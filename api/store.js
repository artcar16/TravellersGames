/* ============================================================
   api/store.js — Base de données « cloud » de The Travellers (v2.1).

   Fonction serverless Vercel (Node, CommonJS, sans dépendance)
   adossée à un magasin Redis (Vercel KV / Upstash) via son API
   REST. La clé secrète reste UNIQUEMENT côté serveur : les joueurs
   n'ont aucun token à saisir, tout est partagé.

   Modèle de données Redis :
     - tg:ids          SET des identifiants de tournois
     - tg:t:<id>       STRING : JSON de la STRUCTURE d'un tournoi
                       (joueurs, réglages, tirage — jamais les scores)
     - tg:s:<id>       HASH   : matchId -> JSON d'un score
                       { s1, s2, p1, p2, draw, at, by? }
     - tg:rev          compteur incrémenté à CHAQUE écriture
                       (sert au rafraîchissement « temps réel »)
     - tg:rv           HASH   : id -> jeton de révision du tournoi (change
                       à chaque écriture qui le touche) : les appareils ne
                       rechargent QUE les tournois modifiés
     - tg:bak:v1:<id>  STRING : sauvegarde (une seule fois) d'un tournoi de
                       l'ancien format (v1) avant qu'il ne soit écrasé
     - tg:del:<id>     STRING : « pierre tombale » d'un tournoi supprimé (1 an) :
                       distingue une suppression d'une perte de données (base
                       Redis vidée / remplacée), où l'on recrée au lieu de refuser
     - tg:lk:<id>      verrou court (SET NX PX) par tournoi

   Un score = un champ de hash : deux saisies simultanées sur deux
   matchs différents ne peuvent jamais s'écraser, et une édition de
   la structure (nom, réglages…) ne touche jamais aux scores.

   API :
     GET  /api/store?meta=1[&since=R] -> { configured, rev, revs? }   (sondage léger ;
                                  revs = {id: jeton}, omis si since === rev)
     GET  /api/store               -> { configured, rev, revs, tournaments:[{...structure, scores}] }
     GET  /api/store?ids=a,b       -> idem, seulement ces tournois (+ missing:[ids absents],
                                  deleted:[ids absents car SUPPRIMÉS] ; absent sans être supprimé
                                  = données perdues côté Redis → le client recrée)
     POST /api/store
       { op:"upsert", tournament, base?, baseUpdatedAt?, baseDraw? }  structure (scores retirés)
       { op:"delete", id }                       structure + scores
       { op:"score", tid, matchId, record, overwrite? }   un score
       { op:"unscore", tid, matchId, draw?, at? }
       { op:"resetScores", tid, keepDraw }       purge des scores d'un autre tirage
       { op:"replaceAll", tournaments }          remplace tout (structures + scores)
     -> { ok:true, configured:true, rev, rv?, prv? }  (+ ignored:"raison" si l'écriture
        a été volontairement écartée, voir ci-dessous ; + current: score en place
        pour ignored "exists" / "older")

   Garde-fous (toutes les écritures d'un tournoi se font sous un verrou
   court par tournoi : « lire → comparer → écrire » est ATOMIQUE) :
     - upsert : si la requête est basée sur une version connue (base,
       baseUpdatedAt, baseDraw) et que le tournoi a été supprimé → rien n'est
       écrit (ignored:"deleted", pas de tournoi « zombie ») ; si la structure
       stockée a un autre updatedAt, ou un autre tirage que baseDraw alors
       que la requête ne porte pas ce tirage → ignored:"conflict" ; le
       client recharge, fusionne et renvoie.
     - score : tournoi supprimé → ignored:"deleted" (aucune écriture ; absent
       sans pierre tombale → ignored:"missing", le client le recrée) ; score
       d'un autre tirage que le tirage courant → ignored:"staleDraw" ; même
       match déjà saisi (même tirage, mêmes joueurs) avec un résultat
       DIFFÉRENT → la PREMIÈRE saisie gagne (ignored:"exists") sauf
       overwrite:true (correction volontaire) ou même appareil (`by`) ; une
       correction plus ANCIENNE (`at`) n'écrase pas la plus récente
       (ignored:"older").
     - unscore : tournoi supprimé → ignored ; si `draw` / `at` sont fournis,
       on n'efface que le score de ce tirage, pas plus récent que `at`.
     - resetScores : tournoi supprimé → ignored ; n'efface JAMAIS un score
       dont draw === keepDraw.
     - Un tournoi de l'ancien format (v !== 2) est sauvegardé une fois
       (SET tg:bak:v1:<id> NX) dans la même transaction que son écrasement.
     - Chaque appel Redis a un délai maximal (7 s) et chaque requête un budget
       total (~7,5 s) : Redis lent ou bloqué → 503 JSON, jamais de requête pendante.

   Si aucune variable d'environnement n'est configurée, la fonction
   répond { configured:false } et l'application reste en mode local.
   ============================================================ */
