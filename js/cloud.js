/* ============================================================
   cloud.js — Synchronisation « cloud » temps réel (v2.1).

   L'app dialogue avec la fonction serverless /api/store (Redis).
   Aucun token côté joueur. Si le magasin n'est pas configuré,
   l'app reste en mode « local » (localStorage), comme avant.

   Deux flux séparés :
   - STRUCTURE d'un tournoi (joueurs, réglages, tirage) : détectée par
     empreinte (diff avec le dernier état connu du cloud), envoyée en
     différé (~1 s), avec contrôle de concurrence (version + tirage de
     base) et fusion à 3 voies si deux appareils éditent en même temps :
     champs indépendants (nom, date, réglages…) fusionnés séparément,
     joueurs fusionnés UN PAR UN (par identifiant), et un tirage fait /
     refait / annulé ailleurs n'est JAMAIS défait par une édition basée
     sur l'ancien tirage (avis « drawChanged »).
   - SCORES : un enregistrement par match. Chaque saisie / effacement /
     purge est une opération mise dans une FILE PERSISTÉE
     (localStorage « tg_cloud_ops_v1 »), envoyée aussitôt et dans
     l'ordre ; en cas d'échec réseau elle est conservée et renvoyée
     (nouvel essai progressif, sondage, événement « online », ou
     au prochain chargement de la page). Côté serveur, la PREMIÈRE
     saisie d'un match gagne (sauf correction volontaire) : une saisie
     refusée est retirée et signalée (avis « conflict »).

   Lecture : sondage du compteur de révision toutes les 4 s (pause si
   l'onglet est caché) ; s'il change, le serveur donne le jeton de
   révision de chaque tournoi et l'on ne télécharge QUE les tournois
   modifiés (téléchargement complet au démarrage / « Recharger »),
   puis applyRemote : base = serveur, éditions de structure locales non
   envoyées fusionnées, et opérations de score encore en file (ou
   envoyées mais pas encore visibles dans l'instantané) superposées
   — un score saisi ne « disparaît » donc jamais de l'écran.

   Avis à l'utilisateur : TG.Cloud.onNotice(fn) → fn({kind, message, tid?, matchId?})
   kind ∈ "conflict" | "drawChanged" | "deleted" | "storage" | "info" | "update".

   Diagnostic : TG.Cloud.getInfo() → { status, pending, lastOkAt, lastError:{kind, http,
   message, at}, stuck } avec kind ∈ "network" (requête jamais arrivée au serveur),
   "timeout" (réseau trop lent), "server" (serveur joint mais en panne : message du
   serveur) ; TG.Cloud.testConnection() → test immédiat (?health=1).
   ============================================================ */
