'use strict';

const SHARED_OBSERVABILITY_PREFIX = '/api/module-lifecycle';
const MODULE_OPERATION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

function upstreamPath(pathname) {
  if (pathname === `${SHARED_OBSERVABILITY_PREFIX}/modules/shared-observability`) {
    return '/api/modules/shared-observability';
  }
  if (pathname === `${SHARED_OBSERVABILITY_PREFIX}/modules/shared-observability/operations`) {
    return '/api/modules/shared-observability/operations';
  }
  if (pathname === `${SHARED_OBSERVABILITY_PREFIX}/modules/shared-observability/verify`) {
    return '/api/modules/shared-observability/verify';
  }
  const operation = pathname.match(new RegExp(
    `^${SHARED_OBSERVABILITY_PREFIX}/module-operations/(${MODULE_OPERATION_ID})$`,
    'i',
  ));
  return operation ? `/api/module-operations/${operation[1]}` : '';
}

function forwardedHeaders(req) {
  const headers = {
    accept: 'application/json',
    authorization: String(req.headers?.authorization || ''),
  };
  const contentType = String(req.headers?.['content-type'] || '');
  const correlationId = String(req.headers?.['x-os-correlation-id'] || '');
  const idempotencyKey = String(req.headers?.['x-os-idempotency-key'] || '');
  if (/^application\/json(?:;|$)/i.test(contentType)) headers['content-type'] = contentType;
  if (/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)) headers['x-os-correlation-id'] = correlationId;
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(idempotencyKey)) {
    headers['x-os-idempotency-key'] = idempotencyKey;
  }
  return headers;
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw { code: 413, msg: 'module lifecycle request body too large' };
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function createModuleLifecycleProxy({
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = 20000,
} = {}) {
  const upstream = String(baseUrl || '').replace(/\/$/, '');
  if (!upstream) throw new Error('module lifecycle authority baseUrl is required');

  return async function moduleLifecycleProxy(req, res, pathname) {
    const targetPath = upstreamPath(pathname);
    if (!targetPath) return false;
    if (!['GET', 'POST'].includes(req.method)) {
      res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return true;
    }

    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const response = await fetchImpl(`${upstream}${targetPath}`, {
        method: req.method,
        headers: forwardedHeaders(req),
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const responseBody = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      });
      res.end(responseBody);
    } catch (error) {
      const code = Number(error?.code) >= 400 ? Number(error.code) : 503;
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        error: error?.msg || 'Console module lifecycle authority unavailable',
        errorCode: 'module_authority_unavailable',
      }));
    }
    return true;
  };
}

module.exports = {
  SHARED_OBSERVABILITY_PREFIX,
  createModuleLifecycleProxy,
  forwardedHeaders,
  upstreamPath,
};
