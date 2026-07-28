/*!
 * Athenaeum · fb-boot.js — canonical shared Firebase bootstrap
 * ------------------------------------------------------------------
 * FB_BOOT_VER : 2026.07.27.B   (2026-07-27: สลับ Firebase project ใหม่ทั้งระบบ)
 * หน้าที่     : init Firebase → จัดการ login → เผยแพร่ window.__FB → dispatch 'fb-ready'
 * ใช้โดย      : Athenaeum portal + ทุก plugin (Papyrus, Almanac, ...)
 *
 * ⚠️ ไฟล์นี้คือของกลาง — แก้พัง = พังทุก plugin
 *    กติกา: เล็ก · นิ่ง · ไม่มี logic ของ plugin ปนเข้ามาเด็ดขาด
 *
 * วิธีใช้ใน plugin (contract ข้อ 2 — ห้าม init firebase เอง):
 *   <script type="module" src="/fb-boot.js"></script>
 *   <script type="module">
 *     const FB = await window.__fbReady;      // รอจนพร้อม (login เสร็จแล้ว)
 *     FB.assertVer('2026.07.26.A');           // กัน drift (optional แต่แนะนำ)
 *     const snap = await FB.getDoc(FB.doc(FB.db, 'apps', 'papyrus', 'meta', 'card'));
 *   </script>
 *
 * Event ที่ยิงบน window:
 *   'fb-ready'         → detail { user, ver }   · พร้อมใช้ window.__FB แล้ว
 *   'fb-auth-required' → detail { error }       · ยังไม่ login · ให้แสดง gate + เรียก FB_SIGN_IN()
 *   'fb-signed-out'    → detail {}              · เพิ่ง sign out
 *
 * Global ที่ตั้งให้:
 *   window.__FB          = API object (มีเมื่อ login แล้วเท่านั้น)
 *   window.__PAPYRUS_FB  = alias ของตัวเดียวกัน (backward-compat กับ papyrus.html เดิม)
 *   window.__fbReady     = Promise<API>
 *   window.__FB_BOOT_VER = '2026.07.27.B'
 *   window.FB_SIGN_IN()  = เรียกจาก user gesture เท่านั้น (popup → fallback redirect)
 *   window.FB_SIGN_OUT()
 *
 * Flag ที่ตั้งก่อนโหลดไฟล์นี้ได้ (optional):
 *   window.__FB_AUTO_SIGNIN = false   → ไม่ redirect เอง รอ gesture อย่างเดียว
 *   window.__FB_EXPECTED_EMAIL = 'x@gmail.com' → เตือนตอน login ผิด account
 */

import { initializeApp }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithRedirect, signInWithPopup,
  getRedirectResult, onAuthStateChanged, signOut,
  setPersistence, browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, updateDoc,
  collection, getDocs, query, where, orderBy, limit,
  onSnapshot, writeBatch, serverTimestamp, deleteField
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ── constants ─────────────────────────────────────────────────── */

const FB_BOOT_VER = '2026.07.27.B';
const SDK_VER = '10.12.2';

// ⚠️ 2026-07-27 · สลับมาใช้ Firebase project ใหม่ทั้งระบบ (แทน almanac-papyrus-archive-35513 เดิม)
//    project: athenaeum-archive
const firebaseConfig = {
  apiKey: 'AIzaSyDF75zErm5ArBxxUOUabM05HOB0l8q3JbY',
  authDomain: 'athenaeum-archive.firebaseapp.com',
  projectId: 'athenaeum-archive',
  storageBucket: 'athenaeum-archive.firebasestorage.app',
  messagingSenderId: '257956817757',
  appId: '1:257956817757:web:acb0156df5aab6734f16b4'
};

// กัน redirect loop: ถ้าเด้งไป login แล้วกลับมายัง sign-out อยู่ จะไม่เด้งซ้ำอีก
const LOOP_KEY = 'fb-boot:redirect-attempted';
const AUTO_SIGNIN = window.__FB_AUTO_SIGNIN !== false;
const EXPECTED_EMAIL = window.__FB_EXPECTED_EMAIL || '';

/* ── init ──────────────────────────────────────────────────────── */

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

function fire(name, detail) {
  try { window.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); }
  catch (e) { console.error('[fb-boot] dispatch failed', name, e); }
}

/* ── public API (signature ล็อกให้ตรง Papyrus STORE adapter) ────── */

