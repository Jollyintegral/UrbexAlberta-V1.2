// --- Firebase (Firestore for storing spots) ---
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { 
  getFirestore, collection, addDoc, getDocs, serverTimestamp, doc, updateDoc, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut,
  signInAnonymously
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

const firebaseConfig = {
  apiKey: "AIzaSyBqUaNlFlKcyl86kaDDN196eRTGOJtlxkY",
  authDomain: "urbex-alberta-test.firebaseapp.com",
  projectId: "urbex-alberta-test",
  storageBucket: "urbex-alberta-test.firebasestorage.app",
  messagingSenderId: "324527243889",
  appId: "1:324527243889:web:9d506e8ecd4d00330791d0"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
const SPOTS_COLLECTION = 'spots';
const ROLE_RANK = { visitor: 0, member: 1, editor: 2, admin: 3, owner: 4 };
const SPOTS_CACHE_KEY = 'spotsCacheV1';
const SPOTS_CACHE_TS_KEY = 'spotsCacheTsV1';
const SPOTS_CACHE_TTL_MS = 120000;
let guestMode = false;
let userRole = null;
let currentUser = null;
let map; // Global map variable
let spotClusterGroup;
const spotSearchIndex = [];
let activeLinkControlsCloser = null;

function normalizeRole(role) {
  const value = (role || '').toString().trim().toLowerCase();
  if (value === 'owner' || value === 'admin' || value === 'editor' || value === 'member' || value === 'visitor') return value;
  return 'visitor';
}

function roleLabel(role) {
  const r = normalizeRole(role);
  return r.charAt(0).toUpperCase() + r.slice(1);
}

function normalizeVisibilityRole(role) {
  const value = (role || '').toString().trim().toLowerCase();
  if (value === 'visitor' || value === 'member' || value === 'editor') return value;
  return 'visitor';
}

function roleAtLeast(role, minimum) {
  return (ROLE_RANK[normalizeRole(role)] ?? 0) >= (ROLE_RANK[normalizeRole(minimum)] ?? 0);
}

function isVisitorRole() {
  return normalizeRole(userRole) === 'visitor';
}

function isAdminRole() {
  const role = normalizeRole(userRole);
  return role === 'admin' || role === 'owner';
}

function canEditSpots() {
  return roleAtLeast(userRole, 'editor');
}

function canViewSpot(minRole) {
  return roleAtLeast(userRole, normalizeVisibilityRole(minRole || 'visitor'));
}

function upsertSpotSearchEntry(spotId, name, marker) {
  const normalizedName = (name || 'Unnamed spot').trim() || 'Unnamed spot';
  const existing = spotSearchIndex.find((entry) => entry.spotId === spotId);
  if (existing) {
    existing.name = normalizedName;
    existing.nameLower = normalizedName.toLowerCase();
    existing.marker = marker;
    return;
  }
  spotSearchIndex.push({ spotId, name: normalizedName, nameLower: normalizedName.toLowerCase(), marker });
}

function removeSpotSearchEntry(spotId) {
  const idx = spotSearchIndex.findIndex((entry) => entry.spotId === spotId);
  if (idx >= 0) spotSearchIndex.splice(idx, 1);
}

function getSpotSearchMatches(query, limit = 8) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];

  const startsWith = [];
  const includes = [];
  for (const entry of spotSearchIndex) {
    if (entry.nameLower.startsWith(q)) startsWith.push(entry);
    else if (entry.nameLower.includes(q)) includes.push(entry);
  }

  return [...startsWith, ...includes].slice(0, limit);
}

function focusSpotResult(match) {
  if (!match || !match.marker || !map) return;
  const markerAvailable = spotClusterGroup
    ? spotClusterGroup.hasLayer(match.marker)
    : map.hasLayer(match.marker);
  if (!markerAvailable) return;
  const latLng = match.marker.getLatLng();
  if (spotClusterGroup && typeof spotClusterGroup.zoomToShowLayer === 'function') {
    map.flyTo([latLng.lat, latLng.lng], Math.max(map.getZoom(), 14), { duration: 0.7 });
    spotClusterGroup.zoomToShowLayer(match.marker, () => {
      match.marker.openPopup();
    });
    return;
  }

  map.flyTo([latLng.lat, latLng.lng], Math.max(map.getZoom(), 16), { duration: 0.7 });
  setTimeout(() => match.marker.openPopup(), 450);
}

function parseCoordinateInput(input) {
  if (!input) return null;
  const cleaned = input.trim().replace(/[()]/g, '');
  if (!cleaned) return null;

  const parts = cleaned.includes(',')
    ? cleaned.split(',').map((p) => p.trim()).filter(Boolean)
    : cleaned.split(/\s+/).map((p) => p.trim()).filter(Boolean);

  if (parts.length !== 2) return null;

  const lat = Number(parts[0]);
  const lng = Number(parts[1]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lat, lng };
}

function addCoordinateSearchControl() {
  const coordControl = L.control({ position: 'topleft' });

  coordControl.onAdd = function () {
    const container = L.DomUtil.create('div', 'coord-search-control');
    container.innerHTML = `
      <form class="coord-search-form">
        <input type="text" class="coord-search-input" placeholder="Search" aria-label="Search coordinates">
        <button type="submit" class="coord-search-btn">Search</button>
      </form>
      <div class="coord-search-error" aria-live="polite"></div>
      <ul class="coord-search-results" role="listbox" aria-label="Matching spots"></ul>
    `;

    const form = container.querySelector('.coord-search-form');
    const input = container.querySelector('.coord-search-input');
    const error = container.querySelector('.coord-search-error');
    const results = container.querySelector('.coord-search-results');

    function clearResults() {
      results.innerHTML = '';
      results.style.display = 'none';
    }

    function renderResults(matches) {
      results.innerHTML = '';
      if (!matches.length) {
        results.style.display = 'none';
        return;
      }

      for (const match of matches) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'coord-search-result-btn';
        btn.textContent = match.name;
        btn.onclick = () => {
          input.value = match.name;
          error.textContent = '';
          clearResults();
          focusSpotResult(match);
        };
        li.appendChild(btn);
        results.appendChild(li);
      }
      results.style.display = 'block';
    }

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const query = input.value.trim();
      if (!query) {
        clearResults();
        error.textContent = '';
        return;
      }

      const parsed = parseCoordinateInput(query);
      if (parsed) {
        clearResults();
        error.textContent = '';
        map.flyTo([parsed.lat, parsed.lng], Math.max(map.getZoom(), 15), {
          duration: 0.7
        });
        return;
      }

      const matches = getSpotSearchMatches(query, 8);
      if (!matches.length) {
        clearResults();
        error.textContent = 'No matching spots';
        return;
      }

      error.textContent = '';
      renderResults(matches);
      focusSpotResult(matches[0]);
    });

    let searchDebounceTimer = null;
    input.addEventListener('input', () => {
      if (error.textContent) error.textContent = '';
      const query = input.value.trim();
      if (!query || parseCoordinateInput(query)) {
        clearResults();
        return;
      }
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        renderResults(getSpotSearchMatches(query, 8));
      }, 180);
    });

    return container;
  };

  coordControl.addTo(map);
}

