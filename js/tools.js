// Editing on the room plan with a finger or mouse.
//   edit  — drag doors, windows, columns and drawn shapes; drag handles to resize a shape or to
//           swing / stretch the selected wall (its far end).
//   wall  — tap or drag to add a wall from where the last one ends.
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
    if (tool === 'wall') return { kind: 'wall' };
    if (tool === 'line' || tool === 'rect' || tool === 'circle') return { kind: 'shape-new', a: snapPoint(p, ppcm).p };
    if (tool !== 'edit') return null;

    const handle = el.closest?.('[data-handle]')?.dataset.handle;
    if (handle) return { kind: 'handle', handle, target: el.closest('[data-handle]').dataset.for };
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
    const { p, ppcm } = frame(e);
    const d = drag;
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

  // Handles: corners of a rectangle, the rim of a circle, the ends of a line, or the far end
  // of the selected wall. Returns the point it snapped to, if any.
  function dragHandle(d, p, ppcm) {
    if (d.handle === 'wall-end') {
      const g = geometry(room), sg = g.segs.find(x => x.wall.id === d.target);
      if (!sg) return null;
      const i = sg.i;
      // Only corners before this wall stay put while it moves, so only they (and A, to close) can catch it.
      const s = snapPoint(p, ppcm, { points: g.pts.slice(0, i), walls: false });
      const prevHeading = i > 0 ? g.segs[i - 1].heading + (+g.segs[i - 1].wall.turn || 0) : 0;
      const { heading, len } = aim(sg.p0, s.p, prevHeading, !!s.at);
      // Turning this wall turns the corner before it; the corner after it turns back the other way,
      // so the walls that follow keep their direction and simply shift.
      const delta = heading - sg.heading;
      if (i === 0) room.heading0 = normAngle((+room.heading0 || 0) + delta);
      else setTurn(room.walls[i - 1], (+room.walls[i - 1].turn || 0) + delta);
      if (i < room.walls.length - 1) setTurn(sg.wall, (+sg.wall.turn || 0) - delta);
      sg.wall.length = len;
      return s.at;
    }
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
      const nw = ctx.newWall({ length: len, turn: 90 });
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
