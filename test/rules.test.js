'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateDataset, SPLIT_DATE, LABEL_END } = require('../src/data');
const {
  RecommendationError,
  buildContext,
  recommendFor,
  recommendAll,
  jaccard,
  isCourseVisible,
} = require('../src/rules');

const dataset = generateDataset();

function correctCtx(catalog = dataset.baseCatalog) {
  return buildContext(dataset.employees, catalog, dataset.events, SPLIT_DATE, {
    eligibility: 'history',
    futureStats: false,
    useFutureCatalog: false,
  });
}

test('规则：T 时刻恰好开放的课程按可见处理（边界 <=），晚于 T 的课程不可见', () => {
  assert.equal(isCourseVisible({ catalogOpenAt: SPLIT_DATE }, SPLIT_DATE), true);
  assert.equal(isCourseVisible({ catalogOpenAt: dataset.lateCourse.catalogOpenAt }, SPLIT_DATE), false);
});

test('规则：正确切分的候选目录严格等于 T 时可见目录，C9 被排除', () => {
  const extendedCatalog = [...dataset.baseCatalog, dataset.lateCourse];
  const ctx = correctCtx(extendedCatalog);
  assert.deepEqual(ctx.candidateCatalog.map((c) => c.id), dataset.baseCatalog.map((c) => c.id));
  assert.ok(!ctx.candidateCatalog.some((c) => c.id === 'C9'));
});

test('规则：正确切分的岗位统计只使用 T 前事件（未来事件不补旧特征）', () => {
  const extendedCatalog = [...dataset.baseCatalog, dataset.lateCourse];
  const ctx = correctCtx(extendedCatalog);
  const historyCount = dataset.events.filter((e) => e.occurredAt < SPLIT_DATE).length;
  assert.ok(historyCount < dataset.events.length, '前置条件：存在 T 之后的事件');
  // C9 没有任何 T 前事件，正确统计里不应出现
  for (const role of Object.keys(ctx.roleCourseCount)) {
    assert.equal(ctx.roleCourseCount[role].C9, undefined);
  }
});

test('规则：错误切分把未来目录与未来事件混入，C9 进入候选目录与岗位统计', () => {
  const extendedCatalog = [...dataset.baseCatalog, dataset.lateCourse];
  const ctx = buildContext(dataset.employees, extendedCatalog, dataset.events, SPLIT_DATE, {
    eligibility: 'history',
    futureStats: true,
    useFutureCatalog: true,
  });
  assert.ok(ctx.candidateCatalog.some((c) => c.id === 'C9'));
  const salesCount = ctx.roleCourseCount.sales.C9 || 0;
  assert.ok(salesCount > 0, '销售岗的 C9 完成事件应被错误地计入岗位共性统计');
});

test('规则：正确切分下任何员工都不会被推荐 C9', () => {
  const extendedCatalog = [...dataset.baseCatalog, dataset.lateCourse];
  const ctx = correctCtx(extendedCatalog);
  const recs = recommendAll(dataset.employees, ctx, { topN: 5 });
  for (const r of recs) {
    assert.ok(!r.recommendations.some((x) => x.courseId === 'C9'), `${r.employeeId} 不应被推荐 C9`);
  }
});

test('规则：新增 C9 前后，正确切分的候选完全一致（点时间纪律）', () => {
  const base = recommendAll(dataset.employees, correctCtx(dataset.baseCatalog), { topN: 5 });
  const extended = recommendAll(
    dataset.employees,
    correctCtx([...dataset.baseCatalog, dataset.lateCourse]),
    { topN: 5 },
  );
  assert.deepEqual(
    base.map((r) => [r.employeeId, r.recommendations.map((x) => x.courseId)]),
    extended.map((r) => [r.employeeId, r.recommendations.map((x) => x.courseId)]),
  );
});

test('规则：E04 已完成当时全部可见课程，返回空候选并给出原因', () => {
  const ctx = correctCtx();
  const r = recommendFor('E04', ctx);
  assert.equal(r.reason, 'visible_completed_all');
  assert.deepEqual(r.recommendations, []);
});

test('规则：冷启动员工 E12 仍可由岗位共性产生候选', () => {
  const ctx = correctCtx();
  const r = recommendFor('E12', ctx);
  assert.ok(r.recommendations.length > 0);
  assert.match(r.reasonText, /冷启动/);
});

test('规则（异常）：未知员工抛出 UNKNOWN_EMPLOYEE', () => {
  const ctx = correctCtx();
  assert.throws(() => recommendFor('NO_SUCH_EMPLOYEE', ctx), (err) => {
    assert.ok(err instanceof RecommendationError);
    assert.equal(err.code, 'UNKNOWN_EMPLOYEE');
    return true;
  });
});

test('规则：候选数不超过 topN，且分数非负、按分数降序', () => {
  const ctx = correctCtx();
  for (const emp of dataset.employees) {
    const r = recommendFor(emp.id, ctx, { topN: 3 });
    assert.ok(r.recommendations.length <= 3);
    for (const x of r.recommendations) {
      assert.ok(x.score >= 0);
      assert.ok(x.roleScore >= 0 && x.simScore >= 0);
    }
    for (let i = 1; i < r.recommendations.length; i += 1) {
      assert.ok(r.recommendations[i - 1].score >= r.recommendations[i].score);
    }
  }
});

test('规则：Jaccard 相似度基本性质', () => {
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  assert.equal(jaccard(new Set(['a']), new Set(['a'])), 1);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
});
