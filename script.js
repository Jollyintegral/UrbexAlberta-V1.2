// --- Firebase (Firestore for storing spots) ---
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { 
  getFirestore, collection, addDoc, getDocs, serverTimestamp, doc, updateDoc, getDoc 
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js';

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
const SPOTS_COLLECTION = 'spots';
let userRole = null;
let map; // Global map variable
const spotSearchIndex = [];

function normalizeRole(role) {
  return (role || '').toString().trim().toLowerCase();
}

function isVisitorRole() {
  return normalizeRole(userRole) === 'visitor';
}

function isAdminRole() {
  return normalizeRole(userRole) === 'admin';
}

function upsertSpotSearchEntry(spotId, name, marker) {
  const normalizedName = (name || 'Unnamed spot').trim() || 'Unnamed spot';
  const existing = spotSearchIndex.find((entry) => entry.spotId === spotId);
  if (existing) {
    existing.name = normalizedName;
    existing.marker = marker;
    return;
  }
  spotSearchIndex.push({ spotId, name: normalizedName, marker });
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
    const nameLower = entry.name.toLowerCase();
    if (nameLower.startsWith(q)) startsWith.push(entry);
    else if (nameLower.includes(q)) includes.push(entry);
  }

  return [...startsWith, ...includes].slice(0, limit);
}

function focusSpotResult(match) {
  if (!match || !match.marker || !map || !map.hasLayer(match.marker)) return;
  const latLng = match.marker.getLatLng();
  map.flyTo([latLng.lat, latLng.lng], Math.max(map.getZoom(), 16), { duration: 0.7 });
  setTimeout(() => {
    match.marker.openPopup();
  }, 450);
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

    input.addEventListener('input', () => {
      if (error.textContent) error.textContent = '';
      const query = input.value.trim();
      if (!query || parseCoordinateInput(query)) {
        clearResults();
        return;
      }
      renderResults(getSpotSearchMatches(query, 8));
    });

    return container;
  };

  coordControl.addTo(map);
}

function normalizeSpotClass(value) {
  if (value === 'default' || value === 'confirmed' || value === 'risky' || value === 'unsure') return value;
  // Backward compatibility: old "abandoned" class now maps to "unsure" (yellow).
  if (value === 'abandoned') return 'unsure';
  return 'default';
}

const MARKER_ICON_URLS = {
  default: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  confirmed: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png',
  risky: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
  unsure: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-yellow.png'
};

const MARKER_SHADOW_URL = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png';
const spotIconCache = {};

// Marker icon factory using Leaflet default marker style with class colors.
function getSpotIcon(spotClass) {
  const normalized = normalizeSpotClass(spotClass);
  if (!spotIconCache[normalized]) {
    spotIconCache[normalized] = L.icon({
      iconUrl: MARKER_ICON_URLS[normalized],
      shadowUrl: MARKER_SHADOW_URL,
      iconSize: [25, 41],
      iconAnchor: [12, 41],
      popupAnchor: [1, -34],
      shadowSize: [41, 41]
    });
  }
  return spotIconCache[normalized];
}

async function loadSpots() {
  try {
    const snapshot = await getDocs(collection(db, SPOTS_COLLECTION));
    snapshot.forEach((docSnap) => {
      const d = docSnap.data();
      const lat = d.lat ?? d.latitude;
      const lng = d.lng ?? d.longitude;
      if (lat == null || lng == null) return;
      const spotClass = normalizeSpotClass(d.spotClass);
      const spotComments = Array.isArray(d.comments) ? d.comments : [];
      const spotName = d.name || 'Unnamed spot';
      const m = L.marker([lat, lng], { draggable: false, icon: getSpotIcon(spotClass) }).addTo(map);
      m._spotId = docSnap.id;
      m._spotClass = spotClass;
      m._spotComments = spotComments;
      m.bindPopup(createSpotPopup({ marker: m, spotId: docSnap.id, name: spotName, desc: d.description || '', imageUrl: d.imageUrl || '', spotClass, comments: spotComments, editMode: false }), { minWidth: 220 });
      upsertSpotSearchEntry(docSnap.id, spotName, m);
    });
  } catch (err) {
    console.warn('Could not load spots from Firestore:', err);
  }
}

let addMode = false;

async function verifyKey() {
  const key = document.getElementById("keyInput").value;

  if (!key.trim()) {
    document.getElementById("gateError").textContent = 'Please enter a key';
    document.getElementById("gateError").style.display = 'block';
    return;
  }

  document.getElementById("gateError").style.display = 'none';

  try {
    let resolvedRole = null;

    // Fetch role from Firestore keys collection (no hardcoded keys in client code)
    const docRef = doc(db, "keys", key);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      resolvedRole = docSnap.data().role || null;
    }

    if (resolvedRole) {
      userRole = normalizeRole(resolvedRole);
      sessionStorage.setItem('mapUnlocked', '1');
      sessionStorage.setItem('userRole', userRole);
      document.getElementById("gate").style.display = 'none';
      if (!map) runMapApp();
    } else {
      document.getElementById("gateError").textContent = 'Invalid key';
      document.getElementById("gateError").style.display = 'block';
    }
  } catch (error) {
    document.getElementById("gateError").textContent = 'Error: ' + error.message;
    document.getElementById("gateError").style.display = 'block';
  }
}

// Expose to global scope for onclick handler
window.verifyKey = verifyKey;

