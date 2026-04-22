'use strict';

let allTracks = [], selectedUris = new Set();
let library = { liked: [], playlists: [] };
let viewMode = 'list';
let darkMode = true;
let currentFiltered = [];
let skipEnrich = false;
let currentAudio = null;
let currentPlayBtn = null;

// ── Helpers ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function cardColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${Math.abs(h) % 360},38%,22%)`;
}
function fmtDuration(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── Theme ─────────────────────────────────────────────────────
function applyTheme() {
  document.body.classList.toggle('light', !darkMode);
  $('theme-btn').textContent = darkMode ? '☀️' : '🌙';
}
function toggleTheme() {
  darkMode = !darkMode;
  localStorage.setItem('vibify_theme', darkMode ? 'dark' : 'light');
  applyTheme();
}
function initTheme() {
  const saved = localStorage.getItem('vibify_theme');
  if (saved) { darkMode = saved === 'dark'; }
  else { darkMode = !window.matchMedia('(prefers-color-scheme: light)').matches; }
  applyTheme();
}

// ── View toggle ───────────────────────────────────────────────
function toggleView() {
  viewMode = viewMode === 'list' ? 'grid' : 'list';
  $('view-btn').textContent = viewMode === 'list' ? '⊞ Grille' : '☰ Liste';
  renderTracks(currentFiltered.length ? currentFiltered : allTracks);
}

// ── Loading ───────────────────────────────────────────────────
function showLoading(text, showSkip = false) {
  $('loading-text').textContent = text;
  $('loading-bar').style.width = '0%';
  $('loading-sub').textContent = '';
  $('skip-enrich-btn').classList.toggle('hidden', !showSkip);
  $('loading-overlay').classList.remove('hidden');
}
function updateLoadingProgress(done, total, sub = '') {
  $('loading-bar').style.width = (total ? Math.round(done / total * 100) : 0) + '%';
  $('loading-sub').textContent = sub;
}
function hideLoading() { $('loading-overlay').classList.add('hidden'); }

// ── Persistance ───────────────────────────────────────────────
const STORAGE_KEY = 'vibify_library_v2';

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
  } catch (e) {
    // Trop grand, on ignore
  }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || (!data.liked && !data.playlists)) return false;
    library = data;
    return true;
  } catch { return false; }
}

function clearStorage() {
  localStorage.removeItem(STORAGE_KEY);
}

function checkSavedLibrary() {
  if (loadFromStorage()) {
    const total = library.liked.length + library.playlists.reduce((s, p) => s + p.items.length, 0);
    const plCount = library.playlists.length;
    $('saved-info').textContent = `📦 Bibliothèque sauvegardée : ${total} titres · ${plCount} playlist${plCount!==1?'s':''}`;
    $('saved-banner').classList.remove('hidden');
    $('import-form').classList.add('hidden');
  }
}

// ── File parsing ──────────────────────────────────────────────
async function readFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = rej;
    r.readAsText(file, 'utf-8');
  });
}

async function handleFiles(fileList) {
  library = { liked: [], playlists: [] };
  let found = false;
  const err = $('import-error');
  err.classList.add('hidden');

  for (const file of fileList) {
    if (!file.name.endsWith('.json')) continue;
    let json;
    try { json = JSON.parse(await readFile(file)); } catch { continue; }

    if (file.name === 'YourLibrary.json') {
      if (Array.isArray(json.tracks)) {
        library.liked = json.tracks.filter(t => t.track).map(t => ({
          name: t.track || '', artists: [t.artist || ''], album: t.album || '',
          uri: t.uri || '', image: null, duration_ms: null, preview_url: null, added_at: null,
        }));
        found = true;
      }
    } else if (/^Playlist\d+\.json$/i.test(file.name)) {
      const name = json.name || file.name.replace('.json', '');
      const items = (json.items || []).filter(i => i.track && i.track.trackName).map(i => ({
        name: i.track.trackName || '', artists: [i.track.artistName || ''],
        album: i.track.albumName || '', uri: i.track.trackUri || '',
        image: null, duration_ms: null, preview_url: null, added_at: i.addedDate || null,
      }));
      library.playlists.push({ name, items });
      found = true;
    }
  }

  if (!found) {
    err.textContent = '❌ Aucun fichier Spotify reconnu. Cherche YourLibrary.json et/ou PlaylistX.json dans le ZIP.';
    err.classList.remove('hidden');
    return;
  }

  launchApp();
  await enrichLibrary();
  saveToStorage();
  renderTracks(currentFiltered.length ? currentFiltered : allTracks);
}

