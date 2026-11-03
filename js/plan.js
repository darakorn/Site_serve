// Room geometry from a wall walk, and SVG floor-plan rendering.
// A room is walked wall by wall starting at corner A heading right (east).
// After each wall the walker turns by `turn` degrees (+ = right, − = left).
// Walking clockwise keeps the room on the walker's right; a plain rectangle is four right turns.

const VW = 400;
const INK = '#222';
const DIM = '#777';
const ACC = '#1f6f5c';
const GLASS = '#d6ecf8', GLASS_LINE = '#2f86c0';
const CLEAR = '#b4540a';   // a free-standing item measured off the walls
const DIMLINE = '#2c5aa0'; // dimensions drawn on the plan
const FREE_DIM = '#555';   // a free-standing wall's own length
const RED = '#d93025';
const FONT = "'Sarabun','Noto Sans Thai','Leelawadee UI',system-ui,sans-serif";

export const fmtM = cm => ((+cm || 0) / 100).toFixed(2);

// Lengths are stored in cm; a project picks the unit used for typing and for plan labels.
// k: factor from cm, fix: decimals on plan labels, input: decimals kept when showing a value in a form.
export const UNITS = {
  mm: { k: 10, label: 'mm', fix: 0, input: 1 },
  cm: { k: 1, label: 'cm', fix: 0, input: 2 },
  m: { k: 0.01, label: 'm', fix: 2, input: 4 },
};
export const unitOf = u => (UNITS[u] ? u : 'cm');
export const toUnit = (cm, u) => (cm === '' || cm == null ? '' : +((+cm || 0) * UNITS[unitOf(u)].k).toFixed(UNITS[unitOf(u)].input));
export const fromUnit = (v, u) => +(v / UNITS[unitOf(u)].k).toFixed(3);
export function fmtLen(cm, u) {
  const { k, fix } = UNITS[unitOf(u)], v = (+cm || 0) * k;
  // cm keeps a half-centimetre when one was measured; the others use a fixed format.
  const r = d => (Math.round(v * 10 ** d + 1e-9) / 10 ** d).toFixed(d); // 3.505 → 3.51, not toFixed's 3.50
  return unitOf(u) === 'cm' && Math.round(v) !== +r(1) ? r(1) : r(fix);
}
export const fmtArea = cm2 => (cm2 / 10000).toFixed(2) + ' m²';
export const cornerName = i => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
export const normAngle = a => Math.round(((((a % 360) + 540) % 360) - 180) * 10) / 10;

export const OPEN_STYLES = {
  door: { swing: 'Hinged', slide: 'Sliding', double: 'Double-acting' },
  window: { casement: 'Casement', slide: 'Sliding', awning: 'Awning', open: 'Plain opening (no sash)' },
};
// Which way a sliding door's leaves run: apart from the middle, or all to one side (as seen from
// inside the room). One leaf can't part in the middle.
export const SLIDE_WAYS = { center: 'Opens from the middle', left: 'Slides to the left', right: 'Slides to the right' };
export const slideWay = (o, leaves) => (o.slide === 'left' || o.slide === 'right' ? o.slide : leaves > 1 ? 'center' : 'left');
export const OPEN_STYLE_DEFAULTS = { door: { style: 'swing', leaves: 1 }, window: { style: 'slide', leaves: 2 } };
export const MAX_LEAVES = { door: 4, window: 6 };

// Style and leaf count of a door/window, falling back to defaults for older records.
export function openStyle(o) {
  const d = OPEN_STYLE_DEFAULTS[o.type];
  if (!d) return null;
  const style = OPEN_STYLES[o.type][o.style] ? o.style : d.style;
  const leaves = style === 'open' ? 1 : Math.min(MAX_LEAVES[o.type], Math.max(1, parseInt(o.leaves) || d.leaves));
  return { style, leaves, label: OPEN_STYLES[o.type][style] };
}

/**
 * Plan symbol of a door or window as lines and quarter arcs, in any coordinate space.
 * a: start point on the wall line, u: unit along the wall, n: unit into the room,
 * (o.swing === 'out' opens a swing door away from the room; o.hinge === 'right' mirrors a door so
 * its hinge is on the right as seen from inside the room — the wall's end corner),
 * w: opening width, t: symbol depth (wall thickness), mid: offset of the frame centre along n,
 * fw: width of a door's frame jambs.
 * Returns [{ line: [p, q], dash }, { arc: { c, from, to }, dash }].
 */
export function openingShapes(o, a, u, n, w, t, mid = 0, fw = 0) {
  const st = openStyle(o);
  if (!st) return [];
  const { style, leaves: L } = st;
  const way = o.type === 'door' && style === 'slide' ? slideWay(o, L) : null;
  const flip = o.type === 'door' && (way ? way === 'right' : o.hinge === 'right');
  const out = [];
  const ln = (p, q, dash = false) => out.push({ line: [p, q], dash });
  // A door's frame: a jamb fw wide through the wall thickness at each side; the leaves hang
  // between them.
  const jamb = o.type === 'door' ? Math.min(Math.max(0, fw), w / 4) : 0;
  if (jamb) {
    const R = (along, across) => add(add(a, u, along), n, across);
    for (const x of [0, w - jamb]) {
      const c = [R(x, mid - t / 2), R(x + jamb, mid - t / 2), R(x + jamb, mid + t / 2), R(x, mid + t / 2)];
      c.forEach((p, i) => ln(p, c[(i + 1) % 4]));
    }
    a = add(a, u, jamb);
    w -= 2 * jamb;
  }
  const lw = w / L;
  const P = (along, across = 0) => add(add(a, u, flip ? w - along : along), n, across);
  // Leaves hinge on the outer jambs, meeting in the middle.
  const hinges = () => Array.from({ length: L }, (_, i) => {
    const left = L === 1 || i < L / 2;
    return { h: i * lw + (left ? 0 : lw), dir: left ? 1 : -1 };
  });
  const swing = (side, dash) => {
    for (const { h, dir } of hinges()) {
      const hp = P(h), leaf = P(h, side * lw);
      ln(hp, leaf, dash);
      out.push({ arc: { c: hp, from: leaf, to: P(h + dir * lw) }, dash: true });
    }
  };
  // Sliding door leaves with an arrow inside the room for the way each one opens. Parting from
  // the middle, the leaves either side of it run apart, the inner ones on the track nearer the
  // room; to one side (drawn as to the left, mirrored for right) they stack up on alternate tracks.
  const sliding = depth => {
    const lap = Math.min(lw * 0.08, t), head = Math.min(lw * 0.12, t * 0.8), y = Math.max(t * 0.9, head * 1.5);
    const arrow = (from, to) => {
      const d = Math.sign(to - from);
      ln(P(from, y), P(to, y));
      ln(P(to, y), P(to - d * head, y - head * 0.6));
      ln(P(to, y), P(to - d * head, y + head * 0.6));
    };
    for (let i = 0; i < L; i++) {
      const toLeft = way !== 'center' || i < L / 2;
      // Middle: count out from the centre; one side: from the end the leaves gather at.
      const rank = way === 'center' ? (toLeft ? Math.floor(L / 2) - 1 - i : i - Math.ceil(L / 2)) : i;
      const k = L === 1 || (way === 'center' && L === 2) ? 0 : (rank % 2 ? -1 : 1) * depth;
      ln(P(Math.max(0, i * lw - lap), mid + k), P(Math.min(w, (i + 1) * lw + lap), mid + k));
      const c = (i + 0.5) * lw;
      arrow(toLeft ? c + lw * 0.25 : c - lw * 0.25, toLeft ? c - lw * 0.25 : c + lw * 0.25);
    }
  };
  const panels = depth => {
    const lap = Math.min(lw * 0.08, t);
    for (let i = 0; i < L; i++) {
      const k = (L === 1 ? 0 : i % 2 ? 1 : -1) * depth;
      ln(P(Math.max(0, i * lw - lap), mid + k), P(Math.min(w, (i + 1) * lw + lap), mid + k));
    }
  };

  if (o.type === 'door') {
    if (style === 'swing') swing(o.swing === 'out' ? -1 : 1, false);
    else if (style === 'double') { swing(1, false); swing(-1, true); }
    else sliding(t / 4);
    return out;
  }

  // Window frame on both faces with jamb ticks, then the sash symbol. A plain window opening is
  // only the hole: jambs, and the sill dashed across it.
  const plain = style === 'open';
  for (const k of [-t / 2, t / 2]) ln(P(0, mid + k), P(w, mid + k), plain);
  for (const x of [0, w]) ln(P(x, mid - t / 2), P(x, mid + t / 2));
  if (plain) return out;
  if (style === 'slide') {
    panels(t / 6);
    return out;
  }
  ln(P(0, mid), P(w, mid));
  for (let i = 1; i < L; i++) ln(P(i * lw, mid - t / 2), P(i * lw, mid + t / 2));
  if (style === 'casement') {
    // Sashes open outward.
    for (const { h, dir } of hinges()) {
      const hp = P(h, mid - t / 2), leaf = P(h, mid - t / 2 - lw);
      ln(hp, leaf, true);
      out.push({ arc: { c: hp, from: leaf, to: P(h + dir * lw, mid - t / 2) }, dash: true });
    }
  } else {
    // Awning: sash pushed out from the bottom hinge, drawn as a dashed V per leaf.
    for (let i = 0; i < L; i++) {
      const tip = P((i + 0.5) * lw, mid - t / 2 - Math.min(lw * 0.35, t * 2.5));
      ln(P(i * lw, mid - t / 2), tip, true);
      ln(tip, P((i + 1) * lw, mid - t / 2), true);
    }
  }
  return out;
}

