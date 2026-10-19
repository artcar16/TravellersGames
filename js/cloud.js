/* ============================================================
   cloud.js — Synchronisation « cloud » temps réel (v2).

   L'app dialogue avec la fonction serverless /api/store (Redis).
   Aucun token côté joueur. Si le magasin n'est pas configuré,
   l'app reste en mode « local » (localStorage), comme avant.

   Deux flux séparés :
   - STRUCTURE d'un tournoi (joueurs, réglages, tirage) : détectée par
     empreinte (diff avec le dernier état connu du cloud), envoyée en
     différé (~1 s), avec contrôle de concurrence (baseUpdatedAt) et
     fusion à 3 voies par groupe de champs (nom, date, réglages,
     joueurs+tirage…) si deux appareils éditent en même temps.
   - SCORES : un enregistrement par match. Chaque saisie / effacement /
     purge est une opération mise dans une FILE PERSISTÉE
     (localStorage « tg_cloud_ops_v1 »), envoyée aussitôt et dans
     l'ordre ; en cas d'échec réseau elle est conservée et renvoyée
     (nouvel essai progressif, sondage, événement « online », ou
     au prochain chargement de la page).

   Lecture : sondage du compteur de révision toutes les 4 s (pause si
   l'onglet est caché) ; s'il change, rechargement complet puis
   applyRemote : base = serveur, éditions de structure locales non
   envoyées fusionnées, et opérations de score encore en file (ou
   envoyées mais pas encore visibles dans l'instantané) superposées
   — un score saisi ne « disparaît » donc jamais de l'écran.
   ============================================================ */
