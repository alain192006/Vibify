'use strict';

// Handle OAuth popup callback — runs before anything else
(function () {
  if (!window.location.hash.includes('access_token')) return;
  const p = new URLSearchParams(window.location.hash.slice(1));
  const at = p.get('access_token');
  if (!at) return;
  const data = { accessToken: at, refreshToken: p.get('refresh_token') || '', expiresAt: Date.now() + parseInt(p.get('expires_in') || '3600') * 1000 };
  localStorage.setItem('vibify_spotify_auth', JSON.stringify(data));
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({ type: 'vibify_spotify_auth', ...data }, '*');
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#121212;color:#fff;font-family:sans-serif;flex-direction:column;gap:12px"><div style="font-size:2.5rem">✅</div><p style="font-weight:700;font-size:1.1rem">Connecté à Spotify !</p><p style="color:#b3b3b3;font-size:.85rem">Cette fenêtre va se fermer…</p></div>';
    setTimeout(() => window.close(), 1200);
  } else { history.replaceState(null, '', '/'); }
})();

let allTracks = [], selectedUris = new Set();
let library = { liked: [], playlists: [] };
let viewMode = 'list';
let darkMode = true;
let currentFiltered = [];
let skipEnrich = false;
let currentAudio = null;
let currentPlayBtn = null;
let trackTags = {};
let currentTagUri = null;
let trackRatings = {};
let batchTagUris = new Set();
const RATINGS_KEY = 'vibify_ratings';
let spotifyToken = null;
let spotifyUser = null;
const SPOTIFY_AUTH_KEY = 'vibify_spotify_auth';

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

// ── Spotify Auth ─────────────────────────────────────────────
function loadSpotifyAuth() {
  try {
    const data = JSON.parse(localStorage.getItem(SPOTIFY_AUTH_KEY) || 'null');
    if (!data?.accessToken) return;
    if (data.expiresAt && Date.now() > data.expiresAt - 60000) {
      if (data.refreshToken) refreshSpotifyToken(data.refreshToken);
      return;
    }
    spotifyToken = data.accessToken;
    fetchSpotifyUser();
  } catch {}
}

async function refreshSpotifyToken(rt) {
  try {
    const r = await fetch('/api/v1/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (r.ok) {
      const data = await r.json();
      spotifyToken = data.access_token;
      const stored = JSON.parse(localStorage.getItem(SPOTIFY_AUTH_KEY) || '{}');
      stored.accessToken = data.access_token;
      stored.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      localStorage.setItem(SPOTIFY_AUTH_KEY, JSON.stringify(stored));
      fetchSpotifyUser();
    }
  } catch {}
}

async function fetchSpotifyUser() {
  if (!spotifyToken) return;
  try {
    const r = await fetch('/api/v1/auth/me', { headers: { 'Authorization': `Bearer ${spotifyToken}` } });
    if (r.ok) { spotifyUser = await r.json(); updateSpotifyUI(); }
    else { spotifyToken = null; updateSpotifyUI(); }
  } catch {}
}

function updateSpotifyUI() {
  const connected = !!(spotifyToken && spotifyUser);
  $('spotify-connect-btn').classList.toggle('hidden', connected);
  $('spotify-user-wrap').classList.toggle('hidden', !connected);
  if (connected) {
    $('spotify-user-name').textContent = spotifyUser.name;
    if (spotifyUser.image) $('spotify-avatar').src = spotifyUser.image;
  }
  updateFloatBar();
}

function connectSpotify() {
  window.open('/api/v1/auth/login', 'spotify_login', 'width=500,height=700,left=200,top=100');
}

function disconnectSpotify() {
  spotifyToken = null; spotifyUser = null;
  localStorage.removeItem(SPOTIFY_AUTH_KEY);
  updateSpotifyUI();
}

async function createSpotifyPlaylist() {
  if (!spotifyToken || !selectedUris.size) return;
  const name = $('create-pl-name').value.trim();
  if (!name) { $('create-pl-name').focus(); return; }
  const btn = $('create-pl-confirm');
  btn.textContent = 'Création en cours…'; btn.disabled = true;
  $('create-pl-result').innerHTML = '';
  try {
    const r = await fetch('/api/v1/playlists/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${spotifyToken}` },
      body: JSON.stringify({ name, description: `Créée avec Vibify — ${selectedUris.size} titres`, track_uris: [...selectedUris] }),
    });
    if (r.ok) {
      const data = await r.json();
      $('create-pl-result').innerHTML = `<div class="create-pl-success">✅ Playlist créée ! <a href="${esc(data.url)}" target="_blank" class="open-spotify-btn" style="opacity:1">Ouvrir dans Spotify ↗</a></div>`;
      $('create-pl-name').value = '';
    } else {
      const err = await r.json().catch(() => ({}));
      $('create-pl-result').innerHTML = `<p style="color:#ff6b6b;font-size:.85rem">❌ ${err.detail || 'Erreur'}</p>`;
    }
  } catch (e) {
    $('create-pl-result').innerHTML = `<p style="color:#ff6b6b;font-size:.85rem">❌ ${e.message}</p>`;
  } finally { btn.textContent = 'Créer sur Spotify ✓'; btn.disabled = false; }
}

// ── Tags ──────────────────────────────────────────────────────
const TAGS_KEY = 'vibify_tags';

function loadTags() {
  try { trackTags = JSON.parse(localStorage.getItem(TAGS_KEY) || '{}'); } catch { trackTags = {}; }
}
function saveTags() {
  try { localStorage.setItem(TAGS_KEY, JSON.stringify(trackTags)); } catch {}
}
function getTagsFor(uri) { return trackTags[uri] || []; }
function addTagTo(uri, raw) {
  const tag = raw.trim().toLowerCase().replace(/\s+/g, '-');
  if (!tag) return false;
  if (!trackTags[uri]) trackTags[uri] = [];
  if (trackTags[uri].includes(tag)) return false;
  trackTags[uri].push(tag);
  saveTags();
  return true;
}
function removeTagFrom(uri, tag) {
  if (!trackTags[uri]) return;
  trackTags[uri] = trackTags[uri].filter(t => t !== tag);
  if (!trackTags[uri].length) delete trackTags[uri];
  saveTags();
}
function getAllTagsUsed() {
  return [...new Set(Object.values(trackTags).flat())].sort();
}
function updateTagSelect() {
  const tags = getAllTagsUsed();
  const cur = $('tag-select').value;
  $('tag-select').innerHTML = '<option value="">🏷️ Tag…</option>' +
    tags.map(t => `<option value="${esc(t)}"${t === cur ? ' selected' : ''}>${esc(t)}</option>`).join('');
}
function updateTrackTagDisplay(uri) {
  document.querySelectorAll(`.track-tags[data-uri], .card-tags[data-uri]`).forEach(wrap => {
    if (wrap.dataset.uri !== uri) return;
    const tags = getTagsFor(uri);
    wrap.querySelectorAll('.tag-chip').forEach(c => c.remove());
    tags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = tag;
      wrap.appendChild(chip);
    });
  });
}
function showTagModal(uri, name) {
  batchTagUris = new Set();
  currentTagUri = uri;
  $('tag-track-name').textContent = name;
  renderTagModalChips();
  renderTagSuggestions();
  $('tag-input').value = '';
  $('tag-modal').classList.remove('hidden');
  setTimeout(() => $('tag-input').focus(), 60);
}
function renderTagModalChips() {
  const tags = getTagsFor(currentTagUri);
  $('tag-chips-wrap').innerHTML = tags.length
    ? tags.map(t => `<span class="tag-chip tag-chip-rm" data-tag="${esc(t)}">${esc(t)} <span class="tag-x">✕</span></span>`).join('')
    : '<span class="tag-empty">Aucun tag — ajoutes-en un !</span>';
  $('tag-chips-wrap').querySelectorAll('.tag-chip-rm').forEach(chip => {
    chip.addEventListener('click', () => {
      removeTagFrom(currentTagUri, chip.dataset.tag);
      renderTagModalChips(); renderTagSuggestions();
      updateTrackTagDisplay(currentTagUri); updateTagSelect();
    });
  });
}
function renderTagSuggestions() {
  const existing = getTagsFor(currentTagUri);
  const sugg = getAllTagsUsed().filter(t => !existing.includes(t));
  $('tag-suggestions').innerHTML = sugg.length
    ? '<span class="tag-sugg-label">Déjà utilisés :</span> ' +
      sugg.map(t => `<span class="tag-suggestion" data-tag="${esc(t)}">${esc(t)}</span>`).join('')
    : '';
  $('tag-suggestions').querySelectorAll('.tag-suggestion').forEach(s => {
    s.addEventListener('click', () => {
      if (addTagTo(currentTagUri, s.dataset.tag)) {
        renderTagModalChips(); renderTagSuggestions();
        updateTrackTagDisplay(currentTagUri); updateTagSelect();
      }
    });
  });
}
function confirmAddTag() {
  const val = $('tag-input').value;
  if (batchTagUris.size > 0) {
    if (!val.trim()) return;
    batchTagUris.forEach(uri => addTagTo(uri, val));
    $('tag-input').value = '';
    updateTagSelect();
  } else {
    if (addTagTo(currentTagUri, val)) {
      $('tag-input').value = '';
      renderTagModalChips(); renderTagSuggestions();
      updateTrackTagDisplay(currentTagUri); updateTagSelect();
    }
  }
}

// ── Ratings ──────────────────────────────────────────────────
function loadRatings() { try { trackRatings = JSON.parse(localStorage.getItem(RATINGS_KEY) || '{}'); } catch { trackRatings = {}; } }
function saveRatings() { try { localStorage.setItem(RATINGS_KEY, JSON.stringify(trackRatings)); } catch {} }
function getRating(uri) { return trackRatings[uri] || 0; }
function setRating(uri, n) {
  if (trackRatings[uri] === n) delete trackRatings[uri]; else trackRatings[uri] = n;
  saveRatings();
  document.querySelectorAll(`.star-rating[data-uri]`).forEach(sr => {
    if (sr.dataset.uri !== uri) return;
    const r = getRating(uri);
    sr.querySelectorAll('.star').forEach((s, i) => s.classList.toggle('filled', i < r));
  });
}
function starsHtml(uri) {
  const r = getRating(uri);
  return `<div class="star-rating" data-uri="${esc(uri)}">${[1,2,3,4,5].map(n => `<span class="star${n<=r?' filled':''}" data-star="${n}">★</span>`).join('')}</div>`;
}
function attachStars(container) {
  container.querySelectorAll('.star-rating').forEach(sr => {
    sr.addEventListener('click', e => {
      const star = e.target.closest('.star');
      if (!star) return;
      e.stopPropagation();
      setRating(sr.dataset.uri, parseInt(star.dataset.star));
    });
  });
}

// ── Batch tag ─────────────────────────────────────────────────
function showBatchTagModal() {
  batchTagUris = new Set([...selectedUris]);
  if (!batchTagUris.size) return;
  currentTagUri = null;
  $('tag-track-name').textContent = `${batchTagUris.size} titre${batchTagUris.size > 1 ? 's' : ''} sélectionné${batchTagUris.size > 1 ? 's' : ''}`;
  $('tag-chips-wrap').innerHTML = '<span class="tag-empty">Les tags seront ajoutés à tous les titres sélectionnés</span>';
  const sugg = getAllTagsUsed();
  $('tag-suggestions').innerHTML = sugg.length
    ? '<span class="tag-sugg-label">Tags existants :</span> ' + sugg.map(t => `<span class="tag-suggestion" data-tag="${esc(t)}">${esc(t)}</span>`).join('') : '';
  $('tag-suggestions').querySelectorAll('.tag-suggestion').forEach(s => {
    s.addEventListener('click', () => { batchTagUris.forEach(uri => addTagTo(uri, s.dataset.tag)); updateTagSelect(); });
  });
  $('tag-input').value = '';
  $('tag-modal').classList.remove('hidden');
  setTimeout(() => $('tag-input').focus(), 60);
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
  streamingHistory = [];
  let found = false;
  const err = $('import-error');
  err.classList.add('hidden');

  // Collecte tous les JSON (depuis fichiers directs ou ZIP)
  const jsonEntries = []; // { name, content }

  for (const file of fileList) {
    const lname = file.name.toLowerCase();
    if (lname.endsWith('.zip')) {
      // @ts-ignore — JSZip chargé via CDN
      if (typeof JSZip === 'undefined') {
        err.textContent = '❌ JSZip non chargé — vérifie ta connexion et réessaie.';
        err.classList.remove('hidden'); return;
      }
      try {
        // @ts-ignore
        const zip = await JSZip.loadAsync(file);
        for (const [path, entry] of Object.entries(zip.files)) {
          if (entry.dir) continue;
          const basename = path.split('/').pop();
          if (basename === 'YourLibrary.json' || /^Playlist\d+\.json$/i.test(basename) || /^StreamingHistory_music_\d+\.json$/i.test(basename)) {
            jsonEntries.push({ name: basename, content: await entry.async('string') });
          }
        }
      } catch (e) {
        err.textContent = `❌ Impossible de lire le ZIP : ${e.message}`;
        err.classList.remove('hidden'); return;
      }
    } else if (lname.endsWith('.json')) {
      jsonEntries.push({ name: file.name, content: await readFile(file) });
    }
  }

  for (const { name, content } of jsonEntries) {
    let json;
    try { json = JSON.parse(content); } catch { continue; }

    if (name === 'YourLibrary.json') {
      if (Array.isArray(json.tracks)) {
        library.liked = json.tracks.filter(t => t.track).map(t => ({
          name: t.track || '', artists: [t.artist || ''], album: t.album || '',
          uri: t.uri || '', image: null, duration_ms: null, preview_url: null, added_at: null,
        }));
        found = true;
      }
    } else if (/^StreamingHistory_music_\d+\.json$/i.test(name)) {
      if (Array.isArray(json)) {
        streamingHistory.push(...json.filter(e => e.master_metadata_track_name));
        found = true;
      }
    } else if (/^Playlist\d+\.json$/i.test(name)) {
      const plName = json.name || name.replace('.json', '');
      const items = (json.items || []).filter(i => i.track && i.track.trackName).map(i => ({
        name: i.track.trackName || '', artists: [i.track.artistName || ''],
        album: i.track.albumName || '', uri: i.track.trackUri || '',
        image: null, duration_ms: null, preview_url: null, added_at: i.addedDate || null,
      }));
      library.playlists.push({ name: plName, items });
      found = true;
    }
  }

  if (!found) {
    err.textContent = '❌ Aucun fichier Spotify reconnu. Cherche YourLibrary.json et/ou PlaylistX.json dans le ZIP.';
    err.classList.remove('hidden');
    return;
  }

  launchApp();
  $('history-btn').classList.toggle('hidden', !streamingHistory.length);
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
  await enrichAudioFeatures(ids, uriMap);
}