function launchApp() {
  $('import-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  const total = library.liked.length + library.playlists.reduce((s, p) => s + p.items.length, 0);
  $('import-info').textContent = `${total} titres`;
  renderSidebar();
}

// ── Enrichissement ────────────────────────────────────────────
async function enrichLibrary() {
  skipEnrich = false;
  const allFlat = [...library.liked, ...library.playlists.flatMap(p => p.items)];
  const uriMap = {};
  allFlat.forEach(t => { if (t.uri) uriMap[t.uri] = t; });

  const ids = [...new Set(
    allFlat.map(t => t.uri).filter(u => u && u.startsWith('spotify:track:')).map(u => u.split(':')[2])
  )];
  if (!ids.length) return;

  showLoading('Chargement des pochettes…', true);

  for (let i = 0; i < ids.length && !skipEnrich; i += 50) {
    const batch = ids.slice(i, i + 50);
    updateLoadingProgress(i, ids.length, `${Math.min(i + 50, ids.length)} / ${ids.length}`);
    try {
      const r = await fetch('/api/v1/tracks/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: batch }),
      });
      if (r.ok) {
        (await r.json()).forEach(d => {
          const t = uriMap[d.uri] || uriMap[`spotify:track:${d.id}`];
          if (t) { t.image = d.image; t.duration_ms = d.duration_ms; t.preview_url = d.preview_url || null; }
        });
      }
    } catch {}
  }
  hideLoading();
}

// ── Sidebar ───────────────────────────────────────────────────
function countDups(tracks) {
  const seen = new Set(); let n = 0;
  tracks.forEach(t => {
    const k = t.uri || `${t.name}|${(t.artists||[]).join()}`;
    if (seen.has(k)) n++; else seen.add(k);
  });
  return n;
}

function renderSidebar() {
  const list = $('sidebar-list');
  list.innerHTML = '';

  const allItems = [...library.liked, ...library.playlists.flatMap(p => p.items)];

  const allBtn = makeSrcBtn('🌐', 'Tout voir', allItems.length, countDups(allItems));
  allBtn.addEventListener('click', () => { setActive(allBtn); loadSource('Tout voir', allItems); });
  list.appendChild(allBtn);

  if (library.liked.length) {
    const btn = makeSrcBtn('❤️', 'Titres likés', library.liked.length, countDups(library.liked));
    btn.addEventListener('click', () => { setActive(btn); loadSource('Titres likés', library.liked); });
    list.appendChild(btn);
    btn.click();
  } else {
    allBtn.click();
  }

  if (library.playlists.length) {
    const sep = document.createElement('div');
    sep.className = 'sidebar-title'; sep.style.padding = '12px 16px 6px'; sep.textContent = 'Playlists';
    list.appendChild(sep);

    library.playlists.forEach(pl => {
      const wrap = document.createElement('div');
      wrap.className = 'sidebar-item-wrap';

      const btn = makeSrcBtn('🎵', pl.name, pl.items.length, countDups(pl.items));
      btn.addEventListener('click', () => { setActive(btn); loadSource(pl.name, pl.items); });

      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'fusion-check'; cb.title = 'Sélect. pour fusion';
      cb.dataset.name = pl.name;
      cb.addEventListener('change', updateFusionBtn);

      wrap.appendChild(cb); wrap.appendChild(btn);
      list.appendChild(wrap);
    });
  }
}