function formatLatLng(latlng) {
  if (!latlng) return '';
  return `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
}

async function copyTextToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(ta);
  return copied;
}

function buildMapContextMenu(latlng) {
  const coordsText = formatLatLng(latlng);
  const mapsUrl = `https://www.google.com/maps?q=${encodeURIComponent(coordsText)}`;
  const wrap = document.createElement('div');
  wrap.className = 'coord-context-menu';
  wrap.innerHTML = `
    <button type="button" class="coord-context-action" data-action="copy">Copy coordinates</button>
    <button type="button" class="coord-context-action" data-action="google">Open in Google Maps</button>
    <div class="coord-context-value">${escapeHtml(coordsText)}</div>
    <p class="coord-context-status" aria-live="polite"></p>
  `;

  const statusEl = wrap.querySelector('.coord-context-status');
  const copyBtn = wrap.querySelector('[data-action="copy"]');
  const googleBtn = wrap.querySelector('[data-action="google"]');

  copyBtn.onclick = async (e) => {
    e.preventDefault();
    try {
      const copied = await copyTextToClipboard(coordsText);
      statusEl.textContent = copied ? 'Coordinates copied.' : 'Could not copy coordinates.';
    } catch (err) {
      statusEl.textContent = 'Could not copy coordinates.';
    }
  };

  googleBtn.onclick = (e) => {
    e.preventDefault();
    window.open(mapsUrl, '_blank', 'noopener,noreferrer');
  };

  return wrap;
}

function normalizeSpotClass(value) {
  if (value === 'default' || value === 'confirmed' || value === 'risky' || value === 'unsure') return value;
  // Backward compatibility: old "abandoned" class now maps to "unsure" (yellow).
  if (value === 'abandoned') return 'unsure';
  return 'default';
}