async function enrichAudioFeatures(ids, uriMap) {
  try {
    const r = await fetch('/api/v1/tracks/audio-features', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) return;
    (await r.json()).forEach(f => {
      if (!f?.id) return;
      const t = uriMap[`spotify:track:${f.id}`] || uriMap[f.id];
      if (t) { t.energy = f.energy; t.danceability = f.danceability; t.valence = f.valence; t.tempo = f.tempo; }
    });
  } catch {}
}

// ── Recherche Spotify ─────────────────────────────────────────
let searchResults = [];

function openSearchModal() {
  $('search-modal').classList.remove('hidden');
  $('search-results').innerHTML = '';
  $('search-actions').classList.add('hidden');
  $('search-modal-input').value = '';
  setTimeout(() => $('search-modal-input').focus(), 60);
}

async function runSearch() {
  const q = $('search-modal-input').value.trim();
  if (!q) return;
  $('search-results').innerHTML = '<div class="empty-state">🔎 Recherche en cours…</div>';
  $('search-actions').classList.add('hidden');
  try {
    const headers = spotifyToken ? { 'Authorization': `Bearer ${spotifyToken}` } : {};
    const r = await fetch(`/api/v1/tracks/search?q=${encodeURIComponent(q)}&limit=20`, { headers });
    if (!r.ok) { const err = await r.json().catch(() => ({})); throw new Error(err.detail || `Erreur ${r.status}`); }
    searchResults = await r.json();
    renderSearchResults();
  } catch (e) {
    $('search-results').innerHTML = `<div class="empty-state">❌ ${e.message}</div>`;
  }
}

function renderSearchResults() {
  if (!searchResults.length) {
    $('search-results').innerHTML = '<div class="empty-state">Aucun résultat</div>'; return;
  }
  $('search-results').innerHTML = searchResults.map((t, i) => {
    const artists = (t.artists || []).join(', ');
    const color = cardColor(t.name + artists);
    return `<div class="search-result-row" data-idx="${i}">
      <input type="checkbox" class="search-check track-check" data-idx="${i}">
      <div class="track-img-wrap">
        ${t.image ? `<img class="track-img" src="${esc(t.image)}" alt="" loading="lazy">` : `<div class="track-placeholder" style="background:${color}">🎵</div>`}
      </div>
      <div style="flex:1;min-width:0">
        <div class="track-name">${esc(t.name)}</div>
        <div class="track-artist">${esc(artists)}</div>
      </div>
      <div class="track-col" style="font-size:.8rem;color:var(--muted)">${esc(t.album || '')}</div>
      <div class="track-dur"><span>${fmtDuration(t.duration_ms)}</span></div>
    </div>`;
  }).join('');

  $('search-results').querySelectorAll('.search-result-row').forEach(row => {
    const cb = row.querySelector('.search-check');
    row.addEventListener('click', e => { if (e.target === cb) return; cb.checked = !cb.checked; row.classList.toggle('selected', cb.checked); });
    cb.addEventListener('change', () => row.classList.toggle('selected', cb.checked));
  });
  $('search-actions').classList.remove('hidden');
}

function searchSelectAll() {
  const rows = $('search-results').querySelectorAll('.search-result-row');
  const allOn = [...rows].every(r => r.querySelector('.search-check').checked);
  rows.forEach(row => { const cb = row.querySelector('.search-check'); cb.checked = !allOn; row.classList.toggle('selected', !allOn); });
}

function addSearchToLibrary() {
  const checked = [...$('search-results').querySelectorAll('.search-check:checked')];
  if (!checked.length) { showToast('Sélectionne des titres d\'abord'); return; }
  const tracks = checked.map(cb => searchResults[parseInt(cb.dataset.idx)]);
  if (!library.liked) library.liked = [];
  const existing = new Set(library.liked.map(t => t.uri || t.id).filter(Boolean));
  const newTracks = tracks.filter(t => {
    const key = t.uri || t.id;
    return key && !existing.has(key);
  });
  library.liked.push(...newTracks);
  saveToStorage();
  if (!$('app-screen').classList.contains('hidden')) {
    allTracks = [...allTracks, ...newTracks];
    renderTracks(allTracks);
  } else {
    launchApp();
    renderTracks(library.liked);
  }
  $('search-modal').classList.add('hidden');
  showToast(`✅ ${newTracks.length} titre${newTracks.length > 1 ? 's' : ''} ajouté${newTracks.length > 1 ? 's' : ''} !`);
}

// ── Recommandations ──────────────────────────────────────────
let recoResults = [];

