import { db } from './db.js';
import { geometry, segPoint, WALL_KINDS, WALL_T, renderPlan, svgToPng, fmtM, fmtArea, fmtLen, UNITS, unitOf, toUnit, fromUnit, cornerName, normAngle, OPEN_STYLES, OPEN_STYLE_DEFAULTS, SLIDE_WAYS, slideWay, MAX_LEAVES, openStyle, openingTags, SHAPE_TYPES, shapePoints } from './plan.js';
import { openAnnotator, renderAnnotated, compressImage } from './annotate.js';
import { plansToDxf } from './dxf.js';
import { newZoom, applyZoom, attachZoom } from './zoom.js';
import { attachPlanTools } from './tools.js';
import { hasCamera, takePhoto } from './camera.js';

// Bump with CACHE in sw.js and add a CHANGELOG.md entry on every release.
const APP_VERSION = '1.0.22';

const $app = document.getElementById('app');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => new Date().toLocaleDateString('sv');
const fileSafe = s => String(s || 'plan').replace(/[\\/:*?"<>|]+/g, '_').trim();

const TURNS = [[90, 'Turn right 90°'], [-90, 'Turn left 90°'], [45, 'Turn right 45°'], [-45, 'Turn left 45°'], [0, 'Straight on (no turn)']];
const OPEN_TYPES = { door: 'Door', window: 'Window', opening: 'Opening' };
const OPEN_DEFAULTS = {
  door: { offset: 30, width: 80, height: 200, ...OPEN_STYLE_DEFAULTS.door },
  window: { offset: 50, width: 120, height: 110, sill: 90, ...OPEN_STYLE_DEFAULTS.window },
};

let P = null;             // project being edited
let photos = new Map();   // photo id → record for P
let view = { name: 'home' };
let selectedWall = null;
let selectedOp = null;    // door/window/column/shape picked in the plan, highlighted in the form
let planTool = null;      // 'edit' | 'wall' | 'light' | 'glass' | 'column' | 'line' | 'rect' | 'circle' while working on the plan
let preview = {};         // { draft, draftWall, snapAt } shown while a plan drag is under way
let snapOn = true;
try { snapOn = localStorage.getItem('plan-snap') !== '0'; } catch { /* storage unavailable */ }
// Wall list shows one line per wall, with only the selected wall opened up. Kept per device.
let wallsCollapsed = false;
try { wallsCollapsed = localStorage.getItem('walls-collapsed') === '1'; } catch { /* storage unavailable */ }
const imgCache = new Map(); // `${photoId}@${size}` → Promise<dataURL>
const zooms = new Map();    // room id → plan zoom { k, x, y }
const zoomOf = id => zooms.get(id) || zooms.set(id, newZoom()).get(id);

// ---------- undo / redo (the open room only) ----------
// Every save() of a room records its previous state. Typing in one field folds into one step
// (save(fieldKey) within a second of the last keystroke there). Photos aren't part of it: undoing a wall delete brings the wall
// back but its photos stay on the room overview.
const UNDO_MAX = 50, MERGE_MS = 1000;
let hist = { roomId: null, past: [], future: [], last: null, at: 0, key: null };
function trackRoom(key = null) {
  const room = view.name === 'room' && curRoom();
  if (!room) return;
  const now = JSON.stringify(room);
  if (hist.roomId !== room.id) { hist = { roomId: room.id, past: [], future: [], last: now, at: 0 }; return; }
  if (now === hist.last) return;
  if (!key || key !== hist.key || Date.now() - hist.at > MERGE_MS) {
    hist.past.push(hist.last);
    if (hist.past.length > UNDO_MAX) hist.past.shift();
  }
  hist.future = [];
  hist.last = now;
  hist.at = Date.now();
  hist.key = key;
}
async function undoRedo(back) {
  const room = curRoom();
  const from = back ? hist.past : hist.future, to = back ? hist.future : hist.past;
  if (!room || hist.roomId !== room.id || !from.length) return;
  to.push(hist.last);
  hist.last = from.pop();
  hist.at = 0;
  hist.key = null;
  const state = JSON.parse(hist.last);
  for (const k of Object.keys(room)) delete room[k];
  Object.assign(room, state);
  persist();
  await rerender();
}

// ---------- persistence ----------
let saveTimer;
function save(fieldKey) {
  trackRoom(fieldKey);
  persist();
}
function persist() {
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
  return [i >= 0 ? `Wall ${i + 1}` : 'Room overview', p.note].filter(Boolean).join(' · ');
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
      trackRoom(); // starts a fresh history when the room changes
    } else {
      view = { name: b === 'report' ? 'report' : 'project' };
    }
  }
  await render();
  scrollTo(0, 0);
}
function render() {
  if (view.name !== 'room') { planTool = null; document.body.classList.remove('plan-full'); }
  return { home: viewHome, project: viewProject, room: viewRoom, report: viewReport }[view.name]();
}
async function rerender() {
  const y = scrollY;
  await render();
  scrollTo(0, y);
}

// Curved walls are stored as a bulge (how far the arc bows out from the chord); the radius is
// worked out from it, and typing a radius sets the bulge. Up to a half circle.
function radiusOf(w) {
  const c = +w.length || 0, h = Math.min(Math.abs(+w.bulge || 0), c / 2);
  return h ? (c * c / 4 + h * h) / (2 * h) : '';
}
function bulgeFor(w, R) {
  const c = +w.length || 0, h = R > c / 2 ? R - Math.sqrt(R * R - c * c / 4) : c / 2;
  return Math.round((+w.bulge < 0 ? -h : h) * 10) / 10;
}
const roundLen = v => (v === '' ? '' : Math.round(v * 10) / 10);

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
const UNIT_NAMES = { mm: 'Millimetres (mm)', cm: 'Centimetres (cm)', m: 'Metres (m)' };
const bar = (back, title, right = '') =>
  `<header class="bar${view.name === 'report' ? ' noprint' : ''}">${back ? `<a class="back" href="${back}" aria-label="Back">‹</a>` : ''}<h1>${esc(title)}</h1>${right}</header>`;

