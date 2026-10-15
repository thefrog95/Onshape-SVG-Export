import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facesToSvg, chainEdges, boundingBox, coplanar } from '../public/svg.js';

const XY = { origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] };
const line = (a, b) => ({ kind: 'LINE', points: [a, b] });

// 40 x 20 mm rectangle with a Ø10 hole at (10, 10); edges deliberately
// shuffled and partly reversed, as Onshape returns them unordered.
const plate = {
  id: 'JHD',
  ...XY,
  edges: [
    line([40, 0], [40, 20]),
    { kind: 'CIRCLE', points: [[15, 10], [5, 10], [15, 10]], center: [10, 10], radius: 5 },
    line([0, 0], [40, 0]),
    line([0, 20], [0, 0]),
    line([0, 20], [40, 20]),
  ],
};

test('chains unordered edges into closed loops', () => {
  const chains = chainEdges(plate.edges);
  assert.equal(chains.length, 2);
  assert.deepEqual(chains.map((c) => c.length).sort(), [1, 4]);
});

test('produces a true-scale SVG in millimetres', () => {
  const svg = facesToSvg([plate]);
  assert.match(svg, /width="40mm" height="20mm" viewBox="0 -20 40 20"/);
  const paths = svg.match(/<path d="[^"]+"\/>/g);
  assert.equal(paths.length, 2);
  assert.ok(paths.every((p) => p.includes('Z')), 'loops are closed');
  // Full circle becomes two half arcs of radius 5.
  assert.match(svg, /A5 5 0 1 1 5 -10A5 5 0 1 1 15 -10Z/);
});

test('margin grows the canvas', () => {
  const svg = facesToSvg([plate], { margin: 2 });
  assert.match(svg, /width="44mm" height="24mm" viewBox="-2 -22 44 24"/);
});

test('mirror flips x', () => {
  const svg = facesToSvg([plate], { mirror: true });
  assert.match(svg, /viewBox="-40 -20 40 20"/);
});

test('arc flags: quarter vs three-quarter arcs', () => {
  const s = Math.SQRT1_2 * 10;
  // Quarter arc from (10,0) counter-clockwise to (0,10), centre at origin.
  const quarter = { kind: 'CIRCLE', points: [[10, 0], [s, s], [0, 10]], center: [0, 0], radius: 10 };
  const svgQ = facesToSvg([{ ...XY, edges: [quarter, line([0, 10], [0, 0]), line([0, 0], [10, 0])] }]);
  // In SVG (y down) a CCW arc in plane coordinates sweeps with flag 0.
  assert.match(svgQ, /A10 10 0 0 0 0 -10/);

  const big = { kind: 'CIRCLE', points: [[10, 0], [-s, -s], [0, 10]], center: [0, 0], radius: 10 };
  const svgB = facesToSvg([{ ...XY, edges: [big, line([0, 10], [0, 0]), line([0, 0], [10, 0])] }]);
  assert.match(svgB, /A10 10 0 1 1 0 -10/);
});

test('bounding box includes arc bulge beyond endpoints', () => {
  // Semicircle from (10,0) over the top to (-10,0): top point y=10 not sampled at ends.
  const arc = { kind: 'CIRCLE', points: [[10, 0], [0, 10], [-10, 0]], center: [0, 0], radius: 10 };
  const box = boundingBox([arc]);
  assert.equal(box.maxY, 10);
  assert.equal(box.minY, 0);
});

test('combines coplanar faces in the first face frame', () => {
  const other = {
    id: 'JKD',
    origin: [100, 0, 0],
    normal: [0, 0, 1],
    xAxis: [0, 1, 0], // rotated 90° relative to the first face
    edges: [line([0, 0], [10, 0]), line([10, 0], [10, -5]), line([10, -5], [0, -5]), line([0, -5], [0, 0])],
  };
  assert.ok(coplanar([plate, other]));
  const svg = facesToSvg([plate, other]);
  // Second face spans x 100..105, y 0..10 in the first face frame.
  assert.match(svg, /width="105mm" height="20mm"/);
});

test('rejects non-coplanar faces', () => {
  const tilted = { ...plate, normal: [0, 1, 0], xAxis: [1, 0, 0] };
  assert.equal(coplanar([plate, tilted]), false);
  assert.throws(() => facesToSvg([plate, tilted]), /not coplanar/);
});
