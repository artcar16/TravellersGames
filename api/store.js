/* ============================================================
   api/store.js — Base de données « cloud » de The Travellers (v2).

   Fonction serverless Vercel (Node, CommonJS, sans dépendance)
   adossée à un magasin Redis (Vercel KV / Upstash) via son API
   REST. La clé secrète reste UNIQUEMENT côté serveur : les joueurs
   n'ont aucun token à saisir, tout est partagé.

   Modèle de données Redis :
     - tg:ids        SET des identifiants de tournois
     - tg:t:<id>     STRING : JSON de la STRUCTURE d'un tournoi
                     (joueurs, réglages, tirage — jamais les scores)
     - tg:s:<id>     HASH   : matchId -> JSON d'un score
                     { s1, s2, p1, p2, draw, at }
     - tg:rev        compteur incrémenté à CHAQUE écriture
                     (sert au rafraîchissement « temps réel »)

   Un score = un champ de hash : deux saisies simultanées sur deux
   matchs différents ne peuvent jamais s'écraser, et une édition de
   la structure (nom, réglages…) ne touche jamais aux scores.

   API :
     GET  /api/store?meta=1  -> { configured, rev }          (sondage léger)
     GET  /api/store         -> { configured, rev, tournaments:[{...structure, scores}] }
     POST /api/store
       { op:"upsert", tournament }             structure (scores retirés)
       { op:"delete", id }                     structure + scores
       { op:"score", tid, matchId, record }    un score
       { op:"unscore", tid, matchId, draw?, at? }
       { op:"resetScores", tid, keepDraw }     purge des scores d'un autre tirage
       { op:"replaceAll", tournaments }        remplace tout (structures + scores)
     -> { ok:true, configured:true, rev }  (+ ignored:"raison" si l'écriture
        a été volontairement écartée, voir ci-dessous)

   Garde-fous (jamais de perte d'un score valide) :
     - score : un enregistrement plus ANCIEN (même tirage, `at` plus petit)
       n'écrase pas le plus récent ; un enregistrement d'un autre tirage
       n'écrase jamais un score du tirage courant.
     - unscore : si `draw` / `at` sont fournis, on n'efface que le score de
       ce tirage, pas plus récent que `at`.
     - resetScores : n'efface JAMAIS un score dont draw === keepDraw, même
       s'il arrive pendant la purge (lecture + suppression atomiques, puis
       restauration HSETNX de ce qui ne devait pas partir).

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
const kT = (id) => "tg:t:" + id;
const kS = (id) => "tg:s:" + id;

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_STRUCT_CHARS = 900000;     // ~0,9 Mo par tournoi (un tournoi de 128 joueurs ≈ 40 Ko)
const MAX_TOURNAMENTS = 300;         // replaceAll

function configured() {
  return !!(REDIS_URL && REDIS_TOKEN);
}

// ---------------------------------------------------------------
//  Accès Redis (API REST Upstash)
// ---------------------------------------------------------------
async function call(path, commands) {
  const res = await fetch(REDIS_URL + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + REDIS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = new Error("Redis " + res.status + " " + String(txt).slice(0, 200));
    err.status = res.status;
    throw err;
  }
  const data = await res.json(); // [{result}|{error}, ...]
  if (!Array.isArray(data)) throw new Error("Redis : réponse inattendue");
  return data.map((d) => {
    if (d && d.error) throw new Error("Redis : " + d.error);
    return d ? d.result : null;
  });
}

/** Pile de commandes (exécutées dans l'ordre, non atomique). */
function redis(commands) { return call("/pipeline", commands); }

/** Transaction atomique (MULTI/EXEC) ; repli sur /pipeline si indisponible. */
async function redisTx(commands) {
  try {
    return await call("/multi-exec", commands);
  } catch (e) {
    if (e && e.status && e.status !== 401 && e.status !== 403) return redis(commands);
    throw e;
  }
}

// ---------------------------------------------------------------
//  Utilitaires / validation
// ---------------------------------------------------------------
class BadRequest extends Error {}

function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function parseJSON(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}
function isPlainObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
const isId = (v) => typeof v === "string" && ID_RE.test(v);
const isStr80 = (v) => typeof v === "string" && v.length >= 1 && v.length <= 80;
const isScore = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 99;
const isTime = (v) => typeof v === "number" && Number.isFinite(v);

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
  if (!isStr80(r.p1) || !isStr80(r.p2) || !isStr80(r.draw)) return null;
  if (!isTime(r.at)) return null;
  return { s1: r.s1, s2: r.s2, p1: r.p1, p2: r.p2, draw: r.draw, at: r.at };
}

