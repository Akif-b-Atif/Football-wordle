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
    result: null, // { won, reveal, guessesUsed } once the game is over
    endTimer: null,
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
    statsMode: document.getElementById("statsMode"),
    resultOverlay: document.getElementById("resultOverlay"),
    resultTitle: document.getElementById("resultTitle"),
    resultReveal: document.getElementById("resultReveal"),
    shareText: document.getElementById("shareText"),
    copyBtn: document.getElementById("copyBtn"),
    copyStatus: document.getElementById("copyStatus"),
    resultStatsTitle: document.getElementById("resultStatsTitle"),
    resultStatsGrid: document.getElementById("resultStatsGrid"),
    resultDistChart: document.getElementById("resultDistChart"),
  };

  // -------------------------------------------------------------------
  // Local storage keys
  // -------------------------------------------------------------------
  const LS_TOKEN_PREFIX = "fw_token_"; // + mode (+ dateKey for daily)
  const LS_STATS = { daily: "fw_stats_v1", unlimited: "fw_stats_unlimited_v1" };
  const LS_SEEN_HOWTO = "fw_seen_howto_v2"; // bumped when the rules changed (yellow nation/club, new columns)

  function todayKeyLocalGuessFallback() {
    return new Date().toISOString().slice(0, 10);
  }

  function tokenStorageKey(mode) {
    if (mode === "daily") return `${LS_TOKEN_PREFIX}daily_${todayKeyLocalGuessFallback()}`;
    return `${LS_TOKEN_PREFIX}unlimited_active`;
  }

  function loadStats(mode) {
    try {
      return JSON.parse(localStorage.getItem(LS_STATS[mode])) || defaultStats();
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
  function saveStats(mode, s) {
    localStorage.setItem(LS_STATS[mode], JSON.stringify(s));
  }

  // Daily Challenge and Unlimited each keep their own stats, so the numbers in
  // the game-over popup always include the game you just finished.
  function recordResult({ mode, dateKey, won, guessesUsed }) {
    const s = loadStats(mode);
    if (mode === "daily" && s.lastDailyDateKey === dateKey) return; // already recorded today
    s.played += 1;
    if (won) {
      s.won += 1;
      s.currentStreak += 1;
      s.maxStreak = Math.max(s.maxStreak, s.currentStreak);
      s.distribution[guessesUsed - 1] += 1;
    } else {
      s.currentStreak = 0;
    }
    if (mode === "daily") s.lastDailyDateKey = dateKey;
    saveStats(mode, s);
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
    state.result = null;
    clearTimeout(state.endTimer);
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
        showEndPanel(data.won, data.reveal, data.guessesUsed, { autoOpenResult: true });
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
    return "gray";
  }

  // Plain-English meaning of each cell. Shown as a hover tooltip and read out
  // by screen readers, so the colours are never the only way to get the clue.
  // Keep the thresholds in sync with CLOSE_BY in server.js and "How to play".
  const DESCRIBE = {
    nationality: {
      green: "same country",
      yellow: "different country, same continent",
      gray: "different continent",
    },
    club: {
      green: "same club",
      yellow: "different club, same league",
      gray: "different league",
    },
    position: {
      green: "same position",
      yellow: "different position, same group",
      gray: "different position group",
    },
  };
  const CLOSE_TEXT = { age: "within 2 years", overall: "within 2 rating points", height: "within 3 cm" };

  function describeNumeric(kind, fb) {
    if (fb.result === "green") return "exact match";
    const closeness = fb.result === "yellow" ? `close, ${CLOSE_TEXT[kind]}` : "not close";
    return `${closeness}; the answer is ${fb.arrow === "up" ? "higher" : "lower"}`;
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
      ${faceImg(fb.guessedPlayer.face_url, fb.guessedPlayer.id, fb.guessedPlayer.short_name)}
      <span>${escapeHtml(fb.guessedPlayer.short_name)}</span>
    `;
    row.appendChild(playerCell);

    row.appendChild(
      makeResultCell(fb.nationality.value, fb.nationality.result, DESCRIBE.nationality[fb.nationality.result], fb.nationality.continent)
    );
    row.appendChild(makeResultCell(fb.club.value, fb.club.result, DESCRIBE.club[fb.club.result], fb.club.league));
    row.appendChild(makeResultCell(fb.position.value, fb.position.result, DESCRIBE.position[fb.position.result]));
    row.appendChild(makeArrowCell(fb.age, describeNumeric("age", fb.age)));
    row.appendChild(makeArrowCell(fb.overall, describeNumeric("overall", fb.overall)));
    row.appendChild(makeArrowCell(fb.height, describeNumeric("height", fb.height)));
    row.appendChild(makeTraitsCell(fb.traits.shared));

    els.resultsBody.prepend(row); // most recent guess on top
  }

  // `sub` is a small context line under the value (continent under a nation,
  // league under a club) so you can see *why* a cell is yellow.
  function makeResultCell(value, result, description, sub) {
    const div = document.createElement("div");
    div.className = `cell result-cell ${resultClass(result)}${sub ? " stacked" : ""}`;
    div.title = description;

    const main = document.createElement("span");
    main.textContent = value == null ? "—" : value;
    div.appendChild(main);

    if (sub) {
      const subEl = document.createElement("span");
      subEl.className = "cell-sub";
      subEl.textContent = sub;
      div.appendChild(subEl);
    }

    const sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = `: ${description}`;
    div.appendChild(sr);
    return div;
  }

  // fb = { value, result: green|yellow|gray, arrow: up|down|null }
  function makeArrowCell(fb, description) {
    const div = document.createElement("div");
    const arrowCls = fb.arrow ? ` arrow-${fb.arrow}` : "";
    div.className = `cell result-cell ${resultClass(fb.result)}${arrowCls}`;
    div.title = description;
    div.textContent = fb.value == null ? "—" : fb.value;

    const sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = `: ${description}`;
    div.appendChild(sr);
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

  function showEndPanel(won, reveal, guessesUsed, { autoOpenResult = false } = {}) {
    state.result = { won, reveal, guessesUsed };
    els.endPanel.hidden = false;
    const card = els.endCard;
    card.className = `end-card ${won ? "win" : "lose"}`;

    const nextBtn = state.mode === "unlimited" ? `<button class="btn btn-primary" id="playAgainBtn">Play again</button>` : "";

    card.innerHTML = `
      <h2>${won ? "Full time — you got it!" : "Full time — out of guesses"}</h2>
      <p>${won ? `Found in ${guessesUsed} guess${guessesUsed === 1 ? "" : "es"}.` : "Better luck next time."}</p>
      <div class="reveal">
        ${revealHtml(reveal)}
      </div>
      <div class="end-actions">${nextBtn}<button class="btn btn-secondary" id="viewResultBtn">Share &amp; stats</button></div>
    `;

    const playAgain = document.getElementById("playAgainBtn");
    if (playAgain) playAgain.addEventListener("click", () => startNewUnlimited());

    const viewBtn = document.getElementById("viewResultBtn");
    viewBtn.addEventListener("click", () => openResultModal(viewBtn));

    els.endPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });

    // Pop the result up right after a game finishes (not when resuming an
    // already-finished game on page load). The short delay lets you see the
    // last row land first.
    if (autoOpenResult) {
      const result = state.result;
      clearTimeout(state.endTimer);
      state.endTimer = setTimeout(() => {
        if (state.result === result) openResultModal(viewBtn);
      }, 900);
    }
  }

  function revealHtml(reveal) {
    return `
        ${faceImg(reveal.face_url, reveal.id, reveal.short_name)}
        <div>
          <div class="reveal-name">${escapeHtml(reveal.long_name || reveal.short_name)}</div>
          <div class="reveal-sub">${escapeHtml(reveal.club_name)} · ${escapeHtml(reveal.nationality_name)} · ${escapeHtml(reveal.primary_position)} · OVR ${reveal.overall}</div>
        </div>`;
  }

  async function startNewUnlimited() {
    localStorage.removeItem(tokenStorageKey("unlimited"));
    await startOrResume("unlimited");
  }

  // Day #1 of the Daily Challenge; puzzle numbers count up from here.
  // Change this if you launched on a different date.
  const LAUNCH_UTC = Date.UTC(2026, 6, 31); // 31 Jul 2026

  function puzzleNumber(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    return Math.max(1, Math.floor((Date.UTC(y, m - 1, d) - LAUNCH_UTC) / 86400000) + 1);
  }

  // Wordle-style, spoiler-free summary: only the colours of each guess, never
  // who you guessed or who the answer was.
  //
  //   Footle #12 3/8
  //
  //   🟨⬛⬛⬛🟨🟨
  //   🟩🟨🟨🟨🟩⬛
  //   🟩🟩🟩🟩🟩🟩
  function buildShareText() {
    const { won, guessesUsed } = state.result;
    const square = (r) => (r === "green" ? "🟩" : r === "yellow" ? "🟨" : "⬛");
    // state.history is oldest-first, so rows read in the order you guessed.
    const grid = state.history
      .map((fb) =>
        [fb.nationality, fb.club, fb.position, fb.age, fb.overall, fb.height].map((c) => square(c.result)).join("")
      )
      .join("\n");
    const name =
      state.mode === "daily" && state.dateKey
        ? `Footle #${puzzleNumber(state.dateKey).toLocaleString("en-US")}`
        : "Footle Unlimited";
    const link = /^https?:/.test(location.origin) ? `\n\n${location.origin}` : "";
    return `${name} ${won ? guessesUsed : "X"}/${state.maxGuesses}\n\n${grid}${link}`;
  }

  // Game-over popup: the answer, the shareable emoji grid, and your stats
  // (which already include the game you just finished).
  function openResultModal(trigger) {
    const r = state.result;
    if (!r) return;
    els.resultTitle.textContent = r.won ? "Full time — you got it!" : "Full time — out of guesses";
    els.resultReveal.innerHTML = revealHtml(r.reveal);
    els.shareText.textContent = buildShareText();
    els.copyBtn.textContent = "Copy result";
    els.copyStatus.textContent = "";
    els.resultStatsTitle.textContent = `Statistics — ${state.mode === "daily" ? "Daily Challenge" : "Unlimited"}`;
    renderStats(state.mode, els.resultStatsGrid, els.resultDistChart, r.won ? r.guessesUsed : null);
    openModal(els.resultOverlay, trigger);
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Older browsers / non-secure pages: fall back to a hidden textarea.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {}
      ta.remove();
      return ok;
    }
  }

  els.copyBtn.addEventListener("click", async () => {
    const ok = await copyToClipboard(els.shareText.textContent);
    if (ok) {
      els.copyBtn.textContent = "Copied!";
      els.copyStatus.textContent = "Result copied to clipboard.";
      setTimeout(() => {
        els.copyBtn.textContent = "Copy result";
      }, 2000);
    } else {
      // Last resort: select the text so it can be copied by hand.
      const range = document.createRange();
      range.selectNodeContents(els.shareText);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      els.copyStatus.textContent = "Couldn't copy automatically. The text is selected, so copy it manually.";
    }
  });

  // Player photos, with a three-step fallback so a failing image host never
  // leaves a blank grey circle:
  //   1. load straight from the CDN, sending no referrer (defeats simple
  //      hotlink protection that rejects requests coming from other sites)
  //   2. if that fails, ask our own server (/api/face/:id) to fetch it
  //   3. if that fails too, show an initials badge
  function faceImg(url, id, name) {
    if (!url) return initialsBadge(name);
    return `<img src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-face-id="${escapeHtml(id)}" data-name="${escapeHtml(name)}" />`;
  }

  function initialsOf(name) {
    const parts = String(name || "").replace(/[.\-']/g, " ").split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function initialsBadge(name) {
    return `<span class="face-fallback" aria-hidden="true">${escapeHtml(initialsOf(name))}</span>`;
  }

  // <img> error events don't bubble, so listen in the capture phase.
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.dataset.faceId) return;
      if (!img.dataset.proxied) {
        img.dataset.proxied = "1";
        img.removeAttribute("referrerpolicy");
        img.src = `/api/face/${encodeURIComponent(img.dataset.faceId)}`;
        return;
      }
      img.outerHTML = initialsBadge(img.dataset.name);
    },
    true
  );

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
          ${faceImg(p.face_url, p.id, p.short_name)}
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
    els.statsMode.textContent = state.mode === "daily" ? "Daily Challenge" : "Unlimited mode";
    renderStats(state.mode, els.statsGrid, els.distChart);
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

  // Fills a stats grid + guess-distribution chart. `highlight` is the number
  // of guesses of the game just won, so its bar can be coloured.
  function renderStats(mode, gridEl, distEl, highlight = null) {
    const s = loadStats(mode);
    const winPct = s.played > 0 ? Math.round((s.won / s.played) * 100) : 0;
    gridEl.innerHTML = `
      ${statBox(s.played, "Played")}
      ${statBox(winPct + "%", "Win rate")}
      ${statBox(s.currentStreak, "Streak")}
      ${statBox(s.maxStreak, "Max streak")}
      ${statBox(s.won, "Wins")}
      ${statBox(avgGuesses(s), "Avg guesses")}
    `;
    const max = Math.max(1, ...s.distribution);
    distEl.innerHTML = s.distribution
      .map((count, i) => {
        const pct = Math.round((count / max) * 100);
        const current = highlight === i + 1 ? " current" : "";
        return `
        <div class="dist-row">
          <span class="dist-label">${i + 1}</span>
          <div class="dist-bar-wrap"><div class="dist-bar${current}" style="width:${count > 0 ? Math.max(pct, 10) : 0}%">${count > 0 ? count : ""}</div></div>
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
