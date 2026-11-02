import { db } from './db.js';
import { geometry, renderPlan, svgToPng, fmtM, fmtArea, cornerName, normAngle, OPEN_STYLES, OPEN_STYLE_DEFAULTS, MAX_LEAVES, openStyle } from './plan.js';
import { openAnnotator, renderAnnotated, compressImage } from './annotate.js';
import { plansToDxf } from './dxf.js';
import { newZoom, applyZoom, attachZoom } from './zoom.js';

// Bump with CACHE in sw.js and add a CHANGELOG.md entry on every release.
const APP_VERSION = '1.0.2';

const $app = document.getElementById('app');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => new Date().toLocaleDateString('sv');
const fileSafe = s => String(s || 'plan').replace(/[\\/:*?"<>|]+/g, '_').trim();

const TURNS = [[90, 'เลี้ยวขวา 90°'], [-90, 'เลี้ยวซ้าย 90°'], [45, 'เลี้ยวขวา 45°'], [-45, 'เลี้ยวซ้าย 45°'], [0, 'ตรงไป (ไม่เลี้ยว)']];
const OPEN_TYPES = { door: 'ประตู', window: 'หน้าต่าง', opening: 'ช่องเปิด' };
const OPEN_DEFAULTS = {
  door: { offset: 30, width: 80, height: 200, ...OPEN_STYLE_DEFAULTS.door },
  window: { offset: 50, width: 120, height: 110, ...OPEN_STYLE_DEFAULTS.window },
};

let P = null;             // project being edited
let photos = new Map();   // photo id → record for P
let view = { name: 'home' };
let selectedWall = null;
const imgCache = new Map(); // `${photoId}@${size}` → Promise<dataURL>
const zooms = new Map();    // room id → plan zoom { k, x, y }
const zoomOf = id => zooms.get(id) || zooms.set(id, newZoom()).get(id);

// ---------- persistence ----------
let saveTimer;
function save() {
  P.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.putProject(P), 300);
}
async function flush() {
  clearTimeout(saveTimer);
  if (P) await db.putProject(P);
}
async function loadProject(id) {
  if (P?.id === id) return P;
  await flush();
  P = await db.getProject(id);
  photos = new Map();
  if (P) for (const ph of await db.photosOf(id)) photos.set(ph.id, ph);
  return P;
}

const newWall = () => ({ id: uid(), length: 300, turn: 90, note: '', openings: [] });
const curRoom = () => P?.rooms.find(r => r.id === view.roomId);
const roomPhotos = (roomId, wallId) =>
  [...photos.values()]
    .filter(p => p.roomId === roomId && (wallId === undefined || (p.wallId || null) === wallId))
    .sort((a, b) => a.createdAt - b.createdAt);
function photoCounts(room) {
  const c = {};
  for (const p of roomPhotos(room.id)) if (p.wallId) c[p.wallId] = (c[p.wallId] || 0) + 1;
  return c;
}
function photoLabel(room, p) {
  const i = room.walls.findIndex(w => w.id === p.wallId);
  return [i >= 0 ? `ผนัง ${i + 1}` : 'ภาพรวมห้อง', p.note].filter(Boolean).join(' · ');
}

// ---------- routing ----------
async function route() {
  const [a, id, b, rid] = location.hash.replace(/^#\/?/, '').split('/');
  if (a !== 'p' || !id) {
    await flush();
    P = null;
    view = { name: 'home' };
  } else {
    if (!(await loadProject(id))) { location.hash = '#/'; return; }
    if (b === 'r') {
      if (!P.rooms.some(r => r.id === rid)) { location.hash = `#/p/${id}`; return; }
      if (view.roomId !== rid) selectedWall = null;
      view = { name: 'room', roomId: rid };
    } else {
      view = { name: b === 'report' ? 'report' : 'project' };
    }
  }
  await render();
  scrollTo(0, 0);
}
function render() {
  return { home: viewHome, project: viewProject, room: viewRoom, report: viewReport }[view.name]();
}
async function rerender() {
  const y = scrollY;
  await render();
  scrollTo(0, y);
}

// ---------- small templates ----------
function field(label, key, val, type = 'text', extra = '') {
  const num = type === 'number' ? ` step="any"${extra.includes('inputmode') ? '' : ' inputmode="decimal"'}` : '';
  const input = type === 'textarea'
    ? `<textarea data-f="${key}" ${extra}>${esc(val)}</textarea>`
    : `<input type="${type}" data-f="${key}" value="${esc(val)}"${num} ${extra}>`;
  return `<label class="field"><span>${label}</span>${input}</label>`;
}
const bar = (back, title, right = '') =>
  `<header class="bar${view.name === 'report' ? ' noprint' : ''}">${back ? `<a class="back" href="${back}" aria-label="กลับ">‹</a>` : ''}<h1>${esc(title)}</h1>${right}</header>`;

function photoStrip(roomId, wallId) {
  const attrs = `data-photo-room="${roomId}" data-photo-wall="${wallId || ''}"`;
  return `<div class="photos">
    ${roomPhotos(roomId, wallId).map(p => `<button class="thumb" data-act="open-photo" data-ph="${p.id}" aria-label="เปิดรูป"><img data-img="${p.id}" alt=""></button>`).join('')}
    <label class="thumb add">📷<span>ถ่ายรูป</span><input type="file" accept="image/*" capture="environment" ${attrs} hidden></label>
    <label class="thumb add">🖼<span>คลังรูป</span><input type="file" accept="image/*" multiple ${attrs} hidden></label>
  </div>`;
}

function hydrateImages() {
  return Promise.all([...$app.querySelectorAll('img[data-img]')].map(async img => {
    const ph = photos.get(img.dataset.img);
    if (!ph) return;
    const size = +img.dataset.size || 320, key = `${ph.id}@${size}`;
    if (!imgCache.has(key)) imgCache.set(key, renderAnnotated(ph.blob, ph.annotations, size));
    img.src = await imgCache.get(key);
  }));
}
function dropCache(photoId) {
  for (const k of imgCache.keys()) if (k.startsWith(photoId + '@')) imgCache.delete(k);
}

// ---------- views ----------
async function viewHome() {
  const list = (await db.allProjects()).sort((a, b) => b.updatedAt - a.updatedAt);
  $app.innerHTML = `${bar('', 'สำรวจหน้างาน')}
  <main>
    <button class="btn primary block" data-act="new-project">+ โปรเจกต์ใหม่</button>
    ${list.length
      ? list.map(p => `<a class="card link" href="#/p/${p.id}"><b>${esc(p.name || 'ไม่มีชื่อ')}</b><small>${[p.site, `${p.rooms.length} ห้อง`, p.date].filter(Boolean).map(esc).join(' · ')}</small></a>`).join('')
      : '<p class="empty">ยังไม่มีโปรเจกต์ กดปุ่มด้านบนเพื่อเริ่มสำรวจ</p>'}
    <label class="btn ghost block">นำเข้าไฟล์สำรอง (.json)<input type="file" accept=".json,application/json" data-import hidden></label>
    <p class="hint version">เวอร์ชัน ${APP_VERSION}</p>
  </main>`;
}

function viewProject() {
  const counts = r => roomPhotos(r.id).length;
  $app.innerHTML = `${bar('#/', P.name || 'โปรเจกต์')}
  <main>
    <section class="card">
      ${field('ชื่อโปรเจกต์', 'project.name', P.name)}
      ${field('ลูกค้า', 'project.client', P.client)}
      ${field('สถานที่', 'project.site', P.site)}
      <div class="row">${field('วันที่สำรวจ', 'project.date', P.date, 'date')}${field('ผู้สำรวจ', 'project.surveyor', P.surveyor)}</div>
      ${field('หมายเหตุ', 'project.note', P.note, 'textarea')}
    </section>
    <h2>ห้อง (${P.rooms.length})</h2>
    ${P.rooms.map(r => {
      const g = geometry(r);
      return `<a class="card link room-card" href="#/p/${P.id}/r/${r.id}">
        <div class="mini">${renderPlan(r, { mini: true })}</div>
        <div><b>${esc(r.name)}</b><small>${r.walls.length} ผนัง · ${g.closed ? fmtArea(g.area) : 'ยังไม่ปิดห้อง'} · 📷 ${counts(r)}</small></div>
      </a>`;
    }).join('')}
    <section class="card">
      <h3>เพิ่มห้อง</h3>
      <label class="field"><span>ชื่อห้อง</span><input id="nr-name" placeholder="เช่น ห้องนอน 1"></label>
      <div class="row">
        <label class="field"><span>กว้าง (ซม.)</span><input id="nr-w" type="number" inputmode="decimal" step="any"></label>
        <label class="field"><span>ยาว (ซม.)</span><input id="nr-l" type="number" inputmode="decimal" step="any"></label>
      </div>
      <p class="hint">ใส่กว้าง × ยาว เพื่อสร้างห้องสี่เหลี่ยมทันที หรือเว้นว่างไว้แล้วค่อยใส่ผนังทีละด้าน</p>
      <button class="btn primary block" data-act="add-room">+ เพิ่มห้อง</button>
    </section>
    <h2>ส่งออก</h2>
    <a class="btn block" href="#/p/${P.id}/report">📄 รายงานแปลน + รูป (พิมพ์ / PDF)</a>
    <button class="btn block" data-act="export-dxf-all">📐 แปลนทุกห้องเป็น DXF (CAD)</button>
    <button class="btn block" data-act="backup">💾 สำรองโปรเจกต์เป็นไฟล์</button>
    <button class="btn ghost danger block" data-act="delete-project">ลบโปรเจกต์</button>
  </main>`;
}

function summaryParts(room) {
  const g = geometry(room);
  const h = +room.height || 0;
  const openArea = room.walls.flatMap(w => w.openings).reduce((s, o) => s + (+o.width || 0) * (+o.height || 0), 0);
  const parts = [['พื้นที่พื้น', g.closed ? fmtArea(g.area) : '–'], ['ความยาวรอบห้อง', `${fmtM(g.perimeter)} ม.`]];
  if (h) parts.push(['สูง', `${fmtM(h)} ม.`], ['พื้นที่ผนังสุทธิ', fmtArea(Math.max(0, g.perimeter * h - openArea))]);
  return { g, parts };
}
function summaryHtml(room) {
  const { g, parts } = summaryParts(room);
  let html = parts.map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
  if (room.walls.length >= 2 && g.gap >= 1) {
    html += `<div class="warn"><span>⚠ ห้องยังไม่ปิด ปลายผนังสุดท้ายห่างจากมุม A <b>${Math.round(g.gap)} ซม.</b> ถ้าห่างนิดเดียวอาจเป็นความคลาดเคลื่อนตอนวัด</span>
      <button class="btn sm" data-act="close-room">เพิ่มผนังปิดห้องให้</button></div>`;
  }
  return html;
}
const planSvg = room => renderPlan(room, { selected: selectedWall, photoCounts: photoCounts(room) });

function refreshPlan() {
  const room = curRoom();
  if (!room) return;
  const pl = document.getElementById('plan'), sm = document.getElementById('summary');
  if (pl) { pl.innerHTML = planSvg(room); applyZoom(pl, zoomOf(room.id)); }
  if (sm) sm.innerHTML = summaryHtml(room);
}

function kindRow(o, at) {
  const st = openStyle(o);
  if (!st) return '';
  const opt = (v, l, on) => `<option value="${v}"${on ? ' selected' : ''}>${l}</option>`;
  return `<div class="op-kind">
    <select data-f="op.style" ${at} aria-label="แบบบาน">${Object.entries(OPEN_STYLES[o.type]).map(([k, l]) => opt(k, l, k === st.style)).join('')}</select>
    <select data-f="op.leaves" ${at} aria-label="จำนวนบาน">${Array.from({ length: MAX_LEAVES[o.type] }, (_, i) => opt(i + 1, `${i + 1} บาน`, i + 1 === st.leaves)).join('')}</select>
  </div>`;
}

function openingRow(w, o) {
  const at = `data-w="${w.id}" data-o="${o.id}"`;
  const idx = P && curRoom().walls.indexOf(w);
  return `<div class="op">
    <select data-f="op.type" ${at} aria-label="ชนิดช่องเปิด">${Object.entries(OPEN_TYPES).map(([k, l]) => `<option value="${k}"${o.type === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <button class="icon" data-act="del-op" ${at} aria-label="ลบ">✕</button>
    ${kindRow(o, at)}
    ${field(`ห่างจากมุม ${cornerName(idx)}`, 'op.offset', o.offset, 'number', at)}
    ${field('กว้าง', 'op.width', o.width, 'number', at)}
    ${field('สูง', 'op.height', o.height, 'number', at)}
  </div>`;
}

function wallCard(room, w, i) {
  const n = room.walls.length, last = i === n - 1;
  const known = !w.customTurn && TURNS.some(([v]) => v === w.turn);
  return `<article class="card wall${selectedWall === w.id ? ' sel' : ''}" id="w-${w.id}">
    <div class="wall-head">
      <span class="badge">${i + 1}</span><b>ผนัง ${i + 1}</b>
      <small>มุม ${cornerName(i)} → ${last ? cornerName(0) : cornerName(i + 1)}</small>
      <button class="icon" data-act="del-wall" data-w="${w.id}" aria-label="ลบผนัง">✕</button>
    </div>
    <div class="row">
      ${field('ความยาว (ซม.)', 'wall.length', w.length, 'number', `data-w="${w.id}"`)}
      ${last ? '' : `<label class="field"><span>ที่มุม ${cornerName(i + 1)}</span><select data-turn="${w.id}">
        ${TURNS.map(([v, l]) => `<option value="${v}"${known && v === w.turn ? ' selected' : ''}>${l}</option>`).join('')}
        <option value="custom"${known ? '' : ' selected'}>กำหนดองศาเอง…</option></select></label>`}
    </div>
    ${!last && !known ? field('องศาที่เลี้ยว (+ ขวา / − ซ้าย)', 'wall.turn', w.turn, 'number', `data-w="${w.id}" inputmode="text"`) : ''}
    ${field('หมายเหตุผนัง', 'wall.note', w.note, 'text', `data-w="${w.id}" placeholder="เช่น ผนังปูน มีปลั๊ก 2 จุด"`)}
    ${w.openings.map(o => openingRow(w, o)).join('')}
    <div class="btns">
      <button class="btn sm" data-act="add-op" data-type="door" data-w="${w.id}">+ ประตู</button>
      <button class="btn sm" data-act="add-op" data-type="window" data-w="${w.id}">+ หน้าต่าง</button>
      <button class="btn sm" data-act="add-op" data-type="opening" data-w="${w.id}">+ ช่องเปิด</button>
    </div>
    ${photoStrip(room.id, w.id)}
  </article>`;
}

function viewRoom() {
  const room = curRoom();
  $app.innerHTML = `${bar(`#/p/${P.id}`, room.name, '<button class="btn sm" data-act="export-png">PNG</button><button class="btn sm" data-act="export-dxf">DXF</button>')}
  <main>
    <section class="plan-wrap">
      <div class="plan-box">
        <div id="plan" class="plan">${planSvg(room)}</div>
        <button class="btn sm zoom-reset" data-act="zoom-reset" aria-label="ย่อกลับ">⤢ ย่อกลับ</button>
      </div>
      <div id="summary" class="summary">${summaryHtml(room)}</div>
    </section>
    <section class="card">
      <div class="row">${field('ชื่อห้อง', 'room.name', room.name)}${field('ความสูงฝ้า (ซม.)', 'room.height', room.height, 'number')}</div>
      ${field('หมายเหตุห้อง', 'room.note', room.note, 'textarea')}
      <small>รูปภาพรวม / มุมห้อง</small>
      ${photoStrip(room.id, null)}
    </section>
    <p class="hint">ยืนในห้อง เริ่มที่มุม A แล้วไล่วัดผนังวนตามเข็มนาฬิกา (ห้องอยู่ทางขวามือ) ห้องสี่เหลี่ยมทั่วไปเลี้ยวขวา 90° ทุกมุม · แตะผนังในแปลนเพื่อไปที่ผนังนั้น</p>
    <div id="walls">${room.walls.map((w, i) => wallCard(room, w, i)).join('')}</div>
    <button class="btn primary block" data-act="add-wall">+ เพิ่มผนัง</button>
    <button class="btn ghost danger block" data-act="delete-room">ลบห้องนี้</button>
  </main>`;
  attachZoom(document.getElementById('plan'), zoomOf(room.id));
  return hydrateImages();
}

function fmtOpening(o, wallIndex) {
  const st = openStyle(o);
  const kind = st ? ` ${st.label}${st.leaves > 1 ? ` ${st.leaves} บาน` : ''}` : '';
  return `${OPEN_TYPES[o.type]}${kind} ${fmtM(o.width)}×${fmtM(o.height)} ม. (ห่างมุม ${cornerName(wallIndex)} ${fmtM(o.offset)})`;
}

function roomReport(r) {
  const { parts } = summaryParts(r);
  const n = r.walls.length;
  const list = roomPhotos(r.id);
  return `<section class="r-room">
    <h2>${esc(r.name)}</h2>
    <div class="r-plan">${renderPlan(r, { photoCounts: photoCounts(r) })}</div>
    <p class="r-sum">${parts.map(([k, v]) => `${k} <b>${v}</b>`).join(' · ')}</p>
    ${r.note ? `<p>${esc(r.note)}</p>` : ''}
    <table class="r-table"><thead><tr><th>ผนัง</th><th>ยาว (ม.)</th><th>ประตู / หน้าต่าง</th><th>หมายเหตุ</th></tr></thead><tbody>
      ${r.walls.map((w, i) => `<tr><td>${i + 1} (${cornerName(i)}→${cornerName((i + 1) % n)})</td><td>${fmtM(w.length)}</td><td>${w.openings.map(o => fmtOpening(o, i)).join('<br>') || '–'}</td><td>${esc(w.note)}</td></tr>`).join('')}
    </tbody></table>
    ${list.length ? `<div class="r-photos">${list.map(p => `<figure><img data-img="${p.id}" data-size="1100" alt=""><figcaption>${esc(photoLabel(r, p))}</figcaption></figure>`).join('')}</div>` : ''}
  </section>`;
}

function viewReport() {
  const total = P.rooms.reduce((s, r) => { const g = geometry(r); return s + (g.closed ? g.area : 0); }, 0);
  const meta = [['ลูกค้า', P.client], ['สถานที่', P.site], ['วันที่สำรวจ', P.date], ['ผู้สำรวจ', P.surveyor], ['จำนวนห้อง', P.rooms.length], ['พื้นที่พื้นรวม', fmtArea(total)]]
    .filter(([, v]) => v !== '' && v != null);
  $app.innerHTML = `${bar(`#/p/${P.id}`, 'รายงาน', '<button class="btn sm" data-act="print">พิมพ์ / PDF</button>')}
  <main class="report">
    <h1 class="r-title">${esc(P.name)}</h1>
    <dl class="r-meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${P.note ? `<p>${esc(P.note)}</p>` : ''}
    ${P.rooms.map(roomReport).join('') || '<p class="empty">ยังไม่มีห้อง</p>'}
  </main>`;
  return hydrateImages();
}

// ---------- actions ----------
function selectWall(id, scroll) {
  if (view.name !== 'room') return;
  selectedWall = id;
  refreshPlan();
  $app.querySelectorAll('.wall').forEach(c => c.classList.toggle('sel', c.id === 'w-' + id));
  if (scroll) document.getElementById('w-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeRoom(room) {
  const g = geometry(room), n = room.walls.length, last = g.segs[n - 1];
  const need = (Math.atan2(-g.end.y, -g.end.x) * 180) / Math.PI;
  room.walls[n - 1].turn = normAngle(need - last.heading);
  room.walls[n - 1].customTurn = false;
  room.walls.push({ ...newWall(), length: Math.round(g.gap), turn: normAngle(-need) });
}

async function addPhotos(files, roomId, wallId, annotateNow) {
  let last;
  for (const file of files) {
    const blob = await compressImage(file);
    last = { id: uid(), projectId: P.id, roomId, wallId, blob, annotations: [], note: '', createdAt: Date.now() };
    await db.putPhoto(last);
    photos.set(last.id, last);
  }
  save();
  await rerender();
  if (annotateNow && last) openPhoto(last.id);
}

function openPhoto(id) {
  const ph = photos.get(id);
  const room = P.rooms.find(r => r.id === ph.roomId);
  openAnnotator(ph, {
    title: room ? `${room.name} · ${photoLabel(room, { ...ph, note: '' })}` : '',
    async onSave(anns, note) {
      ph.annotations = anns;
      ph.note = note;
      await db.putPhoto(ph);
      dropCache(id);
      rerender();
    },
    async onDelete() {
      await db.deletePhoto(id);
      photos.delete(id);
      dropCache(id);
      rerender();
    },
  });
}

async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function exportPng(room) {
  const { g } = summaryParts(room);
  const svg = renderPlan(room, {
    export: true,
    photoCounts: {},
    title: `${P.name} · ${room.name}`,
    subtitle: [g.closed ? fmtArea(g.area) : '', P.date].filter(Boolean).join(' · '),
  });
  await shareOrDownload(await svgToPng(svg, 4), `${fileSafe(P.name)}-${fileSafe(room.name)}.png`);
}

function exportDxf(rooms, name) {
  const blob = new Blob([plansToDxf(rooms)], { type: 'application/dxf' });
  return shareOrDownload(blob, `${name}.dxf`);
}

const blobToDataURL = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });

async function backup() {
  await flush();
  const list = await db.photosOf(P.id);
  const data = {
    app: 'site-survey', version: 1, exportedAt: new Date().toISOString(), project: P,
    photos: await Promise.all(list.map(async ({ blob, ...rest }) => ({ ...rest, data: await blobToDataURL(blob) }))),
  };
  await shareOrDownload(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${fileSafe(P.name)}.survey.json`);
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (data?.app !== 'site-survey' || !data.project?.id) { alert('ไฟล์นี้ไม่ใช่ไฟล์สำรองของแอปนี้'); return; }
  const id = data.project.id;
  if (await db.getProject(id)) {
    if (!confirm(`มีโปรเจกต์ "${data.project.name}" อยู่แล้ว เขียนทับด้วยไฟล์นี้?`)) return;
    await db.deleteProject(id);
  }
  await db.putProject(data.project);
  for (const { data: url, ...rest } of data.photos || []) {
    await db.putPhoto({ ...rest, blob: await (await fetch(url)).blob() });
  }
  P = null;
  location.hash = `#/p/${id}`;
}

$app.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]');
  if (!t) {
    const hit = e.target.closest('[data-wall]');
    if (hit) selectWall(hit.dataset.wall, true);
    return;
  }
  const room = curRoom();
  const w = t.dataset.w && room?.walls.find(x => x.id === t.dataset.w);
  switch (t.dataset.act) {
    case 'new-project': {
      const p = { id: uid(), name: 'โปรเจกต์ใหม่', client: '', site: '', date: today(), surveyor: '', note: '', rooms: [], createdAt: Date.now(), updatedAt: Date.now() };
      await db.putProject(p);
      location.hash = `#/p/${p.id}`;
      break;
    }
    case 'add-room': {
      const name = document.getElementById('nr-name').value.trim() || `ห้อง ${P.rooms.length + 1}`;
      const W = parseFloat(document.getElementById('nr-w').value), L = parseFloat(document.getElementById('nr-l').value);
      const walls = W > 0 && L > 0 ? [W, L, W, L].map(length => ({ ...newWall(), length })) : [newWall()];
      const r = { id: uid(), name, height: '', note: '', walls };
      P.rooms.push(r);
      save();
      location.hash = `#/p/${P.id}/r/${r.id}`;
      break;
    }
    case 'delete-project':
      if (confirm(`ลบโปรเจกต์ "${P.name}" พร้อมรูปทั้งหมด? กู้คืนไม่ได้`)) {
        clearTimeout(saveTimer);
        const id = P.id;
        P = null;
        await db.deleteProject(id);
        location.hash = '#/';
      }
      break;
    case 'backup': await backup(); break;
    case 'delete-room':
      if (confirm(`ลบห้อง "${room.name}" พร้อมรูปในห้อง?`)) {
        for (const p of roomPhotos(room.id)) { await db.deletePhoto(p.id); photos.delete(p.id); }
        P.rooms = P.rooms.filter(r => r !== room);
        save();
        location.hash = `#/p/${P.id}`;
      }
      break;
    case 'add-wall': {
      const nw = newWall();
      room.walls.push(nw);
      selectedWall = nw.id;
      save();
      await rerender();
      document.getElementById('w-' + nw.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
    case 'del-wall':
      if (confirm('ลบผนังนี้? รูปของผนังจะย้ายไปอยู่ภาพรวมห้อง')) {
        room.walls = room.walls.filter(x => x !== w);
        for (const p of roomPhotos(room.id, w.id)) { p.wallId = null; await db.putPhoto(p); }
        save();
        rerender();
      }
      break;
    case 'add-op':
      w.openings.push({ id: uid(), type: t.dataset.type, offset: 30, width: 80, height: 200, ...OPEN_DEFAULTS[t.dataset.type] });
      save();
      rerender();
      break;
    case 'del-op':
      w.openings = w.openings.filter(o => o.id !== t.dataset.o);
      save();
      rerender();
      break;
    case 'close-room': closeRoom(room); save(); rerender(); break;
    case 'open-photo': openPhoto(t.dataset.ph); break;
    case 'export-png': exportPng(room); break;
    case 'zoom-reset': { const z = zoomOf(room.id); z.k = 1; applyZoom(document.getElementById('plan'), z); break; }
    case 'export-dxf': exportDxf([room], `${fileSafe(P.name)}-${fileSafe(room.name)}`); break;
    case 'export-dxf-all': exportDxf(P.rooms, fileSafe(P.name)); break;
    case 'print': print(); break;
  }
});

$app.addEventListener('input', e => {
  const el = e.target, key = el.dataset.f;
  if (!key) return;
  const [scope, prop] = key.split('.');
  const room = curRoom();
  const w = room?.walls.find(x => x.id === el.dataset.w);
  const target = { project: P, room, wall: w, op: w?.openings.find(o => o.id === el.dataset.o) }[scope];
  if (!target) return;
  target[prop] = el.type === 'number' ? (el.value === '' ? '' : parseFloat(el.value)) : el.value;
  save();
  if (prop === 'name' && (scope === 'room' || view.name === 'project')) $app.querySelector('.bar h1').textContent = el.value;
  if (scope === 'op' && prop === 'type') rerender();
  else if (view.name === 'room') refreshPlan();
});

$app.addEventListener('change', async e => {
  const el = e.target;
  if (el.dataset.turn) {
    const w = curRoom().walls.find(x => x.id === el.dataset.turn);
    if (el.value === 'custom') w.customTurn = true;
    else { w.turn = +el.value; w.customTurn = false; }
    save();
    rerender();
  } else if (el.dataset.photoRoom) {
    const files = [...el.files];
    el.value = '';
    if (files.length) await addPhotos(files, el.dataset.photoRoom, el.dataset.photoWall || null, el.hasAttribute('capture'));
  } else if (el.hasAttribute('data-import') && el.files[0]) {
    await importBackup(el.files[0]);
  }
});

$app.addEventListener('focusin', e => {
  const card = e.target.closest('.wall');
  if (card && selectedWall !== card.id.slice(2)) selectWall(card.id.slice(2), false);
});

addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
addEventListener('pagehide', flush);
navigator.storage?.persist?.();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
route();
