'use strict';
/* Stretch + Lift — everything is stored on this device (localStorage). */

const KEY = 'stretchlift.v1';
// A stretch day counts once every stretch in at least one workout is ticked.

// ---------- small utils ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
const todayKey = () => keyOf(new Date());
const weekdayIdx = k => (parseKey(k).getDay() + 6) % 7; // Mon=0 … Sun=6
const mondayOf = k => addDays(k, -weekdayIdx(k));
const weekDays = mon => Array.from({ length: 7 }, (_, i) => addDays(mon, i));
const fmtDay = (k, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => parseKey(k).toLocaleDateString(undefined, opts);
const fmtShort = k => fmtDay(k, { day: 'numeric', month: 'short' });
const fmtNum = n => String(Math.round(n * 10) / 10);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- state ----------
function blankState() {
  return {
    version: 2,
    workouts: [],    // {id, name, archived}
    stretches: [],   // {id, name, archived, workoutId, archivedWith?}
    lifts: [],       // {id, name, archived}
    stretchLog: {},  // date -> {items:[ids], done:[ids], groups:{workoutId:[ids]}, notes} (+ legacyMet for v1 days)
    gymLog: {},      // date -> {entries:{liftId:{reps, kg}}, notes}
    settings: { startDate: todayKey(), stretchTime: '20:00', gymDay: 'FR', gymTime: '18:00', lastBackup: null },
  };
}
function normalise(s) {
  const b = blankState();
  if (!s || typeof s !== 'object') return b;
  const st = { ...b, ...s, settings: { ...b.settings, ...(s.settings || {}) } };
  migrate(st);
  return st;
}
function migrate(st) {
  if (!Array.isArray(st.workouts)) st.workouts = [];
  // v1 → v2: stretches had no workout, so put any orphans into one default workout.
  const orphans = st.stretches.filter(x => !st.workouts.some(w => w.id === x.workoutId));
  if (orphans.length) {
    let w = st.workouts.find(x => !x.archived);
    if (!w) { w = { id: uid(), name: 'My stretches', archived: false }; st.workouts.push(w); }
    for (const x of orphans) x.workoutId = w.id;
  }
  // Days logged under the old 50% rule keep the result they had (until edited).
  for (const s of Object.values(st.stretchLog)) {
    if (s.groups || s.legacyMet !== undefined) continue;
    const items = s.items || [], done = (s.done || []).filter(id => items.includes(id)).length;
    s.legacyMet = items.length > 0 && done / items.length >= 0.5;
  }
  st.version = 2;
}
function load() {
  try { return normalise(JSON.parse(localStorage.getItem(KEY))); } catch (e) { return blankState(); }
}
let state = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { toast('⚠️ Couldn’t save — export a backup from More'); }
}
save(); // records startDate on first launch

const ui = {
  tab: 'stretch',
  date: { stretch: todayKey(), lift: todayKey() },
  edit: { stretch: false, lift: false },
  calMonth: todayKey().slice(0, 7),
  progressLift: null,
  metric: 'kg',
};

// ---------- exercises ----------
const listOf = kind => (kind === 'stretch' ? state.stretches : kind === 'workout' ? state.workouts : state.lifts);
const activeOf = kind => listOf(kind).filter(x => !x.archived);
const findEx = (kind, id) => listOf(kind).find(x => x.id === id);
const noun = kind => ({ stretch: 'stretch', workout: 'workout', lift: 'exercise' }[kind]);
const nouns = kind => ({ stretch: 'stretches', workout: 'workouts', lift: 'exercises' }[kind]);
const stretchesIn = wid => activeOf('stretch').filter(x => x.workoutId === wid);

function startKey() {
  let s = state.settings.startDate || todayKey();
  for (const k of Object.keys(state.stretchLog)) if (k < s) s = k;
  for (const k of Object.keys(state.gymLog)) if (k < s) s = k;
  return s;
}

// ---------- stretching ----------
// Shown for a date: every current stretch, plus removed ones that were ticked that day.
function stretchIdsFor(date) {
  const ids = activeOf('stretch').map(x => x.id);
  const s = state.stretchLog[date];
  if (s) for (const id of s.done) if (!ids.includes(id) && findEx('stretch', id)) ids.push(id);
  return ids;
}
// The workouts shown for a date, each with the stretch ids in it (empty workouts included).
function groupsFor(date) {
  const out = activeOf('workout').map(w => ({ w, ids: [] }));
  for (const id of stretchIdsFor(date)) {
    const ex = findEx('stretch', id);
    let g = out.find(o => o.w.id === ex.workoutId);
    if (!g) { const w = findEx('workout', ex.workoutId); if (!w) continue; g = { w, ids: [] }; out.push(g); }
    g.ids.push(id);
  }
  return out;
}
function snapshot(date, s) {
  s.items = stretchIdsFor(date);
  s.groups = Object.fromEntries(groupsFor(date).filter(g => g.ids.length).map(g => [g.w.id, g.ids]));
  delete s.legacyMet;
}
function stretchScore(date) {
  const s = state.stretchLog[date];
  if (!s) return null;
  const any = s.done.length > 0;
  if (s.legacyMet !== undefined) return { met: s.legacyMet, any, completed: [] };
  const done = new Set(s.done);
  const completed = Object.entries(s.groups || {}).filter(([, ids]) => ids.length && ids.every(id => done.has(id))).map(([wid]) => wid);
  return { met: completed.length > 0, any, completed };
}
function stretchMet(date) { const sc = stretchScore(date); return !!sc && sc.met; }
function stretchSession(date) { return state.stretchLog[date] || (state.stretchLog[date] = { items: [], done: [], groups: {}, notes: '' }); }
function dropIfEmptyStretch(date) {
  const s = state.stretchLog[date];
  if (s && !s.done.length && !s.notes.trim()) delete state.stretchLog[date];
}
function toggleStretch(date, id, on) {
  const s = stretchSession(date);
  s.done = s.done.filter(x => x !== id);
  if (on) s.done.push(id);
  snapshot(date, s); // record which workouts this day was scored against
  dropIfEmptyStretch(date);
}
// Keep today's scoring in step when workouts or stretches change.
function resyncToday() {
  const t = todayKey(), s = state.stretchLog[t];
  if (s) { snapshot(t, s); dropIfEmptyStretch(t); }
}

