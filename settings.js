import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFirestore, doc, getDoc, setDoc, serverTimestamp, collection, getDocs, addDoc, query, orderBy, limit } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { getAuth, onAuthStateChanged, signOut, updateProfile } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

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
const auth = getAuth(app);
let currentUser = null;
let currentRole = 'visitor';
let currentUserDoc = null;
let roleDashboardLoaded = false;
let roleUsersCache = null;
let roleAuditCache = null;
let roleCacheTs = 0;
const ROLE_CACHE_TTL_MS = 120000;

function normalizeRole(role) {
  const raw = (role || '').toString().trim().toLowerCase();
  if (!raw) return 'visitor';
  if (raw === 'owner' || raw.startsWith('owner ')) return 'owner';
  if (raw === 'admin' || raw.startsWith('admin ')) return 'admin';
  if (raw === 'editor' || raw.startsWith('editor ')) return 'editor';
  if (raw === 'member' || raw.startsWith('member ')) return 'member';
  if (raw === 'visitor' || raw.startsWith('visitor ')) return 'visitor';
  return 'visitor';
}

function setStatus(text, isError = false) {
  const el = document.getElementById('settingsStatusText');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? '#ffb6c3' : '#d9e5ff';
}

function setAccountUi(user, role) {
  const wrap = document.getElementById('settingsAccountWrap');
  const name = document.getElementById('settingsAccountName');
  const avatar = document.getElementById('settingsAccountAvatar');
  const profileName = document.getElementById('settingsProfileName');
  const profileMeta = document.getElementById('settingsProfileMeta');
  const profileJoined = document.getElementById('settingsProfileJoined');
  const profileAvatar = document.getElementById('settingsProfileAvatar');
  const displayName = (user.displayName || '').trim() || (user.email ? user.email.split('@')[0] : 'Account');
  const first = (displayName[0] || 'U').toUpperCase();
  if (wrap) wrap.style.display = 'block';
  if (name) name.textContent = `${displayName} (${roleLabel(role)})`;
  if (avatar) avatar.textContent = first;
  if (profileName) profileName.textContent = displayName;
  if (profileMeta) profileMeta.textContent = `Role: ${roleLabel(role)}`;
  const joinedDate = currentUserDoc && currentUserDoc.createdAt && typeof currentUserDoc.createdAt.toDate === 'function'
    ? currentUserDoc.createdAt.toDate()
    : (user.metadata && user.metadata.creationTime ? new Date(user.metadata.creationTime) : null);
  if (profileJoined) profileJoined.textContent = joinedDate ? `Joined: ${joinedDate.toLocaleDateString()}` : 'Joined: -';
  if (profileAvatar) profileAvatar.textContent = first;
}

function wireMenu() {
  const btn = document.getElementById('settingsAccountBtn');
  const dropdown = document.getElementById('settingsAccountDropdown');
  const signOutBtn = document.getElementById('settingsSignOutBtn');
  if (btn && dropdown) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const open = dropdown.style.display !== 'none';
      dropdown.style.display = open ? 'none' : 'block';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    };
    document.addEventListener('click', () => {
      dropdown.style.display = 'none';
      btn.setAttribute('aria-expanded', 'false');
    });
  }
  if (signOutBtn) signOutBtn.onclick = async () => {
    await signOut(auth);
    window.location.href = 'index.html';
  };
}

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

async function loadRole(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  currentUserDoc = snap.data() || null;
  return normalizeRole((currentUserDoc || {}).role || 'visitor');
}

function wireTabs() {
  const navButtons = Array.from(document.querySelectorAll('.settings-nav-item[data-tab]'));
  const panels = Array.from(document.querySelectorAll('.settings-tab-panel[data-panel]'));
  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      navButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
      panels.forEach((panel) => {
        panel.classList.toggle('is-active', panel.getAttribute('data-panel') === tab);
      });
      if (tab === 'roles') {
        loadRoleDashboard();
      }
      setStatus('');
    });
  });
}

function canManageRoles() {
  return currentRole === 'admin' || currentRole === 'owner';
}

function roleLabel(role) {
  const r = normalizeRole(role);
  return r.charAt(0).toUpperCase() + r.slice(1);
}

function formatAuditTime(value) {
  if (!value) return '';
  if (typeof value.toDate === 'function') return value.toDate().toLocaleString();
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : '';
}

async function updateUserRole(targetUid, targetEmail, previousRole, nextRole) {
  if (!currentUser || !canManageRoles()) return;
  const cleanRole = normalizeRole(nextRole);
  if (cleanRole === 'owner' && currentRole !== 'owner') {
    throw new Error('Only Owner can assign Owner role.');
  }
  await setDoc(doc(db, 'users', targetUid), {
    role: cleanRole,
    updatedAt: serverTimestamp()
  }, { merge: true });
  await addDoc(collection(db, 'role_audit'), {
    targetUid,
    targetEmail: targetEmail || '',
    previousRole: normalizeRole(previousRole || 'visitor'),
    newRole: cleanRole,
    changedByUid: currentUser.uid,
    changedByEmail: currentUser.email || '',
    createdAt: serverTimestamp()
  });
}

