// Floor plans as DXF (R12 / AC1009, readable by AutoCAD, LibreCAD, ZWCAD, SketchUp…).
// With a ceiling height set, the walls are complete in 3D: full height between openings, plus the
// part under each window and over each door / window / opening.
// Drawing units are millimetres; the plan's y-down centimetres are flipped to CAD's y-up.
// Wall, Door, Window, Opening and Column hold closed outlines ready to extrude into 3D: walls run
// from the measured inside face out by the wall thickness and break at doors and windows, whose
// footprints fill the gap. Walls and columns carry the ceiling height as entity thickness, so
// AutoCAD shows them in 3D straight away. Door and window symbols sit on their own -Symbol layers.

import { geometry, openingShapes, openingTags, chainBreaks, columnShape, segPoint, shapePoints, fmtLen, fmtArea } from './plan.js';

const LAYERS = [
  ['Wall', 7], ['Door', 3], ['Door-Symbol', 3], ['Window', 5], ['Window-Symbol', 5],
  ['Opening', 8], ['Column', 6], ['Furniture', 4], ['Dim', 1], ['Text', 2],
];
const DIM_OFF = 300, DIM_ROW = 300, TICK = 60, TXT = 120, NAME_TXT = 250, ROOM_GAP = 1500;

const num = n => (Math.round(n * 1000) / 1000).toString();
// Non-ASCII (Thai) as \U+XXXX, which AutoCAD and most readers decode in TEXT.
const enc = s => String(s ?? '').replace(/[^\x20-\x7e]/g, c => '\\U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
const deg = v => (Math.atan2(v.y, v.x) * 180) / Math.PI;
const readable = a => (a > 90 ? a - 180 : a <= -90 ? a + 180 : a);
const add = (p, v, k) => ({ x: p.x + v.x * k, y: p.y + v.y * k });

function writer() {
  const out = [];
  const g = (code, v) => out.push(String(code), String(v));
  return {
    out,
    line(layer, a, b, dash) {
      g(0, 'LINE'); g(8, layer);
      if (dash) g(6, 'DASHED');
      g(10, num(a.x)); g(20, num(a.y)); g(30, 0);
      g(11, num(b.x)); g(21, num(b.y)); g(31, 0);
    },
    arc(layer, c, r, a0, a1, dash) {
      g(0, 'ARC'); g(8, layer);
      if (dash) g(6, 'DASHED');
      g(10, num(c.x)); g(20, num(c.y)); g(30, 0);
      g(40, num(r)); g(50, num(a0)); g(51, num(a1));
    },
    // Closed outline; a vertex with `b` starts an arc to the next vertex (DXF bulge = tan(angle / 4)).
    // height: extruded up by (entity thickness); z: elevation it starts from.
    poly(layer, pts, height = 0, z = 0) {
      g(0, 'POLYLINE'); g(8, layer); g(66, 1);
      g(10, 0); g(20, 0); g(30, num(z)); g(70, 1);
      if (height > 0) g(39, num(height));
      for (const p of pts) {
        g(0, 'VERTEX'); g(8, layer); g(10, num(p.x)); g(20, num(p.y)); g(30, 0);
        if (p.b) g(42, num(p.b));
      }
      g(0, 'SEQEND'); g(8, layer);
    },
    circle(layer, c, r, height = 0) {
      g(0, 'CIRCLE'); g(8, layer);
      if (height > 0) g(39, num(height));
      g(10, num(c.x)); g(20, num(c.y)); g(30, 0); g(40, num(r));
    },
    text(layer, p, h, s, rot = 0) {
      g(0, 'TEXT'); g(8, layer);
      g(10, num(p.x)); g(20, num(p.y)); g(30, 0);
      g(40, h); g(1, enc(s)); g(7, 'THAI');
      if (rot) g(50, num(rot));
      g(72, 1); g(73, 2);
      g(11, num(p.x)); g(21, num(p.y)); g(31, 0);
    },
  };
}

// Draws one room with its corner A at (ox, oy) in CAD space. t: wall thickness in mm.
function drawRoom(w, room, ox, oy, unit, t) {
  const geo = geometry(room);
  const P = p => ({ x: ox + p.x * 10, y: oy - p.y * 10 });
  const V = v => ({ x: v.x, y: -v.y }); // plan direction ↔ CAD direction (its own inverse)
  const neg = v => ({ x: -v.x, y: -v.y });
  const height = (+room.height || 0) * 10;
  const segs = geo.segs.filter(sg => sg.len);
  const tags = openingTags(room);
  // Point on a wall `x` mm along its chord, with the outward unit normal there, in CAD space.
  const at = (sg, x) => { const q = segPoint(sg, x / 10); return { p: P(q.p), o: V(neg(q.n)) }; };
  // Signed angle (CCW +) from a to b seen from c, for arc bulges.
  const turn = (c, a, b) => {
    const ax = a.x - c.x, ay = a.y - c.y, bx = b.x - c.x, by = b.y - c.y;
    return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  };

  // Outside face at a corner: where the outer faces of the walls either side meet (mitre).
  const outerCorner = (end, sg) => {
    const k = segs.indexOf(sg);
    const other = end === 'start'
      ? (k > 0 ? segs[k - 1] : geo.closed ? segs[segs.length - 1] : null)
      : (k < segs.length - 1 ? segs[k + 1] : geo.closed ? segs[0] : null);
    const here = at(sg, end === 'start' ? 0 : sg.len * 10), o2 = here.o;
    if (!other) return add(here.p, o2, t);
    const o1 = at(other, end === 'start' ? other.len * 10 : 0).o, dot = o1.x * o2.x + o1.y * o2.y;
    if (dot < -0.99) return add(here.p, o2, t);
    return add(here.p, { x: o1.x + o2.x, y: o1.y + o2.y }, t / (1 + dot));
  };

  for (const sg of segs) {
    const A = P(sg.p0), B = P(sg.p1);
    const len = sg.len * 10;
    const u = { x: (B.x - A.x) / len, y: (B.y - A.y) / len };
    const o = V(neg(sg.inward));
    const C = sg.arc && P(sg.arc.center);

    const ops = (sg.wall.openings || [])
      .map(op => {
        const off = Math.min(Math.max(+op.offset || 0, 0), sg.len) * 10;
        return { op, off, w: Math.min(Math.max(+op.width || 0, 0) * 10, len - off) };
      })
      .filter(x => x.w > 0)
      .sort((a, b) => a.off - b.off);

    // Wall pieces between openings, each a closed outline through the wall thickness.
    // Curved walls follow their arc on both faces.
    const qa = outerCorner('start', sg), qb = outerCorner('end', sg);
    const piece = (s0, s1, z = 0, h = height) => {
      if (s1 - s0 < 0.5) return;
      const e0 = at(sg, s0), e1 = at(sg, s1);
      const i0 = e0.p, i1 = e1.p;
      const o0 = s0 <= 0 ? qa : add(i0, e0.o, t), o1 = s1 >= len ? qb : add(i1, e1.o, t);
      if (!C) return w.poly('Wall', [i0, i1, o1, o0], h, z);
      w.poly('Wall', [{ ...i0, b: Math.tan(turn(C, i0, i1) / 4) }, i1, { ...o1, b: Math.tan(turn(C, o1, o0) / 4) }, o0], h, z);
    };
    let pos = 0;
    for (const { op, off, w: ow } of ops) {
      if (off > pos) piece(pos, off);
      pos = Math.max(pos, off + ow);
      // On a curved wall an opening is a straight chord between its two ends on the arc.
      const a = at(sg, off).p, b = at(sg, off + ow).p, span = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ul = { x: (b.x - a.x) / span, y: (b.y - a.y) / span }, nl = V(sg.inwardOf(V(ul))), ol = neg(nl);
      const layer = op.type === 'door' ? 'Door' : op.type === 'window' ? 'Window' : 'Opening';
      // With a ceiling height the wall is closed off under the window (sill) and over the opening
      // (lintel), and the door/window itself is a block from its sill to its head.
      const sill = op.type === 'window' ? Math.max(0, +op.sill || 0) * 10 : 0, oh = Math.max(0, +op.height || 0) * 10;
      if (height > 0) {
        if (sill > 0) piece(off, off + ow, 0, Math.min(sill, height));
        if (oh && height - sill - oh > 0.5) piece(off, off + ow, sill + oh, height - sill - oh);
      }
      w.poly(layer, [a, b, add(b, ol, t), add(a, ol, t)], height > 0 ? oh : 0, height > 0 ? sill : 0);
      if (layer === 'Opening') continue;
      w.text('Text', add(add(a, ul, span / 2), nl, TXT * 2.5), TXT * 1.2, tags.get(op.id));
      // Frames and sliding panels sit inside the wall thickness; swings open from the inside face.
      for (const sh of openingShapes(op, a, ul, nl, span, t, -t / 2)) {
        if (sh.line) { w.line(`${layer}-Symbol`, sh.line[0], sh.line[1], sh.dash); continue; }
        const { c, from, to } = sh.arc;
        const t0 = deg({ x: from.x - c.x, y: from.y - c.y }), t1 = deg({ x: to.x - c.x, y: to.y - c.y });
        const ccw = (((t1 - t0) % 360) + 360) % 360 <= 180;
        w.arc(`${layer}-Symbol`, c, Math.hypot(from.x - c.x, from.y - c.y), ccw ? t0 : t1, ccw ? t1 : t0, sh.dash);
      }
    }
    if (pos < len) piece(pos, len);

    // Dimensions outside the wall thickness: a chain through door/window edges, then the overall length.
    // They run along the chord; a wall bowing outward pushes them past its arc.
    const push = sg.arc?.sign > 0 ? Math.abs(sg.arc.h) * 10 : 0;
    const tick = { x: (u.x + o.x) * Math.SQRT1_2, y: (u.y + o.y) * Math.SQRT1_2 };
    const dimRow = (marks, dist) => {
      const base = t + dist + push;
      w.line('Dim', add(add(A, u, marks[0]), o, base), add(add(A, u, marks[marks.length - 1]), o, base));
      marks.forEach((m, k) => {
        const p = add(add(A, u, m), o, base);
        w.line('Dim', add(add(A, u, m), o, t + 50), add(p, o, 60));
        w.line('Dim', add(p, tick, -TICK / 2), add(p, tick, TICK / 2));
        if (k < marks.length - 1) w.text('Dim', add(add(add(A, u, (m + marks[k + 1]) / 2), o, base), o, TXT), TXT, fmtLen((marks[k + 1] - m) / 10, unit), readable(deg(u)));
      });
    };
    const breaks = chainBreaks(sg);
    if (breaks) dimRow(breaks.map(v => v * 10), DIM_OFF);
    dimRow([0, len], breaks ? DIM_OFF + DIM_ROW : DIM_OFF);
    if (sg.arc) w.text('Dim', add(P(sg.arc.apex), neg(o), TXT * 3), TXT, `R ${fmtLen(sg.arc.r, unit)}`, readable(deg(u)));

    for (const c of sg.wall.columns || []) {
      const sh = columnShape(sg, c);
      if (sh?.round) w.circle('Column', P(sh.round.c), sh.round.r * 10, height);
      else if (sh) w.poly('Column', sh.corners.map(P), height);
    }
  }

  // Shapes drawn into the plan (counters, built-ins…)
  for (const sh of room.shapes || []) {
    const [a, b] = shapePoints(sh).map(P);
    if (sh.type === 'line') w.line('Furniture', a, b);
    else if (sh.type === 'rect') w.poly('Furniture', [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]);
    else w.circle('Furniture', P({ x: +sh.x || 0, y: +sh.y || 0 }), (+sh.d || 0) * 5);
    if (sh.label) w.text('Furniture', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, TXT, sh.label);
  }

  if (geo.segs.length >= 2 && geo.gap >= 1) w.line('Dim', P(geo.end), P(geo.pts[0]));

  const xs = geo.pts.map(p => P(p).x), ys = geo.pts.map(p => P(p).y);
  const c = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  w.text('Text', add(c, { x: 0, y: 1 }, NAME_TXT * 0.7), NAME_TXT, room.name);
  if (geo.closed) w.text('Text', add(c, { x: 0, y: -1 }, NAME_TXT * 0.7), NAME_TXT * 0.6, fmtArea(geo.area));
}

// Rooms are laid out left to right so a whole project lands in one file.
// opt: { unit (label unit), wallThickness (cm, default 10) }
export function plansToDxf(rooms, { unit, wallThickness } = {}) {
  const t = (+wallThickness > 0 ? +wallThickness : 10) * 10;
  const w = writer();
  let x = 0;
  for (const room of rooms) {
    const geo = geometry(room);
    if (!geo.segs.length) continue;
    const fit = [...geo.extent, ...(room.shapes || []).flatMap(shapePoints)];
    const xs = fit.map(p => p.x * 10), ys = fit.map(p => p.y * 10);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys);
    drawRoom(w, room, x - minX + t, minY, unit, t);
    x += maxX - minX + ROOM_GAP + 2 * t;
  }

  const head = [
    '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LTYPE', '70', '2',
    '0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0',
    '0', 'LTYPE', '2', 'DASHED', '70', '0', '3', '__ __ __', '72', '65', '73', '2', '40', '75.0', '49', '50.0', '49', '-25.0',
    '0', 'ENDTAB',
    // Thai needs a TrueType font: AutoCAD's default txt.shx has no Thai glyphs.
    '0', 'TABLE', '2', 'STYLE', '70', '1',
    '0', 'STYLE', '2', 'THAI', '70', '0', '40', '0.0', '41', '1.0', '50', '0.0', '71', '0', '42', '2.5', '3', 'tahoma.ttf', '4', '',
    '0', 'ENDTAB',
    '0', 'TABLE', '2', 'LAYER', '70', String(LAYERS.length),
    ...LAYERS.flatMap(([name, color]) => ['0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', 'CONTINUOUS']),
    '0', 'ENDTAB',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
  ];
  return [...head, ...w.out, '0', 'ENDSEC', '0', 'EOF', ''].join('\r\n');
}