function makeSrcBtn(icon, name, count, dups = 0) {
  const btn = document.createElement('button');
  btn.className = 'playlist-item';
  const dupBadge = dups > 0 ? `<span class="dup-badge" title="${dups} doublon${dups>1?'s':''}">${dups}⚠</span>` : '';
  btn.innerHTML = `<span class="item-icon">${icon}</span><span class="item-name" title="${esc(name)}">${esc(name)}</span>${dupBadge}<span class="item-badge">${count}</span>`;
  return btn;
}

function setActive(btn) {
  document.querySelectorAll('.playlist-item').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function loadSource(name, tracks) {
  $('playlist-title').textContent = name;
  allTracks = tracks;
  currentFiltered = [];
  $('dup-btn').dataset.active = '';
  $('dup-btn').textContent = '🔍 Doublons';
  resetFilters();
  buildSelects();
}

// ── Fusion ────────────────────────────────────────────────────
function updateFusionBtn() {
  const checked = document.querySelectorAll('.fusion-check:checked');
  const bottom = $('sidebar-bottom');
  if (checked.length >= 2) {
    bottom.classList.remove('hidden');
    $('fusion-btn').textContent = `🔀 Fusionner (${checked.length})`;
  } else {
    bottom.classList.add('hidden');
  }
}

function fusionPlaylists() {
  const checked = document.querySelectorAll('.fusion-check:checked');
  const names = [...checked].map(cb => cb.dataset.name);
  const tracks = [], labels = [];
  library.playlists.forEach(pl => {
    if (names.includes(pl.name)) { tracks.push(...pl.items); labels.push(pl.name); }
  });
  loadSource(labels.join(' + '), tracks);
  checked.forEach(cb => { cb.checked = false; });
  updateFusionBtn();
}

// ── Render ────────────────────────────────────────────────────
function renderTracks(tracks) {
  currentFiltered = tracks;
  selectedUris.clear();
  updateFloatBar();
  $('tracks-count').textContent = `${tracks.length} titre${tracks.length !== 1 ? 's' : ''}`;

  const wrap = $('tracks-wrap');
  if (!tracks.length) { wrap.innerHTML = '<div class="empty-state">Aucun titre trouvé 🎵</div>'; return; }

  if (viewMode === 'grid') {
    wrap.innerHTML = '<div class="tracks-grid"></div>';
    const grid = wrap.querySelector('.tracks-grid');
    tracks.forEach((t, i) => {
      const card = document.createElement('div');
      card.className = 'track-card';
      card.style.animationDelay = `${Math.min(i, 40) * 18}ms`;
      const artists = (t.artists || []).join(', ');
      const color = cardColor(t.name + artists);
      const cid = t.uri?.split(':')[2] || '';
      const artContent = t.image
        ? `<img class="card-img" src="${esc(t.image)}" alt="" loading="lazy">`
        : `<span class="card-emoji">🎵</span>`;
      card.innerHTML = `
        <div class="card-art" style="background:${color}">
          <input type="checkbox" class="card-check track-check" data-uri="${esc(t.uri)}">
          ${artContent}
          ${t.preview_url ? '<button class="card-play-btn" title="Aperçu 30s">▶</button>' : ''}
        </div>
        <div class="card-body">
          <div class="card-name" title="${esc(t.name)}">${esc(t.name)}</div>
          <div class="card-artist">${esc(artists)}</div>
          ${t.duration_ms ? `<div class="card-dur">${fmtDuration(t.duration_ms)}</div>` : ''}
          ${cid ? `<a class="card-spotify-link" href="https://open.spotify.com/track/${esc(cid)}" target="_blank">↗ Spotify</a>` : ''}
        </div>`;
      attachToggle(card, card.querySelector('.track-check'), t);
      const cpb = t.preview_url ? card.querySelector('.card-play-btn') : null;
      if (cpb) cpb.addEventListener('click', e => { e.stopPropagation(); playPreview(t.preview_url, cpb, card); });
      const csl = card.querySelector('.card-spotify-link');
      if (csl) csl.addEventListener('click', e => e.stopPropagation());
      grid.appendChild(card);
    });
  } else {
    wrap.innerHTML = `<div class="track-header">
      <span></span><span></span><span>Titre / Artiste</span><span>Album</span><span>Artiste</span><span>Durée</span>
    </div>`;
    tracks.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'track-row';
      row.style.animationDelay = `${Math.min(i, 60) * 9}ms`;
      const artists = (t.artists || []).join(', ');
      const color = cardColor(t.name + artists);
      const id = t.uri?.split(':')[2] || '';
      const imgHtml = t.image
        ? `<img class="track-img" src="${esc(t.image)}" alt="" loading="lazy">`
        : `<div class="track-placeholder" style="background:${color}">🎵</div>`;
      row.innerHTML = `
        <input type="checkbox" class="track-check" data-uri="${esc(t.uri)}">
        <div class="track-img-wrap">
          ${imgHtml}
          ${t.preview_url ? '<button class="preview-play-btn" title="Aperçu 30s">▶</button>' : ''}
        </div>
        <div>
          <div class="track-name" title="${esc(t.name)}">${esc(t.name)}</div>
          <div class="track-artist">${esc(artists)}</div>
        </div>
        <div class="track-col" title="${esc(t.album)}">${esc(t.album)}</div>
        <div class="track-col">${esc(artists)}</div>
        <div class="track-dur">
          <span>${fmtDuration(t.duration_ms)}</span>
          ${id ? `<a class="open-spotify-btn" href="https://open.spotify.com/track/${esc(id)}" target="_blank" title="Ouvrir dans Spotify">↗</a>` : ''}
        </div>`;
      attachToggle(row, row.querySelector('.track-check'), t);
      const pb = t.preview_url ? row.querySelector('.preview-play-btn') : null;
      if (pb) pb.addEventListener('click', e => { e.stopPropagation(); playPreview(t.preview_url, pb, row); });
      const sl = row.querySelector('.open-spotify-btn');
      if (sl) sl.addEventListener('click', e => e.stopPropagation());
      wrap.appendChild(row);
    });
  }
}

