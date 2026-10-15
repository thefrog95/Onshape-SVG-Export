// Onshape SVG Export: a small, dependency-free server for the Onshape
// extension. It handles the OAuth sign-in, serves the panel, and evaluates
// FeatureScript in the user's Part Studio to read planar face geometry.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFaceScript, decodeEvalResponse, validateFaceIds } from './lib/featurescript.js';

const config = {
  port: Number(process.env.PORT ?? 3000),
  appUrl: (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  clientId: process.env.ONSHAPE_CLIENT_ID,
  clientSecret: process.env.ONSHAPE_CLIENT_SECRET,
  apiUrl: (process.env.ONSHAPE_API_URL ?? 'https://cad.onshape.com').replace(/\/$/, ''),
  oauthUrl: (process.env.ONSHAPE_OAUTH_URL ?? 'https://oauth.onshape.com').replace(/\/$/, ''),
};

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// In-memory stores. The panel runs in a third-party iframe where cookies are
// unreliable, so the session id travels in a header instead.
const sessions = new Map(); // sid -> { accessToken, refreshToken, expiresAt, lastUsed }
const pendingStates = new Map(); // state -> { returnTo, createdAt }

const newId = () => randomBytes(24).toString('base64url');

function prune() {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.lastUsed > SESSION_TTL_MS) sessions.delete(k);
  for (const [k, s] of pendingStates) if (now - s.createdAt > STATE_TTL_MS) pendingStates.delete(k);
}
setInterval(prune, 60 * 1000).unref();

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

async function tokenRequest(params) {
  const res = await fetch(`${config.oauthUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...params,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  const t = await res.json();
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + (Number(t.expires_in ?? 3600) - 60) * 1000,
  };
}

async function accessTokenFor(session) {
  if (Date.now() < session.expiresAt) return session.accessToken;
  Object.assign(
    session,
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
  );
  return session.accessToken;
}

function sessionFrom(req) {
  const sid = req.headers['x-session'];
  const session = typeof sid === 'string' ? sessions.get(sid) : undefined;
  if (session) session.lastUsed = Date.now();
  return session;
}

// Only allow returning to our own panel after sign-in.
function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function oauthStart(url, res) {
  if (!config.clientId || !config.clientSecret) {
    return send(res, 500, 'Server is missing ONSHAPE_CLIENT_ID / ONSHAPE_CLIENT_SECRET');
  }
  const state = newId();
  pendingStates.set(state, {
    returnTo: safeReturnTo(url.searchParams.get('returnTo')),
    popup: url.searchParams.get('popup') === '1',
    createdAt: Date.now(),
  });
  const authorize = new URL(`${config.oauthUrl}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: `${config.appUrl}/oauth/callback`,
    state,
  }).toString();
  send(res, 302, '', { Location: authorize.toString() });
}

async function oauthCallback(url, res) {
  const state = url.searchParams.get('state');
  const pending = state && pendingStates.get(state);
  if (!pending) return send(res, 400, 'Sign-in expired or invalid. Reopen the panel and try again.');
  pendingStates.delete(state);
  const code = url.searchParams.get('code');
  if (!code) return send(res, 400, `Sign-in was not completed: ${url.searchParams.get('error') ?? 'no code'}`);
  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${config.appUrl}/oauth/callback`,
  });
  const sid = newId();
  sessions.set(sid, { ...tokens, lastUsed: Date.now() });
  if (pending.popup) {
    // Signed in from a popup window: hand the session to the panel and close.
    const html = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<p>Signed in. You can close this window.</p>
<script>
  const sid = ${JSON.stringify(sid)};
  if (window.opener) { window.opener.postMessage({ type: 'svg-export-session', sid }, location.origin); window.close(); }
  else { location.replace(${JSON.stringify(pending.returnTo)} + '#sid=' + sid); }
</script>`;
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
  }
  // The fragment never reaches any server; the panel moves it to sessionStorage.
  send(res, 302, '', { Location: `${pending.returnTo}#sid=${sid}` });
}

const WVM = new Set(['w', 'v', 'm']);
const ONSHAPE_ID = /^[0-9a-f]{24}$/i;

async function exportFaces(req, res) {
  const session = sessionFrom(req);
  if (!session) return send(res, 401, { error: 'Not signed in' });
  const body = await readJson(req);
  const { documentId, wvm, wvmId, elementId, faceIds } = body;
  if (![documentId, wvmId, elementId].every((id) => ONSHAPE_ID.test(String(id))) || !WVM.has(wvm)) {
    return send(res, 400, { error: 'Missing or invalid document context' });
  }
  try {
    validateFaceIds(faceIds);
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
  const token = await accessTokenFor(session);
  const endpoint =
    `${config.apiUrl}/api/v10/partstudios/d/${documentId}/${wvm}/${wvmId}/e/${elementId}/featurescript`;
  const apiRes = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json;charset=UTF-8; qs=0.09',
    },
    body: JSON.stringify({ script: buildFaceScript(faceIds), queries: [] }),
  });
  if (apiRes.status === 401) {
    sessions.delete(req.headers['x-session']);
    return send(res, 401, { error: 'Onshape session expired' });
  }
  if (!apiRes.ok) {
    return send(res, 502, { error: `Onshape API error ${apiRes.status}: ${(await apiRes.text()).slice(0, 500)}` });
  }
  let faces;
  try {
    faces = decodeEvalResponse(await apiRes.json());
  } catch (err) {
    return send(res, 502, { error: err.message });
  }
  send(res, 200, { faces });
}

async function serveStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 404, 'Not found');
  try {
    const data = await readFile(file);
    send(res, 200, data, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch {
    send(res, 404, 'Not found');
  }
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, config.appUrl);
  try {
    if (req.method === 'GET' && url.pathname === '/oauth/start') return oauthStart(url, res);
    if (req.method === 'GET' && url.pathname === '/oauth/callback') return await oauthCallback(url, res);
    if (req.method === 'GET' && url.pathname === '/api/session') {
      return send(res, 200, { signedIn: Boolean(sessionFrom(req)) });
    }
    if (req.method === 'POST' && url.pathname === '/api/faces') return await exportFaces(req, res);
    if (req.method === 'GET') return await serveStatic(url, res);
    send(res, 405, 'Method not allowed');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, err.status ?? 500, { error: err.message });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(config.port, () => console.log(`Onshape SVG Export listening on ${config.appUrl} (port ${config.port})`));
}
