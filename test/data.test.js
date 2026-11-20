'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateDataset,
  SPLIT_DATE,
  LABEL_END,
  BASE_CATALOG,
  LATE_COURSE,
  EMPLOYEES,
} = require('../src/data');

test('虚构数据：固定种子下生成结果完全确定（可复现、可核对）', () => {
  const a = generateDataset();
  const b = generateDataset();
  assert.deepEqual(a.events, b.events);
  assert.equal(a.events.length, b.events.length);
  assert.ok(a.events.length >= 40, '应生成足够多的完成事件用于离线评估');
});

test('虚构数据：C1~C8 在 T 前全部开放，C9 在 T 之后才开放', () => {
  for (const c of BASE_CATALOG) {
    assert.ok(c.catalogOpenAt <= SPLIT_DATE, `${c.id} 应在 T 前开放`);
  }
  assert.ok(LATE_COURSE.catalogOpenAt > SPLIT_DATE, 'C9 必须晚于 T 开放');
  assert.ok(LATE_COURSE.catalogOpenAt < LABEL_END, 'C9 必须在评估窗口结束前开放');
});

test('虚构数据：事件按时间升序排列且字段完整', () => {
  const { events } = generateDataset();
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(events[i - 1].occurredAt <= events[i].occurredAt);
  }
  for (const ev of events) {
    assert.match(ev.id, /^EV\d+$/);
    assert.ok(EMPLOYEES.some((e) => e.id === ev.employeeId));
    assert.equal(ev.eventType, 'completed');
  }
});

test('虚构数据：冷启动员工 E12 在 T 前没有任何完成事件', () => {
  const { events } = generateDataset();
  const e12History = events.filter((e) => e.employeeId === 'E12' && e.occurredAt < SPLIT_DATE);
  assert.equal(e12History.length, 0);
});

test('虚构数据：C9 的完成事件全部晚于其开放时间（客观事件存在，但 T 时不可见）', () => {
  const { events } = generateDataset();
  const c9 = events.filter((e) => e.courseId === 'C9');
  assert.ok(c9.length >= 3, '应有若干员工在 C9 开放后完成它');
  for (const ev of c9) {
    assert.ok(ev.occurredAt >= LATE_COURSE.catalogOpenAt);
    assert.ok(ev.occurredAt >= SPLIT_DATE);
  }
});
