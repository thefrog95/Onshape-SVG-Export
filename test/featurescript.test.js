import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFaceScript, decodeEvalResponse, validateFaceIds } from '../lib/featurescript.js';

test('embeds validated face ids in the script', () => {
  const script = buildFaceScript(['JHD', 'JKC']);
  assert.match(script, /for \(var fid in \["JHD", "JKC"\]\)/);
  assert.match(script, /^function\(context is Context, queries\)/);
});

test('rejects ids that could inject FeatureScript', () => {
  assert.throws(() => validateFaceIds(['JHD"]); evil(']), /Invalid face id/);
  assert.throws(() => validateFaceIds([]), /Select at least one face/);
});

test('decodes nested BTFSValue JSON', () => {
  const num = (v) => ({ btType: 'com.belmonttech.serialize.fsvalue.BTFSValueNumber', value: v });
  const str = (v) => ({ btType: 'com.belmonttech.serialize.fsvalue.BTFSValueString', value: v });
  const arr = (v) => ({ btType: 'com.belmonttech.serialize.fsvalue.BTFSValueArray', value: v });
  const map = (o) => ({
    btType: 'com.belmonttech.serialize.fsvalue.BTFSValueMap',
    value: Object.entries(o).map(([k, v]) => ({ key: str(k), value: v })),
  });
  const body = {
    result: arr([map({ id: str('JHD'), edges: arr([map({ kind: str('LINE'), points: arr([arr([num(0), num(1)])]) })]) })]),
    notices: [],
  };
  assert.deepEqual(decodeEvalResponse(body), [{ id: 'JHD', edges: [{ kind: 'LINE', points: [[0, 1]] }] }]);
});

test('reports FeatureScript errors from notices', () => {
  const body = { result: null, notices: [{ level: 'ERROR', message: { message: 'qTransient failed', level: 'ERROR' } }] };
  assert.throws(() => decodeEvalResponse(body), /qTransient failed/);
});