async function showRecommendations() {
  $('reco-modal').classList.remove('hidden');
  $('reco-results').innerHTML = '<div class="empty-state">✨ Analyse de ta bibliothèque…</div>';
  $('reco-actions').classList.add('hidden');

  const all = [...(library.liked||[]), ...library.playlists.flatMap(p => p.items)];
  if (!all.length) {
    $('reco-results').innerHTML = '<div class="empty-state">Ajoute d\'abord des titres à ta bibliothèque</div>';
    return;
  }

  // Top 5 artistes
  const artistCounts = {};
  all.forEach(t => (t.artists||[]).forEach(a => { if (a) artistCounts[a] = (artistCounts[a]||0)+1; }));
  const topArtists = Object.entries(artistCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(e=>e[0]);
  $('reco-subtitle').textContent = `Basé sur : ${topArtists.slice(0,3).join(', ')}…`;

  const existingIds = new Set(all.map(t => t.uri || t.id).filter(Boolean));
  recoResults = [];

  try {
    for (const artist of topArtists) {
      const r = await fetch(`/api/v1/tracks/search?q=${encodeURIComponent(artist)}&limit=8`,
        spotifyToken ? { headers: { 'Authorization': `Bearer ${spotifyToken}` } } : {});
      if (!r.ok) continue;
      const tracks = await r.json();
      tracks.forEach(t => {
        const key = t.uri || t.id;
        if (key && !existingIds.has(key) && !recoResults.find(r => (r.uri||r.id) === key)) {
          recoResults.push(t);
          existingIds.add(key);
        }
      });
    }
    // Mélange pour varier
    recoResults = recoResults.sort(() => Math.random() - 0.5).slice(0, 25);
    renderRecoResults();
  } catch(e) {
    $('reco-results').innerHTML = `<div class="empty-state">❌ ${e.message}</div>`;
  }
}

function renderRecoResults() {
  if (!recoResults.length) {
    $('reco-results').innerHTML = '<div class="empty-state">Aucune recommandation trouvée</div>';
    return;
  }
  $('reco-results').innerHTML = recoResults.map((t, i) => {
    const artists = (t.artists||[]).join(', ');
    const color = cardColor(t.name + artists);
    return `<div class="search-result-row" data-idx="${i}">
      <input type="checkbox" class="search-check reco-check" data-idx="${i}">
      <div class="track-img-wrap">
        ${t.image ? `<img class="track-img" src="${esc(t.image)}" alt="" loading="lazy">` : `<div class="track-placeholder" style="background:${color}">🎵</div>`}
      </div>
      <div style="flex:1;min-width:0">
        <div class="track-name">${esc(t.name)}</div>
        <div class="track-artist">${esc(artists)}</div>
      </div>
      <div class="track-col" style="font-size:.8rem;color:var(--muted)">${esc(t.album||'')}</div>
      <div class="track-dur"><span>${fmtDuration(t.duration_ms)}</span></div>
    </div>`;
  }).join('');
  $('reco-results').querySelectorAll('.search-result-row').forEach(row => {
    const cb = row.querySelector('.reco-check');
    row.addEventListener('click', e => { if (e.target === cb) return; cb.checked = !cb.checked; row.classList.toggle('selected', cb.checked); });
    cb.addEventListener('change', () => row.classList.toggle('selected', cb.checked));
  });
  $('reco-actions').classList.remove('hidden');
}

function recoSelectAll() {
  const rows = $('reco-results').querySelectorAll('.search-result-row');
  const allOn = [...rows].every(r => r.querySelector('.reco-check').checked);
  rows.forEach(row => { const cb = row.querySelector('.reco-check'); cb.checked = !allOn; row.classList.toggle('selected', !allOn); });
}

function addRecoToLibrary() {
  const checked = [...$('reco-results').querySelectorAll('.reco-check:checked')];
  if (!checked.length) { showToast('Sélectionne des titres d\'abord'); return; }
  const tracks = checked.map(cb => recoResults[parseInt(cb.dataset.idx)]);
  if (!library.liked) library.liked = [];
  const existing = new Set(library.liked.map(t => t.uri || t.id).filter(Boolean));
  const newTracks = tracks.filter(t => { const k = t.uri||t.id; return k && !existing.has(k); });
  library.liked.push(...newTracks);
  saveToStorage();
  allTracks = [...allTracks, ...newTracks];
  renderTracks(allTracks);
  $('reco-modal').classList.add('hidden');
  showToast(`✅ ${newTracks.length} titre${newTracks.length>1?'s':''} ajouté${newTracks.length>1?'s':''}  !`);
}

// ── Import Last.fm ───────────────────────────────────────────
async function importFromLastfm() {
  const username = prompt('Ton pseudo Last.fm :');
  if (!username?.trim()) return;
  showLoading('Récupération de ton historique Last.fm…');
  try {
    const [recentRes, topRes, lovedRes] = await Promise.all([
      fetch(`/api/v1/lastfm/recent?username=${encodeURIComponent(username)}&limit=500`),
      fetch(`/api/v1/lastfm/top-tracks?username=${encodeURIComponent(username)}&period=overall&limit=200`),
      fetch(`/api/v1/lastfm/loved?username=${encodeURIComponent(username)}&limit=200`),
    ]);
    if (!recentRes.ok) { const e = await recentRes.json().catch(()=>({})); throw new Error(e.detail || 'Pseudo introuvable'); }
    const recent = await recentRes.json();
    const top    = topRes.ok ? await topRes.json() : [];
    const loved  = lovedRes.ok ? await lovedRes.json() : [];

    // Merge unique tracks (recent + top + loved), prefer loved then top
    const seen = new Set();
    const merged = [];
    [...loved, ...top, ...recent].forEach(t => {
      const key = (t.name + '|' + (t.artists||[])[0]).toLowerCase();
      if (!seen.has(key)) { seen.add(key); merged.push(t); }
    });

    library = { liked: merged, playlists: [] };
    streamingHistory = [];
    saveToStorage();
    hideLoading();
    launchApp();
    renderTracks(library.liked);
    showToast(`✅ ${merged.length} titres importés depuis Last.fm !`);
    startLastfmAutoSync(username.trim());
  } catch(e) {
    hideLoading();
    alert('Erreur Last.fm : ' + e.message);
  }
}

// ── Import depuis Spotify ─────────────────────────────────────
let pendingSpotifyImport = false;

async function importFromSpotify() {
  if (!spotifyToken) {
    pendingSpotifyImport = true;
    connectSpotify();
    return;
  }
  pendingSpotifyImport = false;
  library = { liked: [], playlists: [] };
  streamingHistory = [];

  try {
    showLoading('Récupération des titres likés…');
    const likedR = await fetch('/api/v1/tracks/liked', { headers: { 'Authorization': `Bearer ${spotifyToken}` } });
    if (!likedR.ok) { const e = await likedR.json().catch(()=>({})); throw new Error(e.detail || `Liked: ${likedR.status}`); }
    library.liked = await likedR.json();
    updateLoadingProgress(20, 100, `${library.liked.length} titres likés`);

    const plR = await fetch('/api/v1/playlists/', { headers: { 'Authorization': `Bearer ${spotifyToken}` } });
    if (!plR.ok) { const e = await plR.json().catch(()=>({})); throw new Error(e.detail || `Playlists: ${plR.status}`); }
    const playlists = await plR.json();
    updateLoadingProgress(30, 100, `${playlists.length} playlists trouvées`);

    for (let i = 0; i < playlists.length; i++) {
      const pl = playlists[i];
      updateLoadingProgress(30 + Math.round(i / Math.max(playlists.length, 1) * 65), 100,
        `Playlist ${i + 1}/${playlists.length} : ${pl.name}`);
      try {
        const tR = await fetch(`/api/v1/playlists/${pl.id}/tracks`, { headers: { 'Authorization': `Bearer ${spotifyToken}` } });
        const tracks = tR.ok ? await tR.json() : [];
        if (tracks.length) library.playlists.push({ name: pl.name, items: tracks });
      } catch {}
    }

    hideLoading();
    launchApp();
    $('history-btn').classList.add('hidden');
    saveToStorage();

    const allFlat = [...library.liked, ...library.playlists.flatMap(p => p.items)];
    const uriMap = {};
    allFlat.forEach(t => { if (t.uri) uriMap[t.uri] = t; });
    const ids = [...new Set(allFlat.map(t => t.uri).filter(u => u?.startsWith('spotify:track:')).map(u => u.split(':')[2]))];
    await enrichAudioFeatures(ids, uriMap);
    saveToStorage();
    renderTracks(library.liked.length ? library.liked : allFlat);
    showToast(`✅ ${allFlat.length} titres importés depuis Spotify !`);
  } catch (e) {
    hideLoading();
    alert('Erreur import Spotify : ' + e.message);
  }
}

// ── Demo Mode ─────────────────────────────────────────────────
function loadDemoData() {
  const demo = (name, artist, album, energy, valence, dance, tempo, img) => ({
    name, artists:[artist], album, uri:`spotify:track:demo_${name.replace(/\s/g,'_')}`,
    image: img||null, duration_ms: Math.floor(Math.random()*90000)+150000,
    preview_url: null, added_at: `202${Math.floor(Math.random()*4)+1}-0${Math.floor(Math.random()*9)+1}-${String(Math.floor(Math.random()*28)+1).padStart(2,'0')}`,
    energy, valence, danceability:dance, tempo,
  });

  const liked = [
    demo('Blinding Lights','The Weeknd','After Hours',0.73,0.33,0.51,171,'https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36'),
    demo('As It Was','Harry Styles','Harry\'s House',0.73,0.66,0.52,174,'https://i.scdn.co/image/ab67616d0000b273b46f74e1bb6e7e0cbf8d6c98'),
    demo('Starboy','The Weeknd','Starboy',0.59,0.46,0.68,186,'https://i.scdn.co/image/ab67616d0000b2734718e2b124f79258be7bc452'),
    demo('Golden Hour','JVKE','this is what ____ feels like',0.63,0.92,0.60,97),
    demo('Levitating','Dua Lipa','Future Nostalgia',0.83,0.92,0.70,103,'https://i.scdn.co/image/ab67616d0000b273bd26ede1ae69327010d49946'),
    demo('Heat Waves','Glass Animals','Dreamland',0.54,0.34,0.59,80),
    demo('Stay','The Kid LAROI','F*CK LOVE 3',0.62,0.64,0.79,170),
    demo('Circles','Post Malone','Hollywood\'s Bleeding',0.69,0.76,0.69,121),
    demo('Peaches','Justin Bieber','Justice',0.62,0.71,0.66,90),
    demo('Ghost','Justin Bieber','Justice',0.48,0.41,0.55,130),
    demo('SAD!','XXXTENTACION','?',0.57,0.24,0.75,75),
    demo('Rockstar','Post Malone','Beerbongs & Bentleys',0.54,0.18,0.53,79),
    demo('Sunflower','Post Malone','Spider-Man: Into the Spider-Verse',0.77,0.91,0.77,95,'https://i.scdn.co/image/ab67616d0000b273e2e352d89826aef6dbd5ff8f'),
    demo('Dark Horse','Katy Perry','PRISM',0.63,0.55,0.63,132),
    demo('Smells Like Teen Spirit','Nirvana','Nevermind',0.90,0.61,0.49,117,'https://i.scdn.co/image/ab67616d0000b273e175a19e530c898d167d39bf'),
    demo('Bohemian Rhapsody','Queen','A Night at the Opera',0.40,0.23,0.22,72,'https://i.scdn.co/image/ab67616d0000b2733e95a2a38f4b5de2dd4da793'),
    demo('Hotel California','Eagles','Hotel California',0.50,0.53,0.40,75),
    demo('Mr. Brightside','The Killers','Hot Fuss',0.89,0.67,0.33,148),
    demo('Somebody That I Used to Know','Gotye','Making Mirrors',0.64,0.32,0.48,129),
    demo('Uptown Funk','Mark Ronson','Uptown Special',0.93,0.96,0.85,115,'https://i.scdn.co/image/ab67616d0000b273e419ccba0baa8bd3f3d7abf2'),
    demo('Happy','Pharrell Williams','G I R L',0.85,0.96,0.74,160,'https://i.scdn.co/image/ab67616d0000b2730ede6a8e2e2d30b3fa2ab1ec'),
    demo('Shape of You','Ed Sheeran','÷',0.82,0.93,0.83,96,'https://i.scdn.co/image/ab67616d0000b273ba5db46f4b838ef6027e6f96'),
    demo('Perfect','Ed Sheeran','÷',0.43,0.56,0.33,95),
    demo('Someone Like You','Adele','21',0.15,0.20,0.28,67,'https://i.scdn.co/image/ab67616d0000b2732118bf9b198b05a95ded6300'),
    demo('Rolling in the Deep','Adele','21',0.84,0.61,0.73,105),
    demo('Lose Yourself','Eminem','8 Mile',0.70,0.28,0.71,171),
    demo('Rap God','Eminem','The Marshall Mathers LP2',0.65,0.36,0.89,77),
    demo('God\'s Plan','Drake','Scorpion',0.44,0.31,0.75,77,'https://i.scdn.co/image/ab67616d0000b2739416ed64daf84936d89e671c'),
    demo('Hotline Bling','Drake','Views',0.63,0.60,0.68,135),
    demo('HUMBLE.','Kendrick Lamar','DAMN.',0.90,0.42,0.73,150),
  ];

  const playlists = [
    {
      name: '🔥 Workout',
      items: liked.filter(t => t.energy >= 0.7).concat([
        demo('Eye of the Tiger','Survivor','Eye of the Tiger',0.90,0.81,0.52,109),
        demo('Stronger','Kanye West','Graduation',0.88,0.49,0.72,104),
      ]),
    },
    {
      name: '😌 Chill Vibes',
      items: liked.filter(t => t.energy <= 0.55).concat([
        demo('Heather','Conan Gray','Kid Krow',0.21,0.27,0.40,92),
        demo('Coffee','beabadoobee','Fake It Flowers',0.55,0.67,0.61,148),
      ]),
    },
    {
      name: '🎉 Party',
      items: liked.filter(t => t.danceability >= 0.70),
    },
  ];

  const fakeHistory = liked.flatMap(t => {
    const plays = Math.floor(Math.random() * 40) + 1;
    return Array(plays).fill(null).map(() => ({
      ts: new Date(Date.now() - Math.random()*3*365*24*3600000).toISOString(),
      ms_played: Math.random() > 0.15 ? t.duration_ms : Math.floor(t.duration_ms * Math.random() * 0.4),
      master_metadata_track_name: t.name,
      master_metadata_album_artist_name: t.artists[0],
      master_metadata_album_album_name: t.album,
      spotify_track_uri: t.uri,
      skipped: Math.random() < 0.12,
    }));
  });

  library = { liked, playlists };
  streamingHistory = fakeHistory;
  saveToStorage();
  launchApp();
  $('history-btn').classList.remove('hidden');
  renderTracks(liked);
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

  // Section artistes
  const allForArtists = [...library.liked, ...library.playlists.flatMap(p => p.items)];
  const artistMap = {};
  allForArtists.forEach(t => (t.artists||[]).forEach(a => { if (a) { if (!artistMap[a]) artistMap[a] = []; artistMap[a].push(t); } }));
  const topArtistEntries = Object.entries(artistMap).sort((a,b)=>b[1].length-a[1].length).slice(0,15);
  if (topArtistEntries.length) {
    const artistSep = document.createElement('div');
    artistSep.className = 'sidebar-title'; artistSep.style.padding = '12px 16px 6px'; artistSep.textContent = 'Artistes';
    list.appendChild(artistSep);
    topArtistEntries.forEach(([artist, tracks]) => {
      const btn = makeSrcBtn('🎤', artist, tracks.length);
      btn.addEventListener('click', () => { setActive(btn); loadSource(artist, tracks); });
      list.appendChild(btn);
    });
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

let fusionData = { tracks: [], labels: [] };

function fusionPlaylists() {
  const checked = document.querySelectorAll('.fusion-check:checked');
  const names = [...checked].map(cb => cb.dataset.name);
  fusionData = { tracks: [], labels: [] };
  library.playlists.forEach(pl => {
    if (names.includes(pl.name)) { fusionData.tracks.push(...pl.items); fusionData.labels.push(pl.name); }
  });
  const defaultName = fusionData.labels.join(' + ').slice(0, 100);
  const total = fusionData.tracks.length;
  const dups = countDups(fusionData.tracks);
  $('fusion-modal-info').textContent = `${fusionData.labels.length} playlists · ${total} titres · ${dups} doublon${dups!==1?'s':''}`;
  $('fusion-pl-name').value = defaultName;
  $('fusion-result').innerHTML = '';
  $('fusion-modal').classList.remove('hidden');
  setTimeout(() => $('fusion-pl-name').focus(), 60);
}

function getFusionTracks() {
  let tracks = [...fusionData.tracks];
  if ($('fusion-dedup').checked) {
    const seen = new Set();
    tracks = tracks.filter(t => {
      const k = t.uri || `${t.name}|${(t.artists||[]).join()}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }
  return tracks;
}

function fusionViewOnly() {
  const tracks = getFusionTracks();
  const label = $('fusion-pl-name').value.trim() || fusionData.labels.join(' + ');
  loadSource(label, tracks);
  $('fusion-modal').classList.add('hidden');
  document.querySelectorAll('.fusion-check:checked').forEach(cb => { cb.checked = false; });
  updateFusionBtn();
}

async function fusionToSpotify() {
  if (!spotifyToken) { alert('Connecte-toi à Spotify d\'abord (bouton 🎵 Spotify en haut).'); return; }
  const name = $('fusion-pl-name').value.trim();
  if (!name) { $('fusion-pl-name').focus(); return; }
  const tracks = getFusionTracks();
  const uris = tracks.map(t => t.uri).filter(u => u && u.startsWith('spotify:track:'));
  if (!uris.length) { alert('Aucun URI Spotify valide dans ces playlists.'); return; }

  const btn = $('fusion-spotify-btn');
  btn.textContent = 'Création…'; btn.disabled = true;
  $('fusion-result').innerHTML = '';
  try {
    const r = await fetch('/api/v1/playlists/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${spotifyToken}` },
      body: JSON.stringify({ name, description: `Fusionnée avec Vibify — ${uris.length} titres`, track_uris: uris }),
    });
    if (r.ok) {
      const data = await r.json();
      $('fusion-result').innerHTML = `<div class="create-pl-success">✅ Playlist créée ! <a href="${esc(data.url)}" target="_blank" class="open-spotify-btn" style="opacity:1">Ouvrir dans Spotify ↗</a></div>`;
      fusionViewOnly();
    } else {
      const err = await r.json().catch(() => ({}));
      $('fusion-result').innerHTML = `<p style="color:#ff6b6b;font-size:.85rem">❌ ${err.detail || 'Erreur Spotify'}</p>`;
    }
  } catch (e) {
    $('fusion-result').innerHTML = `<p style="color:#ff6b6b;font-size:.85rem">❌ ${e.message}</p>`;
  } finally { btn.textContent = '🎵 Créer sur Spotify'; btn.disabled = false; }
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
      const cardTagChips = getTagsFor(t.uri).map(tag => `<span class="tag-chip">${esc(tag)}</span>`).join('');
      card.innerHTML = `
        <div class="card-art" style="background:${color}">
          <input type="checkbox" class="card-check track-check" data-uri="${esc(t.uri)}">
          ${artContent}
          ${t.preview_url ? '<button class="card-play-btn" title="Aperçu 30s">▶</button>' : ''}
        </div>
        <div class="card-body">
          <div class="card-name" title="${esc(t.name)}">${esc(t.name)}</div>
          <div class="card-artist">${esc(artists)}</div>
          ${starsHtml(t.uri)}
          ${t.duration_ms ? `<div class="card-dur">${fmtDuration(t.duration_ms)}${t.tempo ? ` · <span class="bpm-badge">${Math.round(t.tempo)}</span>` : ''}</div>` : ''}
          <div class="card-tags" data-uri="${esc(t.uri)}"><button class="tag-edit-btn" title="Tags">🏷️</button>${cardTagChips}</div>
          ${cid ? `<a class="card-spotify-link" href="https://open.spotify.com/track/${esc(cid)}" target="_blank">↗ Spotify</a>` : ''}
        </div>`;
      attachToggle(card, card.querySelector('.track-check'), t);
      const cpb = t.preview_url ? card.querySelector('.card-play-btn') : null;
      if (cpb) cpb.addEventListener('click', e => { e.stopPropagation(); playPreview(t.preview_url, cpb, card, t); });
      const csl = card.querySelector('.card-spotify-link');
      if (csl) csl.addEventListener('click', e => e.stopPropagation());
      card.querySelector('.tag-edit-btn').addEventListener('click', e => { e.stopPropagation(); showTagModal(t.uri, t.name); });
      attachStars(card);
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
      const rowTags = getTagsFor(t.uri).map(tag => `<span class="tag-chip">${esc(tag)}</span>`).join('');
      row.innerHTML = `
        <input type="checkbox" class="track-check" data-uri="${esc(t.uri)}">
        <div class="track-img-wrap">
          ${imgHtml}
          ${t.preview_url ? '<button class="preview-play-btn" title="Aperçu 30s">▶</button>' : ''}
        </div>
        <div>
          <div class="track-name" title="${esc(t.name)}">${esc(t.name)}</div>
          <div class="track-artist">${esc(artists)}</div>
          <div class="track-tags" data-uri="${esc(t.uri)}"><button class="tag-edit-btn" title="Tags">🏷️</button>${rowTags}</div>
          ${starsHtml(t.uri)}
        </div>
        <div class="track-col" title="${esc(t.album)}">${esc(t.album)}</div>
        <div class="track-col">${esc(artists)}</div>
        <div class="track-dur">
          <div class="dur-main">
            <span>${fmtDuration(t.duration_ms)}</span>
            ${t.tempo ? `<span class="bpm-badge">${Math.round(t.tempo)}</span>` : ''}
            <button class="where-btn" data-uri="${esc(t.uri)}" data-name="${esc(t.name)}" title="Où est ce titre ?">📋</button>
            ${id ? `<a class="open-spotify-btn" href="https://open.spotify.com/track/${esc(id)}" target="_blank" title="Ouvrir dans Spotify">↗</a>` : ''}
          </div>
          ${t.energy != null ? `<div class="energy-bar-wrap" title="Énergie: ${Math.round(t.energy*100)}%"><div class="energy-bar" style="width:${Math.round(t.energy*100)}%"></div></div>` : ''}
        </div>`;
      attachToggle(row, row.querySelector('.track-check'), t);
      const pb = t.preview_url ? row.querySelector('.preview-play-btn') : null;
      if (pb) pb.addEventListener('click', e => { e.stopPropagation(); playPreview(t.preview_url, pb, row, t); });
      const sl = row.querySelector('.open-spotify-btn');
      if (sl) sl.addEventListener('click', e => e.stopPropagation());
      row.querySelector('.tag-edit-btn').addEventListener('click', e => { e.stopPropagation(); showTagModal(t.uri, t.name); });
      attachStars(row);
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
    $('float-create-btn').classList.toggle('hidden', !(spotifyToken && spotifyUser));
  } else {
    bar.classList.remove('visible');
    $('float-create-btn').classList.add('hidden');
  }
}

let miniPlayerTimer = null;

function playPreview(url, btn, row, track) {
  if (currentAudio) {
    currentAudio.pause();
    if (currentPlayBtn) currentPlayBtn.textContent = '▶';
    currentPlayBtn?.closest('.track-row')?.classList.remove('playing');
    currentPlayBtn?.closest('.track-card')?.classList.remove('playing');
    const wasBtn = currentPlayBtn;
    currentAudio = null; currentPlayBtn = null;
    if (wasBtn === btn) { hideMiniPlayer(); return; }
  }
  currentAudio = new Audio(url);
  currentPlayBtn = btn;
  btn.textContent = '⏸';
  row?.classList.add('playing');
  showMiniPlayer(track);
  currentAudio.play().catch(() => {});
  currentAudio.addEventListener('timeupdate', () => {
    const pct = currentAudio.duration ? (currentAudio.currentTime / currentAudio.duration * 100) : 0;
    $('mini-player-progress').style.width = pct + '%';
  });
  currentAudio.addEventListener('ended', () => {
    btn.textContent = '▶';
    row?.classList.remove('playing');
    currentAudio = null; currentPlayBtn = null;
    hideMiniPlayer();
  });
}

function showMiniPlayer(track) {
  const img = $('mini-player-img');
  const ph  = $('mini-player-placeholder');
  if (track?.image) { img.src = track.image; img.classList.remove('hidden'); ph.classList.add('hidden'); }
  else              { img.classList.add('hidden'); ph.classList.remove('hidden'); }
  $('mini-player-name').textContent   = track?.name || '';
  $('mini-player-artist').textContent = (track?.artists||[]).join(', ');
  $('mini-player-progress').style.width = '0%';
  $('mini-player').classList.remove('hidden');
  fetchAndShowLyrics(track);
}

function hideMiniPlayer() {
  $('mini-player').classList.add('hidden');
  $('mini-player-progress').style.width = '0%';
  $('lyrics-panel').classList.add('hidden');
  currentLyricsTrack = null;
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

  const selectedTag  = $('tag-select').value;
  const decade       = $('decade-select').value;
  const selectedYear = $('year-select').value;
  const minRating    = parseInt($('rating-select').value || '0');
  const mood         = $('mood-select').value;
  let tracks = [...allTracks];
  if (query) tracks = tracks.filter(t =>
    (t.name || '').toLowerCase().includes(query) ||
    (t.artists || []).join(' ').toLowerCase().includes(query) ||
    (t.album || '').toLowerCase().includes(query)
  );
  if (selectedTag)  tracks = tracks.filter(t => getTagsFor(t.uri).includes(selectedTag));
  if (decade) { const d = parseInt(decade); tracks = tracks.filter(t => { const y = parseInt((t.added_at||'').slice(0,4)); return y >= d && y < d+10; }); }
  if (selectedYear) tracks = tracks.filter(t => (t.added_at || '').startsWith(selectedYear));
  if (minRating)    tracks = tracks.filter(t => getRating(t.uri) >= minRating);
  if (mood === 'energique')    tracks = tracks.filter(t => t.energy != null && t.energy >= 0.7);
  if (mood === 'calme')        tracks = tracks.filter(t => t.energy != null && t.energy <= 0.4);
  if (mood === 'dansant')      tracks = tracks.filter(t => t.danceability != null && t.danceability >= 0.7);
  if (mood === 'melancolique') tracks = tracks.filter(t => t.valence != null && t.valence <= 0.4);
  if (mood === 'positif')      tracks = tracks.filter(t => t.valence != null && t.valence >= 0.7);
  if (by) tracks.sort((a, b) => {
    let va = '', vb = '';
    if (by === 'artist')       { va = (a.artists||[]).join().toLowerCase(); vb = (b.artists||[]).join().toLowerCase(); }
    else if (by === 'name')    { va = (a.name||'').toLowerCase(); vb = (b.name||'').toLowerCase(); }
    else if (by === 'album')   { va = (a.album||'').toLowerCase(); vb = (b.album||'').toLowerCase(); }
    else if (by === 'duration_ms') { va = a.duration_ms||0; vb = b.duration_ms||0; }
    else if (by === 'added_at')    { va = a.added_at||''; vb = b.added_at||''; }
    else if (by === 'rating')  { va = getRating(a.uri); vb = getRating(b.uri); }
    else if (by === 'energy')  { va = a.energy||0; vb = b.energy||0; }
    else if (by === 'tempo')   { va = a.tempo||0; vb = b.tempo||0; }
    return va < vb ? -order : va > vb ? order : 0;
  });
  renderTracks(tracks);
}

function resetFilters() {
  $('sort-by').value = ''; $('sort-order').value = 'asc';
  $('search-input').value = ''; $('artist-select').value = ''; $('album-select').value = '';
  $('tag-select').value=''; $('year-select').value=''; $('rating-select').value=''; $('mood-select').value=''; $('decade-select').value='';
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
  const years = [...new Set(allTracks.map(t => (t.added_at||'').slice(0,4)).filter(y => /^\d{4}$/.test(y)))].sort().reverse();
  $('year-select').innerHTML = '<option value="">📅 Année…</option>' +
    years.map(y => `<option value="${y}">${y}</option>`).join('');
  updateTagSelect();
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

  $('stats-body').innerHTML = generateMusicProfile(all) + `
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
    </div>` : ''}
    ${(() => {
      // Top albums
      const albumCounts = {};
      all.forEach(t => { if (t.album) albumCounts[t.album] = (albumCounts[t.album]||0)+1; });
      const topAlbums = Object.entries(albumCounts).sort((a,b)=>b[1]-a[1]).slice(0,6);
      const maxA = topAlbums[0]?.[1] || 1;
      if (!topAlbums.length) return '';
      return `<div class="stat-section-title" style="margin-top:14px">Top albums</div>
      <div class="top-list">
        ${topAlbums.map(([a,n])=>`
          <div class="top-row">
            <span class="top-name">${esc(a)}</span>
            <div class="top-bar-wrap"><div class="top-bar" style="width:${Math.round(n/maxA*100)}%;background:#a78bfa"></div></div>
            <span class="top-count">${n} titre${n>1?'s':''}</span>
          </div>`).join('')}
      </div>`;
    })()}
    ${(() => {
      // Decade distribution
      const decades = {};
      all.forEach(t => {
        const y = parseInt((t.added_at||'').slice(0,4));
        if (y >= 1950) { const d = Math.floor(y/10)*10; decades[d] = (decades[d]||0)+1; }
      });
      const entries = Object.entries(decades).sort((a,b)=>a[0]-b[0]);
      if (!entries.length) return '';
      const maxD = Math.max(...entries.map(e=>e[1]));
      return `<div class="stat-section-title" style="margin-top:14px">Répartition par décennie</div>
      <div class="top-list">
        ${entries.map(([d,n])=>`
          <div class="top-row">
            <span class="top-name">${d}s</span>
            <div class="top-bar-wrap"><div class="top-bar" style="width:${Math.round(n/maxD*100)}%;background:#60a5fa"></div></div>
            <span class="top-count">${n}</span>
          </div>`).join('')}
      </div>`;
    })()}
    ${(() => {
      // Ratings distribution
      const rated = all.filter(t => t.uri && trackRatings[t.uri]);
      if (!rated.length) return '';
      const dist = {1:0,2:0,3:0,4:0,5:0};
      rated.forEach(t => dist[trackRatings[t.uri]]++);
      const maxR = Math.max(...Object.values(dist));
      return `<div class="stat-section-title" style="margin-top:14px">Distribution des notes (${rated.length} notés)</div>
      <div class="top-list">
        ${[5,4,3,2,1].map(s=>`
          <div class="top-row">
            <span class="top-name">${'★'.repeat(s)}${'☆'.repeat(5-s)}</span>
            <div class="top-bar-wrap"><div class="top-bar" style="width:${maxR?Math.round(dist[s]/maxR*100):0}%;background:#fbbf24"></div></div>
            <span class="top-count">${dist[s]}</span>
          </div>`).join('')}
      </div>`;
    })()}
    ${(() => {
      // Mood breakdown
      const wf = all.filter(t => t.energy != null);
      if (!wf.length) return '';
      const moods = { '⚡ Énergique': 0, '😌 Calme': 0, '💃 Dansant': 0, '😢 Mélancolique': 0, '😊 Positif': 0 };
      wf.forEach(t => {
        if (t.energy > 0.65 && t.valence > 0.55) moods['⚡ Énergique']++;
        else if (t.energy <= 0.4 && t.valence <= 0.4) moods['😢 Mélancolique']++;
        else if (t.danceability > 0.7) moods['💃 Dansant']++;
        else if (t.energy <= 0.4) moods['😌 Calme']++;
        else moods['😊 Positif']++;
      });
      const maxM = Math.max(...Object.values(moods));
      const colors = {'⚡ Énergique':'#ff6b6b','😌 Calme':'#60a5fa','💃 Dansant':'#a78bfa','😢 Mélancolique':'#94a3b8','😊 Positif':'#fbbf24'};
      return `<div class="stat-section-title" style="margin-top:14px">Répartition des humeurs</div>
      <div class="top-list">
        ${Object.entries(moods).map(([m,n])=>`
          <div class="top-row">
            <span class="top-name">${m}</span>
            <div class="top-bar-wrap"><div class="top-bar" style="width:${Math.round(n/maxM*100)}%;background:${colors[m]}"></div></div>
            <span class="top-count">${n}</span>
          </div>`).join('')}
      </div>`;
    })()}`;
  $('stats-modal').classList.remove('hidden');
}

// ── DJ Mode ───────────────────────────────────────────────────
let djQueue = [], djIndex = -1, djAudio = null, djPlaying = false;
let djProgressTimer = null, djCrossfadeStarted = false;

function addToDjQueue() {
  const tracks = (currentFiltered.length ? currentFiltered : allTracks)
    .filter(t => selectedUris.has(t.uri) && t.preview_url);
  if (!tracks.length) {
    alert('Aucun titre sélectionné n\'a de preview Spotify disponible.\nEnrichis ta bibliothèque d\'abord.'); return;
  }
  const wasEmpty = !djQueue.length;
  djQueue.push(...tracks);
  renderDjQueue();
  if (wasEmpty) { djIndex = 0; djShowPlayer(); djPlayCurrent(); }
  else djShowPlayer();
}

function djShowPlayer() {
  $('dj-player').classList.remove('hidden');
  document.body.classList.add('dj-active');
}

function djHidePlayer() {
  if (djAudio) { djAudio.pause(); djAudio = null; }
  clearInterval(djProgressTimer);
  djPlaying = false; djQueue = []; djIndex = -1; djCrossfadeStarted = false;
  $('dj-player').classList.add('hidden');
  $('dj-queue-panel').classList.add('hidden');
  document.body.classList.remove('dj-active');
}

function djPlayCurrent() {
  if (djIndex < 0 || djIndex >= djQueue.length) return;
  const t = djQueue[djIndex];
  if (!t.preview_url) { djNext(); return; }

  if (djAudio) { djAudio.pause(); djAudio = null; }
  clearInterval(djProgressTimer);
  djCrossfadeStarted = false;

  djAudio = new Audio(t.preview_url);
  djAudio.volume = 0;
  djPlaying = true;

  $('dj-title').textContent  = t.name;
  $('dj-artist').textContent = (t.artists||[]).join(', ');
  $('dj-art').src = t.image || '';
  $('dj-art-wrap').style.background = t.image ? 'transparent' : cardColor(t.name);
  $('dj-play-btn').textContent = '⏸';
  $('dj-count').textContent = `${djIndex+1} / ${djQueue.length}`;

  djAudio.play().catch(() => djNext());
  djFade(djAudio, 0, 1, 900);

  djProgressTimer = setInterval(() => {
    if (!djAudio) return;
    const cur = djAudio.currentTime, dur = djAudio.duration || 30;
    $('dj-progress-fill').style.width = (cur/dur*100) + '%';
    $('dj-time').textContent     = fmtDuration(cur*1000);
    $('dj-duration').textContent = fmtDuration(dur*1000);
    if (dur - cur < 3 && !djCrossfadeStarted && djIndex+1 < djQueue.length) {
      djCrossfadeStarted = true;
      djFade(djAudio, djAudio.volume, 0, 2500);
      setTimeout(djNext, 1800);
    }
  }, 200);

  djAudio.addEventListener('ended', () => { if (!djCrossfadeStarted) djNext(); });
  renderDjQueue();
}

function djFade(audio, from, to, ms) {
  const steps = 20, dt = ms/steps, dv = (to-from)/steps;
  let i = 0;
  const id = setInterval(() => {
    if (!audio) { clearInterval(id); return; }
    audio.volume = Math.max(0, Math.min(1, from + dv * ++i));
    if (i >= steps) clearInterval(id);
  }, dt);
}

function djTogglePlay() {
  if (!djAudio) { djPlayCurrent(); return; }
  if (djPlaying) { djAudio.pause(); djPlaying = false; $('dj-play-btn').textContent = '▶'; }
  else           { djAudio.play();  djPlaying = true;  $('dj-play-btn').textContent = '⏸'; }
}

function djNext() {
  djCrossfadeStarted = false;
  if (djIndex < djQueue.length-1) { djIndex++; djPlayCurrent(); }
  else {
    djPlaying = false; $('dj-play-btn').textContent = '▶';
    clearInterval(djProgressTimer);
    $('dj-progress-fill').style.width = '100%';
  }
}

function djPrev() {
  djCrossfadeStarted = false;
  if (djAudio && djAudio.currentTime > 3) { djAudio.currentTime = 0; return; }
  if (djIndex > 0) { djIndex--; djPlayCurrent(); }
}

function djSeek(e) {
  if (!djAudio) return;
  const bar = $('dj-progress-bar');
  const ratio = e.offsetX / bar.offsetWidth;
  djAudio.currentTime = ratio * (djAudio.duration || 30);
}

function djShuffleQueue() {
  const cur = djQueue[djIndex];
  const rest = djQueue.filter((_,i) => i !== djIndex);
  for (let i = rest.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [rest[i],rest[j]]=[rest[j],rest[i]]; }
  djQueue = cur ? [cur, ...rest] : rest;
  djIndex = cur ? 0 : -1;
  renderDjQueue();
}

function renderDjQueue() {
  const list = $('dj-queue-list');
  if (!list) return;
  list.innerHTML = djQueue.map((t, i) => `
    <div class="dj-queue-item${i===djIndex?' dj-current':''}" data-idx="${i}">
      <div class="dj-queue-art" style="background:${cardColor(t.name)}">
        ${t.image ? `<img src="${esc(t.image)}" alt="">` : '🎵'}
      </div>
      <div class="dj-queue-text">
        <div class="dj-queue-name">${esc(t.name)}</div>
        <div class="dj-queue-artist">${esc((t.artists||[]).join(', '))}</div>
      </div>
      ${i===djIndex ? '<span class="dj-now">▶</span>' : `<button class="dj-rm-btn" data-idx="${i}">✕</button>`}
    </div>`).join('') || '<div style="padding:24px;color:var(--muted);text-align:center">File vide</div>';

  list.querySelectorAll('.dj-queue-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.dj-rm-btn')) return;
      djIndex = parseInt(item.dataset.idx);
      djCrossfadeStarted = false;
      djPlayCurrent();
    });
  });
  list.querySelectorAll('.dj-rm-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      djQueue.splice(idx, 1);
      if (idx < djIndex) djIndex--;
      else if (idx === djIndex && djPlaying) djPlayCurrent();
      $('dj-count').textContent = `${djIndex+1} / ${djQueue.length}`;
      renderDjQueue();
    });
  });
}

// ── Quiz ──────────────────────────────────────────────────────
let quizTracks = [], quizIndex = 0, quizScore = 0, quizTimerRef = null;

function startQuiz() {
  const pool = (currentFiltered.length ? currentFiltered : allTracks).filter(t => t.image && t.uri);
  if (pool.length < 4) { alert('Minimum 4 titres avec pochette — charge ta bibliothèque ou utilise le mode démo.'); return; }
  quizTracks = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.min(10, pool.length));
  quizIndex = 0; quizScore = 0;
  $('quiz-modal').classList.remove('hidden');
  showQuizQuestion();
}

function showQuizQuestion() {
  clearTimeout(quizTimerRef);
  if (quizIndex >= quizTracks.length) { showQuizResult(); return; }
  const t = quizTracks[quizIndex];
  const pool = (currentFiltered.length ? currentFiltered : allTracks).filter(x => x.uri !== t.uri);
  const wrong = [...pool].sort(() => Math.random() - 0.5).slice(0, 3);
  const choices = [...wrong, t].sort(() => Math.random() - 0.5);

  $('quiz-progress').textContent = `Question ${quizIndex + 1} / ${quizTracks.length}`;
  $('quiz-score-display').textContent = `${quizScore} pts`;
  $('quiz-content').innerHTML = `
    <div class="quiz-art-wrap"><img id="quiz-art" class="quiz-art quiz-blurred" src="${esc(t.image)}" alt=""></div>
    <p class="quiz-question">Quel est ce titre ?</p>
    <div class="quiz-choices">
      ${choices.map(c => `<button class="quiz-choice" data-uri="${esc(c.uri)}" data-correct="${c.uri === t.uri}">
        <span class="quiz-choice-name">${esc(c.name)}</span>
        <span class="quiz-choice-artist">${esc((c.artists||[]).join(', '))}</span>
      </button>`).join('')}
    </div>`;

  $('quiz-timer-fill').style.transition = 'none';
  $('quiz-timer-fill').style.width = '100%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $('quiz-timer-fill').style.transition = 'width 10s linear';
    $('quiz-timer-fill').style.width = '0%';
  }));
  quizTimerRef = setTimeout(() => resolveQuiz(null, t), 10000);

  $('quiz-content').querySelectorAll('.quiz-choice').forEach(btn => {
    btn.addEventListener('click', () => resolveQuiz(btn.dataset.uri, t));
  });
}

function resolveQuiz(uri, correct) {
  clearTimeout(quizTimerRef);
  $('quiz-art')?.classList.remove('quiz-blurred');
  if (uri === correct.uri) quizScore += 100;
  $('quiz-content').querySelectorAll('.quiz-choice').forEach(btn => {
    btn.disabled = true;
    if (btn.dataset.correct === 'true') btn.classList.add('quiz-correct');
    else if (btn.dataset.uri === uri) btn.classList.add('quiz-wrong');
  });
  setTimeout(() => { quizIndex++; showQuizQuestion(); }, 1600);
}

function showQuizResult() {
  const pct = Math.round(quizScore / (quizTracks.length * 100) * 100);
  const emoji = pct >= 90?'🏆':pct>=70?'🎉':pct>=50?'😊':pct>=30?'😅':'😬';
  $('quiz-content').innerHTML = `
    <div class="quiz-result">
      <div class="quiz-result-emoji">${emoji}</div>
      <div class="quiz-result-score">${quizScore} <span>/ ${quizTracks.length * 100}</span></div>
      <div class="quiz-result-pct">${pct}% de bonnes réponses</div>
      <div class="quiz-result-msg">${pct>=80?'Tu connais vraiment bien ta musique !':pct>=50?'Pas mal, mais tu peux faire mieux !':'Tu découvres encore ta propre lib 😄'}</div>
      <button id="quiz-restart-btn" class="btn-primary">🔄 Rejouer</button>
    </div>`;
  $('quiz-restart-btn').addEventListener('click', startQuiz);
}

// ── Roulette ──────────────────────────────────────────────────
let currentRoulette = null;

function spinRoulette() {
  const tracks = currentFiltered.length ? currentFiltered : allTracks;
  if (!tracks.length) return;
  currentRoulette = tracks[Math.floor(Math.random() * tracks.length)];
  renderRoulette();
  $('roulette-modal').classList.remove('hidden');
}

function renderRoulette() {
  const t = currentRoulette;
  const artists = (t.artists||[]).join(', ');
  $('roulette-content').innerHTML = `
    <div class="roulette-art" style="background:${cardColor(t.name)}">
      ${t.image ? `<img src="${esc(t.image)}" alt="">` : '<span>🎵</span>'}
    </div>
    <div class="roulette-name">${esc(t.name)}</div>
    <div class="roulette-artist">${esc(artists)}</div>
    ${t.album ? `<div class="roulette-album">${esc(t.album)}</div>` : ''}
    ${t.energy != null ? `<div class="roulette-features">
      <span>⚡ ${Math.round(t.energy*100)}%</span>
      <span>💃 ${Math.round((t.danceability||0)*100)}%</span>
      ${t.tempo ? `<span>🥁 ${Math.round(t.tempo)} BPM</span>` : ''}
    </div>` : ''}
    ${starsHtml(t.uri)}`;
}

// ── Mosaic ────────────────────────────────────────────────────
async function generateMosaic() {
  $('mosaic-modal').classList.remove('hidden');
  $('mosaic-content').innerHTML = '<div class="mosaic-loading">⏳ Génération en cours…</div>';
  const all = [...library.liked, ...library.playlists.flatMap(p => p.items)];
  const imgs = [...new Set(all.map(t => t.image).filter(Boolean))];
  if (imgs.length < 4) {
    $('mosaic-content').innerHTML = '<div class="mosaic-loading">Pas assez de pochettes. Charge ta bibliothèque complète.</div>'; return;
  }
  const SIZE = 80, cols = Math.min(Math.ceil(Math.sqrt(imgs.length)), 10);
  const rows = Math.ceil(imgs.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * SIZE; canvas.height = rows * SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#121212'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const loaded = await Promise.all(imgs.map(url => new Promise(res => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => res(img); img.onerror = () => res(null); img.src = url;
  })));
  loaded.forEach((img, i) => {
    if (!img) return;
    ctx.drawImage(img, (i % cols) * SIZE, Math.floor(i / cols) * SIZE, SIZE, SIZE);
  });
  const dataUrl = canvas.toDataURL('image/png');
  $('mosaic-content').innerHTML = `<img src="${dataUrl}" class="mosaic-preview" alt="Mosaïque">`;
  $('download-mosaic-btn').onclick = () => {
    Object.assign(document.createElement('a'), { href: dataUrl, download: 'vibify_mosaic.png' }).click();
  };
}

// ── Auto Flow ─────────────────────────────────────────────────
function autoFlow(mode) {
  let tracks = [...(currentFiltered.length ? currentFiltered : allTracks)];
  if (tracks.filter(t => t.energy != null).length < 3) { alert('Pas assez de données audio — charge ta lib et attends l\'enrichissement.'); return; }
  if (mode === 'ascending')  tracks.sort((a,b) => (a.energy||0)-(b.energy||0));
  if (mode === 'descending') tracks.sort((a,b) => (b.energy||0)-(a.energy||0));
  if (mode === 'bpm')        tracks.sort((a,b) => (a.tempo||0)-(b.tempo||0));
  if (mode === 'wave') {
    tracks.sort((a,b) => (a.energy||0)-(b.energy||0));
    const res = []; let lo = 0, hi = tracks.length-1;
    while (lo <= hi) { res.length%2===0 ? res.push(tracks[lo++]) : res.push(tracks[hi--]); }
    tracks = res;
  }
  renderTracks(tracks);
  const labels = {ascending:'⬆ Énergie croissante', descending:'⬇ Énergie décroissante', wave:'〰 Vague', bpm:'🥁 BPM croissant'};
  showToast(`🌊 Flow ${labels[mode]} appliqué`);
}

// ── Coherence ─────────────────────────────────────────────────
function showCoherence() {
  const tracks = currentFiltered.length ? currentFiltered : allTracks;
  const wf = tracks.filter(t => t.energy != null);
  if (wf.length < 3) { alert('Pas assez de données audio.'); return; }
  const avg = k => wf.reduce((s,t)=>s+(t[k]||0),0)/wf.length;
  const std = (k,m) => Math.sqrt(wf.reduce((s,t)=>s+Math.pow((t[k]||0)-m,2),0)/wf.length);
  const mE=avg('energy'),mV=avg('valence'),mD=avg('danceability'),mT=avg('tempo');
  const sE=std('energy',mE),sV=std('valence',mV),sD=std('danceability',mD),sT=std('tempo',mT)/200;
  const score = Math.max(0,Math.round((1-(sE+sV+sD+sT)/4*2.5)*100));
  const emoji = score>=80?'🎯':score>=60?'✅':score>=40?'⚠️':'🌪️';
  const label = score>=80?'Très cohérente':score>=60?'Bonne cohérence':score>=40?'Assez variée':'Très hétérogène';
  const outliers = wf.filter(t => Math.abs((t.energy||0)-mE)>sE*1.8||Math.abs((t.valence||0)-mV)>sV*1.8).slice(0,5);
  const bar = (m,s) => {
    const lo=Math.round(Math.max(0,m-s)*100),hi=Math.round(Math.min(1,m+s)*100);
    return `<div class="coh-bar-wrap"><div class="coh-bar-fill" style="left:${lo}%;width:${Math.max(2,hi-lo)}%"></div><div class="coh-bar-mean" style="left:${Math.round(m*100)}%"></div></div>`;
  };
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<div class="modal-box">
    <div class="modal-header"><h3>🎯 Cohérence de playlist</h3><button class="modal-close" onclick="this.closest('.modal').remove()">✕</button></div>
    <div class="coh-score-wrap">
      <div class="coh-score-num">${emoji} ${score}<span style="font-size:1.2rem;font-weight:400">/100</span></div>
      <div class="coh-score-label">${label}</div>
      <div style="color:var(--muted);font-size:.8rem">${wf.length} titres analysés</div>
    </div>
    <div class="coh-details">
      <div class="coh-row"><span>Énergie</span>${bar(mE,sE)}<span>${Math.round(mE*100)}%</span></div>
      <div class="coh-row"><span>Humeur</span>${bar(mV,sV)}<span>${Math.round(mV*100)}%</span></div>
      <div class="coh-row"><span>Dansabilité</span>${bar(mD,sD)}<span>${Math.round(mD*100)}%</span></div>
    </div>
    ${outliers.length?`<div class="stat-section-title" style="margin-top:14px">🔍 Titres qui détonnent</div>
    <div class="history-track-list">${outliers.map(t=>`<div class="history-track-row"><div class="history-track-info"><div class="history-track-name">${esc(t.name)}</div><div class="history-track-artist">${esc((t.artists||[]).join(', '))}</div></div></div>`).join('')}</div>`:''}
  </div>`;
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  document.body.appendChild(modal);
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'vibify-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('toast-show'), 10);
  setTimeout(() => { el.classList.remove('toast-show'); setTimeout(() => el.remove(), 400); }, 2500);
}

