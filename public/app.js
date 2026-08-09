(() => {
  "use strict";

  // -------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------
  const state = {
    mode: "daily",
    token: null,
    dateKey: null,
    maxGuesses: 8,
    guessedIds: new Set(),
    history: [], // feedback rows
    gameOver: false,
    won: false,
  };

  const els = {
    guessInput: document.getElementById("guessInput"),
    suggestions: document.getElementById("suggestions"),
    guessCounter: document.getElementById("guessCounter"),
    statusMsg: document.getElementById("statusMsg"),
    resultsBody: document.getElementById("resultsBody"),
    endPanel: document.getElementById("endPanel"),
    endCard: document.getElementById("endCard"),
    modeTabs: document.querySelectorAll(".mode-tab"),
    howToBtn: document.getElementById("howToPlayBtn"),
    howToOverlay: document.getElementById("howToOverlay"),
    statsBtn: document.getElementById("statsBtn"),
    statsOverlay: document.getElementById("statsOverlay"),
    statsGrid: document.getElementById("statsGrid"),
    distChart: document.getElementById("distChart"),
  };

  // -------------------------------------------------------------------
  // Local storage keys
  // -------------------------------------------------------------------
  const LS_TOKEN_PREFIX = "fw_token_"; // + mode (+ dateKey for daily)
  const LS_STATS = "fw_stats_v1";
  const LS_SEEN_HOWTO = "fw_seen_howto";

  function todayKeyLocalGuessFallback() {
    return new Date().toISOString().slice(0, 10);
  }

  function tokenStorageKey(mode) {
    if (mode === "daily") return `${LS_TOKEN_PREFIX}daily_${todayKeyLocalGuessFallback()}`;
    return `${LS_TOKEN_PREFIX}unlimited_active`;
  }

  function loadStats() {
    try {
      return JSON.parse(localStorage.getItem(LS_STATS)) || defaultStats();
    } catch {
      return defaultStats();
    }
  }
  function defaultStats() {
    return {
      played: 0,
      won: 0,
      currentStreak: 0,
      maxStreak: 0,
      distribution: [0, 0, 0, 0, 0, 0, 0, 0], // index 0..7 = guesses 1..8
      lastDailyDateKey: null,
    };
  }
  function saveStats(s) {
    localStorage.setItem(LS_STATS, JSON.stringify(s));
  }

  function recordResult({ mode, dateKey, won, guessesUsed }) {
    // Only the Daily Challenge feeds the persistent streak/stat tracker,
    // matching the classic Wordle-style behaviour. Unlimited games are
    // just for fun and don't affect streaks.
    if (mode !== "daily") return;
    const s = loadStats();
    if (s.lastDailyDateKey === dateKey) return; // already recorded today
    s.played += 1;
    if (won) {
      s.won += 1;
      s.currentStreak += 1;
      s.maxStreak = Math.max(s.maxStreak, s.currentStreak);
      s.distribution[guessesUsed - 1] += 1;
    } else {
      s.currentStreak = 0;
    }
    s.lastDailyDateKey = dateKey;
    saveStats(s);
  }

  // -------------------------------------------------------------------
  // API helpers
  // -------------------------------------------------------------------
  async function api(path, opts) {
    const res = await fetch(path, {
      method: opts && opts.body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  // -------------------------------------------------------------------
  // Game lifecycle
  // -------------------------------------------------------------------
  async function startOrResume(mode) {
    state.mode = mode;
    resetBoard();

    const stored = localStorage.getItem(tokenStorageKey(mode));
    if (stored) {
      try {
        const s = await api("/api/game/state", { body: { token: stored } });
        state.token = stored;
        state.dateKey = s.dateKey;
        state.maxGuesses = 8;
        state.history = s.history || [];
        state.gameOver = s.gameOver;
        state.won = s.won;
        state.guessedIds = new Set(state.history.map((h) => h.guessedPlayer.id));
        renderHistory();
        updateCounter(s.guessesUsed);
        if (s.gameOver) showEndPanel(s.won, s.reveal, s.guessesUsed);
        return;
      } catch {
        localStorage.removeItem(tokenStorageKey(mode));
      }
    }

    const fresh = await api("/api/game/new", { body: { mode } });
    state.token = fresh.token;
    state.dateKey = fresh.dateKey;
    state.maxGuesses = fresh.maxGuesses;
    localStorage.setItem(tokenStorageKey(mode), fresh.token);
    updateCounter(0);
  }

  function resetBoard() {
    state.history = [];
    state.guessedIds = new Set();
    state.gameOver = false;
    state.won = false;
    els.resultsBody.innerHTML = "";
    els.endPanel.hidden = true;
    els.statusMsg.textContent = "";
    els.guessInput.value = "";
    els.guessInput.disabled = false;
    hideSuggestions();
  }

  function updateCounter(used) {
    els.guessCounter.textContent = `${used} / ${state.maxGuesses} guesses`;
  }

  async function submitGuess(playerId) {
    if (state.gameOver) return;
    if (state.guessedIds.has(playerId)) {
      setStatus("You already guessed that player.");
      return;
    }
    els.guessInput.disabled = true;
    try {
      const data = await api("/api/guess", { body: { token: state.token, playerId } });
      state.token = data.token;
      localStorage.setItem(tokenStorageKey(state.mode), data.token);
      state.guessedIds.add(playerId);
      state.history.push(data.feedback);
      appendRow(data.feedback);
      updateCounter(data.guessesUsed);
      setStatus("");

      if (data.gameOver) {
        state.gameOver = true;
        state.won = data.won;
        recordResult({ mode: state.mode, dateKey: state.dateKey, won: data.won, guessesUsed: data.guessesUsed });
        showEndPanel(data.won, data.reveal, data.guessesUsed);
      }
    } catch (err) {
      setStatus(err.message);
    } finally {
      els.guessInput.disabled = state.gameOver;
      if (!state.gameOver) els.guessInput.focus();
    }
  }

  function setStatus(msg) {
    els.statusMsg.textContent = msg;
  }

  // -------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------
  function resultClass(result) {
    if (result === "green") return "green";
    if (result === "yellow") return "yellow";
    if (result === "gray") return "gray";
    return "gray";
  }

  function arrowClass(result) {
    if (result === "up") return "arrow-up";
    if (result === "down") return "arrow-down";
    return "";
  }

  function renderHistory() {
    els.resultsBody.innerHTML = "";
    state.history.forEach(appendRow);
  }

  function appendRow(fb) {
    const row = document.createElement("div");
    row.className = "result-row";

    const playerCell = document.createElement("div");
    playerCell.className = "cell player-col";
    playerCell.innerHTML = `
      ${fb.guessedPlayer.face_url ? `<img src="${fb.guessedPlayer.face_url}" alt="" loading="lazy" />` : ""}
      <span>${escapeHtml(fb.guessedPlayer.short_name)}</span>
    `;
    row.appendChild(playerCell);

    row.appendChild(makeResultCell(fb.nationality.value, fb.nationality.result));
    row.appendChild(makeResultCell(fb.league.value, fb.league.result));
    row.appendChild(makeResultCell(fb.club.value, fb.club.result));
    row.appendChild(makeResultCell(fb.position.value, fb.position.result));
    row.appendChild(makeArrowCell(fb.age.value, fb.age.result));
    row.appendChild(makeArrowCell(fb.overall.value, fb.overall.result));
    row.appendChild(makeArrowCell(fb.weak_foot.value, fb.weak_foot.result));
    row.appendChild(makeArrowCell(fb.skill_moves.value, fb.skill_moves.result));
    row.appendChild(makeTraitsCell(fb.traits.shared));

    els.resultsBody.prepend(row); // most recent guess on top
  }

  function makeResultCell(value, result) {
    const div = document.createElement("div");
    div.className = `cell result-cell ${resultClass(result)}`;
    div.textContent = value == null ? "—" : value;
    return div;
  }

  function makeArrowCell(value, result) {
    const div = document.createElement("div");
    div.className = `cell result-cell ${resultClass(result)} ${arrowClass(result)}`;
    div.textContent = value == null ? "—" : value;
    return div;
  }

  function makeTraitsCell(shared) {
    const div = document.createElement("div");
    div.className = "cell traits-col";
    if (!shared || shared.length === 0) {
      div.innerHTML = `<span class="trait-none">No shared traits</span>`;
    } else {
      div.innerHTML = shared.map((t) => `<span class="trait-chip">${escapeHtml(t)}</span>`).join("");
    }
    return div;
  }

  function showEndPanel(won, reveal, guessesUsed) {
    els.endPanel.hidden = false;
    const card = els.endCard;
    card.className = `end-card ${won ? "win" : "lose"}`;

    const shareBtn = state.mode === "daily" ? `<button class="btn btn-secondary" id="shareBtn">Share result</button>` : "";
    const nextBtn = state.mode === "unlimited" ? `<button class="btn btn-primary" id="playAgainBtn">Play again</button>` : "";

    card.innerHTML = `
      <h2>${won ? "Full time — you got it!" : "Full time — out of guesses"}</h2>
      <p>${won ? `Found in ${guessesUsed} guess${guessesUsed === 1 ? "" : "es"}.` : "Better luck next time."}</p>
      <div class="reveal">
        ${reveal.face_url ? `<img src="${reveal.face_url}" alt="" />` : ""}
        <div>
          <div class="reveal-name">${escapeHtml(reveal.long_name || reveal.short_name)}</div>
          <div class="reveal-sub">${escapeHtml(reveal.club_name)} · ${escapeHtml(reveal.nationality_name)} · ${escapeHtml(reveal.primary_position)} · OVR ${reveal.overall}</div>
        </div>
      </div>
      <div class="end-actions">${nextBtn}${shareBtn}</div>
    `;

    const playAgain = document.getElementById("playAgainBtn");
    if (playAgain) playAgain.addEventListener("click", () => startNewUnlimited());

    const share = document.getElementById("shareBtn");
    if (share) share.addEventListener("click", () => shareResult(won, guessesUsed));

    els.endPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function startNewUnlimited() {
    localStorage.removeItem(tokenStorageKey("unlimited"));
    await startOrResume("unlimited");
  }

  function shareResult(won, guessesUsed) {
    const grid = state.history
      .slice()
      .reverse()
      .map((fb) => {
        const cells = [fb.nationality.result, fb.league.result, fb.club.result, fb.position.result];
        return cells.map((r) => (r === "green" ? "🟩" : r === "yellow" ? "🟨" : "⬜")).join("");
      })
      .join("\n");
    const text = `Footle ${state.dateKey} — ${won ? `${guessesUsed}/8` : "X/8"}\n${grid}`;
    if (navigator.share) {
      navigator.share({ text }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setStatus("Result copied to clipboard!");
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // -------------------------------------------------------------------
  // Autocomplete
  // -------------------------------------------------------------------
  let searchTimer = null;
  let activeIndex = -1;
  let currentResults = [];

  els.guessInput.addEventListener("input", () => {
    const q = els.guessInput.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) {
      hideSuggestions();
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 180);
  });

  els.guessInput.addEventListener("keydown", (e) => {
    if (els.suggestions.hidden) return;
    const items = els.suggestions.querySelectorAll(".suggestion-item:not(.disabled)");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      highlightActive(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      highlightActive(items);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // If nothing's been arrowed to yet, Enter picks the top match —
      // matches how most people actually use the search box.
      const target = activeIndex >= 0 ? items[activeIndex] : items[0];
      if (target) target.click();
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });

  function highlightActive(items) {
    items.forEach((el, i) => el.classList.toggle("active", i === activeIndex));
    if (items[activeIndex]) items[activeIndex].scrollIntoView({ block: "nearest" });
  }

  async function runSearch(q) {
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
      currentResults = data.results || [];
      renderSuggestions(currentResults);
    } catch {
      hideSuggestions();
    }
  }

  function renderSuggestions(results) {
    activeIndex = -1;
    if (results.length === 0) {
      els.suggestions.innerHTML = `<div class="suggestion-empty">No players found</div>`;
      els.suggestions.hidden = false;
      return;
    }
    els.suggestions.innerHTML = results
      .map((p) => {
        const already = state.guessedIds.has(p.id);
        return `
        <div class="suggestion-item ${already ? "disabled" : ""}" data-id="${p.id}">
          ${p.face_url ? `<img src="${p.face_url}" alt="" loading="lazy" />` : ""}
          <div>
            <div class="suggestion-name">${escapeHtml(p.short_name)}${already ? " (already guessed)" : ""}</div>
            <div class="suggestion-sub">${escapeHtml(p.club_name)} · ${escapeHtml(p.nationality_name)}</div>
          </div>
        </div>`;
      })
      .join("");
    els.suggestions.hidden = false;

    els.suggestions.querySelectorAll(".suggestion-item:not(.disabled)").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.getAttribute("data-id");
        hideSuggestions();
        els.guessInput.value = "";
        submitGuess(id);
      });
    });
  }

  function hideSuggestions() {
    els.suggestions.hidden = true;
    els.suggestions.innerHTML = "";
    activeIndex = -1;
  }

  document.addEventListener("click", (e) => {
    if (!els.suggestions.contains(e.target) && e.target !== els.guessInput) hideSuggestions();
  });

  // -------------------------------------------------------------------
  // Mode tabs
  // -------------------------------------------------------------------
  els.modeTabs.forEach((tab) => {
    tab.addEventListener("click", async () => {
      if (tab.classList.contains("active")) return;
      els.modeTabs.forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      try {
        await startOrResume(tab.dataset.mode);
      } catch (err) {
        setStatus(err.message);
      }
    });
  });

  // -------------------------------------------------------------------
  // Modals
  // -------------------------------------------------------------------
  let lastFocused = null;

  function openModal(overlay, trigger) {
    lastFocused = trigger || document.activeElement;
    overlay.hidden = false;
    const closeBtn = overlay.querySelector(".modal-close");
    if (closeBtn) closeBtn.focus();
  }
  function closeModal(overlay) {
    if (overlay.hidden) return;
    overlay.hidden = true;
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

  els.howToBtn.addEventListener("click", (e) => openModal(els.howToOverlay, e.currentTarget));
  els.statsBtn.addEventListener("click", (e) => {
    renderStats();
    openModal(els.statsOverlay, e.currentTarget);
  });
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", (e) => closeModal(e.target.closest(".modal-overlay")));
  });
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal(overlay);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal-overlay:not([hidden])").forEach(closeModal);
    }
  });

  // Show "How to play" automatically the very first time someone opens the
  // game, same idea as Wordle's first-run tutorial. Never shown again after
  // that, and Statistics never auto-opens — nothing worth showing yet on a
  // first visit.
  if (!localStorage.getItem(LS_SEEN_HOWTO)) {
    openModal(els.howToOverlay, els.howToBtn);
    localStorage.setItem(LS_SEEN_HOWTO, "1");
  }

  function renderStats() {
    const s = loadStats();
    const winPct = s.played > 0 ? Math.round((s.won / s.played) * 100) : 0;
    els.statsGrid.innerHTML = `
      ${statBox(s.played, "Played")}
      ${statBox(winPct + "%", "Win rate")}
      ${statBox(s.currentStreak, "Streak")}
      ${statBox(s.maxStreak, "Max streak")}
      ${statBox(s.won, "Wins")}
      ${statBox(avgGuesses(s), "Avg guesses")}
    `;
    const max = Math.max(1, ...s.distribution);
    els.distChart.innerHTML = s.distribution
      .map((count, i) => {
        const pct = Math.round((count / max) * 100);
        return `
        <div class="dist-row">
          <span class="dist-label">${i + 1}</span>
          <div class="dist-bar-wrap"><div class="dist-bar" style="width:${count > 0 ? Math.max(pct, 10) : 0}%">${count > 0 ? count : ""}</div></div>
        </div>`;
      })
      .join("");
  }

  function avgGuesses(s) {
    const totalGuesses = s.distribution.reduce((sum, count, i) => sum + count * (i + 1), 0);
    if (s.won === 0) return "—";
    return (totalGuesses / s.won).toFixed(1);
  }

  function statBox(num, label) {
    return `<div class="stat-box"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
  }

  // -------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------
  startOrResume("daily").catch((err) => setStatus(err.message));
})();
