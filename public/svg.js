// Turns face geometry (as returned by lib/featurescript.js) into SVG.
// Shared by the browser panel and the Node tests, so it has no dependencies.
//
// Input face: { id, origin:[x,y,z] mm, normal:[...], xAxis:[...],
//               edges: [{ kind: 'LINE'|'CIRCLE'|'OTHER', points:[[x,y]...],
//                         center?:[x,y], radius? }] }
// Edge points are in the face's own 2D plane frame, in mm, with y up.

const EPS = 1e-3; // mm, endpoint matching tolerance

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const same = (a, b, tol = EPS) => dist(a, b) <= tol;

function fmt(n) {
  const s = (Math.abs(n) < 1e-9 ? 0 : n).toFixed(4);
  return s.replace(/\.?0+$/, '') || '0';
}

const frameY = (face) => cross3(face.normal, face.xAxis);

// Are all faces in the same plane, facing the same way?
export function coplanar(faces, tol = 1e-4) {
  if (faces.length < 2) return true;
  const [ref, ...rest] = faces;
  return rest.every(
    (f) =>
      dot(f.normal, ref.normal) > 1 - tol &&
      Math.abs(dot(sub(f.origin, ref.origin), ref.normal)) < EPS * 10,
  );
}

// Re-express a face's 2D edge points in the 2D frame of another, coplanar face.
function reproject(face, ref) {
  if (face === ref) return face.edges;
  const fy = frameY(face);
  const ry = frameY(ref);
  const map = ([x, y]) => {
    const w = face.origin.map((o, i) => o + x * face.xAxis[i] + y * fy[i]);
    const d = sub(w, ref.origin);
    return [dot(d, ref.xAxis), dot(d, ry)];
  };
  return face.edges.map((e) => ({
    ...e,
    points: e.points.map(map),
    ...(e.center ? { center: map(e.center) } : {}),
  }));
}

// Convert plane coordinates (y up) to SVG coordinates (y down), optionally
// mirrored left-right (handy when cutting from the back side).
function toSvgEdges(edges, mirror) {
  const m = ([x, y]) => [mirror ? -x : x, -y];
  return edges.map((e) => ({
    ...e,
    points: e.points.map(m),
    ...(e.center ? { center: m(e.center) } : {}),
  }));
}

const reverseEdge = (e) => ({ ...e, points: [...e.points].reverse() });
const start = (e) => e.points[0];
const end = (e) => e.points[e.points.length - 1];

// Order edges into connected chains so each loop becomes one closed path.
export function chainEdges(edges) {
  const pending = edges.filter((e) => e.points.length >= 2);
  const chains = [];
  while (pending.length) {
    const chain = [pending.shift()];
    let grew = true;
    while (grew && !(chain.length > 1 && same(end(chain.at(-1)), start(chain[0])))) {
      grew = false;
      const tip = end(chain.at(-1));
      for (let i = 0; i < pending.length; i++) {
        const e = pending[i];
        if (same(start(e), tip)) chain.push(e);
        else if (same(end(e), tip)) chain.push(reverseEdge(e));
        else continue;
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains;
}

function arcCommand(e, to) {
  const r = e.radius;
  const [s, m, f] = [start(e), e.points[Math.floor(e.points.length / 2)], end(e)];
  if (same(s, f)) {
    // Full circle: two half arcs through the diametrically opposite point.
    const c = e.center;
    const opp = [2 * c[0] - s[0], 2 * c[1] - s[1]];
    return `A${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(opp[0])} ${fmt(opp[1])}` +
      `A${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(to[0])} ${fmt(to[1])}`;
  }
  const turn = (m[0] - s[0]) * (f[1] - m[1]) - (m[1] - s[1]) * (f[0] - m[0]);
  const sweep = turn > 0 ? 1 : 0;
  // Large arc when the midpoint lies on the far side of the chord from the
  // centre, i.e. the arc spans more than 180°.
  const chord = [f[0] - s[0], f[1] - s[1]];
  const side = (p) => chord[0] * (p[1] - s[1]) - chord[1] * (p[0] - s[0]);
  const large = e.center && side(m) * side(e.center) > 0 ? 1 : 0;
  return `A${fmt(r)} ${fmt(r)} 0 ${large} ${sweep} ${fmt(to[0])} ${fmt(to[1])}`;
}

function chainToPath(chain) {
  const closed = same(end(chain.at(-1)), start(chain[0]));
  let d = `M${fmt(start(chain[0])[0])} ${fmt(start(chain[0])[1])}`;
  chain.forEach((e, i) => {
    // Snap the final endpoint exactly onto the start so the path closes cleanly.
    const to = closed && i === chain.length - 1 ? start(chain[0]) : end(e);
    if (e.kind === 'CIRCLE' && e.radius > 0) d += arcCommand(e, to);
    else {
      for (const p of e.points.slice(1, -1)) d += `L${fmt(p[0])} ${fmt(p[1])}`;
      d += `L${fmt(to[0])} ${fmt(to[1])}`;
    }
  });
  return closed ? d + 'Z' : d;
}

// Points that bound an edge: its samples, plus the circle extremes that lie
// on the arc (so arcs bulging past their endpoints are not clipped).
function extentPoints(e) {
  if (e.kind !== 'CIRCLE' || !e.center) return e.points;
  const pts = [...e.points];
  const [c, r] = [e.center, e.radius];
  const s = start(e);
  const f = end(e);
  const m = e.points[Math.floor(e.points.length / 2)];
  const ang = (p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const full = same(s, f);
  const a0 = ang(s);
  const ccw = norm(ang(m) - a0) <= norm(ang(f) - a0); // increasing angle s→m→f
  const span = full ? 2 * Math.PI : ccw ? norm(ang(f) - a0) : norm(a0 - ang(f));
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const off = ccw ? norm(a - a0) : norm(a0 - a);
    if (full || off <= span) pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return pts;
}

export function boundingBox(edges) {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const e of edges) {
    for (const [x, y] of extentPoints(e)) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Build an SVG document (true scale, units mm) from one or more faces.
 * Several faces are combined into one drawing; they must be coplanar.
 */
export function facesToSvg(faces, options = {}) {
  const { margin = 0, strokeWidth = 0.1, stroke = '#000000', mirror = false, title } = options;
  if (!faces.length) throw new Error('No faces to export');
  if (!coplanar(faces)) throw new Error('Faces are not coplanar; export them separately');
  const ref = faces[0];
  const edges = toSvgEdges(faces.flatMap((f) => reproject(f, ref)), mirror);
  const paths = chainEdges(edges).map(chainToPath);
  const box = boundingBox(edges);
  const x = box.minX - margin;
  const y = box.minY - margin;
  const w = Math.max(box.maxX - box.minX + 2 * margin, 1e-3);
  const h = Math.max(box.maxY - box.minY + 2 * margin, 1e-3);
  const body = paths.map((d) => `    <path d="${d}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)}">
${title ? `  <title>${escapeXml(title)}</title>\n` : ''}  <g fill="none" stroke="${escapeXml(stroke)}" stroke-width="${fmt(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" fill-rule="evenodd">
${body}
  </g>
</svg>
`;
}