// ── Music Map ─────────────────────────────────────────────────
let streamingHistory = [];
let mapDots = [];

function showMusicMap() {
  const tracks = (currentFiltered.length ? currentFiltered : allTracks).filter(t => t.energy != null && t.valence != null);
  if (tracks.length < 3) {
    alert('Pas assez de données audio — importe ton ZIP Spotify et attends la fin du chargement.'); return;
  }
  $('map-modal').classList.remove('hidden');
  requestAnimationFrame(() => drawMusicMap(tracks));
}

function drawMusicMap(tracks) {
  const canvas = $('map-canvas');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const PAD = 44, w = W - PAD * 2, h = H - PAD * 2;

  const isDark = darkMode;
  const quadAlpha = isDark ? '0.09' : '0.12';

  const quads = [
    { x: PAD+w/2, y: PAD,     w: w/2, h: h/2, color:`rgba(255,100,100,${quadAlpha})`, label:'⚡ Intense',    tx:PAD+w*0.75, ty:PAD+18 },
    { x: PAD,     y: PAD,     w: w/2, h: h/2, color:`rgba(160,100,255,${quadAlpha})`, label:'🌩 Sombre',     tx:PAD+w*0.25, ty:PAD+18 },
    { x: PAD+w/2, y: PAD+h/2, w: w/2, h: h/2, color:`rgba(29,185,84,${quadAlpha})`,  label:'😊 Chill',      tx:PAD+w*0.75, ty:PAD+h-8 },
    { x: PAD,     y: PAD+h/2, w: w/2, h: h/2, color:`rgba(96,165,250,${quadAlpha})`, label:'🌙 Mélancolie', tx:PAD+w*0.25, ty:PAD+h-8 },
  ];

  quads.forEach(q => {
    ctx.fillStyle = q.color;
    ctx.fillRect(q.x, q.y, q.w, q.h);
    ctx.fillStyle = isDark ? 'rgba(200,200,200,0.35)' : 'rgba(80,80,80,0.5)';
    ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(q.label, q.tx, q.ty);
  });

  ctx.strokeStyle = isDark ? 'rgba(200,200,200,0.15)' : 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD+w/2, PAD); ctx.lineTo(PAD+w/2, PAD+h);
  ctx.moveTo(PAD, PAD+h/2); ctx.lineTo(PAD+w, PAD+h/2);
  ctx.stroke();

  ctx.fillStyle = isDark ? 'rgba(180,180,180,0.5)' : 'rgba(80,80,80,0.6)';
  ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('😢 Triste', PAD + w*0.08, PAD+h+28);
  ctx.fillText('😊 Joyeux', PAD + w*0.92, PAD+h+28);
  ctx.save(); ctx.translate(14, PAD+h/2); ctx.rotate(-Math.PI/2);
  ctx.fillText('⬆ Énergie', 0, 0); ctx.restore();

  mapDots = [];
  tracks.forEach(t => {
    const x = PAD + t.valence * w;
    const y = PAD + (1 - t.energy) * h;
    let color;
    if (t.energy > 0.5 && t.valence > 0.5) color = '#ff6b6b';
    else if (t.energy > 0.5) color = '#a78bfa';
    else if (t.valence > 0.5) color = '#1db954';
    else color = '#60a5fa';
    const selected = selectedUris.has(t.uri);
    ctx.beginPath(); ctx.arc(x, y, selected ? 6 : 4, 0, Math.PI*2);
    ctx.fillStyle = color + (selected ? 'ff' : 'bb');
    ctx.fill();
    if (selected) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
    mapDots.push({ x, y, t, color });
  });

  let hoveredDot = null;
  canvas.onmousemove = e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    hoveredDot = mapDots.find(d => Math.hypot(d.x-mx, d.y-my) < 9) || null;
    const tip = $('map-tooltip');
    if (hoveredDot) {
      const artists = (hoveredDot.t.artists||[]).join(', ');
      tip.textContent = `${hoveredDot.t.name}  —  ${artists}`;
      tip.style.display = 'block';
      tip.style.left = (e.clientX + 14) + 'px';
      tip.style.top  = (e.clientY - 36) + 'px';
      canvas.style.cursor = 'pointer';
    } else { tip.style.display = 'none'; canvas.style.cursor = 'default'; }
  };
  canvas.onmouseleave = () => { $('map-tooltip').style.display = 'none'; };
  canvas.onclick = e => {
    if (!hoveredDot) return;
    const uri = hoveredDot.t.uri;
    if (selectedUris.has(uri)) selectedUris.delete(uri); else selectedUris.add(uri);
    updateFloatBar();
    drawMusicMap(tracks);
  };
}

