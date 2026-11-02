import { db } from './db.js';
import { geometry, renderPlan, svgToPng, fmtM, fmtArea, fmtLen, UNITS, unitOf, toUnit, fromUnit, cornerName, normAngle, OPEN_STYLES, OPEN_STYLE_DEFAULTS, MAX_LEAVES, openStyle, openingTags, SHAPE_TYPES, shapePoints } from './plan.js';
import { openAnnotator, renderAnnotated, compressImage } from './annotate.js';
import { plansToDxf } from './dxf.js';
import { newZoom, applyZoom, attachZoom } from './zoom.js';
import { attachPlanTools } from './tools.js';

// Bump with CACHE in sw.js and add a CHANGELOG.md entry on every release.
const APP_VERSION = '1.0.9';

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
let selectedOp = null;    // door/window/column/shape picked in the plan, highlighted in the form
let planTool = null;      // 'edit' | 'wall' | 'line' | 'rect' | 'circle' while working on the plan
let preview = {};         // { draft, draftWall, snapAt } shown while a plan drag is under way
let snapOn = true;
try { snapOn = localStorage.getItem('plan-snap') !== '0'; } catch { /* storage unavailable */ }
// Wall list shows one line per wall, with only the selected wall opened up. Kept per device.
let wallsCollapsed = false;
try { wallsCollapsed = localStorage.getItem('walls-collapsed') === '1'; } catch { /* storage unavailable */ }
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
// A length stored in cm, shown and typed in the project's unit.
const unitLabel = () => UNITS[unitOf(P?.unit)].label;
const lenField = (label, key, cm, extra = '') => field(`${label} (${unitLabel()})`, key, toUnit(cm, P?.unit), 'number', `data-len ${extra}`);
const UNIT_NAMES = { mm: 'มิลลิเมตร (มม.)', cm: 'เซนติเมตร (ซม.)', m: 'เมตร (ม.)' };
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
      ${lenField('ความหนาผนังสำหรับ DXF', 'project.wallThickness', P.wallThickness ?? 10, 'placeholder="10 ซม."')}
      <label class="field"><span>หน่วยวัดระยะ (ใช้กรอกและแสดงในแปลน)</span><select data-f="project.unit">
        ${Object.entries(UNIT_NAMES).map(([k, l]) => `<option value="${k}"${unitOf(P.unit) === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
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
        <label class="field"><span>กว้าง (${unitLabel()})</span><input id="nr-w" type="number" inputmode="decimal" step="any"></label>
        <label class="field"><span>ยาว (${unitLabel()})</span><input id="nr-l" type="number" inputmode="decimal" step="any"></label>
      </div>
      <p class="hint">ใส่กว้าง × ยาว เพื่อสร้างห้องสี่เหลี่ยมทันที หรือเว้นว่างไว้แล้วค่อยใส่ผนังทีละด้าน</p>
      <button class="btn primary block" data-act="add-room">+ เพิ่มห้อง</button>
    </section>
    <h2>ส่งออก</h2>
    <a class="btn block" href="#/p/${P.id}/report">📄 รายงานแปลน + รูป (พิมพ์ / PDF)</a>
    <button class="btn block" data-act="export-dxf-all">📐 แปลนทุกห้องเป็น DXF (CAD)</button>
    <button class="btn block" data-act="upload">☁️ อัปโหลดเข้า server (DATA)</button>
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
    html += `<div class="warn"><span>⚠ ห้องยังไม่ปิด ปลายผนังสุดท้ายห่างจากมุม A <b>${fmtLen(g.gap, P.unit)} ${unitLabel()}</b> ถ้าห่างนิดเดียวอาจเป็นความคลาดเคลื่อนตอนวัด</span>
      <button class="btn sm" data-act="close-room">เพิ่มผนังปิดห้องให้</button></div>`;
  }
  return html;
}
const planSvg = room => renderPlan(room, { selected: selectedWall, selectedOp, ...preview, editing: !!planTool, handles: planTool === 'edit' ? handlesFor(room) : null, photoCounts: photoCounts(room), unit: P.unit, zoom: zoomOf(room.id).k });

function refreshPlan() {
  const room = curRoom();
  if (!room) return;
  const pl = document.getElementById('plan'), sm = document.getElementById('summary');
  if (pl) { pl.innerHTML = planSvg(room); applyZoom(pl, zoomOf(room.id)); }
  if (sm) sm.innerHTML = summaryHtml(room);
}

function kindRow(o, at, autoTag) {
  const st = openStyle(o);
  if (!st) return '';
  const opt = (v, l, on) => `<option value="${v}"${on ? ' selected' : ''}>${l}</option>`;
  return `<div class="op-kind">
    <input class="op-tag" data-f="op.tag" ${at} value="${esc(o.tag || '')}" placeholder="${esc(autoTag)}" aria-label="ชื่อ เช่น D1">
    <select data-f="op.style" ${at} aria-label="แบบบาน">${Object.entries(OPEN_STYLES[o.type]).map(([k, l]) => opt(k, l, k === st.style)).join('')}</select>
    <select data-f="op.leaves" ${at} aria-label="จำนวนบาน">${Array.from({ length: MAX_LEAVES[o.type] }, (_, i) => opt(i + 1, `${i + 1} บาน`, i + 1 === st.leaves)).join('')}</select>
    ${o.type === 'door' && st.style === 'swing' ? `<select data-f="op.swing" ${at} aria-label="ทิศเปิด">${opt('in', 'เปิดเข้า', o.swing !== 'out')}${opt('out', 'เปิดออก', o.swing === 'out')}</select>` : ''}
  </div>`;
}

function columnRow(w, c) {
  const at = `data-w="${w.id}" data-c="${c.id}"`;
  const idx = P && curRoom().walls.indexOf(w);
  const round = c.shape === 'round';
  return `<div class="op col${selectedOp === c.id ? ' picked' : ''}" id="op-${c.id}">
    <select data-f="col.shape" ${at} aria-label="รูปเสา"><option value="rect"${round ? '' : ' selected'}>เสาเหลี่ยม</option><option value="round"${round ? ' selected' : ''}>เสากลม</option></select>
    <button class="icon" data-act="del-col" ${at} aria-label="ลบเสา">✕</button>
    <div class="col-f">
      ${lenField(`ห่างมุม ${cornerName(idx)}`, 'col.offset', c.offset, at)}
      ${lenField('ห่างจากผนัง', 'col.gap', c.gap, at)}
      ${lenField(round ? 'เส้นผ่านศูนย์กลาง' : 'กว้างตามผนัง', 'col.width', c.width, at)}
      ${round ? '' : lenField('ลึกเข้าห้อง', 'col.depth', c.depth, at)}
    </div>
  </div>`;
}

// A door/window can be placed from the corner or from the far edge of an earlier opening on the
// same wall (`ref` + `refGap`); its absolute `offset` is then kept in step by resolveRefs().
function resolveRefs(w) {
  w.openings.forEach((o, i) => {
    if (!o.ref) return;
    const r = w.openings.slice(0, i).find(x => x.id === o.ref);
    if (!r) { delete o.ref; delete o.refGap; return; }
    o.offset = Math.round(((+r.offset || 0) + (+r.width || 0) + (+o.refGap || 0)) * 10) / 10;
  });
}
const opName = (tags, o) => tags.get(o.id) || OPEN_TYPES[o.type];

function openingRow(w, o) {
  const at = `data-w="${w.id}" data-o="${o.id}"`;
  const idx = P && curRoom().walls.indexOf(w);
  const tags = openingTags(curRoom()), before = w.openings.slice(0, w.openings.indexOf(o));
  const ref = o.ref && before.find(x => x.id === o.ref);
  return `<div class="op${selectedOp === o.id ? ' picked' : ''}" id="op-${o.id}">
    <select data-f="op.type" ${at} aria-label="ชนิดช่องเปิด">${Object.entries(OPEN_TYPES).map(([k, l]) => `<option value="${k}"${o.type === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <button class="icon" data-act="del-op" ${at} aria-label="ลบ">✕</button>
    ${kindRow(o, at, tags.get(o.id) || '')}
    ${before.length ? `<label class="field op-ref"><span>วัดระยะจาก</span><select data-f="op.ref" ${at}>
      <option value="">มุม ${cornerName(idx)}</option>
      ${before.map(x => `<option value="${x.id}"${ref === x ? ' selected' : ''}>ขอบหลัง ${esc(opName(tags, x))}</option>`).join('')}</select></label>` : ''}
    ${ref ? lenField(`ห่างจาก ${esc(opName(tags, ref))}`, 'op.refGap', o.refGap, at) : lenField(`ห่างมุม ${cornerName(idx)}`, 'op.offset', o.offset, at)}
    ${lenField('กว้าง', 'op.width', o.width, at)}
    ${lenField('สูง', 'op.height', o.height, at)}
  </div>`;
}

// One-line summary of a wall for the collapsed list: length, curve, tags, columns, photos.
function wallSummary(room, w) {
  const tags = openingTags(room);
  return [
    `${fmtLen(w.length, P.unit)} ${unitLabel()}`,
    +w.bulge ? '⌒ โค้ง' : '',
    w.openings.map(o => tags.get(o.id) || OPEN_TYPES[o.type]).join(' '),
    w.columns?.length ? `เสา ${w.columns.length}` : '',
    roomPhotos(room.id, w.id).length ? `📷${roomPhotos(room.id, w.id).length}` : '',
  ].filter(Boolean).join(' · ');
}

function wallCard(room, w, i) {
  const n = room.walls.length, last = i === n - 1;
  const known = !w.customTurn && TURNS.some(([v]) => v === w.turn);
  const corners = `มุม ${cornerName(i)} → ${last ? cornerName(0) : cornerName(i + 1)}`;
  if (wallsCollapsed && selectedWall !== w.id) {
    return `<article class="card wall mini-wall" id="w-${w.id}">
      <button class="wall-head wall-open" data-act="open-wall" data-w="${w.id}">
        <span class="badge">${i + 1}</span><b>ผนัง ${i + 1}</b><small>${esc(wallSummary(room, w))}</small><span class="chev">›</span>
      </button>
    </article>`;
  }
  const curved = w.bulge !== undefined && w.bulge !== null;
  return `<article class="card wall${selectedWall === w.id ? ' sel' : ''}" id="w-${w.id}">
    <div class="wall-head">
      <span class="badge">${i + 1}</span><b>ผนัง ${i + 1}</b>
      <small>${corners}</small>
      <button class="icon" data-act="del-wall" data-w="${w.id}" aria-label="ลบผนัง">✕</button>
    </div>
    <div class="row">
      ${lenField('ความยาว', 'wall.length', w.length, `data-w="${w.id}"`)}
      ${last ? '' : `<label class="field"><span>ที่มุม ${cornerName(i + 1)}</span><select data-turn="${w.id}">
        ${TURNS.map(([v, l]) => `<option value="${v}"${known && v === w.turn ? ' selected' : ''}>${l}</option>`).join('')}
        <option value="custom"${known ? '' : ' selected'}>กำหนดองศาเอง…</option></select></label>`}
    </div>
    ${!last && !known ? field('องศาที่เลี้ยว (+ ขวา / − ซ้าย)', 'wall.turn', w.turn, 'number', `data-w="${w.id}" inputmode="text"`) : ''}
    ${curved ? `<div class="row bulge">${lenField('ระยะโค้ง (+ ออก / − เข้าห้อง)', 'wall.bulge', w.bulge, `data-w="${w.id}" inputmode="text"`)}
      <button class="icon" data-act="del-bulge" data-w="${w.id}" aria-label="เลิกโค้ง">✕</button></div>
      <p class="hint">วัดจากกึ่งกลางเส้นตรงมุมถึงมุม ไปถึงผนัง · ความยาวด้านบนคือระยะตรงมุมถึงมุม</p>` : ''}
    ${field('หมายเหตุผนัง', 'wall.note', w.note, 'text', `data-w="${w.id}" placeholder="เช่น ผนังปูน มีปลั๊ก 2 จุด"`)}
    ${w.openings.map(o => openingRow(w, o)).join('')}
    ${(w.columns || []).map(c => columnRow(w, c)).join('')}
    <div class="btns">
      <button class="btn sm" data-act="add-op" data-type="door" data-w="${w.id}">+ ประตู</button>
      <button class="btn sm" data-act="add-op" data-type="window" data-w="${w.id}">+ หน้าต่าง</button>
      <button class="btn sm" data-act="add-op" data-type="opening" data-w="${w.id}">+ ช่องเปิด</button>
      <button class="btn sm" data-act="add-col" data-w="${w.id}">+ เสา</button>
    </div>
    <div class="btns">
      ${curved ? '' : `<button class="btn sm ghost" data-act="add-bulge" data-w="${w.id}">⌒ ผนังโค้ง</button>`}
      <button class="btn sm ghost" data-act="split-wall" data-w="${w.id}">✂ แบ่งครึ่ง</button>
      <button class="btn sm ghost" data-act="insert-wall" data-w="${w.id}">⤵ แทรกผนังต่อจากนี้</button>
    </div>
    ${photoStrip(room.id, w.id)}
  </article>`;
}

// ---------- shapes drawn into the plan ----------
const shapeName = sh => (sh.label ? `${sh.label} (${SHAPE_TYPES[sh.type]})` : SHAPE_TYPES[sh.type]);
const SHAPE_FIELDS = {
  line: [['x1', 'x เริ่ม'], ['y1', 'y เริ่ม'], ['x2', 'x ปลาย'], ['y2', 'y ปลาย']],
  rect: [['x', 'x มุมบนซ้าย'], ['y', 'y มุมบนซ้าย'], ['w', 'กว้างแนว x'], ['h', 'ลึกแนว y']],
  circle: [['x', 'x จุดศูนย์กลาง'], ['y', 'y จุดศูนย์กลาง'], ['d', 'เส้นผ่านศูนย์กลาง']],
};

function shapesCard(room) {
  const list = room.shapes || [];
  return `<section class="card shapes">
    <h3>สิ่งของในแปลน <small>เคาน์เตอร์ ตู้ บิวท์อิน ฯลฯ</small></h3>
    ${list.length ? '<p class="hint">x, y วัดจากมุม A — ไปทางขวาเป็น +x ลงล่างเป็น +y</p>' : '<p class="hint">กด "✏️ วาดในแปลน" ใต้แปลนแล้วลากนิ้ว หรือเพิ่มจากปุ่มด้านล่างแล้วกรอกขนาด</p>'}
    ${list.map(sh => {
      const at = `data-s="${sh.id}"`;
      return `<div class="op shape${selectedOp === sh.id ? ' picked' : ''}" id="op-${sh.id}">
        <input data-f="shape.label" ${at} value="${esc(sh.label || '')}" placeholder="ชื่อ เช่น เคาน์เตอร์ (${SHAPE_TYPES[sh.type]})">
        <button class="icon" data-act="del-shape" ${at} aria-label="ลบ">✕</button>
        <div class="col-f">${SHAPE_FIELDS[sh.type].map(([k, l]) => lenField(l, `shape.${k}`, sh[k], `${at} inputmode="text"`)).join('')}</div>
      </div>`;
    }).join('')}
    <div class="btns">${Object.entries(SHAPE_TYPES).map(([k, l]) => `<button class="btn sm" data-act="add-shape" data-type="${k}">+ ${l}</button>`).join('')}</div>
  </section>`;
}

const snap = v => Math.round(v / 5) * 5; // drawn shapes snap to 5 cm

// Handles shown in edit mode: the far end of the selected wall, and the selected shape's grips.
function handlesFor(room) {
  const out = [];
  const sh = room.shapes?.find(x => x.id === selectedOp);
  if (sh) {
    const [a, b] = shapePoints(sh);
    if (sh.type === 'rect') [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }].forEach((p, k) => out.push({ ...p, id: `rect-${k}`, for: sh.id }));
    else if (sh.type === 'circle') out.push({ x: (+sh.x || 0) + (+sh.d || 0) / 2, y: +sh.y || 0, id: 'circle-r', for: sh.id });
    else out.push({ ...a, id: 'line-1', for: sh.id }, { ...b, id: 'line-2', for: sh.id });
  }
  const sg = geometry(room).segs.find(x => x.wall.id === selectedWall);
  if (sg && !sh) out.push({ ...sg.p1, id: 'wall-end', for: sg.wall.id });
  return out;
}

const PLAN_TOOLS = { edit: '✋ ย้าย/ยืด', wall: '🧱 ผนัง', line: '╱ เส้น', rect: '▭ สี่เหลี่ยม', circle: '◯ วงกลม' };

function drawBar() {
  if (!planTool) return '<button class="btn sm" data-act="tool" data-tool="edit">✏️ แก้ไข / วาดในแปลน</button>';
  return `${Object.entries(PLAN_TOOLS).map(([k, l]) => `<button class="btn sm${planTool === k ? ' on' : ''}" data-act="tool" data-tool="${k}">${l}</button>`).join('')}
    <button class="btn sm${snapOn ? ' on' : ''}" data-act="snap" aria-pressed="${snapOn}">🧲 Snap</button>
    <button class="btn sm primary" data-act="tool-off">เสร็จ</button>
    <small class="tool-hint">${{
      edit: 'ลากประตู หน้าต่าง เสา หรือสิ่งของเพื่อย้าย · แตะผนังแล้วลากจุดปลายเพื่อยืด/หมุน',
      wall: 'แตะหรือลากไปจุดที่ผนังสิ้นสุด ผนังใหม่จะต่อจากปลายผนังล่าสุด · ลากกลับมาที่มุม A เพื่อปิดห้อง',
    }[planTool] || 'ลากในแปลนเพื่อวาด'}</small>`;
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
      <div class="draw-bar">${drawBar()}</div>
      <div id="summary" class="summary">${summaryHtml(room)}</div>
    </section>
    <section class="card">
      <div class="row">${field('ชื่อห้อง', 'room.name', room.name)}${lenField('ความสูงฝ้า', 'room.height', room.height)}</div>
      ${field('หมายเหตุห้อง', 'room.note', room.note, 'textarea')}
      <small>รูปภาพรวม / มุมห้อง</small>
      ${photoStrip(room.id, null)}
    </section>
    <p class="hint">ยืนในห้อง เริ่มที่มุม A แล้วไล่วัดผนังวนตามเข็มนาฬิกา (ห้องอยู่ทางขวามือ) ห้องสี่เหลี่ยมทั่วไปเลี้ยวขวา 90° ทุกมุม · แตะผนังในแปลนเพื่อไปที่ผนังนั้น</p>
    <div class="walls-bar"><b>ผนัง ${room.walls.length} ด้าน</b>
      <button class="btn sm" data-act="toggle-walls">${wallsCollapsed ? '☰ แสดงทั้งหมด' : '≡ ย่อทั้งหมด'}</button></div>
    <div id="walls">${room.walls.map((w, i) => wallCard(room, w, i)).join('')}</div>
    <button class="btn primary block" data-act="add-wall">+ เพิ่มผนัง</button>
    ${shapesCard(room)}
    <button class="btn ghost danger block" data-act="delete-room">ลบห้องนี้</button>
  </main>`;
  const box = document.getElementById('plan');
  const busy = attachPlanTools(box, {
    room,
    tool: () => planTool,
    snap: () => snapOn,
    uid,
    newWall: extra => ({ ...newWall(), ...extra }),
    resolveRefs,
    preview(p) { preview = p; refreshPlan(); },
    async done(id, kind) {
      preview = {};
      if (kind === 'wall') selectedWall = id;
      else if (id) selectedOp = id;
      save();
      await rerender();
    },
  });
  attachZoom(box, zoomOf(room.id), refreshPlan, () => busy() || (!!planTool && planTool !== 'edit'));
  return hydrateImages();
}

function fmtOpening(o, wallIndex) {
  const st = openStyle(o);
  const kind = st ? ` ${st.label}${st.leaves > 1 ? ` ${st.leaves} บาน` : ''}${o.type === 'door' && st.style === 'swing' && o.swing === 'out' ? ' เปิดออก' : ''}` : '';
  const tag = openingTags(curRoomOf(o)).get(o.id);
  return `${tag ? `${esc(tag)} ` : ''}${OPEN_TYPES[o.type]}${kind} ${fmtLen(o.width, P.unit)}×${fmtLen(o.height, P.unit)} ${unitLabel()} (ห่างมุม ${cornerName(wallIndex)} ${fmtLen(o.offset, P.unit)})`;
}

// Room holding an opening, for its tag in the report (which lists every room).
const curRoomOf = o => P.rooms.find(r => r.walls.some(w => w.openings.includes(o)));

function fmtColumn(c, wallIndex) {
  const u = P.unit;
  return `${c.shape === 'round' ? `เสากลม Ø${fmtLen(c.width, u)}` : `เสา ${fmtLen(c.width, u)}×${fmtLen(c.depth, u)}`} ${unitLabel()} (ห่างมุม ${cornerName(wallIndex)} ${fmtLen(c.offset, u)}${+c.gap ? `, ห่างผนัง ${fmtLen(c.gap, u)}` : ''})`;
}

function roomReport(r) {
  const { parts } = summaryParts(r);
  const n = r.walls.length;
  const list = roomPhotos(r.id);
  return `<section class="r-room">
    <h2>${esc(r.name)}</h2>
    <div class="r-plan">${renderPlan(r, { photoCounts: photoCounts(r), unit: P.unit })}</div>
    <p class="r-sum">${parts.map(([k, v]) => `${k} <b>${v}</b>`).join(' · ')}</p>
    ${r.shapes?.length ? `<p>สิ่งของ: ${r.shapes.map(sh => esc(shapeName(sh)) + (sh.type === 'rect' ? ` ${fmtLen(sh.w, P.unit)}×${fmtLen(sh.h, P.unit)}` : sh.type === 'circle' ? ` Ø${fmtLen(sh.d, P.unit)}` : '')).join(', ')} ${unitLabel()}</p>` : ''}
    ${r.note ? `<p>${esc(r.note)}</p>` : ''}
    <table class="r-table"><thead><tr><th>ผนัง</th><th>ยาว (${unitLabel()})</th><th>ประตู / หน้าต่าง / เสา</th><th>หมายเหตุ</th></tr></thead><tbody>
      ${r.walls.map((w, i) => `<tr><td>${i + 1} (${cornerName(i)}→${cornerName((i + 1) % n)})</td><td>${fmtLen(w.length, P.unit)}${+w.bulge ? `<br><small>โค้ง ${fmtLen(w.bulge, P.unit)}</small>` : ''}</td><td>${[...w.openings.map(o => fmtOpening(o, i)), ...(w.columns || []).map(c => fmtColumn(c, i))].join('<br>') || '–'}</td><td>${esc(w.note)}</td></tr>`).join('')}
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
// soft: just move the highlight (used while typing in a card, where a redraw would steal focus).
async function selectWall(id, scroll, opId = null, soft = false) {
  if (view.name !== 'room') return;
  // A tap focuses the collapsed card's button before its click, so check the card, not selectedWall.
  const reopen = !soft && wallsCollapsed && !!document.getElementById('w-' + id)?.classList.contains('mini-wall');
  const repick = !soft && selectedOp !== opId;
  if (soft) $app.querySelectorAll('.op.picked').forEach(x => x.classList.remove('picked'));
  selectedWall = id;
  selectedOp = opId;
  if (reopen || repick) await rerender();
  else refreshPlan();
  $app.querySelectorAll('.wall').forEach(c => c.classList.toggle('sel', c.id === 'w-' + id));
  const target = opId && document.getElementById('op-' + opId);
  if (target && scroll) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  else if (scroll) document.getElementById('w-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    unitLabel: unitLabel(),
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

function planPng(room) {
  const { g } = summaryParts(room);
  const svg = renderPlan(room, {
    export: true,
    unit: P.unit,
    photoCounts: {},
    title: `${P.name} · ${room.name}`,
    subtitle: [g.closed ? fmtArea(g.area) : '', P.date].filter(Boolean).join(' · '),
  });
  return svgToPng(svg, 4);
}

async function exportPng(room) {
  await shareOrDownload(await planPng(room), `${fileSafe(P.name)}-${fileSafe(room.name)}.png`);
}

const dxfBlob = rooms => new Blob([plansToDxf(rooms, { unit: P.unit, wallThickness: P.wallThickness })], { type: 'application/dxf' });

function exportDxf(rooms, name) {
  return shareOrDownload(dxfBlob(rooms), `${name}.dxf`);
}

const blobToDataURL = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });

async function backupBlob() {
  await flush();
  const list = await db.photosOf(P.id);
  const data = {
    app: 'site-survey', version: 1, exportedAt: new Date().toISOString(), project: P,
    photos: await Promise.all(list.map(async ({ blob, ...rest }) => ({ ...rest, data: await blobToDataURL(blob) }))),
  };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

async function backup() {
  await shareOrDownload(await backupBlob(), `${fileSafe(P.name)}.survey.json`);
}

// ---------- upload to the office server (server.py) ----------
// Everything about the project goes to DATA/<survey date>/<project>/ on the server:
// the backup .json, a DXF of all rooms, and per room its plan (PNG + DXF) and photos,
// with a second copy of each annotated photo that has its lines drawn in.
const seg = s => fileSafe(s).replace(/^\.+/, '') || '_';

async function uploadProject(btn) {
  try {
    const r = await fetch('api/ping', { cache: 'no-store' });
    if (!(await r.json()).ok) throw new Error();
  } catch {
    alert('ที่อยู่นี้ไม่มีระบบอัปโหลด ต้องเปิดแอปผ่าน server ของ office (server.py) เช่นผ่าน Tailscale');
    return;
  }
  const base = `${seg(P.date || today())}/${seg(P.name)}`;
  const files = [
    [`${seg(P.name)}.survey.json`, backupBlob],
    [`${seg(P.name)} ทุกห้อง.dxf`, () => dxfBlob(P.rooms)],
  ];
  const used = new Set();
  for (const room of P.rooms) {
    let dir = seg(room.name);
    for (let k = 2; used.has(dir); k++) dir = `${seg(room.name)} (${k})`;
    used.add(dir);
    files.push([`${dir}/แปลน.png`, () => planPng(room)], [`${dir}/แปลน.dxf`, () => dxfBlob([room])]);
    roomPhotos(room.id).forEach((p, i) => {
      const name = `${dir}/รูป/${String(i + 1).padStart(2, '0')} ${seg(photoLabel(room, p))}`;
      files.push([`${name}.jpg`, () => p.blob]);
      if (p.annotations?.length) files.push([`${name} (มีเส้นระยะ).jpg`, async () => (await fetch(await renderAnnotated(p.blob, p.annotations, 4000))).blob()]);
    });
  }

  const label = btn.textContent;
  btn.disabled = true;
  try {
    for (const [k, [path, make]] of files.entries()) {
      btn.textContent = `กำลังอัปโหลด ${k + 1}/${files.length}…`;
      const res = await fetch(`api/upload?path=${encodeURIComponent(`${base}/${path}`)}`, { method: 'PUT', body: await make() });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    }
    alert(`อัปโหลดแล้ว ${files.length} ไฟล์\nไปที่ DATA/${base}`);
  } catch (e) {
    alert(`อัปโหลดไม่สำเร็จ (${e.message || e}) ลองใหม่อีกครั้ง ไฟล์ที่ขึ้นไปแล้วจะถูกเขียนทับ`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
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
    const sh = e.target.closest('[data-shape]');
    if (sh && (!planTool || planTool === 'edit')) {
      selectedOp = sh.dataset.shape;
      await rerender();
      document.getElementById('op-' + selectedOp)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const hit = e.target.closest('[data-wall]');
    // While editing on the plan, picking something keeps the page where it is.
    if (hit) selectWall(hit.dataset.wall, !planTool, hit.dataset.op || hit.dataset.col || null);
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
      const W = fromUnit(parseFloat(document.getElementById('nr-w').value), P.unit), L = fromUnit(parseFloat(document.getElementById('nr-l').value), P.unit);
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
    case 'upload': await uploadProject(t); break;
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
    case 'add-op': {
      // A second door/window is measured on from the last one by default.
      const last = w.openings.at(-1);
      w.openings.push({ id: uid(), type: t.dataset.type, offset: 30, width: 80, height: 200, ...OPEN_DEFAULTS[t.dataset.type], ...(last ? { ref: last.id, refGap: 50 } : {}) });
      resolveRefs(w);
      save();
      rerender();
      break;
    }
    case 'open-wall': await selectWall(w.id, true); break;
    case 'tool': planTool = t.dataset.tool; preview = {}; await rerender(); break;
    case 'tool-off': planTool = null; preview = {}; await rerender(); break;
    case 'snap':
      snapOn = !snapOn;
      try { localStorage.setItem('plan-snap', snapOn ? '1' : '0'); } catch { /* storage unavailable */ }
      await rerender();
      break;
    case 'add-shape': {
      // Dropped in the middle of the room at a typical size, then typed in exactly.
      const g = geometry(room), xs = g.extent.map(p => p.x), ys = g.extent.map(p => p.y);
      const cx = snap((Math.min(...xs) + Math.max(...xs)) / 2), cy = snap((Math.min(...ys) + Math.max(...ys)) / 2);
      const base = { line: { x1: cx - 50, y1: cy, x2: cx + 50, y2: cy }, rect: { x: cx - 100, y: cy - 30, w: 200, h: 60 }, circle: { x: cx, y: cy, d: 60 } }[t.dataset.type];
      (room.shapes ||= []).push({ id: uid(), type: t.dataset.type, label: '', ...base });
      selectedOp = room.shapes.at(-1).id;
      save();
      await rerender();
      document.getElementById('op-' + selectedOp)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      break;
    }
    case 'del-shape':
      room.shapes = (room.shapes || []).filter(x => x.id !== t.dataset.s);
      save();
      rerender();
      break;
    case 'toggle-walls':
      wallsCollapsed = !wallsCollapsed;
      try { localStorage.setItem('walls-collapsed', wallsCollapsed ? '1' : '0'); } catch { /* storage unavailable */ }
      await rerender();
      break;
    case 'add-bulge': w.bulge = Math.round((+w.length || 100) / 10); save(); rerender(); break;
    case 'del-bulge': delete w.bulge; save(); rerender(); break;
    case 'insert-wall': {
      // The new wall starts where this one ends and runs straight on; adjust its length and turn.
      const nw = { ...newWall(), length: 100, turn: 0 };
      room.walls.splice(room.walls.indexOf(w) + 1, 0, nw);
      selectedWall = nw.id;
      save();
      await rerender();
      document.getElementById('w-' + nw.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
    case 'split-wall': {
      if (+w.bulge) { alert('ผนังโค้งแบ่งไม่ได้ ให้เลิกโค้งก่อน'); break; }
      // Two straight halves; doors, windows and columns past the middle move to the second half.
      const L = +w.length || 0, h = Math.round(L * 5) / 10;
      const second = { ...newWall(), length: Math.round((L - h) * 10) / 10, turn: w.turn, customTurn: w.customTurn };
      second.openings = w.openings.filter(o => +o.offset >= h).map(o => ({ ...o, offset: +o.offset - h }));
      second.columns = (w.columns || []).filter(c => +c.offset >= h).map(c => ({ ...c, offset: +c.offset - h }));
      w.openings = w.openings.filter(o => +o.offset < h);
      w.columns = (w.columns || []).filter(c => +c.offset < h);
      w.length = h;
      w.turn = 0;
      w.customTurn = false;
      room.walls.splice(room.walls.indexOf(w) + 1, 0, second);
      resolveRefs(w);
      resolveRefs(second);
      save();
      await rerender();
      break;
    }
    case 'add-col':
      (w.columns ||= []).push({ id: uid(), offset: 0, gap: 0, width: 20, depth: 20 });
      save();
      rerender();
      break;
    case 'del-col':
      w.columns = (w.columns || []).filter(c => c.id !== t.dataset.c);
      save();
      rerender();
      break;
    case 'del-op':
      w.openings = w.openings.filter(o => o.id !== t.dataset.o);
      resolveRefs(w);
      save();
      rerender();
      break;
    case 'close-room': closeRoom(room); save(); rerender(); break;
    case 'open-photo': openPhoto(t.dataset.ph); break;
    case 'export-png': exportPng(room); break;
    case 'zoom-reset': zoomOf(room.id).k = 1; refreshPlan(); break;
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
  const target = { project: P, room, wall: w, op: w?.openings.find(o => o.id === el.dataset.o), col: w?.columns?.find(c => c.id === el.dataset.c), shape: room?.shapes?.find(x => x.id === el.dataset.s) }[scope];
  if (!target) return;
  const v = parseFloat(el.value);
  target[prop] = el.type !== 'number' ? el.value : el.value === '' || isNaN(v) ? '' : el.hasAttribute('data-len') ? fromUnit(v, P.unit) : v;
  if (scope === 'op' && prop === 'ref') {
    // Switching the reference keeps the opening where it is; only the measured distance changes.
    const r = w.openings.find(x => x.id === target.ref);
    if (r) target.refGap = Math.max(0, Math.round(((+target.offset || 0) - (+r.offset || 0) - (+r.width || 0)) * 10) / 10);
    else { delete target.ref; delete target.refGap; }
  }
  if (scope === 'op') resolveRefs(w);
  save();
  if (prop === 'name' && (scope === 'room' || view.name === 'project')) $app.querySelector('.bar h1').textContent = el.value;
  if ((scope === 'op' && (prop === 'type' || prop === 'style' || prop === 'ref')) || (scope === 'col' && prop === 'shape') || (scope === 'project' && prop === 'unit')) rerender();
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
  const card = e.target.closest('.wall:not(.mini-wall)');
  if (card && selectedWall !== card.id.slice(2)) selectWall(card.id.slice(2), false, null, true);
});

addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
addEventListener('pagehide', flush);
navigator.storage?.persist?.();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
route();
