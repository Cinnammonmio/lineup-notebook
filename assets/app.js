'use strict';

/* ARC (Valorant Lineups) — static, no build step.
 * Data sources:
 *   data/lineups.json      → lineups committed to the repo (shared by every device)
 *   localStorage lp.local  → edits made in this browser, not yet exported
 *   valorant-api.com       → map minimaps + agent/ability icons (cached locally)
 */

/** App version — bump on every release, together with VERSION in sw.js, and note it in CHANGELOG.md. */
const APP_VERSION = '1.17.2';

const MAPS_URL = 'https://valorant-api.com/v1/maps';
const AGENTS_URL = 'https://valorant-api.com/v1/agents?isPlayableCharacter=true';
const API_TTL = 3 * 24 * 3600 * 1000;

const LS = {
  local: 'lp.local.v1',
  practiced: 'lp.practiced.v1',
  lastMap: 'lp.lastMap',
  maps: 'lp.api.maps.v4',
  role: 'lp.agentRole',
  filters: 'lp.filters',
  agent: 'lp.agent',
  gh: 'lp.github.v1',
  fit: 'lp.detailFit',
  pushed: 'lp.pushed.v1',
  agents: 'lp.api.agents.v3',
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
const FIELDS = ['id', 'kind', 'title', 'map', 'agent', 'ability', 'side', 'site', 'type', 'from', 'to', 'steps', 'throw', 'media', 'layout', 'items', 'smokes', 'tags', 'by', 'example'];

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
  f: { agents: new Set([store.get(LS.agent, [])].flat().filter((x) => typeof x === 'string')), role: store.get(LS.role, 'all'), side: 'all', site: 'all', type: 'all', q: '', todo: false, ...store.get(LS.filters, {}) },
  selected: null,
  plan: null,
  peek: null,
  hoverPlan: null,
  smokePick: null,
  tab: 'lineups',
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
    .map((m) => ({
      name: m.displayName, icon: m.displayIcon, banner: m.listViewIcon || m.splash || null, sites: mapSites(m),
      scale: Math.abs(m.xMultiplier) || null, // minimap share of width per game unit (1 unit = 1 cm)
    }))
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
    // long words (ATTACKER/DEFENDER) are kept away from the edge so they aren't cut off
    const lim = kind ? 0.15 : 0.04;
    const x = Math.min(1 - lim, Math.max(lim, st.x)), y = Math.min(0.95, Math.max(0.05, st.y));
    box.append(el('span', { class: 'site-lbl' + kind, style: `left:${x * 100}%;top:${y * 100}%`, text: st.name }));
  }
}

/** Hand-picked theme colours (valorant-api's gradients share similar purples, so picking from them isn't reliable). */
const AGENT_COLORS = {
  astra: '#b77cf2', breach: '#f2903d', brimstone: '#e0703a', chamber: '#e6c56b', clove: '#e27ad8',
  cypher: '#bfcbd6', deadlock: '#8fb4d9', fade: '#8e7fe0', gekko: '#b6f04a', harbor: '#2fc0cf',
  iso: '#8c6cf2', jett: '#8fd6ff', 'kay/o': '#5fa8ff', killjoy: '#ffd23f', neon: '#3d86ff',
  omen: '#7175e0', phoenix: '#ff6a33', raze: '#ffa62b', reyna: '#c95ae0', sage: '#3fd9b8',
  skye: '#7fd65a', sova: '#55a4ff', tejo: '#e8b04a', viper: '#3fe07d', vyse: '#a88ce0',
  waylay: '#ff8fb8', yoru: '#4a62ff', veto: '#d9d9e8',
};
/** Fallback for agents not in the list: the most vivid of valorant-api's background gradient colours. */
function agentColor(list) {
  let best = null;
  for (const hex of list || []) {
    const m = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '');
    if (!m) continue;
    const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    const d = max - min, sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    const score = sat * (1 - Math.abs(l - 0.55));
    if (!best || score > best.score) best = { score, h: (h * 60 + 360) % 360, sat };
  }
  if (!best) return null;
  return `hsl(${Math.round(best.h)} ${Math.round(Math.max(0.6, Math.min(0.9, best.sat)) * 100)}% 62%)`;
}
const colorFor = (l) => agentOf(l.agent)?.color || null;