// Door and window tags (D1, D2…, W1, W2…) numbered in wall order through the room, unless the
// opening has its own `tag`. Returns Map opening id → tag.
export function openingTags(room) {
  const tags = new Map(), count = { door: 0, window: 0 };
  for (const w of [...room.walls, ...freeWalls(room)]) {
    for (const o of w.openings || []) {
      if (!(o.type in count)) continue;
      count[o.type]++;
      tags.set(o.id, String(o.tag || '').trim() || `${o.type === 'door' ? 'D' : 'W'}${count[o.type]}`);
    }
  }
  return tags;
}

// Points along a wall (cm from its start corner) where doors, windows and openings begin and end,
// for a chain dimension. null when the wall has none.
export function chainBreaks(sg) {
  const cuts = [];
  for (const o of sg.wall.openings || []) {
    const off = clamp(+o.offset || 0, 0, sg.len), w = clamp(+o.width || 0, 0, sg.len - off);
    if (w) cuts.push(off, off + w);
  }
  if (!cuts.length) return null;
  return [...new Set([0, ...cuts, sg.len].map(v => Math.round(v * 10) / 10))].sort((a, b) => a - b);
}

// Column footprint in plan cm: `offset` along the wall from its start corner, `gap` out from the
// wall into the room, `width` along the wall and `depth` into the room. A round column
// (shape 'round') has diameter `width`. Returns { round: { c, r } } or { corners: [4 points] }.
export function columnShape(sg, c) {
  const w = Math.max(0, +c.width || 0), d = c.shape === 'round' ? w : Math.max(0, +c.depth || 0);
  if (!w || !d) return null;
  const { p: base, t, n } = segPoint(sg, clamp(+c.offset || 0, 0, sg.len));
  const p = add(base, n, Math.max(0, +c.gap || 0));
  if (c.shape === 'round') return { round: { c: add(add(p, t, w / 2), n, w / 2), r: w / 2 } };
  return { corners: [p, add(p, t, w), add(add(p, t, w), n, d), add(p, n, d)] };
}
// A free-standing column (room.columns): x, y is its centre in plan cm from corner A, axis-aligned.
export function freeColumnShape(c) {
  const w = Math.max(0, +c.width || 0), d = c.shape === 'round' ? w : Math.max(0, +c.depth || 0);
  if (!w || !d) return null;
  const x = +c.x || 0, y = +c.y || 0;
  if (c.shape === 'round') return { round: { c: { x, y }, r: w / 2 } };
  return { corners: boxCorners({ x, y }, w, d, +c.rot || 0) };
}

// Corners of a w × d box centred on c and turned rot degrees (clockwise on the plan), in the order
// top-left, top-right, bottom-right, bottom-left as it stands before turning.
export function boxCorners(c, w, d, rot = 0) {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => turnAbout({ x: c.x + (i * w) / 2, y: c.y + (j * d) / 2 }, c, rot));
}
export function turnAbout(p, c, deg) {
  if (!deg) return { ...p };
  const r = (deg * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r), dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs };
}
// A drawn rectangle's corners, turned by its rotation about its centre.
export function rectCorners(sh) {
  const w = +sh.w || 0, h = +sh.h || 0;
  return boxCorners({ x: (+sh.x || 0) + w / 2, y: (+sh.y || 0) + h / 2 }, w, h, +sh.rot || 0);
}
export const inwardFor = cw => u => (cw ? { x: -u.y, y: u.x } : { x: u.y, y: -u.x });

// Point on a wall at `x` cm along its chord (straight line from corner to corner), with the unit
// tangent `t` and the unit normal `n` into the room there. Straight walls: t = u everywhere.
export function segPoint(sg, x) {
  const { arc } = sg;
  if (!arc) return { p: add(sg.p0, sg.u, x), t: sg.u, n: sg.inward };
  const X = x - sg.len / 2, root = Math.sqrt(Math.max(0, arc.r * arc.r - X * X));
  const y = arc.sign * (root - (arc.r - Math.abs(arc.h)));
  // At the ends of a half circle the arc runs straight out from (or back into) the chord.
  if (!root) {
    const t = add({ x: 0, y: 0 }, arc.out, X < 0 ? arc.sign : -arc.sign);
    return { p: add(add(sg.p0, sg.u, x), arc.out, y), t, n: sg.inwardOf(t) };
  }
  const slope = (-arc.sign * X) / root;
  const tv = add(sg.u, arc.out, slope), k = Math.hypot(tv.x, tv.y);
  const t = { x: tv.x / k, y: tv.y / k };
  return { p: add(add(sg.p0, sg.u, x), arc.out, y), t, n: sg.inwardOf(t) };
}