"use strict";

/**
 * Résout l'URL REST + le token d'écriture du magasin Redis, quel que soit
 * le nommage des variables d'environnement. On gère les noms standards
 * (Vercel KV, Upstash) puis, à défaut, tout couple « *REST*URL » / « *REST*TOKEN »
 * — utile si un préfixe personnalisé a été appliqué lors du branchement.
 * On exclut systématiquement les tokens en lecture seule (READ_ONLY).
 */
function resolveCreds() {
  const env = process.env;
  const known = [
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  ];
  for (const [u, t] of known) {
    if (env[u] && env[t]) return { url: env[u], token: env[t] };
  }
  const keys = Object.keys(env);
  const isHttps = (v) => typeof v === "string" && /^https:\/\//.test(v);
  const urlKey =
    keys.find((k) => /REST.*URL$/i.test(k) && isHttps(env[k])) ||
    keys.find((k) => /URL$/i.test(k) && isHttps(env[k]) && /REDIS|KV|UPSTASH|STORAGE/i.test(k));
  const tokenKey =
    keys.find((k) => /REST.*TOKEN$/i.test(k) && !/READ_ONLY/i.test(k)) ||
    keys.find((k) => /TOKEN$/i.test(k) && !/READ_ONLY/i.test(k) && /REDIS|KV|UPSTASH|STORAGE/i.test(k));
  return { url: urlKey ? env[urlKey] : "", token: tokenKey ? env[tokenKey] : "" };
}

const _creds = resolveCreds();
const REDIS_URL = String(_creds.url || "").replace(/\/+$/, "");
const REDIS_TOKEN = _creds.token || "";

const K_IDS = "tg:ids";
const K_REV = "tg:rev";
const K_RV = "tg:rv";
const kT = (id) => "tg:t:" + id;
const kS = (id) => "tg:s:" + id;
const kL = (id) => "tg:lk:" + id;        // verrou court par tournoi
const kBak = (id) => "tg:bak:v1:" + id;  // sauvegarde de l'ancien format
const kDel = (id) => "tg:del:" + id;     // pierre tombale (tournoi supprimé)
const TOMB_S = 365 * 24 * 3600;          // durée de vie d'une pierre tombale
const LOCK_MS = 6000;                    // durée de vie d'un verrou (expire seul)
const LOCK_WAIT_MS = 4000;               // attente max pour l'obtenir
const REDIS_TIMEOUT_MS = 7000;           // délai max d'un appel Redis
const REQUEST_BUDGET_MS = 7500;          // délai max d'une requête (tous appels Redis compris)
const MAX_IDS_PER_GET = 100;

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const NAME_MAX = 200;
const MAX_PLAYERS = 2000;
const MAX_STRUCT_CHARS = 900000;     // ~0,9 Mo par tournoi (un tournoi de 128 joueurs ≈ 40 Ko)
const MAX_TOURNAMENTS = 300;         // replaceAll

function configured() {
  return !!(REDIS_URL && REDIS_TOKEN);
}

// ---------------------------------------------------------------
//  Erreurs
// ---------------------------------------------------------------
class BadRequest extends Error {}
/** Incident passager (Redis lent / injoignable, tournoi occupé) → 503. */
class Unavailable extends Error {}

/**
 * Budget de temps d'une requête : chaque appel Redis est borné par le temps
 * qui reste, pour toujours répondre (503 JSON) avant ~7,5 s même si Redis
 * est lent ou bloqué.
 */
function budget(ms) {
  const end = Date.now() + (ms || REQUEST_BUDGET_MS);
  return () => {
    const left = end - Date.now();
    if (left < 200) throw new Unavailable("Base de données trop lente, réessayez.");
    return Math.min(REDIS_TIMEOUT_MS, left);
  };
}