function attachToggle(el, cb, t) {
  const toggle = () => {
    if (cb.checked) { selectedUris.add(t.uri); el.classList.add('selected'); }
    else            { selectedUris.delete(t.uri); el.classList.remove('selected'); }
    updateFloatBar();
  };
  cb.addEventListener('change', toggle);
  el.addEventListener('click', e => { if (e.target === cb) return; cb.checked = !cb.checked; toggle(); });
}

// ── Floating bar ──────────────────────────────────────────────
function updateFloatBar() {
  const bar = $('float-bar');
  if (selectedUris.size > 0) {
    bar.classList.add('visible');
    $('float-count').textContent = `${selectedUris.size} titre${selectedUris.size > 1 ? 's' : ''} sélectionné${selectedUris.size > 1 ? 's' : ''}`;
  } else {
    bar.classList.remove('visible');
  }
}

function playPreview(url, btn, row) {
  if (currentAudio) {
    currentAudio.pause();
    if (currentPlayBtn) currentPlayBtn.textContent = '▶';
    currentPlayBtn?.closest('.track-row')?.classList.remove('playing');
    currentPlayBtn?.closest('.track-card')?.classList.remove('playing');
    const wasBtn = currentPlayBtn;
    currentAudio = null; currentPlayBtn = null;
    if (wasBtn === btn) return;
  }
  currentAudio = new Audio(url);
  currentPlayBtn = btn;
  btn.textContent = '⏸';
  row?.classList.add('playing');
  currentAudio.play().catch(() => {});
  currentAudio.addEventListener('ended', () => {
    btn.textContent = '▶';
    row?.classList.remove('playing');
    currentAudio = null; currentPlayBtn = null;
  });
}