function needId(v, what) {
  if (!isId(v)) throw new BadRequest("Identifiant invalide (" + what + ").");
  return v;
}
function optDraw(v, what) {
  if (v == null) return null;
  if (!isStr80(v)) throw new BadRequest("Tirage invalide (" + what + ").");
  return v;
}

/** Structure d'un tournoi (sans scores) validée + sérialisée. */
function cleanStructure(t) {
  if (!isPlainObject(t)) throw new BadRequest("Tournoi invalide.");
  needId(t.id, "tournoi");
  const s = Object.assign({}, t);
  delete s.scores;
  if (s.draw != null && (!isPlainObject(s.draw) || !isStr80(s.draw.id))) throw new BadRequest("Tirage invalide.");
  if (s.players != null && !Array.isArray(s.players)) throw new BadRequest("Liste de joueurs invalide.");
  if (s.name != null && typeof s.name !== "string") throw new BadRequest("Nom invalide.");
  let json;
  try { json = JSON.stringify(s); } catch (e) { throw new BadRequest("Tournoi invalide."); }
  if (json.length > MAX_STRUCT_CHARS) throw new BadRequest("Tournoi trop volumineux.");
  return { id: s.id, json };
}

/** Scores d'un tournoi (replaceAll) : { matchId: record } validés. */
function cleanScores(scores) {
  if (scores == null) return [];
  if (!isPlainObject(scores)) throw new BadRequest("Scores invalides.");
  const pairs = [];
  Object.keys(scores).forEach((mid) => {
    needId(mid, "match");
    const rec = cleanRecord(scores[mid]);
    if (!rec) throw new BadRequest("Score invalide (" + mid + ").");
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
    const rec = cleanRecord(parseJSON(v));
    if (rec) scores[f] = rec;
  });
  return scores;
}

/**
 * Suppression conditionnelle de champs d'un hash, sûre face aux écritures
 * concurrentes : lecture + suppression dans une même transaction, puis
 * restauration (HSETNX : jamais d'écrasement) de toute valeur qui n'aurait
 * pas dû partir (ex. un score du nouveau tirage arrivé entre-temps).
 */
async function conditionalDelete(key, fields, shouldDelete) {
  if (!fields.length) {
    const out = await redis([["INCR", K_REV]]);
    return toNum(out[0]);
  }
  const out = await redisTx([["HMGET", key, ...fields], ["HDEL", key, ...fields], ["INCR", K_REV]]);
  const vals = Array.isArray(out[0]) ? out[0] : [];
  const restore = [];
  fields.forEach((f, i) => {
    const v = vals[i];
    if (v == null) return;
    if (!shouldDelete(parseJSON(v))) restore.push(["HSETNX", key, f, typeof v === "string" ? v : JSON.stringify(v)]);
  });
  let rev = toNum(out[2]);
  if (restore.length) {
    const o2 = await redis([...restore, ["INCR", K_REV]]);
    rev = toNum(o2[o2.length - 1]);
  }
  return rev;
}

function done(res, rev, ignored) {
  const body = { ok: true, configured: true, rev: toNum(rev) };
  if (ignored) body.ignored = ignored;
  return res.status(200).json(body);
}

// ---------------------------------------------------------------
//  Lecture
// ---------------------------------------------------------------
async function readAll() {
  // Le compteur est lu AVANT les données : un instantané de révision R
  // contient toujours au moins toutes les écritures de révision <= R.
  const [rev, ids] = await redis([["GET", K_REV], ["SMEMBERS", K_IDS]]);
  const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id);
  const tournaments = [];
  if (list.length) {
    const out = await redis([["MGET", ...list.map(kT)], ...list.map((id) => ["HGETALL", kS(id)])]);
    const vals = Array.isArray(out[0]) ? out[0] : [];
    list.forEach((id, i) => {
      const t = parseJSON(vals[i]);
      if (!isPlainObject(t)) return;
      if (!t.id) t.id = id;
      t.scores = scoresFromHash(out[i + 1]);
      tournaments.push(t);
    });
  }
  return { rev: toNum(rev), tournaments };
}

// ---------------------------------------------------------------
//  Écritures
// ---------------------------------------------------------------
async function opUpsert(body, res) {
  const s = cleanStructure(body.tournament);
  const out = await redis([
    ["SET", kT(s.id), s.json],
    ["SADD", K_IDS, s.id],
    ["INCR", K_REV],
  ]);
  return done(res, out[2]);
}

async function opDelete(body, res) {
  const id = needId(body.id != null ? body.id : body.tid, "tournoi");
  const out = await redis([
    ["DEL", kT(id), kS(id)],
    ["SREM", K_IDS, id],
    ["INCR", K_REV],
  ]);
  return done(res, out[2]);
}

