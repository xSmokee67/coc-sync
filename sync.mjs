// Synchronizacja danych z oficjalnego API Clash of Clans do pliku sync.json,
// który czyta Panel Klanu. Uruchamiane przez GitHub Actions co 30 minut.
// Klucz API: sekret COC_API_KEY (klucz z IP 45.79.218.79 – proxy RoyaleAPI).
import fs from 'node:fs/promises';

const KEY = process.env.COC_API_KEY;
const BASE = process.env.COC_API_BASE || 'https://cocproxy.royaleapi.dev/v1';
const NOW = new Date(process.env.SYNC_NOW || Date.now());

const HERO = { 'Barbarian King': 'bk', 'Archer Queen': 'aq', 'Minion Prince': 'mp', 'Grand Warden': 'gw', 'Royal Champion': 'rc', 'Dragon Duke': 'dd' };
const ROLE = { leader: 'leader', coLeader: 'coleader', admin: 'elder', member: 'member' };
// Osiągnięcia, które rosną tylko wtedy, gdy gracz sam coś robi (do wyliczenia „ostatnio aktywny”).
const ACTIVE_ACH = ['Gold Grab', 'Elixir Escapade', 'Heroic Heist', 'Conqueror', 'Friend in Need', 'Games Champion', 'Aggressive Capitalism', 'War League Legend', 'Most Valuable Clanmate', 'Sharing is caring', 'Siege Sharer'];
const CG_PLAYER_MAX = 10000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const normTag = t => '#' + String(t || '').toUpperCase().replace(/^#/, '').replace(/O/g, '0');
const enc = t => encodeURIComponent(normTag(t));
const parseT = s => {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z` : s;
};
const monthKey = d => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');

async function api(path) {
  let last;
  for (let i = 0; i < 4; i++) {
    let r;
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
    start: parseT(w.startTime), end: parseT(w.endTime),
    ours: usS.map((m, i) => ({
      tag: m.tag, name: m.name, th: m.townhallLevel, pos: i + 1,
      attacks: [...(m.attacks || [])].sort((a, b) => a.order - b.order).map(a => ({ t: pos[normTag(a.defenderTag)] || null, s: a.stars, d: a.destructionPercentage }))
    })),
    enemyTH: themS.map(m => m.townhallLevel),
    ourStars: us.stars || 0, ourPct: Math.round((us.destructionPercentage || 0) * 10) / 10,
    enemyStars: them.stars || 0, enemyPct: Math.round((them.destructionPercentage || 0) * 10) / 10
  };
}

async function syncClan(tag, state) {
  const out = { ok: false, tag: normTag(tag) };
  const clan = await api(`/clans/${enc(tag)}`);
  out.clan = { name: clan.name, tag: clan.tag, level: clan.clanLevel, warLeague: clan.warLeague && clan.warLeague.name, warLogPublic: clan.isWarLogPublic, members: clan.members };
  const list = clan.memberList || [];

  // --- gracze (TH, bohaterowie, chęć do wojen, aktywność, Igrzyska) ---
  const cgMonth = monthKey(NOW);
  const cgStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 22, 8));
  const cgEnd = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 28, 8));
  const cgPre = NOW < cgStart && cgStart - NOW < 48 * 3600e3;   // tuż przed startem: ustaw punkt odniesienia
  const cgOn = NOW >= cgStart;                                   // od startu do końca miesiąca liczymy punkty
  out.members = await mapLimit(list, 4, async m => {
    const base = { tag: m.tag, name: m.name, role: ROLE[m.role] || 'member', th: m.townHallLevel || null, don: m.donations || 0, rec: m.donationsReceived || 0 };
    let p;
    try { p = await api(`/players/${enc(m.tag)}`); } catch (e) { return base; }
    base.th = p.townHallLevel; base.warPref = p.warPreference === 'out' ? 'out' : 'in';
    base.heroes = {}; (p.heroes || []).forEach(h => { if (h.village === 'home' && HERO[h.name]) base.heroes[HERO[h.name]] = h.level; });
    const ach = {}; (p.achievements || []).forEach(a => ach[a.name] = a.value);
    const fp = [p.donations, p.donationsReceived, p.attackWins, p.warStars, p.clanCapitalContributions, p.expLevel, p.builderBaseTrophies, ...ACTIVE_ACH.map(n => ach[n] || 0)].join('|');
    const st = state.players[normTag(m.tag)] || (state.players[normTag(m.tag)] = {});
    if (st.fp !== fp) { st.fp = fp; if (st.seen) st.lastActive = NOW.toISOString(); }
    st.seen = NOW.toISOString();
    if (st.lastActive) base.lastActive = st.lastActive;
    const games = ach['Games Champion'];
    if (games != null) {
      st.cg = st.cg || {};
      if (cgPre || (cgOn && !st.cg[cgMonth])) st.cg[cgMonth] = games;
      if (cgOn && st.cg[cgMonth] != null) base.cg = Math.min(CG_PLAYER_MAX, Math.max(0, games - st.cg[cgMonth]));
      for (const k of Object.keys(st.cg)) if (k < monthKey(new Date(NOW - 62 * 864e5))) delete st.cg[k];
    }
    return base;
  });
  if (cgOn) out.cg = { season: cgMonth, active: NOW < cgEnd, pts: Object.fromEntries(out.members.filter(m => m.cg != null).map(m => [m.tag, m.cg])) };

  // --- bieżąca wojna ---
  try {
    const w = await api(`/clans/${enc(tag)}/currentwar`);
    out.war = w.state === 'notInWar' ? { state: 'notInWar' } : convWar(w, tag);
  } catch (e) { out.warError = e.status === 403 ? 'Dziennik wojen klanu jest prywatny – w grze ustaw go jako publiczny (Ustawienia klanu)' : e.message; }

  // --- Liga Klanów (CWL) ---
  try {
    const g = await api(`/clans/${enc(tag)}/currentwar/leaguegroup`);
    if (g && g.rounds && g.state !== 'notInWar') {
      state.cwl = state.cwl || {};
      const key = normTag(tag) + ':' + g.season;
      const known = state.cwl[key] || (state.cwl[key] = {});
      const rounds = [];
      for (let r = 0; r < g.rounds.length; r++) {
        const tags = (g.rounds[r].warTags || []).filter(t => t && t !== '#0');
        if (!tags.length) { rounds.push(null); continue; }
        let war = null;
        const order = known[r] ? [known[r], ...tags.filter(t => t !== known[r])] : tags;
        for (const wt of order) {
          const w = await api(`/clanwarleagues/wars/${enc(wt)}`);
          if ([w.clan, w.opponent].some(c => c && normTag(c.tag) === normTag(tag))) { known[r] = wt; war = convWar(w, tag); break; }
        }
        if (!war) { rounds.push(null); continue; }
        let result = '';
        if (war.state === 'warEnded') result = war.ourStars > war.enemyStars ? 'W' : war.ourStars < war.enemyStars ? 'L' : war.ourPct > war.enemyPct ? 'W' : war.ourPct < war.enemyPct ? 'L' : 'D';
        rounds.push({ state: war.state, enemy: war.enemy, enemyTag: war.enemyTag, size: war.size, result, ourStars: war.ourStars, enemyStars: war.enemyStars,
          lineup: war.ours.map(o => ({ tag: o.tag, name: o.name, th: o.th, s: o.attacks[0] ? o.attacks[0].s : null })) });
      }
      for (const k of Object.keys(state.cwl)) if (!k.endsWith(g.season)) delete state.cwl[k];
      out.cwl = { season: g.season, state: g.state, size: (rounds.find(x => x) || {}).size || null, rounds };
    }
  } catch (e) { if (e.status !== 404) out.cwlError = e.message; }

  // --- Raid Weekend (stolica klanu) ---
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

async function main() {
  const cfg = JSON.parse(await fs.readFile('config.json', 'utf8'));
  let state = { players: {} };
  try { state = JSON.parse(await fs.readFile('state.json', 'utf8')); } catch {}
  state.players = state.players || {};
  const result = { v: 1, generatedAt: NOW.toISOString(), clans: {} };
  if (!KEY) {
    for (const id of Object.keys(cfg.clans)) result.clans[id] = { ok: false, error: 'Brak sekretu COC_API_KEY w ustawieniach repozytorium' };
  } else {
    for (const [id, tag] of Object.entries(cfg.clans)) {
      if (!tag || /^#?X+$/i.test(tag)) { result.clans[id] = { ok: false, error: 'Uzupełnij tag klanu w config.json' }; continue; }
      try { result.clans[id] = await syncClan(tag, state); }
      catch (e) { result.clans[id] = { ok: false, tag: normTag(tag), error: e.message }; }
      console.log(id, result.clans[id].ok ? `OK: ${result.clans[id].members.length} graczy, wojna: ${result.clans[id].war ? result.clans[id].war.state : '-'}` : 'BŁĄD: ' + result.clans[id].error);
    }
  }
  const cutoff = NOW - 60 * 864e5;
  for (const [t, p] of Object.entries(state.players)) if (p.seen && new Date(p.seen) < cutoff) delete state.players[t];
  await fs.writeFile('sync.json', JSON.stringify(result));
  await fs.writeFile('state.json', JSON.stringify(state));
  if (Object.values(result.clans).every(c => !c.ok)) process.exitCode = 1;
}
main();
