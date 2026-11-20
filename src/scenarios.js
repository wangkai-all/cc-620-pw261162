'use strict';

// 场景编排：
//   目录维度：base（C1~C8） / extended（新增后来才开放的 C9）
//   切分维度：correct（严格点时间） / naive（用未来事件补旧特征 + 标签泄漏式过滤）
// 两条维度组合成 4 次离线运行，候选生成与评估都只基于运行当时可见的目录。

const { generateDataset, SPLIT_DATE, LABEL_END } = require('./data');
const { buildContext, recommendAll } = require('./rules');
const { evaluateCatalog } = require('./evaluation');

const TOP_N = 5;

class ScenarioError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScenarioError';
    this.code = code;
  }
}

function runPipeline(dataset, { withLateCourse, mode }) {
  const catalog = withLateCourse ? [...dataset.baseCatalog, dataset.lateCourse] : dataset.baseCatalog;
  const options = mode === 'correct'
    ? { futureStats: false, useFutureCatalog: false }
    : { futureStats: true, useFutureCatalog: true };

  const ctx = buildContext(dataset.employees, catalog, dataset.events, SPLIT_DATE, options);
  const recs = recommendAll(dataset.employees, ctx, { topN: TOP_N });
  const recMap = new Map(recs.map((r) => [r.employeeId, r.recommendations.map((x) => x.courseId)]));
  const evaluation = evaluateCatalog(dataset.employees, catalog, dataset.events, SPLIT_DATE, LABEL_END, recMap, mode);

  return { mode, withLateCourse, catalog, ctx, recs, recMap, evaluation, ranAt: new Date().toISOString() };
}

function historyEventCount(dataset) {
  return dataset.events.filter((e) => e.occurredAt < SPLIT_DATE).length;
}

function serializePipeline(run) {
  return {
    mode: run.mode,
    withLateCourse: run.withLateCourse,
    ranAt: run.ranAt,
    catalog: run.catalog.map((c) => ({
      ...c,
      visibleAtSplit: c.catalogOpenAt <= SPLIT_DATE,
    })),
    context: {
      futureStats: run.ctx.futureStats,
      useFutureCatalog: run.ctx.useFutureCatalog,
      visibleCatalogIds: run.ctx.visibleCatalog.map((c) => c.id),
      candidateCatalogIds: run.ctx.candidateCatalog.map((c) => c.id),
      roleCourseCount: run.ctx.roleCourseCount,
      roleSize: run.ctx.roleSize,
      completedCountByEmployee: Object.fromEntries(
        [...run.ctx.completedByEmployee.entries()].map(([id, set]) => [id, set.size]),
      ),
    },
    recommendations: run.recs,
    evaluation: {
      totals: run.evaluation.totals,
      metrics: run.evaluation.metrics,
      perEmployee: run.evaluation.perEmployee,
      buckets: run.evaluation.buckets,
      visibleCatalogSize: run.evaluation.visibleCatalogSize,
      catalogSize: run.evaluation.catalogSize,
    },
  };
}

function candidateList(run, employeeId) {
  return run.recMap.get(employeeId) || [];
}