// Things drawn into the plan (counters, built-ins…), in plan cm from corner A, y down:
// line { x1, y1, x2, y2 }, rect { x, y, w, h }, circle { x, y (centre), d (diameter) }; each may have a label.
export const SHAPE_TYPES = { line: 'Line', rect: 'Rectangle', circle: 'Circle', wall: 'Free wall' };
// Drawn items that run from one point to another: a line, or a free-standing wall (a wall in the
// room that isn't part of its outline), which has a thickness and a wall type.
export const segShape = sh => sh.type === 'line' || sh.type === 'wall';

// The free-standing walls of a room (drawn items of type "wall").
export const freeWalls = room => (room.shapes || []).filter(sh => sh.type === 'wall');

// A free-standing wall as a wall segment, so doors and windows sit on it the way they do on the
// room's walls: measured from its start (x1, y1), its "inside" face on the left of start → end.
export function freeWallSeg(sh, defT) {
  const [p0, p1] = shapePoints(sh), len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (!len) return null;
  const u = { x: (p1.x - p0.x) / len, y: (p1.y - p0.y) / len }, left = v => ({ x: -v.y, y: v.x });
  const t = +sh.thickness > 0 ? +sh.thickness : +defT > 0 ? +defT : WALL_T;
  return { wall: sh, i: -1, p0, p1, u, len, heading: (Math.atan2(u.y, u.x) * 180) / Math.PI, inward: left(u), inwardOf: left, free: true, glass: sh.kind === 'glass', t };
}

// A free-standing wall's outline: its thickness centred on the line it was drawn along.
export function freeWallCorners(sh, defT) {
  const [p, q] = shapePoints(sh), len = Math.hypot(q.x - p.x, q.y - p.y);
  if (!len) return null;
  const t = +sh.thickness > 0 ? +sh.thickness : +defT > 0 ? +defT : WALL_T, n = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len };
  return [add(p, n, t / 2), add(q, n, t / 2), add(q, n, -t / 2), add(p, n, -t / 2)];
}
export function shapePoints(sh) {
  if (segShape(sh)) return [{ x: +sh.x1 || 0, y: +sh.y1 || 0 }, { x: +sh.x2 || 0, y: +sh.y2 || 0 }];
  if (sh.type === 'rect') return [{ x: +sh.x || 0, y: +sh.y || 0 }, { x: (+sh.x || 0) + (+sh.w || 0), y: (+sh.y || 0) + (+sh.h || 0) }];
  const r = (+sh.d || 0) / 2;
  return [{ x: (+sh.x || 0) - r, y: (+sh.y || 0) - r }, { x: (+sh.x || 0) + r, y: (+sh.y || 0) + r }];
}
const shapeCenter = sh => mid(...shapePoints(sh));

// Bounding box of something placed in the room — a free-standing column or a drawn rectangle /
// circle — for measuring it off the walls. Lines have none.
export function itemBox(it) {
  // A turned one is measured from the box around it.
  const around = pts => ({ x0: Math.min(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)), x1: Math.max(...pts.map(p => p.x)), y1: Math.max(...pts.map(p => p.y)) });
  if (it.shape === 'rect' || it.shape === 'round') {
    const sh = freeColumnShape(it);
    if (!sh) return null;
    return sh.round ? around([add(sh.round.c, { x: 1, y: 1 }, -sh.round.r), add(sh.round.c, { x: 1, y: 1 }, sh.round.r)]) : around(sh.corners);
  }
  if (it.type === 'rect') return around(rectCorners(it));
  if (it.type === 'circle') return around(shapePoints(it));
  return null;
}

// How far a box stands off the walls: from the middle of each side straight out (left, right,
// up, down on the plan) to the inside face of the first wall it meets. Returns
// [{ side, from, to, dist }] for the sides that reach a wall; plan cm.
export function clearances(g, box) {
  const faces = [];
  for (const sg of g.segs) {
    if (sg.gap || !sg.len) continue;
    const steps = sg.arc ? 24 : 1, pts = Array.from({ length: steps + 1 }, (_, i) => segPoint(sg, (sg.len * i) / steps).p);
    for (let i = 0; i < steps; i++) faces.push([pts[i], pts[i + 1]]);
  }
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const rays = [
    ['left', { x: box.x0, y: cy }, { x: -1, y: 0 }], ['right', { x: box.x1, y: cy }, { x: 1, y: 0 }],
    ['up', { x: cx, y: box.y0 }, { x: 0, y: -1 }], ['down', { x: cx, y: box.y1 }, { x: 0, y: 1 }],
  ];
  const out = [];
  for (const [side, from, d] of rays) {
    let best = Infinity;
    for (const [a, b] of faces) {
      const e = { x: b.x - a.x, y: b.y - a.y }, den = d.x * e.y - d.y * e.x;
      if (Math.abs(den) < 1e-9) continue;
      const w = { x: a.x - from.x, y: a.y - from.y };
      const t = (w.x * e.y - w.y * e.x) / den, k = (w.x * d.y - w.y * d.x) / den;
      if (t > 0.01 && k >= -1e-6 && k <= 1 + 1e-6) best = Math.min(best, t);
    }
    if (best < Infinity) out.push({ side, from, to: add(from, d, best), dist: best });
  }
  return out;
}

// The nearer wall across and the nearer wall up/down: the two that place an item.
export function nearestClearances(list) {
  const pick = sides => list.filter(c => sides.includes(c.side)).sort((a, b) => a.dist - b.dist)[0];
  return [pick(['left', 'right']), pick(['up', 'down'])].filter(Boolean);
}

export function geometry(room) {
  const pts = [{ x: 0, y: 0 }];
  const segs = [];
  let heading = +room.heading0 || 0; // direction of the first wall (0 = east), set when walls are drawn on the plan
  room.walls.forEach((wall, i) => {
    const len = Math.max(0, +wall.length || 0);
    const r = (heading * Math.PI) / 180;
    const u = { x: Math.cos(r), y: Math.sin(r) };
    const p0 = pts[i];
    const p1 = { x: p0.x + u.x * len, y: p0.y + u.y * len };
    segs.push({ wall, i, p0, p1, u, len, heading });
    pts.push(p1);
    heading += +wall.turn || 0;
  });
  const end = pts[pts.length - 1];
  const gap = Math.hypot(end.x, end.y);
  let a2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a2 += p.x * q.y - q.x * p.y;
  }
  const cw = a2 >= 0; // clockwise on screen (y down) → room is on the right of each wall
  const inwardOf = inwardFor(cw);
  let area = Math.abs(a2) / 2, perimeter = 0, gaps = 0, glass = 0;

  // Curved walls: `bulge` is how far the middle of the wall bows out from the straight line
  // between its corners (+ away from the room, − into it), up to a half circle.
  for (const sg of segs) {
    sg.inwardOf = inwardOf;
    sg.inward = inwardOf(sg.u);
    // A deleted wall stays in the chain as a straight gap, so the walls after it keep their place.
    sg.gap = !!sg.wall.gap;
    sg.glass = !sg.gap && sg.wall.kind === 'glass';
    if (sg.gap) gaps += sg.len;
    const h = sg.gap ? 0 : clamp(+sg.wall.bulge || 0, -sg.len / 2, sg.len / 2);
    if (Math.abs(h) < 0.5 || !sg.len) { perimeter += sg.len; if (sg.glass) glass += sg.len; continue; }
    const c = sg.len, r = (c * c / 4 + h * h) / (2 * Math.abs(h));
    const out = { x: -sg.inward.x, y: -sg.inward.y }, sign = Math.sign(h);
    const m = mid(sg.p0, sg.p1);
    sg.arc = { h, r, sign, out, apex: add(m, out, h), center: add(m, out, h - sign * r) };
    const half = Math.asin(Math.min(1, c / (2 * r)));
    perimeter += 2 * r * half;
    if (sg.glass) glass += 2 * r * half;
    // Circular segment between chord and arc: added when the wall bows out, removed when it bows in.
    area += sign * (r * r * half - (c / 2) * (r - Math.abs(h)));
  }
  // Corners plus the tip of each curved wall: what the plan has to fit.
  const extent = [...pts, ...segs.filter(sg => sg.arc).map(sg => sg.arc.apex)];
  return { pts, segs, end, gap, wallLen: perimeter - gaps - glass, glassLen: glass, closed: gap < 1 && (segs.length >= 3 || (segs.length === 2 && segs.every(sg => sg.arc))), area, perimeter, cw, extent };
}