// ---------------------------------------------------------------
//  Accès Redis (API REST Upstash)
// ---------------------------------------------------------------
async function call(path, commands, timeoutMs) {
  const ms = Math.max(250, Math.min(REDIS_TIMEOUT_MS, Number(timeoutMs) || REDIS_TIMEOUT_MS));
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) { /* */ } }, ms) : null;
  try {
    let res;
    try {
      res = await fetch(REDIS_URL + path, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + REDIS_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(commands),
        signal: ctl ? ctl.signal : undefined,
      });
    } catch (e) {
      if (ctl && ctl.signal.aborted) throw new Unavailable("Base de données indisponible (délai dépassé), réessayez.");
      throw new Unavailable("Base de données injoignable, réessayez.");
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      const err = new Error("Redis " + res.status + " " + String(txt).slice(0, 200));
      err.status = res.status;
      throw err;
    }
    let data;
    try {
      data = await res.json(); // [{result}|{error}, ...]
    } catch (e) {
      if (ctl && ctl.signal.aborted) throw new Unavailable("Base de données indisponible (délai dépassé), réessayez.");
      throw new Error("Redis : réponse illisible");
    }
    if (!Array.isArray(data)) throw new Error("Redis : réponse inattendue");
    return data.map((d) => {
      if (d && d.error) throw new Error("Redis : " + d.error);
      return d ? d.result : null;
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Pile de commandes (exécutées dans l'ordre, non atomique). */
function redis(commands, timeoutMs) { return call("/pipeline", commands, timeoutMs); }

/** Transaction atomique (MULTI/EXEC) ; repli sur /pipeline si le point d'accès n'existe pas. */
async function redisTx(commands, timeoutMs) {
  try {
    return await call("/multi-exec", commands, timeoutMs);
  } catch (e) {
    if (e && (e.status === 404 || e.status === 405 || e.status === 501)) return redis(commands, timeoutMs);
    throw e;
  }
}

// ---------------------------------------------------------------
//  Utilitaires / validation
// ---------------------------------------------------------------
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function parseJSON(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}
function isPlainObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isId = (v) => typeof v === "string" && ID_RE.test(v);
const isScore = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 99;
const isTime = (v) => typeof v === "number" && Number.isFinite(v);
const isStrMax = (v, max) => typeof v === "string" && v.length <= max;
/** Champ libre facultatif : absent, nombre fini ou texte borné. */
const isOptField = (v, max) => v == null || (typeof v === "number" && Number.isFinite(v)) || isStrMax(v, max);
function drawIdOf(s) { return isPlainObject(s) && isPlainObject(s.draw) && typeof s.draw.id === "string" ? s.draw.id : null; }
function newToken() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function readBody(req) {
  let b;
  try { b = req.body; } catch (e) { throw new BadRequest("JSON invalide."); }
  if (b == null || b === "") throw new BadRequest("Corps de requête manquant.");
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(b)) b = b.toString("utf8");
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch (e) { throw new BadRequest("JSON invalide."); }
  }
  if (!isPlainObject(b)) throw new BadRequest("Corps de requête invalide.");
  return b;
}

/** Enregistrement de score validé et normalisé, ou null. */
function cleanRecord(r) {
  if (!isPlainObject(r)) return null;
  if (!isScore(r.s1) || !isScore(r.s2)) return null;
  if (!isId(r.p1) || !isId(r.p2) || !isId(r.draw)) return null;
  if (!isTime(r.at)) return null;
  const out = { s1: r.s1, s2: r.s2, p1: r.p1, p2: r.p2, draw: r.draw, at: r.at };
  if (isId(r.by)) out.by = r.by;     // appareil auteur (facultatif)
  return out;
}
function publicRecord(r) { return r ? { s1: r.s1, s2: r.s2, p1: r.p1, p2: r.p2, draw: r.draw, at: r.at } : null; }

function needId(v, what) {
  if (!isId(v)) throw new BadRequest("Identifiant invalide (" + what + ").");
  return v;
}
function optDraw(v, what) {
  if (v == null) return null;
  if (!isId(v)) throw new BadRequest("Tirage invalide (" + what + ").");
  return v;
}

function bad(msg) { throw new BadRequest(msg); }

/** Joueurs : ids uniques, noms bornés (le moteur limite à 80 caractères). */
function checkPlayers(ps) {
  if (!Array.isArray(ps)) bad("Liste de joueurs invalide.");
  if (ps.length > MAX_PLAYERS) bad("Trop de joueurs.");
  const seen = new Set();
  ps.forEach((p) => {
    if (!isPlainObject(p) || !isId(p.id)) bad("Joueur invalide (identifiant).");
    if (seen.has(p.id)) bad("Joueur en double (" + p.id + ").");
    seen.add(p.id);
    if (!isStrMax(p.name, NAME_MAX)) bad("Nom de joueur invalide (" + NAME_MAX + " caractères max).");
    if (!isOptField(p.club, NAME_MAX) || !isOptField(p.rating, 40) || !isOptField(p.note, 2000)) bad("Fiche joueur invalide.");
  });
}

/** Tirage : forme stricte (mêmes règles que le moteur), aucune valeur libre. */
function checkDraw(d) {
  if (!isPlainObject(d) || !isId(d.id)) bad("Tirage invalide.");
  if (!Array.isArray(d.p1) || !Array.isArray(d.slots)) bad("Tirage invalide (p1 / slots).");
  const p1ids = new Set();
  d.p1.forEach((m) => {
    if (!isPlainObject(m) || !isId(m.id) || p1ids.has(m.id) || !isId(m.a) || !isId(m.b)) bad("Tirage invalide (match de phase 1).");
    p1ids.add(m.id);
  });
  const P = d.slots.length;
  if (P < 1 || P > 4096 || (P & (P - 1)) !== 0) bad("Tirage invalide (taille du tableau).");
  d.slots.forEach((sl) => {
    if (!isPlainObject(sl)) bad("Tirage invalide (place).");
    if (sl.kind === "match") { if (!isId(sl.ref) || !p1ids.has(sl.ref)) bad("Tirage invalide (référence de match)."); }
    else if (sl.kind === "bye") { if (!isId(sl.pid)) bad("Tirage invalide (exempt)."); }
    else if (sl.kind === "rep") { if (!Number.isInteger(sl.k) || sl.k < 1 || sl.k > P) bad("Tirage invalide (repêchage)."); }
    else bad("Tirage invalide (type de place).");
  });
  ["n", "size", "qualifiers", "repechage"].forEach((k) => {
    if (d[k] != null && !(Number.isInteger(d[k]) && d[k] >= 0 && d[k] <= 100000)) bad("Tirage invalide (" + k + ").");
  });
  if (d.exempt != null && !isId(d.exempt)) bad("Tirage invalide (exempt).");
  if (d.at != null && !isTime(d.at)) bad("Tirage invalide (date).");
  ["tiebreak", "consOrder"].forEach((k) => {
    const o = d[k];
    if (o == null) return;
    if (!isPlainObject(o)) bad("Tirage invalide (" + k + ").");
    Object.keys(o).forEach((pid) => { if (!isId(pid) || !isTime(o[pid])) bad("Tirage invalide (" + k + ")."); });
  });
}

/** Structure d'un tournoi (sans scores) validée + sérialisée. */
function cleanStructure(t) {
  if (!isPlainObject(t)) bad("Tournoi invalide.");
  needId(t.id, "tournoi");
  const s = Object.assign({}, t);
  delete s.scores;
  if (s.v != null && typeof s.v !== "number") bad("Version invalide.");
  if (s.name != null && !isStrMax(s.name, NAME_MAX)) bad("Nom du tournoi invalide (" + NAME_MAX + " caractères max).");
  if (!isOptField(s.date, NAME_MAX)) bad("Date invalide.");
  if (s.createdAt != null && !isTime(s.createdAt)) bad("createdAt invalide.");
  if (s.updatedAt != null && !isTime(s.updatedAt)) bad("updatedAt invalide.");
  if (s.settings != null && !isPlainObject(s.settings)) bad("Réglages invalides.");
  if (s.players != null) checkPlayers(s.players);
  if (s.draw != null) checkDraw(s.draw);
  let json;
  try { json = JSON.stringify(s); } catch (e) { bad("Tournoi invalide."); }
  if (json.length > MAX_STRUCT_CHARS) bad("Tournoi trop volumineux.");
  return { id: s.id, json, draw: drawIdOf(s) };
}

/** Scores d'un tournoi (replaceAll) : { matchId: record } validés. */
function cleanScores(scores) {
  if (scores == null) return [];
  if (!isPlainObject(scores)) bad("Scores invalides.");
  const pairs = [];
  Object.keys(scores).forEach((mid) => {
    needId(mid, "match");
    const rec = cleanRecord(scores[mid]);
    if (!rec) bad("Score invalide (" + mid + ").");
    pairs.push(mid, JSON.stringify(rec));
  });
  return pairs;
}

/** HGETALL renvoie [f1, v1, f2, v2…] via REST (objet toléré aussi). */
function hashPairs(h) {
  const out = [];
  if (Array.isArray(h)) {
    for (let i = 0; i + 1 < h.length; i += 2) out.push([String(h[i]), h[i + 1]]);
  } else if (isPlainObject(h)) {
    Object.keys(h).forEach((k) => out.push([k, h[k]]));
  }
  return out;
}

function scoresFromHash(h) {
  const scores = {};
  hashPairs(h).forEach(([f, v]) => {
    const rec = publicRecord(cleanRecord(parseJSON(v)));
    if (rec) scores[f] = rec;
  });
  return scores;
}

/** Une structure stockée doit-elle être sauvegardée avant d'être écrasée ? (ancien format) */
function needsBackup(curJson) {
  if (curJson == null) return false;
  const cur = parseJSON(curJson);
  return !(isPlainObject(cur) && cur.v === 2);
}

function done(res, r) {
  const body = { ok: true, configured: true, rev: toNum(r.rev) };
  if (r.ignored) body.ignored = r.ignored;
  if (r.rv != null) body.rv = String(r.rv);
  if (hasOwn(r, "prv")) body.prv = r.prv == null ? "0" : String(r.prv);
  if (r.current) body.current = r.current;
  if (r.recreated) body.recreated = true;
  return res.status(200).json(body);
}

// ---------------------------------------------------------------
//  Lecture
// ---------------------------------------------------------------
function idList(ids) { return (Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id); }
function revsOf(list, rvHash) {
  const rv = {};
  hashPairs(rvHash).forEach(([f, v]) => { rv[f] = v; });
  const out = {};
  list.forEach((id) => { out[id] = rv[id] != null ? String(rv[id]) : "0"; });
  return out;
}

async function readMany(list, left) {
  const tournaments = [];
  if (!list.length) return tournaments;
  const out = await redis([["MGET", ...list.map(kT)], ...list.map((id) => ["HGETALL", kS(id)])], left());
  const vals = Array.isArray(out[0]) ? out[0] : [];
  list.forEach((id, i) => {
    const t = parseJSON(vals[i]);
    if (!isPlainObject(t)) return;
    if (!t.id) t.id = id;
    t.scores = scoresFromHash(out[i + 1]);
    tournaments.push(t);
  });
  return tournaments;
}

async function readAll(left) {
  // Le compteur (et les jetons) sont lus AVANT les données : un instantané de
  // révision R contient toujours au moins toutes les écritures de révision <= R.
  const [rev, ids, rvs] = await redis([["GET", K_REV], ["SMEMBERS", K_IDS], ["HGETALL", K_RV]], left());
  const list = idList(ids);
  const tournaments = await readMany(list, left);
  return { rev: toNum(rev), revs: revsOf(list, rvs), tournaments };
}

async function readIds(ids, left) {
  const [rev, members, rvs, tombs] = await redis([["GET", K_REV], ["SMEMBERS", K_IDS], ["HMGET", K_RV, ...ids], ["MGET", ...ids.map(kDel)]], left());
  const set = new Set(idList(members));
  const revs = {};
  const present = [], missing = [], deleted = [];
  ids.forEach((id, i) => {
    if (!set.has(id)) {
      missing.push(id);
      if (Array.isArray(tombs) && tombs[i] != null) deleted.push(id);
      return;
    }
    present.push(id);
    const v = Array.isArray(rvs) ? rvs[i] : null;
    revs[id] = v != null ? String(v) : "0";
  });
  const tournaments = await readMany(present, left);
  return { rev: toNum(rev), revs, tournaments, missing, deleted };
}

async function readMeta(since, left) {
  if (since != null) {
    const [rev] = await redis([["GET", K_REV]], left());
    if (toNum(rev) === since) return { rev: toNum(rev) };
  }
  const [rev, ids, rvs] = await redis([["GET", K_REV], ["SMEMBERS", K_IDS], ["HGETALL", K_RV]], left());
  return { rev: toNum(rev), revs: revsOf(idList(ids), rvs) };
}

function parseIds(q) {
  let raw = q.ids;
  if (Array.isArray(raw)) raw = raw.join(",");
  const ids = [];
  String(raw || "").split(",").forEach((s) => {
    const id = s.trim();
    if (!id) return;
    if (!isId(id)) bad("Identifiant invalide (ids).");
    if (ids.indexOf(id) < 0) ids.push(id);
  });
  if (!ids.length) bad("Liste d'identifiants vide.");
  if (ids.length > MAX_IDS_PER_GET) bad("Trop d'identifiants (" + MAX_IDS_PER_GET + " max).");
  return ids;
}

// ---------------------------------------------------------------
//  Écritures
// ---------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Verrou court par tournoi (SET NX PX) : rend atomique « lire l'état courant →
 * comparer → écrire » même si plusieurs requêtes arrivent ensemble (toutes
 * les écritures d'un tournoi le prennent). Expire seul si la fonction
 * s'interrompt. `lk.left()` borne les appels Redis faits sous verrou ;
 * `lk.unlock()` renvoie la commande de libération à joindre à la dernière
 * transaction (économise un aller-retour) tant que le verrou est sûrement à nous.
 */
async function withLock(id, fn) {
  const key = kL(id);
  const token = newToken() + Math.random().toString(36).slice(2, 6);
  const t0 = Date.now();
  const left = budget();
  let acquiredAt = 0;
  for (;;) {
    let got;
    try {
      [got] = await redis([["SET", key, token, "NX", "PX", LOCK_MS]], left());
    } catch (e) {
      // Réponse perdue alors que le verrou a peut-être été pris : on tente de le
      // rendre, sans retarder la réponse (il expirera de toute façon).
      redis([["GET", key]], 1500)
        .then(([cur]) => (cur === token ? redis([["DEL", key]], 1500) : null))
        .catch(() => { /* expirera */ });
      throw e;
    }
    if (got === "OK") { acquiredAt = Date.now(); break; }
    if (Date.now() - t0 > LOCK_WAIT_MS) throw new Unavailable("Tournoi momentanément occupé, réessayez.");
    await sleep(20 + Math.floor(Math.random() * 50));
  }
  const fresh = () => Date.now() - acquiredAt < LOCK_MS - 1500;
  let released = false;
  const lk = {
    left: () => {
      const ms = LOCK_MS - 500 - (Date.now() - acquiredAt);
      if (ms < 250) throw new Unavailable("Tournoi momentanément occupé, réessayez.");
      return Math.min(ms, left());
    },
    unlock: () => {
      if (!fresh()) return [];
      released = true;
      return [["DEL", key]];
    },
  };
  let ok = false;
  try {
    const r = await fn(lk);
    ok = true;
    return r;
  } finally {
    if (!(ok && released)) {
      try {
        if (fresh()) await redis([["DEL", key]], 2000);
        else {
          const [cur] = await redis([["GET", key]], 2000);
          if (cur === token) await redis([["DEL", key]], 2000);
        }
      } catch (e) { /* le verrou expirera tout seul */ }
    }
  }
}

/**
 * Suppression conditionnelle de champs d'un hash : lecture + suppression dans
 * une même transaction, puis restauration (HSETNX : jamais d'écrasement) de
 * toute valeur qui n'aurait pas dû partir. Exécutée sous le verrou du tournoi
 * (ceinture et bretelles si un écrivain ne le respectait pas).
 */
async function conditionalDelete(tid, fields, shouldDelete, lk) {
  const key = kS(tid);
  const tok = newToken();
  const out = await redisTx([["HMGET", key, ...fields], ["HDEL", key, ...fields], ["HSET", K_RV, tid, tok], ["INCR", K_REV]], lk.left());
  const vals = Array.isArray(out[0]) ? out[0] : [];
  const restore = [];
  fields.forEach((f, i) => {
    const v = vals[i];
    if (v == null) return;
    if (!shouldDelete(parseJSON(v))) restore.push(["HSETNX", key, f, typeof v === "string" ? v : JSON.stringify(v)]);
  });
  let rev = toNum(out[3]), rv = tok;
  if (restore.length) {
    rv = newToken();
    const o2 = await redis([...restore, ["HSET", K_RV, tid, rv], ["INCR", K_REV]], lk.left());
    rev = toNum(o2[o2.length - 1]);
  }
  return { rev, rv };
}

async function opUpsert(body) {
  const s = cleanStructure(body.tournament);
  const hasBUA = body.baseUpdatedAt != null;
  if (hasBUA && !isTime(body.baseUpdatedAt)) bad("baseUpdatedAt invalide.");
  const hasBaseDraw = hasOwn(body, "baseDraw");
  const baseDraw = hasBaseDraw ? optDraw(body.baseDraw, "baseDraw") : null;
  // Écriture basée sur une version vue par le client : contrôle de concurrence.
  const based = hasBUA || hasBaseDraw || body.base === true;
  return withLock(s.id, async (lk) => {
    const [curJson, rev0, prv, tomb] = await redis([["GET", kT(s.id)], ["GET", K_REV], ["HGET", K_RV, s.id], ["EXISTS", kDel(s.id)]], lk.left());
    const cur = parseJSON(curJson);
    // Supprimé entre-temps : on ne recrée pas un tournoi « zombie ». (Absent
    // SANS pierre tombale = données perdues côté Redis : on le recrée.)
    if (based && curJson == null && toNum(tomb) > 0) return { rev: rev0, ignored: "deleted" };
    if (based && curJson != null) {
      // Quelqu'un a écrit entre-temps → le client recharge, fusionne et renvoie.
      if (hasBUA && isPlainObject(cur) && cur.updatedAt !== body.baseUpdatedAt) return { rev: rev0, ignored: "conflict" };
      // Tirage fait / refait / annulé ailleurs : une édition basée sur l'ancien
      // tirage ne peut pas le défaire.
      if (hasBaseDraw && isPlainObject(cur)) {
        const cd = drawIdOf(cur);
        if (cd !== baseDraw && s.draw !== cd) return { rev: rev0, ignored: "conflict" };
      }
    }
    const tok = newToken();
    const cmds = [];
    if (needsBackup(curJson)) cmds.push(["SET", kBak(s.id), String(curJson), "NX"]);
    cmds.push(["SET", kT(s.id), s.json], ["SADD", K_IDS, s.id], ["HSET", K_RV, s.id, tok], ["INCR", K_REV]);
    const iRev = cmds.length - 1;
    const out = await redisTx(cmds.concat(lk.unlock()), lk.left());
    // Recréé après une perte de données : le client renvoie aussi ses scores.
    return { rev: out[iRev], rv: tok, prv, recreated: based && curJson == null };
  });
}

async function opDelete(body) {
  const id = needId(body.id != null ? body.id : body.tid, "tournoi");
  return withLock(id, async (lk) => {
    const [curJson] = await redis([["GET", kT(id)]], lk.left());
    const cmds = [];
    if (needsBackup(curJson)) cmds.push(["SET", kBak(id), String(curJson), "NX"]);
    cmds.push(["DEL", kT(id), kS(id)], ["SREM", K_IDS, id], ["HDEL", K_RV, id], ["SET", kDel(id), "1", "EX", TOMB_S], ["INCR", K_REV]);
    const iRev = cmds.length - 1;
    const out = await redisTx(cmds.concat(lk.unlock()), lk.left());
    return { rev: out[iRev] };
  });
}

/** Tournoi absent : supprimé (pierre tombale) ou perdu côté Redis (le client le recrée). */
function absentReason(tomb) { return toNum(tomb) > 0 ? "deleted" : "missing"; }

async function opScore(body) {
  const tid = needId(body.tid, "tournoi");
  const mid = needId(body.matchId, "match");
  const rec = cleanRecord(body.record);
  if (!rec) bad("Score invalide : { s1, s2 } entiers 0..99, p1/p2/draw identifiants, at nombre.");
  const overwrite = body.overwrite === true;
  return withLock(tid, async (lk) => {
    const [structJson, curJson, rev0, prv, tomb] = await redis([["GET", kT(tid)], ["HGET", kS(tid), mid], ["GET", K_REV], ["HGET", K_RV, tid], ["EXISTS", kDel(tid)]], lk.left());
    // Tournoi supprimé (ou absent) : aucune écriture (pas de hash de scores orphelin).
    if (structJson == null) return { rev: rev0, ignored: absentReason(tomb) };
    // Score d'un tirage remplacé (ou tournoi sans tirage) : sans objet.
    if (rec.draw !== drawIdOf(parseJSON(structJson))) return { rev: rev0, ignored: "staleDraw" };
    const cur = cleanRecord(parseJSON(curJson));
    if (cur && cur.draw === rec.draw) {
      const samePlayers = cur.p1 === rec.p1 && cur.p2 === rec.p2;
      // Même résultat (réessai, ou deux appareils d'accord) : rien à écrire.
      if (samePlayers && cur.s1 === rec.s1 && cur.s2 === rec.s2) return { rev: rev0, rv: prv, prv };
      const sameDevice = !!(cur.by && rec.by && cur.by === rec.by);
      // La PREMIÈRE saisie gagne ; seule une correction volontaire la remplace.
      if (samePlayers && !overwrite && !sameDevice) return { rev: rev0, ignored: "exists", current: publicRecord(cur) };
      // Correction plus ancienne (arrivée en retard) : le plus récent gagne.
      if (cur.at > rec.at) return { rev: rev0, ignored: "older", current: publicRecord(cur) };
    }
    const tok = newToken();
    const out = await redisTx([["HSET", kS(tid), mid, JSON.stringify(rec)], ["HSET", K_RV, tid, tok], ["INCR", K_REV]].concat(lk.unlock()), lk.left());
    return { rev: out[2], rv: tok, prv };
  });
}

async function opUnscore(body) {
  const tid = needId(body.tid, "tournoi");
  const mid = needId(body.matchId, "match");
  const draw = optDraw(body.draw, "draw");
  if (body.at != null && !isTime(body.at)) bad("Horodatage invalide.");
  const at = body.at != null ? body.at : null;
  const should = (rec) => !isPlainObject(rec) ||
    ((draw == null || rec.draw === draw) && (at == null || !(isTime(rec.at) && rec.at > at)));
  return withLock(tid, async (lk) => {
    const [structJson, curJson, rev0, prv, tomb] = await redis([["GET", kT(tid)], ["HGET", kS(tid), mid], ["GET", K_REV], ["HGET", K_RV, tid], ["EXISTS", kDel(tid)]], lk.left());
    if (structJson == null) return { rev: rev0, ignored: absentReason(tomb) };
    if (curJson == null) return { rev: rev0, rv: prv, prv };
    if (!should(parseJSON(curJson))) return { rev: rev0, ignored: "notMatching" };
    const tok = newToken();
    const out = await redisTx([["HDEL", kS(tid), mid], ["HSET", K_RV, tid, tok], ["INCR", K_REV]].concat(lk.unlock()), lk.left());
    return { rev: out[2], rv: tok, prv };
  });
}

async function opResetScores(body) {
  const tid = needId(body.tid, "tournoi");
  const keep = optDraw(body.keepDraw, "keepDraw");
  // keepDraw null → tout part ; sinon on garde EXACTEMENT les scores de keepDraw.
  const should = (rec) => !isPlainObject(rec) || rec.draw !== keep;
  return withLock(tid, async (lk) => {
    const [structJson, all, rev0, prv, tomb] = await redis([["GET", kT(tid)], ["HGETALL", kS(tid)], ["GET", K_REV], ["HGET", K_RV, tid], ["EXISTS", kDel(tid)]], lk.left());
    if (structJson == null) return { rev: rev0, ignored: absentReason(tomb) };
    const fields = hashPairs(all).filter(([, v]) => should(parseJSON(v))).map(([f]) => f);
    if (!fields.length) return { rev: rev0, rv: prv, prv };
    const r = await conditionalDelete(tid, fields, should, lk);
    return { rev: r.rev, rv: r.rv, prv };
  });
}

async function opReplaceAll(body) {
  if (!Array.isArray(body.tournaments)) bad("Liste de tournois attendue.");
  if (body.tournaments.length > MAX_TOURNAMENTS) bad("Trop de tournois.");
  const seen = new Set();
  const items = body.tournaments.map((t) => {
    const s = cleanStructure(t);
    if (seen.has(s.id)) bad("Tournoi en double (" + s.id + ").");
    seen.add(s.id);
    return { s, pairs: cleanScores(t.scores) };
  });
  const left = budget(20000);
  const [ids] = await redis([["SMEMBERS", K_IDS]], left());
  const old = idList(ids);
  const cmds = [];
  if (old.length) {
    // Sauvegarde des tournois de l'ancien format avant de tout remplacer.
    const [vals] = await redis([["MGET", ...old.map(kT)]], left());
    old.forEach((id, i) => {
      const v = Array.isArray(vals) ? vals[i] : null;
      if (needsBackup(v)) cmds.push(["SET", kBak(id), String(v), "NX"]);
    });
  }
  cmds.push(["DEL", K_IDS, K_RV, ...old.map(kT), ...old.map(kS)]);
  items.forEach(({ s, pairs }) => {
    cmds.push(["DEL", kS(s.id)]);
    cmds.push(["SET", kT(s.id), s.json]);
    cmds.push(["SADD", K_IDS, s.id]);
    cmds.push(["HSET", K_RV, s.id, newToken()]);
    if (pairs.length) cmds.push(["HSET", kS(s.id), ...pairs]);
  });
  cmds.push(["INCR", K_REV]);
  const out = await redisTx(cmds, left());
  return { rev: out[out.length - 1] };
}

const OPS = {
  upsert: opUpsert,
  delete: opDelete,
  score: opScore,
  unscore: opUnscore,
  resetScores: opResetScores,
  replaceAll: opReplaceAll,
};

// ---------------------------------------------------------------
//  Point d'entrée
// ---------------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!configured()) {
      return res.status(200).json({ configured: false });
    }

    if (req.method === "GET") {
      const q = req.query || {};
      if (q.meta === "1" || q.meta === "true") {
        const since = q.since != null && q.since !== "" && Number.isFinite(Number(q.since)) ? Number(q.since) : null;
        const m = await readMeta(since, budget());
        const out = { configured: true, rev: m.rev };
        if (m.revs) out.revs = m.revs;
        return res.status(200).json(out);
      }
      if (q.ids != null) {
        const r = await readIds(parseIds(q), budget());
        return res.status(200).json({ configured: true, rev: r.rev, revs: r.revs, tournaments: r.tournaments, missing: r.missing, deleted: r.deleted });
      }
      const all = await readAll(budget());
      return res.status(200).json({ configured: true, rev: all.rev, revs: all.revs, tournaments: all.tournaments });
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const fn = typeof body.op === "string" && hasOwn(OPS, body.op) ? OPS[body.op] : null;
      if (!fn) bad("Opération invalide.");
      const r = await fn(body);
      return done(res, r);
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Méthode non autorisée." });
  } catch (e) {
    if (e instanceof BadRequest) return res.status(400).json({ error: e.message });
    if (e instanceof Unavailable) return res.status(503).json({ error: e.message });
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