// ── Music Profile ─────────────────────────────────────────────
function generateMusicProfile(tracks) {
  const wf = tracks.filter(t => t.energy != null);
  if (!wf.length) return '';
  const avg = k => wf.reduce((s,t) => s+(t[k]||0), 0) / wf.length;
  const energy = avg('energy'), valence = avg('valence'),
        dance  = avg('danceability'), tempo = avg('tempo');

  let type, emoji, desc;
  if      (energy>0.65 && valence>0.55) { type='Le Fêtard';      emoji='🎉'; desc='Tu écoutes de la musique qui booste et met de bonne humeur. Les soirées, c\'est ton terrain naturel.'; }
  else if (energy>0.65 && valence<=0.4) { type='L\'Intense';     emoji='⚡'; desc='Tu préfères la puissance et les émotions brutes. Chaque écoute est une montée d\'adrénaline.'; }
  else if (energy<=0.35 && valence>0.6) { type='Le Contemplatif';emoji='🌿'; desc='Tu aimes la musique douce et lumineuse. Tu écoutes pour te détendre et apprécier les petits moments.'; }
  else if (energy<=0.4 && valence<=0.4) { type='Le Mélancolique'; emoji='🌙'; desc='Tu apprécies les émotions profondes et la nostalgie. Ta musique raconte des histoires qui touchent l\'âme.'; }
  else if (dance>0.75)                  { type='Le Danseur';      emoji='💃'; desc='Le rythme prime sur tout. Peu importe où tu es, la musique te donne envie de bouger.'; }
  else if (tempo>145)                   { type='Le Speedrunner';  emoji='🚀'; desc='Tu écoutes vite, tu vis vite. Les BPM élevés te donnent cette énergie au quotidien.'; }
  else                                  { type='L\'Éclectique';   emoji='🎭'; desc='Ton goût est difficile à cerner — et c\'est une qualité. Tu traverses les genres sans frontières.'; }

  const bar = (v,color='#1db954') =>
    `<div class="profile-bar-wrap"><div class="profile-bar" style="width:${Math.round(v*100)}%;background:${color}"></div></div>`;

  return `
    <div class="profile-card">
      <div class="profile-type">${emoji} ${type}</div>
      <div class="profile-desc">${desc}</div>
      <div class="profile-stats">
        <div class="profile-stat"><span>Énergie</span>${bar(energy,'#ff6b6b')}<span>${Math.round(energy*100)}%</span></div>
        <div class="profile-stat"><span>Humeur</span>${bar(valence,'#fbbf24')}<span>${Math.round(valence*100)}%</span></div>
        <div class="profile-stat"><span>Dansabilité</span>${bar(dance,'#a78bfa')}<span>${Math.round(dance*100)}%</span></div>
        <div class="profile-stat"><span>Tempo moyen</span>${bar(Math.min(tempo/200,1),'#60a5fa')}<span>${Math.round(tempo)} BPM</span></div>
      </div>
      <p class="profile-note">${wf.length} titres analysés sur ${tracks.length}</p>
    </div>`;
}

