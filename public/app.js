/* ===== DevOps Work Tracker — frontend ===== */

const POC_STAGES = ['Concept', 'Started', 'In-Progress', 'Completed', 'Documented'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function todayStr(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; }
function fmtDateTime(iso) { return iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }
// Current local time formatted for a datetime-local input (YYYY-MM-DDTHH:mm).
function nowLocalInput(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
// Default the entry-time and maintenance date inputs to "now" (due date stays optional/blank).
function applyFormDateDefaults() {
  const et = $('#taskForm [name=entry_time]'); if (et) et.value = nowLocalInput();
  const md = $('#maintenanceForm [name=date]'); if (md) { md.value = todayStr(); md.max = todayStr(); } // no future maintenance dates
}

// ---------- auth state ----------
let authToken = localStorage.getItem('jwt');
let currentUser = null;
let allUsers = [];

async function api(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  // An expired/invalid token during an authenticated session → back to login.
  if (res.status === 401 && authToken) { localStorage.removeItem('jwt'); authToken = null; location.reload(); }
  if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.status = res.status; err.body = data; throw err; }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function formData(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    data[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return data;
}

// Disable a form's submit button during async work to prevent double-submits.
// Returns an unlock() to call in a finally block.
function lockSubmit(form) {
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  return () => { if (btn) btn.disabled = false; };
}

// ---------- tag color cache ----------
let allTags = []; // [{id,name,category,color,...}]
const tagColorMap = new Map();
async function refreshTags() {
  allTags = await api('/api/tags');
  tagColorMap.clear();
  allTags.forEach((t) => tagColorMap.set(t.name, t.color || '#7aa2ff'));
}
function tagColor(name) { return tagColorMap.get(name) || '#5a6685'; }

// Render clickable tag pills for a card/row. `filterTab` makes them filter that tab.
function tagPills(tags, filterTab) {
  if (!tags || !tags.length) return '';
  return `<span class="tags-cell">` + tags.map((t) =>
    `<span class="tagpill" data-tag="${esc(t)}"${filterTab ? ` data-filtertab="${filterTab}"` : ''} style="background:${tagColor(t)}">${esc(t)}</span>`
  ).join('') + `</span>`;
}

// ================= TAB NAV =================
$$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === name));
  loaders[name]?.();
}
const loaders = {
  home: loadHome,
  checklist: loadChecklist, tasks: loadTasks, pipelines: loadPipelines,
  maintenance: loadMaintenance, pocs: loadPocs, timeline: loadTimeline,
  graph: loadGraph, recurring: loadRecurring, tags: loadTagLibrary,
  tagsOverview: loadTagsOverview, audit: loadAudit,
};

// per-tab tag filters
const tagFilters = { tasks: null, pipelines: null, maintenance: null, pocs: null };
function setTagFilter(tab, tag) {
  tagFilters[tab] = tag;
  loaders[tab]?.();
}
// Delegated click for filter pills
document.addEventListener('click', (e) => {
  const pill = e.target.closest('.tagpill[data-filtertab]');
  if (pill) setTagFilter(pill.dataset.filtertab, pill.dataset.tag);
});
function renderTagFilterChip(elId, tab) {
  const el = $('#' + elId);
  const tag = tagFilters[tab];
  if (!tag) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `Filtered by <span class="tagpill" style="background:${tagColor(tag)}">${esc(tag)}</span> <span class="x">clear ✕</span>`;
  $('.x', el).onclick = () => setTagFilter(tab, null);
}

// ================= REASON MODAL =================
let reasonResolve = null;
function askReason(title = 'Why this change?') {
  return new Promise((resolve) => {
    reasonResolve = resolve;
    $('#reasonTitle').textContent = title;
    $('#reasonText').value = '';
    $('#reasonError').classList.add('hidden');
    $('#reasonModal').classList.remove('hidden');
    $('#reasonText').focus();
  });
}
$('#reasonCancel').addEventListener('click', () => { $('#reasonModal').classList.add('hidden'); reasonResolve?.(null); reasonResolve = null; });
$('#reasonOk').addEventListener('click', () => {
  const v = $('#reasonText').value.trim();
  if (!v) { $('#reasonError').classList.remove('hidden'); return; }
  $('#reasonModal').classList.add('hidden');
  reasonResolve?.(v); reasonResolve = null;
});

// ================= HISTORY DRAWER =================
async function openHistory(type, id, name) {
  $('#historyTitle').textContent = `History — ${name}`;
  $('#historyBody').innerHTML = '<div class="empty">Loading…</div>';
  $('#historyDrawer').classList.remove('hidden');
  $('#drawerBackdrop').classList.remove('hidden');
  try {
    const items = await api(`/api/activity-log/entity/${type}/${id}`);
    $('#historyBody').innerHTML = items.length ? items.map((h) => `
      <div class="hist-item">
        <div class="ha">${esc(h.action)}${h.field_changed ? ` · ${esc(h.field_changed)}` : ''}</div>
        ${h.old_value || h.new_value ? `<div class="hc">${esc(h.old_value)} → ${esc(h.new_value)}</div>` : ''}
        <div class="hr">${esc(h.reason_note || '—')}</div>
        <div class="ht">${fmtDateTime(h.timestamp)} · ${esc(h.actor)}</div>
      </div>`).join('') : '<div class="empty">No history.</div>';
  } catch (e) { $('#historyBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function closeDrawer() { $('#historyDrawer').classList.add('hidden'); $('#drawerBackdrop').classList.add('hidden'); }
$('#historyClose').addEventListener('click', closeDrawer);
$('#drawerBackdrop').addEventListener('click', closeDrawer);
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-history]');
  if (btn) openHistory(btn.dataset.htype, btn.dataset.history, btn.dataset.hname || '');
});

// ================= TAG PICKER COMPONENT =================
const tagPickers = {};
class TagPicker {
  constructor(container) {
    this.selected = [];
    container.classList.add('tag-picker');
    container.innerHTML = `<span class="tp-label">🏷️ tags</span><div class="tp-chips"></div><select class="tag-select"></select>`;
    this.chips = $('.tp-chips', container);
    this.select = $('.tag-select', container);
    this.select.addEventListener('change', () => this.onSelect());
    this.renderOptions();
  }
  // Populate the dropdown with every available tag not already chosen.
  renderOptions() {
    const avail = allTags.filter((t) => !this.selected.includes(t.name));
    this.select.innerHTML =
      `<option value="">add tag…</option>` +
      avail.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('') +
      `<option value="__new__">➕ Create new tag…</option>`;
  }
  async onSelect() {
    const v = this.select.value;
    this.select.value = '';
    if (!v) return;
    if (v === '__new__') {
      const name = prompt('New tag name:');
      if (name && name.trim()) await this.add(name.trim(), true);
      return;
    }
    await this.add(v, false);
  }
  async add(name, isNew) {
    if (this.selected.includes(name)) return;
    if (isNew && !allTags.some((t) => t.name === name)) {
      try { await api('/api/tags', { method: 'POST', body: JSON.stringify({ name }) }); await refreshTags(); }
      catch (e) { toast(e.message, true); return; }
    }
    this.selected.push(name);
    this.render();
    this.renderOptions();
  }
  render() {
    this.chips.innerHTML = this.selected.map((n) =>
      `<span class="tagpill" style="background:${tagColor(n)}">${esc(n)} <span class="x" data-rm="${esc(n)}">✕</span></span>`).join('');
    $$('.x[data-rm]', this.chips).forEach((x) => x.onclick = () => { this.selected = this.selected.filter((s) => s !== x.dataset.rm); this.render(); this.renderOptions(); });
  }
  getTags() { return [...this.selected]; }
  setTags(arr) { this.selected = [...(arr || [])]; this.render(); this.renderOptions(); }
  clear() { this.selected = []; this.render(); this.renderOptions(); }
}