// ---------- gym ----------
function gymIdsFor(date) {
  const ids = activeOf('lift').map(x => x.id);
  const g = state.gymLog[date];
  if (g) for (const id of Object.keys(g.entries)) if (!ids.includes(id) && findEx('lift', id)) ids.push(id);
  return ids;
}
function gymHas(date) { const g = state.gymLog[date]; return !!g && Object.keys(g.entries).length > 0; }
function gymSession(date) { return state.gymLog[date] || (state.gymLog[date] = { entries: {}, notes: '' }); }
function dropIfEmptyGym(date) {
  const g = state.gymLog[date];
  if (g && !Object.keys(g.entries).length && !g.notes.trim()) delete state.gymLog[date];
}
function setGym(date, id, field, raw) {
  const g = gymSession(date);
  const e = g.entries[id] || { reps: null, kg: null };
  const v = raw === '' ? null : Number(raw.replace(',', '.'));
  e[field] = v === null || !isFinite(v) || v < 0 ? null : v;
  if (e.reps === null && e.kg === null) delete g.entries[id]; else g.entries[id] = e;
  dropIfEmptyGym(date);
}

// ---------- weeks & streaks ----------
// Week status halves: met | failed | pending | future | none (before you started)
function weekStatus(mon, today = todayKey(), start = startKey()) {
  const days = weekDays(mon), sun = days[6];
  const gymCount = days.filter(gymHas).length;
  if (sun < start) return { s: 'none', g: 'none', gymCount };
  if (mon > today) return { s: 'future', g: 'future', gymCount };
  const counted = days.filter(d => d >= start); // days before your first use don't count against you
  let s;
  if (counted.every(stretchMet)) s = 'met';
  else if (counted.some(d => d < today && !stretchMet(d)) || sun < today) s = 'failed';
  else s = 'pending';
  const g = gymCount > 0 ? 'met' : sun < today ? 'failed' : 'pending';
  return { s, g, gymCount };
}
function streaks() {
  const today = todayKey(), start = startKey();
  let d = stretchMet(today) ? today : addDays(today, -1), cur = 0;
  while (stretchMet(d)) { cur++; d = addDays(d, -1); }
  let best = 0, run = 0;
  for (let k = start; k <= today; k = addDays(k, 1)) { run = stretchMet(k) ? run + 1 : 0; best = Math.max(best, run); }

  const thisMon = mondayOf(today);
  const weekHas = m => weekDays(m).some(gymHas);
  let w = weekHas(thisMon) ? thisMon : addDays(thisMon, -7), gcur = 0;
  while (weekHas(w)) { gcur++; w = addDays(w, -7); }
  let gbest = 0, grun = 0, perfect = 0;
  for (let m = mondayOf(start); m <= thisMon; m = addDays(m, 7)) {
    grun = weekHas(m) ? grun + 1 : 0; gbest = Math.max(gbest, grun);
    const ws = weekStatus(m, today, start);
    if (ws.s === 'met' && ws.g === 'met') perfect++;
  }
  return { cur, best, gcur, gbest, perfect };
}

// ---------- shared view pieces ----------
function dateNav(kind) {
  const date = ui.date[kind], today = todayKey();
  const label = date === today ? 'Today' : date === addDays(today, -1) ? 'Yesterday' : fmtDay(date);
  return `
  <div class="datenav">
    <button class="icon-btn" data-action="date" data-kind="${kind}" data-step="-1" aria-label="Previous day">‹</button>
    <div class="datenav-label">
      <strong>${label}</strong><span>${fmtDay(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
      <input type="date" data-datepick="${kind}" value="${date}" max="${today}" aria-label="Pick a date">
    </div>
    <button class="icon-btn" data-action="date" data-kind="${kind}" data-step="1" aria-label="Next day" ${date >= today ? 'disabled' : ''}>›</button>
  </div>
  ${date !== today ? `<button class="link-btn" style="margin-top:-6px" data-action="date-today" data-kind="${kind}">Back to today</button>` : ''}`;
}
function notesCard(kind, text) {
  return `<div class="card"><label class="notes-label" for="notes-${kind}">Notes</label>
    <textarea id="notes-${kind}" data-notes="${kind}" rows="3" placeholder="How did it go?">${esc(text)}</textarea></div>`;
}
function emptyCard(kind) {
  return `<div class="card"><p class="empty">No ${nouns(kind)} yet.<br>Add the ones you do and they’ll appear every session.</p>
    <button class="btn wide" data-action="edit" data-kind="${kind}">Add ${nouns(kind)}</button></div>`;
}
function editList(kind) {
  const items = activeOf(kind);
  return `
  <form class="card add-form" data-add="${kind}">
    <input type="text" name="exname" placeholder="New ${noun(kind)}" autocomplete="off" autocapitalize="words" enterkeyhint="done" maxlength="60">
    <button class="btn">Add</button>
  </form>
  <div class="card list">
    ${items.length ? items.map((x, i) => `
    <div class="row edit-row"><span class="row-name">${esc(x.name)}</span>${editButtons(kind, x, i, items.length)}</div>`).join('') : `<p class="empty">No ${nouns(kind)} yet — add your first above.</p>`}
  </div>
  <p class="hint">Deleting keeps all past history. Deleted ${nouns(kind)} can be restored from More.</p>
  <button class="btn wide" data-action="edit" data-kind="${kind}">Done</button>`;
}