export const WALL_KINDS = { '': 'Masonry (solid)', light: 'Light wall (no hatch)', glass: 'Glass wall' };
export const WALL_T = 10; // cm, when neither the wall nor the project gives a thickness
export const DOOR_FRAME = 5; // cm, width of a door frame jamb

// A wall's thickness in cm: its own, else the project's default.
export const wallT = (sg, def) => (+sg.wall.thickness > 0 ? +sg.wall.thickness : +def > 0 ? +def : WALL_T);

// Outside face at one end of a wall: where its outer face meets the outer face of the wall next
// to it (a mitre, also between walls of different thickness), or straight out from the end when
// there is none, it's a gap, or the two run on in line. Plan cm; walls run outward from the
// measured inside face. tOf(sg) gives each wall's thickness.
export function outerCorner(g, sg, end, tOf) {
  const k = g.segs.indexOf(sg), n = g.segs.length;
  let other = end === 'start' ? (k > 0 ? g.segs[k - 1] : g.closed ? g.segs[n - 1] : null)
    : (k < n - 1 ? g.segs[k + 1] : g.closed ? g.segs[0] : null);
  if (!other || other === sg || other.gap || !other.len) other = null;
  const here = segPoint(sg, end === 'start' ? 0 : sg.len), t2 = tOf(sg);
  const flat = add(here.p, here.n, -t2);
  if (!other) return flat;
  const there = segPoint(other, end === 'start' ? other.len : 0), t1 = tOf(other);
  const q = crossing(flat, here.t, add(there.p, there.n, -t1), there.t);
  // Parallel, or so sharp a corner that the mitre would shoot off: square it off instead.
  return q && Math.hypot(q.x - flat.x, q.y - flat.y) <= 4 * Math.max(t1, t2) ? q : flat;
}

// A wall's two faces as point lists (plan cm), inside face first; a curved wall is sampled along
// its arc. The outer face's ends are the mitred corners.
export function wallOutline(g, sg, tOf) {
  const t = tOf(sg), steps = sg.arc ? 32 : 1;
  // Even steps round the arc, not along the chord: near the ends of a deep arc chord steps get
  // long and the curve turns into a point.
  const half = sg.arc ? Math.asin(Math.min(1, sg.len / (2 * sg.arc.r))) : 0;
  const xAt = i => (sg.arc ? sg.len / 2 + sg.arc.r * Math.sin(-half + (2 * half * i) / steps) : (sg.len * i) / steps);
  const at = Array.from({ length: steps + 1 }, (_, i) => segPoint(sg, clamp(xAt(i), 0, sg.len)));
  const inner = at.map(q => q.p), outer = at.map(q => add(q.p, q.n, -t));
  outer[0] = outerCorner(g, sg, 'start', tOf);
  outer[steps] = outerCorner(g, sg, 'end', tOf);
  return { inner, outer };
}

function crossing(p, u, q, v) {
  const c = u.x * v.y - u.y * v.x;
  if (Math.abs(c) < 1e-6) return null;
  const k = ((q.x - p.x) * v.y - (q.y - p.y) * v.x) / c;
  return add(p, u, k);
}

// SVG path through the room's corners, with arcs for curved walls. X maps plan → SVG.
export function wallPath(g, X, segs = g.segs, close = g.closed) {
  if (!segs.length) return '';
  let d = `M${f(X(segs[0].p0).x)} ${f(X(segs[0].p0).y)}`;
  for (const sg of segs) {
    const b = X(sg.p1);
    if (!sg.arc) { d += ` L${f(b.x)} ${f(b.y)}`; continue; }
    const a = X(sg.p0), m = X(sg.arc.apex), r = Math.hypot(X(sg.arc.center).x - a.x, X(sg.arc.center).y - a.y);
    const sweep = (m.x - a.x) * (b.y - m.y) - (m.y - a.y) * (b.x - m.x) > 0 ? 1 : 0;
    d += ` A${f(r)} ${f(r)} 0 0 ${sweep} ${f(b.x)} ${f(b.y)}`;
  }
  return close ? d + ' Z' : d;
}

const f = n => n.toFixed(2);
const add = (p, v, k) => ({ x: p.x + v.x * k, y: p.y + v.y * k });
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const line = (a, b, attrs) => `<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" ${attrs}/>`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function readableAngle(u) {
  let a = (Math.atan2(u.y, u.x) * 180) / Math.PI;
  if (a > 90) a -= 180;
  if (a <= -90) a += 180;
  return a;
}

/**
 * opt: { mini, selected (wall id), selectedOp (opening / column / shape id), draft (shape being drawn),
 *        draftWall ({ a, b, len } wall being drawn), snapAt (point a drag snapped to),
 *        handles ([{ x, y, id, for }] drag handles, plan cm), editing (a plan tool is on),
 *        frame ({ ox, oy, s, VH } to draw at, instead of fitting the room), photoCounts {wallId: n}, export, title, subtitle, unit,
 *        zoom (CSS zoom the SVG is shown at: strokes, text and offsets shrink by it so they keep
 *        their on-screen size while the walls grow) }
 */
