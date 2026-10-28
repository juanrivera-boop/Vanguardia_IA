'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const REPLICATE_PREFIX = '/api/replicate';
const SAMBANOVA_PREFIX = '/api/sambanova';
const XAI_PREFIX = '/api/xai';
const NVIDIA_PREFIX = '/api/nvidia';
const PHP_PROXY_PATH = '/api-proxy.php';
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(body));
}

async function proxyReplicate(request, response, requestUrl) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.setHeader('Allow', 'GET, POST');
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const upstreamPath = requestUrl.pathname.slice(REPLICATE_PREFIX.length);
  const isPredictionRoute = upstreamPath === '/v1/predictions' || upstreamPath.startsWith('/v1/predictions/');
  if (!upstreamPath.startsWith('/v1/models/') && !isPredictionRoute) {
    sendJson(response, 404, { error: 'Replicate route not found' });
    return;
  }

  const authorization = request.headers.authorization;
  if (!authorization || !authorization.startsWith('Bearer ')) {
    sendJson(response, 401, { error: 'Replicate API token is required' });
    return;
  }

  try {
    const headers = { Authorization: authorization };
    if (request.headers['content-type']) headers['Content-Type'] = request.headers['content-type'];
    if (request.headers.prefer) headers.Prefer = request.headers.prefer;

    let body;
    if (request.method === 'POST') {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 3 * 1024 * 1024) {
          sendJson(response, 413, { error: 'Replicate request is too large' });
          return;
        }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }

    const upstreamUrl = new URL(`${upstreamPath}${requestUrl.search}`, 'https://api.replicate.com');
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      ...(body ? { body } : {})
    });
    const responseHeaders = {
      'Cache-Control': 'no-store',
      'Content-Type': upstream.headers.get('content-type') || 'application/json'
    };
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) responseHeaders['Retry-After'] = retryAfter;
    response.writeHead(upstream.status, responseHeaders);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    sendJson(response, 502, { error: `Replicate proxy failed: ${error.message}` });
  }
}

async function proxySambaNova(request, response, requestUrl) {
  const upstreamPath = requestUrl.pathname.slice(SAMBANOVA_PREFIX.length);
  if (request.method !== 'POST' || upstreamPath !== '/v1/chat/completions') {
    response.setHeader('Allow', 'POST');
    sendJson(response, 404, { error: 'SambaNova route not found' });
    return;
  }

  const authorization = request.headers.authorization;
  if (!authorization || !authorization.startsWith('Bearer ')) {
    sendJson(response, 401, { error: 'SambaNova API key is required' });
    return;
  }

  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 3 * 1024 * 1024) {
        sendJson(response, 413, { error: 'SambaNova request is too large' });
        return;
      }
      chunks.push(chunk);
    }

    const upstream = await fetch(`https://api.sambanova.ai${upstreamPath}${requestUrl.search}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': request.headers['content-type'] || 'application/json'
      },
      body: Buffer.concat(chunks)
    });
    const responseHeaders = {
      'Cache-Control': 'no-store',
      'Content-Type': upstream.headers.get('content-type') || 'application/json'
    };
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) responseHeaders['Retry-After'] = retryAfter;
    response.writeHead(upstream.status, responseHeaders);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    sendJson(response, 502, { error: `SambaNova proxy failed: ${error.message}` });
  }
}

async function proxyImageProviders(request, response, requestUrl, provider) {
  const prefix = provider === 'xai' ? XAI_PREFIX : NVIDIA_PREFIX;
  const upstreamPath = requestUrl.pathname.slice(prefix.length);
  const targets = provider === 'xai'
    ? {
        '/v1/chat/completions': 'https://api.x.ai/v1/chat/completions',
        '/v1/images/generations': 'https://api.x.ai/v1/images/generations'
      }
    : {
        '/v1/chat/completions': 'https://integrate.api.nvidia.com/v1/chat/completions',
        '/v1/genai/stabilityai/stable-diffusion-3-medium': 'https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium'
      };
  if (request.method !== 'POST' || !targets[upstreamPath]) {
    response.setHeader('Allow', 'POST');
    sendJson(response, 404, { error: `${provider} route not found` });
    return;
  }

  const authorization = request.headers.authorization;
  if (!authorization || !authorization.startsWith('Bearer ')) {
    sendJson(response, 401, { error: `${provider} API key is required` });
    return;
  }

  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 3 * 1024 * 1024) {
        sendJson(response, 413, { error: `${provider} request is too large` });
        return;
      }
      chunks.push(chunk);
    }

    const headers = {
      Authorization: authorization,
      'Content-Type': request.headers['content-type'] || 'application/json'
    };
    if (request.headers.accept) headers.Accept = request.headers.accept;
    const upstream = await fetch(targets[upstreamPath], {
      method: 'POST',
      headers,
      body: Buffer.concat(chunks)
    });
    const responseHeaders = {
      'Cache-Control': 'no-store',
      'Content-Type': upstream.headers.get('content-type') || 'application/json'
    };
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) responseHeaders['Retry-After'] = retryAfter;
    response.writeHead(upstream.status, responseHeaders);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    sendJson(response, 502, { error: `${provider} proxy failed: ${error.message}` });
  }
}

function serveStatic(request, response, requestUrl) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) || path.basename(filePath) === 'server.js') {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': stat.size,
      'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(filePath).pipe(response);
  });
}

http.createServer((request, response) => {
  let requestUrl;
  try {
    requestUrl = new URL(request.url, `http://${HOST}:${PORT}`);
  } catch {
    sendJson(response, 400, { error: 'Invalid URL' });
    return;
  }

  if (requestUrl.pathname === PHP_PROXY_PATH) {
    const provider = requestUrl.searchParams.get('provider');
    const upstreamPath = requestUrl.searchParams.get('path') || '';
    requestUrl.pathname = `${provider === 'replicate' ? REPLICATE_PREFIX : SAMBANOVA_PREFIX}${upstreamPath}`;
    requestUrl.search = '';
    if (provider === 'replicate') proxyReplicate(request, response, requestUrl);
    else if (provider === 'sambanova') proxySambaNova(request, response, requestUrl);
    else if (provider === 'xai' || provider === 'nvidia') {
      requestUrl.pathname = `${provider === 'xai' ? XAI_PREFIX : NVIDIA_PREFIX}${upstreamPath}`;
      proxyImageProviders(request, response, requestUrl, provider);
    }
    else sendJson(response, 404, { error: 'Provider route not found' });
  } else if (requestUrl.pathname.startsWith(REPLICATE_PREFIX)) {
    proxyReplicate(request, response, requestUrl);
  } else if (requestUrl.pathname.startsWith(SAMBANOVA_PREFIX)) {
    proxySambaNova(request, response, requestUrl);
  } else {
    serveStatic(request, response, requestUrl);
  }
}).listen(PORT, HOST, () => {
  console.log(`App local disponible en http://${HOST}:${PORT}`);
  console.log('Los proxies de Replicate, SambaNova, xAI y NVIDIA solo escuchan en esta computadora.');
});