// ================= PARENT PICKER COMPONENT =================
const parentPickers = {};
class ParentPicker {
  constructor(container) {
    this.value = null;
    container.classList.add('parent-picker');
    container.innerHTML = `<span class="tp-label">🔗 link parent (optional)</span><input class="parent-search" placeholder="search task / pipeline / POC…" /><div class="parent-suggest hidden"></div><div class="parent-selected"></div>`;
    this.input = $('.parent-search', container);
    this.suggest = $('.parent-suggest', container);
    this.sel = $('.parent-selected', container);
    let timer;
    this.input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => this.search(), 220); });
    document.addEventListener('click', (e) => { if (!container.contains(e.target)) this.suggest.classList.add('hidden'); });
  }
  async search() {
    const q = this.input.value.trim();
    if (!q) { this.suggest.classList.add('hidden'); return; }
    try {
      const { groups } = await api(`/api/search?q=${encodeURIComponent(q)}`);
      const typeMap = { tasks: 'task', pipelines: 'pipeline', pocs: 'poc' };
      const items = [];
      groups.filter((g) => typeMap[g.type]).forEach((g) => g.results.forEach((r) => {
        items.push({ id: r.id, type: typeMap[g.type], label: r.task_name || r.pipeline_name || r.title || r.id });
      }));
      this.suggest.innerHTML = items.length ? items.slice(0, 8).map((i) =>
        `<div data-id="${i.id}" data-type="${i.type}" data-label="${esc(i.label)}"><strong>${esc(i.label)}</strong> <span class="muted">${i.type}</span></div>`).join('')
        : '<div class="muted" style="padding:8px">No matches</div>';
      this.suggest.classList.remove('hidden');
      $$('div[data-id]', this.suggest).forEach((d) => d.onclick = () => {
        this.value = { parent_id: d.dataset.id, parent_type: d.dataset.type };
        this.sel.innerHTML = `linked → ${esc(d.dataset.label)} (${d.dataset.type}) <span class="x">remove</span>`;
        $('.x', this.sel).onclick = () => { this.value = null; this.sel.innerHTML = ''; };
        this.suggest.classList.add('hidden'); this.input.value = '';
      });
    } catch { this.suggest.classList.add('hidden'); }
  }
  getParent() { return this.value; }
  clear() { this.value = null; this.sel.innerHTML = ''; this.input.value = ''; }
}

// ================= RECUR BOX COMPONENT =================
const recurBoxes = {};
class RecurBox {
  constructor(container) {
    container.classList.add('recur-box');
    container.innerHTML = `
      <label class="checkbox-inline"><input type="checkbox" class="recur-toggle" /> ↻ Make this recurring</label>
      <div class="recur-opts hidden">
        <select class="recur-type">
          <option value="daily">daily</option><option value="weekly">weekly</option>
          <option value="monthly">monthly</option><option value="custom_cron">custom cron</option>
        </select>
        <input class="recur-value" placeholder="MON,WED,FRI / 1 / 0 9 * * 1" />
      </div>`;
    this.toggle = $('.recur-toggle', container);
    this.opts = $('.recur-opts', container);
    this.typeSel = $('.recur-type', container);
    this.valIn = $('.recur-value', container);
    this.toggle.addEventListener('change', () => this.opts.classList.toggle('hidden', !this.toggle.checked));
  }
  getRule() {
    if (!this.toggle.checked) return null;
    return { recurrence_type: this.typeSel.value, recurrence_value: this.valIn.value.trim() };
  }
  clear() { this.toggle.checked = false; this.opts.classList.add('hidden'); this.valIn.value = ''; }
}

function initComponents() {
  $$('[data-tagpicker]').forEach((el) => tagPickers[el.dataset.tagpicker] = new TagPicker(el));
  $$('[data-parentpicker]').forEach((el) => parentPickers[el.dataset.parentpicker] = new ParentPicker(el));
  $$('[data-recur]').forEach((el) => recurBoxes[el.dataset.recur] = new RecurBox(el));
}

// ================= HOME =================
function homeTaskRow(t) {
  const ds = dueState(t.due_date, t.status);
  const dueTag = t.due_date ? `<span class="due-flag due-${ds || 'none'}">${esc(t.due_date)}</span>` : '';
  return `<div class="home-task" data-id="${t.id}">
    <span class="badge s-${esc(t.status)}">${esc(t.status)}</span>
    <span class="ht-name">${esc(t.task_name)}</span>
    <span class="ht-meta prio-${esc(t.priority)}">${esc(t.priority)}</span>
    ${dueTag}
    <span class="ht-env">${esc(t.environment)}</span>
  </div>`;
}

async function loadHome() {
  const me = currentUser.username;
  const mine = (t) => t.assigned_to === me || t.created_by === me;
  let all = [];
  try { all = await api('/api/daily-tasks'); } catch { /* ignore */ }
  const myTasks = all.filter(mine);
  const today = todayStr();

  const overdue = myTasks.filter((t) => dueState(t.due_date, t.status) === 'overdue');
  const dueToday = myTasks.filter((t) => dueState(t.due_date, t.status) === 'today');
  const dueWeek = myTasks.filter((t) => dueState(t.due_date, t.status) === 'soon');
  const inProgress = myTasks.filter((t) => t.status === 'in-progress');
  const todays = myTasks.filter((t) => t.status !== 'done' && todayStr(new Date(t.entry_time)) === today);
  const openCount = myTasks.filter((t) => t.status !== 'done').length;

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  $('#homeHero').innerHTML = `
    <h2>${greet}, ${esc(currentUser.display_name || me)} 👋</h2>
    <p class="home-date">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>`;

  $('#homeStats').innerHTML = `
    <div class="stat ${overdue.length ? 'stat-danger' : ''}"><div class="num">${overdue.length}</div><div class="lbl">Overdue</div></div>
    <div class="stat"><div class="num">${dueToday.length}</div><div class="lbl">Due today</div></div>
    <div class="stat"><div class="num">${inProgress.length}</div><div class="lbl">In progress</div></div>
    <div class="stat"><div class="num">${openCount}</div><div class="lbl">Open (yours)</div></div>`;

  const section = (title, list, emptyMsg) => `
    <div class="home-section">
      <h3>${title} <span class="hs-count">${list.length}</span></h3>
      ${list.length ? `<div class="home-list">${list.map(homeTaskRow).join('')}</div>` : `<div class="home-empty">${emptyMsg}</div>`}
    </div>`;

  $('#homeBody').innerHTML =
    section('<i data-lucide="alert-triangle"></i> Overdue tasks', overdue, 'Nothing overdue — nice work!') +
    section('<i data-lucide="calendar-clock"></i> Due today', dueToday, 'Nothing due today.') +
    section('<i data-lucide="calendar-days"></i> Your tasks for today', todays, 'No tasks logged for today.') +
    (dueWeek.length ? section('<i data-lucide="calendar-range"></i> Coming up this week', dueWeek, '') : '');

  $$('#homeBody .home-task').forEach((el) => el.addEventListener('click', () => switchTab('tasks')));
}