// ── Streaming History ─────────────────────────────────────────
function showHistory() {
  if (!streamingHistory.length) return;
  const sh = streamingHistory;
  const totalMs = sh.reduce((s, e) => s + (e.ms_played || 0), 0);
  const totalH  = Math.floor(totalMs / 3600000);
  const totalMin = Math.floor((totalMs % 3600000) / 60000);
  const skipped = sh.filter(e => e.skipped || e.ms_played < 10000).length;
  const skipRate = Math.round(skipped / sh.length * 100);

  // Top tracks by play count (>= 30s)
  const trackPlays = {};
  sh.filter(e => e.ms_played >= 30000).forEach(e => {
    const key = e.spotify_track_uri || e.master_metadata_track_name;
    if (!trackPlays[key]) trackPlays[key] = { name: e.master_metadata_track_name, artist: e.master_metadata_album_artist_name, plays: 0, ms: 0 };
    trackPlays[key].plays++; trackPlays[key].ms += e.ms_played;
  });
  const topTracks = Object.values(trackPlays).sort((a,b) => b.plays - a.plays).slice(0, 10);

  // Top artists by time
  const artistMs = {};
  sh.forEach(e => {
    const a = e.master_metadata_album_artist_name;
    if (a) artistMs[a] = (artistMs[a] || 0) + (e.ms_played || 0);
  });
  const topArtists = Object.entries(artistMs).sort((a,b) => b[1]-a[1]).slice(0, 8);
  const maxArtMs = topArtists[0]?.[1] || 1;

  // By hour
  const byHour = Array(24).fill(0);
  sh.forEach(e => { if (e.ts) { const h = new Date(e.ts).getHours(); byHour[h]++; } });
  const maxH = Math.max(...byHour);

  // By year
  const byYear = {};
  sh.forEach(e => { if (e.ts) { const y = e.ts.slice(0,4); byYear[y] = (byYear[y]||0) + (e.ms_played||0); } });
  const years = Object.entries(byYear).sort((a,b) => a[0].localeCompare(b[0]));
  const maxYMs = Math.max(...years.map(([,v]) => v));

  const fmtH = ms => { const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000); return h?`${h}h ${m}min`:`${m}min`; };

  $('history-body').innerHTML = `
    <div class="stat-grid" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-num">${totalH}h ${totalMin}min</div><div class="stat-lbl">Temps total d'écoute</div></div>
      <div class="stat-card"><div class="stat-num">${sh.length.toLocaleString()}</div><div class="stat-lbl">Écoutes totales</div></div>
      <div class="stat-card"><div class="stat-num">${Object.keys(trackPlays).length.toLocaleString()}</div><div class="stat-lbl">Titres uniques écoutés</div></div>
      <div class="stat-card"><div class="stat-num">${skipRate}%</div><div class="stat-lbl">Taux de skip</div></div>
    </div>

    <div class="stat-section-title">🏆 Top 10 titres les plus écoutés</div>
    <div class="history-track-list">
      ${topTracks.map((t,i) => `
        <div class="history-track-row">
          <span class="history-rank">${i+1}</span>
          <div class="history-track-info">
            <div class="history-track-name">${esc(t.name)}</div>
            <div class="history-track-artist">${esc(t.artist)}</div>
          </div>
          <div class="history-track-stats">
            <span class="history-plays">${t.plays} écoutes</span>
            <span class="history-time">${fmtH(t.ms)}</span>
          </div>
        </div>`).join('')}
    </div>

    <div class="stat-section-title" style="margin-top:18px">🎤 Top artistes par temps d'écoute</div>
    <div class="top-list">
      ${topArtists.map(([a,ms]) => `
        <div class="top-row">
          <span class="top-name">${esc(a)}</span>
          <div class="top-bar-wrap"><div class="top-bar" style="width:${Math.round(ms/maxArtMs*100)}%"></div></div>
          <span class="top-count">${fmtH(ms)}</span>
        </div>`).join('')}
    </div>

    <div class="history-charts">
      <div>
        <div class="stat-section-title" style="margin-top:18px">🕐 Écoutes par heure</div>
        <div class="hour-chart">
          ${byHour.map((n,h) => `
            <div class="hour-col" title="${h}h : ${n} écoutes">
              <div class="hour-bar" style="height:${maxH?Math.round(n/maxH*100):0}%"></div>
              <div class="hour-label">${h%4===0?h+'h':''}</div>
            </div>`).join('')}
        </div>
      </div>
      ${years.length > 1 ? `
      <div>
        <div class="stat-section-title" style="margin-top:18px">📅 Par année</div>
        <div class="year-chart">
          ${years.map(([y,ms]) => `
            <div class="year-col" title="${y} : ${fmtH(ms)}">
              <div class="year-bar" style="height:${Math.round(ms/maxYMs*100)}%"></div>
              <div class="year-label">${y}</div>
            </div>`).join('')}
        </div>
      </div>` : ''}
    </div>`;

  $('history-modal').classList.remove('hidden');
}

// ── Compatibility ─────────────────────────────────────────────
function exportProfile() {
  const all = [...library.liked, ...library.playlists.flatMap(p => p.items)];
  const artistMs = {};
  all.forEach(t => (t.artists||[]).forEach(a => { artistMs[a] = (artistMs[a]||0)+1; }));
  const profile = {
    v: 1,
    name: spotifyUser?.name || 'Anonyme',
    trackUris: [...new Set(all.map(t => t.uri).filter(Boolean))],
    topArtists: Object.entries(artistMs).sort((a,b)=>b[1]-a[1]).slice(0,50).map(([a])=>a),
    trackCount: all.length,
    playlistCount: library.playlists.length,
  };
  const blob = new Blob([JSON.stringify(profile)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'vibify_profile.json' });
  a.click(); URL.revokeObjectURL(a.href);
}

function loadFriendProfile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const friend = JSON.parse(e.target.result);
      if (friend.v !== 1 || !friend.trackUris) { alert('Fichier de profil invalide.'); return; }
      showCompatibility(friend);
    } catch { alert('Impossible de lire ce fichier.'); }
  };
  reader.readAsText(file);
}

function showCompatibility(friend) {
  const myAll = [...library.liked, ...library.playlists.flatMap(p => p.items)];
  const myUris = new Set(myAll.map(t => t.uri).filter(Boolean));
  const friendUris = new Set(friend.trackUris);

  const common = [...myUris].filter(u => friendUris.has(u));
  const onlyMe = [...myUris].filter(u => !friendUris.has(u));
  const onlyFriend = [...friendUris].filter(u => !myUris.has(u));
  const total = new Set([...myUris, ...friendUris]).size;
  const score = Math.round(common.length / total * 100);

  const myTopArtists = {};
  myAll.forEach(t => (t.artists||[]).forEach(a => { myTopArtists[a] = (myTopArtists[a]||0)+1; }));
  const commonArtists = (friend.topArtists||[]).filter(a => myTopArtists[a]).slice(0,6);

  const emoji = score >= 70 ? '🔥' : score >= 45 ? '🎶' : score >= 25 ? '🤝' : '🌍';
  const label = score >= 70 ? 'Âmes sœurs musicales !' : score >= 45 ? 'Bonne compatibilité !' : score >= 25 ? 'Quelques goûts en commun' : 'Univers musicaux différents';

  const commonTracks = myAll.filter(t => common.includes(t.uri)).slice(0, 8);

  $('compat-result').innerHTML = `
    <div class="compat-score-card">
      <div class="compat-score-emoji">${emoji}</div>
      <div class="compat-score-num">${score}%</div>
      <div class="compat-score-label">${label}</div>
      <div class="compat-names">Toi · ${esc(friend.name)}</div>
    </div>
    <div class="compat-stats-grid">
      <div class="stat-card"><div class="stat-num">${common.length}</div><div class="stat-lbl">Titres en commun</div></div>
      <div class="stat-card"><div class="stat-num">${onlyMe.length}</div><div class="stat-lbl">Tes titres exclusifs</div></div>
      <div class="stat-card"><div class="stat-num">${onlyFriend.length}</div><div class="stat-lbl">Ses titres exclusifs</div></div>
      <div class="stat-card"><div class="stat-num">${commonArtists.length}</div><div class="stat-lbl">Artistes en commun</div></div>
    </div>
    ${commonArtists.length ? `
    <div class="stat-section-title" style="margin-top:16px">🎤 Artistes que vous aimez tous les deux</div>
    <div class="compat-artists">${commonArtists.map(a => `<span class="compat-artist-chip">${esc(a)}</span>`).join('')}</div>` : ''}
    ${commonTracks.length ? `
    <div class="stat-section-title" style="margin-top:16px">🎵 Titres en commun</div>
    <div class="history-track-list">
      ${commonTracks.map(t => `<div class="history-track-row">
        <div class="history-track-info"><div class="history-track-name">${esc(t.name)}</div><div class="history-track-artist">${esc((t.artists||[]).join(', '))}</div></div>
      </div>`).join('')}
    </div>` : ''}`;
}