async function loadRoleDashboard() {
  const block = document.getElementById('roleDashboardBlock');
  const tbody = document.getElementById('roleUsersTableBody');
  const auditList = document.getElementById('roleAuditList');
  if (!block || !tbody || !auditList) return;

  if (!canManageRoles()) {
    block.innerHTML = `<p class="settings-role-note">You do not have permission to use role management. Detected role: ${roleLabel(currentRole)}.</p>`;
    return;
  }

  if (!roleDashboardLoaded) {
    tbody.innerHTML = '<tr><td colspan="4">Loading users...</td></tr>';
  }

  const now = Date.now();
  let users = roleUsersCache;
  let auditRows = roleAuditCache;

  if (!users || !auditRows || (now - roleCacheTs) > ROLE_CACHE_TTL_MS) {
    const userSnaps = await getDocs(query(collection(db, 'users'), limit(250)));
    users = [];
    userSnaps.forEach((snap) => users.push({ uid: snap.id, ...snap.data() }));
    const auditSnaps = await getDocs(query(collection(db, 'role_audit'), orderBy('createdAt', 'desc'), limit(20)));
    auditRows = [];
    auditSnaps.forEach((snap) => auditRows.push(snap.data()));
    roleUsersCache = users;
    roleAuditCache = auditRows;
    roleCacheTs = now;
  }

  users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));

  tbody.innerHTML = users.map((u) => {
    const current = normalizeRole(u.role || 'visitor');
    const lockedOwner = current === 'owner' && currentRole !== 'owner';
    const ownerOption = currentRole === 'owner'
      ? `<option value="owner" ${current === 'owner' ? 'selected' : ''}>Owner</option>`
      : '';
    const disabledAttr = lockedOwner ? 'disabled' : '';
    return `<tr data-uid="${u.uid}">
      <td>${u.email || u.displayName || u.uid}</td>
      <td>${roleLabel(current)}</td>
      <td>
        <select class="settings-role-select" ${disabledAttr}>
          <option value="visitor" ${current === 'visitor' ? 'selected' : ''}>Visitor</option>
          <option value="member" ${current === 'member' ? 'selected' : ''}>Member</option>
          <option value="editor" ${current === 'editor' ? 'selected' : ''}>Editor</option>
          <option value="admin" ${current === 'admin' ? 'selected' : ''}>Admin</option>
          ${ownerOption}
        </select>
      </td>
      <td><button type="button" class="settings-role-save-btn" ${disabledAttr}>Save</button></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.settings-role-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      if (!tr) return;
      const uid = tr.getAttribute('data-uid');
      const sel = tr.querySelector('.settings-role-select');
      const user = users.find((u) => u.uid === uid);
      if (!uid || !sel || !user) return;
      btn.disabled = true;
      setStatus('Updating role...');
      try {
        await updateUserRole(uid, user.email || '', user.role || 'visitor', sel.value);
        roleUsersCache = null;
        roleAuditCache = null;
        setStatus('Role updated and audited.');
        await loadRoleDashboard();
      } catch (err) {
        setStatus('Role update failed: ' + (err.code || err.message || String(err)), true);
      } finally {
        btn.disabled = false;
      }
    });
  });

  auditList.innerHTML = auditRows.map((r) => {
    const when = formatAuditTime(r.createdAt);
    return `<div class="settings-audit-item">${r.changedByEmail || 'unknown'} changed ${r.targetEmail || r.targetUid || 'user'} from <strong>${roleLabel(r.previousRole || 'visitor')}</strong> to <strong>${roleLabel(r.newRole || 'visitor')}</strong> <span>${when}</span></div>`;
  }).join('') || '<div class="settings-audit-item">No role changes yet.</div>';

  roleDashboardLoaded = true;
}

async function saveSettings() {
  if (!currentUser) return;
  const displayNameInput = document.getElementById('settingsDisplayNameInput');
  const bioInput = document.getElementById('settingsProfileBioInput');
  if (!displayNameInput) return;
  const nextName = (displayNameInput.value || '').trim();
  const nextBio = bioInput ? (bioInput.value || '').trim() : '';
  setStatus('Saving...');
  try {
    await updateProfile(currentUser, { displayName: nextName });
    await setDoc(doc(db, 'users', currentUser.uid), {
      displayName: nextName,
      bio: nextBio,
      updatedAt: serverTimestamp()
    }, { merge: true });
    currentUser = auth.currentUser;
    setAccountUi(currentUser, currentRole);
    setStatus('Saved.');
  } catch (err) {
    setStatus('Save failed: ' + (err.code || err.message || String(err)), true);
  }
}

function wireForm() {
  const saveBtn = document.getElementById('settingsSaveBtn');
  const backBtn = document.getElementById('settingsBackBtn');
  if (saveBtn) saveBtn.onclick = saveSettings;
  if (backBtn) backBtn.onclick = () => { window.location.href = 'index.html'; };
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  currentUser = user;
  currentRole = await loadRole(user.uid);
  const displayNameInput = document.getElementById('settingsDisplayNameInput');
  const emailInput = document.getElementById('settingsEmailInput');
  if (displayNameInput) displayNameInput.value = user.displayName || '';
  if (emailInput) emailInput.value = user.email || '';
  const bioInput = document.getElementById('settingsProfileBioInput');
  if (bioInput) bioInput.value = (currentUserDoc && currentUserDoc.bio) ? currentUserDoc.bio : '';
  setAccountUi(user, currentRole);
});

wireMenu();
wireMobileMenu();
wireForm();
wireTabs();