function clearSelection() {
  document.querySelectorAll('.track-check').forEach(cb => {
    if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
  });
}

// ── Sort / Filter ─────────────────────────────────────────────
let searchTimer;
function applySortFilter() {
  const query = $('search-input').value.trim().toLowerCase();
  const by    = $('sort-by').value;
  const order = $('sort-order').value === 'asc' ? 1 : -1;

  let tracks = [...allTracks];
  if (query) tracks = tracks.filter(t =>
    (t.name || '').toLowerCase().includes(query) ||
    (t.artists || []).join(' ').toLowerCase().includes(query) ||
    (t.album || '').toLowerCase().includes(query)
  );
  if (by) tracks.sort((a, b) => {
    let va = '', vb = '';
    if (by === 'artist')     { va = (a.artists||[]).join().toLowerCase(); vb = (b.artists||[]).join().toLowerCase(); }
    else if (by === 'name')  { va = (a.name||'').toLowerCase(); vb = (b.name||'').toLowerCase(); }
    else if (by === 'album') { va = (a.album||'').toLowerCase(); vb = (b.album||'').toLowerCase(); }
    else if (by === 'duration_ms') { va = a.duration_ms||0; vb = b.duration_ms||0; }
    else if (by === 'added_at') { va = a.added_at||''; vb = b.added_at||''; }
    return va < vb ? -order : va > vb ? order : 0;
  });
  renderTracks(tracks);
}

function resetFilters() {
  $('sort-by').value = ''; $('sort-order').value = 'asc';
  $('search-input').value = ''; $('artist-select').value = ''; $('album-select').value = '';
  renderTracks(allTracks);
}

function toggleSelectAll() {
  const boxes = document.querySelectorAll('.track-check');
  const allOn = [...boxes].every(b => b.checked);
  boxes.forEach(b => { b.checked = !allOn; b.dispatchEvent(new Event('change')); });
}

function shuffleTracks() {
  const tracks = [...(currentFiltered.length ? currentFiltered : allTracks)];
  for (let i = tracks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  }
  renderTracks(tracks);
}

// ── Artist / Album selects ────────────────────────────────────
function buildSelects() {
  const artists = [...new Set(allTracks.flatMap(t => t.artists || []).filter(Boolean))].sort();
  $('artist-select').innerHTML = '<option value="">🎤 Artiste…</option>' +
    artists.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');

  const albums = [...new Set(allTracks.map(t => t.album).filter(Boolean))].sort();
  $('album-select').innerHTML = '<option value="">💿 Album…</option>' +
    albums.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
}

function selectByField(field, value) {
  if (!value) return;
  document.querySelectorAll('.track-check').forEach(cb => {
    const el = cb.closest('.track-row, .track-card');
    if (!el) return;
    const target = el.querySelector(field === 'artist' ? '.track-artist,.card-artist' : '.track-col,.card-name');
    if (target && target.textContent.includes(value)) {
      cb.checked = true; cb.dispatchEvent(new Event('change'));
    }
  });
  if (field === 'artist') $('artist-select').value = '';
  else $('album-select').value = '';
}

// ── Duplicates ────────────────────────────────────────────────
function findDuplicates() {
  const btn = $('dup-btn');
  if (btn.dataset.active === '1') {
    btn.dataset.active = ''; btn.textContent = '🔍 Doublons';
    renderTracks(allTracks); return;
  }
  const seen = {}, dups = [];
  allTracks.forEach(t => {
    const key = t.uri || `${t.name}|${(t.artists||[]).join()}`;
    if (seen[key]) dups.push(t); else seen[key] = true;
  });
  if (!dups.length) { alert('✅ Aucun doublon dans cette source !'); return; }
  btn.dataset.active = '1'; btn.textContent = `✕ Doublons (${dups.length})`;
  renderTracks(dups);
}

