import { db } from './db.js';

const APP_VERSION = '1.2.0';
const DAY = 86400000;
const WD = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];
const WD_LONG = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
const MOODS = ['😣', '😕', '😐', '🙂', '😄'];
const TITLES = { checkin: 'Stasera', stats: 'Progressi', settings: 'Impostazioni' };

const state = { habits: [], days: new Map(), lastExport: null, current: null };
let editingHabitId = null;
let editingFields = [];
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
// un giorno importato (partial) contiene dati ma non è un vero check-in serale: non penalizza le altre abitudini
const isLogged = k => { const e = state.days.get(k); return !!e && !e.partial; };

// inizio statistiche: la data di creazione, o il primo giorno in cui l'hai spuntata se precedente
function habitStart(h) {
  let s = h.createdAt;
  for (const [k, e] of state.days) if (e.done?.[h.id] && k < s) s = k;
  return s;
}

async function saveDay(entry) {
  entry.savedAt = Date.now();
  delete entry.partial; // toccato dall'app = check-in vero
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

// ---------- campi personalizzati ----------
const FIELD_TYPES = { number: 'Numero', wdl: 'Esito V/P/S', text: 'Testo', bool: 'Sì / No', tournament: 'Torneo' };

// torneo: { on, result: 'w' | 'l' | null }. Un vecchio valore booleano vale "torneo senza esito".
function tourOf(v) {
  if (v === true) return { on: true, result: null };
  if (v && typeof v === 'object') return { on: !!v.on, result: v.result === 'w' || v.result === 'l' ? v.result : null };
  return { on: false, result: null };
}
const fieldsOf = h => h.fields || [];
const fieldVal = (k, h, f) => state.days.get(k)?.data?.[h.id]?.[f.id];

// valori di testo già usati (per l'autocompletamento)
function pastValues(h, f) {
  const set = new Set();
  for (const e of state.days.values()) { const v = e.data?.[h.id]?.[f.id]; if (typeof v === 'string' && v.trim()) set.add(v.trim()); }
  return [...set].sort((a, b) => a.localeCompare(b));
}

const stepper = (hid, fid, part, v) =>
  `<span class="stepper"><button type="button" data-hid="${esc(hid)}" data-fid="${esc(fid)}" ${part ? `data-part="${part}"` : ''} data-step="-1" aria-label="meno">−</button><b>${v || 0}</b><button type="button" data-hid="${esc(hid)}" data-fid="${esc(fid)}" ${part ? `data-part="${part}"` : ''} data-step="1" aria-label="più">+</button></span>`;

function fieldsFormHTML(h, k) {
  return `<div class="fields">${fieldsOf(h).map(f => {
    const v = fieldVal(k, h, f);
    let ctrl;
    if (f.type === 'number') ctrl = stepper(h.id, f.id, null, v);
    else if (f.type === 'wdl') {
      const x = v || {};
      ctrl = `<span class="wdl">${[['w', 'V'], ['d', 'P'], ['l', 'S']].map(([p, l]) => `<span class="wdl-p"><small>${l}</small>${stepper(h.id, f.id, p, x[p])}</span>`).join('')}</span>`;
    } else if (f.type === 'tournament') {
      const t = tourOf(v);
      ctrl = `<span class="tour"><button type="button" class="tog ${t.on ? 'on' : ''}" data-hid="${esc(h.id)}" data-fid="${esc(f.id)}" data-tour="toggle">${t.on ? 'Sì' : 'No'}</button>${t.on ? `
        <span class="seg-mini">${[['w', 'Vinto'], ['l', 'Perso']].map(([r, l]) => `<button type="button" class="${t.result === r ? 'sel ' + r : ''}" data-hid="${esc(h.id)}" data-fid="${esc(f.id)}" data-tour="${r}">${l}</button>`).join('')}</span>` : ''}</span>`;
    } else if (f.type === 'bool') ctrl = `<button type="button" class="tog ${v ? 'on' : ''}" data-hid="${esc(h.id)}" data-fid="${esc(f.id)}" data-bool="1">${v ? 'Sì' : 'No'}</button>`;
    else {
      const dl = `dl-${esc(h.id)}-${esc(f.id)}`;
      ctrl = `<input class="fld-text" list="${dl}" data-hid="${esc(h.id)}" data-fid="${esc(f.id)}" value="${esc(v || '')}" placeholder="…"><datalist id="${dl}">${pastValues(h, f).map(o => `<option value="${esc(o)}">`).join('')}</datalist>`;
    }
    return `<div class="fld ${f.type}"><span class="fld-l">${esc(f.label)}</span>${ctrl}</div>`;
  }).join('')}</div>`;
}

async function updateField(hid, fid, fn) {
  const entry = getOrCreateDay(state.current);
  entry.data = { ...(entry.data || {}) };
  entry.data[hid] = { ...(entry.data[hid] || {}) };
  entry.data[hid][fid] = fn(entry.data[hid][fid]);
  await saveDay(entry);
  renderAll();
}

// statistiche dei campi: totali, medie, grafici, raggruppamenti per testo/sì-no e per mese.
// Se c'è un campo Torneo, una giornata di torneo conta come UNA partita nel record (vinto = V, perso = S);
// le singole partite del torneo restano nelle statistiche "partite giocate" e nella sezione Tornei.
function fieldStatsHTML(h) {
  const fields = fieldsOf(h);
  if (!fields.length) return '';
  const rows = [...state.days.values()].filter(e => e.done?.[h.id]).sort((a, b) => a.date.localeCompare(b.date))
    .map(e => ({ k: e.date, v: e.data?.[h.id] || {} }));
  if (!rows.length) return '';
  const wdl = fields.find(f => f.type === 'wdl');
  const tourF = fields.find(f => f.type === 'tournament');
  const nums = fields.filter(f => f.type === 'number');
  const groups = fields.filter(f => f.type === 'text' || f.type === 'bool');
  const isTour = r => !!tourF && tourOf(r.v[tourF.id]).on;

  const agg = list => {
    const a = { n: list.length, w: 0, d: 0, l: 0, played: 0, unk: 0, sums: {} };
    nums.forEach(f => { a.sums[f.id] = 0; });
    for (const r of list) {
      const x = wdl ? r.v[wdl.id] || {} : {};
      const pw = +x.w || 0, pd = +x.d || 0, pl = +x.l || 0;
      a.played += pw + pd + pl;
      if (isTour(r)) {
        const res = tourOf(r.v[tourF.id]).result;
        if (res === 'w') a.w++; else if (res === 'l') a.l++; else a.unk++;
      } else { a.w += pw; a.d += pd; a.l += pl; }
      nums.forEach(f => { a.sums[f.id] += +r.v[f.id] || 0; });
    }
    a.games = a.w + a.d + a.l;
    return a;
  };
  const all = agg(rows);
  const hasRecord = !!(wdl || tourF);
  const per = all.played || all.n;
  const perLbl = all.played ? 'a partita' : 'a sessione';
  const winPct = a => a.games ? pct(a.w / a.games) : '–';

  const tiles = [
    kpi('Sessioni', all.n),
    ...(wdl ? [kpi('Partite giocate', all.played)] : []),
    ...(hasRecord ? [kpi('Vittorie', `${winPct(all)}<small class="sub">${all.w}V ${all.d}P ${all.l}S</small>`)] : []),
    ...nums.map(f => kpi(esc(f.label), `${all.sums[f.id]}<small class="sub">${fmt2(all.sums[f.id] / per)} ${perLbl}</small>`)),
  ];

  const head = `<tr><th></th><th>Sess.</th>${hasRecord ? '<th>V-P-S</th><th>%V</th>' : ''}${nums.map(f => `<th>${esc(f.label)}</th>`).join('')}</tr>`;
  const line = (label, a) => `<tr><td>${label}</td><td>${a.n}</td>${hasRecord ? `<td>${a.w}-${a.d}-${a.l}</td><td>${winPct(a)}</td>` : ''}${nums.map(f => `<td>${a.sums[f.id]}</td>`).join('')}</tr>`;
  const table = (title, map) => `<h3>${title}</h3><div class="tbl-wrap"><table class="tbl">${head}${[...map.entries()].map(([lab, list]) => line(lab, agg(list))).join('')}</table></div>`;
  const groupBy = g => {
    const m = new Map();
    for (const r of rows) {
      const raw = r.v[g.id];
      const key = g.type === 'bool' ? (raw ? 'Sì' : 'No') : (String(raw || '').trim() || '—');
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(r);
    }
    return new Map([...m.entries()].sort((a, b) => b[1].length - a[1].length));
  };
  const groupTables = groups.map(g => table(`Per ${esc(g.label.toLowerCase())}`,
    new Map([...groupBy(g).entries()].map(([key, list]) => [esc(key), list])))).join('');

  const monthKeys = [];
  for (let mk = rows[0].k.slice(0, 7); mk <= rows.at(-1).k.slice(0, 7);) {
    monthKeys.push(mk);
    const d = keyToDate(mk + '-01'); d.setMonth(d.getMonth() + 1); mk = dayKey(d).slice(0, 7);
  }
  const byMonth = new Map(monthKeys.map(mk => [mk, rows.filter(r => r.k.startsWith(mk))]));
  const monthLbl = (mk, opts) => keyToDate(mk + '-01').toLocaleDateString('it-IT', opts);
  const monthTable = table('Per mese', new Map([...byMonth.entries()].filter(([, l]) => l.length).reverse()
    .map(([mk, l]) => [monthLbl(mk, { month: 'short', year: '2-digit' }), l])));

  // ---- grafici ----
  const charts = [];
  if (hasRecord) {
    const ms = monthKeys.slice(-12).map(mk => ({ mk, a: agg(byMonth.get(mk)) }));
    charts.push(`<h3>Risultati per mese</h3>${resultsChartSVG(ms, monthLbl)}
      <div class="legend"><span><i class="sw win"></i>Vittorie</span><span><i class="sw draw"></i>Pareggi</span><span><i class="sw loss"></i>Sconfitte</span></div>`);
  }
  const cumFields = nums.slice(0, 2).filter(f => all.sums[f.id] > 0);
  if (cumFields.length && rows.length >= 3) {
    charts.push(`<h3>${cumFields.map(f => esc(f.label)).join(' e ')} nel tempo (cumulati)</h3>${cumulativeSVG(rows, cumFields)}
      <div class="legend">${cumFields.map((f, i) => `<span><i class="sw s${i + 1}"></i>${esc(f.label)}</span>`).join('')}</div>`);
  }
  const textF = groups.find(g => g.type === 'text');
  if (hasRecord && textF) {
    const bars = [...groupBy(textF).entries()].map(([key, list]) => ({ key, a: agg(list) }))
      .filter(x => x.a.games >= 2).sort((a, b) => b.a.w / b.a.games - a.a.w / a.a.games);
    if (bars.length >= 2) charts.push(`<h3>% vittorie per ${esc(textF.label.toLowerCase())}</h3>
      <div class="hbars">${bars.map(x => `<button class="hbar" data-tip="${esc(x.key)}: ${x.a.w}V ${x.a.d}P ${x.a.l}S su ${x.a.games} (${x.a.n} sessioni)">
        <span class="hb-l">${esc(x.key)}</span><span class="hb-t"><span class="hb-f" style="width:${x.a.w / x.a.games * 100}%"></span></span>
        <span class="hb-v">${pct(x.a.w / x.a.games)}<small> · ${x.a.games}</small></span></button>`).join('')}</div>`);
  }
  const chartsHTML = charts.length ? `<div class="charts">${charts.join('')}<p class="chart-tip muted small">Tocca una barra o un punto per i dettagli.</p></div>` : '';

  // ---- tornei ----
  let tourHTML = '';
  const tours = rows.filter(isTour);
  if (tours.length) {
    const ta = agg(tours);
    const inner = tours.reduce((a, r) => { const x = r.v[wdl?.id] || {}; a.w += +x.w || 0; a.d += +x.d || 0; a.l += +x.l || 0; return a; }, { w: 0, d: 0, l: 0 });
    const lab = textF ? r => esc(r.v[textF.id] || '—') : () => '';
    tourHTML = `<h3>Tornei</h3>
      <p class="small"><b>${tours.length}</b> tornei · <b>${ta.w}</b> vinti · <b>${ta.l}</b> persi${ta.unk ? ` · <span class="warn-t">${ta.unk} senza esito</span>` : ''}${wdl ? ` · partite al loro interno ${inner.w}V ${inner.d}P ${inner.l}S` : ''}</p>
      <div class="tbl-wrap"><table class="tbl"><tr><th>Data</th>${textF ? `<th>${esc(textF.label)}</th>` : ''}<th>Esito</th>${wdl ? '<th>Partite</th>' : ''}${nums.slice(0, 2).map(f => `<th>${esc(f.label)}</th>`).join('')}</tr>
      ${[...tours].reverse().map(r => { const t = tourOf(r.v[tourF.id]); const x = r.v[wdl?.id] || {};
        return `<tr><td>${keyToDate(r.k).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</td>${textF ? `<td>${lab(r)}</td>` : ''}
          <td>${t.result === 'w' ? '🏆 Vinto' : t.result === 'l' ? 'Perso' : '<span class="warn-t">?</span>'}</td>
          ${wdl ? `<td>${+x.w || 0}-${+x.d || 0}-${+x.l || 0}</td>` : ''}${nums.slice(0, 2).map(f => `<td>${+r.v[f.id] || 0}</td>`).join('')}</tr>`; }).join('')}
      </table></div>`;
  }

  return `<div class="fstats"><div class="kpis inner">${tiles.join('')}</div>
    ${tourF ? `<p class="muted small">Nel record ogni torneo conta come una partita: vinto = V, perso = S.${all.unk ? ` ${all.unk} tornei senza esito non sono contati: aprili dal check-in di quel giorno e scegli Vinto o Perso.` : ''}</p>` : ''}
    ${chartsHTML}${groupTables}${tourHTML}${monthTable}</div>`;
}

// barre impilate V/P/S per mese
function resultsChartSVG(ms, monthLbl) {
  const W = 340, H = 150, L = 24, B = 20, T = 8;
  const max = Math.max(1, ...ms.map(m => m.a.games));
  const step = (W - L) / ms.length, bw = Math.min(22, step * 0.62);
  const y = v => T + (H - T - B) * (1 - v / max);
  const ticks = [...new Set([0, Math.ceil(max / 2), max])];
  let out = ticks.map(t => `<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 3}" class="ax" text-anchor="end">${t}</text>`).join('');
  ms.forEach((m, i) => {
    const x = L + step * i + (step - bw) / 2;
    let base = 0;
    const segs = [['w', 'win'], ['d', 'draw'], ['l', 'loss']].filter(([p]) => m.a[p] > 0);
    segs.forEach(([p, cls], j) => {
      const y1 = y(base + m.a[p]), y0 = y(base);
      const top = j === segs.length - 1;
      const hgt = Math.max(1, y0 - y1 - (j > 0 ? 2 : 0));
      out += top
        ? `<path d="${roundTop(x, y1, bw, hgt, 4)}" class="${cls}"/>`
        : `<rect x="${x}" y="${y1}" width="${bw}" height="${hgt}" class="${cls}"/>`;
      base += m.a[p];
    });
    const lbl = monthLbl(m.mk, { month: 'narrow' });
    out += `<text x="${x + bw / 2}" y="${H - 6}" class="ax" text-anchor="middle">${lbl}</text>`;
    out += `<rect x="${L + step * i}" y="${T}" width="${step}" height="${H - T - B}" class="hit" data-tip="${monthLbl(m.mk, { month: 'long', year: 'numeric' })}: ${m.a.w}V ${m.a.d}P ${m.a.l}S${m.a.n ? ` in ${m.a.n} sessioni` : ' (nessuna partita)'}"/>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Risultati per mese">${out}</svg>`;
}

function roundTop(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// linee cumulative (max 2 serie) su asse temporale
function cumulativeSVG(rows, fields) {
  const W = 340, H = 160, L = 24, R = 44, B = 20, T = 10;
  const t0 = keyToDate(rows[0].k).getTime(), t1 = Math.max(t0 + DAY, keyToDate(rows.at(-1).k).getTime());
  const series = fields.map(f => { let c = 0; return rows.map(r => ({ k: r.k, t: keyToDate(r.k).getTime(), v: (c += +r.v[f.id] || 0) })); });
  const max = Math.max(1, ...series.map(s => s.at(-1).v));
  const x = t => L + (W - L - R) * (t - t0) / (t1 - t0);
  const y = v => T + (H - T - B) * (1 - v / max);
  const ticks = [...new Set([0, Math.round(max / 2), max])];
  let out = ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 3}" class="ax" text-anchor="end">${t}</text>`).join('');
  const d0 = keyToDate(rows[0].k), d1 = keyToDate(rows.at(-1).k);
  const fmtD = d => d.toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });
  out += `<text x="${L}" y="${H - 6}" class="ax">${fmtD(d0)}</text><text x="${W - R}" y="${H - 6}" class="ax" text-anchor="end">${fmtD(d1)}</text>`;
  const ends = [];
  series.forEach((s, i) => {
    const pts = [`${x(s[0].t)},${y(0)}`];
    s.forEach((p, j) => { if (j) pts.push(`${x(p.t)},${y(s[j - 1].v)}`); pts.push(`${x(p.t)},${y(p.v)}`); });
    out += `<polyline points="${pts.join(' ')}" class="ln s${i + 1}"/>`;
    ends.push({ i, v: s.at(-1).v, yy: y(s.at(-1).v) });
  });
  // etichette finali senza sovrapposizioni
  ends.sort((a, b) => a.yy - b.yy);
  for (let j = 1; j < ends.length; j++) if (ends[j].yy - ends[j - 1].yy < 12) ends[j].yy = ends[j - 1].yy + 12;
  ends.forEach(e => { out += `<text x="${W - R + 6}" y="${e.yy + 4}" class="end s${e.i + 1}t">${e.v} ${esc(fields[e.i].label.toLowerCase())}</text>`; });
  // punti toccabili: uno per sessione con valori
  rows.forEach((r, j) => {
    const vals = fields.map((f, i) => ({ f, add: +r.v[f.id] || 0, tot: series[i][j].v }));
    if (!vals.some(v => v.add)) return;
    const tip = `${keyToDate(r.k).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })}: ${vals.map(v => `+${v.add} ${esc(v.f.label.toLowerCase())} (tot. ${v.tot})`).join(', ')}`;
    vals.forEach((v, i) => { if (v.add) out += `<circle cx="${x(series[i][j].t)}" cy="${y(v.tot)}" r="2.5" class="pt s${i + 1}"/>`; });
    out += `<circle cx="${x(series[0][j].t)}" cy="${y(Math.max(...vals.map(v => v.tot)))}" r="9" class="hit" data-tip="${tip}"/>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Valori cumulati nel tempo">${out}</svg>`;
}

const fmt2 = x => (Math.round(x * 100) / 100).toFixed(2).replace('.', ',');

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
    ${body}${fieldStatsHTML(h)}</div>`;
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
    </button>${done && fieldsOf(h).length ? fieldsFormHTML(h, k) : ''}`;
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
  editingFields = fieldsOf(h || {}).map(x => ({ ...x }));
  renderFieldEditor();
  $('#h-delete').hidden = !h;
  $('#h-archive').hidden = !h;
  $('#h-archive').textContent = h?.archived ? 'Ripristina' : 'Archivia';
  $('#habit-dialog').showModal();
}

function renderFieldEditor() {
  $('#field-list').innerHTML = editingFields.map((fd, i) => `
    <div class="fe-row" data-i="${i}">
      <input class="fe-label" value="${esc(fd.label)}" placeholder="es. Gol" maxlength="24">
      <select class="fe-type">${Object.entries(FIELD_TYPES).map(([t, l]) => `<option value="${t}" ${t === fd.type ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button type="button" class="icon-btn" data-rm="${i}" aria-label="Rimuovi campo">×</button>
    </div>`).join('') || '<p class="muted small">Nessun campo: è una semplice spunta.</p>';
}

function readFieldEditor() {
  $$('#field-list .fe-row').forEach(row => {
    const fd = editingFields[+row.dataset.i];
    fd.label = $('.fe-label', row).value.trim();
    fd.type = $('.fe-type', row).value;
  });
}

async function submitHabit(e) {
  e.preventDefault();
  const f = e.target;
  readFieldEditor();
  const fields = editingFields.filter(x => x.label);
  const freq = f.freq.value;
  const target = freq === 'weekly' ? Math.min(7, Math.max(1, parseInt(f.target.value, 10) || 3)) : 7;
  const existing = state.habits.find(h => h.id === editingHabitId);
  const h = existing
    ? { ...existing, icon: f.icon.value.trim() || '⭐', name: f.name.value.trim(), freq, target, fields }
    : { id: uid(), icon: f.icon.value.trim() || '⭐', name: f.name.value.trim(), freq, target, fields,
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
    if (!confirm(`Importare ${data.habits.length} abitudini e ${data.days.length} giorni?\nI giorni già presenti vengono uniti, non sovrascritti.`)) return;
    const habits = data.habits.map(h => ({ ...(state.habits.find(x => x.id === h.id) || {}), ...h }));
    const days = data.days.map(d => {
      const ex = state.days.get(d.date);
      if (!ex) return d;
      const data2 = { ...(ex.data || {}) };
      for (const [hid, vals] of Object.entries(d.data || {})) data2[hid] = { ...(data2[hid] || {}), ...vals };
      const merged = { ...ex, done: { ...(ex.done || {}), ...(d.done || {}) }, data: data2,
        mood: ex.mood ?? d.mood ?? null, note: [ex.note, d.note].filter(Boolean).join(' · ') };
      if (ex.partial && d.partial) merged.partial = true; else delete merged.partial;
      return merged;
    });
    await db.putMany('habits', habits);
    await db.putMany('days', days);
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
  $('#habit-list').addEventListener('click', e => {
    const st = e.target.closest('[data-step]');
    if (st) {
      const d = +st.dataset.step, part = st.dataset.part;
      updateField(st.dataset.hid, st.dataset.fid, v => {
        if (!part) return Math.max(0, (+v || 0) + d);
        const x = { w: 0, d: 0, l: 0, ...(v || {}) };
        x[part] = Math.max(0, (+x[part] || 0) + d);
        return x;
      });
      return;
    }
    const tr = e.target.closest('[data-tour]');
    if (tr) {
      const act = tr.dataset.tour;
      updateField(tr.dataset.hid, tr.dataset.fid, v => {
        const t = tourOf(v);
        if (act === 'toggle') return { on: !t.on, result: t.on ? null : t.result };
        return { on: true, result: t.result === act ? null : act };
      });
      return;
    }
    const tg = e.target.closest('[data-bool]');
    if (tg) { updateField(tg.dataset.hid, tg.dataset.fid, v => !v); return; }
    const b = e.target.closest('.habit');
    if (b) toggleHabit(b.dataset.id);
  });
  $('#habit-list').addEventListener('change', e => {
    const t = e.target.closest('.fld-text');
    if (t) updateField(t.dataset.hid, t.dataset.fid, () => t.value.trim());
  });
  $('#btn-add-field').addEventListener('click', () => {
    readFieldEditor();
    editingFields.push({ id: uid().slice(0, 8), label: '', type: 'number' });
    renderFieldEditor();
    $$('#field-list .fe-label').at(-1)?.focus();
  });
  $('#field-list').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (!rm) return;
    readFieldEditor();
    editingFields.splice(+rm.dataset.rm, 1);
    renderFieldEditor();
  });
  $('#moods').addEventListener('click', e => { const b = e.target.closest('[data-mood]'); if (b) setMood(+b.dataset.mood); });
  $('#day-note').addEventListener('input', noteChanged);
  $('#save-status').addEventListener('click', async e => {
    if (e.target.id === 'btn-confirm') { await saveDay(getOrCreateDay(state.current)); renderAll(); }
  });
  $('#stats').addEventListener('click', e => {
    const tip = e.target.closest('[data-tip]');
    if (tip) {
      const box = tip.closest('.charts')?.querySelector('.chart-tip');
      if (box) { box.textContent = tip.dataset.tip; box.classList.add('on'); }
      return;
    }
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