function editButtons(kind, x, i, n, extraAction) {
  return `
      <button class="icon-btn sm" data-action="move" data-kind="${kind}" data-id="${x.id}" data-step="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button class="icon-btn sm" data-action="move" data-kind="${kind}" data-id="${x.id}" data-step="1" ${i === n - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <button class="icon-btn sm" data-action="${extraAction || 'rename'}" data-kind="${kind}" data-id="${x.id}" aria-label="Edit">✎</button>
      <button class="icon-btn sm danger" data-action="archive" data-kind="${kind}" data-id="${x.id}" aria-label="Delete">✕</button>`;
}
function editStretches() {
  const ws = activeOf('workout');
  let html = `
  <form class="card add-form" data-add="workout">
    <input type="text" name="exname" placeholder="New workout (e.g. Morning)" autocomplete="off" autocapitalize="words" enterkeyhint="done" maxlength="60">
    <button class="btn">Add</button>
  </form>`;
  if (!ws.length) html += `<div class="card"><p class="empty">Start by adding a workout above, then add its stretches.</p></div>`;
  ws.forEach((w, i) => {
    const items = stretchesIn(w.id);
    html += `
  <section class="card group">
    <div class="row edit-row group-edit-head">
      <strong class="row-name">${esc(w.name)}</strong>${editButtons('workout', w, i, ws.length)}
    </div>
    <div class="list">
      ${items.map((x, j) => `<div class="row edit-row"><span class="row-name">${esc(x.name)}</span>${editButtons('stretch', x, j, items.length, 'edit-stretch')}</div>`).join('')}
    </div>
    <form class="add-form inset" data-add="stretch" data-workout="${w.id}">
      <input type="text" name="exname" placeholder="Add stretch to ${esc(w.name)}" autocomplete="off" autocapitalize="sentences" enterkeyhint="done" maxlength="60">
      <button class="btn">Add</button>
    </form>
  </section>`;
  });
  html += `<p class="hint">A day counts when every stretch in at least one workout is ticked. Tap ✎ on a stretch to rename it or move it to another workout. Deleting keeps all past history; restore from More.</p>
  <button class="btn wide" data-action="edit" data-kind="stretch">Done</button>`;
  return html;
}