(function () {
  "use strict";

  const API = "/api/store";
  const POLL_MS = 4000;          // sondage du compteur de révision
  const DEBOUNCE_MS = 1000;      // regroupe les éditions de structure rapprochées
  const TIMEOUT_MS = 12000;      // délai max d'une requête légère (réseau mobile capricieux)
  const FULL_TIMEOUT_MS = 45000; // délai max d'un téléchargement de tournois
  const RETRY_MAX_MS = 15000;    // nouvel essai progressif : 2 s, 4 s, 8 s, 15 s…
  const INIT_RETRY_MAX_MS = 30000; // 1er démarrage sans réponse du cloud : 2 s, 4 s… 30 s
  const MAX_PARTIAL = 40;        // au-delà : téléchargement complet
  const LS_OPS = "tg_cloud_ops_v1";    // file d'opérations (persistée)
  const LS_SYNC = "tg_cloud_sync_v1";  // empreintes du dernier état connu du cloud
  const LS_DEV = "tg_cloud_dev_v1";    // identifiant de cet appareil (auteur des saisies)
  const ID_RX = /^[A-Za-z0-9_-]{1,80}$/;
  const STUCK_AFTER = 3;         // échecs serveur d'une même op avant de laisser passer les suivantes

  let mode = "local";            // local | cloud
  let status = "local";          // local | syncing | connected | error
  const statusListeners = [];
  const remoteListeners = [];
  const noticeListeners = [];
  let pendingNotices = [];       // avis émis avant le premier écouteur

  // ----- Persisté -----
  let queue = [];                // [{k, op, tid, matchId?, record?, overwrite?, draw?, at?, keepDraw?}]
  // base[tid] = { h, g:{groupe:empreinte}, d:tirage, p:{pid:empreinte}, u:updatedAt serveur,
  //               s:{matchId: at}, l?:1 (ancien format v1 côté serveur) }
  let sync = { cloud: false, base: {} };

  // ----- Mémoire -----
  let booted = false;            // bootSync réussi au moins une fois
  let bootPromise = null;
  let appliedRev = -1;           // révision du dernier instantané appliqué
  let acked = [];                // ops confirmées pas encore visibles dans un instantané
  let structAck = {};            // tid -> révision de notre dernier upsert/delete confirmé
  let conflicted = {};           // tid -> true : upsert refusé (concurrence), à refusionner
  const rejected = {};           // tid -> empreinte refusée (400) : ne pas renvoyer en boucle
  let knownRv = {};              // tid -> jeton de révision des données appliquées
  let refreshIds = {};           // tid -> à recharger même si sa révision n'a pas bougé
  let dirtyCount = 0;
  let opSeq = 0;
  const removedKeys = {};        // ops traitées / remplacées par CET onglet
  const myScores = {};           // tid -> {matchId: record} saisis par CET appareil (session)
  const staleWatch = {};         // tid -> échéance : vérifier si nos saisies suivantes sont devenues caduques

  let syncTimer = null, retryTimer = null, pollTimer = null, initTimer = null;
  let flushing = null, flushAgain = false;
  let checking = null, checkAgain = false;
  let failures = 0;
  let forceRefresh = false;      // recharger au prochain sondage (même révision)
  let forceFull = false;         // … et tout télécharger
  let eventsBound = false;
  let connecting = false;        // 1er démarrage : cloud injoignable, nouvel essai en cours
  let initFailures = 0;
  let initRetrying = null;
  let storageWarned = false;
  let deviceId = null;
  let lastOkAt = 0;              // dernière réponse du serveur (tout statut HTTP < 500)
  let lastError = null;          // { kind: network|timeout|server, http, message, at }
  let build = null;              // version déployée vue au démarrage
  let updateNoticed = false;
  const opFails = {};            // clé d'op -> échecs serveur (5xx) consécutifs

  // ============================================================
  //  Utilitaires
  // ============================================================
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; /* quota / mode privé */ } }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
  function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  /** Message lisible (français) : les erreurs réseau du navigateur sont en anglais. */
  function errMsg(e) {
    const m = String((e && e.message) || e || "");
    if (!m || e instanceof TypeError || /fetch|network|abort|load failed/i.test(m)) {
      return "Cloud injoignable pour le moment (réseau ?). Les données restent sur cet appareil et partiront automatiquement.";
    }
    return m;
  }

  /** JSON canonique (clés triées) : comparaison indépendante de l'ordre des clés. */
  function canon(v) {
    if (v === undefined) return "~u";
    if (v === null || typeof v !== "object") { const s = JSON.stringify(v); return s === undefined ? "null" : s; }
    if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : canon(x))).join(",") + "]";
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  /** Empreinte 53 bits (cyrb53) + longueur. */
  function hashStr(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + "." + str.length.toString(36);
  }
  function hashOf(v) { return hashStr(canon(v)); }

  function structOf(t) {
    if (TG.Store && TG.Store.structureOf) return TG.Store.structureOf(t);
    const o = Object.assign({}, t); delete o.scores; return o;
  }
  function drawOf(t) { return t && isObj(t.draw) && t.draw.id ? t.draw.id : null; }
  function playersOf(s) { return s && Array.isArray(s.players) ? s.players.filter((p) => p && typeof p.id === "string") : []; }
  function nameIn(t, pid) {
    const p = playersOf(t).find((x) => x.id === pid);
    return p ? p.name : "?";
  }
  function getDeviceId() {
    if (deviceId) return deviceId;
    let id = lsGet(LS_DEV);
    if (!id || !ID_RX.test(id)) {
      id = "dev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      lsSet(LS_DEV, id);
    }
    deviceId = id;
    return id;
  }

  /** Groupes de champs fusionnables indépendamment (joueurs et tirage à part). */
  function groupsOf(s) {
    const g = {};
    Object.keys(s).forEach((k) => {
      if (k === "updatedAt" || k === "scores" || k === "players" || k === "draw") return;
      g[k] = s[k];
    });
    return g;
  }
  function knownOf(scores) {
    const s = {};
    Object.keys(scores || {}).forEach((m) => { const r = scores[m]; if (r && typeof r.at === "number") s[m] = r.at; });
    return s;
  }
  /** Empreintes d'une version serveur (référence pour les diffs et la fusion). */
  function baseOf(struct, rawUpdatedAt, scores, legacy) {
    const g = groupsOf(struct), gh = {};
    Object.keys(g).forEach((k) => { gh[k] = hashOf(g[k]); });
    const p = {};
    playersOf(struct).forEach((pl) => { p[pl.id] = hashOf(pl); });
    const b = {
      h: hashOf(struct),
      g: gh,
      d: drawOf(struct),
      p,
      u: typeof rawUpdatedAt === "number" ? rawUpdatedAt : null,
      s: knownOf(scores),
    };
    if (legacy) b.l = 1;
    return b;
  }

  /** a doit-il remplacer b ? (tirage courant d'abord, puis le plus récent) */
  function newer(a, b, cur) {
    const ac = a.draw === cur, bc = b.draw === cur;
    if (ac !== bc) return ac;
    return (Number(a.at) || 0) > (Number(b.at) || 0);
  }

  /** Version serveur normalisée (migrée) : { id, struct, scores, u, legacy } */
  function normalize(raw) {
    if (!isObj(raw) || !raw.id) return null;
    let t;
    try { t = TG.Store.migrate(clone(raw)); } catch (e) { return null; }
    if (!t || !t.id) return null;
    const scores = isObj(t.scores) ? t.scores : {};
    return { id: t.id, struct: structOf(t), scores, u: raw.updatedAt, legacy: raw.v !== TG.Store.VERSION };
  }
  function baseFor(S) { return baseOf(S.struct, S.u, S.scores, S.legacy); }

  // ============================================================
  //  Fusion à 3 voies
  // ============================================================
  /**
   * Joueurs + tirage. bd = tirage de la base commune, ld = local, sd = serveur.
   * - Tirage fait / refait / annulé AILLEURS (sd ≠ bd) et pas (ou autrement)
   *   ici : la liste et le tirage du serveur font foi ; seules les
   *   modifications de fiches (nom, club…) faites ici sont reportées, par
   *   identifiant ; les ajouts / retraits faits ici sont abandonnés (avis).
   * - Tirage fait ICI seulement : liste et tirage locaux ; les fiches
   *   modifiées ailleurs sont reportées ; une inscription faite ailleurs
   *   pendant ce tirage n'est pas retenue (avis).
   * - Même tirage des deux côtés : fusion joueur par joueur (ajouts et
   *   retraits des deux côtés conservés).
   * Une même fiche modifiée des deux côtés : la version la plus récente.
   */
  function mergeRoster(b, L, S, localWins) {
    const lp = playersOf(L), sp = playersOf(S);
    const ld = drawOf(L), sd = drawOf(S);
    const bd = b.d !== undefined ? b.d : ld;          // base ancienne : on suppose qu'on n'a pas tiré
    const bp = isObj(b.p) ? b.p : null;
    const lById = {}, sById = {};
    lp.forEach((p) => { lById[p.id] = p; });
    sp.forEach((p) => { sById[p.id] = p; });
    const inBase = (id) => !!bp && bp[id] !== undefined;
    const res = { kind: "same", players: null, draw: null, dropped: [], serverDropped: [], applied: 0, lostDraw: false, bd, sd, ld };
    const pick = (id) => {
      const l = lById[id], s = sById[id];
      const lh = hashOf(l), sh = hashOf(s);
      if (lh === sh) return clone(s);
      const bh = bp ? bp[id] : undefined;
      if (bh !== undefined) {
        if (lh === bh) return clone(s);                 // modifié ailleurs seulement
        if (sh !== bh && !localWins) return clone(s);   // des deux côtés : le plus récent
      } else if (!localWins) return clone(s);
      res.applied++;
      return clone(l);
    };
    const serverDrew = sd !== bd, localDrew = ld !== bd;
    if (serverDrew && (!localDrew || ld !== sd)) {
      res.kind = "server";
      res.players = sp.map((s) => (lById[s.id] ? pick(s.id) : clone(s)));
      lp.forEach((l) => { if (!sById[l.id] && !inBase(l.id)) res.dropped.push(l.name); });             // ajoutés ici
      if (bp) Object.keys(bp).forEach((id) => { if (sById[id] && !lById[id]) res.dropped.push(sById[id].name); });  // retirés ici
      res.lostDraw = localDrew;
      res.draw = clone(S.draw);
    } else if (localDrew && !serverDrew) {
      res.kind = "local";
      res.players = lp.map((l) => (sById[l.id] ? pick(l.id) : clone(l)));
      if (bp) sp.forEach((s) => { if (!lById[s.id] && !inBase(s.id)) res.serverDropped.push(s.name); });
      res.draw = clone(L.draw);
    } else {
      res.draw = clone(S.draw);
      if (bp) {
        const list = [];
        sp.forEach((s) => {
          if (lById[s.id]) list.push(pick(s.id));
          else if (!inBase(s.id)) list.push(clone(s));   // ajouté ailleurs (sinon : retiré ici)
        });
        lp.forEach((l) => { if (!sById[l.id] && !inBase(l.id)) list.push(clone(l)); });  // ajouté ici
        res.players = list;
      } else {
        const src = localWins ? lp : sp, other = localWins ? sById : lById;
        res.players = src.map((p) => (other[p.id] ? pick(p.id) : clone(p)));
      }
    }
    return res;
  }

  function list3(names) {
    const n = names.filter(Boolean);
    const shown = n.slice(0, 3).map((x) => "« " + x + " »").join(", ");
    return n.length > 3 ? shown + " et " + (n.length - 3) + " autre(s)" : shown;
  }

  /** Avis à afficher après une fusion de joueurs / tirage. */
  function rosterNotes(r, S, notes) {
    if (!notes) return;
    const tname = S && S.name ? "« " + S.name + " » : " : "";
    if (r.kind === "server" && (r.dropped.length || r.lostDraw || r.applied)) {
      const what = r.sd == null ? "Le tirage a été annulé sur un autre appareil"
        : r.bd == null ? "Le tirage a été effectué sur un autre appareil"
          : "Le tirage a été refait sur un autre appareil";
      let msg;
      if (r.lostDraw) {
        msg = what + (r.ld == null ? " : votre annulation du tirage n'a pas été retenue."
          : r.sd == null ? " : votre tirage n'a pas été retenu."
            : " : c'est ce tirage qui est conservé, le vôtre n'a pas été retenu.");
      }
      else if (r.dropped.length) msg = what + " : votre modification de la liste des joueurs (" + list3(r.dropped) + ") n'a pas pu être appliquée.";
      else msg = what + " : vos corrections de joueurs ont été reportées sur ce tirage.";
      notes.push({ kind: "drawChanged", message: tname + msg, tid: S.id });
    }
    if (r.kind === "local" && r.serverDropped.length) {
      notes.push({
        kind: "info",
        message: tname + "Inscription faite sur un autre appareil pendant votre tirage, non retenue : " + list3(r.serverDropped) +
          ". Annulez puis refaites le tirage pour l'inclure.",
        tid: S.id,
      });
    }
  }

  /**
   * Fusion à 3 voies d'une structure (b = empreintes de la base commune,
   * L = locale, S = serveur). Un groupe modifié d'un seul côté garde cette
   * modification ; modifié des deux côtés → le plus récent (updatedAt).
   * Joueurs + tirage : voir mergeRoster.
   */
  function merge3(b, L, S, notes) {
    if (!b) return L;
    const out = clone(S);
    const lg = groupsOf(L), sg = groupsOf(S);
    const keys = {};
    Object.keys(lg).forEach((k) => { keys[k] = true; });
    Object.keys(sg).forEach((k) => { keys[k] = true; });
    const localWins = (L.updatedAt || 0) >= (S.updatedAt || 0);
    Object.keys(keys).forEach((k) => {
      const lh = hashOf(lg[k]), sh = hashOf(sg[k]), bh = b.g ? b.g[k] : undefined;
      if (lh === sh || lh === bh) return;           // pas de modification locale
      if (sh !== bh && !localWins) return;          // conflit : le serveur est plus récent
      if (lg[k] === undefined) delete out[k];
      else out[k] = clone(lg[k]);
    });
    const r = mergeRoster(b, L, S, localWins);
    out.players = r.players;
    out.draw = r.draw === undefined ? null : r.draw;
    rosterNotes(r, S, notes);
    const a = Object.assign({}, out), c = Object.assign({}, S);
    delete a.updatedAt; delete c.updatedAt;
    if (c.players === undefined) c.players = [];
    if (c.draw === undefined) c.draw = null;
    if (hashOf(a) === hashOf(c)) return clone(S);  // rien de local à garder : version serveur
    // Nouvelle version unique (sert de jeton de concurrence côté serveur).
    out.updatedAt = Math.max(toNum(L.updatedAt), toNum(S.updatedAt)) + 1;
    return out;
  }

  // ============================================================
  //  Persistance de la file et des empreintes
  // ============================================================
  function validOp(o) {
    if (!isObj(o) || typeof o.tid !== "string" || typeof o.k !== "string") return false;
    if (o.op === "score") return typeof o.matchId === "string" && isObj(o.record);
    if (o.op === "unscore") return typeof o.matchId === "string";
    return o.op === "resetScores" || o.op === "delete";
  }
  function loadPersisted() {
    try {
      const q = JSON.parse(lsGet(LS_OPS) || "[]");
      queue = Array.isArray(q) ? q.filter(validOp) : [];
    } catch (e) { queue = []; }
    try {
      const s = JSON.parse(lsGet(LS_SYNC) || "null");
      if (isObj(s)) { sync.cloud = !!s.cloud; sync.base = isObj(s.base) ? s.base : {}; }
    } catch (e) { /* état illisible : on repart de zéro (fusion non destructive) */ }
  }
  /**
   * Sauvegarde la file. Plusieurs onglets partagent le même localStorage
   * (ex. affichage public + saisie) : on conserve les opérations écrites par
   * un autre onglet (sauf celles que celui-ci a déjà traitées) au lieu de
   * les écraser.
   */
  function persistQueue() {
    let stored = [];
    try { stored = JSON.parse(lsGet(LS_OPS) || "[]"); } catch (e) { stored = []; }
    const mine = {};
    queue.forEach((q) => { mine[q.k] = true; });
    const foreign = (Array.isArray(stored) ? stored : []).filter((o) => validOp(o) && !mine[o.k] && !removedKeys[o.k]);
    const all = foreign.concat(queue);
    if (lsSet(LS_OPS, JSON.stringify(all))) { storageWarned = false; return; }
    if (all.length && !storageWarned) {
      storageWarned = true;
      notice("storage", "Mémoire du navigateur pleine : les saisies en attente ne sont plus sauvegardées sur cet appareil. " +
        "Elles sont tout de même envoyées tant que le réseau fonctionne — ne rechargez pas la page avant leur envoi et libérez de la place.");
    }
  }
  function persistSync() { lsSet(LS_SYNC, JSON.stringify(sync)); }

  // ============================================================
  //  Statut et avis
  // ============================================================
  function pendingCount() { return queue.length + dirtyCount; }
  function emitStatus() {
    const n = pendingCount();
    statusListeners.slice().forEach((fn) => { try { fn(status, n); } catch (e) { /* écouteur fautif */ } });
  }
  function setStatus(s) { if (mode !== "cloud" && !connecting && s !== "local") s = "local"; status = s; emitStatus(); }
  function onStatus(fn) { if (typeof fn === "function" && statusListeners.indexOf(fn) < 0) statusListeners.push(fn); }
  function getStatus() { return status; }
  function isCloud() { return mode === "cloud"; }
  function onRemoteChange(fn) {
    if (typeof fn === "function" && remoteListeners.indexOf(fn) < 0) remoteListeners.push(fn);
    return () => { const i = remoteListeners.indexOf(fn); if (i >= 0) remoteListeners.splice(i, 1); };
  }
  function notifyRemote() { remoteListeners.slice().forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

  /** Avis destinés à l'utilisateur (plusieurs écouteurs possibles). */
  function onNotice(fn) {
    if (typeof fn !== "function") return () => {};
    if (noticeListeners.indexOf(fn) < 0) noticeListeners.push(fn);
    if (pendingNotices.length) {
      const p = pendingNotices; pendingNotices = [];
      p.forEach((n) => { try { fn(n); } catch (e) { console.error(e); } });
    }
    return () => { const i = noticeListeners.indexOf(fn); if (i >= 0) noticeListeners.splice(i, 1); };
  }
  function notice(kind, message, extra) {
    const n = Object.assign({ kind, message: String(message || "") }, extra || {});
    if (!noticeListeners.length) {
      pendingNotices.push(n);
      if (pendingNotices.length > 10) pendingNotices.shift();
      return;
    }
    noticeListeners.slice().forEach((fn) => { try { fn(n); } catch (e) { console.error(e); } });
  }
  function emitNotes(notes) { (notes || []).forEach((n) => notice(n.kind, n.message, n.tid ? { tid: n.tid } : null)); }

  // ============================================================
  //  Réseau
  // ============================================================
  /** Erreur réseau classée (kind, http, message serveur) pour un diagnostic clair. */
  function netError(kind, http, message) {
    const e = new Error(message);
    e.kind = kind; e.http = http || 0;
    lastError = { kind, http: http || 0, message, at: Date.now() };
    return e;
  }
  async function fetchJSON(url, opts, timeoutMs) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    let timedOut = false;
    const timer = ctl ? setTimeout(() => { timedOut = true; try { ctl.abort(); } catch (e) { /* */ } }, timeoutMs || TIMEOUT_MS) : null;
    try {
      const o = Object.assign({ cache: "no-store" }, opts || {});
      if (ctl) o.signal = ctl.signal;
      let r;
      try { r = await fetch(url, o); }
      catch (e) {
        if (timedOut) throw netError("timeout", 0, "Réseau trop lent : le serveur n'a pas répondu à temps.");
        throw netError("network", 0, "Cet appareil n'arrive pas à joindre le site (pas de réseau, ou réseau qui bloque).");
      }
      let json = null;
      try { json = await r.json(); } catch (e) { json = null; }
      if (r.status < 500 && r.status !== 429 && (json || r.ok)) { lastOkAt = Date.now(); lastError = null; }
      else if (r.status >= 500 || r.status === 429) {
        const m = json && typeof json.error === "string" && json.error ? json.error : "Le serveur ne répond pas correctement (erreur " + r.status + ").";
        lastError = { kind: "server", http: r.status, message: m, at: Date.now() };
      }
      if (json && json.build !== undefined) noteBuild(json.build);
      return { ok: !!r.ok, status: r.status, json };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function getJSON(url, timeoutMs) {
    const r = await fetchJSON(url, { headers: { Accept: "application/json" } }, timeoutMs);
    if (!r.ok || !r.json) {
      const e = new Error((r.json && r.json.error) || "Lecture impossible (" + r.status + ")");
      e.kind = r.status >= 500 || r.status === 429 ? "server" : "http"; e.http = r.status;
      throw e;
    }
    return r.json;
  }

  /** Nouvelle version déployée pendant que l'app est ouverte : on le propose (une fois). */
  function noteBuild(b) {
    if (typeof b !== "string" || !b) return;
    if (build == null) { build = b; return; }
    if (b !== build && !updateNoticed) {
      updateNoticed = true;
      notice("update", "Nouvelle version de l'application disponible.");
    }
  }

  /** Test immédiat (bouton « Tester la connexion ») : réseau → serveur → base de données. */
  async function testConnection() {
    const t0 = Date.now();
    let r;
    try { r = await fetchJSON(API + "?health=1", { headers: { Accept: "application/json" } }, TIMEOUT_MS); }
    catch (e) { return { ok: false, kind: e.kind || "network", message: e.message, ms: Date.now() - t0 }; }
    const ms = Date.now() - t0, j = r.json || {};
    if (r.status === 404 || r.status === 405 || r.status === 501 || j.configured === false) {
      return { ok: false, kind: "local", message: "Aucune base de données partagée n'est branchée sur ce site (mode local).", ms };
    }
    if (!r.ok || !j.ok) {
      return { ok: false, kind: "server", http: r.status, ms,
        message: (typeof j.error === "string" && j.error) || "Le serveur ne répond pas correctement (erreur " + r.status + ")." };
    }
    // Tout répond : on relance aussitôt la synchro (et la connexion si elle n'était pas établie).
    failures = 0;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (connecting) retryInit();
    else if (mode === "cloud") Promise.resolve(booted ? flush() : null).then(() => checkRemote(true));
    return { ok: true, ms, redisMs: toNum(j.redisMs) };
  }

  function stuckCount() {
    return queue.filter((q) => (opFails[q.k] || 0) >= STUCK_AFTER).length;
  }
  function getInfo() {
    return { status, mode, pending: pendingCount(), lastOkAt, lastError: lastError ? Object.assign({}, lastError) : null, stuck: stuckCount() };
  }
  /** POST : {rev, ignored, rv, prv, current} | {permanent, error} ; lève une erreur si incident passager. */
  async function post(body) {
    const r = await fetchJSON(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 400 || r.status === 413 || r.status === 422) {
      return { permanent: true, error: (r.json && r.json.error) || ("HTTP " + r.status) };
    }
    if (!r.ok) {
      const e = new Error((r.json && r.json.error) || "Envoi refusé (" + r.status + ")");
      e.kind = r.status >= 500 || r.status === 429 ? "server" : "http"; e.http = r.status;
      throw e;
    }
    if (!r.json || !r.json.configured || !r.json.ok) throw new Error("Cloud indisponible");
    const j = r.json;
    return {
      rev: typeof j.rev === "number" ? j.rev : null,
      ignored: j.ignored || null,
      rv: typeof j.rv === "string" ? j.rv : null,
      prv: typeof j.prv === "string" ? j.prv : null,
      current: isObj(j.current) ? j.current : null,
      recreated: j.recreated === true,
    };
  }
  async function fetchState() {
    const j = await getJSON(API, FULL_TIMEOUT_MS);
    if (!j.configured) throw new Error("Cloud non configuré");
    return { rev: toNum(j.rev), tournaments: Array.isArray(j.tournaments) ? j.tournaments : [], revs: isObj(j.revs) ? j.revs : null };
  }

  // ============================================================
  //  Démarrage
  // ============================================================
  /**
   * Interroge le cloud. Réponse définitive « local » seulement si le serveur
   * dit {configured:false} ou si l'API n'existe pas (404 : site statique) ;
   * réseau coupé, délai, 5xx, 429… = incident passager → on réessaiera.
   */
  async function probe() {
    let r;
    try { r = await fetchJSON(API + "?meta=1", { headers: { Accept: "application/json" } }, TIMEOUT_MS); }
    catch (e) { return "transient"; }
    if (r.ok && r.json && r.json.configured === true) return "cloud";
    if (r.ok && r.json && r.json.configured === false) return "local";
    if (r.status === 404 || r.status === 405 || r.status === 501) return "local";
    return "transient";
  }

  async function init() {
    bindEvents();
    getDeviceId();
    const p = await probe();
    if (p === "cloud") {
      connecting = false;
      mode = "cloud";
      if (!sync.cloud) { sync.cloud = true; persistSync(); }
      setStatus("syncing");
    } else if (p === "local") {
      connecting = false;
      mode = "local";
      if (sync.cloud) { sync.cloud = false; persistSync(); }
      setStatus("local");
    } else if (sync.cloud || queue.length) {
      // Hors-ligne au démarrage : cet appareil utilisait déjà le cloud, on
      // reste en mode cloud (les saisies sont mises en file et partiront au
      // retour du réseau) au lieu de basculer silencieusement en local.
      mode = "cloud";
      setStatus("error");
    } else {
      // Premier démarrage pendant un incident passager : mode local pour
      // l'instant, mais on réessaie (2 s, 4 s… 30 s) et l'on bascule en
      // cloud (synchro initiale + sondage) dès que le serveur répond.
      mode = "local";
      connecting = true;
      initFailures = 1;
      setStatus("syncing");
      scheduleInitRetry();
    }
    return mode;
  }

  function scheduleInitRetry() {
    if (initTimer || !connecting) return;
    const delay = Math.min(INIT_RETRY_MAX_MS, 1000 * Math.pow(2, Math.min(initFailures, 5)));
    initTimer = setTimeout(() => { initTimer = null; retryInit(); }, delay);
  }
  function retryInit() {
    if (!connecting) return Promise.resolve(mode);
    if (initRetrying) return initRetrying;
    if (initTimer) { clearTimeout(initTimer); initTimer = null; }
    initRetrying = (async () => {
      try {
        const p = await probe();
        if (!connecting) return mode;
        if (p === "cloud") {
          connecting = false;
          initFailures = 0;
          mode = "cloud";
          if (!sync.cloud) { sync.cloud = true; persistSync(); }
          setStatus("syncing");
          const r = await bootSync();
          startPolling();
          if (r && r.error) notifyRemote();  // (bootSync notifie déjà en cas de succès)
        } else if (p === "local") {
          connecting = false;
          mode = "local";
          setStatus("local");
        } else {
          initFailures++;
          setStatus(initFailures >= 3 ? "error" : "syncing");
          scheduleInitRetry();
        }
        return mode;
      } finally {
        initRetrying = null;
      }
    })();
    return initRetrying;
  }

  function queuedDeletes() {
    const d = {};
    queue.forEach((q) => { if (q.op === "delete") d[q.tid] = true; });
    return d;
  }

  /**
   * Synchro initiale : FUSION non destructive local ↔ cloud.
   * - structure : fusion à 3 voies si l'on connaît la dernière version
   *   cloud vue par cet appareil, sinon la plus récente (updatedAt) ;
   * - scores : union ; pour un même match, le tirage courant puis le plus
   *   grand `at` l'emporte. Un score local absent du cloud est renvoyé…
   *   sauf s'il y avait déjà été vu (il a donc été effacé ailleurs) ;
   * - tournoi seulement local : créé dans le cloud (sauf s'il y avait été vu
   *   puis supprimé ailleurs sans modification locale depuis).
   */
  function bootSync() {
    if (mode !== "cloud") return Promise.resolve({ skipped: true });
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      setStatus("syncing");
      try {
        const snap = await fetchState();
        const fate = await fateOfAbsent(snap);
        const res = mergeBoot(snap, fate);
        booted = true;
        appliedRev = snap.rev;
        emitNotes(res.notes);
        const f = await flush();
        if (f && f.error) setStatus("error");
        notifyRemote();
        return { ok: true, merged: res.count, pushed: res.pushed };
      } catch (e) {
        console.warn("Cloud : synchro initiale impossible", e);
        setStatus("error");
        return { error: errMsg(e) };
      } finally {
        bootPromise = null;
      }
    })();
    return bootPromise;
  }

  function unionScores(tid, Ls, Ss, known, cur, toPush) {
    const out = clone(Ss || {});
    const loc = isObj(Ls) ? Ls : {};
    Object.keys(loc).forEach((m) => {
      const l = loc[m];
      if (!isObj(l) || !cur || l.draw !== cur) return;   // score d'un autre tirage : sans objet
      const s = out[m];
      if (!s) {
        if (known && known[m] === l.at) return;          // vu dans le cloud puis effacé : pas de résurrection
        out[m] = clone(l); toPush.push({ tid, matchId: m, record: l });
      } else if (newer(l, s, cur)) {
        out[m] = clone(l); toPush.push({ tid, matchId: m, record: l });
      }
    });
    return out;
  }

  function mergeBoot(snap, fate) {
    fate = fate || {};
    const localList = (TG.Store.snapshot().tournaments || []).filter((t) => t && t.id);
    const localById = {};
    localList.forEach((t) => { localById[t.id] = t; });
    const deleting = queuedDeletes();
    const out = [], seen = {}, toPush = [], notes = [];
    const revs = isObj(snap.revs) ? snap.revs : null;
    knownRv = {};

    (snap.tournaments || []).forEach((raw) => {
      if (!isObj(raw) || !raw.id || seen[raw.id]) return;
      seen[raw.id] = true;
      if (revs && revs[raw.id] != null) knownRv[raw.id] = String(revs[raw.id]);
      if (deleting[raw.id]) return;
      const S = normalize(raw);
      if (!S) { if (localById[raw.id]) out.push(clone(localById[raw.id])); return; }  // illisible : on garde le local
      const L = localById[S.id], b = sync.base[S.id];
      let struct = S.struct, scores = S.scores;
      if (L) {
        const ls = structOf(L), lh = hashOf(ls);
        if (lh !== hashOf(S.struct)) {
          if (b) { if (lh !== b.h) struct = merge3(b, clone(ls), S.struct, notes); }
          else if ((L.updatedAt || 0) > (S.updatedAt || 0)) struct = clone(ls);
        }
        scores = unionScores(S.id, L.scores, S.scores, b && b.s, drawOf(struct), toPush);
      }
      sync.base[S.id] = baseFor(S);
      delete conflicted[S.id];
      overlay(S.id, scores, drawOf(struct), snap.rev);
      struct.scores = scores;
      out.push(struct);
    });

    localList.forEach((L) => {
      if (seen[L.id] || deleting[L.id]) return;
      const b = sync.base[L.id], f = fate[L.id];
      if (f === "keep") { out.push(clone(L)); return; }  // illisible côté serveur : on garde la copie locale
      if (f === "lost") delete sync.base[L.id];         // perdu côté serveur (base vidée) : recréé
      else if (b && hashOf(structOf(L)) === b.h) {      // supprimé ailleurs pendant notre absence
        delete sync.base[L.id];
        return;
      }
      // Modifié ici depuis : la base est gardée, le serveur tranche à l'envoi
      // (supprimé ailleurs → retiré ici ; données perdues côté serveur → recréé).
      const t = clone(L);
      t.scores = unionScores(L.id, L.scores, {}, null, drawOf(t), toPush);
      overlay(L.id, t.scores, drawOf(t), snap.rev);
      out.push(t);
    });

    TG.Store.replaceAll({ tournaments: out });
    toPush.forEach((p) => {
      const has = queue.some((q) => (q.op === "score" || q.op === "unscore") && q.tid === p.tid && q.matchId === p.matchId);
      if (!has) enqueue({ op: "score", tid: p.tid, matchId: p.matchId, record: Object.assign(clone(p.record), { by: getDeviceId() }) });
    });
    persistSync();
    computeDirty(false);
    return { count: out.length, pushed: toPush.length, notes };
  }

  // ============================================================
  //  Application d'un état distant
  // ============================================================
  /** Superpose les opérations locales pas encore visibles dans l'instantané `rev`. */
  function overlay(tid, scores, cur, rev) {
    const ops = acked.filter((a) => a.tid === tid && a.rev > rev).concat(queue.filter((q) => q.tid === tid));
    ops.forEach((op) => {
      if (op.op === "score") {
        if (op.record.draw !== cur) return;           // score d'un tirage remplacé : sans objet
        const c = scores[op.matchId];
        if (!isObj(c) || !newer(c, op.record, cur)) scores[op.matchId] = clone(op.record);
      } else if (op.op === "unscore") {
        const c = scores[op.matchId];
        if (c && (op.draw == null || c.draw === op.draw) && (op.at == null || !(Number(c.at) > op.at))) delete scores[op.matchId];
      } else if (op.op === "resetScores") {
        Object.keys(scores).forEach((m) => {
          const r = scores[m];
          if (!isObj(r) || (r.draw !== op.keepDraw && r.draw !== cur)) delete scores[m];
        });
      }
    });
  }

  function differs(a, b) {
    if (a.length !== b.length) return true;
    const m = {};
    a.forEach((t) => { m[t.id] = t; });
    for (const t of b) { const o = m[t.id]; if (!o || canon(o) !== canon(t)) return true; }
    return false;
  }

  function resetKnowledge() {
    sync.base = {}; acked = []; structAck = {}; conflicted = {}; appliedRev = -1;
    knownRv = {}; refreshIds = {};
    persistSync();
  }

  /**
   * Applique un instantané serveur (complet, ou partiel : seulement les
   * tournois modifiés `opt.partial`) ; `opt.fate` dit ce que sont devenus les
   * tournois connus absents du serveur ("deleted" / "lost" / "keep").
   * Base = serveur (structure + scores), puis :
   * - tournoi avec édition de structure locale non envoyée → fusion à 3 voies
   *   (la modification locale est conservée, les scores serveur aussi) ;
   * - tournoi que l'on vient d'écrire (révision > instantané) → version locale ;
   * - opérations de score en file / confirmées mais pas encore visibles →
   *   superposées : l'UI ne recule jamais.
   */
  function applyRemote(snap, opt) {
    opt = opt || {};
    if (!snap || typeof snap.rev !== "number" || snap.rev < appliedRev) return false;
    const rev = snap.rev;
    const partial = !!opt.partial;
    const goneRev = partial ? toNum(opt.metaRev) : rev;
    const fate = opt.fate || {};          // id absent du serveur → "deleted" | "lost" | "keep"
    const relost = [];
    const revs = isObj(snap.revs) ? snap.revs : null;
    const localList = (TG.Store.snapshot().tournaments || []).filter((t) => t && t.id);
    const localById = {};
    localList.forEach((t) => { localById[t.id] = t; });
    const deleting = queuedDeletes();
    const out = [], seen = {}, notes = [];
    let needPush = false;
    if (!partial) knownRv = {};

    (snap.tournaments || []).forEach((raw) => {
      if (!isObj(raw) || !raw.id || seen[raw.id]) return;
      seen[raw.id] = true;
      if (revs && revs[raw.id] != null) knownRv[raw.id] = String(revs[raw.id]);
      if (deleting[raw.id]) return;
      const S = normalize(raw);
      if (!S) { if (localById[raw.id]) out.push(clone(localById[raw.id])); return; }  // illisible : on garde le local
      const id = S.id, L = localById[id];
      const mine = (structAck[id] != null ? structAck[id] : -1) > rev;
      if (!L && mine) return;                         // supprimé par nous, instantané antérieur
      let struct = S.struct;
      if (L && mine) {
        struct = clone(structOf(L));                  // notre écriture n'est pas encore dans l'instantané
      } else {
        if (L) {
          const ls = structOf(L), lh = hashOf(ls), b = sync.base[id];
          if ((!b || b.h !== lh) && lh !== hashOf(S.struct)) {
            struct = merge3(b, clone(ls), S.struct, notes);
            needPush = true;
          }
        }
        sync.base[id] = baseFor(S);
        delete conflicted[id];
      }
      const scores = S.scores;
      overlay(id, scores, drawOf(struct), rev);
      struct.scores = scores;
      out.push(struct);
    });

    localList.forEach((L) => {
      if (seen[L.id]) return;
      const f = fate[L.id];
      if ((partial && !f) || f === "keep") { out.push(clone(L)); return; }  // non concerné / illisible côté serveur
      if ((structAck[L.id] != null ? structAck[L.id] : -1) > goneRev) { out.push(clone(L)); return; }
      if (f === "lost" && sync.base[L.id]) {                       // perdu côté serveur (base vidée) : on le recrée
        delete sync.base[L.id];
        delete knownRv[L.id];
        out.push(clone(L));
        relost.push(L.id);
        needPush = true;
        return;
      }
      if (sync.base[L.id]) {                                       // supprimé par un autre appareil
        delete sync.base[L.id];
        delete knownRv[L.id];
        notes.push({ kind: "deleted", message: "Le tournoi « " + (L.name || "") + " » a été supprimé sur un autre appareil.", tid: L.id });
        return;
      }
      out.push(clone(L));                                          // jamais envoyé : sera créé
      needPush = true;
    });
    if (partial) Object.keys(fate).forEach((id) => { if (!localById[id] && fate[id] !== "keep") delete knownRv[id]; });

    appliedRev = partial ? Math.max(appliedRev, goneRev) : rev;
    acked = acked.filter((a) => a.rev > rev || (partial && !seen[a.tid]));
    persistSync();
    const changed = differs(localList, out);
    if (changed) TG.Store.replaceAll({ tournaments: out });
    if (Object.keys(staleWatch).length) checkStale(notes);
    relost.forEach((id) => repushScores(id));
    computeDirty(false);
    emitStatus();
    if (needPush || dirtyCount) kick();
    if (changed) notifyRemote();
    emitNotes(notes);
    return changed;
  }

  // ============================================================
  //  Changements locaux
  // ============================================================
  /** Structures locales différentes du dernier état connu du cloud. */
  function computeDirty(withDeletes) {
    const list = (TG.Store.snapshot().tournaments || []).filter((t) => t && t.id);
    const ups = [], present = {};
    list.forEach((t) => {
      present[t.id] = true;
      const s = structOf(t), h = hashOf(s), b = sync.base[t.id];
      if ((b && b.h === h) || rejected[t.id] === h) return;
      ups.push({ id: t.id, struct: s, h });
    });
    if (withDeletes && booted) {
      const deleting = queuedDeletes();
      Object.keys(sync.base).forEach((id) => {
        if (!present[id] && !deleting[id]) enqueue({ op: "delete", tid: id });
      });
    }
    dirtyCount = ups.length;
    return ups;
  }

  function newKey() {
    opSeq++;
    return Date.now().toString(36) + "-" + opSeq.toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  /** Retire de la file les opérations qui vérifient `drop` ; true si la file a changé. */
  function dropWhere(drop) {
    const n = queue.length;
    queue = queue.filter((q) => {
      if (!drop(q)) return true;
      removedKeys[q.k] = true;
      return false;
    });
    return queue.length !== n;
  }
  /** Ajoute une opération à la file (fusion : la dernière sur un même match gagne). */
  function enqueue(op) {
    op.k = newKey();
    if (op.op === "score" || op.op === "unscore") {
      // Ressaisie après un effacement (ou une correction) encore en file : c'est un
      // remplacement volontaire → il ne doit pas être refusé comme « déjà saisi ailleurs ».
      if (op.op === "score" && queue.some((q) => q.tid === op.tid && q.matchId === op.matchId && (q.op === "unscore" || (q.op === "score" && q.overwrite)))) op.overwrite = true;
      dropWhere((q) => (q.op === "score" || q.op === "unscore") && q.tid === op.tid && q.matchId === op.matchId);
    } else if (op.op === "resetScores") {
      dropWhere((q) => q.tid === op.tid && (
        q.op === "resetScores" ||
        (q.op === "score" && q.record.draw !== op.keepDraw) ||
        (q.op === "unscore" && q.draw !== op.keepDraw)));
    } else if (op.op === "delete") {
      dropWhere((q) => q.tid === op.tid);
    }
    queue.push(op);
    persistQueue();
    emitStatus();
  }
  function removeOp(k) {
    if (dropWhere((q) => q.k === k)) persistQueue();
    else removedKeys[k] = true;
    emitStatus();
  }

  function kick() { if (mode === "cloud" && booted) flush(); }

  /** Appelé par TG.Store.commit() à chaque modification de structure. */
  function scheduleSync(reason) {
    if (mode !== "cloud" || !booted) return;      // avant la synchro initiale : bootSync fusionnera
    const before = queue.length;
    const ups = computeDirty(true);
    if (queue.length !== before) kick();           // suppression de tournoi : envoi immédiat
    if (ups.length) {
      if (syncTimer) clearTimeout(syncTimer);
      setStatus("syncing");
      syncTimer = setTimeout(() => { syncTimer = null; flush(); }, DEBOUNCE_MS);
    }
    emitStatus();
  }

  // ----- Scores (appelés par TG.Store) -----
  function seenAt(tid, matchId) {
    const b = sync.base[tid];
    return b && b.s && typeof b.s[matchId] === "number" ? b.s[matchId] : null;
  }
  /** opts.overwrite : correction volontaire (remplace un résultat déjà saisi ailleurs). */
  function pushScore(tid, matchId, record, opts) {
    if (!isObj(record) || typeof tid !== "string" || typeof matchId !== "string") return;
    const rec = { s1: record.s1, s2: record.s2, p1: record.p1, p2: record.p2, draw: record.draw, at: Number(record.at) || Date.now(), by: getDeviceId() };
    // Une correction l'emporte toujours sur le score qu'on a vu, même si
    // l'horloge de cet appareil retarde.
    const seen = seenAt(tid, matchId);
    if (seen != null && !(rec.at > seen)) rec.at = seen + 1;
    const op = { op: "score", tid, matchId, record: rec };
    if (opts && opts.overwrite) op.overwrite = true;
    (myScores[tid] = myScores[tid] || {})[matchId] = rec;
    enqueue(op);
    kick();
  }

  /**
   * Après un conflit (notre résultat d'un match a été écarté), les matchs SUIVANTS que
   * nous avions saisis peuvent ne plus compter (leurs joueurs ont changé). On le signale
   * explicitement au lieu de les laisser disparaître sans un mot.
   */
  function checkStale(notes) {
    const now = Date.now();
    Object.keys(staleWatch).forEach((tid) => {
      if (staleWatch[tid] < now) { delete staleWatch[tid]; return; }
      const t = TG.Store.getTournament(tid), mine = myScores[tid];
      if (!t || !mine) return;
      const st = TG.Store.state(t);
      const lost = Object.keys(mine).filter((mid) => {
        const m = st.byId[mid], rec = t.scores && t.scores[mid], my = mine[mid];
        return m && m.staleScore && rec && rec.s1 === my.s1 && rec.s2 === my.s2 && rec.p1 === my.p1 && rec.p2 === my.p2;
      });
      if (!lost.length) return;
      delete staleWatch[tid];
      const txt = lost.map((mid) => scoreText(t, mine[mid])).join(" ; ");
      lost.forEach((mid) => { delete mine[mid]; });
      notes.push({ kind: "conflict", tid, message: (lost.length > 1 ? lost.length + " de vos saisies suivantes ne comptent plus" : "Votre saisie suivante ne compte plus") +
        " (" + txt + ") : un résultat précédent a été retenu différemment sur un autre appareil. Vérifiez ces matchs et ressaisissez-les si besoin." });
    });
  }
  function pushUnscore(tid, matchId) {
    if (typeof tid !== "string" || typeof matchId !== "string") return;
    const t = TG.Store.getTournament(tid);
    const seen = seenAt(tid, matchId);
    const at = Math.max(Date.now(), seen != null ? seen : 0);
    enqueue({ op: "unscore", tid, matchId, draw: drawOf(t), at });
    kick();
  }
  function pushResetScores(tid, keepDraw) {
    if (typeof tid !== "string") return;
    enqueue({ op: "resetScores", tid, keepDraw: keepDraw == null ? null : String(keepDraw) });
    // Nouveau tirage : la structure part tout de suite (pas d'attente du différé).
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    kick();
  }

  // ============================================================
  //  Envoi
  // ============================================================
  function scheduleRetry() {
    if (retryTimer || mode !== "cloud") return;
    const delay = Math.min(RETRY_MAX_MS, 1000 * Math.pow(2, Math.min(failures, 4)));
    retryTimer = setTimeout(() => { retryTimer = null; flush(); }, delay);
  }

  /** Envoie tout ce qui attend : structures d'abord, puis la file, dans l'ordre. */
  function flush() {
    if (mode !== "cloud") return Promise.resolve({ ok: true, local: true });
    if (!booted) return Promise.resolve({ error: "Synchronisation initiale en attente." });
    if (flushing) { flushAgain = true; return flushing; }
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    setStatus("syncing");
    flushing = (async () => {
      try {
        do {
          flushAgain = false;
          await pushStructures();
          await pushQueue();
        } while (flushAgain);
        failures = 0;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        setStatus("connected");
        return { ok: true };
      } catch (e) {
        failures++;
        setStatus("error");
        scheduleRetry();
        return { error: errMsg(e) };
      } finally {
        flushing = null;
        if (forceRefresh) setTimeout(() => { checkRemote(true); }, 0);
      }
    })();
    return flushing;
  }

  /** Recharger ce tournoi au prochain sondage (même si sa révision n'a pas bougé). */
  function refresh(tid) { if (tid) refreshIds[tid] = true; forceRefresh = true; }

  /** Notre écriture est la seule depuis nos dernières données : inutile de les recharger. */
  function advanceRv(tid, r) {
    if (!r || typeof r.rv !== "string" || typeof r.prv !== "string") return;
    if (knownRv[tid] !== undefined && knownRv[tid] === r.prv) knownRv[tid] = r.rv;
  }

  /** Tournoi supprimé ailleurs (écriture refusée) : on le retire ici aussi. */
  function dropDeleted(tid) {
    const t = TG.Store.getTournament(tid);
    delete sync.base[tid]; delete knownRv[tid]; delete conflicted[tid]; delete refreshIds[tid]; delete structAck[tid];
    if (dropWhere((q) => q.tid === tid)) persistQueue();
    persistSync();
    if (t) {
      TG.Store.deleteTournament(tid);
      notice("deleted", "Le tournoi « " + (t.name || "") + " » a été supprimé sur un autre appareil : vos dernières modifications n'ont pas été enregistrées.", { tid });
      notifyRemote();
    }
    forceRefresh = true;
  }

  async function pushStructures() {
    for (let guard = 0; guard < 200; guard++) {
      const u = computeDirty(true).filter((x) => !conflicted[x.id])[0];
      if (!u) return;
      const payload = clone(u.struct);
      const b = sync.base[u.id];
      const body = { op: "upsert", tournament: payload };
      if (b) {
        // Modification basée sur une version vue dans le cloud : le serveur
        // refuse si le tournoi a été supprimé, modifié ou re-tiré entre-temps.
        body.base = true;
        if (typeof b.u === "number") body.baseUpdatedAt = b.u;
        if (b.d !== undefined) body.baseDraw = b.d;
      }
      const r = await post(body);
      if (r.permanent) {
        rejected[u.id] = u.h;
        console.warn("Cloud : tournoi refusé par le serveur", u.id, r.error);
        notice("info", "Le tournoi « " + (payload.name || "") + " » n'a pas pu être enregistré en ligne (" + r.error + ").", { tid: u.id });
        continue;
      }
      if (r.ignored === "deleted") { dropDeleted(u.id); continue; }
      if (r.ignored) {
        // Quelqu'un d'autre a modifié ce tournoi : on recharge et on fusionne.
        conflicted[u.id] = true;
        refresh(u.id);
        continue;
      }
      if (typeof r.rev === "number") structAck[u.id] = r.rev;
      const nb = baseOf(payload, payload.updatedAt, null, false);
      nb.s = b && b.s && !r.recreated ? b.s : {};
      sync.base[u.id] = nb;
      advanceRv(u.id, r);
      persistSync();
      if (r.recreated) repushScores(u.id);   // le serveur avait perdu ce tournoi (et ses scores)
    }
  }

  /** Traduit une opération de la file en requête (null = devenue sans objet). */
  function wireOf(op) {
    if (op.op === "delete") return { op: "delete", id: op.tid };
    const t = TG.Store.getTournament(op.tid);
    if (!t) return null;
    const cur = drawOf(t);
    if (op.op === "score") {
      if (op.record.draw !== cur) return null;   // score d'un tirage remplacé
      const w = { op: "score", tid: op.tid, matchId: op.matchId, record: op.record };
      if (op.overwrite) w.overwrite = true;
      return w;
    }
    if (op.op === "unscore") {
      if (op.draw && op.draw !== cur) return null;
      const w = { op: "unscore", tid: op.tid, matchId: op.matchId };
      if (op.draw) w.draw = op.draw;
      if (typeof op.at === "number") w.at = op.at;
      return w;
    }
    // Purge : on garde toujours les scores du tirage COURANT (si le tirage a
    // encore changé depuis, la purge suit le tirage actuel, jamais un ancien).
    if (op.op === "resetScores") return { op: "resetScores", tid: op.tid, keepDraw: cur };
    return null;
  }

  function scoreText(t, rec, flip) {
    if (!rec) return "";
    const a = nameIn(t, rec.p1), b = nameIn(t, rec.p2);
    return flip ? b + " " + rec.s2 + " – " + rec.s1 + " " + a : a + " " + rec.s1 + " – " + rec.s2 + " " + b;
  }

  function queuedFor(tid, m) {
    return queue.some((q) => q.tid === tid && (q.op === "score" || q.op === "unscore") && q.matchId === m);
  }
  /** Renvoie tous les scores connus ici (tirage courant) d'un tournoi recréé sur le serveur. */
  function repushScores(tid) {
    const t = TG.Store.getTournament(tid);
    const cur = drawOf(t);
    if (!t || !cur) return;
    Object.keys(t.scores || {}).forEach((m) => {
      const rec = t.scores[m];
      if (!isObj(rec) || rec.draw !== cur || queuedFor(tid, m)) return;
      queue.push({ op: "score", tid, matchId: m, record: Object.assign(clone(rec), { by: getDeviceId() }), k: newKey() });
    });
    persistQueue();
    emitStatus();
  }

  /** Une opération de score a été écartée par le serveur. */
  function onIgnored(op, r) {
    const tid = op.tid;
    if (r.ignored === "deleted") { dropDeleted(tid); return; }
    if (r.ignored === "missing") {
      // Le serveur a perdu ce tournoi (base Redis vidée / remplacée) sans qu'il
      // ait été supprimé : on le recrée (structure sans base = création), puis
      // on renvoie l'opération et tous les scores connus ici du tirage courant.
      // (Une seule fois : la base locale sert de garde contre une boucle.)
      const t = TG.Store.getTournament(tid);
      if (sync.base[tid] && t) {
        delete sync.base[tid]; delete knownRv[tid];
        persistSync();
        const again = op.op === "unscore" ? !queuedFor(tid, op.matchId)
          : op.op === "resetScores" && !queue.some((q) => q.tid === tid && q.op === "resetScores");
        if (again) queue.push(Object.assign({}, op, { k: newKey() }));
        repushScores(tid);
      }
      kick();
      return;
    }
    refresh(tid);
    if (op.op !== "score") return;
    if (r.ignored === "exists" || r.ignored === "older") staleWatch[tid] = Date.now() + 120000;
    const t = TG.Store.getTournament(tid);
    const mine = op.record;
    const flip = !!(r.current && r.current.p1 === mine.p2 && r.current.p2 === mine.p1);
    const minePart = mine ? " Votre saisie (" + mine.s1 + " – " + mine.s2 + ") n'a pas été retenue." : "";
    if (r.ignored === "exists") {
      notice("conflict", "Résultat déjà saisi sur un autre appareil" + (r.current ? " : " + scoreText(t, r.current, flip) : "") + "." + minePart,
        { tid, matchId: op.matchId });
    } else if (r.ignored === "older") {
      notice("conflict", "Une correction plus récente de ce match a été faite sur un autre appareil" + (r.current ? " : " + scoreText(t, r.current, flip) : "") + "." + minePart,
        { tid, matchId: op.matchId });
    } else if (r.ignored === "staleDraw") {
      notice("drawChanged", "Le tirage a été modifié sur un autre appareil : le score saisi (" + scoreText(t, mine) + ") n'a pas été retenu.",
        { tid, matchId: op.matchId });
    }
  }

  async function pushQueue() {
    for (let guard = 0; guard < 10000 && queue.length; guard++) {
      // Une opération ne part que si la structure de son tournoi est à jour
      // dans le cloud (sinon le tirage côté serveur pourrait différer).
      const blocked = {};
      computeDirty(false).forEach((u) => { blocked[u.id] = true; });
      Object.keys(conflicted).forEach((id) => { blocked[id] = true; });
      // Une op que le serveur refuse en boucle (erreur 500) ne bloque plus les
      // autres : elle passe en dernier (avec celles qui doivent la suivre :
      // même match, ou purge / suppression du même tournoi), et sera retentée.
      const held = {}, heldMatch = {}, heldTid = {};
      queue.forEach((q) => {
        const mk = q.tid + "\n" + (q.matchId || "");
        const after = (q.matchId && heldMatch[mk]) || ((q.op === "resetScores" || q.op === "delete") && heldTid[q.tid]);
        if ((opFails[q.k] || 0) >= STUCK_AFTER || after) { held[q.k] = true; heldMatch[mk] = true; heldTid[q.tid] = true; }
      });
      const ready = (q) => q.op === "delete" || !blocked[q.tid];
      const op = queue.find((q) => ready(q) && !held[q.k]) || queue.find(ready);
      if (!op) return;
      const wire = wireOf(op);
      if (!wire) { removeOp(op.k); continue; }
      let r;
      try { r = await post(wire); }
      catch (e) {
        if (e && e.kind === "server" && e.http === 500) opFails[op.k] = (opFails[op.k] || 0) + 1;
        throw e;
      }
      delete opFails[op.k];
      removeOp(op.k);
      if (r.permanent) { console.warn("Cloud : opération refusée", wire, r.error); continue; }
      if (op.op === "delete") {
        if (typeof r.rev === "number") structAck[op.tid] = r.rev;
        delete sync.base[op.tid];
        delete knownRv[op.tid];
        persistSync();
        continue;
      }
      if (r.ignored) { onIgnored(op, r); continue; }
      if (typeof r.rev === "number") {
        acked.push(Object.assign({}, op, { rev: r.rev }));
        if (acked.length > 2000) acked.splice(0, acked.length - 2000);
      }
      advanceRv(op.tid, r);
      if (op.op === "score" && sync.base[op.tid]) {
        const b = sync.base[op.tid];
        b.s = b.s || {};
        b.s[op.matchId] = op.record.at;
        persistSync();
      }
    }
  }

  /** Bouton « Forcer l'envoi ». */
  async function pushPending(reason) {
    if (mode !== "cloud") return { error: "Cloud non configuré." };
    if (!booted) {
      const r = await bootSync();
      if (r && r.error) return r;
    }
    const r = await flush();
    if (r && r.error) return r;
    if (!queue.length) return { ok: true };
    const n = stuckCount();
    return { error: n ? n + " saisie(s) refusée(s) par le serveur" + (lastError && lastError.kind === "server" ? " : " + lastError.message : ".")
      : queue.length + " opération(s) encore en attente." };
  }

  // ============================================================
  //  Lecture « temps réel »
  // ============================================================
  /**
   * Ne recharge que les tournois dont le jeton de révision a changé (ou
   * signalés à recharger) ; ceux qui ont disparu du serveur sont supprimés.
   */
  async function pullChanged(metaRev, revs) {
    const ids = Object.keys(revs).filter((id) => ID_RX.test(id));
    const changed = ids.filter((id) => knownRv[id] !== String(revs[id]) || refreshIds[id]);
    // Disparus du serveur : supprimés ailleurs… ou perdus (base vidée) — on demande.
    const cand = {};
    Object.keys(knownRv).forEach((id) => { if (!hasOwn(revs, id)) cand[id] = true; });
    Object.keys(sync.base).forEach((id) => { if (!hasOwn(revs, id)) cand[id] = true; });
    refreshIds = {};
    const ask = changed.concat(Object.keys(cand).filter((id) => ID_RX.test(id)));
    if (ask.length > MAX_PARTIAL) {
      const snap = await fetchState();
      applyRemote(snap, { fate: await fateOfAbsent(snap) });
      return;
    }
    let snap = { rev: metaRev, tournaments: [], revs: {} };
    const fate = {};
    if (ask.length) {
      const j = await fetchIds(ask);
      snap = { rev: j.rev, tournaments: j.tournaments, revs: j.revs };
      Object.assign(fate, j.fate);
    }
    applyRemote(snap, { partial: true, metaRev, fate });
    // Tournoi illisible côté serveur : ne pas le redemander à chaque sondage.
    changed.forEach((id) => { if (fate[id] === "keep") knownRv[id] = String(revs[id]); });
  }

  /**
   * Télécharge des tournois précis. fate[id] pour chaque id demandé mais non
   * reçu : "deleted" (supprimé, pierre tombale), "lost" (absent sans avoir été
   * supprimé : base Redis vidée / remplacée → on le recrée), "keep" (présent
   * mais illisible : on garde la copie locale).
   */
  async function fetchIds(ids) {
    const out = { rev: -1, tournaments: [], revs: {}, fate: {} };
    for (let i = 0; i < ids.length; i += 60) {
      const part = ids.slice(i, i + 60);
      const j = await getJSON(API + "?ids=" + part.map(encodeURIComponent).join(","), FULL_TIMEOUT_MS);
      if (!j.configured) throw new Error("Cloud non configuré");
      if (out.rev < 0 || toNum(j.rev) < out.rev) out.rev = toNum(j.rev);
      const list = Array.isArray(j.tournaments) ? j.tournaments : [];
      out.tournaments = out.tournaments.concat(list);
      if (isObj(j.revs)) Object.assign(out.revs, j.revs);
      const got = {}, missing = {};
      list.forEach((t) => { if (isObj(t) && t.id) got[t.id] = true; });
      (Array.isArray(j.missing) ? j.missing : []).forEach((id) => { missing[id] = true; });
      const del = Array.isArray(j.deleted) ? j.deleted : null;   // serveur ancien : absent = supprimé
      part.forEach((id) => {
        if (got[id]) return;
        if (!missing[id]) out.fate[id] = "keep";
        else out.fate[id] = !del || del.indexOf(id) >= 0 ? "deleted" : "lost";
      });
    }
    return out;
  }

  /** Après un téléchargement complet : sort des tournois locaux connus du cloud mais absents. */
  async function fateOfAbsent(snap) {
    const present = {};
    (snap.tournaments || []).forEach((t) => { if (isObj(t) && t.id) present[t.id] = true; });
    const ids = (TG.Store.snapshot().tournaments || [])
      .filter((t) => t && t.id && sync.base[t.id] && !present[t.id] && ID_RX.test(t.id)).map((t) => t.id);
    if (!ids.length) return {};
    return (await fetchIds(ids)).fate;
  }

  /** Sondage : renvoie ce qui attend, puis recharge ce qui a changé. */
  function checkRemote(force) {
    if (mode !== "cloud") {
      if (connecting && force) return retryInit().then(() => ({ ok: mode === "cloud" }));
      return Promise.resolve({ skipped: true });
    }
    if (!force && typeof document !== "undefined" && document.hidden) return Promise.resolve({ skipped: true });
    if (checking) { checkAgain = true; return checking; }
    checking = (async () => {
      try {
        if (!booted) {
          const r = await bootSync();
          return r && r.error ? r : { ok: true };
        }
        if (queue.length || dirtyCount) await flush();
        const wantAll = forceRefresh || forceFull || appliedRev < 0;
        const j = await getJSON(API + "?meta=1" + (wantAll ? "" : "&since=" + appliedRev));
        if (!j.configured) throw new Error("Cloud non configuré");
        const rev = toNum(j.rev);
        if (rev < appliedRev) {
          // Base Redis remise à zéro (ou changée) : fusion complète non
          // destructive, on repeuple le cloud avec nos tournois ET nos scores.
          resetKnowledge();
          booted = false;
          const r = await bootSync();
          return r && r.error ? r : { ok: true };
        }
        if (rev !== appliedRev || wantAll) {
          const full = forceFull || !isObj(j.revs);
          forceRefresh = false;
          forceFull = false;
          if (full) {
            refreshIds = {};
            const snap = await fetchState();
            applyRemote(snap, { fate: await fateOfAbsent(snap) });
          } else {
            await pullChanged(rev, j.revs);
          }
        }
        if (!flushing) setStatus(queue.length && failures ? "error" : "connected");
        return { ok: true };
      } catch (e) {
        setStatus("error");
        return { error: errMsg(e) };
      } finally {
        checking = null;
        if (checkAgain) { checkAgain = false; setTimeout(() => { checkRemote(); }, 0); }
      }
    })();
    return checking;
  }

  /** Rechargement manuel depuis le cloud (ne jette aucune saisie locale). */
  async function pullNow() {
    if (mode !== "cloud") {
      if (connecting) {
        await retryInit();
        if (mode === "cloud") return { ok: true, count: (TG.Store.snapshot().tournaments || []).length };
      }
      return { error: "Cloud non configuré." };
    }
    if (!booted) {
      const r = await bootSync();
      if (r && r.error) return r;
      return { ok: true, count: (TG.Store.snapshot().tournaments || []).length };
    }
    await flush();
    while (checking) await checking;
    forceRefresh = true;
    forceFull = true;
    const r = await checkRemote(true);
    if (r && r.error) return r;
    return { ok: true, count: (TG.Store.snapshot().tournaments || []).length };
  }

  function tick() {
    if (typeof document !== "undefined" && document.hidden) return;
    checkRemote();
  }
  function startPolling() {
    if (mode !== "cloud") return;
    stopPolling();
    pollTimer = setInterval(tick, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;
    try {
      window.addEventListener("online", () => {
        if (connecting) { retryInit(); return; }
        if (mode !== "cloud") return;
        failures = 0;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (booted) flush().then(() => checkRemote(true));
        else checkRemote(true);
      });
      const wake = () => {
        if (connecting) { retryInit(); return; }
        if (mode === "cloud" && pollTimer) checkRemote();
      };
      window.addEventListener("focus", wake);
      window.addEventListener("pageshow", wake);
      if (typeof document !== "undefined" && document.addEventListener) {
        document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
      }
    } catch (e) { /* environnement sans événements */ }
  }

  loadPersisted();

  window.TG = window.TG || {};
  TG.Cloud = {
    init, bootSync, isCloud,
    onStatus, getStatus, onRemoteChange, onNotice,
    scheduleSync, pushPending, pullNow,
    checkRemote, startPolling, stopPolling,
    pushScore, pushUnscore, pushResetScores,
    pendingCount, getInfo, testConnection,
  };
})();
