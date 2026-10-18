import { db } from './db.js';

const APP_VERSION = '1.0.0';
const DAY = 86400000;
const WD = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];
const WD_LONG = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
const MOODS = ['😣', '😕', '😐', '🙂', '😄'];
const TITLES = { checkin: 'Stasera', stats: 'Progressi', settings: 'Impostazioni' };

const state = { habits: [], days: new Map(), lastExport: null, current: null };
let editingHabitId = null;
let noteTimer = null;

// ---------- utils ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const keyToDate = k => new Date(k + 'T12:00:00');
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addDaysKey = (k, n) => dayKey(addDays(keyToDate(k), n));
const wdIndex = d => (new Date(d).getDay() + 6) % 7; // 0 = lunedì
const weekStartKey = k => addDaysKey(k, -wdIndex(keyToDate(k)));
const todayKey = () => dayKey(new Date());
const pct = x => Math.round(x * 100) + '%';
const fmt1 = x => x.toFixed(1).replace('.', ',');
const fmtDate = d => d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
function* dayRange(from, to) { for (let k = from; k <= to; k = addDaysKey(k, 1)) yield k; }

// Dopo mezzanotte (fino alle 5) il check-in "di stasera" è ancora quello di ieri.
const defaultDay = () => (new Date().getHours() < 5 ? addDaysKey(todayKey(), -1) : todayKey());

function defaultHabits() {
  const t = todayKey();
  return [
    { id: 'gym', name: 'Palestra', icon: '🏋️', freq: 'weekly', target: 3, order: 0, archived: false, createdAt: t },
    { id: 'deutsch', name: 'Studiato tedesco', icon: '🇩🇪', freq: 'daily', target: 7, order: 1, archived: false, createdAt: t },
    { id: 'nophone', name: 'Niente telefono', icon: '📵', freq: 'daily', target: 7, order: 2, archived: false, createdAt: t },
  ];
}

// ---------- data ----------
async function load() {
  const [habits, days, seeded, lastExport] = await Promise.all([
    db.all('habits'), db.all('days'), db.getSetting('seeded'), db.getSetting('lastExport'),
  ]);
  if (!habits.length && !seeded) {
    const defs = defaultHabits();
    await db.putMany('habits', defs);
    await db.setSetting('seeded', true);
    state.habits = defs;
  } else {
    state.habits = habits;
  }
  state.days = new Map(days.map(d => [d.date, d]));
  state.lastExport = lastExport || null;
}

const activeHabits = () => state.habits.filter(h => !h.archived).sort((a, b) => a.order - b.order);
const isDone = (h, k) => !!state.days.get(k)?.done?.[h.id];
const isLogged = k => state.days.has(k);

// inizio statistiche: la data di creazione, o il primo giorno in cui l'hai spuntata se precedente
function habitStart(h) {
  let s = h.createdAt;
  for (const [k, e] of state.days) if (e.done?.[h.id] && k < s) s = k;
  return s;
}

async function saveDay(entry) {
  entry.savedAt = Date.now();
  state.days.set(entry.date, entry);
  await db.put('days', entry);
}

function getOrCreateDay(k) {
  return state.days.get(k) || { date: k, done: {}, mood: null, note: '' };
}

// ---------- calcoli ----------
// abitudini quotidiane: tasso sui giorni in cui hai fatto il check-in
function dailyRate(h, days) {
  const to = todayKey();
  const from = [addDaysKey(to, -(days - 1)), habitStart(h)].sort().pop();
  let logged = 0, done = 0;
  for (const k of dayRange(from, to)) {
    if (!isLogged(k)) continue;
    logged++; if (isDone(h, k)) done++;
  }
  return logged ? { rate: done / logged, logged, done } : null;
}

function dailyRateBetween(h, fromOffset, toOffset) {
  const t = todayKey();
  const start = habitStart(h);
  let logged = 0, done = 0;
  for (let i = fromOffset; i <= toOffset; i++) {
    const k = addDaysKey(t, -i);
    if (k < start || !isLogged(k)) continue;
    logged++; if (isDone(h, k)) done++;
  }
  return logged >= 5 ? done / logged : null;
}

