// Floor plans as DXF (R12 / AC1009, readable by AutoCAD, LibreCAD, ZWCAD, SketchUp…).
// Drawing units are millimetres; the plan's y-down centimetres are flipped to CAD's y-up.
// Wall, Door, Window, Opening and Column hold closed outlines ready to extrude into 3D: walls run
// from the measured inside face out by the wall thickness and break at doors and windows, whose
// footprints fill the gap. Walls and columns carry the ceiling height as entity thickness, so
// AutoCAD shows them in 3D straight away. Door and window symbols sit on their own -Symbol layers.

import { geometry, openingShapes, chainBreaks, columnCorners, inwardFor, fmtLen, fmtArea } from './plan.js';

const LAYERS = [
  ['Wall', 7], ['Door', 3], ['Door-Symbol', 3], ['Window', 5], ['Window-Symbol', 5],
  ['Opening', 8], ['Column', 6], ['Dim', 1], ['Text', 2],
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
    poly(layer, pts, height = 0) {
      g(0, 'POLYLINE'); g(8, layer); g(66, 1);
      g(10, 0); g(20, 0); g(30, 0); g(70, 1);
      if (height > 0) g(39, num(height));
      for (const p of pts) { g(0, 'VERTEX'); g(8, layer); g(10, num(p.x)); g(20, num(p.y)); g(30, 0); }
      g(0, 'SEQEND'); g(8, layer);
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
  const sign = geo.cw ? 1 : -1;
  const height = (+room.height || 0) * 10;
  const segs = geo.segs.filter(sg => sg.len);
  // Inward normal in plan space (y down), carried through the y flip.
  const inwardCad = sg => ({ x: -sg.u.y * sign, y: -sg.u.x * sign });
  const outward = sg => { const n = inwardCad(sg); return { x: -n.x, y: -n.y }; };

  // Outside face at corner i: where the outer faces of the walls either side meet (mitre).
  const outerCorner = (i, sg) => {
    const k = segs.indexOf(sg);
    const prev = k > 0 ? segs[k - 1] : geo.closed ? segs[segs.length - 1] : null;
    const p = P(i === 'start' ? sg.p0 : sg.p1), o2 = outward(sg);
    const other = i === 'start' ? prev : k < segs.length - 1 ? segs[k + 1] : geo.closed ? segs[0] : null;
    if (!other) return add(p, o2, t);
    const o1 = outward(other), dot = o1.x * o2.x + o1.y * o2.y;
    if (dot < -0.99) return add(p, o2, t);
    return add(p, { x: o1.x + o2.x, y: o1.y + o2.y }, t / (1 + dot));
  };

  for (const sg of segs) {
    const A = P(sg.p0), B = P(sg.p1);
    const len = sg.len * 10;
    const u = { x: (B.x - A.x) / len, y: (B.y - A.y) / len };
    const n = inwardCad(sg), o = outward(sg);

    const ops = (sg.wall.openings || [])
      .map(op => {
        const off = Math.min(Math.max(+op.offset || 0, 0), sg.len) * 10;
        return { op, off, w: Math.min(Math.max(+op.width || 0, 0) * 10, len - off) };
      })
      .filter(x => x.w > 0)
      .sort((a, b) => a.off - b.off);

    // Wall pieces between openings, each a closed outline through the wall thickness.
    const qa = outerCorner('start', sg), qb = outerCorner('end', sg);
    const piece = (s0, s1) => {
      if (s1 - s0 < 0.5) return;
      const i0 = add(A, u, s0), i1 = add(A, u, s1);
      const o0 = s0 <= 0 ? qa : add(i0, o, t), o1 = s1 >= len ? qb : add(i1, o, t);
      w.poly('Wall', [i0, i1, o1, o0], height);
    };
    let at = 0;
    for (const { op, off, w: ow } of ops) {
      if (off > at) piece(at, off);
      at = Math.max(at, off + ow);
      const a = add(A, u, off), b = add(A, u, off + ow);
      const layer = op.type === 'door' ? 'Door' : op.type === 'window' ? 'Window' : 'Opening';
      w.poly(layer, [a, b, add(b, o, t), add(a, o, t)]);
      if (layer === 'Opening') continue;
      // Frames and sliding panels sit inside the wall thickness; swings open from the inside face.
      for (const sh of openingShapes(op, a, u, n, ow, t, -t / 2)) {
        if (sh.line) { w.line(`${layer}-Symbol`, sh.line[0], sh.line[1], sh.dash); continue; }
        const { c, from, to } = sh.arc;
        const t0 = deg({ x: from.x - c.x, y: from.y - c.y }), t1 = deg({ x: to.x - c.x, y: to.y - c.y });
        const ccw = (((t1 - t0) % 360) + 360) % 360 <= 180;
        w.arc(`${layer}-Symbol`, c, Math.hypot(from.x - c.x, from.y - c.y), ccw ? t0 : t1, ccw ? t1 : t0, sh.dash);
      }
    }
    if (at < len) piece(at, len);

    // Dimensions outside the wall thickness: a chain through door/window edges, then the overall length.
    const tick = { x: (u.x + o.x) * Math.SQRT1_2, y: (u.y + o.y) * Math.SQRT1_2 };
    const dimRow = (marks, dist) => {
      const base = t + dist;
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

    for (const c of sg.wall.columns || []) {
      const q = columnCorners(sg, c, inwardFor(geo.cw));
      if (q) w.poly('Column', q.map(P), height);
    }
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
    const xs = geo.pts.map(p => p.x * 10), ys = geo.pts.map(p => p.y * 10);
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