// ================= CHECKLIST =================
$('#checklistDate').addEventListener('change', loadChecklist);
async function loadChecklist() {
  const date = $('#checklistDate').value || todayStr();
  const { categories, done, total } = await api(`/api/checklist?date=${date}`);
  $('#checklistProgress').textContent = `${done}/${total} done`;
  $('#checklistItems').innerHTML = categories.map((cat) => {
    const catDone = cat.items.filter((i) => i.checked).length;
    const rows = cat.items.map((i) => `
      <div class="check-item ${i.checked ? 'checked' : ''}" data-id="${i.id}" data-checked="${i.checked}">
        <span class="box">${i.checked ? '✓' : ''}</span><span class="label">${esc(i.label)}</span>
        <button class="del-item" data-id="${i.id}">✕</button>
      </div>`).join('');
    return `<div class="check-cat"><div class="cat-head"><h3>${esc(cat.name)}</h3><span class="cat-count">${catDone}/${cat.items.length}</span></div>
      <div class="cat-items">${rows || '<div class="cat-empty">No items yet.</div>'}</div>
      <form class="add-item-form" data-cat="${esc(cat.name)}"><input name="label" placeholder="Add to ${esc(cat.name)}…" autocomplete="off" /><button type="submit" class="btn"><i data-lucide="plus"></i> Add</button></form></div>`;
  }).join('');

  $$('#checklistItems .check-item').forEach((el) => el.addEventListener('click', async (e) => {
    if (e.target.closest('.del-item')) return;
    const checked = el.dataset.checked !== 'true';
    try { await api(`/api/checklist/${el.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ checked }) }); await loadChecklist(); if (checked) toast('Checklist item completed ✓'); }
    catch (err) { toast(err.message, true); }
  }));
  $$('#checklistItems .del-item').forEach((btn) => btn.addEventListener('click', async () => {
    try { await api(`/api/checklist/${btn.dataset.id}`, { method: 'DELETE' }); await loadChecklist(); } catch (err) { toast(err.message, true); }
  }));
  $$('#checklistItems .add-item-form').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault(); const label = form.label.value.trim(); if (!label) return;
    try { await api('/api/checklist', { method: 'POST', body: JSON.stringify({ category: form.dataset.cat, label, date: $('#checklistDate').value || todayStr() }) }); await loadChecklist(); }
    catch (err) { toast(err.message, true); }
  }));
}

// ================= TASKS =================
$('#tasksDate').addEventListener('change', loadTasks);
$('#filterPriority').addEventListener('change', loadTasks);
$('#filterStatus').addEventListener('change', loadTasks);

$('#taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = formData(e.target);
  if (data.entry_time) data.entry_time = new Date(data.entry_time).toISOString();
  else { const v = $('#tasksDate').value || todayStr(); data.entry_time = v === todayStr() ? new Date().toISOString() : new Date(`${v}T12:00:00`).toISOString(); }
  if (!data.due_date) delete data.due_date; // optional
  data.tags = tagPickers.taskTags.getTags();
  const prereq = $('#taskPrereq').value;
  if (prereq) { data.parent_id = prereq; data.parent_type = 'task'; data.relationship_label = 'prerequisite'; }
  const unlock = lockSubmit(e.target);
  try {
    await api('/api/daily-tasks', { method: 'POST', body: JSON.stringify(data) });
    const rule = recurBoxes.taskRecur.getRule();
    if (rule) await createRule('task', data, rule);
    e.target.reset(); tagPickers.taskTags.clear(); $('#taskPrereq').value = ''; recurBoxes.taskRecur.clear();
    applyFormDateDefaults();
    toast('Task added' + (rule ? ' (recurring)' : ''));
    loadTasks();
  } catch (err) { toast(err.message, true); } finally { unlock(); }
});

const NEXT_STATUS = { pending: 'in-progress', 'in-progress': 'done', done: 'done' };
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
let dueView = null; // null = date-scoped view; otherwise 'overdue' | 'today' | 'week'

// Classify a due_date relative to today for an open task.
function dueState(due, status) {
  if (!due || status === 'done') return '';
  const today = todayStr();
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  const wk = todayStr(new Date(Date.now() + 7 * 864e5));
  if (due <= wk) return 'soon';
  return 'future';
}
function dueCell(t) {
  if (!t.due_date) return '<span class="muted">—</span>';
  const st = dueState(t.due_date, t.status);
  const label = { overdue: '⚠ overdue', today: '📅 today', soon: 'due', future: '', '': '' }[st] || '';
  return `<span class="due-flag due-${st || 'none'}">${esc(t.due_date)}${label ? ` · ${label}` : ''}</span>`;
}

async function loadTasks() {
  renderTagFilterChip('taskTagFilter', 'tasks');

  // Always pull the open due list for chip counts.
  const dueList = await api('/api/daily-tasks/due');
  const counts = { overdue: 0, today: 0, week: 0 };
  dueList.forEach((t) => {
    const s = dueState(t.due_date, t.status);
    if (s === 'overdue') counts.overdue++;
    else if (s === 'today') { counts.today++; counts.week++; }
    else if (s === 'soon') counts.week++;
  });
  renderDueBar(counts);
  updateOverdueBadge(counts.overdue);

  let tasks;
  if (dueView) {
    tasks = dueList.filter((t) => {
      const s = dueState(t.due_date, t.status);
      if (dueView === 'overdue') return s === 'overdue';
      if (dueView === 'today') return s === 'today';
      if (dueView === 'week') return s === 'overdue' || s === 'today' || s === 'soon';
      return true;
    });
  } else {
    const params = new URLSearchParams({ date: $('#tasksDate').value || todayStr() });
    if ($('#filterPriority').value) params.set('priority', $('#filterPriority').value);
    if ($('#filterStatus').value) params.set('status', $('#filterStatus').value);
    if (tagFilters.tasks) params.set('tag', tagFilters.tasks);
    tasks = await api(`/api/daily-tasks?${params}`);
  }

  // High priority on top; stable sort preserves the existing order within a priority.
  tasks.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9));

  taskById = {};
  tasks.forEach((t) => { taskById[t.id] = t; });

  const tbody = $('#tasksTable tbody');
  if (!tasks.length) { tbody.innerHTML = `<tr><td colspan="10" class="empty">${dueView ? 'Nothing due in this window.' : 'No tasks.'}</td></tr>`; return; }
  tbody.innerHTML = tasks.map((t) => {
    const editable = canEditDoc(t);
    const statusCell = editable
      ? `<input class="status-note" placeholder="note (optional)" />
         <button class="status-trigger badge s-${esc(t.status)}" data-status="${esc(t.status)}">${esc(t.status)} <span class="caret">▾</span></button>`
      : `<span class="badge s-${esc(t.status)}">${esc(t.status)}</span>`;
    const actions = editable
      ? `<button class="icon-btn edit-task" data-id="${t.id}" title="Edit task"><i data-lucide="pencil"></i> Edit</button>`
      : `<span class="viewonly-badge">view-only</span>`;
    return `
    <tr data-id="${t.id}" class="${dueState(t.due_date, t.status) === 'overdue' ? 'row-overdue' : ''}">
      <td><strong>${esc(t.task_name)}</strong>${t.recurrence_rule_id ? '<span class="recur-badge">↻ recurring</span>' : ''}${t.parent_id ? '<span class="recur-badge">child</span>' : ''}<div class="muted">${esc(t.todo_description)}</div></td>
      <td>${esc(t.environment)}</td><td>${fmtTime(t.entry_time)}</td>
      <td>${dueCell(t)}</td>
      <td>${esc(t.who_asked)}</td>
      <td>${assigneePill(t)}</td>
      <td class="prio-${esc(t.priority)}">${esc(t.priority)}</td>
      <td>${tagPills(t.tags, 'tasks')}</td>
      <td class="status-cell">${statusCell}</td>
      <td class="row-actions">
        ${actions}
        <button class="icon-btn" data-history="${t.id}" data-htype="task" data-hname="${esc(t.task_name)}" title="History"><i data-lucide="history"></i></button>
      </td>
    </tr>`;
  }).join('');

  $$('#tasksTable .edit-task').forEach((btn) => btn.addEventListener('click', () => openEditTask(btn.dataset.id)));
  populatePrereqSelect();
}

// Fill the "Prerequisite task" dropdown with existing tasks.
async function populatePrereqSelect() {
  const sel = $('#taskPrereq');
  if (!sel) return;
  const current = sel.value;
  try {
    const tasks = await api('/api/daily-tasks');
    sel.innerHTML = `<option value="">— none —</option>` +
      tasks.map((t) => `<option value="${t.id}">${esc(t.task_name)}</option>`).join('');
    sel.value = current; // keep selection if still valid
  } catch { /* ignore */ }
}

// ---- Edit task modal ----
let taskById = {};
let editingId = null;

function openEditTask(id) {
  const t = taskById[id];
  if (!t) return;
  editingId = id;
  const f = $('#editForm');
  f.task_name.value = t.task_name || '';
  f.environment.value = t.environment || 'test';
  f.priority.value = t.priority || 'medium';
  f.who_asked.value = t.who_asked || '';
  f.due_date.value = t.due_date || '';
  f.todo_description.value = t.todo_description || '';
  f.assigned_to.innerHTML = assignOptionsHtml(t.assigned_to);
  f.assigned_to.value = t.assigned_to || currentUser.username;
  tagPickers.editTags.setTags(t.tags || []);
  $('#editModal').classList.remove('hidden');
  f.task_name.focus();
}
function closeEdit() { $('#editModal').classList.add('hidden'); editingId = null; }
$('#editCancel').addEventListener('click', closeEdit);
$('#editModal').addEventListener('click', (e) => { if (e.target.id === 'editModal') closeEdit(); });

$('#editSave').addEventListener('click', async () => {
  if (!editingId) return;
  const f = $('#editForm');
  if (!f.task_name.value.trim()) { f.task_name.focus(); return; }
  const body = {
    task_name: f.task_name.value.trim(),
    environment: f.environment.value,
    priority: f.priority.value,
    who_asked: f.who_asked.value.trim(),
    todo_description: f.todo_description.value.trim(),
    due_date: f.due_date.value || null,
    assigned_to: f.assigned_to.value,
    tags: tagPickers.editTags.getTags(),
  };
  const btn = $('#editSave'); btn.disabled = true;
  try {
    await api(`/api/daily-tasks/${editingId}`, { method: 'PATCH', body: JSON.stringify(body) });
    toast('Task updated'); closeEdit(); loadTasks();
  } catch (e) { handleConflict(e); } finally { btn.disabled = false; }
});

// ---- Custom status dropdown (color-coded popup) ----
const STATUS_OPTS = [['pending', '#f5b942'], ['in-progress', '#7aa2ff'], ['done', '#2ecc8f']];
let statusCtx = null;

document.addEventListener('click', (e) => {
  const trig = e.target.closest('.status-trigger');
  const menu = $('#statusMenu');
  if (trig) {
    e.stopPropagation();
    const tr = trig.closest('tr');
    statusCtx = { id: tr.dataset.id, noteEl: $('.status-note', tr), current: trig.dataset.status };
    openStatusMenu(trig);
  } else if (!e.target.closest('#statusMenu')) {
    menu.classList.add('hidden');
  }
});

function openStatusMenu(trig) {
  const menu = $('#statusMenu');
  menu.innerHTML = STATUS_OPTS.map(([s, c]) =>
    `<div class="status-opt ${s === statusCtx.current ? 'current' : ''}" data-s="${s}">
       <span class="dot" style="background:${c}"></span><span>${s}</span>${s === statusCtx.current ? '<span class="tick">✓</span>' : ''}
     </div>`).join('');
  const r = trig.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${r.left}px`;
  menu.style.minWidth = `${Math.max(r.width, 150)}px`;
  menu.classList.remove('hidden');

  $$('.status-opt', menu).forEach((o) => o.onclick = async () => {
    menu.classList.add('hidden');
    const next = o.dataset.s;
    if (next === statusCtx.current) return;
    const note = statusCtx.noteEl.value.trim();
    try {
      await api(`/api/daily-tasks/${statusCtx.id}`, { method: 'PATCH', body: JSON.stringify({ status: next, reason_note: note || 'Status updated' }) });
      toast(next === 'done' ? 'Task completed ✓' : 'Status updated');
      loadTasks();
    } catch (e) { handleConflict(e); loadTasks(); }
  });
}
// Keep the floating menu glued to the trigger while scrolling.
window.addEventListener('scroll', () => $('#statusMenu')?.classList.add('hidden'), true);

// Global overdue badge in the top bar (visible from any tab).
function updateOverdueBadge(count) {
  const el = $('#overdueBadge');
  if (!count) { el.classList.add('hidden'); return; }
  el.innerHTML = `<i data-lucide="alert-triangle"></i> ${count} overdue`;
  el.classList.remove('hidden');
  refreshIcons();
}
async function refreshOverdue() {
  try {
    const dueList = await api('/api/daily-tasks/due');
    updateOverdueBadge(dueList.filter((t) => dueState(t.due_date, t.status) === 'overdue').length);
  } catch { /* ignore */ }
}
$('#overdueBadge').addEventListener('click', () => { dueView = 'overdue'; switchTab('tasks'); });

// Render the "what's due" chip bar; clicking a chip switches the task view.
function renderDueBar(counts) {
  const chips = [
    { key: null, label: '🗂 All tasks', cls: '' },
    { key: 'overdue', label: `⚠ Overdue (${counts.overdue})`, cls: 'due-overdue' },
    { key: 'today', label: `📅 Due today (${counts.today})`, cls: 'due-today' },
    { key: 'week', label: `🗓 This week (${counts.week})`, cls: 'due-soon' },
  ];
  $('#dueBar').innerHTML = chips.map((c) =>
    `<button class="due-chip ${c.cls} ${dueView === c.key ? 'active' : ''}" data-due="${c.key ?? ''}">${c.label}</button>`).join('');
  $$('#dueBar .due-chip').forEach((b) => b.addEventListener('click', () => {
    dueView = b.dataset.due || null;
    loadTasks();
  }));
}

// ================= PIPELINES (per-environment checklist) =================
let pipeEnv = 'dev';
$$('#pipeEnvTabs .env-tab').forEach((b) => b.addEventListener('click', () => { pipeEnv = b.dataset.env; loadPipelines(); }));

async function loadPipelines() {
  $$('#pipeEnvTabs .env-tab').forEach((b) => b.classList.toggle('active', b.dataset.env === pipeEnv));
  const { categories } = await api(`/api/pipeline-checks?environment=${pipeEnv}`);

  $('#pipeChecklist').innerHTML = categories.map((cat) => {
    const done = cat.items.filter((i) => i.checked).length;
    const rows = cat.items.map((i) => `
      <div class="check-item ${i.checked ? 'checked' : ''}" data-id="${i.id}" data-checked="${i.checked}">
        <span class="box">${i.checked ? '✓' : ''}</span><span class="label">${esc(i.label)}</span>
        <button class="del-item" data-id="${i.id}">✕</button>
      </div>`).join('');
    return `<div class="check-cat"><div class="cat-head"><h3>${esc(cat.name)}</h3><span class="cat-count">${done}/${cat.items.length}</span></div>
      <div class="cat-items">${rows || '<div class="cat-empty">No items yet.</div>'}</div>
      <form class="add-item-form" data-cat="${esc(cat.name)}"><input name="label" placeholder="Add to ${esc(cat.name)}…" autocomplete="off" /><button type="submit" class="btn"><i data-lucide="plus"></i> Add</button></form></div>`;
  }).join('');

  $$('#pipeChecklist .check-item').forEach((el) => el.addEventListener('click', async (e) => {
    if (e.target.closest('.del-item')) return;
    const checked = el.dataset.checked !== 'true';
    try { await api(`/api/pipeline-checks/${el.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ checked }) }); loadPipelines(); if (checked) toast('Pipeline check completed ✓'); }
    catch (err) { toast(err.message, true); }
  }));
  $$('#pipeChecklist .del-item').forEach((btn) => btn.addEventListener('click', async () => {
    try { await api(`/api/pipeline-checks/${btn.dataset.id}`, { method: 'DELETE' }); loadPipelines(); } catch (err) { toast(err.message, true); }
  }));
  $$('#pipeChecklist .add-item-form').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault(); const label = form.label.value.trim(); if (!label) return;
    const unlock = lockSubmit(form);
    try { await api('/api/pipeline-checks', { method: 'POST', body: JSON.stringify({ environment: pipeEnv, category: form.dataset.cat, label }) }); loadPipelines(); }
    catch (err) { toast(err.message, true); } finally { unlock(); }
  }));
}

// ================= MAINTENANCE =================
$('#maintenanceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = formData(e.target);
  if (!data.date) data.date = todayStr();
  if (data.date > todayStr()) { toast('Maintenance date cannot be in the future', true); return; }
  data.tags = tagPickers.mntTags.getTags();
  const unlock = lockSubmit(e.target);
  try {
    await api('/api/maintenance', { method: 'POST', body: JSON.stringify(data) });
    const rule = recurBoxes.mntRecur.getRule();
    if (rule) await createRule('maintenance', data, rule);
    e.target.reset(); tagPickers.mntTags.clear(); recurBoxes.mntRecur.clear();
    applyFormDateDefaults();
    toast('Maintenance logged' + (rule ? ' (recurring)' : '')); loadMaintenance();
  } catch (err) { toast(err.message, true); } finally { unlock(); }
});
async function loadMaintenance() {
  const params = new URLSearchParams();
  if (tagFilters.maintenance) params.set('tag', tagFilters.maintenance);
  renderTagFilterChip('mntTagFilter', 'maintenance');
  const list = await api(`/api/maintenance?${params}`);
  const tbody = $('#maintenanceTable tbody');
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty">No maintenance logs.</td></tr>`; return; }
  tbody.innerHTML = list.map((m) => `
    <tr><td>${esc(m.date)}${m.recurrence_rule_id ? '<span class="recur-badge">↻</span>' : ''}</td><td>${esc(m.environment)}</td>
    <td>${esc(m.release_version)}</td><td>${tagPills(m.tags, 'maintenance')}</td><td>${esc(m.notes)}</td></tr>`).join('');
}

// ================= POCs =================
$('#pocForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = formData(e.target);
  data.tags = tagPickers.pocTags.getTags();
  const parent = parentPickers.pocParent.getParent();
  if (parent) Object.assign(data, parent);
  const unlock = lockSubmit(e.target);
  try {
    await api('/api/pocs', { method: 'POST', body: JSON.stringify(data) });
    e.target.reset(); tagPickers.pocTags.clear(); parentPickers.pocParent.clear();
    toast('POC added'); loadPocs();
  } catch (err) { toast(err.message, true); } finally { unlock(); }
});
async function loadPocs() {
  const params = new URLSearchParams();
  if (tagFilters.pocs) params.set('tag', tagFilters.pocs);
  renderTagFilterChip('pocTagFilter', 'pocs');
  const pocs = await api(`/api/pocs?${params}`);
  const wrap = $('#pocCards');
  if (!pocs.length) { wrap.innerHTML = `<div class="empty">No POCs yet.</div>`; return; }
  wrap.innerHTML = pocs.map((p) => {
    const activeIdx = POC_STAGES.indexOf(p.status);
    const stages = POC_STAGES.map((s, i) => {
      let cls = 'stage'; if (i === activeIdx) cls += ' active'; else if (i < activeIdx) cls += ' passed';
      return `<span class="${cls}">${s}</span>${i < POC_STAGES.length - 1 ? '<span class="stage-arrow">→</span>' : ''}`;
    }).join('');
    const canAdvance = p.status !== 'Documented';
    const advanceCtl = !canAdvance
      ? `<span class="badge s-done">Documented ✓</span>`
      : (canEditDoc(p) ? `<button class="btn primary advance">Advance <i data-lucide="arrow-right"></i></button>` : `<span class="viewonly-badge">view-only</span>`);
    return `<div class="poc-card" data-id="${p.id}">
      <h4>${esc(p.title)}</h4><div class="desc">${esc(p.concept_description)}</div>
      <div class="poc-stages">${stages}</div>${tagPills(p.tags, 'pocs')}
      <div class="owner-note">created by ${esc(p.created_by || '—')}</div>
      <div class="actions" style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap">
        ${advanceCtl}
        <button class="btn spawn"><i data-lucide="git-branch-plus"></i> Spawn task</button>
        <button class="icon-btn" data-history="${p.id}" data-htype="poc" data-hname="${esc(p.title)}"><i data-lucide="history"></i></button>
      </div></div>`;
  }).join('');
  $$('#pocCards .advance').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.closest('.poc-card').dataset.id;
    const reason = await askReason('Advance POC status');
    if (!reason) return;
    try { await api(`/api/pocs/${id}`, { method: 'PATCH', body: JSON.stringify({ reason_note: reason }) }); toast('POC advanced'); loadPocs(); }
    catch (e) { handleConflict(e); }
  }));
  $$('#pocCards .spawn').forEach((btn) => btn.addEventListener('click', async () => {
    const card = btn.closest('.poc-card'); const id = card.dataset.id; const title = $('h4', card).textContent;
    const name = prompt('Provisioning task name:', `Provision for ${title}`);
    if (!name) return;
    try {
      await api('/api/daily-tasks', { method: 'POST', body: JSON.stringify({ task_name: name, parent_id: id, parent_type: 'poc', relationship_label: 'spawned-from', who_asked: 'POC spawn' }) });
      toast('Provisioning task spawned'); switchTab('tasks');
    } catch (e) { toast(e.message, true); }
  }));
}

// Shared 409 handler (open children).
function handleConflict(e) {
  if (e.status === 409 && e.body?.open_children) {
    const names = e.body.open_children.map((c) => `${c.name} (${c.type}/${c.status})`).join(', ');
    toast(`Blocked — open children: ${names}`, true);
  } else { toast(e.message, true); }
}

// Create a recurrence rule from a just-submitted form payload.
async function createRule(template_type, payload, rule) {
  const clean = { ...payload };
  delete clean.reason_note; delete clean.parent_id; delete clean.parent_type; delete clean.entry_time; delete clean.date;
  await api('/api/recurrence-rules', { method: 'POST', body: JSON.stringify({ template_type, template_payload: clean, ...rule }) });
}

// ================= TIMELINE =================
let timelineFilter = 'all', timelineCache = [];
$('#timelineDate').addEventListener('change', loadTimeline);
$$('.chip').forEach((chip) => chip.addEventListener('click', () => { $$('.chip').forEach((c) => c.classList.toggle('active', c === chip)); timelineFilter = chip.dataset.filter; renderTimelineEvents(); }));
$('#exportHtml').addEventListener('click', () => exportReport('html'));
$('#exportTxt').addEventListener('click', () => exportReport('txt'));
function exportReport(format) { window.open(`/api/timeline/export?date=${$('#timelineDate').value || todayStr()}&format=${format}`, '_blank'); }
async function loadTimeline() {
  const date = $('#timelineDate').value || todayStr();
  const [{ events }, summary] = await Promise.all([api(`/api/timeline?date=${date}`), api(`/api/timeline/summary?date=${date}`)]);
  timelineCache = events; renderSummary(summary); renderTimelineEvents();
}
function renderSummary(s) {
  $('#summaryStats').innerHTML = `
    <div class="stat"><div class="num">${s.tasks_done}</div><div class="lbl">Tasks done</div></div>
    <div class="stat"><div class="num">${s.pipelines_pass}/${s.pipelines_fail}</div><div class="lbl">Pipelines pass/fail</div></div>
    <div class="stat"><div class="num">${s.pocs_advanced}</div><div class="lbl">POCs advanced</div></div>
    <div class="stat"><div class="num">${s.maintenance_logged}</div><div class="lbl">Maintenance</div></div>
    <div class="stat"><div class="num">${s.checklist_pct}%</div><div class="lbl">Checklist</div></div>`;
}
function renderTimelineEvents() {
  const list = timelineFilter === 'all' ? timelineCache : timelineCache.filter((e) => e.event_type === timelineFilter);
  const wrap = $('#timelineList');
  if (!list.length) { wrap.innerHTML = `<div class="empty">No activity for this day.</div>`; return; }
  wrap.innerHTML = list.map((e) => `
    <div class="tl-event"><span class="dot t-${esc(e.event_type)}"></span>
      <div class="card"><div class="tl-head"><span class="tl-title">${esc(e.event_title)}</span><span class="tl-time">${fmtTime(e.completed_at)}</span></div>
      <span class="tl-badge t-${esc(e.event_type)}">${esc(e.event_type)}</span>
      ${e.event_description ? `<div class="tl-desc">${esc(e.event_description)}</div>` : ''}</div></div>`).join('');
}

// ================= DEPENDENCY GRAPH =================
let graphRoot = null, graphRootType = null;
const TYPE_TAB = { task: 'tasks', pipeline: 'pipelines', poc: 'pocs', maintenance: 'maintenance' };

$('#graphRefresh').addEventListener('click', loadGraph);
$('#graphBack').addEventListener('click', () => { graphRoot = null; graphRootType = null; loadGraph(); });

function nodeColor(n) {
  const s = n.status;
  if (n.type === 'task') return s === 'done' ? '#2ecc8f' : s === 'in-progress' ? '#7aa2ff' : '#f5b942';
  if (n.type === 'pipeline') return s === 'pass' ? '#2ecc8f' : s === 'fail' ? '#ff6b7d' : '#f5b942';
  if (n.type === 'poc') return s === 'Documented' ? '#2ecc8f' : s === 'Completed' ? '#4dd0b0' : s === 'In-Progress' ? '#7aa2ff' : '#f5b942';
  return '#8b93ab';
}

// Left-to-right flow layout: parent → child on the same horizontal line.
// A chain A→B→C lands on one row; branches get their own rows; doubly-linked
// pairs share a row (same line) because the back-edge is skipped during layout.
function layoutFlow(nodes, links) {
  const children = new Map(), indeg = new Map();
  nodes.forEach((n) => { children.set(n.id, []); indeg.set(n.id, 0); });
  links.forEach((l) => {
    if (children.has(l.from_id) && children.has(l.to_id) && l.from_id !== l.to_id) {
      children.get(l.from_id).push(l.to_id);
      indeg.set(l.to_id, indeg.get(l.to_id) + 1);
    }
  });

  // Roots = nodes with no incoming link (fall back to all if everything is in a cycle).
  let roots = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  if (!roots.length) roots = nodes.map((n) => n.id);

  const depth = new Map(), rowY = new Map(), visited = new Set();
  let rowCounter = 0;
  function dfs(id, d) {
    visited.add(id);
    depth.set(id, Math.max(depth.get(id) || 0, d));
    const kids = children.get(id).filter((k) => !visited.has(k));
    if (!kids.length) { const y = rowCounter++; rowY.set(id, y); return y; }
    const rows = kids.map((k) => dfs(k, d + 1));
    const y = rows.reduce((a, b) => a + b, 0) / rows.length;
    rowY.set(id, y);
    return y;
  }
  roots.forEach((r) => { if (!visited.has(r)) dfs(r, 0); });
  // Components with no indegree-0 root (e.g. a mutual A↔B cycle): lay them out
  // through the same walk so the cycle's members share a row (same line).
  nodes.forEach((n) => { if (!visited.has(n.id)) dfs(n.id, 0); });

  const colGap = 300, rowGap = 80;
  const pos = {}; let maxD = 0, maxY = 0;
  nodes.forEach((n) => {
    const x = 120 + (depth.get(n.id) || 0) * colGap;
    const y = 50 + (rowY.get(n.id) || 0) * rowGap;
    pos[n.id] = { x, y };
    maxD = Math.max(maxD, depth.get(n.id) || 0); maxY = Math.max(maxY, y);
  });
  return { pos, width: Math.max(760, 120 + maxD * colGap + 260), height: Math.max(360, maxY + 90), headersSvg: '' };
}

const GNODE_W = 184, GNODE_H = 44;

function buildGraphSvg(nodes, links, layout) {
  const { pos, width, height } = layout;
  const W = GNODE_W, H = GNODE_H;
  const fwd = new Set(links.map((l) => `${l.from_id}>${l.to_id}`));

  // Anchor a link on the card borders (horizontal or vertical side, whichever fits).
  function anchor(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) * H >= Math.abs(dy) * W) {
      const s = Math.sign(dx) || 1;
      return { sx: a.x + s * W / 2, sy: a.y, ex: b.x - s * W / 2, ey: b.y };
    }
    const s = Math.sign(dy) || 1;
    return { sx: a.x, sy: a.y + s * H / 2, ex: b.x, ey: b.y - s * H / 2 };
  }

  const linkSvg = links.map((l) => {
    const a = pos[l.from_id], b = pos[l.to_id]; if (!a || !b) return '';
    const { sx, sy, ex, ey } = anchor(a, b);
    const hasReverse = fwd.has(`${l.to_id}>${l.from_id}`);
    let d, lx = (sx + ex) / 2, ly = (sy + ey) / 2;
    if (hasReverse) {
      // Bow opposite directions so A→B and B→A don't overlap.
      const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy) || 1;
      const sign = String(l.from_id) < String(l.to_id) ? 1 : -1;
      const bow = 28 * sign;
      lx += (-dy / len) * bow; ly += (dx / len) * bow;
      d = `M ${sx} ${sy} Q ${lx} ${ly} ${ex} ${ey}`;
    } else {
      d = `M ${sx} ${sy} L ${ex} ${ey}`; // straight = most readable
    }
    const label = l.relationship_type && l.relationship_type !== 'parent'
      ? `<text class="glink-label" x="${lx}" y="${ly - 4}" text-anchor="middle">${esc(l.relationship_type)}</text>` : '';
    // Wide transparent hit-path makes the thin arrow easy to click for deletion.
    return `<g class="glink-group" data-link-id="${esc(l.id || '')}">
      <title>Click to delete this connection</title>
      <path class="glink-hit" d="${d}" fill="none" stroke="transparent" stroke-width="16"></path>
      <path class="glink" d="${d}" fill="none" marker-end="url(#arrow)"></path>${label}</g>`;
  }).join('');

  const nodeSvg = nodes.map((n) => {
    const p = pos[n.id]; if (!p) return '';
    const label = n.label.length > 21 ? n.label.slice(0, 20) + '…' : n.label;
    const c = nodeColor(n);
    return `<g class="gnode" data-type="${n.type}" data-id="${n.id}" transform="translate(${p.x - W / 2},${p.y - H / 2})">
      <title>${esc(n.label)} (${esc(n.type)}) · ${esc(n.status)}</title>
      <rect width="${W}" height="${H}" rx="10" fill="#1b2238" stroke="${c}" stroke-width="2"></rect>
      <circle cx="20" cy="${H / 2}" r="6" fill="${c}"></circle>
      <text x="36" y="${H / 2 - 3}" class="gnode-label">${esc(label)}</text>
      <text x="36" y="${H / 2 + 12}" class="gnode-type">${esc(n.type)} · ${esc(n.status)}</text>
    </g>`;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <defs><marker id="arrow" markerWidth="11" markerHeight="11" refX="9" refY="5" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#9aa3bd"></path></marker></defs>
    ${linkSvg}${nodeSvg}</svg>`;
}

async function loadGraph() {
  const url = graphRoot
    ? `/api/relationships/graph?root_id=${encodeURIComponent(graphRoot)}&root_type=${encodeURIComponent(graphRootType || '')}&depth=2`
    : '/api/relationships/graph';
  const { nodes, links } = await api(url);

  // Header: title + back button for focus mode.
  $('#graphBack').classList.toggle('hidden', !graphRoot);
  const titleEl = $('#graphTitle');
  if (graphRoot) {
    const root = nodes.find((n) => n.id === graphRoot);
    titleEl.innerHTML = root
      ? `sub-graph of <strong>${esc(root.label)}</strong> · <a href="#" id="graphOpenTab">open in ${esc(TYPE_TAB[graphRootType] || 'tab')} →</a>`
      : '';
    const open = $('#graphOpenTab');
    if (open) open.onclick = (e) => { e.preventDefault(); const tab = TYPE_TAB[graphRootType]; if (tab) switchTab(tab); };
  } else { titleEl.textContent = ''; }

  const wrap = $('#graphWrap');
  if (!nodes.length) { wrap.innerHTML = '<div class="empty">No items to graph.</div>'; return; }
  if (graphRoot && nodes.length === 1) {
    // Root has no descendants — still show it, with a hint.
    wrap.innerHTML = `<div class="graph-hint">No sub-entities under this item.</div>`;
  }

  const layout = layoutFlow(nodes, links);
  wrap.innerHTML = buildGraphSvg(nodes, links, layout);
  setupGraphInteractions($('#graphWrap svg'), layout.pos);
}

// Click a node → drill into its sub-graph; drag from A onto B → A becomes parent of B.
function setupGraphInteractions(svg, pos) {
  if (!svg) return;

  // Click a connection arrow → delete that relationship.
  svg.querySelectorAll('.glink-group').forEach((g) => g.addEventListener('click', async () => {
    const id = g.dataset.linkId;
    if (!id) return;
    if (!confirm('Delete this connection?')) return;
    try { await api(`/api/relationships/${id}`, { method: 'DELETE' }); toast('Connection removed'); loadGraph(); }
    catch (err) { toast(err.message, true); }
  }));

  let drag = null;
  const toSvg = (cx, cy) => { const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy; const p = pt.matrixTransform(svg.getScreenCTM().inverse()); return { x: p.x, y: p.y }; };

  function onMove(e) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 5) drag.moved = true;
    const p = toSvg(e.clientX, e.clientY);
    const line = svg.querySelector('#tempLink');
    if (line) { line.setAttribute('x2', p.x); line.setAttribute('y2', p.y); }
  }
  async function onUp(e) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const line = svg.querySelector('#tempLink'); if (line) line.remove();
    const d = drag; drag = null;
    if (!d) return;
    if (!d.moved) { graphRoot = d.id; graphRootType = d.type; loadGraph(); return; } // click → drill
    const tgt = document.elementFromPoint(e.clientX, e.clientY)?.closest('.gnode');
    if (tgt && tgt.dataset.id !== d.id) {
      try {
        await api('/api/relationships', { method: 'POST', body: JSON.stringify({
          from_id: d.id, from_type: d.type, to_id: tgt.dataset.id, to_type: tgt.dataset.type, relationship_type: 'parent',
        }) });
        toast('Linked: parent → child'); loadGraph();
      } catch (err) { toast(err.message, true); }
    }
  }

  svg.querySelectorAll('.gnode').forEach((g) => g.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = pos[g.dataset.id];
    drag = { id: g.dataset.id, type: g.dataset.type, x0: e.clientX, y0: e.clientY, moved: false };
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('id', 'tempLink');
    line.setAttribute('x1', start.x); line.setAttribute('y1', start.y);
    line.setAttribute('x2', start.x); line.setAttribute('y2', start.y);
    line.setAttribute('stroke', '#7aa2ff'); line.setAttribute('stroke-width', '2'); line.setAttribute('stroke-dasharray', '5');
    svg.appendChild(line);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }));
}

// ================= RECURRING =================
async function loadRecurring() {
  const rules = await api('/api/recurrence-rules');
  const wrap = $('#recurringList');
  if (!rules.length) { wrap.innerHTML = '<div class="empty">No recurring rules. Toggle "Make recurring" on a task or maintenance form.</div>'; return; }
  wrap.innerHTML = rules.map((r) => {
    const name = r.template_payload?.task_name || `${r.template_payload?.environment || ''} maintenance` || r.template_type;
    return `<div class="recur-card ${r.active ? '' : 'paused'}" data-id="${r.id}">
      <h4>${esc(name)} <span class="recur-badge">${esc(r.template_type)}</span></h4>
      <div class="rc-meta">📅 ${esc(r.schedule_human)}</div>
      <div class="rc-meta">⏭️ next: ${fmtDateTime(r.next_run_at)}</div>
      <div class="rc-meta">↩️ last: ${r.last_generated_at ? fmtDateTime(r.last_generated_at) : '—'}</div>
      <div class="rc-meta owner-note">created by ${esc(r.created_by || '—')}</div>
      ${canEditDoc(r) ? `<div class="rc-actions">
        <button class="btn toggle">${r.active ? '<i data-lucide="pause"></i> Pause' : '<i data-lucide="play"></i> Resume'}</button>
        <button class="btn del"><i data-lucide="trash-2"></i> Delete</button>
      </div>` : ''}</div>`;
  }).join('');
  $$('#recurringList .toggle').forEach((b) => b.addEventListener('click', async () => {
    const card = b.closest('.recur-card'); const active = card.classList.contains('paused');
    try { await api(`/api/recurrence-rules/${card.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active }) }); loadRecurring(); } catch (e) { toast(e.message, true); }
  }));
  $$('#recurringList .del').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this recurrence rule?')) return;
    const card = b.closest('.recur-card');
    try { await api(`/api/recurrence-rules/${card.dataset.id}`, { method: 'DELETE' }); loadRecurring(); } catch (e) { toast(e.message, true); }
  }));
}