const API = {
  // core — Papyrus adapter คาด 7 ตัวนี้
  db, doc, getDoc, setDoc, deleteDoc, collection, getDocs,
  // extras — plugin ใหม่ใช้ได้ ไม่กระทบของเดิม
  app, auth, updateDoc, query, where, orderBy, limit,
  onSnapshot, writeBatch, serverTimestamp, deleteField,
  // meta
  FB_BOOT_VER, SDK_VER,
  user: null,
  signIn, signOutNow,
  assertVer(expected) {
    if (expected && expected !== FB_BOOT_VER) {
      throw new Error(
        `[fb-boot] version mismatch — plugin ต้องการ ${expected} แต่ของกลางเป็น ${FB_BOOT_VER}`
      );
    }
    return FB_BOOT_VER;
  }
};

let _resolve;
const ready = new Promise((res) => { _resolve = res; });
let published = false;
let hadUser = false;

window.__fbReady = ready;
window.__FB_BOOT_VER = FB_BOOT_VER;
window.FB_SIGN_IN = signIn;
window.FB_SIGN_OUT = signOutNow;

/* ── sign in / out ─────────────────────────────────────────────── */

/**
 * เรียกจาก user gesture (คลิกปุ่ม) เท่านั้น
 * ลอง popup ก่อน → ถ้าเบราว์เซอร์บล็อก/ไม่รองรับ ค่อย fallback เป็น redirect
 * เหตุผล: Safari iOS + storage partitioning ทำให้ signInWithRedirect เงียบได้
 */
async function signIn() {
  try {
    sessionStorage.setItem(LOOP_KEY, '1');
  } catch (e) { /* private mode */ }
  try {
    await signInWithPopup(auth, provider);
    return true;
  } catch (err) {
    const code = err && err.code || '';
    const popupFailed =
      code.includes('popup-blocked') ||
      code.includes('popup-closed-by-user') ||
      code.includes('cancelled-popup-request') ||
      code.includes('operation-not-supported-in-this-environment');
    if (!popupFailed) {
      console.error('[fb-boot] signIn failed', err);
      fire('fb-auth-required', { error: err });
      return false;
    }
    if (code.includes('popup-closed-by-user')) {
      fire('fb-auth-required', { error: err });
      return false;
    }
    await signInWithRedirect(auth, provider);
    return true;
  }
}

async function signOutNow() {
  try { sessionStorage.setItem(LOOP_KEY, '1'); } catch (e) { /* noop */ }
  await signOut(auth);
}

/* ── boot sequence ─────────────────────────────────────────────── */

let redirectErr = null;

try {
  await setPersistence(auth, browserLocalPersistence);
} catch (e) {
  console.warn('[fb-boot] persistence fallback', e);
}

try {
  await getRedirectResult(auth);
} catch (e) {
  redirectErr = e;
  console.error('[fb-boot] getRedirectResult', e);
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    hadUser = true;
    try { sessionStorage.removeItem(LOOP_KEY); } catch (e) { /* noop */ }

    if (EXPECTED_EMAIL && user.email !== EXPECTED_EMAIL) {
      fire('fb-auth-required', {
        error: new Error(`login ด้วย ${user.email} ซึ่งไม่ตรงกับ ${EXPECTED_EMAIL} — Firestore Rules จะปฏิเสธ`)
      });
      return;
    }

    API.user = user;
    window.__FB = API;
    window.__PAPYRUS_FB = API;   // alias — papyrus.html เดิมไม่ต้องแก้ชื่อ
    if (!published) { published = true; _resolve(API); }
    fire('fb-ready', { user, ver: FB_BOOT_VER });
    return;
  }

  API.user = null;

  if (hadUser) {                 // เพิ่งกด sign out
    hadUser = false;
    fire('fb-signed-out', {});
    return;
  }

  let tried = false;
  try { tried = !!sessionStorage.getItem(LOOP_KEY); } catch (e) { tried = false; }

  if (AUTO_SIGNIN && !tried && !redirectErr) {
    try { sessionStorage.setItem(LOOP_KEY, '1'); } catch (e) { /* noop */ }
    signInWithRedirect(auth, provider).catch((err) => {
      console.error('[fb-boot] signInWithRedirect', err);
      fire('fb-auth-required', { error: err });
    });
  } else {
    fire('fb-auth-required', { error: redirectErr });
  }
});

export { FB_BOOT_VER, SDK_VER, API, ready, signIn, signOutNow };
