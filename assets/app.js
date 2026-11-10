'use strict';

/* สมุด Lineup — static, no build step.
 * Data sources:
 *   data/lineups.json      → lineups committed to the repo (shared by every device)
 *   localStorage lp.local  → edits made in this browser, not yet exported
 *   valorant-api.com       → map minimaps + agent/ability icons (cached locally)
 */

const MAPS_URL = 'https://valorant-api.com/v1/maps';
const AGENTS_URL = 'https://valorant-api.com/v1/agents?isPlayableCharacter=true';
const API_TTL = 3 * 24 * 3600 * 1000;

const LS = {
  local: 'lp.local.v1',
  practiced: 'lp.practiced.v1',
  lastMap: 'lp.lastMap',
  maps: 'lp.api.maps.v1',
  agents: 'lp.api.agents.v1',
};

const TYPES = [
  ['entry', 'เปิดไซต์ (entry)'],
  ['execute', 'Execute'],
  ['post-plant', 'หลังวางบอม (post-plant)'],
  ['retake', 'รีเทค'],
  ['info', 'หาข้อมูล'],
  ['hold', 'ตั้งรับ / หน่วงเวลา'],
  ['smoke', 'จุดวาง smoke'],
  ['other', 'อื่น ๆ'],
];
const TYPE_LABEL = Object.fromEntries(TYPES);
const SIDE_LABEL = { attack: 'บุก', defense: 'รับ' };
const SITES = ['A', 'B', 'C', 'Mid'];
const FIELDS = ['id', 'title', 'map', 'agent', 'ability', 'side', 'site', 'type', 'from', 'to', 'steps', 'throw', 'media', 'tags', 'example'];

/* ---------- helpers ---------- */

const $ = (s, r = document) => r.querySelector(s);
const norm = (s) => String(s ?? '').trim().toLowerCase();
const round3 = (n) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  setProps(n, props);
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}
function svgEl(tag, props) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  setProps(n, props);
  return n;
}
function setProps(n, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.setAttribute('class', v);
    else if (k === 'text') n.textContent = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
}
const isMobile = () => (matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0) && innerWidth < 900;
const safeHref = (u) => (/^\s*(javascript|vbscript|data:text)/i.test(u) ? '#' : u);

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function clean(l) {
  const o = {};
  for (const k of FIELDS) {
    const v = l[k];
    if (v == null || v === '' || v === false || (Array.isArray(v) && !v.length)) continue;
    o[k] = v;
  }
  return o;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  if (t.showPopover) { if (!t.matches(':popover-open')) t.showPopover(); }
  else t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (t.hidePopover && t.matches(':popover-open')) t.hidePopover();
    t.classList.remove('show');
  }, 2800);
}

/* ---------- state ---------- */

const state = {
  maps: [],
  agents: [],
  base: [],
  local: store.get(LS.local, {}),
  practiced: store.get(LS.practiced, {}),
  map: null,
  f: { agents: new Set(), side: 'all', site: 'all', type: 'all', q: '', todo: false },
  selected: null,
  pick: null,
  editing: null,
};

/* ---------- data loading ---------- */

async function loadApi(url, key, pickFn, force) {
  const cached = store.get(key, null);
  if (!force && cached && Date.now() - cached.t < API_TTL && cached.d?.length) return cached.d;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = pickFn((await r.json()).data || []);
    store.set(key, { t: Date.now(), d });
    return d;
  } catch (e) {
    console.warn('โหลดข้อมูลจาก API ไม่ได้', url, e);
    return cached?.d || [];
  }
}

