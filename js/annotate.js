// Photo handling: compression, drawing annotations, and the full-screen annotation editor.
// Annotation coordinates are stored normalised (0..1) so they render at any image size.

const RED = '#ff3b30';
export const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#111111', '#ffffff'];
const LIGHT = new Set(['#ffcc00', '#ffffff']);
let lastColor = RED;

export function loadImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { resolve(img); URL.revokeObjectURL(url); };
    img.onerror = e => { reject(e); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

export async function compressImage(file, max = 1600, quality = 0.85) {
  const img = await loadImg(file);
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise(resolve => c.toBlob(resolve, 'image/jpeg', quality));
}

function label(ctx, text, x, y, fs, color = RED) {
  ctx.font = `bold ${fs}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width, p = fs * 0.35;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x - w / 2 - p, y - fs * 0.7, w + 2 * p, fs * 1.4, fs * 0.3) : ctx.rect(x - w / 2 - p, y - fs * 0.7, w + 2 * p, fs * 1.4);
  ctx.fill();
  ctx.fillStyle = LIGHT.has(color) ? '#000' : '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + fs * 0.04);
}

function arrowHead(ctx, x, y, ang, size) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(ang - 0.45), y - size * Math.sin(ang - 0.45));
  ctx.lineTo(x - size * Math.cos(ang + 0.45), y - size * Math.sin(ang + 0.45));
  ctx.closePath();
  ctx.fill();
}

export function drawAnnotations(ctx, anns, W, H) {
  const lw = Math.max(2, W / 300), fs = Math.max(14, Math.round(W / 26));
  for (const a of anns) {
    const color = a.color || RED;
    ctx.lineCap = ctx.lineJoin = 'round';
    if (a.type === 'line') {
      const x1 = a.x1 * W, y1 = a.y1 * H, x2 = a.x2 * W, y2 = a.y2 * H;
      const ang = Math.atan2(y2 - y1, x2 - x1);
      ctx.strokeStyle = ctx.fillStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      arrowHead(ctx, x2, y2, ang, lw * 5);
      arrowHead(ctx, x1, y1, ang + Math.PI, lw * 5);
      if (a.text) label(ctx, a.text, (x1 + x2) / 2, (y1 + y2) / 2, fs, color);
    } else if (a.type === 'text') {
      label(ctx, a.text, a.x * W, a.y * H, fs, color);
    } else if (a.type === 'pen' && a.pts.length) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw * 1.5;
      ctx.beginPath();
      ctx.moveTo(a.pts[0][0] * W, a.pts[0][1] * H);
      for (const [x, y] of a.pts) ctx.lineTo(x * W, y * H);
      if (a.pts.length === 1) ctx.lineTo(a.pts[0][0] * W + 0.1, a.pts[0][1] * H);
      ctx.stroke();
    }
  }
}

export async function renderAnnotated(blob, anns, maxW) {
  const img = await loadImg(blob);
  const k = Math.min(1, maxW / img.naturalWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  drawAnnotations(ctx, anns || [], c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}


export async function openAnnotator(photo, { title = '', unitLabel = 'ซม.', onSave, onDelete }) {
  // A bare number gets the project's unit; anything else is kept as typed.
  const withUnit = t => (/^\d+(\.\d+)?$/.test(t.trim()) ? `${t.trim()} ${unitLabel}` : t.trim());
  const anns = structuredClone(photo.annotations || []);
  const ov = document.createElement('div');
  ov.className = 'annot';
  ov.innerHTML = `
    <div class="annot-bar">
      <button data-a="close">ปิด</button>
      <span class="annot-title"></span>
      <button data-a="save" class="primary">บันทึก</button>
    </div>
    <div class="annot-stage"><canvas></canvas></div>
    <div class="annot-tools">
      <button data-tool="line" class="on">↔ เส้นระยะ</button>
      <button data-tool="text">T ข้อความ</button>
      <button data-tool="pen">✎ ปากกา</button>
      <button data-a="undo">↶ ย้อน</button>
      <button data-a="delete" class="danger">ลบรูป</button>
    </div>
    <div class="annot-colors">${COLORS.map(c => `<button data-color="${c}" style="background:${c}" aria-label="สี ${c}"></button>`).join('')}</div>
    <input class="annot-note" placeholder="คำอธิบายรูป เช่น มุมห้องด้านหน้าต่าง">`;
  ov.querySelector('.annot-title').textContent = title;
  const markColor = () => ov.querySelectorAll('[data-color]').forEach(x => x.classList.toggle('on', x.dataset.color === lastColor));
  markColor();
  const note = ov.querySelector('.annot-note');
  note.value = photo.note || '';
  document.body.append(ov);
  document.body.classList.add('noscroll');

  const canvas = ov.querySelector('canvas'), stage = ov.querySelector('.annot-stage');
  const ctx = canvas.getContext('2d');
  const img = await loadImg(photo.blob);
  let tool = 'line', draft = null, dirty = false;

  function draw() {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    drawAnnotations(ctx, draft ? [...anns, draft] : anns, canvas.width, canvas.height);
  }
  function fit() {
    const r = stage.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const k = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    const w = Math.floor(img.naturalWidth * k), h = Math.floor(img.naturalHeight * k);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    draw();
  }
  fit();
  addEventListener('resize', fit);

  const pos = e => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  // In-app text box instead of window.prompt(): a native dialog opened mid-gesture
  // leaves the touch stuck on Android Chrome and the editor stops responding.
  function ask(label) {
    return new Promise(resolve => {
      const box = document.createElement('form');
      box.className = 'annot-ask';
      box.innerHTML = `<div><label></label><input enterkeyhint="done">
        <p><button type="button">ยกเลิก</button><button type="submit" class="primary">ตกลง</button></p></div>`;
      box.querySelector('label').textContent = label;
      const input = box.querySelector('input');
      const done = v => { box.remove(); resolve(v); };
      box.addEventListener('submit', e => { e.preventDefault(); done(input.value); });
      box.querySelector('button[type=button]').addEventListener('click', () => done(null));
      ov.append(box);
      input.focus();
    });
  }

  let busy = false, start = null;
  canvas.addEventListener('pointerdown', e => {
    if (busy || draft || !e.isPrimary) return;
    const p = pos(e);
    canvas.setPointerCapture(e.pointerId);
    if (tool === 'line') draft = { type: 'line', color: lastColor, x1: p.x, y1: p.y, x2: p.x, y2: p.y, text: '' };
    else if (tool === 'pen') draft = { type: 'pen', color: lastColor, pts: [[p.x, p.y]] };
    else start = p;
  });
  canvas.addEventListener('pointermove', e => {
    if (!draft) return;
    const p = pos(e);
    if (draft.type === 'line') {
      draft.x2 = p.x;
      draft.y2 = p.y;
    } else {
      const [lx, ly] = draft.pts[draft.pts.length - 1], r = canvas.getBoundingClientRect();
      if (Math.hypot((p.x - lx) * r.width, (p.y - ly) * r.height) < 2) return;
      draft.pts.push([+p.x.toFixed(4), +p.y.toFixed(4)]);
    }
    draw();
  });
  const finish = async () => {
    const d = draft, s = start;
    draft = start = null;
    if (d?.type === 'pen') {
      anns.push(d); dirty = true; draw();
      return;
    }
    busy = true;
    if (s) {
      const t = await ask('ข้อความ');
      if (t?.trim()) { anns.push({ type: 'text', color: lastColor, x: s.x, y: s.y, text: withUnit(t) }); dirty = true; }
    } else if (d) {
      const r = canvas.getBoundingClientRect();
      if (Math.hypot((d.x2 - d.x1) * r.width, (d.y2 - d.y1) * r.height) > 14) {
        anns.push(d); draw();
        const t = await ask(`ระยะ (${unitLabel})`);
        if (t === null) anns.pop();
        else { d.text = withUnit(t); dirty = true; }
      }
    }
    busy = false;
    draw();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', () => { draft = start = null; draw(); });

  function close() {
    removeEventListener('resize', fit);
    ov.remove();
    document.body.classList.remove('noscroll');
  }
  ov.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.color) {
      lastColor = b.dataset.color;
      markColor();
    } else if (b.dataset.tool) {
      tool = b.dataset.tool;
      ov.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x === b));
    } else if (b.dataset.a === 'undo') {
      anns.pop(); dirty = true; draw();
    } else if (b.dataset.a === 'save') {
      close(); onSave(anns, note.value);
    } else if (b.dataset.a === 'close') {
      if (!(dirty || note.value !== (photo.note || '')) || confirm('ยังไม่ได้บันทึก ปิดเลยไหม?')) close();
    } else if (b.dataset.a === 'delete') {
      if (confirm('ลบรูปนี้?')) { close(); onDelete(); }
    }
  });
}