// ── Where is this track ───────────────────────────────────────
function showWhere(uri, name) {
  const inLiked = library.liked.some(t => t.uri === uri);
  const inPlaylists = library.playlists.filter(pl => pl.items.some(t => t.uri === uri));
  $('where-track-name').textContent = name;
  const total = (inLiked ? 1 : 0) + inPlaylists.length;
  $('where-body').innerHTML = total === 0
    ? '<p style="color:var(--muted)">Ce titre n\'est dans aucune source importée.</p>'
    : `<div class="where-list">
        ${inLiked ? '<div class="where-item"><span class="where-icon">❤️</span><span>Titres likés</span></div>' : ''}
        ${inPlaylists.map(pl => `<div class="where-item"><span class="where-icon">🎵</span><span>${esc(pl.name)}</span></div>`).join('')}
      </div>
      <p class="where-count">Présent dans <strong>${total}</strong> source${total>1?'s':''}</p>`;
  $('where-modal').classList.remove('hidden');
}

// ── Backup ────────────────────────────────────────────────────
function downloadBackup() {
  const backup = {
    version: 2, date: new Date().toISOString(),
    library, tags: trackTags, ratings: trackRatings,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `vibify_backup_${new Date().toISOString().slice(0,10)}.json`,
  }).click();
  showToast('💾 Backup téléchargé !');
}

function loadBackup(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.library) { alert('Fichier de backup invalide.'); return; }
      library = data.library;
      if (data.tags) { trackTags = data.tags; localStorage.setItem(TAGS_KEY, JSON.stringify(trackTags)); }
      if (data.ratings) { trackRatings = data.ratings; saveRatings(); }
      saveToStorage();
      launchApp();
      showToast('✅ Backup restauré !');
    } catch { alert('Impossible de lire ce fichier.'); }
  };
  reader.readAsText(file);
}

// ── Playlist splitter ─────────────────────────────────────────
let splitGroups = [];
let splitBy = 'artist';

function showSplitModal() {
  splitGroups = [];
  $('split-actions').classList.add('hidden');
  $('split-spotify-status').textContent = '';
  $('split-preview').innerHTML = '';
  $('split-modal').classList.remove('hidden');
  computeSplit(splitBy);
}

function computeSplit(by) {
  splitBy = by;
  document.querySelectorAll('.split-opt').forEach(b => b.classList.toggle('active', b.dataset.by === by));
  const tracks = currentFiltered.length ? currentFiltered : allTracks;
  const groups = {};

  if (by === 'artist') {
    tracks.forEach(t => {
      const key = (t.artists||['Inconnu'])[0];
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    });
  } else if (by === 'decade') {
    tracks.forEach(t => {
      const y = parseInt((t.added_at||'').slice(0,4));
      const key = isNaN(y) ? 'Inconnue' : `${Math.floor(y/10)*10}s`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    });
  } else if (by === 'mood') {
    tracks.forEach(t => {
      let key;
      if (t.energy == null) key = '❓ Non analysé';
      else if (t.energy > 0.65 && t.valence > 0.55) key = '🎉 Fête';
      else if (t.energy > 0.65) key = '⚡ Intense';
      else if (t.energy <= 0.4 && t.valence > 0.55) key = '😌 Chill';
      else if (t.energy <= 0.4) key = '🌙 Mélancolique';
      else key = '🎵 Neutre';
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    });
  }

  splitGroups = Object.entries(groups)
    .sort((a,b) => b[1].length - a[1].length)
    .filter(([,v]) => v.length >= 2);

  if (!splitGroups.length) {
    $('split-preview').innerHTML = '<p style="color:var(--muted);padding:16px">Pas assez de données pour diviser.</p>';
    $('split-actions').classList.add('hidden');
    return;
  }

  $('split-preview').innerHTML = `
    <div class="split-groups">
      ${splitGroups.map(([name, tracks]) => `
        <div class="split-group">
          <div class="split-group-name">${esc(name)}</div>
          <div class="split-group-count">${tracks.length} titre${tracks.length>1?'s':''}</div>
        </div>`).join('')}
    </div>
    <p class="split-total">${splitGroups.length} playlists seront créées</p>`;
  $('split-actions').classList.remove('hidden');
}

async function splitToSpotify() {
  if (!spotifyToken) { alert('Connecte-toi à Spotify d\'abord.'); return; }
  const btn = $('split-spotify-btn');
  btn.disabled = true;
  let done = 0;
  for (const [name, tracks] of splitGroups) {
    const uris = tracks.map(t => t.uri).filter(u => u?.startsWith('spotify:track:'));
    if (!uris.length) continue;
    $('split-spotify-status').textContent = `Création ${++done}/${splitGroups.length} : ${name}…`;
    try {
      await fetch('/api/v1/playlists/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${spotifyToken}` },
        body: JSON.stringify({ name, description: `Créée avec Vibify`, track_uris: uris }),
      });
    } catch {}
  }
  $('split-spotify-status').textContent = `✅ ${done} playlists créées sur Spotify !`;
  btn.disabled = false;
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

// ── Vibify Wrapped ────────────────────────────────────────────
function showWrapped() {
  const all = [...library.liked, ...library.playlists.flatMap(p => p.items)];
  if (!all.length) { showToast('Importe ta bibliothèque d\'abord !'); return; }

  const artistCounts = {};
  all.forEach(t => (t.artists||[]).forEach(a => { artistCounts[a] = (artistCounts[a]||0) + 1; }));
  const topArtists = Object.entries(artistCounts).sort((a,b) => b[1]-a[1]).slice(0, 5);

  const scrobbled = all.filter(t => t.scrobbles > 0).sort((a,b) => b.scrobbles-a.scrobbles).slice(0, 5);
  const topTracks = scrobbled.length ? scrobbled : all.slice(0, 5);

  const decades = {};
  all.forEach(t => { if (t.year) { const d = Math.floor(t.year/10)*10; decades[d] = (decades[d]||0)+1; } });
  const topDecade = Object.entries(decades).sort((a,b) => b[1]-a[1])[0];

  const totalMs = all.reduce((s,t) => s+(t.duration_ms||0), 0);
  const totalHours = Math.round(totalMs/3600000);
  const totalDays  = Math.floor(totalMs/86400000);

  const slides = [
    { bg:'linear-gradient(160deg,#0d0d1a,#0a1628)', accent:'#1db954', emoji:'🎵',
      title:'Ton année en musique', sub:'Voilà ce que Vibify a retenu de toi…', body:'' },
    { bg:'linear-gradient(160deg,#0a1628,#1a0a28)', accent:'#3b82f6', emoji:'🎵',
      title: all.length.toLocaleString('fr'), sub:'titres dans ta bibliothèque',
      body:`<div class="wrapped-detail">C'est ${Math.round(all.length/10)*10} ambiances différentes 🎶</div>` },
    { bg:'linear-gradient(160deg,#1a0a28,#28100a)', accent:'#f59e0b', emoji:'⏱️',
      title: totalHours ? `${totalHours}h` : '—', sub:"d'écoute au total",
      body: totalDays >= 1 ? `<div class="wrapped-detail">Soit ${totalDays} jour${totalDays>1?'s':''} non-stop 🔥</div>` : '' },
    { bg:'linear-gradient(160deg,#0a1a10,#0d0d1a)', accent:'#1db954', emoji:'🎤',
      title: topArtists[0]?.[0] || '—', sub:'ton artiste numéro 1',
      body: topArtists.slice(1,5).map(([a],i) =>
        `<div class="wrapped-rank"><span class="wrapped-rank-num">#${i+2}</span>${esc(a)}</div>`).join('') },
    { bg:'linear-gradient(160deg,#28100a,#1a1000)', accent:'#ff6b6b', emoji:'🔥',
      title:'Tes titres culte', sub:'',
      body: topTracks.map((t,i) =>
        `<div class="wrapped-rank"><span class="wrapped-rank-num">#${i+1}</span>${esc(t.name)} <span class="wrapped-rank-artist">— ${esc((t.artists||[])[0]||'')}</span></div>`).join('') },
    { bg:'linear-gradient(160deg,#0a1828,#0d0d1a)', accent:'#60a5fa', emoji:'🕐',
      title: topDecade ? `Années ${topDecade[0]}` : 'Intemporel',
      sub: topDecade ? 'ta décennie de cœur' : 'tu traverses les époques', body:'' },
    { bg:'linear-gradient(160deg,#0d0d1a,#0a1628)', accent:'#1db954', emoji:'✨',
      title:'Vibify', sub:'Continue d\'écouter, de ressentir 🙏',
      body:'<div class="wrapped-detail" style="margin-top:8px;font-size:.9rem;opacity:.5">vibify.app</div>' },
  ];

  let current = 0;
  const old = document.getElementById('_wrapped_modal');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = '_wrapped_modal';
  box.className = 'modal';
  box.style.background = 'rgba(0,0,0,.92)';
  box.innerHTML = `
    <div class="wrapped-box">
      <button class="wrapped-close" id="_w_close">✕</button>
      <div id="_w_slide" class="wrapped-slide"></div>
      <div class="wrapped-nav">
        <button id="_w_prev" class="wrapped-nav-btn">‹</button>
        <div id="_w_dots" class="wrapped-dots"></div>
        <button id="_w_next" class="wrapped-nav-btn">›</button>
      </div>
      <button id="_w_save" class="wrapped-share-btn">📸 Sauvegarder en image</button>
    </div>`;
  document.body.appendChild(box);

  function renderSlide(idx) {
    const s = slides[idx];
    const slide = box.querySelector('#_w_slide');
    slide.style.background = s.bg;
    const content = document.createElement('div');
    content.className = 'wrapped-content';
    content.style.setProperty('--w-accent', s.accent);
    content.innerHTML = `
      <div class="wrapped-emoji">${s.emoji}</div>
      <div class="wrapped-big">${s.title}</div>
      ${s.sub ? `<div class="wrapped-sub">${s.sub}</div>` : ''}
      <div class="wrapped-body">${s.body}</div>`;
    slide.innerHTML = '';
    slide.appendChild(content);
    requestAnimationFrame(() => content.classList.add('wrapped-in'));

    box.querySelector('#_w_dots').innerHTML =
      slides.map((_,i) => `<div class="wrapped-dot${i===idx?' active':''}"></div>`).join('');
    box.querySelector('#_w_prev').style.opacity = idx > 0 ? '1' : '0.2';
    box.querySelector('#_w_next').textContent = idx === slides.length-1 ? '✓ Fermer' : '›';
  }

  renderSlide(0);
  box.querySelector('#_w_prev').addEventListener('click', () => { if (current > 0) renderSlide(--current); });
  box.querySelector('#_w_next').addEventListener('click', () => {
    if (current < slides.length-1) renderSlide(++current);
    else { box.remove(); document.removeEventListener('keydown', keyNav); }
  });
  box.querySelector('#_w_close').addEventListener('click', () => { box.remove(); document.removeEventListener('keydown', keyNav); });
  box.querySelector('#_w_save').addEventListener('click', generateShareCard);
  box.addEventListener('click', e => { if (e.target === box) { box.remove(); document.removeEventListener('keydown', keyNav); } });

  function keyNav(e) {
    if (e.key === 'ArrowRight' && current < slides.length-1) renderSlide(++current);
    if (e.key === 'ArrowLeft'  && current > 0) renderSlide(--current);
    if (e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', keyNav); }
  }
  document.addEventListener('keydown', keyNav);
}

// ── Share Card ────────────────────────────────────────────────
function generateShareCard() {
  const all = [...library.liked, ...library.playlists.flatMap(p => p.items)];
  if (!all.length) { showToast('Importe ta bibliothèque d\'abord !'); return; }

  const artistCounts = {};
  all.forEach(t => (t.artists||[]).forEach(a => { artistCounts[a] = (artistCounts[a]||0)+1; }));
  const topArtists = Object.entries(artistCounts).sort((a,b) => b[1]-a[1]).slice(0, 3);
  const totalMs    = all.reduce((s,t) => s+(t.duration_ms||0), 0);
  const totalHours = Math.round(totalMs/3600000);

  const canvas = $('share-canvas');
  const W = 400, H = 520;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#090914'); bg.addColorStop(0.5, '#0b1a0b'); bg.addColorStop(1, '#140912');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W*.5, H*.28, 0, W*.5, H*.28, 220);
  glow.addColorStop(0, 'rgba(29,185,84,.18)'); glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  function roundedRect(x,y,w,h,r) {
    ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
    ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r); ctx.lineTo(x+r,y+h);
    ctx.arcTo(x,y+h,x,y+h-r,r); ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r); ctx.closePath();
  }
  ctx.strokeStyle = 'rgba(29,185,84,.3)'; ctx.lineWidth = 1.5;
  roundedRect(4, 4, W-8, H-8, 20); ctx.stroke();

  ctx.font = 'bold 26px system-ui,sans-serif'; ctx.fillStyle = '#1db954'; ctx.textAlign = 'center';
  ctx.fillText('Vibify', W/2, 54);

  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(40,70); ctx.lineTo(W-40,70); ctx.stroke();

  ctx.font = 'bold 80px system-ui,sans-serif'; ctx.fillStyle = '#fff';
  ctx.fillText(all.length.toLocaleString('fr'), W/2, 165);
  ctx.font = '15px system-ui,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.fillText('titres dans ma bibliothèque', W/2, 192);

  const hg = ctx.createLinearGradient(0,220,W,220);
  hg.addColorStop(0,'#1db954'); hg.addColorStop(1,'#00d4aa');
  ctx.font = 'bold 34px system-ui,sans-serif'; ctx.fillStyle = hg;
  ctx.fillText(`${totalHours}h d'écoute`, W/2, 248);

  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.beginPath(); ctx.moveTo(40,268); ctx.lineTo(W-40,268); ctx.stroke();

  ctx.font = 'bold 11px system-ui,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.3)';
  ctx.fillText('TOP ARTISTES', W/2, 298);

  topArtists.forEach(([a],i) => {
    const sz = [22,17,14][i]; const al = [1,.75,.55][i];
    ctx.font = `bold ${sz}px system-ui,sans-serif`;
    ctx.fillStyle = i===0 ? '#fff' : `rgba(255,255,255,${al})`;
    const maxW = W-80; let nm = a;
    while (ctx.measureText(nm).width > maxW && nm.length > 3) nm = nm.slice(0,-1)+'…';
    ctx.fillText(nm, W/2, 328+i*34);
  });

  ctx.font = '12px system-ui,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.22)';
  ctx.fillText('vibify.app', W/2, H-20);

  $('share-modal').classList.remove('hidden');
  $('download-share-btn').onclick = () => {
    Object.assign(document.createElement('a'), {
      href: canvas.toDataURL('image/png'), download: 'vibify_card.png'
    }).click();
    showToast('📸 Carte téléchargée !');
  };
}

