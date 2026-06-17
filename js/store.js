/* ============================================================
   store.js — Modèle de données + logique de tournoi
   Persistance : miroir local (localStorage) + synchro cloud
   partagée via cloud.js (fonction serverless Vercel + Vercel KV).
   ============================================================ */
(function () {
  "use strict";

  const LS_KEY = "tg_backgammon_db_v1";

  // ----- État en mémoire -----
  let DB = { tournaments: [] };
  const listeners = [];

  function uid(prefix) {
    return (prefix || "id") + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) DB = JSON.parse(raw);
    } catch (e) { console.warn("Lecture DB locale impossible", e); }
    if (!DB || typeof DB !== "object") DB = { tournaments: [] };
    if (!Array.isArray(DB.tournaments)) DB.tournaments = [];
    return DB;
  }

  function persistLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); } catch (e) { console.warn(e); }
  }

  function emit() { listeners.forEach((fn) => { try { fn(DB); } catch (e) { console.error(e); } }); }

  function onChange(fn) { listeners.push(fn); }

  /** Horodate un tournoi (sert à départager les conflits lors de la fusion cloud). */
  function touch(t) { if (t) t.updatedAt = Date.now(); return t; }

  /** Sauvegarde locale + déclenche la sync cloud (si configurée). */
  function commit(reason) {
    persistLocal();
    emit();
    if (window.TG && TG.Cloud && TG.Cloud.isCloud()) {
      TG.Cloud.scheduleSync(reason || "maj");
    }
  }

  // ============================================================
  //  Tournois
  // ============================================================
  function defaultSettings() {
    return {
      format: "single",          // single | double (repêchage)
      expectedPlayers: 8,
      roundValues: [],           // [{round:1, points:7}, ...]
      repechage: false,          // repêche les perdants (poule des perdants)
      secondaryPool: false,      // poule secondaire affichée à part
      autoRotate: true,          // rotation auto des vues du tournoi
      rotateSeconds: 30,
      rules: "Tournoi à élimination directe. Le premier joueur atteignant le nombre de points de la manche remporte le match.",
    };
  }

  function listTournaments() {
    return DB.tournaments.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function getTournament(id) {
    return DB.tournaments.find((t) => t.id === id) || null;
  }

  function createTournament(name, date) {
    const t = {
      id: uid("trn"),
      name: name || "Nouveau tournoi",
      date: date || new Date().toISOString().slice(0, 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings: defaultSettings(),
      players: [],
      bracket: null,            // { rounds, matches } pour la poule principale
      secondary: null,          // bracket de la poule secondaire / repêchage
      generatedAt: null,
    };
    DB.tournaments.unshift(t);
    commit("création tournoi " + t.name);
    return t;
  }

  function updateTournament(id, patch) {
    const t = getTournament(id);
    if (!t) return null;
    Object.assign(t, patch);
    touch(t);
    commit("maj tournoi " + t.name);
    return t;
  }

  function deleteTournament(id) {
    const i = DB.tournaments.findIndex((t) => t.id === id);
    if (i >= 0) {
      const name = DB.tournaments[i].name;
      DB.tournaments.splice(i, 1);
      commit("suppression tournoi " + name);
    }
  }

  // ============================================================
  //  Joueurs
  // ============================================================
  function addPlayer(tid, name, extra) {
    const t = getTournament(tid);
    if (!t) return null;
    const p = Object.assign({ id: uid("ply"), name: name || "Joueur", rating: null, club: "", note: "" }, extra || {});
    t.players.push(p);
    touch(t);
    commit("ajout joueur " + p.name);
    return p;
  }

  function updatePlayer(tid, pid, patch) {
    const t = getTournament(tid);
    if (!t) return null;
    const p = t.players.find((x) => x.id === pid);
    if (!p) return null;
    Object.assign(p, patch);
    touch(t);
    commit("maj joueur " + p.name);
    return p;
  }

  function removePlayer(tid, pid) {
    const t = getTournament(tid);
    if (!t) return;
    t.players = t.players.filter((x) => x.id !== pid);
    touch(t);
    commit("retrait joueur");
  }

  function playerName(t, pid) {
    if (pid === "BYE") return "Exempt";
    const p = t.players.find((x) => x.id === pid);
    return p ? p.name : "—";
  }

  /** Statistiques agrégées d'un joueur sur tous les matches terminés. */
  function playerStats(t, pid) {
    const s = { played: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 };
    const all = allMatches(t);
    all.forEach((m) => {
      if (m.status !== "done") return;
      if (m.p1 === "BYE" || m.p2 === "BYE") return;
      let mine = null, opp = null;
      if (m.p1 === pid) { mine = m.score1; opp = m.score2; }
      else if (m.p2 === pid) { mine = m.score2; opp = m.score1; }
      else return;
      s.played++;
      s.pointsFor += (mine || 0);
      s.pointsAgainst += (opp || 0);
      if (m.winner === pid) s.wins++; else s.losses++;
    });
    return s;
  }

  function allMatches(t) {
    const out = [];
    if (t.bracket) t.bracket.matches.forEach((m) => out.push(m));
    if (t.secondary) t.secondary.matches.forEach((m) => out.push(m));
    return out;
  }

  // ============================================================
  //  Génération du bracket (élimination directe)
  // ============================================================
  function nextPow2(n) { let p = 1; while (p < n) p *= 2; return Math.max(2, p); }

  /** Ordre de placement standard des têtes de série pour une taille donnée. */
  function seedOrder(size) {
    let order = [1, 2];
    while (order.length < size) {
      const sum = order.length * 2 + 1;
      const next = [];
      for (const s of order) { next.push(s); next.push(sum - s); }
      order = next;
    }
    return order;
  }

  function pointsForRound(t, round) {
    const rv = (t.settings.roundValues || []).find((r) => r.round === round);
    return rv ? rv.points : null;
  }

  /**
   * Construit un bracket à élimination directe.
   * @param entrants  liste d'ids de joueurs (ordre = têtes de série)
   * @param tag       'main' | 'sec'
   * @param roundOffset  décalage de numéro de manche (pour la valeur des points)
   */
  function buildBracket(entrants, tag, roundOffset) {
    roundOffset = roundOffset || 0;
    const size = nextPow2(entrants.length);
    const totalRounds = Math.log2(size);
    const order = seedOrder(size); // ex pour 8 : [1,8,5,4,3,6,7,2]

    // Place les entrants selon l'ordre des têtes de série, comble avec BYE.
    const slots = order.map((seed) => (seed <= entrants.length ? entrants[seed - 1] : "BYE"));

    const matches = [];
    const rounds = [];

    // Manche 1
    let prevRound = [];
    const r1 = [];
    for (let i = 0; i < size; i += 2) {
      const m = makeMatch(tag, 1, r1.length, slots[i], slots[i + 1]);
      matches.push(m); r1.push(m);
    }
    rounds.push(r1);
    prevRound = r1;

    // Manches suivantes (vides, reliées)
    for (let r = 2; r <= totalRounds; r++) {
      const cur = [];
      for (let i = 0; i < prevRound.length; i += 2) {
        const m = makeMatch(tag, r, cur.length, null, null);
        prevRound[i].next = { id: m.id, slot: 1 };
        prevRound[i + 1].next = { id: m.id, slot: 2 };
        matches.push(m); cur.push(m);
      }
      rounds.push(cur);
      prevRound = cur;
    }

    const bracket = {
      tag,
      size,
      totalRounds,
      roundOffset,
      matches,
      // index des manches par numéro (pour le rendu)
      rounds: rounds.map((arr) => arr.map((m) => m.id)),
    };

    // Résout les exempts (BYE) en chaîne.
    bracket.matches.forEach((m) => resolveBye(bracket, m));
    return bracket;
  }

  function makeMatch(tag, round, index, p1, p2) {
    return {
      id: uid("m"),
      tag, round, index,
      p1: p1 || null, p2: p2 || null,
      score1: null, score2: null,
      winner: null, loser: null,
      status: "pending",      // pending | ready | done
      next: null,             // { id, slot }
    };
  }

  function findMatch(bracket, id) { return bracket.matches.find((m) => m.id === id); }

  /** Met à jour le statut + propage les exempts automatiquement. */
  function resolveBye(bracket, m) {
    if (m.status === "done") return;
    const p1 = m.p1, p2 = m.p2;
    if (p1 && p2) {
      if (p1 === "BYE" && p2 === "BYE") return advance(bracket, m, "BYE", "BYE", null, null, true);
      else if (p1 === "BYE") return advance(bracket, m, p2, "BYE", null, null, true);
      else if (p2 === "BYE") return advance(bracket, m, p1, "BYE", null, null, true);
      else m.status = "ready";
    } else {
      m.status = "pending";
    }
  }

  function matchStatus(bracket, m) {
    if (m.status === "done") return "done";
    if (m.p1 && m.p2 && m.p1 !== "BYE" && m.p2 !== "BYE") return "ready";
    return "pending";
  }

  /** Enregistre le vainqueur et propage vers la manche suivante. */
  function advance(bracket, m, winnerId, loserId, s1, s2, isBye) {
    m.winner = winnerId;
    m.loser = loserId;
    m.score1 = s1; m.score2 = s2;
    m.status = "done";
    m.bye = !!isBye;
    if (m.next) {
      const nm = findMatch(bracket, m.next.id);
      if (nm) {
        if (m.next.slot === 1) nm.p1 = winnerId; else nm.p2 = winnerId;
        resolveBye(bracket, nm);
      }
    }
  }

  /**
   * Génère le(s) bracket(s) du tournoi à partir de la liste des joueurs.
   * @param tid
   * @param opts { shuffle:bool }
   */
  function generateBracket(tid, opts) {
    opts = opts || {};
    const t = getTournament(tid);
    if (!t) return null;
    const ids = t.players.map((p) => p.id);
    if (ids.length < 2) return { error: "Il faut au moins 2 joueurs." };

    let entrants = ids.slice();
    if (opts.shuffle) {
      for (let i = entrants.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [entrants[i], entrants[j]] = [entrants[j], entrants[i]];
      }
    }

    t.bracket = buildBracket(entrants, "main", 0);
    t.secondary = null;

    // Poule secondaire / repêchage : on prépare un bracket pour les perdants
    // de la 1re manche de la poule principale.
    if (t.settings.repechage || t.settings.secondaryPool) {
      const r1ids = t.bracket.rounds[0];
      const realSize = nextPow2(r1ids.length);
      t.secondary = buildSecondary(r1ids, realSize);
      // lie chaque match principal de manche 1 à un siège de la secondaire
      mapLosersToSecondary(t);
      // Propage les perdants déjà connus (matches de manche 1 résolus par exempt).
      propagateExistingLosers(t);
    }

    t.generatedAt = Date.now();
    // recalcul des statuts initiaux
    syncStatuses(t);
    touch(t);
    commit("génération du tableau");
    return { ok: true };
  }

  /** Bracket secondaire : les perdants de la manche 1 principale y entrent. */
  function buildSecondary(mainR1Ids, size) {
    const totalRounds = Math.log2(size);
    const order = seedOrder(size);
    const matches = [];
    const rounds = [];

    const r1 = [];
    for (let i = 0; i < size; i += 2) {
      const m = makeMatch("sec", 1, r1.length, null, null);
      matches.push(m); r1.push(m);
    }
    rounds.push(r1);
    let prev = r1;
    for (let r = 2; r <= totalRounds; r++) {
      const cur = [];
      for (let i = 0; i < prev.length; i += 2) {
        const m = makeMatch("sec", r, cur.length, null, null);
        prev[i].next = { id: m.id, slot: 1 };
        prev[i + 1].next = { id: m.id, slot: 2 };
        matches.push(m); cur.push(m);
      }
      rounds.push(cur);
      prev = cur;
    }
    return {
      tag: "sec", size, totalRounds, roundOffset: 0, matches,
      rounds: rounds.map((arr) => arr.map((m) => m.id)),
      // table de correspondance : seat -> { matchId, slot } pour recevoir les perdants
      loserSlots: [],
    };
  }

  /** Associe chaque match principal de manche 1 à un siège de la secondaire. */
  function mapLosersToSecondary(t) {
    const sec = t.secondary;
    const main = t.bracket;
    const r1 = main.rounds[0]; // ids des matches principaux manche 1
    const secR1 = sec.rounds[0]; // ids matches secondaire manche 1
    sec.loserSlots = [];
    // Place les perdants par paires dans les matches de la secondaire (ordre du bracket)
    let seat = 0;
    secR1.forEach((mid) => {
      const sm = findMatch(sec, mid);
      // deux sièges p1, p2
      [1, 2].forEach((slot) => {
        const mainMid = r1[seat];
        if (mainMid) {
          sec.loserSlots.push({ mainMatchId: mainMid, secMatchId: mid, slot });
        } else {
          // pas de perdant -> exempt
          if (slot === 1) sm.p1 = "BYE"; else sm.p2 = "BYE";
        }
        seat++;
      });
    });
    // Si nombre impair de perdants, comble les sièges restants par BYE
    secR1.forEach((mid) => {
      const sm = findMatch(sec, mid);
      if (sm.p1 === null && !sec.loserSlots.find((l) => l.secMatchId === mid && l.slot === 1)) sm.p1 = "BYE";
      if (sm.p2 === null && !sec.loserSlots.find((l) => l.secMatchId === mid && l.slot === 2)) sm.p2 = "BYE";
    });
  }

  /** Fait descendre le perdant d'un match principal de manche 1 vers la secondaire. */
  function dropLoserToSecondary(t, mainMatch) {
    if (!t.secondary || !t.secondary.loserSlots) return;
    const link = t.secondary.loserSlots.find((l) => l.mainMatchId === mainMatch.id);
    if (!link) return;
    const sm = findMatch(t.secondary, link.secMatchId);
    if (!sm) return;
    const loser = mainMatch.loser; // peut être "BYE"
    if (link.slot === 1) sm.p1 = loser; else sm.p2 = loser;
    resolveBye(t.secondary, sm);
  }

  /** À la génération : descend les perdants des matches déjà résolus (exempts). */
  function propagateExistingLosers(t) {
    if (!t.secondary) return;
    t.bracket.rounds[0].forEach((mid) => {
      const m = findMatch(t.bracket, mid);
      if (m && m.status === "done") dropLoserToSecondary(t, m);
    });
    syncStatuses(t);
  }

  /** Recalcule les statuts ready/pending de tous les matches. */
  function syncStatuses(t) {
    [t.bracket, t.secondary].forEach((b) => {
      if (!b) return;
      b.matches.forEach((m) => { if (m.status !== "done") m.status = matchStatus(b, m); });
      b.matches.forEach((m) => resolveBye(b, m));
    });
  }

  // ============================================================
  //  Saisie de scores
  // ============================================================
  /** Trouve le match « prêt » d'un joueur (poule principale prioritaire). */
  function findReadyMatchForPlayer(t, pid) {
    const search = (b) => {
      if (!b) return null;
      return b.matches.find((m) => m.status === "ready" && (m.p1 === pid || m.p2 === pid)) || null;
    };
    return search(t.bracket) || search(t.secondary) || null;
  }

  /** Y a-t-il un match en attente d'adversaire pour ce joueur ? */
  function findPendingMatchForPlayer(t, pid) {
    const search = (b) => {
      if (!b) return null;
      return b.matches.find((m) =>
        m.status === "pending" && (m.p1 === pid || m.p2 === pid)
      ) || null;
    };
    return search(t.bracket) || search(t.secondary) || null;
  }

  function bracketOf(t, m) {
    if (t.bracket && t.bracket.matches.includes(m)) return t.bracket;
    if (t.secondary && t.secondary.matches.includes(m)) return t.secondary;
    return null;
  }

  /**
   * Enregistre un score pour un match.
   * @returns { ok, nextMatch?, message? }
   */
  function recordScore(tid, matchId, score1, score2) {
    const t = getTournament(tid);
    if (!t) return { error: "Tournoi introuvable" };
    let m = t.bracket && findMatch(t.bracket, matchId);
    let b = t.bracket;
    if (!m && t.secondary) { m = findMatch(t.secondary, matchId); b = t.secondary; }
    if (!m) return { error: "Match introuvable" };
    if (m.status !== "ready") return { error: "Ce match n'est pas prêt à être joué." };

    score1 = parseInt(score1, 10); score2 = parseInt(score2, 10);
    if (isNaN(score1) || isNaN(score2)) return { error: "Scores invalides." };
    if (score1 === score2) return { error: "Pas d'égalité possible au backgammon." };

    const winner = score1 > score2 ? m.p1 : m.p2;
    const loser  = score1 > score2 ? m.p2 : m.p1;
    advance(b, m, winner, loser, score1, score2, false);

    // Si poule secondaire/repêchage : le perdant de la manche 1 principale
    // descend dans la secondaire.
    if (b === t.bracket && m.round === 1 && t.secondary && t.secondary.loserSlots) {
      dropLoserToSecondary(t, m);
    }

    syncStatuses(t);
    touch(t);
    commit("score enregistré");

    const next = findReadyMatchForPlayer(t, winner);
    return { ok: true, winner, next };
  }

  // ============================================================
  //  Sérialisation Markdown (base de données .md)
  // ============================================================
  function tournamentToMarkdown(t) {
    const lines = [];
    lines.push("# " + t.name);
    lines.push("");
    lines.push("- **Date** : " + (t.date || "—"));
    lines.push("- **Joueurs** : " + t.players.length);
    lines.push("- **Format** : " + (t.settings.format === "double" ? "Repêchage" : "Élimination directe"));
    lines.push("- **Poule secondaire** : " + (t.settings.secondaryPool || t.settings.repechage ? "oui" : "non"));
    lines.push("");
    if (t.players.length) {
      lines.push("## Joueurs");
      lines.push("");
      lines.push("| # | Nom | Club | Joués | V | Points |");
      lines.push("|---|-----|------|-------|---|--------|");
      t.players.forEach((p, i) => {
        const s = playerStats(t, p.id);
        lines.push(`| ${i + 1} | ${p.name} | ${p.club || ""} | ${s.played} | ${s.wins} | ${s.pointsFor} |`);
      });
      lines.push("");
    }
    const renderB = (b, title) => {
      if (!b) return;
      lines.push("## " + title);
      lines.push("");
      b.rounds.forEach((ids, ri) => {
        lines.push(`### Manche ${ri + 1}` + (pointsForRound(t, ri + 1) ? ` — ${pointsForRound(t, ri + 1)} pts` : ""));
        ids.forEach((id) => {
          const m = findMatch(b, id);
          const n1 = playerName(t, m.p1), n2 = playerName(t, m.p2);
          const sc = m.status === "done" ? ` — ${m.score1}-${m.score2}` : (m.status === "ready" ? " — à jouer" : "");
          lines.push(`- ${n1} vs ${n2}${sc}`);
        });
        lines.push("");
      });
    };
    renderB(t.bracket, "Tableau principal");
    renderB(t.secondary, "Poule secondaire");

    lines.push("## Règlement");
    lines.push("");
    lines.push(t.settings.rules || "");
    lines.push("");
    lines.push("<!-- TG-DATA: ne pas modifier à la main -->");
    lines.push("```json");
    lines.push(JSON.stringify(t, null, 2));
    lines.push("```");
    return lines.join("\n");
  }

  function tournamentFromMarkdown(md) {
    const m = md.match(/```json\s*([\s\S]*?)```/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  function indexToMarkdown() {
    const lines = ["# The Travellers — Tournois de Backgammon", "",
      "Base de données générée automatiquement. Ne pas éditer à la main.", ""];
    lines.push("| Tournoi | Date | Joueurs | Fichier |");
    lines.push("|---------|------|---------|---------|");
    listTournaments().forEach((t) => {
      lines.push(`| ${t.name} | ${t.date} | ${t.players.length} | data/tournament-${t.id}.md |`);
    });
    lines.push("");
    lines.push("<!-- TG-INDEX -->");
    lines.push("```json");
    lines.push(JSON.stringify({ ids: DB.tournaments.map((t) => t.id) }, null, 2));
    lines.push("```");
    return lines.join("\n");
  }

  /** Remplace toute la base à partir d'un objet (import / chargement cloud). */
  function replaceAll(db) {
    if (db && Array.isArray(db.tournaments)) {
      DB = db;
      persistLocal();
      emit();
    }
  }

  function importTournament(t) {
    if (!t || !t.id) return;
    const i = DB.tournaments.findIndex((x) => x.id === t.id);
    if (i >= 0) DB.tournaments[i] = t; else DB.tournaments.push(t);
    persistLocal(); emit();
  }

  function snapshot() { return DB; }

  // ----- Exposition -----
  window.TG = window.TG || {};
  TG.Store = {
    load, onChange, snapshot, commit, persistLocal,
    uid,
    listTournaments, getTournament, createTournament, updateTournament, deleteTournament,
    addPlayer, updatePlayer, removePlayer, playerName, playerStats, allMatches,
    generateBracket, recordScore, syncStatuses,
    findReadyMatchForPlayer, findPendingMatchForPlayer, findMatch, matchStatus,
    pointsForRound,
    tournamentToMarkdown, tournamentFromMarkdown, indexToMarkdown,
    replaceAll, importTournament,
    defaultSettings,
  };
})();