function makeMinimalPinDataUrl(fillColor) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 40">
    <defs>
      <filter id="s" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="1.6" stdDeviation="1.2" flood-color="#000" flood-opacity=".28"/>
      </filter>
    </defs>
    <path filter="url(#s)" d="M14 2C7.9 2 3 6.9 3 13c0 8.5 9.5 18.7 10 19.2a1.4 1.4 0 0 0 2 0C15.5 31.7 25 21.5 25 13c0-6.1-4.9-11-11-11z" fill="${fillColor}"/>
    <circle cx="14" cy="13" r="6.2" fill="#f4f8ff"/>
  </svg>`;
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}

const MARKER_ICON_URLS = {
  default: makeMinimalPinDataUrl('#6f86bf'),
  confirmed: makeMinimalPinDataUrl('#33c06d'),
  risky: makeMinimalPinDataUrl('#ef4f76'),
  unsure: makeMinimalPinDataUrl('#e7c74b')
};

const MARKER_SHADOW_URL = '';
const spotIconCache = {};

// Marker icon factory using Leaflet default marker style with class colors.
function getSpotIcon(spotClass) {
  const normalized = normalizeSpotClass(spotClass);
  if (!spotIconCache[normalized]) {
    spotIconCache[normalized] = L.icon({
      iconUrl: MARKER_ICON_URLS[normalized],
      shadowUrl: MARKER_SHADOW_URL || undefined,
      iconSize: [28, 40],
      iconAnchor: [14, 36],
      popupAnchor: [1, -30]
    });
  }
  return spotIconCache[normalized];
}

function cacheSpotsForSession(spots) {
  try {
    sessionStorage.setItem(SPOTS_CACHE_KEY, JSON.stringify(spots));
    sessionStorage.setItem(SPOTS_CACHE_TS_KEY, String(Date.now()));
  } catch {}
}

function getCachedSpots() {
  try {
    const ts = Number(sessionStorage.getItem(SPOTS_CACHE_TS_KEY) || '0');
    if (!ts || (Date.now() - ts) > SPOTS_CACHE_TTL_MS) return null;
    const raw = sessionStorage.getItem(SPOTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clearSpotsCache() {
  try {
    sessionStorage.removeItem(SPOTS_CACHE_KEY);
    sessionStorage.removeItem(SPOTS_CACHE_TS_KEY);
  } catch {}
}

function renderSpotData(spotId, d) {
  const lat = d.lat ?? d.latitude;
  const lng = d.lng ?? d.longitude;
  if (lat == null || lng == null) return;
  const spotClass = normalizeSpotClass(d.spotClass);
  const spotComments = Array.isArray(d.comments) ? d.comments : [];
  const spotName = d.name || 'Unnamed spot';
  const minRole = normalizeVisibilityRole(d.minRole || 'visitor');
  if (!canViewSpot(minRole)) return;
  const m = L.marker([lat, lng], { draggable: false, icon: getSpotIcon(spotClass) }).addTo(spotClusterGroup || map);
  m._spotId = spotId;
  m._spotClass = spotClass;
  m._spotComments = spotComments;
  m._spotName = spotName;
  m._spotDesc = d.description || '';
  m._spotImageUrl = d.imageUrl || '';
  m._spotMinRole = minRole;
  m.bindPopup('<div class="spot-popup-loading">Loading...</div>', { minWidth: 220 });
  m.on('popupopen', () => {
    m.getPopup().setContent(createSpotPopup({
      marker: m,
      spotId: m._spotId,
      name: m._spotName || 'Unnamed spot',
      desc: m._spotDesc || '',
      imageUrl: m._spotImageUrl || '',
      spotClass: m._spotClass || 'default',
      minRole: m._spotMinRole || 'visitor',
      comments: m._spotComments || [],
      editMode: false
    }));
  });
  upsertSpotSearchEntry(spotId, spotName, m);
}

async function loadSpots() {
  const cached = getCachedSpots();
  if (cached) {
    cached.forEach((entry) => renderSpotData(entry.id, entry.data));
    return;
  }
  try {
    const snapshot = await getDocs(collection(db, SPOTS_COLLECTION));
    const cacheRows = [];
    snapshot.forEach((docSnap) => {
      const d = docSnap.data();
      cacheRows.push({ id: docSnap.id, data: d });
      renderSpotData(docSnap.id, d);
    });
    cacheSpotsForSession(cacheRows);
  } catch (err) {
    console.warn('Could not load spots from Firestore:', err);
  }
}

function clearRenderedSpots() {
  if (spotClusterGroup && typeof spotClusterGroup.clearLayers === 'function') {
    spotClusterGroup.clearLayers();
  } else if (map) {
    map.eachLayer((layer) => {
      if (layer && typeof layer.getLatLng === 'function') map.removeLayer(layer);
    });
  }
  spotSearchIndex.length = 0;
}

let addMode = false;

async function ensureUserRoleDoc(user) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      email: user.email || '',
      displayName: user.displayName || '',
      role: 'member',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    return 'member';
  }
  const data = snap.data() || {};
  await setDoc(ref, {
    email: user.email || data.email || '',
    displayName: user.displayName || data.displayName || '',
    updatedAt: serverTimestamp()
  }, { merge: true });
  return normalizeRole(data.role || 'member');
}

function setAuthStatus(message, isError = false) {
  const authStatus = document.getElementById('authStatus');
  if (!authStatus) return;
  authStatus.textContent = message || '';
  authStatus.style.display = message ? 'block' : 'none';
  authStatus.style.color = isError ? '#ffb6c3' : '#d9e5ff';
}

function setSignedInUserUi(user, role) {
  const userEl = document.getElementById('signedInUser');
  if (!userEl) return;
  if (!user) {
    userEl.textContent = '';
    userEl.style.display = 'none';
    return;
  }
  const email = user.email || 'Signed in user';
  userEl.textContent = `${email} (${roleLabel(role || 'visitor')})`;
  userEl.style.display = 'block';
}

function getUserDisplayLabel(user) {
  if (!user) return 'Account';
  if (user.displayName && user.displayName.trim()) return user.displayName.trim();
  if (user.email && user.email.includes('@')) return user.email.split('@')[0];
  return 'Account';
}

function updateAccountMenuUi(user, role) {
  const wrap = document.getElementById('accountMenuWrap');
  const nameEl = document.getElementById('accountMenuName');
  const avatarEl = document.getElementById('accountMenuAvatar');
  const headerSignInBtn = document.getElementById('headerSignInBtn');
  const isGuestUser = !!(user && user.isAnonymous);
  if (headerSignInBtn) headerSignInBtn.style.display = ((!user && guestMode) || isGuestUser) ? 'inline-flex' : 'none';
  if (!wrap || !nameEl || !avatarEl) return;
  if (!user || isGuestUser) {
    wrap.style.display = 'none';
    return;
  }
  const label = getUserDisplayLabel(user);
  const roleSuffix = role ? ` (${roleLabel(role)})` : '';
  nameEl.textContent = `${label}${roleSuffix}`;
  avatarEl.textContent = (label[0] || 'U').toUpperCase();
  wrap.style.display = 'block';
  if (headerSignInBtn) headerSignInBtn.style.display = 'none';
}

function closeAccountDropdown() {
  const dropdown = document.getElementById('accountDropdown');
  const btn = document.getElementById('accountMenuBtn');
  if (dropdown) dropdown.style.display = 'none';
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleAccountDropdown() {
  const dropdown = document.getElementById('accountDropdown');
  const btn = document.getElementById('accountMenuBtn');
  if (!dropdown || !btn) return;
  const open = dropdown.style.display !== 'none';
  dropdown.style.display = open ? 'none' : 'block';
  btn.setAttribute('aria-expanded', open ? 'false' : 'true');
}

function wireAccountMenu() {
  const menuBtn = document.getElementById('accountMenuBtn');
  const settingsBtn = document.getElementById('accountSettingsBtn');
  const signOutBtn = document.getElementById('accountSignOutBtn');
  if (menuBtn) menuBtn.onclick = (e) => { e.stopPropagation(); toggleAccountDropdown(); };
  if (settingsBtn) settingsBtn.onclick = () => {
    closeAccountDropdown();
    window.location.href = 'settings.html';
  };
  if (signOutBtn) signOutBtn.onclick = async () => { closeAccountDropdown(); await signOut(auth); };
  document.addEventListener('click', () => closeAccountDropdown());
}

function wireAuthButtons() {
  const signInBtn = document.getElementById('googleSignInBtn');
  const signOutBtn = document.getElementById('signOutBtn');
  const continueGuestBtn = document.getElementById('continueGuestBtn');
  const headerSignInBtn = document.getElementById('headerSignInBtn');
  if (signInBtn) {
    signInBtn.onclick = async () => {
      setAuthStatus('');
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (error) {
        setAuthStatus('Google sign-in failed: ' + (error.code || error.message || String(error)), true);
      }
    };
  }
  if (signOutBtn) {
    signOutBtn.onclick = async () => {
      try {
        await signOut(auth);
      } catch (error) {
        setAuthStatus('Sign out failed: ' + (error.code || error.message || String(error)), true);
      }
    };
  }
  if (continueGuestBtn) {
    continueGuestBtn.onclick = async () => {
      guestMode = true;
      userRole = 'visitor';
      sessionStorage.setItem('guestMode', '1');
      setAuthStatus('');
      try {
        await signInAnonymously(auth);
        const gateEl = document.getElementById('gate');
        if (gateEl) gateEl.style.display = 'none';
        if (!map) runMapApp();
      } catch (error) {
        const code = error && error.code ? String(error.code) : '';
        if (code === 'auth/admin-restricted-operation') {
          // Fallback: still allow local visitor mode if anonymous auth is disabled in Firebase.
          const gateEl = document.getElementById('gate');
          if (gateEl) gateEl.style.display = 'none';
          if (!map) runMapApp();
          setAuthStatus('Guest mode started (local visitor). Enable Anonymous auth in Firebase for full guest auth.', false);
          return;
        }
        setAuthStatus('Guest mode failed: ' + (error.code || error.message || String(error)), true);
      }
    };
  }
  if (headerSignInBtn) {
    headerSignInBtn.onclick = async () => {
      setAuthStatus('');
      try {
        guestMode = false;
        sessionStorage.removeItem('guestMode');
        await signInWithPopup(auth, googleProvider);
      } catch (error) {
        setAuthStatus('Google sign-in failed: ' + (error.code || error.message || String(error)), true);
      }
    };
  }
}

function initAuthGate() {
  const gateEl = document.getElementById('gate');
  const signInBtn = document.getElementById('googleSignInBtn');
  const signOutBtn = document.getElementById('signOutBtn');
  wireAuthButtons();
  guestMode = sessionStorage.getItem('guestMode') === '1';
  if (guestMode) {
    userRole = 'visitor';
    updateAccountMenuUi(null, null);
    if (gateEl) gateEl.style.display = 'none';
    if (!map) runMapApp();
  }
  if (sessionStorage.getItem('authSignedIn') === '1' && gateEl) {
    gateEl.style.display = 'none';
  }
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      currentUser = null;
      guestMode = sessionStorage.getItem('guestMode') === '1';
      userRole = guestMode ? 'visitor' : 'visitor';
      sessionStorage.removeItem('authSignedIn');
      if (!guestMode) sessionStorage.removeItem('guestMode');
      setSignedInUserUi(null, null);
      updateAccountMenuUi(null, null);
      if (signInBtn) signInBtn.style.display = 'inline-flex';
      if (signOutBtn) signOutBtn.style.display = 'none';
      if (gateEl) gateEl.style.display = guestMode ? 'none' : 'flex';
      if (guestMode && !map) runMapApp();
      return;
    }

      currentUser = user;
      guestMode = false;
      sessionStorage.setItem('authSignedIn', '1');
      sessionStorage.removeItem('guestMode');
      setAuthStatus('');
    try {
      if (user.isAnonymous || guestMode) {
        userRole = 'visitor';
      } else {
        userRole = await ensureUserRoleDoc(user);
      }
      sessionStorage.setItem('userRole', normalizeRole(userRole));
      setSignedInUserUi(user, userRole);
      updateAccountMenuUi(user, userRole);
      if (signInBtn) signInBtn.style.display = 'none';
      if (signOutBtn) signOutBtn.style.display = 'inline-flex';
      if (gateEl) gateEl.style.display = 'none';
      if (!map) runMapApp();
      else {
        clearRenderedSpots();
        loadSpots();
      }
    } catch (error) {
      userRole = 'visitor';
      setSignedInUserUi(user, userRole);
      updateAccountMenuUi(user, userRole);
      setAuthStatus('Could not load your role. Defaulting to visitor.', true);
      if (signInBtn) signInBtn.style.display = 'none';
      if (signOutBtn) signOutBtn.style.display = 'inline-flex';
      if (gateEl) gateEl.style.display = 'none';
      if (!map) runMapApp();
    }
  });
}

function runMapApp() {
  if (!window.L) throw new Error('Leaflet failed to load. Check internet or blocked unpkg.com');

  // Create the map
  map = L.map('map', { zoomControl: false }).setView([53.5444, -113.4909], 12);

  // Street
  const street = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: 'Â© OpenStreetMap contributors' }
  );

  // Satellite
  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Tiles Â© Esri' }
  );

  // Roads overlay
  const roads = L.tileLayer(
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Roads © Esri', opacity: 0.8 }
  );
  // Hybrid = satellite + major roads (cleaner labels)
  const hybrid = L.layerGroup([satellite, roads]);

  // Default view
  hybrid.addTo(map);
  if (typeof L.markerClusterGroup === 'function') {
    spotClusterGroup = L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 15,
      maxClusterRadius: 55
    });
  } else {
    console.warn('Leaflet marker clustering plugin not available. Falling back to regular markers.');
    spotClusterGroup = L.layerGroup();
  }
  map.addLayer(spotClusterGroup);

  // Layer switcher
  const baseMaps = {
    "Street Map": street,
    "Satellite": satellite,
    "Hybrid": hybrid
  };

  L.control.layers(baseMaps, null, {
    position: 'topright'
  }).addTo(map);
  addCoordinateSearchControl();

  map.on('contextmenu', (e) => {
    const popupContent = buildMapContextMenu(e.latlng);
    L.popup({
      minWidth: 260,
      maxWidth: 280,
      className: 'coord-context-popup'
    })
      .setLatLng(e.latlng)
      .setContent(popupContent)
      .openOn(map);
  });

  // Add Street View control to map (plugin)
  if (window.L && typeof L.control.streetView === 'function') {
    setTimeout(() => {
      L.control.streetView().addTo(map);
    }, 500);
  }

  // Load spots
  loadSpots();

  // Add spot button handler (only for non-visitors)
  if (canEditSpots()) {
    document.getElementById("addSpotBtn").onclick = () => {
      addMode = true;
      alert("Click on the map to add a spot");
    };
  } else {
    // Hide add button for visitors
    document.getElementById("addSpotBtn").style.display = 'none';
  }

  // Map click handler
  map.on("click", async function (e) {
    if (!canEditSpots() || !addMode) return;
    const newMarker = L.marker(e.latlng, { draggable: true, icon: getSpotIcon('default') }).addTo(spotClusterGroup || map);
    newMarker._spotClass = 'default';
    newMarker._spotComments = [];
    const wrap = document.createElement('div');
    wrap.className = 'spot-popup-view spot-create-form';
    wrap.innerHTML = `<div class="spot-create-title">New Spot</div>
      <select id="spotClass" class="spot-edit-class spot-create-class">
        <option value="default">No Class</option>
        <option value="confirmed">&#9989; Confirmed</option>
        <option value="risky">&#128308; Risky</option>
        <option value="unsure">&#128993; Unsure</option>
      </select>
      <select id="spotMinRole" class="spot-edit-class spot-create-class">
        <option value="visitor">Visitor+</option>
        <option value="member">Member+</option>
        <option value="editor">Editor+</option>
      </select>
      <input type="text" id="spotName" class="spot-edit-name spot-create-name" placeholder="Name">
      <input type="file" id="spotImage" accept="image/*" style="display:none">
      <div id="spotDesc" class="spot-edit-desc spot-create-desc" contenteditable></div>
      <button type="button" id="saveSpotBtn" class="save-edit-spot-btn spot-create-save-btn">Save to cloud</button>
      <p id="saveStatus" class="edit-status spot-create-status"></p>`;
    addDescToolbar(wrap.querySelector('#spotDesc'), wrap.querySelector('#spotImage'));
    newMarker.bindPopup(wrap, { minWidth: 240 }).openPopup();
    wrap.querySelector('#spotClass').onchange = function() {
      const selectedClass = normalizeSpotClass(this.value);
      newMarker._spotClass = selectedClass;
      newMarker.setIcon(getSpotIcon(selectedClass));
    };
    wrap.querySelector('#saveSpotBtn').onclick = async () => {
      const name = (wrap.querySelector('#spotName').value.trim()) || 'Unnamed spot';
      const desc = wrap.querySelector('#spotDesc').innerHTML;
      const pos = newMarker.getLatLng();
      const fileInput = wrap.querySelector('#spotImage');
      const spotClass = normalizeSpotClass(wrap.querySelector('#spotClass').value);
      const minRole = normalizeVisibilityRole(wrap.querySelector('#spotMinRole').value);
      try {
        const ref = await addDoc(collection(db, SPOTS_COLLECTION), { lat: pos.lat, lng: pos.lng, name, description: desc, spotClass, minRole, comments: [], createdAt: serverTimestamp() });
        let imageUrl = '';
        if (fileInput.files[0]) {
          imageUrl = await uploadSpotImage(ref.id, fileInput.files[0]);
          await updateDoc(doc(db, SPOTS_COLLECTION, ref.id), { imageUrl });
        }
        newMarker._spotId = ref.id;
        newMarker._spotClass = spotClass;
        newMarker._spotComments = [];
        newMarker._spotName = name;
        newMarker._spotDesc = desc;
        newMarker._spotImageUrl = imageUrl;
        newMarker._spotMinRole = minRole;
        newMarker.dragging.disable();
        newMarker.setIcon(getSpotIcon(spotClass));
        newMarker.getPopup().setContent(createSpotPopup({ marker: newMarker, spotId: ref.id, name, desc, imageUrl, spotClass, minRole, comments: newMarker._spotComments, editMode: false }));
        clearSpotsCache();
        upsertSpotSearchEntry(ref.id, name, newMarker);
        wrap.querySelector('#saveStatus').textContent = 'Saved!';
        wrap.querySelector('#saveStatus').style.color = '#8ec5ff';
      } catch (err) {
        wrap.querySelector('#saveStatus').textContent = 'Error: ' + (err.code || err.message || String(err));
        wrap.querySelector('#saveStatus').style.color = '#ffb6c3';
      }
    };
    addMode = false;
  });
}

async function uploadSpotImage(spotId, file) {
  const r = ref(storage, `spots/${spotId}/image`);
  await uploadBytes(r, file);
  return await getDownloadURL(r);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function normalizeLinkUrl(rawUrl) {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function showInlineToast(rootEl, message) {
  if (!rootEl) return;
  const existing = rootEl.querySelector('.spot-inline-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'spot-inline-toast';
  toast.textContent = message;
  rootEl.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 1500);
}

function unlinkAnchor(anchor) {
  if (!anchor || !anchor.parentNode) return;
  const textNode = document.createTextNode(anchor.textContent || '');
  anchor.parentNode.replaceChild(textNode, anchor);
}

function getLinkActionButtonsHtml(includeEdit) {
  return `
    ${includeEdit ? `<button type="button" class="spot-link-control-btn spot-link-control-icon-btn" data-action="edit" title="Edit link" aria-label="Edit link">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4zm14.7-11.3c.4-.4.4-1 0-1.4l-2-2a1 1 0 0 0-1.4 0l-1.6 1.6 4 4 1-1.2z"/></svg>
    </button>` : ''}
    <button type="button" class="spot-link-control-btn spot-link-control-icon-btn" data-action="copy" title="Copy link" aria-label="Copy link">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16h-9V7h9v14z"/></svg>
    </button>
    <button type="button" class="spot-link-control-btn spot-link-control-icon-btn" data-action="open" title="Open in new tab" aria-label="Open in new tab">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3h-7zM5 5h6V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6h-2v6H5V5z"/></svg>
    </button>
  `;
}

function addEditableLinkSupport(editableEl) {
  if (!editableEl || editableEl.dataset.linkSupportBound === '1') return;
  editableEl.dataset.linkSupportBound = '1';

  let controls = null;
  let editor = null;
  let activeAnchor = null;

  function closeControls() {
    if (controls) controls.remove();
    controls = null;
    activeAnchor = null;
  }

  function closeEditor() {
    if (editor) editor.remove();
    editor = null;
  }

  function getRangeRect(range) {
    if (!range) return null;
    const rects = range.getClientRects();
    if (rects && rects.length) return rects[0];
    if (!range.collapsed) return range.getBoundingClientRect();
    const clone = range.cloneRange();
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    clone.insertNode(marker);
    const rect = marker.getBoundingClientRect();
    marker.remove();
    return rect;
  }

  function placeFloatingBox(box, targetEl, sourceRange = null) {
    const parentRect = editableEl.parentNode.getBoundingClientRect();
    const anchorRect = getRangeRect(sourceRange) || targetEl.getBoundingClientRect();
    const gap = 8;
    const minLeft = 6;
    const maxLeft = Math.max(minLeft, parentRect.width - box.offsetWidth - 6);
    const left = Math.min(maxLeft, Math.max(minLeft, anchorRect.left - parentRect.left));
    const preferredTop = anchorRect.top - parentRect.top - box.offsetHeight - gap;
    const fallbackTop = anchorRect.bottom - parentRect.top + gap;
    const maxTop = Math.max(0, parentRect.height - box.offsetHeight - 6);
    const top = preferredTop >= 0 ? preferredTop : fallbackTop;
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(0, Math.min(maxTop, top))}px`;
  }

  function openLinkEditor({ targetAnchor = null, sourceRange = null }) {
    closeEditor();
    if (targetAnchor) closeControls();
    const selectedText = targetAnchor
      ? (targetAnchor.textContent || '')
      : (window.getSelection() ? window.getSelection().toString().trim() : '');
    const selectedHref = targetAnchor
      ? (targetAnchor.getAttribute('href') || '')
      : '';

    editor = document.createElement('div');
    editor.className = 'spot-link-editor';
    editor.innerHTML = `
      <label class="spot-link-editor-label">Text</label>
      <input type="text" class="spot-link-editor-input" data-field="text" placeholder="Link text">
      <label class="spot-link-editor-label">URL</label>
      <input type="text" class="spot-link-editor-input" data-field="url" placeholder="https://example.com">
      <div class="spot-link-editor-actions">
        <button type="button" class="spot-link-editor-btn" data-action="apply">Apply</button>
        <button type="button" class="spot-link-editor-btn" data-action="cancel">Cancel</button>
        ${targetAnchor ? '<button type="button" class="spot-link-editor-btn spot-link-editor-unlink" data-action="unlink">Unlink</button>' : ''}
      </div>
    `;
    editableEl.parentNode.appendChild(editor);

    const textInput = editor.querySelector('[data-field="text"]');
    const urlInput = editor.querySelector('[data-field="url"]');
    textInput.value = selectedText;
    urlInput.value = selectedHref || 'https://';
    placeFloatingBox(editor, targetAnchor || editableEl, sourceRange);
    textInput.focus();

    editor.addEventListener('click', (e) => {
      const action = e.target.getAttribute('data-action');
      if (!action) return;
      e.preventDefault();
      if (action === 'cancel') {
        closeEditor();
        return;
      }
      if (action === 'unlink' && targetAnchor) {
        unlinkAnchor(targetAnchor);
        closeEditor();
        return;
      }
      if (action !== 'apply') return;

      const nextText = (textInput.value || '').trim();
      const nextHref = normalizeLinkUrl(urlInput.value || '');
      if (!nextHref) return;

      if (targetAnchor) {
        targetAnchor.textContent = nextText || nextHref;
        targetAnchor.href = nextHref;
        targetAnchor.target = '_blank';
        targetAnchor.rel = 'noopener noreferrer';
        closeEditor();
        return;
      }

      editableEl.focus();
      const sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      if (sourceRange) sel.addRange(sourceRange);
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);

      const anchor = document.createElement('a');
      anchor.href = nextHref;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = nextText || nextHref;

      if (!range.collapsed) range.deleteContents();
      range.insertNode(anchor);
      range.setStartAfter(anchor);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      closeEditor();
    });
  }

  function openControls(anchor) {
    closeControls();
    closeEditor();
    activeAnchor = anchor;
    controls = document.createElement('div');
    controls.className = 'spot-link-controls';
    controls.innerHTML = getLinkActionButtonsHtml(true);
    editableEl.parentNode.appendChild(controls);
    placeFloatingBox(controls, anchor);
  }

  editableEl.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a || !editableEl.contains(a)) {
      closeControls();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    openControls(a);
  });

  if (!activeLinkControlsCloser) {
    activeLinkControlsCloser = (evt) => {
      const t = evt && evt.target;
      if (t && typeof t.closest === 'function') {
        if (t.closest('.spot-link-editor')) return;
        if (t.closest('.spot-link-controls')) return;
        if (t.closest('.spot-desc-toolbar')) return;
      }
      document.querySelectorAll('.spot-link-controls').forEach((el) => el.remove());
      document.querySelectorAll('.spot-link-editor').forEach((el) => el.remove());
    };
    document.addEventListener('click', activeLinkControlsCloser);
  }

  editableEl.parentNode.addEventListener('click', (e) => {
    if (!controls || !controls.contains(e.target)) return;
    const actionEl = e.target.closest('[data-action]');
    const action = actionEl ? actionEl.getAttribute('data-action') : null;
    if (!action || !activeAnchor) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === 'edit') {
      openLinkEditor({ targetAnchor: activeAnchor });
      closeControls();
      return;
    }
    if (action === 'copy') {
      const href = activeAnchor.href || activeAnchor.getAttribute('href') || '';
      if (!href) return;
      copyTextToClipboard(href).then((copied) => {
        showInlineToast(editableEl.parentNode, copied ? 'Copied link to clipboard' : 'Could not copy link');
      }).catch(() => {
        showInlineToast(editableEl.parentNode, 'Could not copy link');
      });
      return;
    }
    if (action === 'open') {
      const href = activeAnchor.href || activeAnchor.getAttribute('href') || '';
      if (!href) return;
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  });

  return {
    openNewLinkEditor() {
      editableEl.focus();
      const sel = window.getSelection();
      let savedRange = null;
      if (sel && sel.rangeCount) {
        const candidate = sel.getRangeAt(0);
        if (editableEl.contains(candidate.commonAncestorContainer)) {
          savedRange = candidate.cloneRange();
        }
      }
      if (!savedRange) {
        savedRange = document.createRange();
        savedRange.selectNodeContents(editableEl);
        savedRange.collapse(false);
      }
      openLinkEditor({ sourceRange: savedRange });
    }
  };
}