function pickAgents(arr) {
  const seen = new Set();
  return arr
    .filter((a) => a.displayName && !seen.has(norm(a.displayName)) && seen.add(norm(a.displayName)))
    .map((a) => ({
      name: a.displayName,
      icon: a.displayIcon,
      color: AGENT_COLORS[norm(a.displayName)] || agentColor(a.backgroundGradientColors),
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

const isPlan = (x) => x?.kind === 'plan';
/** Lineups only (plans are stored in the same list, see plans()). */
const all = () => allItems().filter((x) => !isPlan(x));
const plans = () => allItems().filter(isPlan);
const activePlan = () => (state.plan ? plans().find((x) => x.id === state.plan) || null : null);

function allItems() {
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
  const plan = activePlan();
  if (plan) return (plan.items || []).includes(l.id); // a plan shows exactly its lineups
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
/** Visible lineups in list order (plan order while a plan is open). */
function sortedVisible() {
  const plan = activePlan();
  const list = visible();
  return plan ? list.sort((a, b) => plan.items.indexOf(a.id) - plan.items.indexOf(b.id)) : list.sort(byListOrder);
}
const byListOrder = (a, b) =>
  (a.site || '~').localeCompare(b.site || '~') || (a.title || '').localeCompare(b.title || '', 'th');

/* ---------- persistence ---------- */

function saveLocal() {
  if (!store.set(LS.local, state.local)) toast('บันทึกในเบราว์เซอร์ไม่ได้ (พื้นที่เต็มหรือถูกปิด)');
}

/** Drop local overrides that the deployed data/lineups.json already contains. */
function pruneLocal() {
  const baseById = new Map(state.base.map((b) => [b.id, b]));
  const pushed = store.get(LS.pushed, {});
  let changed = false;
  for (const [id, o] of Object.entries(state.local)) {
    const b = baseById.get(id);
    // a deletion is done once the site no longer has it AND GitHub can't still have it (pushed but not deployed yet)
    const synced = o._deleted
      ? !b && (!(id in pushed) || pushed[id] === DELETED)
      : b && stable(clean(b)) === stable(clean(o));
    if (synced) { delete state.local[id]; delete pushed[id]; changed = true; }
  }
  for (const id of Object.keys(pushed)) if (!state.local[id]) { delete pushed[id]; changed = true; }
  store.set(LS.pushed, pushed);
  if (changed) saveLocal();
}
const DELETED = '__deleted__';

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
  for (const pl of plans()) {
    if ((pl.items || []).includes(id)) saveLocalPlanItems(pl, pl.items.filter((x) => x !== id));
  }
  if (state.base.some((b) => b.id === id) || id in store.get(LS.pushed, {})) state.local[id] = { id, _deleted: true };
  else delete state.local[id];
  saveLocal();
  pruneLocal();
}

function saveLocalPlanItems(pl, items) {
  const o = { ...pl, items };
  delete o._local;
  state.local[pl.id] = clean(o);
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
  // keep an open preview only while its pin is still on the map
  if (state.peek) {
    if (document.querySelector(`#pins .pin[data-id="${CSS.escape(state.peek.anchor)}"]`)) renderPeek(); else closePeek();
  }
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

function lineEls(l, cls, svg, pins, interactive, num) {
  const id = l.id;
  const col = colorFor(l); // agent colour; the side shows as the start dot's ring
  if (l.from && l.to) {
    svg.append(svgEl('line', {
      x1: l.from.x * 1000, y1: l.from.y * 1000, x2: l.to.x * 1000, y2: l.to.y * 1000,
      class: 'ln ' + cls, 'data-id': id, style: col ? `stroke:${col}` : null,
    }));
  }
  if (l.from) svg.append(svgEl('circle', { cx: l.from.x * 1000, cy: l.from.y * 1000, r: 11, class: 'st ' + cls, 'data-id': id, style: col ? `fill:${col}` : null }));
  if (l.to) {
    const icon = iconFor(l);
    pins.append(el(interactive ? 'button' : 'span', {
      type: interactive ? 'button' : null,
      class: 'pin ' + cls, 'data-id': id,
      style: `left:${l.to.x * 100}%;top:${l.to.y * 100}%` + (col ? `;--ag:${col}` : ''),
      title: l.title || '',
      'aria-label': interactive ? (l.title || 'lineup') : null,
      onclick: interactive ? (e) => { e.stopPropagation(); if (touchUi()) selectFromPin(id); else peekAt(id); } : null,
      onmouseenter: interactive ? () => hover(id) : null,
      onmouseleave: interactive ? () => hover(null) : null,
    }, icon ? el('img', { src: icon, alt: '' }) : '◆', num ? el('span', { class: 'pin-n', text: String(num) }) : null));
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
  // hovering a plan card in the plan list previews that plan on the map
  const preview = state.tab === 'plans' && !state.plan && state.hoverPlan ? plans().find((x) => x.id === state.hoverPlan) : null;
  const plan = activePlan() || preview;
  // plan tab with nothing opened: show what every plan on this map uses
  const allPlans = state.tab === 'plans' && !plan ? plans().filter((x) => norm(x.map) === norm(state.map)) : null;
  const onMap = (l) => norm(l.map) === norm(state.map);
  const pool = preview ? all().filter((l) => onMap(l) && preview.items.includes(l.id))
    : allPlans ? all().filter((l) => onMap(l) && allPlans.some((x) => (x.items || []).includes(l.id)))
      : visible();
  const list = pool.filter((l) => l.from || l.to).sort((a, b) => (a.id === sel) - (b.id === sel));
  for (const l of list) {
    const cls = 'side-' + (l.side || 'none') + (sel && sel !== l.id ? ' dim' : '') + (sel === l.id ? ' sel' : '');
    lineEls(l, cls, svg, pins, true, plan ? plan.items.indexOf(l.id) + 1 : 0);
  }

  // smokes placed directly in a plan (no lineup needed)
  const smokes = state.smokePick ? state.planEdit?.smokes || [] : plan?.smokes || (allPlans || []).flatMap((x) => x.smokes || []);
  for (const sm of smokes) pins.prepend(smokeEl(sm));

  const p = state.pick;
  if (p?.draft?.from) svg.append(svgEl('circle', { cx: p.draft.from.x * 1000, cy: p.draft.from.y * 1000, r: 13, class: 'tmp' }));
  $('#mapWrap').classList.toggle('picking', !!p || !!state.smokePick);

  state.drawn = { list, smokes, plan };
  zoomForState();
}

/** Zoom the map to whatever is chosen: a highlighted lineup, or an opened / previewed plan. */
function zoomForState() {
  const d = state.drawn;
  if (!d) return;
  const sel = state.selected;
  const focus = state.pick || state.smokePick ? null
    : sel ? d.list.filter((l) => l.id === sel)
      : d.plan ? d.list : null;
  zoomMapTo(focus && [...focus.flatMap((l) => [l.from, l.to]).filter(Boolean), ...(focus === d.list ? d.smokes : [])]);
}

/** Change the highlighted lineup without rebuilding the page (rebuilding made every icon flicker). */
function applySelection() {
  const sel = state.selected;
  for (const n of document.querySelectorAll('#mapSvg [data-id], #pins .pin[data-id]')) {
    const id = n.getAttribute('data-id');
    n.classList.toggle('dim', !!sel && id !== sel);
    n.classList.toggle('sel', id === sel);
  }
  for (const c of document.querySelectorAll('#list .card[data-id]')) c.classList.toggle('sel', c.dataset.id === sel);
  zoomForState();
}

/** Fit the map view around these points (0–1 coords); nothing → whole map. Icons keep their size. */
function zoomMapTo(points) {
  const inner = $('#mapInner'), wrap = $('#mapWrap');
  let z = 1, tx = 0, ty = 0;
  if (points?.length) {
    const xs = points.map((q) => q.x), ys = points.map((q) => q.y);
    const pad = 0.1;
    let x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    const span = Math.max(x1 - x0, y1 - y0, 0.34); // never closer than ~3×
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    z = Math.min(3, 1 / span);
    const W = wrap.clientWidth, H = wrap.clientHeight;
    tx = Math.min(0, Math.max(W - W * z, W / 2 - cx * W * z));
    ty = Math.min(0, Math.max(H - H * z, H / 2 - cy * H * z));
  }
  inner.style.transform = z === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${z})`;
  inner.style.setProperty('--z', z);
  // start dots are SVG circles inside the zoomed layer: keep their on-screen size
  for (const c of $('#mapSvg').querySelectorAll('circle')) {
    c.dataset.r ||= c.getAttribute('r');
    c.setAttribute('r', (+c.dataset.r / z).toFixed(2));
  }
  wrap.classList.toggle('zoomed', z > 1);
}

/* ---------- spike timer: 45 s from plant, with the defuse windows marked ---------- */

const SPIKE = { total: 45, full: 7, half: 3.5 };
/* fallback drawing: a planted spike — capped canister with a glowing core and bands */
const SPIKE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8l1.5 3v12L12 22l-5.5-4V6z" fill="currentColor" opacity=".22"/><path d="M8 3h8l1.5 3v12L12 22l-5.5-4V6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6.5 6h11M6.5 15h11" stroke="currentColor" stroke-width="1.3"/><rect x="10.6" y="7.5" width="2.8" height="6" rx="1.4" fill="currentColor"/></svg>';
const spike = { start: 0, raf: 0, buzzed: new Set(), doneTimer: 0, img: store.get('lp.spikeIcon', null)?.url || null };
const spikeIconHtml = () => (spike.img ? `<img src="${spike.img}" alt="">` : SPIKE_ICON);

/** The in-game Spike icon from valorant-api (game-mode equippables), cached; the drawn icon is the fallback. */
async function loadSpikeIcon() {
  const c = store.get('lp.spikeIcon', null);
  if (c && Date.now() - c.t < API_TTL) return;
  try {
    const r = await fetch('https://valorant-api.com/v1/gamemodes/equippables');
    if (!r.ok) return;
    const item = ((await r.json()).data || []).find((x) => /spike|bomb/i.test(x.displayName || ''));
    const url = item?.displayIcon || item?.killStreamIcon || null;
    store.set('lp.spikeIcon', { t: Date.now(), url });
    if (url && url !== spike.img) { spike.img = url; if (!spike.start) spikeIdle(); }
  } catch { /* offline: keep the drawn icon */ }
}

const SPIKE_FULLSCREEN_AT = 15; // seconds left when the timer takes over the whole screen

/** Full screen covers everything. An open (modal) dialog makes the rest of the page inert, so the
 *  timer moves into that dialog while one is open, and back under the map afterwards. */
const SPIKE_HOSTS = ['#zoom', '#annot', '#editor', '#planEditor', '#ghDialog', '#detail'];
function spikeHost() {
  const box = $('#spike');
  const want = box.classList.contains('full')
    ? SPIKE_HOSTS.map((q) => $(q)).find((d) => d?.open) || document.body
    : $('#mapWrap');
  if (box.parentNode !== want) want.append(box);
}
function spikeSetFull(on) {
  const box = $('#spike');
  if (box.classList.contains('full') !== on) box.classList.toggle('full', on);
  spikeHost();
}

function spikeIdle() {
  cancelAnimationFrame(spike.raf);
  clearTimeout(spike.doneTimer);
  spike.start = 0;
  spike.mini = false;
  spikeSetFull(false);
  const box = $('#spike');
  box.className = 'spike';
  box.replaceChildren(el('button', { type: 'button', class: 'spike-go', title: 'เริ่มนับเวลา spike (45 วิ)', 'aria-label': 'เริ่มนับเวลา spike 45 วินาที', onclick: spikeStart }));
  box.firstChild.innerHTML = spikeIconHtml() + '<b>45</b>';
}

function spikeStart() {
  spike.start = performance.now();
  spike.buzzed.clear();
  const box = $('#spike');
  box.className = 'spike running';
  box.replaceChildren(
    el('span', { class: 'spike-ic' }),
    el('div', { class: 'spike-track' },
      el('div', { class: 'spike-fill' }),
      el('i', { class: 'spike-mark', 'data-l': '7', style: `left:${(SPIKE.full / SPIKE.total) * 100}%`, title: 'กู้เต็มต้องเริ่มก่อน 7 วิ' }),
      el('i', { class: 'spike-mark half', 'data-l': '3.5', style: `left:${(SPIKE.half / SPIKE.total) * 100}%`, title: 'กู้ครึ่งต้องเริ่มก่อน 3.5 วิ' }),
      el('span', { class: 'spike-hint' })),
    el('b', { class: 'spike-time' }),
    el('button', { type: 'button', class: 'spike-min', 'aria-label': 'ย่อ', title: 'ย่อเป็นแถบเล็ก', onclick: () => { spike.mini = true; spikeSetFull(false); } }, 'ย่อ'),
    el('button', { type: 'button', class: 'spike-x', 'aria-label': 'หยุดนับเวลา', title: 'หยุด', onclick: spikeIdle }, '✕'));
  box.querySelector('.spike-ic').innerHTML = spikeIconHtml();
  spikeTick();
}

function spikeTick() {
  const left = Math.max(0, SPIKE.total - (performance.now() - spike.start) / 1000);
  const box = $('#spike');
  // last 15 s: full screen (unless minimised), and the bar switches to a 15-second scale so the
  // 7 / 3.5 s defuse marks are far apart
  const final = left < SPIKE_FULLSCREEN_AT, scale = final ? SPIKE_FULLSCREEN_AT : SPIKE.total;
  box.classList.toggle('final', final);
  spikeSetFull(final && !spike.mini && left > 0 || (left <= 0 && box.classList.contains('full')));
  box.querySelector('.spike-fill').style.width = (left / scale) * 100 + '%';
  const [mFull, mHalf] = box.querySelectorAll('.spike-mark');
  mFull.style.left = (SPIKE.full / scale) * 100 + '%';
  mHalf.style.left = (SPIKE.half / scale) * 100 + '%';
  box.querySelector('.spike-time').textContent = left >= 10 ? Math.ceil(left) : left.toFixed(1);
  const phase = left <= 0 ? 'boom' : left < SPIKE.half ? 'lost' : left < SPIKE.full ? 'half' : left < 10 ? 'warn' : 'ok';
  box.dataset.phase = phase;
  box.querySelector('.spike-hint').textContent = {
    ok: '', warn: 'เตรียมกู้', half: 'กู้เต็มไม่ทัน · ต้องกู้ครึ่งไว้แล้ว', lost: 'ไม่ทันกู้แล้ว', boom: 'ระเบิด!',
  }[phase];
  for (const [t, ms] of [[SPIKE_FULLSCREEN_AT, 60], [10, 80], [SPIKE.full, 160], [0, 500]]) {
    if (left <= t && !spike.buzzed.has(t)) { spike.buzzed.add(t); navigator.vibrate?.(ms); }
  }
  if (left <= 0) { spike.doneTimer = setTimeout(spikeIdle, 3000); return; }
  spike.raf = requestAnimationFrame(spikeTick);
}

/** Touch screens: a card tap shows the quick preview at the lineup's pin first; mouse: open it straight away. */
const touchUi = () => matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
/** Card tap: highlight that lineup on the map (others stay visible, dimmed). Tap again to clear. */
function highlightLineup(id) {
  if (state.peek) closePeek();
  state.selected = state.selected === id ? null : id;
  updateHash();
  applySelection();
}

/** Touch: tapping a pin highlights it and scrolls its card into view; tapping the same spot again
 *  cycles through lineups whose pins are close together. */
function selectFromPin(id) {
  const ids = nearPins(id);
  const cur = ids.indexOf(state.selected);
  const pick = cur >= 0 ? ids[(cur + 1) % ids.length] : id;
  state.selected = pick;
  updateHash();
  applySelection();
  const card = document.querySelector(`#list .card[data-id="${CSS.escape(pick)}"]`);
  card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (ids.length > 1) toast(`${ids.indexOf(pick) + 1}/${ids.length} · แตะซ้ำเพื่อสลับ lineup ที่ซ้อนกัน`);
}

function nearPins(id) {
  const pinEls = [...document.querySelectorAll('#pins .pin[data-id]')];
  const centre = (n) => { const r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const me = pinEls.find((n) => n.dataset.id === id);
  if (!me) return [id];
  const [cx, cy] = centre(me);
  return [...new Set(pinEls.map((n) => { const [x, y] = centre(n); return { id: n.dataset.id, d: Math.hypot(x - cx, y - cy) }; })
    .filter((x) => x.d <= PEEK_RADIUS).sort((a, b) => a.d - b.d).map((x) => x.id))];
}

/* ---------- tap a pin: quick preview; pins close together become buttons to switch between ---------- */

const PEEK_RADIUS = 30; // px: pins this close to the tapped one are offered too

function peekAt(id) {
  if (!document.querySelector(`#pins .pin[data-id="${CSS.escape(id)}"]`)) { openDetail(id); return; }
  state.peek = { ids: nearPins(id), i: 0, anchor: id };
  renderPeek();
}

function closePeek() {
  state.peek = null;
  $('#peek').hidden = true;
  $('#peek').replaceChildren();
  hover(null);
}

function renderPeek() {
  const pk = state.peek;
  const box = $('#peek');
  if (!pk) { box.hidden = true; return; }
  const l = all().find((x) => x.id === pk.ids[pk.i]);
  if (!l) { closePeek(); return; }
  const media = (l.media || []).map(parseMedia).filter(Boolean);
  const { stand, aim } = splitMedia(media);
  const a = agentOf(l.agent), col = colorFor(l);
  const thumb = (m, label) => el('figure', { class: 'peek-shot' },
    m ? el('img', { src: mediaSrc(m.src), alt: label }) : el('span', { class: 'peek-none', text: 'ไม่มีรูป' }), el('figcaption', { text: label }));
  box.style.setProperty('--ag', col || 'var(--accent)');
  box.replaceChildren(
    pk.ids.length > 1 ? el('div', { class: 'peek-tabs', role: 'tablist', 'aria-label': 'lineup ที่อยู่ใกล้กัน' }, pk.ids.map((id, i) => {
      const x = all().find((y) => y.id === id);
      const ax = agentOf(x?.agent), ic = x ? iconFor(x) : null;
      return el('button', {
        type: 'button', class: 'peek-tab' + (i === pk.i ? ' on' : ''), role: 'tab', 'aria-selected': String(i === pk.i), title: x?.title || '',
        style: ax?.color ? `--ag:${ax.color}` : null,
        onclick: (e) => { e.stopPropagation(); pk.i = i; renderPeek(); },
      }, ax?.icon ? el('img', { src: ax.icon, alt: '' }) : null, ic ? el('img', { class: 'ab-mini', src: ic, alt: '' }) : null);
    })) : null,
    el('div', { class: 'peek-head' },
      a?.icon ? el('img', { class: 'peek-face', src: a.icon, alt: l.agent }) : null,
      el('div', { class: 'grow' },
        el('b', { text: l.title || '(ไม่มีชื่อ)' }),
        el('small', { text: [l.ability, l.site && 'ไซต์ ' + l.site, l.throw].filter(Boolean).join(' · ') })),
      el('button', { type: 'button', class: 'peek-x', 'aria-label': 'ปิด', onclick: (e) => { e.stopPropagation(); closePeek(); } }, '✕')),
    el('div', { class: 'peek-shots' }, thumb(stand, 'จุดยืน'), thumb(aim, 'จุดเล็ง')),
    el('button', { type: 'button', class: 'btn sm primary peek-open', onclick: (e) => { e.stopPropagation(); const id = l.id; closePeek(); openDetail(id); } }, 'เปิดดู ›'));
  box.hidden = false;
  hover(l.id);
  // place it next to the tapped pin, inside the map
  const wrap = $('#mapWrap').getBoundingClientRect();
  const pin = document.querySelector(`#pins .pin[data-id="${CSS.escape(pk.anchor)}"]`)?.getBoundingClientRect();
  const bw = box.offsetWidth, bh = box.offsetHeight;
  let x = pin ? pin.left - wrap.left + pin.width / 2 - bw / 2 : (wrap.width - bw) / 2;
  let y = pin ? (pin.top - wrap.top > wrap.height / 2 ? pin.top - wrap.top - bh - 10 : pin.bottom - wrap.top + 10) : 10;
  x = Math.max(6, Math.min(wrap.width - bw - 6, x));
  y = Math.max(6, Math.min(wrap.height - bh - 6, y));
  box.style.left = x + 'px';
  box.style.top = y + 'px';
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
  const roleF = state.f.role;
  let list = state.agents.map((a) => ({ name: a.name, icon: a.icon, role: a.role }));
  for (const l of all()) if (l.agent && !list.some((a) => norm(a.name) === norm(l.agent))) list.push({ name: l.agent });
  if (roleF === 'has') list = list.filter((a) => count(a.name) || state.f.agents.has(norm(a.name)));
  else if (roleF !== 'all') list = list.filter((a) => norm(a.role) === roleF || state.f.agents.has(norm(a.name)));
  list.sort((x, y) => x.name.localeCompare(y.name));
  const keepLeft = row.scrollLeft;
  row.replaceChildren();
  row.hidden = !list.length;
  for (const a of list) {
    const key = norm(a.name);
    const on = state.f.agents.has(key);
    const n = count(a.name);
    const col = agentOf(a.name)?.color;
    row.append(el('button', {
      type: 'button', class: 'ag' + (on ? ' on' : '') + (n ? ' has' : '') + (a.icon ? '' : ' txt'),
      style: col ? `--ag:${col}` : null,
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

function renderTabs() {
  const n = plans().filter((x) => norm(x.map) === norm(state.map)).length;
  $('#tabs').replaceChildren(
    el('button', { type: 'button', class: state.tab !== 'plans' ? 'on' : '', onclick: () => { state.tab = 'lineups'; state.plan = null; render(); } }, 'Lineup'),
    el('button', { type: 'button', class: state.tab === 'plans' ? 'on' : '', onclick: () => { state.tab = 'plans'; state.plan = null; state.selected = null; render(); } },
      'แผน', n ? el('span', { class: 'n', text: String(n) }) : null));
}

function lineupCard(l, num) {
  const icon = iconFor(l);
  const col = colorFor(l);
  return el('li', { class: 'card' + (state.selected === l.id ? ' sel' : ''), 'data-id': l.id, style: col ? `--ag:${col}` : null },
    el('button', {
      type: 'button', class: 'card-main',
      onclick: () => highlightLineup(l.id),
      onmouseenter: () => hover(l.id),
      onmouseleave: () => hover(null),
    },
    num ? el('span', { class: 'card-n', text: String(num) }) : null,
    agentOf(l.agent)?.icon ? el('img', { class: 'card-agent', src: agentOf(l.agent).icon, alt: l.agent, title: l.agent, loading: 'lazy' }) : null,
    el('span', { class: 'ab' }, icon ? el('img', { src: icon, alt: '', loading: 'lazy' }) : '◆'),
    el('span', { class: 'card-body' },
      el('span', { class: 'card-title', text: l.title || '(ไม่มีชื่อ)' }),
      el('span', { class: 'card-meta' },
        l.side ? el('i', { class: 'side-dot ' + l.side, title: SIDE_LABEL[l.side] }) : null,
        [l.ability || l.agent, l.site && 'ไซต์ ' + l.site, TYPE_LABEL[l.type]].filter(Boolean).join(' · ') || '—'),
      l.example || l._local || l.by ? el('span', { class: 'chips' },
        l.by ? el('span', { class: 'chip by', text: 'โดย ' + l.by }) : null,
        l.example ? el('span', { class: 'chip ex', text: 'ตัวอย่าง' }) : null,
        l._local ? el('span', { class: 'chip warn', text: 'ยังไม่ export' }) : null) : null)),
    el('button', { type: 'button', class: 'view-btn', title: 'ดู lineup', 'aria-label': 'ดู ' + (l.title || 'lineup'), onclick: () => openDetail(l.id) }, 'ดู ›'));
}

/** Agent portrait with the ability icon in the corner (dashed ring = smoke placed from the map). */
function planIcon(agent, ability, title, smoke) {
  const a = agentOf(agent), ab = abilityIcon(agent, ability);
  return el('span', { class: 'plan-ic' + (smoke ? ' smoke' : ''), title, style: a?.color ? `--ag:${a.color}` : null },
    a?.icon ? el('img', { class: 'face', src: a.icon, alt: agent }) : el('span', { text: (agent || '?')[0] }),
    ab && ab !== a?.icon ? el('img', { class: 'abil', src: ab, alt: ability }) : null);
}

function renderPlanList(ul, cnt) {
  const list = plans().filter((x) => norm(x.map) === norm(state.map)).sort((a, b) => (a.title || '').localeCompare(b.title || '', 'th'));
  cnt.replaceChildren(
    el('span', { class: 'grow cnt-text', text: `${list.length} แผนบน ${state.map || '—'}` }),
    el('button', { type: 'button', class: 'reset-ag', onclick: () => openPlanEditor({ map: state.map }) }, '+ สร้างแผน'));
  ul.replaceChildren();
  if (!list.length) {
    ul.append(el('li', { class: 'empty' },
      el('span', { text: 'แผน = คอมโบหลาย lineup ที่ใช้ด้วยกัน เช่น post-plant A: molly + nanoswarm' }),
      el('button', { type: 'button', class: 'btn primary', onclick: () => openPlanEditor({ map: state.map }) }, '+ สร้างแผนแรก')));
    return;
  }
  const byId = new Map(all().map((l) => [l.id, l]));
  for (const pl of list) {
    const items = (pl.items || []).map((id) => byId.get(id)).filter(Boolean);
    const peek = (on) => { state.hoverPlan = on ? pl.id : null; renderMap(); };
    ul.append(el('li', {
      class: 'card plan-card',
      onmouseenter: () => peek(true), onmouseleave: () => peek(false),
      onfocusin: () => peek(true), onfocusout: () => peek(false),
    },
      el('button', { type: 'button', class: 'card-main', onclick: () => { state.plan = pl.id; state.tab = 'plans'; state.selected = null; render(); } },
        el('span', { class: 'card-body' },
          el('span', { class: 'card-title', text: pl.title || '(แผนไม่มีชื่อ)' }),
          el('span', { class: 'card-meta' },
            pl.side ? el('i', { class: 'side-dot ' + pl.side, title: SIDE_LABEL[pl.side] }) : null,
            [pl.site && 'ไซต์ ' + pl.site, `${items.length} lineup`, pl.smokes?.length && `${pl.smokes.length} สโมก`].filter(Boolean).join(' · ')),
          el('span', { class: 'plan-icons' }, items.map((l, i) => planIcon(l.agent, l.ability, `${i + 1}. ${l.title}`)),
            (pl.smokes || []).map((sm) => planIcon(sm.agent, sm.ability, `สโมก: ${sm.agent} · ${sm.ability}`, true))),
          pl._local ? el('span', { class: 'chips' }, el('span', { class: 'chip warn', text: 'ยังไม่ export' })) : null)),
      el('button', { type: 'button', class: 'tick', title: 'แก้ไขแผน', 'aria-label': 'แก้ไขแผน', onclick: () => openPlanEditor(pl) }, '✎')));
  }
}

function saveFilters() {
  store.set(LS.filters, { side: state.f.side, site: state.f.site, type: state.f.type });
  store.set(LS.role, state.f.role);
}

const activeFilters = () => ['side', 'site', 'type', 'role'].filter((k) => state.f[k] !== 'all').length;

/** One "กรอง" button (next to the agent buttons) opens this panel: side, site, type and agent role. */
function renderFilterBar() {
  const bar = $('#filterPop');
  if (bar.hidden) return;
  const sel = (key, label, options) => el('select', {
    class: 'fsel' + (state.f[key] !== 'all' ? ' on' : ''), 'aria-label': label, title: label,
    onchange: (e) => { state.f[key] = e.target.value; saveFilters(); render(); },
  }, options.map(([v, t]) => el('option', { value: v, text: t, selected: state.f[key] === v })));
  const active = ['side', 'site', 'type', 'role'].some((k) => state.f[k] !== 'all');
  bar.replaceChildren(
    sel('side', 'ฝั่ง', [['all', 'ทุกฝั่ง'], ['attack', 'บุก'], ['defense', 'รับ']]),
    sel('site', 'ไซต์', [['all', 'ทุกไซต์'], ...SITES.map((x) => [x, 'ไซต์ ' + x])]),
    sel('type', 'ประเภท', [['all', 'ทุกประเภท'], ['entry', 'เปิดไซต์'], ['execute', 'Execute'], ['post-plant', 'Post-plant'], ['retake', 'รีเทค'], ['info', 'หาข้อมูล'], ['hold', 'ตั้งรับ'], ['smoke', 'Smoke'], ['other', 'อื่น ๆ']]),
    sel('role', 'บทบาทเอเจนต์', [['all', 'ทุกบทบาท'], ['has', 'มี lineup'], ['controller', 'Controller'], ['duelist', 'Duelist'], ['initiator', 'Initiator'], ['sentinel', 'Sentinel']]),
    ...(active ? [el('button', { type: 'button', class: 'reset-ag', onclick: () => { Object.assign(state.f, { side: 'all', site: 'all', type: 'all', role: 'all' }); saveFilters(); render(); } }, 'ล้าง')] : []));
}
function filterButton() {
  const n = activeFilters();
  return el('button', {
    type: 'button', class: 'reset-ag filter-btn' + (n ? ' on' : ''), 'aria-expanded': String(!$('#filterPop').hidden),
    onclick: (e) => { e.stopPropagation(); $('#filterPop').hidden = !$('#filterPop').hidden; renderFilterBar(); e.currentTarget.setAttribute('aria-expanded', String(!$('#filterPop').hidden)); },
  }, '⚙ กรอง', n ? el('span', { class: 'n', text: String(n) }) : null);
}

function renderList() {
  const keepTop = $('#list').scrollTop; // re-rendering must not jump the list back to the top
  renderListInner();
  $('#list').scrollTop = keepTop;
}

function renderListInner() {
  if (state.tab === 'plans' || activePlan()) $('#filterPop').hidden = true;
  renderFilterBar();
  if (state.tab !== 'plans' || state.plan) state.hoverPlan = null;
  const ul = $('#list');
  const cnt = $('#count');
  renderTabs();
  const plan = activePlan();
  if (state.plan && !plan) state.plan = null;
  $('#agents').hidden = $('#agents').hidden || !!plan || state.tab === 'plans';
  if (state.tab === 'plans' && !plan) { renderPlanList(ul, cnt); return; }

  const total = all().filter((l) => norm(l.map) === norm(state.map)).length;
  const list = sortedVisible();
  if (plan) {
    cnt.replaceChildren(
      el('span', { class: 'grow cnt-text plan-head', text: `แผน: ${plan.title || '—'} · ${list.length} lineup` }),
      el('button', { type: 'button', class: 'reset-ag', onclick: () => openPlanEditor(plan) }, '✎ แก้แผน'),
      el('button', { type: 'button', class: 'reset-ag', onclick: () => { state.plan = null; state.tab = 'plans'; state.selected = null; render(); } }, '✕ ออก'));
    ul.replaceChildren(...list.map((l, i) => lineupCard(l, i + 1)));
    const groups = new Map();
    for (const sm of plan.smokes || []) { const k = sm.agent + '|' + sm.ability; groups.set(k, [...(groups.get(k) || []), sm]); }
    for (const [k, arr] of groups) {
      const [agent, ability] = k.split('|');
      const col = agentOf(agent)?.color, ic = abilityIcon(agent, ability), face = agentOf(agent)?.icon;
      ul.append(el('li', { class: 'card smoke-row', style: col ? `--ag:${col}` : null },
        el('span', { class: 'card-main' },
          el('span', { class: 'card-n', text: '☁' }),
          face ? el('img', { class: 'card-agent', src: face, alt: agent }) : null,
          el('span', { class: 'ab' }, ic ? el('img', { src: ic, alt: '' }) : '☁'),
          el('span', { class: 'card-body' },
            el('span', { class: 'card-title', text: `สโมก ${ability}` + (arr.length > 1 ? ` ×${arr.length}` : '') }),
            el('span', { class: 'card-meta', text: `${agent} · วางจากแมพ (ไม่มี lineup)` })))));
    }
    if (!list.length && !(plan.smokes || []).length) ul.append(el('li', { class: 'empty' }, 'แผนนี้ยังไม่มี lineup — กด ✎ แก้แผน เพื่อเลือก'));
    return;
  }
  const picked = [...state.f.agents].map((k) => agentOf(k)?.name || k);
  const agentName = picked.length ? picked.join(', ') : '';
  const withLineups = [...new Set(all().filter((l) => norm(l.map) === norm(state.map) && l.agent).map((l) => norm(l.agent)))];
  cnt.replaceChildren(
    el('span', { class: 'grow cnt-text', text: (picked.length ? (picked.length > 2 ? `${picked.length} เอเจนต์` : agentName) : 'ทุกเอเจนต์') + ` · ${list.length} lineup` }),
    filterButton(),
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
  for (const l of list) ul.append(lineupCard(l));
}

/* ---------- plans: a combo of lineups used together ---------- */

function openPlanEditor(src) {
  const exists = !!src?.id && plans().some((x) => x.id === src.id);
  const d = { kind: 'plan', side: state.f.side !== 'all' ? state.f.side : 'attack', map: state.map, items: [], ...src };
  delete d._local;
  state.planEdit = { draft: d, exists, items: [...(d.items || [])], smokes: (d.smokes || []).map((x) => ({ ...x })), smokeAgent: null, smokeAbility: null };
  const f = $('#planForm').elements;
  $('#planTitle').textContent = exists ? 'แก้ไขแผน' : 'สร้างแผน';
  f.title.value = d.title || '';
  f.side.value = d.side || 'attack';
  fillOptions(f.site, [['', '—'], ...SITES.map((x) => [x, x])], d.site || '');
  f.steps.value = d.steps || '';
  $('#planDelete').hidden = !exists;
  renderPlanPicker();
  renderPlanSmokes();
  $('#planEditor').showModal();
}

/* ---------- smokes in a plan: placed on the map, no lineup needed ---------- */

const SMOKE_RE = /smoke|dark cover|nebula|cloudburst|cove|cascade|high tide|toxic screen|poison cloud|ruse|cyber cage/i;
function abilityIcon(agent, ability) {
  const a = agentOf(agent);
  return a?.abilities.find((x) => norm(x.name) === norm(ability))?.icon || a?.icon || null;
}
/** Approximate in-game smoke radius in game units (cm). */
const SMOKE_RADIUS = {
  'sky smoke': 415, 'dark cover': 410, nebula: 475, 'poison cloud': 450, 'toxic screen': 300,
  cove: 450, cascade: 300, 'high tide': 300, ruse: 410, cloudburst: 335, 'cyber cage': 360,
};
function smokeEl(sm) {
  const col = agentOf(sm.agent)?.color, ic = abilityIcon(sm.agent, sm.ability);
  const scale = mapOf(state.map)?.scale;
  const size = scale ? 2 * (SMOKE_RADIUS[norm(sm.ability)] || 420) * scale * 100 : 7; // % of the map width
  return el('span', { class: 'smoke-pin', title: `สโมก ${sm.agent} · ${sm.ability}`, style: `left:${sm.x * 100}%;top:${sm.y * 100}%;width:${size.toFixed(2)}%` + (col ? `;--ag:${col}` : '') },
    ic ? el('img', { src: ic, alt: '' }) : '☁');
}

function renderPlanSmokes() {
  const pe = state.planEdit;
  const ctrl = (a) => (/controller/i.test(a.role) ? 0 : 1);
  const agents = [...state.agents].sort((a, b) => ctrl(a) - ctrl(b) || a.name.localeCompare(b.name));
  if (!pe.smokeAgent) pe.smokeAgent = agents[0]?.name || null;
  const ag = agentOf(pe.smokeAgent);
  const abilities = ag?.abilities || [];
  if (!abilities.some((x) => x.name === pe.smokeAbility)) pe.smokeAbility = (abilities.find((x) => SMOKE_RE.test(x.name)) || abilities[0])?.name || null;

  $('#planSmokes').replaceChildren(...(pe.smokes.length ? pe.smokes.map((sm, i) => {
    const col = agentOf(sm.agent)?.color, ic = abilityIcon(sm.agent, sm.ability);
    return el('span', { class: 'smoke-chip', style: col ? `--ag:${col}` : null },
      ic ? el('img', { src: ic, alt: '' }) : '☁', el('span', { text: `${sm.agent} · ${sm.ability}` }),
      el('button', { type: 'button', 'aria-label': 'เอาออก', onclick: () => { pe.smokes.splice(i, 1); renderPlanSmokes(); } }, '✕'));
  }) : [el('span', { class: 'muted-s', text: 'ยังไม่มีสโมก — เลือกเอเจนต์ / สกิล แล้วแตะแมพเพื่อวาง' })]));

  $('#smokeAgents').replaceChildren(...agents.map((a) => pickBtn('pk-ag', a.name === pe.smokeAgent, a.name,
    () => { pe.smokeAgent = a.name; pe.smokeAbility = null; renderPlanSmokes(); }, el('img', { src: a.icon, alt: '' }))));
  $('#smokeAbilities').replaceChildren(...abilities.map((x) => pickBtn('pk-ab', x.name === pe.smokeAbility, x.name,
    () => { pe.smokeAbility = x.name; renderPlanSmokes(); }, x.icon ? el('img', { src: x.icon, alt: '' }) : null, el('span', { text: x.name }))));
  $('#smokePlace').disabled = !pe.smokeAgent || !pe.smokeAbility || !mapOf(pe.draft.map);
  scrollIntoRowIfHidden($('#smokeAgents'), $('#smokeAgents .on'));
}

function readPlanForm() {
  const f = $('#planForm').elements;
  Object.assign(state.planEdit.draft, { title: f.title.value, side: f.side.value, site: f.site.value, steps: f.steps.value });
}

function startSmokePick() {
  const pe = state.planEdit;
  readPlanForm();
  state.smokePick = { agent: pe.smokeAgent, ability: pe.smokeAbility, added: 0 };
  $('#planEditor').close();
  if (norm(pe.draft.map) !== norm(state.map)) { state.map = canonMap(pe.draft.map) || pe.draft.map; }
  render();
  updateSmokeBanner();
}

function updateSmokeBanner() {
  const b = $('#pickBanner');
  const sp = state.smokePick;
  if (!sp) { b.hidden = true; b.replaceChildren(); return; }
  b.hidden = false;
  b.replaceChildren(
    el('span', { class: 'step', text: '☁' }),
    el('span', { class: 'grow', text: `วางสโมก ${sp.ability}: แตะบนแมพ (หลายจุดได้) · วางแล้ว ${sp.added}` }),
    el('button', { type: 'button', class: 'btn sm', disabled: !sp.added, onclick: () => { state.planEdit.smokes.pop(); sp.added--; renderMap(); updateSmokeBanner(); } }, '↶'),
    el('button', { type: 'button', class: 'btn sm primary', onclick: finishSmokePick }, 'เสร็จ'));
}

function finishSmokePick() {
  state.smokePick = null;
  updateSmokeBanner();
  renderMap();
  resumePlanEditor();
}

function resumePlanEditor() {
  const d = state.planEdit.draft;
  const f = $('#planForm').elements;
  f.title.value = d.title || '';
  f.side.value = d.side || 'attack';
  f.site.value = d.site || '';
  f.steps.value = d.steps || '';
  renderPlanPicker();
  renderPlanSmokes();
  $('#planEditor').showModal();
}

function renderPlanPicker() {
  const pe = state.planEdit;
  const f = $('#planForm').elements;
  const side = f.side.value;
  const pool = all().filter((l) => norm(l.map) === norm(pe.draft.map))
    .sort((a, b) => (a.side === side ? 0 : 1) - (b.side === side ? 0 : 1) || byListOrder(a, b));
  $('#planHint').textContent = `เลือก lineup บน ${pe.draft.map || '—'} ตามลำดับที่ใช้ (แตะซ้ำเพื่อเอาออก) · เลือกแล้ว ${pe.items.length}`;
  $('#planPick').replaceChildren(...(pool.length ? pool.map((l) => {
    const n = pe.items.indexOf(l.id) + 1;
    const ic = iconFor(l), col = colorFor(l);
    return el('button', {
      type: 'button', class: 'pp' + (n ? ' on' : '') + (l.side !== side ? ' other' : ''), style: col ? `--ag:${col}` : null,
      onclick: () => { if (n) pe.items.splice(n - 1, 1); else pe.items.push(l.id); renderPlanPicker(); if (!f.title.dataset.touched) f.title.value = autoPlanTitle(); },
    },
    el('span', { class: 'pp-n', text: n ? String(n) : '' }),
    ic ? el('img', { src: ic, alt: '' }) : el('span', { text: '◆' }),
    el('span', { class: 'pp-t' }, el('b', { text: l.title || '(ไม่มีชื่อ)' }), el('small', { text: [l.agent, SIDE_LABEL[l.side]].filter(Boolean).join(' · ') })));
  }) : [el('p', { class: 'muted', text: 'ยังไม่มี lineup บนแมพนี้' })]));
}

function autoPlanTitle() {
  const f = $('#planForm').elements;
  const items = state.planEdit.items.map((id) => all().find((l) => l.id === id)).filter(Boolean);
  const type = items.map((l) => l.type).find((t) => t && t !== 'other');
  return [TYPE_SHORT[type] || 'แผน', f.site.value || commonSite(items)].filter(Boolean).join(' ') + (f.side.value ? ' · ' + SIDE_LABEL[f.side.value] : '');
}
/** The site every lineup in the list shares, if any. */
function commonSite(items) {
  const sites = [...new Set(items.map((l) => l.site).filter(Boolean))];
  return sites.length === 1 && items.every((l) => l.site) ? sites[0] : '';
}

function bindPlans() {
  const dlg = $('#planEditor');
  const f = $('#planForm').elements;
  for (const b of dlg.querySelectorAll('[data-close]')) b.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  f.title.addEventListener('input', () => { f.title.dataset.touched = f.title.value.trim() ? '1' : ''; });
  f.side.addEventListener('change', () => { renderPlanPicker(); if (!f.title.dataset.touched) f.title.value = autoPlanTitle(); });
  f.site.addEventListener('change', () => { if (!f.title.dataset.touched) f.title.value = autoPlanTitle(); });
  dlg.addEventListener('close', () => { if (!state.smokePick) delete f.title.dataset.touched; });
  $('#smokePlace').addEventListener('click', startSmokePick);
  $('#planDelete').addEventListener('click', () => {
    const d = state.planEdit?.draft;
    if (!d?.id || !confirm(`ลบแผน “${d.title || ''}”? (lineup ในแผนไม่ถูกลบ)`)) return;
    deleteLineup(d.id);
    if (state.plan === d.id) state.plan = null;
    dlg.close();
    render();
    if (ghReady() && gh.cfg.auto) publish({ quiet: true });
    toast('ลบแผนแล้ว');
  });
  $('#planForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const pe = state.planEdit;
    if (!pe.items.length && !pe.smokes.length) { toast('เลือก lineup หรือวางสโมกอย่างน้อย 1 อัน'); return; }
    const picked = pe.items.map((id) => all().find((l) => l.id === id)).filter(Boolean);
    const d = { ...pe.draft, kind: 'plan', title: f.title.value.trim() || autoPlanTitle(), side: f.side.value, site: f.site.value || commonSite(picked), steps: f.steps.value.trim(), items: pe.items, smokes: pe.smokes.length ? pe.smokes : undefined };
    d.id ||= newId();
    saveLineup(d);
    dlg.close();
    state.plan = d.id;
    state.tab = 'plans';
    state.selected = null;
    render();
    toast(ghReady() && gh.cfg.auto ? 'บันทึกแผนแล้ว — กำลังขึ้น GitHub…' : 'บันทึกแผนในเครื่องแล้ว');
    if (ghReady() && gh.cfg.auto) publish({ quiet: true });
  });
}

function renderUnsynced() {
  const total = Object.keys(state.local).length;
  const n = unpublished().length;
  const b = $('#unsynced');
  b.hidden = !total && !gh.busy;
  b.disabled = gh.busy;
  if (gh.busy) { b.textContent = '⬆ กำลังขึ้น GitHub…'; b.title = ''; return; }
  if (ghReady()) {
    b.textContent = n ? `⬆ ขึ้น GitHub (${n})` : '⏳ รอเว็บอัปเดต';
    b.title = n ? 'แตะเพื่อส่งการแก้ไขขึ้น GitHub' : 'ส่งขึ้น GitHub แล้ว — เว็บจะอัปเดตใน 1–2 นาที';
  } else {
    b.textContent = `${total} ยังไม่ export`;
    b.title = 'มีการแก้ไขที่เก็บอยู่แค่ในเบราว์เซอร์นี้ — แตะเพื่อส่งออก (หรือตั้งค่า GitHub ในเมนู ⋯)';
  }
}

/* ---------- map selection ---------- */

function setMap(name) {
  if (state.peek) closePeek();
  state.map = name;
  state.selected = null;
  state.plan = null;
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

/** Split media into picture slots — stand, stand2 (below it), aim, aim2 — and everything else. */
function splitMedia(list) {
  const imgs = list.filter((m) => IMG_RE.test(m.src));
  const kindOf = (m) => {
    const f = m.src.match(/-(stand|aim)(2)?(?:-v\w+)?\.\w+$/i);
    if (f) return f[1].toLowerCase() + (f[2] || '');
    const c = m.caption || '';
    const two = /2\s*$/.test(c) ? '2' : '';
    if (STAND_RE.test(c)) return 'stand' + two;
    if (AIM_RE.test(c)) return 'aim' + two;
    return null;
  };
  const out = {};
  for (const m of imgs) { const k = kindOf(m); if (k && !out[k]) out[k] = m; }
  if (!Object.keys(out).length && imgs.length) [out.stand, out.aim] = imgs;
  for (const k of ['stand', 'aim']) if (!out[k] && out[k + '2']) { out[k] = out[k + '2']; delete out[k + '2']; }
  const used = new Set(Object.values(out));
  return { ...out, rest: list.filter((m) => !used.has(m)) };
}

/* ---------- picture board: stand | aim columns, each with 1–2 slots; dividers are draggable ---------- */

const LAYOUT_DEFAULT = { col: 0.5, stand: 0.5, aim: 0.5 };
const clampR = (v) => Math.round(Math.min(0.8, Math.max(0.2, v)) * 1000) / 1000;

/** cols: [{ key: 'stand'|'aim', top: Node, bottom: Node|null }] · layout: { col, stand, aim } · onChange(layout) after a drag */
function makeBoard(cols, layout, onChange) {
  const lay = { ...LAYOUT_DEFAULT, ...layout };
  const root = el('div', { class: 'board' });
  const drag = (handle, axis, box, apply) => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      const move = (ev) => {
        const r = box.getBoundingClientRect();
        apply(clampR(axis === 'x' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height));
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.classList.remove('dragging');
        onChange?.({ ...lay });
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('pointercancel', up, { once: true });
    });
    handle.addEventListener('click', (e) => e.stopPropagation());
  };
  const colEls = cols.map((c) => {
    const col = el('div', { class: 'bcol' });
    const top = el('div', { class: 'bcell' }, c.top);
    col.append(top);
    if (c.bottom) {
      const bottom = el('div', { class: 'bcell' }, c.bottom);
      const hd = el('div', { class: 'hdiv', role: 'separator', 'aria-orientation': 'horizontal', title: 'ลากเพื่อปรับขนาด' });
      const set = (r) => { lay[c.key] = r; top.style.flexGrow = r; bottom.style.flexGrow = 1 - r; };
      set(lay[c.key]);
      drag(hd, 'y', col, set);
      col.append(hd, bottom);
    }
    return col;
  });
  const vd = el('div', { class: 'vdiv', role: 'separator', 'aria-orientation': 'vertical', title: 'ลากเพื่อปรับขนาด' });
  const setCol = (r) => { lay.col = r; colEls[0].style.flexGrow = r; colEls[1].style.flexGrow = 1 - r; };
  setCol(lay.col);
  drag(vd, 'x', root, setCol);
  root.append(colEls[0], vd, colEls[1]);
  return root;
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

/* ---------- full-screen image with zoom: pinch / double-tap / wheel / buttons, drag to pan ---------- */

const zm = { s: 1, x: 0, y: 0, pts: new Map(), pinch: null, tap: null, img: null, stage: null };
const Z_MAX = 6;

function zoom(src, caption, badge) {
  const z = $('#zoom');
  zm.bw = zm.bh = 0;
  zm.img = el('img', { src: mediaSrc(src), alt: caption || '', draggable: 'false', onload: () => { zoomFit(); zoomApply(); } });
  zm.stage = el('div', { class: 'zoom-stage' }, zm.img);
  const btn = (t, label, fn) => el('button', { type: 'button', class: 'zoom-btn', title: label, 'aria-label': label, onclick: (e) => { e.stopPropagation(); fn(); } }, t);
  const center = () => { const r = zm.stage.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  z.replaceChildren(zm.stage,
    el('div', { class: 'zoom-bar' },
      btn('−', 'ซูมออก', () => zoomAt(zm.s / 1.5, ...center(), true)),
      btn('＋', 'ซูมเข้า', () => zoomAt(zm.s * 1.5, ...center(), true)),
      btn('⟲', 'ขนาดปกติ', () => zoomReset(true)),
      btn('✕', 'ปิด', () => z.close())),
    ...(caption ? [el('span', { class: 'zoom-cap', text: caption + ' · จีบนิ้ว / แตะ 2 ครั้งเพื่อซูม' })] : []),
    ...(badge ? [el('span', { class: 'throw-badge zoom-badge', text: badge })] : []));
  zoomReset();
  bindZoomStage(zm.stage);
  z.showModal();
}

/** Size the picture to fit the screen at 1×. */
function zoomFit() {
  const { img, stage } = zm;
  if (!img?.naturalWidth) return;
  const k = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight);
  zm.bw = img.naturalWidth * k;
  zm.bh = img.naturalHeight * k;
}
function zoomApply(animate) {
  const { img, stage } = zm;
  if (!img) return;
  if (!zm.bw) zoomFit();
  const w = (zm.bw || img.offsetWidth) * zm.s, h = (zm.bh || img.offsetHeight) * zm.s;
  // keep the picture on screen: pan only as far as the zoomed image overflows the stage
  const mx = Math.max(0, (w - stage.clientWidth) / 2);
  const my = Math.max(0, (h - stage.clientHeight) / 2);
  zm.x = Math.min(mx, Math.max(-mx, zm.x));
  zm.y = Math.min(my, Math.max(-my, zm.y));
  // zoom by real layout size, not a CSS scale: the browser then draws the picture from its full
  // resolution at every zoom level instead of enlarging a screen-sized copy (which looked blurry)
  img.style.transition = animate ? 'width .2s ease-out, height .2s ease-out, transform .2s ease-out' : 'none';
  if (zm.bw) { img.style.width = w + 'px'; img.style.height = h + 'px'; }
  img.style.transform = `translate(${zm.x}px, ${zm.y}px)`;
  $('#zoom').classList.toggle('zoomed', zm.s > 1.01);
}
function zoomReset(animate) { zm.s = 1; zm.x = 0; zm.y = 0; zoomApply(animate); }
/** Zoom to scale ns keeping the screen point (px, py) under the finger / cursor. */
function zoomAt(ns, px, py, animate) {
  ns = Math.min(Z_MAX, Math.max(1, ns));
  const r = zm.stage.getBoundingClientRect();
  const cx = px - (r.left + r.width / 2), cy = py - (r.top + r.height / 2);
  zm.x = cx - (ns / zm.s) * (cx - zm.x);
  zm.y = cy - (ns / zm.s) * (cy - zm.y);
  zm.s = ns;
  zoomApply(animate);
}

function bindZoomStage(stage) {
  const pts = zm.pts;
  pts.clear();
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const mid = () => { const [a, b] = [...pts.values()]; return [(a.x + b.x) / 2, (a.y + b.y) / 2]; };
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { zm.pinch = { d: dist(), s: zm.s, m: mid() }; zm.tap = null; }
    else zm.tap = { x: e.clientX, y: e.clientY, t: Date.now(), onImg: e.target === zm.img };
    zm.closeOnClick = false;
  });
  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 2 && zm.pinch) {
      const [mx, my] = mid();
      zm.x += mx - zm.pinch.m[0]; zm.y += my - zm.pinch.m[1];
      zm.pinch.m = [mx, my];
      zoomAt(zm.pinch.s * dist() / zm.pinch.d, mx, my);
    } else if (pts.size === 1 && zm.s > 1) {
      zm.x += dx; zm.y += dy;
      zoomApply();
    }
    if (zm.tap && Math.hypot(e.clientX - zm.tap.x, e.clientY - zm.tap.y) > 10) zm.tap = null;
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) zm.pinch = null;
    const t = zm.tap;
    zm.tap = null;
    if (!t || e.type === 'pointercancel' || Date.now() - t.t > 300) return;
    // tap on the black area closes — on 'click', so the follow-up click can't hit (and reopen) the image underneath
    zm.closeOnClick = !t.onImg && zm.s <= 1.01;
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(zm.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY);
  }, { passive: false });
  stage.addEventListener('dblclick', (e) => e.preventDefault());
  stage.addEventListener('click', () => { if (zm.closeOnClick) { zm.closeOnClick = false; $('#zoom').close(); } });
}

function detailBoard(l, stand, stand2, aim, aim2) {
  // dividers can be dragged while viewing (not saved — the layout is set in the editor)
  const b = makeBoard([
    { key: 'stand', top: pairFig(stand, 'จุดยืน'), bottom: stand2 ? pairFig(stand2, 'จุดยืน 2') : null },
    { key: 'aim', top: pairFig(aim, 'จุดเล็ง', l.throw), bottom: aim2 ? pairFig(aim2, 'จุดเล็ง 2') : null },
  ], l.layout);
  b.classList.add('pair');
  b.append(el('span', { class: 'scroll-hint', 'aria-hidden': 'true', text: '▲ ปัดขึ้นดูวิธีทำ' }));
  return b;
}

function neighbour(id, dir) {
  const list = sortedVisible();
  const i = list.findIndex((x) => x.id === id);
  return i < 0 || list.length < 2 ? null : list[(i + dir + list.length) % list.length];
}

function openDetail(id) {
  const l = all().find((x) => x.id === id);
  if (!l) { toast('ไม่พบ lineup นี้'); return; }
  const mapChanged = norm(l.map) !== norm(state.map);
  if (mapChanged) state.map = canonMap(l.map) || l.map;
  state.selected = id;
  updateHash();
  if (mapChanged || !document.querySelector(`#list .card[data-id="${CSS.escape(id)}"]`)) render(); else applySelection();

  const d = $('#detail');
  const icon = iconFor(l);
  const media = (l.media || []).map(parseMedia).filter(Boolean);
  const { stand, stand2, aim, aim2, rest } = splitMedia(media);
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
      el('button', {
        type: 'button', class: 'btn icon land-only', title: 'สลับ เต็มช่อง / พอดีจอ', 'aria-label': 'สลับ เต็มช่อง / พอดีจอ',
        onclick: () => { const fit = !d.classList.contains('fit'); d.classList.toggle('fit', fit); store.set(LS.fit, fit); },
      }, '⤢'),
      el('button', { type: 'button', class: 'btn sm', onclick: () => { d.close(); openEditor(l); } }, '✎ แก้ไข'),
      navBtn('‹', 'lineup ก่อนหน้า', prev),
      navBtn('›', 'lineup ถัดไป', next),
      el('button', { type: 'button', class: 'btn icon', 'aria-label': 'ปิด', onclick: () => d.close() }, '✕')),
    el('div', { class: 'sheet-body' },
      showPair ? detailBoard(l, stand, stand2, aim, aim2) : null,
      el('div', { class: 'detail-cols' },
        el('div', { class: 'detail-text' },
          el('div', { class: 'chips' }, chips(l)),
          l.steps ? section('วิธีทำ', el('div', { class: 'steps', text: l.steps })) : null,
          l.throw ? section('การปา / ยิง', el('p', { text: l.throw })) : null,
          !l.steps && !l.throw && !media.length
            ? el('p', { class: 'muted', text: 'ยังไม่มีรายละเอียด กด “แก้ไข” เพื่อเพิ่มวิธีทำหรือรูป' }) : null),
        l.from || l.to ? miniMap(l) : null),
      rest.length ? section('คลิป / รูปอื่น ๆ', el('div', { class: 'gallery' }, rest.map(mediaEl))) : null)));

  d.classList.toggle('fit', !!store.get(LS.fit, false));
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
/** WebP when the browser can encode it (most can), otherwise JPEG. High quality: crosshair and small details must stay sharp. */
const IMG_QUALITY = 0.95;
function canvasBlob(c) {
  return new Promise((res) => c.toBlob((b) => {
    if (b && b.type === 'image/webp') res(b); else c.toBlob(res, 'image/jpeg', IMG_QUALITY);
  }, 'image/webp', IMG_QUALITY));
}
/** Full HD: a normal 1920×1080 game screenshot keeps its native resolution. */
/** Up to 1440p width: 1080p and 1440p game screenshots keep their native resolution. */
const MAX_W = 2560;
/** Draw an image at w×h; big reductions are done in halving steps so text and lines don't turn jagged or blurry. */
function drawScaled(img, w, h) {
  let src = img, sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
  while (sw / 2 >= w) {
    const step = el('canvas', { width: Math.round(sw / 2), height: Math.round(sh / 2) });
    const sctx = step.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(src, 0, 0, step.width, step.height);
    src = step; sw = step.width; sh = step.height;
  }
  const c = el('canvas', { width: w, height: h });
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}
async function shrinkImage(file) {
  const img = await loadImg(file);
  const k = Math.min(1, MAX_W / img.naturalWidth);
  return canvasBlob(drawScaled(img, Math.round(img.naturalWidth * k), Math.round(img.naturalHeight * k)));
}
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
const extOf = (blob) => (blob.type === 'image/webp' ? 'webp' : 'jpg');
/** Every edited picture gets a new file name (…-aim-v<time>.webp): overwriting the same name would keep showing
 *  the old picture from caches, and the site would look like the edit wasn't saved. Old files are removed on publish. */
function shotPath(d, kind, blob) {
  const ver = 'v' + Date.now().toString(36);
  return `media/${slug(d.map)}/${[slug(d.agent), slug(d.site), slug(d.ability), d.id, kind, ver].join('-')}.${extOf(blob)}`;
}

/* ---------- editor ---------- */

const SHOT_KINDS = ['stand', 'stand2', 'aim', 'aim2'];
const SHOT_LABEL = { stand: 'จุดยืน', stand2: 'จุดยืน 2', aim: 'จุดเล็ง', aim2: 'จุดเล็ง 2' };
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

function shotCell(kind, throwText) {
  const ed = state.editing;
  const s = ed.shots[kind];
  const label = SHOT_LABEL[kind];
  const base = kind.replace('2', '');
  const badge = kind === 'aim' ? throwText : '';
  const box = el('div', {
    class: 'shot' + (s ? ' has' : '') + (ed.activeShot === kind ? ' active' : ''), 'data-kind': kind,
    onclick: () => { ed.activeShot = kind; renderShots(); },
    ondragover: (e) => { e.preventDefault(); box.classList.add('drop'); },
    ondragleave: () => box.classList.remove('drop'),
    ondrop: (e) => { e.preventDefault(); box.classList.remove('drop'); const f = e.dataTransfer?.files?.[0]; if (f) setShotFile(kind, f); },
  });
  const remove = (e) => {
    e.stopPropagation();
    ed.shots[kind] = null;
    if (kind.endsWith('2')) ed.showSecond[base] = false;
    renderShots();
  };
  box.append(...(s
    ? [
      el('img', {
        src: s.url, alt: label, class: 'zoomable-img', title: 'แตะเพื่อขยาย',
        onclick: (e) => { e.stopPropagation(); ed.activeShot = kind; zoom(s.url, label, badge); },
      }),
      el('span', { class: 'cap', text: label }),
      badge ? el('span', { class: 'throw-badge', text: badge }) : null,
      el('span', { class: 'shot-tools' },
        el('button', { type: 'button', title: 'ขยายดู', 'aria-label': 'ขยายดู', onclick: (e) => { e.stopPropagation(); zoom(s.url, label, badge); } }, '🔍'),
        el('button', { type: 'button', title: 'ไฮไลต์ / ครอป', onclick: (e) => { e.stopPropagation(); annotateShot(kind); } }, '✎'),
        el('button', { type: 'button', title: 'เปลี่ยนรูป', onclick: (e) => { e.stopPropagation(); chooseShot(kind); } }, 'เปลี่ยน'),
        el('button', { type: 'button', title: 'ลบรูป', onclick: remove }, '✕')),
      !kind.endsWith('2') && !ed.shots[kind + '2'] && !ed.showSecond[kind]
        ? el('button', { type: 'button', class: 'add-slot', onclick: (e) => { e.stopPropagation(); ed.showSecond[kind] = true; ed.activeShot = kind + '2'; renderShots(); } }, '+ ช่องล่าง')
        : null,
    ].filter(Boolean)
    : [
      el('button', { type: 'button', class: 'shot-empty', onclick: (e) => { e.stopPropagation(); chooseShot(kind); } },
        el('b', { text: '+ รูป' + label }), el('small', { text: 'แตะเลือก · Ctrl+V · ลากไฟล์มาวาง' })),
      kind.endsWith('2') ? el('span', { class: 'shot-tools' }, el('button', { type: 'button', title: 'เอาช่องนี้ออก', onclick: remove }, '✕')) : null,
    ].filter(Boolean)));
  return box;
}

function renderShots() {
  const ed = state.editing;
  const throwText = readThrow();
  const cols = ['stand', 'aim'].map((key) => ({
    key,
    top: shotCell(key, throwText),
    bottom: ed.shots[key + '2'] || ed.showSecond[key] ? shotCell(key + '2', throwText) : null,
  }));
  $('#shotBoard').replaceChildren(makeBoard(cols, ed.layout, (lay) => { ed.layout = lay; }));
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
    if (kind.endsWith('2')) state.editing.showSecond[kind.replace('2', '')] = true;
    renderShots();
    annotateShot(kind, 'crop'); // crop right away so the picture is already close-up (Cancel keeps it as is)
  } catch (e) { toast(e.message); }
}

async function annotateShot(kind, mode) {
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
  const out = await openAnnot(orig, shapes || [], SHOT_LABEL[kind], mode);
  if (!out) return;
  state.editing.shots[kind] = { ...s, orig: out.base, blob: out.blob, shapes: out.shapes, url: URL.createObjectURL(out.blob), dirty: true };
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
  const split = splitMedia(media);
  const rest = split.rest;
  const fromMedia = (m) => (m ? { src: m.src, url: mediaSrc(m.src) } : null);
  state.editing = {
    draft: d, exists,
    shots: d._shots || Object.fromEntries(SHOT_KINDS.map((k) => [k, fromMedia(split[k])])),
    showSecond: {},
    layout: { ...d.layout },
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
  $('#btnDelete').hidden = !exists || (!ghReady() && state.base.some((b) => b.id === d.id));
  $('#mobileWarn').hidden = !isMobile() || ghReady();

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
  const lay = { ...LAYOUT_DEFAULT, ...state.editing.layout };
  const used = { col: true, stand: !!state.editing.shots.stand2, aim: !!state.editing.shots.aim2 };
  const changed = Object.keys(LAYOUT_DEFAULT).some((k) => used[k] && Math.abs(lay[k] - 0.5) > 0.01);
  d.layout = changed ? Object.fromEntries(Object.keys(LAYOUT_DEFAULT).filter((k) => used[k]).map((k) => [k, clampR(lay[k])])) : undefined;
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
  for (const kind of SHOT_KINDS) {
    const sh = state.editing.shots[kind];
    if (!sh) continue;
    let src = sh.src;
    if (sh.dirty) {
      src = shotPath(d, kind, sh.blob);
      await putLocalMedia(src, { blob: sh.blob, orig: sh.orig, shapes: sh.shapes || [] });
    }
    out.push({ src, caption: SHOT_LABEL[kind] });
  }
  return [...out, ...readRestMedia()];
}

/* ---------- highlight tool: circle / arrow / pen / crop ---------- */

/** Sizes per tool, as a share of the picture width: circle radius, arrow length, crop box width. */
const TOOL_SIZES = {
  circle: { s: 0.035, m: 0.06, l: 0.1 },
  arrow: { s: 0.08, m: 0.14, l: 0.22 },
  crop: { s: 0.3, m: 0.45, l: 0.65 },
};
const LINE_WIDTHS = { thin: 0.6, mid: 1, thick: 1.8 };
const annot = {
  img: null, baseBlob: null, shapes: [], history: [], crop: null, cur: null, before: null, resolve: null,
  tool: 'circle', color: '#ff4655', size: 'm', width: 'mid', dash: false, aspect: '16:9',
};
const ASPECTS = { free: 0, '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1 };
const imgW = (i) => i.naturalWidth || i.width;
const imgH = (i) => i.naturalHeight || i.height;
const copyShapes = (x) => JSON.parse(JSON.stringify(x));

/** Small pictures (e.g. a tight crop) are enlarged to at least this width with smooth resampling,
 *  so they don't look blocky on big screens and highlights are drawn crisply. */
const MIN_OUT_W = 1600;
function sizeAnnotCanvas() {
  const c = $('#annotCanvas');
  const w = imgW(annot.img);
  const k = Math.min(MAX_W / w, Math.max(1, Math.min(3, MIN_OUT_W / w)));
  c.width = Math.round(imgW(annot.img) * k);
  c.height = Math.round(imgH(annot.img) * k);
}

async function openAnnot(blob, shapes, label, mode) {
  annot.img = await loadImg(blob);
  annot.baseBlob = blob;
  annot.shapes = copyShapes(shapes);
  annot.history = [];
  annot.crop = null;
  annot.tool = mode === 'crop' ? 'crop' : (annot.tool === 'crop' ? 'circle' : annot.tool);
  sizeAnnotCanvas();
  $('#annot').setAttribute('aria-label', 'ไฮไลต์รูป' + label);
  syncAnnotBar();
  drawAnnot();
  $('#annot').showModal();
  return new Promise((res) => { annot.resolve = res; });
}

function drawShape(ctx, sh, w, h) {
  const lw = Math.max(2, Math.round(w / 200 * (sh.w || 1)));
  ctx.save();
  ctx.strokeStyle = sh.color; ctx.fillStyle = sh.color; ctx.lineWidth = lw;
  ctx.lineCap = sh.dash ? 'butt' : 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = lw * 1.5;
  if (sh.dash) ctx.setLineDash([lw * 3, lw * 2.2]);
  ctx.beginPath();
  if (sh.type === 'circle') {
    const cx = (sh.x1 + sh.x2) / 2 * w, cy = (sh.y1 + sh.y2) / 2 * h;
    ctx.ellipse(cx, cy, Math.abs(sh.x2 - sh.x1) / 2 * w || 1, Math.abs(sh.y2 - sh.y1) / 2 * h || 1, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (sh.type === 'arrow') {
    const x1 = sh.x1 * w, y1 = sh.y1 * h, x2 = sh.x2 * w, y2 = sh.y2 * h;
    const a = Math.atan2(y2 - y1, x2 - x1), hl = Math.max(lw * 4.5, 12);
    ctx.moveTo(x1, y1); ctx.lineTo(x2 - Math.cos(a) * hl * 0.6, y2 - Math.sin(a) * hl * 0.6); ctx.stroke();
    ctx.setLineDash([]);
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

/** Picture + highlights only (what gets saved). */
function paintAnnot(ctx, w, h) {
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(annot.img, 0, 0, w, h);
  for (const sh of annot.shapes) drawShape(ctx, sh, w, h);
}

function drawAnnot() {
  const c = $('#annotCanvas');
  const ctx = c.getContext('2d');
  paintAnnot(ctx, c.width, c.height);
  const cr = annot.crop;
  if (cr) { // dim everything outside the crop box
    const [x, y, w, h] = [cr.x * c.width, cr.y * c.height, cr.w * c.width, cr.h * c.height];
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.beginPath(); ctx.rect(0, 0, c.width, c.height); ctx.rect(x, y, w, h); ctx.fill('evenodd');
    ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, c.width / 500); ctx.setLineDash([10, 6]);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
  $('#annot [data-annot=applycrop]').hidden = !cr || cr.w < 0.02 || cr.h < 0.02;
}

function syncAnnotBar() {
  const bar = $('#annot');
  for (const b of bar.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === annot.tool);
  for (const b of bar.querySelectorAll('[data-color]')) b.classList.toggle('on', b.dataset.color === annot.color);
  for (const b of bar.querySelectorAll('[data-size]')) b.classList.toggle('on', b.dataset.size === annot.size);
  for (const b of bar.querySelectorAll('[data-width]')) b.classList.toggle('on', b.dataset.width === annot.width);
  for (const b of bar.querySelectorAll('[data-aspect]')) b.classList.toggle('on', b.dataset.aspect === annot.aspect);
  bar.querySelector('.annot-aspect').hidden = annot.tool !== 'crop';
  bar.querySelector('[data-annot=dash]').classList.toggle('on', annot.dash);
  const cropping = annot.tool === 'crop';
  for (const g of bar.querySelectorAll('.annot-style')) g.hidden = cropping;
  bar.querySelector('.annot-sizes').hidden = annot.tool === 'pen';
  $('#annotCanvas').style.cursor = 'crosshair';
  $('#annot .annot-hint').textContent = {
    crop: 'แตะจุดที่จะเล็ง / ยืน = กรอบครอปรอบจุดนั้น · S/M/L เปลี่ยนขนาด · ลากออกจากจุด = ปรับเอง → ✓ ใช้ครอป',
    circle: 'แตะจุดที่จะเล็ง / ยืน = วงกลมรอบจุดนั้น · S/M/L เปลี่ยนขนาด · ลากออกจากจุด = ปรับเอง',
    arrow: 'แตะจุดที่จะเล็ง / ยืน = ลูกศรชี้ไปที่จุดนั้น · S/M/L เปลี่ยนความยาว · ลาก = เลือกทิศ',
    pen: 'ลากเพื่อวาดอิสระ',
  }[annot.tool] || '';
}

function pushHistory() {
  annot.history.push({ img: annot.img, baseBlob: annot.baseBlob, shapes: copyShapes(annot.shapes) });
  if (annot.history.length > 50) annot.history.shift();
}

/* Everything is placed from a centre point: the spot to aim at / stand on. */
const picRatio = () => imgW(annot.img) / imgH(annot.img); // normalised y per normalised x for equal pixels

function circleAt(cx, cy, r) {
  const ry = r * picRatio();
  return { cx, cy, x1: cx - r, x2: cx + r, y1: cy - ry, y2: cy + ry };
}
/** Arrow whose head is at (cx, cy); the tail sits `len` away at angle `a` (default: from the lower right). */
function arrowAt(cx, cy, len, a) {
  let ang = a ?? Math.PI * 0.75;
  const tail = (t) => [cx - Math.cos(t) * len, cy + Math.sin(t) * len * picRatio()];
  let [tx, ty] = tail(ang);
  if (a == null && (tx < 0 || ty > 1)) { // keep the default tail on the picture
    for (const t of [Math.PI * 0.25, -Math.PI * 0.25, -Math.PI * 0.75]) {
      const [x, y] = tail(t);
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) { ang = t; [tx, ty] = [x, y]; break; }
    }
  }
  return { cx, cy, ang, len, x1: tx, y1: ty, x2: cx, y2: cy };
}
/** Crop box of width w centred on (cx, cy), locked to the chosen aspect (or height hFree when free), kept inside the picture. */
function cropAt(cx, cy, w, hFree) {
  const ratio = ASPECTS[annot.aspect];
  w = Math.max(0.05, w);
  let h = ratio ? w * picRatio() / ratio : Math.max(0.05, hFree ?? w);
  const f = Math.min(1, 1 / w, 1 / h);
  w *= f; h *= f;
  const x = Math.min(1 - w, Math.max(0, cx - w / 2));
  const y = Math.min(1 - h, Math.max(0, cy - h / 2));
  return { cx, cy, x, y, w, h };
}

function applyCrop() {
  const cr = annot.crop;
  annot.crop = null;
  if (!cr || cr.w < 0.02 || cr.h < 0.02) { drawAnnot(); return; }
  const W = imgW(annot.img), H = imgH(annot.img);
  const cv = el('canvas', { width: Math.round(cr.w * W), height: Math.round(cr.h * H) });
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(annot.img, cr.x * W, cr.y * H, cr.w * W, cr.h * H, 0, 0, cv.width, cv.height);
  pushHistory();
  // move highlights into the cropped picture's coordinates
  const fx = (x) => round3((x - cr.x) / cr.w), fy = (y) => round3((y - cr.y) / cr.h);
  annot.shapes = annot.shapes.map((sh) => (sh.type === 'pen'
    ? { ...sh, pts: sh.pts.map(([x, y]) => [fx(x), fy(y)]), w: (sh.w || 1) / cr.w }
    : { ...sh, x1: fx(sh.x1), y1: fy(sh.y1), x2: fx(sh.x2), y2: fy(sh.y2), w: (sh.w || 1) / cr.w }));
  annot.img = cv;
  annot.baseBlob = null;
  sizeAnnotCanvas();
  annot.tool = 'circle';
  syncAnnotBar();
  drawAnnot();
}

function closeAnnot(result) {
  const r = annot.resolve;
  annot.resolve = null;
  if ($('#annot').open) $('#annot').close();
  r?.(result);
}

async function finishAnnot() {
  if (annot.crop) applyCrop();
  const c = $('#annotCanvas');
  annot.crop = null;
  paintAnnot(c.getContext('2d'), c.width, c.height); // no crop overlay in the saved picture
  const blob = await canvasBlob(c);
  // base = picture without highlights (cropped if cropped), kept so highlights stay editable later
  let base = annot.baseBlob;
  if (!base) {
    const bc = el('canvas', { width: c.width, height: c.height });
    const bctx = bc.getContext('2d');
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(annot.img, 0, 0, bc.width, bc.height);
    base = await canvasBlob(bc);
  }
  closeAnnot({ blob, base, shapes: annot.shapes });
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
    const size = TOOL_SIZES[annot.tool]?.[annot.size];
    if (annot.tool === 'crop') { annot.crop = cropAt(x, y, size); annot.cur = { crop: true, cx: x, cy: y }; drawAnnot(); return; }
    annot.before = { img: annot.img, baseBlob: annot.baseBlob, shapes: copyShapes(annot.shapes) };
    const style = { color: annot.color, w: LINE_WIDTHS[annot.width], dash: annot.dash || undefined };
    annot.cur = annot.tool === 'pen' ? { type: 'pen', ...style, pts: [[x, y]] }
      : annot.tool === 'circle' ? { type: 'circle', ...style, ...circleAt(x, y, size) }
      : { type: 'arrow', ...style, ...arrowAt(x, y, size) };
    annot.cur.start = [x, y];
    annot.shapes.push(annot.cur);
    annot.last = annot.tool === 'pen' ? null : annot.cur;
    drawAnnot();
  });
  c.addEventListener('pointermove', (e) => {
    const cur = annot.cur;
    if (!cur) return;
    const [x, y] = pt(e);
    const dx = x - cur.cx, dy = (y - cur.cy) / picRatio(); // in width units
    const dist = Math.hypot(dx, dy);
    if (cur.crop) {
      if (dist > 0.02) { // drag from the centre: the box grows around it
        const ratio = ASPECTS[annot.aspect];
        annot.crop = ratio
          ? cropAt(cur.cx, cur.cy, Math.max(Math.abs(dx) * 2, Math.abs(dy) * 2 * ratio, 0.05))
          : cropAt(cur.cx, cur.cy, Math.abs(x - cur.cx) * 2, Math.abs(y - cur.cy) * 2);
      }
    } else if (cur.type === 'pen') cur.pts.push([x, y]);
    else if (cur.type === 'circle') { if (dist > 0.01) Object.assign(cur, circleAt(cur.cx, cur.cy, dist)); }
    else if (cur.type === 'arrow') { if (dist > 0.02) Object.assign(cur, arrowAt(cur.cx, cur.cy, dist, Math.atan2(dy, -dx))); } // tail follows the finger
    drawAnnot();
  });
  const end = () => {
    const sh = annot.cur;
    annot.cur = null;
    if (!sh || sh.crop) { drawAnnot(); return; }
    delete sh.start;
    annot.history.push(annot.before);
    annot.before = null;
    drawAnnot();
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);

  $('#annot').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.tool) { annot.tool = d.tool; annot.last = null; if (d.tool !== 'crop') annot.crop = null; }
    if (d.color) annot.color = d.color;
    if (d.size) {
      annot.size = d.size;
      const sz = TOOL_SIZES[annot.tool]?.[d.size];
      if (annot.tool === 'crop' && annot.crop) annot.crop = cropAt(annot.crop.cx, annot.crop.cy, sz);
      else if (annot.last && annot.last.type === annot.tool && annot.shapes.includes(annot.last)) {
        pushHistory();
        const i = annot.shapes.length - 1 - [...annot.shapes].reverse().indexOf(annot.last);
        const L = annot.shapes[i];
        Object.assign(L, L.type === 'circle' ? circleAt(L.cx, L.cy, sz) : arrowAt(L.cx, L.cy, sz, L.ang));
        annot.last = L;
      }
    }
    if (d.width) annot.width = d.width;
    if (d.aspect) { annot.aspect = d.aspect; if (annot.crop) annot.crop = cropAt(annot.crop.cx, annot.crop.cy, annot.crop.w); }
    if (d.annot === 'dash') annot.dash = !annot.dash;
    if (d.annot === 'undo') {
      if (annot.crop) annot.crop = null;
      else {
        const prev = annot.history.pop();
        if (prev) { Object.assign(annot, prev); annot.last = null; sizeAnnotCanvas(); }
      }
    }
    if (d.annot === 'clear' && annot.shapes.length) { pushHistory(); annot.shapes = []; }
    if (d.annot === 'applycrop') applyCrop();
    if (d.annot === 'cancel') { closeAnnot(null); return; }
    if (d.annot === 'done') { await finishAnnot(); return; }
    syncAnnotBar();
    drawAnnot();
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
  if (state.peek && !state.pick && !state.smokePick) { closePeek(); return; }
  const r = $('#mapInner').getBoundingClientRect(); // the zoomed layer, so taps map to the right spot
  const pt = { x: round3((e.clientX - r.left) / r.width), y: round3((e.clientY - r.top) / r.height) };
  const sp = state.smokePick;
  if (sp) {
    state.planEdit.smokes.push({ agent: sp.agent, ability: sp.ability, ...pt });
    sp.added++;
    renderMap();
    updateSmokeBanner();
    return;
  }
  const p = state.pick;
  if (!p) return;
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

/* ---------- publish to GitHub (one commit: data/lineups.json + new images) ---------- */

function defaultRepo() {
  const host = location.hostname;
  const first = location.pathname.split('/').filter(Boolean)[0];
  return host.endsWith('.github.io') && first ? `${host.split('.')[0]}/${first}` : 'Cinnammonmio/lineup-notebook';
}
const gh = {
  cfg: { repo: defaultRepo(), branch: 'main', token: '', auto: true, ...store.get(LS.gh, {}) },
  busy: false,
  again: false,
  extraFiles: {}, // other repo files to publish with the next commit (e.g. data/inbox.json)
};
const ghReady = () => !!gh.cfg.token && /^[\w.-]+\/[\w.-]+$/.test(gh.cfg.repo);

/** Local changes that haven't been pushed in their current form. */
function unpublished() {
  const pushed = store.get(LS.pushed, {});
  return Object.entries(state.local).filter(([id, o]) => pushed[id] !== (o._deleted ? DELETED : stable(clean(o))));
}

async function ghApi(path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${gh.cfg.repo}${path}`, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + gh.cfg.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  if (r.ok) return r.status === 204 ? null : r.json();
  const why = { 401: 'token ไม่ถูกต้องหรือหมดอายุ', 403: 'token ไม่มีสิทธิ์เขียน (ต้องเป็น Contents: Read and write)', 404: 'ไม่พบ repo/branch หรือ token ไม่ได้เลือก repo นี้', 409: 'repo ว่างเปล่า', 422: 'มีคนแก้ repo พร้อมกัน' }[r.status];
  const err = new Error(why || `GitHub ตอบกลับ ${r.status}`);
  err.status = r.status;
  throw err;
}

const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
const blobToB64 = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1]);
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});

/** Apply this browser's edits on top of the lineups currently on GitHub. */
function mergeLocal(remote) {
  const out = [];
  const seen = new Set();
  for (const r of remote) {
    if (!r || typeof r !== 'object' || !r.id) continue;
    seen.add(r.id);
    const o = state.local[r.id];
    if (o?._deleted) continue;
    out.push(o ? clean(o) : r);
  }
  for (const [id, o] of Object.entries(state.local)) if (!seen.has(id) && !o._deleted) out.push(clean(o));
  return out;
}

async function publishOnce() {
  const branch = encodeURIComponent(gh.cfg.branch || 'main');
  const ref = await ghApi(`/git/ref/heads/${branch}`);
  const head = ref.object.sha;
  const commit = await ghApi(`/git/commits/${head}`);
  let remote = [];
  try {
    const f = await ghApi(`/contents/data/lineups.json?ref=${head}`);
    const text = f.content ? b64ToText(f.content) : b64ToText((await ghApi(`/git/blobs/${f.sha}`)).content);
    const j = JSON.parse(text);
    remote = Array.isArray(j) ? j : j.lineups || [];
  } catch (e) { if (e.status !== 404) throw e; }

  const items = mergeLocal(remote);
  const tree = [{ path: 'data/lineups.json', mode: '100644', type: 'blob', content: JSON.stringify(items, null, 2) + '\n' }];
  const extra = { ...gh.extraFiles };
  for (const [path, content] of Object.entries(extra)) tree.push({ path, mode: '100644', type: 'blob', content });
  const paths = [...new Set(items.flatMap(mediaPaths))].filter((x) => localUrls.has(x));
  for (const path of paths) {
    const rec = await mediaDb.get(path).catch(() => null);
    if (!rec?.blob) continue;
    const blob = await ghApi('/git/blobs', { method: 'POST', body: { content: await blobToB64(rec.blob), encoding: 'base64' } });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  // remove pictures no lineup uses any more (replaced or deleted) — only ones that really exist in the repo
  const keep = new Set(items.flatMap(mediaPaths));
  const gone = [...new Set(remote.flatMap(mediaPaths))].filter((x) => /^media\//.test(x) && !keep.has(x));
  if (gone.length) {
    const existing = new Set((await ghApi(`/git/trees/${commit.tree.sha}?recursive=1`)).tree.map((t) => t.path));
    for (const path of gone) if (existing.has(path)) tree.push({ path, mode: '100644', type: 'blob', sha: null });
  }
  const changes = unpublished();
  const nameOf = (id, o) => o.title || remote.find((r) => r?.id === id)?.title || state.base.find((x) => x.id === id)?.title || id;
  const titles = changes.map(([id, o]) => (o._deleted ? 'ลบ ' : '') + nameOf(id, o)).slice(0, 5).join(', ');
  const newTree = await ghApi('/git/trees', { method: 'POST', body: { base_tree: commit.tree.sha, tree } });
  const msg = titles ? `Update lineups from ARC: ${titles}` : Object.keys(extra).length ? 'Update ARC settings' : 'Update lineups from ARC: sync';
  const newCommit = await ghApi('/git/commits', { method: 'POST', body: { message: msg, tree: newTree.sha, parents: [head] } });
  await ghApi(`/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: newCommit.sha } });
  for (const k of Object.keys(extra)) delete gh.extraFiles[k];

  // remember what was pushed; local copies stay until the deployed site has them (pruneLocal)
  const pushed = store.get(LS.pushed, {});
  for (const [id, o] of changes) pushed[id] = o._deleted ? DELETED : stable(clean(o));
  store.set(LS.pushed, pushed);
  return { lineups: items.length, images: tree.filter((t) => t.sha).length };
}

async function publish({ quiet } = {}) {
  if (!ghReady()) { openGhDialog(); return; }
  if (gh.busy) { gh.again = true; return; }
  if (!unpublished().length && !Object.keys(gh.extraFiles).length) { if (!quiet) toast('ไม่มีอะไรต้องขึ้น GitHub'); return; }
  gh.busy = true;
  renderUnsynced();
  try {
    let res;
    try { res = await publishOnce(); } catch (e) { if (e.status === 422) res = await publishOnce(); else throw e; } // someone pushed meanwhile: retry on the new head
    toast(`ขึ้น GitHub แล้ว (${res.lineups} lineup${res.images ? `, ${res.images} รูป` : ''}) — มือถือเห็นใน 1–2 นาที`);
  } catch (e) {
    toast('ขึ้น GitHub ไม่ได้: ' + (navigator.onLine === false ? 'ไม่มีอินเทอร์เน็ต' : e.message) + ' — ข้อมูลยังอยู่ในเครื่อง');
  } finally {
    gh.busy = false;
    pruneLocal();
    renderUnsynced();
    if (gh.again) { gh.again = false; publish({ quiet: true }); }
  }
}

function openGhDialog() {
  const f = $('#ghForm').elements;
  f.token.value = gh.cfg.token;
  f.repo.value = gh.cfg.repo;
  f.branch.value = gh.cfg.branch;
  f.auto.checked = gh.cfg.auto;
  $('#ghStatus').textContent = gh.cfg.token ? 'ตั้งค่าไว้แล้ว' : 'ยังไม่ได้ใส่ token';
  $('#ghForget').hidden = !gh.cfg.token;
  $('#ghDialog').showModal();
}
function readGhForm() {
  const f = $('#ghForm').elements;
  return { token: f.token.value.trim(), repo: f.repo.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, ''), branch: f.branch.value.trim() || 'main', auto: f.auto.checked };
}
function bindGh() {
  const dlg = $('#ghDialog');
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('#ghTest').addEventListener('click', async () => {
    const prev = gh.cfg;
    gh.cfg = { ...gh.cfg, ...readGhForm() };
    $('#ghStatus').textContent = 'กำลังทดสอบ…';
    try {
      await ghApi(`/git/ref/heads/${encodeURIComponent(gh.cfg.branch)}`);
      $('#ghStatus').textContent = '✓ เชื่อมต่อได้ (สิทธิ์เขียนจะเช็กตอนขึ้น GitHub ครั้งแรก)';
    } catch (e) { $('#ghStatus').textContent = '✕ ' + e.message; }
    gh.cfg = prev;
  });
  $('#ghForget').addEventListener('click', () => {
    gh.cfg.token = '';
    store.set(LS.gh, gh.cfg);
    dlg.close();
    renderUnsynced();
    toast('ลบ token ออกจากเครื่องนี้แล้ว');
  });
  $('#ghForm').addEventListener('submit', (e) => {
    e.preventDefault();
    gh.cfg = { ...gh.cfg, ...readGhForm() };
    store.set(LS.gh, gh.cfg);
    dlg.close();
    renderUnsynced();
    toast(ghReady() ? 'บันทึกการตั้งค่า GitHub แล้ว' : 'ยังไม่ได้ใส่ token');
    if (ghReady() && unpublished().length) publish();
  });
}

/* ---------- friends: send lineups to the owner, who reviews and publishes them ---------- */

const blobToDataUrl = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
const dataUrlToBlob = async (u) => (await fetch(u)).blob();

/** Friend: pack this device's new / edited lineups (with their pictures) into one file and share it. */
async function submitToOwner() {
  const sent = store.get('lp.submitted', {});
  const all_ = Object.values(state.local).filter((x) => !x._deleted && !isPlan(x)).map(clean);
  const items = inbox.cfg ? all_.filter((x) => sent[x.id] !== stable(x)) : all_;
  if (!items.length) { toast(all_.length ? 'ส่งครบแล้ว — แก้หรือเพิ่ม lineup ใหม่แล้วค่อยส่งอีกครั้ง' : 'ยังไม่มี lineup ที่เพิ่ม / แก้ในเครื่องนี้'); return; }
  let name = store.get('lp.myName', '');
  if (!name) {
    name = (prompt('ชื่อของคุณ (จะขึ้นเป็น "โดย …" บน lineup)') || '').trim().slice(0, 30);
    if (!name) return;
    store.set('lp.myName', name);
  }
  const images = {};
  for (const path of new Set(items.flatMap(mediaPaths))) {
    if (!localUrls.has(path)) continue;
    const rec = await mediaDb.get(path).catch(() => null);
    if (rec?.blob) images[path] = await blobToDataUrl(rec.blob);
  }
  const pack = { type: 'arc-lineups', version: APP_VERSION, from: name, created: new Date().toISOString(), lineups: items, images };
  if (inbox.cfg) {
    toast('กำลังส่ง…');
    try {
      await inboxSend(name, pack);
      for (const x of items) sent[x.id] = stable(x);
      store.set('lp.submitted', sent);
      toast(`ส่ง ${items.length} lineup แล้ว — รอเจ้าของตรวจและเพิ่มเข้าสมุด`);
      return;
    } catch (e) { toast('ส่งเข้ากล่องรับไม่ได้ (' + e.message + ') — จะใช้วิธีส่งไฟล์แทน'); }
  }
  const date = new Date().toISOString().slice(0, 10);
  const file = new File([JSON.stringify(pack)], `arc-${slug(name)}-${date}.json`, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: `lineup จาก ${name}` }); toast('ส่งแล้ว — รอเจ้าของรับเข้าสมุด'); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  download(file, file.name);
  toast(`ได้ไฟล์ ${file.name} — ส่งให้เจ้าของทาง LINE / Discord`);
}