function pickMaps(arr) {
  const seen = new Set();
  return arr
    .filter((m) => m.tacticalDescription && m.displayIcon && m.displayName)
    .filter((m) => !seen.has(norm(m.displayName)) && seen.add(norm(m.displayName)))
    .map((m) => ({ name: m.displayName, icon: m.displayIcon, banner: m.listViewIcon || m.splash || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function pickAgents(arr) {
  const seen = new Set();
  return arr
    .filter((a) => a.displayName && !seen.has(norm(a.displayName)) && seen.add(norm(a.displayName)))
    .map((a) => ({
      name: a.displayName,
      icon: a.displayIcon,
      role: a.role?.displayName || '',
      abilities: (a.abilities || [])
        .filter((x) => x.slot !== 'Passive' && x.displayName)
        .map((x) => ({ name: x.displayName, icon: x.displayIcon })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function loadBase() {
  try {
    const r = await fetch('data/lineups.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const arr = Array.isArray(j) ? j : j.lineups || [];
    return arr.filter((x) => x && typeof x === 'object' && x.id);
  } catch (e) {
    console.warn(e);
    toast(location.protocol === 'file:'
      ? 'เปิดผ่าน file:// ไม่ได้ ให้รันเซิร์ฟเวอร์ (ดู README)'
      : 'โหลด data/lineups.json ไม่ได้');
    return [];
  }
}

/* ---------- lookups ---------- */

const agentOf = (name) => state.agents.find((a) => norm(a.name) === norm(name));
const mapOf = (name) => state.maps.find((m) => norm(m.name) === norm(name));
function iconFor(l) {
  const a = agentOf(l.agent);
  if (!a) return null;
  const ab = a.abilities.find((x) => norm(x.name) === norm(l.ability));
  return ab?.icon || a.icon;
}

function all() {
  const out = [];
  const seen = new Set();
  for (const b of state.base) {
    seen.add(b.id);
    const o = state.local[b.id];
    if (o?._deleted) continue;
    out.push(o ? { ...o, _local: true } : b);
  }
  for (const [id, o] of Object.entries(state.local)) {
    if (!seen.has(id) && !o._deleted) out.push({ ...o, _local: true });
  }
  return out;
}

function mapNames() {
  const names = state.maps.map((m) => m.name);
  for (const l of all()) if (l.map && !names.some((n) => norm(n) === norm(l.map))) names.push(l.map);
  return names;
}
const canonMap = (n) => (n ? mapNames().find((x) => norm(x) === norm(n)) || null : null);

function matches(l, ignoreMap) {
  const f = state.f;
  if (!ignoreMap && norm(l.map) !== norm(state.map)) return false;
  if (f.agents.size && !f.agents.has(norm(l.agent))) return false;
  if (f.side !== 'all' && l.side !== f.side) return false;
  if (f.site !== 'all' && l.site !== f.site) return false;
  if (f.type !== 'all' && l.type !== f.type) return false;
  if (f.todo && state.practiced[l.id]) return false;
  if (f.q) {
    const hay = norm([l.title, l.agent, l.ability, l.steps, l.throw, l.site, (l.tags || []).join(' ')].join(' '));
    if (!norm(f.q).split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}
const visible = () => all().filter((l) => matches(l));

/* ---------- persistence ---------- */

function saveLocal() {
  if (!store.set(LS.local, state.local)) toast('บันทึกในเบราว์เซอร์ไม่ได้ (พื้นที่เต็มหรือถูกปิด)');
}

/** Drop local overrides that the deployed data/lineups.json already contains. */
function pruneLocal() {
  const baseById = new Map(state.base.map((b) => [b.id, b]));
  let changed = false;
  for (const [id, o] of Object.entries(state.local)) {
    const b = baseById.get(id);
    const synced = o._deleted ? !b : b && stable(clean(b)) === stable(clean(o));
    if (synced) { delete state.local[id]; changed = true; }
  }
  if (changed) saveLocal();
}

function togglePracticed(id) {
  if (state.practiced[id]) delete state.practiced[id];
  else state.practiced[id] = true;
  store.set(LS.practiced, state.practiced);
  render();
}

function saveLineup(d) {
  if (!d.id) d.id = newId();
  state.local[d.id] = clean(d);
  saveLocal();
  pruneLocal();
}

function deleteLineup(id) {
  if (state.base.some((b) => b.id === id)) state.local[id] = { id, _deleted: true };
  else delete state.local[id];
  saveLocal();
  pruneLocal();
}

/* ---------- hash routing: #/<map>/<id> ---------- */

function updateHash() {
  const h = '#/' + encodeURIComponent(state.map || '') + (state.selected ? '/' + encodeURIComponent(state.selected) : '');
  if (location.hash !== h) history.replaceState(null, '', h);
}
function readHash() {
  const m = location.hash.match(/^#\/([^/]*)(?:\/(.+))?$/);
  if (!m) return {};
  try { return { map: decodeURIComponent(m[1]), id: m[2] && decodeURIComponent(m[2]) }; } catch { return {}; }
}

/* ---------- rendering ---------- */

function render() {
  renderMaps();
  renderMap();
  renderAgents();
  renderFilters();
  renderList();
  renderUnsynced();
}

function renderMaps() {
  const box = $('#maps');
  const items = all();
  box.replaceChildren();
  for (const name of mapNames()) {
    const n = items.filter((l) => norm(l.map) === norm(name) && matches(l, true)).length;
    const m = mapOf(name);
    const on = norm(name) === norm(state.map);
    box.append(el('button', {
      type: 'button', class: 'map-chip' + (on ? ' on' : ''), 'aria-pressed': String(on),
      onclick: () => setMap(name),
    },
    m?.banner ? el('img', { src: m.banner, alt: '', loading: 'lazy' }) : null,
    el('span', { class: 'nm', text: name }),
    n ? el('span', { class: 'n', text: String(n) }) : null));
  }
  const on = box.querySelector('.on');
  if (on) box.scrollTo({ left: on.offsetLeft - 16 - (box.clientWidth - on.offsetWidth) / 2, behavior: 'instant' });
}

function lineEls(l, cls, svg, pins, interactive) {
  const id = l.id;
  if (l.from && l.to) {
    svg.append(svgEl('line', {
      x1: l.from.x * 1000, y1: l.from.y * 1000, x2: l.to.x * 1000, y2: l.to.y * 1000,
      class: 'ln ' + cls, 'data-id': id,
    }));
  }
  if (l.from) svg.append(svgEl('circle', { cx: l.from.x * 1000, cy: l.from.y * 1000, r: 11, class: 'st ' + cls, 'data-id': id }));
  if (l.to) {
    const icon = iconFor(l);
    pins.append(el(interactive ? 'button' : 'span', {
      type: interactive ? 'button' : null,
      class: 'pin ' + cls, 'data-id': id,
      style: `left:${l.to.x * 100}%;top:${l.to.y * 100}%`,
      title: l.title || '',
      'aria-label': interactive ? (l.title || 'lineup') : null,
      onclick: interactive ? (e) => { e.stopPropagation(); openDetail(id); } : null,
      onmouseenter: interactive ? () => hover(id) : null,
      onmouseleave: interactive ? () => hover(null) : null,
    }, icon ? el('img', { src: icon, alt: '' }) : '◆'));
  }
}

function renderMap() {
  const m = mapOf(state.map);
  const img = $('#mapImg');
  if (m) { if (img.getAttribute('src') !== m.icon) img.src = m.icon; img.alt = 'มินิแมพ ' + m.name; img.hidden = false; }
  else { img.removeAttribute('src'); img.hidden = true; }
  $('#mapNoImg').hidden = !!m || !state.map;

  const svg = $('#mapSvg');
  const pins = $('#pins');
  svg.replaceChildren();
  pins.replaceChildren();

  const sel = state.selected;
  const list = visible().filter((l) => l.from || l.to).sort((a, b) => (a.id === sel) - (b.id === sel));
  for (const l of list) {
    const cls = 'side-' + (l.side || 'none') + (sel && sel !== l.id ? ' dim' : '') + (sel === l.id ? ' sel' : '');
    lineEls(l, cls, svg, pins, true);
  }

  const p = state.pick;
  if (p?.draft?.from) svg.append(svgEl('circle', { cx: p.draft.from.x * 1000, cy: p.draft.from.y * 1000, r: 13, class: 'tmp' }));
  $('#mapWrap').classList.toggle('picking', !!p);
}

function hover(id) {
  for (const n of document.querySelectorAll('#mapWrap [data-id], #list [data-id]')) {
    n.classList.toggle('hl', id != null && n.getAttribute('data-id') === id);
  }
}

function renderAgents() {
  const row = $('#agents');
  const names = [...new Map(all().filter((l) => l.agent).map((l) => {
    const n = agentOf(l.agent)?.name || l.agent;
    return [norm(n), n];
  })).values()].sort((a, b) => a.localeCompare(b));
  row.replaceChildren();
  row.hidden = !names.length;
  if (!names.length) return;
  row.append(el('button', {
    type: 'button', class: 'ag all' + (state.f.agents.size ? '' : ' on'),
    onclick: () => { state.f.agents.clear(); render(); },
  }, 'ทุกเอเจนต์'));
  for (const n of names) {
    const a = agentOf(n);
    const on = state.f.agents.has(norm(n));
    row.append(el('button', {
      type: 'button', class: 'ag' + (on ? ' on' : ''), 'aria-pressed': String(on),
      onclick: () => { if (on) state.f.agents.delete(norm(n)); else state.f.agents.add(norm(n)); render(); },
    }, a ? el('img', { src: a.icon, alt: '' }) : null, el('span', { text: n })));
  }
}

function renderFilters() {
  for (const b of document.querySelectorAll('#side button')) b.classList.toggle('on', b.dataset.v === state.f.side);
}

function chips(l) {
  return [
    l.side ? el('span', { class: 'chip ' + l.side, text: SIDE_LABEL[l.side] || l.side }) : null,
    l.site ? el('span', { class: 'chip', text: 'ไซต์ ' + l.site }) : null,
    l.type ? el('span', { class: 'chip', text: TYPE_LABEL[l.type] || l.type }) : null,
    ...(l.tags || []).map((t) => el('span', { class: 'chip', text: '#' + t })),
    l.example ? el('span', { class: 'chip ex', text: 'ตัวอย่าง' }) : null,
    l._local ? el('span', { class: 'chip warn', text: 'ยังไม่ export' }) : null,
    !l.from && !l.to ? el('span', { class: 'chip', text: 'ไม่มีตำแหน่ง' }) : null,
  ];
}

function renderList() {
  const ul = $('#list');
  const total = all().filter((l) => norm(l.map) === norm(state.map)).length;
  const list = visible().sort((a, b) =>
    (a.site || '~').localeCompare(b.site || '~') || (a.title || '').localeCompare(b.title || '', 'th'));
  $('#count').textContent = total ? `แสดง ${list.length} จาก ${total} lineup บน ${state.map}` : '';
  ul.replaceChildren();

  if (!list.length) {
    ul.append(total
      ? el('li', { class: 'empty' }, 'ไม่มี lineup ที่ตรงกับตัวกรอง')
      : el('li', { class: 'empty' },
        el('span', { text: state.map ? `ยังไม่มี lineup บน ${state.map}` : 'ยังไม่มีข้อมูลแมพ' }),
        state.map ? el('button', { type: 'button', class: 'btn primary', onclick: startAdd }, '+ เพิ่ม lineup แรก') : null));
    return;
  }

  for (const l of list) {
    const icon = iconFor(l);
    const done = !!state.practiced[l.id];
    ul.append(el('li', { class: 'card' + (state.selected === l.id ? ' sel' : ''), 'data-id': l.id },
      el('button', {
        type: 'button', class: 'card-main',
        onclick: () => openDetail(l.id),
        onmouseenter: () => hover(l.id),
        onmouseleave: () => hover(null),
      },
      el('span', { class: 'ab side-' + (l.side || 'none') }, icon ? el('img', { src: icon, alt: '', loading: 'lazy' }) : '◆'),
      el('span', { class: 'card-body' },
        el('span', { class: 'card-title', text: l.title || '(ไม่มีชื่อ)' }),
        el('span', { class: 'card-meta', text: [l.agent, l.ability].filter(Boolean).join(' · ') || '—' }),
        el('span', { class: 'chips' }, chips(l)))),
      el('button', {
        type: 'button', class: 'tick' + (done ? ' on' : ''), 'aria-pressed': String(done),
        title: done ? 'ซ้อมแล้ว (แตะเพื่อยกเลิก)' : 'ทำเครื่องหมายว่าซ้อมแล้ว',
        'aria-label': 'ซ้อมแล้ว',
        onclick: () => togglePracticed(l.id),
      }, '✓')));
  }
}

function renderUnsynced() {
  const n = Object.keys(state.local).length;
  const b = $('#unsynced');
  b.hidden = !n;
  b.textContent = `${n} ยังไม่ export`;
  b.title = 'มีการแก้ไขที่เก็บอยู่แค่ในเบราว์เซอร์นี้ — แตะเพื่อส่งออก lineups.json';
}

/* ---------- map selection ---------- */

function setMap(name) {
  state.map = name;
  state.selected = null;
  store.set(LS.lastMap, name);
  updateHash();
  render();
}

/* ---------- detail ---------- */

function parseMedia(m) {
  if (typeof m === 'string') return m.trim() ? { src: m.trim() } : null;
  return m && typeof m.src === 'string' && m.src.trim() ? { src: m.src.trim(), caption: m.caption } : null;
}

function mediaEl({ src, caption }) {
  let node;
  const yt = src.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) {
    const t = (src.match(/[?&](?:t|start)=(\d+)/) || [])[1];
    node = el('div', { class: 'yt' }, el('iframe', {
      src: `https://www.youtube-nocookie.com/embed/${yt[1]}${t ? '?start=' + t : ''}`,
      title: caption || 'YouTube', loading: 'lazy',
      allow: 'encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true,
    }));
  } else if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src)) {
    node = el('video', { src: safeHref(src), controls: true, muted: true, loop: true, playsinline: true, preload: 'metadata' });
  } else if (/\.(png|jpe?g|webp|gif|avif|bmp)(\?|#|$)/i.test(src) || /^(media\/|data:image\/)/i.test(src)) {
    node = el('a', { href: safeHref(src), target: '_blank', rel: 'noopener' }, el('img', { src: safeHref(src), alt: caption || '', loading: 'lazy' }));
  } else {
    node = el('a', { class: 'link', href: safeHref(src), target: '_blank', rel: 'noopener noreferrer', text: src });
  }
  return el('figure', { class: 'media' }, node, caption ? el('figcaption', { text: caption }) : null);
}

function miniMap(l) {
  const m = mapOf(l.map);
  const wrap = el('div', { class: 'mini' }, m ? el('img', { src: m.icon, alt: 'มินิแมพ ' + m.name }) : null);
  const svg = svgEl('svg', { viewBox: '0 0 1000 1000', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const pins = el('div', { class: 'pins' });
  lineEls(l, 'side-' + (l.side || 'none') + ' sel', svg, pins, false);
  wrap.append(svg, pins);
  return wrap;
}

const section = (title, body) => el('div', { class: 'sec' }, el('h3', { text: title }), body);

function openDetail(id) {
  const l = all().find((x) => x.id === id);
  if (!l) { toast('ไม่พบ lineup นี้'); return; }
  if (norm(l.map) !== norm(state.map)) state.map = canonMap(l.map) || l.map;
  state.selected = id;
  updateHash();
  render();

  const d = $('#detail');
  const icon = iconFor(l);
  const done = !!state.practiced[l.id];
  const media = (l.media || []).map(parseMedia).filter(Boolean);

  d.replaceChildren(el('div', { class: 'sheet-inner' },
    el('header', { class: 'sheet-head' },
      icon ? el('img', { class: 'head-ic', src: icon, alt: '' }) : null,
      el('div', { class: 'grow' },
        el('h2', { text: l.title || '(ไม่มีชื่อ)' }),
        el('div', { class: 'sub', text: [l.agent, l.ability, l.map].filter(Boolean).join(' · ') })),
      el('button', { type: 'button', class: 'btn icon', 'aria-label': 'ปิด', onclick: () => d.close() }, '✕')),
    el('div', { class: 'sheet-body' },
      el('div', { class: 'chips' }, chips(l)),
      l.from || l.to ? miniMap(l) : null,
      l.steps ? section('วิธีทำ', el('div', { class: 'steps', text: l.steps })) : null,
      l.throw ? section('การปา / ยิง', el('p', { text: l.throw })) : null,
      media.length ? section('รูป / คลิป', el('div', { class: 'gallery' }, media.map(mediaEl))) : null,
      !l.steps && !l.throw && !media.length
        ? el('p', { class: 'muted', text: 'ยังไม่มีรายละเอียด กด “แก้ไข” เพื่อเพิ่มวิธีทำหรือรูป' }) : null),
    el('footer', { class: 'sheet-foot' },
      el('button', {
        type: 'button', class: 'btn' + (done ? ' ok' : ''),
        onclick: () => { togglePracticed(l.id); openDetail(l.id); },
      }, done ? '✓ ซ้อมแล้ว' : 'ซ้อมแล้ว?'),
      el('span', { class: 'grow' }),
      el('button', { type: 'button', class: 'btn', onclick: () => copyLink(l) }, 'คัดลอกลิงก์'),
      el('button', { type: 'button', class: 'btn primary', onclick: () => { d.close(); openEditor(l); } }, 'แก้ไข'))));

  if (!d.open) d.showModal();
  d.querySelector('.sheet-body').scrollTop = 0;
}

async function copyLink(l) {
  const url = location.href.split('#')[0] + '#/' + encodeURIComponent(l.map || '') + '/' + encodeURIComponent(l.id);
  try { await navigator.clipboard.writeText(url); toast('คัดลอกลิงก์แล้ว'); }
  catch { window.prompt('คัดลอกลิงก์นี้', url); }
}

/* ---------- editor ---------- */

function fillOptions(select, pairs, value) {
  select.replaceChildren(...pairs.map(([v, t]) => el('option', { value: v, text: t })));
  select.value = value ?? pairs[0]?.[0] ?? '';
}

function fillAbilityList(agentName) {
  const a = agentOf(agentName);
  $('#abilityList').replaceChildren(...(a?.abilities || []).map((x) => el('option', { value: x.name })));
}

function renderPos(d) {
  const set = (sel, v) => { const b = $(sel); b.textContent = v ? 'ตั้งแล้ว ✓' : 'ยังไม่ตั้ง'; b.className = v ? 'ok' : 'no'; };
  set('#posFrom', d.from);
  set('#posTo', d.to);
  if (!d.from && d.to) $('#posFrom').textContent = 'ไม่มี (วางจากแมพ)';
}

function openEditor(src) {
  const exists = !!src?.id && all().some((x) => x.id === src.id);
  const d = { side: 'attack', type: 'other', map: state.map, ...src };
  delete d._local;
  if (!d.agent && state.f.agents.size === 1) {
    const only = [...state.f.agents][0];
    d.agent = agentOf(only)?.name || only;
  }
  state.editing = { draft: d, exists };

  const f = $('#editForm').elements;
  $('#editTitle').textContent = exists ? 'แก้ไข lineup' : 'เพิ่ม lineup';
  f.title.value = d.title || '';
  const names = mapNames();
  if (d.map && !names.some((n) => norm(n) === norm(d.map))) names.push(d.map);
  fillOptions(f.map, names.map((n) => [n, n]), canonMap(d.map) || d.map);
  f.agent.value = d.agent || '';
  fillAbilityList(d.agent);
  f.ability.value = d.ability || '';
  f.side.value = d.side || 'attack';
  fillOptions(f.site, [['', '—'], ...SITES.map((s) => [s, s])], d.site || '');
  fillOptions(f.type, TYPES, d.type || 'other');
  f.steps.value = d.steps || '';
  f.throw.value = d.throw || '';
  f.media.value = (d.media || []).map(parseMedia).filter(Boolean)
    .map((m) => (m.caption ? `${m.src} | ${m.caption}` : m.src)).join('\n');
  f.tags.value = (d.tags || []).join(', ');
  renderPos(d);
  $('#btnDelete').hidden = !exists;
  $('#mobileWarn').hidden = !isMobile();

  const dlg = $('#editor');
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('.sheet-body').scrollTop = 0;
  if (!exists && !d.title) setTimeout(() => f.title.focus(), 50);
}

function readForm() {
  const f = $('#editForm').elements;
  const d = { ...state.editing.draft };
  const agent = f.agent.value.trim();
  d.title = f.title.value.trim();
  d.map = f.map.value;
  d.agent = agentOf(agent)?.name || agent;
  const ab = f.ability.value.trim();
  d.ability = agentOf(d.agent)?.abilities.find((x) => norm(x.name) === norm(ab))?.name || ab;
  d.side = f.side.value;
  d.site = f.site.value;
  d.type = f.type.value;
  d.steps = f.steps.value.trim();
  d.throw = f.throw.value.trim();
  d.media = f.media.value.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [src, ...rest] = s.split('|');
    const caption = rest.join('|').trim();
    return caption ? { src: src.trim(), caption } : src.trim();
  });
  d.tags = f.tags.value.split(',').map((s) => s.trim()).filter(Boolean);
  return d;
}

/* ---------- picking positions on the map ---------- */

function startAdd() {
  if (isMobile()) toast('แก้บนมือถือ: ข้อมูลจะอยู่แค่ในเครื่องนี้ ควรเพิ่มจากคอม');
  if (!state.map) { openEditor({}); return; }
  startPick({ map: state.map }, false);
}

function startPick(draft, fromEditor) {
  if (!mapOf(draft.map)) {
    toast('ไม่มีรูปมินิแมพ — ข้ามการเลือกตำแหน่ง');
    openEditor(draft);
    return;
  }
  state.pick = { step: 'from', draft: { ...draft, from: null, to: null }, prev: draft, fromEditor };
  const dlg = $('#editor');
  if (dlg.open) dlg.close();
  if (norm(draft.map) !== norm(state.map)) state.map = canonMap(draft.map) || draft.map;
  state.selected = null;
  updateHash();
  render();
  updateBanner();
  $('#pickBanner').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateBanner() {
  const b = $('#pickBanner');
  const p = state.pick;
  if (!p) { b.hidden = true; b.replaceChildren(); return; }
  b.hidden = false;
  b.replaceChildren(
    el('span', { class: 'step', text: p.step === 'from' ? '1/2' : '2/2' }),
    el('span', { class: 'grow', text: p.step === 'from' ? 'แตะบนแมพตรงจุดที่ยืน' : 'แตะบนแมพตรงจุดที่สกิลไปตก' }),
    p.step === 'from'
      ? el('button', { type: 'button', class: 'btn sm', onclick: toOnlyPick, title: 'เช่น smoke ที่วางจากแมพ' }, 'ไม่มีจุดยืน')
      : null,
    el('button', { type: 'button', class: 'btn sm', onclick: skipPick }, 'ข้าม'),
    el('button', { type: 'button', class: 'btn sm', onclick: cancelPick }, 'ยกเลิก'));
}

function finishPick(draft) {
  state.pick = null;
  updateBanner();
  renderMap();
  openEditor(draft);
}
function skipPick() {
  const p = state.pick;
  if (!p) return;
  const d = { ...p.prev, ...(p.draft.from ? { from: p.draft.from } : {}), map: state.map };
  finishPick(d);
}
function toOnlyPick() {
  const p = state.pick;
  if (!p) return;
  p.draft.from = null;
  p.step = 'to';
  renderMap();
  updateBanner();
}
function cancelPick() {
  const p = state.pick;
  state.pick = null;
  updateBanner();
  renderMap();
  if (p?.fromEditor) openEditor(p.prev);
}

function onMapClick(e) {
  const p = state.pick;
  if (!p) return;
  const r = e.currentTarget.getBoundingClientRect();
  const pt = { x: round3((e.clientX - r.left) / r.width), y: round3((e.clientY - r.top) / r.height) };
  p.draft.map = state.map;
  if (p.step === 'from') {
    p.draft.from = pt;
    p.step = 'to';
    renderMap();
    updateBanner();
  } else {
    p.draft.to = pt;
    finishPick(p.draft);
  }
}

/* ---------- import / export ---------- */

function exportJson() {
  const items = all().map(clean);
  const blob = new Blob([JSON.stringify(items, null, 2) + '\n'], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'lineups.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`ส่งออก ${items.length} lineup แล้ว — เอาไฟล์ไปแทน data/lineups.json`);
}

async function importJson(file) {
  try {
    const j = JSON.parse(await file.text());
    const arr = Array.isArray(j) ? j : j.lineups;
    if (!Array.isArray(arr)) throw new Error('ไม่ใช่ array');
    let n = 0;
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const c = clean({ ...item, id: item.id || newId() });
      state.local[c.id] = c;
      n++;
    }
    saveLocal();
    pruneLocal();
    render();
    toast(`นำเข้า ${n} รายการ`);
  } catch (e) {
    toast('ไฟล์ไม่ถูกต้อง: ' + e.message);
  }
}

/* ---------- wiring ---------- */

function bindUi() {
  $('#btnAdd').addEventListener('click', startAdd);
  $('#unsynced').addEventListener('click', exportJson);
  $('#mapWrap').addEventListener('click', onMapClick);

  const menu = $('#menu');
  const menuBtn = $('#btnMenu');
  const setMenu = (open) => { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
  menu.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    setMenu(false);
    if (act === 'export') exportJson();
    if (act === 'import') $('#importFile').click();
    if (act === 'refresh') { store.del(LS.maps); store.del(LS.agents); location.reload(); }
    if (act === 'reset') {
      const n = Object.keys(state.local).length;
      if (!n) { toast('ไม่มีการแก้ไขในเครื่องนี้'); return; }
      if (confirm(`ล้าง ${n} การแก้ไขที่ยังไม่ได้ export? กู้คืนไม่ได้`)) { state.local = {}; saveLocal(); render(); toast('ล้างแล้ว'); }
    }
  });
  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importJson(file);
    e.target.value = '';
  });

  // filters
  $('#side').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (v) { state.f.side = v; render(); }
  });
  fillOptions($('#site'), [['all', 'ทุกไซต์'], ...SITES.map((s) => [s, 'ไซต์ ' + s])], 'all');
  fillOptions($('#type'), [['all', 'ทุกประเภท'], ...TYPES], 'all');
  $('#site').addEventListener('change', (e) => { state.f.site = e.target.value; render(); });
  $('#type').addEventListener('change', (e) => { state.f.type = e.target.value; render(); });
  $('#q').addEventListener('input', (e) => { state.f.q = e.target.value; render(); });
  $('#onlyTodo').addEventListener('change', (e) => { state.f.todo = e.target.checked; render(); });

  // dialogs: click on backdrop closes
  for (const d of [$('#detail'), $('#editor')]) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }
  $('#detail').addEventListener('close', () => { state.selected = null; updateHash(); render(); });
  for (const b of document.querySelectorAll('#editor [data-close]')) b.addEventListener('click', () => $('#editor').close());

  // editor
  const form = $('#editForm');
  form.elements.agent.addEventListener('input', (e) => fillAbilityList(e.target.value));
  $('#btnRepick').addEventListener('click', () => {
    const d = readForm();
    startPick(d, true);
  });
  $('#btnDelete').addEventListener('click', () => {
    const d = state.editing?.draft;
    if (!d?.id) return;
    if (!confirm(`ลบ “${d.title || 'lineup นี้'}”?`)) return;
    deleteLineup(d.id);
    $('#editor').close();
    render();
    toast('ลบแล้ว — export เพื่ออัปเดตไฟล์ใน repo');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = readForm();
    if (!d.title) { toast('ใส่ชื่อ lineup ก่อน'); form.elements.title.focus(); return; }
    if (!d.map) { toast('เลือกแมพก่อน'); return; }
    saveLineup(d);
    $('#editor').close();
    state.map = canonMap(d.map) || d.map;
    store.set(LS.lastMap, state.map);
    openDetail(d.id);
    toast('บันทึกในเครื่องแล้ว');
  });

  window.addEventListener('hashchange', () => {
    const h = readHash();
    const m = canonMap(h.map);
    if (h.id && h.id !== state.selected) openDetail(h.id);
    else if (m && norm(m) !== norm(state.map)) setMap(m);
  });

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.pick) cancelPick(); });
}

async function init() {
  bindUi();
  const [maps, agents, base] = await Promise.all([
    loadApi(MAPS_URL, LS.maps, pickMaps),
    loadApi(AGENTS_URL, LS.agents, pickAgents),
    loadBase(),
  ]);
  state.maps = maps;
  state.agents = agents;
  state.base = base;
  pruneLocal();

  $('#agentList').replaceChildren(...agents.map((a) => el('option', { value: a.name, label: a.role })));

  const h = readHash();
  const firstWithData = all().find((l) => l.map)?.map;
  state.map = canonMap(h.map) || canonMap(store.get(LS.lastMap, null)) || canonMap(firstWithData) || mapNames()[0] || null;
  if (!maps.length) toast('โหลดรูปแมพไม่ได้ — เช็กอินเทอร์เน็ต');
  render();
  updateHash();
  if (h.id) openDetail(h.id);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
}

init();