function addViewOnlyLinkSupport(rootEl, options = {}) {
  if (!rootEl) return;
  const descEl = rootEl.querySelector('.spot-desc');
  if (!descEl || descEl.dataset.viewLinkBound === '1') return;
  descEl.dataset.viewLinkBound = '1';
  let controls = null;
  let activeAnchor = null;
  const onEditLink = typeof options.onEditLink === 'function' ? options.onEditLink : null;

  function closeControls() {
    if (controls) controls.remove();
    controls = null;
    activeAnchor = null;
  }

  function placeViewControls(anchor) {
    if (!controls || !anchor) return;
    const parentRect = rootEl.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const gap = 8;
    const minLeft = 6;
    const maxLeft = Math.max(minLeft, parentRect.width - controls.offsetWidth - 6);
    const left = Math.min(maxLeft, Math.max(minLeft, anchorRect.left - parentRect.left));
    const preferredTop = anchorRect.top - parentRect.top - controls.offsetHeight - gap;
    const fallbackTop = anchorRect.bottom - parentRect.top + gap;
    controls.style.left = `${left}px`;
    controls.style.top = `${preferredTop >= 0 ? preferredTop : fallbackTop}px`;
  }

  function openControls(anchor) {
    closeControls();
    activeAnchor = anchor;
    controls = document.createElement('div');
    controls.className = 'spot-link-controls';
    controls.innerHTML = getLinkActionButtonsHtml(!!onEditLink);
    rootEl.appendChild(controls);
    placeViewControls(anchor);
  }

  descEl.addEventListener('click', (e) => {
    const anchor = e.target.closest('a');
    if (!anchor || !descEl.contains(anchor)) {
      closeControls();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    openControls(anchor);
  });

  rootEl.addEventListener('click', (e) => {
    if (!controls || !controls.contains(e.target)) return;
    const actionEl = e.target.closest('[data-action]');
    const action = actionEl ? actionEl.getAttribute('data-action') : null;
    if (!action || !activeAnchor) return;
    e.preventDefault();
    e.stopPropagation();
    const href = activeAnchor.href || activeAnchor.getAttribute('href') || '';
    if (action === 'edit' && onEditLink) {
      onEditLink();
      return;
    }
    if (action === 'copy') {
      if (!href) return;
      copyTextToClipboard(href).then((copied) => {
        showInlineToast(rootEl, copied ? 'Copied link to clipboard' : 'Could not copy link');
      }).catch(() => {
        showInlineToast(rootEl, 'Could not copy link');
      });
      return;
    }
    if (action === 'open') {
      if (!href) return;
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  });

  if (!activeLinkControlsCloser) {
    activeLinkControlsCloser = (evt) => {
      const t = evt && evt.target;
      if (t && typeof t.closest === 'function') {
        if (t.closest('.spot-link-editor')) return;
        if (t.closest('.spot-link-controls')) return;
        if (t.closest('.spot-desc-toolbar')) return;
      }
      document.querySelectorAll('.spot-link-controls').forEach((el) => el.remove());
      document.querySelectorAll('.spot-link-editor').forEach((el) => el.remove());
    };
    document.addEventListener('click', activeLinkControlsCloser);
  };
}

// Toolbar: B, U, Link, Img. Img = open file picker for spot image (pass fileInput). el = contenteditable
function addDescToolbar(el, spotImageInput) {
  const bar = document.createElement('div');
  bar.className = 'spot-desc-toolbar';
  bar.innerHTML = '<button type="button" class="spot-desc-tool-btn">B</button> <button type="button" class="spot-desc-tool-btn">U</button> <button type="button" class="spot-desc-tool-btn">Link</button> <button type="button" class="spot-desc-tool-btn">Img</button>';
  const linkSupport = addEditableLinkSupport(el);
  bar.querySelectorAll('button')[0].onclick = () => { el.focus(); document.execCommand('bold'); };
  bar.querySelectorAll('button')[1].onclick = () => { el.focus(); document.execCommand('underline'); };
  bar.querySelectorAll('button')[2].onclick = () => { if (linkSupport) linkSupport.openNewLinkEditor(); };
  bar.querySelectorAll('button')[3].onclick = () => { if (spotImageInput) spotImageInput.click(); else { const u = prompt('Image URL:'); if (u) { el.focus(); document.execCommand('insertHTML', false, '<img src="'+u+'" style="max-width:100%">'); } } };
  el.before(bar);
}

function showImageOverlay(url) {
  const el = document.getElementById('imageOverlay');
  el.querySelector('img').src = url;
  el.style.display = 'flex';
  el.onclick = () => { el.style.display = 'none'; el.onclick = null; };
}

function formatCommentTime(value) {
  let ms = null;
  if (typeof value === 'number') ms = value;
  else if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) ms = parsed;
  } else if (value && typeof value.toMillis === 'function') ms = value.toMillis();
  else if (value && typeof value.seconds === 'number') ms = value.seconds * 1000;
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}


