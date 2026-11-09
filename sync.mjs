// Synchronizacja danych z oficjalnego API Clash of Clans dla Panelu Klanu.
// Uruchamiane przez GitHub Actions (budzik cron-job.org + harmonogram).
// Wynik:
//   sync.json  – bieżący stan obu klanów (członkowie, wojna, CWL, raid, Igrzyska)
//   state.json – pamięć między przebiegami + archiwum: historia wojen, sezony CWL,
//                dziennik klanu, dzienne migawki graczy (do profili)
// Klucz API: sekret COC_API_KEY (klucz z IP 45.79.218.79 – proxy RoyaleAPI).
import fs from 'node:fs/promises';

const KEY = process.env.COC_API_KEY;
const BASE = process.env.COC_API_BASE || 'https://cocproxy.royaleapi.dev/v1';
const NOW = new Date(process.env.SYNC_NOW || Date.now());
const NOW_ISO = NOW.toISOString();

const HERO = { 'Barbarian King': 'bk', 'Archer Queen': 'aq', 'Minion Prince': 'mp', 'Grand Warden': 'gw', 'Royal Champion': 'rc', 'Dragon Duke': 'dd' };
const HERO_KEYS = ['bk', 'aq', 'mp', 'gw', 'rc', 'dd'];
const ROLE = { leader: 'leader', coLeader: 'coleader', admin: 'elder', member: 'member' };
// Osiągnięcia, które rosną tylko wtedy, gdy gracz sam coś robi (do wyliczenia „ostatnio aktywny”).
const ACTIVE_ACH = ['Gold Grab', 'Elixir Escapade', 'Heroic Heist', 'Conqueror', 'Friend in Need', 'Games Champion', 'Aggressive Capitalism', 'War League Legend', 'Most Valuable Clanmate', 'Sharing is caring', 'Siege Sharer'];
// Liczniki oddanych wojsk, czarów i machin (do donacji w dniu przygotowań).
const DONATE_ACH = ['Friend in Need', 'Sharing is caring', 'Siege Sharer'];
const CG_PLAYER_MAX = 10000;
const KEEP_SNAP_DAYS = 120, KEEP_LOG = 600, KEEP_WARS = 100, KEEP_CWL_SEASONS = 6;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const normTag = t => '#' + String(t || '').toUpperCase().replace(/^#/, '').replace(/O/g, '0');
const enc = t => encodeURIComponent(normTag(t));
const parseT = s => {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z` : s;
};
const monthKey = d => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
const dayKey = d => d.toISOString().slice(0, 10);
const r1 = x => Math.round((x || 0) * 10) / 10;

let calls = 0;
async function api(path) {
  let last;
  for (let i = 0; i < 4; i++) {
    let r;
    calls++;
    try {
      r = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + KEY, Accept: 'application/json' } });
    } catch (e) { last = e; await sleep(1500 * (i + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { last = new Error('HTTP ' + r.status); await sleep(2000 * (i + 1)); continue; }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(explain(r.status, body.reason, body.message));
      e.status = r.status; e.reason = body.reason; throw e;
    }
    return body;
  }
  throw new Error('API Clash of Clans nie odpowiada (' + (last && last.message) + ')');
}
function explain(status, reason, message) {
  if (reason === 'accessDenied.invalidIp') return 'Klucz API ma zły adres IP – ustaw 45.79.218.79 na developer.clashofclans.com';
  if (status === 403 && reason === 'accessDenied') return 'Odmowa dostępu – sprawdź sekret COC_API_KEY albo czy dziennik wojen klanu jest publiczny';
  if (status === 404) return 'Nie znaleziono (sprawdź tag w config.json)';
  return `HTTP ${status} ${reason || ''} ${message || ''}`.trim();
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---------- czasy ataków ----------
// API nie podaje godziny ataku. Zapamiętujemy, w którym przebiegu atak pojawił się po raz pierwszy:
// ab = poprzedni przebieg (atak był później), at = ten przebieg (atak był wcześniej).
function stampAttacks(state, warKey, ours) {
  const seen = state.atk[warKey] || (state.atk[warKey] = {});
  for (const o of ours) {
    o.attacks.forEach((a, j) => {
      const k = normTag(o.tag) + ':' + (a.o || j);
      if (!seen[k]) seen[k] = [state.lastSync || null, NOW_ISO];
      a.ab = seen[k][0]; a.at = seen[k][1];
    });
  }
  seen._t = NOW_ISO;
}

function convWar(w, ourTag) {
  if (!w || !w.clan || !w.opponent) return null;
  let us = w.clan, them = w.opponent;
  if (normTag(us.tag) !== normTag(ourTag)) [us, them] = [them, us];
  const themS = [...(them.members || [])].sort((a, b) => a.mapPosition - b.mapPosition);
  const usS = [...(us.members || [])].sort((a, b) => a.mapPosition - b.mapPosition);
  const pos = {}; themS.forEach((m, i) => pos[normTag(m.tag)] = i + 1);
  return {
    id: w.preparationStartTime || w.startTime, state: w.state,
    enemy: them.name || 'Przeciwnik', enemyTag: them.tag || '', size: w.teamSize || usS.length, apm: w.attacksPerMember || 1,
    prep: parseT(w.preparationStartTime), start: parseT(w.startTime), end: parseT(w.endTime),
    ours: usS.map((m, i) => ({
      tag: m.tag, name: m.name, th: m.townhallLevel, pos: i + 1,
      attacks: [...(m.attacks || [])].sort((a, b) => a.order - b.order)
        .map(a => ({ t: pos[normTag(a.defenderTag)] || null, s: a.stars, d: a.destructionPercentage, o: a.order, du: a.duration || null }))
    })),
    enemyTH: themS.map(m => m.townhallLevel),
    enemyTags: themS.map(m => m.tag),
    ourStars: us.stars || 0, ourPct: r1(us.destructionPercentage),
    enemyStars: them.stars || 0, enemyPct: r1(them.destructionPercentage)
  };
}
const warResult = w => w.ourStars > w.enemyStars ? 'W' : w.ourStars < w.enemyStars ? 'L' : w.ourPct > w.enemyPct ? 'W' : w.ourPct < w.enemyPct ? 'L' : 'D';
function thDist(list) { const d = {}; list.forEach(th => { if (th) d[th] = (d[th] || 0) + 1; }); return d; }

// ---------- rozpoznanie przeciwnika ----------
async function scoutClan(tag, withLog) {
  const c = await api(`/clans/${enc(tag)}`);
  const s = { name: c.name, tag: c.tag, level: c.clanLevel, members: c.members, league: c.warLeague && c.warLeague.name,
    wins: c.warWins ?? null, losses: c.warLosses ?? null, ties: c.warTies ?? null, streak: c.warWinStreak ?? null,
    logPublic: !!c.isWarLogPublic, location: c.location && c.location.name || null, th: thDist((c.memberList || []).map(m => m.townHallLevel)) };
  if (withLog && c.isWarLogPublic) {
    try {
      const log = await api(`/clans/${enc(tag)}/warlog?limit=10`);
      s.recent = (log.items || []).map(x => ({ r: x.result === 'win' ? 'W' : x.result === 'lose' ? 'L' : x.result === 'tie' ? 'D' : '', size: x.teamSize,
        st: x.clan && x.clan.stars, est: x.opponent && x.opponent.stars, en: x.opponent && x.opponent.name || (x.attacksPerMember === 1 ? 'CWL' : '') }));
    } catch {}
  }
  return s;
}
async function scoutWar(state, key, war) {
  if (state.scout[key]) return state.scout[key];
  const s = await scoutClan(war.enemyTag, true);
  // bohaterowie baz przeciwnika (obrona) – raz na wojnę
  s.bases = await mapLimit(war.enemyTags || [], 4, async (t, i) => {
    try {
      const p = await api(`/players/${enc(t)}`);
      const h = {}; (p.heroes || []).forEach(x => { if (x.village === 'home' && HERO[x.name]) h[HERO[x.name]] = x.level; });
      return { pos: i + 1, th: p.townHallLevel, h, ws: p.warStars || 0 };
    } catch { return { pos: i + 1, th: war.enemyTH[i] || null, h: {} }; }
  });
  s.t = NOW_ISO;
  state.scout[key] = s;
  return s;
}

// ---------- jeden klan ----------
async function syncClan(id, tag, state) {
  const out = { ok: false, tag: normTag(tag) };
  const clan = await api(`/clans/${enc(tag)}`);
  out.clan = { name: clan.name, tag: clan.tag, level: clan.clanLevel, warLeague: clan.warLeague && clan.warLeague.name, warLogPublic: clan.isWarLogPublic, members: clan.members };
  const list = clan.memberList || [];

  // --- gracze (TH, bohaterowie, chęć do wojen, aktywność, Igrzyska, donacje) ---
  const cgMonth = monthKey(NOW);
  const cgStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 22, 8));
  const cgEnd = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 28, 8));
  const cgPre = NOW < cgStart && cgStart - NOW < 48 * 3600e3;
  const cgOn = NOW >= cgStart;
  const donDelta = {};   // ile wojsk/czarów/machin gracz oddał od poprzedniego przebiegu
  out.members = await mapLimit(list, 4, async m => {
    const base = { tag: m.tag, name: m.name, role: ROLE[m.role] || 'member', th: m.townHallLevel || null, don: m.donations || 0, rec: m.donationsReceived || 0 };
    const st = state.players[normTag(m.tag)] || (state.players[normTag(m.tag)] = {});
    if (!st.first) st.first = NOW_ISO;
    let p;
    try { p = await api(`/players/${enc(m.tag)}`); } catch (e) { return base; }
    base.th = p.townHallLevel; base.warPref = p.warPreference === 'out' ? 'out' : 'in';
    base.heroes = {}; (p.heroes || []).forEach(h => { if (h.village === 'home' && HERO[h.name]) base.heroes[HERO[h.name]] = h.level; });
    base.ws = p.warStars || 0; base.xp = p.expLevel || 0;
    const ach = {}; (p.achievements || []).forEach(a => ach[a.name] = a.value);
    const fp = [p.donations, p.donationsReceived, p.attackWins, p.warStars, p.clanCapitalContributions, p.expLevel, p.builderBaseTrophies, ...ACTIVE_ACH.map(n => ach[n] || 0)].join('|');
    if (st.fp !== fp) { st.fp = fp; if (st.seen) st.lastActive = NOW_ISO; }
    st.seen = NOW_ISO;
    if (st.lastActive) base.lastActive = st.lastActive;
    else base.quietSince = st.first;               // od pierwszego pomiaru nic nie zrobił
    // donacje (wojska + czary + machiny) – przyrost od poprzedniego przebiegu
    const dc = DONATE_ACH.reduce((a, n) => a + (ach[n] || 0), 0);
    if (st.dc != null && dc > st.dc) donDelta[normTag(m.tag)] = dc - st.dc;
    st.dc = dc;
    const games = ach['Games Champion'];
    if (games != null) {
      st.cg = st.cg || {};
      if (cgPre || (cgOn && !st.cg[cgMonth])) st.cg[cgMonth] = games;
      if (cgOn && st.cg[cgMonth] != null) base.cg = Math.min(CG_PLAYER_MAX, Math.max(0, games - st.cg[cgMonth]));
      for (const k of Object.keys(st.cg)) if (k < monthKey(new Date(NOW - 62 * 864e5))) delete st.cg[k];
    }
    // dzienna migawka do profilu: [dzień, TH, BK, AQ, MP, GW, RC, DD, donacje sezonu, otrzymane, gwiazdki wojenne, oddane łącznie]
    const snap = state.snap[normTag(m.tag)] || (state.snap[normTag(m.tag)] = []);
    const row = [dayKey(NOW), p.townHallLevel, ...HERO_KEYS.map(k => base.heroes[k] || 0), base.don, base.rec, base.ws, dc];
    if (snap.length && snap[snap.length - 1][0] === row[0]) snap[snap.length - 1] = row; else snap.push(row);
    const cut = dayKey(new Date(NOW - KEEP_SNAP_DAYS * 864e5));
    while (snap.length && snap[0][0] < cut) snap.shift();
    return base;
  });
  if (cgOn) out.cg = { season: cgMonth, active: NOW < cgEnd, pts: Object.fromEntries(out.members.filter(m => m.cg != null).map(m => [m.tag, m.cg])) };

  // --- dziennik klanu: dołączenia, odejścia, awanse, ulepszenia TH, zmiany nicku ---
  const prev = state.roster[id];
  const now = {};
  out.members.forEach(m => { now[normTag(m.tag)] = { n: m.name, r: m.role, th: m.th }; });
  if (prev) {
    const RANK = { member: 0, elder: 1, coleader: 2, leader: 3 };
    for (const [t, m] of Object.entries(now)) {
      const p = prev[t];
      if (!p) {
        const back = (state.ever[t] || []).length > 0;
        log(state, id, t, m.n, back ? 'rejoin' : 'join', back ? (state.ever[t].slice(-1)[0] || null) : null, null);
        continue;
      }
      if (p.r !== m.r) log(state, id, t, m.n, RANK[m.r] > RANK[p.r] ? 'promo' : 'demo', p.r, m.r);
      if (p.th && m.th && m.th > p.th) log(state, id, t, m.n, 'th', p.th, m.th);
      if (p.n !== m.n) log(state, id, t, m.n, 'name', p.n, m.n);
    }
    for (const [t, p] of Object.entries(prev)) if (!now[t]) log(state, id, t, p.n, 'leave', null, null);
  }
  for (const t of Object.keys(now)) { const e = state.ever[t] || (state.ever[t] = []); if (!e.includes(id)) e.push(id); }
  for (const t of Object.keys(prev || {})) if (!now[t]) { const e = state.ever[t] || (state.ever[t] = []); e.push(id); }
  state.roster[id] = now;

  // --- bieżąca wojna ---
  try {
    const w = await api(`/clans/${enc(tag)}/currentwar`);
    if (w.state === 'notInWar') out.war = { state: 'notInWar' };
    else {
      out.war = convWar(w, tag);
      const key = 'w:' + normTag(tag) + ':' + out.war.id;
      stampAttacks(state, key, out.war.ours);
      if (out.war.state === 'preparation') addDon(state, key, donDelta);
      out.war.don = state.don[key] || {};
      if (out.war.state !== 'warEnded') {
        try { out.war.scout = await scoutWar(state, key, out.war); } catch (e) { out.war.scoutError = e.message; }
      } else if (state.scout[key]) out.war.scout = state.scout[key];
    }
  } catch (e) { out.warError = e.status === 403 ? 'Dziennik wojen klanu jest prywatny – w grze ustaw go jako publiczny (Ustawienia klanu)' : e.message; }

  // --- Liga Klanów (CWL): wszystkie wojny grupy, tabela, czasy ataków, donacje w dniu przygotowań ---
  try {
    const g = await api(`/clans/${enc(tag)}/currentwar/leaguegroup`);
    if (g && g.rounds && g.state !== 'notInWar') {
      const season = String(g.season || '').slice(0, 7);
      const table = {};
      (g.clans || []).forEach(c => { table[normTag(c.tag)] = { tag: c.tag, name: c.name, level: c.clanLevel, stars: 0, dest: 0, w: 0, l: 0, d: 0, played: 0, th: thDist((c.members || []).map(m => m.townHallLevel)) }; });
      const rounds = [];
      for (let r = 0; r < g.rounds.length; r++) {
        const tags = (g.rounds[r].warTags || []).filter(t => t && t !== '#0');
        let ours = null;
        for (const wt of tags) {
          let w = state.cwlWars[wt];                     // zakończone wojny trzymamy w pamięci
          if (!w) {
            const raw = await api(`/clanwarleagues/wars/${enc(wt)}`);
            w = { state: raw.state, a: { tag: raw.clan.tag, st: raw.clan.stars || 0, de: raw.clan.destructionPercentage || 0 }, b: { tag: raw.opponent.tag, st: raw.opponent.stars || 0, de: raw.opponent.destructionPercentage || 0 } };
            if ([raw.clan, raw.opponent].some(c => c && normTag(c.tag) === normTag(tag))) w.raw = raw;
            if (raw.state === 'warEnded') state.cwlWars[wt] = { state: w.state, a: w.a, b: w.b, mine: !!w.raw };
          }
          // tabela grupy (wojna w toku też się liczy – jak w grze)
          if (w.state === 'inWar' || w.state === 'warEnded') {
            for (const [x, y] of [[w.a, w.b], [w.b, w.a]]) {
              const row = table[normTag(x.tag)]; if (!row) continue;
              row.stars += x.st; row.dest += x.de * (g.rounds.length ? 1 : 1);
              if (w.state === 'warEnded') {
                row.played++;
                if (x.st > y.st || (x.st === y.st && x.de > y.de)) { row.w++; row.stars += 10; } else if (x.st < y.st || x.de < y.de) row.l++; else row.d++;
              }
            }
          }
          if ([w.a, w.b].some(c => normTag(c.tag) === normTag(tag))) {
            const raw = w.raw || await api(`/clanwarleagues/wars/${enc(wt)}`);
            ours = convWar(raw, tag); ours.warTag = wt;
          }
        }
        if (!ours) { rounds.push(null); continue; }
        const key = 'c:' + ours.warTag;
        stampAttacks(state, key, ours.ours);
        if (ours.state === 'preparation') addDon(state, key, donDelta);
        rounds.push({ state: ours.state, enemy: ours.enemy, enemyTag: ours.enemyTag, size: ours.size, result: ours.state === 'warEnded' ? warResult(ours) : '',
          ourStars: ours.ourStars, enemyStars: ours.enemyStars, ourPct: ours.ourPct, enemyPct: ours.enemyPct,
          prep: ours.prep, start: ours.start, end: ours.end, don: state.don[key] || {},
          lineup: ours.ours.map(o => { const a = o.attacks[0]; return { tag: o.tag, name: o.name, th: o.th, pos: o.pos, s: a ? a.s : null, d: a ? r1(a.d) : null, t: a ? a.t : null, du: a ? a.du : null, ab: a ? a.ab : null, at: a ? a.at : null }; }),
          enemyTH: ours.enemyTH });
      }
      const tbl = Object.values(table).map(x => ({ ...x, dest: Math.round(x.dest) })).sort((a, b) => b.stars - a.stars || b.dest - a.dest);
      out.cwl = { season, state: g.state, size: (rounds.find(x => x) || {}).size || null, rounds, table: tbl };
      // archiwum sezonu (do profili graczy)
      const arch = state.cwlSeasons[id] || (state.cwlSeasons[id] = {});
      arch[season] = { size: out.cwl.size, rounds: rounds.map(r => r && { enemy: r.enemy, result: r.result, start: r.start, lineup: r.lineup.map(x => ({ tag: x.tag, s: x.s, d: x.d, t: x.t, at: x.at })) }) };
      const seasons = Object.keys(arch).sort();
      while (seasons.length > KEEP_CWL_SEASONS) delete arch[seasons.shift()];
    }
  } catch (e) { if (e.status !== 404) out.cwlError = e.message; }

  // --- Raid Weekend ---
  try {
    const rs = await api(`/clans/${enc(tag)}/capitalraidseasons?limit=1`);
    const s = rs.items && rs.items[0];
    if (s) {
      const ms = s.members || [];
      out.raid = { state: s.state, start: parseT(s.startTime), end: parseT(s.endTime), loot: s.capitalTotalLoot || 0,
        limit: ms.reduce((a, m) => Math.max(a, (m.attackLimit || 0) + (m.bonusAttackLimit || 0)), 0) || 6,
        members: ms.map(m => ({ tag: m.tag, attacks: m.attacks || 0, gold: m.capitalResourcesLooted || 0 })) };
    }
  } catch (e) { out.raidError = e.message; }

  out.ok = true;
  return out;
}
function addDon(state, key, delta) {
  const d = state.don[key] || (state.don[key] = {});
  for (const [t, n] of Object.entries(delta)) d[t] = (d[t] || 0) + n;
}
function log(state, clan, tag, name, k, a, b) {
  state.log.push({ t: NOW_ISO, c: clan, tag, n: name, k, a, b });
}

// ---------- archiwum zwykłych wojen ----------
function toHist(id, w) {
  return { id: 'api-' + w.id, clan: id, enemy: w.enemy, enemyTag: w.enemyTag, size: w.size, apm: w.apm,
    date: (w.end || w.start || NOW_ISO).slice(0, 10), start: w.start || null,
    ourStars: w.ourStars, ourPct: w.ourPct, enemyStars: w.enemyStars, enemyPct: w.enemyPct, result: warResult(w),
    rows: w.ours.map(o => ({ tag: o.tag, name: o.name, th: o.th, pos: o.pos,
      a: Array.from({ length: w.apm || 1 }, (_, j) => o.attacks[j] ? { t: o.attacks[j].t, s: o.attacks[j].s, d: o.attacks[j].d, at: o.attacks[j].at || null } : { t: null, s: null, d: null }) })) };
}
function recordWars(id, out, state, history) {
  const add = w => { if (w && w.ours && !history.some(h => h.id === 'api-' + w.id)) history.push(toHist(id, w)); };
  const cw = out.war, last = state.lastWar[id];
  if (!cw) return;
  if (cw.state === 'warEnded') { add(cw); delete state.lastWar[id]; return; }
  if (last && (!cw.ours || cw.id !== last.id)) { add(last); delete state.lastWar[id]; }
  if (cw.ours && (cw.state === 'inWar' || cw.state === 'preparation')) { const c = { ...cw }; delete c.scout; state.lastWar[id] = c; }
}

// state.json czytelny dla gita (jedna pozycja w linii), żeby repozytorium nie puchło
function stateStringify(st) {
  const lines = ['{'];
  const keys = Object.keys(st);
  keys.forEach((k, i) => {
    const v = st[k]; const end = i < keys.length - 1 ? ',' : '';
    if (v && typeof v === 'object' && !Array.isArray(v) && ['players', 'snap', 'ever', 'atk', 'don', 'cwlWars', 'scout'].includes(k)) {
      const ks = Object.keys(v);
      lines.push(JSON.stringify(k) + ':{');
      ks.forEach((kk, j) => lines.push(JSON.stringify(kk) + ':' + JSON.stringify(v[kk]) + (j < ks.length - 1 ? ',' : '')));
      lines.push('}' + end);
    } else if (Array.isArray(v) && ['history', 'log'].includes(k)) {
      lines.push(JSON.stringify(k) + ':[');
      v.forEach((x, j) => lines.push(JSON.stringify(x) + (j < v.length - 1 ? ',' : '')));
      lines.push(']' + end);
    } else lines.push(JSON.stringify(k) + ':' + JSON.stringify(v) + end);
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}

async function main() {
  const cfg = JSON.parse(await fs.readFile('config.json', 'utf8'));
  let state = {};
  try { state = JSON.parse(await fs.readFile('state.json', 'utf8')); } catch {}
  for (const k of ['players', 'snap', 'ever', 'roster', 'atk', 'don', 'cwlWars', 'scout', 'lastWar', 'cwlSeasons']) state[k] = state[k] || {};
  state.history = Array.isArray(state.history) ? state.history : [];
  state.log = Array.isArray(state.log) ? state.log : [];
  state.v = 2;
  const result = { v: 2, generatedAt: NOW_ISO, prevSync: state.lastSync || null, clans: {} };
  let anyOk = false;
  if (!KEY) {
    for (const id of Object.keys(cfg.clans)) result.clans[id] = { ok: false, error: 'Brak sekretu COC_API_KEY w ustawieniach repozytorium' };
  } else {
    for (const [id, tag] of Object.entries(cfg.clans)) {
      if (!tag || /^#?X+$/i.test(tag)) { result.clans[id] = { ok: false, error: 'Uzupełnij tag klanu w config.json' }; continue; }
      try { result.clans[id] = await syncClan(id, tag, state); recordWars(id, result.clans[id], state, state.history); anyOk = true; }
      catch (e) { result.clans[id] = { ok: false, tag: normTag(tag), error: e.message }; }
      const c = result.clans[id];
      console.log(id, c.ok ? `OK: ${c.members.length} graczy, wojna: ${c.war ? c.war.state : '-'}, CWL: ${c.cwl ? c.cwl.state : '-'}` : 'BŁĄD: ' + c.error);
    }
  }
  // porządki
  const cutoff = NOW - 60 * 864e5;
  for (const [t, p] of Object.entries(state.players)) if (p.seen && new Date(p.seen) < cutoff) { delete state.players[t]; delete state.snap[t]; }
  const old = iso => !iso || new Date(iso) < NOW - 14 * 864e5;
  for (const [k, v] of Object.entries(state.atk)) if (old(v._t)) { delete state.atk[k]; delete state.don[k]; }
  for (const k of Object.keys(state.don)) if (!state.atk[k]) delete state.don[k];
  const scoutKeys = Object.keys(state.scout).sort((a, b) => (state.scout[a].t || '').localeCompare(state.scout[b].t || ''));
  while (scoutKeys.length > 6) delete state.scout[scoutKeys.shift()];
  const cwlKeys = Object.keys(state.cwlWars); if (cwlKeys.length > 400) cwlKeys.slice(0, cwlKeys.length - 400).forEach(k => delete state.cwlWars[k]);
  if (state.log.length > KEEP_LOG) state.log = state.log.slice(-KEEP_LOG);
  state.history.sort((a, b) => a.date.localeCompare(b.date));
  for (const id of Object.keys(cfg.clans)) {
    const mine = state.history.filter(h => h.clan === id);
    if (mine.length > KEEP_WARS) { const drop = new Set(mine.slice(0, mine.length - KEEP_WARS).map(h => h.id)); state.history = state.history.filter(h => !drop.has(h.id)); }
    if (result.clans[id] && result.clans[id].ok) result.clans[id].history = state.history.filter(h => h.clan === id).slice(-15);
  }
  if (anyOk) state.lastSync = NOW_ISO;
  console.log('Zapytań do API:', calls);
  await fs.writeFile('sync.json', JSON.stringify(result));
  await fs.writeFile('state.json', stateStringify(state));
  if (!anyOk) process.exitCode = 1;
}
main();
