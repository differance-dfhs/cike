import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { PolicyError } from './engine.mjs';
import { artifactNameFromPathname, artifactResponseHeaders } from './artifact-security.mjs';

const BODY_LIMIT = 64 * 1024;
const ACCESS_TOKEN_HEADER = 'x-cike-session-token';
const ALLOWED_ORIGINS = new Set([
  'null',
  'http://127.0.0.1:5189',
  'http://localhost:5189',
]);

function setCommonHeaders(response, request) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  const origin = request.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
}

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function requestOriginAllowed(request) {
  const origin = request.headers.origin;
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function requestTokenAllowed(request, expectedToken) {
  if (!expectedToken) return true;
  const provided = String(request.headers[ACCESS_TOKEN_HEADER] || '');
  const expected = String(expectedToken);
  if (!provided || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new PolicyError('请求内容过大。', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PolicyError('请求不是有效的 JSON。', 400);
  }
}

function snapshotResponse(result) {
  if (!result?.snapshot) return result;
  return {
    ...result.snapshot,
    ...(result.job ? { accepted: true, job: result.job } : {}),
  };
}

function contentTypeFor(name) {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';
  if (name.endsWith('.md') || name.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

export function createHttpService(options) {
  const { engine, runner, host = '127.0.0.1', port = 4318, accessToken = '' } = options;
  const server = http.createServer(async (request, response) => {
    setCommonHeaders(response, request);
    if (!requestOriginAllowed(request)) {
      json(response, 403, { error: '请求来源不被允许。' });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', `Content-Type, ${ACCESS_TOKEN_HEADER}`);
      response.end();
      return;
    }
    if (!requestTokenAllowed(request, accessToken)) {
      json(response, 401, { error: '本地会话令牌无效。' });
      return;
    }

    const url = new URL(request.url || '/', `http://${host}:${port}`);
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        json(response, 200, {
          ok: true,
          service: 'cike-proactive-agent',
          policy: 'local-proactive-external-confirm',
          now: new Date().toISOString(),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/snapshot') {
        json(response, 200, await engine.getSnapshot({ reason: 'api' }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/codex-runtime') {
        json(response, 200, await engine.getCodexRuntime());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/scan') {
        await readJsonBody(request);
        json(response, 200, await engine.getSnapshot({ force: true, reason: 'manual' }));
        return;
      }

      const actionMatch = url.pathname.match(/^\/api\/opportunities\/([a-z0-9-]{3,80})\/action$/u);
      if (request.method === 'POST' && actionMatch) {
        const body = await readJsonBody(request);
        const result = await engine.actOnOpportunity(actionMatch[1], body.action);
        json(response, result.job ? 202 : 200, snapshotResponse(result));
        return;
      }

      const feedbackMatch = url.pathname.match(/^\/api\/opportunities\/([a-z0-9-]{3,80})\/feedback$/u);
      if (request.method === 'POST' && feedbackMatch) {
        const body = await readJsonBody(request);
        const result = await engine.rateOpportunity(feedbackMatch[1], body.rating, body.note);
        json(response, 200, snapshotResponse(result));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/interactions') {
        const body = await readJsonBody(request);
        json(response, 200, await engine.recordInteraction(body));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/jobs') {
        json(response, 200, { jobs: runner.listJobs() });
        return;
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]{3,80})$/u);
      if (request.method === 'GET' && jobMatch) {
        const job = runner.getJob(jobMatch[1]);
        if (!job) throw new PolicyError('任务不存在。', 404);
        json(response, 200, job);
        return;
      }

      const artifactPrefix = '/api/artifacts/';
      if (request.method === 'GET' && url.pathname.startsWith(artifactPrefix)) {
        const name = artifactNameFromPathname(url.pathname);
        if (!name) throw new PolicyError('产物名不合法。', 400);
        const filePath = path.join(runner.artifactsDir, name);
        let info;
        try {
          info = await lstat(filePath);
        } catch {
          throw new PolicyError('产物不存在或尚未生成。', 404);
        }
        if (!info.isFile() || info.isSymbolicLink() || info.size > 12 * 1024 * 1024) {
          throw new PolicyError('产物无法预览。', 400);
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', contentTypeFor(name));
        response.setHeader('Content-Length', info.size);
        response.setHeader('Content-Disposition', `inline; filename="${name}"`);
        for (const [header, value] of Object.entries(artifactResponseHeaders())) response.setHeader(header, value);
        const stream = createReadStream(filePath);
        stream.on('error', () => response.destroy());
        stream.pipe(response);
        return;
      }

      json(response, 404, { error: '接口不存在。' });
    } catch (error) {
      const statusCode = error instanceof PolicyError ? error.statusCode : 500;
      json(response, statusCode, {
        error: error instanceof PolicyError ? error.message : '本地服务暂时不可用。',
      });
    }
  });

  return {
    host,
    get port() {
      const address = server.address();
      return address && typeof address === 'object' ? address.port : port;
    },
    server,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve(this);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },
  };
}

export const httpServiceInternals = { ACCESS_TOKEN_HEADER, requestTokenAllowed };