function createSpotPopup({ marker, spotId, name, desc, imageUrl, spotClass, minRole = 'visitor', comments = [], editMode, activePane = 'details' }) {
  const wrap = document.createElement('div');
  wrap.className = 'spot-popup-view';
  if (!editMode) {
    const spotLatLng = marker && typeof marker.getLatLng === 'function' ? marker.getLatLng() : null;
    const googleMapsUrl = spotLatLng
      ? `https://www.google.com/maps?q=${encodeURIComponent(`${spotLatLng.lat},${spotLatLng.lng}`)}`
      : '';
    const mapsLinkHtml = googleMapsUrl
      ? `<a class="spot-maps-link" href="${googleMapsUrl}" target="_blank" rel="noopener noreferrer">View on Google Maps</a>`
      : '';
    const currentComments = Array.isArray(comments) ? comments : [];
    const imageBlockHtml = imageUrl ? `<div class="spot-popup-title-row"><img class="spot-thumb" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(name)}"></div>` : '';
    const editButtonHtml = canEditSpots() ? '<button type="button" class="edit-spot-btn">Edit</button>' : '';
    const commentsCount = currentComments.length;
    const detailsActiveClass = activePane === 'comments' ? '' : 'is-active';
    const commentsActiveClass = activePane === 'comments' ? 'is-active' : '';
    const commentsHtml = currentComments.length
      ? currentComments.map((comment, idx) => {
          const commentText = escapeHtml((comment && comment.text) || '');
          const commentAuthor = escapeHtml((comment && comment.author) || 'User');
          const commentTime = formatCommentTime(comment && comment.createdAt);
          const timeSuffix = commentTime ? ` - ${escapeHtml(commentTime)}` : '';
          const deleteButton = isAdminRole()
            ? `<button type="button" class="spot-comment-delete-btn" data-comment-index="${idx}">Delete</button>`
            : '';
          return `<div class="spot-comment-item">
            <div class="spot-comment-meta-row">
              <div class="spot-comment-meta">${commentAuthor}${timeSuffix}</div>
              ${deleteButton}
            </div>
            <div class="spot-comment-text">${commentText}</div>
          </div>`;
        }).join('')
      : '<div class="spot-comment-empty">No comments yet.</div>';
        wrap.innerHTML = `${imageBlockHtml}
      <div class="spot-popup-body">
        <strong class="spot-popup-name">${escapeHtml(name)}</strong>
        <div class="spot-pane spot-pane-details ${detailsActiveClass}">
          <div class="spot-desc">${desc || ''}</div>
        </div>
        <div class="spot-pane spot-pane-comments ${commentsActiveClass}">
          <div class="spot-comments-wrap">
            <div class="spot-comments-list">${commentsHtml}</div>
            <div class="spot-comment-form">
              <textarea class="spot-comment-input" rows="2" maxlength="300" placeholder="Add a comment"></textarea>
              <button type="button" class="spot-comment-save-btn">Post comment</button>
              <p class="spot-comment-status"></p>
            </div>
          </div>
        </div>
        <div class="spot-popup-tabs">
          <button type="button" class="spot-tab-btn ${detailsActiveClass}" data-pane="details">Details</button>
          <button type="button" class="spot-tab-btn ${commentsActiveClass}" data-pane="comments">Comments (${commentsCount})</button>
          ${editButtonHtml}

        </div>
        <div class="spot-maps-link-wrap">${mapsLinkHtml}</div>
      </div>`;

    if (canEditSpots()) {
      const editBtn = wrap.querySelector('.edit-spot-btn');
      if (editBtn) {
        editBtn.onclick = e => {
          e.preventDefault(); e.stopPropagation();
          marker.getPopup().setContent(createSpotPopup({ marker, spotId, name, desc, imageUrl, spotClass, minRole: marker._spotMinRole || minRole, comments: currentComments, editMode: true }));
          marker.getPopup().openPopup();
          marker.dragging.enable();
          marker.once('dragstart', () => marker.getPopup().closePopup());
        };
      }
    }

    addViewOnlyLinkSupport(wrap, {
      onEditLink: canEditSpots() ? () => {
        marker.getPopup().setContent(createSpotPopup({ marker, spotId, name, desc, imageUrl, spotClass, minRole: marker._spotMinRole || minRole, comments: currentComments, editMode: true }));
        marker.getPopup().openPopup();
        marker.dragging.enable();
        marker.once('dragstart', () => marker.getPopup().closePopup());
      } : null
    });

    const thumb = wrap.querySelector('.spot-thumb');
    if (thumb) thumb.onclick = e => { e.stopPropagation(); showImageOverlay(imageUrl); };

    const tabButtons = wrap.querySelectorAll('.spot-tab-btn');
    const paneDetails = wrap.querySelector('.spot-pane-details');
    const paneComments = wrap.querySelector('.spot-pane-comments');
    tabButtons.forEach((btn) => {
      btn.onclick = () => {
        const pane = btn.getAttribute('data-pane');
        const showComments = pane === 'comments';
        tabButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
        if (paneDetails) paneDetails.classList.toggle('is-active', !showComments);
        if (paneComments) paneComments.classList.toggle('is-active', showComments);
      };
    });

    const commentInput = wrap.querySelector('.spot-comment-input');
    const commentBtn = wrap.querySelector('.spot-comment-save-btn');
    const commentStatus = wrap.querySelector('.spot-comment-status');
    if (commentBtn && commentInput) {
      commentBtn.onclick = async () => {
        const text = commentInput.value.trim();
        if (!text) {
          commentStatus.textContent = 'Write a comment first.';
          commentStatus.style.color = '#b00020';
          return;
        }
        const newComment = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text,
          author: userRole || 'User',
          createdAt: Date.now()
        };
        const nextComments = [...currentComments, newComment];
        commentBtn.disabled = true;
        commentStatus.textContent = 'Saving...';
        commentStatus.style.color = '#333';
        try {
          await updateDoc(doc(db, SPOTS_COLLECTION, spotId), {
            comments: nextComments,
            updatedAt: serverTimestamp()
          });
          marker._spotComments = nextComments;
          marker.getPopup().setContent(createSpotPopup({
            marker,
            spotId,
            name,
            desc,
            imageUrl,
            spotClass,
            minRole: marker._spotMinRole || minRole,
            comments: marker._spotComments,
            editMode: false,
            activePane: 'comments'
          }));
          marker.getPopup().openPopup();
        } catch (err) {
          commentStatus.textContent = 'Error: ' + (err.code || err.message || String(err));
          commentStatus.style.color = '#b00020';
        } finally {
          commentBtn.disabled = false;
        }
      };
    }

    if (isAdminRole()) {
      wrap.querySelectorAll('.spot-comment-delete-btn').forEach((btn) => {
        btn.onclick = async () => {
          const index = Number(btn.getAttribute('data-comment-index'));
          if (!Number.isInteger(index) || index < 0 || index >= currentComments.length) return;
          const nextComments = currentComments.filter((_, i) => i !== index);
          btn.disabled = true;
          try {
            await updateDoc(doc(db, SPOTS_COLLECTION, spotId), {
              comments: nextComments,
              updatedAt: serverTimestamp()
            });
            marker._spotComments = nextComments;
            marker.getPopup().setContent(createSpotPopup({
              marker,
              spotId,
              name,
              desc,
              imageUrl,
              spotClass,
              minRole: marker._spotMinRole || minRole,
              comments: marker._spotComments,
              editMode: false,
              activePane: 'comments'
            }));
            marker.getPopup().openPopup();
          } catch (err) {
            const msg = wrap.querySelector('.spot-comment-status');
            if (msg) {
              msg.textContent = 'Delete failed: ' + (err.code || err.message || String(err));
              msg.style.color = '#b00020';
            }
            btn.disabled = false;
          }
        };
      });
    }
  } else {
    // Add spot class selector
    wrap.innerHTML = `<input class="spot-edit-name" value="${escapeHtml(name)}" type="text">
      <select class="spot-edit-class">
        <option value="default">No Class</option>
        <option value="confirmed">&#9989; Confirmed</option>
        <option value="risky">&#128308; Risky</option>
        <option value="unsure">&#128993; Unsure</option>
      </select>
      <select class="spot-edit-min-role">
        <option value="visitor">Visitor+</option>
        <option value="member">Member+</option>
        <option value="editor">Editor+</option>
      </select>
      <input type="file" class="spot-edit-image" accept="image/*" style="display:none">
      <div class="spot-edit-desc" contenteditable>${desc || ''}</div>
      <button type="button" class="save-edit-spot-btn">Save</button>
      <button type="button" class="delete-edit-spot-btn">Delete</button>
      <p class="edit-status"></p>`;
    // Set current class from data, with backward compatibility for older values.
    const classSel = wrap.querySelector('.spot-edit-class');
    classSel.value = normalizeSpotClass(spotClass || marker._spotClass);
    const minRoleSel = wrap.querySelector('.spot-edit-min-role');
    minRoleSel.value = normalizeVisibilityRole(minRole || marker._spotMinRole || 'visitor');
    const descEl = wrap.querySelector('.spot-edit-desc');
    addDescToolbar(descEl, wrap.querySelector('.spot-edit-image'));
    wrap.querySelector('.save-edit-spot-btn').onclick = async () => {
      const newName = (wrap.querySelector('.spot-edit-name').value.trim()) || 'Unnamed spot';
      const newClass = normalizeSpotClass(classSel.value);
      const newMinRole = normalizeVisibilityRole(minRoleSel.value);
      const fileInput = wrap.querySelector('.spot-edit-image');
      let newImageUrl = imageUrl || '';
      try {
        if (fileInput.files[0]) newImageUrl = await uploadSpotImage(spotId, fileInput.files[0]);
        await updateDoc(doc(db, SPOTS_COLLECTION, spotId), { lat: marker.getLatLng().lat, lng: marker.getLatLng().lng, name: newName, description: descEl.innerHTML, imageUrl: newImageUrl, spotClass: newClass, minRole: newMinRole, updatedAt: serverTimestamp() });
        marker.dragging.disable();
        marker._spotClass = newClass;
        marker._spotName = newName;
        marker._spotDesc = descEl.innerHTML;
        marker._spotImageUrl = newImageUrl;
        marker._spotMinRole = newMinRole;
        marker.setIcon(getSpotIcon(newClass));
        clearSpotsCache();
        upsertSpotSearchEntry(spotId, newName, marker);
        marker.getPopup().setContent(createSpotPopup({ marker, spotId, name: newName, desc: descEl.innerHTML, imageUrl: newImageUrl, spotClass: newClass, minRole: newMinRole, comments: marker._spotComments || [], editMode: false }));
      } catch (err) {
        wrap.querySelector('.edit-status').textContent = 'Error: ' + (err.code || err.message || String(err));
        wrap.querySelector('.edit-status').style.color = 'red';
      }
    };
    wrap.querySelector('.delete-edit-spot-btn').onclick = async () => {
      if (!confirm('Are you sure you want to delete this spot?')) return;
      try {
        const { deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        await deleteDoc(doc(db, SPOTS_COLLECTION, spotId));
        clearSpotsCache();
        removeSpotSearchEntry(spotId);
        if (spotClusterGroup && spotClusterGroup.hasLayer(marker)) {
          spotClusterGroup.removeLayer(marker);
        } else {
          map.removeLayer(marker);
        }
      } catch (err) {
        alert('Failed to delete spot: ' + (err.code || err.message || String(err)));
      }
    };
  }
  return wrap;
}

wireAccountMenu();
function wireMobileMenu() {
  const toggle = document.querySelector('.mobile-menu-button');
  const header = document.querySelector('header');
  if (!toggle || !header) return;

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = header.classList.toggle('mobile-menu-open');
    toggle.classList.toggle('is-active', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  const drawerClose = document.querySelector('.drawer-close-button');
  if (drawerClose) {
    drawerClose.addEventListener('click', (event) => {
      event.stopPropagation();
      header.classList.remove('mobile-menu-open');
      toggle.classList.remove('is-active');
      toggle.setAttribute('aria-expanded', 'false');
    });
  }

  document.addEventListener('click', (event) => {
    if (header.classList.contains('mobile-menu-open') && !header.contains(event.target)) {
      header.classList.remove('mobile-menu-open');
      toggle.classList.remove('is-active');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

wireMobileMenu();
initAuthGate();