// ---------- views ----------
function viewStretch() {
  if (ui.edit.stretch) return editStretches();
  const date = ui.date.stretch, s = state.stretchLog[date];
  const groups = groupsFor(date).filter(g => g.ids.length);
  let html = dateNav('stretch');
  if (!groups.length) return html + emptyCard('stretch') + notesCard('stretch', s ? s.notes : '');
  const done = new Set(s ? s.done : []);
  const complete = groups.filter(g => g.ids.every(id => done.has(id)));
  const legacy = s && s.legacyMet !== undefined;
  html += complete.length
    ? `<div class="banner ok">✓ Day complete — ${complete.map(g => esc(g.w.name)).join(', ')} done</div>`
    : legacy && s.legacyMet
      ? `<div class="banner ok">✓ Counted under the old 50% rule. Ticking anything now re-scores this day by workout.</div>`
      : `<div class="banner warn">Finish every stretch in ${groups.length > 1 ? 'any one workout' : 'the workout'} to complete the day</div>`;
  for (const g of groups) {
    const n = g.ids.filter(id => done.has(id)).length, all = n === g.ids.length;
    html += `
  <section class="card group ${all ? 'met' : ''}">
    <div class="group-head"><strong>${esc(g.w.name)}${g.w.archived ? '<em class="tag">removed</em>' : ''}</strong><span class="count">${all ? '✓ ' : ''}${n}/${g.ids.length}</span></div>
    <div class="bar"><span style="width:${(n / g.ids.length) * 100}%"></span></div>
    <div class="list">
      ${g.ids.map(id => {
        const ex = findEx('stretch', id);
        return `<label class="row check-row"><input type="checkbox" data-stretch="${id}" ${done.has(id) ? 'checked' : ''}>
          <span class="row-name">${esc(ex.name)}${ex.archived ? '<em class="tag">removed</em>' : ''}</span></label>`;
      }).join('')}
    </div>
  </section>`;
  }
  html += notesCard('stretch', s ? s.notes : '');
  html += `<button class="link-btn" data-action="edit" data-kind="stretch">Add or edit workouts &amp; stretches</button>`;
  return html;
}
function openStretchEditor(id) {
  const ex = findEx('stretch', id);
  $('#sheet').innerHTML = `
  <div class="sheet-backdrop" data-action="close-sheet"></div>
  <form class="sheet-panel" data-edit-stretch="${id}" role="dialog" aria-label="Edit stretch">
    <div class="grabber"></div>
    <h2>Edit stretch</h2>
    <div class="card">
      <label class="notes-label" for="es-name">Name</label>
      <input type="text" id="es-name" name="exname" value="${esc(ex.name)}" maxlength="60" style="width:100%">
      <label class="notes-label" for="es-w" style="margin-top:12px">Workout</label>
      <select id="es-w" name="workout" style="width:100%">
        ${activeOf('workout').map(w => `<option value="${w.id}" ${w.id === ex.workoutId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
      </select>
    </div>
    <div class="btn-row"><button type="button" class="btn secondary" data-action="close-sheet">Cancel</button><button class="btn">Save</button></div>
  </form>`;
  $('#sheet').hidden = false;
}

function gymWeekHTML(date) {
  const today = todayKey(), mon = mondayOf(date), isThis = mon === mondayOf(today);
  const sessions = weekDays(mon).filter(gymHas).length;
  const label = isThis ? 'This week' : `Week of ${fmtShort(mon)}`;
  if (sessions) return `<div class="banner ok" id="gym-week">✓ ${label}: ${plural(sessions, 'gym session')}</div>`;
  if (isThis) {
    const left = 7 - weekdayIdx(today);
    return `<div class="banner warn" id="gym-week">No gym yet this week — ${left === 1 ? 'today’s the last day' : `${left} days left`}</div>`;
  }
  return `<div class="banner bad" id="gym-week">No gym logged for the week of ${fmtShort(mon)}</div>`;
}
function updateGymWeek() { const el = $('#gym-week'); if (el) el.outerHTML = gymWeekHTML(ui.date.lift); }

function viewGym() {
  if (ui.edit.lift) return editList('lift');
  const date = ui.date.lift, ids = gymIdsFor(date), g = state.gymLog[date];
  let html = dateNav('lift') + gymWeekHTML(date);
  if (!ids.length) return html + emptyCard('lift') + notesCard('lift', g ? g.notes : '');
  html += `<div class="card list">
    ${ids.map(id => {
      const ex = findEx('lift', id), e = (g && g.entries[id]) || {};
      return `<div class="row gym-row">
        <span class="row-name">${esc(ex.name)}${ex.archived ? '<em class="tag">removed</em>' : ''}</span>
        <label class="num"><input type="text" inputmode="numeric" data-lift="${id}" data-field="reps" value="${e.reps ?? ''}" placeholder="–" aria-label="${esc(ex.name)} reps"><small>reps</small></label>
        <label class="num"><input type="text" inputmode="decimal" data-lift="${id}" data-field="kg" value="${e.kg ?? ''}" placeholder="–" aria-label="${esc(ex.name)} kg"><small>kg</small></label>
      </div>`;
    }).join('')}
  </div>
  <p class="hint">Log your final set. Leave an exercise blank if you skipped it.</p>`;
  html += notesCard('lift', g ? g.notes : '');
  html += `<button class="link-btn" data-action="edit" data-kind="lift">Add or edit exercises</button>`;
  return html;
}

function viewCalendar() {
  const today = todayKey(), start = startKey(), st = streaks();
  const thisWeek = weekStatus(mondayOf(today), today, start);
  const left = 7 - weekdayIdx(today);

  let html = `
  <div class="stats">
    <div class="stat"><span class="lbl">🔥 Stretch</span><b>${st.cur}</b><span>day streak · best ${st.best}</span></div>
    <div class="stat"><span class="lbl">🏋️ Gym</span><b>${st.gcur}</b><span>week streak · best ${st.gbest}</span></div>
    <div class="stat"><span class="lbl">⭐ Perfect</span><b>${st.perfect}</b><span>full weeks</span></div>
  </div>
  <div class="nudges">
    ${stretchMet(today)
      ? `<div class="banner ok">✓ Stretching done today</div>`
      : `<div class="banner warn">${st.cur ? `Stretch today to make it ${st.cur + 1} days in a row` : 'Stretch today to start a streak'}</div>`}
    ${thisWeek.gymCount
      ? `<div class="banner ok">✓ Gym done this week (${plural(thisWeek.gymCount, 'session')})</div>`
      : `<div class="banner warn">${left === 1 ? 'Last day' : `${left} days left`} to hit the gym this week${st.gcur ? ` and keep your ${st.gcur}-week streak` : ''}</div>`}
  </div>`;

  const [y, m] = ui.calMonth.split('-').map(Number);
  const first = keyOf(new Date(y, m - 1, 1)), last = keyOf(new Date(y, m, 0));
  const monthName = parseKey(first).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  html += `<div class="card cal-card">
    <div class="cal-head">
      <button class="icon-btn sm" data-action="cal" data-step="-1" aria-label="Previous month">‹</button>
      <strong>${monthName}</strong>
      <button class="icon-btn sm" data-action="cal" data-step="1" aria-label="Next month" ${ui.calMonth >= today.slice(0, 7) ? 'disabled' : ''}>›</button>
    </div>
    <div class="cal">
      ${['M', 'T', 'W', 'T', 'F', 'S', 'S', 'Wk'].map(d => `<div class="dow">${d}</div>`).join('')}`;
  for (let mon = mondayOf(first); mon <= last; mon = addDays(mon, 7)) {
    for (const d of weekDays(mon)) {
      const sc = stretchScore(d);
      let cls = 'day';
      if (d.slice(0, 7) !== ui.calMonth) cls += ' out';
      if (d === today) cls += ' today';
      if (d <= today) {
        if (sc && sc.met) cls += ' s-met';
        else if (sc && sc.any) cls += ' s-part';
        else if (d >= start && d < today) cls += ' s-miss';
      }
      if (gymHas(d)) cls += ' g';
      html += `<button class="${cls}" data-action="day" data-date="${d}" ${d > today ? 'disabled' : ''} aria-label="${fmtDay(d)}">
        <span class="num">${parseKey(d).getDate()}</span><span class="gdot"></span></button>`;
    }
    const ws = weekStatus(mon, today, start);
    html += `<div class="wk" title="Stretch every day / gym at least once"><span class="half ${ws.s}">S</span><span class="half ${ws.g}">G</span></div>`;
  }
  html += `</div>
    <div class="legend">
      <span><i style="background:var(--green)"></i>Workout done</span>
      <span><i style="background:var(--amber-soft);box-shadow:inset 0 0 0 1px var(--amber)"></i>Some</span>
      <span><i style="background:var(--red-soft);box-shadow:inset 0 0 0 1px var(--red)"></i>Missed</span>
      <span><i style="background:var(--gym);width:7px;height:7px"></i>Gym</span>
    </div>
    <p class="small">A stretch day counts when you finish every stretch in at least one workout. Week column: <b>S</b> goes green when you do that every day, <b>G</b> when you go to the gym at least once (Mon–Sun). Tap a day for details.</p>
  </div>`;
  return html;
}

const METRICS = {
  kg: { label: 'Weight', unit: 'kg', get: e => e.kg },
  reps: { label: 'Reps', unit: 'reps', get: e => e.reps },
  e1rm: { label: 'Est. 1RM', unit: 'kg', get: e => (e.kg != null && e.reps ? (e.reps === 1 ? e.kg : e.kg * (1 + e.reps / 30)) : null) },
};
function liftHistory(id) {
  return Object.keys(state.gymLog).sort()
    .filter(d => state.gymLog[d].entries[id])
    .map(d => ({ d, e: state.gymLog[d].entries[id], notes: state.gymLog[d].notes }));
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
function chartSVG(points, unit) {
  const W = 340, H = 200, L = 40, R = 14, T = 12, B = 26;
  const ts = points.map(p => parseKey(p.d).getTime());
  const vs = points.map(p => p.v);
  const x0 = Math.min(...ts), x1 = Math.max(...ts);
  let y0 = Math.min(...vs), y1 = Math.max(...vs);
  if (y1 - y0 < 1e-9) { y0 -= Math.max(1, y0 * 0.1); y1 += Math.max(1, y1 * 0.1); }
  const step = niceStep((y1 - y0) / 4);
  y0 = Math.floor(y0 / step) * step; y1 = Math.ceil(y1 / step) * step;
  if (y0 < 0) y0 = 0;
  const X = t => (x1 === x0 ? (L + W - R) / 2 : L + ((t - x0) / (x1 - x0)) * (W - L - R));
  const Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const best = Math.max(...vs);
  let g = '';
  for (let v = y0; v <= y1 + step / 2; v += step) {
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/>
      <text class="axis" x="${L - 6}" y="${Y(v) + 3.5}" text-anchor="end">${fmtNum(v)}</text>`;
  }
  const xl = [points[0]];
  if (points.length > 1) xl.push(points[points.length - 1]);
  g += xl.map((p, i) => `<text class="axis" x="${X(ts[i ? points.length - 1 : 0])}" y="${H - 6}" text-anchor="${points.length === 1 ? 'middle' : i ? 'end' : 'start'}">${fmtShort(p.d)}</text>`).join('');
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(ts[i]).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  g += `<path class="line" d="${path}"/>`;
  g += points.map((p, i) => `<circle class="pt ${p.v === best ? 'pr' : ''}" cx="${X(ts[i])}" cy="${Y(p.v)}" r="${points.length > 40 ? 2.5 : 4}"><title>${fmtShort(p.d)}: ${fmtNum(p.v)} ${unit}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Progress chart">${g}</svg>`;
}
function viewProgress() {
  const lifts = state.lifts.filter(l => liftHistory(l.id).length);
  if (!lifts.length) return `<div class="card"><p class="empty">Log a few gym sessions and your progress charts will show up here.</p></div>`;
  if (!lifts.some(l => l.id === ui.progressLift)) ui.progressLift = lifts[0].id;
  const lift = findEx('lift', ui.progressLift), M = METRICS[ui.metric];
  const hist = liftHistory(lift.id);
  const pts = hist.map(h => ({ d: h.d, v: M.get(h.e) })).filter(p => p.v != null);

  let html = `<div class="chips">${lifts.map(l => `<button class="chip ${l.id === lift.id ? 'active' : ''}" data-action="pick-lift" data-id="${l.id}">${esc(l.name)}</button>`).join('')}</div>
  <div class="seg">${Object.entries(METRICS).map(([k, v]) => `<button class="${k === ui.metric ? 'active' : ''}" data-action="metric" data-m="${k}">${v.label}</button>`).join('')}</div>`;
  if (!pts.length) {
    html += `<div class="card"><p class="empty">No ${M.label.toLowerCase()} data logged for ${esc(lift.name)} yet.</p></div>`;
  } else {
    const best = pts.reduce((a, b) => (b.v > a.v ? b : a));
    const first = pts[0], latest = pts[pts.length - 1], diff = latest.v - first.v;
    html += `<div class="card chart">${chartSVG(pts, M.unit)}
      <div class="kpis">
        <div class="kpi"><b>${fmtNum(best.v)}</b><span>Best ${M.unit} · ${fmtShort(best.d)}</span></div>
        <div class="kpi"><b>${fmtNum(latest.v)}</b><span>Latest · ${fmtShort(latest.d)}</span></div>
        <div class="kpi"><b>${diff > 0 ? '+' : ''}${fmtNum(diff)}</b><span>Since first${first.v ? ` (${diff >= 0 ? '+' : ''}${Math.round((diff / first.v) * 100)}%)` : ''}</span></div>
      </div>
      ${ui.metric === 'e1rm' ? '<p class="small">Estimated one-rep max (Epley: kg × (1 + reps/30)).</p>' : ''}
    </div>`;
  }
  html += `<h2 class="section-title">History</h2><div class="card list">
    ${hist.slice().reverse().map(h => `<div class="row hist-row">
      <span class="row-name">${fmtDay(h.d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}${h.notes ? `<span class="note">${esc(h.notes)}</span>` : ''}</span>
      <span class="val">${h.e.kg != null ? fmtNum(h.e.kg) + ' kg' : '–'} × ${h.e.reps ?? '–'}</span></div>`).join('')}
  </div>`;
  return html;
}

const DAYS = [['MO', 'Monday'], ['TU', 'Tuesday'], ['WE', 'Wednesday'], ['TH', 'Thursday'], ['FR', 'Friday'], ['SA', 'Saturday'], ['SU', 'Sunday']];
function viewMore() {
  const set = state.settings;
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  // Stretches deleted along with their workout come back when the workout is restored.
  const archived = [...state.workouts.map(x => ['workout', x]), ...state.stretches.map(x => ['stretch', x]), ...state.lifts.map(x => ['lift', x])]
    .filter(([, x]) => x.archived && !x.archivedWith);
  const nStretch = Object.keys(state.stretchLog).filter(stretchMet).length;
  const nGym = Object.keys(state.gymLog).filter(gymHas).length;
  const backupAge = set.lastBackup ? Math.floor((Date.now() - new Date(set.lastBackup)) / 864e5) : null;
  const hasData = nStretch + nGym > 0;

  let html = '';
  if (!standalone) html += `<div class="banner warn"><b>Install on your iPhone:</b> open this page in Safari, tap the Share button, then <b>Add to Home Screen</b>. It then works offline like a normal app.</div>`;

  html += `<h2 class="section-title">Reminders</h2>
  <div class="card">
    <div class="set-row"><label for="st-time">Daily stretch reminder</label>
      <div class="ctrls"><input type="time" id="st-time" data-setting="stretchTime" value="${esc(set.stretchTime)}"></div></div>
    <button class="btn wide secondary" data-action="ics" data-which="stretch">Add stretch reminder to Calendar</button>
    <div class="set-row" style="margin-top:12px"><label for="gy-day">Weekly gym reminder</label>
      <div class="ctrls">
        <select id="gy-day" data-setting="gymDay">${DAYS.map(([c, n]) => `<option value="${c}" ${c === set.gymDay ? 'selected' : ''}>${n.slice(0, 3)}</option>`).join('')}</select>
        <input type="time" data-setting="gymTime" value="${esc(set.gymTime)}" aria-label="Gym reminder time">
      </div></div>
    <button class="btn wide secondary" data-action="ics" data-which="gym">Add gym reminder to Calendar</button>
    <p class="small">iPhone web apps can’t send their own scheduled notifications, so this adds a repeating Calendar event with an alert. If tapping does nothing in the home-screen app, open the page in Safari and try there.</p>
  </div>

  <h2 class="section-title">Backup</h2>
  <div class="card">
    <p style="margin:0">Your data lives only on this phone. Export a backup now and then (save it to Files or iCloud Drive).</p>
    <p class="small">${set.lastBackup ? `Last backup: ${new Date(set.lastBackup).toLocaleDateString()}${backupAge > 30 && hasData ? ' — time for a new one' : ''}` : 'No backup yet.'}</p>
    <div class="btn-row"><button class="btn" data-action="export">Export backup</button><button class="btn secondary" data-action="import">Restore…</button></div>
  </div>`;

  if (archived.length) {
    html += `<h2 class="section-title">Deleted items</h2><div class="card list">
      ${archived.map(([kind, x]) => `<div class="row"><span class="row-name">${esc(x.name)} <em class="tag">${{ workout: 'stretch workout', stretch: 'stretch', lift: 'gym' }[kind]}</em></span>
        <button class="link-btn" style="margin:0" data-action="restore" data-kind="${kind}" data-id="${x.id}">Restore</button></div>`).join('')}
    </div>`;
  }
  html += `<p class="small" style="text-align:center;margin:20px 0">${plural(nStretch, 'stretch day')} · ${plural(nGym, 'gym session')} logged since ${fmtDay(startKey(), { day: 'numeric', month: 'short', year: 'numeric' })}</p>`;
  return html;
}

// ---------- day detail sheet ----------
function openDay(d) {
  const sc = stretchScore(d), s = state.stretchLog[d], g = state.gymLog[d];
  const doneNames = s ? s.done.map(id => findEx('stretch', id)).filter(Boolean).map(x => esc(x.name)) : [];
  const entries = g ? Object.entries(g.entries).map(([id, e]) => [findEx('lift', id), e]).filter(([x]) => x) : [];
  $('#sheet').innerHTML = `
  <div class="sheet-backdrop" data-action="close-sheet"></div>
  <div class="sheet-panel" role="dialog" aria-label="${fmtDay(d)}">
    <div class="grabber"></div>
    <h2>${fmtDay(d, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
    <div class="card">
      <b>Stretching</b> ${sc ? (sc.met ? '· ✓ complete' : '· not complete') : ''}
      ${sc && sc.completed.length ? `<p class="small">Finished: ${sc.completed.map(id => findEx('workout', id)).filter(Boolean).map(w => esc(w.name)).join(', ')}</p>` : ''}
      ${s && s.legacyMet !== undefined ? '<p class="small">Scored under the old 50% rule</p>' : ''}
      <p class="small">${doneNames.length ? `Ticked: ${doneNames.join(', ')}` : 'Nothing logged'}</p>
      ${s && s.notes ? `<p class="small">📝 ${esc(s.notes)}</p>` : ''}
    </div>
    <div class="card">
      <b>Gym</b>
      ${entries.length ? entries.map(([x, e]) => `<p class="small">${esc(x.name)}: ${e.kg != null ? fmtNum(e.kg) + ' kg' : '–'} × ${e.reps ?? '–'}</p>`).join('') : '<p class="small">No session</p>'}
      ${g && g.notes ? `<p class="small">📝 ${esc(g.notes)}</p>` : ''}
    </div>
    <div class="btn-row">
      <button class="btn secondary" data-action="open-day" data-kind="stretch" data-date="${d}">Edit stretching</button>
      <button class="btn secondary" data-action="open-day" data-kind="lift" data-date="${d}">Edit gym</button>
    </div>
  </div>`;
  $('#sheet').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet').innerHTML = ''; }

// ---------- files: reminders & backup ----------
async function shareOrDownload(name, text, type, preferShare) {
  const file = new File([text], name, { type });
  if (preferShare && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}
function makeICS(which) {
  const set = state.settings, today = todayKey();
  let start = today, summary, rrule, desc;
  if (which === 'stretch') {
    summary = 'Stretch 🧘'; rrule = 'FREQ=DAILY'; desc = 'Daily stretches — tick them off in Stretch+Lift.';
  } else {
    const target = DAYS.findIndex(([c]) => c === set.gymDay);
    while (weekdayIdx(start) !== target) start = addDays(start, 1);
    summary = 'Gym check 🏋️'; rrule = `FREQ=WEEKLY;BYDAY=${set.gymDay}`; desc = 'Been to the gym this week? Log it in Stretch+Lift.';
  }
  const time = (which === 'stretch' ? set.stretchTime : set.gymTime) || '20:00';
  const dt = start.replace(/-/g, '') + 'T' + time.replace(':', '') + '00';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Stretch Lift//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${uid()}@stretch-lift`, `DTSTAMP:${stamp}`, `DTSTART:${dt}`, 'DURATION:PT15M',
    `RRULE:${rrule}`, `SUMMARY:${summary}`, `DESCRIPTION:${desc}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${summary}`, 'TRIGGER:PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}
async function exportBackup() {
  const data = JSON.stringify({ app: 'stretch-lift', exportedAt: new Date().toISOString(), ...state }, null, 1);
  const ok = await shareOrDownload(`stretch-lift-backup-${todayKey()}.json`, data, 'application/json', true);
  if (ok) { state.settings.lastBackup = new Date().toISOString(); save(); render(); toast('Backup exported'); }
}
async function importBackup(file) {
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.stretches) || !Array.isArray(d.lifts) || typeof d.stretchLog !== 'object' || typeof d.gymLog !== 'object') throw new Error('bad');
    const when = d.exportedAt ? ` from ${new Date(d.exportedAt).toLocaleDateString()}` : '';
    if (!confirm(`Replace everything on this phone with the backup${when}?`)) return;
    delete d.app; delete d.exportedAt;
    state = normalise(d); save(); render(); toast('Backup restored');
  } catch (e) { alert('That file doesn’t look like a Stretch+Lift backup.'); }
}

// ---------- render ----------
const TITLES = { stretch: 'Stretching', gym: 'Gym', calendar: 'Calendar', progress: 'Progress', more: 'More' };
const VIEWS = { stretch: viewStretch, gym: viewGym, calendar: viewCalendar, progress: viewProgress, more: viewMore };
function render() {
  document.querySelectorAll('.tabbar button').forEach(b => {
    const on = b.dataset.tab === ui.tab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const title = ui.tab === 'stretch' && ui.edit.stretch ? 'Edit workouts' : ui.tab === 'gym' && ui.edit.lift ? 'Edit exercises' : TITLES[ui.tab];
  $('#title').textContent = title;
  $('#view').innerHTML = VIEWS[ui.tab]();
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- events ----------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]');
  if (!t || t.disabled) return;
  const { action, kind, id, date } = t.dataset, step = Number(t.dataset.step);
  switch (action) {
    case 'tab':
      if (ui.tab === t.dataset.tab) ui.edit = { stretch: false, lift: false };
      ui.tab = t.dataset.tab; render(); window.scrollTo(0, 0); break;
    case 'date': {
      const next = addDays(ui.date[kind], step);
      if (next <= todayKey()) { ui.date[kind] = next; render(); }
      break;
    }
    case 'date-today': ui.date[kind] = todayKey(); render(); break;
    case 'edit': ui.edit[kind] = !ui.edit[kind]; render(); window.scrollTo(0, 0); break;
    case 'move': {
      const list = listOf(kind), me = findEx(kind, id);
      const active = kind === 'stretch' ? stretchesIn(me.workoutId) : activeOf(kind); // stretches reorder within their workout
      const i = active.indexOf(me), other = active[i + step];
      if (!other) break;
      const a = list.indexOf(active[i]), b = list.indexOf(other);
      [list[a], list[b]] = [list[b], list[a]];
      save(); render(); break;
    }
    case 'rename': {
      const ex = findEx(kind, id);
      const name = prompt(`Rename ${noun(kind)}`, ex.name);
      if (name && name.trim()) { ex.name = name.trim().slice(0, 60); save(); render(); }
      break;
    }
    case 'edit-stretch': openStretchEditor(id); break;
    case 'archive': {
      const ex = findEx(kind, id);
      if (kind === 'workout') {
        const inside = stretchesIn(id);
        if (!confirm(`Delete workout “${ex.name}”${inside.length ? ` and its ${inside.length} stretch${inside.length === 1 ? '' : 'es'}` : ''}? Past sessions keep them in your history.`)) break;
        for (const x of inside) { x.archived = true; x.archivedWith = id; }
      } else if (!confirm(`Delete “${ex.name}”? Past sessions keep it in your history.`)) break;
      ex.archived = true;
      if (kind !== 'lift') resyncToday();
      save(); render(); toast(`Deleted ${ex.name}`); break;
    }
    case 'restore': {
      const ex = findEx(kind, id); ex.archived = false;
      if (kind === 'workout') {
        for (const x of state.stretches) if (x.archivedWith === id) { x.archived = false; delete x.archivedWith; }
      } else if (kind === 'stretch') {
        const w = findEx('workout', ex.workoutId);
        if (w && w.archived) { // bring its workout back too, with whatever was deleted alongside it
          w.archived = false;
          for (const x of state.stretches) if (x.archivedWith === w.id) { x.archived = false; delete x.archivedWith; }
        }
      }
      if (kind !== 'lift') resyncToday();
      save(); render(); toast(`Restored ${ex.name}`); break;
    }
    case 'cal': {
      const [y, m] = ui.calMonth.split('-').map(Number);
      ui.calMonth = keyOf(new Date(y, m - 1 + step, 1)).slice(0, 7); render(); break;
    }
    case 'day': openDay(date); break;
    case 'close-sheet': closeSheet(); break;
    case 'open-day':
      ui.date[kind] = date; ui.edit[kind] = false; ui.tab = kind === 'stretch' ? 'stretch' : 'gym';
      closeSheet(); render(); window.scrollTo(0, 0); break;
    case 'pick-lift': ui.progressLift = id; render(); break;
    case 'metric': ui.metric = t.dataset.m; render(); break;
    case 'ics':
      shareOrDownload(t.dataset.which === 'stretch' ? 'stretch-reminder.ics' : 'gym-reminder.ics', makeICS(t.dataset.which), 'text/calendar', false);
      break;
    case 'export': exportBackup(); break;
    case 'import': $('#import-file').value = ''; $('#import-file').click(); break;
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('[data-stretch]')) {
    toggleStretch(ui.date.stretch, t.dataset.stretch, t.checked); save(); render();
  } else if (t.matches('[data-datepick]')) {
    const v = t.value, kind = t.dataset.datepick;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v <= todayKey()) { ui.date[kind] = v; render(); }
  } else if (t.matches('[data-setting]')) {
    state.settings[t.dataset.setting] = t.value; save();
  } else if (t.id === 'import-file') {
    importBackup(t.files[0]);
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.matches('[data-lift]')) {
    setGym(ui.date.lift, t.dataset.lift, t.dataset.field, t.value.trim()); save(); updateGymWeek();
  } else if (t.matches('[data-notes]')) {
    const kind = t.dataset.notes, date = ui.date[kind];
    if (kind === 'stretch') {
      const s = stretchSession(date);
      s.notes = t.value;
      if (!s.groups && s.legacyMet === undefined) snapshot(date, s);
      dropIfEmptyStretch(date);
    } else {
      gymSession(date).notes = t.value; dropIfEmptyGym(date);
    }
    save();
  }
});

document.addEventListener('submit', e => {
  const ed = e.target.closest('[data-edit-stretch]');
  if (ed) {
    e.preventDefault();
    const ex = findEx('stretch', ed.dataset.editStretch), name = ed.elements.exname.value.trim().slice(0, 60), wid = ed.elements.workout.value;
    if (name) ex.name = name;
    if (wid && wid !== ex.workoutId) { // move to the bottom of the new workout
      ex.workoutId = wid;
      state.stretches.splice(state.stretches.indexOf(ex), 1); state.stretches.push(ex);
    }
    resyncToday(); save(); closeSheet(); render(); return;
  }
  const f = e.target.closest('[data-add]');
  if (!f) return;
  e.preventDefault();
  const kind = f.dataset.add, wid = f.dataset.workout, name = f.elements.exname.value.trim().slice(0, 60);
  if (!name) return;
  const siblings = kind === 'stretch' ? stretchesIn(wid) : activeOf(kind);
  if (siblings.some(x => x.name.toLowerCase() === name.toLowerCase())) { toast(`“${name}” is already on the list`); return; }
  const item = { id: uid(), name, archived: false };
  if (kind === 'stretch') item.workoutId = wid;
  listOf(kind).push(item);
  if (kind !== 'lift') resyncToday();
  save(); render();
  // keep adding without re-tapping (for a new workout, jump to its stretch box)
  const again = kind === 'workout' ? $(`[data-workout="${item.id}"] input`) : $(`[data-add="${kind}"]${wid ? `[data-workout="${wid}"]` : ''} input`);
  if (again) again.focus();
});

// Roll "today" over if the app is left open past midnight.
let lastToday = todayKey();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const t = todayKey();
  if (t === lastToday) return;
  for (const k of ['stretch', 'lift']) if (ui.date[k] === lastToday) ui.date[k] = t;
  if (ui.calMonth === lastToday.slice(0, 7)) ui.calMonth = t.slice(0, 7);
  lastToday = t;
  render();
});

// ---------- boot ----------
if (VIEWS[location.hash.slice(1)]) ui.tab = location.hash.slice(1); // e.g. …/#calendar
render();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // When an updated version installs, reload once so it's used straight away.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