/** Owner: open a friend's file and review it before adding. */
async function receiveFromFriend(file) {
  let pack;
  try { pack = JSON.parse(await file.text()); } catch { toast('ไฟล์ไม่ถูกต้อง'); return; }
  if (pack?.type !== 'arc-lineups' || !Array.isArray(pack.lineups)) { toast('ไม่ใช่ไฟล์ lineup จากเพื่อน'); return; }
  const items = pack.lineups.filter((x) => x && typeof x === 'object' && !isPlan(x) && x.map);
  if (!items.length) { toast('ไฟล์นี้ไม่มี lineup'); return; }
  state.review = { pack, items, picked: new Set(items.map((_, i) => i)) };
  $('#reviewTitle').textContent = `lineup จาก ${pack.from || 'เพื่อน'}`;
  $('#reviewInfo').textContent = `${items.length} lineup · ติ๊กอันที่จะเพิ่มเข้าสมุด (ของเดิมจะไม่ถูกทับหรือลบ)`;
  renderReview();
  $('#reviewDialog').showModal();
}

function renderReview() {
  const rv = state.review;
  $('#reviewList').replaceChildren(...rv.items.map((l, i) => {
    const { stand, aim } = splitMedia((l.media || []).map(parseMedia).filter(Boolean));
    const thumb = (m) => (m && rv.pack.images?.[m.src] ? el('img', { src: rv.pack.images[m.src], alt: '' }) : el('span', { class: 'rv-none' }));
    const a = agentOf(l.agent);
    const on = rv.picked.has(i);
    return el('li', { class: 'rv-item' + (on ? ' on' : ''), onclick: () => { if (on) rv.picked.delete(i); else rv.picked.add(i); renderReview(); } },
      el('span', { class: 'rv-check', text: on ? '✓' : '' }),
      a?.icon ? el('img', { class: 'rv-face', src: a.icon, alt: l.agent }) : null,
      el('span', { class: 'rv-body' },
        el('b', { text: l.title || '(ไม่มีชื่อ)' }),
        el('small', { text: [l._from && 'จาก ' + l._from, l.map, l.agent, l.ability, l.site && 'ไซต์ ' + l.site].filter(Boolean).join(' · ') })),
      el('span', { class: 'rv-thumbs' }, thumb(stand), thumb(aim)));
  }));
  $('#reviewAccept').textContent = `เพิ่มที่เลือก (${rv.picked.size})`;
  $('#reviewAccept').disabled = !rv.picked.size;
}

