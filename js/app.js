/* ============================================================
   app.js — Routeur SPA + rendu des vues
   The Travellers — Suivi de tournois de backgammon
   ============================================================ */
(function () {
  "use strict";

  const Store = TG.Store;
  const Cloud = TG.Cloud;
  const $app = document.getElementById("app");
  const $nav = document.getElementById("topnav");

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
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 2800);
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

  function field(label, inputHtml) {
    const f = el(`<label class="field">${esc(label)}</label>`);
    f.appendChild(el(inputHtml));
    return f;
  }

  // ---------- Routeur ----------
  const routes = [];
  function route(pattern, handler) {
    const keys = [];
    const rx = new RegExp("^" + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; }) + "$");
    routes.push({ rx, keys, handler });
  }

  function navigate(hash) { location.hash = hash; }

  function parseHash() {
    let h = location.hash.replace(/^#/, "");
    if (!h || h === "/") h = "/";
    return h;
  }

  function render() {
    const path = parseHash();
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

  // ---------- Barre de navigation contextuelle ----------
  function renderNav() {
    const path = parseHash();
    const m = path.match(/^\/t\/([^/]+)/);
    clear($nav);
    $nav.appendChild(navLink("#/", "Tournois", path === "/"));
    if (m) {
      const t = Store.getTournament(m[1]);
      if (t) $nav.appendChild(navLink("#/t/" + t.id + "/bracket", t.name, false));
    }
  }
  function navLink(href, label, active) {
    return el(`<a href="${href}" class="${active ? "active" : ""}">${esc(label)}</a>`);
  }

  // ---------- Sous-onglets d'un tournoi ----------
  function subtabs(tid, current) {
    const items = [
      ["players", "Joueurs"], ["bracket", "Tableau"], ["scores", "Saisie des scores"], ["settings", "Réglages"],
    ];
    const wrap = el('<div class="subtabs"></div>');
    items.forEach(([k, label]) => {
      wrap.appendChild(el(`<a href="#/t/${tid}/${k}" class="${current === k ? "active" : ""}">${esc(label)}</a>`));
    });
    return wrap;
  }

  function pageHead(eyebrow, title, subtitle, right) {
    const head = el(`<div class="page-head">
      <div>
        <div class="eyebrow">${esc(eyebrow)}</div>
        <h1>${esc(title)}</h1>
        ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
      </div>
    </div>`);
    if (right) head.appendChild(right);
    return head;
  }

  // ============================================================
  //  VUE : Accueil (liste des tournois)
  // ============================================================
  route("/", function () {
    const addBtn = el('<button class="btn">＋ Nouveau tournoi</button>');
    addBtn.onclick = openCreateTournament;
    $app.appendChild(pageHead("The Travellers Club", "Tournois de Backgammon", "Sélectionnez un tournoi ou créez-en un nouveau.", addBtn));

    const list = Store.listTournaments();
    if (!list.length) {
      const empty = el(`<div class="card empty"><div class="ico">🎲</div>
        <h2>Aucun tournoi pour le moment</h2>
        <p class="muted">Créez votre premier tournoi pour commencer le suivi.</p></div>`);
      const b = el('<button class="btn" style="margin-top:14px">＋ Créer un tournoi</button>');
      b.onclick = openCreateTournament; empty.appendChild(b);
      $app.appendChild(empty);
      return;
    }

    const grid = el('<div class="grid cols"></div>');
    list.forEach((t) => {
      const nbMatches = Store.allMatches(t).length;
      const done = Store.allMatches(t).filter((m) => m.status === "done").length;
      const statusChip = !t.bracket
        ? '<span class="chip warn">Non démarré</span>'
        : (done >= nbMatches && nbMatches > 0 ? '<span class="chip ok">Terminé</span>' : '<span class="chip gold">En cours</span>');
      const card = el(`<div class="card t-card">
        <h3>${esc(t.name)}</h3>
        <div class="meta">📅 ${esc(t.date || "—")} · 👥 ${t.players.length} joueurs</div>
        <div class="chips">
          ${statusChip}
          ${(t.settings.secondaryPool || t.settings.repechage) ? '<span class="chip">Poule secondaire</span>' : ""}
          ${t.bracket ? `<span class="chip">${done}/${nbMatches} matchs</span>` : ""}
        </div>
      </div>`);
      card.onclick = () => navigate("#/t/" + t.id + "/bracket");
      grid.appendChild(card);
    });
    $app.appendChild(grid);
  });

  function openCreateTournament() {
    const nameI = el('<input type="text" placeholder="Ex. Open de printemps" />');
    const dateI = el(`<input type="date" value="${new Date().toISOString().slice(0, 10)}" />`);
    const playersI = el('<input type="number" min="2" max="128" value="8" />');
    modal({
      title: "Nouveau tournoi",
      bodyNodes: [
        wrapField("Nom du tournoi", nameI),
        wrapField("Date", dateI),
        wrapField("Nombre de joueurs prévu", playersI),
      ],
      actions: [
        { label: "Annuler", cls: "subtle", onClick: (c) => c() },
        { label: "Créer", onClick: (c) => {
            const name = nameI.value.trim() || "Tournoi sans nom";
            const t = Store.createTournament(name, dateI.value);
            t.settings.expectedPlayers = parseInt(playersI.value, 10) || 8;
            Store.commit("config initiale");
            c(); navigate("#/t/" + t.id + "/players");
            toast("Tournoi créé.");
          } },
      ],
    });
  }
  function wrapField(label, input) { const f = el(`<label class="field">${esc(label)}</label>`); f.appendChild(input); return f; }

  // ============================================================
  //  VUE : Joueurs
  // ============================================================
  route("/t/:id/players", function (p) {
    const t = Store.getTournament(p.id);
    if (!t) return notFound();
    const addBtn = el('<button class="btn">＋ Ajouter un joueur</button>');
    addBtn.onclick = () => openPlayerForm(t);
    $app.appendChild(pageHead(t.name, "Joueurs", "Liste, statistiques et gestion des participants.", addBtn));
    $app.appendChild(subtabs(t.id, "players"));

    // Stats globales
    const totalPts = t.players.reduce((a, pl) => a + Store.playerStats(t, pl.id).pointsFor, 0);
    const stats = el(`<div class="card" style="margin-bottom:18px">
      <div class="stat-row">
        <div class="stat"><div class="n">${t.players.length}</div><div class="l">Joueurs</div></div>
        <div class="stat"><div class="n">${Store.allMatches(t).filter(m=>m.status==="done"&&m.p1!=="BYE"&&m.p2!=="BYE").length}</div><div class="l">Matchs joués</div></div>
        <div class="stat"><div class="n">${totalPts}</div><div class="l">Points marqués</div></div>
      </div>
    </div>`);
    $app.appendChild(stats);

    if (!t.players.length) {
      $app.appendChild(el('<div class="card empty"><div class="ico">👤</div><p>Aucun joueur inscrit.</p></div>'));
      return;
    }

    const rows = t.players
      .map((pl) => ({ pl, s: Store.playerStats(t, pl.id) }))
      .sort((a, b) => b.s.wins - a.s.wins || b.s.pointsFor - a.s.pointsFor);

    const table = el(`<div class="card"><table class="table">
      <thead><tr>
        <th class="rank">#</th><th>Joueur</th><th>Club</th>
        <th>Matchs</th><th>Victoires</th><th>Points</th><th>Diff.</th><th></th>
      </tr></thead><tbody></tbody></table></div>`);
    const tbody = table.querySelector("tbody");
    rows.forEach((r, i) => {
      const diff = r.s.pointsFor - r.s.pointsAgainst;
      const tr = el(`<tr>
        <td class="rank">${i + 1}</td>
        <td><strong>${esc(r.pl.name)}</strong>${r.pl.rating ? ` <span class="chip">${esc(r.pl.rating)}</span>` : ""}</td>
        <td class="muted">${esc(r.pl.club || "—")}</td>
        <td class="num">${r.s.played}</td>
        <td class="num">${r.s.wins}</td>
        <td class="num">${r.s.pointsFor}</td>
        <td class="num">${diff > 0 ? "+" : ""}${diff}</td>
        <td></td>
      </tr>`);
      const actions = el('<div class="btn-row"></div>');
      const edit = el('<button class="btn sm subtle">Modifier</button>');
      edit.onclick = () => openPlayerForm(t, r.pl);
      const del = el('<button class="btn sm danger">✕</button>');
      del.onclick = () => {
        if (confirm("Retirer " + r.pl.name + " ?")) { Store.removePlayer(t.id, r.pl.id); render(); }
      };
      actions.appendChild(edit); actions.appendChild(del);
      tr.lastElementChild.appendChild(actions);
      tbody.appendChild(tr);
    });
    $app.appendChild(table);

    if (t.bracket) {
      $app.appendChild(el('<p class="muted" style="margin-top:14px">⚠️ Le tableau est déjà généré. Modifier les joueurs ne le régénère pas automatiquement — régénérez-le depuis l’onglet Tableau si besoin.</p>'));
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
            if (player) Store.updatePlayer(t.id, player.id, data);
            else Store.addPlayer(t.id, name, data);
            c(); render();
          } },
      ],
    });
  }

  // ============================================================
  //  VUE : Tableau (bracket)
  // ============================================================
  let rotateTimer = null;
  let currentView = "main"; // main | sec

  route("/t/:id/bracket", function (p) {
    clearRotate();
    const t = Store.getTournament(p.id);
    if (!t) return notFound();

    const right = el('<div class="btn-row"></div>');
    const genBtn = el(`<button class="btn ${t.bracket ? "subtle" : ""}">${t.bracket ? "↻ Régénérer" : "⚙︎ Générer le tableau"}</button>`);
    genBtn.onclick = () => openGenerate(t);
    right.appendChild(genBtn);
    $app.appendChild(pageHead(t.name, "Tableau du tournoi", "Visualisation en arbre à élimination directe.", right));
    $app.appendChild(subtabs(t.id, "bracket"));

    if (!t.bracket) {
      $app.appendChild(el(`<div class="card empty"><div class="ico">🌳</div>
        <h2>Tableau non généré</h2>
        <p class="muted">Inscrivez les joueurs puis générez le tableau pour démarrer.</p></div>`));
      return;
    }

    const hasSec = !!t.secondary;
    if (currentView === "sec" && !hasSec) currentView = "main";

    // Barre d'outils (vues + rotation auto)
    const toolbar = el('<div class="bracket-toolbar"></div>');
    const views = el('<div class="bracket-views"></div>');
    if (hasSec) {
      const prev = el('<button class="arrow-btn" title="Vue précédente">‹</button>');
      const name = el(`<div class="view-name"></div>`);
      const next = el('<button class="arrow-btn" title="Vue suivante">›</button>');
      const updateName = () => { name.textContent = currentView === "main" ? "Tableau principal" : "Poule secondaire"; };
      updateName();
      const swap = () => { currentView = currentView === "main" ? "sec" : "main"; updateName(); drawBracket(); };
      prev.onclick = () => { stopAuto(); swap(); };
      next.onclick = () => { stopAuto(); swap(); };
      views.appendChild(prev); views.appendChild(name); views.appendChild(next);
    } else {
      views.appendChild(el('<div class="view-name">Tableau principal</div>'));
    }
    toolbar.appendChild(views);

    const rightTools = el('<div class="btn-row"></div>');
    let autoOn = false;
    if (hasSec) {
      const autoBtn = el(`<button class="btn subtle sm">▶︎ Rotation auto (${t.settings.rotateSeconds || 30}s)</button>`);
      autoBtn.onclick = () => {
        if (autoOn) { stopAuto(); autoBtn.textContent = `▶︎ Rotation auto (${t.settings.rotateSeconds || 30}s)`; autoBtn.classList.add("subtle"); }
        else { startAuto(); autoBtn.textContent = "⏸ Rotation en cours"; autoBtn.classList.remove("subtle"); }
      };
      function startAuto() {
        autoOn = true;
        const sec = (t.settings.rotateSeconds || 30) * 1000;
        rotateTimer = setInterval(() => {
          currentView = currentView === "main" ? "sec" : "main";
          const nm = views.querySelector(".view-name");
          if (nm) nm.textContent = currentView === "main" ? "Tableau principal" : "Poule secondaire";
          drawBracket();
        }, sec);
      }
      window.__stopAuto = function () { autoOn = false; clearRotate(); };
      rightTools.appendChild(autoBtn);
    }
    function stopAuto() { autoOn = false; clearRotate(); const ab = rightTools.querySelector("button"); if (ab && hasSec) { ab.textContent = `▶︎ Rotation auto (${t.settings.rotateSeconds || 30}s)`; ab.classList.add("subtle"); } }

    toolbar.appendChild(rightTools);
    $app.appendChild(toolbar);

    const scroll = el('<div class="bracket-scroll"></div>');
    $app.appendChild(scroll);

    function drawBracket() {
      clear(scroll);
      const b = currentView === "sec" ? t.secondary : t.bracket;
      scroll.appendChild(renderBracketTree(t, b));
    }
    drawBracket();

    // Démarre la rotation auto si activée dans les réglages.
    if (hasSec && t.settings.autoRotate) {
      const ab = rightTools.querySelector("button");
      if (ab) ab.click();
    }
  });

  function clearRotate() { if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; } }

  function renderBracketTree(t, b) {
    const wrap = el('<div class="bracket"></div>');
    const roundNames = (n) => {
      // n = numéro de manche (1..total). Nomme depuis la fin.
      const fromEnd = b.totalRounds - n;
      if (fromEnd === 0) return "Finale";
      if (fromEnd === 1) return "Demi-finales";
      if (fromEnd === 2) return "Quarts de finale";
      return "Manche " + n;
    };
    b.rounds.forEach((ids, ri) => {
      const round = ri + 1;
      const col = el('<div class="bracket-round"></div>');
      const pts = Store.pointsForRound(t, round);
      col.appendChild(el(`<div class="round-title">${esc(roundNames(round))}${pts ? `<span class="round-pts">${pts} points</span>` : ""}</div>`));
      ids.forEach((id) => {
        const m = Store.findMatch(b, id);
        col.appendChild(renderMatch(t, m));
      });
      wrap.appendChild(col);
    });
    return wrap;
  }

  function renderMatch(t, m) {
    const live = m.status === "ready";
    const done = m.status === "done";
    const box = el(`<div class="match ${live ? "live" : ""} ${done ? "done" : ""}"></div>`);
    const seat = (pid, score, isWinner) => {
      const bye = pid === "BYE";
      const cls = bye ? "bye" : (done ? (isWinner ? "win" : "lose") : "");
      const nm = pid ? Store.playerName(t, pid) : "—";
      return `<div class="seat ${cls}">
        <span class="name">${esc(nm)}</span>
        <span class="sc">${score == null ? "" : score}</span>
      </div>`;
    };
    box.innerHTML =
      seat(m.p1, m.score1, m.winner && m.winner === m.p1) +
      seat(m.p2, m.score2, m.winner && m.winner === m.p2);
    return box;
  }

  function openGenerate(t) {
    if (t.players.length < 2) { toast("Il faut au moins 2 joueurs.", "err"); return; }
    const shuffleI = el('<label class="toggle"><input type="checkbox" checked/><span class="track"></span><span>Mélanger l’ordre (tirage aléatoire)</span></label>');
    const info = el(`<p class="muted">${t.players.length} joueurs. ${t.bracket ? "⚠️ Régénérer effacera les scores déjà saisis." : ""}</p>`);
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
    $app.appendChild(pageHead(t.name, "Saisie des scores", "Sélectionnez votre nom pour enregistrer votre match.", null));
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
    const wiz = el('<div class="wizard card"></div>');

    if (!selectedPid) {
      wiz.appendChild(el('<div class="section-title"><h2>Qui êtes-vous ?</h2><div class="line"></div></div>'));
      const pick = el('<div class="player-pick"></div>');
      t.players.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((pl) => {
        const btn = el(`<button>${esc(pl.name)}</button>`);
        btn.onclick = () => renderScoreStep(t, pl.id);
        pick.appendChild(btn);
      });
      wiz.appendChild(pick);
      $app.appendChild(wiz);
      return;
    }

    const pl = t.players.find((x) => x.id === selectedPid);
    const back = el('<button class="btn subtle sm" style="margin-bottom:14px">‹ Changer de joueur</button>');
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
        wiz.appendChild(el(`<div class="info-banner wait">
          <span class="ico">⏳</span>
          <div><strong>Patientez.</strong><br/>
          <span class="muted">Votre prochain match attend la fin du match de ${esc(oppName)}. Revenez quand votre adversaire sera connu.</span></div>
        </div>`));
      } else {
        // Plus de match : éliminé ou champion ?
        const allDone = Store.allMatches(t).filter(m => m.p1 === selectedPid || m.p2 === selectedPid);
        const isChampion = isPlayerChampion(t, selectedPid);
        if (isChampion) {
          wiz.appendChild(el(`<div class="info-banner ok"><span class="ico">🏆</span><div><strong>Félicitations, vainqueur du tournoi !</strong></div></div>`));
        } else if (allDone.length) {
          wiz.appendChild(el(`<div class="info-banner"><span class="ico">🎲</span><div>Vous n’avez plus de match à jouer pour le moment.</div></div>`));
        } else {
          wiz.appendChild(el(`<div class="info-banner"><span class="ico">🎲</span><div>Aucun match prévu pour vous.</div></div>`));
        }
      }
    }

    // Récap des matchs récents du joueur
    const hist = Store.allMatches(t).filter((m) => m.status === "done" && (m.p1 === selectedPid || m.p2 === selectedPid));
    if (hist.length) {
      const h = el('<div style="margin-top:20px"></div>');
      h.appendChild(el('<div class="section-title"><h2 style="font-size:1.2rem">Vos matchs</h2><div class="line"></div></div>'));
      hist.forEach((m) => {
        const mine = m.p1 === selectedPid ? m.score1 : m.score2;
        const opp = m.p1 === selectedPid ? m.score2 : m.score1;
        const oppId = m.p1 === selectedPid ? m.p2 : m.p1;
        const won = m.winner === selectedPid;
        h.appendChild(el(`<div class="info-banner ${won ? "ok" : ""}" style="margin:8px 0">
          <span class="ico">${won ? "✓" : "✕"}</span>
          <div>vs <strong>${esc(Store.playerName(t, oppId))}</strong> — ${mine}–${opp} ${won ? "(victoire)" : "(défaite)"}</div>
        </div>`));
      });
      wiz.appendChild(h);
    }

    $app.appendChild(wiz);
  }

  function renderScoreForm(t, m, selectedPid) {
    const wrap = el('<div></div>');
    const pts = Store.pointsForRound(t, m.round);
    const tag = m.tag === "sec" ? "Poule secondaire" : "Tableau principal";
    wrap.appendChild(el(`<div class="info-banner"><span class="ico">🎯</span>
      <div><strong>${esc(tag)} — Manche ${m.round}</strong>${pts ? ` · match en ${pts} points` : ""}<br/>
      <span class="muted">Saisissez le score final de votre match.</span></div></div>`));

    const n1 = Store.playerName(t, m.p1), n2 = Store.playerName(t, m.p2);
    const summary = el(`<div class="match-summary">
      <div class="vs-side"><div class="pname">${esc(n1)}</div></div>
      <div class="vs-mid">VS</div>
      <div class="vs-side"><div class="pname">${esc(n2)}</div></div>
    </div>`);
    const s1 = el(`<input type="number" min="0" inputmode="numeric" />`);
    const s2 = el(`<input type="number" min="0" inputmode="numeric" />`);
    if (pts) { s1.placeholder = "0–" + pts; s2.placeholder = "0–" + pts; }
    summary.children[0].appendChild(s1);
    summary.children[2].appendChild(s2);
    wrap.appendChild(summary);

    const save = el('<button class="btn" style="width:100%">Enregistrer le résultat</button>');
    save.onclick = () => {
      const r = Store.recordScore(t.id, m.id, s1.value, s2.value);
      if (r.error) { toast(r.error, "err"); return; }
      toast("Résultat enregistré ✓");
      // Affiche le prochain match du joueur sélectionné
      renderScoreStep(t, selectedPid);
      showNextMatchInfo(t, selectedPid);
    };
    wrap.appendChild(save);
    return wrap;
  }

  function showNextMatchInfo(t, pid) {
    const next = Store.findReadyMatchForPlayer(t, pid);
    const wiz = $app.querySelector(".wizard");
    if (!wiz) return;
    if (next) {
      const oppId = next.p1 === pid ? next.p2 : next.p1;
      const pts = Store.pointsForRound(t, next.round);
      const card = el(`<div class="next-match-card">
        <div class="muted">Match suivant — Manche ${next.round}${pts ? ` (${pts} pts)` : ""}</div>
        <div class="big">vs ${esc(Store.playerName(t, oppId))}</div>
      </div>`);
      wiz.appendChild(card);
    }
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
    $app.appendChild(pageHead(t.name, "Réglages du tournoi", "Format, valeur des manches, règlement et synchronisation.", null));
    $app.appendChild(subtabs(t.id, "settings"));

    const s = t.settings;

    // ----- Informations générales -----
    const gen = el('<div class="card" style="margin-bottom:18px"></div>');
    gen.appendChild(el('<div class="section-title"><h2>Informations</h2><div class="line"></div></div>'));
    const nameI = el(`<input type="text" value="${esc(t.name)}" />`);
    const dateI = el(`<input type="date" value="${esc(t.date || "")}" />`);
    const playersI = el(`<input type="number" min="2" max="128" value="${s.expectedPlayers || t.players.length}" />`);
    const grid1 = el('<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))"></div>');
    grid1.appendChild(wrapField("Nom", nameI));
    grid1.appendChild(wrapField("Date", dateI));
    grid1.appendChild(wrapField("Nombre de joueurs prévu", playersI));
    gen.appendChild(grid1);
    $app.appendChild(gen);

    // ----- Format & poules -----
    const fmt = el('<div class="card" style="margin-bottom:18px"></div>');
    fmt.appendChild(el('<div class="section-title"><h2>Format</h2><div class="line"></div></div>'));
    const repI = el(`<label class="toggle"><input type="checkbox" ${s.repechage ? "checked" : ""}/><span class="track"></span><span>Repêchage des perdants (poule des perdants)</span></label>`);
    const secI = el(`<label class="toggle"><input type="checkbox" ${s.secondaryPool ? "checked" : ""}/><span class="track"></span><span>Afficher une poule secondaire</span></label>`);
    const rotI = el(`<label class="toggle"><input type="checkbox" ${s.autoRotate ? "checked" : ""}/><span class="track"></span><span>Rotation automatique des vues (affichage)</span></label>`);
    const rotSecI = el(`<input type="number" min="5" max="600" value="${s.rotateSeconds || 30}" />`);
    fmt.appendChild(repI);
    fmt.appendChild(el('<div style="height:10px"></div>'));
    fmt.appendChild(secI);
    fmt.appendChild(el('<hr class="divider"/>'));
    fmt.appendChild(rotI);
    fmt.appendChild(el('<div style="height:10px"></div>'));
    fmt.appendChild(wrapField("Durée de rotation (secondes)", rotSecI));
    $app.appendChild(fmt);

    // ----- Valeur des manches -----
    const rounds = el('<div class="card" style="margin-bottom:18px"></div>');
    rounds.appendChild(el('<div class="section-title"><h2>Valeur des manches</h2><div class="line"></div></div>'));
    rounds.appendChild(el('<p class="muted">Définissez le nombre de points pour gagner un match à chaque manche (ex. manche 1 : 7 pts, manche 2 : 9 pts).</p>'));
    const nbRounds = t.bracket ? t.bracket.totalRounds : Math.max(1, Math.ceil(Math.log2(Math.max(2, s.expectedPlayers || t.players.length || 2))));
    const roundWrap = el('<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))"></div>');
    const roundInputs = [];
    for (let r = 1; r <= nbRounds; r++) {
      const cur = Store.pointsForRound(t, r);
      const inp = el(`<input type="number" min="1" max="99" value="${cur != null ? cur : (r === nbRounds ? 11 : 7 + (r - 1) * 2)}" />`);
      roundInputs.push({ round: r, inp });
      const label = r === nbRounds ? `Finale (manche ${r})` : `Manche ${r}`;
      roundWrap.appendChild(wrapField(label, inp));
    }
    rounds.appendChild(roundWrap);
    $app.appendChild(rounds);

    // ----- Règlement -----
    const rulesC = el('<div class="card" style="margin-bottom:18px"></div>');
    rulesC.appendChild(el('<div class="section-title"><h2>Règlement</h2><div class="line"></div></div>'));
    const rulesI = el(`<textarea style="min-height:140px">${esc(s.rules || "")}</textarea>`);
    rulesC.appendChild(rulesI);
    $app.appendChild(rulesC);

    // ----- Boutons -----
    const saveRow = el('<div class="btn-row" style="margin-bottom:30px"></div>');
    const saveBtn = el('<button class="btn">💾 Enregistrer les réglages</button>');
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
      toast("Réglages enregistrés.");
      renderNav();
    };
    saveRow.appendChild(saveBtn);
    const delBtn = el('<button class="btn danger">Supprimer le tournoi</button>');
    delBtn.onclick = () => {
      if (confirm("Supprimer définitivement « " + t.name + " » ?")) {
        Store.deleteTournament(t.id); navigate("#/"); toast("Tournoi supprimé.");
      }
    };
    saveRow.appendChild(delBtn);
    $app.appendChild(saveRow);

    // ----- Base de données (cloud partagé) -----
    $app.appendChild(renderCloudCard());
  });

  function renderCloudCard() {
    const card = el('<div class="card"></div>');
    card.appendChild(el('<div class="section-title"><h2>Base de données &amp; partage</h2><div class="line"></div></div>'));

    const cloud = Cloud.isCloud();
    if (cloud) {
      card.appendChild(el(`<div class="info-banner ok" style="margin-bottom:12px">
        <span class="ico">☁︎</span>
        <div><strong>Connecté au cloud.</strong><br/>
        <span class="muted">Les données sont enregistrées en ligne et <strong>partagées en temps réel avec tout le monde</strong>. Aucun réglage n’est nécessaire pour les joueurs : il leur suffit d’ouvrir le lien.</span></div>
      </div>`));
    } else {
      card.appendChild(el(`<div class="info-banner" style="margin-bottom:12px">
        <span class="ico">📦</span>
        <div><strong>Mode local (ce navigateur).</strong><br/>
        <span class="muted">Le partage cloud n’est pas encore activé : les données restent sur cet appareil. Pour activer le partage entre tous les joueurs, branchez un magasin de données dans Vercel (une seule fois) — voir le <code>README</code>. Une fois branché, tout fonctionne automatiquement, sans aucun token.</span></div>
      </div>`));
    }

    const row = el('<div class="btn-row" style="margin-top:6px"></div>');
    const reloadB = el('<button class="btn subtle">⟳ Recharger depuis le cloud</button>');
    reloadB.disabled = !cloud;
    reloadB.onclick = async () => {
      reloadB.textContent = "Chargement…"; reloadB.disabled = true;
      const r = await Cloud.pullNow();
      reloadB.disabled = false; reloadB.textContent = "⟳ Recharger depuis le cloud";
      if (r.error) toast(r.error, "err");
      else { toast("Chargé : " + r.count + " tournoi(s)."); render(); }
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
    $app.appendChild(el('<div class="empty"><div class="ico">🔍</div><p>Tournoi introuvable.</p><a class="btn" href="#/">Retour à l’accueil</a></div>'));
  }

  // ============================================================
  //  Démarrage
  // ============================================================
  function boot() {
    Store.load();
    Cloud.onStatus(updateSyncPill);
    updateSyncPill();

    document.getElementById("sync-pill").onclick = () => {
      const path = parseHash();
      const m = path.match(/^\/t\/([^/]+)/);
      if (m) navigate("#/t/" + m[1] + "/settings");
      else toast(Cloud.isCloud() ? "Données partagées via le cloud ☁︎" : "Mode local — voir Réglages pour activer le partage.");
    };

    Store.onChange(() => { renderNav(); });
    window.addEventListener("hashchange", () => { clearRotate(); render(); renderNav(); });

    // Rafraîchit l'affichage quand une mise à jour distante arrive,
    // sans interrompre une saisie en cours.
    Cloud.onRemoteChange(() => {
      const a = document.activeElement;
      const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
      const modalOpen = !!document.querySelector(".modal-overlay");
      if (!typing && !modalOpen) { render(); renderNav(); }
    });

    render();
    renderNav();

    // Démarrage du cloud : sonde le backend, aligne les données, puis
    // active le rafraîchissement « temps réel ».
    Cloud.init().then((mode) => {
      updateSyncPill();
      if (mode === "cloud") {
        Cloud.bootSync().then(() => {
          render();
          renderNav();
          updateSyncPill();
          Cloud.startPolling();
        });
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