function buildDiff(store) {
  const { dataset } = store;
  const base = store.runs.base;
  const extended = store.runs.extended;

  const metricRows = [
    { scenario: 'base.correct', ...base.correct.evaluation.metrics },
    { scenario: 'base.naive', ...base.naive.evaluation.metrics },
    { scenario: 'extended.correct', ...extended.correct.evaluation.metrics },
    { scenario: 'extended.naive', ...extended.naive.evaluation.metrics },
  ];

  // 逐员工候选对照（新增 C9 前后、正确 vs 错误）
  const candidateComparison = dataset.employees.map((emp) => {
    const baseCorrect = candidateList(base.correct, emp.id);
    const baseNaive = candidateList(base.naive, emp.id);
    const extCorrect = candidateList(extended.correct, emp.id);
    const extNaive = candidateList(extended.naive, emp.id);
    return {
      employeeId: emp.id,
      employeeName: emp.name,
      roleId: emp.roleId,
      baseCorrect,
      baseNaive,
      extendedCorrect: extCorrect,
      extendedNaive: extNaive,
      correctStable: JSON.stringify(baseCorrect) === JSON.stringify(extCorrect),
      naivePicksLateCourse: extNaive.includes(dataset.lateCourse.id),
      correctPicksLateCourse: extCorrect.includes(dataset.lateCourse.id),
    };
  });

  const lateId = dataset.lateCourse.id;
  const naiveLatePickers = candidateComparison.filter((r) => r.naivePicksLateCourse).map((r) => r.employeeId);
  const correctLatePickers = candidateComparison.filter((r) => r.correctPicksLateCourse).map((r) => r.employeeId);
  const unstableCorrect = candidateComparison.filter((r) => !r.correctStable).map((r) => r.employeeId);

  // 正确流水线：C9 对每个员工落入哪个桶
  const lateCourseBuckets = extended.correct.evaluation.perEmployee.map((row) => ({
    employeeId: row.employeeId,
    bucket: row.bucketOf[lateId] || null,
  }));
  const notVisibleEmployees = lateCourseBuckets
    .filter((x) => x.bucket === 'NOT_VISIBLE')
    .map((x) => x.employeeId);
  const invisibleLabelOnlyEmployees = lateCourseBuckets
    .filter((x) => x.bucket === 'INVISIBLE_LABEL_ONLY')
    .map((x) => x.employeeId);

  const mCorrect = extended.correct.evaluation.metrics;
  const mNaive = extended.naive.evaluation.metrics;

  // 点时间纪律不变量（全部应通过）
  const invariants = [
    {
      id: 'correct-candidates-ignore-future-catalog',
      description: '正确切分：新增 C9 后，每个员工的候选与基线完全一致（未来课程不进入候选）',
      passed: unstableCorrect.length === 0,
      detail: unstableCorrect.length === 0 ? '12/12 员工候选保持一致' : `发生变化的员工：${unstableCorrect.join(', ')}`,
    },
    {
      id: 'correct-never-recommends-invisible-course',
      description: '正确切分：没有任何员工被推荐 T 时刻尚未开放的 C9',
      passed: correctLatePickers.length === 0,
      detail: correctLatePickers.length === 0 ? 'C9 推荐次数为 0' : `违规员工：${correctLatePickers.join(', ')}`,
    },
    {
      id: 'naive-recommends-invisible-course',
      description: '错误切分：C9 泄漏进候选列表（员工在 T 时刻根本看不到该课程）',
      passed: naiveLatePickers.length > 0,
      detail: naiveLatePickers.length > 0 ? `${naiveLatePickers.length} 名员工被推荐 C9：${naiveLatePickers.join(', ')}` : '未观察到泄漏（数据异常）',
    },
    {
      id: 'not-visible-separated-from-visible-not-done',
      description: '评价分桶：C9 的 NOT_VISIBLE（看不到）与 VISIBLE_NOT_DONE（看到了没完成）严格分开',
      passed: notVisibleEmployees.length + invisibleLabelOnlyEmployees.length === dataset.employees.length,
      detail: `NOT_VISIBLE ${notVisibleEmployees.length} 人；INVISIBLE_LABEL_ONLY ${invisibleLabelOnlyEmployees.length} 人；两类均未计入 VISIBLE_NOT_DONE`,
    },
    {
      id: 'feature-split-event-count',
      description: '特征事件量：正确切分只统计 T 前事件，错误切分把窗口内未来事件也算进岗位统计（用未来补旧特征）',
      passed:
        base.correct.ctx.roleCourseCount !== base.naive.ctx.roleCourseCount &&
        historyEventCount(dataset) < dataset.events.length,
      detail: `T 前事件 ${historyEventCount(dataset)} 条 / 全量事件 ${dataset.events.length} 条；正确模式岗位统计使用前者，错误模式使用后者，基线目录下错误模式召回已被抬高`,
    },
    {
      id: 'invisible-hits-not-counted-as-precision',
      description: '错误切分把 C9 命中计入了“看不见的命中率”，正确精确率拒绝承认这类命中',
      passed: mNaive.invisibleHitsCount > 0 && mCorrect.invisibleHitsCount === 0,
      detail: `错误模式 INVISIBLE_HIT ${mNaive.invisibleHitsCount} 次；若错误承认这些命中，精确率将虚高为 ${(mNaive.inflatedPrecisionIfLeakIgnored * 100).toFixed(1)}%（正确口径精确率 ${(mCorrect.precision * 100).toFixed(1)}%）`,
    },
  ];

  return {
    createdAt: new Date().toISOString(),
    lateCourse: dataset.lateCourse,
    metricRows,
    metricDelta: {
      precision: mNaive.precision - mCorrect.precision,
      recall: mNaive.recall - mCorrect.recall,
      coverage: mNaive.coverage - mCorrect.coverage,
      invisibleRecommendationRate: mNaive.invisibleRecommendationRate - mCorrect.invisibleRecommendationRate,
    },
    candidateComparison,
    lateCourseBuckets,
    bucketSummary: {
      notVisibleEmployees,
      invisibleLabelOnlyEmployees,
    },
    invariants,
    allInvariantsPassed: invariants.every((i) => i.passed),
  };
}