function dailyStreak(h) {
  let k = todayKey(), n = 0;
  if (!isDone(h, k)) k = addDaysKey(k, -1); // stasera non ancora spuntata: la streak non è rotta
  while (isDone(h, k)) { n++; k = addDaysKey(k, -1); }
  return n;
}

function dailyBest(h) {
  let best = 0, cur = 0;
  for (const k of dayRange(habitStart(h), todayKey())) { cur = isDone(h, k) ? cur + 1 : 0; best = Math.max(best, cur); }
  return best;
}

const weekCount = (h, ws) => { let n = 0; for (let i = 0; i < 7; i++) if (isDone(h, addDaysKey(ws, i))) n++; return n; };

function weeklyStreak(h) {
  const startW = weekStartKey(habitStart(h));
  let ws = weekStartKey(todayKey()), n = 0;
  if (weekCount(h, ws) >= h.target) n++; // settimana in corso: conta solo se già raggiunta
  ws = addDaysKey(ws, -7);
  while (ws >= startW && weekCount(h, ws) >= h.target) { n++; ws = addDaysKey(ws, -7); }
  return n;
}

function weeklyBest(h) {
  let best = 0, cur = 0;
  for (let ws = weekStartKey(habitStart(h)); ws <= todayKey(); ws = addDaysKey(ws, 7)) {
    cur = weekCount(h, ws) >= h.target ? cur + 1 : 0; best = Math.max(best, cur);
  }
  return best;
}

// abitudini settimanali: % di settimane centrate (ultime N complete + quella in corso se già centrata)
function weeklyRate(h, n = 8) {
  const startW = weekStartKey(habitStart(h));
  const cw = weekStartKey(todayKey());
  let total = 0, met = 0;
  for (let i = 1; i <= n; i++) {
    const ws = addDaysKey(cw, -7 * i);
    if (ws < startW) break;
    total++; if (weekCount(h, ws) >= h.target) met++;
  }
  if (weekCount(h, cw) >= h.target) { total++; met++; }
  return total ? { rate: met / total, total, met } : null;
}

function habitRate(h) {
  return h.freq === 'daily' ? dailyRate(h, 30) : weeklyRate(h, 8);
}

function weekStatus(h, k) {
  const ws = weekStartKey(k);
  const count = weekCount(h, ws);
  const need = h.target - count;
  if (need <= 0) return { count, text: `${count}/${h.target} · settimana centrata ✓`, cls: 'ok' };
  const slots = 7 - wdIndex(keyToDate(k)) - (isDone(h, k) ? 1 : 0);
  if (need > slots) return { count, text: `${count}/${h.target} · settimana mancata`, cls: 'bad' };
  return { count, text: `${count}/${h.target} · ne mancano ${need} in ${7 - wdIndex(keyToDate(k))} gg`, cls: need === slots ? 'warn' : '' };
}

// punteggio del giorno: quota di abitudini quotidiane fatte (null se niente check-in)
function dayScore(k) {
  if (!isLogged(k)) return null;
  const daily = activeHabits().filter(h => h.freq === 'daily' && habitStart(h) <= k);
  if (!daily.length) return activeHabits().some(h => isDone(h, k)) ? 1 : 0;
  return daily.filter(h => isDone(h, k)).length / daily.length;
}

function checkinStreak() {
  let k = todayKey(), n = 0;
  if (!isLogged(k)) k = addDaysKey(k, -1);
  while (isLogged(k)) { n++; k = addDaysKey(k, -1); }
  return n;
}