// ── Statistics ────────────────────────────────────────────────
function showStats() {
  const all = [...library.liked, ...library.playlists.flatMap(p => p.items)];
  const cur = currentFiltered.length ? currentFiltered : allTracks;
  const artists = {};
  all.forEach(t => (t.artists||[]).filter(Boolean).forEach(a => artists[a] = (artists[a]||0)+1));
  const top = Object.entries(artists).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const maxN = top[0]?.[1] || 1;
  const albums = new Set(all.map(t=>t.album).filter(Boolean)).size;
  const totalDur = all.reduce((s,t) => s+(t.duration_ms||0), 0);
  const curDur   = cur.reduce((s,t) => s+(t.duration_ms||0), 0);

  function fmtH(ms) {
    const h = Math.floor(ms/3600000); const m = Math.floor((ms%3600000)/60000);
    return h ? `${h}h ${m}min` : `${m}min`;
  }

  $('stats-body').innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-num">${all.length}</div><div class="stat-lbl">Titres total</div></div>
      <div class="stat-card"><div class="stat-num">${Object.keys(artists).length}</div><div class="stat-lbl">Artistes</div></div>
      <div class="stat-card"><div class="stat-num">${albums}</div><div class="stat-lbl">Albums</div></div>
      <div class="stat-card"><div class="stat-num">${library.playlists.length}</div><div class="stat-lbl">Playlists</div></div>
      <div class="stat-card"><div class="stat-num">${fmtH(totalDur)}</div><div class="stat-lbl">Durée totale</div></div>
      <div class="stat-card"><div class="stat-num">${cur.length}</div><div class="stat-lbl">Vue actuelle</div></div>
      <div class="stat-card"><div class="stat-num">${fmtH(curDur)}</div><div class="stat-lbl">Durée vue</div></div>
      <div class="stat-card"><div class="stat-num">${countDups(all)}</div><div class="stat-lbl">Doublons totaux</div></div>
    </div>
    <div class="stat-section-title" style="margin-top:14px">Top artistes</div>
    <div class="top-list">
      ${top.map(([a,n])=>`
        <div class="top-row">
          <span class="top-name">${esc(a)}</span>
          <div class="top-bar-wrap"><div class="top-bar" style="width:${Math.round(n/maxN*100)}%"></div></div>
          <span class="top-count">${n} titre${n>1?'s':''}</span>
        </div>`).join('')}
    </div>
    ${library.playlists.length ? `
    <div class="stat-section-title" style="margin-top:14px">Playlists (${library.playlists.length})</div>
    <div class="pl-stat-table">
      ${library.playlists.map(pl => {
        const d = countDups(pl.items);
        return `<div class="pl-stat-row">
          <span class="pl-stat-name" title="${esc(pl.name)}">${esc(pl.name)}</span>
          <span class="pl-stat-count">${pl.items.length} titres</span>
          ${d ? `<span class="pl-stat-dups">⚠ ${d} doublon${d>1?'s':''}</span>` : '<span></span>'}
        </div>`;
      }).join('')}
    </div>` : ''}`;
  $('stats-modal').classList.remove('hidden');
}

// ── Export ────────────────────────────────────────────────────
function copyUris() {
  const text = [...selectedUris].join('\n');
  navigator.clipboard.writeText(text)
    .then(() => alert(`✅ ${selectedUris.size} URI${selectedUris.size>1?'s':''} copié${selectedUris.size>1?'s':''} !`))
    .catch(() => prompt('Copie ces URIs :', text));
}

function exportCsv() {
  const sel = (currentFiltered.length ? currentFiltered : allTracks).filter(t => selectedUris.has(t.uri));
  const rows = [['Titre','Artiste','Album','Durée','URI']];
  sel.forEach(t => rows.push([
    `"${(t.name||'').replace(/"/g,'""')}"`,
    `"${(t.artists||[]).join(', ').replace(/"/g,'""')}"`,
    `"${(t.album||'').replace(/"/g,'""')}"`,
    fmtDuration(t.duration_ms),
    t.uri||'',
  ]));
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob(['﻿'+rows.map(r=>r.join(',')).join('\r\n')],{type:'text/csv;charset=utf-8;'})),
    download: 'vibify_selection.csv',
  });
  a.click(); URL.revokeObjectURL(a.href);
}