export function renderPlan(room, opt = {}) {
  const g = geometry(room);
  const mini = !!opt.mini;
  const svgOpen = (h, extra = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${h}"${opt.export ? ` width="${VW}" height="${h}"` : ''} font-family="${FONT}"${extra}>`;
  const shapes = [...(room.shapes || []), ...(opt.draft ? [{ ...opt.draft, id: '__draft' }] : [])];
  // An empty room still gets a frame in the editor, so its first walls can be drawn on it.
  if (!g.segs.length && (mini || opt.export || !opt.editing)) {
    return `${svgOpen(120)}<text x="${VW / 2}" y="64" text-anchor="middle" fill="${DIM}" font-size="14">No walls yet</text></svg>`;
  }

  const head = opt.export ? 46 : 0;
  const pad = mini ? 10 : 56;
  const maxH = mini ? 280 : 440;
  const fit = [...g.extent, ...(g.segs.length ? [] : [{ x: -50, y: -50 }, { x: 400, y: 300 }]), ...(room.shapes || []).flatMap(shapePoints), ...(room.columns || []).map(c => ({ x: +c.x || 0, y: +c.y || 0 })),
    ...(room.dims || []).flatMap(d => [{ x: +d.x1 || 0, y: +d.y1 || 0 }, { x: +d.x2 || 0, y: +d.y2 || 0 }])];
  const xs = fit.map(p => p.x), ys = fit.map(p => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const bw = Math.max(Math.max(...xs) - minX, 1), bh = Math.max(Math.max(...ys) - minY, 1);
  let s = Math.min((VW - 2 * pad) / bw, (maxH - 2 * pad) / bh);
  let VH = Math.round(bh * s + 2 * pad + head);
  let ox = (VW - bw * s) / 2 - minX * s, oy = pad + head - minY * s;
  // During a drag the caller pins the scale and position, so the plan doesn't refit under the finger.
  if (opt.frame) ({ ox, oy, s, VH } = opt.frame);
  const X = p => ({ x: ox + p.x * s, y: oy + p.y * s });
  const sign = g.cw ? 1 : -1;
  const inward = u => ({ x: -u.y * sign, y: u.x * sign });
  const z = opt.zoom || 1, Z = v => v / z;
  const T = Z(mini ? 3 : 6);
  const halo = `paint-order="stroke" stroke="#fff" stroke-width="${f(Z(3))}" stroke-linejoin="round"`;
  const dash = (a, b) => `stroke-dasharray="${f(Z(a))} ${f(Z(b))}"`;
  const out = [];

  if (opt.export) {
    out.push(`<rect width="${VW}" height="${VH}" fill="#fff"/>`);
    out.push(`<text x="14" y="26" font-size="15" font-weight="700" fill="${INK}">${esc(opt.title)}</text>`);
    out.push(`<text x="${VW - 14}" y="26" font-size="12" text-anchor="end" fill="${DIM}">${esc(opt.subtitle)}</text>`);
  }

  // An open run of walls that ends back on corner A (one with a gap) doesn't letter A twice.
  const corners = g.closed || (g.segs.length > 1 && g.gap < 1) ? g.pts.slice(0, -1) : g.pts;
  out.push(`<path d="${wallPath(g, X, g.segs, true)}" fill="#f3efe6"/>`);

  // Walls to scale, from the measured inside face outward by their thickness, by kind:
  // masonry solid black, a light wall just its outline, glass a pale blue band with the glass
  // line down the middle. A gap (a deleted wall) is a dashed line waiting to be filled in.
  const tOf = sg => wallT(sg, opt.wallT), tPx = sg => tOf(sg) * s;
  const pts = list => list.map(p => { const v = X(p); return `${f(v.x)},${f(v.y)}`; }).join(' ');
  const kindOf = sg => (sg.gap ? 'gap' : sg.glass ? 'glass' : sg.wall.kind === 'light' ? 'light' : 'solid');
  const outlines = new Map(g.segs.filter(sg => !sg.gap && sg.len).map(sg => [sg, wallOutline(g, sg, tOf)]));
  const edge = Z(mini ? 0.8 : 1.2);
  for (const [sg, { inner, outer }] of outlines) {
    const kind = kindOf(sg), ring = pts([...inner, ...[...outer].reverse()]);
    if (kind === 'solid') { out.push(`<polygon points="${ring}" fill="${INK}" stroke="${INK}" stroke-width="${f(Z(0.6))}" stroke-linejoin="round"/>`); continue; }
    const ink = kind === 'glass' ? GLASS_LINE : INK;
    out.push(`<polygon points="${ring}" fill="${kind === 'glass' ? GLASS : '#fff'}"/>`);
    out.push(`<polyline points="${pts(inner)}" fill="none" stroke="${ink}" stroke-width="${f(edge)}"/>`, `<polyline points="${pts(outer)}" fill="none" stroke="${ink}" stroke-width="${f(edge)}"/>`);
    // Close off an end unless it runs on into a wall of the same kind.
    const k = g.segs.indexOf(sg), n = g.segs.length;
    const prev = k > 0 ? g.segs[k - 1] : g.closed ? g.segs[n - 1] : null, next = k < n - 1 ? g.segs[k + 1] : g.closed ? g.segs[0] : null;
    if (!prev || kindOf(prev) !== kind) out.push(line(X(inner[0]), X(outer[0]), `stroke="${ink}" stroke-width="${f(edge)}"`));
    if (!next || kindOf(next) !== kind) out.push(line(X(inner.at(-1)), X(outer.at(-1)), `stroke="${ink}" stroke-width="${f(edge)}"`));
    if (kind === 'glass') out.push(`<polyline points="${pts(inner.map((p, i) => mid(p, outer[i])))}" fill="none" stroke="${GLASS_LINE}" stroke-width="${f(edge)}"/>`);
  }
  for (const sg of g.segs.filter(x => x.gap)) out.push(line(X(sg.p0), X(sg.p1), `stroke="${DIM}" stroke-width="${f(Z(mini ? 1 : 1.6))}" ${dash(7, 5)}`));

  const sel = g.segs.find(sg => sg.wall.id === opt.selected);
  if (sel && !mini) {
    if (outlines.has(sel)) { const o = outlines.get(sel); out.push(`<polygon points="${pts([...o.inner, ...[...o.outer].reverse()])}" fill="${ACC}" fill-opacity="0.55" stroke="${ACC}" stroke-width="${f(Z(1.5))}"/>`); }
    else out.push(line(X(sel.p0), X(sel.p1), `stroke="${ACC}" stroke-width="${f(Z(2.5))}" ${dash(7, 5)}`));
  }

  // Doors, windows and other openings
  // On a curved wall each opening is drawn straight between its two ends on the arc.
  // A free-standing wall's thickness is centred on its line, so its openings start from the face
  // half a thickness to the left.
  const hits = [], tagSpots = [], tags = openingTags(room);
  const drawOpenings = sg => {
    const face = sg.free ? sg.t / 2 : 0;
    for (const o of sg.wall.openings || []) {
      const off = clamp(+o.offset || 0, 0, sg.len);
      const w = clamp(+o.width || 0, 0, sg.len - off);
      if (!w) continue;
      const a = X(add(segPoint(sg, off).p, sg.inward, face)), b = X(add(segPoint(sg, off + w).p, sg.inward, face)), r = Math.hypot(b.x - a.x, b.y - a.y);
      const u = { x: (b.x - a.x) / r, y: (b.y - a.y) / r }, n = sg.free ? sg.inwardOf(u) : inward(u), o2 = { x: -n.x, y: -n.y };
      const tw = sg.free ? sg.t * s : sg.gap ? T : tPx(sg), jamb = `stroke="${sg.glass ? GLASS_LINE : INK}" stroke-width="${f(Z(1))}"`;
      // Cut the wall away through its thickness, then close the cut with a jamb line each side.
      out.push(`<polygon points="${[add(a, n, Z(1)), add(b, n, Z(1)), add(b, o2, tw + Z(1)), add(a, o2, tw + Z(1))].map(p => `${f(p.x)},${f(p.y)}`).join(' ')}" fill="#fff"/>`);
      out.push(line(a, add(a, o2, tw), jamb), line(b, add(b, o2, tw), jamb));
      // The picked one is marked along its span: a plain opening has no tag to light up.
      if (!mini && o.id === opt.selectedOp) out.push(line(a, b, `stroke="${ACC}" stroke-width="${f(Z(4))}" stroke-opacity="0.6"`));
      // A sliding door's arrows sit just inside the wall, so its tag moves further in.
      if (tags.has(o.id)) tagSpots.push({ p: add(mid(a, b), n, Z(o.type === 'door' ? (openStyle(o)?.style === 'slide' ? 26 : 12) : 10)), tag: tags.get(o.id), sel: o.id === opt.selectedOp });
      if (!mini && !opt.export) hits.push(line(a, b, `stroke="#000" stroke-opacity="0" stroke-width="${f(Z(22))}" data-wall="${sg.wall.id}" data-op="${o.id}" style="cursor:pointer"`));
      if (o.type === 'door' || o.type === 'window') {
        const solid = Z(o.type === 'door' ? (mini ? 1 : 1.6) : 1);
        for (const sh of openingShapes(o, a, u, n, r, tw, -tw / 2, Math.max(DOOR_FRAME * s, Z(2)))) {
          if (sh.line) {
            out.push(line(sh.line[0], sh.line[1], `stroke="${INK}" stroke-width="${f(sh.dash ? Z(0.8) : solid)}"${sh.dash ? ' ' + dash(3, 2) : ''}`));
          } else {
            const { c, from, to } = sh.arc, rr = Math.hypot(from.x - c.x, from.y - c.y);
            const sweep = (from.x - c.x) * (to.y - c.y) - (from.y - c.y) * (to.x - c.x) > 0 ? 1 : 0;
            out.push(`<path d="M${f(from.x)} ${f(from.y)} A${f(rr)} ${f(rr)} 0 0 ${sweep} ${f(to.x)} ${f(to.y)}" fill="none" stroke="${INK}" stroke-width="${f(Z(0.8))}" ${dash(3, 2)}/>`);
          }
        }
      } else {
        out.push(line(a, b, `stroke="${INK}" stroke-width="${f(Z(1.2))}" ${dash(4, 3)}`), line(add(a, o2, tw), add(b, o2, tw), `stroke="${INK}" stroke-width="${f(Z(1.2))}" ${dash(4, 3)}`));
      }
    }
  };
  for (const sg of g.segs) drawOpenings(sg);

  // Drawn shapes (counters etc.), under the labels
  const SHAPE = '#4f6a8f', shapeLabels = [], wallLengths = [];
  for (const sh of shapes) {
    const on = sh.id === opt.selectedOp, draft = sh.id === '__draft';
    const tag = !mini && !opt.export && !draft ? ` data-shape="${sh.id}" style="cursor:pointer"` : '';
    const look = `stroke="${on ? ACC : SHAPE}" stroke-width="${f(Z(on ? 2 : 1.4))}"${draft ? ' ' + dash(4, 3) : ''}`;
    if (sh.type === 'wall') {
      // Drawn like the room's walls of the same type, to scale.
      const ring = freeWallCorners(sh, opt.wallT);
      if (!ring) continue;
      const pts = ring.map(p => { const v = X(p); return `${f(v.x)},${f(v.y)}`; }).join(' ');
      const kind = sh.kind === 'glass' ? 'glass' : sh.kind === 'light' ? 'light' : 'solid', ink = kind === 'glass' ? GLASS_LINE : INK;
      const fade = draft ? ' fill-opacity="0.5"' : '';
      if (kind === 'solid') out.push(`<polygon points="${pts}" fill="${INK}"${fade} stroke="${INK}" stroke-width="${f(Z(0.6))}"/>`);
      else out.push(`<polygon points="${pts}" fill="${kind === 'glass' ? GLASS : '#fff'}"${fade} stroke="${ink}" stroke-width="${f(Z(mini ? 0.8 : 1.2))}"/>`);
      if (kind === 'glass') out.push(line(X(mid(ring[0], ring[3])), X(mid(ring[1], ring[2])), `stroke="${GLASS_LINE}" stroke-width="${f(Z(1.2))}"`));
      if (on) out.push(`<polygon points="${pts}" fill="${ACC}" fill-opacity="0.55" stroke="${ACC}" stroke-width="${f(Z(1.5))}"/>`);
      const [a, b] = shapePoints(sh).map(X);
      if (tag) out.push(line(a, b, `stroke="#000" stroke-opacity="0" stroke-width="${f(Math.max(Z(18), (+sh.thickness || opt.wallT || WALL_T) * s))}"${tag}`));
      if (draft) wallLengths.push({ a, b, len: Math.hypot(+sh.x2 - +sh.x1, +sh.y2 - +sh.y1) });
    } else if (sh.type === 'line') {
      const [a, b] = shapePoints(sh).map(X);
      out.push(line(a, b, `${look} stroke-linecap="round"`));
      if (tag) out.push(line(a, b, `stroke="#000" stroke-opacity="0" stroke-width="${f(Z(16))}"${tag}`));
    } else if (sh.type === 'rect') {
      out.push(`<polygon points="${rectCorners(sh).map(p => { const v = X(p); return `${f(v.x)},${f(v.y)}`; }).join(' ')}" fill="${SHAPE}" fill-opacity="0.12" ${look}${tag}/>`);
    } else {
      const c = X({ x: +sh.x || 0, y: +sh.y || 0 });
      out.push(`<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(Math.max(((+sh.d || 0) / 2) * s, Z(1)))}" fill="${SHAPE}" fill-opacity="0.12" ${look}${tag}/>`);
    }
    if (sh.label && !mini) shapeLabels.push({ p: X(shapeCenter(sh)), label: sh.label, on });
  }

  for (const sh of freeWalls(room)) { const sg = freeWallSeg(sh, opt.wallT); if (sg) drawOpenings(sg); }

  // Columns: on a wall, and free-standing ones anywhere in the plan
  const allCols = [
    ...g.segs.flatMap(sg => (sg.wall.columns || []).map(c => ({ c, sh: columnShape(sg, c), tag: `data-wall="${sg.wall.id}" data-col="${c.id}"` }))),
    ...(room.columns || []).map(c => ({ c, sh: freeColumnShape(c), tag: `data-fcol="${c.id}"` })),
  ];
  for (const { c, sh, tag: at } of allCols) {
    if (!sh) continue;
    const on = !mini && c.id === opt.selectedOp;
    const tag = !mini && !opt.export ? ` ${at} style="cursor:pointer"` : '';
    const look = `fill="${on ? ACC : '#555'}" stroke="${on ? ACC : INK}" stroke-width="${f(Z(1))}"${tag}`;
    if (sh.round) { const q = X(sh.round.c); out.push(`<circle cx="${f(q.x)}" cy="${f(q.y)}" r="${f(Math.max(sh.round.r * s, Z(1.5)))}" ${look}/>`); }
    else out.push(`<polygon points="${sh.corners.map(p => { const v = X(p); return `${f(v.x)},${f(v.y)}`; }).join(' ')}" ${look}/>`);
  }

  if (!mini) {
    // Labels are collected with a priority and drawn only where they don't collide with a
    // more important one, so short walls and small columns don't bury the plan in text.
    // Zooming in gives them room and they come back.
    const labels = [];
    const label = (prio, p, w, h, ang, svg) => {
      const r = (ang * Math.PI) / 180, c = Math.abs(Math.cos(r)), sn = Math.abs(Math.sin(r));
      const bw = w * c + h * sn, bh = w * sn + h * c;
      labels.push({ prio, box: [p.x - bw / 2, p.y - bh / 2, p.x + bw / 2, p.y + bh / 2], svg });
    };
    const text = (prio, p, str, size, ang, attrs) => {
      const fs = Z(size);
      label(prio, p, String(str).length * fs * 0.6 + Z(2), fs * 1.15, ang,
        `<text x="${f(p.x)}" y="${f(p.y)}"${ang ? ` transform="rotate(${f(ang)} ${f(p.x)} ${f(p.y)})"` : ''} text-anchor="middle" dominant-baseline="central" font-size="${f(fs)}" ${attrs}>${esc(str)}</text>`);
    };
    const thin = `stroke="${DIM}" stroke-width="${f(Z(0.7))}"`;

    // Dimension lines outside each wall, wall numbers inside
    for (const sg of g.segs) {
      if (!sg.len) continue;
      const a = X(sg.p0), b = X(sg.p1), n = inward(sg.u), o = { x: -n.x, y: -n.y };
      const ang = readableAngle(sg.u), lenStr = fmtLen(sg.len, opt.unit), px = sg.len * s;
      const isSel = sel === sg;
      const m = segPoint(sg, sg.len / 2), c = add(X(m.p), m.n, Z(18)), r = Z(9);
      if (sg.arc) text(3.5, add(c, m.n, Z(18)), `R ${fmtLen(sg.arc.r, opt.unit)}`, 9, 0, `fill="${DIM}" ${halo}`);
      if (px >= Z(14) || isSel) label(isSel ? 0 : 4, c, 2 * r, 2 * r, 0,
        `<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(r)}" fill="${isSel ? ACC : '#fff'}" stroke="${isSel ? ACC : DIM}" stroke-width="${f(Z(1))}"/>` +
        `<text x="${f(c.x)}" y="${f(c.y)}" text-anchor="middle" dominant-baseline="central" font-size="${f(Z(10))}" font-weight="700" fill="${isSel ? '#fff' : INK}">${sg.i + 1}</text>`);
      const cnt = opt.photoCounts?.[sg.wall.id];
      if (cnt) text(5, add(c, n, Z(15)), `📷${cnt}`, 9, 0, `fill="${DIM}"`);
      // Too short for its own length at this zoom: its dimension would only cover its neighbours.
      // Zooming in brings it back.
      if (px < lenStr.length * Z(12) * 0.6 + Z(8)) continue;
      const tick = p => out.push(line(add(add(p, sg.u, -Z(3)), o, Z(3)), add(add(p, sg.u, Z(3)), o, -Z(3)), `stroke="${INK}" stroke-width="${f(Z(1.2))}"`));
      // Chain dimension: corner, each door/window edge, corner. The overall length moves out a row.
      // Dimensions run along the chord; a wall bowing outward pushes them past its arc.
      const push = sg.arc?.sign > 0 ? Math.abs(sg.arc.h) * s : 0;
      const tp = sg.gap ? 0 : tPx(sg), breaks = chainBreaks(sg), dc = Z(22) + push + tp, d = Z(breaks ? 40 : 24) + push + tp;
      if (breaks) {
        const at = v => add(a, sg.u, v * s);
        out.push(line(add(at(0), o, dc), add(at(sg.len), o, dc), thin));
        breaks.forEach((v, k) => {
          const p = add(at(v), o, dc);
          if (k && k < breaks.length - 1) out.push(line(add(at(v), o, Z(6) + tp), add(p, o, Z(3)), thin));
          tick(p);
          const nx = breaks[k + 1];
          if (nx == null) return;
          const str = fmtLen(nx - v, opt.unit);
          if ((nx - v) * s < str.length * Z(9) * 0.6) return; // doesn't fit between its ticks
          text(3, add(add(at((v + nx) / 2), o, dc), o, Z(6)), str, 9, ang, `fill="${DIM}" ${halo}`);
        });
      }
      const da = add(a, o, d), db = add(b, o, d);
      out.push(line(add(a, o, Z(6) + tp), add(a, o, d + Z(4)), thin), line(add(b, o, Z(6) + tp), add(b, o, d + Z(4)), thin), line(da, db, thin));
      tick(da); tick(db);
      // Longer walls win a tie for space.
      text(1 + 1 / (1 + sg.len), add(mid(da, db), o, Z(8)), lenStr, 12, ang, `font-weight="600" fill="${INK}" ${halo}`);
    }

    for (const { p, label: str, on } of shapeLabels) text(on ? 0 : 2.8, p, str, 9, 0, `fill="${on ? ACC : SHAPE}" font-weight="600" ${halo}`);
    for (const { a, b, len } of wallLengths) {
      const L = Math.hypot(b.x - a.x, b.y - a.y), u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      text(0.3, add(mid(a, b), { x: -u.y, y: u.x }, -Z(14)), fmtLen(len, opt.unit), 11, readableAngle(u), `font-weight="700" fill="${ACC}" ${halo}`);
    }

    // A dimension between two plan points: the line, a tick at each end, the length above it.
    const dimLine = (p, q, color, prio, attrs = '') => {
      const a = X(p), b = X(q), len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < Z(3)) return;
      const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, nv = { x: -u.y, y: u.x };
      const tk = c => line(add(add(c, u, -Z(3)), nv, Z(3)), add(add(c, u, Z(3)), nv, -Z(3)), `stroke="${color}" stroke-width="${f(Z(1.1))}"`);
      out.push(line(a, b, `stroke="${color}" stroke-width="${f(Z(0.8))}"${attrs}`), tk(a), tk(b));
      // Text on the side readableAngle turns it to: above the line as it reads.
      const ang = readableAngle(u), up = Math.abs(Math.atan2(u.y, u.x)) > Math.PI / 2 ? 1 : -1;
      text(prio, add(mid(a, b), nv, up * Z(7)), fmtLen(Math.hypot(q.x - p.x, q.y - p.y), opt.unit), 9, ang, `fill="${color}" font-weight="600" ${halo}`);
    };
    // Free-standing walls: a number (F1, F2…) on one side, and on the other their length, with a
    // chain through any doors and windows first, like the room's walls.
    freeWalls(room).forEach((sh, i) => {
      const sg = freeWallSeg(sh, opt.wallT);
      if (!sg) return;
      const half = sg.t / 2, on = sh.id === opt.selectedOp, name = `F${i + 1}`;
      const c = add(X(add(mid(sg.p0, sg.p1), sg.inward, half)), sg.inward, Z(14)), bw = Z(22), bh = Z(16);
      label(on ? 0 : 4, c, bw, bh, 0,
        `<rect x="${f(c.x - bw / 2)}" y="${f(c.y - bh / 2)}" width="${f(bw)}" height="${f(bh)}" rx="${f(bh / 2)}" fill="${on ? ACC : '#fff'}" stroke="${on ? ACC : DIM}" stroke-width="${f(Z(1))}"/>` +
        `<text x="${f(c.x)}" y="${f(c.y)}" text-anchor="middle" dominant-baseline="central" font-size="${f(Z(10))}" font-weight="700" fill="${on ? '#fff' : INK}">${name}</text>`);
      const along = (x, px) => add(add(sg.p0, sg.u, x), sg.inward, -(half + Z(px) / s));
      const breaks = chainBreaks(sg);
      if (breaks) breaks.slice(1).forEach((x, k) => dimLine(along(breaks[k], 16), along(x, 16), FREE_DIM, 3));
      dimLine(along(0, breaks ? 32 : 16), along(sg.len, breaks ? 32 : 16), FREE_DIM, 1 + 1 / (1 + sg.len));
    });

    // Free-standing columns are measured off the nearest walls across and up/down; whatever is
    // picked (a column or a drawn rectangle / circle) off all the walls around it.
    const items = [...(room.columns || []).map(c => ({ c, on: c.id === opt.selectedOp })),
      ...(room.shapes || []).filter(sh => sh.id === opt.selectedOp).map(c => ({ c, on: true }))];
    for (const { c, on } of items) {
      const box = itemBox(c);
      if (!box) continue;
      const all = clearances(g, box);
      for (const d of on ? all : nearestClearances(all)) dimLine(d.from, d.to, CLEAR, on ? 0.6 : 3.2);
    }
    for (const d of [...(room.dims || []), ...(opt.draftDim ? [{ ...opt.draftDim, id: '__draft' }] : [])]) {
      const p = { x: +d.x1 || 0, y: +d.y1 || 0 }, q = { x: +d.x2 || 0, y: +d.y2 || 0 }, on = d.id === opt.selectedOp;
      dimLine(p, q, on || d.id === '__draft' ? ACC : DIMLINE, on ? 0.4 : 2.6, d.id === '__draft' ? ' ' + dash(4, 3) : '');
      if (!opt.export && d.id !== '__draft') out.push(line(X(p), X(q), `stroke="#000" stroke-opacity="0" stroke-width="${f(Z(16))}" data-dim="${d.id}" style="cursor:pointer"`));
    }

    // Door / window tags in a small box just inside the wall
    for (const { p, tag, sel: on } of tagSpots) {
      const fs = Z(9), w = tag.length * fs * 0.62 + Z(6), h = fs * 1.5;
      label(on ? 0 : 2.5, p, w, h, 0,
        `<rect x="${f(p.x - w / 2)}" y="${f(p.y - h / 2)}" width="${f(w)}" height="${f(h)}" rx="${f(Z(3))}" fill="${on ? ACC : '#fff'}" stroke="${on ? ACC : INK}" stroke-width="${f(Z(0.8))}"/>` +
        `<text x="${f(p.x)}" y="${f(p.y)}" text-anchor="middle" dominant-baseline="central" font-size="${f(fs)}" font-weight="700" fill="${on ? '#fff' : INK}">${esc(tag)}</text>`);
    }

    // Corner letters
    corners.forEach((p, i) => {
      const prev = g.segs[i - 1] ?? (g.closed ? g.segs[g.segs.length - 1] : null);
      const next = g.segs[i];
      let v = { x: 0, y: 0 }, tp = 0;
      for (const sg of [prev, next]) if (sg) { const n = inward(sg.u); v.x -= n.x; v.y -= n.y; if (!sg.gap) tp = Math.max(tp, tPx(sg)); }
      const k = Math.hypot(v.x, v.y) || 1;
      text(i ? 2 : 0.5, add(X(p), { x: v.x / k, y: v.y / k }, Z(13) + tp * 1.4), cornerName(i), 11, 0, `font-weight="700" fill="${ACC}" ${halo}`);
    });

    if (g.segs.length >= 2 && g.gap >= 1) {
      const a = X(g.end), b = X(g.pts[0]);
      out.push(line(a, b, `stroke="${RED}" stroke-width="${f(Z(1.5))}" ${dash(5, 4)}`));
      text(0, mid(a, b), `gap ${fmtLen(g.gap, opt.unit)} ${UNITS[unitOf(opt.unit)].label}`, 11, 0, `fill="${RED}" ${halo}`);
    }

    const placed = [], gapPx = Z(1);
    const overlaps = (p, q) => p[0] < q[2] + gapPx && q[0] < p[2] + gapPx && p[1] < q[3] + gapPx && q[1] < p[3] + gapPx;
    for (const l of labels.sort((x, y) => x.prio - y.prio)) {
      if (l.prio > 0 && placed.some(q => overlaps(l.box, q))) continue;
      placed.push(l.box);
      out.push(l.svg);
    }

    if (!opt.export) {
      for (const sg of g.segs) {
        out.push(`<path d="${wallPath(g, X, [sg], false)}" fill="none" stroke="#000" stroke-opacity="0" stroke-width="${f(Z(30))}" data-wall="${sg.wall.id}" style="cursor:pointer"/>`);
      }
      // Doors and windows on top of the wall targets, so a tap picks the opening itself.
      out.push(...hits);
    }
  }

  // Editing overlays: the wall being drawn, where a drag snapped, and drag handles — on top of everything.
  if (!mini && opt.draftWall) {
    const a = X(opt.draftWall.a), b = X(opt.draftWall.b);
    out.push(line(a, b, `stroke="${ACC}" stroke-width="${f(T)}" stroke-opacity="0.6" stroke-linecap="square"`));
    const m = mid(a, b);
    out.push(`<text x="${f(m.x)}" y="${f(m.y - Z(10))}" text-anchor="middle" font-size="${f(Z(12))}" font-weight="700" fill="${ACC}" paint-order="stroke" stroke="#fff" stroke-width="${f(Z(3))}">${fmtLen(opt.draftWall.len, opt.unit)}</text>`);
  }
  if (!mini && opt.snapAt) {
    const q = X(opt.snapAt);
    out.push(`<circle cx="${f(q.x)}" cy="${f(q.y)}" r="${f(Z(7))}" fill="none" stroke="#e8710a" stroke-width="${f(Z(2))}"/>`);
  }
  for (const h of opt.handles || []) {
    const q = X(h);
    out.push(`<circle cx="${f(q.x)}" cy="${f(q.y)}" r="${f(Z(h.solid ? 9 : 8))}" fill="${h.solid ? ACC : '#fff'}" stroke="${h.solid ? '#fff' : ACC}" stroke-width="${f(Z(2.5))}" data-handle="${h.id}" data-for="${h.for}" style="cursor:grab"/>`);
  }

  // Plan ↔ SVG mapping, so a tap or a drag on the plan can be turned back into room cm.
  return `${svgOpen(VH, mini || opt.export ? '' : ` data-map="${f(ox)},${f(oy)},${s}"`)}${out.join('')}</svg>`;
}

export function svgToPng(svg, scale = 3) {
  const [, w, h] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).map(Number);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w * scale;
      c.height = h * scale;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(resolve, 'image/png');
    };
    img.onerror = reject;
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}
