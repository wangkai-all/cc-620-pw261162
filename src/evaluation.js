'use strict';

// 离线评估。
// 评价必须把两类负向情况严格分开：
//   A. NOT_VISIBLE         课程在 T 时刻尚未开放，员工根本看不到
//   B. VISIBLE_NOT_DONE    课程在 T 时刻已开放（员工看得到），但评估窗口内没有完成
// 标签只允许使用 [splitDate, labelEnd) 内发生的完成事件。

const LABEL_BUCKET = Object.freeze({
  HIT: 'HIT',                                   // 推荐了、当时可见、窗口内完成
  WASTED: 'WASTED',                             // 推荐了、当时可见、窗口内没完成（看到了但没做）
  MISSED: 'MISSED',                             // 未推荐、当时可见、窗口内完成
  INVISIBLE_HIT: 'INVISIBLE_HIT',               // 推荐了、但 T 时刻课程未开放、窗口内完成
  INVISIBLE_REC_NOT_DONE: 'INVISIBLE_REC_NOT_DONE', // 推荐了未开放课程且未完成
  INVISIBLE_LABEL_ONLY: 'INVISIBLE_LABEL_ONLY', // 未推荐、未开放、窗口内完成（客观事件）
  NOT_VISIBLE: 'NOT_VISIBLE',                   // 未推荐、未开放、未完成（员工根本看不到）
  VISIBLE_NOT_DONE: 'VISIBLE_NOT_DONE',         // 未推荐、已开放、未完成（看得到但没做）
});

const safeRatio = (num, den) => (den === 0 ? 0 : num / den);

function buildLabels(employees, catalog, events, splitDate, labelEnd) {
  const visibleIds = new Set(catalog.filter((c) => c.catalogOpenAt <= splitDate).map((c) => c.id));
  const labelMap = new Map(employees.map((e) => [e.id, new Set()]));
  events.forEach((ev) => {
    if (!labelMap.has(ev.employeeId)) return;
    if (ev.occurredAt >= splitDate && ev.occurredAt < labelEnd) {
      labelMap.get(ev.employeeId).add(ev.courseId);
    }
  });
  return { visibleIds, labelMap };
}

// recommendationsByEmployee: Map<employeeId, string[]>（课程 id 顺序即推荐顺序）
// mode: 'correct' | 'naive'，仅用于结果标注，分桶逻辑对两种模式一致。
function evaluateCatalog(employees, catalog, events, splitDate, labelEnd, recommendationsByEmployee, mode) {
  const { visibleIds, labelMap } = buildLabels(employees, catalog, events, splitDate, labelEnd);
  const courseById = new Map(catalog.map((c) => [c.id, c]));

  const totals = {
    employees: employees.length,
    employeesWithRecommendation: 0,
    recommendedVisible: 0,
    recommendedInvisible: 0,
    hits: 0,
    wasted: 0,
    missed: 0,
    invisibleHits: 0,
    invisibleRecNotDone: 0,
    invisibleLabelOnly: 0,
    notVisible: 0,
    visibleNotDone: 0,
    visibleLabels: 0,
  };

  const perEmployee = employees.map((emp) => {
    const labels = labelMap.get(emp.id) || new Set();
    const recIds = recommendationsByEmployee.get(emp.id) || [];
    if (recIds.length > 0) totals.employeesWithRecommendation += 1;

    const recSet = new Set(recIds);
    const row = {
      employeeId: emp.id,
      employeeName: emp.name,
      roleId: emp.roleId,
      recommendations: recIds,
      visibleLabelCourses: [],
      invisibleLabelCourses: [],
      hits: [],
      wasted: [],
      missed: [],
      invisibleHits: [],
      invisibleRecNotDone: [],
      invisibleLabelOnly: [],
      notVisible: [],
      visibleNotDone: [],
      bucketOf: {},
    };

    labels.forEach((courseId) => {
      if (visibleIds.has(courseId)) {
        row.visibleLabelCourses.push(courseId);
        totals.visibleLabels += 1;
        if (recSet.has(courseId)) { row.hits.push(courseId); totals.hits += 1; row.bucketOf[courseId] = LABEL_BUCKET.HIT; }
        else { row.missed.push(courseId); totals.missed += 1; row.bucketOf[courseId] = LABEL_BUCKET.MISSED; }
      } else {
        row.invisibleLabelCourses.push(courseId);
        if (recSet.has(courseId)) { row.invisibleHits.push(courseId); totals.invisibleHits += 1; row.bucketOf[courseId] = LABEL_BUCKET.INVISIBLE_HIT; }
        else { row.invisibleLabelOnly.push(courseId); totals.invisibleLabelOnly += 1; row.bucketOf[courseId] = LABEL_BUCKET.INVISIBLE_LABEL_ONLY; }
      }
    });

    recIds.forEach((courseId) => {
      if (visibleIds.has(courseId)) {
        totals.recommendedVisible += 1;
        if (!labels.has(courseId)) { row.wasted.push(courseId); totals.wasted += 1; row.bucketOf[courseId] = LABEL_BUCKET.WASTED; }
      } else {
        totals.recommendedInvisible += 1;
        if (!labels.has(courseId)) { row.invisibleRecNotDone.push(courseId); totals.invisibleRecNotDone += 1; row.bucketOf[courseId] = LABEL_BUCKET.INVISIBLE_REC_NOT_DONE; }
      }
    });

    catalog.forEach((course) => {
      if (recSet.has(course.id) || labels.has(course.id)) return;
      if (visibleIds.has(course.id)) {
        row.visibleNotDone.push(course.id);
        totals.visibleNotDone += 1;
        row.bucketOf[course.id] = LABEL_BUCKET.VISIBLE_NOT_DONE;
      } else {
        row.notVisible.push(course.id);
        totals.notVisible += 1;
        row.bucketOf[course.id] = LABEL_BUCKET.NOT_VISIBLE;
      }
    });

    return row;
  });

  const totalRecommendations = totals.recommendedVisible + totals.recommendedInvisible;
  const metrics = {
    mode,
    precision: safeRatio(totals.hits, totals.recommendedVisible),
    recall: safeRatio(totals.hits, totals.visibleLabels),
    coverage: safeRatio(totals.employeesWithRecommendation, totals.employees),
    hitRatePerEmployee: safeRatio(totals.hits, totals.employees),
    invisibleRecommendationRate: safeRatio(totals.recommendedInvisible, totalRecommendations),
    invisibleHitRate: safeRatio(totals.invisibleHits, totals.recommendedInvisible),
    // 若错误地把“未开放课程的命中”也算成命中，会得到虚高的精确率
    inflatedPrecisionIfLeakIgnored: safeRatio(totals.hits + totals.invisibleHits, totalRecommendations),
    invisibleHitsCount: totals.invisibleHits,
    notVisibleCount: totals.notVisible,
    visibleNotDoneCount: totals.visibleNotDone,
  };

  return {
    mode,
    splitDate,
    labelEnd,
    catalogSize: catalog.length,
    visibleCatalogSize: visibleIds.size,
    totals,
    metrics,
    perEmployee,
    buckets: LABEL_BUCKET,
    courseById: Object.fromEntries(courseById),
  };
}

module.exports = {
  LABEL_BUCKET,
  buildLabels,
  evaluateCatalog,
  safeRatio,
};