async function acceptReview() {
  const rv = state.review;
  let n = 0;
  for (const i of rv.picked) {
    const src = rv.items[i];
    const from = String(src._from || rv.pack.from || 'เพื่อน').slice(0, 30);
    const d = { ...src, id: newId(), by: src.by || from }; // always a new lineup: never overwrites the owner's
    delete d._from;
    delete d._local; delete d._deleted;
    const split = splitMedia((d.media || []).map(parseMedia).filter(Boolean));
    const kindOf = new Map(SHOT_KINDS.filter((k) => split[k]).map((k) => [split[k].src, k]));
    const media = [];
    for (const m of (d.media || []).map(parseMedia).filter(Boolean)) {
      const data = rv.pack.images?.[m.src];
      if (data) {
        const blob = await dataUrlToBlob(data);
        const path = shotPath(d, kindOf.get(m.src) || 'extra', blob);
        await putLocalMedia(path, { blob, orig: blob, shapes: [] });
        media.push({ src: path, caption: m.caption });
      } else if (!/^media\//.test(m.src)) media.push(m); // links (e.g. YouTube) carry over; missing files don't
    }
    d.media = media;
    saveLineup(d);
    n++;
  }
  $('#reviewDialog').close();
  if (rv.inboxIds?.length) await inboxDelete(rv.inboxIds).catch((e) => toast('ลบออกจากกล่องรับไม่ได้: ' + e.message));
  state.review = null;
  render();
  inboxRefresh();
  toast(ghReady() && gh.cfg.auto ? `เพิ่ม ${n} lineup แล้ว — กำลังขึ้น GitHub…` : `เพิ่ม ${n} lineup ในเครื่องแล้ว`);
  if (ghReady() && gh.cfg.auto) publish({ quiet: true });
}

/* ---------- inbox (Supabase): friends send from the website, only the owner can read ---------- */

const inbox = { cfg: null, count: 0 };
const inboxPass = () => store.get('lp.inboxPass', '');

async function inboxLoad() {
  try {
    const r = await fetch('data/inbox.json', { cache: 'no-cache' });
    const j = r.ok ? await r.json() : null;
    inbox.cfg = j?.url && j?.anonKey ? { url: j.url.replace(/\/+$/, ''), anonKey: j.anonKey } : null;
  } catch { inbox.cfg = null; }
  inboxRefresh();
}

async function inboxCall(path, body, prefer) {
  const c = inbox.cfg;
  if (!c) throw new Error('ยังไม่ได้ตั้งกล่องรับ');
  const r = await fetch(`${c.url}/rest/v1/${path}`, {
    method: 'POST', cache: 'no-store',
    headers: { apikey: c.anonKey, Authorization: 'Bearer ' + c.anonKey, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(/passphrase/i.test(t) ? 'รหัสผ่านเจ้าของไม่ถูกต้อง' : r.status === 413 ? 'ไฟล์ใหญ่เกินไป' : `ข้อผิดพลาด ${r.status}`);
  }
  const text = await r.text(); // inserts with return=minimal answer 201 with an empty body
  return text ? JSON.parse(text) : null;
}
const inboxSend = (sender, payload) => inboxCall('arc_inbox', { sender, payload }, 'return=minimal');
const inboxDelete = (ids) => inboxCall('rpc/arc_inbox_delete', { pass: inboxPass(), ids });

/** Owner: number of submissions waiting (shown as a badge). */
async function inboxRefresh() {
  const b = $('#inboxBadge');
  if (!inbox.cfg || !inboxPass()) { b.hidden = true; return; }
  try {
    inbox.count = await inboxCall('rpc/arc_inbox_count', { pass: inboxPass() });
    b.hidden = !inbox.count;
    b.textContent = `📥 รอตรวจ ${inbox.count}`;
  } catch { b.hidden = true; }
}

async function inboxOpen() {
  if (!inbox.cfg) { toast('ยังไม่ได้ตั้งกล่องรับ — ⋯ → ตั้งค่ากล่องรับ'); return; }
  if (!inboxPass()) { openInboxDialog(); return; }
  toast('กำลังโหลด…');
  let rows;
  try { rows = await inboxCall('rpc/arc_inbox_list', { pass: inboxPass() }); } catch (e) { toast(e.message); return; }
  const items = [], images = {};
  for (const row of rows || []) {
    const p = row.payload || {};
    Object.assign(images, p.images || {});
    for (const l of p.lineups || []) if (l && typeof l === 'object' && !isPlan(l) && l.map) items.push({ ...l, _from: row.sender || p.from });
  }
  if (!items.length) { toast('กล่องรับว่าง'); if (rows?.length) inboxDelete(rows.map((x) => x.id)).then(inboxRefresh); return; }
  state.review = { pack: { images }, items, picked: new Set(items.map((_, i) => i)), inboxIds: rows.map((x) => x.id) };
  $('#reviewTitle').textContent = 'lineup จากเพื่อน (กล่องรับ)';
  $('#reviewInfo').textContent = `${items.length} lineup จาก ${rows.length} ครั้งที่ส่ง · ติ๊กอันที่จะเพิ่ม — อันที่ไม่ติ๊กจะถูกทิ้งจากกล่องรับ (ของเดิมในสมุดไม่ถูกทับหรือลบ)`;
  renderReview();
  $('#reviewDialog').showModal();
}

function openInboxDialog() {
  const f = $('#inboxForm').elements;
  f.url.value = inbox.cfg?.url || '';
  f.anonKey.value = inbox.cfg?.anonKey || '';
  f.pass.value = inboxPass();
  $('#inboxStatus').textContent = inbox.cfg ? 'เปิดใช้กล่องรับแล้ว' : 'ยังไม่ได้ตั้ง — ดูวิธีใน docs/inbox-setup.md';
  $('#inboxDialog').showModal();
}

function bindInbox() {
  const dlg = $('#inboxDialog');
  const f = $('#inboxForm').elements;
  for (const b of dlg.querySelectorAll('[data-close]')) b.addEventListener('click', () => dlg.close());
  $('#inboxBadge').addEventListener('click', inboxOpen);
  $('#inboxTest').addEventListener('click', async () => {
    const prev = inbox.cfg;
    inbox.cfg = { url: f.url.value.trim().replace(/\/+$/, ''), anonKey: f.anonKey.value.trim() };
    const pass = inboxPass(); store.set('lp.inboxPass', f.pass.value);
    $('#inboxStatus').textContent = 'กำลังทดสอบ…';
    try { const n = await inboxCall('rpc/arc_inbox_count', { pass: f.pass.value }); $('#inboxStatus').textContent = `✓ เชื่อมต่อได้ · รอตรวจ ${n}`; }
    catch (e) { $('#inboxStatus').textContent = '✕ ' + e.message; }
    inbox.cfg = prev; store.set('lp.inboxPass', pass);
  });
  $('#inboxForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = f.url.value.trim().replace(/\/+$/, ''), anonKey = f.anonKey.value.trim();
    store.set('lp.inboxPass', f.pass.value);
    const changed = url !== (inbox.cfg?.url || '') || anonKey !== (inbox.cfg?.anonKey || '');
    inbox.cfg = url && anonKey ? { url, anonKey } : null;
    dlg.close();
    if (changed) {
      // friends' browsers read the inbox address from the repo
      gh.extraFiles['data/inbox.json'] = JSON.stringify(inbox.cfg || {}, null, 2) + '\n';
      if (ghReady()) { publish({ quiet: true }); toast('บันทึกแล้ว — กำลังขึ้น GitHub ให้เพื่อนใช้ได้'); }
      else toast('บันทึกแล้ว — ตั้งค่า GitHub ก่อน เพื่อให้เพื่อนใช้กล่องรับได้');
    } else toast('บันทึกแล้ว');
    inboxRefresh();
  });
  setInterval(() => { if (document.visibilityState === 'visible') inboxRefresh(); }, 3 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') inboxRefresh(); });
}

function bindFriends() {
  const dlg = $('#reviewDialog');
  for (const b of dlg.querySelectorAll('[data-close]')) b.addEventListener('click', () => dlg.close());
  $('#reviewAll').addEventListener('click', () => { state.review.picked = new Set(state.review.items.map((_, i) => i)); renderReview(); });
  $('#reviewAccept').addEventListener('click', acceptReview);
  $('#receiveFile').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) receiveFromFriend(f); e.target.value = ''; });
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
  const items = allItems().map(clean);
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
  $('#unsynced').addEventListener('click', () => {
    if (!ghReady()) exportJson();
    else if (unpublished().length) publish();
    else toast('ส่งขึ้น GitHub แล้ว — เว็บจะอัปเดตใน 1–2 นาที');
  });
  bindGh();
  bindPlans();
  bindFriends();
  bindInbox();
  $('#mapWrap').addEventListener('click', onMapClick);
  $('#peek').addEventListener('click', (e) => e.stopPropagation()); // clicks inside the preview don't reach the map
  $('#spike').addEventListener('click', (e) => e.stopPropagation());
  // a dialog opening or closing while the timer is full screen: follow it to the right place
  document.addEventListener('close', () => setTimeout(spikeHost, 0), true);
  for (const d of document.querySelectorAll('dialog')) new MutationObserver(spikeHost).observe(d, { attributes: true, attributeFilter: ['open'] });
  spikeIdle();
  loadSpikeIcon();
  $('#filterPop').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { if (!$('#filterPop').hidden) { $('#filterPop').hidden = true; renderList(); } });
  window.addEventListener('resize', () => renderMap());

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
    if (act === 'github') openGhDialog();
    if (act === 'update') manualUpdate();
    if (act === 'publish') publish();
    if (act === 'import') $('#importFile').click();
    if (act === 'submit') submitToOwner();
    if (act === 'receive') { if (inbox.cfg && inboxPass()) inboxOpen(); else $('#receiveFile').click(); }
    if (act === 'receiveFile') $('#receiveFile').click();
    if (act === 'inbox') openInboxDialog();
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
    saveFilters();
    render();
  });

  // dialogs: click on backdrop closes
  for (const d of [$('#detail'), $('#editor')]) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }
  $('#detail').addEventListener('close', () => { state.selected = null; updateHash(); applySelection(); });
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
  document.addEventListener('paste', (e) => {
    if (!$('#editor').open || $('#annot').open) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const ed = state.editing;
    const kind = (ed.activeShot && (!ed.activeShot.endsWith('2') || ed.showSecond[ed.activeShot[0] === 's' ? 'stand' : 'aim'] || ed.shots[ed.activeShot]))
      ? ed.activeShot : (!ed.shots.stand ? 'stand' : !ed.shots.aim ? 'aim' : 'stand');
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
    if (ghReady() && gh.cfg.auto) publish({ quiet: true });
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
    if (ghReady() && gh.cfg.auto) publish({ quiet: true });
    $('#editor').close();
    state.map = canonMap(d.map) || d.map;
    store.set(LS.lastMap, state.map);
    openDetail(d.id);
    toast(ghReady() && gh.cfg.auto ? 'บันทึกแล้ว — กำลังขึ้น GitHub…' : 'บันทึกในเครื่องแล้ว');
  });

  window.addEventListener('hashchange', () => {
    const h = readHash();
    const m = canonMap(h.map);
    if (h.id && h.id !== state.selected) openDetail(h.id);
    else if (m && norm(m) !== norm(state.map)) setMap(m);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.peek) closePeek();
    if (e.key === 'Escape' && state.pick) cancelPick();
    if (e.key === 'Escape' && state.smokePick) finishSmokePick();
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && $('#detail').open && !$('#zoom').open && state.selected) {
      const n = neighbour(state.selected, e.key === 'ArrowLeft' ? -1 : 1);
      if (n) openDetail(n.id);
    }
  });
  $('#zoom').addEventListener('close', () => { zm.img = null; zm.stage = null; zm.pts.clear(); });
  window.addEventListener('resize', () => { if ($('#zoom').open) { zoomFit(); zoomApply(); } });
}

