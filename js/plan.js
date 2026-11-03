// Room geometry from a wall walk, and SVG floor-plan rendering.
// A room is walked wall by wall starting at corner A heading right (east).
// After each wall the walker turns by `turn` degrees (+ = right, − = left).
// Walking clockwise keeps the room on the walker's right; a plain rectangle is four right turns.

const VW = 400;
const INK = '#222';
const DIM = '#777';
const ACC = '#1f6f5c';
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
  window: { casement: 'Casement', slide: 'Sliding', awning: 'Awning' },
};
export const OPEN_STYLE_DEFAULTS = { door: { style: 'swing', leaves: 1 }, window: { style: 'slide', leaves: 2 } };
export const MAX_LEAVES = { door: 4, window: 6 };

// Style and leaf count of a door/window, falling back to defaults for older records.
export function openStyle(o) {
  const d = OPEN_STYLE_DEFAULTS[o.type];
  if (!d) return null;
  const style = OPEN_STYLES[o.type][o.style] ? o.style : d.style;
  const leaves = Math.min(MAX_LEAVES[o.type], Math.max(1, parseInt(o.leaves) || d.leaves));
  return { style, leaves, label: OPEN_STYLES[o.type][style] };
}

/**
 * Plan symbol of a door or window as lines and quarter arcs, in any coordinate space.
 * a: start point on the wall line, u: unit along the wall, n: unit into the room,
 * (o.swing === 'out' opens a swing door away from the room; o.hinge === 'right' mirrors a door so
 * its hinge is on the right as seen from inside the room — the wall's end corner),
 * w: opening width, t: symbol depth (wall thickness), mid: offset of the frame centre along n.
 * Returns [{ line: [p, q], dash }, { arc: { c, from, to }, dash }].
 */
