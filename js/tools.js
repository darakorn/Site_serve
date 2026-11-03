// Editing on the room plan with a finger or mouse.
//   edit  — drag doors, windows, columns and drawn shapes; drag handles to resize a shape, or on
//           the selected wall: either end to stretch / swing it, the middle to move it sideways.
//           The walls next to it keep their direction and follow, so a closed room stays closed.
//   wall  — tap or drag to add a wall from where the last one ends (glass: the same, as a glass wall).
//   line / rect / circle — drag out a shape.
// With snap on, points stick to room corners, shape points and walls nearby, angles to 45° steps
// and everything else to a 5 cm grid. Two fingers still pinch-zoom (zoom.js); a second finger
// cancels whatever one finger was doing.

import { geometry, shapePoints, normAngle } from './plan.js';

const GRID = 5, SNAP_PX = 14, ANGLE_SNAP = 7;
const STD_TURNS = [90, -90, 45, -45, 0];
const grid = v => Math.round(v / GRID) * GRID;
const round1 = v => Math.round(v * 10) / 10;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const add = (p, v, k) => ({ x: p.x + v.x * k, y: p.y + v.y * k });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const degOf = v => (Math.atan2(v.y, v.x) * 180) / Math.PI;
const dirOf = a => ({ x: Math.cos((a * Math.PI) / 180), y: Math.sin((a * Math.PI) / 180) });
const cross = (a, b) => a.x * b.y - a.y * b.x;

// Where the line through p along u meets the line through q along v; null if they're parallel.
function meet(p, u, q, v) {
  const c = cross(u, v);
  return Math.abs(c) < 1e-6 ? null : add(p, u, cross(sub(q, p), v) / c);
}

// Points worth snapping to on a drawn shape.
function keyPoints(sh) {
  const [a, b] = shapePoints(sh);
  if (sh.type === 'rect') return [a, b, { x: a.x, y: b.y }, { x: b.x, y: a.y }];
  if (sh.type === 'circle') return [{ x: +sh.x || 0, y: +sh.y || 0 }];
  return [a, b];
}

// Sets a wall's turn and whether the form should show it as a custom angle.
function setTurn(w, turn) {
  w.turn = normAngle(turn);
  w.customTurn = !STD_TURNS.includes(w.turn);
}

/**
 * ctx: {
 *   room,
 *   tool(): current mode or null,  snap(): snap on?,
 *   preview(p): show { draft, draftWall, snapAt } and redraw the plan,
 *   done(selectId?): the model changed — save and redraw everything,
 *   resolveRefs(wall): keep openings measured from other openings in step,
 * }
 * Returns isBusy(): true while one finger is dragging, so zoom.js doesn't pan.
 */
