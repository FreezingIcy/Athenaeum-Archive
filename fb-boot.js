/*!
 * Athenaeum · fb-boot.js — canonical shared Firebase bootstrap
 * ------------------------------------------------------------------
 * FB_BOOT_VER : 2026.07.27.C   (2026-07-27: ตัด auto-redirect ออก เหลือ popup ล้วน
 *               ตามแบบ CTD ที่ launch จริงมาแล้วและพิสูจน์ว่า popup พอ ไม่ต้อง redirect fallback)
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
 *     FB.assertVer('2026.07.27.C');           // กัน drift (optional แต่แนะนำ)
 *     const uid = FB.user.uid;                // ทุก path ต้องขึ้นต้นด้วย users/<uid>/
 *     const snap = await FB.getDoc(FB.doc(FB.db, 'users', uid, 'apps', 'papyrus', 'meta', 'card'));
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
 *   window.__FB_BOOT_VER = '2026.07.27.C'
 *   window.FB_SIGN_IN()  = เรียกจาก user gesture เท่านั้น (popup ล้วน — ไม่มี redirect fallback แล้ว)
 *   window.FB_SIGN_OUT()
 */

import { initializeApp }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup,
  onAuthStateChanged, signOut,
  setPersistence, browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, updateDoc,
  collection, getDocs, query, where, orderBy, limit,
  onSnapshot, writeBatch, serverTimestamp, deleteField
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ── constants ─────────────────────────────────────────────────── */

const FB_BOOT_VER = '2026.07.27.C';
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
 * เรียกจาก user gesture (คลิกปุ่ม) เท่านั้น — popup ล้วน ๆ
 * เหตุผล: CTD (launch จริงมาแล้ว) พิสูจน์แล้วว่า popup อย่างเดียวพอ
 * ไม่จำเป็นต้องมี redirect fallback ที่ซับซ้อนและเสี่ยง Safari storage-partitioning bug
 */
async function signIn() {
  try {
    await signInWithPopup(auth, provider);
    return true;
  } catch (err) {
    const code = (err && err.code) || '';
    if (code.includes('popup-closed-by-user') || code.includes('cancelled-popup-request')) {
      return false; // user ปิด popup เอง ไม่ใช่ error จริง ไม่ต้องแจ้ง
    }
    console.error('[fb-boot] signIn failed', err);
    fire('fb-auth-required', { error: err });
    return false;
  }
}

async function signOutNow() {
  await signOut(auth);
}

/* ── boot sequence ─────────────────────────────────────────────── */

try {
  await setPersistence(auth, browserLocalPersistence);
} catch (e) {
  console.warn('[fb-boot] persistence fallback', e);
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    hadUser = true;
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
  } else {                       // ยังไม่เคย login เลย — โชว์ gate เฉย ๆ ไม่ redirect เอง
    fire('fb-auth-required', { error: null });
  }
});

/* หมายเหตุ: ไฟล์นี้โหลดผ่าน <script type="module" src="..."> เท่านั้น
   ทุกอย่างส่งออกทาง window.__FB / window.__fbReady — ไม่มี export เพราะไม่มีใคร import */