export function openingShapes(o, a, u, n, w, t, mid = 0) {
  const st = openStyle(o);
  if (!st) return [];
  const { style, leaves: L } = st, lw = w / L;
  const flip = o.type === 'door' && o.hinge === 'right';
  const P = (along, across = 0) => add(add(a, u, flip ? w - along : along), n, across);
  const out = [];
  const ln = (p, q, dash = false) => out.push({ line: [p, q], dash });
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
    else panels(t / 4);
    return out;
  }

  // Window frame on both faces with jamb ticks, then the sash symbol.
  for (const k of [-t / 2, t / 2]) ln(P(0, mid + k), P(w, mid + k));
  for (const x of [0, w]) ln(P(x, mid - t / 2), P(x, mid + t / 2));
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
  for (const w of room.walls) {
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
export const inwardFor = cw => u => (cw ? { x: -u.y, y: u.x } : { x: u.y, y: -u.x });

// Point on a wall at `x` cm along its chord (straight line from corner to corner), with the unit
// tangent `t` and the unit normal `n` into the room there. Straight walls: t = u everywhere.
export function segPoint(sg, x) {
  const { arc } = sg;
  if (!arc) return { p: add(sg.p0, sg.u, x), t: sg.u, n: sg.inward };
  const X = x - sg.len / 2, root = Math.sqrt(Math.max(0, arc.r * arc.r - X * X));
  const y = arc.sign * (root - (arc.r - Math.abs(arc.h)));
  const slope = root ? (-arc.sign * X) / root : 0;
  const tv = add(sg.u, arc.out, slope), k = Math.hypot(tv.x, tv.y);
  const t = { x: tv.x / k, y: tv.y / k };
  return { p: add(add(sg.p0, sg.u, x), arc.out, y), t, n: sg.inwardOf(t) };
}

// Things drawn into the plan (counters, built-ins…), in plan cm from corner A, y down:
// line { x1, y1, x2, y2 }, rect { x, y, w, h }, circle { x, y (centre), d (diameter) }; each may have a label.
export const SHAPE_TYPES = { line: 'Line', rect: 'Rectangle', circle: 'Circle' };
export function shapePoints(sh) {
  if (sh.type === 'line') return [{ x: +sh.x1 || 0, y: +sh.y1 || 0 }, { x: +sh.x2 || 0, y: +sh.y2 || 0 }];
  if (sh.type === 'rect') return [{ x: +sh.x || 0, y: +sh.y || 0 }, { x: (+sh.x || 0) + (+sh.w || 0), y: (+sh.y || 0) + (+sh.h || 0) }];
  const r = (+sh.d || 0) / 2;
  return [{ x: (+sh.x || 0) - r, y: (+sh.y || 0) - r }, { x: (+sh.x || 0) + r, y: (+sh.y || 0) + r }];
}
const shapeCenter = sh => mid(...shapePoints(sh));

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
  let area = Math.abs(a2) / 2, perimeter = 0;

  // Curved walls: `bulge` is how far the middle of the wall bows out from the straight line
  // between its corners (+ away from the room, − into it), up to a half circle.
  for (const sg of segs) {
    sg.inwardOf = inwardOf;
    sg.inward = inwardOf(sg.u);
    const h = clamp(+sg.wall.bulge || 0, -sg.len / 2, sg.len / 2);
    if (Math.abs(h) < 0.5 || !sg.len) { perimeter += sg.len; continue; }
    const c = sg.len, r = (c * c / 4 + h * h) / (2 * Math.abs(h));
    const out = { x: -sg.inward.x, y: -sg.inward.y }, sign = Math.sign(h);
    const m = mid(sg.p0, sg.p1);
    sg.arc = { h, r, sign, out, apex: add(m, out, h), center: add(m, out, h - sign * r) };
    const half = Math.asin(Math.min(1, c / (2 * r)));
    perimeter += 2 * r * half;
    // Circular segment between chord and arc: added when the wall bows out, removed when it bows in.
    area += sign * (r * r * half - (c / 2) * (r - Math.abs(h)));
  }
  // Corners plus the tip of each curved wall: what the plan has to fit.
  const extent = [...pts, ...segs.filter(sg => sg.arc).map(sg => sg.arc.apex)];
  return { pts, segs, end, gap, closed: gap < 1 && (segs.length >= 3 || (segs.length === 2 && segs.every(sg => sg.arc))), area, perimeter, cw, extent };
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
  const fit = [...g.extent, ...(g.segs.length ? [] : [{ x: -50, y: -50 }, { x: 400, y: 300 }]), ...(room.shapes || []).flatMap(shapePoints)];
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

  const corners = g.closed ? g.pts.slice(0, -1) : g.pts;
  out.push(`<path d="${wallPath(g, X, g.segs, true)}" fill="#f3efe6"/>`);
  out.push(`<path d="${wallPath(g, X)}" fill="none" stroke="${INK}" stroke-width="${f(T)}" stroke-linejoin="miter" stroke-linecap="square"/>`);

  const sel = g.segs.find(sg => sg.wall.id === opt.selected);
  if (sel && !mini) out.push(`<path d="${wallPath(g, X, [sel], false)}" fill="none" stroke="${ACC}" stroke-width="${f(T)}" stroke-linecap="square"/>`);

  // Doors, windows and other openings
  // On a curved wall each opening is drawn straight between its two ends on the arc.
  const hits = [], tagSpots = [], tags = openingTags(room);
  for (const sg of g.segs) {
    for (const o of sg.wall.openings || []) {
      const off = clamp(+o.offset || 0, 0, sg.len);
      const w = clamp(+o.width || 0, 0, sg.len - off);
      if (!w) continue;
      const a = X(segPoint(sg, off).p), b = X(segPoint(sg, off + w).p), r = Math.hypot(b.x - a.x, b.y - a.y);
      const u = { x: (b.x - a.x) / r, y: (b.y - a.y) / r }, n = inward(u);
      out.push(line(a, b, `stroke="#fff" stroke-width="${f(T + Z(2))}"`));
      if (tags.has(o.id)) tagSpots.push({ p: add(mid(a, b), n, Z(o.type === 'door' ? 12 : 10)), tag: tags.get(o.id), sel: o.id === opt.selectedOp });
      if (!mini && !opt.export) hits.push(line(a, b, `stroke="#000" stroke-opacity="0" stroke-width="${f(Z(22))}" data-wall="${sg.wall.id}" data-op="${o.id}" style="cursor:pointer"`));
      if (o.type === 'door' || o.type === 'window') {
        const solid = Z(o.type === 'door' ? (mini ? 1 : 1.6) : 1);
        for (const sh of openingShapes(o, a, u, n, r, T)) {
          if (sh.line) {
            out.push(line(sh.line[0], sh.line[1], `stroke="${INK}" stroke-width="${f(sh.dash ? Z(0.8) : solid)}"${sh.dash ? ' ' + dash(3, 2) : ''}`));
          } else {
            const { c, from, to } = sh.arc, rr = Math.hypot(from.x - c.x, from.y - c.y);
            const sweep = (from.x - c.x) * (to.y - c.y) - (from.y - c.y) * (to.x - c.x) > 0 ? 1 : 0;
            out.push(`<path d="M${f(from.x)} ${f(from.y)} A${f(rr)} ${f(rr)} 0 0 ${sweep} ${f(to.x)} ${f(to.y)}" fill="none" stroke="${INK}" stroke-width="${f(Z(0.8))}" ${dash(3, 2)}/>`);
          }
        }
      } else {
        out.push(line(a, b, `stroke="${INK}" stroke-width="${f(Z(1.2))}" ${dash(4, 3)}`));
      }
    }
  }

  // Drawn shapes (counters etc.), under the labels
  const SHAPE = '#4f6a8f', shapeLabels = [];
  for (const sh of shapes) {
    const on = sh.id === opt.selectedOp, draft = sh.id === '__draft';
    const tag = !mini && !opt.export && !draft ? ` data-shape="${sh.id}" style="cursor:pointer"` : '';
    const look = `stroke="${on ? ACC : SHAPE}" stroke-width="${f(Z(on ? 2 : 1.4))}"${draft ? ' ' + dash(4, 3) : ''}`;
    if (sh.type === 'line') {
      const [a, b] = shapePoints(sh).map(X);
      out.push(line(a, b, `${look} stroke-linecap="round"`));
      if (tag) out.push(line(a, b, `stroke="#000" stroke-opacity="0" stroke-width="${f(Z(16))}"${tag}`));
    } else if (sh.type === 'rect') {
      const [a, b] = shapePoints(sh).map(X);
      out.push(`<rect x="${f(Math.min(a.x, b.x))}" y="${f(Math.min(a.y, b.y))}" width="${f(Math.abs(b.x - a.x))}" height="${f(Math.abs(b.y - a.y))}" fill="${SHAPE}" fill-opacity="0.12" ${look}${tag}/>`);
    } else {
      const c = X({ x: +sh.x || 0, y: +sh.y || 0 });
      out.push(`<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(Math.max(((+sh.d || 0) / 2) * s, Z(1)))}" fill="${SHAPE}" fill-opacity="0.12" ${look}${tag}/>`);
    }
    if (sh.label && !mini) shapeLabels.push({ p: X(shapeCenter(sh)), label: sh.label, on });
  }

  // Columns
  for (const sg of g.segs) {
    for (const c of sg.wall.columns || []) {
      const sh = columnShape(sg, c);
      if (!sh) continue;
      const tag = !mini && !opt.export ? ` data-wall="${sg.wall.id}" data-col="${c.id}" style="cursor:pointer"` : '';
      const look = `fill="#555" stroke="${INK}" stroke-width="${f(Z(1))}"${tag}`;
      if (sh.round) { const q = X(sh.round.c); out.push(`<circle cx="${f(q.x)}" cy="${f(q.y)}" r="${f(Math.max(sh.round.r * s, Z(1.5)))}" ${look}/>`); }
      else out.push(`<polygon points="${sh.corners.map(p => { const v = X(p); return `${f(v.x)},${f(v.y)}`; }).join(' ')}" ${look}/>`);
    }
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
      const breaks = chainBreaks(sg), dc = Z(22) + push, d = Z(breaks ? 40 : 24) + push;
      if (breaks) {
        const at = v => add(a, sg.u, v * s);
        out.push(line(add(at(0), o, dc), add(at(sg.len), o, dc), thin));
        breaks.forEach((v, k) => {
          const p = add(at(v), o, dc);
          if (k && k < breaks.length - 1) out.push(line(add(at(v), o, Z(6)), add(p, o, Z(3)), thin));
          tick(p);
          const nx = breaks[k + 1];
          if (nx == null) return;
          const str = fmtLen(nx - v, opt.unit);
          if ((nx - v) * s < str.length * Z(9) * 0.6) return; // doesn't fit between its ticks
          text(3, add(add(at((v + nx) / 2), o, dc), o, Z(6)), str, 9, ang, `fill="${DIM}" ${halo}`);
        });
      }
      const da = add(a, o, d), db = add(b, o, d);
      out.push(line(add(a, o, Z(6)), add(a, o, d + Z(4)), thin), line(add(b, o, Z(6)), add(b, o, d + Z(4)), thin), line(da, db, thin));
      tick(da); tick(db);
      // Longer walls win a tie for space.
      text(1 + 1 / (1 + sg.len), add(mid(da, db), o, Z(8)), lenStr, 12, ang, `font-weight="600" fill="${INK}" ${halo}`);
    }

    for (const { p, label: str, on } of shapeLabels) text(on ? 0 : 2.8, p, str, 9, 0, `fill="${on ? ACC : SHAPE}" font-weight="600" ${halo}`);

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
      let v = { x: 0, y: 0 };
      for (const sg of [prev, next]) if (sg) { const n = inward(sg.u); v.x -= n.x; v.y -= n.y; }
      const k = Math.hypot(v.x, v.y) || 1;
      text(i ? 2 : 0.5, add(X(p), { x: v.x / k, y: v.y / k }, Z(13)), cornerName(i), 11, 0, `font-weight="700" fill="${ACC}" ${halo}`);
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
