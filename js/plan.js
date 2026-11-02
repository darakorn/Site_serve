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
  mm: { k: 10, label: 'มม.', fix: 0, input: 1 },
  cm: { k: 1, label: 'ซม.', fix: 0, input: 2 },
  m: { k: 0.01, label: 'ม.', fix: 2, input: 4 },
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
export const fmtArea = cm2 => (cm2 / 10000).toFixed(2) + ' ตร.ม.';
export const cornerName = i => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
export const normAngle = a => Math.round(((((a % 360) + 540) % 360) - 180) * 10) / 10;

export const OPEN_STYLES = {
  door: { swing: 'บานเปิด', slide: 'บานเลื่อน', double: 'บานสวิง 2 ทาง' },
  window: { casement: 'บานเปิด', slide: 'บานเลื่อน', awning: 'บานกระทุ้ง' },
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
 * w: opening width, t: symbol depth (wall thickness), mid: offset of the frame centre along n.
 * Returns [{ line: [p, q], dash }, { arc: { c, from, to }, dash }].
 */
export function openingShapes(o, a, u, n, w, t, mid = 0) {
  const st = openStyle(o);
  if (!st) return [];
  const { style, leaves: L } = st, lw = w / L;
  const P = (along, across = 0) => add(add(a, u, along), n, across);
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
    if (style === 'swing') swing(1, false);
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
// wall into the room, `width` along the wall and `depth` into the room.
export function columnCorners(sg, c, inward) {
  const n = inward(sg.u), w = Math.max(0, +c.width || 0), d = Math.max(0, +c.depth || 0);
  if (!w || !d) return null;
  const p = add(add(sg.p0, sg.u, Math.max(0, +c.offset || 0)), n, Math.max(0, +c.gap || 0));
  return [p, add(p, sg.u, w), add(add(p, sg.u, w), n, d), add(p, n, d)];
}
export const inwardFor = cw => u => (cw ? { x: -u.y, y: u.x } : { x: u.y, y: -u.x });

export function geometry(room) {
  const pts = [{ x: 0, y: 0 }];
  const segs = [];
  let heading = 0;
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
  return {
    pts, segs, end, gap,
    closed: segs.length >= 3 && gap < 1,
    area: Math.abs(a2) / 2,
    perimeter: segs.reduce((s, g) => s + g.len, 0),
    cw: a2 >= 0, // clockwise on screen (y down) → room is on the right of each wall
  };
}

const f = n => n.toFixed(1);
const add = (p, v, k) => ({ x: p.x + v.x * k, y: p.y + v.y * k });
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const line = (a, b, attrs) => `<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" ${attrs}/>`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const halo = 'paint-order="stroke" stroke="#fff" stroke-width="3" stroke-linejoin="round"';

function readableAngle(u) {
  let a = (Math.atan2(u.y, u.x) * 180) / Math.PI;
  if (a > 90) a -= 180;
  if (a <= -90) a += 180;
  return a;
}

/**
 * opt: { mini, selected (wall id), photoCounts {wallId: n}, export, title, subtitle, unit }
 */
export function renderPlan(room, opt = {}) {
  const g = geometry(room);
  const mini = !!opt.mini;
  const svgOpen = (h, extra = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${h}"${opt.export ? ` width="${VW}" height="${h}"` : ''} font-family="${FONT}"${extra}>`;
  if (!g.segs.length) {
    return `${svgOpen(120)}<text x="${VW / 2}" y="64" text-anchor="middle" fill="${DIM}" font-size="14">ยังไม่มีผนัง</text></svg>`;
  }

  const head = opt.export ? 46 : 0;
  const pad = mini ? 10 : 56;
  const maxH = mini ? 280 : 440;
  const xs = g.pts.map(p => p.x), ys = g.pts.map(p => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const bw = Math.max(Math.max(...xs) - minX, 1), bh = Math.max(Math.max(...ys) - minY, 1);
  const s = Math.min((VW - 2 * pad) / bw, (maxH - 2 * pad) / bh);
  const VH = Math.round(bh * s + 2 * pad + head);
  const ox = (VW - bw * s) / 2 - minX * s, oy = pad + head - minY * s;
  const X = p => ({ x: ox + p.x * s, y: oy + p.y * s });
  const sign = g.cw ? 1 : -1;
  const inward = u => ({ x: -u.y * sign, y: u.x * sign });
  const T = mini ? 3 : 6;
  const out = [];

  if (opt.export) {
    out.push(`<rect width="${VW}" height="${VH}" fill="#fff"/>`);
    out.push(`<text x="14" y="26" font-size="15" font-weight="700" fill="${INK}">${esc(opt.title)}</text>`);
    out.push(`<text x="${VW - 14}" y="26" font-size="12" text-anchor="end" fill="${DIM}">${esc(opt.subtitle)}</text>`);
  }

  const corners = g.closed ? g.pts.slice(0, -1) : g.pts;
  const ptsAttr = corners.map(p => { const q = X(p); return `${f(q.x)},${f(q.y)}`; }).join(' ');
  out.push(`<polygon points="${ptsAttr}" fill="#f3efe6"/>`);
  out.push(`<${g.closed ? 'polygon' : 'polyline'} points="${ptsAttr}" fill="none" stroke="${INK}" stroke-width="${T}" stroke-linejoin="miter" stroke-linecap="square"/>`);

  const sel = g.segs.find(sg => sg.wall.id === opt.selected);
  if (sel && !mini) out.push(line(X(sel.p0), X(sel.p1), `stroke="${ACC}" stroke-width="${T}" stroke-linecap="square"`));

  // Doors, windows and other openings
  for (const sg of g.segs) {
    const A = X(sg.p0), u = sg.u, n = inward(u);
    for (const o of sg.wall.openings || []) {
      const off = clamp(+o.offset || 0, 0, sg.len);
      const w = clamp(+o.width || 0, 0, sg.len - off);
      if (!w) continue;
      const a = add(A, u, off * s), b = add(a, u, w * s), r = w * s;
      out.push(line(a, b, `stroke="#fff" stroke-width="${T + 2}"`));
      if (o.type === 'door' || o.type === 'window') {
        const solid = o.type === 'door' ? (mini ? 1 : 1.6) : 1;
        for (const sh of openingShapes(o, a, u, n, r, T)) {
          if (sh.line) {
            out.push(line(sh.line[0], sh.line[1], `stroke="${INK}" stroke-width="${sh.dash ? 0.8 : solid}"${sh.dash ? ' stroke-dasharray="3 2"' : ''}`));
          } else {
            const { c, from, to } = sh.arc, rr = Math.hypot(from.x - c.x, from.y - c.y);
            const sweep = (from.x - c.x) * (to.y - c.y) - (from.y - c.y) * (to.x - c.x) > 0 ? 1 : 0;
            out.push(`<path d="M${f(from.x)} ${f(from.y)} A${f(rr)} ${f(rr)} 0 0 ${sweep} ${f(to.x)} ${f(to.y)}" fill="none" stroke="${INK}" stroke-width="0.8" stroke-dasharray="3 2"/>`);
          }
        }
      } else {
        out.push(line(a, b, `stroke="${INK}" stroke-width="1.2" stroke-dasharray="4 3"`));
      }
    }
  }

  // Columns
  const inPlan = inwardFor(g.cw);
  for (const sg of g.segs) {
    for (const c of sg.wall.columns || []) {
      const q = columnCorners(sg, c, inPlan);
      if (q) out.push(`<polygon points="${q.map(p => { const v = X(p); return `${f(v.x)},${f(v.y)}`; }).join(' ')}" fill="#555" stroke="${INK}" stroke-width="1"/>`);
    }
  }

  if (!mini) {
    // Dimension lines outside each wall, wall numbers inside
    for (const sg of g.segs) {
      if (!sg.len) continue;
      const a = X(sg.p0), b = X(sg.p1), n = inward(sg.u), o = { x: -n.x, y: -n.y };
      const thin = `stroke="${DIM}" stroke-width="0.7"`;
      const tick = p => out.push(line(add(add(p, sg.u, -3), o, 3), add(add(p, sg.u, 3), o, -3), `stroke="${INK}" stroke-width="1.2"`));
      // Chain dimension: corner, each door/window edge, corner. The overall length moves out a row.
      const breaks = chainBreaks(sg), dc = 22, d = breaks ? 40 : 24;
      if (breaks) {
        const at = v => add(a, sg.u, v * s);
        out.push(line(add(at(0), o, dc), add(at(sg.len), o, dc), thin));
        breaks.forEach((v, k) => {
          const p = add(at(v), o, dc);
          if (k && k < breaks.length - 1) out.push(line(add(at(v), o, 6), add(p, o, 3), thin));
          tick(p);
          const nx = breaks[k + 1];
          if (nx == null || (nx - v) * s < 16) return;
          const t = add(add(at((v + nx) / 2), o, dc), o, 6);
          out.push(`<text x="${f(t.x)}" y="${f(t.y)}" transform="rotate(${f(readableAngle(sg.u))} ${f(t.x)} ${f(t.y)})" text-anchor="middle" dominant-baseline="middle" font-size="9" fill="${DIM}" ${halo}>${fmtLen(nx - v, opt.unit)}</text>`);
        });
      }
      const da = add(a, o, d), db = add(b, o, d);
      out.push(line(add(a, o, 6), add(a, o, d + 4), thin), line(add(b, o, 6), add(b, o, d + 4), thin), line(da, db, thin));
      tick(da); tick(db);
      const t = add(mid(da, db), o, 8);
      out.push(`<text x="${f(t.x)}" y="${f(t.y)}" transform="rotate(${f(readableAngle(sg.u))} ${f(t.x)} ${f(t.y)})" text-anchor="middle" dominant-baseline="middle" font-size="12" font-weight="600" fill="${INK}" ${halo}>${fmtLen(sg.len, opt.unit)}</text>`);

      const isSel = sel === sg;
      const c = add(mid(a, b), n, 18);
      out.push(`<circle cx="${f(c.x)}" cy="${f(c.y)}" r="9" fill="${isSel ? ACC : '#fff'}" stroke="${isSel ? ACC : DIM}"/>`);
      out.push(`<text x="${f(c.x)}" y="${f(c.y)}" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="700" fill="${isSel ? '#fff' : INK}">${sg.i + 1}</text>`);
      const cnt = opt.photoCounts?.[sg.wall.id];
      if (cnt) {
        const pc = add(c, n, 15);
        out.push(`<text x="${f(pc.x)}" y="${f(pc.y)}" text-anchor="middle" dominant-baseline="central" font-size="9" fill="${DIM}">📷${cnt}</text>`);
      }
    }

    // Corner letters
    corners.forEach((p, i) => {
      const prev = g.segs[i - 1] ?? (g.closed ? g.segs[g.segs.length - 1] : null);
      const next = g.segs[i];
      let v = { x: 0, y: 0 };
      for (const sg of [prev, next]) if (sg) { const n = inward(sg.u); v.x -= n.x; v.y -= n.y; }
      const k = Math.hypot(v.x, v.y) || 1;
      const q = add(X(p), { x: v.x / k, y: v.y / k }, 13);
      out.push(`<text x="${f(q.x)}" y="${f(q.y)}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" fill="${ACC}" ${halo}>${cornerName(i)}</text>`);
    });

    if (g.segs.length >= 2 && g.gap >= 1) {
      const a = X(g.end), b = X(g.pts[0]), m = mid(a, b);
      out.push(line(a, b, `stroke="${RED}" stroke-width="1.5" stroke-dasharray="5 4"`));
      out.push(`<text x="${f(m.x)}" y="${f(m.y)}" text-anchor="middle" dominant-baseline="central" font-size="11" fill="${RED}" ${halo}>ห่าง ${fmtLen(g.gap, opt.unit)} ${UNITS[unitOf(opt.unit)].label}</text>`);
    }

    if (!opt.export) {
      for (const sg of g.segs) {
        out.push(line(X(sg.p0), X(sg.p1), `stroke="#000" stroke-opacity="0" stroke-width="30" data-wall="${sg.wall.id}" style="cursor:pointer"`));
      }
    }
  }

  return `${svgOpen(VH)}${out.join('')}</svg>`;
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
