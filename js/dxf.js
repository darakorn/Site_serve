// Floor plans as DXF (R12 / AC1009, readable by AutoCAD, LibreCAD, ZWCAD, SketchUp…).
// Drawing units are millimetres; the plan's y-down centimetres are flipped to CAD's y-up.
// Walls are single lines on the measured inside face, broken at doors, windows and openings.

import { geometry, openingShapes, fmtM, fmtArea } from './plan.js';

const LAYERS = [['WALL', 7], ['DOOR', 3], ['WINDOW', 5], ['OPENING', 8], ['DIM', 1], ['TEXT', 2]];
const DIM_OFF = 300, TICK = 60, TXT = 120, NAME_TXT = 250, WIN_DEPTH = 100, ROOM_GAP = 1500;

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

// Draws one room with its corner A at (ox, oy) in CAD space.
function drawRoom(w, room, ox, oy) {
  const geo = geometry(room);
  const P = p => ({ x: ox + p.x * 10, y: oy - p.y * 10 });
  const sign = geo.cw ? 1 : -1;

  for (const sg of geo.segs) {
    if (!sg.len) continue;
    const A = P(sg.p0), B = P(sg.p1);
    const len = sg.len * 10;
    const u = { x: (B.x - A.x) / len, y: (B.y - A.y) / len };
    // Inward normal in plan space (y down), carried through the y flip.
    const n = { x: -sg.u.y * sign, y: -sg.u.x * sign };

    const ops = (sg.wall.openings || [])
      .map(o => {
        const off = Math.min(Math.max(+o.offset || 0, 0), sg.len) * 10;
        return { o, off, w: Math.min(Math.max(+o.width || 0, 0) * 10, len - off) };
      })
      .filter(x => x.w > 0)
      .sort((a, b) => a.off - b.off);

    let at = 0;
    for (const { o, off, w: ow } of ops) {
      if (off > at) w.line('WALL', add(A, u, at), add(A, u, off));
      at = Math.max(at, off + ow);
      const a = add(A, u, off), b = add(A, u, off + ow);
      if (o.type === 'door' || o.type === 'window') {
        const layer = o.type.toUpperCase();
        // Frames and sliding panels sit in a WIN_DEPTH band just outside the inside face.
        for (const sh of openingShapes(o, a, u, n, ow, WIN_DEPTH, -WIN_DEPTH / 2)) {
          if (sh.line) { w.line(layer, sh.line[0], sh.line[1], sh.dash); continue; }
          const { c, from, to } = sh.arc;
          const t0 = deg({ x: from.x - c.x, y: from.y - c.y }), t1 = deg({ x: to.x - c.x, y: to.y - c.y });
          const ccw = (((t1 - t0) % 360) + 360) % 360 <= 180;
          w.arc(layer, c, Math.hypot(from.x - c.x, from.y - c.y), ccw ? t0 : t1, ccw ? t1 : t0, sh.dash);
        }
      } else {
        w.line('OPENING', a, b);
      }
    }
    if (at < len) w.line('WALL', add(A, u, at), B);

    // Dimension outside the wall: extension lines, dimension line, ticks, text in metres.
    const o = { x: -n.x, y: -n.y };
    const da = add(A, o, DIM_OFF), db = add(B, o, DIM_OFF);
    w.line('DIM', add(A, o, 50), add(A, o, DIM_OFF + 60));
    w.line('DIM', add(B, o, 50), add(B, o, DIM_OFF + 60));
    w.line('DIM', da, db);
    const tick = { x: (u.x + o.x) * Math.SQRT1_2, y: (u.y + o.y) * Math.SQRT1_2 };
    for (const p of [da, db]) w.line('DIM', add(p, tick, -TICK / 2), add(p, tick, TICK / 2));
    w.text('DIM', add(add(da, u, len / 2), o, TXT), TXT, fmtM(sg.len), readable(deg(u)));
  }

  if (geo.segs.length >= 2 && geo.gap >= 1) w.line('DIM', P(geo.end), P(geo.pts[0]));

  const xs = geo.pts.map(p => P(p).x), ys = geo.pts.map(p => P(p).y);
  const c = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  w.text('TEXT', add(c, { x: 0, y: 1 }, NAME_TXT * 0.7), NAME_TXT, room.name);
  if (geo.closed) w.text('TEXT', add(c, { x: 0, y: -1 }, NAME_TXT * 0.7), NAME_TXT * 0.6, fmtArea(geo.area));
}

// Rooms are laid out left to right so a whole project lands in one file.
export function plansToDxf(rooms) {
  const w = writer();
  let x = 0;
  for (const room of rooms) {
    const geo = geometry(room);
    if (!geo.segs.length) continue;
    const xs = geo.pts.map(p => p.x * 10), ys = geo.pts.map(p => p.y * 10);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys);
    drawRoom(w, room, x - minX, minY);
    x += maxX - minX + ROOM_GAP;
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
