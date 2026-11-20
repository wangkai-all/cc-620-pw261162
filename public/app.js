'use strict';

// 前端：三次操作都在同一会话内完成，结果区均带 data-evidence-result 便于前后核对。
const $ = (sel) => document.querySelector(sel);

const BUCKET_TEXT = {
  HIT: '命中：已推荐且窗口内完成',
  WASTED: '看到了没完成：已推荐、已开放、未完成',
  MISSED: '漏召：已开放、窗口内完成但没推荐',
  INVISIBLE_HIT: '泄漏命中：推荐了 T 时未开放的课程且后来完成',
  INVISIBLE_REC_NOT_DONE: '泄漏推荐：推荐了未开放课程且未完成',
  INVISIBLE_LABEL_ONLY: '看不到却完成了：课程未开放、未推荐、后来完成',
  NOT_VISIBLE: '看不到课程：未开放、未推荐、未完成',
  VISIBLE_NOT_DONE: '看到了没完成：已开放、未推荐、未完成',
};

const METRIC_TEXT = {
  precision: '精确率（仅统计可见推荐）',
  recall: '召回率（可见标签）',
  coverage: '员工覆盖率',
  hitRatePerEmployee: '人均命中数',
  invisibleRecommendationRate: '不可见课程推荐占比',
  invisibleHitRate: '不可见推荐“命中率”',
  inflatedPrecisionIfLeakIgnored: '错误承认泄漏命中后的虚高精确率',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const num3 = (x) => Number(x).toFixed(3);

function courseChip(id, lateId) {
  const cls = id === lateId ? 'course-chip late' : 'course-chip';
  return `<span class="${cls}">${esc(id)}</span>`;
}

function tag(text, kind) {
  return `<span class="tag tag-${kind}">${esc(text)}</span>`;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const payload = await res.json();
  if (!res.ok) {
    const err = new Error(payload.message || '请求失败');
    err.code = payload.error;
    err.status = res.status;
    throw err;
  }
  return payload;
}

function renderTimeline(state) {
  const c = state.constants;
  const late = state.lateCourse;
  $('#timelineTrack').innerHTML = [
    `<span class="tl-item">2026-01 起：C1~C8 陆续开放（T 前全部可见）</span>`,
    `<span class="tl-item tl-split">T = ${c.SPLIT_DATE}：候选生成 / 特征截断</span>`,
    `<span class="tl-item tl-late">${late.catalogOpenAt}：${late.id} 才开放（晚于 T）</span>`,
    `<span class="tl-item tl-end">评估窗口结束 = ${c.LABEL_END}（标签只用 [T, 结束) 的完成事件）</span>`,
  ].join('');
}

function metricCards(pipe, lateId) {
  const m = pipe.evaluation.metrics;
  const t = pipe.evaluation.totals;
  const cards = [
    ['精确率', pct(m.precision)],
    ['召回率', pct(m.recall)],
    ['覆盖率', pct(m.coverage)],
    ['命中数 HIT', t.hits],
    ['看到了没完成 WASTED', t.wasted],
    ['看不到课程 NOT_VISIBLE', t.notVisible],
    ['不可见推荐数', t.recommendedInvisible],
  ];
  return `<div class="summary-grid" data-evidence-result="metric-cards">
    ${cards.map(([k, v]) => `<div class="summary-card"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}
  </div>
  <div class="note" data-evidence-result="pipeline-context">
    特征口径：futureStats=<span class="mono">${pipe.context.futureStats}</span>，
    useFutureCatalog=<span class="mono">${pipe.context.useFutureCatalog}</span>；
    T 时可见目录 ${pipe.evaluation.visibleCatalogSize} 门 / 全目录 ${pipe.evaluation.catalogSize} 门
    ${lateId ? `；后开放课程 ${lateId} 的 catalogOpenAt 晚于 T` : ''}
  </div>`;
}

function candidateTable(pipe, employees, lateId) {
  const rows = pipe.recommendations.map((r) => {
    const emp = employees.find((e) => e.id === r.employeeId);
    const chips = r.recommendations.length
      ? r.recommendations.map((x) => courseChip(x.courseId, lateId)).join('')
      : '<span class="tag tag-neutral">无候选</span>';
    return `<tr>
      <td>${esc(emp.id)} ${esc(emp.name)}</td>
      <td>${esc(emp.roleId)}</td>
      <td>${esc(r.reasonText)}</td>
      <td>${chips}</td>
    </tr>`;
  }).join('');
  return `<table data-evidence-result="candidate-table">
    <thead><tr><th>员工</th><th>岗位</th><th>推荐说明</th><th>候选（Top ${5}）</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderReplay(payload, state) {
  const lateId = state.lateCourse.id;
  $('#panelReplay').hidden = false;
  $('#replayBody').innerHTML = `
    <div class="note">${esc(payload.message)}</div>
    <div class="two-col">
      <div class="col-correct" data-evidence-result="replay-correct">
        <h3>${tag('正确时间切分（点时间纪律）', 'ok')}</h3>
        ${metricCards(payload.correct, null)}
        ${candidateTable(payload.correct, state.employees, null)}
      </div>
      <div class="col-naive" data-evidence-result="replay-naive">
        <h3>${tag('错误时间切分（未来事件补旧特征）', 'bad')}</h3>
        ${metricCards(payload.naive, null)}
        ${candidateTable(payload.naive, state.employees, null)}
      </div>
    </div>`;
}

function renderAdd(payload, state) {
  const lateId = state.lateCourse.id;
  const correctLatePicks = payload.correct.recommendations.filter((r) =>
    r.recommendations.some((x) => x.courseId === lateId));
  const naiveLatePicks = payload.naive.recommendations.filter((r) =>
    r.recommendations.some((x) => x.courseId === lateId));

  const leakNote = `
    <div class="note" data-evidence-result="leak-note">
      错误切分的两处违规：① <strong>未来目录泄漏</strong>——候选目录使用了 T 之后才开放的 C9；
      ② <strong>未来事件补旧特征</strong>——岗位共性统计混入 T 之后的完成事件。
      正确切分的岗位统计只用 T 前事件，且候选目录严格等于 T 时可见目录。
    </div>`;

  const treatment = `
    <div class="two-col" data-evidence-result="late-course-treatment">
      <div class="col-correct">
        <h3>${tag('正确切分如何对待 C9', 'ok')}</h3>
        <p>推荐 C9 的员工数：<strong>${correctLatePicks.length}</strong>
        （C9 在 T 时未开放，正确流水线从候选源头排除，评价中只进入 NOT_VISIBLE / INVISIBLE_LABEL_ONLY 桶）</p>
      </div>
      <div class="col-naive">
        <h3>${tag('错误切分如何对待 C9', 'bad')}</h3>
        <p>推荐 C9 的员工数：<strong>${naiveLatePicks.length}</strong>
        （错误流水线把未来目录与未来完成事件混入，C9 泄漏进候选；员工在 T 时根本看不到这门课）</p>
        <p>涉及员工：${naiveLatePicks.map((r) => esc(r.employeeId)).join('、') || '无'}</p>
      </div>
    </div>`;

  $('#panelAdd').hidden = false;
  $('#addBody').innerHTML = `
    <div class="note">${esc(payload.message)}</div>
    ${leakNote}
    ${treatment}
    <div class="two-col">
      <div class="col-correct" data-evidence-result="add-correct">
        <h3>${tag('扩展目录 · 正确切分', 'ok')}</h3>
        ${metricCards(payload.correct, lateId)}
        ${candidateTable(payload.correct, state.employees, lateId)}
      </div>
      <div class="col-naive" data-evidence-result="add-naive">
        <h3>${tag('扩展目录 · 错误切分', 'bad')}</h3>
        ${metricCards(payload.naive, lateId)}
        ${candidateTable(payload.naive, state.employees, lateId)}
      </div>
    </div>`;
}

function renderDiff(payload, state) {
  const d = payload.diff;
  const lateId = d.lateCourse.id;

  const metricRows = d.metricRows.map((r) => {
    const kind = r.mode === 'correct' ? 'ok' : 'bad';
    const scope = r.withLateCourse ? '扩展目录(含C9)' : '基线目录';
    return `<tr>
      <td>${esc(scope)}</td>
      <td>${tag(r.mode === 'correct' ? '正确切分' : '错误切分', kind)}</td>
      <td class="num">${pct(r.precision)}</td>
      <td class="num">${pct(r.recall)}</td>
      <td class="num">${pct(r.coverage)}</td>
      <td class="num">${num3(r.hitRatePerEmployee)}</td>
      <td class="num">${pct(r.invisibleRecommendationRate)}</td>
      <td class="num">${r.invisibleHitsCount}</td>
      <td class="num">${r.notVisibleCount}</td>
      <td class="num">${r.visibleNotDoneCount}</td>
      <td class="num">${pct(r.inflatedPrecisionIfLeakIgnored)}</td>
    </tr>`;
  }).join('');

  const candidateRows = d.candidateComparison.map((r) => `
    <tr>
      <td>${esc(r.employeeId)} ${esc(r.employeeName)}</td>
      <td>${r.baseCorrect.map((id) => courseChip(id, lateId)).join('') || '<span class="tag tag-neutral">空</span>'}</td>
      <td>${r.baseNaive.map((id) => courseChip(id, lateId)).join('') || '<span class="tag tag-neutral">空</span>'}</td>
      <td>${r.extendedCorrect.map((id) => courseChip(id, lateId)).join('') || '<span class="tag tag-neutral">空</span>'}</td>
      <td>${r.extendedNaive.map((id) => courseChip(id, lateId)).join('') || '<span class="tag tag-neutral">空</span>'}</td>
      <td>${r.correctStable ? tag('一致 ✓', 'ok') : tag('变化 ✗', 'bad')}</td>
      <td>${r.naivePicksLateCourse ? tag('C9 泄漏', 'bad') : tag('—', 'neutral')}</td>
    </tr>`).join('');

  const bucketRows = d.lateCourseBuckets.map((b) => `
    <tr>
      <td>${esc(b.employeeId)}</td>
      <td>${b.bucket ? tag(BUCKET_TEXT[b.bucket] || b.bucket, b.bucket === 'NOT_VISIBLE' ? 'warn' : 'primary') : '—'}</td>
    </tr>`).join('');

  const invariantHtml = d.invariants.map((iv) => `
    <div class="invariant ${iv.passed ? 'pass' : 'fail'}" data-evidence-result="invariant-item">
      <span>${iv.passed ? tag('通过', 'ok') : tag('失败', 'bad')}</span>
      <div>
        <div class="iv-title">${esc(iv.description)}</div>
        <div class="iv-detail">${esc(iv.detail)}</div>
      </div>
    </div>`).join('');

  const delta = d.metricDelta;
  $('#panelDiff').hidden = false;
  $('#diffBody').innerHTML = `
    <div class="note" data-evidence-result="diff-summary">
      扩展目录下错误切分相对正确切分：精确率差 ${signedPct(delta.precision)}，
      召回率差 ${signedPct(delta.recall)}，覆盖率差 ${signedPct(delta.coverage)}，
      不可见课程推荐占比差 ${signedPct(delta.invisibleRecommendationRate)}。
      不变量核对：${d.allInvariantsPassed ? tag('全部通过', 'ok') : tag('存在失败', 'bad')}
    </div>

    <h3>指标对照（4 种组合）</h3>
    <div style="overflow-x:auto" data-evidence-result="diff-metrics">
      <table>
        <thead><tr>
          <th>目录</th><th>切分方式</th><th class="num">精确率</th><th class="num">召回率</th>
          <th class="num">覆盖率</th><th class="num">人均命中</th><th class="num">不可见推荐占比</th>
          <th class="num">泄漏命中数</th><th class="num">NOT_VISIBLE</th>
          <th class="num">VISIBLE_NOT_DONE</th><th class="num">虚高精确率(错误口径)</th>
        </tr></thead>
        <tbody>${metricRows}</tbody>
      </table>
    </div>

    <h3>逐员工候选对照（C9 高亮为黄色）</h3>
    <div style="overflow-x:auto" data-evidence-result="diff-candidates">
      <table>
        <thead><tr>
          <th>员工</th><th>基线·正确</th><th>基线·错误</th>
          <th>扩展·正确</th><th>扩展·错误</th><th>正确候选前后一致？</th><th>错误候选泄漏 C9？</th>
        </tr></thead>
        <tbody>${candidateRows}</tbody>
      </table>
    </div>

    <h3>C9 评价分桶（看不到 ≠ 看到了没完成）</h3>
    <div style="overflow-x:auto" data-evidence-result="diff-buckets">
      <table>
        <thead><tr><th>员工</th><th>C9 所属桶</th></tr></thead>
        <tbody>${bucketRows}</tbody>
      </table>
      <div class="note">
        NOT_VISIBLE（根本看不到）：${d.bucketSummary.notVisibleEmployees.length} 人；
        INVISIBLE_LABEL_ONLY（课程开放后完成，但 T 时看不到）：${d.bucketSummary.invisibleLabelOnlyEmployees.length} 人。
        两类均与 VISIBLE_NOT_DONE（看得到但没完成）严格隔离，不互相污染。
      </div>
    </div>

    <h3>点时间纪律不变量</h3>
    <div data-evidence-result="diff-invariants">${invariantHtml}</div>`;
}

function signedPct(x) {
  const s = (x * 100).toFixed(1);
  return `${x >= 0 ? '+' : ''}${s}个百分点`;
}

function setButtons(state) {
  $('#btnAdd').disabled = !state.hasBaseRun || state.hasExtendedRun;
  $('#btnDiff').disabled = !state.hasExtendedRun;
}

function showError(err) {
  const box = $('#errorBox');
  box.hidden = false;
  box.textContent = `操作被拒绝（HTTP ${err.status || ''} / ${err.code || 'ERROR'}）：${err.message}`;
  $('#actionStatus').textContent = '上一步操作失败';
}

function clearError() {
  $('#errorBox').hidden = true;
  $('#errorBox').textContent = '';
}

async function doAction(action, renderer) {
  clearError();
  $('#actionStatus').textContent = '执行中…';
  try {
    const payload = await api('/api/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const state = await api('/api/state');
    setButtons(state);
    renderer(payload, state);
    $('#actionStatus').textContent = `已完成：${payload.message}`;
  } catch (err) {
    showError(err);
    const state = await api('/api/state');
    setButtons(state);
  }
}

$('#btnReplay').addEventListener('click', () => doAction('replay', renderReplay));
$('#btnAdd').addEventListener('click', () => doAction('add-late-course', renderAdd));
$('#btnDiff').addEventListener('click', () => doAction('diff', renderDiff));

(async function init() {
  try {
    const state = await api('/api/state');
    renderTimeline(state);
    setButtons(state);
    $('#actionStatus').textContent = state.hasBaseRun ? '已有历史运行，可继续或重放重置' : '就绪，请从①开始';
  } catch (err) {
    showError(err);
  }
})();
