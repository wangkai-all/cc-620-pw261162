'use strict';

// 仅使用 Node.js 内置模块。启动：node server.js（PORT 由环境变量读取，默认 3000）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  createStore,
  actionReplay,
  actionAddLateCourse,
  actionDiff,
  serializeState,
  ScenarioError,
} = require('./scenarios');
const { RecommendationError } = require('./rules');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  // 路径穿越保护：只允许 public 目录内的文件
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'FORBIDDEN', message: '禁止访问该路径' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'NOT_FOUND', message: `静态资源不存在：${rel}` });
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'content-length': data.length,
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new ScenarioError('BODY_TOO_LARGE', '请求体超过 64KiB 限制'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ScenarioError('INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createApp() {
  const store = createStore();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return serveStatic(res, '/');
      }
      if (req.method === 'GET' && pathname === '/app.js') return serveStatic(res, '/app.js');
      if (req.method === 'GET' && pathname === '/styles.css') return serveStatic(res, '/styles.css');

      if (req.method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, serializeState(store));
      }

      if (req.method === 'POST' && pathname === '/api/actions') {
        const body = await readBody(req);
        const action = body.action;
        let result;
        switch (action) {
          case 'replay':
            result = actionReplay(store);
            break;
          case 'add-late-course':
            result = actionAddLateCourse(store);
            break;
          case 'diff':
            result = actionDiff(store);
            break;
          default:
            return sendJson(res, 400, { error: 'UNKNOWN_ACTION', message: `未知操作：${String(action)}` });
        }
        return sendJson(res, 200, result);
      }

      if (req.method === 'GET' && pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'NOT_FOUND', message: `接口不存在：${pathname}` });
      }
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: `不支持的方法：${req.method}` });
      }
      return sendJson(res, 404, { error: 'NOT_FOUND', message: `路径不存在：${pathname}` });
    } catch (err) {
      if (err instanceof ScenarioError || err instanceof RecommendationError) {
        const status = err.code === 'ACTION_OUT_OF_ORDER' ||
          err.code === 'LATE_COURSE_NOT_ADDED' ||
          err.code === 'LATE_COURSE_ALREADY_ADDED'
          ? 409
          : 400;
        return sendJson(res, status, { error: err.code, message: err.message });
      }
      return sendJson(res, 500, { error: 'INTERNAL', message: err.message || '服务器内部错误' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = createApp();
  server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port;
    // 同时回显配置端口与实际端口（PORT=0 时由系统分配，测试据此解析）
    console.log(`course-replay server listening on http://127.0.0.1:${actual} (PORT=${port})`);
  });
}

module.exports = { createApp };