async function opScore(body, res) {
  const tid = needId(body.tid, "tournoi");
  const mid = needId(body.matchId, "match");
  const rec = cleanRecord(body.record);
  if (!rec) throw new BadRequest("Score invalide : { s1, s2 } entiers 0..99, p1/p2/draw texte, at nombre.");

  const [structJson, curJson, rev0] = await redis([["GET", kT(tid)], ["HGET", kS(tid), mid], ["GET", K_REV]]);
  const st = parseJSON(structJson);
  const curDraw = st && isPlainObject(st.draw) ? st.draw.id : null;
  const cur = parseJSON(curJson);
  if (isPlainObject(cur)) {
    // Un score du tirage courant n'est jamais écrasé par un score d'un autre tirage.
    if (curDraw && cur.draw === curDraw && rec.draw !== curDraw) return done(res, rev0, "staleDraw");
    // Même tirage : le plus récent gagne (saisie hors-ligne arrivée en retard).
    if (cur.draw === rec.draw && isTime(cur.at) && cur.at > rec.at) return done(res, rev0, "older");
  }
  const out = await redis([["HSET", kS(tid), mid, JSON.stringify(rec)], ["INCR", K_REV]]);
  return done(res, out[1]);
}

async function opUnscore(body, res) {
  const tid = needId(body.tid, "tournoi");
  const mid = needId(body.matchId, "match");
  const draw = optDraw(body.draw, "draw");
  if (body.at != null && !isTime(body.at)) throw new BadRequest("Horodatage invalide.");
  const at = body.at != null ? body.at : null;

  if (draw == null && at == null) {
    const out = await redis([["HDEL", kS(tid), mid], ["INCR", K_REV]]);
    return done(res, out[1]);
  }
  const should = (rec) => !isPlainObject(rec) ||
    ((draw == null || rec.draw === draw) && (at == null || !(isTime(rec.at) && rec.at > at)));
  const [curJson, rev0] = await redis([["HGET", kS(tid), mid], ["GET", K_REV]]);
  if (curJson == null) return done(res, rev0);
  if (!should(parseJSON(curJson))) return done(res, rev0, "notMatching");
  const rev = await conditionalDelete(kS(tid), [mid], should);
  return done(res, rev);
}

async function opResetScores(body, res) {
  const tid = needId(body.tid, "tournoi");
  const keep = optDraw(body.keepDraw, "keepDraw");
  // keepDraw null → tout part ; sinon on garde EXACTEMENT les scores de keepDraw.
  const should = (rec) => !isPlainObject(rec) || rec.draw !== keep;
  const [all] = await redis([["HGETALL", kS(tid)]]);
  const fields = hashPairs(all).filter(([, v]) => should(parseJSON(v))).map(([f]) => f);
  const rev = await conditionalDelete(kS(tid), fields, should);
  return done(res, rev);
}

async function opReplaceAll(body, res) {
  if (!Array.isArray(body.tournaments)) throw new BadRequest("Liste de tournois attendue.");
  if (body.tournaments.length > MAX_TOURNAMENTS) throw new BadRequest("Trop de tournois.");
  const items = body.tournaments.map((t) => {
    const s = cleanStructure(t);
    return { s, pairs: cleanScores(t.scores) };
  });
  const [ids] = await redis([["SMEMBERS", K_IDS]]);
  const old = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id);
  const cmds = [["DEL", K_IDS, ...old.map(kT), ...old.map(kS)]];
  items.forEach(({ s, pairs }) => {
    cmds.push(["DEL", kS(s.id)]);
    cmds.push(["SET", kT(s.id), s.json]);
    cmds.push(["SADD", K_IDS, s.id]);
    if (pairs.length) cmds.push(["HSET", kS(s.id), ...pairs]);
  });
  cmds.push(["INCR", K_REV]);
  const out = await redisTx(cmds);
  return done(res, out[out.length - 1]);
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
        const [rev] = await redis([["GET", K_REV]]);
        return res.status(200).json({ configured: true, rev: toNum(rev) });
      }
      const all = await readAll();
      return res.status(200).json({ configured: true, rev: all.rev, tournaments: all.tournaments });
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const fn = typeof body.op === "string" && Object.prototype.hasOwnProperty.call(OPS, body.op) ? OPS[body.op] : null;
      if (!fn) throw new BadRequest("Opération invalide.");
      return await fn(body, res);
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Méthode non autorisée." });
  } catch (e) {
    if (e instanceof BadRequest) return res.status(400).json({ error: e.message });
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

// Exposé pour les tests uniquement.
module.exports._internals = { resolveCreds, cleanRecord, cleanStructure, ID_RE };