function avgScore(days) {
  const vals = [];
  for (let i = 0; i < days; i++) { const s = dayScore(addDaysKey(todayKey(), -i)); if (s != null) vals.push(s); }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function perfectDays(days) {
  let n = 0;
  for (let i = 0; i < days; i++) if (dayScore(addDaysKey(todayKey(), -i)) === 1) n++;
  return n;
}

function weekdayStats(h) {
  const res = WD.map(() => ({ logged: 0, done: 0 }));
  for (const k of dayRange(habitStart(h), todayKey())) {
    if (!isLogged(k)) continue;
    const r = res[wdIndex(keyToDate(k))];
    r.logged++; if (isDone(h, k)) r.done++;
  }
  return res.map(r => ({ ...r, rate: r.logged ? r.done / r.logged : null }));
}

function moodSplit(h) {
  const yes = [], no = [];
  for (const [k, e] of state.days) {
    if (e.mood == null || k < habitStart(h)) continue;
    (e.done?.[h.id] ? yes : no).push(e.mood);
  }
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  return yes.length >= 5 && no.length >= 5 ? { yes: avg(yes), no: avg(no) } : null;
}

function insights() {
  const out = [];
  const habits = activeHabits();
  const loggedDays = state.days.size;
  if (loggedDays < 3) return ['Fai qualche check-in serale: dopo una settimana qui compaiono i primi consigli.'];

  const rated = habits.map(h => ({ h, r: habitRate(h) })).filter(x => x.r && (x.h.freq === 'daily' ? x.r.logged >= 7 : x.r.total >= 2));
  if (rated.length >= 2) {
    const sorted = [...rated].sort((a, b) => a.r.rate - b.r.rate);
    const worst = sorted[0], best = sorted.at(-1);
    out.push(`Da migliorare: <b>${esc(worst.h.icon)} ${esc(worst.h.name)}</b>, ${pct(worst.r.rate)} ${worst.h.freq === 'daily' ? 'dei giorni' : 'delle settimane'}. Concentrati su questa prima di aggiungerne altre.`);
    if (best.r.rate >= 0.8) out.push(`Punto di forza: <b>${esc(best.h.icon)} ${esc(best.h.name)}</b> (${pct(best.r.rate)}). Ormai è un'abitudine.`);
  }

  for (const h of habits.filter(h => h.freq === 'daily')) {
    const ws = weekdayStats(h);
    const all = dailyRate(h, 365);
    if (!all || all.logged < 14) continue;
    const cand = ws.map((w, i) => ({ ...w, i })).filter(w => w.logged >= 2 && w.rate != null);
    const worst = cand.sort((a, b) => a.rate - b.rate)[0];
    if (worst && all.rate - worst.rate >= 0.25) {
      out.push(`<b>${esc(h.icon)} ${esc(h.name)}</b> cede soprattutto di <b>${WD_LONG[worst.i]}</b> (${pct(worst.rate)} contro ${pct(all.rate)} di media).`);
    }
  }

  for (const h of habits.filter(h => h.freq === 'daily')) {
    const recent = dailyRateBetween(h, 0, 13), before = dailyRateBetween(h, 14, 27);
    if (recent == null || before == null) continue;
    const diff = recent - before;
    if (diff >= 0.15) out.push(`<b>${esc(h.icon)} ${esc(h.name)}</b> in crescita: ${pct(recent)} nelle ultime 2 settimane (prima ${pct(before)}).`);
    if (diff <= -0.15) out.push(`<b>${esc(h.icon)} ${esc(h.name)}</b> in calo: ${pct(recent)} nelle ultime 2 settimane (prima ${pct(before)}).`);
  }

  for (const h of habits) {
    const m = moodSplit(h);
    if (m && Math.abs(m.yes - m.no) >= 0.5) {
      out.push(m.yes > m.no
        ? `Nei giorni con <b>${esc(h.icon)} ${esc(h.name)}</b> il tuo umore medio è <b>${fmt1(m.yes)}</b> contro ${fmt1(m.no)}.`
        : `Curioso: nei giorni con <b>${esc(h.icon)} ${esc(h.name)}</b> l'umore è più basso (${fmt1(m.yes)} contro ${fmt1(m.no)}).`);
    }
  }

  for (const h of habits.filter(h => h.freq === 'weekly')) {
    const st = weekStatus(h, todayKey());
    if (st.cls === 'warn') out.push(`<b>${esc(h.icon)} ${esc(h.name)}</b>: questa settimana devi farla in tutti i giorni rimasti per centrare l'obiettivo.`);
  }

  let logged14 = 0;
  for (let i = 0; i < 14; i++) if (isLogged(addDaysKey(todayKey(), -i))) logged14++;
  out.push(`Check-in fatti in ${logged14} delle ultime 14 sere.`);
  return out;
}

// ---------- componenti ----------
const kpi = (label, value) => `<div class="kpi"><div class="kpi-v">${value}</div><div class="kpi-l">${label}</div></div>`;

function ringHTML(p, label) {
  const r = 26, c = 2 * Math.PI * r;
  return `<div class="ring-wrap"><svg class="ring" viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="32" r="${r}" class="ring-bg"/>
    <circle cx="32" cy="32" r="${r}" class="ring-fg ${p >= 1 ? 'done' : ''}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.min(1, p))}"/>
  </svg><span>${label}</span></div>`;
}

const scoreClass = s => s == null ? 'l0' : s === 0 ? 'l1' : s < 0.5 ? 'l2' : s < 1 ? 'l3' : 'l4';

function heatmapHTML() {
  const weeks = 16;
  const start = addDaysKey(weekStartKey(todayKey()), -7 * (weeks - 1));
  const t = todayKey();
  let cells = '';
  for (let i = 0; i < weeks * 7; i++) {
    const k = addDaysKey(start, i);
    const s = k > t ? undefined : dayScore(k);
    cells += k > t ? `<div class="hm lx"></div>` : `<button class="hm ${scoreClass(s)}" data-day="${k}" title="${k}${s != null ? ': ' + pct(s) : ''}"></button>`;
  }
  return `<div class="heatmap">${cells}</div>
    <div class="hm-legend">nessun check-in <span class="hm l0"></span> &nbsp; 0% <span class="hm l1"></span><span class="hm l2"></span><span class="hm l3"></span><span class="hm l4"></span> 100%</div>`;
}

function habitCardHTML(h) {
  const r = habitRate(h);
  const t = todayKey();
  let body = '';
  if (h.freq === 'daily') {
    const recent = dailyRateBetween(h, 0, 13), before = dailyRateBetween(h, 14, 27);
    const trend = recent != null && before != null ? (recent - before >= 0.1 ? '<span class="up">▲</span>' : before - recent >= 0.1 ? '<span class="down">▼</span>' : '') : '';
    let dots = '';
    for (let i = 27; i >= 0; i--) {
      const k = addDaysKey(t, -i);
      const cls = k < habitStart(h) ? 'pre' : !isLogged(k) ? 'none' : isDone(h, k) ? 'yes' : 'no';
      dots += `<span class="dot ${cls}"></span>`;
    }
    const wd = weekdayStats(h);
    body = `
      <div class="hc-stats"><b>${r ? pct(r.rate) : '–'}</b> ${trend}<span class="muted small">ultimi 30 gg</span>
        <span class="hc-streak">🔥 ${dailyStreak(h)} gg · record ${dailyBest(h)}</span></div>
      <div class="dots">${dots}</div>
      <div class="muted tiny">ultimi 28 giorni</div>
      <div class="wd">${wd.map((w, i) => `<div class="wd-c"><span class="wd-b" style="--a:${w.rate ?? 0}"></span><small>${WD[i]}</small></div>`).join('')}</div>
      <div class="muted tiny">percentuale per giorno della settimana</div>`;
  } else {
    const cw = weekStartKey(t);
    const weeks = [...Array(8)].map((_, i) => { const ws = addDaysKey(cw, -7 * (7 - i)); return { ws, n: weekCount(h, ws), pre: addDaysKey(ws, 6) < habitStart(h) }; });
    const wd = WD.map(() => 0);
    for (const k of dayRange(habitStart(h), t)) if (isDone(h, k)) wd[wdIndex(keyToDate(k))]++;
    const maxWd = Math.max(1, ...wd);
    body = `
      <div class="hc-stats"><b>${r ? pct(r.rate) : '–'}</b><span class="muted small">settimane centrate</span>
        <span class="hc-streak">🔥 ${weeklyStreak(h)} sett. · record ${weeklyBest(h)}</span></div>
      <div class="wbars">${weeks.map((w, i) => `
        <div class="wbar"><div class="wbar-track"><div class="tgt" style="bottom:${h.target / 7 * 100}%"></div>
          <div class="wbar-fill ${w.n >= h.target ? 'ok' : ''} ${i === 7 ? 'cur' : ''} ${w.pre ? 'pre' : ''}" style="height:${w.n / 7 * 100}%"></div></div>
          <small>${keyToDate(w.ws).getDate()}/${keyToDate(w.ws).getMonth() + 1}</small></div>`).join('')}</div>
      <div class="muted tiny">volte a settimana, ultime 8 (linea = obiettivo ${h.target})</div>
      <div class="wd">${wd.map((n, i) => `<div class="wd-c"><span class="wd-b" style="--a:${n / maxWd}"></span><small>${WD[i]}</small></div>`).join('')}</div>
      <div class="muted tiny">in che giorni la fai di solito</div>`;
  }
  return `<div class="card habit-card">
    <div class="hc-head"><span class="hc-icon">${esc(h.icon)}</span><b>${esc(h.name)}</b>
      <span class="muted small">${h.freq === 'daily' ? 'ogni giorno' : `${h.target}× settimana`}</span></div>
    ${body}</div>`;
}

// ---------- toast ----------
let toastTimer;
function toast(html) {
  const el = $('#toast');
  el.innerHTML = html;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ---------- render ----------
function renderCheckin() {
  const k = state.current;
  const t = todayKey();
  const d = keyToDate(k);
  $('#day-label').textContent = k === t ? 'Oggi' : k === addDaysKey(t, -1) ? 'Ieri' : d.toLocaleDateString('it-IT', { weekday: 'long' });
  $('#day-sub').textContent = d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#day-next').disabled = k >= t;

  const ws = weekStartKey(k);
  $('#weekstrip').innerHTML = WD.map((w, i) => {
    const dk = addDaysKey(ws, i);
    const s = dk > t ? undefined : dayScore(dk);
    return `<button class="ws-day ${dk === k ? 'sel' : ''} ${dk > t ? 'future' : ''}" data-day="${dk}" ${dk > t ? 'disabled' : ''}>
      <small>${w}</small><span class="ws-dot ${scoreClass(s)}">${keyToDate(dk).getDate()}</span></button>`;
  }).join('');

  const habits = activeHabits();
  const daily = habits.filter(h => h.freq === 'daily');
  const dailyDone = daily.filter(h => isDone(h, k)).length;
  const entry = state.days.get(k);
  const p = daily.length ? dailyDone / daily.length : 0;
  let msg;
  if (!habits.length) msg = 'Aggiungi la prima abitudine da Impostazioni.';
  else if (daily.length && dailyDone === daily.length) msg = '<b>Giornata perfetta.</b> Tutte le quotidiane fatte ✨';
  else if (!entry) msg = 'Spunta quello che hai fatto: si salva da solo.';
  else msg = `${dailyDone} di ${daily.length} abitudini quotidiane.`;
  $('#score-card').innerHTML = `${ringHTML(p, `${dailyDone}<small>/${daily.length}</small>`)}
    <div><p>${msg}</p><p class="muted small">Check-in di fila: <b>${checkinStreak()}</b> sere</p></div>`;

  $('#habit-list').innerHTML = habits.map(h => {
    const done = isDone(h, k);
    let sub;
    if (h.freq === 'daily') {
      const s = dailyStreak(h);
      sub = `<span>ogni giorno${s ? ` · 🔥 ${s}` : ''}</span>`;
    } else {
      const st = weekStatus(h, k);
      const pips = [...Array(h.target)].map((_, i) => `<i class="${i < st.count ? 'on' : ''}"></i>`).join('');
      sub = `<span class="pips">${pips}</span><span class="${st.cls}">${st.text}</span>`;
    }
    return `<button class="habit ${done ? 'done' : ''}" data-id="${esc(h.id)}" aria-pressed="${done}">
      <span class="h-icon">${esc(h.icon)}</span>
      <span class="h-main"><b>${esc(h.name)}</b><span class="h-sub">${sub}</span></span>
      <span class="check">${done ? '✓' : ''}</span>
    </button>`;
  }).join('') || '';

  $('#moods').innerHTML = MOODS.map((m, i) => `<button class="mood ${entry?.mood === i + 1 ? 'sel' : ''}" data-mood="${i + 1}" aria-label="Umore ${i + 1}">${m}</button>`).join('');
  const note = $('#day-note');
  if (document.activeElement !== note) note.value = entry?.note || '';

  $('#save-status').innerHTML = entry
    ? `Check-in salvato alle ${new Date(entry.savedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} ✓`
    : `<button class="btn" id="btn-confirm" type="button">Non ho fatto niente di questo: registra la giornata</button>`;
}

function renderStats() {
  const el = $('#stats');
  const habits = activeHabits();
  if (!habits.length) { el.innerHTML = `<div class="card empty">Nessuna abitudine attiva.</div>`; return; }
  const a7 = avgScore(7);
  el.innerHTML = `
    <div class="kpis">
      ${kpi('Check-in di fila', `${checkinStreak()}`)}
      ${kpi('Ultimi 7 gg', a7 == null ? '–' : pct(a7))}
      ${kpi('Giornate perfette', `${perfectDays(30)}<small>/30</small>`)}
    </div>
    <div class="card"><h2>Cosa puoi migliorare</h2><ul class="insights">${insights().map(i => `<li>${i}</li>`).join('')}</ul></div>
    <div class="card"><h2>Costanza · 16 settimane</h2>${heatmapHTML()}
      <p class="muted tiny">Colore = quota di abitudini quotidiane fatte. Tocca un giorno per aprirlo.</p></div>
    ${habits.map(habitCardHTML).join('')}`;
}

function renderSettings() {
  const habits = [...state.habits].sort((a, b) => a.order - b.order);
  const row = (h, i, list) => `
    <div class="admin-row ${h.archived ? 'archived' : ''}">
      <span class="h-icon">${esc(h.icon)}</span>
      <span class="grow"><b>${esc(h.name)}</b><br><span class="muted small">${h.freq === 'daily' ? 'ogni giorno' : `${h.target}× settimana`}${h.archived ? ' · archiviata' : ''}</span></span>
      ${h.archived ? '' : `<button class="icon-btn" data-move="-1" data-id="${esc(h.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Su">↑</button>
      <button class="icon-btn" data-move="1" data-id="${esc(h.id)}" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Giù">↓</button>`}
      <button class="icon-btn" data-edit="${esc(h.id)}" aria-label="Modifica">✎</button>
    </div>`;
  const act = habits.filter(h => !h.archived), arch = habits.filter(h => h.archived);
  $('#habit-admin').innerHTML = act.map(row).join('') + (arch.length ? `<p class="muted small" style="margin:14px 0 4px">Archiviate</p>${arch.map(row).join('')}` : '');

  $('#backup-info').textContent = state.lastExport
    ? `Ultimo backup: ${fmtDate(new Date(state.lastExport))}. I dati vivono solo su questo dispositivo.`
    : 'Nessun backup ancora. I dati vivono solo su questo dispositivo: esportali ogni tanto in File o iCloud Drive.';
  const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  $('#btn-badge').textContent = granted ? 'Badge attivo ✓' : "Attiva badge sull'icona";
  $('#btn-badge').disabled = granted;
  $('#version').textContent = `Habit Tracker v${APP_VERSION} · ${state.days.size} check-in`;
}

function updateBadge() {
  try {
    if (!('setAppBadge' in navigator) || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!isLogged(todayKey()) && new Date().getHours() >= 20) navigator.setAppBadge(1); else navigator.clearAppBadge();
  } catch { /* non supportato */ }
}

function renderAll() { renderCheckin(); renderStats(); renderSettings(); updateBadge(); }

// ---------- azioni check-in ----------
async function toggleHabit(id) {
  const h = state.habits.find(x => x.id === id);
  const k = state.current;
  const daily = activeHabits().filter(x => x.freq === 'daily');
  const wasPerfect = daily.length && daily.every(x => isDone(x, k));
  const wasWeek = h.freq === 'weekly' ? weekCount(h, weekStartKey(k)) : 0;

  const entry = getOrCreateDay(k);
  entry.done = { ...entry.done };
  if (entry.done[id]) delete entry.done[id]; else entry.done[id] = true;
  await saveDay(entry);
  renderAll();

  const nowDone = !!entry.done[id];
  if (!nowDone) return;
  if (h.freq === 'weekly' && wasWeek < h.target && weekCount(h, weekStartKey(k)) >= h.target) {
    toast(`${esc(h.icon)} <b>Obiettivo settimanale centrato!</b><br>${h.target}/${h.target} questa settimana.`);
  } else if (!wasPerfect && daily.length && daily.every(x => isDone(x, k))) {
    toast('✨ <b>Giornata perfetta</b><br>Tutte le abitudini quotidiane fatte.');
  } else if (h.freq === 'daily') {
    const s = dailyStreak(h);
    if ([3, 7, 14, 21, 30, 50, 100, 200, 365].includes(s)) toast(`🔥 <b>${esc(h.name)}: ${s} giorni di fila</b>`);
  }
}

async function setMood(m) {
  const entry = getOrCreateDay(state.current);
  entry.mood = entry.mood === m ? null : m;
  await saveDay(entry);
  renderAll();
}

function noteChanged() {
  clearTimeout(noteTimer);
  const k = state.current;
  const value = $('#day-note').value;
  noteTimer = setTimeout(async () => {
    const entry = getOrCreateDay(k);
    entry.note = value.trim();
    await saveDay(entry);
    renderAll();
  }, 600);
}

function goToDay(k) {
  if (k > todayKey()) return;
  clearTimeout(noteTimer);
  state.current = k;
  renderCheckin();
}

// ---------- gestione abitudini ----------
function openHabitDialog(h) {
  editingHabitId = h?.id || null;
  const f = $('#habit-form');
  $('#habit-title').textContent = h ? 'Modifica abitudine' : 'Nuova abitudine';
  f.icon.value = h?.icon || '⭐';
  f.name.value = h?.name || '';
  f.freq.value = h?.freq || 'daily';
  f.target.value = h?.freq === 'weekly' ? h.target : 3;
  $('#target-wrap').hidden = f.freq.value !== 'weekly';
  $('#h-delete').hidden = !h;
  $('#h-archive').hidden = !h;
  $('#h-archive').textContent = h?.archived ? 'Ripristina' : 'Archivia';
  $('#habit-dialog').showModal();
}

async function submitHabit(e) {
  e.preventDefault();
  const f = e.target;
  const freq = f.freq.value;
  const target = freq === 'weekly' ? Math.min(7, Math.max(1, parseInt(f.target.value, 10) || 3)) : 7;
  const existing = state.habits.find(h => h.id === editingHabitId);
  const h = existing
    ? { ...existing, icon: f.icon.value.trim() || '⭐', name: f.name.value.trim(), freq, target }
    : { id: uid(), icon: f.icon.value.trim() || '⭐', name: f.name.value.trim(), freq, target,
        order: Math.max(-1, ...state.habits.map(x => x.order)) + 1, archived: false, createdAt: todayKey() };
  if (!h.name) return;
  await db.put('habits', h);
  state.habits = state.habits.filter(x => x.id !== h.id).concat(h);
  $('#habit-dialog').close();
  renderAll();
}

async function moveHabit(id, dir) {
  const list = activeHabits();
  const i = list.findIndex(h => h.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((h, n) => { h.order = n; });
  await db.putMany('habits', list);
  renderAll();
}

async function archiveHabit() {
  const h = state.habits.find(x => x.id === editingHabitId);
  if (!h) return;
  h.archived = !h.archived;
  await db.put('habits', h);
  $('#habit-dialog').close();
  renderAll();
}

async function deleteHabit() {
  const h = state.habits.find(x => x.id === editingHabitId);
  if (!h || !confirm(`Eliminare "${h.name}"? Lo storico delle spunte resta nel backup ma sparisce dalle statistiche.\nSe vuoi solo metterla in pausa, usa Archivia.`)) return;
  await db.del('habits', h.id);
  state.habits = state.habits.filter(x => x.id !== h.id);
  $('#habit-dialog').close();
  renderAll();
}

// ---------- badge ----------
async function enableBadge() {
  if (typeof Notification === 'undefined' || !('setAppBadge' in navigator)) {
    alert("Il badge funziona solo con l'app installata sulla schermata Home (iOS 16.4+). Aprila dall'icona e riprova.");
    return;
  }
  const p = await Notification.requestPermission();
  if (p === 'granted') { renderAll(); toast('🔴 Badge attivo dalle 20:00 se manca il check-in.'); }
  else alert('Permesso negato. Puoi riattivarlo da Impostazioni iOS → Notifiche.');
}

// ---------- backup ----------
async function exportData() {
  const data = {
    app: 'habit-tracker', version: 1, exportedAt: new Date().toISOString(),
    habits: state.habits, days: [...state.days.values()],
  };
  const name = `habit-tracker-${todayKey()}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  let done = false;
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); done = true; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  if (!done) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  state.lastExport = Date.now();
  await db.setSetting('lastExport', state.lastExport);
  renderAll();
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'habit-tracker' || !Array.isArray(data.habits) || !Array.isArray(data.days)) throw new Error('Formato non riconosciuto');
    if (!confirm(`Importare ${data.habits.length} abitudini e ${data.days.length} check-in?\nLe voci con lo stesso id/data verranno sovrascritte.`)) return;
    await db.putMany('habits', data.habits);
    await db.putMany('days', data.days);
    await load();
    renderAll();
    alert('Import completato.');
  } catch (err) {
    alert('Import fallito: ' + err.message);
  }
}

