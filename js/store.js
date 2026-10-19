/* ============================================================
   store.js — Modèle de données + moteur de tournoi (v2)

   FORMAT
   - Phase 1 : tout le monde joue un match (paires tirées au sort).
     Nombre impair → un exempt, qualifié d'office.
   - Tableau final : élimination directe, taille = puissance de 2
     juste au-dessus du nombre de qualifiés. Les places manquantes
     sont comblées par les MEILLEURS PERDANTS de la phase 1
     (points marqués, puis différentiel, puis tirage au sort).
     Un match se joue dès que ses deux adversaires sont connus.
   - Consolante : tous les perdants non repêchés, en élimination
     directe (exempts au 1er tour si besoin pour revenir à une
     puissance de 2). Générée automatiquement en fin de phase 1.

   ARCHITECTURE
   - La STRUCTURE (joueurs, réglages, tirage) et les SCORES sont
     stockés séparément : un enregistrement de score par match.
     Deux saisies simultanées sur deux matchs différents ne peuvent
     donc jamais s'écraser.
   - Tout l'état (qui joue contre qui, qui avance, repêchés,
     consolante, champion) est RECALCULÉ par une fonction pure,
     déterministe, à partir de la structure et des scores.
   - Chaque score mémorise le tirage et les deux joueurs concernés :
     si un score devient obsolète (correction en amont, nouveau
     tirage), il est simplement ignoré.
   ============================================================ */