// ── Keyboard shortcuts ────────────────────────────────────────
function initKeyboard() {
  document.addEventListener('keydown', e => {
    const inInput = ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName);

    if (e.key === 'Escape') {
      document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !inInput) {
      e.preventDefault(); toggleSelectAll();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault(); $('search-input').focus(); $('search-input').select();
    }
    if (e.key === '?' && !inInput) {
      const t = $('shortcuts-toast');
      t.classList.remove('hidden');
      setTimeout(() => t.classList.add('hidden'), 3500);
    }
  });
}

// ── Events ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initKeyboard();
  checkSavedLibrary();

  // Import
  $('file-input').addEventListener('change', e => handleFiles(e.target.files));
  const drop = $('drop-zone');
  drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', ()  => drop.classList.remove('drag-over'));
  drop.addEventListener('drop',      e  => { e.preventDefault(); drop.classList.remove('drag-over'); handleFiles(e.dataTransfer.files); });

  // Saved library
  $('load-saved-btn').addEventListener('click', () => {
    if (loadFromStorage()) {
      launchApp();
      // Pas d'enrichissement (déjà sauvegardé)
      hideLoading();
    }
  });
  $('ignore-saved-btn').addEventListener('click', () => {
    clearStorage();
    $('saved-banner').classList.add('hidden');
    $('import-form').classList.remove('hidden');
  });

  // Loading
  $('skip-enrich-btn').addEventListener('click', () => { skipEnrich = true; hideLoading(); });

  // Header
  $('new-import-btn').addEventListener('click', () => {
    $('app-screen').classList.add('hidden');
    $('import-screen').classList.remove('hidden');
    $('saved-banner').classList.add('hidden');
    $('import-form').classList.remove('hidden');
    checkSavedLibrary();
  });
  $('theme-btn').addEventListener('click', toggleTheme);
  $('view-btn').addEventListener('click', toggleView);
  $('stats-btn').addEventListener('click', showStats);

  // Toolbar
  $('dup-btn').addEventListener('click', findDuplicates);
  $('shuffle-btn').addEventListener('click', shuffleTracks);

  // Sidebar fusion
  $('fusion-btn').addEventListener('click', fusionPlaylists);

  // Filters
  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer); searchTimer = setTimeout(applySortFilter, 250);
  });
  $('sort-by').addEventListener('change', applySortFilter);
  $('sort-order').addEventListener('change', applySortFilter);
  $('reset-btn').addEventListener('click', resetFilters);
  $('select-all-btn').addEventListener('click', toggleSelectAll);
  $('artist-select').addEventListener('change', e => selectByField('artist', e.target.value));
  $('album-select').addEventListener('change', e => selectByField('album', e.target.value));

  // Floating bar
  $('float-copy-btn').addEventListener('click', copyUris);
  $('float-csv-btn').addEventListener('click', exportCsv);
  $('float-clear-btn').addEventListener('click', clearSelection);

  // Modals
  $('close-stats-btn').addEventListener('click', () => $('stats-modal').classList.add('hidden'));
  $('close-export-btn').addEventListener('click', () => $('export-modal').classList.add('hidden'));
  $('copy-uris-btn').addEventListener('click', copyUris);
  $('export-csv-btn').addEventListener('click', exportCsv);
  document.querySelectorAll('.modal').forEach(m =>
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); })
  );
});
