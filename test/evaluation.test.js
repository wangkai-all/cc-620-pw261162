'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateDataset, SPLIT_DATE, LABEL_END } = require('../src/data');
const { evaluateCatalog, buildLabels, LABEL_BUCKET, safeRatio } = require('../src/evaluation');
const {
  createStore,
  actionReplay,
  actionAddLateCourse,
  actionDiff,
  serializeState,
  ScenarioError,
  runPipeline,
} = require('../src/scenarios');

const dataset = generateDataset();

test('评估：标签只取 [T, LABEL_END) 内的完成事件，T 前事件绝不进标签', () => {
  const { labelMap } = buildLabels(dataset.employees, dataset.baseCatalog, dataset.events, SPLIT_DATE, LABEL_END);
  for (const ev of dataset.events) {
    if (ev.occurredAt < SPLIT_DATE) {
      assert.ok(!labelMap.get(ev.employeeId).has(ev.courseId), 'T 前完成事件不能成为标签');
    }
  }
});

test('评估：NOT_VISIBLE 与 VISIBLE_NOT_DONE 严格分桶，互不污染', () => {
  const run = runPipeline(dataset, { withLateCourse: true, mode: 'correct' });
  const result = evaluateCatalog(
    dataset.employees,
    run.catalog,
    dataset.events,
    SPLIT_DATE,
    LABEL_END,
    run.recMap,
    'correct',
  );
  for (const row of result.perEmployee) {
    // C9 在 T 时不可见：只能落入 NOT_VISIBLE / INVISIBLE_LABEL_ONLY / INVISIBLE_*，绝不进可见桶
    assert.ok(!row.visibleNotDone.includes('C9'));
    assert.ok(!row.wasted.includes('C9'));
    assert.ok(!row.hits.includes('C9'));
    const allowed = [LABEL_BUCKET.NOT_VISIBLE, LABEL_BUCKET.INVISIBLE_LABEL_ONLY];
    if (row.bucketOf.C9) assert.ok(allowed.includes(row.bucketOf.C9));
  }
  // 全量守恒：NOT_VISIBLE + INVISIBLE_LABEL_ONLY 覆盖全部 12 名员工对 C9 的评价
  assert.equal(
    result.totals.notVisible + result.totals.invisibleLabelOnly,
    dataset.employees.length,
  );
});

test('评估：正确流水线不可见推荐数为 0；错误流水线出现不可见推荐与 INVISIBLE_HIT', () => {
  const correct = runPipeline(dataset, { withLateCourse: true, mode: 'correct' });
  const naive = runPipeline(dataset, { withLateCourse: true, mode: 'naive' });
  assert.equal(correct.evaluation.totals.recommendedInvisible, 0);
  assert.ok(naive.evaluation.totals.recommendedInvisible > 0);
  assert.ok(naive.evaluation.totals.invisibleHits > 0);
  assert.equal(correct.evaluation.totals.invisibleHits, 0);
  // 错误承认泄漏命中会得到虚高精确率，且正确精确率拒绝计入这类命中
  assert.ok(
    naive.evaluation.metrics.inflatedPrecisionIfLeakIgnored > naive.evaluation.metrics.precision,
  );
});

test('评估：除零保护——空推荐时精确率为 0 而不是 NaN', () => {
  assert.equal(safeRatio(0, 0), 0);
  const emptyMap = new Map(dataset.employees.map((e) => [e.id, []]));
  const result = evaluateCatalog(
    dataset.employees,
    dataset.baseCatalog,
    dataset.events,
    SPLIT_DATE,
    LABEL_END,
    emptyMap,
    'correct',
  );
  assert.equal(Number.isNaN(result.metrics.precision), false);
  assert.equal(result.metrics.precision, 0);
  assert.equal(result.metrics.coverage, 0);
});

test('评估：指标取值都在 [0,1]，且命中/浪费/漏召计数自洽', () => {
  const run = runPipeline(dataset, { withLateCourse: false, mode: 'correct' });
  const { metrics, totals } = run.evaluation;
  for (const [k, v] of Object.entries(metrics)) {
    if (k === 'mode' || k.endsWith('Count')) continue;
    assert.ok(v >= 0 && v <= 1, `${k} 应在 [0,1] 内，实际 ${v}`);
  }
  assert.equal(totals.hits + totals.missed, totals.visibleLabels);
  assert.equal(totals.hits + totals.wasted, totals.recommendedVisible);
});

test('场景：完整三步流程后全部点时间不变量通过', () => {
  const store = createStore();
  actionReplay(store);
  actionAddLateCourse(store);
  const { diff } = actionDiff(store);
  assert.equal(diff.allInvariantsPassed, true);
  for (const iv of diff.invariants) assert.equal(iv.passed, true, `不变量失败：${iv.id}`);
  // 正确候选前后一致；错误候选对至少一名员工泄漏 C9
  assert.ok(diff.candidateComparison.every((c) => c.correctStable));
  assert.ok(diff.candidateComparison.some((c) => c.naivePicksLateCourse));
  assert.ok(diff.candidateComparison.every((c) => !c.correctPicksLateCourse));
});

test('场景：错误切分的指标相对正确切分出现可观测偏差', () => {
  const store = createStore();
  actionReplay(store);
  actionAddLateCourse(store);
  const { diff } = actionDiff(store);
  const by = Object.fromEntries(diff.metricRows.map((r) => [r.scenario, r]));
  // 未来事件进岗位统计 → 基线召回被抬高
  assert.ok(by['base.naive'].recall >= by['base.correct'].recall);
  // 未来目录泄漏 → 扩展目录下错误模式出现不可见推荐，正确模式始终为 0
  assert.ok(by['extended.naive'].invisibleRecommendationRate > 0);
  assert.equal(by['extended.correct'].invisibleRecommendationRate, 0);
  // 正确流水线在两个目录下的可见指标完全相同（C9 不影响正确口径）
  assert.equal(by['base.correct'].precision, by['extended.correct'].precision);
  assert.equal(by['base.correct'].recall, by['extended.correct'].recall);
});

test('场景（异常）：未重放就新增课程 → ACTION_OUT_OF_ORDER', () => {
  const store = createStore();
  assert.throws(() => actionAddLateCourse(store), (err) => {
    assert.ok(err instanceof ScenarioError);
    assert.equal(err.code, 'ACTION_OUT_OF_ORDER');
    return true;
  });
});

test('场景（异常）：未新增课程就查看差异 → LATE_COURSE_NOT_ADDED', () => {
  const store = createStore();
  actionReplay(store);
  assert.throws(() => actionDiff(store), (err) => {
    assert.equal(err.code, 'LATE_COURSE_NOT_ADDED');
    return true;
  });
});

test('场景（异常）：重复新增课程 → LATE_COURSE_ALREADY_ADDED', () => {
  const store = createStore();
  actionReplay(store);
  actionAddLateCourse(store);
  assert.throws(() => actionAddLateCourse(store), (err) => {
    assert.equal(err.code, 'LATE_COURSE_ALREADY_ADDED');
    return true;
  });
});

test('场景：重放可重置状态，状态序列化包含前端所需结构', () => {
  const store = createStore();
  actionReplay(store);
  actionAddLateCourse(store);
  actionDiff(store);
  actionReplay(store);
  const state = serializeState(store);
  assert.equal(state.hasBaseRun, true);
  assert.equal(state.hasExtendedRun, false);
  assert.equal(state.hasDiff, false);
  assert.ok(Array.isArray(state.events));
  assert.ok(state.base.correct.evaluation.metrics);
});