// ── Lyrics ────────────────────────────────────────────────────
let currentLyricsTrack = null;

async function fetchAndShowLyrics(track) {
  currentLyricsTrack = track;
  const artist = (track?.artists||[])[0] || '';
  const title  = track?.name || '';
  if (!artist || !title) return;

  const panel = $('lyrics-panel');
  panel.classList.remove('hidden');
  $('lyrics-text').innerHTML = '<div class="lyrics-loading">🎵 Chargement des paroles…</div>';

  try {
    const r = await fetch(`/api/v1/lyrics?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`);
    const data = await r.json();
    if (data.lyrics) {
      $('lyrics-text').innerHTML = `<pre class="lyrics-content">${esc(data.lyrics)}</pre>`;
    } else {
      $('lyrics-text').innerHTML = '<div class="lyrics-loading">Paroles introuvables 😔</div>';
      setTimeout(() => { if (currentLyricsTrack === track) panel.classList.add('hidden'); }, 2000);
    }
  } catch {
    $('lyrics-text').innerHTML = '<div class="lyrics-loading">Erreur de chargement</div>';
  }
}

// ── Mood Picker ───────────────────────────────────────────────
function showMoodPicker() {
  if (!library.liked.length) { showToast('Charge ta bibliothèque d\'abord !'); return; }
  $('mood-modal').classList.remove('hidden');
}

function applyMood(mood) {
  $('mood-modal').classList.add('hidden');
  const base = allTracks.length ? allTracks : library.liked;
  const hasAudio = base.some(t => t.energy != null);

  const filters = {
    hype:  t => (t.energy||0) > 0.65 && (t.valence||0) > 0.5,
    chill: t => (t.energy||0) < 0.45,
    sad:   t => (t.valence||0.5) < 0.35,
    party: t => (t.danceability||0) > 0.7 && (t.energy||0) > 0.6,
    focus: t => (t.energy||0) >= 0.3 && (t.energy||0) <= 0.6 && (t.speechiness||0) < 0.1,
    dance: t => (t.danceability||0) > 0.65,
  };
  const names = { hype:'🔥 Hype', chill:'😌 Chill', sad:'😢 Sad vibes', party:'🎉 Party', focus:'🎯 Focus', dance:'💃 Dance' };

  let filtered = hasAudio ? base.filter(filters[mood]) : [];
  if (filtered.length < 5) {
    filtered = [...base].sort(() => Math.random() - .5);
    showToast('🎲 Shuffle — importe ton ZIP Spotify pour le filtre par humeur précis');
  } else {
    showToast(`${names[mood]} — ${filtered.length} titres`);
  }

  renderTracks(filtered);
  $('playlist-title').textContent = names[mood] || 'Mood';
  $('tracks-count').textContent   = `${filtered.length} titre${filtered.length>1?'s':''}`;
}

// ── Last.fm Auto-sync ─────────────────────────────────────────
const LASTFM_USER_KEY = 'vibify_lastfm_user';
let lastfmSyncInterval = null;

function startLastfmAutoSync(username) {
  if (!username) return;
  localStorage.setItem(LASTFM_USER_KEY, username);
  clearInterval(lastfmSyncInterval);
  lastfmSyncInterval = setInterval(() => silentLastfmSync(username), 5 * 60 * 1000);
}

async function silentLastfmSync(username) {
  try {
    const r = await fetch(`/api/v1/lastfm/recent?username=${encodeURIComponent(username)}&limit=50`);
    if (!r.ok) return;
    const fresh = await r.json();
    const existingIds = new Set(library.liked.map(t => t.id));
    const added = fresh.filter(t => !existingIds.has(t.id));
    if (added.length) {
      library.liked = [...added, ...library.liked];
      saveToStorage();
      renderSidebar();
      showToast(`🔄 +${added.length} nouveau${added.length>1?'x':''} titre${added.length>1?'s':''} Last.fm`);
    }
  } catch {}
}

function resumeLastfmAutoSync() {
  const u = localStorage.getItem(LASTFM_USER_KEY);
  if (u) startLastfmAutoSync(u);
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
  loadTags();
  loadRatings();
  loadSpotifyAuth();
  checkSavedLibrary();

  // OAuth popup message
  window.addEventListener('message', e => {
    if (e.data?.type === 'vibify_spotify_auth') {
      spotifyToken = e.data.accessToken;
      fetchSpotifyUser();
      if (pendingSpotifyImport) importFromSpotify();
    }
  });

  // PWA service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/static/sw.js').catch(() => {});
  }

  // Import
  $('spotify-import-btn').addEventListener('click', importFromSpotify);
  $('lastfm-import-btn').addEventListener('click', importFromLastfm);
  $('demo-btn').addEventListener('click', loadDemoData);
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
  // DJ Mode
  $('float-dj-btn').addEventListener('click', addToDjQueue);
  $('dj-play-btn').addEventListener('click', djTogglePlay);
  $('dj-next-btn').addEventListener('click', djNext);
  $('dj-prev-btn').addEventListener('click', djPrev);
  $('dj-close-btn').addEventListener('click', djHidePlayer);
  $('dj-progress-bar').addEventListener('click', djSeek);
  $('dj-queue-btn').addEventListener('click', () => $('dj-queue-panel').classList.toggle('hidden'));
  $('dj-close-queue-btn').addEventListener('click', () => $('dj-queue-panel').classList.add('hidden'));
  $('dj-shuffle-queue-btn').addEventListener('click', djShuffleQueue);
  $('dj-clear-queue-btn').addEventListener('click', () => { djQueue = []; djIndex = -1; renderDjQueue(); });

  $('history-btn').addEventListener('click', showHistory);
  $('close-history-btn').addEventListener('click', () => $('history-modal').classList.add('hidden'));
  $('compare-btn').addEventListener('click', () => $('compat-modal').classList.remove('hidden'));
  $('close-compat-btn').addEventListener('click', () => $('compat-modal').classList.add('hidden'));
  $('export-profile-btn').addEventListener('click', exportProfile);
  $('friend-profile-input').addEventListener('change', e => { if (e.target.files[0]) loadFriendProfile(e.target.files[0]); });
  $('quiz-btn').addEventListener('click', startQuiz);
  $('close-quiz-btn').addEventListener('click', () => { clearTimeout(quizTimerRef); $('quiz-modal').classList.add('hidden'); });

  $('roulette-btn').addEventListener('click', spinRoulette);
  $('close-roulette-btn').addEventListener('click', () => $('roulette-modal').classList.add('hidden'));
  $('roulette-again-btn').addEventListener('click', spinRoulette);
  $('roulette-play-btn').addEventListener('click', () => { if (currentRoulette?.preview_url) playPreview(currentRoulette.preview_url, $('roulette-play-btn'), null); });
  $('roulette-select-btn').addEventListener('click', () => {
    if (!currentRoulette) return;
    selectedUris.add(currentRoulette.uri); updateFloatBar();
    showToast(`✅ "${currentRoulette.name}" ajouté à la sélection`);
    $('roulette-modal').classList.add('hidden');
  });

  $('mosaic-btn').addEventListener('click', generateMosaic);
  $('close-mosaic-btn').addEventListener('click', () => $('mosaic-modal').classList.add('hidden'));

  $('flow-btn').addEventListener('click', () => $('flow-menu').classList.toggle('hidden'));
  document.querySelectorAll('#flow-menu button').forEach(btn => {
    btn.addEventListener('click', () => { autoFlow(btn.dataset.mode); $('flow-menu').classList.add('hidden'); });
  });
  document.addEventListener('click', e => { if (!e.target.closest('.flow-wrap')) $('flow-menu').classList.add('hidden'); });

  $('coh-btn').addEventListener('click', showCoherence);
  $('map-btn').addEventListener('click', showMusicMap);
  $('close-map-btn').addEventListener('click', () => { $('map-modal').classList.add('hidden'); $('map-tooltip').style.display = 'none'; });
  $('dup-btn').addEventListener('click', findDuplicates);
  $('shuffle-btn').addEventListener('click', shuffleTracks);

  // Sidebar fusion
  $('fusion-btn').addEventListener('click', fusionPlaylists);
  $('close-fusion-modal-btn').addEventListener('click', () => $('fusion-modal').classList.add('hidden'));
  $('fusion-view-btn').addEventListener('click', fusionViewOnly);
  $('fusion-spotify-btn').addEventListener('click', fusionToSpotify);

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
  $('tag-select').addEventListener('change', applySortFilter);
  $('decade-select').addEventListener('change', applySortFilter);
  $('year-select').addEventListener('change', applySortFilter);
  $('rating-select').addEventListener('change', applySortFilter);
  $('mood-select').addEventListener('change', applySortFilter);
  $('float-tag-btn').addEventListener('click', showBatchTagModal);

  // Floating bar
  $('float-copy-btn').addEventListener('click', copyUris);
  $('float-csv-btn').addEventListener('click', exportCsv);
  $('float-clear-btn').addEventListener('click', clearSelection);

  // Modals
  // Spotify
  $('spotify-connect-btn').addEventListener('click', connectSpotify);
  $('spotify-disconnect-btn').addEventListener('click', disconnectSpotify);
  $('float-create-btn').addEventListener('click', () => {
    $('create-pl-info').textContent = `${selectedUris.size} titre${selectedUris.size > 1 ? 's' : ''} sélectionné${selectedUris.size > 1 ? 's' : ''}`;
    $('create-pl-name').value = ''; $('create-pl-result').innerHTML = '';
    $('create-pl-modal').classList.remove('hidden');
    setTimeout(() => $('create-pl-name').focus(), 60);
  });
  $('close-create-pl-btn').addEventListener('click', () => $('create-pl-modal').classList.add('hidden'));
  $('create-pl-confirm').addEventListener('click', createSpotifyPlaylist);
  $('create-pl-name').addEventListener('keydown', e => { if (e.key === 'Enter') createSpotifyPlaylist(); });

  // Tag modal
  $('close-tag-btn').addEventListener('click', () => $('tag-modal').classList.add('hidden'));
  $('tag-confirm-btn').addEventListener('click', confirmAddTag);
  $('tag-input').addEventListener('keydown', e => { if (e.key === 'Enter') confirmAddTag(); });

  // Backup
  $('backup-btn').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = e => { if (e.target.files[0]) loadBackup(e.target.files[0]); };
    const menu = document.createElement('div');
    menu.style.cssText = 'position:fixed;z-index:9999;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:8px;box-shadow:0 8px 32px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:4px;top:60px;right:16px';
    menu.innerHTML = '<button class="btn-icon" id="_bk_dl">💾 Télécharger backup</button><button class="btn-icon" id="_bk_ul">📂 Restaurer backup</button>';
    document.body.appendChild(menu);
    menu.querySelector('#_bk_dl').onclick = () => { downloadBackup(); menu.remove(); };
    menu.querySelector('#_bk_ul').onclick = () => { inp.click(); menu.remove(); };
    setTimeout(() => document.addEventListener('click', function h(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', h); } }), 10);
  });

  // Where modal
  $('close-where-btn').addEventListener('click', () => $('where-modal').classList.add('hidden'));
  $('tracks-wrap').addEventListener('click', e => {
    const btn = e.target.closest('.where-btn');
    if (btn) { e.stopPropagation(); showWhere(btn.dataset.uri, btn.dataset.name); }
  });

  // Split modal
  $('split-btn').addEventListener('click', showSplitModal);
  $('close-split-btn').addEventListener('click', () => $('split-modal').classList.add('hidden'));
  document.querySelectorAll('.split-opt').forEach(btn =>
    btn.addEventListener('click', () => computeSplit(btn.dataset.by))
  );
  $('split-spotify-btn').addEventListener('click', splitToSpotify);

  $('search-music-btn').addEventListener('click', openSearchModal);
  $('search-toolbar-btn').addEventListener('click', openSearchModal);
  $('reco-btn').addEventListener('click', showRecommendations);
  $('close-reco-btn').addEventListener('click', () => $('reco-modal').classList.add('hidden'));
  $('reco-add-btn').addEventListener('click', addRecoToLibrary);
  $('reco-select-all-btn').addEventListener('click', recoSelectAll);
  $('reco-refresh-btn').addEventListener('click', showRecommendations);
  $('close-search-btn').addEventListener('click', () => $('search-modal').classList.add('hidden'));
  $('search-modal-btn').addEventListener('click', runSearch);
  $('search-modal-input').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
  $('search-add-lib-btn').addEventListener('click', addSearchToLibrary);
  $('search-select-all-btn').addEventListener('click', searchSelectAll);

  $('close-stats-btn').addEventListener('click', () => $('stats-modal').classList.add('hidden'));

  // Wrapped
  $('wrapped-btn').addEventListener('click', showWrapped);

  // Share card
  $('share-btn').addEventListener('click', generateShareCard);
  $('close-share-btn').addEventListener('click', () => $('share-modal').classList.add('hidden'));

  // Mood picker
  $('mood-btn').addEventListener('click', showMoodPicker);
  $('close-mood-btn').addEventListener('click', () => $('mood-modal').classList.add('hidden'));
  document.querySelectorAll('.mood-btn').forEach(btn =>
    btn.addEventListener('click', () => applyMood(btn.dataset.mood))
  );

  // Lyrics panel
  $('lyrics-close-btn').addEventListener('click', () => {
    $('lyrics-panel').classList.add('hidden');
    currentLyricsTrack = null;
  });

  // Last.fm auto-sync resume
  resumeLastfmAutoSync();

  $('mini-player-btn').addEventListener('click', () => {
    if (!currentAudio) return;
    if (currentAudio.paused) { currentAudio.play(); $('mini-player-btn').textContent = '⏸'; if (currentPlayBtn) currentPlayBtn.textContent = '⏸'; }
    else { currentAudio.pause(); $('mini-player-btn').textContent = '▶'; if (currentPlayBtn) currentPlayBtn.textContent = '▶'; }
  });
  $('mini-player-close').addEventListener('click', () => {
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    if (currentPlayBtn) { currentPlayBtn.textContent = '▶'; currentPlayBtn = null; }
    hideMiniPlayer();
  });
  $('close-export-btn').addEventListener('click', () => $('export-modal').classList.add('hidden'));
  $('copy-uris-btn').addEventListener('click', copyUris);
  $('export-csv-btn').addEventListener('click', exportCsv);
  document.querySelectorAll('.modal').forEach(m =>
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); })
  );
});