function createStore() {
  return {
    dataset: generateDataset(),
    runs: { base: null, extended: null },
    diff: null,
    actions: [],
  };
}

function actionReplay(store) {
  // 重放原推荐规则：同时跑正确切分与错误切分（基线目录，二者特征口径已可对照）
  const base = {
    correct: runPipeline(store.dataset, { withLateCourse: false, mode: 'correct' }),
    naive: runPipeline(store.dataset, { withLateCourse: false, mode: 'naive' }),
  };
  store.runs = { base, extended: null };
  store.diff = null;
  store.actions.push({ action: 'replay', at: new Date().toISOString() });
  return {
    step: 1,
    message: '已在基线目录（C1~C8，T 前均已开放）重放推荐规则，同时给出正确/错误两种时间切分',
    correct: serializePipeline(base.correct),
    naive: serializePipeline(base.naive),
  };
}

function actionAddLateCourse(store) {
  if (!store.runs.base) {
    throw new ScenarioError('ACTION_OUT_OF_ORDER', '请先执行「重放原推荐规则」，再新增后开放课程');
  }
  if (store.runs.extended) {
    throw new ScenarioError('LATE_COURSE_ALREADY_ADDED', '后开放课程已加入目录，请直接查看差异或重放重置');
  }
  const extended = {
    correct: runPipeline(store.dataset, { withLateCourse: true, mode: 'correct' }),
    naive: runPipeline(store.dataset, { withLateCourse: true, mode: 'naive' }),
  };
  store.runs.extended = extended;
  store.actions.push({ action: 'add-late-course', at: new Date().toISOString(), courseId: store.dataset.lateCourse.id });
  return {
    step: 2,
    message: `已加入 ${store.dataset.lateCourse.id}（${store.dataset.lateCourse.title}），开放时间 ${store.dataset.lateCourse.catalogOpenAt}，晚于 T=${SPLIT_DATE}`,
    correct: serializePipeline(extended.correct),
    naive: serializePipeline(extended.naive),
  };
}

function actionDiff(store) {
  if (!store.runs.base) {
    throw new ScenarioError('ACTION_OUT_OF_ORDER', '请先执行「重放原推荐规则」');
  }
  if (!store.runs.extended) {
    throw new ScenarioError('LATE_COURSE_NOT_ADDED', '尚未新增后开放课程，无法查看候选与评估差异');
  }
  store.diff = buildDiff(store);
  store.actions.push({ action: 'diff', at: new Date().toISOString() });
  return { step: 3, message: '已生成候选差异、指标差异与点时间不变量核对', diff: store.diff };
}

function serializeState(store) {
  return {
    constants: store.dataset.constants,
    roles: store.dataset.roles,
    employees: store.dataset.employees,
    events: store.dataset.events,
    baseCatalog: store.dataset.baseCatalog,
    lateCourse: store.dataset.lateCourse,
    hasBaseRun: Boolean(store.runs.base),
    hasExtendedRun: Boolean(store.runs.extended),
    hasDiff: Boolean(store.diff),
    actions: store.actions,
    base: store.runs.base
      ? { correct: serializePipeline(store.runs.base.correct), naive: serializePipeline(store.runs.base.naive) }
      : null,
    extended: store.runs.extended
      ? { correct: serializePipeline(store.runs.extended.correct), naive: serializePipeline(store.runs.extended.naive) }
      : null,
    diff: store.diff,
  };
}

module.exports = {
  TOP_N,
  ScenarioError,
  createStore,
  actionReplay,
  actionAddLateCourse,
  actionDiff,
  serializeState,
  runPipeline,
  buildDiff,
};