function runMapApp() {
  if (!window.L) throw new Error('Leaflet failed to load. Check internet or blocked unpkg.com');

  // Create the map
  map = L.map('map').setView([53.5444, -113.4909], 12);

  // Street
  const street = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '© OpenStreetMap contributors' }
  );

  // Satellite
  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Tiles © Esri' }
  );

  // Roads overlay
  const roads = L.tileLayer(
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Roads © Esri' }
  );

  // Town / city names
  const places = L.tileLayer(
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Places © Esri' }
  );

  // Hybrid = satellite + roads + places
  const hybrid = L.layerGroup([satellite, roads, places]);

  // Default view
  hybrid.addTo(map);

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

  // Add Street View control to map (plugin)
  if (window.L && typeof L.control.streetView === 'function') {
    setTimeout(() => {
      L.control.streetView().addTo(map);
    }, 500);
  }

  // Load spots
  loadSpots();

  // Add spot button handler (only for non-visitors)
  if (!isVisitorRole()) {
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
    if (isVisitorRole() || !addMode) return;
    const newMarker = L.marker(e.latlng, { draggable: true, icon: getSpotIcon('default') }).addTo(map);
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
      try {
        const ref = await addDoc(collection(db, SPOTS_COLLECTION), { lat: pos.lat, lng: pos.lng, name, description: desc, spotClass, comments: [], createdAt: serverTimestamp() });
        let imageUrl = '';
        if (fileInput.files[0]) {
          imageUrl = await uploadSpotImage(ref.id, fileInput.files[0]);
          await updateDoc(doc(db, SPOTS_COLLECTION, ref.id), { imageUrl });
        }
        newMarker._spotId = ref.id;
        newMarker._spotClass = spotClass;
        newMarker._spotComments = [];
        newMarker.dragging.disable();
        newMarker.setIcon(getSpotIcon(spotClass));
        newMarker.getPopup().setContent(createSpotPopup({ marker: newMarker, spotId: ref.id, name, desc, imageUrl, spotClass, comments: newMarker._spotComments, editMode: false }));
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

// Toolbar: B, U, Img. Img = open file picker for spot image (pass fileInput). el = contenteditable
function addDescToolbar(el, spotImageInput) {
  const bar = document.createElement('div');
  bar.className = 'spot-desc-toolbar';
  bar.innerHTML = '<button type="button" class="spot-desc-tool-btn">B</button> <button type="button" class="spot-desc-tool-btn">U</button> <button type="button" class="spot-desc-tool-btn">Img</button>';
  bar.querySelectorAll('button')[0].onclick = () => { el.focus(); document.execCommand('bold'); };
  bar.querySelectorAll('button')[1].onclick = () => { el.focus(); document.execCommand('underline'); };
  bar.querySelectorAll('button')[2].onclick = () => { if (spotImageInput) spotImageInput.click(); else { const u = prompt('Image URL:'); if (u) { el.focus(); document.execCommand('insertHTML', false, '<img src="'+u+'" style="max-width:100%">'); } } };
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


function createSpotPopup({ marker, spotId, name, desc, imageUrl, spotClass, comments = [], editMode, activePane = 'details' }) {
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
    const editButtonHtml = !isVisitorRole() ? '<button type="button" class="edit-spot-btn">Edit</button>' : '';
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

    if (!isVisitorRole()) {
      const editBtn = wrap.querySelector('.edit-spot-btn');
      if (editBtn) {
        editBtn.onclick = e => {
          e.preventDefault(); e.stopPropagation();
          marker.getPopup().setContent(createSpotPopup({ marker, spotId, name, desc, imageUrl, spotClass, comments: currentComments, editMode: true }));
          marker.getPopup().openPopup();
          marker.dragging.enable();
          marker.once('dragstart', () => marker.getPopup().closePopup());
        };
      }
    }

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
      <input type="file" class="spot-edit-image" accept="image/*" style="display:none">
      <div class="spot-edit-desc" contenteditable>${desc || ''}</div>
      <button type="button" class="save-edit-spot-btn">Save</button>
      <button type="button" class="delete-edit-spot-btn">Delete</button>
      <p class="edit-status"></p>`;
    // Set current class from data, with backward compatibility for older values.
    const classSel = wrap.querySelector('.spot-edit-class');
    classSel.value = normalizeSpotClass(spotClass || marker._spotClass);
    const descEl = wrap.querySelector('.spot-edit-desc');
    addDescToolbar(descEl, wrap.querySelector('.spot-edit-image'));
    wrap.querySelector('.save-edit-spot-btn').onclick = async () => {
      const newName = (wrap.querySelector('.spot-edit-name').value.trim()) || 'Unnamed spot';
      const newClass = normalizeSpotClass(classSel.value);
      const fileInput = wrap.querySelector('.spot-edit-image');
      let newImageUrl = imageUrl || '';
      try {
        if (fileInput.files[0]) newImageUrl = await uploadSpotImage(spotId, fileInput.files[0]);
        await updateDoc(doc(db, SPOTS_COLLECTION, spotId), { lat: marker.getLatLng().lat, lng: marker.getLatLng().lng, name: newName, description: descEl.innerHTML, imageUrl: newImageUrl, spotClass: newClass, updatedAt: serverTimestamp() });
        marker.dragging.disable();
        marker._spotClass = newClass;
        marker.setIcon(getSpotIcon(newClass));
        upsertSpotSearchEntry(spotId, newName, marker);
        marker.getPopup().setContent(createSpotPopup({ marker, spotId, name: newName, desc: descEl.innerHTML, imageUrl: newImageUrl, spotClass: newClass, comments: marker._spotComments || [], editMode: false }));
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
        removeSpotSearchEntry(spotId);
        map.removeLayer(marker);
      } catch (err) {
        alert('Failed to delete spot: ' + (err.code || err.message || String(err)));
      }
    };
  }
  return wrap;
}

// Check if already unlocked
if (sessionStorage.getItem('mapUnlocked') === '1') {
  userRole = normalizeRole(sessionStorage.getItem('userRole'));
  document.getElementById("gate").style.display = 'none';
  runMapApp();
}
