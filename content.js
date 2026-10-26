(() => {
  'use strict';

  const PER_PAGE = 50;
  const MAX_PAGES = 200; // osu! search returns nothing past 10,000 results
  const ROOT_ID = 'osp-root';
  const ACTIVE_CLASS = 'osp-active';
  const CACHE_SIZE = 30;
  const PAGES_KEY = 'osp:lastPages';
  const PAGES_KEPT = 50;
  const FIRST_YEAR = 2007;

  const cache = new Map(); // api url -> response json
  const audio = new Audio();
  let root = null;
  let shown = null; // "query|page" currently shown or loading
  let requestId = 0;
  let playingId = null;
  let picker = null;
  let pickerField = null; // date field the open picker edits
  let dateRanges = {}; // field -> { from, to } as inclusive "YYYY-MM-DD" days

  // osu!'s star rating colour spectrum
  const DIFF_STOPS = [
    [0.1, '#4290fb'], [1.25, '#4fc0ff'], [2, '#4fffd5'], [2.5, '#7cff4f'],
    [3.3, '#f6f05c'], [4.2, '#ff8068'], [4.9, '#ff4e6f'], [5.8, '#c645b8'],
    [6.7, '#6563de'], [7.7, '#18158e'], [9, '#000000'],
  ];
  const MODE_ORDER = { osu: 0, taiko: 1, fruits: 2, mania: 3 };
  const DATE_FIELDS = { ranked: 'Ranked', created: 'Submitted', updated: 'Updated' };
  const DATE_TOKEN = /^(ranked|created|submitted|updated)(>=|<=|==|!=|>|<|=|:)(\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?)$/i;

  const isListing = () => location.pathname.replace(/\/$/, '') === '/beatmapsets';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const fmt = (n) => Number(n || 0).toLocaleString();

  function diffColour(stars) {
    if (stars < DIFF_STOPS[0][0]) return '#aaaaaa';
    for (let i = 1; i < DIFF_STOPS.length; i++) {
      const [x1, c1] = DIFF_STOPS[i];
      if (stars > x1) continue;
      const [x0, c0] = DIFF_STOPS[i - 1];
      const t = (stars - x0) / (x1 - x0);
      const a = parseInt(c0.slice(1), 16);
      const b = parseInt(c1.slice(1), 16);
      const mix = (shift) => Math.round(((a >> shift) & 255) + (((b >> shift) & 255) - ((a >> shift) & 255)) * t);
      return `rgb(${mix(16)}, ${mix(8)}, ${mix(0)})`;
    }
    return '#000000';
  }

  // --- Remembered pages ---------------------------------------------------

  function readPages() {
    try {
      return JSON.parse(localStorage.getItem(PAGES_KEY)) || {};
    } catch {
      return {};
    }
  }

  function rememberPage(query, page) {
    const all = readPages();
    all[query] = { page, t: Date.now() };
    const kept = Object.entries(all).sort((a, b) => b[1].t - a[1].t).slice(0, PAGES_KEPT);
    try {
      localStorage.setItem(PAGES_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch {
      // storage full or blocked; pages just won't be remembered
    }
  }

  const rememberedPage = (query) => readPages()[query]?.page || 1;

  // --- URL ----------------------------------------------------------------

  function currentParams() {
    const params = new URLSearchParams(location.search);
    const hasPage = params.has('page');
    const page = Math.max(1, parseInt(params.get('page'), 10) || 1);
    params.delete('page');
    return { query: params.toString(), page, hasPage };
  }

  function apiUrl(query, page) {
    const params = new URLSearchParams(query);
    if (page > 1) params.set('page', page);
    const qs = params.toString();
    return '/beatmapsets/search' + (qs ? '?' + qs : '');
  }

  function replaceUrl(mutate) {
    const url = new URL(location.href);
    mutate(url.searchParams);
    // Keep Turbo's history state so Back from a beatmap restores this exact page.
    history.replaceState(history.state, '', url);
  }

  function goTo(page) {
    replaceUrl((p) => p.set('page', page));
    tick();
    const top = root.getBoundingClientRect().top + window.scrollY - 70;
    if (window.scrollY > top) window.scrollTo({ top });
  }

  // --- Date filter --------------------------------------------------------

  const normaliseField = (f) => (f.toLowerCase() === 'submitted' ? 'created' : f.toLowerCase());

  // First and last day of the period a search value names: "2010", "2010-8" or "2010-08-15".
  function periodBounds(value) {
    const [y, m, d] = value.split('-').map(Number);
    if (d) return [OspDate.ymd(y, m - 1, d), OspDate.ymd(y, m - 1, d)];
    if (m) return [OspDate.ymd(y, m - 1, 1), OspDate.ymd(y, m, 0)];
    return [OspDate.ymd(y, 0, 1), OspDate.ymd(y, 11, 31)];
  }

  // Reads each date field's range out of a search query as inclusive days.
  function parseDates(q) {
    const ranges = {};
    for (const field of Object.keys(DATE_FIELDS)) ranges[field] = { from: '', to: '' };
    for (const token of q.split(/\s+/)) {
      const match = DATE_TOKEN.exec(token);
      if (!match) continue;
      const range = ranges[normaliseField(match[1])];
      const [, , op, value] = match;
      const [first, last] = periodBounds(value);
      if (op === '>=') range.from = first;
      else if (op === '>') range.from = OspDate.addDays(last, 1);
      else if (op === '<=') range.to = last;
      else if (op === '<') range.to = OspDate.addDays(first, -1);
      else if (op !== '!=') [range.from, range.to] = [first, last];
    }
    return ranges;
  }

  function buildQuery(q, ranges) {
    const tokens = q.split(/\s+/).filter((token) => token && !DATE_TOKEN.test(token));
    for (const [field, { from, to }] of Object.entries(ranges)) {
      if (from) tokens.push(`${field}>=${from}`);
      // "<" the next day is inclusive of `to` however osu! reads "<=" on a day.
      if (to) tokens.push(`${field}<${OspDate.addDays(to, 1)}`);
    }
    return tokens.join(' ');
  }

  function setSearchQuery(q) {
    const sameQuery = () => (new URLSearchParams(location.search).get('q') || '').trim() === q;
    const input = document.querySelector('.beatmapsets-search__input');
    const usable = input && !input.disabled;
    if (usable) {
      // Let osu!'s own search box drive the change so its filter state stays in sync.
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setTimeout(() => {
      if (sameQuery()) return;
      replaceUrl((p) => {
        if (q) p.set('q', q);
        else p.delete('q');
        p.delete('page');
      });
      tick();
    }, usable ? 1500 : 0);
  }

  function applyDates() {
    const q = (new URLSearchParams(location.search).get('q') || '').trim();
    const next = buildQuery(q, dateRanges);
    if (next !== q) setSearchQuery(next);
  }

  function rangeLabel({ from, to }) {
    if (from && to) return from === to ? OspDate.format(from) : `${OspDate.format(from)} – ${OspDate.format(to)}`;
    if (from) return `since ${OspDate.format(from)}`;
    if (to) return `until ${OspDate.format(to)}`;
    return 'any time';
  }

  function renderDateChips() {
    root.querySelectorAll('.osp-dates__chip').forEach((chip) => {
      const range = dateRanges[chip.dataset.field];
      chip.classList.toggle('osp-dates__chip--set', Boolean(range.from || range.to));
      chip.querySelector('.osp-dates__value').textContent = rangeLabel(range);
    });
  }

  function syncDates(query) {
    if (picker.isOpen) return;
    dateRanges = parseDates(new URLSearchParams(query).get('q') || '');
    renderDateChips();
  }

  function datesHtml() {
    const chips = Object.entries(DATE_FIELDS).map(([field, label]) => `
      <button type="button" class="osp-dates__chip" data-field="${field}">
        <span class="osp-dates__label">${label}</span>
        <span class="osp-dates__value">any time</span>
        <span class="osp-dates__caret">▾</span>
      </button>`).join('');
    return `
      <div class="osp-dates">
        ${chips}
        <button type="button" class="osp-dates__clear">Clear dates</button>
      </div>`;
  }

  // --- Rendering ----------------------------------------------------------

  function buildRoot() {
    const el = document.createElement('div');
    el.id = ROOT_ID;
    el.innerHTML = `
      ${datesHtml()}
      <div class="osp-notice" hidden></div>
      <nav class="osp-pager"></nav>
      <div class="osp-grid"></div>
      <div class="osp-status" hidden></div>
      <nav class="osp-pager"></nav>`;

    el.addEventListener('click', (e) => {
      const pageBtn = e.target.closest('[data-page]');
      if (pageBtn && !pageBtn.disabled) {
        goTo(Number(pageBtn.dataset.page));
        return;
      }
      const cover = e.target.closest('.osp-card__cover');
      if (cover) togglePreview(cover);
      if (e.target.closest('.osp-retry')) {
        shown = null;
        tick();
      }
      const chip = e.target.closest('.osp-dates__chip');
      if (chip) {
        const reopen = !(picker.isOpen && pickerField === chip.dataset.field);
        picker.close(true);
        if (reopen) {
          pickerField = chip.dataset.field;
          picker.open(chip, dateRanges[pickerField]);
        }
      }
      if (e.target.closest('.osp-dates__clear')) {
        picker.close(false);
        for (const field of Object.keys(dateRanges)) dateRanges[field] = { from: '', to: '' };
        renderDateChips();
        applyDates();
      }
    });

    picker = new DateRangePicker({
      minYear: FIRST_YEAR,
      onCommit: (range) => {
        dateRanges[pickerField] = range;
        renderDateChips();
        applyDates();
      },
    });
    el.querySelector('.osp-dates').append(picker.el);

    el.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = e.target.querySelector('input');
      const page = Math.min(Number(input.max), Math.max(1, parseInt(input.value, 10) || 1));
      goTo(page);
    });

    audio.addEventListener('ended', stopPreview);
    audio.addEventListener('timeupdate', () => {
      const bar = root?.querySelector('.osp-card__cover--playing .osp-card__progress');
      if (bar && audio.duration) bar.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
    });
    return el;
  }

  function mount() {
    const anchor = document.querySelector('.beatmapsets')?.closest('.js-react');
    if (!anchor) return false;
    // Turbo page snapshots can contain a stale copy of the root.
    document.querySelectorAll('#' + ROOT_ID).forEach((el) => { if (el !== root) el.remove(); });
    if (!root) root = buildRoot();
    if (anchor.nextElementSibling !== root) anchor.after(root);
    document.documentElement.classList.add(ACTIVE_CLASS);
    return true;
  }

  function setStatus(html) {
    const status = root.querySelector('.osp-status');
    status.hidden = !html;
    status.innerHTML = html || '';
  }

  async function load(query, page) {
    shown = query + '|' + page;
    const id = ++requestId;
    const url = apiUrl(query, page);
    root.classList.add('osp-loading');

    let data = cache.get(url);
    if (!data) {
      try {
        const res = await fetch(url, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
        cache.set(url, data);
        if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
      } catch (err) {
        if (id !== requestId) return;
        root.classList.remove('osp-loading');
        setStatus(`Couldn't load page ${page} (${esc(err.message)}). <button type="button" class="osp-retry">Retry</button>`);
        return;
      }
    }
    if (id !== requestId) return;
    root.classList.remove('osp-loading');
    draw(data, query, page);
  }

  function draw(data, query, page) {
    const sets = data.beatmapsets || [];
    const totalPages = Math.max(1, Math.min(MAX_PAGES, Math.ceil((data.total || 0) / PER_PAGE)));

    const notices = [];
    const wantedSort = new URLSearchParams(query).get('sort');
    if (wantedSort && data.search?.sort && data.search.sort !== wantedSort) {
      notices.push(`osu! ignored the "${esc(wantedSort)}" sort and used "${esc(data.search.sort)}" instead. Sorting and most filters need you to be signed in.`);
    }
    if (data.error) notices.push(esc(data.error));
    // With a page param osu! reports total capped at exactly 10,000.
    if (page === MAX_PAGES && (data.total || 0) >= MAX_PAGES * PER_PAGE) {
      notices.push(`osu! only lets search go ${MAX_PAGES} pages deep (${fmt(MAX_PAGES * PER_PAGE)} maps). Narrow the filters to see more.`);
    }
    const notice = root.querySelector('.osp-notice');
    notice.hidden = !notices.length;
    notice.innerHTML = notices.map((n) => `<p>${n}</p>`).join('');

    root.querySelector('.osp-grid').innerHTML = sets.map(card).join('');
    setStatus(sets.length ? '' : (page > 1 ? `Page ${page} is empty.` : 'No beatmaps found.'));

    const pager = pagerHtml(page, totalPages);
    root.querySelectorAll('.osp-pager').forEach((nav) => { nav.innerHTML = pager; });
  }

  function pagerHtml(page, total) {
    const btn = (p, label, extra = '') => {
      const current = p === page && !extra;
      return `<button type="button" class="osp-pager__btn${current ? ' osp-pager__btn--current' : ''}"
        data-page="${p}" ${p < 1 || p > total || current ? 'disabled' : ''} ${extra}>${label}</button>`;
    };

    const pages = new Set([1, total]);
    for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= total) pages.add(p);
    const sorted = [...pages].sort((a, b) => a - b);

    let numbers = '';
    sorted.forEach((p, i) => {
      if (i > 0 && p - sorted[i - 1] > 1) numbers += '<span class="osp-pager__gap">…</span>';
      numbers += btn(p, p);
    });

    return `
      ${btn(page - 1, '‹ Prev', 'aria-label="Previous page"')}
      ${numbers}
      ${btn(page + 1, 'Next ›', 'aria-label="Next page"')}
      <form class="osp-pager__jump">
        <input type="number" min="1" max="${total}" value="${page}" aria-label="Page number">
        <button type="submit" class="osp-pager__btn">Go</button>
        <span class="osp-pager__count">of ${total}</span>
      </form>`;
  }

  function card(set) {
    const href = `/beatmapsets/${set.id}`;
    const cover = set.covers?.['list@2x'] || set.covers?.list || '';
    const diffs = [...(set.beatmaps || [])].sort((a, b) =>
      (MODE_ORDER[a.mode] - MODE_ORDER[b.mode]) || (a.difficulty_rating - b.difficulty_rating));
    const shownDiffs = diffs.slice(0, 16);
    const dots = shownDiffs.map((b) => `<span class="osp-dot" style="background:${diffColour(b.difficulty_rating)}"
      title="${esc(b.version)} — ${b.difficulty_rating.toFixed(2)}★ (${esc(b.mode)})"></span>`).join('');
    const more = diffs.length > shownDiffs.length ? `<span class="osp-more">+${diffs.length - shownDiffs.length}</span>` : '';
    const playing = playingId === set.id;

    return `
      <div class="osp-card">
        <button type="button" class="osp-card__cover${playing ? ' osp-card__cover--playing' : ''}"
          data-set="${set.id}" data-src="${esc(set.preview_url)}" title="Play preview"
          style="background-image:url('${esc(cover)}')">
          <span class="osp-card__play">${playing ? '■' : '▶'}</span>
          <span class="osp-status-badge osp-status-badge--${esc(set.status)}">${esc(set.status)}</span>
          <span class="osp-card__progress"></span>
        </button>
        <div class="osp-card__body">
          <a class="osp-card__title" href="${href}" title="${esc(set.title)}">${esc(set.title)}</a>
          <div class="osp-card__artist" title="${esc(set.artist)}">by ${esc(set.artist)}</div>
          <div class="osp-card__mapper">mapped by <a href="/users/${set.user_id}">${esc(set.creator)}</a></div>
          <div class="osp-card__stats">
            <span title="Favourites">♥ ${fmt(set.favourite_count)}</span>
            <span title="Play count">▶ ${fmt(set.play_count)}</span>
            ${set.video ? '<span title="Has video">🎞</span>' : ''}
          </div>
          <div class="osp-card__diffs">${dots}${more}</div>
        </div>
        <div class="osp-card__actions">
          <a class="osp-card__download" href="${href}/download" data-turbo="false" title="Download">⭳</a>
        </div>
      </div>`;
  }

  function togglePreview(cover) {
    const id = Number(cover.dataset.set);
    const wasPlaying = playingId === id;
    stopPreview();
    if (wasPlaying) return;
    audio.src = new URL(cover.dataset.src, location.href).href;
    audio.volume = 0.5;
    audio.play().catch(stopPreview);
    playingId = id;
    cover.classList.add('osp-card__cover--playing');
    cover.querySelector('.osp-card__play').textContent = '■';
  }

  function stopPreview() {
    audio.pause();
    playingId = null;
    root?.querySelectorAll('.osp-card__cover--playing').forEach((cover) => {
      cover.classList.remove('osp-card__cover--playing');
      cover.querySelector('.osp-card__play').textContent = '▶';
      cover.querySelector('.osp-card__progress').style.width = '';
    });
  }

  function tick() {
    if (!isListing()) {
      document.documentElement.classList.remove(ACTIVE_CLASS);
      if (playingId) stopPreview();
      picker?.close(false);
      shown = null;
      return;
    }
    if (!mount()) return;
    let { query, page, hasPage } = currentParams();
    if (!hasPage) {
      // Fresh visit or osu! changed the filters: go back to where this search was left.
      page = rememberedPage(query);
      replaceUrl((p) => p.set('page', page));
    }
    if (query + '|' + page === shown) return;
    rememberPage(query, page);
    syncDates(query);
    load(query, page);
  }

  document.addEventListener('turbo:load', tick);
  window.addEventListener('popstate', () => setTimeout(tick));
  // osu! rewrites the URL itself when filters change, so poll for that.
  setInterval(tick, 300);
  tick();
})();
