import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

const firebaseConfig = {
  apiKey: "AIzaSyBqUaNlFlKcyl86kaDDN196eRTGOJtlxkY",
  authDomain: "urbex-alberta-test.firebaseapp.com",
  projectId: "urbex-alberta-test",
  storageBucket: "urbex-alberta-test.firebasestorage.app",
  messagingSenderId: "324527243889",
  appId: "1:324527243889:web:9d506e8ecd4d00330791d0"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
let guestMode = sessionStorage.getItem('guestMode') === '1';

function normalizeRole(role) {
  const value = (role || '').toString().trim().toLowerCase();
  if (value === 'owner' || value === 'admin' || value === 'editor' || value === 'member' || value === 'visitor') return value;
  return 'visitor';
}

function roleLabel(role) {
  const r = normalizeRole(role);
  return r.charAt(0).toUpperCase() + r.slice(1);
}

function closeAccountDropdown() {
  const dropdown = document.getElementById('accountDropdown');
  const btn = document.getElementById('accountMenuBtn');
  if (dropdown) dropdown.style.display = 'none';
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function updateAccountUi(user) {
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
  const displayName = (user.displayName || '').trim() || (user.email ? user.email.split('@')[0] : 'Account');
  const role = normalizeRole(sessionStorage.getItem('userRole') || 'member');
  nameEl.textContent = `${displayName} (${roleLabel(role)})`;
  avatarEl.textContent = (displayName[0] || 'U').toUpperCase();
  wrap.style.display = 'block';
}

function wireHeaderActions() {
  const menuBtn = document.getElementById('accountMenuBtn');
  const settingsBtn = document.getElementById('accountSettingsBtn');
  const signOutBtn = document.getElementById('accountSignOutBtn');
  const headerSignInBtn = document.getElementById('headerSignInBtn');
  const dropdown = document.getElementById('accountDropdown');

  if (menuBtn && dropdown) {
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const open = dropdown.style.display !== 'none';
      dropdown.style.display = open ? 'none' : 'block';
      menuBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
    };
  }
  if (settingsBtn) settingsBtn.onclick = () => { closeAccountDropdown(); window.location.href = 'settings.html'; };
  if (signOutBtn) signOutBtn.onclick = async () => {
    closeAccountDropdown();
    guestMode = false;
    sessionStorage.removeItem('guestMode');
    sessionStorage.removeItem('authSignedIn');
    sessionStorage.removeItem('userRole');
    await signOut(auth);
    updateAccountUi(null);
  };
  if (headerSignInBtn) {
    headerSignInBtn.onclick = async () => {
      guestMode = false;
      sessionStorage.removeItem('guestMode');
      await signInWithPopup(auth, googleProvider);
    };
  }
  document.addEventListener('click', () => closeAccountDropdown());
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

wireHeaderActions();
wireMobileMenu();

onAuthStateChanged(auth, (user) => {
  if (!user) {
    guestMode = sessionStorage.getItem('guestMode') === '1';
    updateAccountUi(null);
    return;
  }
  sessionStorage.setItem('authSignedIn', '1');
  if (user.isAnonymous) {
    sessionStorage.setItem('userRole', 'visitor');
  } else {
    sessionStorage.removeItem('guestMode');
    guestMode = false;
    if (!sessionStorage.getItem('userRole')) sessionStorage.setItem('userRole', 'member');
  }
  updateAccountUi(user);
});