const LANDSCAPE_PHONE = matchMedia('(orientation: landscape) and (max-height: 600px), (orientation: landscape) and (min-width: 900px)'); // phones in landscape and desktop share one layout
/** Landscape phone: header + map chips live in the right column so the map can use the full height. */
function placeMapChips() {
  const top = $('header.top');
  const maps = $('#maps');
  if (LANDSCAPE_PHONE.matches) $('.list-col').prepend(top, maps);
  else { document.body.prepend(top); $('main.layout').before(maps); }
}

/** Real visible height (some phones report 100dvh wrong in landscape / standalone mode). */
function syncAppHeight() {
  // the layout viewport: unlike visualViewport it doesn't shrink when the page was pinch-zoomed
  const h = Math.round(Math.max(window.innerHeight, document.documentElement.clientHeight || 0));
  if (h > 0) document.documentElement.style.setProperty('--app-h', h + 'px');
}

async function init() {
  // no page zoom (double-tap / pinch): it shifts the fixed layout and leaves a gap at the bottom.
  // Pictures still zoom in their own viewer.
  for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
  syncAppHeight();
  window.addEventListener('resize', syncAppHeight);
  window.addEventListener('orientationchange', () => setTimeout(syncAppHeight, 300));
  window.visualViewport?.addEventListener('resize', syncAppHeight);
  // phones report the final height late (toolbar animating, app coming back from the background)
  window.addEventListener('pageshow', syncAppHeight);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') [0, 300, 1000].forEach((t) => setTimeout(syncAppHeight, t)); });
  [300, 1000, 2500].forEach((t) => setTimeout(syncAppHeight, t));
  for (const n of document.querySelectorAll('[data-version]')) n.textContent = 'v' + APP_VERSION;
  bindUi();
  placeMapChips();
  LANDSCAPE_PHONE.addEventListener('change', placeMapChips);
  // chip rows have hidden scrollbars: let a mouse wheel scroll them sideways
  for (const row of [$('#maps'), $('#agents')]) {
    row.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || row.scrollWidth <= row.clientWidth) return;
      e.preventDefault();
      row.scrollLeft += e.deltaY;
    }, { passive: false });
  }
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
    // When a new version's service worker takes over, reload once so the new code runs —
    // but not while a dialog is open (unsaved input / something being viewed): wait until it closes.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false, pending = false;
    const busy = () => [...document.querySelectorAll('dialog')].some((d) => d.open) || !!state.pick || !!state.smokePick;
    const reloadNow = () => { if (reloaded) return; reloaded = true; location.reload(); };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      if (busy()) { pending = true; toast('มีเวอร์ชันใหม่ — จะอัปเดตเมื่อปิดหน้านี้'); } else reloadNow();
    });
    // a dialog closing may be the moment we were waiting for
    document.addEventListener('close', () => setTimeout(() => { if (pending && !busy()) reloadNow(); }, 50), true);
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // an installed app can stay open for hours: look for a new version when it comes back to the
      // foreground and every 10 minutes while visible, so nobody has to close and reopen it
      const check = async () => {
        if (document.visibilityState !== 'visible') return;
        reg.update().catch(() => {});
        // also ask the server directly (bypassing caches) which version is live; if the service worker
        // update didn't come through, reload once for that version
        const live = await liveVersion();
        if (!live || live === APP_VERSION || sessionStorage.getItem('lp.reloadedFor') === live) return;
        setTimeout(() => {
          if (reloaded) return;
          sessionStorage.setItem('lp.reloadedFor', live);
          if (busy()) { pending = true; toast('มีเวอร์ชันใหม่ ' + live + ' — จะอัปเดตเมื่อปิดหน้านี้'); } else reloadNow();
        }, 4000);
      };
      document.addEventListener('visibilitychange', check);
      setInterval(check, 10 * 60 * 1000);
    }).catch((e) => console.warn('SW', e));
  }
  watchData();
  inboxLoad();
}

