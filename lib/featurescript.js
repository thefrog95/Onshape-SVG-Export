// Builds the FeatureScript that Onshape evaluates to extract planar face
// geometry, and decodes the BTFSValue JSON that the evaluation returns.

const ID_PATTERN = /^[A-Za-z0-9_.+:-]{1,64}$/;

// Number of sample points requested per edge, by curve type. Lines only need
// their endpoints; circles need a midpoint to know which way the arc sweeps;
// everything else (splines, ellipses, ...) is exported as a polyline.
const SAMPLES = { LINE: 2, CIRCLE: 3, OTHER: 97 };

export function validateFaceIds(faceIds) {
  if (!Array.isArray(faceIds) || faceIds.length === 0) {
    throw new Error('Select at least one face');
  }
  if (faceIds.length > 200) throw new Error('Too many faces selected');
  for (const id of faceIds) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new Error(`Invalid face id: ${JSON.stringify(id)}`);
    }
  }
  return faceIds;
}

// Returns, per face, its plane (in mm, world space) and every bounding edge
// sampled and projected into the face plane's 2D coordinate system (mm).
// Coordinates: x along plane.x, y along normal × x, viewed from outside the
// part (looking against the face normal).
export function buildFaceScript(faceIds) {
  validateFaceIds(faceIds);
  const ids = faceIds.map((id) => JSON.stringify(id)).join(', ');
  return `function(context is Context, queries) {
    var project = function(p, plane, yDir) {
        var d = p - plane.origin;
        return [dot(d, plane.x) / millimeter, dot(d, yDir) / millimeter];
    };
    var faces = [];
    for (var fid in [${ids}]) {
        var face = qTransient(fid as TransientId);
        if (size(evaluateQuery(context, face)) == 0) {
            faces = append(faces, { "id" : fid, "error" : "NOT_FOUND" });
            continue;
        }
        var plane;
        try silent {
            plane = evPlane(context, { "face" : face });
        }
        if (plane == undefined) {
            faces = append(faces, { "id" : fid, "error" : "NOT_PLANAR" });
            continue;
        }
        var yDir = cross(plane.normal, plane.x);
        var edges = [];
        for (var edge in evaluateQuery(context, qAdjacent(face, AdjacencyType.EDGE, EntityType.EDGE))) {
            if (evLength(context, { "entities" : edge }) < 1e-9 * meter) {
                continue;
            }
            var curve = evCurveDefinition(context, { "edge" : edge });
            var kind = "OTHER";
            var count = ${SAMPLES.OTHER};
            if (curve is Line) {
                kind = "LINE";
                count = ${SAMPLES.LINE};
            } else if (curve is Circle) {
                kind = "CIRCLE";
                count = ${SAMPLES.CIRCLE};
            }
            var parameters = [];
            for (var i = 0; i < count; i += 1) {
                parameters = append(parameters, i / (count - 1));
            }
            var tangents = evEdgeTangentLines(context, { "edge" : edge, "parameters" : parameters });
            var points = [];
            for (var t in tangents) {
                points = append(points, project(t.origin, plane, yDir));
            }
            var entry = { "kind" : kind, "points" : points };
            if (kind == "CIRCLE") {
                entry.center = project(curve.coordSystem.origin, plane, yDir);
                entry.radius = curve.radius / millimeter;
            }
            edges = append(edges, entry);
        }
        faces = append(faces, {
            "id" : fid,
            "origin" : [plane.origin[0] / millimeter, plane.origin[1] / millimeter, plane.origin[2] / millimeter],
            "normal" : [plane.normal[0], plane.normal[1], plane.normal[2]],
            "xAxis" : [plane.x[0], plane.x[1], plane.x[2]],
            "edges" : edges
        });
    }
    return faces;
}`;
}

// Onshape returns FeatureScript values as nested typed JSON, e.g.
// { typeTag: "", btType: "...BTFSValueArray", value: [ ... ] }. Convert that
// to plain JSON. Map entries are { key: <BTFSValue>, value: <BTFSValue> }.
export function decodeFsValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decodeFsValue);
  const type = String(v.btType ?? v.type ?? '');
  if (type.includes('BTFSValueMap')) {
    const out = {};
    for (const entry of v.value ?? []) {
      out[String(decodeFsValue(entry.key))] = decodeFsValue(entry.value);
    }
    return out;
  }
  if (type.includes('BTFSValueArray')) return (v.value ?? []).map(decodeFsValue);
  if (type.includes('BTFSValueUndefined')) return null;
  if (type.includes('BTFSValueWithUnits')) {
    return { value: v.value, unitToPower: v.unitToPower };
  }
  if ('value' in v) return decodeFsValue(v.value);
  return v;
}

export function decodeEvalResponse(body) {
  const errors = (body?.notices ?? [])
    .filter((n) => n?.level === 'ERROR' || n?.message?.level === 'ERROR')
    .map((n) => n?.message?.message ?? n?.message ?? JSON.stringify(n));
  if (body?.result == null) {
    const detail = errors.length ? errors.join('; ') : 'empty result';
    throw new Error(`FeatureScript evaluation failed: ${detail}`);
  }
  return decodeFsValue(body.result);
}