async function wipe() {
  if (!confirm('Cancellare TUTTI i check-in? Le abitudini restano.')) return;
  if (!confirm('Sicuro? Senza backup non si torna indietro.')) return;
  await db.clear('days');
  await load();
  renderAll();
}

// ---------- navigazione ----------
function switchView(v) {
  $$('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('#title').textContent = TITLES[v];
  window.scrollTo(0, 0);
}

// ---------- init ----------
async function init() {
  await load();
  state.current = defaultDay();
  renderAll();

  $$('.tabs button').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('#day-prev').addEventListener('click', () => goToDay(addDaysKey(state.current, -1)));
  $('#day-next').addEventListener('click', () => goToDay(addDaysKey(state.current, 1)));
  $('#weekstrip').addEventListener('click', e => { const b = e.target.closest('[data-day]'); if (b) goToDay(b.dataset.day); });
  $('#habit-list').addEventListener('click', e => { const b = e.target.closest('.habit'); if (b) toggleHabit(b.dataset.id); });
  $('#moods').addEventListener('click', e => { const b = e.target.closest('[data-mood]'); if (b) setMood(+b.dataset.mood); });
  $('#day-note').addEventListener('input', noteChanged);
  $('#save-status').addEventListener('click', async e => {
    if (e.target.id === 'btn-confirm') { await saveDay(getOrCreateDay(state.current)); renderAll(); }
  });
  $('#stats').addEventListener('click', e => {
    const b = e.target.closest('[data-day]');
    if (b) { goToDay(b.dataset.day); switchView('checkin'); }
  });

  $('#btn-add-habit').addEventListener('click', () => openHabitDialog(null));
  $('#habit-admin').addEventListener('click', e => {
    const ed = e.target.closest('[data-edit]');
    if (ed) openHabitDialog(state.habits.find(h => h.id === ed.dataset.edit));
    const mv = e.target.closest('[data-move]');
    if (mv) moveHabit(mv.dataset.id, +mv.dataset.move);
  });
  $('#habit-form').addEventListener('submit', submitHabit);
  $('#habit-form').addEventListener('change', e => { if (e.target.name === 'freq') $('#target-wrap').hidden = e.target.value !== 'weekly'; });
  $('#h-cancel').addEventListener('click', () => $('#habit-dialog').close());
  $('#h-archive').addEventListener('click', archiveHabit);
  $('#h-delete').addEventListener('click', deleteHabit);

  $('#btn-badge').addEventListener('click', enableBadge);
  $('#btn-export').addEventListener('click', exportData);
  $('#import-file').addEventListener('change', e => { const f = e.target.files[0]; if (f) importData(f); e.target.value = ''; });
  $('#btn-wipe').addEventListener('click', wipe);

  // se l'app resta aperta oltre mezzanotte o torna in primo piano il giorno dopo
  let lastToday = todayKey();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (todayKey() !== lastToday) { lastToday = todayKey(); state.current = defaultDay(); }
    renderAll();
  });

  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
