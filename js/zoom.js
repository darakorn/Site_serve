// Pinch / wheel / double-tap zoom for the room plan, so only the plan zooms and not the page.
// The SVG inside `box` is CSS-transformed; `state` ({ k, x, y }) outlives re-renders of the SVG.

const MAX = 8, TAP_MOVE = 6, DOUBLE_TAP_MS = 300;

export const newZoom = () => ({ k: 1, x: 0, y: 0 });

export function applyZoom(box, z) {
  const svg = box.querySelector('svg');
  if (!svg) return;
  const W = svg.clientWidth, H = svg.clientHeight;
  z.k = Math.min(MAX, Math.max(1, z.k));
  z.x = Math.min(0, Math.max(W - W * z.k, z.x));
  z.y = Math.min(0, Math.max(H - H * z.k, z.y));
  if (z.k === 1) z.x = z.y = 0;
  svg.style.transformOrigin = '0 0';
  svg.style.transform = z.k === 1 ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.k})`;
  box.closest('.plan-box')?.classList.toggle('zoomed', z.k > 1);
}

export function attachZoom(box, z) {
  const pts = new Map();
  let moved = false, travel = 0, lastTap = null;

  // Point relative to the SVG's untransformed top-left corner.
  const local = (cx, cy) => {
    const svg = box.querySelector('svg'), r = box.getBoundingClientRect();
    return { x: cx - r.left - (svg?.offsetLeft || 0), y: cy - r.top - (svg?.offsetTop || 0) };
  };
  const zoomAt = (p, f) => {
    const k = Math.min(MAX, Math.max(1, z.k * f));
    z.x = p.x - ((p.x - z.x) * k) / z.k;
    z.y = p.y - ((p.y - z.y) * k) / z.k;
    z.k = k;
    applyZoom(box, z);
  };
  const pair = () => {
    const [a, b] = [...pts.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  box.addEventListener('pointerdown', e => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { box.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    if (pts.size === 1) { moved = false; travel = 0; }
    else moved = true;
  });
  box.addEventListener('pointermove', e => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    if (pts.size === 2) {
      const before = pair();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const after = pair();
      z.x += after.m.x - before.m.x;
      z.y += after.m.y - before.m.y;
      if (before.d > 0) zoomAt(local(after.m.x, after.m.y), after.d / before.d);
      return;
    }
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    travel += Math.hypot(dx, dy);
    if (travel > TAP_MOVE) moved = true;
    if (!moved) return;
    if (z.k > 1) { z.x += dx; z.y += dy; applyZoom(box, z); }
    else if (e.pointerType === 'touch') scrollBy(0, -dy);
  });
  const up = e => {
    if (!pts.delete(e.pointerId) || pts.size || moved) return;
    const now = Date.now(), p = { x: e.clientX, y: e.clientY };
    if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
      lastTap = null;
      if (z.k > 1) { z.k = 1; applyZoom(box, z); }
      else zoomAt(local(p.x, p.y), 2.5);
    } else lastTap = { t: now, ...p };
  };
  box.addEventListener('pointerup', up);
  box.addEventListener('pointercancel', e => { pts.delete(e.pointerId); moved = true; });
  // A pan or pinch must not also count as a tap on a wall.
  box.addEventListener('click', e => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);
  box.addEventListener('wheel', e => {
    if (z.k === 1 && e.deltaY > 0 && !e.ctrlKey) return; // let the page scroll past an unzoomed plan
    e.preventDefault();
    zoomAt(local(e.clientX, e.clientY), Math.exp(-e.deltaY * 0.002));
  }, { passive: false });

  applyZoom(box, z);
}