// ================= TAG LIBRARY =================
$('#tagForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = formData(e.target);
  const unlock = lockSubmit(e.target);
  try { await api('/api/tags', { method: 'POST', body: JSON.stringify(data) }); await refreshTags(); e.target.reset(); $('[name=color]', e.target).value = '#7aa2ff'; toast('Tag created'); loadTagLibrary(); }
  catch (err) { toast(err.message, true); } finally { unlock(); }
});
async function loadTagLibrary() {
  await refreshTags();
  const wrap = $('#tagLibrary');
  if (!allTags.length) { wrap.innerHTML = '<div class="empty">No tags yet.</div>'; return; }
  wrap.innerHTML = allTags.map((t) => `
    <div class="tag-lib-card" data-id="${t.id}">
      <div class="tl-top"><span class="tagpill" style="background:${t.color}">${esc(t.name)}</span><span class="tl-cat">${esc(t.category)}</span></div>
      <div class="tl-desc">${esc(t.description || 'No description')}</div>
      ${canEditDoc(t) ? `<div class="tl-actions">
        <input type="color" value="${esc(t.color)}" class="recolor" />
        <button class="btn save"><i data-lucide="check"></i> Save</button>
        <button class="btn del"><i data-lucide="trash-2"></i> Delete</button>
      </div>` : `<div class="owner-note">created by ${esc(t.created_by || '—')}</div>`}
    </div>`).join('');
  $$('#tagLibrary .save').forEach((b) => b.addEventListener('click', async () => {
    const card = b.closest('.tag-lib-card'); const color = $('.recolor', card).value;
    try { await api(`/api/tags/${card.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ color }) }); await refreshTags(); toast('Tag updated'); loadTagLibrary(); } catch (e) { toast(e.message, true); }
  }));
  $$('#tagLibrary .del').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete tag and strip it from all items?')) return;
    const card = b.closest('.tag-lib-card');
    try { await api(`/api/tags/${card.dataset.id}`, { method: 'DELETE' }); await refreshTags(); toast('Tag deleted'); loadTagLibrary(); } catch (e) { toast(e.message, true); }
  }));
}

// ================= TAGS OVERVIEW =================
async function loadTagsOverview() {
  const rows = await api('/api/tags/overview');
  const tbody = $('#tagOverviewTable tbody');
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty">No tags.</td></tr>`; return; }
  tbody.innerHTML = rows.map((r) => `
    <tr><td><span class="tagpill" style="background:${r.color}">${esc(r.name)}</span></td>
    <td>${esc(r.category)}</td><td>${r.open}</td><td>${r.closed}</td><td><strong>${r.total}</strong></td></tr>`).join('');
}

// ================= AUDIT LOG =================
$('#auditSearch').addEventListener('click', loadAudit);
async function loadAudit() {
  const params = new URLSearchParams();
  if ($('#auditType').value) params.set('entity_type', $('#auditType').value);
  if ($('#auditActor').value) params.set('actor', $('#auditActor').value);
  if ($('#auditFrom').value) params.set('from', $('#auditFrom').value);
  if ($('#auditTo').value) params.set('to', $('#auditTo').value);
  if ($('#auditQ').value) params.set('q', $('#auditQ').value);
  const rows = await api(`/api/activity-log?${params}`);
  const tbody = $('#auditTable tbody');
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty">No activity.</td></tr>`; return; }
  tbody.innerHTML = rows.map((r) => `
    <tr><td>${fmtDateTime(r.timestamp)}</td><td>${esc(r.entity_type)}</td><td>${esc(r.action)}</td>
    <td>${r.field_changed ? `${esc(r.field_changed)}: ${esc(r.old_value)}→${esc(r.new_value)}` : '—'}</td>
    <td>${esc(r.reason_note || '')}</td><td>${esc(r.actor)}</td></tr>`).join('');
}

// ================= GLOBAL SEARCH =================
const searchInput = $('#globalSearch'), searchResults = $('#searchResults');
let searchTimer;
const INDEX_TAB = { daily_tasks: 'tasks', pipelines: 'pipelines', maintenance: 'maintenance', pocs: 'pocs', timeline_events: 'timeline', activity_log: 'audit', tags: 'tags' };
searchInput.addEventListener('input', () => { clearTimeout(searchTimer); const q = searchInput.value.trim(); if (!q) { searchResults.classList.add('hidden'); return; } searchTimer = setTimeout(() => runSearch(q), 220); });
searchInput.addEventListener('focus', () => { if (searchInput.value.trim() && searchResults.innerHTML) searchResults.classList.remove('hidden'); });
document.addEventListener('click', (e) => { if (!e.target.closest('.searchwrap')) searchResults.classList.add('hidden'); });

async function runSearch(q) {
  try {
    const { groups } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    searchResults.classList.remove('hidden');
    if (!groups.length) { searchResults.innerHTML = `<div class="search-empty">No matches for "${esc(q)}".</div>`; return; }
    searchResults.innerHTML = groups.map((g) => `<div class="search-group"><div class="search-group-title">${esc(g.label)} (${g.count})</div>${g.results.map((r) => renderSearchItem(g, r)).join('')}</div>`).join('');
    $$('.search-item').forEach((el) => el.addEventListener('click', () => { switchTab(el.dataset.tab); searchResults.classList.add('hidden'); searchInput.value = ''; }));
  } catch (e) { searchResults.classList.remove('hidden'); searchResults.innerHTML = `<div class="search-empty">${esc(e.message)}</div>`; }
}
function renderSearchItem(group, r) {
  const title = {
    daily_tasks: r.task_name, pipelines: r.pipeline_name,
    maintenance: `${r.environment} ${r.version || ''}`.trim() || 'Maintenance',
    pocs: r.title, timeline_events: r.event_title,
    activity_log: `${r.action} · ${r.entity_type}`, tags: r.name,
  }[group.index] || r.id;
  let snippet = '';
  if (r._highlight) { const f = Object.keys(r._highlight)[0]; snippet = r._highlight[f]?.[0] || ''; }
  if (!snippet) snippet = esc(r.todo_description || r.flow || r.notes || r.concept_description || r.event_description || r.reason_note || r.description || '');
  const tab = INDEX_TAB[group.index] || 'timeline';
  return `<div class="search-item" data-tab="${tab}"><div class="si-title">${esc(title)}</div>${snippet ? `<div class="si-desc">${snippet}</div>` : ''}</div>`;
}

// ================= AUTH =================
let authMode = 'login';
function setupAuthScreen() {
  $$('.auth-tab').forEach((tab) => tab.addEventListener('click', () => {
    authMode = tab.dataset.mode;
    $$('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('.reg-only').classList.toggle('hidden', authMode !== 'register');
    $('#authSubmit').textContent = authMode === 'register' ? 'Create account' : 'Log in';
    $('#authError').classList.add('hidden');
  }));

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { username: f.username.value, password: f.password.value };
    if (authMode === 'register') body.display_name = f.display_name.value;
    const btn = $('#authSubmit'); btn.disabled = true;
    try {
      const { token, user } = await api(`/api/auth/${authMode}`, { method: 'POST', body: JSON.stringify(body) });
      authToken = token; localStorage.setItem('jwt', token); currentUser = user;
      await startApp();
    } catch (err) {
      const el = $('#authError'); el.textContent = err.message; el.classList.remove('hidden');
    } finally { btn.disabled = false; }
  });

  $('#logoutBtn').addEventListener('click', () => { localStorage.removeItem('jwt'); location.reload(); });
}
function showLogin() { $('#authScreen').classList.remove('hidden'); }
function hideLogin() { $('#authScreen').classList.add('hidden'); }

async function loadUsers() {
  try { allUsers = await api('/api/users'); } catch { allUsers = []; }
}
// Build assignment <option>s: common + every user (current user marked).
function assignOptionsHtml(selected) {
  let html = `<option value="common">🌐 common (anyone)</option>`;
  for (const u of allUsers) {
    const me = u.username === currentUser.username;
    html += `<option value="${esc(u.username)}" ${u.username === selected ? 'selected' : ''}>${esc(u.display_name || u.username)}${me ? ' (me)' : ''}</option>`;
  }
  return html;
}
function populateAssignSelects() {
  $$('.assign-select').forEach((sel) => { sel.innerHTML = assignOptionsHtml(currentUser.username); });
}

// Can the current user edit this doc? (mirrors backend canEdit)
function canEditDoc(d) {
  if (!d || !d.created_by) return true;
  return d.created_by === currentUser.username || d.assigned_to === currentUser.username || d.assigned_to === 'common';
}
function assigneePill(t) {
  const a = t.assigned_to;
  if (!a) return '<span class="muted">—</span>';
  if (a === 'common') return '<span class="assignee-pill common">common</span>';
  const me = a === currentUser.username;
  const u = allUsers.find((x) => x.username === a);
  return `<span class="assignee-pill ${me ? 'me' : ''}">${esc(u ? (u.display_name || u.username) : a)}${me ? ' (me)' : ''}</span>`;
}

// ================= INIT =================
let componentsReady = false;
// Render Lucide icons, debounced — used after dynamic re-renders.
let _iconTimer;
function refreshIcons() { clearTimeout(_iconTimer); _iconTimer = setTimeout(() => { try { window.lucide?.createIcons(); } catch { /* ignore */ } }, 30); }

async function init() {
  window.lucide?.createIcons(); // render icons in static markup
  // Auto-render icons whenever dynamic content is added to the page.
  new MutationObserver(refreshIcons).observe(document.body, { childList: true, subtree: true });
  setupAuthScreen();
  if (authToken) {
    try { const { user } = await api('/api/auth/me'); currentUser = user; return startApp(); }
    catch { authToken = null; localStorage.removeItem('jwt'); }
  }
  showLogin();
}

async function startApp() {
  hideLogin();
  $('#currentUserChip').textContent = currentUser.display_name || currentUser.username;
  $('#todayLabel').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const today = todayStr();
  $('#timelineDate').value = today; $('#checklistDate').value = today; $('#tasksDate').value = today;
  $('#auditFrom').value = today; $('#auditTo').value = today;
  try { await refreshTags(); } catch {}
  await loadUsers();
  if (!componentsReady) { initComponents(); componentsReady = true; }
  populateAssignSelects();
  applyFormDateDefaults();
  loadHome();
  refreshOverdue();
}
init();
