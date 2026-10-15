import { coplanar, facesToSvg, boundingBox } from './svg.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const context = {
  documentId: params.get('documentId'),
  wvm: params.get('workspaceOrVersion') ?? 'w',
  wvmId: params.get('workspaceOrVersionId') ?? params.get('workspaceId'),
  elementId: params.get('elementId'),
};

// Onshape is the parent frame; only accept messages from Onshape origins.
function onshapeOrigin() {
  const candidates = [params.get('server'), document.referrer, 'https://cad.onshape.com'];
  for (const c of candidates) {
    try {
      const u = new URL(c);
      if (u.protocol === 'https:' && (u.hostname === 'onshape.com' || u.hostname.endsWith('.onshape.com'))) {
        return u.origin;
      }
    } catch { /* try next */ }
  }
  return 'https://cad.onshape.com';
}
const ONSHAPE_ORIGIN = onshapeOrigin();

// --- session ---------------------------------------------------------------
const SID_KEY = 'svg-export-sid';
function storeSid(sid) {
  try { sessionStorage.setItem(SID_KEY, sid); } catch { /* storage blocked */ }
  window.svgExportSid = sid;
}
function getSid() {
  try { return sessionStorage.getItem(SID_KEY) ?? window.svgExportSid; } catch { return window.svgExportSid; }
}
const hashSid = new URLSearchParams(location.hash.slice(1)).get('sid');
if (hashSid) {
  storeSid(hashSid);
  history.replaceState(null, '', location.pathname + location.search);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Session': getSid() ?? '', ...options.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showSignIn();
    throw new Error('Please sign in again.');
  }
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

function showSignIn() {
  $('signin').hidden = false;
  $('exporter').hidden = true;
}
function showExporter() {
  $('signin').hidden = true;
  $('exporter').hidden = false;
}

$('signin-button').addEventListener('click', () => {
  const returnTo = location.pathname + location.search;
  const start = `/oauth/start?returnTo=${encodeURIComponent(returnTo)}`;
  // Prefer a popup (Onshape's sign-in page may refuse to load inside a frame);
  // fall back to navigating this frame if popups are blocked.
  const popup = window.open(`${start}&popup=1`, 'onshape-signin', 'width=520,height=680');
  if (!popup) location.href = start;
});

window.addEventListener('message', (event) => {
  if (event.origin === location.origin && event.data?.type === 'svg-export-session') {
    storeSid(event.data.sid);
    showExporter();
    return;
  }
  if (event.origin !== ONSHAPE_ORIGIN) return;
  if (event.data?.messageName === 'SELECTION') onSelection(event.data.selections ?? []);
});

// --- selection ---------------------------------------------------------------
let selectedFaces = [];

function onSelection(selections) {
  selectedFaces = selections
    .filter((s) => s?.selectionId && (s.entityType ?? 'FACE').toUpperCase() === 'FACE')
    .map((s) => s.selectionId);
  const list = $('selection');
  list.replaceChildren(
    ...selectedFaces.map((id) => Object.assign(document.createElement('li'), { textContent: `Face ${id}` })),
  );
  $('selection-hint').textContent = selectedFaces.length
    ? `${selectedFaces.length} face${selectedFaces.length > 1 ? 's' : ''} selected.`
    : 'Select one or more planar faces in the graphics area.';
  $('export-button').disabled = selectedFaces.length === 0;
}

// --- export -----------------------------------------------------------------
const objectUrls = [];

function fileName(label) {
  return `${label.replace(/[^A-Za-z0-9_-]+/g, '_')}.svg`;
}

function renderResult(label, svg, faces) {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  const box = boundingBox(faces.flatMap((f) => f.edges));
  const w = (box.maxX - box.minX).toFixed(2);
  const h = (box.maxY - box.minY).toFixed(2);

  const card = document.createElement('article');
  card.className = 'result';
  card.innerHTML = `
    <h2></h2>
    <div class="preview"><img alt="SVG preview"></div>
    <p class="meta">${w} × ${h} mm</p>
    <div class="actions">
      <a class="download">Download</a>
      <button type="button" class="secondary copy">Copy SVG</button>
    </div>`;
  card.querySelector('h2').textContent = label;
  card.querySelector('img').src = url;
  const link = card.querySelector('.download');
  link.href = url;
  link.download = fileName(label);
  card.querySelector('.copy').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(svg);
      e.target.textContent = 'Copied';
    } catch {
      e.target.textContent = 'Copy blocked';
    }
  });
  $('results').append(card);
}

function renderError(label, message) {
  const card = document.createElement('article');
  card.className = 'result';
  const title = Object.assign(document.createElement('h2'), { textContent: label });
  const msg = Object.assign(document.createElement('p'), { className: 'face-error', textContent: message });
  card.append(title, msg);
  $('results').append(card);
}

const FACE_ERRORS = {
  NOT_PLANAR: 'This face is not planar and cannot be exported.',
  NOT_FOUND: 'Face not found. Reselect it and try again.',
};

$('export-button').addEventListener('click', async () => {
  const button = $('export-button');
  button.disabled = true;
  $('status').textContent = 'Reading geometry from Onshape…';
  objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  $('results').replaceChildren();
  try {
    const { faces } = await api('/api/faces', {
      method: 'POST',
      body: JSON.stringify({ ...context, faceIds: selectedFaces }),
    });
    const options = {
      margin: Math.max(0, Number($('margin').value) || 0),
      strokeWidth: Math.max(0.001, Number($('stroke').value) || 0.1),
      mirror: $('mirror').checked,
    };
    const good = faces.filter((f) => !f.error);
    faces.filter((f) => f.error).forEach((f) => renderError(`Face ${f.id}`, FACE_ERRORS[f.error] ?? f.error));

    if ($('combine').checked && good.length > 1 && coplanar(good)) {
      const label = `faces_${good.map((f) => f.id).join('_')}`.slice(0, 80);
      renderResult(label, facesToSvg(good, { ...options, title: label }), good);
    } else {
      for (const f of good) {
        const label = `face_${f.id}`;
        renderResult(label, facesToSvg([f], { ...options, title: label }), [f]);
      }
    }
    const note = $('combine').checked && good.length > 1 && !coplanar(good)
      ? ' Faces are not coplanar, so each was exported separately.'
      : '';
    $('status').textContent = `Done.${note}`;
  } catch (err) {
    $('status').textContent = '';
    renderError('Export failed', err.message);
  } finally {
    button.disabled = selectedFaces.length === 0;
  }
});

// --- start-up ---------------------------------------------------------------
async function init() {
  if (!context.documentId || !context.wvmId || !context.elementId) {
    $('context-error').hidden = false;
    return;
  }
  window.parent.postMessage(
    {
      messageName: 'applicationInit',
      documentId: context.documentId,
      workspaceId: context.wvmId,
      elementId: context.elementId,
    },
    ONSHAPE_ORIGIN,
  );
  try {
    const { signedIn } = await api('/api/session');
    if (signedIn) showExporter();
    else showSignIn();
  } catch {
    showSignIn();
  }
}

init();
