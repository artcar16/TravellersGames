/* ============================================================
   app.js — Routeur SPA + rendu des vues
   The Travellers — Suivi de tournois de backgammon
   ============================================================ */
(function () {
  "use strict";

  const Store = TG.Store;
  const Cloud = TG.Cloud;
  const $app = document.getElementById("app");

  // ---------- Utilitaires DOM ----------
  function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---------- Toast ----------
  function toast(msg, kind) {
    let wrap = document.querySelector(".toast-wrap");
    if (!wrap) { wrap = el('<div class="toast-wrap"></div>'); document.body.appendChild(wrap); }
    const t = el(`<div class="toast ${kind === "err" ? "err" : ""}">${esc(msg)}</div>`);
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 2600);
  }

  // ---------- Modal ----------
  function modal({ title, bodyNodes, actions }) {
    const root = document.getElementById("modal-root");
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el(`<div class="modal">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="close-x" aria-label="Fermer">×</button></div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div>`);
    const body = box.querySelector(".modal-body");
    const foot = box.querySelector(".modal-foot");
    (bodyNodes || []).forEach((n) => body.appendChild(n));
    const close = () => overlay.remove();
    box.querySelector(".close-x").onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    (actions || []).forEach((a) => {
      const b = el(`<button class="btn ${a.cls || ""}">${esc(a.label)}</button>`);
      b.onclick = () => a.onClick(close);
      foot.appendChild(b);
    });
    overlay.appendChild(box);
    root.appendChild(overlay);
    const firstInput = body.querySelector("input,select,textarea");
    if (firstInput) firstInput.focus();
    return { close, body };
  }

  function wrapField(label, input) { const f = el(`<label class="field">${esc(label)}</label>`); f.appendChild(input); return f; }

  // ---------- Routeur ----------
  const routes = [];
  function route(pattern, handler) {
    const keys = [];
    const rx = new RegExp("^" + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; }) + "$");
    routes.push({ rx, keys, handler });
  }
  function navigate(hash) { location.hash = hash; }
  function parseHash() { let h = location.hash.replace(/^#/, ""); if (!h) h = "/"; return h; }

  function render() {
    teardownBracket();
    const path = parseHash();
    document.body.classList.toggle("fullbleed", /^\/t\/[^/]+\/bracket$/.test(path));
    for (const r of routes) {
      const m = path.match(r.rx);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        clear($app);
        r.handler(params);
        window.scrollTo(0, 0);
        return;
      }
    }
    clear($app);
    $app.appendChild(el('<div class="empty"><div class="ico">🧭</div><p>Page introuvable.</p></div>'));
  }

  /** Met à jour le titre de l'onglet selon le contexte. */
  function renderNav() {
    const m = parseHash().match(/^\/t\/([^/]+)/);
    let title = "The Travellers — Backgammon";
    if (m) { const t = Store.getTournament(m[1]); if (t) title = t.name + " — The Travellers"; }
    document.title = title;
  }

  // ---------- Sous-onglets d'un tournoi ----------
  function subtabs(tid, current) {
    const items = [["players", "Joueurs"], ["bracket", "Tableau"], ["scores", "Scores"], ["settings", "Réglages"]];
    const wrap = el('<div class="subtabs"></div>');
    items.forEach(([k, label]) => {
      wrap.appendChild(el(`<a href="#/t/${tid}/${k}" class="${current === k ? "active" : ""}">${esc(label)}</a>`));
    });
    return wrap;
  }

  function pageHead(eyebrow, title, subtitle, right, backHref) {
    const eb = backHref ? `<a href="${backHref}">‹ ${esc(eyebrow)}</a>` : esc(eyebrow);
    const head = el(`<div class="page-head"><div>
      <div class="eyebrow">${eb}</div>
      <h1>${esc(title)}</h1>
      ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
    </div></div>`);
    if (right) head.appendChild(right);
    return head;
  }

  // ============================================================
  //  VUE : Accueil (liste des tournois)
  // ============================================================
  route("/", function () {
    const addBtn = el('<button class="btn hide-mobile">＋ Nouveau tournoi</button>');
    addBtn.onclick = openCreateTournament;
    $app.appendChild(pageHead("The Travellers · Paris", "Tournois", "Choisissez un tournoi ou créez-en un.", addBtn));

    const list = Store.listTournaments();
    if (!list.length) {
      const empty = el(`<div class="card empty"><div class="ico">🎲</div>
        <h2>Aucun tournoi</h2>
        <p>Créez votre premier tournoi pour commencer.</p></div>`);
      const b = el('<button class="btn" style="margin-top:16px">＋ Créer un tournoi</button>');
      b.onclick = openCreateTournament; empty.appendChild(b);
      $app.appendChild(empty);
    } else {
      const grid = el('<div class="grid cols"></div>');
      list.forEach((t) => {
        const nb = Store.allMatches(t).length;
        const done = Store.allMatches(t).filter((m) => m.status === "done").length;
        const chip = !t.bracket
          ? '<span class="chip warn">Non démarré</span>'
          : (done >= nb && nb > 0 ? '<span class="chip ok">Terminé</span>' : '<span class="chip gold">En cours</span>');
        const card = el(`<div class="t-card">
          <h3>${esc(t.name)}</h3>
          <div class="meta">${esc(t.date || "—")} · ${t.players.length} joueurs</div>
          <div class="chips">${chip}
            ${(t.settings.secondaryPool || t.settings.repechage) ? '<span class="chip">Poule secondaire</span>' : ""}
            ${t.bracket ? `<span class="chip">${done}/${nb} matchs</span>` : ""}
          </div>
        </div>`);
        card.onclick = () => navigate("#/t/" + t.id + "/players");
        grid.appendChild(card);
      });
      $app.appendChild(grid);
    }

    const fab = el('<button class="fab" title="Nouveau tournoi" aria-label="Nouveau tournoi">＋</button>');
    fab.onclick = openCreateTournament;
    $app.appendChild(fab);
  });

  function openCreateTournament() {
    const nameI = el('<input type="text" placeholder="Ex. Open de printemps" />');
    const dateI = el(`<input type="date" value="${new Date().toISOString().slice(0, 10)}" />`);
    const playersI = el('<input type="number" min="2" max="128" value="8" />');
    modal({
      title: "Nouveau tournoi",
      bodyNodes: [wrapField("Nom du tournoi", nameI), wrapField("Date", dateI), wrapField("Nombre de joueurs prévu", playersI)],
      actions: [
        { label: "Annuler", cls: "subtle", onClick: (c) => c() },
        { label: "Créer", onClick: (c) => {
            const name = nameI.value.trim() || "Tournoi sans nom";
            const t = Store.createTournament(name, dateI.value);
            t.settings.expectedPlayers = parseInt(playersI.value, 10) || 8;
            Store.commit("config initiale");
            c(); navigate("#/t/" + t.id + "/players"); toast("Tournoi créé.");
          } },
      ],
    });
  }

  // ============================================================
  //  VUE : Joueurs
  // ============================================================
  route("/t/:id/players", function (p) {
    const t = Store.getTournament(p.id);
    if (!t) return notFound();
    const addBtn = el('<button class="btn">＋ Ajouter</button>');
    addBtn.onclick = () => openPlayerForm(t);
    $app.appendChild(pageHead("Tournois", "Joueurs", t.name, addBtn, "#/"));
    $app.appendChild(subtabs(t.id, "players"));

    const totalPts = t.players.reduce((a, pl) => a + Store.playerStats(t, pl.id).pointsFor, 0);
    $app.appendChild(el(`<div class="card" style="margin-bottom:14px"><div class="stat-row">
      <div class="stat"><div class="n">${t.players.length}</div><div class="l">Joueurs</div></div>
      <div class="stat"><div class="n">${Store.allMatches(t).filter(m=>m.status==="done"&&m.p1!=="BYE"&&m.p2!=="BYE").length}</div><div class="l">Matchs</div></div>
      <div class="stat"><div class="n">${totalPts}</div><div class="l">Points</div></div>
    </div></div>`));

    if (!t.players.length) {
      $app.appendChild(el('<div class="card empty"><div class="ico">👤</div><p>Aucun joueur inscrit.</p></div>'));
      return;
    }

    const rows = t.players.map((pl) => ({ pl, s: Store.playerStats(t, pl.id) }))
      .sort((a, b) => b.s.wins - a.s.wins || b.s.pointsFor - a.s.pointsFor);
    const table = el(`<div class="card"><table class="table"><thead><tr>
      <th class="rank">#</th><th>Joueur</th><th>Club</th><th>Matchs</th><th>Vict.</th><th>Points</th><th>Diff.</th><th></th>
    </tr></thead><tbody></tbody></table></div>`);
    const tbody = table.querySelector("tbody");
    rows.forEach((r, i) => {
      const diff = r.s.pointsFor - r.s.pointsAgainst;
      const tr = el(`<tr style="cursor:pointer">
        <td class="rank">${i + 1}</td>
        <td><strong>${esc(r.pl.name)}</strong>${r.pl.rating ? ` <span class="chip">${esc(r.pl.rating)}</span>` : ""}</td>
        <td class="muted">${esc(r.pl.club || "—")}</td>
        <td class="num">${r.s.played}</td><td class="num">${r.s.wins}</td><td class="num">${r.s.pointsFor}</td>
        <td class="num">${diff > 0 ? "+" : ""}${diff}</td><td></td>
      </tr>`);
      tr.onclick = () => openPlayerForm(t, r.pl);   // taper la ligne = modifier
      const actions = el('<div class="btn-row" style="justify-content:flex-end;flex-wrap:nowrap"></div>');
      const edit = el('<button class="btn sm subtle hide-mobile">Modifier</button>');
      edit.onclick = (e) => { e.stopPropagation(); openPlayerForm(t, r.pl); };
      const del = el('<button class="btn sm danger">✕</button>');
      del.onclick = (e) => { e.stopPropagation(); if (confirm("Retirer " + r.pl.name + " ?")) { Store.removePlayer(t.id, r.pl.id); render(); } };
      actions.appendChild(edit); actions.appendChild(del);
      tr.lastElementChild.appendChild(actions);
      tbody.appendChild(tr);
    });
    $app.appendChild(table);
    $app.appendChild(el('<p class="muted" style="margin-top:10px;font-size:.82rem">Touchez une ligne pour modifier un joueur.</p>'));

    if (t.bracket) {
      $app.appendChild(el('<p class="muted" style="margin-top:14px;font-size:.86rem">Le tableau est déjà généré : modifier les joueurs ne le régénère pas. Régénérez-le depuis l’onglet Tableau si besoin.</p>'));
    }
  });

  function openPlayerForm(t, player) {
    const nameI = el(`<input type="text" value="${player ? esc(player.name) : ""}" placeholder="Nom du joueur" />`);
    const clubI = el(`<input type="text" value="${player ? esc(player.club || "") : ""}" placeholder="Club / ville" />`);
    const rateI = el(`<input type="text" value="${player ? esc(player.rating || "") : ""}" placeholder="Ex. 1500 (optionnel)" />`);
    const noteI = el(`<textarea placeholder="Remarques (optionnel)">${player ? esc(player.note || "") : ""}</textarea>`);
    modal({
      title: player ? "Modifier le joueur" : "Ajouter un joueur",
      bodyNodes: [wrapField("Nom", nameI), wrapField("Club / ville", clubI), wrapField("Classement / rating", rateI), wrapField("Note", noteI)],
      actions: [
        { label: "Annuler", cls: "subtle", onClick: (c) => c() },
        { label: player ? "Enregistrer" : "Ajouter", onClick: (c) => {
            const name = nameI.value.trim();
            if (!name) { toast("Le nom est requis.", "err"); return; }
            const data = { name, club: clubI.value.trim(), rating: rateI.value.trim(), note: noteI.value.trim() };
            if (player) Store.updatePlayer(t.id, player.id, data); else Store.addPlayer(t.id, name, data);
            c(); render();
          } },
      ],
    });
  }

  // ============================================================
  //  VUE : Tableau (bracket) — plein écran, auto-zoom
  // ============================================================
  let rotateTimer = null;
  let currentView = "main";       // main | sec
  let onBracketResize = null;
  let bracketRO = null;

  function clearRotate() { if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; } }
  function teardownBracket() {
    clearRotate();
    if (onBracketResize) { window.removeEventListener("resize", onBracketResize); onBracketResize = null; }
    if (bracketRO) { bracketRO.disconnect(); bracketRO = null; }
  }

  route("/t/:id/bracket", function (p) {
    const t = Store.getTournament(p.id);
    if (!t) { document.body.classList.remove("fullbleed"); return notFound(); }

    const back = el('<button class="bracket-ui bracket-back" title="Retour" aria-label="Retour">‹</button>');
    back.onclick = () => { if (history.length > 1) history.back(); else navigate("#/t/" + t.id + "/players"); };
    $app.appendChild(back);

    if (!t.bracket) {
      const e = el(`<div class="bracket-empty"><div>
        <div class="ico" style="font-size:2.4rem">🌳</div>
        <h2 style="font-family:'Cormorant Garamond',serif;font-size:1.6rem;margin:10px 0 4px">Tableau non généré</h2>
        <p class="muted">Inscrivez les joueurs puis générez le tableau.</p>
        <button class="btn" style="margin-top:14px">⚙︎ Générer le tableau</button>
      </div></div>`);
      e.querySelector(".btn").onclick = () => openGenerate(t);
      $app.appendChild(e);
      return;
    }

    const hasSec = !!t.secondary;
    if (currentView === "sec" && !hasSec) currentView = "main";

    $app.appendChild(el(`<div class="bracket-ui bracket-titlebar">${esc(t.name)}</div>`));

    const stage = el('<div class="bracket-stage"></div>');
    const fit = el('<div class="bracket-fit"></div>');
    stage.appendChild(fit);
    $app.appendChild(stage);

    function draw() {
      clear(fit);
      const b = currentView === "sec" ? t.secondary : t.bracket;
      fit.appendChild(renderBracketTree(t, b));
      requestAnimationFrame(() => fitBracket(stage, fit));
    }
    draw();

    onBracketResize = () => fitBracket(stage, fit);
    window.addEventListener("resize", onBracketResize);
    // Recalcule l'échelle quand le contenu change de taille (chargement des
    // polices web, changement de vue) pour éviter tout débordement.
    if (window.ResizeObserver) { bracketRO = new ResizeObserver(() => fitBracket(stage, fit)); bracketRO.observe(fit); }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitBracket(stage, fit));

    if (hasSec) {
      const dock = el('<div class="bracket-ui bracket-dock"></div>');
      const bMain = el("<button>Principal</button>");
      const bSec = el("<button>Secondaire</button>");
      const rot = el('<button class="rot" title="Rotation automatique" aria-label="Rotation automatique">⟳</button>');
      const updateToggle = () => { bMain.classList.toggle("active", currentView === "main"); bSec.classList.toggle("active", currentView === "sec"); };
      function startRotate() {
        clearRotate(); rot.classList.add("on");
        rotateTimer = setInterval(() => { currentView = currentView === "main" ? "sec" : "main"; updateToggle(); draw(); }, (t.settings.rotateSeconds || 30) * 1000);
      }
      function stopRotate() { clearRotate(); rot.classList.remove("on"); }
      bMain.onclick = () => { stopRotate(); currentView = "main"; updateToggle(); draw(); };
      bSec.onclick = () => { stopRotate(); currentView = "sec"; updateToggle(); draw(); };
      rot.onclick = () => { if (rotateTimer) stopRotate(); else startRotate(); };
      dock.appendChild(bMain); dock.appendChild(bSec); dock.appendChild(rot);
      updateToggle();
      $app.appendChild(dock);
      if (t.settings.autoRotate) startRotate();
    }
  });

  /** Met l'arbre à l'échelle pour tenir dans la fenêtre. */
  function fitBracket(stage, fit) {
    const inner = fit.firstElementChild;
    if (!inner) return;
    fit.style.transform = "translate(-50%, -50%)";   // échelle 1 pour mesurer
    const sw = inner.scrollWidth, sh = inner.scrollHeight;
    const aw = stage.clientWidth, ah = stage.clientHeight;
    if (!sw || !sh || !aw || !ah) return;
    let scale = Math.min((aw - 24) / sw, (ah - 24) / sh);
    scale = Math.max(0.16, Math.min(scale, 1.5));
    fit.style.transform = "translate(-50%, -50%) scale(" + scale + ")";
  }

  function renderBracketTree(t, b) {
    const wrap = el('<div class="bracket"></div>');
    const roundNames = (n) => {
      const fromEnd = b.totalRounds - n;
      if (fromEnd === 0) return "Finale";
      if (fromEnd === 1) return "Demi-finales";
      if (fromEnd === 2) return "Quarts";
      return "Manche " + n;
    };
    b.rounds.forEach((ids, ri) => {
      const round = ri + 1;
      const col = el('<div class="bracket-round"></div>');
      const pts = Store.pointsForRound(t, round);
      col.appendChild(el(`<div class="round-title">${esc(roundNames(round))}${pts ? `<span class="round-pts">${pts} pts</span>` : ""}</div>`));
      ids.forEach((id) => col.appendChild(renderMatch(t, Store.findMatch(b, id))));
      wrap.appendChild(col);
    });
    return wrap;
  }

  function renderMatch(t, m) {
    const live = m.status === "ready", done = m.status === "done";
    const box = el(`<div class="match ${live ? "live" : ""} ${done ? "done" : ""}"></div>`);
    const seat = (pid, score, isWinner) => {
      const bye = pid === "BYE";
      const cls = bye ? "bye" : (done ? (isWinner ? "win" : "lose") : "");
      const nm = pid ? Store.playerName(t, pid) : "—";
      return `<div class="seat ${cls}"><span class="name">${esc(nm)}</span><span class="sc">${score == null ? "" : score}</span></div>`;
    };
    box.innerHTML = seat(m.p1, m.score1, m.winner && m.winner === m.p1) + seat(m.p2, m.score2, m.winner && m.winner === m.p2);
    return box;
  }

  function openGenerate(t) {
    if (t.players.length < 2) { toast("Il faut au moins 2 joueurs.", "err"); return; }
    const shuffleI = el('<label class="toggle"><input type="checkbox" checked/><span class="track"></span><span>Mélanger l’ordre (tirage aléatoire)</span></label>');
    const info = el(`<p class="muted">${t.players.length} joueurs.${t.bracket ? " Régénérer effacera les scores déjà saisis." : ""}</p>`);
    modal({
      title: t.bracket ? "Régénérer le tableau" : "Générer le tableau",
      bodyNodes: [info, shuffleI],
      actions: [
        { label: "Annuler", cls: "subtle", onClick: (c) => c() },
        { label: "Générer", onClick: (c) => {
            const res = Store.generateBracket(t.id, { shuffle: shuffleI.querySelector("input").checked });
            if (res && res.error) { toast(res.error, "err"); return; }
            c(); currentView = "main"; render(); toast("Tableau généré.");
          } },
      ],
    });
  }

  // ============================================================
  //  VUE : Saisie des scores
  // ============================================================
  route("/t/:id/scores", function (p) {
    const t = Store.getTournament(p.id);
    if (!t) return notFound();
    $app.appendChild(pageHead("Tournois", "Saisie des scores", t.name, null, "#/"));
    $app.appendChild(subtabs(t.id, "scores"));
    if (!t.bracket) {
      $app.appendChild(el('<div class="card empty"><div class="ico">📝</div><p>Le tableau n’est pas encore généré.</p></div>'));
      return;
    }
    renderScoreStep(t, null);
  });

  function renderScoreStep(t, selectedPid) {
    const old = $app.querySelector(".wizard");
    if (old) old.remove();
    const wiz = el('<div class="wizard"></div>');

    if (!selectedPid) {
      wiz.appendChild(el('<div class="section-title"><h2>Qui êtes-vous ?</h2><div class="line"></div></div>'));
      const players = t.players.slice().sort((a, b) => a.name.localeCompare(b.name));
      let search = null;
      if (players.length > 8) {
        search = el('<input class="who-search" type="search" placeholder="Rechercher votre nom…" />');
        wiz.appendChild(search);
      }
      const pick = el('<div class="player-pick"></div>');
      const draw = (q) => {
        clear(pick);
        players.filter((pl) => !q || pl.name.toLowerCase().includes(q.toLowerCase())).forEach((pl) => {
          const btn = el(`<button>${esc(pl.name)}<span class="arr">›</span></button>`);
          btn.onclick = () => renderScoreStep(t, pl.id);
          pick.appendChild(btn);
        });
      };
      draw("");
      if (search) search.oninput = () => draw(search.value);
      wiz.appendChild(pick);
      $app.appendChild(wiz);
      return;
    }

    const pl = t.players.find((x) => x.id === selectedPid);
    const back = el('<button class="btn subtle sm" style="margin-bottom:16px">‹ Changer de joueur</button>');
    back.onclick = () => renderScoreStep(t, null);
    wiz.appendChild(back);
    wiz.appendChild(el(`<div class="section-title"><h2>${esc(pl.name)}</h2><div class="line"></div></div>`));

    const ready = Store.findReadyMatchForPlayer(t, selectedPid);
    if (ready) {
      wiz.appendChild(renderScoreForm(t, ready, selectedPid));
    } else {
      const pending = Store.findPendingMatchForPlayer(t, selectedPid);
      if (pending) {
        const oppId = pending.p1 === selectedPid ? pending.p2 : pending.p1;
        const oppName = oppId ? Store.playerName(t, oppId) : "votre prochain adversaire";
        wiz.appendChild(el(`<div class="info-banner wait"><span class="ico">⏳</span>
          <div><strong>Patientez.</strong><br/><span class="muted">Votre prochain match attend la fin du match de ${esc(oppName)}.</span></div></div>`));
      } else if (isPlayerChampion(t, selectedPid)) {
        wiz.appendChild(el('<div class="info-banner ok"><span class="ico">🏆</span><div><strong>Vainqueur du tournoi — félicitations !</strong></div></div>'));
      } else {
        wiz.appendChild(el('<div class="info-banner"><span class="ico">🎲</span><div>Plus de match à jouer pour le moment.</div></div>'));
      }
    }

    const hist = Store.allMatches(t).filter((m) => m.status === "done" && (m.p1 === selectedPid || m.p2 === selectedPid));
    if (hist.length) {
      const h = el('<div class="hist"></div>');
      h.appendChild(el('<div class="section-title"><h2 style="font-size:1.15rem">Vos matchs</h2><div class="line"></div></div>'));
      hist.forEach((m) => {
        const mine = m.p1 === selectedPid ? m.score1 : m.score2;
        const opp = m.p1 === selectedPid ? m.score2 : m.score1;
        const oppId = m.p1 === selectedPid ? m.p2 : m.p1;
        const won = m.winner === selectedPid;
        h.appendChild(el(`<div class="hist-row"><span class="res ${won ? "w" : "l"}">${won ? "✓" : "✕"}</span>
          <span class="nm">${esc(Store.playerName(t, oppId))}</span><span class="sc">${mine}–${opp}</span></div>`));
      });
      wiz.appendChild(h);
    }
    $app.appendChild(wiz);
  }

  function renderScoreForm(t, m, selectedPid) {
    const wrap = el("<div></div>");
    const pts = Store.pointsForRound(t, m.round);
    const tag = m.tag === "sec" ? "Poule secondaire" : "Tableau principal";
    wrap.appendChild(el(`<div class="match-meta"><strong>${esc(tag)}</strong> · Manche ${m.round}${pts ? ` · en ${pts} pts` : ""}</div>`));

    let v1 = 0, v2 = 0;
    const rows = el('<div class="score-rows"></div>');
    const r1 = scoreRow(Store.playerName(t, m.p1));
    const r2 = scoreRow(Store.playerName(t, m.p2));
    rows.appendChild(r1.node); rows.appendChild(r2.node);
    const refresh = () => {
      r1.set(v1); r2.set(v2);
      r1.node.classList.toggle("win", v1 > v2);
      r2.node.classList.toggle("win", v2 > v1);
    };
    r1.onMinus = () => { v1 = Math.max(0, v1 - 1); refresh(); };
    r1.onPlus = () => { v1++; refresh(); };
    r2.onMinus = () => { v2 = Math.max(0, v2 - 1); refresh(); };
    r2.onPlus = () => { v2++; refresh(); };
    refresh();
    wrap.appendChild(rows);

    const save = el('<button class="btn" style="width:100%">Enregistrer le résultat</button>');
    save.onclick = () => {
      if (v1 === v2) { toast("Pas d’égalité possible au backgammon.", "err"); return; }
      const r = Store.recordScore(t.id, m.id, v1, v2);
      if (r.error) { toast(r.error, "err"); return; }
      toast("Résultat enregistré ✓");
      renderScoreStep(t, selectedPid);
      showNextMatchInfo(t, selectedPid);
    };
    wrap.appendChild(save);
    return wrap;
  }

  function scoreRow(name) {
    const node = el(`<div class="score-row">
      <div><div class="pname">${esc(name)}</div><div class="win-tag">Vainqueur</div></div>
      <div class="stepper"><button class="minus" aria-label="moins">−</button><div class="val">0</div><button class="plus" aria-label="plus">+</button></div>
    </div>`);
    const valEl = node.querySelector(".val");
    const api = { node, set: (v) => { valEl.textContent = v; }, onMinus: null, onPlus: null };
    node.querySelector(".minus").onclick = () => api.onMinus && api.onMinus();
    node.querySelector(".plus").onclick = () => api.onPlus && api.onPlus();
    return api;
  }

  function showNextMatchInfo(t, pid) {
    const next = Store.findReadyMatchForPlayer(t, pid);
    const wiz = $app.querySelector(".wizard");
    if (!wiz || !next) return;
    const oppId = next.p1 === pid ? next.p2 : next.p1;
    const pts = Store.pointsForRound(t, next.round);
    wiz.appendChild(el(`<div class="next-match-card">
      <div class="lbl">Match suivant — Manche ${next.round}${pts ? ` · ${pts} pts` : ""}</div>
      <div class="big">contre ${esc(Store.playerName(t, oppId))}</div></div>`));
  }

  function isPlayerChampion(t, pid) {
    if (!t.bracket) return false;
    const finalIds = t.bracket.rounds[t.bracket.rounds.length - 1];
    const fm = Store.findMatch(t.bracket, finalIds[0]);
    return fm && fm.status === "done" && fm.winner === pid;
  }

  // ============================================================
  //  VUE : Réglages
  // ============================================================
  route("/t/:id/settings", function (p) {
    const t = Store.getTournament(p.id);
    if (!t) return notFound();
    $app.appendChild(pageHead("Tournois", "Réglages", t.name, null, "#/"));
    $app.appendChild(subtabs(t.id, "settings"));
    const s = t.settings;

    const gen = el('<div class="card" style="margin-bottom:14px"></div>');
    gen.appendChild(el('<div class="section-title"><h2>Informations</h2><div class="line"></div></div>'));
    const nameI = el(`<input type="text" value="${esc(t.name)}" />`);
    const dateI = el(`<input type="date" value="${esc(t.date || "")}" />`);
    const playersI = el(`<input type="number" min="2" max="128" value="${s.expectedPlayers || t.players.length}" />`);
    const grid1 = el('<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))"></div>');
    grid1.appendChild(wrapField("Nom", nameI)); grid1.appendChild(wrapField("Date", dateI)); grid1.appendChild(wrapField("Joueurs prévus", playersI));
    gen.appendChild(grid1); $app.appendChild(gen);

    const fmt = el('<div class="card" style="margin-bottom:14px"></div>');
    fmt.appendChild(el('<div class="section-title"><h2>Format</h2><div class="line"></div></div>'));
    const repI = el(`<label class="toggle"><input type="checkbox" ${s.repechage ? "checked" : ""}/><span class="track"></span><span>Repêchage des perdants</span></label>`);
    const secI = el(`<label class="toggle"><input type="checkbox" ${s.secondaryPool ? "checked" : ""}/><span class="track"></span><span>Afficher une poule secondaire</span></label>`);
    const rotI = el(`<label class="toggle"><input type="checkbox" ${s.autoRotate ? "checked" : ""}/><span class="track"></span><span>Rotation auto des vues (affichage)</span></label>`);
    const rotSecI = el(`<input type="number" min="5" max="600" value="${s.rotateSeconds || 30}" />`);
    fmt.appendChild(repI); fmt.appendChild(el('<div style="height:12px"></div>'));
    fmt.appendChild(secI); fmt.appendChild(el('<hr class="divider"/>'));
    fmt.appendChild(rotI); fmt.appendChild(el('<div style="height:12px"></div>'));
    fmt.appendChild(wrapField("Durée de rotation (secondes)", rotSecI));
    $app.appendChild(fmt);

    const rounds = el('<div class="card" style="margin-bottom:14px"></div>');
    rounds.appendChild(el('<div class="section-title"><h2>Valeur des manches</h2><div class="line"></div></div>'));
    rounds.appendChild(el('<p class="muted" style="margin-top:0">Nombre de points pour gagner un match à chaque manche.</p>'));
    const nbRounds = t.bracket ? t.bracket.totalRounds : Math.max(1, Math.ceil(Math.log2(Math.max(2, s.expectedPlayers || t.players.length || 2))));
    const roundWrap = el('<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))"></div>');
    const roundInputs = [];
    for (let r = 1; r <= nbRounds; r++) {
      const cur = Store.pointsForRound(t, r);
      const inp = el(`<input type="number" min="1" max="99" value="${cur != null ? cur : (r === nbRounds ? 11 : 7 + (r - 1) * 2)}" />`);
      roundInputs.push({ round: r, inp });
      roundWrap.appendChild(wrapField(r === nbRounds ? `Finale (manche ${r})` : `Manche ${r}`, inp));
    }
    rounds.appendChild(roundWrap); $app.appendChild(rounds);

    const rulesC = el('<div class="card" style="margin-bottom:14px"></div>');
    rulesC.appendChild(el('<div class="section-title"><h2>Règlement</h2><div class="line"></div></div>'));
    const rulesI = el(`<textarea style="min-height:120px">${esc(s.rules || "")}</textarea>`);
    rulesC.appendChild(rulesI); $app.appendChild(rulesC);

    const saveRow = el('<div class="btn-row" style="margin-bottom:26px"></div>');
    const saveBtn = el('<button class="btn">Enregistrer</button>');
    saveBtn.onclick = () => {
      t.name = nameI.value.trim() || t.name;
      t.date = dateI.value;
      s.expectedPlayers = parseInt(playersI.value, 10) || s.expectedPlayers;
      s.repechage = repI.querySelector("input").checked;
      s.secondaryPool = secI.querySelector("input").checked;
      s.autoRotate = rotI.querySelector("input").checked;
      s.rotateSeconds = parseInt(rotSecI.value, 10) || 30;
      s.format = s.repechage ? "double" : "single";
      s.roundValues = roundInputs.map((r) => ({ round: r.round, points: parseInt(r.inp.value, 10) || 7 }));
      s.rules = rulesI.value;
      Store.updateTournament(t.id, {});
      toast("Réglages enregistrés."); renderNav();
    };
    saveRow.appendChild(saveBtn);
    const delBtn = el('<button class="btn danger">Supprimer le tournoi</button>');
    delBtn.onclick = () => { if (confirm("Supprimer définitivement « " + t.name + " » ?")) { Store.deleteTournament(t.id); navigate("#/"); toast("Tournoi supprimé."); } };
    saveRow.appendChild(delBtn); $app.appendChild(saveRow);

    $app.appendChild(renderCloudCard());
  });

  function renderCloudCard() {
    const card = el('<div class="card"></div>');
    card.appendChild(el('<div class="section-title"><h2>Base de données &amp; partage</h2><div class="line"></div></div>'));
    const cloud = Cloud.isCloud();
    if (cloud) {
      card.appendChild(el(`<div class="info-banner ok" style="margin-bottom:12px"><span class="ico">☁︎</span>
        <div><strong>Connecté au cloud.</strong><br/><span class="muted">Données partagées en temps réel avec tout le monde. Les joueurs n’ont rien à configurer.</span></div></div>`));
    } else {
      card.appendChild(el(`<div class="info-banner" style="margin-bottom:12px"><span class="ico">📦</span>
        <div><strong>Mode local (ce navigateur).</strong><br/><span class="muted">Pour activer le partage, branchez un magasin de données dans Vercel (voir <code>README</code>). Ensuite tout est automatique, sans token.</span></div></div>`));
    }
    const row = el('<div class="btn-row"></div>');
    const reloadB = el('<button class="btn subtle">⟳ Recharger depuis le cloud</button>');
    reloadB.disabled = !cloud;
    reloadB.onclick = async () => {
      reloadB.textContent = "Chargement…"; reloadB.disabled = true;
      const r = await Cloud.pullNow();
      reloadB.disabled = false; reloadB.textContent = "⟳ Recharger depuis le cloud";
      if (r.error) toast(r.error, "err"); else { toast("Chargé : " + r.count + " tournoi(s)."); render(); }
      updateSyncPill();
    };
    row.appendChild(reloadB);
    if (cloud) {
      const pushB = el('<button class="btn subtle">⬆︎ Forcer l’envoi</button>');
      pushB.onclick = async () => {
        pushB.textContent = "Envoi…"; pushB.disabled = true;
        const r = await Cloud.pushPending("envoi manuel");
        pushB.disabled = false; pushB.textContent = "⬆︎ Forcer l’envoi";
        if (r && r.error) toast(r.error, "err"); else toast("Données envoyées ✓");
        updateSyncPill();
      };
      row.appendChild(pushB);
    }
    card.appendChild(row);
    return card;
  }

  // ============================================================
  //  Pastille de synchronisation
  // ============================================================
  function updateSyncPill() {
    const pill = document.getElementById("sync-pill");
    const label = document.getElementById("sync-label");
    const st = Cloud.getStatus();
    pill.classList.remove("connected", "error");
    if (st === "connected") { pill.classList.add("connected"); label.textContent = "Cloud"; }
    else if (st === "syncing") { label.textContent = "Synchro…"; }
    else if (st === "error") { pill.classList.add("error"); label.textContent = "Erreur"; }
    else { label.textContent = "Local"; }
  }

  function notFound() {
    document.body.classList.remove("fullbleed");
    $app.appendChild(el('<div class="empty"><div class="ico">🔍</div><p>Tournoi introuvable.</p><a class="btn" href="#/" style="margin-top:14px">Retour à l’accueil</a></div>'));
  }

  // ============================================================
  //  Démarrage
  // ============================================================
  function boot() {
    Store.load();
    Cloud.onStatus(updateSyncPill);
    updateSyncPill();

    document.getElementById("sync-pill").onclick = () => {
      const m = parseHash().match(/^\/t\/([^/]+)/);
      if (m) navigate("#/t/" + m[1] + "/settings");
      else toast(Cloud.isCloud() ? "Données partagées via le cloud ☁︎" : "Mode local — voir Réglages pour partager.");
    };

    Store.onChange(() => { renderNav(); });
    window.addEventListener("hashchange", () => { render(); renderNav(); });

    Cloud.onRemoteChange(() => {
      const a = document.activeElement;
      const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
      const modalOpen = !!document.querySelector(".modal-overlay");
      if (!typing && !modalOpen) { render(); renderNav(); }
    });

    render();
    renderNav();

    Cloud.init().then((mode) => {
      updateSyncPill();
      if (mode === "cloud") {
        Cloud.bootSync().then(() => { render(); renderNav(); updateSyncPill(); Cloud.startPolling(); });
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