(function () {
  "use strict";

  const API = "/api/store";
  const POLL_MS = 4000;          // sondage du compteur de révision
  const DEBOUNCE_MS = 1000;      // regroupe les éditions de structure rapprochées
  const TIMEOUT_MS = 12000;      // délai max d'une requête (réseau mobile capricieux)
  const RETRY_MAX_MS = 15000;    // nouvel essai progressif : 2 s, 4 s, 8 s, 15 s…
  const LS_OPS = "tg_cloud_ops_v1";    // file d'opérations (persistée)
  const LS_SYNC = "tg_cloud_sync_v1";  // empreintes du dernier état connu du cloud
  const ROSTER = "~roster";            // groupe indissociable : joueurs + tirage

  let mode = "local";            // local | cloud
  let status = "local";          // local | syncing | connected | error
  const statusListeners = [];
  const remoteListeners = [];

  // ----- Persisté -----
  let queue = [];                // [{k, op, tid, matchId?, record?, draw?, at?, keepDraw?}]
  // base[tid] = { h, g:{groupe:empreinte}, u:updatedAt serveur, s:{matchId: at} }
  let sync = { cloud: false, base: {} };

  // ----- Mémoire -----
  let booted = false;            // bootSync réussi au moins une fois
  let bootPromise = null;
  let appliedRev = -1;           // révision du dernier instantané appliqué
  let acked = [];                // ops confirmées pas encore visibles dans un instantané
  let structAck = {};            // tid -> révision de notre dernier upsert/delete confirmé
  let conflicted = {};           // tid -> true : upsert refusé (concurrence), à refusionner
  const rejected = {};           // tid -> empreinte refusée (400) : ne pas renvoyer en boucle
  let dirtyCount = 0;
  let opSeq = 0;
  const removedKeys = {};        // ops traitées / remplacées par CET onglet

  let syncTimer = null, retryTimer = null, pollTimer = null;
  let flushing = null, flushAgain = false;
  let checking = null, checkAgain = false;
  let failures = 0;
  let forceRefresh = false;
  let eventsBound = false;

  // ============================================================
  //  Utilitaires
  // ============================================================
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* quota / mode privé */ } }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
  function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
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

  /** Groupes de champs fusionnables indépendamment (joueurs + tirage ensemble). */
  function groupsOf(s) {
    const g = {};
    Object.keys(s).forEach((k) => {
      if (k === "updatedAt" || k === "scores" || k === "players" || k === "draw") return;
      g[k] = s[k];
    });
    g[ROSTER] = { players: s.players, draw: s.draw };
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
    return {
      h: legacy ? "legacy" : hashOf(struct),
      g: gh,
      u: typeof rawUpdatedAt === "number" ? rawUpdatedAt : null,
      s: knownOf(scores),
    };
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

  /**
   * Fusion à 3 voies d'une structure (b = empreintes de la base commune,
   * L = locale, S = serveur). Un groupe modifié d'un seul côté garde cette
   * modification ; modifié des deux côtés → le plus récent (updatedAt).
   */
  function merge3(b, L, S) {
    if (!b) return L;
    const out = clone(S);
    const lg = groupsOf(L), sg = groupsOf(S);
    const keys = {};
    Object.keys(lg).forEach((k) => { keys[k] = true; });
    Object.keys(sg).forEach((k) => { keys[k] = true; });
    const localWins = (L.updatedAt || 0) >= (S.updatedAt || 0);
    let took = false;
    Object.keys(keys).forEach((k) => {
      const lh = hashOf(lg[k]), sh = hashOf(sg[k]), bh = b.g ? b.g[k] : undefined;
      if (lh === sh || lh === bh) return;           // pas de modification locale
      if (sh !== bh && !localWins) return;          // conflit : le serveur est plus récent
      took = true;
      if (k === ROSTER) {
        if (lg[k].players === undefined) delete out.players; else out.players = clone(lg[k].players);
        if (lg[k].draw === undefined) delete out.draw; else out.draw = clone(lg[k].draw);
      } else if (lg[k] === undefined) delete out[k];
      else out[k] = clone(lg[k]);
    });
    if (!took) return out;                          // rien de local à garder : version serveur
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
    lsSet(LS_OPS, JSON.stringify(foreign.concat(queue)));
  }
  function persistSync() { lsSet(LS_SYNC, JSON.stringify(sync)); }

  // ============================================================
  //  Statut
  // ============================================================
  function pendingCount() { return queue.length + dirtyCount; }
  function emitStatus() {
    const n = pendingCount();
    statusListeners.slice().forEach((fn) => { try { fn(status, n); } catch (e) { /* écouteur fautif */ } });
  }
  function setStatus(s) { if (mode !== "cloud" && s !== "local") s = "local"; status = s; emitStatus(); }
  function onStatus(fn) { if (typeof fn === "function" && statusListeners.indexOf(fn) < 0) statusListeners.push(fn); }
  function getStatus() { return status; }
  function isCloud() { return mode === "cloud"; }
  function onRemoteChange(fn) {
    if (typeof fn === "function" && remoteListeners.indexOf(fn) < 0) remoteListeners.push(fn);
    return () => { const i = remoteListeners.indexOf(fn); if (i >= 0) remoteListeners.splice(i, 1); };
  }
  function notifyRemote() { remoteListeners.slice().forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

  // ============================================================
  //  Réseau
  // ============================================================
  async function fetchJSON(url, opts) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) { /* */ } }, TIMEOUT_MS) : null;
    try {
      const o = Object.assign({ cache: "no-store" }, opts || {});
      if (ctl) o.signal = ctl.signal;
      const r = await fetch(url, o);
      let json = null;
      try { json = await r.json(); } catch (e) { json = null; }
      return { ok: !!r.ok, status: r.status, json };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function getJSON(url) {
    const r = await fetchJSON(url, { headers: { Accept: "application/json" } });
    if (!r.ok || !r.json) throw new Error("Lecture impossible (" + r.status + ")");
    return r.json;
  }
  /** POST : {rev, ignored} | {permanent, error} ; lève une erreur si incident passager. */
  async function post(body) {
    const r = await fetchJSON(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 400 || r.status === 413 || r.status === 422) {
      return { permanent: true, error: (r.json && r.json.error) || ("HTTP " + r.status) };
    }
    if (!r.ok) throw new Error("Envoi refusé (" + r.status + ")");
    if (!r.json || !r.json.configured || !r.json.ok) throw new Error("Cloud indisponible");
    return { rev: typeof r.json.rev === "number" ? r.json.rev : null, ignored: r.json.ignored || null };
  }
  async function fetchState() {
    const j = await getJSON(API);
    if (!j.configured) throw new Error("Cloud non configuré");
    return { rev: toNum(j.rev), tournaments: Array.isArray(j.tournaments) ? j.tournaments : [] };
  }

  // ============================================================
  //  Démarrage
  // ============================================================
  async function init() {
    bindEvents();
    try {
      const j = await getJSON(API + "?meta=1");
      if (j && j.configured) {
        mode = "cloud";
        if (!sync.cloud) { sync.cloud = true; persistSync(); }
        setStatus("syncing");
      } else {
        mode = "local";
        if (sync.cloud) { sync.cloud = false; persistSync(); }
        setStatus("local");
      }
    } catch (e) {
      // Hors-ligne au démarrage : si cet appareil utilisait déjà le cloud, on
      // reste en mode cloud (les saisies sont mises en file et partiront au
      // retour du réseau) au lieu de basculer silencieusement en local.
      if (sync.cloud || queue.length) { mode = "cloud"; setStatus("error"); }
      else { mode = "local"; setStatus("local"); }
    }
    return mode;
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
        const res = mergeBoot(snap);
        booted = true;
        appliedRev = snap.rev;
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

  function mergeBoot(snap) {
    const localList = (TG.Store.snapshot().tournaments || []).filter((t) => t && t.id);
    const localById = {};
    localList.forEach((t) => { localById[t.id] = t; });
    const deleting = queuedDeletes();
    const out = [], seen = {}, toPush = [];

    (snap.tournaments || []).forEach((raw) => {
      if (!isObj(raw) || !raw.id || seen[raw.id]) return;
      seen[raw.id] = true;
      if (deleting[raw.id]) return;
      const S = normalize(raw);
      if (!S) { if (localById[raw.id]) out.push(clone(localById[raw.id])); return; }  // illisible : on garde le local
      const L = localById[S.id], b = sync.base[S.id];
      let struct = S.struct, scores = S.scores;
      if (L) {
        const ls = structOf(L), lh = hashOf(ls);
        if (lh !== hashOf(S.struct)) {
          if (b) { if (lh !== b.h) struct = merge3(b, clone(ls), S.struct); }
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
      const b = sync.base[L.id];
      if (b) {
        delete sync.base[L.id];
        if (hashOf(structOf(L)) === b.h) return;     // supprimé ailleurs pendant notre absence
      }
      const t = clone(L);
      t.scores = unionScores(L.id, L.scores, {}, null, drawOf(t), toPush);
      overlay(L.id, t.scores, drawOf(t), snap.rev);
      out.push(t);
    });

    TG.Store.replaceAll({ tournaments: out });
    toPush.forEach((p) => {
      const has = queue.some((q) => (q.op === "score" || q.op === "unscore") && q.tid === p.tid && q.matchId === p.matchId);
      if (!has) enqueue({ op: "score", tid: p.tid, matchId: p.matchId, record: clone(p.record) });
    });
    persistSync();
    computeDirty(false);
    return { count: out.length, pushed: toPush.length };
  }

  // ============================================================
  //  Application d'un état distant
  // ============================================================
  /** Superpose les opérations locales pas encore visibles dans l'instantané `rev`. */
  function overlay(tid, scores, cur, rev) {
    const ops = acked.filter((a) => a.tid === tid && a.rev > rev).concat(queue.filter((q) => q.tid === tid));
    ops.forEach((op) => {
      if (op.op === "score") {
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
    persistSync();
  }

  /**
   * Applique un instantané serveur. Base = serveur (structure + scores), puis :
   * - tournoi avec édition de structure locale non envoyée → fusion à 3 voies
   *   (la modification locale est conservée, les scores serveur aussi) ;
   * - tournoi que l'on vient d'écrire (révision > instantané) → version locale ;
   * - opérations de score en file / confirmées mais pas encore visibles →
   *   superposées : l'UI ne recule jamais.
   */
  function applyRemote(snap) {
    if (!snap || typeof snap.rev !== "number" || snap.rev < appliedRev) return false;
    const rev = snap.rev;
    const localList = (TG.Store.snapshot().tournaments || []).filter((t) => t && t.id);
    const localById = {};
    localList.forEach((t) => { localById[t.id] = t; });
    const deleting = queuedDeletes();
    const out = [], seen = {};
    let needPush = false;

    (snap.tournaments || []).forEach((raw) => {
      if (!isObj(raw) || !raw.id || seen[raw.id]) return;
      seen[raw.id] = true;
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
            struct = merge3(b, clone(ls), S.struct);
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
      if ((structAck[L.id] != null ? structAck[L.id] : -1) > rev) { out.push(clone(L)); return; }
      if (sync.base[L.id]) { delete sync.base[L.id]; return; }   // supprimé par un autre appareil
      out.push(clone(L));                                          // jamais envoyé : sera créé
      needPush = true;
    });

    appliedRev = rev;
    acked = acked.filter((a) => a.rev > rev);
    persistSync();
    const changed = differs(localList, out);
    if (changed) TG.Store.replaceAll({ tournaments: out });
    computeDirty(false);
    emitStatus();
    if (needPush || dirtyCount) kick();
    if (changed) notifyRemote();
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
  function pushScore(tid, matchId, record) {
    if (!isObj(record) || typeof tid !== "string" || typeof matchId !== "string") return;
    const rec = { s1: record.s1, s2: record.s2, p1: record.p1, p2: record.p2, draw: record.draw, at: Number(record.at) || Date.now() };
    // Une correction l'emporte toujours sur le score qu'on a vu, même si
    // l'horloge de cet appareil retarde.
    const seen = seenAt(tid, matchId);
    if (seen != null && !(rec.at > seen)) rec.at = seen + 1;
    enqueue({ op: "score", tid, matchId, record: rec });
    kick();
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

  async function pushStructures() {
    for (let guard = 0; guard < 200; guard++) {
      const u = computeDirty(true).filter((x) => !conflicted[x.id])[0];
      if (!u) return;
      const payload = clone(u.struct);
      const b = sync.base[u.id];
      const body = { op: "upsert", tournament: payload };
      if (b && typeof b.u === "number" && b.h !== "legacy") body.baseUpdatedAt = b.u;
      const r = await post(body);
      if (r.permanent) {
        rejected[u.id] = u.h;
        console.error("Cloud : tournoi refusé par le serveur", u.id, r.error);
        continue;
      }
      if (r.ignored === "conflict") {
        // Quelqu'un d'autre a modifié ce tournoi : on recharge et on fusionne.
        conflicted[u.id] = true;
        forceRefresh = true;
        continue;
      }
      if (typeof r.rev === "number") structAck[u.id] = r.rev;
      const nb = baseOf(payload, payload.updatedAt, null, false);
      nb.s = b && b.s ? b.s : {};
      sync.base[u.id] = nb;
      persistSync();
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
      return { op: "score", tid: op.tid, matchId: op.matchId, record: op.record };
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

  async function pushQueue() {
    for (let guard = 0; guard < 10000 && queue.length; guard++) {
      // Une opération ne part que si la structure de son tournoi est à jour
      // dans le cloud (sinon le tirage côté serveur pourrait différer).
      const blocked = {};
      computeDirty(false).forEach((u) => { blocked[u.id] = true; });
      Object.keys(conflicted).forEach((id) => { blocked[id] = true; });
      const op = queue.find((q) => q.op === "delete" || !blocked[q.tid]);
      if (!op) return;
      const wire = wireOf(op);
      if (!wire) { removeOp(op.k); continue; }
      const r = await post(wire);
      removeOp(op.k);
      if (r.permanent) { console.error("Cloud : opération refusée", wire, r.error); continue; }
      if (r.ignored) { forceRefresh = true; continue; }
      if (op.op === "delete") {
        if (typeof r.rev === "number") structAck[op.tid] = r.rev;
        delete sync.base[op.tid];
        persistSync();
        continue;
      }
      if (typeof r.rev === "number") {
        acked.push(Object.assign({}, op, { rev: r.rev }));
        if (acked.length > 2000) acked.splice(0, acked.length - 2000);
      }
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
    return queue.length ? { error: queue.length + " opération(s) encore en attente." } : { ok: true };
  }

  // ============================================================
  //  Lecture « temps réel »
  // ============================================================
  /** Sondage : renvoie ce qui attend, puis recharge si la révision a changé. */
  function checkRemote(force) {
    if (mode !== "cloud") return Promise.resolve({ skipped: true });
    if (!force && typeof document !== "undefined" && document.hidden) return Promise.resolve({ skipped: true });
    if (checking) { checkAgain = true; return checking; }
    checking = (async () => {
      try {
        if (!booted) {
          const r = await bootSync();
          return r && r.error ? r : { ok: true };
        }
        if (queue.length || dirtyCount) await flush();
        const j = await getJSON(API + "?meta=1");
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
        if (rev !== appliedRev || forceRefresh) {
          forceRefresh = false;
          const snap = await fetchState();
          applyRemote(snap);
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
    if (mode !== "cloud") return { error: "Cloud non configuré." };
    if (!booted) {
      const r = await bootSync();
      if (r && r.error) return r;
      return { ok: true, count: (TG.Store.snapshot().tournaments || []).length };
    }
    await flush();
    while (checking) await checking;
    forceRefresh = true;
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
        if (mode !== "cloud") return;
        failures = 0;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (booted) flush().then(() => checkRemote(true));
        else checkRemote(true);
      });
      const wake = () => { if (mode === "cloud" && pollTimer) checkRemote(); };
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
    onStatus, getStatus, onRemoteChange,
    scheduleSync, pushPending, pullNow,
    checkRemote, startPolling, stopPolling,
    pushScore, pushUnscore, pushResetScores,
    pendingCount,
  };
})();