/** The version currently published (from sw.js, fetched past every cache). */
async function liveVersion() {
  try {
    const r = await fetch('sw.js?__v=' + Date.now(), { cache: 'no-store' });
    return r.ok ? (/VERSION = '([^']+)'/.exec(await r.text()) || [])[1] || null : null;
  } catch { return null; }
}

async function manualUpdate() {
  toast('กำลังเช็กอัปเดต…');
  const live = await liveVersion();
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => null);
  await reg?.update().catch(() => {});
  if (live && live === APP_VERSION) { toast(`ใช้เวอร์ชันล่าสุดอยู่แล้ว (v${APP_VERSION})`); return; }
  setTimeout(() => location.reload(), 800);
}

/** Pick up lineups published from another device without a reload: re-read data/lineups.json when the
 *  app comes back to the foreground and every 2 minutes while visible. */
function watchData() {
  let last = stable(state.base.map(clean));
  let busyFetch = false;
  const refresh = async () => {
    if (busyFetch || document.visibilityState !== 'visible' || location.protocol === 'file:') return;
    busyFetch = true;
    try {
      const r = await fetch('data/lineups.json?__v=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      const arr = (Array.isArray(j) ? j : j.lineups || []).filter((x) => x && typeof x === 'object' && x.id);
      const now = stable(arr.map(clean));
      if (now === last) return;
      last = now;
      state.base = arr;
      pruneLocal();
      cleanLocalMedia();
      if (!$('#editor').open && !$('#planEditor').open) render();
      toast('อัปเดต lineup ล่าสุดแล้ว');
    } catch { /* offline: try again later */ } finally { busyFetch = false; }
  };
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 2 * 60 * 1000);
}

init();