export function attachPlanTools(box, ctx) {
  const { room } = ctx;
  let drag = null;

  // Pointer → plan cm, and how many screen px one plan cm takes right now.
  const frame = e => {
    const svg = box.querySelector('svg');
    const [ox, oy, s] = (svg?.dataset.map || '0,0,1').split(',').map(Number);
    const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    const k = Math.min(r.width / vb.width, r.height / vb.height); // viewBox is letterboxed in the element
    const vx = (e.clientX - r.left - (r.width - vb.width * k) / 2) / k, vy = (e.clientY - r.top - (r.height - vb.height * k) / 2) / k;
    return { p: { x: (vx - ox) / s, y: (vy - oy) / s }, ppcm: s * k };
  };

  // Snap a point: corners and shape points first, then the nearest wall line, then the grid.
  const snapPoint = (p, ppcm, { points = null, skipShape = null, walls = true } = {}) => {
    if (!ctx.snap()) return { p: { x: round1(p.x), y: round1(p.y) }, at: null };
    const tol = SNAP_PX / ppcm, g = geometry(room);
    const cands = [...(points ?? g.pts), ...(room.shapes || []).filter(sh => sh.id !== skipShape).flatMap(keyPoints)];
    let best = null, bd = tol;
    for (const q of cands) { const d = dist(p, q); if (d < bd) { bd = d; best = q; } }
    if (!best && walls) {
      for (const sg of g.segs) {
        if (sg.arc || !sg.len) continue;
        const q = add(sg.p0, sg.u, clamp(dot(sub(p, sg.p0), sg.u), 0, sg.len)), d = dist(p, q);
        if (d < bd) { bd = d; best = q; }
      }
    }
    if (best) return { p: { x: round1(best.x), y: round1(best.y) }, at: best };
    return { p: { x: grid(p.x), y: grid(p.y) }, at: null };
  };

  // Snap a distance along a wall to the wall ends, other opening edges, or the grid.
  const snapAlong = (v, marks, ppcm) => {
    if (!ctx.snap()) return round1(v);
    const tol = SNAP_PX / ppcm;
    const near = marks.reduce((b, m) => (Math.abs(m - v) < Math.abs(b - v) ? m : b), Infinity);
    return Math.abs(near - v) < tol ? near : grid(v);
  };

  // A direction from `from` towards `to`, held to 45° steps from `baseHeading` when close.
  const aim = (from, to, baseHeading, pointHit) => {
    let rel = normAngle(degOf(sub(to, from)) - baseHeading), len = dist(from, to);
    if (ctx.snap() && !pointHit) {
      const r = Math.round(rel / 45) * 45;
      if (Math.abs(rel - r) < ANGLE_SNAP) rel = r;
      len = grid(len);
    }
    return { heading: baseHeading + rel, len: round1(len) };
  };

  const segOf = wallId => geometry(room).segs.find(sg => sg.wall.id === wallId);

  // The plan's current scale and position, pinned for the whole drag.
  const pin = () => {
    const svg = box.querySelector('svg');
    const [ox, oy, s] = (svg?.dataset.map || '0,0,1').split(',').map(Number);
    return { ox, oy, s, VH: svg.viewBox.baseVal.height };
  };
  const show = p => ctx.preview({ ...p, frame: drag?.frame });

  // ---------- starting a drag ----------
  function begin(e) {
    const tool = ctx.tool(), { p, ppcm } = frame(e), el = e.target;
    if (tool === 'wall' || tool === 'glass') return { kind: 'wall', glass: tool === 'glass' };
    if (tool === 'line' || tool === 'rect' || tool === 'circle') return { kind: 'shape-new', a: snapPoint(p, ppcm).p };
    if (tool !== 'edit') return null;

    const handle = el.closest?.('[data-handle]')?.dataset.handle;
    if (handle) {
      const target = el.closest('[data-handle]').dataset.for;
      if (handle.startsWith('wall-')) return { kind: 'handle', handle, target, orig: snapshot(), grab: p };
      return { kind: 'handle', handle, target };
    }
    const shId = el.closest?.('[data-shape]')?.dataset.shape;
    if (shId) {
      const sh = room.shapes.find(x => x.id === shId);
      return { kind: 'shape-move', sh, start: p, orig: { ...sh } };
    }
    const opEl = el.closest?.('[data-op]');
    if (opEl) {
      const sg = segOf(opEl.dataset.wall), o = sg?.wall.openings.find(x => x.id === opEl.dataset.op);
      if (o) return { kind: 'op-move', sg, o, grab: dot(sub(p, sg.p0), sg.u) - (+o.offset || 0) };
    }
    const colEl = el.closest?.('[data-col]');
    if (colEl) {
      const sg = segOf(colEl.dataset.wall), c = sg?.wall.columns.find(x => x.id === colEl.dataset.col);
      if (c) return { kind: 'col-move', sg, c, grabU: dot(sub(p, sg.p0), sg.u) - (+c.offset || 0), grabN: dot(sub(p, sg.p0), sg.inward) - (+c.gap || 0) };
    }
    return null; // empty space: let zoom.js pan
  }

  // ---------- following the finger ----------
  function move(e) {
    const d = drag;
    const { p: raw, ppcm } = frame(e);
    const p = d.shift ? add(raw, d.shift, 1) : raw;
    let snapAt = null;

    if (d.kind === 'wall') {
      const g = geometry(room), last = g.segs.at(-1);
      const from = last ? g.end : { x: 0, y: 0 };
      const s = snapPoint(p, ppcm, { walls: false });
      const { heading, len } = aim(from, s.p, last ? last.heading + (+last.wall.turn || 0) : 0, !!s.at);
      d.result = { from, heading, len };
      snapAt = s.at;
      show({ draftWall: { a: from, b: add(from, dirOf(heading), len), len }, snapAt });
      return;
    }
    if (d.kind === 'shape-new') {
      const s = snapPoint(p, ppcm), a = d.a, b = s.p;
      const t = ctx.tool();
      if (t === 'rect') d.result = { type: 'rect', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: round1(Math.abs(b.x - a.x)), h: round1(Math.abs(b.y - a.y)) };
      else if (t === 'circle') d.result = { type: 'circle', x: a.x, y: a.y, d: round1(2 * dist(a, b)) };
      else {
        const { heading, len } = aim(a, b, 0, !!s.at);
        const e2 = s.at ? b : add(a, dirOf(heading), len);
        d.result = { type: 'line', x1: a.x, y1: a.y, x2: round1(e2.x), y2: round1(e2.y) };
      }
      show({ draft: d.result, snapAt: s.at });
      return;
    }
    if (d.kind === 'shape-move') {
      const { sh, orig } = d, delta = sub(p, d.start);
      // Snap the shape by its first point; the rest follows.
      const key = orig.type === 'line' ? { x: +orig.x1, y: +orig.y1 } : { x: +orig.x, y: +orig.y };
      const s = snapPoint(add(key, delta, 1), ppcm, { skipShape: sh.id });
      const dx = s.p.x - key.x, dy = s.p.y - key.y;
      if (orig.type === 'line') Object.assign(sh, { x1: round1(+orig.x1 + dx), y1: round1(+orig.y1 + dy), x2: round1(+orig.x2 + dx), y2: round1(+orig.y2 + dy) });
      else Object.assign(sh, { x: round1(+orig.x + dx), y: round1(+orig.y + dy) });
      snapAt = s.at;
    } else if (d.kind === 'op-move') {
      const { sg, o } = d, w = +o.width || 0;
      const marks = [0, sg.len - w, ...sg.wall.openings.filter(x => x !== o).flatMap(x => [+x.offset + +x.width, +x.offset - w])];
      const off = clamp(snapAlong(dot(sub(p, sg.p0), sg.u) - d.grab, marks, ppcm), 0, Math.max(0, sg.len - w));
      if (o.ref) {
        const r = sg.wall.openings.find(x => x.id === o.ref);
        o.refGap = Math.max(0, round1(off - (+r.offset || 0) - (+r.width || 0)));
      } else o.offset = off;
      ctx.resolveRefs(sg.wall);
    } else if (d.kind === 'col-move') {
      const { sg, c } = d, w = +c.width || 0;
      c.offset = clamp(snapAlong(dot(sub(p, sg.p0), sg.u) - d.grabU, [0, sg.len - w], ppcm), 0, Math.max(0, sg.len - w));
      c.gap = Math.max(0, snapAlong(dot(sub(p, sg.p0), sg.inward) - d.grabN, [0], ppcm));
    } else if (d.kind === 'handle') {
      snapAt = dragHandle(d, p, ppcm);
    }
    d.changed = true;
    show({ snapAt });
  }

  // The room as it was when a wall drag began; every move works out the new shape from this.
  function snapshot() {
    const g = geometry(room), n = room.walls.length;
    return {
      n, closed: g.closed,
      pts: g.pts.slice(0, g.closed ? n : n + 1),
      segs: g.segs.map(({ u, inward, heading }) => ({ u, inward, heading })),
      walls: room.walls.map(w => ({ turn: w.turn, customTurn: w.customTurn, ops: w.openings.map(o => o.offset), cols: (w.columns || []).map(c => c.offset) })),
      heading0: room.heading0,
      shapes: JSON.parse(JSON.stringify(room.shapes || [])),
    };
  }

  // Dragging the selected wall: 'wall-end' / 'wall-start' move that corner (the wall stretches and
  // swings about its other end), 'wall-move' slides the whole wall sideways. The wall beyond a
  // moved corner keeps its direction and shifts with it, and the one after that stretches to meet
  // it, so the rest of the room stays where it is. Returns the point it snapped to, if any.
  function reshapeWall(d, p, ppcm) {
    const o = d.orig, { n, closed } = o, i = room.walls.findIndex(w => w.id === d.target);
    if (i < 0) return null;
    room.shapes = JSON.parse(JSON.stringify(o.shapes));
    const k = c => (closed ? ((c % n) + n) % n : c); // corner index (a closed room wraps round)
    const has = w => closed || (w >= 0 && w < n);      // is there a wall with this index?
    const seg = w => o.segs[k(w)];
    const P = o.pts.map(q => ({ ...q }));
    const at = c => o.pts[k(c)];
    let snapAt = null;

    // Move corner c (the end of wall `near`) to q; wall `beside`, on the other side of the corner,
    // keeps its direction, and its far corner slides along the wall after it.
    const pushCorner = (c, q, beside, farCorner, after, afterFixed) => {
      P[k(c)] = q;
      if (!has(beside)) return;
      const shifted = add(at(farCorner), sub(q, at(c)), 1);
      P[k(farCorner)] = (has(after) && meet(q, seg(beside).u, at(afterFixed), seg(after).u)) || shifted;
    };

    if (d.handle === 'wall-move') {
      let t = dot(sub(p, d.grab), seg(i).inward);
      if (ctx.snap()) t = grid(t);
      const a = add(at(i), seg(i).inward, t), u = seg(i).u;
      P[k(i)] = (has(i - 1) && meet(a, u, at(i - 1), seg(i - 1).u)) || a;
      P[k(i + 1)] = (has(i + 1) && meet(a, u, at(i + 2), seg(i + 1).u)) || add(at(i + 1), seg(i).inward, t);
    } else {
      const end = d.handle === 'wall-end';
      const pivot = end ? i : i + 1, moving = end ? [i + 1, i + 2] : [i, i - 1];
      const fixed = o.pts.filter((_, c) => !moving.some(m => k(m) === c));
      const s = snapPoint(p, ppcm, { points: fixed, walls: false });
      const { heading, len } = aim(at(pivot), s.p, seg(i).heading + (end ? 0 : 180), !!s.at);
      const q = s.at ? s.p : add(at(pivot), dirOf(heading), len);
      if (end) pushCorner(i + 1, q, i + 1, i + 2, i + 2, i + 3);
      else pushCorner(i, q, i - 1, i - 1, i - 2, i - 2);
      snapAt = s.at;
    }

    // Corners → wall lengths and turns. A wall shrunk to nothing keeps its old direction.
    const H = room.walls.map((w, j) => {
      const v = sub(P[k(j + 1)] ?? P[k(j)], P[k(j)]);
      return Math.hypot(v.x, v.y) > 0.05 ? o.segs[j].heading + normAngle(degOf(v) - o.segs[j].heading) : o.segs[j].heading;
    });
    room.heading0 = normAngle(H[0]);
    room.walls.forEach((w, j) => {
      const ow = o.walls[j], last = j === n - 1;
      w.length = round1(dist(P[k(j)], P[k(j + 1)] ?? P[k(j)]));
      if (last && !closed) Object.assign(w, { turn: ow.turn, customTurn: ow.customTurn });
      else if (normAngle(H[k(j + 1)] - H[j]) !== normAngle(+ow.turn || 0)) setTurn(w, H[k(j + 1)] - H[j]);
      else Object.assign(w, { turn: ow.turn, customTurn: ow.customTurn });
      // Openings and columns are measured from the wall's start: keep them where they were when
      // that corner moves.
      const back = dot(sub(o.pts[k(j)], P[k(j)]), dirOf(H[j]));
      w.openings.forEach((x, m) => { x.offset = Math.max(0, round1((+ow.ops[m] || 0) + back)); });
      (w.columns || []).forEach((x, m) => { x.offset = Math.max(0, round1((+ow.cols[m] || 0) + back)); });
      ctx.resolveRefs(w);
    });

    // Corner A is where the plan starts from: if it moved, move the drawn shapes back so they stay
    // put, and shift the view so the plan doesn't jump under the finger.
    const A = P[0];
    d.shift = Math.hypot(A.x, A.y) > 1e-9 ? A : null;
    for (const sh of room.shapes) {
      if (sh.type === 'line') Object.assign(sh, { x1: round1(+sh.x1 - A.x), y1: round1(+sh.y1 - A.y), x2: round1(+sh.x2 - A.x), y2: round1(+sh.y2 - A.y) });
      else Object.assign(sh, { x: round1(+sh.x - A.x), y: round1(+sh.y - A.y) });
    }
    const f0 = d.frame0 ||= d.frame;
    d.frame = { ...f0, ox: f0.ox + A.x * f0.s, oy: f0.oy + A.y * f0.s };
    return snapAt;
  }

  // Dragging either end of a door / window / opening along its wall; the other end stays put.
  function resizeOpening(d, p, ppcm) {
    const sg = geometry(room).segs.find(s => s.wall.openings.some(x => x.id === d.target));
    if (!sg) return null;
    const o = sg.wall.openings.find(x => x.id === d.target);
    const a = +o.offset || 0, b = a + (+o.width || 0), MIN = GRID;
    const marks = [0, sg.len, ...sg.wall.openings.filter(x => x !== o).flatMap(x => [+x.offset, +x.offset + +x.width])];
    const v = snapAlong(dot(sub(p, sg.p0), sg.u), marks, ppcm);
    if (d.handle === 'op-end') o.width = round1(clamp(v, a + MIN, sg.len) - a);
    else {
      // One measured on from another opening can't start before that one ends.
      const r = o.ref && sg.wall.openings.find(x => x.id === o.ref), from = r ? (+r.offset || 0) + (+r.width || 0) : 0;
      const na = round1(clamp(v, from, b - MIN));
      o.width = round1(b - na);
      if (r) o.refGap = round1(na - from);
      else o.offset = na;
    }
    ctx.resolveRefs(sg.wall);
    return null;
  }

  // Handles: corners of a rectangle, the rim of a circle, the ends of a line, or on the selected
  // wall its two ends and middle. Returns the point it snapped to, if any.
  function dragHandle(d, p, ppcm) {
    if (d.handle.startsWith('wall-')) return reshapeWall(d, p, ppcm);
    if (d.handle.startsWith('op-')) return resizeOpening(d, p, ppcm);
    const sh = room.shapes.find(x => x.id === d.target);
    if (!sh) return null;
    const s = snapPoint(p, ppcm, { skipShape: sh.id }), q = s.p;
    if (d.handle.startsWith('rect-')) {
      // The opposite corner stays fixed.
      const [a, b] = shapePoints(sh), k = +d.handle.slice(5);
      const fixed = { x: k === 0 || k === 3 ? b.x : a.x, y: k === 0 || k === 1 ? b.y : a.y };
      Object.assign(sh, { x: Math.min(fixed.x, q.x), y: Math.min(fixed.y, q.y), w: round1(Math.abs(q.x - fixed.x)), h: round1(Math.abs(q.y - fixed.y)) });
    } else if (d.handle === 'circle-r') {
      sh.d = round1(2 * dist({ x: +sh.x, y: +sh.y }, q));
    } else if (d.handle === 'line-1') Object.assign(sh, { x1: q.x, y1: q.y });
    else if (d.handle === 'line-2') Object.assign(sh, { x2: q.x, y2: q.y });
    return s.at;
  }

  // ---------- letting go ----------
  function finish() {
    const d = drag;
    drag = null;
    if (d.kind === 'wall' && d.result && d.result.len >= GRID) {
      const { heading, len } = d.result, last = room.walls.at(-1);
      if (!last) room.heading0 = normAngle(heading);
      else {
        const g = geometry(room);
        setTurn(last, heading - g.segs.at(-1).heading);
      }
      const nw = ctx.newWall({ length: len, turn: 90, ...(d.glass ? { kind: 'glass' } : {}) });
      room.walls.push(nw);
      return ctx.done(nw.id, 'wall');
    }
    if (d.kind === 'shape-new' && d.result) {
      const r = d.result, size = Math.max(+r.w || 0, +r.h || 0, +r.d || 0, r.type === 'line' ? Math.hypot(r.x2 - r.x1, r.y2 - r.y1) : 0);
      if (size >= GRID) {
        (room.shapes ||= []).push({ id: ctx.uid(), label: '', ...r });
        return ctx.done(room.shapes.at(-1).id, 'shape');
      }
    }
    if (d.changed) return ctx.done();
    ctx.preview({});
  }

  box.addEventListener('pointerdown', e => {
    if (!ctx.tool()) return;
    if (drag) { drag = null; ctx.preview({}); return; } // second finger: it's a pinch
    drag = begin(e);
    if (drag) { drag.pointer = e.pointerId; drag.frame = pin(); if (drag.kind === 'wall' || drag.kind === 'shape-new') move(e); }
  });
  box.addEventListener('pointermove', e => { if (drag && e.pointerId === drag.pointer) move(e); });
  box.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pointer) finish(); });
  box.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.pointer) { drag = null; ctx.preview({}); } });

  return () => !!drag;
}