function photoStrip(roomId, wallId) {
  const attrs = `data-photo-room="${roomId}" data-photo-wall="${wallId || ''}"`;
  return `<div class="photos">
    ${roomPhotos(roomId, wallId).map(p => `<button class="thumb" data-act="open-photo" data-ph="${p.id}" aria-label="Open photo"><img data-img="${p.id}" alt=""></button>`).join('')}
    <label class="thumb add" data-act="camera">📷<span>Camera</span><input type="file" accept="image/*" capture="environment" ${attrs} hidden></label>
    <label class="thumb add">🖼<span>Gallery</span><input type="file" accept="image/*" multiple ${attrs} hidden></label>
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
  $app.innerHTML = `${bar('', 'Site Survey')}
  <main>
    <button class="btn primary block" data-act="new-project">+ New project</button>
    ${list.length
      ? list.map(p => `<a class="card link" href="#/p/${p.id}"><b>${esc(p.name || 'Untitled')}</b><small>${[p.site, `${p.rooms.length} room${p.rooms.length === 1 ? '' : 's'}`, p.date].filter(Boolean).map(esc).join(' · ')}</small></a>`).join('')
      : '<p class="empty">No projects yet. Tap the button above to start a survey.</p>'}
    <label class="btn ghost block">Import backup (.siteserve)<input type="file" data-import hidden></label>
    <p class="hint version">Version ${APP_VERSION}</p>
  </main>`;
}

function viewProject() {
  const counts = r => roomPhotos(r.id).length;
  $app.innerHTML = `${bar('#/', P.name || 'Project')}
  <main>
    <section class="card">
      ${field('Project name', 'project.name', P.name)}
      ${field('Client', 'project.client', P.client)}
      ${field('Site', 'project.site', P.site)}
      <div class="row">${field('Survey date', 'project.date', P.date, 'date')}${field('Surveyor', 'project.surveyor', P.surveyor)}</div>
      ${lenField('Default wall thickness', 'project.wallThickness', P.wallThickness ?? WALL_T, 'placeholder="10 cm"')}
      <label class="field"><span>Length unit (for typing and on the plan)</span><select data-f="project.unit">
        ${Object.entries(UNIT_NAMES).map(([k, l]) => `<option value="${k}"${unitOf(P.unit) === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      ${field('Notes', 'project.note', P.note, 'textarea')}
    </section>
    <h2>Rooms (${P.rooms.length})</h2>
    ${P.rooms.map(r => {
      const g = geometry(r);
      return `<a class="card link room-card" href="#/p/${P.id}/r/${r.id}">
        <div class="mini">${renderPlan(r, { mini: true, wallT: P.wallThickness })}</div>
        <div><b>${esc(r.name)}</b><small>${r.walls.length} walls · ${g.closed ? fmtArea(g.area) : 'not closed'} · 📷 ${counts(r)}</small></div>
      </a>`;
    }).join('')}
    <section class="card">
      <h3>Add a room</h3>
      <label class="field"><span>Room name</span><input id="nr-name" placeholder="e.g. Bedroom 1"></label>
      <div class="row">
        <label class="field"><span>Width (${unitLabel()})</span><input id="nr-w" type="number" inputmode="decimal" step="any"></label>
        <label class="field"><span>Length (${unitLabel()})</span><input id="nr-l" type="number" inputmode="decimal" step="any"></label>
      </div>
      <label class="field"><span>or Radius R (${unitLabel()}) for a round room</span><input id="nr-r" type="number" inputmode="decimal" step="any"></label>
      <p class="hint">Enter width × length for a rectangular room, a radius for a round one, or leave blank and add walls one by one.</p>
      <button class="btn primary block" data-act="add-room">+ Add room</button>
    </section>
    <h2>Export</h2>
    <a class="btn block" href="#/p/${P.id}/report">📄 Report: plans + photos (print / PDF)</a>
    <button class="btn block" data-act="export-dxf-all">📐 All plans as DXF (CAD)</button>
    <button class="btn block" data-act="upload">☁️ Upload to server (DATA)</button>
    <button class="btn block" data-act="backup">💾 Back up project to a file</button>
    <button class="btn ghost danger block" data-act="delete-project">Delete project</button>
  </main>`;
}

function summaryParts(room) {
  const g = geometry(room);
  const h = +room.height || 0;
  const openArea = room.walls.flatMap(w => w.openings).reduce((s, o) => s + (+o.width || 0) * (+o.height || 0), 0);
  const parts = [['Floor area', g.closed ? fmtArea(g.area) : '–'], ['Perimeter', `${fmtM(g.perimeter)} m`]];
  if (h) parts.push(['Height', `${fmtM(h)} m`], ['Net wall area', fmtArea(Math.max(0, g.wallLen * h - openArea))]);
  if (h && g.glassLen) parts.push(['Glass wall area', fmtArea(g.glassLen * h)]);
  return { g, parts };
}
function summaryHtml(room) {
  const { g, parts } = summaryParts(room);
  let html = parts.map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
  if (room.walls.length >= 2 && g.gap >= 1) {
    html += `<div class="warn"><span>⚠ The room is not closed: the last wall ends <b>${fmtLen(g.gap, P.unit)} ${unitLabel()}</b> from corner A. A small gap is usually measuring error.</span>
      <button class="btn sm" data-act="close-room">Add a closing wall</button></div>`;
  }
  return html;
}
const planSvg = room => renderPlan(room, { wallT: P.wallThickness, selected: selectedWall, selectedOp, ...preview, editing: !!planTool, handles: planTool === 'edit' ? handlesFor(room) : null, photoCounts: photoCounts(room), unit: P.unit, zoom: zoomOf(room.id).k });

function refreshPlan() {
  const room = curRoom();
  if (!room) return;
  const pl = document.getElementById('plan'), sm = document.getElementById('summary');
  if (pl) { pl.innerHTML = planSvg(room); applyZoom(pl, zoomOf(room.id)); }
  if (sm) sm.innerHTML = summaryHtml(room);
  const bar = document.querySelector('.draw-bar');
  if (bar) bar.innerHTML = drawBar(); // undo / redo availability
}

function kindRow(o, at, autoTag) {
  const st = openStyle(o);
  if (!st) return '';
  const opt = (v, l, on) => `<option value="${v}"${on ? ' selected' : ''}>${l}</option>`;
  return `<div class="op-kind">
    <input class="op-tag" data-f="op.tag" ${at} value="${esc(o.tag || '')}" placeholder="${esc(autoTag)}" aria-label="Tag, e.g. D1">
    <select data-f="op.style" ${at} aria-label="Type">${Object.entries(OPEN_STYLES[o.type]).map(([k, l]) => opt(k, l, k === st.style)).join('')}</select>
    ${st.style === 'open' ? '' : `<select data-f="op.leaves" ${at} aria-label="Leaves">${Array.from({ length: MAX_LEAVES[o.type] }, (_, i) => opt(i + 1, `${i + 1} leaf${i ? 's' : ''}`, i + 1 === st.leaves)).join('')}</select>`}
    ${o.type === 'door' && st.style === 'swing' ? `<select data-f="op.swing" ${at} aria-label="Opens">${opt('in', 'Opens in', o.swing !== 'out')}${opt('out', 'Opens out', o.swing === 'out')}</select>` : ''}
    ${o.type === 'door' && st.style === 'slide' ? `<select data-f="op.slide" ${at} aria-label="Opens">${Object.entries(SLIDE_WAYS).filter(([k]) => k !== 'center' || st.leaves > 1).map(([k, l]) => opt(k, l, k === slideWay(o, st.leaves))).join('')}</select>` : ''}
    ${o.type === 'door' && st.style !== 'slide' ? `<select data-f="op.hinge" ${at} aria-label="Hinge side">${opt('left', 'Hinge left', o.hinge !== 'right')}${opt('right', 'Hinge right', o.hinge === 'right')}</select>` : ''}
  </div>`;
}

function columnRow(w, c) {
  const at = `data-w="${w.id}" data-c="${c.id}"`;
  const idx = P && curRoom().walls.indexOf(w);
  const round = c.shape === 'round';
  return `<div class="op col${selectedOp === c.id ? ' picked' : ''}" id="op-${c.id}">
    <select data-f="col.shape" ${at} aria-label="Column shape"><option value="rect"${round ? '' : ' selected'}>Square column</option><option value="round"${round ? ' selected' : ''}>Round column</option></select>
    <button class="icon" data-act="del-col" ${at} aria-label="Delete column">✕</button>
    <div class="col-f">
      ${lenField(`From corner ${cornerName(idx)}`, 'col.offset', c.offset, at)}
      ${lenField('From wall', 'col.gap', c.gap, at)}
      ${lenField(round ? 'Diameter' : 'Width along wall', 'col.width', c.width, at)}
      ${round ? '' : lenField('Depth into room', 'col.depth', c.depth, at)}
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
    <select data-f="op.type" ${at} aria-label="Kind">${Object.entries(OPEN_TYPES).map(([k, l]) => `<option value="${k}"${o.type === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <button class="icon" data-act="del-op" ${at} aria-label="Delete">✕</button>
    ${kindRow(o, at, tags.get(o.id) || '')}
    ${before.length ? `<label class="field op-ref"><span>Measure from</span><select data-f="op.ref" ${at}>
      <option value="">Corner ${cornerName(idx)}</option>
      ${before.map(x => `<option value="${x.id}"${ref === x ? ' selected' : ''}>End of ${esc(opName(tags, x))}</option>`).join('')}</select></label>` : ''}
    <div class="op-f">
      ${ref ? lenField(`From ${esc(opName(tags, ref))}`, 'op.refGap', o.refGap, at) : lenField(`From corner ${cornerName(idx)}`, 'op.offset', o.offset, at)}
      ${lenField('Width', 'op.width', o.width, at)}
      ${lenField('Height', 'op.height', o.height, at)}
      ${o.type === 'window' ? lenField('Sill height', 'op.sill', o.sill, at) : ''}
    </div>
  </div>`;
}

// One-line summary of a wall for the collapsed list: length, curve, tags, columns, photos.
function wallSummary(room, w) {
  const tags = openingTags(room);
  return [
    `${fmtLen(w.length, P.unit)} ${unitLabel()}`,
    w.gap ? '┄ gap (wall deleted)' : +w.bulge ? '⌒ curved' : '',
    !w.gap && w.kind === 'glass' ? '🪟 glass' : !w.gap && w.kind === 'light' ? '▯ light wall' : '',
    !w.gap && +w.thickness > 0 ? `${fmtLen(w.thickness, P.unit)} thick` : '',
    w.openings.map(o => tags.get(o.id) || OPEN_TYPES[o.type]).join(' '),
    w.columns?.length ? `${w.columns.length} column${w.columns.length > 1 ? 's' : ''}` : '',
    roomPhotos(room.id, w.id).length ? `📷${roomPhotos(room.id, w.id).length}` : '',
  ].filter(Boolean).join(' · ');
}

function wallCard(room, w, i) {
  const n = room.walls.length, last = i === n - 1;
  const known = !w.customTurn && TURNS.some(([v]) => v === w.turn);
  const corners = `Corner ${cornerName(i)} → ${last ? cornerName(0) : cornerName(i + 1)}`;
  if (wallsCollapsed && selectedWall !== w.id) {
    return `<article class="card wall mini-wall" id="w-${w.id}">
      <button class="wall-head wall-open" data-act="open-wall" data-w="${w.id}">
        <span class="badge">${i + 1}</span><b>Wall ${i + 1}</b><small>${esc(wallSummary(room, w))}</small><span class="chev">›</span>
      </button>
    </article>`;
  }
  if (w.gap) {
    return `<article class="card wall gap-wall${selectedWall === w.id ? ' sel' : ''}" id="w-${w.id}">
    <div class="wall-head${wallsCollapsed ? ' wall-fold' : ''}"${wallsCollapsed ? ` data-act="close-wall" data-w="${w.id}"` : ''}>
      <span class="badge">${i + 1}</span><b>Gap · wall ${i + 1} deleted</b>
      <small>${corners}</small>
      ${wallsCollapsed ? '<span class="chev open">›</span>' : ''}
    </div>
    <p class="hint">The walls around it stay where they are. Put a wall back here, split the gap to fill part of it, or remove the gap to join the walls either side.</p>
    <div class="row">
      ${lenField('Length', 'wall.length', w.length, `data-w="${w.id}"`)}
      ${last ? '' : `<label class="field"><span>At corner ${cornerName(i + 1)}</span><select data-turn="${w.id}">
        ${TURNS.map(([v, l]) => `<option value="${v}"${known && v === w.turn ? ' selected' : ''}>${l}</option>`).join('')}
        <option value="custom"${known ? '' : ' selected'}>Custom angle…</option></select></label>`}
    </div>
    ${!last && !known ? field('Turn angle (+ right / − left)', 'wall.turn', w.turn, 'number', `data-w="${w.id}" inputmode="text"`) : ''}
    <div class="btns">
      <button class="btn sm" data-act="fill-gap" data-w="${w.id}">↺ Put a wall here</button>
      <button class="btn sm ghost" data-act="split-wall" data-w="${w.id}">✂ Split in two</button>
      <button class="btn sm ghost danger" data-act="del-wall" data-w="${w.id}">Remove gap</button>
    </div>
  </article>`;
  }
  const curved = w.bulge !== undefined && w.bulge !== null;
  // In the collapsed list the open wall's header folds it back up.
  return `<article class="card wall${selectedWall === w.id ? ' sel' : ''}" id="w-${w.id}">
    <div class="wall-head${wallsCollapsed ? ' wall-fold' : ''}"${wallsCollapsed ? ` data-act="close-wall" data-w="${w.id}"` : ''}>
      <span class="badge">${i + 1}</span><b>Wall ${i + 1}</b>
      <small>${corners}</small>
      ${wallsCollapsed ? '<span class="chev open">›</span>' : ''}
      <button class="icon" data-act="del-wall" data-w="${w.id}" aria-label="Delete wall">✕</button>
    </div>
    <div class="row">
      ${lenField('Length', 'wall.length', w.length, `data-w="${w.id}"`)}
      ${last ? '' : `<label class="field"><span>At corner ${cornerName(i + 1)}</span><select data-turn="${w.id}">
        ${TURNS.map(([v, l]) => `<option value="${v}"${known && v === w.turn ? ' selected' : ''}>${l}</option>`).join('')}
        <option value="custom"${known ? '' : ' selected'}>Custom angle…</option></select></label>`}
    </div>
    ${!last && !known ? field('Turn angle (+ right / − left)', 'wall.turn', w.turn, 'number', `data-w="${w.id}" inputmode="text"`) : ''}
    ${curved ? `<div class="row bulge">${lenField('Bulge (+ out / − into room)', 'wall.bulge', w.bulge, `data-w="${w.id}" inputmode="text"`)}
      ${lenField('Radius R', 'wall.radius', roundLen(radiusOf(w)), `data-w="${w.id}"`)}
      <button class="icon" data-act="del-bulge" data-w="${w.id}" aria-label="Make straight">✕</button></div>
      <p class="hint">Bulge is measured from the middle of the straight corner-to-corner line out to the wall · or type the radius · the length above is corner to corner</p>
      <div class="btns"><button class="btn sm ghost" data-act="half-circle" data-w="${w.id}">◐ Half circle</button></div>` : ''}
    <div class="row">
      <label class="field"><span>Wall type</span><select data-f="wall.kind" data-w="${w.id}">${Object.entries(WALL_KINDS).map(([k, l]) => `<option value="${k}"${(w.kind || '') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      ${lenField('Thickness', 'wall.thickness', w.thickness, `data-w="${w.id}" placeholder="${esc(fmtLen(P.wallThickness ?? WALL_T, P.unit))} (default)"`)}
    </div>
    ${field('Wall notes', 'wall.note', w.note, 'text', `data-w="${w.id}" placeholder="e.g. plaster wall, 2 sockets"`)}
    ${w.openings.map(o => openingRow(w, o)).join('')}
    ${(w.columns || []).map(c => columnRow(w, c)).join('')}
    <div class="btns">
      <button class="btn sm" data-act="add-op" data-type="door" data-w="${w.id}">+ Door</button>
      <button class="btn sm" data-act="add-op" data-type="window" data-w="${w.id}">+ Window</button>
      <button class="btn sm" data-act="add-op" data-type="window" data-style="open" data-w="${w.id}">+ Window opening</button>
      <button class="btn sm" data-act="add-op" data-type="opening" data-w="${w.id}">+ Opening</button>
      <button class="btn sm" data-act="add-col" data-w="${w.id}">+ Column</button>
    </div>
    <div class="btns">
      ${curved ? '' : `<button class="btn sm ghost" data-act="add-bulge" data-w="${w.id}">⌒ Curve wall</button>`}
      <button class="btn sm ghost" data-act="split-wall" data-w="${w.id}">✂ Split in two</button>
      <button class="btn sm ghost" data-act="insert-wall" data-w="${w.id}">⤵ Insert wall after</button>
    </div>
    ${photoStrip(room.id, w.id)}
  </article>`;
}

// ---------- shapes drawn into the plan ----------
const shapeName = sh => (sh.label ? `${sh.label} (${SHAPE_TYPES[sh.type]})` : SHAPE_TYPES[sh.type]);
const SHAPE_FIELDS = {
  line: [['x1', 'Start x'], ['y1', 'Start y'], ['x2', 'End x'], ['y2', 'End y']],
  rect: [['x', 'Top-left x'], ['y', 'Top-left y'], ['w', 'Width (x)'], ['h', 'Depth (y)']],
  circle: [['x', 'Centre x'], ['y', 'Centre y'], ['d', 'Diameter']],
};

function shapesCard(room) {
  const list = room.shapes || [];
  return `<section class="card shapes">
    <h3>Items on the plan <small>counters, cabinets, built-ins, free-standing columns…</small></h3>
    ${list.length || room.columns?.length ? '<p class="hint">x, y are measured from corner A — right is +x, down is +y</p>' : '<p class="hint">Tap "✏️ Edit / draw on plan" below the plan and drag, or add one below and type its size.</p>'}
    ${list.map(sh => {
      const at = `data-s="${sh.id}"`;
      return `<div class="op shape${selectedOp === sh.id ? ' picked' : ''}" id="op-${sh.id}">
        <input data-f="shape.label" ${at} value="${esc(sh.label || '')}" placeholder="Name, e.g. Counter (${SHAPE_TYPES[sh.type]})">
        <button class="icon" data-act="del-shape" ${at} aria-label="Delete">✕</button>
        <div class="col-f">${SHAPE_FIELDS[sh.type].map(([k, l]) => lenField(l, `shape.${k}`, sh[k], `${at} inputmode="text"`)).join('')}</div>
      </div>`;
    }).join('')}
    ${(room.columns || []).map(c => {
      const at = `data-fc="${c.id}"`, round = c.shape === 'round';
      return `<div class="op col${selectedOp === c.id ? ' picked' : ''}" id="op-${c.id}">
        <select data-f="fcol.shape" ${at} aria-label="Column shape"><option value="rect"${round ? '' : ' selected'}>Free-standing square column</option><option value="round"${round ? ' selected' : ''}>Free-standing round column</option></select>
        <button class="icon" data-act="del-fcol" ${at} aria-label="Delete column">✕</button>
        <div class="col-f">
          ${lenField('Centre x', 'fcol.x', c.x, `${at} inputmode="text"`)}
          ${lenField('Centre y', 'fcol.y', c.y, `${at} inputmode="text"`)}
          ${lenField(round ? 'Diameter' : 'Width (x)', 'fcol.width', c.width, at)}
          ${round ? '' : lenField('Depth (y)', 'fcol.depth', c.depth, at)}
        </div>
      </div>`;
    }).join('')}
    <div class="btns">${Object.entries(SHAPE_TYPES).map(([k, l]) => `<button class="btn sm" data-act="add-shape" data-type="${k}">+ ${l}</button>`).join('')}
      <button class="btn sm" data-act="add-fcol">+ Column</button></div>
  </section>`;
}

const snap = v => Math.round(v / 5) * 5; // drawn shapes snap to 5 cm

// Handles shown in edit mode: the picked shape's grips, or the ends of the picked door / window /
// opening, or else both ends and the middle of the selected wall.
function handlesFor(room) {
  const out = [];
  const sh = room.shapes?.find(x => x.id === selectedOp);
  if (sh) {
    const [a, b] = shapePoints(sh);
    if (sh.type === 'rect') [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }].forEach((p, k) => out.push({ ...p, id: `rect-${k}`, for: sh.id }));
    else if (sh.type === 'circle') out.push({ x: (+sh.x || 0) + (+sh.d || 0) / 2, y: +sh.y || 0, id: 'circle-r', for: sh.id });
    else out.push({ ...a, id: 'line-1', for: sh.id }, { ...b, id: 'line-2', for: sh.id });
  }
  const g = geometry(room);
  // A picked door / window / opening: its two ends, to make it wider or narrower.
  for (const s of g.segs) {
    const o = s.wall.openings.find(x => x.id === selectedOp);
    if (!o) continue;
    const off = Math.min(Math.max(+o.offset || 0, 0), s.len), end = Math.min(off + (+o.width || 0), s.len);
    out.push({ ...segPoint(s, off).p, id: 'op-start', for: o.id }, { ...segPoint(s, end).p, id: 'op-end', for: o.id });
    return out;
  }
  const sg = g.segs.find(x => x.wall.id === selectedWall);
  if (sg && !selectedOp) {
    const m = sg.arc ? sg.arc.apex : { x: (sg.p0.x + sg.p1.x) / 2, y: (sg.p0.y + sg.p1.y) / 2 };
    out.push({ ...sg.p0, id: 'wall-start', for: sg.wall.id }, { ...sg.p1, id: 'wall-end', for: sg.wall.id }, { ...m, id: 'wall-move', for: sg.wall.id, solid: true });
  }
  return out;
}

// What is picked on the plan: a door / window / opening, a column, a drawn item, or — while
// editing on the plan, where the form is out of sight — the selected wall.
function pickedItem(room) {
  for (const w of room.walls) {
    const o = w.openings.find(x => x.id === selectedOp);
    if (o) return { kind: 'op', w, o, name: openingTags(room).get(o.id) || OPEN_TYPES[o.type] };
    const c = (w.columns || []).find(x => x.id === selectedOp);
    if (c) return { kind: 'col', w, c, name: 'Column' };
  }
  const sh = room.shapes?.find(x => x.id === selectedOp);
  if (sh) return { kind: 'shape', sh, name: shapeName(sh) };
  const fc = room.columns?.find(x => x.id === selectedOp);
  if (fc) return { kind: 'fcol', c: fc, name: 'Column' };
  const i = planTool ? room.walls.findIndex(x => x.id === selectedWall) : -1;
  if (i >= 0) return { kind: 'wall', w: room.walls[i], name: room.walls[i].gap ? `Gap (wall ${i + 1})` : `Wall ${i + 1}` };
  return null;
}

// Quick buttons under the plan for what was picked there: delete it, and for a door flip the
// hinge side and in / out.
function pickQuick(room) {
  const it = pickedItem(room);
  if (!it) return '';
  const o = it.kind === 'op' && it.o, st = o?.type === 'door' && openStyle(o);
  const at = o ? `data-w="${it.w.id}" data-o="${o.id}"` : '';
  return `<div class="door-quick">
    <b>${esc(it.name)}</b>
    ${st && st.style !== 'slide' ? `<button class="btn sm" data-act="door-hinge" ${at}>⇆ ${o.hinge === 'right' ? 'Hinge right' : 'Hinge left'}</button>` : ''}
    ${st && st.style === 'swing' ? `<button class="btn sm" data-act="door-swing" ${at}>⇅ ${o.swing === 'out' ? 'Opens out' : 'Opens in'}</button>` : ''}
    ${st && st.style === 'slide' ? `<button class="btn sm" data-act="door-slide" ${at}>⇄ ${SLIDE_WAYS[slideWay(o, st.leaves)]}</button>` : ''}
    ${it.kind === 'wall' && it.w.gap ? `<button class="btn sm" data-act="fill-gap" data-w="${it.w.id}">↺ Put a wall here</button>` : ''}
    ${it.kind === 'wall' && !it.w.gap ? Object.entries(KIND_BUTTONS).map(([k, l]) => `<button class="btn sm${(it.w.kind || '') === k ? ' on' : ''}" data-act="wall-kind" data-kind="${k}" data-w="${it.w.id}">${l}</button>`).join('') : ''}
    <button class="btn sm danger" data-act="del-picked">🗑 ${it.kind === 'wall' && it.w.gap ? 'Remove gap' : 'Delete'}</button>
    <button class="btn sm icon-btn" data-act="${it.kind === 'wall' ? 'close-wall' : 'unpick'}" aria-label="Close">✕</button>
  </div>`;
}

const KIND_BUTTONS = { '': '🧱 Masonry', light: '▯ Light', glass: '🪟 Glass' };
const PLAN_TOOLS = { edit: '✋ Move / resize', wall: '🧱 Wall', light: '▯ Light wall', glass: '🪟 Glass wall', column: '▪ Column', line: '╱ Line', rect: '▭ Rectangle', circle: '◯ Circle' };

function drawBar() {
  const room = curRoom(), quick = room ? pickQuick(room) : '';
  const undo = `<button class="btn sm icon-btn" data-act="undo" aria-label="Undo"${hist.past.length ? '' : ' disabled'}>↶</button>
    <button class="btn sm icon-btn" data-act="redo" aria-label="Redo"${hist.future.length ? '' : ' disabled'}>↷</button>`;
  if (!planTool) return `${quick}${undo}<button class="btn sm" data-act="tool" data-tool="edit">✏️ Edit / draw on plan</button>`;
  return `${quick}${undo}${Object.entries(PLAN_TOOLS).map(([k, l]) => `<button class="btn sm${planTool === k ? ' on' : ''}" data-act="tool" data-tool="${k}">${l}</button>`).join('')}
    <button class="btn sm${snapOn ? ' on' : ''}" data-act="snap" aria-pressed="${snapOn}">🧲 Snap</button>
    <button class="btn sm primary" data-act="tool-off">Done</button>
    <small class="tool-hint">${{
      edit: 'Drag doors, windows, openings, columns or items to move them · tap one, then drag its ends to resize · tap a wall, then drag an end to stretch / turn it or the middle to move it',
      wall: 'Tap or drag to where the wall ends; it continues from the last wall · finish at corner A to close the room',
      light: 'Like 🧱 Wall, but the new wall is a light wall (drywall) · switch any wall later: tap it in ✋ Move / resize',
      glass: 'Like 🧱 Wall, but the new wall is glass · switch any wall later: tap it in ✋ Move / resize',
      column: 'Tap where a free-standing column goes · drag it, or type its size, afterwards',
    }[planTool] || 'Drag on the plan to draw'}</small>`;
}

function viewRoom() {
  const room = curRoom();
  $app.innerHTML = `${bar(`#/p/${P.id}`, room.name, '<button class="btn sm" data-act="export-png">PNG</button><button class="btn sm" data-act="export-dxf">DXF</button>')}
  <main>
    <section class="plan-wrap${planTool ? ' full' : ''}">
      <div class="plan-box">
        <div id="plan" class="plan">${planSvg(room)}</div>
        <button class="btn sm zoom-reset" data-act="zoom-reset" aria-label="Reset zoom">⤢ Reset zoom</button>
      </div>
      <div class="draw-bar">${drawBar()}</div>
      <div id="summary" class="summary">${summaryHtml(room)}</div>
    </section>
    <section class="card">
      <div class="row">${field('Room name', 'room.name', room.name)}${lenField('Ceiling height', 'room.height', room.height)}</div>
      ${field('Room notes', 'room.note', room.note, 'textarea')}
      <small>Room overview photos</small>
      ${photoStrip(room.id, null)}
    </section>
    <p class="hint">Stand in the room, start at corner A and measure the walls clockwise (room on your right). A plain rectangle turns right 90° at every corner · tap a wall on the plan to jump to it.</p>
    <div class="walls-bar"><b>${room.walls.length} walls</b>
      <button class="btn sm" data-act="toggle-walls">${wallsCollapsed ? '☰ Show all' : '≡ Collapse all'}</button></div>
    <div id="walls">${room.walls.map((w, i) => wallCard(room, w, i)).join('')}</div>
    <button class="btn primary block" data-act="add-wall">+ Add wall</button>
    ${shapesCard(room)}
    <button class="btn block" data-act="copy-room">⧉ Copy this room</button>
    <button class="btn ghost danger block" data-act="delete-room">Delete this room</button>
  </main>`;
  // Editing takes the plan full screen; Done brings the form back.
  document.body.classList.toggle('plan-full', !!planTool);
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
  const kind = st ? ` ${st.label}${st.leaves > 1 ? ` ×${st.leaves}` : ''}${o.type === 'door' && st.style === 'swing' && o.swing === 'out' ? ' opens out' : ''}${o.type === 'door' && st.style !== 'slide' && o.hinge === 'right' ? ' hinge right' : ''}${o.type === 'door' && st.style === 'slide' ? `, ${SLIDE_WAYS[slideWay(o, st.leaves)].toLowerCase()}` : ''}` : '';
  const tag = openingTags(curRoomOf(o)).get(o.id);
  return `${tag ? `${esc(tag)} ` : ''}${OPEN_TYPES[o.type]}${kind} ${fmtLen(o.width, P.unit)}×${fmtLen(o.height, P.unit)} ${unitLabel()} (from corner ${cornerName(wallIndex)} ${fmtLen(o.offset, P.unit)}${o.type === 'window' && o.sill !== undefined && o.sill !== '' ? `, sill ${fmtLen(o.sill, P.unit)}` : ''})`;
}

function fmtFreeColumn(c) {
  const u = P.unit;
  return `${c.shape === 'round' ? `Free-standing round column Ø${fmtLen(c.width, u)}` : `Free-standing column ${fmtLen(c.width, u)}×${fmtLen(c.depth, u)}`} ${unitLabel()} (centre ${fmtLen(c.x, u)}, ${fmtLen(c.y, u)} from corner A)`;
}

// Room holding an opening, for its tag in the report (which lists every room).
const curRoomOf = o => P.rooms.find(r => r.walls.some(w => w.openings.includes(o)));

function fmtColumn(c, wallIndex) {
  const u = P.unit;
  return `${c.shape === 'round' ? `Round column Ø${fmtLen(c.width, u)}` : `Column ${fmtLen(c.width, u)}×${fmtLen(c.depth, u)}`} ${unitLabel()} (from corner ${cornerName(wallIndex)} ${fmtLen(c.offset, u)}${+c.gap ? `, ${fmtLen(c.gap, u)} from wall` : ''})`;
}

function roomReport(r) {
  const { parts } = summaryParts(r);
  const n = r.walls.length;
  const list = roomPhotos(r.id);
  return `<section class="r-room">
    <h2>${esc(r.name)}</h2>
    <div class="r-plan">${renderPlan(r, { wallT: P.wallThickness, photoCounts: photoCounts(r), unit: P.unit })}</div>
    <p class="r-sum">${parts.map(([k, v]) => `${k} <b>${v}</b>`).join(' · ')}</p>
    ${r.shapes?.length ? `<p>Items: ${r.shapes.map(sh => esc(shapeName(sh)) + (sh.type === 'rect' ? ` ${fmtLen(sh.w, P.unit)}×${fmtLen(sh.h, P.unit)}` : sh.type === 'circle' ? ` Ø${fmtLen(sh.d, P.unit)}` : '')).join(', ')} ${unitLabel()}</p>` : ''}
    ${r.note ? `<p>${esc(r.note)}</p>` : ''}
    <table class="r-table"><thead><tr><th>Wall</th><th>Length (${unitLabel()})</th><th>Doors / windows / columns</th><th>Notes</th></tr></thead><tbody>
      ${(r.columns || []).length ? `<tr><td>–</td><td>–</td><td>${r.columns.map(fmtFreeColumn).join('<br>')}</td><td></td></tr>` : ''}
      ${r.walls.map((w, i) => `<tr><td>${i + 1} (${cornerName(i)}→${cornerName((i + 1) % n)})</td><td>${fmtLen(w.length, P.unit)}${w.gap ? '<br><small>gap (wall deleted)</small>' : ''}${!w.gap && w.kind ? `<br><small>${WALL_KINDS[w.kind]?.toLowerCase() || ''}</small>` : ''}${!w.gap && +w.thickness > 0 ? `<br><small>${fmtLen(w.thickness, P.unit)} thick</small>` : ''}${w.gap ? '' : +w.bulge ? `<br><small>bulge ${fmtLen(w.bulge, P.unit)}</small>` : ''}</td><td>${[...w.openings.map(o => fmtOpening(o, i)), ...(w.columns || []).map(c => fmtColumn(c, i))].join('<br>') || '–'}</td><td>${esc(w.note)}</td></tr>`).join('')}
    </tbody></table>
    ${list.length ? `<div class="r-photos">${list.map(p => `<figure><img data-img="${p.id}" data-size="1100" alt=""><figcaption>${esc(photoLabel(r, p))}</figcaption></figure>`).join('')}</div>` : ''}
  </section>`;
}

function viewReport() {
  const total = P.rooms.reduce((s, r) => { const g = geometry(r); return s + (g.closed ? g.area : 0); }, 0);
  const meta = [['Client', P.client], ['Site', P.site], ['Survey date', P.date], ['Surveyor', P.surveyor], ['Rooms', P.rooms.length], ['Total floor area', fmtArea(total)]]
    .filter(([, v]) => v !== '' && v != null);
  $app.innerHTML = `${bar(`#/p/${P.id}`, 'Report', '<button class="btn sm" data-act="print">Print / PDF</button>')}
  <main class="report">
    <h1 class="r-title">${esc(P.name)}</h1>
    <dl class="r-meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${P.note ? `<p>${esc(P.note)}</p>` : ''}
    ${P.rooms.map(roomReport).join('') || '<p class="empty">No rooms yet</p>'}
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

// Deleting a wall leaves a gap in its place (a dashed line), so the walls after it don't move.
// Deleting the gap then takes it out of the chain: the walls after it move up to join on.
async function deleteWall(room, w) {
  const i = room.walls.indexOf(w), last = i === room.walls.length - 1;
  if (w.gap) {
    if (!last && !confirm('Remove this gap? The walls after it move to join on to the wall before it.')) return false;
    room.walls.splice(i, 1);
    if (selectedWall === w.id) selectedWall = null;
    return true;
  }
  const photos = roomPhotos(room.id, w.id);
  if (!confirm(`Delete wall ${i + 1}?${w.openings.length || w.columns?.length ? ' Its doors, windows and columns go with it.' : ''}${photos.length ? ' Its photos move to the room overview.' : ''} A dashed gap stays in its place.`)) return false;
  for (const p of photos) { p.wallId = null; await db.putPhoto(p); }
  w.gap = true;
  w.openings = [];
  w.columns = [];
  delete w.bulge;
  return true;
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
    wallT: P.wallThickness,
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
  await shareOrDownload(await backupBlob(), `${fileSafe(P.name)}.siteserve`);
}

// ---------- upload to the office server (server.py) ----------
// Everything about the project goes to DATA/<survey date>/<project>/ on the server:
// the .siteserve backup, a DXF of all rooms, and per room its plan (PNG + DXF) and photos,
// with a second copy of each annotated photo that has its lines drawn in.
const seg = s => fileSafe(s).replace(/^\.+/, '') || '_';

async function uploadProject(btn) {
  try {
    const r = await fetch('api/ping', { cache: 'no-store' });
    if (!(await r.json()).ok) throw new Error();
  } catch {
    alert('This address has no upload service. Open the app from the office server (server.py), e.g. over Tailscale.');
    return;
  }
  const base = `${seg(P.date || today())}/${seg(P.name)}`;
  const files = [
    [`${seg(P.name)}.siteserve`, backupBlob],
    [`${seg(P.name)} all rooms.dxf`, () => dxfBlob(P.rooms)],
  ];
  const used = new Set();
  for (const room of P.rooms) {
    let dir = seg(room.name);
    for (let k = 2; used.has(dir); k++) dir = `${seg(room.name)} (${k})`;
    used.add(dir);
    files.push([`${dir}/plan.png`, () => planPng(room)], [`${dir}/plan.dxf`, () => dxfBlob([room])]);
    roomPhotos(room.id).forEach((p, i) => {
      const name = `${dir}/photos/${String(i + 1).padStart(2, '0')} ${seg(photoLabel(room, p))}`;
      files.push([`${name}.jpg`, () => p.blob]);
      if (p.annotations?.length) files.push([`${name} (annotated).jpg`, async () => (await fetch(await renderAnnotated(p.blob, p.annotations, 4000))).blob()]);
    });
  }

  const label = btn.textContent;
  btn.disabled = true;
  try {
    for (const [k, [path, make]] of files.entries()) {
      btn.textContent = `Uploading ${k + 1}/${files.length}…`;
      const res = await fetch(`api/upload?path=${encodeURIComponent(`${base}/${path}`)}`, { method: 'PUT', body: await make() });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    }
    alert(`Uploaded ${files.length} files\nto DATA/${base}`);
  } catch (e) {
    alert(`Upload failed (${e.message || e}). Try again — files already sent are overwritten.`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (data?.app !== 'site-survey' || !data.project?.id) { alert('This is not a backup file from this app'); return; }
  const id = data.project.id;
  if (await db.getProject(id)) {
    if (!confirm(`Project "${data.project.name}" already exists. Replace it with this file?`)) return;
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
    const fc = e.target.closest('[data-fcol]');
    if (fc && (!planTool || planTool === 'edit')) {
      selectedOp = fc.dataset.fcol;
      await rerender();
      if (!planTool) document.getElementById('op-' + selectedOp)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      const p = { id: uid(), name: 'New project', client: '', site: '', date: today(), surveyor: '', note: '', rooms: [], createdAt: Date.now(), updatedAt: Date.now() };
      await db.putProject(p);
      location.hash = `#/p/${p.id}`;
      break;
    }
    case 'add-room': {
      const name = document.getElementById('nr-name').value.trim() || `Room ${P.rooms.length + 1}`;
      const W = fromUnit(parseFloat(document.getElementById('nr-w').value), P.unit), L = fromUnit(parseFloat(document.getElementById('nr-l').value), P.unit);
      const R = fromUnit(parseFloat(document.getElementById('nr-r').value), P.unit);
      // A round room is two half-circle walls across the diameter.
      const walls = R > 0 ? [0, 1].map(() => ({ ...newWall(), length: 2 * R, turn: -180, customTurn: true, bulge: R }))
        : W > 0 && L > 0 ? [W, L, W, L].map(length => ({ ...newWall(), length })) : [newWall()];
      const r = { id: uid(), name, height: '', note: '', walls };
      P.rooms.push(r);
      save();
      location.hash = `#/p/${P.id}/r/${r.id}`;
      break;
    }
    case 'delete-project':
      if (confirm(`Delete project "${P.name}" and all its photos? This cannot be undone.`)) {
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
      if (confirm(`Delete room "${room.name}" and its photos?`)) {
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
    case 'camera': {
      // The in-app camera when the page may use it; otherwise the label opens the phone's camera app.
      if (!hasCamera()) break;
      e.preventDefault();
      const input = t.querySelector('input'), { photoRoom, photoWall } = input.dataset;
      let blob;
      try { blob = await takePhoto(room?.name || ''); } catch { input.click(); break; }
      if (blob) await addPhotos([blob], photoRoom, photoWall || null, true);
      break;
    }
    case 'del-picked': {
      const it = pickedItem(room);
      if (!it) break;
      if (it.kind === 'wall') {
        if (!(await deleteWall(room, it.w))) break;
      } else if (it.kind === 'op') {
        it.w.openings = it.w.openings.filter(x => x !== it.o);
        resolveRefs(it.w);
      } else if (it.kind === 'col') it.w.columns = it.w.columns.filter(x => x !== it.c);
      else if (it.kind === 'fcol') room.columns = room.columns.filter(x => x !== it.c);
      else room.shapes = room.shapes.filter(x => x !== it.sh);
      selectedOp = null;
      save();
      await rerender();
      break;
    }
    case 'del-wall':
      if (await deleteWall(room, w)) { save(); rerender(); }
      break;
    case 'fill-gap': delete w.gap; save(); rerender(); break;
    case 'wall-kind': if (t.dataset.kind) w.kind = t.dataset.kind; else delete w.kind; save(); rerender(); break;
    case 'add-op': {
      // A second door/window is measured on from the last one by default.
      const last = w.openings.at(-1);
      w.openings.push({ id: uid(), type: t.dataset.type, offset: 30, width: 80, height: 200, ...OPEN_DEFAULTS[t.dataset.type], ...(t.dataset.style ? { style: t.dataset.style } : {}), ...(last ? { ref: last.id, refGap: 50 } : {}) });
      resolveRefs(w);
      save();
      rerender();
      break;
    }
    case 'open-wall': await selectWall(w.id, true); break;
    case 'copy-room': {
      // Same walls, openings, columns and shapes under new ids (photos stay with the original).
      const ids = new Map(), fresh = id => (id ? ids.get(id) || ids.set(id, uid()).get(id) : id);
      const copy = JSON.parse(JSON.stringify(room));
      copy.id = uid();
      copy.name = `${room.name} (copy)`;
      for (const w of copy.walls) {
        w.id = fresh(w.id);
        for (const o of w.openings || []) { o.id = fresh(o.id); if (o.ref) o.ref = fresh(o.ref); }
        for (const c of w.columns || []) c.id = fresh(c.id);
      }
      for (const sh of copy.shapes || []) sh.id = fresh(sh.id);
      for (const c of copy.columns || []) c.id = fresh(c.id);
      P.rooms.splice(P.rooms.indexOf(room) + 1, 0, copy);
      save();
      location.hash = `#/p/${P.id}/r/${copy.id}`;
      break;
    }
    case 'door-hinge':
    case 'door-swing':
    case 'door-slide': {
      const o = w.openings.find(x => x.id === t.dataset.o);
      if (t.dataset.act === 'door-slide') {
        // Middle → left → right, skipping the middle for a single leaf.
        const ways = Object.keys(SLIDE_WAYS).filter(k => k !== 'center' || openStyle(o).leaves > 1);
        o.slide = ways[(ways.indexOf(slideWay(o, openStyle(o).leaves)) + 1) % ways.length];
      } else if (t.dataset.act === 'door-hinge') o.hinge = o.hinge === 'right' ? 'left' : 'right';
      else o.swing = o.swing === 'out' ? 'in' : 'out';
      save();
      await rerender();
      break;
    }
    case 'unpick': selectedOp = null; await rerender(); break;
    case 'close-wall': selectedWall = null; selectedOp = null; await rerender(); break;
    case 'undo': await undoRedo(true); break;
    case 'redo': await undoRedo(false); break;
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
    case 'add-fcol': {
      // In the middle of the room, then dragged or typed into place.
      const g = geometry(room), xs = g.extent.map(p => p.x), ys = g.extent.map(p => p.y);
      (room.columns ||= []).push({ id: uid(), shape: 'rect', width: 20, depth: 20, x: snap((Math.min(...xs) + Math.max(...xs)) / 2), y: snap((Math.min(...ys) + Math.max(...ys)) / 2) });
      selectedOp = room.columns.at(-1).id;
      save();
      await rerender();
      break;
    }
    case 'del-fcol':
      room.columns = (room.columns || []).filter(x => x.id !== t.dataset.fc);
      save();
      rerender();
      break;
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
    case 'half-circle': w.bulge = bulgeFor(w, 0); save(); rerender(); break;
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
      if (+w.bulge) { alert('A curved wall can\'t be split — make it straight first'); break; }
      // Two straight halves; doors, windows and columns past the middle move to the second half.
      const L = +w.length || 0, h = Math.round(L * 5) / 10;
      const second = { ...newWall(), length: Math.round((L - h) * 10) / 10, turn: w.turn, customTurn: w.customTurn, ...(w.gap ? { gap: true } : {}) };
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
  const target = { project: P, room, wall: w, op: w?.openings.find(o => o.id === el.dataset.o), col: w?.columns?.find(c => c.id === el.dataset.c), shape: room?.shapes?.find(x => x.id === el.dataset.s), fcol: room?.columns?.find(x => x.id === el.dataset.fc) }[scope];
  if (!target) return;
  const v = parseFloat(el.value);
  if (scope === 'wall' && prop === 'radius') {
    if (!(v > 0)) return;
    w.bulge = bulgeFor(w, fromUnit(v, P.unit));
    const b = el.closest('.bulge')?.querySelector('[data-f="wall.bulge"]');
    if (b) b.value = toUnit(w.bulge, P.unit);
    save(`wall.bulge:${w.id}::`);
    refreshPlan();
    return;
  }
  target[prop] = el.type !== 'number' ? el.value : el.value === '' || isNaN(v) ? '' : el.hasAttribute('data-len') ? fromUnit(v, P.unit) : v;
  if (scope === 'op' && prop === 'ref') {
    // Switching the reference keeps the opening where it is; only the measured distance changes.
    const r = w.openings.find(x => x.id === target.ref);
    if (r) target.refGap = Math.max(0, Math.round(((+target.offset || 0) - (+r.offset || 0) - (+r.width || 0)) * 10) / 10);
    else { delete target.ref; delete target.refGap; }
  }
  if (scope === 'op' && prop === 'type' && target.type === 'window' && (target.sill === undefined || target.sill === '')) target.sill = OPEN_DEFAULTS.window.sill;
  if (scope === 'op') resolveRefs(w);
  if (scope === 'wall' && (prop === 'bulge' || prop === 'length')) {
    const r = el.closest('.wall')?.querySelector('[data-f="wall.radius"]');
    if (r) r.value = radiusOf(w) === '' ? '' : toUnit(roundLen(radiusOf(w)), P.unit);
  }
  save(`${key}:${el.dataset.w || ''}:${el.dataset.o || el.dataset.c || el.dataset.s || el.dataset.fc || ''}`);
  if (prop === 'name' && (scope === 'room' || view.name === 'project')) $app.querySelector('.bar h1').textContent = el.value;
  if ((scope === 'wall' && prop === 'kind') || (scope === 'op' && (prop === 'type' || prop === 'style' || prop === 'ref')) || ((scope === 'col' || scope === 'fcol') && prop === 'shape') || (scope === 'op' && prop === 'leaves') || (scope === 'project' && prop === 'unit')) rerender();
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
