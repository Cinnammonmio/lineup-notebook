'use strict';

/* ARC (Valorant Lineups) — static, no build step.
 * Data sources:
 *   data/lineups.json      → lineups committed to the repo (shared by every device)
 *   localStorage lp.local  → edits made in this browser, not yet exported
 *   valorant-api.com       → map minimaps + agent/ability icons (cached locally)
 */

/** App version — bump on every release, together with VERSION in sw.js, and note it in CHANGELOG.md. */
const APP_VERSION = '1.2.0';

const MAPS_URL = 'https://valorant-api.com/v1/maps';
const AGENTS_URL = 'https://valorant-api.com/v1/agents?isPlayableCharacter=true';
const API_TTL = 3 * 24 * 3600 * 1000;

const LS = {
  local: 'lp.local.v1',
  practiced: 'lp.practiced.v1',
  lastMap: 'lp.lastMap',
  maps: 'lp.api.maps.v3',
  agent: 'lp.agent',
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
  f: { agents: new Set([store.get(LS.agent, [])].flat().filter((x) => typeof x === 'string')), side: 'all', site: 'all', type: 'all', q: '', todo: false },
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
    .map((m) => ({ name: m.displayName, icon: m.displayIcon, banner: m.listViewIcon || m.splash || null, sites: mapSites(m) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Labels on the minimap — site letters A/B/C and ATTACKER/DEFENDER spawns — from valorant-api callouts (world coords → 0–1). */
function mapSites(m) {
  const k = ['xMultiplier', 'yMultiplier', 'xScalarToAdd', 'yScalarToAdd'];
  if (!k.every((x) => typeof m[x] === 'number')) return [];
  const acc = {};
  for (const c of m.callouts || []) {
    if (!c.location) continue;
    let key = null;
    if (c.regionName === 'Site' && /^[ABC]$/.test(c.superRegionName)) key = c.superRegionName;
    else if (/attack/i.test(c.superRegionName) && /spawn/i.test(c.regionName)) key = 'ATTACKER';
    else if (/defen/i.test(c.superRegionName) && /spawn/i.test(c.regionName)) key = 'DEFENDER';
    if (!key) continue;
    const x = c.location.y * m.xMultiplier + m.xScalarToAdd;
    const y = c.location.x * m.yMultiplier + m.yScalarToAdd;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) continue;
    (acc[key] ||= []).push({ x, y });
  }
  return Object.entries(acc).sort().map(([name, pts]) => ({
    name,
    x: round3(pts.reduce((t, p) => t + p.x, 0) / pts.length),
    y: round3(pts.reduce((t, p) => t + p.y, 0) / pts.length),
  }));
}

function siteLabels(m, box) {
  for (const st of m?.sites || []) {
    const kind = st.name === 'ATTACKER' ? ' spawn atk' : st.name === 'DEFENDER' ? ' spawn def' : '';
    box.append(el('span', { class: 'site-lbl' + kind, style: `left:${st.x * 100}%;top:${st.y * 100}%`, text: st.name }));
  }
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
const byListOrder = (a, b) =>
  (a.site || '~').localeCompare(b.site || '~') || (a.title || '').localeCompare(b.title || '', 'th');

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
  const keepLeft = box.scrollLeft;
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
  box.scrollLeft = keepLeft;
  scrollIntoRowIfHidden(box, on);
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
  siteLabels(m, pins);

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

/** Tap = add/remove one agent. Nothing selected = every agent. */
function toggleAgent(key) {
  if (state.f.agents.has(key)) state.f.agents.delete(key); else state.f.agents.add(key);
  saveAgents();
}
function setAgents(keys) {
  state.f.agents = new Set(keys);
  saveAgents();
}
function saveAgents() {
  store.set(LS.agent, [...state.f.agents]);
  render();
}

function renderAgents() {
  const row = $('#agents');
  const onMap = all().filter((l) => norm(l.map) === norm(state.map));
  const count = (name) => onMap.filter((l) => norm(l.agent) === norm(name)).length;
  // every agent from the API, plus any agent name used in lineups but missing from the API
  const list = state.agents.map((a) => ({ name: a.name, icon: a.icon }));
  for (const l of all()) if (l.agent && !list.some((a) => norm(a.name) === norm(l.agent))) list.push({ name: l.agent });
  list.sort((x, y) => x.name.localeCompare(y.name));
  const keepLeft = row.scrollLeft;
  row.replaceChildren();
  row.hidden = !list.length;
  for (const a of list) {
    const key = norm(a.name);
    const on = state.f.agents.has(key);
    const n = count(a.name);
    row.append(el('button', {
      type: 'button', class: 'ag' + (on ? ' on' : '') + (n ? ' has' : '') + (a.icon ? '' : ' txt'),
      'aria-pressed': String(on), title: a.name, 'aria-label': a.name + (n ? ` (${n})` : ''),
      onclick: () => toggleAgent(key),
    },
    a.icon ? el('img', { src: a.icon, alt: '', loading: 'lazy' }) : el('span', { text: a.name }),
    n ? el('span', { class: 'n', text: String(n) }) : null));
  }
  row.scrollLeft = keepLeft;
  if (!row.dataset.scrolled) { row.dataset.scrolled = '1'; scrollIntoRowIfHidden(row, row.querySelector('.on')); }
}

/** Scroll a horizontal row only when the item is (partly) off screen — never move what the user just tapped. */
function scrollIntoRowIfHidden(row, item) {
  if (!item) return;
  const left = item.offsetLeft - row.offsetLeft;
  if (left < row.scrollLeft || left + item.offsetWidth > row.scrollLeft + row.clientWidth) {
    row.scrollLeft = left - (row.clientWidth - item.offsetWidth) / 2;
  }
}

const SIDE_CYCLE = { all: 'attack', attack: 'defense', defense: 'all' };
function renderFilters() {
  const b = $('#side');
  b.textContent = state.f.side === 'all' ? 'ทั้งหมด' : SIDE_LABEL[state.f.side];
  b.className = 'side-btn ' + state.f.side;
  b.setAttribute('aria-label', 'ฝั่ง: ' + b.textContent + ' (แตะเพื่อสลับ)');
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
  const list = visible().sort(byListOrder);
  const cnt = $('#count');
  const picked = [...state.f.agents].map((k) => agentOf(k)?.name || k);
  const agentName = picked.length ? picked.join(', ') : '';
  const withLineups = [...new Set(all().filter((l) => norm(l.map) === norm(state.map) && l.agent).map((l) => norm(l.agent)))];
  cnt.replaceChildren(
    el('span', { class: 'grow cnt-text', text: (picked.length ? (picked.length > 2 ? `${picked.length} เอเจนต์` : agentName) : 'ทุกเอเจนต์') + ` · ${list.length} lineup` }),
    ...(picked.length
      ? [el('button', { type: 'button', class: 'reset-ag', onclick: () => setAgents([]) }, 'ดูทุกเอเจนต์')]
      : withLineups.length > 1
        ? [el('button', { type: 'button', class: 'reset-ag', title: 'เลือกทุกเอเจนต์ที่มี lineup บนแมพนี้', onclick: () => setAgents(withLineups) }, 'เลือกตัวที่มี lineup')]
        : []));
  ul.replaceChildren();

  if (!list.length) {
    ul.append(total && !agentName
      ? el('li', { class: 'empty' }, 'ไม่มี lineup ที่ตรงกับตัวกรอง')
      : el('li', { class: 'empty' },
        el('span', { text: state.map ? `ยังไม่มี lineup${agentName ? ' ของ ' + agentName : ''} บน ${state.map}` : 'ยังไม่มีข้อมูลแมพ' }),
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
        el('span', { class: 'card-meta' },
          l.side ? el('i', { class: 'side-dot ' + l.side, title: SIDE_LABEL[l.side] }) : null,
          [l.ability || l.agent, l.site && 'ไซต์ ' + l.site, TYPE_LABEL[l.type]].filter(Boolean).join(' · ') || '—'),
        l.example || l._local ? el('span', { class: 'chips' },
          l.example ? el('span', { class: 'chip ex', text: 'ตัวอย่าง' }) : null,
          l._local ? el('span', { class: 'chip warn', text: 'ยังไม่ export' }) : null) : null)),
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
    node = el('video', { src: mediaSrc(src), controls: true, muted: true, loop: true, playsinline: true, preload: 'metadata' });
  } else if (/\.(png|jpe?g|webp|gif|avif|bmp)(\?|#|$)/i.test(src) || /^(media\/|data:image\/)/i.test(src)) {
    node = el('button', { type: 'button', class: 'zoomable', onclick: () => zoom(src, caption), 'aria-label': 'ขยายรูป' },
      el('img', { src: mediaSrc(src), alt: caption || '', loading: 'lazy' }));
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
  siteLabels(m, pins);
  lineEls(l, 'side-' + (l.side || 'none') + ' sel', svg, pins, false);
  wrap.append(svg, pins);
  return wrap;
}

const section = (title, body) => el('div', { class: 'sec' }, el('h3', { text: title }), body);

const IMG_RE = /\.(png|jpe?g|webp|gif|avif|bmp)(\?|#|$)|^data:image\//i;
const STAND_RE = /ยืน|stand/i;
const AIM_RE = /เล็ง|aim|ปา|throw/i;

/** Split media into the stand/aim image pair and everything else. */
function splitMedia(list) {
  const imgs = list.filter((m) => IMG_RE.test(m.src));
  const tagged = (re, suffix) => imgs.find((m) => re.test(m.caption || '') || new RegExp(`-${suffix}\\.\\w+$`, 'i').test(m.src));
  let stand = tagged(STAND_RE, 'stand');
  let aim = tagged(AIM_RE, 'aim');
  if (!stand && !aim && imgs.length) { [stand, aim] = imgs; }
  const rest = list.filter((m) => m !== stand && m !== aim);
  return { stand, aim, rest };
}

function pairFig(m, label, badge) {
  return el('figure', { class: 'pair-fig' },
    m
      ? el('button', { type: 'button', class: 'zoomable', onclick: () => zoom(m.src, label, badge), 'aria-label': 'ขยายรูป' + label },
        el('img', { src: mediaSrc(m.src), alt: label }))
      : el('div', { class: 'pair-empty', text: 'ยังไม่มีรูป' + label }),
    el('figcaption', { text: label }),
    badge ? el('span', { class: 'throw-badge', text: badge }) : null);
}

function zoom(src, caption, badge) {
  const z = $('#zoom');
  z.replaceChildren(el('img', { src: mediaSrc(src), alt: caption || '' }),
    ...(caption ? [el('span', { class: 'zoom-cap', text: caption })] : []),
    ...(badge ? [el('span', { class: 'throw-badge zoom-badge', text: badge })] : []));
  z.showModal();
}

function neighbour(id, dir) {
  const list = visible().sort(byListOrder);
  const i = list.findIndex((x) => x.id === id);
  return i < 0 || list.length < 2 ? null : list[(i + dir + list.length) % list.length];
}

function openDetail(id) {
  const l = all().find((x) => x.id === id);
  if (!l) { toast('ไม่พบ lineup นี้'); return; }
  if (norm(l.map) !== norm(state.map)) state.map = canonMap(l.map) || l.map;
  state.selected = id;
  updateHash();
  render();

  const d = $('#detail');
  const icon = iconFor(l);
  const media = (l.media || []).map(parseMedia).filter(Boolean);
  const { stand, aim, rest } = splitMedia(media);
  const showPair = stand || aim || l.from;
  const prev = neighbour(id, -1);
  const next = neighbour(id, 1);
  const navBtn = (t, label, target) => el('button', {
    type: 'button', class: 'btn icon', 'aria-label': label, title: label, disabled: !target,
    onclick: () => target && openDetail(target.id),
  }, t);

  d.replaceChildren(el('div', { class: 'sheet-inner' },
    el('header', { class: 'sheet-head' },
      icon ? el('img', { class: 'head-ic', src: icon, alt: '' }) : null,
      el('div', { class: 'grow' },
        el('h2', { text: l.title || '(ไม่มีชื่อ)' }),
        el('div', { class: 'sub', text: [l.agent, l.ability, l.site && 'ไซต์ ' + l.site, l.throw].filter(Boolean).join(' · ') })),
      el('button', { type: 'button', class: 'btn sm', onclick: () => { d.close(); openEditor(l); } }, '✎ แก้ไข'),
      navBtn('‹', 'lineup ก่อนหน้า', prev),
      navBtn('›', 'lineup ถัดไป', next),
      el('button', { type: 'button', class: 'btn icon', 'aria-label': 'ปิด', onclick: () => d.close() }, '✕')),
    el('div', { class: 'sheet-body' },
      showPair ? el('div', { class: 'pair' }, pairFig(stand, 'จุดยืน'), pairFig(aim, 'จุดเล็ง', l.throw),
        el('span', { class: 'scroll-hint', 'aria-hidden': 'true', text: '▲ ปัดขึ้นดูวิธีทำ' })) : null,
      el('div', { class: 'detail-cols' },
        el('div', { class: 'detail-text' },
          el('div', { class: 'chips' }, chips(l)),
          l.steps ? section('วิธีทำ', el('div', { class: 'steps', text: l.steps })) : null,
          l.throw ? section('การปา / ยิง', el('p', { text: l.throw })) : null,
          !l.steps && !l.throw && !media.length
            ? el('p', { class: 'muted', text: 'ยังไม่มีรายละเอียด กด “แก้ไข” เพื่อเพิ่มวิธีทำหรือรูป' }) : null),
        l.from || l.to ? miniMap(l) : null),
      rest.length ? section('คลิป / รูปอื่น ๆ', el('div', { class: 'gallery' }, rest.map(mediaEl))) : null)));

  if (!d.open) d.showModal();
  d.querySelector('.sheet-body').scrollTop = 0;
}

/* ---------- local media: images added in the editor live in IndexedDB until exported ---------- */

const mediaDb = {
  _db: null,
  open() {
    this._db ||= new Promise((res, rej) => {
      const r = indexedDB.open('lp-media', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this._db;
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('files', mode);
      const req = fn(t.objectStore('files'));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  },
  get: (k) => mediaDb.run('readonly', (st) => st.get(k)),
  put: (k, v) => mediaDb.run('readwrite', (st) => st.put(v, k)),
  del: (k) => mediaDb.run('readwrite', (st) => st.delete(k)),
  keys: () => mediaDb.run('readonly', (st) => st.getAllKeys()),
};
/** repo path (e.g. media/ascent/x-stand.webp) → object URL, for images that are not in the repo yet */
const localUrls = new Map();
const mediaSrc = (src) => localUrls.get(src) || safeHref(src);

async function loadLocalMedia() {
  try {
    for (const k of await mediaDb.keys()) {
      const v = await mediaDb.get(k);
      if (v?.blob) localUrls.set(k, URL.createObjectURL(v.blob));
    }
  } catch (e) { console.warn('IndexedDB', e); }
}
async function putLocalMedia(path, rec) {
  await mediaDb.put(path, rec);
  if (localUrls.has(path)) URL.revokeObjectURL(localUrls.get(path));
  localUrls.set(path, URL.createObjectURL(rec.blob));
}
async function delLocalMedia(path) {
  try { await mediaDb.del(path); } catch { /* ignore */ }
  if (localUrls.has(path)) { URL.revokeObjectURL(localUrls.get(path)); localUrls.delete(path); }
}
const mediaPaths = (l) => (l.media || []).map(parseMedia).filter(Boolean).map((m) => m.src);

/** Drop stored images that nothing uses any more, or that the site already serves from the repo. */
async function cleanLocalMedia() {
  const used = new Set(Object.values(state.local).flatMap(mediaPaths));
  const inBase = new Set(state.base.flatMap(mediaPaths));
  for (const path of [...localUrls.keys()]) {
    if (used.has(path)) continue;
    if (!inBase.has(path)) { await delLocalMedia(path); continue; }
    try { if ((await fetch(path, { method: 'HEAD', cache: 'no-store' })).ok) await delLocalMedia(path); } catch { /* offline: keep */ }
  }
}

function loadImg(src) {
  return new Promise((res, rej) => {
    const url = src instanceof Blob ? URL.createObjectURL(src) : src;
    const i = new Image();
    i.onload = () => { if (src instanceof Blob) URL.revokeObjectURL(url); res(i); };
    i.onerror = () => rej(new Error('เปิดรูปไม่ได้'));
    i.src = url;
  });
}
/** WebP when the browser can encode it (most can), otherwise JPEG. */
function canvasBlob(c) {
  return new Promise((res) => c.toBlob((b) => {
    if (b && b.type === 'image/webp') res(b); else c.toBlob(res, 'image/jpeg', 0.85);
  }, 'image/webp', 0.8));
}
const MAX_W = 1280;
async function shrinkImage(file) {
  const img = await loadImg(file);
  const k = Math.min(1, MAX_W / img.naturalWidth);
  const c = el('canvas', { width: Math.round(img.naturalWidth * k), height: Math.round(img.naturalHeight * k) });
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return canvasBlob(c);
}
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
const extOf = (blob) => (blob.type === 'image/webp' ? 'webp' : 'jpg');
function shotPath(d, kind, blob, oldSrc) {
  if (oldSrc && /^media\//.test(oldSrc) && oldSrc.endsWith('.' + extOf(blob))) return oldSrc; // overwrite the same file
  return `media/${slug(d.map)}/${[slug(d.agent), slug(d.site), slug(d.ability), d.id, kind].join('-')}.${extOf(blob)}`;
}

/* ---------- editor ---------- */

const SHOT_LABEL = { stand: 'จุดยืน', aim: 'จุดเล็ง' };
const THROWS = ['ปาปกติ', 'กระโดดแล้วปา'];
const TYPE_SHORT = { entry: 'Entry', execute: 'Execute', 'post-plant': 'Post-plant', retake: 'Retake', info: 'Info', hold: 'Hold', smoke: 'Smoke', other: '' };

function autoTitle(d) {
  const head = [d.ability || d.agent, d.site].filter(Boolean).join(' ');
  return [head, TYPE_SHORT[d.type]].filter(Boolean).join(' · ');
}

function fillOptions(select, pairs, value) {
  select.replaceChildren(...pairs.map(([v, t]) => el('option', { value: v, text: t })));
  select.value = value ?? pairs[0]?.[0] ?? '';
}

function renderPos(d) {
  const set = (sel, v) => { const b = $(sel); b.textContent = v ? 'ตั้งแล้ว ✓' : 'ยังไม่ตั้ง'; b.className = v ? 'ok' : 'no'; };
  set('#posFrom', d.from);
  set('#posTo', d.to);
  if (!d.from && d.to) $('#posFrom').textContent = 'ไม่มี (วางจากแมพ)';
}

function pickBtn(cls, on, label, onclick, ...kids) {
  return el('button', { type: 'button', class: cls + (on ? ' on' : ''), role: 'radio', 'aria-checked': String(on), title: label, 'aria-label': label, onclick }, ...kids);
}

function renderPickers() {
  const d = state.editing.draft;
  const change = (k, v) => {
    d[k] = v;
    if (k === 'agent' && !agentOf(v)?.abilities.some((x) => norm(x.name) === norm(d.ability))) d.ability = '';
    renderPickers();
    updateTitle();
  };
  const textFallback = (k, ph) => el('input', { class: 'pk-text', value: d[k] || '', placeholder: ph, oninput: (e) => { d[k] = e.target.value.trim(); updateTitle(); } });

  const maps = mapNames();
  if (d.map && !maps.some((n) => norm(n) === norm(d.map))) maps.push(d.map);
  $('#pickMap').replaceChildren(...maps.map((n) => {
    const m = mapOf(n);
    return pickBtn('pk-map', norm(n) === norm(d.map), n, () => change('map', n),
      m?.banner ? el('img', { src: m.banner, alt: '' }) : null, el('span', { text: n }));
  }));

  $('#pickAgent').replaceChildren(...(state.agents.length
    ? state.agents.map((a) => pickBtn('pk-ag', norm(a.name) === norm(d.agent), a.name, () => change('agent', a.name), el('img', { src: a.icon, alt: '' })))
    : [textFallback('agent', 'ชื่อเอเจนต์ เช่น Brimstone')]));

  const abilities = agentOf(d.agent)?.abilities || [];
  $('#pickAbility').replaceChildren(...(abilities.length
    ? abilities.map((x) => pickBtn('pk-ab', norm(x.name) === norm(d.ability), x.name, () => change('ability', x.name),
      x.icon ? el('img', { src: x.icon, alt: '' }) : null, el('span', { text: x.name })))
    : d.agent && !state.agents.length ? [textFallback('ability', 'ชื่อสกิล เช่น Incendiary')]
      : [el('span', { class: 'muted-s', text: 'เลือกเอเจนต์ก่อน' })]));

  for (const id of ['#pickMap', '#pickAgent', '#pickAbility']) scrollIntoRowIfHidden($(id), $(id).querySelector('.on'));
}

function updateTitle() {
  const f = $('#editForm').elements;
  const auto = autoTitle(readForm());
  if (!state.editing.titleManual) f.title.value = auto;
  $('#titleMode').textContent = state.editing.titleManual ? '(ตั้งเอง)' : '(อัตโนมัติ)';
  $('#btnAutoTitle').hidden = !state.editing.titleManual;
}

function renderShots() {
  const ed = state.editing;
  const throwText = readThrow();
  for (const box of document.querySelectorAll('#editor .shot')) {
    const kind = box.dataset.kind;
    const s = ed.shots[kind];
    const label = SHOT_LABEL[kind];
    box.classList.toggle('active', ed.activeShot === kind);
    box.classList.toggle('has', !!s);
    box.replaceChildren(...(s
      ? [
        el('img', { src: s.url, alt: label }),
        el('span', { class: 'cap', text: label }),
        kind === 'aim' && throwText ? el('span', { class: 'throw-badge', text: throwText }) : null,
        el('span', { class: 'shot-tools' },
          el('button', { type: 'button', title: 'ไฮไลต์', onclick: (e) => { e.stopPropagation(); annotateShot(kind); } }, '✎ ไฮไลต์'),
          el('button', { type: 'button', title: 'เปลี่ยนรูป', onclick: (e) => { e.stopPropagation(); chooseShot(kind); } }, 'เปลี่ยน'),
          el('button', { type: 'button', title: 'ลบรูป', onclick: (e) => { e.stopPropagation(); ed.shots[kind] = null; renderShots(); } }, '✕')),
      ].filter(Boolean)
      : [el('button', { type: 'button', class: 'shot-empty', onclick: () => chooseShot(kind) },
        el('b', { text: '+ รูป' + label }), el('small', { text: 'แตะเพื่อเลือก · Ctrl+V · ลากไฟล์มาวาง' }))]));
  }
}

function chooseShot(kind) {
  state.editing.activeShot = kind;
  renderShots();
  $('#shotFile').click();
}

async function setShotFile(kind, file) {
  if (!file?.type?.startsWith('image/')) { toast('ไฟล์นี้ไม่ใช่รูป'); return; }
  try {
    const blob = await shrinkImage(file);
    state.editing.shots[kind] = { ...state.editing.shots[kind], blob, orig: blob, shapes: [], url: URL.createObjectURL(blob), dirty: true };
    state.editing.activeShot = kind === 'stand' && !state.editing.shots.aim ? 'aim' : kind;
    renderShots();
  } catch (e) { toast(e.message); }
}

async function annotateShot(kind) {
  const s = state.editing.shots[kind];
  if (!s) return;
  let { orig, shapes } = s;
  if (!orig && s.src && localUrls.has(s.src)) {
    const rec = await mediaDb.get(s.src).catch(() => null);
    orig = rec?.orig; shapes = rec?.shapes;
  }
  if (!orig) {
    try { orig = await (await fetch(s.url)).blob(); } catch { toast('โหลดรูปเพื่อไฮไลต์ไม่ได้'); return; }
  }
  const out = await openAnnot(orig, shapes || [], SHOT_LABEL[kind]);
  if (!out) return;
  state.editing.shots[kind] = { ...s, orig, blob: out.blob, shapes: out.shapes, url: URL.createObjectURL(out.blob), dirty: true };
  renderShots();
}

function readThrow() {
  const f = $('#editForm').elements;
  return f.throwSel.value === '__other' ? f.throw.value.trim() : f.throwSel.value;
}

function openEditor(src) {
  const exists = !!src?.id && all().some((x) => x.id === src.id);
  const d = { side: 'attack', type: 'other', map: state.map, ...src };
  delete d._local;
  if (!d.agent && state.f.agents.size === 1) {
    const only = [...state.f.agents][0];
    d.agent = agentOf(only)?.name || only;
  }
  const media = (d.media || []).map(parseMedia).filter(Boolean);
  const { stand, aim, rest } = splitMedia(media);
  const fromMedia = (m) => (m ? { src: m.src, url: mediaSrc(m.src) } : null);
  state.editing = {
    draft: d, exists,
    shots: d._shots || { stand: fromMedia(stand), aim: fromMedia(aim) },
    activeShot: null,
    titleManual: d._titleManual ?? (!!d.title && d.title !== autoTitle(d)),
  };
  delete d._shots; delete d._titleManual;

  const f = $('#editForm').elements;
  $('#editTitle').textContent = exists ? 'แก้ไข lineup' : 'เพิ่ม lineup';
  f.title.value = d.title || '';
  f.side.value = d.side || 'attack';
  fillOptions(f.site, [['', '—'], ...SITES.map((x) => [x, x])], d.site || '');
  fillOptions(f.type, TYPES, d.type || 'other');
  const known = !d.throw || THROWS.includes(d.throw);
  f.throwSel.value = known ? (d.throw || '') : '__other';
  f.throw.value = known ? '' : d.throw;
  $('#throwOtherWrap').hidden = known;
  f.steps.value = d.steps || '';
  f.media.value = (d._restText ?? rest.map((m) => (m.caption ? `${m.src} | ${m.caption}` : m.src)).join('\n'));
  delete d._restText;
  f.tags.value = (d.tags || []).join(', ');
  renderPos(d);
  renderPickers();
  updateTitle();
  renderShots();
  $('#btnDelete').hidden = !exists;
  $('#mobileWarn').hidden = !isMobile();

  const dlg = $('#editor');
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('.sheet-body').scrollTop = 0;
}

/** Form → lineup fields (map/agent/ability live on the draft, set by the icon pickers). */
function readForm() {
  const f = $('#editForm').elements;
  const d = { ...state.editing.draft };
  d.title = f.title.value.trim();
  d.agent = agentOf(d.agent)?.name || d.agent || '';
  d.ability = agentOf(d.agent)?.abilities.find((x) => norm(x.name) === norm(d.ability))?.name || d.ability || '';
  d.side = f.side.value;
  d.site = f.site.value;
  d.type = f.type.value;
  d.steps = f.steps.value.trim();
  d.throw = readThrow();
  d.tags = f.tags.value.split(',').map((x) => x.trim()).filter(Boolean);
  return d;
}
const readRestMedia = () => $('#editForm').elements.media.value.split('\n').map((x) => x.trim()).filter(Boolean).map((x) => {
  const [src, ...more] = x.split('|');
  const caption = more.join('|').trim();
  return caption ? { src: src.trim(), caption } : src.trim();
});

/** Save images to IndexedDB under their future repo path and build the media list. */
async function buildMedia(d) {
  const out = [];
  for (const kind of ['stand', 'aim']) {
    const sh = state.editing.shots[kind];
    if (!sh) continue;
    let src = sh.src;
    if (sh.dirty) {
      src = shotPath(d, kind, sh.blob, sh.src);
      await putLocalMedia(src, { blob: sh.blob, orig: sh.orig, shapes: sh.shapes || [] });
    }
    out.push({ src, caption: SHOT_LABEL[kind] });
  }
  return [...out, ...readRestMedia()];
}

/* ---------- highlight tool ---------- */

const annot = { img: null, shapes: [], tool: 'circle', color: '#ff4655', cur: null, resolve: null };

async function openAnnot(blob, shapes, label) {
  annot.img = await loadImg(blob);
  annot.shapes = JSON.parse(JSON.stringify(shapes));
  const c = $('#annotCanvas');
  const k = Math.min(1, MAX_W / annot.img.naturalWidth);
  c.width = Math.round(annot.img.naturalWidth * k);
  c.height = Math.round(annot.img.naturalHeight * k);
  $('#annot').setAttribute('aria-label', 'ไฮไลต์รูป' + label);
  drawAnnot();
  $('#annot').showModal();
  return new Promise((res) => { annot.resolve = res; });
}

function drawShape(ctx, sh, w, h) {
  const lw = Math.max(3, Math.round(w / 200));
  ctx.save();
  ctx.strokeStyle = sh.color; ctx.fillStyle = sh.color; ctx.lineWidth = lw;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = lw * 1.5;
  ctx.beginPath();
  if (sh.type === 'circle') {
    const cx = (sh.x1 + sh.x2) / 2 * w, cy = (sh.y1 + sh.y2) / 2 * h;
    ctx.ellipse(cx, cy, Math.abs(sh.x2 - sh.x1) / 2 * w || 1, Math.abs(sh.y2 - sh.y1) / 2 * h || 1, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (sh.type === 'arrow') {
    const x1 = sh.x1 * w, y1 = sh.y1 * h, x2 = sh.x2 * w, y2 = sh.y2 * h;
    const a = Math.atan2(y2 - y1, x2 - x1), hl = lw * 4.5;
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - hl * Math.cos(a - 0.45), y2 - hl * Math.sin(a - 0.45));
    ctx.lineTo(x2 - hl * Math.cos(a + 0.45), y2 - hl * Math.sin(a + 0.45));
    ctx.closePath(); ctx.fill();
  } else if (sh.type === 'pen') {
    sh.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
    ctx.stroke();
  }
  ctx.restore();
}

function drawAnnot() {
  const c = $('#annotCanvas');
  const ctx = c.getContext('2d');
  ctx.drawImage(annot.img, 0, 0, c.width, c.height);
  for (const sh of annot.shapes) drawShape(ctx, sh, c.width, c.height);
}

function closeAnnot(result) {
  const r = annot.resolve;
  annot.resolve = null;
  if ($('#annot').open) $('#annot').close();
  r?.(result);
}

function bindAnnot() {
  const c = $('#annotCanvas');
  const pt = (e) => {
    const r = c.getBoundingClientRect();
    return [round3((e.clientX - r.left) / r.width), round3((e.clientY - r.top) / r.height)];
  };
  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId);
    const [x, y] = pt(e);
    annot.cur = annot.tool === 'pen'
      ? { type: 'pen', color: annot.color, pts: [[x, y]] }
      : { type: annot.tool, color: annot.color, x1: x, y1: y, x2: x, y2: y };
    annot.shapes.push(annot.cur);
  });
  c.addEventListener('pointermove', (e) => {
    if (!annot.cur) return;
    const [x, y] = pt(e);
    if (annot.cur.type === 'pen') annot.cur.pts.push([x, y]); else { annot.cur.x2 = x; annot.cur.y2 = y; }
    drawAnnot();
  });
  const end = () => {
    const sh = annot.cur;
    annot.cur = null;
    if (sh && sh.type !== 'pen' && Math.hypot(sh.x2 - sh.x1, sh.y2 - sh.y1) < 0.01) annot.shapes.pop(); // a tap, not a drag
    drawAnnot();
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);

  $('#annot').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) { annot.tool = b.dataset.tool; for (const x of b.parentNode.children) x.classList.toggle('on', x === b); }
    if (b.dataset.color) { annot.color = b.dataset.color; for (const x of b.parentNode.children) x.classList.toggle('on', x === b); }
    const act = b.dataset.annot;
    if (act === 'undo') { annot.shapes.pop(); drawAnnot(); }
    if (act === 'clear') { annot.shapes = []; drawAnnot(); }
    if (act === 'cancel') closeAnnot(null);
    if (act === 'done') closeAnnot({ blob: await canvasBlob(c), shapes: annot.shapes });
  });
  $('#annot').addEventListener('close', () => closeAnnot(null));
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

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** Minimal ZIP (stored, no compression) — images are already compressed. */
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nm = enc.encode(name), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true);
    parts.push(lh, nm, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
    central.push(ch, nm);
    offset += 30 + nm.length + data.length;
  }
  const size = central.reduce((t, p) => t + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function exportJson() {
  const items = all().map(clean);
  const json = JSON.stringify(items, null, 2) + '\n';
  const paths = [...new Set(items.flatMap(mediaPaths))].filter((p) => localUrls.has(p));
  if (!paths.length) {
    download(new Blob([json], { type: 'application/json' }), 'lineups.json');
    toast(`ส่งออก ${items.length} lineup แล้ว — เอาไฟล์ไปแทน data/lineups.json`);
    return;
  }
  const files = [{ name: 'data/lineups.json', data: new TextEncoder().encode(json) }];
  for (const p of paths) {
    const rec = await mediaDb.get(p).catch(() => null);
    if (rec?.blob) files.push({ name: p, data: new Uint8Array(await rec.blob.arrayBuffer()) });
  }
  download(makeZip(files), 'lineups-export.zip');
  toast(`ส่งออก ${items.length} lineup + ${files.length - 1} รูป — แตก zip ลงโฟลเดอร์ repo (ทับไฟล์เดิม) แล้ว push`);
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
    e.stopPropagation();
    state.f.side = SIDE_CYCLE[state.f.side] || 'all';
    render();
  });

  // dialogs: click on backdrop closes
  for (const d of [$('#detail'), $('#editor')]) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }
  $('#detail').addEventListener('close', () => { state.selected = null; updateHash(); render(); });
  for (const b of document.querySelectorAll('#editor [data-close]')) b.addEventListener('click', () => $('#editor').close());

  // editor
  const form = $('#editForm');
  const fe = form.elements;
  for (const n of ['side', 'site', 'type']) fe[n].addEventListener('change', updateTitle);
  fe.title.addEventListener('input', () => {
    const v = fe.title.value.trim();
    state.editing.titleManual = !!v && v !== autoTitle(readForm());
    updateTitle();
  });
  $('#btnAutoTitle').addEventListener('click', () => { state.editing.titleManual = false; updateTitle(); });
  fe.throwSel.addEventListener('change', () => {
    $('#throwOtherWrap').hidden = fe.throwSel.value !== '__other';
    if (fe.throwSel.value === '__other') fe.throw.focus();
    renderShots();
  });
  fe.throw.addEventListener('input', renderShots);
  $('#shotFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file && state.editing?.activeShot) setShotFile(state.editing.activeShot, file);
    e.target.value = '';
  });
  for (const box of document.querySelectorAll('#editor .shot')) {
    box.addEventListener('click', () => { state.editing.activeShot = box.dataset.kind; renderShots(); });
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drop'); });
    box.addEventListener('dragleave', () => box.classList.remove('drop'));
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      box.classList.remove('drop');
      const file = e.dataTransfer?.files?.[0];
      if (file) setShotFile(box.dataset.kind, file);
    });
  }
  document.addEventListener('paste', (e) => {
    if (!$('#editor').open || $('#annot').open) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const ed = state.editing;
    const kind = ed.activeShot || (!ed.shots.stand ? 'stand' : !ed.shots.aim ? 'aim' : 'stand');
    setShotFile(kind, item.getAsFile());
  });
  bindAnnot();
  $('#btnRepick').addEventListener('click', () => {
    const d = readForm();
    d._shots = state.editing.shots;
    d._titleManual = state.editing.titleManual;
    d._restText = fe.media.value;
    startPick(d, true);
  });
  $('#btnDelete').addEventListener('click', () => {
    const d = state.editing?.draft;
    if (!d?.id) return;
    if (!confirm(`ลบ “${d.title || 'lineup นี้'}”?`)) return;
    deleteLineup(d.id);
    cleanLocalMedia();
    $('#editor').close();
    render();
    toast('ลบแล้ว — export เพื่ออัปเดตไฟล์ใน repo');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = readForm();
    if (!d.map) { toast('เลือกแมพก่อน'); return; }
    if (!d.title) d.title = autoTitle(d) || 'Lineup';
    d.id ||= newId();
    try { d.media = await buildMedia(d); } catch (err) { toast('บันทึกรูปไม่ได้: ' + err.message); return; }
    saveLineup(d);
    cleanLocalMedia();
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

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.pick) cancelPick();
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && $('#detail').open && !$('#zoom').open && state.selected) {
      const n = neighbour(state.selected, e.key === 'ArrowLeft' ? -1 : 1);
      if (n) openDetail(n.id);
    }
  });
  $('#zoom').addEventListener('click', () => $('#zoom').close());
}

const LANDSCAPE_PHONE = matchMedia('(orientation: landscape) and (max-height: 600px)');
/** Landscape phone: header + map chips live in the right column so the map can use the full height. */
function placeMapChips() {
  const top = $('header.top');
  const maps = $('#maps');
  if (LANDSCAPE_PHONE.matches) $('.list-col').prepend(top, maps);
  else { document.body.prepend(top); $('main.layout').before(maps); }
}

async function init() {
  for (const n of document.querySelectorAll('[data-version]')) n.textContent = 'v' + APP_VERSION;
  bindUi();
  placeMapChips();
  LANDSCAPE_PHONE.addEventListener('change', placeMapChips);
  const [maps, agents, base] = await Promise.all([
    loadApi(MAPS_URL, LS.maps, pickMaps),
    loadApi(AGENTS_URL, LS.agents, pickAgents),
    loadBase(),
  ]);
  state.maps = maps;
  state.agents = agents;
  state.base = base;
  await loadLocalMedia();
  pruneLocal();
  cleanLocalMedia();


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
