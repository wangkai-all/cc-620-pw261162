'use strict';

// 推荐规则：
// 1) 岗位共性：同岗位其他员工在“当时可见”的完成记录里，各课程被完成的人数比例
// 2) 相近历史：当前员工已完成课程与课程完成者集合的 Jaccard 相似度
//
// 关键约束：候选生成只能使用 splitDate 之前、且目录已开放的信息。

class RecommendationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RecommendationError';
    this.code = code;
  }
}

function isCourseVisible(course, splitDate) {
  return course.catalogOpenAt <= splitDate;
}

// 构建点时间上下文。
// 候选资格过滤始终只认 T 前完成事件（标签事件不能反过来抹掉候选）。
// options.futureStats:
//   false —— 正确切分：岗位统计只使用 splitDate 之前的事件
//   true  —— 错误切分：岗位统计使用全部事件（含未来事件，用未来补旧特征）
// options.useFutureCatalog:
//   false —— 正确切分：候选目录只包含 splitDate 当时已开放的课程
//   true  —— 错误切分：把后来才开放的课程也放进候选（未来目录泄漏）
function buildContext(employees, catalog, events, splitDate, options = {}) {
  const futureStats = Boolean(options.futureStats);
  const useFutureCatalog = Boolean(options.useFutureCatalog);

  const visibleCatalog = catalog.filter((c) => isCourseVisible(c, splitDate));
  // 错误切分直接拿“今天的完整目录”生成候选；正确切分严格使用 T 时可见目录
  const candidateCatalog = useFutureCatalog ? catalog : visibleCatalog;

  const historyEvents = events.filter((e) => e.occurredAt < splitDate);
  const statEvents = futureStats ? events : historyEvents;

  // 个人已完成 / 课程完成者集合
  const completedByEmployee = new Map(employees.map((e) => [e.id, new Set()]));
  const completedByCourse = new Map(catalog.map((c) => c.id).map((id) => [id, new Set()]));
  const roleOf = new Map(employees.map((e) => [e.id, e.roleId]));
  const roleSize = {};
  employees.forEach((e) => { roleSize[e.roleId] = (roleSize[e.roleId] || 0) + 1; });
  const roleCourseCount = {};
  Object.keys(roleSize).forEach((r) => { roleCourseCount[r] = {}; });

  // 岗位统计：正确模式只统计历史事件；泄漏模式统计全部事件（含未来事件）。
  // 统计范围与候选目录一致（错误模式下连 C9 的岗位共性也会被算出来）。
  const candidateIds = new Set(candidateCatalog.map((c) => c.id));
  statEvents.forEach((ev) => {
    if (!candidateIds.has(ev.courseId)) return;
    const role = roleOf.get(ev.employeeId);
    if (!role) return;
    roleCourseCount[role][ev.courseId] = (roleCourseCount[role][ev.courseId] || 0) + 1;
  });

  historyEvents.forEach((ev) => {
    if (!completedByEmployee.has(ev.employeeId)) return;
    completedByEmployee.get(ev.employeeId).add(ev.courseId);
    if (completedByCourse.has(ev.courseId)) completedByCourse.get(ev.courseId).add(ev.employeeId);
  });

  return {
    splitDate,
    futureStats,
    useFutureCatalog,
    visibleCatalog,
    candidateCatalog,
    completedByEmployee,
    completedByCourse,
    roleCourseCount,
    roleSize,
    roleOf,
  };
}

function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  setA.forEach((x) => { if (setB.has(x)) inter += 1; });
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

const WEIGHT_ROLE = 0.6;
const WEIGHT_SIM = 0.4;

// 为单个员工生成候选。
// options.topN：返回条数（默认 5）；返回结构包含候选与“无可推荐课程”标记。
function recommendFor(employeeId, ctx, options = {}) {
  const topN = options.topN ?? 5;
  const role = ctx.roleOf.get(employeeId);
  if (!role) {
    throw new RecommendationError('UNKNOWN_EMPLOYEE', `未知员工：${employeeId}`);
  }

  const done = ctx.completedByEmployee.get(employeeId) || new Set();
  const eligible = ctx.candidateCatalog.filter((c) => !done.has(c.id));

  if (eligible.length === 0) {
    return {
      employeeId,
      recommendations: [],
      reason: 'visible_completed_all',
      reasonText: '当时可见的课程均已完成，无候选可推',
    };
  }

  const raw = eligible.map((course) => {
    const roleCount = ctx.roleCourseCount[role][course.id] || 0;
    const roleScore = roleCount / ctx.roleSize[role];
    const simScore = jaccard(done, ctx.completedByCourse.get(course.id) || new Set());
    return { courseId: course.id, title: course.title, category: course.category, roleScore, simScore };
  });

  const maxRole = Math.max(...raw.map((r) => r.roleScore), 1e-9);
  const maxSim = Math.max(...raw.map((r) => r.simScore), 1e-9);

  const scored = raw.map((r) => ({
    ...r,
    roleScoreNorm: r.roleScore / maxRole,
    simScoreNorm: r.simScore / maxSim,
    score: WEIGHT_ROLE * (r.roleScore / maxRole) + WEIGHT_SIM * (r.simScore / maxSim),
  }));

  scored.sort((a, b) => (b.score - a.score) || a.courseId.localeCompare(b.courseId));

  return {
    employeeId,
    reason: 'ok',
    reasonText: done.size === 0 ? '无历史完成事件，岗位共性主导（冷启动）' : '岗位共性 + 相近历史混合排序',
    recommendations: scored.slice(0, topN),
  };
}

function recommendAll(employees, ctx, options = {}) {
  return employees.map((e) => recommendFor(e.id, ctx, options));
}

module.exports = {
  RecommendationError,
  WEIGHT_ROLE,
  WEIGHT_SIM,
  isCourseVisible,
  buildContext,
  jaccard,
  recommendFor,
  recommendAll,
};
