'use strict';

// One leaderboard card for every funCentral page, with a Bridge | Regicide | Tai Di switch.
// Each game's rating is its own board; this is just the shared entry point.
window.FunLeaderboard = (() => {
  const GAMES = {
    bridge: { label: 'Bridge', url: '/api/leaderboard', stats: (e) => `${e.wins}W / ${e.gamesPlayed}G` },
    regicide: { label: 'Regicide', url: '/api/regicide/leaderboard', stats: (e) => `${e.bestDefeated}/12 · ${e.gamesPlayed}G` },
    taidi: { label: 'Tai Di', url: '/api/taidi/leaderboard', stats: (e) => `${e.wins}W / ${e.gamesPlayed}G` },
    connect4: { label: 'Connect 4', url: '/api/connect4/leaderboard', stats: (e) => `${e.wins}W / ${e.draws ?? 0}D / ${e.gamesPlayed}G` },
    omok: { label: 'Omok', url: '/api/omok/leaderboard', stats: (e) => `${e.wins}W / ${e.draws ?? 0}D / ${e.gamesPlayed}G` },
  };
  const medals = ['🥇', '🥈', '🥉'];
  const mounts = new WeakMap();
  // On the Regicide page this opens its stats screen in place; elsewhere it navigates there.
  const REGICIDE_FOOTER = '<div class="lb-footer"><a class="btn-link" href="/regicide/?view=stats" onclick="if (window.showStats && location.pathname.startsWith(\'/regicide\')) { event.preventDefault(); showStats(); }">📊 Full stats →</a></div>';
  const TAIDI_FOOTER = '<div class="lb-footer"><a class="btn-link" href="/taidi/?view=stats" onclick="if (window.showStats && location.pathname.startsWith(\'/taidi\')) { event.preventDefault(); showStats(); }">📊 Full stats →</a></div>';
  const CONNECT4_FOOTER = '<div class="lb-footer"><a class="btn-link" href="/connect4/?view=stats" onclick="if (window.showStats && location.pathname.startsWith(\'/connect4\')) { event.preventDefault(); showStats(); }">📊 Full stats →</a></div>';
  const OMOK_FOOTER = '<div class="lb-footer"><a class="btn-link" href="/omok/?view=stats" onclick="if (window.showStats && location.pathname.startsWith(\'/omok\')) { event.preventDefault(); showStats(); }">📊 Full stats →</a></div>';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = () => { try { return localStorage.getItem('authToken'); } catch { return null; } };

  async function fetchBoard(game, query = '') {
    try {
      const t = token();
      const res = await fetch(GAMES[game].url + query, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data?.top) ? data : null;
    } catch { return null; }
  }

  function rows(game, data) {
    if (data?.loading) return `<div class="lb-empty" role="status">Loading ${GAMES[game].label} leaderboard…</div>`;
    if (!data?.top?.length) return `<div class="lb-empty">No rated ${GAMES[game].label} games${data?.seasons?.length > 1 ? ` in ${esc(data.season.name)}` : ''} yet</div>`;
    const row = (e, me) => `<div class="lb-row${me ? ' lb-me' : ''}">
      <span class="lb-rank">${me ? `#${e.rank}` : (medals[e.rank - 1] || `#${e.rank}`)}</span>
      <span class="lb-name">${me ? 'You' : esc(e.displayName)}</span>
      <span class="lb-elo">${e.elo}${e.provisional ? '<span class="lb-provisional" title="Provisional: fewer than 20 rated games this season">P</span>' : ''}</span>
      <span class="lb-stats">${esc(GAMES[game].stats(e))}</span>
    </div>`;
    let html = data.top.map((e) => row(e, false)).join('');
    // The server decides whether this identity is outside the top rows.
    // Display names, ranks and ratings can all be shared by different players.
    if (data.me) html += `<div class="lb-divider"></div>${row(data.me, true)}`;
    return html;
  }

  // Bridge has seasons; offer a switch once more than one has started.
  function seasonSwitch(data) {
    if (!(data?.seasons?.length > 1)) return '';
    const buttons = data.seasons.map((s) =>
      `<button type="button" class="lb-season${s.id === data.season?.id ? ' active' : ''}" data-season="${s.id}" aria-pressed="${s.id === data.season?.id}">${esc(s.name)}${s.current ? '' : ' (final)'}</button>`).join('');
    return `<div class="lb-seasons" role="group" aria-label="Bridge season">${buttons}</div>`;
  }

  /**
   * Renders into `el`. `game` picks the starting tab; `bridgeData` lets Bridge pass what it
   * already fetched; `footer` is optional extra HTML (Bridge's "Full stats" link).
   * Renders nothing when neither board has entries, like Bridge always has.
   */
  async function mount(el, { game = 'bridge', bridgeData, footer = '' } = {}) {
    if (!el) return;
    const revision = {};
    mounts.set(el, revision);
    // Omok is an independent addition: a stalled request must not delay the
    // existing boards or callers waiting for their first render.
    const pendingOmok = fetchBoard('omok');
    const boards = {
      bridge: bridgeData !== undefined ? bridgeData : await fetchBoard('bridge'),
      regicide: await fetchBoard('regicide'),
      taidi: await fetchBoard('taidi'),
      connect4: await fetchBoard('connect4'),
      omok: { top: [], me: null, loading: true },
    };
    let current = game;
    const draw = () => {
      const focused = el.contains(document.activeElement) ? document.activeElement : null;
      const focusGame = focused?.dataset.game;
      const focusSeason = focused?.dataset.season;
      const tabs = Object.entries(GAMES).map(([key, g]) =>
        `<button type="button" class="lb-tab${key === current ? ' active' : ''}" data-game="${key}" aria-pressed="${key === current}">${g.label}</button>`).join('');
      const seasons = current === 'bridge' ? seasonSwitch(boards.bridge) : '';
      const foot = current === 'bridge' ? (footer ? `<div class="lb-footer">${footer}</div>` : '') : current === 'taidi' ? TAIDI_FOOTER : current === 'connect4' ? CONNECT4_FOOTER : current === 'omok' ? OMOK_FOOTER : REGICIDE_FOOTER;
      el.innerHTML = `<div class="lb-card"><div class="lb-header">🏆 Leaderboard</div><div class="lb-tabs" role="group" aria-label="Leaderboard game">${tabs}</div>${seasons}${rows(current, boards[current])}${foot}</div>`;
      for (const b of el.querySelectorAll('.lb-tab')) b.addEventListener('click', () => { current = b.dataset.game; draw(); });
      for (const b of el.querySelectorAll('.lb-season')) {
        b.addEventListener('click', async () => {
          const data = await fetchBoard('bridge', `?season=${encodeURIComponent(b.dataset.season)}`);
          if (data) { boards.bridge = data; refresh(); }
        });
      }
      if (focusGame) el.querySelector(`[data-game="${focusGame}"]`)?.focus({ preventScroll: true });
      else if (focusSeason) el.querySelector(`[data-season="${focusSeason}"]`)?.focus({ preventScroll: true });
    };
    const refresh = () => {
      if (mounts.get(el) !== revision) return;
      // Keep season history reachable even when every current board is empty.
      const hasSeasons = boards.bridge?.seasons?.length > 1;
      if (!hasSeasons && !Object.values(boards).some((b) => b?.top?.length)) { el.innerHTML = ''; return; }
      draw();
    };
    refresh();
    void pendingOmok.then((data) => { boards.omok = data; refresh(); });
  }

  return { mount };
})();
