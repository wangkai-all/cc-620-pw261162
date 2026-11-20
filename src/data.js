'use strict';

// 虚构数据：员工、岗位、课程目录、课程完成事件。
// 全部使用确定性伪随机数（固定种子），保证测试与页面结果可复现、可核对。

const SEED = 20260401;

// 关键时间点（UTC，ISO 字符串可直接按字典序比较）
const SPLIT_DATE = '2026-04-01T00:00:00Z';   // T：候选生成 / 特征截断时刻
const LABEL_END = '2026-07-01T00:00:00Z';    // 评估窗口右端（开区间）
const DAY_MS = 24 * 60 * 60 * 1000;

// 岗位 → 课程的亲和度（0~1），用于生成虚构完成事件与解释推荐结果
const ROLE_AFFINITY = {
  sales: { C1: 0.9, C2: 0.85, C3: 0.2, C4: 0.55, C5: 0.3, C6: 0.75, C7: 0.2, C8: 0.15 },
  engineer: { C1: 0.2, C2: 0.35, C3: 0.9, C4: 0.85, C5: 0.4, C6: 0.3, C7: 0.75, C8: 0.7 },
  marketing: { C1: 0.55, C2: 0.7, C3: 0.3, C4: 0.35, C5: 0.85, C6: 0.5, C7: 0.45, C8: 0.3 },
  hr: { C1: 0.4, C2: 0.45, C3: 0.25, C4: 0.3, C5: 0.75, C6: 0.55, C7: 0.5, C8: 0.35 },
};

// 后来才开放的课程 C9：开放时间晚于 T、早于评估窗口结束
const LATE_COURSE_AFFINITY = { sales: 0.95, marketing: 0.6, engineer: 0.25, hr: 0.3 };

const ROLES = [
  { id: 'sales', name: '销售' },
  { id: 'engineer', name: '工程师' },
  { id: 'marketing', name: '市场' },
  { id: 'hr', name: '人力资源' },
];

// C1~C8 在 T 之前全部开放；C9 在 2026-05-18 才开放
const BASE_CATALOG = [
  { id: 'C1', title: '客户沟通基础', category: '销售通识', catalogOpenAt: '2026-01-05T00:00:00Z' },
  { id: 'C2', title: '商务谈判技巧', category: '销售通识', catalogOpenAt: '2026-01-12T00:00:00Z' },
  { id: 'C3', title: '代码评审实践', category: '工程技术', catalogOpenAt: '2026-01-12T00:00:00Z' },
  { id: 'C4', title: '系统设计入门', category: '工程技术', catalogOpenAt: '2026-02-02T00:00:00Z' },
  { id: 'C5', title: '品牌与活动策划', category: '市场运营', catalogOpenAt: '2026-02-16T00:00:00Z' },
  { id: 'C6', title: '合同与回款管理', category: '销售通识', catalogOpenAt: '2026-03-02T00:00:00Z' },
  { id: 'C7', title: '测试自动化', category: '工程技术', catalogOpenAt: '2026-03-09T00:00:00Z' },
  { id: 'C8', title: '云原生基础', category: '工程技术', catalogOpenAt: '2026-03-16T00:00:00Z' },
];

const LATE_COURSE = {
  id: 'C9',
  title: '大客户数据中台（新开课）',
  category: '销售通识',
  catalogOpenAt: '2026-05-18T00:00:00Z',
};

const EMPLOYEES = [
  { id: 'E01', name: '王磊', roleId: 'sales', joinedAt: '2026-01-06T09:00:00Z' },
  { id: 'E02', name: '李娜', roleId: 'sales', joinedAt: '2026-01-12T09:00:00Z' },
  { id: 'E03', name: '张伟', roleId: 'sales', joinedAt: '2026-02-03T09:00:00Z' },
  { id: 'E04', name: '陈静', roleId: 'sales', joinedAt: '2026-01-06T09:00:00Z', note: '历史完成全部已开放课程' },
  { id: 'E05', name: '刘洋', roleId: 'engineer', joinedAt: '2026-01-08T09:00:00Z' },
  { id: 'E06', name: '赵敏', roleId: 'engineer', joinedAt: '2026-01-19T09:00:00Z' },
  { id: 'E07', name: '孙强', roleId: 'engineer', joinedAt: '2026-02-10T09:00:00Z' },
  { id: 'E08', name: '周婷', roleId: 'engineer', joinedAt: '2026-02-23T09:00:00Z' },
  { id: 'E09', name: '吴昊', roleId: 'marketing', joinedAt: '2026-01-15T09:00:00Z' },
  { id: 'E10', name: '郑爽', roleId: 'marketing', joinedAt: '2026-02-17T09:00:00Z' },
  { id: 'E11', name: '冯远', roleId: 'hr', joinedAt: '2026-01-20T09:00:00Z' },
  { id: 'E12', name: '许晴', roleId: 'hr', joinedAt: '2026-03-25T09:00:00Z', note: '冷启动：T 前无任何完成事件' },
];