(function () {
  "use strict";

  const LS_KEY = "tg_backgammon_db_v1";
  const VERSION = 2;

  let DB = { tournaments: [] };
  const listeners = [];
  const storageListeners = [];
  let storageError = null;
  let epoch = 0;                         // invalide le cache des états
  const cache = new WeakMap();           // t -> { epoch, state }
  const ID_RX = /^[A-Za-z0-9_-]{1,80}$/;
  const NAME_MAX = 80;

  // ---------- Utilitaires ----------
  function uid(prefix) {
    return (prefix || "id") + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }
  function rand() {
    try {
      if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] / 4294967296;
      }
    } catch (e) {}
    return Math.random();
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const x = a[i]; a[i] = a[j]; a[j] = x; }
    return a;
  }
  function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }
  function log2(n) { return Math.round(Math.log(n) / Math.LN2); }

  /** Ordre standard des têtes de série : la tête s affronte P+1-s. */
  function seedOrder(size) {
    if (size <= 1) return [1];
    let order = [1, 2];
    while (order.length < size) {
      const sum = order.length * 2 + 1, next = [];
      for (const s of order) { next.push(s); next.push(sum - s); }
      order = next;
    }
    return order;
  }

  // ---------- Persistance ----------
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) DB = JSON.parse(raw);
    } catch (e) { console.warn("Lecture DB locale impossible", e); }
    if (!DB || typeof DB !== "object") DB = { tournaments: [] };
    if (!Array.isArray(DB.tournaments)) DB.tournaments = [];
    DB.tournaments = DB.tournaments.map(migrate).filter(Boolean);
    epoch++;
    return DB;
  }
  function persistLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(DB));
      storageError = null;
    } catch (e) {
      console.warn(e);
      storageError = e;
      storageListeners.forEach((fn) => { try { fn(e); } catch (x) {} });
    }
  }
  /** Prévenu si le navigateur refuse d'enregistrer (mémoire pleine, mode privé…). */
  function onStorageError(fn) { storageListeners.push(fn); }
  function getStorageError() { return storageError; }
  function emit() {
    epoch++;
    listeners.forEach((fn) => { try { fn(DB); } catch (e) { console.error(e); } });
  }
  function onChange(fn) { listeners.push(fn); }
  function touch(t) { if (t) t.updatedAt = Date.now(); return t; }
  function cloudOn() { return !!(window.TG && TG.Cloud && TG.Cloud.isCloud && TG.Cloud.isCloud()); }

  /** Sauvegarde locale + synchro (différée) de la STRUCTURE vers le cloud. */
  function commit(reason) {
    persistLocal();
    emit();
    if (cloudOn() && TG.Cloud.scheduleSync) TG.Cloud.scheduleSync(reason || "maj");
  }

  // ============================================================
  //  Réglages / migration
  // ============================================================
  function defaultSettings() {
    return {
      pointsPhase1: 7,
      // Points du tableau final, comptés DEPUIS LA FIN :
      // [finale, demies, quarts, 8es, 16es, 32es, 64es]
      mainPoints: [11, 9, 9, 7, 7, 7, 7],
      consolePoints: 5,
      consolante: true,
      autoRotate: true,
      rotateSeconds: 20,
      rules: "Phase 1 : tout le monde joue. Les gagnants se qualifient pour le tableau final, complété par les meilleurs perdants (points marqués). Les autres jouent la consolante. Le premier joueur atteignant le nombre de points du match l'emporte.",
    };
  }

  function normSettings(s) {
    const d = defaultSettings();
    const o = Object.assign({}, d, s || {});
    o.pointsPhase1 = posInt(o.pointsPhase1, d.pointsPhase1);
    o.consolePoints = posInt(o.consolePoints, d.consolePoints);
    o.rotateSeconds = Math.max(5, posInt(o.rotateSeconds, d.rotateSeconds));
    const mp = Array.isArray(o.mainPoints) ? o.mainPoints : d.mainPoints;
    o.mainPoints = d.mainPoints.map((v, i) => posInt(mp[i], v));
    o.consolante = o.consolante !== false;
    o.autoRotate = o.autoRotate !== false;
    if (typeof o.rules !== "string") o.rules = d.rules;
    return o;
  }
  function posInt(v, def) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? Math.min(n, 99) : def; }

  /** Convertit n'importe quel tournoi (ancien format compris) en v2. */
  function migrate(t) {
    if (!t || typeof t !== "object" || typeof t.id !== "string" || !ID_RX.test(t.id)) return null;
    if (t.v === VERSION) {
      t.name = cleanName(t.name, "Tournoi");
      t.date = typeof t.date === "string" ? t.date.slice(0, 32) : "";
      t.createdAt = Number(t.createdAt) || 0;
      t.updatedAt = Number(t.updatedAt) || t.createdAt || 0;
      t.settings = normSettings(t.settings);
      const seen = {};
      t.players = (Array.isArray(t.players) ? t.players : [])
        .filter((p) => p && typeof p.id === "string" && ID_RX.test(p.id) && !seen[p.id] && (seen[p.id] = true))
        .map(normPlayer);
      t.scores = cleanScores(t.scores);
      t.draw = cleanDraw(t.draw);
      return t;
    }
    // Ancien format (v1) : on garde nom, date, joueurs, règlement.
    const old = t.settings || {};
    const s = defaultSettings();
    if (Array.isArray(old.roundValues)) {
      const r1 = old.roundValues.find((r) => r && r.round === 1);
      if (r1 && r1.points) s.pointsPhase1 = posInt(r1.points, s.pointsPhase1);
    }
    if (typeof old.rules === "string" && old.rules.trim()) s.rules = old.rules;
    const seen = {};
    return {
      v: VERSION,
      id: t.id,
      name: cleanName(t.name, "Tournoi"),
      date: typeof t.date === "string" ? t.date.slice(0, 32) : "",
      createdAt: Number(t.createdAt) || 0,
      updatedAt: Number(t.updatedAt) || Number(t.createdAt) || 0,
      settings: s,
      players: (Array.isArray(t.players) ? t.players : [])
        .filter((p) => p && typeof p.id === "string" && ID_RX.test(p.id) && !seen[p.id] && (seen[p.id] = true))
        .map(normPlayer),
      draw: null,
      scores: {},
    };
  }
  function cleanName(v, def) {
    const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
    return s || def;
  }
  function normPlayer(p) {
    return {
      id: p.id,
      name: cleanName(p.name, "Joueur"),
      club: String(p.club || "").slice(0, NAME_MAX),
      rating: String(p.rating || "").slice(0, 20),
      note: String(p.note || "").slice(0, 500),
    };
  }
  function cleanScores(sc) {
    const out = {};
    if (!sc || typeof sc !== "object" || Array.isArray(sc)) return out;
    Object.keys(sc).forEach((k) => {
      const r = sc[k];
      if (!ID_RX.test(k) || !r || typeof r !== "object") return;
      const s1 = Number(r.s1), s2 = Number(r.s2);
      if (!Number.isInteger(s1) || !Number.isInteger(s2) || s1 < 0 || s2 < 0 || s1 > 99 || s2 > 99) return;
      out[k] = { s1, s2, p1: String(r.p1 || ""), p2: String(r.p2 || ""), draw: String(r.draw || ""), at: Number(r.at) || 0 };
    });
    return out;
  }
  /** Tirage validé (forme stricte) — sinon null. Protège contre des données injectées. */
  function cleanDraw(d) {
    if (!d || typeof d !== "object") return null;
    if (typeof d.id !== "string" || !ID_RX.test(d.id)) return null;
    if (!Array.isArray(d.p1) || !Array.isArray(d.slots)) return null;
    const isPid = (x) => typeof x === "string" && ID_RX.test(x);
    const p1 = [], p1ids = {};
    for (const m of d.p1) {
      if (!m || typeof m.id !== "string" || !ID_RX.test(m.id) || p1ids[m.id] || !isPid(m.a) || !isPid(m.b)) return null;
      p1ids[m.id] = true;
      p1.push({ id: m.id, a: m.a, b: m.b });
    }
    const P = d.slots.length;
    if (P < 1 || (P & (P - 1)) !== 0) return null;
    const slots = [];
    for (const sl of d.slots) {
      if (!sl || typeof sl !== "object") return null;
      if (sl.kind === "match" && typeof sl.ref === "string" && p1ids[sl.ref]) slots.push({ kind: "match", ref: sl.ref });
      else if (sl.kind === "bye" && isPid(sl.pid)) slots.push({ kind: "bye", pid: sl.pid });
      else if (sl.kind === "rep" && Number.isInteger(sl.k) && sl.k >= 1 && sl.k <= P) slots.push({ kind: "rep", k: sl.k });
      else return null;
    }
    const nums = (o) => {
      const r = {};
      if (o && typeof o === "object") Object.keys(o).forEach((k) => { if (ID_RX.test(k) && Number.isFinite(Number(o[k]))) r[k] = Number(o[k]); });
      return r;
    };
    const reps = slots.filter((s) => s.kind === "rep").length;
    return {
      id: d.id, at: Number(d.at) || 0,
      n: Number.isInteger(d.n) ? d.n : p1.length * 2 + (isPid(d.exempt) ? 1 : 0),
      size: P, qualifiers: P - reps, repechage: reps,
      p1, exempt: isPid(d.exempt) ? d.exempt : null, slots,
      tiebreak: nums(d.tiebreak), consOrder: nums(d.consOrder),
    };
  }

  // ============================================================
  //  Tournois
  // ============================================================
  function listTournaments() {
    return DB.tournaments.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  function getTournament(id) { return DB.tournaments.find((t) => t.id === id) || null; }

  function createTournament(name, date) {
    const now = Date.now();
    const t = {
      v: VERSION,
      id: uid("trn"),
      name: cleanName(name, "Nouveau tournoi"),
      date: date || new Date().toISOString().slice(0, 10),
      createdAt: now,
      updatedAt: now,
      settings: defaultSettings(),
      players: [],
      draw: null,
      scores: {},
    };
    DB.tournaments.unshift(t);
    commit("création tournoi");
    return t;
  }

  /** Met à jour nom / date / réglages (patch partiel). */
  function updateTournament(id, patch) {
    const t = getTournament(id);
    if (!t) return null;
    patch = patch || {};
    if (patch.name != null) t.name = cleanName(patch.name, t.name);
    if (patch.date != null) t.date = patch.date;
    if (patch.settings) t.settings = normSettings(Object.assign({}, t.settings, patch.settings));
    touch(t);
    commit("maj tournoi");
    return t;
  }

  function deleteTournament(id) {
    const i = DB.tournaments.findIndex((t) => t.id === id);
    if (i >= 0) { DB.tournaments.splice(i, 1); commit("suppression tournoi"); }
  }

  // ============================================================
  //  Joueurs
  // ============================================================
  const DRAWN_MSG = "Le tirage est déjà fait : refaites le tirage pour modifier la liste des joueurs.";

  function addPlayer(tid, name, extra) {
    const t = getTournament(tid);
    if (!t) return { error: "Tournoi introuvable." };
    if (t.draw) return { error: DRAWN_MSG };
    name = cleanName(name, "");
    if (!name) return { error: "Le nom est requis." };
    const p = normPlayer(Object.assign({}, extra || {}, { id: uid("ply"), name }));
    t.players.push(p);
    touch(t); commit("ajout joueur");
    return { ok: true, player: p };
  }

  /** Ajout en masse : un nom par ligne (ou tableau de noms). */
  function addPlayers(tid, names) {
    const t = getTournament(tid);
    if (!t) return { error: "Tournoi introuvable." };
    if (t.draw) return { error: DRAWN_MSG };
    const list = (Array.isArray(names) ? names : String(names || "").split(/\r?\n/))
      .map((n) => cleanName(String(n || "").replace(/^\s*\d+[.)-]\s*/, ""), ""))
      .filter(Boolean);
    list.forEach((name) => t.players.push(normPlayer({ id: uid("ply"), name })));
    if (list.length) { touch(t); commit("ajout joueurs"); }
    return { ok: true, added: list.length };
  }

  function updatePlayer(tid, pid, patch) {
    const t = getTournament(tid);
    if (!t) return { error: "Tournoi introuvable." };
    const p = t.players.find((x) => x.id === pid);
    if (!p) return { error: "Joueur introuvable." };
    if (patch && patch.name != null) {
      const n = cleanName(patch.name, "");
      if (!n) return { error: "Le nom est requis." };
      p.name = n;
    }
    ["club", "rating", "note"].forEach((k) => { if (patch && patch[k] != null) p[k] = String(patch[k]); });
    Object.assign(p, normPlayer(p));
    touch(t); commit("maj joueur");
    return { ok: true, player: p };
  }

  function removePlayer(tid, pid) {
    const t = getTournament(tid);
    if (!t) return { error: "Tournoi introuvable." };
    if (t.draw) return { error: DRAWN_MSG };
    const n = t.players.length;
    t.players = t.players.filter((x) => x.id !== pid);
    if (t.players.length !== n) { touch(t); commit("retrait joueur"); }
    return { ok: true };
  }

  function playerName(t, pid) {
    if (pid === "BYE") return "Exempt";
    if (!pid) return "—";
    const p = t && t.players.find((x) => x.id === pid);
    return p ? p.name : "—";
  }

  // ============================================================
  //  Plan (aperçu de la structure pour N joueurs)
  // ============================================================
  function plan(n) {
    n = Math.max(0, parseInt(n, 10) || 0);
    if (n < 2) return { ok: false, n, error: "Il faut au moins 2 joueurs." };
    const phase1Matches = Math.floor(n / 2);
    const exempt = n % 2 === 1;
    const qualifiers = phase1Matches + (exempt ? 1 : 0);
    const size = nextPow2(qualifiers);
    const repechage = size - qualifiers;
    const consolante = Math.max(0, phase1Matches - repechage);
    return { ok: true, n, phase1Matches, exempt, qualifiers, size, repechage, consolante, mainRounds: log2(size) };
  }

  // ============================================================
  //  Tirage au sort
  // ============================================================
  function drawTournament(tid) {
    const t = getTournament(tid);
    if (!t) return { error: "Tournoi introuvable." };
    const ids = t.players.map((p) => p.id);
    const pl = plan(ids.length);
    if (!pl.ok) return { error: pl.error };

    const order = shuffle(ids);
    const p1 = [];
    for (let i = 0; i + 1 < order.length; i += 2) p1.push({ id: "p1-" + p1.length, a: order[i], b: order[i + 1] });
    const exempt = order.length % 2 ? order[order.length - 1] : null;

    let direct = p1.map((m) => ({ kind: "match", ref: m.id }));
    if (exempt) direct.push({ kind: "bye", pid: exempt });
    direct = shuffle(direct);
    const W = direct.length, P = nextPow2(W);
    // Places de repêchage = têtes de série W+1..P : elles affrontent toujours
    // un qualifié direct, et sont réparties uniformément dans le tableau.
    const slots = seedOrder(P).map((seed) => (seed <= W ? direct[seed - 1] : { kind: "rep", k: seed - W }));

    const tiebreak = {}, consOrder = {};
    ids.forEach((id) => { tiebreak[id] = rand(); consOrder[id] = rand(); });

    t.draw = { id: uid("drw"), at: Date.now(), n: ids.length, size: P, qualifiers: W, repechage: P - W, p1, exempt, slots, tiebreak, consOrder };
    t.scores = {};
    touch(t);
    commit("tirage");
    // Nettoyage serveur des scores d'un AUTRE tirage (jamais ceux de celui-ci).
    if (cloudOn() && TG.Cloud.pushResetScores) TG.Cloud.pushResetScores(t.id, t.draw.id);
    return { ok: true };
  }

  /** Annule le tirage (et tous les scores). */
  function resetDraw(tid) {
    const t = getTournament(tid);
    if (!t) return { error: "Tournoi introuvable." };
    t.draw = null;
    t.scores = {};
    touch(t);
    commit("annulation tirage");
    if (cloudOn() && TG.Cloud.pushResetScores) TG.Cloud.pushResetScores(t.id, null);
    return { ok: true };
  }

  // ============================================================
  //  Moteur : calcul de l'état (fonction pure, mise en cache)
  // ============================================================
  const ROUND_NAMES = ["Finale", "Demi-finales", "Quarts de finale", "8es de finale", "16es de finale", "32es de finale", "64es de finale"];
  function roundName(totalRounds, r) {
    const fromEnd = totalRounds - r;
    return ROUND_NAMES[fromEnd] || ("Tour " + r);
  }
  function mainPointsFor(s, K, r) {
    const fromEnd = K - r;
    const v = s.mainPoints && s.mainPoints[fromEnd];
    return v || s.mainPoints[s.mainPoints.length - 1] || 7;
  }

  function state(t) {
    if (!t) return null;
    const c = cache.get(t);
    if (c && c.epoch === epoch) return c.state;
    const st = computeState(t);
    cache.set(t, { epoch, state: st });
    return st;
  }

  function computeState(t) {
    const s = normSettings(t.settings);
    const pl = plan((t.players || []).length);
    const st = {
      drawn: false,
      plan: pl,
      phase1: { matches: [], done: false, played: 0, total: 0 },
      main: { rounds: [], size: 0, totalRounds: 0 },
      leaves: [],
      repechage: { needed: 0, resolved: false, ranking: [], picks: [] },
      consolante: null,
      champion: null,
      exempt: null,
      byId: {},
      all: [],
      progress: { played: 0, total: 0 },
    };
    const d = t.draw;
    if (!d) return st;
    st.drawn = true;
    const S = t.scores || {};
    const byId = st.byId, all = st.all;

    function mk(stage, round, index, id, points) {
      const m = {
        id, stage, round, index, points,
        p1: null, p2: null, src1: null, src2: null,
        score1: null, score2: null, winner: null, loser: null,
        status: "pending", bye: false, next: null, at: null,
      };
      byId[id] = m; all.push(m);
      return m;
    }
    function winnerOf(m) { return m && m.status === "done" ? m.winner : null; }
    function settle(m) {
      if (m.p1 === "BYE" || m.p2 === "BYE") {
        if (m.p1 && m.p2) {
          m.winner = m.p1 === "BYE" ? m.p2 : m.p1;
          m.loser = "BYE"; m.status = "done"; m.bye = true;
        } else m.status = "pending";
        return;
      }
      if (!m.p1 || !m.p2) { m.status = "pending"; return; }
      const r = S[m.id];
      if (r && r.draw === d.id) {
        let a = null, b = null;
        if (r.p1 === m.p1 && r.p2 === m.p2) { a = r.s1; b = r.s2; }
        else if (r.p1 === m.p2 && r.p2 === m.p1) { a = r.s2; b = r.s1; }
        if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
          m.score1 = a; m.score2 = b;
          m.winner = a > b ? m.p1 : m.p2;
          m.loser = a > b ? m.p2 : m.p1;
          m.status = "done"; m.at = r.at || null;
          return;
        }
        m.staleScore = true;     // score enregistré pour d'autres joueurs → ignoré
      }
      m.status = "ready";
    }

    // ----- Phase 1 -----
    const p1 = d.p1.map((x, i) => {
      const m = mk("p1", 1, i, x.id, s.pointsPhase1);
      m.p1 = x.a; m.p2 = x.b;
      m.src1 = { type: "player" }; m.src2 = { type: "player" };
      settle(m);
      return m;
    });
    const p1Done = p1.every((m) => m.status === "done");
    st.phase1 = { matches: p1, done: p1Done, played: p1.filter((m) => m.status === "done").length, total: p1.length };
    st.exempt = d.exempt || null;

    // ----- Classement des perdants (repêchage) -----
    const R = d.slots.filter((x) => x.kind === "rep").length;
    const ranking = p1.filter((m) => m.status === "done").map((m) => {
      const lostAs1 = m.loser === m.p1;
      const pf = lostAs1 ? m.score1 : m.score2;
      const pa = lostAs1 ? m.score2 : m.score1;
      return { pid: m.loser, matchId: m.id, pf, pa, diff: pf - pa, tb: (d.tiebreak && d.tiebreak[m.loser]) || 0 };
    }).sort((x, y) => (y.pf - x.pf) || (y.diff - x.diff) || (y.tb - x.tb));
    ranking.forEach((x, i) => { x.rank = i + 1; x.inZone = i < R; x.picked = p1Done && i < R; });
    const picks = p1Done ? ranking.slice(0, R).map((x) => x.pid) : [];
    st.repechage = { needed: R, resolved: p1Done, ranking, picks };

    // ----- Tableau final -----
    const P = d.slots.length;
    const K = log2(P);
    st.main.size = P; st.main.totalRounds = K;
    const p1ById = {}; p1.forEach((m) => { p1ById[m.id] = m; });

    // Placement des repêchés sur les places réservées : par ordre de classement,
    // en évitant qu'un repêché retombe sur le joueur qui vient de le battre.
    const repAssign = {};                    // k -> pid
    if (p1Done && picks.length) {
      const repSlots = [];
      d.slots.forEach((sl, j) => { if (sl.kind === "rep") repSlots.push({ j, k: sl.k }); });
      repSlots.sort((a, b) => a.k - b.k);
      const conqueror = {};
      p1.forEach((m) => { if (m.status === "done") conqueror[m.loser] = m.winner; });
      const opponentAt = (j) => {
        const sl = d.slots[j ^ 1];
        if (!sl) return null;
        if (sl.kind === "match") { const pm = p1ById[sl.ref]; return pm && pm.status === "done" ? pm.winner : null; }
        if (sl.kind === "bye") return sl.pid;
        return null;
      };
      const forbid = (pid, r) => !!pid && !!conqueror[pid] && opponentAt(r.j) === conqueror[pid];
      const assign = repSlots.map(() => null);
      picks.forEach((pid) => {
        let i = repSlots.findIndex((r, idx) => assign[idx] === null && !forbid(pid, r));
        if (i < 0) i = assign.findIndex((x) => x === null);
        if (i >= 0) assign[i] = pid;
      });
      for (let i = 0; i < assign.length; i++) {
        if (!forbid(assign[i], repSlots[i])) continue;
        for (let j = 0; j < assign.length; j++) {
          if (j !== i && !forbid(assign[i], repSlots[j]) && !forbid(assign[j], repSlots[i])) {
            const x = assign[i]; assign[i] = assign[j]; assign[j] = x;
            break;
          }
        }
      }
      repSlots.forEach((r, idx) => { if (assign[idx]) repAssign[r.k] = assign[idx]; });
    }
    st.repechage.assign = repAssign;

    st.leaves = d.slots.map((sl, i) => {
      if (sl.kind === "match") return { kind: "match", slot: i, match: p1ById[sl.ref] };
      if (sl.kind === "bye") return { kind: "exempt", slot: i, pid: sl.pid };
      return { kind: "rep", slot: i, k: sl.k, pid: p1Done ? (repAssign[sl.k] || null) : null };
    });

    if (P >= 2) {
      let prev = [];
      for (let i = 0; i < P / 2; i++) {
        const m = mk("main", 1, i, "m1-" + i, mainPointsFor(s, K, 1));
        [1, 2].forEach((slotNo) => {
          const sl = d.slots[2 * i + slotNo - 1];
          if (sl.kind === "match") {
            const pm = p1ById[sl.ref];
            m["src" + slotNo] = { type: "p1", matchId: sl.ref };
            m["p" + slotNo] = winnerOf(pm);
            if (pm) pm.next = { id: m.id, slot: slotNo };
          } else if (sl.kind === "bye") {
            m["src" + slotNo] = { type: "exempt", pid: sl.pid };
            m["p" + slotNo] = sl.pid;
          } else {
            m["src" + slotNo] = { type: "rep", k: sl.k };
            m["p" + slotNo] = p1Done ? (repAssign[sl.k] || "BYE") : null;
          }
        });
        settle(m);
        prev.push(m);
      }
      st.main.rounds.push(prev);
      for (let r = 2; r <= K; r++) {
        const cur = [];
        for (let i = 0; i < prev.length / 2; i++) {
          const m = mk("main", r, i, "m" + r + "-" + i, mainPointsFor(s, K, r));
          const a = prev[2 * i], b = prev[2 * i + 1];
          a.next = { id: m.id, slot: 1 }; b.next = { id: m.id, slot: 2 };
          m.src1 = { type: "winner", matchId: a.id }; m.src2 = { type: "winner", matchId: b.id };
          m.p1 = winnerOf(a); m.p2 = winnerOf(b);
          settle(m);
          cur.push(m);
        }
        st.main.rounds.push(cur);
        prev = cur;
      }
      const fin = st.main.rounds[K - 1][0];
      st.champion = fin.status === "done" && fin.winner !== "BYE" ? fin.winner : null;
    } else if (p1.length === 1) {
      // 2 joueurs : le match de phase 1 EST la finale.
      p1[0].isFinal = true;
      p1[0].points = s.mainPoints[0];
      st.champion = p1[0].status === "done" ? p1[0].winner : null;
    }

    // ----- Consolante -----
    if (s.consolante && p1Done) {
      const pickSet = {};
      picks.forEach((p) => { pickSet[p] = true; });
      const co = d.consOrder || d.tiebreak || {};
      const entrants = ranking.map((x) => x.pid).filter((p) => !pickSet[p])
        .sort((a, b) => ((co[b] || 0) - (co[a] || 0)) || (a < b ? -1 : 1));
      if (entrants.length >= 2) {
        const C = entrants.length, Pc = nextPow2(C), Kc = log2(Pc);
        const seats = seedOrder(Pc).map((seed) => (seed <= C ? entrants[seed - 1] : "BYE"));
        const rounds = [];
        let prev = [];
        for (let i = 0; i < Pc / 2; i++) {
          const m = mk("cons", 1, i, "c1-" + i, s.consolePoints);
          m.p1 = seats[2 * i]; m.p2 = seats[2 * i + 1];
          m.src1 = { type: "player" }; m.src2 = { type: "player" };
          settle(m);
          prev.push(m);
        }
        rounds.push(prev);
        for (let r = 2; r <= Kc; r++) {
          const cur = [];
          for (let i = 0; i < prev.length / 2; i++) {
            const m = mk("cons", r, i, "c" + r + "-" + i, s.consolePoints);
            const a = prev[2 * i], b = prev[2 * i + 1];
            a.next = { id: m.id, slot: 1 }; b.next = { id: m.id, slot: 2 };
            m.src1 = { type: "winner", matchId: a.id }; m.src2 = { type: "winner", matchId: b.id };
            m.p1 = winnerOf(a); m.p2 = winnerOf(b);
            settle(m);
            cur.push(m);
          }
          rounds.push(cur);
          prev = cur;
        }
        const fin = rounds[Kc - 1][0];
        st.consolante = {
          rounds, size: Pc, totalRounds: Kc, entrants,
          champion: fin.status === "done" && fin.winner !== "BYE" ? fin.winner : null,
        };
      }
    }

    const real = all.filter((m) => !m.bye);
    st.progress = {
      played: real.filter((m) => m.status === "done").length,
      total: real.length,
      ready: real.filter((m) => m.status === "ready").length,
    };
    return st;
  }

  // ============================================================
  //  Statut d'un joueur (que doit-il faire maintenant ?)
  // ============================================================
  /**
   * kind :
   *  - notDrawn        : tirage pas encore fait
   *  - play            : un match l'attend (match, opponent)
   *  - wait            : son prochain match attend un adversaire (match, waitFor)
   *  - repechable      : perdu en phase 1, phase 1 en cours (rank, needed, inZone)
   *  - champion        : vainqueur du tableau final
   *  - consoleChampion : vainqueur de la consolante
   *  - out             : éliminé
   */
  function playerStatus(t, pid) {
    const st = state(t);
    if (!st || !st.drawn) return { kind: "notDrawn" };
    const mine = (m) => m.p1 === pid || m.p2 === pid;
    const ready = st.all.find((m) => m.status === "ready" && mine(m));
    if (ready) return { kind: "play", match: ready, opponent: ready.p1 === pid ? ready.p2 : ready.p1 };
    const pend = st.all.find((m) => m.status === "pending" && mine(m));
    if (pend) {
      const otherSlot = pend.p1 === pid ? 2 : 1;
      return { kind: "wait", match: pend, waitFor: pend["src" + otherSlot] };
    }
    if (st.champion === pid) return { kind: "champion" };
    if (st.consolante && st.consolante.champion === pid) return { kind: "consoleChampion" };
    const lostP1 = st.phase1.matches.find((m) => m.status === "done" && m.loser === pid);
    if (lostP1 && !st.phase1.done) {
      const r = st.repechage.ranking.find((x) => x.pid === pid);
      return { kind: "repechable", rank: r ? r.rank : null, needed: st.repechage.needed, inZone: !!(r && r.inZone), pf: r ? r.pf : null };
    }
    return { kind: "out" };
  }

  /** Statistiques d'un joueur sur tous ses matchs joués (hors exempts). */
  function playerStats(t, pid) {
    const s = { played: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 };
    const st = state(t);
    if (!st) return s;
    st.all.forEach((m) => {
      if (m.status !== "done" || m.bye) return;
      let mine, opp;
      if (m.p1 === pid) { mine = m.score1; opp = m.score2; }
      else if (m.p2 === pid) { mine = m.score2; opp = m.score1; }
      else return;
      s.played++; s.pointsFor += mine || 0; s.pointsAgainst += opp || 0;
      if (m.winner === pid) s.wins++; else s.losses++;
    });
    return s;
  }

  // ============================================================
  //  Scores
  // ============================================================
  function recordScore(tid, matchId, s1, s2, opts) {
    opts = opts || {};
    const t = getTournament(tid);
    if (!t || !t.draw) return { error: "Tirage non effectué." };
    const before = state(t);
    const m = before.byId[matchId];
    if (!m) return { error: "Match introuvable." };
    if (m.bye) return { error: "Ce joueur est exempt pour ce tour." };
    if (m.status === "pending") return { error: "Ce match n'est pas encore prêt : l'adversaire n'est pas connu." };
    if (m.status === "done" && !opts.overwrite) return { error: "Ce match a déjà un résultat." };
    s1 = parseInt(s1, 10); s2 = parseInt(s2, 10);
    if (!Number.isFinite(s1) || !Number.isFinite(s2) || s1 < 0 || s2 < 0) return { error: "Scores invalides." };
    if (s1 > 99 || s2 > 99) return { error: "Score trop élevé." };
    if (s1 === s2) return { error: "Pas d'égalité possible au backgammon." };

    const prev = t.scores && t.scores[matchId];
    const rec = { s1, s2, p1: m.p1, p2: m.p2, draw: t.draw.id, at: Math.max(Date.now(), prev && prev.draw === t.draw.id ? (prev.at || 0) + 1 : 0) };
    t.scores = t.scores || {};
    t.scores[matchId] = rec;
    persistLocal();
    emit();
    if (cloudOn() && TG.Cloud.pushScore) TG.Cloud.pushScore(t.id, matchId, rec, { overwrite: !!opts.overwrite });
    const after = state(t);
    return { ok: true, outcome: outcomeOf(t, before, after, matchId) };
  }

  /** Efface le score d'un match (correction par l'organisateur). */
  function clearScore(tid, matchId) {
    const t = getTournament(tid);
    if (!t || !t.scores || !t.scores[matchId]) return { error: "Aucun score à effacer." };
    delete t.scores[matchId];
    persistLocal();
    emit();
    if (cloudOn() && TG.Cloud.pushUnscore) TG.Cloud.pushUnscore(t.id, matchId);
    return { ok: true };
  }

  /** Matchs déjà joués qui seraient annulés si l'on effaçait ce score. */
  function clearImpact(t, matchId) {
    const cur = state(t);
    if (!cur || !t.scores || !t.scores[matchId]) return [];
    const clone = Object.assign({}, t, { scores: Object.assign({}, t.scores) });
    delete clone.scores[matchId];
    const sim = computeState(clone);
    return cur.all.filter((m) => m.id !== matchId && !m.bye && m.status === "done" && !(sim.byId[m.id] && sim.byId[m.id].status === "done" && sim.byId[m.id].winner === m.winner));
  }

  /**
   * Simule une correction (s1/s2) ou un effacement (s1 = null) et décrit
   * TOUT ce qui changerait : réouverture de la phase 1, repêchés sortants /
   * entrants, consolante créée / retirée / redistribuée, matchs déjà joués
   * qui ne compteraient plus, matchs à jouer qui changeraient d'adversaire.
   */
  function simulate(t, matchId, s1, s2) {
    const cur = state(t);
    const empty = { none: true, phase1Reopened: false, phase1Completed: false, picksOut: [], picksIn: [], consolanteRemoved: false, consolanteCreated: false, consolanteChanged: false, cancelled: [], reassigned: [], winnerChanged: false, championChanged: false };
    if (!cur || !cur.drawn) return empty;
    const m = cur.byId[matchId];
    const scores = Object.assign({}, t.scores || {});
    if (s1 == null) delete scores[matchId];
    else if (m) scores[matchId] = { s1: parseInt(s1, 10), s2: parseInt(s2, 10), p1: m.p1, p2: m.p2, draw: t.draw.id, at: Date.now() };
    const sim = computeState(Object.assign({}, t, { scores }));
    const has = (arr, x) => arr.indexOf(x) >= 0;
    const diff = {
      phase1Reopened: cur.phase1.done && !sim.phase1.done,
      phase1Completed: !cur.phase1.done && sim.phase1.done,
      picksOut: cur.repechage.picks.filter((p) => !has(sim.repechage.picks, p)),
      picksIn: sim.repechage.picks.filter((p) => !has(cur.repechage.picks, p)),
      consolanteRemoved: !!cur.consolante && !sim.consolante,
      consolanteCreated: !cur.consolante && !!sim.consolante,
      consolanteChanged: !!cur.consolante && !!sim.consolante && JSON.stringify(cur.consolante.entrants) !== JSON.stringify(sim.consolante.entrants),
      cancelled: cur.all.filter((x) => x.id !== matchId && !x.bye && x.status === "done" &&
        !(sim.byId[x.id] && sim.byId[x.id].status === "done" && sim.byId[x.id].winner === x.winner)),
      reassigned: cur.all.filter((x) => {
        if (x.id === matchId || x.bye || x.status === "done") return false;
        const y = sim.byId[x.id];
        if (!(x.p1 || x.p2)) return false;
        if (!y) return true;
        return x.p1 !== y.p1 || x.p2 !== y.p2;
      }).map((x) => ({ match: x, before: [x.p1, x.p2], after: sim.byId[x.id] ? [sim.byId[x.id].p1, sim.byId[x.id].p2] : [null, null] })),
      winnerChanged: !!(m && m.status === "done" && (!sim.byId[matchId] || sim.byId[matchId].winner !== m.winner)),
      championChanged: cur.champion !== sim.champion,
    };
    diff.none = !diff.phase1Reopened && !diff.picksOut.length && !diff.picksIn.length && !diff.consolanteRemoved &&
      !diff.consolanteCreated && !diff.consolanteChanged && !diff.cancelled.length && !diff.reassigned.length;
    return diff;
  }

  /** Résumé d'un résultat pour la fenêtre de confirmation. */
  function outcomeOf(t, before, after, matchId) {
    const m = after.byId[matchId];
    const o = {
      match: m,
      winner: m.winner, loser: m.loser,
      winnerStatus: playerStatus(t, m.winner),
      loserStatus: playerStatus(t, m.loser),
      phase1Completed: !before.phase1.done && after.phase1.done,
      repechage: null,
      consolanteCreated: !before.consolante && !!after.consolante,
      champion: !before.champion && after.champion ? after.champion : null,
      consoleChampion: (!before.consolante || !before.consolante.champion) && after.consolante && after.consolante.champion ? after.consolante.champion : null,
    };
    if (o.phase1Completed) o.repechage = after.repechage;
    return o;
  }

  // ============================================================
  //  Import / export / cloud
  // ============================================================
  /** Remplace toute la base (chargement cloud). */
  function replaceAll(db) {
    if (db && Array.isArray(db.tournaments)) {
      DB = { tournaments: db.tournaments.map(migrate).filter(Boolean) };
      persistLocal();
      emit();
    }
  }
  function importTournament(t) {
    t = migrate(t);
    if (!t) return;
    const i = DB.tournaments.findIndex((x) => x.id === t.id);
    if (i >= 0) DB.tournaments[i] = t; else DB.tournaments.push(t);
    persistLocal(); emit();
  }
  function snapshot() { return DB; }
  /** Structure d'un tournoi SANS les scores (ce qui est synchronisé en bloc). */
  function structureOf(t) {
    const o = Object.assign({}, t);
    delete o.scores;
    return o;
  }

  // ----- Exposition -----
  window.TG = window.TG || {};
  TG.Store = {
    VERSION,
    load, onChange, snapshot, commit, persistLocal, uid,
    listTournaments, getTournament, createTournament, updateTournament, deleteTournament,
    addPlayer, addPlayers, updatePlayer, removePlayer, playerName,
    plan, drawTournament, resetDraw,
    state, playerStatus, playerStats, roundName,
    recordScore, clearScore, clearImpact, simulate,
    onStorageError, getStorageError,
    replaceAll, importTournament, structureOf, migrate,
    defaultSettings, normSettings,
    // utilitaires (tests)
    _nextPow2: nextPow2, _seedOrder: seedOrder, _computeState: computeState,
  };
})();
