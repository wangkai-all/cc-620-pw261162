'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

function request(port, reqPath, options = {}) {
  const payload = options.body ? JSON.stringify(options.body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method: options.method || (payload ? 'POST' : 'GET'),
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const isJson = String(res.headers['content-type'] || '').includes('application/json');
          resolve({ status: res.statusCode, body: isJson && raw ? JSON.parse(raw) : raw });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务器启动超时')), 5000);
    child.stdout.on('data', (chunk) => {
      const m = String(chunk).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => reject(new Error(`服务器提前退出，code=${code}`)));
  });
  return { child, port };
}

test('HTTP：完整流程 + 异常路径（真实 127.0.0.1 服务，无外部依赖）', async (t) => {
  const { child, port } = await startServer();
  t.after(() => child.kill('SIGTERM'));

  // 首页与静态资源（首页是 HTML，直接读取文本校验 evidence 属性）
  const homeText = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/`, (res) => {
      assert.equal(res.statusCode, 200);
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
  assert.match(homeText, /data-evidence-result="replay"/);
  assert.match(homeText, /新增后开放课程/);

  const appJs = await request(port, '/app.js');
  assert.equal(appJs.status, 200);
  const css = await request(port, '/styles.css');
  assert.equal(css.status, 200);

  // 初始状态
  const state0 = await request(port, '/api/state');
  assert.equal(state0.status, 200);
  assert.equal(state0.body.hasBaseRun, false);
  assert.equal(state0.body.hasExtendedRun, false);

  // 异常①：未重放先新增 → 409
  const earlyAdd = await request(port, '/api/actions', { body: { action: 'add-late-course' } });
  assert.equal(earlyAdd.status, 409);
  assert.equal(earlyAdd.body.error, 'ACTION_OUT_OF_ORDER');

  // 异常②：未重放先看差异 → 409（顺序错误优先报出）
  const earlyDiff = await request(port, '/api/actions', { body: { action: 'diff' } });
  assert.equal(earlyDiff.status, 409);
  assert.equal(earlyDiff.body.error, 'ACTION_OUT_OF_ORDER');

  // ① 重放
  const replay = await request(port, '/api/actions', { body: { action: 'replay' } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.correct.mode, 'correct');
  assert.equal(replay.body.naive.mode, 'naive');
  assert.ok(Array.isArray(replay.body.correct.recommendations));
  assert.equal(replay.body.correct.evaluation.totals.recommendedInvisible, 0);

  // 异常②b：已重放但未新增就看差异 → LATE_COURSE_NOT_ADDED
  const diffTooEarly = await request(port, '/api/actions', { body: { action: 'diff' } });
  assert.equal(diffTooEarly.status, 409);
  assert.equal(diffTooEarly.body.error, 'LATE_COURSE_NOT_ADDED');

  // ② 新增后开放课程
  const add = await request(port, '/api/actions', { body: { action: 'add-late-course' } });
  assert.equal(add.status, 200);
  assert.equal(add.body.correct.evaluation.totals.recommendedInvisible, 0);
  assert.ok(add.body.naive.evaluation.totals.recommendedInvisible > 0);

  // 异常③：重复新增 → 409
  const dup = await request(port, '/api/actions', { body: { action: 'add-late-course' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'LATE_COURSE_ALREADY_ADDED');

  // ③ 差异
  const diff = await request(port, '/api/actions', { body: { action: 'diff' } });
  assert.equal(diff.status, 200);
  assert.equal(diff.body.diff.allInvariantsPassed, true);
  assert.ok(diff.body.diff.metricRows.length === 4);

  // 最终状态
  const state1 = await request(port, '/api/state');
  assert.equal(state1.status, 200);
  assert.equal(state1.body.hasBaseRun, true);
  assert.equal(state1.body.hasExtendedRun, true);
  assert.equal(state1.body.hasDiff, true);
  assert.ok(state1.body.diff.invariants.every((i) => i.passed));

  // 异常④：未知操作 → 400
  const badAction = await request(port, '/api/actions', { body: { action: 'drop-table' } });
  assert.equal(badAction.status, 400);
  assert.equal(badAction.body.error, 'UNKNOWN_ACTION');

  // 异常⑤：非法 JSON → 400
  const badJson = await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/actions', method: 'POST',
        headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      },
    );
    req.end('{not-json');
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error, 'INVALID_JSON');

  // 异常⑥：未知接口与路径穿越保护
  const noApi = await request(port, '/api/nope');
  assert.equal(noApi.status, 404);
  const traversal = await request(port, '/..%2f..%2fpackage.json');
  assert.equal(traversal.status, 404);

  // 重放可再次执行并重置
  const replayAgain = await request(port, '/api/actions', { body: { action: 'replay' } });
  assert.equal(replayAgain.status, 200);
  const state2 = await request(port, '/api/state');
  assert.equal(state2.body.hasExtendedRun, false);
});