// 确定性伪随机数生成器（mulberry32）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function dateBetween(rng, startIso, endIso) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  return iso(start + Math.floor(rng() * (end - start)));
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// 生成虚构完成事件。
// 约定：T 之前发生的事件才能进入特征；T ~ LABEL_END 的事件只用于评估标签。
function generateDataset() {
  const rng = mulberry32(SEED);
  const events = [];
  let seq = 0;
  const push = (employeeId, courseId, occurredAt) => {
    seq += 1;
    events.push({ id: `EV${String(seq).padStart(4, '0')}`, employeeId, courseId, eventType: 'completed', occurredAt });
  };

  EMPLOYEES.forEach((emp, idx) => {
    // 每人一个稳定的活跃度扰动
    const activity = rng() * 0.25 - 0.1;
    const affinity = ROLE_AFFINITY[emp.roleId];

    // E12 冷启动：T 前没有任何完成事件
    if (emp.id === 'E12') return;

    BASE_CATALOG.forEach((course) => {
      // E04 强制在 T 前完成全部基础课程（用于“可见课程均已完成 → 候选为空”场景）
      const forcedHistory = emp.id === 'E04';
      const p = forcedHistory ? 1 : clamp01(0.15 + 0.7 * affinity[course.id] + activity);
      if (rng() >= p) return;

      const joinCap = iso(Date.parse(emp.joinedAt) + DAY_MS);
      const openCap = course.catalogOpenAt;
      const earliest = openCap > joinCap ? openCap : joinCap;
      const historyEnd = iso(Date.parse(SPLIT_DATE) - DAY_MS);

      if (forcedHistory && earliest < historyEnd) {
        push(emp.id, course.id, dateBetween(rng, earliest, historyEnd));
        return;
      }

      if (earliest < SPLIT_DATE && rng() < 0.72) {
        // 历史完成：发生在 T 之前，可进入特征
        if (earliest < historyEnd) push(emp.id, course.id, dateBetween(rng, earliest, historyEnd));
      } else if (SPLIT_DATE < LABEL_END) {
        // 窗口内完成：只能作为评估标签，不能进入特征
        const start = earliest > SPLIT_DATE ? earliest : SPLIT_DATE;
        const end = iso(Date.parse(LABEL_END) - DAY_MS);
        if (start < end) push(emp.id, course.id, dateBetween(rng, start, end));
      }
    });

    // C9 在 5 月开放后，部分员工完成了它（事件客观存在，但 T 时刻课程尚不可见）
    const p9 = clamp01(LATE_COURSE_AFFINITY[emp.roleId] + activity);
    if (rng() < p9) {
      const start = iso(Date.parse(LATE_COURSE.catalogOpenAt) + DAY_MS);
      const end = iso(Date.parse(LABEL_END) - DAY_MS);
      push(emp.id, LATE_COURSE.id, dateBetween(rng, start, end));
    }
  });

  events.sort((a, b) => (a.occurredAt === b.occurredAt ? a.id.localeCompare(b.id) : a.occurredAt.localeCompare(b.occurredAt)));

  return {
    generatedAt: iso(Date.now()),
    constants: { SPLIT_DATE, LABEL_END, TOP_N: 5, SEED },
    roles: ROLES,
    employees: EMPLOYEES,
    baseCatalog: BASE_CATALOG,
    lateCourse: LATE_COURSE,
    roleAffinity: ROLE_AFFINITY,
    events,
  };
}

module.exports = {
  SEED,
  SPLIT_DATE,
  LABEL_END,
  ROLES,
  BASE_CATALOG,
  LATE_COURSE,
  EMPLOYEES,
  ROLE_AFFINITY,
  LATE_COURSE_AFFINITY,
  mulberry32,
  generateDataset,
};
