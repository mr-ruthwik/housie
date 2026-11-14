/* =====================================================================
   COINS + GAME STATE - Google sign-in + Firestore (free Spark plan, no
   server code). Firestore is the place state lives (personal data in
   users/{uid}/data); only the room being played is kept on the device. Every client (host
   included) subscribes to the same Firestore documents and reacts to
   whatever changes there; the host is still the single judge of claims
   and the only one who draws numbers, but it talks to everyone else
   through Firestore instead of a peer-to-peer link.
   Every coin change is a ledger entry + balance update written together;
   the Firestore security rules (firestore.rules) check each pair.
   ===================================================================== */
window.Coins = (function () {
    const firebaseConfig = {
        apiKey: "AIzaSyAgZZl8f4yKLOBB8y1yLZBi7jcvVYxroSY",
        authDomain: "housie-v1.firebaseapp.com",
        projectId: "housie-v1",
        storageBucket: "housie-v1.firebasestorage.app",
        messagingSenderId: "702866651347",
        appId: "1:702866651347:web:5f5936063fa4bf6ff23c26"
    };
    const START_COINS = 1000;          // default welcome bonus; must match firestore.rules
    const ADMIN_EMAIL = "sairuthwik2002@gmail.com"; // must match isAdmin() in firestore.rules
    const HOUSIE_BONUS = 250;          // extra coins for winning Housie; must match firestore.rules
    const SPLIT = { jaldi: 10, line1: 15, line2: 15, line3: 15, housie: 45 };
    const PRIZE_NAMES = { jaldi: "Jaldi", line1: "1st Line", line2: "2nd Line", line3: "3rd Line", housie: "Housie" };

    const api = { user: null, balance: null, enabled: false, ready: Promise.resolve(null), SPLIT, HOUSIE_BONUS };
    if (typeof firebase === "undefined") { console.warn("Firebase SDK failed to load - coins disabled."); return api; }
    api.enabled = true;
    api.favorites = [];

    /* ---------- DEVICE STORE (Persist): ONLY the room being played ----------
       the active room (tickets, marks, room info) so a reload restores the game, and the numbers drawn in a
       "Play with Developer" match. Both are temporary, so they stay on the phone. Everything else is
       personal data and lives in Firestore (see CLOUD STORE below). */
    const AKEY = uid => "housie.active." + uid;
    api.activeSave = obj => { const u = api.user; if (u) { try { Persist.setItem(AKEY(u.uid), JSON.stringify(obj)); } catch (e) { } } };
    api.activeLoad = () => { const u = api.user; if (!u) return null; try { return JSON.parse(Persist.getItem(AKEY(u.uid)) || "null"); } catch (e) { return null; } };
    api.activeUpdate = patch => { const cur = api.activeLoad(); if (cur) api.activeSave(Object.assign(cur, patch)); };
    api.activeClear = () => { const u = api.user; if (u) { try { Persist.removeItem(AKEY(u.uid)); } catch (e) { } } };

    firebase.initializeApp(firebaseConfig);
    const auth = firebase.auth();
    const db = firebase.firestore();
    try { db.settings({ experimentalAutoDetectLongPolling: true, merge: true }); } catch (e) { }
    const TS = () => firebase.firestore.FieldValue.serverTimestamp();
    const INC = n => firebase.firestore.FieldValue.increment(n);
    const UNION = (...items) => firebase.firestore.FieldValue.arrayUnion(...items);

    const uRef = uid => db.collection("users").doc(uid);
    const lRef = (uid, id) => uRef(uid).collection("ledger").doc(id);
    const gRef = id => db.collection("games").doc(id);
    const pRef = (id, uid) => gRef(id).collection("players").doc(uid);

    /* ---------- CLOUD STORE: everything personal lives in Firestore (users/{uid}/data/...) ----------
       prefs   = { kv: { key: JSON text } }  settings, read updates, task flags ...
       history = { items: JSON text }        capped copy of the coin history (powers Stats, Tasks, Daily bonus, History)
       2 reads per sign-in; writes are debounced. Old device copies are moved here once, then removed. */
    const LMAX = 2000;
    const LEGACY = /^housie\.(name$|theme$|randomTheme$|autoSec$|awake$|updatesRead$|newSeen$|bonusPrompt$|timesRepaired\.v1$)/;
    const dRef = (uid, name) => uRef(uid).collection("data").doc(name);
    const ck = k => String(k).replace(/[.\/]/g, "_");           // map keys: no dots or slashes
    let cloud = {}, cloudDirty = {}, cloudLoaded = false, cloudLoading = null, cloudDead = false;
    let cloudTimer = null, cloudBusy = false, cloudAgain = false, cloudFails = 0, cloudWarned = false;
    let lcache = [], luid = null, histDirty = false, legacyDrop = [];
    const cloudReset = () => {
        if (cloudTimer) { clearTimeout(cloudTimer); cloudTimer = null; }
        cloud = {}; cloudDirty = {}; cloudLoaded = false; cloudLoading = null; cloudDead = false;
        cloudBusy = false; cloudAgain = false; cloudFails = 0;
        lcache = []; luid = null; histDirty = false; legacyDrop = [];
    };
    const cloudSchedule = () => { if (cloudTimer) clearTimeout(cloudTimer); cloudTimer = setTimeout(() => { cloudTimer = null; cloudFlush(); }, 800); };
    const mergeHist = (...lists) => {
        const seen = new Set(), out = [];
        lists.forEach(L => (L || []).forEach(e => {
            if (!e) return;
            if (e.id) { if (seen.has(e.id)) return; seen.add(e.id); }
            out.push(e);
        }));
        out.sort((x, y) => (Number(y.time) || 0) - (Number(x.time) || 0));
        if (out.length > LMAX) out.length = LMAX;
        return out;
    };
    api.cloudGet = k => { const c = ck(k); return Object.prototype.hasOwnProperty.call(cloud, c) ? cloud[c] : null; };
    api.cloudSet = (k, json) => { if (cloudDead || !api.user) return; const c = ck(k); cloud[c] = json; cloudDirty[c] = json; cloudSchedule(); };
    api.cloudLoaded = () => cloudLoaded;
    api.cloudReady = Promise.resolve(false);
    api.hydrateLocal = () => api.cloudReady;
    function cloudLoad(u) {
        if (cloudLoading) return cloudLoading;
        cloudLoading = (async () => {
            try {
                const [p, h] = await Promise.all([dRef(u.uid, "prefs").get(), dRef(u.uid, "history").get()]);
                if (!api.user || api.user.uid !== u.uid) return false;           // signed out / switched meanwhile
                const kv = p.exists && p.data().kv && typeof p.data().kv === "object" ? p.data().kv : {};
                cloud = Object.assign({}, kv, cloudDirty);
                let list = [];
                if (h.exists) { try { list = JSON.parse(h.data().items || "[]"); } catch (e) { list = []; } if (!Array.isArray(list)) list = []; }
                // one-time move of the old device copies (settings, coin history) into Firestore
                let dump = {}; try { dump = Persist.dump(); } catch (e) { }
                let legacyList = [];
                Object.keys(dump).forEach(k => {
                    if (k === "housie.ledger." + u.uid) { try { legacyList = JSON.parse(dump[k]) || []; } catch (e) { legacyList = []; } legacyDrop.push(k); return; }
                    if (k === "housie.hydrated." + u.uid) { legacyDrop.push(k); return; }
                    if (!LEGACY.test(k)) return;
                    const c = ck(k.slice(7));
                    if (!Object.prototype.hasOwnProperty.call(cloud, c)) { cloud[c] = dump[k]; cloudDirty[c] = dump[k]; }
                    legacyDrop.push(k);
                });
                if (!Array.isArray(legacyList)) legacyList = [];
                // very first time on a new account / device with nothing to move: pull the latest ledger once
                let fromFs = [];
                if (!h.exists && !legacyList.length) {
                    try {
                        const qs = await uRef(u.uid).collection("ledger").orderBy("time", "desc").limit(300).get();
                        const conv = d => { const x = d.data(); const t = x.time && typeof x.time.toMillis === "function" ? x.time.toMillis() : x.time; return Object.assign({}, x, { id: d.id, time: t }); };
                        fromFs = qs.docs.map(conv);
                        // also everything from this month, so the weekly / monthly task progress is complete on a new device
                        try {
                            const now = new Date(), monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
                            const mq = await uRef(u.uid).collection("ledger").where("time", ">=", monthStart).orderBy("time", "desc").limit(3000).get();
                            fromFs = fromFs.concat(mq.docs.map(conv));
                        } catch (e) { console.warn("[hydrate month]", e); }
                    } catch (e) { console.warn("[hydrate]", e); }
                }
                if (!api.user || api.user.uid !== u.uid) return false;
                luid = u.uid;
                lcache = mergeHist(list, legacyList, fromFs, lcache);
                if (!h.exists || lcache.length > list.length) histDirty = true;
                cloudLoaded = true;
                if (histDirty || Object.keys(cloudDirty).length || legacyDrop.length) cloudSchedule();
                if (api.onCloud) { try { api.onCloud(); } catch (e) { } }
                if (api.onLocal) { try { api.onLocal(); } catch (e) { } }
                setTimeout(() => api.syncLedger(true), 0);
                return true;
            } catch (e) {
                console.warn("[cloud load]", e);
                if (++cloudFails <= 3) setTimeout(cloudSchedule, 15000 * cloudFails);
                if (!cloudWarned) { cloudWarned = true; toast("Could not load your saved data. Check your connection.", "error"); }
                return false;
            } finally { cloudLoading = null; }
        })();
        return cloudLoading;
    }
    async function cloudFlush() {
        const u = api.user;
        if (cloudDead || !u) return;
        if (cloudBusy) { cloudAgain = true; return; }
        cloudBusy = true;
        try {
            if (!cloudLoaded) await cloudLoad(u);            // never write before we know what is stored
            if (cloudLoaded && !cloudDead && api.user && api.user.uid === u.uid) {
                const keys = Object.keys(cloudDirty);
                if (keys.length) {
                    const kv = {};
                    keys.forEach(k => { kv[k] = cloudDirty[k]; delete cloudDirty[k]; });
                    try { await dRef(u.uid, "prefs").set({ kv }, { merge: true }); }
                    catch (e) { keys.forEach(k => { if (!(k in cloudDirty)) cloudDirty[k] = kv[k]; }); throw e; }
                }
                if (histDirty) {
                    histDirty = false;
                    let json = JSON.stringify(lcache);
                    while (json.length > 900000 && lcache.length > 50) { lcache.length = Math.floor(lcache.length / 2); json = JSON.stringify(lcache); }
                    try { await dRef(u.uid, "history").set({ items: json }); }
                    catch (e) { histDirty = true; throw e; }
                }
                legacyDrop.splice(0).forEach(k => { try { Persist.removeItem(k); } catch (e) { } });   // now safely in Firestore
                cloudFails = 0;
            }
        } catch (e) {
            console.warn("[cloud save]", e);
            if (++cloudFails <= 3) setTimeout(cloudSchedule, 15000 * cloudFails);
            if (!cloudWarned) { cloudWarned = true; toast("Could not save your data online. Check your connection.", "error"); }
        }
        cloudBusy = false;
        if (cloudAgain) { cloudAgain = false; cloudSchedule(); }
    }
    api.cloudFlush = cloudFlush;
    api.cloudStop = () => { cloudDead = true; if (cloudTimer) { clearTimeout(cloudTimer); cloudTimer = null; } };
    document.addEventListener("visibilitychange", () => { if (document.hidden) cloudFlush(); });
    window.addEventListener("pagehide", () => { cloudFlush(); });

    // Pulls ledger entries the local copy is missing (coins received from friends, prizes paid while the app
    // was closed, rewards made on another device). The ledger is the source of truth; only entries newer than
    // what we already hold are read (1 day of overlap for clock differences), so this costs very few reads.
    let syncAt = 0, syncBusy = false;
    api.syncLedger = async force => {
        const u = api.user;
        if (!u || !cloudLoaded || syncBusy || (!force && Date.now() - syncAt < 20000)) return false;
        syncBusy = true; syncAt = Date.now();
        try {
            const newest = lcache.reduce((m, e) => Math.max(m, Number(e.time) || 0), 0);
            let q = uRef(u.uid).collection("ledger");
            if (newest) q = q.where("time", ">=", new Date(newest - 24 * 3600 * 1000));
            const qs = await q.orderBy("time", "desc").limit(500).get();
            if (!api.user || api.user.uid !== u.uid) return false;
            const have = new Set(lcache.map(e => e.id));
            const add = qs.docs.filter(d => !have.has(d.id)).map(d => {
                const x = d.data(), t = x.time && typeof x.time.toMillis === "function" ? x.time.toMillis() : x.time;
                return Object.assign({}, x, { id: d.id, time: t });
            });
            if (!add.length) return false;
            lcache = mergeHist(lcache, add);
            histDirty = true; cloudSchedule();
            if (api.onLocal) { try { api.onLocal(); } catch (e) { } }
            return true;
        } catch (e) { console.warn("[ledger sync]", e); return false; }
        finally { syncBusy = false; }
    };
    document.addEventListener("visibilitychange", () => { if (!document.hidden) api.syncLedger(); });

    // adds one history entry (newest first); an id that is already stored is ignored
    api.localAdd = entry => {
        const u = api.user;
        if (!u) return false;
        if (luid !== u.uid) { lcache = []; luid = u.uid; }
        if (entry.id && lcache.some(e => e.id === entry.id)) return false;
        lcache.unshift(Object.assign({ time: Date.now() }, entry));
        if (lcache.length > LMAX) lcache.length = LMAX;
        histDirty = true; cloudSchedule();
        if (api.onLocal) { try { api.onLocal(); } catch (e) { } }
        return true;
    };
    // changes fields of one stored history entry (used to stamp a game as played); returns false when nothing changed
    api.localPatch = (id, fields) => {
        const u = api.user;
        if (!u || luid !== u.uid) return false;
        const e = lcache.find(x => x.id === id);
        if (!e || Object.keys(fields).every(k => e[k] === fields[k])) return false;
        Object.assign(e, fields);
        histDirty = true; cloudSchedule();
        if (api.onLocal) { try { api.onLocal(); } catch (err) { } }
        return true;
    };
    api.localLedger = () => lcache.slice();

    const friendly = e => {
        console.error("[Firestore]", e);
        const m = (e && e.message) || "";
        if (/quota|resource-exhausted/i.test(m + " " + ((e && e.code) || ""))) return "Quota exceeded";
        if (/permission|insufficient/i.test(m)) return "Can't do that now. The game may have started, or you need more coins.";
        if (/network|unavailable|offline/i.test(m)) return "Network problem. Check your connection and try again.";
        return m || "Something went wrong. Try again.";
    };
    const wrap = p => p.catch(e => { throw new Error(friendly(e)); });
    const toast = (m, t) => { if (typeof showNotification === "function") showNotification(m, t); };

    const tRef = (gid, uid) => gRef(gid).collection("tickets").doc(uid);
    // Ticket grids are stored as one JSON string (Firestore can't hold arrays inside arrays).
    const parseTickets = json => { try { return JSON.parse(json || "[]"); } catch (e) { return []; } };

    let unsubUser = null, lastCoins = null;
    function watchBalance(uid) {
        if (unsubUser) unsubUser();
        lastCoins = null;
        let first = true;
        unsubUser = uRef(uid).onSnapshot(snap => {
            if (!snap.exists) return;
            const coins = snap.data().coins;
            const favRaw = snap.data().favoriteNumbers;
            api.favorites = Array.isArray(favRaw) ? favRaw.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 90) : [];
            if (api.onFavorites) { try { api.onFavorites(api.favorites); } catch (e) { } }
            const diff = api.balance === null ? 0 : coins - api.balance;
            api.balance = coins;
            document.querySelectorAll("[data-coin]").forEach(el => { el.textContent = coins; });
            if (coins !== lastCoins) { lastCoins = coins; if (api.onBalance) api.onBalance(coins); }
            if (!first && diff > 0 && Date.now() > (api.quietUntil || 0)) toast(`+${diff} coins`, "success");
            first = false;
        });
    }

    async function ensureUser(user) {
        const snap = await uRef(user.uid).get();
        // Same check as api.isAdmin(): verified Google sign-in on the admin's own email.
        const isAdmin = user.email === ADMIN_EMAIL && user.emailVerified
            && user.providerData.some(p => p.providerId === "google.com");
        if (snap.exists) {
            // Existing admin account (created before "Play with Developer"): mark it as the
            // developer automatically, once. The rules let the verified admin write this.
            // Never overwrites a live devChallenge lock.
            if (isAdmin && snap.data().isDeveloper !== true) {
                const patch = { isDeveloper: true };
                const ch = snap.data().devChallenge;
                if (!ch || typeof ch !== "object") patch.devChallenge = { active: false };
                await uRef(user.uid).update(patch);
            }
            return;
        }
        const bonus = START_COINS;
        const b = db.batch();
        // isDeveloper is set once, here, from a verified Google sign-in on the real admin
        // email - never from a later client write (firestore.rules must keep it that way).
        // It's how any player's client finds "the developer" to challenge, without any
        // client having to hardcode or claim a uid itself.
        b.set(uRef(user.uid), {
            name: (user.displayName || user.email || "Player").slice(0, 60), coins: bonus, activeGame: null,
            isDeveloper: isAdmin, devChallenge: isAdmin ? { active: false } : null
        });
        b.set(lRef(user.uid, "welcome"), { type: "bonus", amount: bonus, time: TS() });
        await b.commit();
        api.localAdd({ id: "welcome", type: "bonus", amount: bonus });
    }

    /* ---------- sign in / out ---------- */
    function updateAuthUI(user) {
        const btn = document.getElementById("btn-google");
        const btnText = document.getElementById("btn-google-text");
        if (btn && btnText) {
            btnText.textContent = user ? `Signed in: ${user.displayName || user.email}` : "Sign in with Google";
            btn.classList.toggle("signed", !!user);
        }
    }

    api.authListeners = [];

    let firstAuth = true;
    api.ready = new Promise(resolve => {
        auth.onAuthStateChanged(async user => {
            api.user = user;
            updateAuthUI(user);
            api.balance = null;
            api.favorites = [];
            cloudReset();
            if (unsubUser) { unsubUser(); unsubUser = null; }
            api.cloudReady = Promise.resolve(false);
            if (user) {
                const cl = cloudLoad(user);
                api.cloudReady = cl;
                try { await ensureUser(user); } catch (e) { console.warn("ensureUser", e); }
                watchBalance(user.uid);
                await cl;          // settings + history are in memory before the app starts
            }
            api.authListeners.forEach(f => { try { f(user); } catch (e) { console.error(e); } });
            if (firstAuth) { firstAuth = false; resolve(user); }
        });
    });

    // one Google popup at a time: extra taps while it is open are ignored
    let popupBusy = null;
    const onePopup = fn => {
        if (popupBusy) return popupBusy;
        popupBusy = Promise.resolve().then(fn).finally(() => { popupBusy = null; });
        return popupBusy;
    };
    api.signIn = () => onePopup(() => auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()));
    api.signOut = () => cloudFlush().catch(() => { }).then(() => auth.signOut());
    api.getIdToken = () => api.user.getIdToken();
    // saves this account's favorite numbers (1 to 10) on users/{uid} (the rules allow only the owner to change this field)
    api.saveFavorites = nums => {
        const u = api.user;
        if (!u) return Promise.reject(new Error("Please sign in first."));
        const clean = Array.from(new Set((nums || []).map(Number))).filter(n => Number.isInteger(n) && n >= 1 && n <= 90).sort((a, b) => a - b);
        if (clean.length < 1 || clean.length > 10) return Promise.reject(new Error("Pick 1 to 10 numbers."));
        return wrap(uRef(u.uid).update({ favoriteNumbers: clean })).then(() => { api.favorites = clean; return clean; });
    };

    /* ---------- delete account: wipes every Firestore doc of this user, then the login ---------- */
    async function wipeCollection(colRef) {
        const snap = await colRef.get();
        const jobs = [];
        for (let i = 0; i < snap.docs.length; i += 400) {
            const b = db.batch();
            snap.docs.slice(i, i + 400).forEach(d => b.delete(d.ref));
            jobs.push(b.commit());      // chunks run in parallel (was one after another)
        }
        await Promise.all(jobs);
    }
    // runs fn over items a few at a time (used by the admin "all" buttons)
    async function pool(items, fn, size) {
        const q = items.slice(), out = { ok: 0, failed: 0 };
        const worker = async () => {
            while (q.length) {
                const it = q.shift();
                try { await fn(it); out.ok++; } catch (e) { console.warn("[bulk]", e); out.failed++; }
            }
        };
        await Promise.all(Array.from({ length: Math.min(size || 5, q.length) }, worker));
        return out;
    }
    // every sub-collection a room can own (all of this is temporary play data)
    const ROOM_SUBS = ["claimRequests", "prizes", "tickets", "players"];
    // wipes all of a room's temporary data; the presence stamps are best effort (older rules may refuse them)
    const wipeRoomSubs = async ref => {
        await Promise.all(ROOM_SUBS.map(sub => wipeCollection(ref.collection(sub))));
        await wipeCollection(ref.collection("presence")).catch(() => { });
    };
    /* ---------- export: admin = whole database, everyone else = own account + history ---------- */
    // lean export (fewer reads): documents come from the list query itself (no second read per document),
    // users export their coin history (ledger) only, rooms export only their record (their players/tickets are
    // temporary play data and are not needed to restore coins)
    async function dumpDocFrom(docSnap, subs) {
        const out = { id: docSnap.id, data: docSnap.exists ? docSnap.data() : null, sub: {} };
        for (const name of subs) {
            const col = await docSnap.ref.collection(name).get().catch(() => null);
            if (col && !col.empty) out.sub[name] = col.docs.map(d => ({ id: d.id, data: d.data() }));
        }
        return out;
    }
    api.exportData = async () => {
        const me = api.user;
        if (!me) throw new Error("Please sign in first.");
        needAdmin();
        const out = { app: "Housie", exportedAt: new Date().toISOString(), by: me.uid, scope: "all", users: [], games: [], codes: [] };
        const users = await db.collection("users").get();
        for (const u of users.docs) out.users.push(await dumpDocFrom(u, ["ledger", "data"]));
        const games = await db.collection("games").get();
        for (const g of games.docs) out.games.push(await dumpDocFrom(g, []));
        const codes = await db.collection("codes").get();
        for (const c of codes.docs) out.codes.push({ id: c.id, data: c.data() });
        return out;
    };
    /* ---------- import: admin restores a backup JSON into this project ---------- */
    const fromJson = v => {
        if (v && typeof v === "object") {
            if (Array.isArray(v)) return v.map(fromJson);
            if (typeof v.__ts === "string" && Object.keys(v).length === 1) return firebase.firestore.Timestamp.fromDate(new Date(v.__ts));
            // a plain {seconds, nanoseconds} map is a Timestamp that lost its type: restore it
            if (typeof v.seconds === "number" && typeof v.nanoseconds === "number"
                && Object.keys(v).every(k => k === "seconds" || k === "nanoseconds" || k === "type")) return new firebase.firestore.Timestamp(v.seconds, v.nanoseconds);
            const o = {};
            for (const k of Object.keys(v)) o[k] = fromJson(v[k]);
            return o;
        }
        return v;
    };
    api.importData = async (backup, onProgress) => {
        needAdmin();
        if (!backup || backup.app !== "Housie") throw new Error("This is not a Housie backup file.");
        const jobs = [];
        const queue = (coll, node) => {
            if (node.data) jobs.push([db.collection(coll).doc(node.id), fromJson(node.data)]);
            for (const name of Object.keys(node.sub || {}))
                for (const d of node.sub[name]) jobs.push([db.collection(coll).doc(node.id).collection(name).doc(d.id), fromJson(d.data)]);
        };
        (backup.users || []).forEach(n => queue("users", n));
        (backup.games || []).forEach(n => queue("games", n));
        (backup.codes || []).forEach(n => queue("codes", n));
        for (let i = 0; i < jobs.length; i += 400) {
            const b = db.batch();
            jobs.slice(i, i + 400).forEach(([ref, data]) => b.set(ref, data));
            await awrap(b.commit());
            if (onProgress) onProgress(Math.min(i + 400, jobs.length), jobs.length);
        }
        return jobs.length;
    };
    /* ---------- admin repair: turn timestamps that were saved as plain {seconds, nanoseconds} maps back into real
       Timestamps. Such values sort BEFORE real timestamps, so they filled the "latest 100" lists and pushed
       today's entries out of view. Covers every user's ledger (time) and every room (createdAt / endedAt). ---------- */
    api.adminRepairTimestamps = async onProgress => {
        needAdmin();
        const isMap = v => v && typeof v === "object" && typeof v.toDate !== "function" && typeof v.seconds === "number" && typeof v.nanoseconds === "number";
        const toTs = v => new firebase.firestore.Timestamp(v.seconds, v.nanoseconds);
        const fixes = [];
        const scan = (qs, fields) => qs.forEach(d => {
            const data = d.data(), patch = {};
            fields.forEach(f => { if (isMap(data[f])) patch[f] = toTs(data[f]); });
            if (Object.keys(patch).length) fixes.push([d.ref, patch]);
        });
        const users = await db.collection("users").get();
        for (const u of users.docs) scan(await u.ref.collection("ledger").get(), ["time"]);
        scan(await db.collection("games").get(), ["createdAt", "endedAt"]);
        for (let i = 0; i < fixes.length; i += 400) {
            const b = db.batch();
            fixes.slice(i, i + 400).forEach(([ref, patch]) => b.update(ref, patch));
            await awrap(b.commit());
            if (onProgress) onProgress(Math.min(i + 400, fixes.length), fixes.length);
        }
        return fixes.length;
    };
    api.deleteAccount = async () => {
        const user = auth.currentUser;
        if (!user) throw new Error("Please sign in first.");
        const uid = user.uid;
        // fresh login first, so the final delete is allowed
        // only ask for Google again if the last login is older than 4 minutes
        const lastLogin = Date.parse(user.metadata.lastSignInTime) || 0;
        if (Date.now() - lastLogin > 4 * 60 * 1000) {
            try { await onePopup(() => user.reauthenticateWithPopup(new firebase.auth.GoogleAuthProvider())); }
            catch (e) { throw new Error("Could not confirm your login. Account not deleted."); }
        }
        try {
            api.cloudStop();             // no more saves while the account is being removed
            if (unsubUser) { unsubUser(); unsubUser = null; }
            const ledger = await uRef(uid).collection("ledger").get();
            const joined = new Set();
            ledger.forEach(d => { const g = d.data().gameId; if (g) joined.add(g); });
            const me = await uRef(uid).get();
            if (me.exists && me.data().code) await db.collection("codes").doc(me.data().code).delete().catch(() => { });
            if (me.exists && me.data().activeGame && me.data().activeGame.gameId) joined.add(me.data().activeGame.gameId);
            // rooms hosted by this user are removed completely
            const hosted = await db.collection("games").where("hostUid", "==", uid).get();
            for (const g of hosted.docs) {
                await wipeRoomSubs(g.ref);
                await g.ref.delete();
                joined.delete(g.id);
            }
            // player docs in rooms hosted by others
            for (const gid of joined) { try { await pRef(gid, uid).delete(); await tRef(gid, uid).delete(); } catch (e) { } }
            // the user document goes first: the rules only let the owner delete ledger entries once it is gone
            await uRef(uid).delete();
            await wipeCollection(uRef(uid).collection("ledger"));
            await wipeCollection(uRef(uid).collection("data")).catch(() => { });
            await user.delete();
        } catch (e) {
            throw new Error(friendly(e));
        }
    };

    const googleBtn = document.getElementById("btn-google");
    if (googleBtn) googleBtn.onclick = () => {
        if (api.user) return;
        api.signIn().catch(e => {
            if (/popup-closed|cancelled-popup|popup-blocked/i.test((e && e.code) || "")) return;
            toast("Sign-in failed: " + e.message, "error");
        });
    };

    /* ---------- low-level refs, exposed so the game logic below can read
       and write Firestore directly without this module having to wrap
       every possible call ---------- */
    api.db = db;
    api.gameRef = gRef;
    api.playerRef = pRef;
    api.userRef = uRef;
    api.arrayUnion = UNION;
    api.serverTimestamp = TS;

    /* ---------- games: create / join ---------- */
    // Pays the entry fee and writes the player / ledger / balance (and the
    // game itself for the host), all in one transaction. Also stamps the
    // joining account's "active game" pointer, which is how a refresh or a
    // different device finds its way back in (replaces localStorage).
    function enter(gid, tickets, name, hostInfo, ticketsData) {
        const uid = api.user.uid;
        const ticketsJson = JSON.stringify(ticketsData || []);
        // many people joining at the same moment contend for the same room document: retry a few times
        const retryAborted = async fn => {
            for (let i = 0; ; i++) {
                try { return await fn(); }
                catch (e) {
                    const busy = e && (e.code === "aborted" || e.code === "failed-precondition" || /contention|aborted/i.test(e.message || ""));
                    if (!busy || i >= 3) throw e;
                    await new Promise(r => setTimeout(r, 300 + Math.random() * 900));
                }
            }
        };
        return wrap(retryAborted(() => db.runTransaction(async tx => {
            const [g, p, u] = await Promise.all([tx.get(gRef(gid)), tx.get(pRef(gid, uid)), tx.get(uRef(uid))]);
            if (!u.exists) throw new Error("Account not ready. Try again in a moment.");
            const coins = u.data().coins;

            if (hostInfo) {
                const cost = hostInfo.price * tickets;
                if (coins < cost) throw new Error(`Not enough coins. You have ${coins}, need ${cost}.`);
                tx.set(gRef(gid), {
                    hostUid: uid, roomCode: hostInfo.roomCode, ticketPrice: hostInfo.price, split: SPLIT,
                    pot: cost, totalTickets: tickets, playerCount: 1, status: "open", createdAt: TS(),
                    calledNumbers: [], currentNumber: null, claimsTaken: {}, claimsLocked: {}
                });
                tx.set(pRef(gid, uid), {
                    tickets, name, isHost: true, claims: [], claimedTickets: [],
                    joinedAt: TS(), lastActive: TS()
                });
                tx.set(tRef(gid, uid), { ticketsJson, marked: {} });
                tx.set(lRef(uid, "entry_" + gid), { type: "entry", gameId: gid, amount: cost ? -cost : 0, time: TS() });
                tx.update(uRef(uid), { coins: coins - cost, lastRef: "entry_" + gid, activeGame: { gameId: gid, roomId: hostInfo.roomCode, isHost: true } });
                return { tickets, already: false, cost };
            }

            if (!g.exists) throw new Error("Room not found.");
            if (p.exists) return { already: true };
            const gd = g.data();
            if (gd.status !== "open") throw new Error("Game already started.");
            const cost = gd.ticketPrice * tickets;
            if (coins < cost) throw new Error(`Not enough coins. You have ${coins}, need ${cost}.`);
            tx.update(gRef(gid), { pot: gd.pot + cost, totalTickets: gd.totalTickets + tickets, playerCount: gd.playerCount + 1 });
            tx.set(pRef(gid, uid), {
                tickets, name, isHost: false, claims: [], claimedTickets: [],
                joinedAt: TS(), lastActive: TS()
            });
            tx.set(tRef(gid, uid), { ticketsJson, marked: {} });
            tx.set(lRef(uid, "entry_" + gid), { type: "entry", gameId: gid, amount: cost ? -cost : 0, time: TS() });
            tx.update(uRef(uid), { coins: coins - cost, lastRef: "entry_" + gid, activeGame: { gameId: gid, roomId: gd.roomCode, isHost: false } });
            return { tickets, already: false, cost };
        })).then(r => { if (r && !r.already) api.localAdd({ id: "entry_" + gid, type: "entry", gameId: gid, amount: r.cost ? -r.cost : 0, host: !!hostInfo }); return r; }));
    }

    api.createGame = (gid, roomCode, price, tickets, name, ticketsData) => enter(gid, tickets, name, { roomCode, price }, ticketsData);
    api.joinGame = (gid, tickets, name, ticketsData) => enter(gid, tickets, name, null, ticketsData);

    // A 4-digit code is "free" if no OPEN or STARTED game is currently
    // using it (a finished game's code can be reused).
    // (a room left open for 12+ hours is treated as abandoned so its code can be reused)
    api.roomCodeAvailable = code => wrap(db.collection("games").where("roomCode", "==", code).get().then(qs =>
        !qs.docs.some(d => {
            const g = d.data();
            const age = g.createdAt && g.createdAt.toMillis ? Date.now() - g.createdAt.toMillis() : 0;
            return ["open", "started"].includes(g.status) && age < 12 * 3600 * 1000;
        })
    ));

    function setStatus(gid, from, to, extra) {
        return wrap(db.runTransaction(async tx => {
            const s = await tx.get(gRef(gid));
            if (s.exists && from.includes(s.data().status)) tx.update(gRef(gid), Object.assign({ status: to }, extra || {}));
        }));
    }
    api.startGame = gid => setStatus(gid, ["open"], "started");
    // stamps endedAt for the room history; if the rules reject the extra field, ends the room without it
    api.endGame = async gid => {
        try { await setStatus(gid, ["open", "started"], "finished", { endedAt: TS() }); }
        catch (e) { await setStatus(gid, ["open", "started"], "finished"); }
    };

    // One formula for every prize. Each prize is floor(pot * % / 100), which leaves a few coins of the pot
    // unpaid. With HOUSIE_TAKES_REMAINDER the Housie prize also gets those leftover coins, so the whole pot is
    // paid out. IMPORTANT: firestore.rules must accept that Housie amount before this is switched on.
    const HOUSIE_TAKES_REMAINDER = false;
    api.prizeShare = (pot, k, split) => {
        split = split || SPLIT; pot = Number(pot) || 0;
        const f = key => Math.floor(pot * (Number(split[key]) || 0) / 100);
        if (k === "housie" && HOUSIE_TAKES_REMAINDER) {
            let rest = pot;
            Object.keys(split).forEach(key => { if (key !== "housie") rest -= f(key); });
            return Math.max(f("housie"), rest);
        }
        return f(k);
    };

    let lastBeatAt = 0, beatInDraw = true;
    api.beatAge = () => Date.now() - lastBeatAt;
    // Host heartbeat: "I am still here". Players use it to tell a live room from an abandoned one.
    // Returns the raw promise (the caller decides what a failure means).
    // Presence: each player stamps their own small document; ONLY the host listens to the collection,
    // so it costs one read per beat for the host and nothing for the other players.
    api.presenceBeat = gid => gRef(gid).collection("presence").doc(api.user.uid).set({ at: TS() });
    api.watchPresence = (gid, cb) => resilient(onErr => gRef(gid).collection("presence").onSnapshot(snap => {
        const seen = {};
        snap.docs.forEach(d => { const a = d.data().at; seen[d.id] = a && a.toMillis ? a.toMillis() : 0; });
        cb(seen);
    }, onErr));
    api.hostBeat = gid => gRef(gid).update({ hostSeenAt: TS() }).then(r => { lastBeatAt = Date.now(); return r; });

    // Abandoned room (host offline): a player leaves and gets back their share of the entry fee.
    // Share = entry fee, minus their part of the prizes that were already paid out
    // (remaining pot * my entry / pot), so a room that already paid prizes never refunds more than is left.
    // One transaction, idempotent by ledger id. firestore.rules must only allow it while the host is stale.
    api.refundEntry = gid => {
        const uid = api.user.uid, lid = "refund_" + gid;
        return wrap(db.runTransaction(async tx => {
            const gs = await tx.get(gRef(gid));
            const ps = await tx.get(pRef(gid, uid));
            const ls = await tx.get(lRef(uid, lid));
            if (ls.exists) return { amount: ls.data().amount || 0, already: true };
            if (!gs.exists || gs.data().status === "finished") throw new Error("This room is already closed.");
            if (!ps.exists) throw new Error("You are not in this room.");
            const g = gs.data(), p = ps.data();
            if (p.isHost) throw new Error("The host can't refund while the room is open.");
            const pot = Number(g.pot) || 0, cost = (Number(g.ticketPrice) || 0) * (Number(p.tickets) || 0);
            let paid = 0;
            Object.keys(g.claimsTaken || {}).forEach(k => { if ((g.claimsTaken[k] || []).length) paid += api.prizeShare(pot, k, g.split); });
            const amount = pot > 0 ? Math.floor(Math.max(0, pot - paid) * Math.min(cost, pot) / pot) : 0;
            if (amount > 0) {
                tx.set(lRef(uid, lid), { type: "refund", gameId: gid, amount, time: TS() });
                tx.update(uRef(uid), { coins: INC(amount), lastRef: lid, activeGame: null });
            } else {
                tx.update(uRef(uid), { activeGame: null });
            }
            tx.delete(pRef(gid, uid));
            tx.delete(tRef(gid, uid));
            return { amount, already: false };
        })).then(r => {
            if (r && !r.already && r.amount > 0) api.localAdd({ id: lid, type: "refund", gameId: gid, amount: r.amount });
            api.activeClear();
            return r;
        });
    };

    // Records an accepted claim and pays it in ONE batch: the prize is created and
    // locked, the claim is added to the player, and the winner is credited. The rules
    // check the whole batch together, so a prize is never half-paid.
    api.settleClaim = (gid, c, extra) => {
        const b = db.batch();
        b.set(gRef(gid).collection("prizes").doc(c.claim), { winners: [c.uid], share: c.share });
        b.update(gRef(gid), { [`claimsTaken.${c.claim}`]: [c.name], [`claimsLocked.${c.claim}`]: true });
        b.update(pRef(gid, c.uid), {
            claims: UNION(c.claim),
            claimedTickets: UNION({ claim: c.claim, ticket: c.ticket, row: c.row })
        });
        const total = c.share + (c.claim === "housie" ? HOUSIE_BONUS : 0); // Housie also pays the winning bonus
        if (total > 0) {
            const id = "win_" + gid + "_" + c.claim;
            b.set(lRef(c.uid, id), Object.assign({ type: "win", gameId: gid, prize: c.claim, amount: total, time: TS() }, extra || {}));
            b.update(uRef(c.uid), { coins: INC(total), lastRef: id });
        }
        return wrap(b.commit());
    };

    /* ---------- Play with Developer: stake lock / settle / cancel / forfeit =================
       No Cloud Functions here (Spark plan, by choice) - this follows the same trust model the
       rest of the app already uses: the room's live client (here, always the human opponent,
       never the developer) is trusted to judge correctly, and these transactions/rules guard
       the bookkeeping (balances, no double pay, single settlement) rather than re-deriving
       ticket math server-side. See the notes sent with firestore.rules for the limits of this. */
    api.devStartGame = (devUid, oppUid, stake, tickets, oppName, devName, oppTicketsData, devTicketsData) => {
        const gid = "dev-" + devUid.slice(0, 6) + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
        return wrap(db.runTransaction(async tx => {
            const [devS, oppS] = await Promise.all([tx.get(uRef(devUid)), tx.get(uRef(oppUid))]);
            if (!devS.exists || !oppS.exists) throw new Error("Account not ready. Try again in a moment.");
            const dev = devS.data(), opp = oppS.data();
            if (!dev.isDeveloper) throw new Error("This account is not the developer.");
            if (dev.devChallenge && dev.devChallenge.active) throw new Error("The developer is already in a challenge. Try again shortly.");
            if ((dev.coins || 0) < stake) throw new Error("The developer doesn't have enough coins to match this price right now.");
            if ((opp.coins || 0) < stake) throw new Error(`Not enough coins. You have ${opp.coins || 0}, need ${stake}.`);

            const pot = stake * 2;
            tx.update(uRef(devUid), {
                coins: dev.coins - stake,
                devChallenge: { active: true, gameId: gid, oppUid, stake, lockedAt: TS() }
            });
            tx.update(uRef(oppUid), {
                coins: opp.coins - stake,
                activeGame: { gameId: gid, roomId: gid, isHost: true, devMode: true }
            });
            tx.set(lRef(devUid, "deventry_" + gid), { type: "deventry", mode: "dev", gameId: gid, amount: -stake, time: TS() });
            tx.set(lRef(oppUid, "deventry_" + gid), { type: "deventry", mode: "dev", gameId: gid, amount: -stake, time: TS() });

            tx.set(gRef(gid), {
                mode: "dev", devUid, oppUid, devName, oppName, hostUid: oppUid, roomCode: null,
                ticketPrice: stake, stake, split: SPLIT, pot, totalTickets: tickets * 2, playerCount: 2,
                status: "started", createdAt: TS(), calledNumbers: [], currentNumber: null,
                claimsTaken: {}, claimsLocked: {}
            });
            tx.set(pRef(gid, oppUid), { tickets, name: oppName, isHost: true, isBot: false, claims: [], claimedTickets: [], joinedAt: TS(), lastActive: TS() });
            tx.set(pRef(gid, devUid), { tickets, name: devName, isHost: false, isBot: true, claims: [], claimedTickets: [], joinedAt: TS(), lastActive: TS() });
            tx.set(tRef(gid, oppUid), { ticketsJson: JSON.stringify(oppTicketsData), marked: {} });
            tx.set(tRef(gid, devUid), { ticketsJson: JSON.stringify(devTicketsData), marked: {} });
            return { gid };
        }).then(r => { devSweep(r.gid); api.localAdd({ id: "deventry_" + gid, type: "deventry", mode: "dev", gameId: r.gid, amount: -stake }); return r; }));
    };
    // Releases the developer's "busy" lock. Only clears it if it still points at this exact
    // game, so a stale/duplicate call can never clobber a newer, unrelated lock.
    api.devReleaseLock = (devUid, gid) => wrap(db.runTransaction(async tx => {
        const s = await tx.get(uRef(devUid));
        if (!s.exists) return;
        const ch = s.data().devChallenge;
        if (ch && ch.gameId === gid && ch.active) tx.update(uRef(devUid), { devChallenge: { active: false } });
    }));
    // Nobody has marked a number yet: a clean cancellation, both entry fees refunded in full.
    api.devCancelIfUnplayed = (gid, devUid, oppUid, stake) => wrap(db.runTransaction(async tx => {
        const g = await tx.get(gRef(gid));
        if (!g.exists || (g.data().calledNumbers || []).length) throw new Error("Game already started.");
        const [devS, oppS] = await Promise.all([tx.get(uRef(devUid)), tx.get(uRef(oppUid))]);
        if (devS.exists) tx.update(uRef(devUid), { coins: INC(stake), devChallenge: { active: false } });
        if (oppS.exists) tx.update(uRef(oppUid), { coins: INC(stake), activeGame: null });
        tx.set(lRef(devUid, "devrefund_" + gid), { type: "devrefund", mode: "dev", gameId: gid, amount: stake, time: TS() });
        tx.set(lRef(oppUid, "devrefund_" + gid), { type: "devrefund", mode: "dev", gameId: gid, amount: stake, time: TS() });
        tx.update(gRef(gid), { status: "finished", cancelled: true });
    }).then(() => { devDrop(gid); api.localAdd({ id: "devrefund_" + gid, type: "devrefund", mode: "dev", gameId: gid, amount: stake }); }));
    // Play had already started and the opponent is leaving: they forfeit their own stake (same
    // policy as leaving a normal room mid-game) and every prize not yet claimed by either side
    // goes to the developer, since the match is being conceded.
    api.devForfeit = (gid, devUid) => gRef(gid).get().then(gs => {
        if (!gs.exists) return;
        const g = gs.data();
        if (g.status === "finished") return;
        const locked = g.claimsLocked || {};
        const pending = Object.keys(SPLIT).filter(k => !locked[k]);
        const jobs = pending.map(k => api.settleClaim(gid, {
            claim: k, uid: devUid, name: g.devName || "Developer", ticket: null, row: null,
            share: api.prizeShare(g.pot, k)
        }, { mode: "dev", note: "Opponent forfeited" }));
        return Promise.all(jobs).then(() => gRef(gid).update({ status: "finished" })).then(() => devDrop(gid));
    });
    api.findGame = roomCode => wrap(
        db.collection("games").where("roomCode", "==", roomCode).get().then(qs => {
            const list = qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
            list.sort((a, b) => ((b.createdAt && b.createdAt.toMillis()) || 0) - ((a.createdAt && a.createdAt.toMillis()) || 0));
            return list[0] || null;
        }));
    api.getPlayer = (gid, uid) => pRef(gid, uid || api.user.uid).get().then(async s => {
        if (!s.exists) return null;
        const p = Object.assign({}, s.data());
        if ((uid || api.user.uid) === api.user.uid) {
            // only the owner can read their own tickets and marks (the rules keep them private)
            const t = await tRef(gid, api.user.uid).get();
            const d = t.exists ? t.data() : {};
            p.ticketsData = parseTickets(d.ticketsJson);
            p.marked = d.marked || {};
        }
        return p;
    });
    api.myPlayer = gid => api.getPlayer(gid, api.user.uid);
    // A Firestore listener that errors out is dead for good. This wrapper subscribes again,
    // waiting 2s, 4s, 8s ... (max 30s) between tries, and gives up after 5 failed tries in a row.
    // Permission errors are never retried: they would fail again and just burn reads.
    // A listener that gave up after its retries is started again when the app comes back to the
    // foreground / goes online. visibility + focus + online often fire together, so one short debounce
    // turns them into a single wake-up. A listener stopped by quota / permission errors is never woken.
    const wakers = new Set();
    let wakeTimer = null;
    const wakeAll = () => { if (wakeTimer) return; wakeTimer = setTimeout(() => { wakeTimer = null; wakers.forEach(f => f()); }, 1500); };
    document.addEventListener("visibilitychange", () => { if (!document.hidden) wakeAll(); });
    window.addEventListener("focus", wakeAll);
    window.addEventListener("online", wakeAll);
    const resilient = subscribe => {
        let unsub = null, stopped = false, timer = null, tries = 0, startedAt = 0, gaveUp = false;
        const MAX_TRIES = 5;
        const wake = () => { if (stopped || !gaveUp) return; gaveUp = false; tries = 0; start(); };
        wakers.add(wake);
        const start = () => {
            if (stopped) return;
            startedAt = Date.now();
            unsub = subscribe(err => {
                if (unsub) { try { unsub(); } catch (e) { } unsub = null; }
                if (stopped) return;
                const code = err && err.code;
                if (code === "permission-denied" || code === "unauthenticated" || code === "resource-exhausted") {
                    console.warn("[listener] stopped (not allowed):", err); return;   // fatal: not woken later
                }
                if (Date.now() - startedAt > 30000) tries = 0;   // it ran fine for a while: start counting again
                if (++tries > MAX_TRIES) { gaveUp = true; console.warn("[listener] giving up after", MAX_TRIES, "tries:", err); return; }
                const wait = Math.min(2000 * Math.pow(2, tries - 1), 30000);
                console.warn("[listener] re-subscribing in " + wait / 1000 + "s:", err);
                timer = setTimeout(start, wait);
            });
        };
        start();
        return () => { stopped = true; wakers.delete(wake); clearTimeout(timer); if (unsub) unsub(); };
    };
    /* ---------- QUOTA SAVERS: draws ----------
       - Play with Developer: the numbers drawn live ONLY on this device (Persist), nothing is
         written to Firestore per draw (was 1 read + 1 write per number, plus listener reads).
         Firestore still holds the stake, the prizes and the final settlement.
       - Normal rooms: the host already knows the called numbers from its own live listener, so a
         draw is ONE plain write (no transaction read). Players still see every number live. */
    const isDevGid = gid => typeof gid === "string" && gid.indexOf("dev-") === 0;
    const DKEY = gid => "housie.devcalled." + gid;
    const devLocal = {};      // gid -> { called, last (latest game doc), emit (listener callback) }
    const devState = gid => {
        let st = devLocal[gid];
        if (!st) {
            let saved = null;
            try { saved = JSON.parse(Persist.getItem(DKEY(gid)) || "null"); } catch (e) { }
            st = devLocal[gid] = { called: (saved && Array.isArray(saved.called)) ? saved.called : [], last: null, emit: null };
        }
        return st;
    };
    const devSave = (gid, st) => { try { Persist.setItem(DKEY(gid), JSON.stringify({ called: st.called })); } catch (e) { } };
    const devDrop = gid => { delete devLocal[gid]; try { Persist.removeItem(DKEY(gid)); } catch (e) { } };
    const devSweep = keep => {
        try { Object.keys(Persist.dump()).forEach(k => { if (k.indexOf("housie.devcalled.") === 0 && k !== DKEY(keep)) Persist.removeItem(k); }); } catch (e) { }
    };
    const withLocal = (gid, g) => {
        const st = devState(gid);
        return Object.assign({}, g, { calledNumbers: st.called.slice(), currentNumber: st.called.length ? st.called[st.called.length - 1] : null });
    };
    const roomNow = {};       // gid -> { called, status } from the live listener (normal rooms)
    const pickNew = called => { let n; do { n = Math.floor(Math.random() * 90) + 1; } while (called.includes(n)); return n; };

    const drawTx = gid => wrap(db.runTransaction(async tx => {
        const gs = await tx.get(gRef(gid));
        if (!gs.exists) throw new Error("Room not found.");
        const g = gs.data();
        const called = g.calledNumbers || [];
        if (called.length >= 90) return { num: null, done: true };
        const n = pickNew(called);
        const patch = { calledNumbers: [...called, n], currentNumber: n };
        if (g.status === "open") patch.status = "started";
        tx.update(gRef(gid), patch);
        return { num: n, done: false };
    }));
    api.draw = gid => {
        if (isDevGid(gid)) {
            const st = devState(gid);
            if (st.called.length >= 90) return Promise.resolve({ num: null, done: true });
            const n = pickNew(st.called);
            st.called.push(n);
            devSave(gid, st);
            if (st.last && st.emit) { try { st.emit(withLocal(gid, st.last)); } catch (e) { console.error(e); } }
            return Promise.resolve({ num: n, done: false });
        }
        const known = roomNow[gid];
        if (!known) return drawTx(gid);
        if (known.called.length >= 90) return Promise.resolve({ num: null, done: true });
        const n = pickNew(known.called);
        const prev = { called: known.called, status: known.status };
        const patch = { calledNumbers: [...known.called, n], currentNumber: n };
        if (known.status === "open") patch.status = "started";
        roomNow[gid] = { called: patch.calledNumbers, status: patch.status || known.status };   // optimistic: quick taps stay in order
        if (beatInDraw) patch.hostSeenAt = TS();    // the draw is the heartbeat: no separate write (and no extra reads for players)
        return gRef(gid).update(patch).then(
            () => { if (patch.hostSeenAt) lastBeatAt = Date.now(); return { num: n, done: false }; },
            () => { roomNow[gid] = prev; beatInDraw = false; return drawTx(gid); });
    };

    api.watchGame = (gid, cb) => resilient(onErr => gRef(gid).onSnapshot(s => {
        if (s.exists) {
            const g = Object.assign({ id: s.id }, s.data());
            if (isDevGid(gid)) { const st = devState(gid); st.last = g; st.emit = cb; cb(withLocal(gid, g)); return; }
            roomNow[gid] = { called: g.calledNumbers || [], status: g.status };
            cb(g);
            return;
        }
        if (!s.metadata.fromCache) cb({ id: gid, status: "finished", calledNumbers: [], claimsTaken: {}, claimsLocked: {} });
    }, onErr));
    api.watchPlayers = (gid, cb) => resilient(onErr => gRef(gid).collection("players").orderBy("joinedAt").onSnapshot(snap => {
        cb(snap.docs.map(d => Object.assign({ uid: d.id }, d.data())));
    }, onErr));
    // host only: every ticket set in the room, keyed by uid (the rules let only the host list them)
    api.watchTickets = (gid, cb) => resilient(onErr => gRef(gid).collection("tickets").onSnapshot(snap => {
        const all = {};
        snap.docs.forEach(d => { all[d.id] = parseTickets(d.data().ticketsJson); });
        cb(all);
    }, onErr));

    // host only: one player's ticket grids, read once when that player makes a claim
    api.getTickets = (gid, uid) => tRef(gid, uid).get().then(snap => (snap.exists ? parseTickets(snap.data().ticketsJson) : []));


    // A claim travels to the host as a plain Firestore document instead of
    // a PeerJS message. This resolves once the host (or this client, if it
    // IS the host) flips "processed" on that same document.
    api.submitClaim = (gid, payload) => new Promise((resolve, reject) => {
        let settled = false;
        const ref = gRef(gid).collection("claimRequests").doc();
        ref.set(Object.assign({}, payload, { uid: api.user.uid, requestedAt: TS(), processed: false, result: null }))
            .then(() => {
                const unsub = ref.onSnapshot(snap => {
                    if (settled || !snap.exists) return;
                    const d = snap.data();
                    if (d.processed) { settled = true; unsub(); resolve(d.result || { ok: false, reason: "No response from host." }); }
                }, err => { if (settled) return; settled = true; unsub(); reject(new Error(friendly(err))); });
                setTimeout(() => { if (settled) return; settled = true; unsub(); resolve({ ok: false, reason: "Host did not respond. They may be offline." }); }, 15000);
            })
            .catch(e => { if (!settled) { settled = true; reject(new Error(friendly(e))); } });
    });
    api.watchClaimRequests = (gid, cb) => resilient(onErr => gRef(gid).collection("claimRequests").where("processed", "==", false)
        .onSnapshot(snap => {
            snap.docChanges().forEach(ch => { if (ch.type === "added") cb(Object.assign({ id: ch.doc.id }, ch.doc.data())); });
        }, onErr));
    api.resolveClaimRequest = (gid, reqId, result) => gRef(gid).collection("claimRequests").doc(reqId).update({ processed: true, result }).catch(() => { });

    // Explicit "Leave Room": removes the player's own temporary data (player doc, tickets)
    // and clears their active-game pointer. If nobody is left in the room afterwards, the room is
    // closed and cleaned up right here, so an empty room can never stay open.
    api.leaveGame = async gid => {
        const uid = api.user.uid;
        api.activeClear();
        await wrap(Promise.all([
            pRef(gid, uid).delete(), tRef(gid, uid).delete(),
            uRef(uid).update({ activeGame: null })
        ]));
    };
    // Deletes ALL temporary play data of a finished room (players, tickets, claim requests, prizes).
    // The game document itself is KEPT as the room's record (code, price, pot,
    // player count, called numbers, winners, times), and users/ + users/{uid}/ledger are untouched,
    // so coins, history and stats stay. Safe to call more than once and from several clients.
    const wipedRooms = new Set();
    api.wipeRoom = async gid => {
        if (!gid || wipedRooms.has(gid)) return;      // never twice from the same client
        wipedRooms.add(gid);
        if (isDevGid(gid)) devDrop(gid);
        try {
            await Promise.all(ROOM_SUBS.map(sub => wipeCollection(gRef(gid).collection(sub))).concat(wipeCollection(gRef(gid).collection("presence")).catch(() => { })));
            await gRef(gid).update({ archived: true }).catch(() => { });   // marks the room as cleaned so nobody repeats it
        } catch (e) { wipedRooms.delete(gid); throw e; }
    };
    // end + clean in one go (any room participant / admin)
    api.closeRoom = async gid => { await api.endGame(gid); await api.wipeRoom(gid); };
    api.clearActiveGame = () => { api.activeClear(); return api.user ? wrap(uRef(api.user.uid).update({ activeGame: null })) : Promise.resolve(); };
    api.getActiveGame = () => Promise.resolve(api.activeLoad());

    /* ---------- ledger helpers (history, stats, rewards) ---------- */
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const LEDGER_LABELS = {
        bonus: "Welcome coins", entry: "Entry fee", daily: "Daily bonus", wheel: "Try your luck", refill: "Free refill",
        task: "Task reward", admin: "Admin adjustment", deventry: "Developer challenge entry fee", devrefund: "Developer challenge refund", refund: "Room refund (host offline)"
    };
    const describe = t => t.type === "win" ? `Won ${PRIZE_NAMES[t.prize] || t.prize}`
        : t.type === "send" ? "Sent to " + (t.toName || "code " + (t.toCode || ""))
            : t.type === "gift" ? "Received from " + (t.fromName || "a friend")
                : (LEDGER_LABELS[t.type] || t.type);
    api.esc = esc;
    api.describe = describe;

    // "send" entries only hold the friend's uid + code: look up the friend's display name once and cache it
    api.sendNames = async list => list;


    // One-off coin reward (daily bonus, refill, wheel, task). The ledger doc
    // id is unique per period, so the same reward can't be taken twice.
    // NOTE: firestore.rules must allow these ledger types (see notes).
    const grantRaw = async (id, type, amount, extra) => {
        const uid = api.user.uid;
        const ref = lRef(uid, id);
        api.quietUntil = Date.now() + 4000; // the caller shows its own toast, skip the generic "+N coins" one
        const attempt = () => db.runTransaction(async tx => {
            const existing = await tx.get(ref);
            if (existing.exists) throw new Error("Already claimed.");
            tx.set(ref, Object.assign({ type, amount, time: TS() }, extra || {}));
            tx.update(uRef(uid), { coins: INC(amount), lastRef: id });
        });
        try {
            return await attempt();
        } catch (e) {
            if (e && e.message === "Already claimed.") throw e;
            const msg = (e && e.message) || "";
            // a permission-denied right after sign-in is often just a stale ID token the rules
            // haven't picked up yet: force a fresh token and retry once before giving up
            if (/permission|insufficient/i.test(msg)) {
                try {
                    await api.user.getIdToken(true);
                    return await attempt();
                } catch (e2) {
                    if (e2 && e2.message === "Already claimed.") throw e2;
                    console.error("[reward]", type, id, amount, e2);
                    throw new Error("Could not claim this reward right now. Try again later.");
                }
            }
            console.error("[reward]", type, id, amount, e);
            throw new Error(friendly(e));
        }
    };

    api.grant = async (id, type, amount, extra) => {
        try {
            const r = await grantRaw(id, type, amount, extra);
            api.localAdd(Object.assign({ id, type, amount }, extra || {}));
            return r;
        } catch (e) {
            // already taken on another device: mark it taken here too, so the UI matches
            if (e && e.message === "Already claimed.") api.localAdd(Object.assign({ id, type, amount: 0 }, extra || {}));
            throw e;
        }
    };

    /* ---------- share coins: every player has a unique 4-digit code ---------- */
    const appErr = m => { const e = new Error(m); e.app = true; return e; };
    const codeRef = c => db.collection("codes").doc(c);
    // my 4-digit code (made once, the first time it is needed; codes/{code} keeps it unique)
    api.myCode = async () => {
        const me = api.user.uid;
        const snap = await wrap(uRef(me).get());
        if (snap.exists && snap.data().code) return snap.data().code;
        for (let i = 0; i < 12; i++) {
            const c = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
            try {
                const b = db.batch();
                b.set(codeRef(c), { uid: me });
                b.update(uRef(me), { code: c });
                await b.commit();
                return c;
            } catch (e) {
                if (/permission|insufficient|already|exists/i.test((e && e.message) || "")) continue; // code taken: try another
                throw new Error(friendly(e));
            }
        }
        throw appErr("Could not create your code. Try again.");
    };
    // friend's 4-digit code -> their uid
    api.findByCode = async code => {
        code = String(code || "").trim();
        if (!/^[0-9]{4}$/.test(code)) throw appErr("Enter the 4-digit code.");
        let snap;
        try { snap = await codeRef(code).get(); } catch (e) { throw new Error(friendly(e)); }
        if (!snap.exists) throw appErr("No player found with that code.");
        if (snap.data().uid === api.user.uid) throw appErr("You can't send coins to yourself.");
        return { id: snap.data().uid, code };
    };
    // one transaction: debit the sender, credit the friend, one ledger entry each
    api.sendCoins = async (toUid, toCode, amount) => {
        const me = api.user.uid;
        amount = Math.floor(Number(amount));
        if (!(amount >= 1)) throw appErr("Enter an amount of 1 or more.");
        if (!toUid || toUid === me) throw appErr("Pick a friend to send to.");
        const sid = "send_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
        const rid = "recv_" + sid;
        api.quietUntil = Date.now() + 4000;
        try {
            await db.runTransaction(async tx => {
                const m = await tx.get(uRef(me));
                if ((m.data().coins || 0) < amount) throw appErr("Insufficient balance");
                tx.set(lRef(me, sid), { type: "send", amount: -amount, to: toUid, toCode, time: TS() });
                tx.update(uRef(me), { coins: INC(-amount), lastRef: sid });
                tx.set(lRef(toUid, rid), { type: "gift", amount, from: me, fromName: m.data().name || "Player", ref: sid, time: TS() });
                tx.update(uRef(toUid), { coins: INC(amount), lastRef: rid });
            });
            api.localAdd({ id: sid, type: "send", amount: -amount, to: toUid, toCode });
        } catch (e) {
            if (e && e.app) throw e;
            if (/permission|insufficient/i.test((e && e.message) || "")) throw new Error("Could not send coins right now. Try again later.");
            throw new Error(friendly(e));
        }
    };

    api.hostedGames = () => db.collection("games").where("hostUid", "==", api.user.uid).get();
    api.hostName = gid => gRef(gid).collection("players").where("isHost", "==", true).limit(1).get()
        .then(qs => (qs.empty ? null : qs.docs[0].data().name)).catch(() => null);
    api.richest = n => db.collection("users").orderBy("coins", "desc").limit(n || 10).get();

    /* ---------- Play with Developer: find + watch the developer's public profile ----------
       The developer's uid is never hardcoded in the client: it's found by querying for the
       one account the backend marked isDeveloper:true at creation (ensureUser, above), which
       only happens for a verified Google sign-in on the real admin email. */
    let devUidCache = null;
    api.findDeveloper = () => {
        if (devUidCache) return Promise.resolve(devUidCache);
        return wrap(db.collection("users").where("isDeveloper", "==", true).limit(1).get()).then(qs => {
            if (qs.empty) return null;
            devUidCache = qs.docs[0].id;
            return devUidCache;
        });
    };
    // Live developer profile for the Home card / lobby: uid, name, coins, and whether they're
    // already locked into another challenge. Resolves to null if there is no developer account yet.
    api.watchDeveloper = cb => {
        let stopped = false, timer = null;
        const pull = () => api.findDeveloper().then(uid => {
            if (stopped) return;
            if (!uid) { cb(null); return; }
            return uRef(uid).get().then(snap => {
                if (stopped) return;
                if (!snap.exists) { cb(null); return; }
                const d = snap.data();
                const ch = d.devChallenge;
                const show = busy => cb({ uid, name: d.name || "Developer", coins: d.coins, busy });
                if (!(ch && ch.active)) { show(false); return; }
                // locked: make sure that match is really still running, otherwise free the developer
                const age = ch.lockedAt && ch.lockedAt.toMillis ? Date.now() - ch.lockedAt.toMillis() : 0;
                const stale = () => api.devReleaseLock(uid, ch.gameId).then(() => show(false)).catch(() => show(true));
                if (!ch.gameId) { show(true); return; }
                return gRef(ch.gameId).get().then(gs => {
                    if (stopped) return;
                    const g = gs.exists ? gs.data() : null;
                    if (!g || g.status === "finished" || age > 3 * 60 * 60 * 1000) return stale();
                    show(true);
                }).catch(() => show(true));
            });
        }).catch(() => { if (!stopped) cb(null); });
        pull();
        timer = setInterval(() => { if (!document.hidden) pull(); }, 3 * 60 * 1000);
        return () => { stopped = true; clearInterval(timer); };
    };

    // Admin only (the Firestore rules enforce this too, the UI check is just cosmetic).
    api.isAdmin = () => !!(api.user && api.user.email === ADMIN_EMAIL && api.user.emailVerified
        && api.user.providerData.some(p => p.providerId === "google.com"));
    // admin actions get their own error text, so a blocked admin call never shows the player-facing
    // "The game may have started..." message
    const awrap = p => p.catch(e => {
        console.error("[admin]", e);
        const m = (e && e.message) || "";
        throw new Error(/permission|insufficient/i.test(m)
            ? "Admin action was blocked. Publish the latest firestore.rules and sign in again."
            : friendly(e));
    });
    const needAdmin = () => { if (!api.isAdmin()) throw new Error("Not allowed."); };
    // latest 50 rooms PLUS every live room, so an old stuck room can never hide behind newer ones
    api.adminGames = async () => {
        needAdmin();
        const [recent, live] = await Promise.all([
            db.collection("games").orderBy("createdAt", "desc").limit(50).get(),
            db.collection("games").where("status", "in", ["open", "started"]).get().catch(() => null)
        ]);
        const seen = new Map();
        recent.docs.forEach(d => seen.set(d.id, d));
        if (live) live.docs.forEach(d => seen.set(d.id, d));
        const ms = t => (t && t.toMillis ? t.toMillis() : 0);
        return [...seen.values()].map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    };
    // users come 100 at a time (richest first); adminUsers(true) returns the next 100
    let usersCursor = null, usersPaged = false;
    api.usersHasMore = false;
    api.adminUsers = async more => {
        needAdmin();
        usersPaged = !!more;
        let q = db.collection("users").orderBy("coins", "desc");
        if (more && usersCursor) q = q.startAfter(usersCursor);
        const qs = await q.limit(100).get();
        if (qs.docs.length) usersCursor = qs.docs[qs.docs.length - 1];
        api.usersHasMore = qs.docs.length === 100;
        return qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
    };
    // real totals (server-side count, about 1 read per 1000 documents); missing on very old SDKs: returns what it can
    api.adminCounts = async () => {
        needAdmin();
        const out = {};
        try { out.users = (await db.collection("users").count().get()).data().count; } catch (e) { }
        try { out.finished = (await db.collection("games").where("status", "==", "finished").count().get()).data().count; } catch (e) { }
        return out;
    };
    // when each player last sent a presence stamp (best effort)
    api.adminPresence = async gid => {
        needAdmin();
        const qs = await gRef(gid).collection("presence").get();
        const o = {};
        qs.docs.forEach(d => { const a = d.data().at; o[d.id] = a && a.toMillis ? a.toMillis() : 0; });
        return o;
    };
    api.adminPlayers = async gid => {
        needAdmin();
        const qs = await gRef(gid).collection("players").get();
        return qs.docs.map(d => Object.assign({ uid: d.id }, d.data()));
    };
    api.adminLedger = async (uid, n) => {
        needAdmin();
        const qs = await uRef(uid).collection("ledger").orderBy("time", "desc").limit(Math.min(n || 50, 50)).get();
        return qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
    };
    // ---- live admin feeds: attached only while the admin screen is open, detached when it is left ----
    api.watchAdminUsers = cb => resilient(onErr => db.collection("users").orderBy("coins", "desc").limit(100).onSnapshot(
        s => {
            if (!usersPaged) { if (s.docs.length) usersCursor = s.docs[s.docs.length - 1]; api.usersHasMore = s.docs.length === 100; }   // keeps "Load more users" working
            cb(s.docs.map(d => Object.assign({ id: d.id }, d.data())));
        }, onErr));
    api.watchAdminGames = cb => {
        let recent = [], live = [];
        const ms = t => (t && t.toMillis ? t.toMillis() : 0);
        const push = () => {
            const seen = new Map();
            recent.concat(live).forEach(g => seen.set(g.id, g));
            cb([...seen.values()].sort((a, b) => ms(b.createdAt) - ms(a.createdAt)));
        };
        const conv = s => s.docs.map(d => Object.assign({ id: d.id }, d.data()));
        const u1 = resilient(onErr => db.collection("games").orderBy("createdAt", "desc").limit(50).onSnapshot(s => { recent = conv(s); push(); }, onErr));
        const u2 = resilient(onErr => db.collection("games").where("status", "in", ["open", "started"]).onSnapshot(s => { live = conv(s); push(); }, onErr));
        return () => { u1(); u2(); };
    };
    api.watchAdminLedger = (uid, n, cb) => resilient(onErr => uRef(uid).collection("ledger").orderBy("time", "desc").limit(Math.min(n || 50, 50)).onSnapshot(
        s => cb(s.docs.map(d => Object.assign({ id: d.id }, d.data()))), onErr));
    // admin: gives a 4-digit code to accounts that never opened Share Coins (never reuses a taken code)
    api.adminAssignCodes = async uids => {
        needAdmin();
        let ok = 0;
        for (const uid of uids) {
            for (let i = 0; i < 12; i++) {
                const c = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
                try {
                    const done = await db.runTransaction(async tx => {
                        const [cs, us] = await Promise.all([tx.get(codeRef(c)), tx.get(uRef(uid))]);
                        if (cs.exists) return false;                                   // taken: try another
                        if (!us.exists || us.data().code) return true;                 // gone, or got a code meanwhile
                        tx.set(codeRef(c), { uid });
                        tx.update(uRef(uid), { code: c });
                        return true;
                    });
                    if (done) { ok++; break; }
                } catch (e) { console.warn("[assign code]", e); break; }
            }
        }
        return ok;
    };
    api.adminClearActive = uid => { needAdmin(); return awrap(uRef(uid).update({ activeGame: null })); };
    // ends the room, removes its temporary data (keeps the room record) and releases everyone still pointing at it
    api.adminEndGame = async gid => {
        needAdmin();
        try {
            const players = await gRef(gid).collection("players").get();
            const gs = await gRef(gid).get();
            if (gs.exists && gs.data().mode === "dev" && gs.data().devUid) await api.devReleaseLock(gs.data().devUid, gid).catch(() => { });
            try { await gRef(gid).update({ status: "finished", endedAt: TS() }); }
            catch (e) { await gRef(gid).update({ status: "finished" }); }
            await api.wipeRoom(gid);
            await Promise.all(players.docs.map(d => uRef(d.id).update({ activeGame: null }).catch(() => { })));
        } catch (e) { await awrap(Promise.reject(e)); }
    };
    // removes leftover temporary data of an already-finished room (keeps the room record)
    api.adminCleanGame = async gid => { needAdmin(); await api.wipeRoom(gid); };
    // bulk helpers: return { ok, failed }
    api.adminEndGames = ids => { needAdmin(); return pool(ids, id => api.adminEndGame(id), 5); };
    api.adminDeleteGames = ids => { needAdmin(); return pool(ids, id => api.adminDeleteGame(id), 5); };
    api.adminCleanGames = ids => { needAdmin(); return pool(ids, id => api.adminCleanGame(id), 5); };
    api.adminClearActiveMany = uids => { needAdmin(); return pool(uids, u => uRef(u).update({ activeGame: null }), 10); };
    api.adminSetAlias = (uid, alias) => { needAdmin(); return awrap(uRef(uid).update({ alias })); };
    api.adminDeleteUser = async uid => {
        needAdmin();
        if (uid === api.user.uid) throw new Error("Use Delete account in Profile for your own account.");
        try {
            const ledger = await uRef(uid).collection("ledger").get();
            const joined = new Set();
            ledger.forEach(d => { const g = d.data().gameId; if (g) joined.add(g); });
            const me = await uRef(uid).get();
            if (me.exists && me.data().code) await db.collection("codes").doc(me.data().code).delete().catch(() => { });
            if (me.exists && me.data().activeGame && me.data().activeGame.gameId) joined.add(me.data().activeGame.gameId);
            const hosted = await db.collection("games").where("hostUid", "==", uid).get();
            for (const g of hosted.docs) {
                const players = await g.ref.collection("players").get();
                await wipeRoomSubs(g.ref);
                await g.ref.delete();
                joined.delete(g.id);
                await Promise.all(players.docs.filter(d => d.id !== uid).map(d => uRef(d.id).update({ activeGame: null }).catch(() => { })));
            }
            for (const gid of joined) { try { await pRef(gid, uid).delete(); await tRef(gid, uid).delete(); } catch (e) { } }
            await wipeCollection(uRef(uid).collection("ledger"));
            await wipeCollection(uRef(uid).collection("data")).catch(() => { });
            await uRef(uid).delete();
        } catch (e) { await awrap(Promise.reject(e)); }
    };
    api.adminDeleteGame = async gid => {
        needAdmin();
        try {
            const players = await gRef(gid).collection("players").get();
            const gs = await gRef(gid).get();
            if (gs.exists && gs.data().mode === "dev" && gs.data().devUid) await api.devReleaseLock(gs.data().devUid, gid).catch(() => { });
            await Promise.allSettled(ROOM_SUBS.map(sub => wipeCollection(gRef(gid).collection(sub))).concat(wipeCollection(gRef(gid).collection("presence")).catch(() => { })));
            await gRef(gid).delete();
            // the room is gone: release everyone who still pointed at it
            await Promise.all(players.docs.map(d => uRef(d.id).update({ activeGame: null }).catch(() => { })));
        } catch (e) { await awrap(Promise.reject(e)); }
    };
    // true when a room no longer exists or is finished (used to auto-release players)
    api.adminGameClosed = async gid => {
        needAdmin();
        const g = await gRef(gid).get();
        return !g.exists || g.data().status === "finished";
    };

    return api;
})();

if (!window.Coins || !Coins.enabled) {
    setTimeout(() => { if (typeof showNotification === "function") showNotification("Sign-in is unavailable. Check your connection and reload.", "error"); }, 500);
}

/* small shared helpers + local preferences (UI settings only, never game state) */
const $ = id => document.getElementById(id);
const store = {
    // personal data (settings, read updates ...) is kept in Firestore by Coins (users/{uid}/data/prefs);
    // only the room being played is stored on the device (Persist)
    get(k, d) { try { const v = (window.Coins && Coins.cloudGet) ? Coins.cloudGet(k) : null; return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { if (window.Coins && Coins.cloudSet) Coins.cloudSet(k, JSON.stringify(v)); } catch (e) { } }
};

/* ================= GLOBAL ================= */
let myName = "";
let ticketCount = 1;
let isHost = false;
let myRoomId = null;
let isDevGame = false;     // true while the current arena session is a "Play with Developer" match
let devInfo = null;        // live { uid, name, coins, busy } for the developer account, or null
let devUnwatch = null;
let devStake = 25, devWantedTickets = 1;

let members = [];
let calledNumbers = [];
let selectedClaim = null;

let isBusy = false;          // true while creating / joining a room
const MIN_LOADING_MS = 700;  // spinner is always shown at least this long

let ticketPrice = 10;            // coins per ticket (set by the host)
let gameId = null;               // Firestore game id for this room
let gameData = null;             // live game doc: pot, split, status
let unwatchGame = null;
let unwatchPlayers = null;
let unwatchClaimRequests = null;
let unwatchTickets = null;
// host presence (see Coins.hostBeat): the host stamps the room every 90s, players watch for it going quiet
const HOST_BEAT_MS = 90000, HOST_WARN_MS = 180000, HOST_REFUND_MS = 300000;
let hostBeatTimer = null, hostWatchTimer = null;
// player presence (players beat every 2 min, the host sees who went quiet; offline = nothing for 5 min)
const PRESENCE_BEAT_MS = 120000, PRESENCE_OFFLINE_MS = 300000;
let presenceBeatTimer = null, presenceTimer = null, unwatchPresence = null, detachCleanup = null;
let presenceVal = {}, presenceLocal = {};
let hostSeenLocal = 0, lastHostSeenAt, lastCalledSeen = -1;
let intentionalExit = false;     // true while *I* am the one closing/leaving, so my own listener doesn't also announce it to me
const PRIZE_ORDER = ["jaldi", "line1", "line2", "line3", "housie"];

const CLAIM_LABELS = {
    jaldi: "Jaldi",
    line1: "1st Line",
    line2: "2nd Line",
    line3: "3rd Line",
    housie: "Housie"
};
let claimsTaken = {};   // claim key -> array of names who won it (ties allowed)
let claimsLocked = {};  // claim key -> true once a new number was drawn after it was claimed
let myClaims = new Set(); // claims this player has already won
let appliedClaimVisuals = new Set(); // claims whose strike-through is already drawn on my tickets

const ticketsContainer = document.getElementById("tickets-container");
const leavePopup = document.getElementById("leave-popup");
const leaveCancel = document.getElementById("leave-cancel");
const leaveConfirm = document.getElementById("leave-confirm");
const winScreen = document.getElementById("win-screen");

/* ================= HELPERS ================= */

function capitalizeName(name) {
    return name.split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function withTimeout(promise, ms, msg) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(msg || "Request timed out. Check your connection.")), ms))
    ]);
}

/* In-app toast. Tone is picked automatically from the message,
   or pass it explicitly: showNotification("Saved", "success"). */
function detectToastTone(msg) {
    const m = String(msg).toLowerCase();
    if (/new number drawn/.test(m)) return "draw";
    if (/claimed|welcome back|restored/.test(m)) return "success";
    if (/please|must|enter|rejected|no longer|not connected|mark numbers|lost|closed|failed|error|invalid|full|not found|already|timed out|did not respond/.test(m)) return "error";
    if (/reconnect|all numbers/.test(m)) return "warn";
    return "info";
}

let lastQuotaToast = 0;
function showNotification(msg, tone) {
    if (/quota|resource-exhausted|server is busy right now/i.test(String(msg))) {
        if (Date.now() - lastQuotaToast < 60000) return;
        lastQuotaToast = Date.now();
        msg = "Quota exceeded";
        tone = "error";
    }
    tone = tone || detectToastTone(msg);

    let stack = document.getElementById("toast-stack");
    if (!stack) {
        stack = document.createElement("div");
        stack.id = "toast-stack";
        stack.setAttribute("role", "status");
        stack.setAttribute("aria-live", "polite");
        document.body.appendChild(stack);
    }
    // inside a game the toasts go into the reserved empty strip under the sticky header
    // (never over the tickets); everywhere else they float at the top as before
    const slot = document.getElementById("arena-toast-slot");
    const inArena = !!slot && !!document.querySelector("#screen-arena.active");
    const host = inArena ? slot : document.body;
    if (stack.parentNode !== host) host.appendChild(stack);

    const text = String(msg);

    const life = 2800;
    const toast = document.createElement("div");
    toast.className = "toast toast-" + tone + (text.length > 36 ? " toast-long" : "");
    toast.style.setProperty("--life", life + "ms");
    toast.innerHTML = `<span class="toast-msg"></span>`;
    toast.querySelector(".toast-msg").textContent = text;
    toast.title = text;
    stack.appendChild(toast);

    // keep at most 3 on screen (only the newest one fits in the arena strip)
    const maxToasts = inArena ? 1 : 3;
    while (stack.children.length > maxToasts) stack.firstElementChild.remove();

    const close = () => {
        toast.classList.add("leaving");
        setTimeout(() => toast.remove(), 300);
    };
    toast.onclick = close;
    setTimeout(close, life);
}

function showReconnectOverlay(roomId) {
    const overlay = document.getElementById("reconnect-overlay");
    const sub = document.getElementById("reconnect-sub");
    if (sub) sub.textContent = roomId ? `Restoring room ${roomId} and your tickets` : "Restoring your previous game";
    if (overlay) overlay.classList.add("active");
}

function hideReconnectOverlay() {
    const overlay = document.getElementById("reconnect-overlay");
    if (overlay) overlay.classList.remove("active");
}

/* ================= SERVICE WORKER ================= */
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js")
        .catch(() => { /* needs https or localhost; fall back silently */ });
}

/* ================= GAME / PRIZES (coins) ================= */
function updatePrizeCard() {
    const list = document.getElementById("prize-list");
    if (!list || !gameData) return;
    document.getElementById("prize-pot").textContent = `Total 🪙 ${gameData.pot}`;
    list.innerHTML = PRIZE_ORDER.map(k => {
        const amt = Coins.prizeShare(gameData.pot, k, gameData.split);
        const w = claimsTaken[k] || [];
        return `<div class="prize-item${w.length ? " won" : ""}"><span>${CLAIM_LABELS[k]}${w.length ? ` · ✓ ${escapeHTML(w.join(", "))}` : ""}</span><b>🪙 ${amt}</b></div>`;
    }).join("");
}

/* ================= SMALL UI HELPERS ================= */
function askConfirm(title, text, okLabel) {
    return new Promise(resolve => {
        const overlay = document.createElement("div");
        overlay.className = "popup-overlay active";
        overlay.style.zIndex = "9999";
        overlay.innerHTML = `<div class="popup-box"><h3></h3><p></p>
            <div class="popup-actions">
                <button class="btn-outline" type="button" data-v="0">Cancel</button>
                <button class="btn-primary" type="button" data-v="1"></button>
            </div></div>`;
        overlay.querySelector("h3").textContent = title;
        overlay.querySelector("p").textContent = text;
        overlay.querySelector('[data-v="1"]').textContent = okLabel || "OK";
        overlay.onclick = e => {
            const b = e.target.closest("button");
            if (!b) return;
            overlay.remove();
            resolve(b.dataset.v === "1");
        };
        document.body.appendChild(overlay);
    });
}

// keep the screen awake while playing so the phone doesn't lock mid-game
let wakeLock = null;
async function keepAwake() {
    try {
        if (store.get("awake", true) && "wakeLock" in navigator && !wakeLock) {
            wakeLock = await navigator.wakeLock.request("screen");
            wakeLock.addEventListener("release", () => { wakeLock = null; });
        }
    } catch (e) { }
}
document.addEventListener("visibilitychange", () => {
    const arena = document.getElementById("screen-arena");
    if (document.visibilityState === "visible" && arena && arena.classList.contains("active")) keepAwake();
});

/* ================= VIEW SWITCH ================= */
const NAV_OF = { home: "home", earn: "earn", lobby: "lobby", devlobby: "home", stats: "stats", profile: "profile", history: "profile", theme: "profile", favorites: "profile", share: "home", leaderboard: "profile", updates: "profile", admin: "profile" };
let currentView = "welcome";

function pushNav(id) {
    try {
        const st = { view: id };
        if (!history.state || !history.state.view) history.replaceState(st, "");
        else if (history.state.view !== id) history.pushState(st, "");
    } catch (e) { }
}

function showView(id, fromPop) {
    const target = $("screen-" + id);
    if (!target) return;
    if (!fromPop) pushNav(id);
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    target.classList.add("active");
    currentView = id;
    if (id !== "admin" && typeof stopAdminLive === "function") stopAdminLive();   // live admin feeds only run on the admin screen
    if (document.querySelector('[data-new="' + id + '"]')) markFeatureSeen(id);   // reaching a new feature any way counts as opening it
    document.body.classList.add("auth-ready");
    const nav = $("bottom-nav");
    if (nav) nav.classList.toggle("hidden", !(window.Coins && Coins.user));
    document.querySelectorAll("#bottom-nav .nav-item").forEach(b => b.classList.toggle("active", b.dataset.open === (NAV_OF[id] || id)));
    closeMenu();
    window.scrollTo(0, 0);
    if (id === "arena") { updateCalledBoard(); updateHistory(); keepAwake(); }
    else if (VIEW_LOADERS[id]) VIEW_LOADERS[id]();
    refreshUpdateBadges();
    paintNewFeatures();
    updateTaskBadge();
}

/* ================= LOADING STATE ================= */
const btnCreate = document.getElementById("btn-create");
const btnJoin = document.getElementById("btn-join");

function setBusy(kind) {
    // kind: "create" | "join" | null
    isBusy = !!kind;

    [[btnCreate, "create", "Creating room...", "Create room"],
    [btnJoin, "join", "Joining room...", "Join room"]].forEach(([btn, k, busyText, idleText]) => {
        const active = kind === k;
        btn.disabled = isBusy;
        btn.classList.toggle("loading", active);
        btn.innerHTML = active ? `<span class="spinner"></span>${busyText}` : idleText;
    });
    document.getElementById("join-id").disabled = isBusy;
}

function remainingLoadTime(startedAt) {
    return Math.max(0, MIN_LOADING_MS - (Date.now() - startedAt));
}

/* ================= ROOM ACTIONS ================= */
function readLobbyPlayer() {
    const rawName = $("username").value.trim();
    const tickets = Number($("ticket-count").value.trim());
    if (!rawName) { showNotification("Please enter your name"); return false; }
    if (!Number.isInteger(tickets) || tickets < 1 || tickets > 4) { showNotification("Tickets must be 1 to 4"); return false; }
    myName = capitalizeName(rawName);
    ticketCount = tickets;
    store.set("name", myName);
    return true;
}

btnCreate.onclick = () => {
    if (isBusy) return; // ignore repeated clicks
    if (!readLobbyPlayer()) return;
    const price = Number($("ticket-price").value.trim());
    if (!Number.isInteger(price) || price < 0 || price > 500) { showNotification("Ticket price must be 0 to 500 coins"); return; }
    ticketPrice = price;
    createRoom();
};

btnJoin.onclick = () => {
    if (isBusy) return; // ignore repeated clicks
    if (!readLobbyPlayer()) return;
    const roomId = $("join-id").value.trim();
    if (!roomId) { showNotification("Enter Room Code"); return; }
    joinRoom(roomId);
};

/* ================= ROOM / GAME LIFECYCLE ================= */

function findFreeRoomCode(attempts) {
    attempts = attempts || 0;
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    return Coins.roomCodeAvailable(code).then(free => {
        if (free) return code;
        if (attempts >= 6) throw new Error("Could not find a free room code. Try again.");
        return findFreeRoomCode(attempts + 1);
    });
}

function createRoom() {
    if (!window.Coins || !Coins.enabled || !Coins.user) { showNotification("Please sign in first"); return; }
    setBusy("create");
    const startedAt = Date.now();

    withTimeout(findFreeRoomCode(), 15000, "Could not create the room. Check your network and try again.")
        .then(roomCode => {
            const gid = roomCode + "-" + Date.now().toString(36);
            const ticketsData = generateTambolaSet(ticketCount, myFavorites());
            return withTimeout(Coins.createGame(gid, roomCode, ticketPrice, ticketCount, myName, ticketsData), 15000,
                "Could not create the room. Check your network and try again.")
                .then(() => ({ gid, roomCode, ticketsData }));
        })
        .then(({ gid, roomCode, ticketsData }) => {
            setTimeout(() => {
                setBusy(null);
                isHost = true;
                gameId = gid;
                myRoomId = roomCode;
                enterArena({ ticketsData, marked: {}, claimedTickets: [], claims: [] });
            }, remainingLoadTime(startedAt));
        })
        .catch(err => {
            setTimeout(() => {
                setBusy(null);
                isHost = false;
                gameId = null;
                showNotification(err.message || "Could not create the room.");
            }, remainingLoadTime(startedAt));
        });
}

function joinRoom(roomId) {
    if (!window.Coins || !Coins.enabled || !Coins.user) { showNotification("Please sign in first"); return; }
    setBusy("join");
    const startedAt = Date.now();
    const back = msg => { setTimeout(() => { setBusy(null); if (msg) showNotification(msg, "error"); }, remainingLoadTime(startedAt)); };
    const enter = (game, playerState, welcomeBack) => {
        setTimeout(() => {
            setBusy(null);
            isHost = !!(welcomeBack && playerState.isHost);   // a host who rejoins by code is still the host
            gameId = game.id;
            myRoomId = game.roomCode;
            ticketPrice = game.ticketPrice;
            enterArena(playerState);
            if (welcomeBack) showNotification("Welcome back! Tickets restored.", "success");
        }, remainingLoadTime(startedAt));
    };

    withTimeout(Coins.findGame(roomId), 15000, "Connection timed out. Check your network and try again.").then(game => {
        if (!game || game.status === "finished") { back("Room not found. Check the code."); return; }
        return Coins.myPlayer(game.id).then(mine => {
            if (mine) {
                ticketCount = mine.tickets;
                // never continue with tickets that are missing: reload them from Firestore, never invent new ones
                return loadMyTickets(game.id, mine.ticketsData, mine.tickets).then(t => {
                    mine.ticketsData = t;
                    enter(game, mine, true);
                });
            }
            if (game.status !== "open") { back(); showGameInProgressPopup(); return; }
            const cost = game.ticketPrice * ticketCount;
            const ask = cost > 0
                ? askConfirm("Join this room?", `Entry fee: 🪙 ${cost} for ${ticketCount} ticket(s).`, "Pay & Join")
                : Promise.resolve(true);
            return ask.then(ok => {
                if (!ok) { back(); return; }
                const ticketsData = generateTambolaSet(ticketCount, myFavorites());
                return Coins.joinGame(game.id, ticketCount, myName, ticketsData).then(r => {
                    ticketCount = r.tickets;
                    enter(game, { ticketsData, marked: {}, claimedTickets: [], claims: [] }, false);
                });
            });
        });
    }).catch(e => back(e.message || "Could not join the room."));
}

// The tickets a player holds must be the ones saved in Firestore (the host checks claims against those).
// Use the local copy only when it is complete; otherwise reload them from Firestore. Fresh random
// tickets are NEVER made here: they would not match the host's copy and every claim would fail.
const ticketsOk = (t, count) => Array.isArray(t) && t.length > 0 && (!count || t.length === count) &&
    t.every(g => Array.isArray(g) && g.length > 0 && g.every(Array.isArray));
async function loadMyTickets(gid, local, count) {
    if (ticketsOk(local, count)) return local;
    let remote = [];
    try { remote = await Coins.getTickets(gid, Coins.user.uid); }
    catch (e) { throw new Error("Could not load your tickets. Check your connection and try again."); }
    if (!ticketsOk(remote)) throw new Error("Your tickets for this room could not be found.");
    ticketCount = remote.length;
    return remote;
}

// Shared by create / join / resume: shows the arena, draws the tickets,
// restores any previously-marked numbers and claims, then starts listening
// to Firestore for everything that happens from here on.
function enterArena(playerState) {
    document.getElementById("display-room-id").textContent = myRoomId || "----";
    toggleHostUI(isHost);
    const roomBadge = document.getElementById("arena-room-badge");
    const devBadge = document.getElementById("arena-dev-badge");
    if (roomBadge) roomBadge.classList.toggle("hidden", isDevGame);
    if (devBadge) devBadge.classList.toggle("hidden", !isDevGame);
    const headBar = document.querySelector(".arena-head");
    if (headBar) headBar.classList.toggle("is-dev", !!isDevGame);   // dev game: header wraps into two rows (see style.css)
    showView("arena");
    appliedClaimVisuals = new Set();
    generateTickets(ticketCount, playerState.ticketsData || []);
    const prev = Coins.activeLoad();
    const marks = (prev && prev.gameId === gameId && prev.marked) ? prev.marked : (playerState.marked || {});
    applyRestoredState(marks, playerState.claimedTickets, playerState.claims);
    ticketsByUid[Coins.user.uid] = playerState.ticketsData || [];
    Coins.activeSave({
        gameId, roomId: myRoomId, isHost, devMode: isDevGame, name: myName, tickets: ticketCount, price: ticketPrice,
        ticketsData: playerState.ticketsData || [], marked: marks
    });
    startListeners(gameId);
    hideReconnectOverlay();
}

function applyRestoredState(marked, claimedTickets, claims) {
    if (marked) {
        Object.keys(marked).forEach(ticketIdx => {
            const nums = marked[ticketIdx] || [];
            const ticket = document.querySelector(`[data-ticket="${ticketIdx}"]`);
            if (!ticket) return;
            const cells = Array.from(ticket.querySelectorAll(".number-cell"));
            nums.forEach(num => {
                const cell = cells.find(c => Number(c.textContent) === Number(num));
                if (cell) cell.classList.add("active");
            });
        });
    }
    myClaims = new Set(claims || []);
    if (Array.isArray(claimedTickets)) {
        claimedTickets.forEach(({ claim, ticket, row }) => { if (claim) applyClaimVisuals(claim, ticket, false, row); });
    }
    updateClaimButtons();
}

function stopListeners() {
    if (typeof autoStop === "function") autoStop();
    if (unwatchGame) { unwatchGame(); unwatchGame = null; }
    if (unwatchPlayers) { unwatchPlayers(); unwatchPlayers = null; }
    if (unwatchClaimRequests) { unwatchClaimRequests(); unwatchClaimRequests = null; }
    if (unwatchTickets) { unwatchTickets(); unwatchTickets = null; }
    if (hostBeatTimer) { clearInterval(hostBeatTimer); hostBeatTimer = null; }
    if (hostWatchTimer) { clearInterval(hostWatchTimer); hostWatchTimer = null; }
    if (presenceBeatTimer) { clearInterval(presenceBeatTimer); presenceBeatTimer = null; }
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    if (unwatchPresence) { unwatchPresence(); unwatchPresence = null; }
    if (detachCleanup) { detachCleanup(); detachCleanup = null; }
    presenceVal = {}; presenceLocal = {};
    hideHostOffline();
}

/* ---------- player presence ---------- */
function beatPresence() {
    if (isHost || isDevGame || !gameId || document.hidden || !window.Coins || !Coins.user) return;
    Coins.presenceBeat(gameId).catch(e => {
        if (e && e.code === "permission-denied" && presenceBeatTimer) { clearInterval(presenceBeatTimer); presenceBeatTimer = null; }
        console.warn("[presence]", e && e.code);
    });
}
// true / false, or undefined when we have never heard from that player (old app version, rules not updated): never shown as offline
function presenceOnline(uid) {
    if (Coins.user && uid === Coins.user.uid) return true;
    if (!(uid in presenceLocal)) return undefined;
    return Date.now() - presenceLocal[uid] < PRESENCE_OFFLINE_MS;
}
function refreshPresence() {
    members = members.map(m => Object.assign({}, m, { online: presenceOnline(m.uid) }));
    renderMembers();
}

/* ---------- host presence ---------- */
function beatHost() {
    if (!isHost || isDevGame || !gameId || !window.Coins || !Coins.user) return;
    if (Coins.beatAge() < 60000) return;      // a number was drawn a moment ago: that already counted as a heartbeat
    Coins.hostBeat(gameId).catch(e => {
        // not allowed (old rules): stop quietly. Players then never see a heartbeat, so nothing is flagged offline.
        if (e && e.code === "permission-denied" && hostBeatTimer) { clearInterval(hostBeatTimer); hostBeatTimer = null; }
        console.warn("[hostBeat]", e && e.code);
    });
}
// players: any sign of life from the host (heartbeat, a new number) resets the clock
function noteHostAlive(g) {
    const seen = g.hostSeenAt && g.hostSeenAt.toMillis ? g.hostSeenAt.toMillis() : null;
    const n = (g.calledNumbers || []).length;
    if (!hostSeenLocal || seen !== lastHostSeenAt || n !== lastCalledSeen) { hostSeenLocal = Date.now(); hideHostOffline(); }
    lastHostSeenAt = seen; lastCalledSeen = n;
}
function checkHostAlive() {
    if (isHost || isDevGame || !gameData || !gameData.hostSeenAt || !hostSeenLocal) return;   // no heartbeat ever seen: nothing to judge
    if (gameData.status !== "open" && gameData.status !== "started") return;
    const idle = Date.now() - hostSeenLocal;
    if (idle >= HOST_WARN_MS) showHostOffline(idle >= HOST_REFUND_MS);
}
function hideHostOffline() { const b = document.getElementById("host-offline"); if (b) b.remove(); }
function showHostOffline(canRefund) {
    let b = document.getElementById("host-offline");
    if (b && b.dataset.refund === String(canRefund)) return;
    if (b) b.remove();
    b = document.createElement("div");
    b.id = "host-offline"; b.dataset.refund = String(canRefund);
    b.style.cssText = "position:fixed;left:10px;right:10px;top:calc(env(safe-area-inset-top,0px) + 10px);z-index:9000;background:#3a1d1d;color:#fff;border:1px solid #e5484d;border-radius:12px;padding:10px 12px;font-size:14px;display:flex;gap:10px;align-items:center;justify-content:space-between";
    const t = document.createElement("span");
    t.textContent = canRefund ? "The host has been offline for over 5 minutes." : "The host seems to be offline. Waiting for them to come back...";
    b.appendChild(t);
    if (canRefund) {
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "btn-primary"; btn.textContent = "Get refund";
        btn.onclick = refundAndLeave;
        b.appendChild(btn);
    }
    document.body.appendChild(b);
}
async function refundAndLeave() {
    const ok = await askConfirm("Leave and get a refund?", "The host is offline. You will leave this room and get back your share of the entry fee (prizes already won by others are deducted).", "Get refund");
    if (!ok) return;
    try {
        const r = await Coins.refundEntry(gameId);
        intentionalExit = true;
        showNotification(r.amount > 0 ? `Refunded 🪙 ${r.amount}` : "You left the room.", "success");
        const gid = gameId, last = !members.some(m => !m.isHost && m.uid !== Coins.user.uid);
        goHome(last ? Coins.endGame(gid).catch(() => { }) : null);   // the last player out closes the room
    } catch (e) { showNotification(e.message || "Could not refund. Try again.", "error"); }
}
document.addEventListener("visibilitychange", () => {
    if (document.hidden || !gameId) return;
    hostSeenLocal = Date.now();     // we were away: give the live data a moment before judging the host
    beatHost();
    beatPresence();
});

function startListeners(gid) {
    stopListeners();
    hostSeenLocal = 0; lastHostSeenAt = undefined; lastCalledSeen = -1;
    if (isHost && !isDevGame) {
        beatHost(); hostBeatTimer = setInterval(beatHost, HOST_BEAT_MS);
        unwatchPresence = Coins.watchPresence(gid, seen => {
            Object.keys(seen).forEach(uid => { if (!(uid in presenceVal) || presenceVal[uid] !== seen[uid]) { presenceVal[uid] = seen[uid]; presenceLocal[uid] = Date.now(); } });
            refreshPresence();
        });
        presenceTimer = setInterval(refreshPresence, 30000);     // labels age even when nobody writes
    } else if (!isDevGame) {
        hostWatchTimer = setInterval(checkHostAlive, 20000);
        beatPresence(); presenceBeatTimer = setInterval(beatPresence, PRESENCE_BEAT_MS);
    }
    let primed = false;
    let finishHandled = false;
    let orphanTimer = null;
    let prevTaken = {};

    const onGame = g => {
        const prevLen = calledNumbers.length;
        gameData = g;
        if (!isHost && !isDevGame) noteHostAlive(g);
        calledNumbers = g.calledNumbers || [];
        claimsTaken = g.claimsTaken || {};
        claimsLocked = g.claimsLocked || {};
        if (Number.isFinite(g.ticketPrice)) ticketPrice = g.ticketPrice;
        document.getElementById("current-number").textContent = g.currentNumber != null ? g.currentNumber : "--";
        updatePrizeCard();
        updateCalledBoard();
        updateHistory();
        updateClaimButtons();
        syncMyWins();
        markPlayed(g);

        if (primed && calledNumbers.length > prevLen && g.currentNumber != null) {
            showNotification(`New Number Drawn: ${g.currentNumber}`);
        }
        // tell everyone when somebody wins a prize
        Object.keys(claimsTaken).forEach(k => {
            const before = prevTaken[k] || [];
            const fresh = (claimsTaken[k] || []).filter(n => !before.includes(n));
            if (primed && fresh.length && !fresh.every(n => n === myName)) {
                showNotification(`${fresh.join(", ")} won ${CLAIM_LABELS[k] || k}`, "success");
            }
            prevTaken[k] = (claimsTaken[k] || []).slice();
        });
        primed = true;

        if (isHost && isDevGame && g.status !== "finished") autoPlayDeveloper();

        // Safety net for the host: Housie already won (or all 90 numbers drawn) but the room is
        // still open - e.g. the host's tab was reloaded during the 3.5s close timer. Close it now.
        if (isHost && g.status !== "finished" && !closeRoomTimer &&
            ((g.claimsTaken && g.claimsTaken.housie && g.claimsTaken.housie.length) || (g.calledNumbers || []).length >= 90)) {
            closeRoomTimer = setTimeout(() => {
                Promise.allSettled([...inFlight]).then(() => Coins.endGame(gameId)).catch(() => { });
            }, 3500);
        }

        if (g.status === "finished" && !intentionalExit && !finishHandled) {
            finishHandled = true;
            if (isDevGame) showDevResultScreen(g);
            else {
                showNotification("Game over. The room is closed.");
                // the room is over: delete its temporary data from the backend (the room record + coin history stay)
                const gid = g.id || gameId;
                goHome(isHost ? new Promise(r => setTimeout(r, 800)).then(() => Coins.wipeRoom(gid)) : Coins.leaveGame(gid));
            }
        }
    };
    unwatchGame = Coins.watchGame(gid, onGame);

    const onPlayers = list => {
        members = list.map(p => Object.assign({}, p, {
            online: presenceOnline(p.uid)      // was always true; undefined = unknown
        }));
        renderMembers();
        syncMyWins();
        // Nobody is the host any more (host left / account removed) but the room is still open:
        // close it, so a room can never stay alive without its host. Best effort (rules / admin sweep back it up).
        if (!isHost && !isDevGame && list.length && !list.some(p => p.isHost) && gameData && gameData.status !== "finished") {
            if (!orphanTimer) orphanTimer = setTimeout(() => {
                orphanTimer = null;
                Coins.endGame(gid).catch(() => { });
            }, 4000);
        } else if (orphanTimer) { clearTimeout(orphanTimer); orphanTimer = null; }
        if (Coins.user) {
            const mine = list.find(p => p.uid === Coins.user.uid);
            if (mine) {
                myClaims = new Set(mine.claims || []);
                (mine.claimedTickets || []).forEach(c => {
                    if (c && c.claim && !appliedClaimVisuals.has(c.claim)) applyClaimVisuals(c.claim, c.ticket, true, c.row);
                });
                updateClaimButtons();
            }
        }
    };
    unwatchPlayers = Coins.watchPlayers(gid, onPlayers);

    // Players only: every live listener costs one read per change, for every player. A phone that has been in
    // the background for 2+ minutes stops listening and catches up in one go when the app comes back.
    if (!isHost && !isDevGame) {
        let hiddenTimer = null, detached = false;
        const onVis = () => {
            if (document.hidden) {
                if (hiddenTimer) return;
                hiddenTimer = setTimeout(() => {
                    hiddenTimer = null; detached = true;
                    if (unwatchGame) { unwatchGame(); unwatchGame = null; }
                    if (unwatchPlayers) { unwatchPlayers(); unwatchPlayers = null; }
                }, 120000);
            } else {
                if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null; }
                if (detached) {
                    detached = false;
                    unwatchGame = Coins.watchGame(gid, onGame);
                    unwatchPlayers = Coins.watchPlayers(gid, onPlayers);
                }
            }
        };
        document.addEventListener("visibilitychange", onVis);
        detachCleanup = () => { document.removeEventListener("visibilitychange", onVis); if (hiddenTimer) clearTimeout(hiddenTimer); };
    }

    if (isHost) {
        unwatchClaimRequests = Coins.watchClaimRequests(gid, handleIncomingClaimRequest);
        // tickets are no longer watched live: judgeClaim loads the claimer's ticket once (see ensureTickets)
    }

}

// Writes my own prize wins into the local coin history (idempotent by id). The winner's client
// is the only one that knows they won, and the amount is the same formula the host used to pay it.
// Stamps my entry for this room as "played" once the room has 2+ players and 5+ numbers were drawn
// (this is what the weekly / monthly play and prize tasks count).
function markPlayed(g) {
    if (isDevGame || !g || !window.Coins || !Coins.user) return;
    if ((Number(g.playerCount) || 0) < 2 || (g.calledNumbers || []).length < 5) return;
    Coins.localPatch("entry_" + (g.id || gameId), { played: true });
}
function syncMyWins() {
    if (!gameData || !gameId || !window.Coins || !Coins.user) return;
    const me = members.find(x => x.uid === Coins.user.uid);
    if (!me) return;
    (me.claimedTickets || []).forEach(c => {
        if (!c || !c.claim) return;
        const pct = (gameData.split || {})[c.claim];
        if (!Number.isFinite(pct)) return;
        const total = Coins.prizeShare(gameData.pot, c.claim, gameData.split) + (c.claim === "housie" ? Coins.HOUSIE_BONUS : 0);
        if (total > 0) Coins.localAdd({ id: "win_" + gameId + "_" + c.claim, type: "win", gameId, prize: c.claim, amount: total, mode: isDevGame ? "dev" : undefined });
    });
}

// cleanup (optional promise): runs before reload so the backend clean-up is never cut off (max 5s wait)
function goHome(cleanup) {
    stopListeners();
    const wait = Promise.race([Promise.resolve(cleanup).catch(() => { }), new Promise(r => setTimeout(r, 5000))]);
    wait.then(() => Coins.clearActiveGame()).catch(() => { }).then(() => setTimeout(() => location.reload(), 600));
}

function toggleHostUI(show) {
    // Only the draw controls are host-only; the called-numbers board and
    // history are visible to everyone so a reconnecting player can catch
    // up on what was drawn while they were away.
    const el = $("btn-draw");
    if (el) el.style.display = show ? "" : "none";
    const gc = document.querySelector(".game-controls");
    if (gc) gc.style.cursor = show ? "pointer" : "default";
    const am = $("auto-menu");
    if (am) am.classList.toggle("hidden", !show);
    if (!show) autoStop();
}

function showGameInProgressPopup() {
    const overlay = document.createElement("div");
    overlay.className = "popup-overlay active";
    overlay.style.zIndex = "9999";

    overlay.innerHTML = `
        <div class="popup-box">
            <h3 style="color: var(--danger);">Game already started</h3>
            <p>Ask the host to restart the game.</p>
            <button class="btn-primary" id="game-started-ok">OK</button>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("game-started-ok").onclick = () => {
        overlay.remove();
        const lobby = document.getElementById("screen-lobby");
        if (!lobby || !lobby.classList.contains("active")) location.reload();
    };
}

/* ================= CLAIM JUDGE (HOST) =================
   The host is the only judge. A claim is checked against the claimer's real
   ticket (the host reads every ticket set from the private tickets
   collection), never against the numbers the claim itself says. The verdict
   and its reservation happen the moment a claim arrives, so nothing waits
   behind other claims or other prizes. Recording the prize, locking it and
   paying the winner is one atomic batch: all of it happens, or none of it. */
const pendingPrizes = {};              // claim -> name of the player whose claim is being recorded
const pendingPlayerClaims = new Set(); // "uid|claim" accepted but not yet recorded
const pendingRows = new Set();         // "uid|ticket|row" taken by a line claim, not yet recorded
const handledRequests = new Set();     // claim request ids already judged
const inFlight = new Set();            // recordings still being written
let ticketsByUid = {};                 // uid -> ticket grids (host only)
let closeRoomTimer = null;

// rows of a ticket this player has already used for a line prize
function usedRowsFor(member, ticket) {
    const used = new Set();
    ((member && member.claimedTickets) || []).forEach(c => {
        if (c && String(c.claim).startsWith("line") && Number(c.ticket) === Number(ticket)) {
            used.add(c.row != null ? Number(c.row) : Number(String(c.claim).slice(4)) - 1);
        }
    });
    return used;
}

function judgeClaim(req) {
    const label = CLAIM_LABELS[req.claim];
    if (!label) return { ok: false, reason: "Unknown claim." };
    if (!gameData || gameData.status === "finished") return { ok: false, reason: "The game is over." };

    if (claimsLocked[req.claim] || req.claim in pendingPrizes) {
        const holder = claimsTaken[req.claim] ? claimsTaken[req.claim].join(", ") : pendingPrizes[req.claim];
        return { ok: false, reason: `${label} already claimed${holder ? " by " + holder : ""}` };
    }
    const member = members.find(m => m.uid === req.uid);
    if (!member) return { ok: false, reason: "Player not found in this room." };
    if ((member.claims || []).includes(req.claim) || pendingPlayerClaims.has(req.uid + "|" + req.claim)) {
        return { ok: false, reason: `You already claimed ${label}` };
    }
    const idx = Number(req.ticket);
    const tickets = ticketsByUid[req.uid];
    const ticket = tickets && tickets[idx - 1];
    if (!ticket) return { ok: false, reason: "Your ticket is still loading. Try again." };

    const called = new Set(calledNumbers);
    const marked = new Set((req.marked || []).map(Number));
    const hit = n => called.has(n) && marked.has(n);
    const rows = ticket.map(r => r.filter(Boolean));
    const all = rows.flat();
    let row = null;

    if (req.claim === "jaldi") {
        if (all.filter(hit).length < 5) return { ok: false, reason: "Marked numbers not matching. Check with host." };
    } else if (req.claim === "housie") {
        if (all.length !== 15 || !all.every(hit)) return { ok: false, reason: "Ticket is not full" };
    } else {
        // 1st, 2nd and 3rd Line: any complete row of this ticket that has not already won a line
        let complete = 0;
        const wanted = (req.row === null || req.row === undefined || req.row === "") ? null : Number(req.row);
        for (let r = 0; r < rows.length && row === null; r++) {
            if (wanted !== null && r !== wanted) continue;   // the player named the row: judge only that one
            if (!rows[r].length || !rows[r].every(hit)) continue;
            complete++;
            const taken = usedRowsFor(member, idx).has(r) || pendingRows.has(req.uid + "|" + idx + "|" + r);
            if (!taken) row = r;
        }
        if (row === null) {
            return { ok: false, reason: complete ? "Your completed lines are already claimed on this ticket" : `${label} is incomplete` };
        }
    }

    const split = gameData.split && gameData.split[req.claim];
    if (!Number.isFinite(split)) return { ok: false, reason: "Room is not ready. Try again." };
    return { ok: true, ticket: idx, row, share: Coins.prizeShare(gameData.pot, req.claim, gameData.split) };
}

// Judges a claim and, if valid, records it. Resolves with the verdict.
function handleClaimRequest(req) {
    if (req.id) {
        if (handledRequests.has(req.id)) return Promise.resolve(null);
        handledRequests.add(req.id);
    }
    return ensureTickets(req.uid).then(() => processClaim(req));
}

// host: load a player's ticket grids once (they never change), instead of a live listener on every ticket
function ensureTickets(uid) {
    if (ticketsByUid[uid] && ticketsByUid[uid].length) return Promise.resolve();
    return Coins.getTickets(gameId, uid)
        .then(t => { if (t && t.length) ticketsByUid[uid] = t; })
        .catch(() => { });
}

function processClaim(req) {
    const verdict = judgeClaim(req);
    if (!verdict.ok) return Promise.resolve(verdict);

    // reserve what this verdict depends on, so a claim arriving before this write lands is judged against it
    const playerKey = req.uid + "|" + req.claim;
    const rowKey = req.uid + "|" + verdict.ticket + "|" + verdict.row;
    pendingPrizes[req.claim] = req.name;
    pendingPlayerClaims.add(playerKey);
    if (verdict.row !== null) pendingRows.add(rowKey);
    const release = () => {
        delete pendingPrizes[req.claim];
        pendingPlayerClaims.delete(playerKey);
        if (verdict.row !== null) pendingRows.delete(rowKey);
    };

    const job = Coins.settleClaim(gameId, {
        claim: req.claim, uid: req.uid, name: req.name,
        ticket: verdict.ticket, row: verdict.row, share: verdict.share
    }).then(() => {
        release();
        recordClaimLocally(req, verdict);
        return { ok: true, claim: req.claim, ticket: verdict.ticket, row: verdict.row };
    }, e => {
        release();
        console.error("[claim]", e);
        return { ok: false, reason: "Could not record this claim. Try again." };
    });
    inFlight.add(job);
    job.then(() => inFlight.delete(job));
    return job;
}

function recordClaimLocally(req, v) {
    claimsTaken[req.claim] = [req.name];
    claimsLocked[req.claim] = true;
    const m = members.find(x => x.uid === req.uid);
    if (m) {
        m.claims = (m.claims || []).concat(req.claim);
        m.claimedTickets = (m.claimedTickets || []).concat({ claim: req.claim, ticket: v.ticket, row: v.row });
    }
    updateClaimButtons();
    renderMembers();
    showNotification(v.share ? `${CLAIM_LABELS[req.claim]} paid: 🪙 ${v.share}` : `${CLAIM_LABELS[req.claim]} claimed`, "success");
    if (req.claim === "housie" && isDevGame && gameData && gameData.devUid) {
        // 1:1 developer match: it is over now, so end it and free the developer straight away
        // (do not wait for a timer that "Back to Home" could cancel)
        endDevMatch(gameData.devUid, gameId);
    }
    if (req.claim === "housie" && !closeRoomTimer) {
        // Housie is the last prize: close the room for everyone after a short celebration
        closeRoomTimer = setTimeout(() => {
            Promise.allSettled([...inFlight]).then(() => Coins.endGame(gameId)).catch(() => { });
        }, 3500);
    }
}

// every incoming claim request goes straight through the judge
function handleIncomingClaimRequest(req) {
    // a request left unanswered for a long time (host was offline) must not be paid out by surprise later
    const sent = req.requestedAt && req.requestedAt.toMillis ? req.requestedAt.toMillis() : 0;
    if (sent && Date.now() - sent > 60000) {
        handledRequests.add(req.id);
        Coins.resolveClaimRequest(gameId, req.id, { ok: false, reason: "Claim expired. Please try again." });
        return;
    }
    handleClaimRequest(req).then(result => {
        if (result) Coins.resolveClaimRequest(gameId, req.id, result);
    });
}

/* ================= DEVELOPER AUTO-PLAY (instant, disclosed as "Auto-Play Opponent") =================
   Runs only in the opponent's browser (the developer has no live session), piggy-backing on the
   exact same judge/settle/celebrate pipeline used for every other claim above. On every called
   number it marks every number on the developer's ticket that has been called, then tries every
   still-open prize category; judgeClaim rejects anything not actually won yet, silently. */
function autoPlayDeveloper() {
    if (!gameData || !gameData.devUid) return;
    const devUid = gameData.devUid;
    ensureTickets(devUid).then(() => {
        const devTickets = ticketsByUid[devUid];
        if (!devTickets || !devTickets.length) return;
        const keys = PRIZE_ORDER.filter(k => !claimsLocked[k] && !(k in pendingPrizes));
        if (!keys.length) return;
        const calledSet = new Set(calledNumbers);
        const devMember = members.find(m => m.uid === devUid);
        const devName = (devMember && devMember.name) || gameData.devName || "Developer";
        devTickets.forEach((ticket, i) => {
            const marked = ticket.flat().filter(n => n && calledSet.has(n));
            if (!marked.length) return;
            keys.forEach(claim => {
                handleClaimRequest({ id: null, uid: devUid, name: devName, claim, ticket: i + 1, marked });
            });
        });
    });
}

/* ================= DEVELOPER GAME RESULT SCREEN ================= */
function showDevResultScreen(g) {
    stopListeners();
    const devUid = g.devUid, oppUid = g.oppUid || (Coins.user && Coins.user.uid);
    const devMember = members.find(m => m.uid === devUid);
    const oppWon = (uidWon) => uidWon === oppUid;
    $("devresult-dev-label").textContent = (devMember && devMember.name) || g.devName || "Developer";
    $("devresult-opp-label").textContent = "You";
    $("devresult-pot").textContent = "🪙 " + (g.pot || 0);

    const taken = g.claimsTaken || {};
    const split = g.split || Coins.SPLIT;
    $("devresult-prizes").innerHTML = PRIZE_ORDER.map(k => {
        const amt = Coins.prizeShare(g.pot, k, split);
        const w = taken[k];
        const who = w && w.length ? escapeHTML(w.join(", ")) : "Not claimed";
        return `<div class="row"><div><b>${CLAIM_LABELS[k]}</b><small>${who}</small></div><b>🪙 ${amt}</b></div>`;
    }).join("");

    const housieWinner = taken.housie && taken.housie[0];
    const iWonHousie = housieWinner && housieWinner === myName;
    $("devresult-title").textContent = iWonHousie ? "🎉 You Won!" : (g.cancelled ? "Game Cancelled" : "🎮 Game Complete");
    $("devresult-sub").textContent = g.cancelled ? "Both entry fees were refunded." : "Here's the final result.";
    $("devresult-tx").textContent = "Balances updated and settled.";
    $("devresult-screen").classList.add("active");

    Promise.all([Coins.userRef(devUid).get(), Coins.userRef(oppUid).get()]).then(([d, o]) => {
        $("devresult-dev-coins").textContent = "🪙 " + ((d.exists && d.data().coins) || 0);
        $("devresult-opp-coins").textContent = "🪙 " + ((o.exists && o.data().coins) || 0);
    }).catch(() => { });

    if (devUid) Coins.devReleaseLock(devUid, g.id || gameId).catch(() => { });
    Coins.clearActiveGame();
    // the match is over: delete its temporary data (the room record + coin history stay)
    if (Coins.user && (g.hostUid === Coins.user.uid || isHost)) setTimeout(() => Coins.wipeRoom(g.id || gameId).catch(() => { }), 1500);
}

$("devresult-home").onclick = () => {
    $("devresult-screen").classList.remove("active");
    location.reload();
};
$("devresult-again").onclick = () => {
    $("devresult-screen").classList.remove("active");
    sessionStorage.setItem("housie.devagain", "1");
    location.reload();
};

/* ================= UI RENDERING ================= */
function renderMembers() {
    const container = document.getElementById("members-list-container");
    container.innerHTML = "";
    let totalTickets = 0;

    members.forEach((m, i) => {
        const name = (m && m.name) ? m.name : "Player";
        const ticketsNum = (m && Number.isFinite(m.tickets)) ? m.tickets : 0;
        totalTickets += ticketsNum;
        const div = document.createElement("div");
        div.className = "member-item";
        div.dataset.uid = m.uid || "";
        const colors = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];
        div.style.borderLeft = `4px solid ${colors[i % colors.length]}`;
        div.innerHTML = `
            <div class="member-info">
                <div class="member-top">
                    <span class="member-name">${i + 1}. ${escapeHTML(name)}</span>
                    ${m.isHost ? '<span class="member-host">HOST</span>' : ''}
                    ${m.online === false ? '<span class="member-offline">OFFLINE</span>' : ''}
                </div>
                <div class="member-sub">
                    <span class="member-tickets">Tickets: ${ticketsNum}</span>${(m.claims && m.claims.length) ? `<span class="member-claims"> · ${m.claims.map(k => escapeHTML(CLAIM_LABELS[k] || k)).join(", ")}</span>` : ""}
                </div>
            </div>
            <span class="member-price">🪙 ${ticketsNum * ticketPrice}</span>
        `;
        container.appendChild(div);
    });

    document.getElementById("total-members").textContent = members.length;
    // the room document and the player list arrive separately: if the list is ahead (someone just joined),
    // use it for the total instead of showing a stale counter
    const potFresh = gameData && Number.isFinite(gameData.pot) && !(Number.isFinite(gameData.playerCount) && members.length > gameData.playerCount);
    document.getElementById("total-price").textContent = potFresh ? gameData.pot : Math.max(totalTickets * ticketPrice, (gameData && gameData.pot) || 0);
}

/* ================= GAMEPLAY ACTIONS ================= */
let lastDrawAt = 0;
document.getElementById("btn-draw").onclick = () => {
    if (!isHost || !gameId) return;
    if (autoOn) { autoStop("Auto generate paused"); return; }
    const now = Date.now();
    if (now - lastDrawAt < 600) return; // ignore accidental double taps
    lastDrawAt = now;
    Coins.draw(gameId).then(r => {
        if (r.done) showNotification("All numbers drawn!");
        // the game-doc listener (shared by host and joiners alike) is what
        // actually updates the board and current-number display
    }).catch(e => showNotification(e.message || "Could not draw a number.", "error"));
};

// tapping anywhere in the box (including the number) draws a number (not while auto generate runs)
document.querySelector(".game-controls").addEventListener("click", e => {
    if (autoOn) return;
    if (!e.target.closest("#btn-draw")) document.getElementById("btn-draw").click();
});

/* ================= AUTO GENERATE (host) =================
   Draws a number every N seconds (default 4). Lives in the three-dots menu. While it runs the
   Generate button becomes a blinking Pause button. It always waits for the previous draw to
   finish, and stops by itself when the game ends, Housie is claimed or all 90 are drawn. */
const AUTO_SPEEDS = [1, 3, 4, 5, 8], AUTO_DEFAULT = 4;
const DRAW_LABEL = "Generate Number";
let autoOn = false, autoTimer = null;
let autoSec = (v => AUTO_SPEEDS.includes(v) ? v : AUTO_DEFAULT)(Number(store.get("autoSec", AUTO_DEFAULT)));

function paintAutoUI() {
    const btn = $("btn-draw"), tg = $("auto-toggle");
    if (!btn) return;
    btn.classList.toggle("auto-running", autoOn);
    btn.setAttribute("aria-pressed", String(autoOn));
    btn.innerHTML = autoOn
        ? '<svg class="ico" aria-hidden="true"><use href="#i-pause" /></svg><span>Pause</span>'
        : DRAW_LABEL;
    if (tg) tg.checked = autoOn;
    const sub = $("auto-sub");
    if (sub) sub.textContent = autoOn ? `On · every ${autoSec} sec` : `Off · ${autoSec} sec`;
    document.querySelectorAll(".auto-speed button").forEach(b => {
        const on = Number(b.dataset.sec) === autoSec;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
    });
}
function autoStop(msg) {
    const was = autoOn;
    autoOn = false;
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    paintAutoUI();
    if (was && msg) showNotification(msg);
}
function autoSchedule(ms) {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(autoTick, ms);
}
function autoTick() {
    autoTimer = null;
    if (!autoOn) return;
    if (!isHost || !gameId || !gameData || gameData.status === "finished") { autoStop(); return; }
    if (claimsLocked.housie || (claimsTaken.housie && claimsTaken.housie.length)) { autoStop("Auto generate stopped: Housie was claimed"); return; }
    if (calledNumbers.length >= 90) { autoStop("All numbers drawn!"); return; }
    Coins.draw(gameId).then(r => {
        if (r && r.done) { autoStop("All numbers drawn!"); return; }
        if (autoOn) autoSchedule(autoSec * 1000);
    }).catch(e => autoStop((e && e.message) || "Auto generate paused: could not draw a number"));
}
function autoStart() {
    if (!isHost || !gameId) return;
    autoOn = true;
    paintAutoUI();
    showNotification(`Auto generate on · every ${autoSec} sec`);
    autoSchedule(400);
}
$("auto-head").onclick = () => {
    const p = $("auto-panel");
    const open = p.classList.toggle("hidden") === false;
    $("auto-head").setAttribute("aria-expanded", String(open));
    $("auto-head").classList.toggle("open", open);
};
$("auto-toggle").onchange = e => {
    closeMenu();
    if (e.target.checked) autoStart(); else autoStop("Auto generate paused");
};
document.querySelectorAll(".auto-speed button").forEach(b => {
    b.onclick = () => {
        autoSec = Number(b.dataset.sec);
        store.set("autoSec", autoSec);
        paintAutoUI();
        if (autoOn) autoSchedule(autoSec * 1000); // new speed applies from now
    };
});
paintAutoUI();

function updateCalledBoard() {
    const grid = document.getElementById("called-grid");
    if (!grid) return;
    grid.innerHTML = "";
    const latest = calledNumbers.length ? calledNumbers[calledNumbers.length - 1] : null;
    for (let i = 1; i <= 90; i++) {
        const d = document.createElement("div");
        const isCalled = calledNumbers.includes(i);
        d.className = "mini-cell" + (isCalled ? " called" : "") + (i === latest ? " latest" : "");
        d.textContent = i;
        grid.appendChild(d);
    }
}

function updateHistory() {
    const container = document.getElementById("called-history-list");
    if (!container) return;
    container.innerHTML = "";
    const lastCalled = [...calledNumbers].reverse().slice(0, 5);

    if (!lastCalled.length) {
        const empty = document.createElement("span");
        empty.className = "history-empty";
        empty.textContent = "No numbers called yet";
        container.appendChild(empty);
        return;
    }
    lastCalled.forEach(n => {
        const d = document.createElement("div");
        d.className = "called-num";
        d.textContent = n;
        container.appendChild(d);
    });
}

/* ================= TICKET GENERATION ================= */
function generateTickets(count, ticketsData) {
    ticketsContainer.innerHTML = "";
    ticketsContainer.dataset.count = count;
    for (let i = 1; i <= count; i++) {
        const ticketData = ticketsData[i - 1];
        if (!ticketData) { console.error("[tickets] missing ticket " + i + ": not replacing it with a random one"); continue; }
        const card = document.createElement("div");
        card.className = "ticket-card";
        card.dataset.ticket = i;
        card.dataset.tt = themeForTicket(i);
        card.innerHTML = buildTicketHTML(ticketData, i);
        ticketsContainer.appendChild(card);
    }
    enableCellClicks();
}

function buildTicketHTML(rows, index) {
    let html = `<div class="ticket-title">Ticket ${index}</div><div class="ticket-grid">`;
    rows.forEach((row, rIdx) => {
        html += `<div class="ticket-row" data-row="${rIdx}">`;
        row.forEach(num => {
            html += num ? `<div class="cell number-cell">${num}</div>` : `<div class="cell empty"></div>`;
        });
        html += `</div>`;
    });
    return html + `</div>`;
}

// Marked numbers are kept in localStorage only (no Firestore write per tap)
function persistMarks() {
    if (!gameId || !window.Coins || !Coins.user) return;
    const marked = {};
    document.querySelectorAll(".ticket-card").forEach(card => {
        marked[card.dataset.ticket] = Array.from(card.querySelectorAll(".number-cell.active")).map(c => Number(c.textContent));
    });
    Coins.activeUpdate({ marked });
}
function scheduleMarkedSave() { persistMarks(); }
function flushMarkedSaves() { persistMarks(); }
document.addEventListener("visibilitychange", () => { if (document.hidden) flushMarkedSaves(); });
window.addEventListener("pagehide", flushMarkedSaves);

function enableCellClicks() {
    document.querySelectorAll(".number-cell").forEach(cell => {
        cell.onclick = () => {
            cell.classList.toggle("active");
            const card = cell.closest(".ticket-card");
            if (card) scheduleMarkedSave(card.dataset.ticket);
        };
    });
}

/* ================= CLAIM HANDLING ================= */
let claimBusy = false;
function setClaimBusy(b) {
    claimBusy = b;
    document.querySelectorAll(".claim-btn").forEach(x => x.classList.toggle("pending", b));
}
document.querySelectorAll(".claim-btn").forEach(btn => {
    btn.onclick = () => {
        if (btn.disabled || claimBusy) return;
        btn.blur();
        selectedClaim = btn.dataset.claim;
        markClaim();
    };
});

const CLAIM_MISMATCH = "Numbers are not matched. Check again.";

// "matched" = marked by the player AND really called. Returns the matching ticket (and row) or null.
function findClaimTarget(claim) {
    const called = new Set(calledNumbers.map(Number));
    const isMatch = c => c.classList.contains("active") && called.has(Number(c.textContent));
    for (let t = 1; t <= ticketCount; t++) {
        const card = document.querySelector(`[data-ticket="${t}"]`);
        if (!card) continue;
        const cells = Array.from(card.querySelectorAll(".number-cell"));
        if (claim === "jaldi") {
            if (cells.filter(isMatch).length >= 5) return { ticket: t, row: null };
        } else if (claim === "housie") {
            if (cells.length === 15 && cells.every(isMatch)) return { ticket: t, row: null };
        } else {
            // 1st / 2nd / 3rd line: first complete row of this ticket that has not already won a line
            const rows = Array.from(card.querySelectorAll(".ticket-row"));
            for (const rowEl of rows) {
                if (rowEl.classList.contains("line-strike")) continue;
                const rc = Array.from(rowEl.querySelectorAll(".number-cell"));
                if (rc.length && rc.every(isMatch)) return { ticket: t, row: Number(rowEl.dataset.row) };
            }
        }
    }
    return null;
}

function updateClaimButtons() {
    document.querySelectorAll(".claim-btn").forEach(btn => {
        const key = btn.dataset.claim;
        const winners = claimsTaken[key] || [];
        btn.disabled = !!claimsLocked[key] || myClaims.has(key);
        btn.title = winners.length ? `Claimed by ${winners.join(", ")}` : "";
    });
}

const CLAIM_SHORT = { jaldi: "Jaldi", line1: "1st Line", line2: "2nd Line", line3: "3rd Line", housie: "Housie" };

function handleClaimResult(result) {
    if (result && result.ok) {
        myClaims.add(result.claim);
        updateClaimButtons();
        applyClaimVisuals(result.claim, result.ticket, true, result.row);
    } else {
        const why = (result && result.reason) || "Claim rejected";
        // any "your numbers do not match" verdict from the host gets the same clear red notice
        const mismatch = /incomplete|not matching|not full|not matched/i.test(why);
        showNotification(mismatch ? CLAIM_MISMATCH : why, "error");
    }
}

function markClaim() {
    if (claimBusy) return;
    flushMarkedSaves();
    if (claimsLocked[selectedClaim] || myClaims.has(selectedClaim)) {
        showNotification(`${CLAIM_LABELS[selectedClaim]} is no longer available`, "error");
        return;
    }
    if (!gameId || !Coins.user) { showNotification("Not connected to the room", "error"); return; }
    if (!document.querySelector(".ticket-card .number-cell.active")) {
        showNotification("Mark numbers first!", "error");
        return;
    }
    // no questions asked: the ticket and row are picked from the numbers that match the called ones
    const target = findClaimTarget(selectedClaim);
    if (!target) { showNotification(CLAIM_MISMATCH, "error"); return; }
    submitClaimNow(target.ticket, target.row);
}

function submitClaimNow(ticketIndex, row) {
    if (claimBusy) return;
    const ticket = document.querySelector(`[data-ticket="${ticketIndex}"]`);
    const activeCells = ticket ? Array.from(ticket.querySelectorAll(".number-cell.active")) : [];
    if (!activeCells.length) { showNotification("Mark numbers first!", "error"); return; }

    const payload = {
        claim: selectedClaim,
        name: myName,
        ticket: ticketIndex,
        marked: activeCells.map(c => Number(c.textContent))
    };
    if (row !== null && row !== undefined) payload.row = row;

    setClaimBusy(true);                          // instant feedback + ignore repeat taps
    showNotification("Checking your claim…");
    const done = r => { setClaimBusy(false); handleClaimResult(r); };
    const fail = e => { setClaimBusy(false); showNotification((e && e.message) || "Claim failed", "error"); };
    if (isHost) {
        handleClaimRequest(Object.assign({ id: null, uid: Coins.user.uid }, payload)).then(done).catch(fail);
    } else {
        Coins.submitClaim(gameId, payload).then(done).catch(fail);
    }
}

// Runs for the player whose claim the host accepted (celebrate = false when
// silently restoring a past claim's visuals on reconnect, instead of re-firing
// the toast/win-screen for something already won).
function applyClaimVisuals(claim, ticketIndex, celebrate = true, row) {
    const ticket = document.querySelector(`[data-ticket="${ticketIndex}"]`);
    if (!ticket) return;
    if (appliedClaimVisuals.has(claim)) return; // already drawn (by the claim reply or the live listener)
    appliedClaimVisuals.add(claim);
    const activeCells = Array.from(ticket.querySelectorAll(".number-cell.active"));

    if (claim === "jaldi") {
        activeCells.forEach(cell => cell.classList.add("claimed", "strike"));
        if (celebrate) showNotification("Jaldi 5 Claimed!");
    } else if (claim.startsWith("line")) {
        const lineIdx = parseInt(claim.replace("line", "")) - 1;
        const rowIdx = row != null ? row : lineIdx; // older saved claims have no row
        const targetRow = ticket.querySelector(`.ticket-row[data-row="${rowIdx}"]`);
        if (targetRow) {
            targetRow.querySelectorAll(".number-cell.active").forEach(cell => cell.classList.add("claimed"));
            targetRow.classList.add("line-strike");
        }
        if (celebrate) showNotification(`Line ${lineIdx + 1} Claimed!`);
    } else if (claim === "housie") {
        activeCells.forEach(cell => cell.classList.add("claimed"));
        if (celebrate) showWinScreen();
    }
}

/* ================= WIN & LEAVE ================= */
function showWinScreen() {
    const prize = gameData ? Coins.prizeShare(gameData.pot, "housie", gameData.split) : 0;
    $("win-coins").textContent = "+" + prize;
    $("win-bonus").textContent = "+" + Coins.HOUSIE_BONUS;
    $("win-text").textContent = "You claimed Housie!";
    winScreen.classList.add("active");
    createConfetti();
}

function createConfetti() {
    const container = document.querySelector(".confetti-container");
    container.innerHTML = "";
    for (let i = 0; i < 150; i++) {
        const c = document.createElement("div");
        c.className = "confetti";
        c.style.left = Math.random() * 100 + "%";
        c.style.top = Math.random() * 100 + "%";
        c.style.backgroundColor = ["#6366f1", "#10b981", "#f59e0b", "#ef4444"][Math.floor(Math.random() * 4)];
        c.style.animationDuration = (Math.random() * 2 + 2.5) + "s";
        container.appendChild(c);
    }
}

// "Back to Home" after a win is a *passive* exit: I stop watching this
// room and forget it's my active game, but I stay a member (others still
// see me in the list, now going stale/offline) in case I come back.
let devMatchEnding = null;
function endDevMatch(devUid, gid) {
    if (devMatchEnding) return devMatchEnding;
    devMatchEnding = Promise.allSettled([...inFlight])
        .then(() => Coins.endGame(gid)).catch(() => { })
        .then(() => Coins.devReleaseLock(devUid, gid)).catch(() => { });
    return devMatchEnding;
}
document.getElementById("win-home").onclick = () => {
    const go = () => { stopListeners(); Coins.clearActiveGame(); location.reload(); };
    if (isDevGame && gameData && gameData.devUid) {
        // finish the match and free the developer BEFORE leaving, but never get stuck here
        Promise.race([endDevMatch(gameData.devUid, gameId), new Promise(r => setTimeout(r, 4000))]).then(go);
        return;
    }
    go();
};

document.getElementById("btn-leave").onclick = () => {
    const sub = document.getElementById("leave-popup-sub");
    if (sub) {
        if (isDevGame) {
            const started = !!(gameData && (gameData.calledNumbers || []).length);
            sub.textContent = started
                ? "Play has started - your entry fee is not refunded and any unclaimed prizes go to the developer."
                : "No numbers called yet - both entry fees will be refunded in full.";
        } else {
            sub.textContent = "Your entry fee is not refunded.";
        }
    }
    leavePopup.classList.add("active");
};
leaveCancel.onclick = () => leavePopup.classList.remove("active");
leaveConfirm.onclick = () => {
    intentionalExit = true;
    const finish = () => { stopListeners(); setTimeout(() => location.reload(), 50); };
    if (isDevGame) {
        // Play with Developer is strictly 1:1, so leaving always ends the match right away -
        // there's no second human to keep playing. Settle per the disclosed cancellation policy
        // (full refund if nobody has played a number yet, remaining prizes forfeited to the
        // developer if play already started), then always release the developer's "busy" lock
        // so a stale lock from a left game can never block future challenges.
        const gid = gameId, devUid = gameData && gameData.devUid, oppUid = Coins.user.uid;
        const stake = gameData && gameData.stake;
        const started = !!(gameData && (gameData.calledNumbers || []).length);
        const settle = started
            ? Coins.devForfeit(gid, devUid).then(() => Coins.clearActiveGame())
            : Coins.devCancelIfUnplayed(gid, devUid, oppUid, stake).catch(() => Coins.clearActiveGame());
        sessionStorage.setItem("housie.devleft", started ? "forfeit" : "refund");
        settle
            .catch(() => { })
            .then(() => Coins.devReleaseLock(devUid, gid))
            .catch(() => { })
            .then(finish);
        return;
    }
    if (isHost) {
        // let recordings already in flight finish (max 4s), then close the room for everyone
        const gid = gameId;
        Promise.race([Promise.allSettled([...inFlight]), new Promise(r => setTimeout(r, 2000))])
            .then(() => Coins.endGame(gid))
            .catch(() => { })
            .then(() => { stopListeners(); return new Promise(r => setTimeout(r, 1200)); }) // players get "Game over" first
            .then(() => Coins.wipeRoom(gid))
            .then(() => Coins.clearActiveGame())
            .then(finish);
    } else {
        Coins.leaveGame(gameId).catch(() => { }).then(finish);
    }
};

/* ================= TAMBOLA GENERATOR ================= */
// A player's tickets come from one standard Tambola strip: 6 tickets that
// together use every number 1-90 exactly once, so no number repeats across
// the tickets a player holds. Returns the first `count` tickets (1 to 4).
// the signed-in player's saved favorite numbers (empty when none / not valid for a ticket)
function myFavorites() { return validFavorites((window.Coins && Coins.favorites) || []); }
// 1 to 10 unique numbers 1-90, at most 3 from the same column (a ticket column holds 3 numbers at most);
// the ticket keeps one number in every empty column, so favorites + empty columns must fit in 15 numbers
function validFavorites(list) {
    const f = Array.from(new Set((list || []).map(Number))).filter(n => Number.isInteger(n) && n >= 1 && n <= 90);
    if (f.length < 1 || f.length > 10) return [];
    const per = Array(9).fill(0);
    f.forEach(n => { per[Math.min(8, Math.floor(n / 10))]++; });
    return per.every(c => c <= 3) && per.reduce((s, c) => s + Math.max(1, c), 0) <= 15 ? f : [];
}
function generateTambolaSet(count, favs) {
    favs = validFavorites(favs);
    // with favorites every ticket must hold the same favorite numbers, so the tickets cannot come from one strip
    if (favs.length) return Array.from({ length: count }, () => generateFavoriteTicket(favs));
    const ranges = [[1, 9], [10, 19], [20, 29], [30, 39], [40, 49], [50, 59], [60, 69], [70, 79], [80, 90]];
    const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; };
    for (let attempt = 0; attempt < 500; attempt++) {
        // 1) how many numbers each ticket holds in each column (1 to 3)
        const k = Array.from({ length: 6 }, () => Array(9).fill(1));
        const room = Array(6).fill(6);                       // each ticket needs 6 more to reach 15
        let ok = true;
        for (const c of shuffle([...Array(9).keys()])) {
            const need = ranges[c][1] - ranges[c][0] + 1 - 6; // column size minus the 6 already placed
            for (let n = 0; n < need && ok; n++) {
                const cand = [...Array(6).keys()].filter(t => room[t] > 0 && k[t][c] < 3);
                if (!cand.length) { ok = false; break; }
                const t = cand[Math.floor(Math.random() * cand.length)];
                k[t][c]++; room[t]--;
            }
            if (!ok) break;
        }
        if (!ok || room.some(r => r !== 0)) continue;
        // 2) put those numbers in rows so every row has exactly 5
        const grids = [];
        for (let t = 0; t < 6 && ok; t++) {
            let layout = null;
            for (let tr = 0; tr < 200 && !layout; tr++) {
                const g = Array.from({ length: 3 }, () => Array(9).fill(false));
                const rowCount = [0, 0, 0];
                for (let c = 0; c < 9; c++) {
                    shuffle([0, 1, 2]).slice(0, k[t][c]).forEach(r => { g[r][c] = true; rowCount[r]++; });
                }
                if (rowCount.every(n => n === 5)) layout = g;
            }
            if (!layout) ok = false; else grids.push(layout);
        }
        if (!ok) continue;
        // 3) deal each column's numbers out to the tickets, ascending top to bottom
        const tickets = Array.from({ length: 6 }, () => Array.from({ length: 3 }, () => Array(9).fill(null)));
        for (let c = 0; c < 9; c++) {
            const pool = [];
            for (let n = ranges[c][0]; n <= ranges[c][1]; n++) pool.push(n);
            shuffle(pool);
            for (let t = 0; t < 6; t++) {
                const rows = [0, 1, 2].filter(r => grids[t][r][c]);
                pool.splice(0, rows.length).sort((a, b) => a - b).forEach((n, i) => { tickets[t][rows[i]][c] = n; });
            }
        }
        return shuffle(tickets).slice(0, count);
    }
    // extremely unlikely fallback: independent tickets
    return Array.from({ length: count }, () => generateTambolaTicket());
}

/* ================= TAMBOLA TICKET WITH FAVORITE NUMBERS ================= */
// Builds a whole valid ticket around the favorites, 1 to 10 of them (3 rows x 9 columns, 15 numbers, 5 per row, every column
// 1-3 numbers, ascending inside a column). Nothing is swapped into a finished ticket: the column counts and row
// layout are decided first (favorites already counted), then each column is filled with its favorites + random others.
function generateFavoriteTicket(favs) {
    const ranges = [[1, 9], [10, 19], [20, 29], [30, 39], [40, 49], [50, 59], [60, 69], [70, 79], [80, 90]];
    const colOf = n => Math.min(8, Math.floor(n / 10));
    const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; };
    const byCol = Array.from({ length: 9 }, () => []);
    favs.forEach(n => byCol[colOf(n)].push(n));
    for (let attempt = 0; attempt < 3000; attempt++) {
        const k = byCol.map(a => Math.max(1, a.length));
        let total = k.reduce((a, b) => a + b, 0);
        while (total < 15) {
            const open = [...Array(9).keys()].filter(c => k[c] < 3);
            k[open[Math.floor(Math.random() * open.length)]]++; total++;
        }
        let layout = null;
        for (let tr = 0; tr < 300 && !layout; tr++) {
            const g = Array.from({ length: 3 }, () => Array(9).fill(false));
            const rc = [0, 0, 0];
            for (let c = 0; c < 9; c++) shuffle([0, 1, 2]).slice(0, k[c]).forEach(r => { g[r][c] = true; rc[r]++; });
            if (rc.every(n => n === 5)) layout = g;
        }
        if (!layout) continue;
        const ticket = Array.from({ length: 3 }, () => Array(9).fill(null));
        for (let c = 0; c < 9; c++) {
            const pool = [];
            for (let n = ranges[c][0]; n <= ranges[c][1]; n++) if (!favs.includes(n)) pool.push(n);
            shuffle(pool);
            const nums = byCol[c].concat(pool.slice(0, k[c] - byCol[c].length)).sort((a, b) => a - b);
            const rows = [0, 1, 2].filter(r => layout[r][c]);
            nums.forEach((n, i) => { ticket[rows[i]][c] = n; });
        }
        return ticket;
    }
    return generateTambolaTicket();   // practically unreachable
}

/* ================= TAMBOLA SINGLE TICKET ================= */
function generateTambolaTicket() {
    const ranges = [[1, 9], [10, 19], [20, 29], [30, 39], [40, 49], [50, 59], [60, 69], [70, 79], [80, 90]];
    // 5 numbers per row, and every column must hold at least one number
    let cols;
    do {
        cols = Array.from({ length: 3 }, () => {
            const picked = new Set();
            while (picked.size < 5) picked.add(Math.floor(Math.random() * 9));
            return picked;
        });
    } while (![...Array(9).keys()].every(c => cols.some(r => r.has(c))));

    const ticket = Array.from({ length: 3 }, () => Array(9).fill(null));
    for (let c = 0; c < 9; c++) {
        const rows = [0, 1, 2].filter(r => cols[r].has(c));
        const [min, max] = ranges[c];
        const pool = [];
        for (let n = min; n <= max; n++) pool.push(n);
        for (let i = pool.length - 1; i > 0; i--) {          // Fisher-Yates: every order equally likely
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        // numbers in a column go in ascending order from top to bottom
        pool.slice(0, rows.length).sort((a, b) => a - b).forEach((n, i) => { ticket[rows[i]][c] = n; });
    }
    return ticket;
}

/* ================= RESUME ON LOAD ================= */
// Replaces the old localStorage-based auto-reconnect: whoever is signed in
// has their active room recorded on their own account doc in Firestore, so
// this works the same whether it's a refresh or a different device.

/* =====================================================================
   APP SHELL: navigation, Home, Lobby, Earn, Profile, Stats, History
   Everything below reads from the same Firestore data as before
   (users/{uid}, users/{uid}/ledger, games). Profile preferences
   (name, theme, random-theme, screen-awake) live in Firestore (users/{uid}/data/prefs).
   ===================================================================== */

/* ================= RESUME / ENTRY ================= */
function enterHome() {
    if (sessionStorage.getItem("housie.devleft")) {
        const how = sessionStorage.getItem("housie.devleft");
        sessionStorage.removeItem("housie.devleft");
        showNotification(how === "refund" ? "Challenge cancelled - both entry fees refunded in full." : "You left the challenge - remaining prizes were awarded to the developer.", how === "refund" ? "success" : "info");
    }
    if (sessionStorage.getItem("housie.devagain")) {
        sessionStorage.removeItem("housie.devagain");
        showView("devlobby");
    } else if (sessionStorage.getItem("housie.again")) {
        sessionStorage.removeItem("housie.again");
        setLobbyTab("create");
        showView("lobby");
    } else {
        showView("home");
    }
}

function attemptResume(user) {
    if (!user || !window.Coins || !Coins.enabled) return;
    // wait for the device file to be loaded, otherwise the saved room looks missing
    const filesReady = (window.Persist && Persist.ready) ? Persist.ready : Promise.resolve();
    filesReady.then(() => {
        const info = Coins.activeLoad();
        if (!info || !info.gameId) { enterHome(); return; }
        showReconnectOverlay(info.roomId);
        // 1 read: is the room still alive?
        Coins.gameRef(info.gameId).get().then(gs => {
            if (!gs.exists || gs.data().status === "finished") { Coins.clearActiveGame().catch(() => { }); return false; }
            const g = Object.assign({ id: gs.id }, gs.data());
            myName = info.name || myDisplayName();
            ticketCount = info.tickets || 1;
            isHost = !!info.isHost;
            isDevGame = g.mode === "dev";
            gameId = g.id;
            myRoomId = g.roomCode;
            ticketPrice = isDevGame ? g.stake : g.ticketPrice;
            // local copy of the tickets if complete, otherwise reloaded from Firestore (1 extra read, only then)
            return loadMyTickets(g.id, info.ticketsData, info.tickets).then(ticketsData => {
                enterArena({ ticketsData, marked: info.marked || {}, claimedTickets: [], claims: [] });
                showNotification("Welcome back! Room restored.");
                return true;
            });
        }).then(entered => {
            hideReconnectOverlay();
            if (!entered) enterHome();
        }).catch(e => {
            // the saved room is kept, so the player can try again; nothing is replaced by made-up tickets
            hideReconnectOverlay();
            if (e && e.message) showNotification(e.message, "error");
            enterHome();
        });
    });
}

// Safety net: if auth never answers (offline), reveal the sign-in screen after a while.
setTimeout(() => document.body.classList.add("auth-ready"), 6000);
if (!window.Coins || !Coins.enabled) document.body.classList.add("auth-ready");

let devRefreshAt = 0;
function startDevWatch() {
    devRefreshAt = Date.now();
    if (devUnwatch) devUnwatch();
    devUnwatch = Coins.watchDeveloper(info => { devInfo = info; paintDevWidgets(); });
}
// the first lookup can miss (slow network): look again whenever a screen needs the developer, at most every 10s
function refreshDevInfo() {
    if (devInfo || !window.Coins || !Coins.user || Date.now() - devRefreshAt < 10000) return;
    startDevWatch();
}
// every player gets a 4-digit code the first time they sign in (before, only players who opened Share Coins had one,
// so new players were missing from "See your friends' codes")
let codeEnsuredFor = null;
function ensureMyCode(user) {
    if (!user || codeEnsuredFor === user.uid || !window.Coins || !Coins.myCode) return;
    codeEnsuredFor = user.uid;
    Coins.myCode().catch(() => { codeEnsuredFor = null; });   // tried again on the next sign-in
}
let authHandled = false;
function onAuth(user) {
    authHandled = true;
    if (!user) {
        if (devUnwatch) { devUnwatch(); devUnwatch = null; }
        devInfo = null;
        showView("welcome");
        return;
    }
    applyCloudSettings();
    ensureMyCode(user);
    if (!devUnwatch) startDevWatch();
    if (currentView === "arena") return;
    attemptResume(user);
}
if (window.Coins && Coins.enabled) {
    Coins.authListeners.push(onAuth);
    Coins.ready.then(u => { if (!authHandled) onAuth(u); });
    // only screens that draw from local data are re-drawn (no screen here does a Firestore read any more)
    const LOCAL_VIEWS = ["home", "earn", "stats", "profile", "history"];
    const refreshLocalViews = () => {
        updateCost();
        updateTaskBadge();
        if (LOCAL_VIEWS.includes(currentView) && VIEW_LOADERS[currentView]) VIEW_LOADERS[currentView]();
    };
    Coins.onBalance = refreshLocalViews;
    Coins.onLocal = refreshLocalViews;
    Coins.onCloud = applyCloudSettings;
}

/* ================= SMALL HELPERS ================= */
const BONUS_DAYS = [1000, 1000, 1000, 1000, 1000, 1000, 1000];
const WHEEL_PRIZES = [100, 100, 150, 200, 250, 300, 500];
const MIN_TICKET_PRICE = 10;

const pad = n => String(n).padStart(2, "0");
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// the device file now only holds the room being played; tell the player if it could not be read
(window.Persist && Persist.ready ? Persist.ready : Promise.resolve()).then(() => {
    if (window.Persist && Persist.native && !Persist.ok) showNotification("Could not read your saved data. It was left untouched and will be used once it can be read.", "error");
});
function weekKey(d) {
    const m = new Date(d);
    m.setHours(0, 0, 0, 0);
    m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); // Monday
    return dayKey(m);
}
const monthKey = d => dayKey(new Date(d.getFullYear(), d.getMonth(), 1)); // first day of the month
// Reads a time in any shape old data may have: Firestore Timestamp, Date, ms / seconds number,
// ISO string, or a plain {seconds, nanoseconds} map (what an un-converted backup restores as).
function toDateAny(v) {
    if (!v) return null;
    if (typeof v.toDate === "function") return v.toDate();
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === "number") return new Date(v < 1e11 ? v * 1000 : v);
    if (typeof v === "string") { const d = new Date(v); return isNaN(d) ? null : d; }
    if (typeof v === "object") {
        const sec = v.seconds != null ? v.seconds : v._seconds;
        if (typeof sec === "number") return new Date(sec * 1000 + Math.floor((v.nanoseconds || v._nanoseconds || 0) / 1e6));
    }
    return null;
}
// the time of a ledger row: "time", or whichever older field name that row used
function rowTime(t) {
    if (!t) return null;
    for (const k of ["time", "createdAt", "at", "timestamp", "ts", "date", "created"]) {
        const d = toDateAny(t[k]); if (d) return d;
    }
    return null;
}
const timeOf = e => rowTime(e) || new Date();
const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
const roomOf = gid => String(gid || "").split("-")[0];
// full wording for screens: a normal room shows "Room 6915", a match against the developer shows "Developer match"
const roomLabel = gid => (String(gid || "").split("-")[0] === "dev" ? "Developer match" : "Room " + roomOf(gid));
const fmtDate = d => d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const signed = n => (n >= 0 ? "+" : "") + n;

function myDisplayName() {
    const u = window.Coins && Coins.user;
    return store.get("name", "") || (u && (u.displayName || (u.email || "").split("@")[0])) || "Player";
}
function avatarLetter(name) {
    return ((name || "P").trim().charAt(0) || "P").toUpperCase();
}
function setAvatar(el, name) {
    if (el) el.textContent = avatarLetter(name);
}

// The coin history is a capped copy kept in Firestore (users/{uid}/data/history, see Coins.localAdd): 1 read per sign-in.
async function getLedger() { return Coins.localLedger(); }

/* ================= DERIVED DATA (from the ledger) ================= */
function computeStats(L) {
    const entries = L.filter(e => e.type === "entry");
    const wins = L.filter(e => e.type === "win");
    const games = entries.length;
    const winGames = new Set(wins.map(w => w.gameId)).size;
    const coinsWon = sum(wins, w => w.amount);
    const spent = -sum(entries, e => e.amount) - sum(L.filter(e => e.type === "refund"), e => e.amount);   // refunds give fees back
    const days = new Set(entries.map(e => dayKey(timeOf(e))));
    let best = 0;
    [...days].sort().forEach(k => {
        let n = 0; const d = new Date(k + "T00:00:00");
        while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
        best = Math.max(best, n);
    });
    return {
        games, wins: wins.length, winGames, coinsWon, spent, net: coinsWon - spent,
        winRate: games ? Math.round(winGames / games * 100) : 0,
        bestStreak: best,
        housie: wins.filter(w => w.prize === "housie").length,
        entries, winsList: wins
    };
}

function bonusState(L) {
    const days = new Set(L.filter(e => e.type === "daily").map(e => e.id.slice(6)));
    const claimedToday = days.has(dayKey(new Date()));
    const d = new Date();
    if (!claimedToday) d.setDate(d.getDate() - 1);
    let streak = 0;
    while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
    const done = claimedToday ? ((streak - 1) % 7) + 1 : streak % 7;
    return { claimedToday, streak, done, amount: claimedToday ? 0 : BONUS_DAYS[streak % 7] };
}

function sessionsFrom(L) {
    const map = new Map();
    L.forEach(e => {
        if (!e.gameId || (e.type !== "entry" && e.type !== "win" && e.type !== "refund")) return;
        const s = map.get(e.gameId) || { gameId: e.gameId, time: timeOf(e), fee: 0, won: [], net: 0 };
        if (e.type === "entry") { s.fee = -e.amount; s.time = timeOf(e); }
        else if (e.type === "win") s.won.push(CLAIM_LABELS[e.prize] || e.prize);
        s.net += e.amount;
        map.set(e.gameId, s);
    });
    return [...map.values()].sort((a, b) => b.time - a.time);
}

/* ---------- tasks ---------- */
// everything a task can count, for one period (today / this week / this month)
const TASK_RULES_FROM = new Date(2026, 10, 15).getTime();   // 15 Nov 2026: from this day on, games must be stamped as played
function periodStats(L, inP) {
    // Anti-farming for tasks: a game counts only when an entry fee was paid AND it was really played with other
    // players (the room had 2+ players and at least 5 numbers were drawn; the app stamps entry.played for that, see markPlayed).
    // Entries from before TASK_RULES_FROM have no stamp yet, so a paid entry counts for them. Prizes count when their game counts.
    const counted = new Set();
    L.forEach(e => {
        if (e.type === "entry" && e.gameId && e.amount < 0 && (e.played || +timeOf(e) < TASK_RULES_FROM)) counted.add(e.gameId);
    });
    const entries = L.filter(e => e.type === "entry" && inP(e) && counted.has(e.gameId));
    const wins = L.filter(e => e.type === "win" && inP(e) && (e.mode === "dev" || counted.has(e.gameId)));
    const prize = p => wins.filter(w => w.prize === p).length;
    return {
        play: entries.length,
        win: wins.length,
        jaldi: prize("jaldi"),
        lines: prize("line1") + prize("line2") + prize("line3"),
        housie: prize("housie")
    };
}
function taskContext(L) {
    const st = computeStats(L);
    const now = new Date();
    const today = dayKey(now), week = weekKey(now), month = monthKey(now);
    return {
        st,
        day: periodStats(L, e => dayKey(timeOf(e)) === today),
        week: periodStats(L, e => weekKey(timeOf(e)) === week),
        month: periodStats(L, e => monthKey(timeOf(e)) === month),
        claimed: new Set(L.filter(e => e.type === "task").map(e => e.id))
    };
}
// Task ids end in "_v4": the new targets/rewards start fresh, so tasks already claimed under the old values can be earned again once.
// Daily tasks use "_v4" ids (new targets/rewards). Daily 6 tasks, weekly 6 + a "complete all" bonus, monthly 6 + a "complete all" bonus. Daily refreshes at midnight, weekly on Monday 00:00, monthly on the 1st at 00:00 (device time).
// firestore.rules must allow the task ledger entries up to the biggest reward below (1740000).
const TASKS = {
    daily: [
        { id: "play10_v4", title: "Play 10 games", target: 10, reward: 3000, calc: c => c.day.play },
        { id: "play15_v4", title: "Play 15 games", target: 15, reward: 5000, calc: c => c.day.play },
        { id: "jaldi5_v4", title: "Win 5 Jaldi", target: 5, reward: 4000, calc: c => c.day.jaldi },
        { id: "line5_v4", title: "Win 5 Lines", target: 5, reward: 5500, calc: c => c.day.lines },
        { id: "win15_v4", title: "Win any 15 prizes", target: 15, reward: 7000, calc: c => c.day.win },
        { id: "housie5_v4", title: "Win 5 Housie", target: 5, reward: 10000, calc: c => c.day.housie }
    ],
    weekly: [
        { id: "w_play70_v4", title: "Play 70 games", target: 70, reward: 35000, calc: c => c.week.play },
        { id: "w_play105_v4", title: "Play 105 games", target: 105, reward: 56000, calc: c => c.week.play },
        { id: "w_jaldi35_v4", title: "Win 35 Jaldi", target: 35, reward: 49000, calc: c => c.week.jaldi },
        { id: "w_line35_v4", title: "Win 35 Lines", target: 35, reward: 63000, calc: c => c.week.lines },
        { id: "w_win105_v4", title: "Win any 105 prizes", target: 105, reward: 84000, calc: c => c.week.win },
        { id: "w_housie35_v4", title: "Win 35 Housie", target: 35, reward: 119000, calc: c => c.week.housie },
        { id: "w_all_v4", title: "Complete all weekly tasks", target: 6, reward: 406000, calc: c => allDone("weekly", c) }
    ],
    monthly: [
        { id: "m_play300_v4", title: "Play 300 games", target: 300, reward: 150000, calc: c => c.month.play },
        { id: "m_play450_v4", title: "Play 450 games", target: 450, reward: 240000, calc: c => c.month.play },
        { id: "m_jaldi150_v4", title: "Win 150 Jaldi", target: 150, reward: 210000, calc: c => c.month.jaldi },
        { id: "m_line150_v4", title: "Win 150 Lines", target: 150, reward: 270000, calc: c => c.month.lines },
        { id: "m_win450_v4", title: "Win any 450 prizes", target: 450, reward: 360000, calc: c => c.month.win },
        { id: "m_housie150_v4", title: "Win 150 Housie", target: 150, reward: 510000, calc: c => c.month.housie },
        { id: "m_all_v4", title: "Complete all monthly tasks", target: 6, reward: 1740000, calc: c => allDone("monthly", c) }
    ],
    once: [
        { id: "first_game", title: "Play your first game", target: 1, reward: 20, calc: c => c.st.games },
        { id: "first_win", title: "Win your first prize", target: 1, reward: 30, calc: c => c.st.wins },
        { id: "first_housie", title: "Win a Housie", target: 1, reward: 100, calc: c => c.st.housie },
        { id: "games25", title: "Play 25 games", target: 25, reward: 100, calc: c => c.st.games }
    ]
};
// progress of the "Complete all ... tasks" bonus: how many of the other tasks in the set have reached their target
const allDone = (kind, c) => TASKS[kind].filter(x => !/_all_/.test(x.id) && x.calc(c) >= x.target).length;
const periodOf = kind => (kind === "daily" ? dayKey(new Date()) : kind === "weekly" ? weekKey(new Date()) : kind === "monthly" ? monthKey(new Date()) : "once");
// when each set refreshes: next midnight / next Monday 00:00 / the 1st of next month 00:00
function nextReset(kind) {
    const n = new Date();
    if (kind === "daily") return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
    if (kind === "weekly") return new Date(n.getFullYear(), n.getMonth(), n.getDate() + (8 - (n.getDay() || 7)));
    return new Date(n.getFullYear(), n.getMonth() + 1, 1);
}
function taskView(kind, t, c) {
    const progress = Math.min(t.calc(c), t.target);
    const ledgerId = `task_${periodOf(kind)}_${t.id}`;
    return { t, kind, progress, ledgerId, done: progress >= t.target, claimed: c.claimed.has(ledgerId), pct: Math.round(progress / t.target * 100) };
}

/* ================= NAVIGATION + TABS ================= */
document.addEventListener("click", e => {
    const markBtn = e.target.closest("[data-mark-read]");
    if (markBtn) { markUpdateRead(markBtn.dataset.markRead); return; }
    const newFeat = e.target.closest("[data-new]");
    if (newFeat) markFeatureSeen(newFeat.dataset.new);
    const nav = e.target.closest("[data-open]");
    if (nav && !nav.closest("#screen-arena")) {
        // "Check update" button inside an update card: opening it counts as reading that update
        const updItem = nav.closest(".upd-item");
        if (updItem && updItem.dataset.updId) markUpdateRead(updItem.dataset.updId);
        if (nav.dataset.tab) setLobbyTab(nav.dataset.tab);
        if (nav.dataset.open === "history") {
            // back arrow + bottom-nav highlight follow the screen History was opened from; data-filter picks the tab
            const from = ["home", "earn", "profile"].includes(currentView) ? currentView : "profile";
            document.querySelector("#screen-history .page-head [data-open]").dataset.open = from;
            NAV_OF.history = from;
            histFilter = nav.dataset.filter || "all";
            document.querySelectorAll("#hist-filters .tab").forEach(x => x.classList.toggle("active", x.dataset.filter === histFilter));
        }
        showView(nav.dataset.open);
        if (nav.dataset.hint) showNotification(nav.dataset.hint, "info");
        if (nav.dataset.focus) focusOn(nav.dataset.focus);
        return;
    }
    const tab = e.target.closest(".tab[data-tab]");
    if (tab) {
        const scope = tab.closest(".info-tabs") || tab.closest(".view");
        tab.parentElement.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === tab));
        scope.querySelectorAll("[data-panel]").forEach(p => p.classList.toggle("active", p.dataset.panel === tab.dataset.tab));
        if (scope.id === "screen-lobby") placeLobbyShared();
    }
});

// "Check update" buttons: after opening the screen, scroll to the changed element, outline it
// for 5s, then let it auto-close (the CSS animation itself fades the ring back out).
function focusOn(selector) {
    setTimeout(() => {
        const el = document.querySelector(".view.active " + selector);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 5000);
    }, 450);
}

// Name + tickets are needed by both tabs, so the one shared block is moved into whichever
// panel is open: each tab then shows a single card with only its own fields.
function placeLobbyShared() {
    const panel = document.querySelector("#screen-lobby .tab-panel.active");
    const shared = $("lobby-shared");
    if (panel && shared && shared.parentElement !== panel) panel.prepend(shared);
}
function setLobbyTab(name) {
    const scope = $("screen-lobby");
    scope.querySelectorAll("#lobby-tabs .tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
    scope.querySelectorAll("[data-panel]").forEach(p => p.classList.toggle("active", p.dataset.panel === name));
    placeLobbyShared();
}

/* ================= WELCOME / SIGN OUT / HOW TO ================= */
const doSignOut = () => Coins.signOut().then(() => location.reload());
["profile-signout"].forEach(id => { $(id).onclick = doSignOut; });

const delPopup = $("delete-popup");
$("profile-delete").onclick = () => delPopup.classList.add("active");
$("admin-backup-import").onclick = () => $("admin-backup-file").click();
$("admin-backup-file").onchange = async e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (!confirm("Restore this backup into the connected Firebase project? Existing documents with the same IDs will be overwritten.")) return;
    const btn = $("admin-backup-import");
    btn.disabled = true;
    try {
        const n = await Coins.importData(JSON.parse(await f.text()), (done, total) => { btn.lastChild.textContent = "Importing " + done + "/" + total; });
        showNotification("Imported " + n + " documents", "success");
        autoRepairTimes(true);
    } catch (err) { showNotification(err.message || "Import failed", "error"); }
    btn.lastChild.textContent = "Import data";
    btn.disabled = false;
};
$("admin-backup-export").onclick = async () => {
    const btn = $("admin-backup-export");
    btn.disabled = true;
    try {
        const data = await Coins.exportData();
        const json = JSON.stringify(data, function (k, v) { const raw = this[k]; return (raw && typeof raw.toDate === "function") ? { __ts: raw.toDate().toISOString() } : v; }, 2);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        a.download = "housie-data-" + new Date().toISOString().slice(0, 10) + ".json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        showNotification("Data exported", "success");
    } catch (err) { showNotification(err.message || "Export failed", "error"); }
    btn.disabled = false;
};
// Old/wrongly-formatted history times are fixed automatically (no button): once per device when the admin
// dashboard first loads, and again right after every data import.
let timesRepairBusy = false;
async function autoRepairTimes(force) {
    if (timesRepairBusy || !Coins.isAdmin()) return;
    if (!force && store.get("timesRepaired.v1", false)) return;
    timesRepairBusy = true;
    try {
        const n = await Coins.adminRepairTimestamps();
        store.set("timesRepaired.v1", true);
        if (n) { adminTxCache = {}; if (typeof loadAdmin === "function") loadAdmin(true); }
    } catch (e) { /* retried on the next load */ }
    timesRepairBusy = false;
}
$("delete-cancel").onclick = () => delPopup.classList.remove("active");
$("delete-confirm").onclick = async e => {
    const btn = e.currentTarget, cancel = $("delete-cancel");
    btn.disabled = cancel.disabled = true;
    btn.textContent = "Deleting...";
    try {
        const delUid = Coins.user && Coins.user.uid;
        await Coins.deleteAccount();
        if (delUid) await Persist.purge(delUid);
        location.reload();
    } catch (err) {
        showNotification(err.message || "Could not delete the account.", "error");
        btn.disabled = cancel.disabled = false;
        btn.textContent = "Delete";
        delPopup.classList.remove("active");
    }
};
/* ================= HOME ================= */
let bonusPrompted = false;
async function renderHome() {
    const u = Coins.user; if (!u) return;
    const name = myDisplayName();
    const h = new Date().getHours();
    $("home-greeting").textContent = h < 12 ? "Good morning" : h < 16 ? "Good afternoon" : "Good evening";
    $("home-name").textContent = name;
    setAvatar($("home-avatar"), name);

    Coins.getActiveGame().then(info => {
        const on = !!(info && info.gameId) && currentView === "home";
        $("resume-card").classList.toggle("hidden", !on);
        if (on) $("resume-room").textContent = info.roomId || roomOf(info.gameId);
    }).catch(() => { });

    try {
        const L = await getLedger();
        const st = computeStats(L), c = taskContext(L), b = bonusState(L);
        paintBonus($("bonus-text"), $("streak-dots"), $("btn-claim-bonus"), b);
        if (b.claimedToday) store.set("bonusPrompt", dayKey(new Date()));
        const picks = [["daily", "play10_v4"], ["daily", "win15_v4"], ["daily", "jaldi5_v4"], ["weekly", "w_play70_v4"]]
            .map(([k, id]) => taskView(k, TASKS[k].find(t => t.id === id), c));
        $("home-tasks").innerHTML = picks.map(v => `
            <div class="task-mini"><b>${esc(v.t.title)}</b>
                <div class="progress"><span style="width:${v.pct}%"></span></div>
                <small>${v.progress}/${v.t.target} · 🪙 ${v.t.reward.toLocaleString("en-US")}${v.claimed ? " · claimed" : ""}</small></div>`).join("");

        const rows = sessionsFrom(L).slice(0, 5);
        $("recent-sessions").innerHTML = rows.length ? rows.map(s => `
            <div class="row"><div><b>${esc(roomLabel(s.gameId))}</b>
                <small>${esc(fmtDate(s.time))} · Fee ${s.fee}${s.won.length ? " · Won " + esc(s.won.join(", ")) : ""}</small></div>
                <b class="${s.net >= 0 ? "pos" : "neg"}">${signed(s.net)}</b></div>`).join("")
            : '<p class="empty">No games yet. Create or join a room to start.</p>';
    } catch (e) { /* offline: keep placeholders */ }
}
const esc = s => escapeHTML(s);

let bonusTimer = null, bonusClaimed = false;
function leftToMidnight() {
    const n = new Date();
    n.setHours(24, 0, 0, 0);
    return Math.max(0, Math.floor((n - new Date()) / 1000));
}
function updateBonusLines() {
    const left = leftToMidnight();
    const t = `${pad(Math.floor(left / 3600))}h ${pad(Math.floor(left % 3600 / 60))}m ${pad(left % 60)}s`;
    document.querySelectorAll(".bonus-line").forEach(el => {
        el.textContent = bonusClaimed ? `Next bonus in ${t}` : `Get ${BONUS_DAYS[0]} coins every day`;
        if (el.dataset.timerOnly !== undefined) el.classList.toggle("hidden", !bonusClaimed);
    });
    return left;
}
function syncBonusTimer(claimed) {
    bonusClaimed = claimed;
    if (bonusTimer) { clearInterval(bonusTimer); bonusTimer = null; }
    updateBonusLines();
    if (!claimed) return;
    bonusTimer = setInterval(() => {
        if (updateBonusLines() > 0) return;
        clearInterval(bonusTimer);
        bonusTimer = null;
        if (VIEW_LOADERS[currentView]) VIEW_LOADERS[currentView]();
    }, 1000);
}

function paintBonus(textEl, dotsEl, btn, b) {
    textEl.textContent = b.claimedToday
        ? `Claimed today. Streak: ${b.streak} day${b.streak === 1 ? "" : "s"}. Come back tomorrow.`
        : `Claim ${b.amount} coins · Day ${b.streak % 7 + 1} of 7`;
    dotsEl.innerHTML = BONUS_DAYS.map((_, i) =>
        `<span class="dot${i < b.done ? " done" : ""}${!b.claimedToday && i === b.done ? " today" : ""}"></span>`).join("");
    btn.disabled = b.claimedToday;
    btn.innerHTML = b.claimedToday ? '<span class="tick">✓</span>Claimed' : "Claim";
    syncBonusTimer(b.claimedToday);
}

// "Claiming" state for the Claim buttons (daily bonus + task rewards): spinner and text while it saves
function claimingOn(btn) {
    if (!btn || btn._origHtml !== undefined) return;
    btn._origHtml = btn.innerHTML;
    btn.classList.add("loading");
    btn.innerHTML = '<span class="spinner"></span>Claiming';
}
function claimingOff(btn) {
    if (!btn || btn._origHtml === undefined) return;
    btn.classList.remove("loading");
    btn.innerHTML = btn._origHtml;
    btn._origHtml = undefined;
}

const rewardBusy = new Set();
async function reward(btn, id, type, amount, label, extra) {
    if (rewardBusy.has(id)) return; // ignore double taps while this reward is being claimed
    rewardBusy.add(id);
    const isClaim = !!btn && (btn._origHtml !== undefined || /^\s*Claim\s*$/.test(btn.textContent));
    if (isClaim) claimingOn(btn);
    if (btn) btn.disabled = true;
    try {
        await Coins.grant(id, type, amount, extra);
        showNotification(`${label}: +${Number(amount).toLocaleString("en-US")} coins`, "success");
    } catch (e) {
        showNotification(e.message || "Could not claim.", "error");
    }
    if (isClaim) claimingOff(btn);
    rewardBusy.delete(id);
    if (VIEW_LOADERS[currentView]) VIEW_LOADERS[currentView]();
}
async function claimDaily(btn) {
    if (btn && btn._origHtml !== undefined) return; // already claiming
    claimingOn(btn);
    if (btn) btn.disabled = true; // stop double taps while the ledger loads
    let b;
    try {
        const L = await getLedger(true);
        b = bonusState(L);
    } catch (e) {
        claimingOff(btn);
        if (btn) btn.disabled = false;
        showNotification(e.message || "Could not claim.", "error");
        return;
    }
    if (b.claimedToday) { claimingOff(btn); return; }
    if (btn) btn.disabled = false; // reward() disables it again
    reward(btn, "daily_" + dayKey(new Date()), "daily", b.amount, "Daily bonus");
}
$("btn-claim-bonus").onclick = e => claimDaily(e.currentTarget);
$("earn-claim").onclick = e => claimDaily(e.currentTarget);
$("btn-resume").onclick = () => attemptResume(Coins.user);

/* ================= LOBBY (Create | Join) ================= */
function updateCost() {
    const price = Number($("ticket-price").value) || 0;
    const tickets = Number($("ticket-count").value) || 1;
    const cost = price * tickets;
    $("cost-total").textContent = cost;
    const bal = Coins.balance;
    const low = bal !== null && cost > bal;
    $("low-balance").classList.toggle("hidden", !low);
    if (low) $("low-need").textContent = cost - bal;
    document.querySelectorAll("#price-chips .chip").forEach(c => c.classList.toggle("active", Number(c.dataset.price) === price));
}
function initLobby() {
    $("username").value = $("username").value || myDisplayName();
    updateCost();
}
function setTickets(n) {
    $("ticket-count").value = Math.min(4, Math.max(1, n));
    updateCost();
}
$("tk-minus").onclick = () => setTickets(Number($("ticket-count").value) - 1);
$("tk-plus").onclick = () => setTickets(Number($("ticket-count").value) + 1);
$("ticket-price").addEventListener("input", updateCost);
$("price-chips").addEventListener("click", e => {
    const c = e.target.closest(".chip"); if (!c) return;
    $("ticket-price").value = c.dataset.price;
    updateCost();
});

let previewTimer = null;
$("join-id").addEventListener("input", () => {
    clearTimeout(previewTimer);
    const code = $("join-id").value.trim();
    $("room-preview").classList.add("hidden");
    if (code.length < 4) return;
    previewTimer = setTimeout(() => {
        Coins.findGame(code).then(async g => {
            if (!g || g.status === "finished" || $("join-id").value.trim() !== code) return;
            $("rp-price").textContent = "🪙 " + g.ticketPrice;
            $("rp-players").textContent = g.playerCount + (g.status === "open" ? "" : " · started");
            $("rp-host").textContent = (await Coins.hostName(g.id)) || "--";
            $("room-preview").classList.remove("hidden");
        }).catch(() => { });
    }, 400);
});

/* ================= PLAY WITH DEVELOPER (home card + lobby) ================= */
function paintDevWidgets() {
    const card = $("home-dev-card");
    if (card) {
        card.classList.toggle("hidden", !devInfo);
        if (devInfo) {
            $("dev-card-name").textContent = devInfo.name;
            $("dev-card-coins").textContent = devInfo.coins;
            setAvatar($("dev-card-avatar"), devInfo.name);
            card.classList.toggle("busy", !!devInfo.busy);
            const cta = $("dev-card-cta");
            if (cta) {
                cta.textContent = devInfo.busy ? "Busy right now" : "";
                if (cta.parentElement) cta.parentElement.classList.toggle("hidden", !devInfo.busy);
            }
        }
    }
    if (currentView === "devlobby") {
        if (devInfo) {
            $("devlobby-name").textContent = devInfo.name;
            $("devlobby-dev-coins").textContent = devInfo.coins;
            setAvatar($("devlobby-avatar"), devInfo.name);
        }
        const myName2 = myDisplayName();
        $("devlobby-my-name").textContent = myName2;
        setAvatar($("devlobby-my-avatar"), myName2);
        updateDevPot();
    }
}
function updateDevPot() {
    $("dev-pot-mine").textContent = devStake;
    $("dev-pot-dev").textContent = devStake;
    $("dev-pot-total").textContent = devStake * 2;
    const bal = Coins.balance;
    const low = bal !== null && devStake > bal;
    $("dev-low-balance").classList.toggle("hidden", !low);
    if (low) $("dev-low-need").textContent = devStake - bal;
    document.querySelectorAll("#dev-stake-chips .chip").forEach(c => c.classList.toggle("active", Number(c.dataset.stake) === devStake));
    const busy = !!(devInfo && devInfo.busy);
    $("dev-busy-notice").classList.toggle("hidden", !busy);
    $("btn-dev-start").disabled = low || busy || !devInfo;
}
function renderDevLobby() {
    refreshDevInfo();
    $("devlobby-tickets").value = devWantedTickets;
    paintDevWidgets();
}
function setDevTickets(n) {
    devWantedTickets = Math.min(4, Math.max(1, n));
    $("devlobby-tickets").value = devWantedTickets;
}
$("devtk-minus").onclick = () => setDevTickets(devWantedTickets - 1);
$("devtk-plus").onclick = () => setDevTickets(devWantedTickets + 1);
$("dev-stake-chips").addEventListener("click", e => {
    const c = e.target.closest(".chip"); if (!c) return;
    devStake = Number(c.dataset.stake);
    updateDevPot();
});

let devStarting = false;
$("btn-dev-start").onclick = () => {
    if (devStarting) return;
    if (!window.Coins || !Coins.enabled || !Coins.user) { showNotification("Please sign in first"); return; }
    if (!devInfo) { showNotification("The developer isn't available right now.", "error"); return; }
    if (Coins.balance !== null && devStake > Coins.balance) { showNotification(`Not enough coins. You have ${Coins.balance}, need ${devStake}.`); return; }

    devStarting = true;
    const btn = $("btn-dev-start");
    btn.disabled = true;
    btn.classList.add("loading");
    btn.innerHTML = `<span class="spinner"></span>Starting`;
    const startedAt = Date.now();
    const devUid = devInfo.uid, devName = devInfo.name;
    const oppName = myDisplayName();
    myName = oppName;
    const oppTicketsData = generateTambolaSet(devWantedTickets, myFavorites());
    const devTicketsData = generateTambolaSet(devWantedTickets);

    withTimeout(Coins.devStartGame(devUid, Coins.user.uid, devStake, devWantedTickets, oppName, devName, oppTicketsData, devTicketsData),
        15000, "Could not start the game. Check your network and try again.")
        .then(({ gid }) => {
            setTimeout(() => {
                devStarting = false;
                btn.disabled = false; btn.classList.remove("loading"); btn.textContent = "Start Game";
                isHost = true;
                isDevGame = true;
                ticketCount = devWantedTickets;
                gameId = gid;
                myRoomId = null;
                ticketPrice = devStake;
                ticketsByUid = {};
                ticketsByUid[devUid] = devTicketsData;
                enterArena({ ticketsData: oppTicketsData, marked: {}, claimedTickets: [], claims: [] });
            }, remainingLoadTime(startedAt));
        })
        .catch(err => {
            setTimeout(() => {
                devStarting = false;
                btn.disabled = false; btn.classList.remove("loading"); btn.textContent = "Start Game";
                showNotification(err.message || "Could not start the game.", "error");
            }, remainingLoadTime(startedAt));
        });
};

/* ================= EARN ================= */
let wheelTimer = null;
function stopWheelCountdown() {
    if (wheelTimer) { clearInterval(wheelTimer); wheelTimer = null; }
}
function startWheelCountdown() {
    stopWheelCountdown();
    const tick = () => {
        const next = new Date();
        next.setHours(24, 0, 0, 0);
        const left = Math.max(0, Math.floor((next - new Date()) / 1000));
        if (left <= 0) {
            stopWheelCountdown();
            if (currentView === "earn") renderEarn();
            return;
        }
        $("wheel-text").textContent = `Next spin in ${pad(Math.floor(left / 3600))}h ${pad(Math.floor(left % 3600 / 60))}m ${pad(left % 60)}s`;
    };
    tick();
    wheelTimer = setInterval(tick, 1000);
}
async function renderEarn() {
    shownPeriods = { daily: periodOf("daily"), weekly: periodOf("weekly"), monthly: periodOf("monthly") };
    startTaskCountdown();
    try {
        const L = await getLedger();
        const c = taskContext(L), b = bonusState(L);
        paintBonus($("earn-streak-text"), $("earn-streak-dots"), $("earn-claim"), b);

        const today = dayKey(new Date());
        const refillDone = L.some(e => e.id === "refill_" + today);
        $("refill-card").classList.toggle("hidden", !(Coins.balance !== null && Coins.balance < MIN_TICKET_PRICE && !refillDone));

        const spun = L.some(e => e.id === "wheel_" + today);
        $("btn-spin").disabled = spun;
        $("btn-spin").innerHTML = spun ? '<span class="tick">✓</span>Spinned' : "Spin";
        if (spun) startWheelCountdown();
        else { stopWheelCountdown(); $("wheel-text").textContent = "One spin a day. Win 100 to 500 coins."; }

        ["daily", "weekly", "monthly", "once"].forEach(kind => {
            // ready to claim first, then in progress, then already claimed
            const views = TASKS[kind].map((t, i) => ({ t, i, v: taskView(kind, t, c) }));
            const rank = x => (x.v.claimed ? 2 : x.v.done ? 0 : 1);
            views.sort((x, y) => rank(x) - rank(y) || x.i - y.i);
            $("tasks-" + kind).innerHTML = views.map(({ t, v }) => {
                const state = v.claimed ? "done" : v.done ? "ready" : "";
                const side = v.claimed ? '<small class="task-count">✓ Claimed</small>'
                    : v.done ? `<button class="btn-primary btn-sm" data-task="${kind}:${t.id}">Claim</button>`
                        : `<small class="task-count">${v.progress}/${t.target}</small>`;
                return `<div class="task-row ${state}">
                    <div class="task-info"><b>${esc(t.title)}</b>
                        <div class="progress"><span style="width:${v.pct}%"></span></div></div>
                    <div class="task-side"><span class="reward">🪙 ${t.reward.toLocaleString("en-US")}</span>${side}</div></div>`;
            }).join("");
            if (kind === "once") return;
            // the tab shows how many tasks can be claimed right now
            const ready = views.filter(x => x.v.done && !x.v.claimed).length;
            document.querySelector(`[data-count="${kind}"]`).textContent = ready || "";
        });
    } catch (e) { }
}
let taskTimer = null, shownPeriods = {};
// days are left out for the daily set (it never has more than 24h to go)
const fmtLeft = (sec, withDays = true) => {
    const d = withDays ? Math.floor(sec / 86400) : 0;
    return `${withDays ? d + "d " : ""}${pad(Math.floor((sec - d * 86400) / 3600))}h ${pad(Math.floor(sec % 3600 / 60))}m ${pad(sec % 60)}s`;
};
function startTaskCountdown() {
    if (taskTimer) { clearInterval(taskTimer); taskTimer = null; }
    const tick = () => {
        if (currentView !== "earn") { clearInterval(taskTimer); taskTimer = null; return; }
        // a set rolled over (new day / Monday / 1st of the month): reload the tasks fresh
        if (["daily", "weekly", "monthly"].some(k => periodOf(k) !== shownPeriods[k])) {
            clearInterval(taskTimer); taskTimer = null; renderEarn(); updateTaskBadge(); return;
        }
        document.querySelectorAll(".set-reset").forEach(el => {
            el.textContent = fmtLeft(Math.max(0, Math.floor((nextReset(el.dataset.set) - new Date()) / 1000)), el.dataset.set !== "daily");
        });
    };
    tick();
    taskTimer = setInterval(tick, 1000);
}
$("screen-earn").addEventListener("click", e => {
    const b = e.target.closest("[data-task]"); if (!b) return;
    const [kind, id] = b.dataset.task.split(":");
    const t = TASKS[kind].find(x => x.id === id);
    reward(b, `task_${periodOf(kind)}_${id}`, "task", t.reward, t.title, { task: id });
});
$("btn-spin").onclick = e => {
    const amount = WHEEL_PRIZES[Math.floor(Math.random() * WHEEL_PRIZES.length)];
    reward(e.currentTarget, "wheel_" + dayKey(new Date()), "wheel", amount, "Try your luck");
};
$("btn-refill").onclick = e => reward(e.currentTarget, "refill_" + dayKey(new Date()), "refill", 30, "Free refill");

/* ================= PROFILE ================= */
const THEMES = ["indigo", "emerald", "amber", "rose", "ocean", "violet", "lime", "orange"];
const randomThemeOn = () => store.get("randomTheme", true) !== false; // on by default
// Random mode: every ticket gets its own colour. The pick is stable for a given room (so a
// refresh keeps the same colours) and steps by 3 through the 8 themes, so up to 4 tickets never match.
function themeForTicket(i) {
    if (!randomThemeOn()) return document.body.dataset.theme || "indigo";
    const seed = String(gameId || "").split("").reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
    return THEMES[(seed + (i - 1) * 3) % THEMES.length];
}
function applyTicketThemes() {
    document.querySelectorAll(".ticket-card").forEach(c => { c.dataset.tt = themeForTicket(Number(c.dataset.ticket) || 1); });
}
function applyTheme(t) {
    document.body.dataset.theme = THEMES.includes(t) ? t : "indigo";
    const rnd = randomThemeOn();
    document.querySelectorAll("#theme-chips .chip").forEach(c => c.classList.toggle("active", !rnd && c.dataset.theme === document.body.dataset.theme));
    const sw = $("theme-random");
    if (sw) sw.checked = rnd;
    applyTicketThemes();
}
applyTheme(store.get("theme", "indigo"));
// settings come from Firestore after sign-in: apply them (theme, auto-draw speed, badges) once loaded
function applyCloudSettings() {
    applyTheme(store.get("theme", "indigo"));
    const v = Number(store.get("autoSec", AUTO_DEFAULT));
    autoSec = AUTO_SPEEDS.includes(v) ? v : AUTO_DEFAULT;
    paintAutoUI();
    refreshUpdateBadges();
    paintNewFeatures();
}

async function renderProfile() {
    const u = Coins.user; if (!u) return;
    const name = myDisplayName();
    setAvatar($("profile-avatar"), name);
    $("profile-name").value = name;
    $("profile-email").textContent = u.email || "";
    $("profile-admin").classList.toggle("hidden", !Coins.isAdmin());
    applyTheme(store.get("theme", "indigo"));
    paintFav();
}
// No Save button: the name saves as soon as the field is left (or Enter is pressed).
function saveProfile() {
    const nameEl = $("profile-name");
    const name = capitalizeName(nameEl.value.trim());
    if (!name) { nameEl.value = myDisplayName(); showNotification("Please enter your name"); return; }
    if (name === myDisplayName()) { nameEl.value = name; return; }
    store.set("name", name);
    nameEl.value = name;
    $("username").value = name;
    setAvatar($("profile-avatar"), name);
    showNotification("Profile saved", "success");
}
$("profile-name").addEventListener("change", saveProfile);
$("profile-name").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
$("profile-edit").onclick = () => {
    const n = $("profile-name");
    n.readOnly = false;
    n.focus();
    n.setSelectionRange(n.value.length, n.value.length);
};
$("profile-name").addEventListener("blur", () => { $("profile-name").readOnly = true; });
$("theme-chips").addEventListener("click", e => {
    const c = e.target.closest(".chip"); if (!c) return;
    store.set("theme", c.dataset.theme);
    store.set("randomTheme", false); // picking a colour switches random mode off
    applyTheme(c.dataset.theme);
});
$("theme-random").addEventListener("change", e => {
    store.set("randomTheme", e.target.checked);
    applyTheme(store.get("theme", "indigo"));
});
/* ================= FAVORITE NUMBERS (Profile) ================= */
let favDraft = [], favEditing = false;
const FAV_MAX = 10;   // how many favorite numbers a player can keep (all of them go on every ticket)
const favPad = n => String(n).padStart(2, "0");
const favCol = n => Math.min(8, Math.floor(n / 10));
const favColName = c => (c === 0 ? "1-9" : c === 8 ? "80-90" : c * 10 + "-" + (c * 10 + 9));
function paintFav() {
    if (!$("fav-card")) return;
    const saved = ((window.Coins && Coins.favorites) || []).slice().sort((a, b) => a - b);
    const has = saved.length > 0;
    $("fav-view").classList.toggle("hidden", favEditing);
    $("fav-editor").classList.toggle("hidden", !favEditing);
    if (!favEditing) {
        $("fav-chips").innerHTML = has ? saved.map(n => `<span class="fav-chip">${favPad(n)}</span>`).join("") : "";
        $("fav-count").textContent = saved.length + "/" + FAV_MAX + " Selected";
        $("fav-empty").classList.toggle("hidden", has);
        $("fav-note").classList.toggle("hidden", !has);
        $("fav-choose").classList.toggle("hidden", has);
        $("fav-edit").classList.toggle("hidden", !has);
        return;
    }
    document.querySelectorAll("#fav-grid .fav-num").forEach(b => b.classList.toggle("sel", favDraft.includes(Number(b.dataset.n))));
    $("fav-live").textContent = favDraft.length + "/" + FAV_MAX + " Selected";
    $("fav-done").classList.toggle("hidden", favDraft.length !== FAV_MAX);
    $("fav-save").disabled = favDraft.length < 1;
}
function favOpen(list) { favDraft = list.slice(); favEditing = true; paintFav(); }
(function initFav() {
    const grid = $("fav-grid");
    if (!grid) return;
    grid.innerHTML = Array.from({ length: 90 }, (_, i) => `<button type="button" class="fav-num" data-n="${i + 1}">${i + 1}</button>`).join("");
    grid.addEventListener("click", e => {
        const b = e.target.closest(".fav-num"); if (!b) return;
        const n = Number(b.dataset.n);
        if (favDraft.includes(n)) favDraft = favDraft.filter(x => x !== n);
        else if (favDraft.length >= FAV_MAX) { showNotification("You can pick only " + FAV_MAX + " numbers", "error"); return; }
        else if (favDraft.filter(x => favCol(x) === favCol(n)).length >= 3) { showNotification("Max 3 numbers from " + favColName(favCol(n)), "error"); return; }
        else favDraft.push(n);
        paintFav();
    });
    $("fav-edit").onclick = () => favOpen((Coins.favorites || []).slice());
    $("fav-choose").onclick = () => favOpen([]);
    $("fav-cancel").onclick = () => { favEditing = false; favDraft = []; paintFav(); };
    $("fav-save").onclick = async () => {
        if (favDraft.length < 1 || favDraft.length > FAV_MAX || new Set(favDraft).size !== favDraft.length) return;
        const btn = $("fav-save");
        btn.disabled = true;
        try {
            await Coins.saveFavorites(favDraft);
            favEditing = false; favDraft = [];
            showNotification("Favorite numbers saved", "success");
        } catch (err) { showNotification(err.message || "Could not save", "error"); }
        paintFav();
    };
    if (window.Coins && Coins.enabled) Coins.onFavorites = () => { if (currentView === "favorites") paintFav(); };
})();

/* ================= STATS ================= */
let statsRange = "7";
function lineChart(el, pts) {
    if (pts.length < 2) { el.innerHTML = '<p class="empty">Not enough data yet.</p>'; return; }
    const W = 320, H = 150, pl = 36, pr = 8, pt = 10, pb = 22;
    const vs = pts.map(p => p.v);
    let min = Math.min(...vs), max = Math.max(...vs);
    if (min === max) { min -= 1; max += 1; }
    const x = i => pl + (W - pl - pr) * i / (pts.length - 1);
    const y = v => pt + (H - pt - pb) * (1 - (v - min) / (max - min));
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
        <line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(max)}" y2="${y(max)}"/><line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(min)}" y2="${y(min)}"/>
        <text x="${pl - 4}" y="${y(max) + 3}" text-anchor="end">${max}</text><text x="${pl - 4}" y="${y(min) + 3}" text-anchor="end">${min}</text>
        <path class="area" d="${line} L${x(pts.length - 1)} ${H - pb} L${x(0)} ${H - pb}Z"/><path class="line" d="${line}"/>
        <text x="${pl}" y="${H - 6}">${esc(pts[0].label)}</text><text x="${W - pr}" y="${H - 6}" text-anchor="end">${esc(pts[pts.length - 1].label)}</text></svg>`;
}
function barChart(el, items) {
    const W = 320, H = 150, pb = 24, pt = 14, gap = 14;
    const max = Math.max(1, ...items.map(i => i.v));
    const bw = (W - gap * (items.length + 1)) / items.length;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">` + items.map((it, i) => {
        const h = (H - pb - pt) * it.v / max, bx = gap + i * (bw + gap);
        return `<rect class="bar" x="${bx}" y="${H - pb - h}" width="${bw}" height="${Math.max(h, 2)}" rx="4"/>
            <text x="${bx + bw / 2}" y="${H - pb - h - 4}" text-anchor="middle">${it.v}</text>
            <text x="${bx + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(it.n)}</text>`;
    }).join("") + "</svg>";
}
function coinSeries(L, range) {
    const asc = [...L].sort((a, b) => timeOf(a) - timeOf(b));
    if (!asc.length) return [];
    const byDay = new Map();
    let run = 0;
    asc.forEach(e => { run += e.amount || 0; byDay.set(dayKey(timeOf(e)), run); });
    const end = new Date(); end.setHours(0, 0, 0, 0);
    const start = new Date(range === "all" ? timeOf(asc[0]) : end);
    start.setHours(0, 0, 0, 0);
    if (range !== "all") start.setDate(start.getDate() - (Number(range) - 1));
    const keys = [...byDay.keys()].sort();
    let last = 0, k = 0;
    const out = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const key = dayKey(d);
        while (k < keys.length && keys[k] <= key) { last = byDay.get(keys[k]); k++; }
        out.push({ label: d.toLocaleDateString([], { day: "numeric", month: "short" }), v: last });
    }
    if (out.length > 60) { const step = Math.ceil(out.length / 60); return out.filter((_, i) => i % step === 0 || i === out.length - 1); }
    return out;
}
async function renderStats() {
    try {
        const L = await getLedger();
        const st = computeStats(L);
        $("st-games").textContent = st.games;
        $("st-wins").textContent = st.winGames;
        $("st-winrate").textContent = st.winRate + "%";
        $("st-hosted").textContent = L.filter(e => e.type === "entry" && e.host).length;
        $("st-net").textContent = signed(st.net);
        lineChart($("chart-coins"), coinSeries(L, statsRange));
        barChart($("chart-prizes"), PRIZE_ORDER.map(k => ({ n: CLAIM_SHORT[k].replace(" Line", ""), v: st.winsList.filter(w => w.prize === k).length })));

        $("st-insight").textContent = st.games
            ? `You have won prizes in ${st.winGames} of ${st.games} games and earned ${st.coinsWon} coins from prizes.`
            : "Play a few games to see insights here.";
    } catch (e) { }
}
$("range-tabs").addEventListener("click", e => {
    const t = e.target.closest(".tab[data-range]"); if (!t) return;
    statsRange = t.dataset.range;
    $("range-tabs").querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
    renderStats();
});

/* ================= HISTORY ================= */
let histFilter = "all";
// History comes from the local copy of the coin history (Coins.localLedger): zero Firestore reads.
async function getHistory() { return Coins.localLedger(); }
async function renderHistory() {
    const list = $("history-list");
    try {
        if (window.Coins && Coins.syncLedger) Coins.syncLedger();   // fetch anything new; the list redraws when it arrives
        const L = await getHistory();
        const taskTypes = ["task", "daily", "wheel", "refill", "bonus"];
        const isDevEntry = e => e.type === "deventry" || e.type === "devrefund" || (e.gameId && String(e.gameId).startsWith("dev-"));
        const rows = L.filter(e => histFilter === "all" || (histFilter === "prize" && e.type === "win") ||
            (histFilter === "entry" && e.type === "entry") || (histFilter === "task" && taskTypes.includes(e.type)) ||
            (histFilter === "shared" && (e.type === "send" || e.type === "gift")) ||
            (histFilter === "dev" && isDevEntry(e)));
        list.innerHTML = rows.length ? rows.map(t => {
            const room = t.gameId ? " · " + esc(roomLabel(t.gameId)) : "";
            return `<div class="row hist-row"><div><div>${esc(Coins.describe(t))}</div><small>${esc(fmtDate(timeOf(t)))}${room}</small></div>
                <b class="${t.amount >= 0 ? "pos" : "neg"}">${signed(t.amount)}</b></div>`;
        }).join("") : '<p class="empty">Nothing here yet.</p>';
    } catch (e) { list.innerHTML = '<p class="empty">Could not load history.</p>'; }
}
$("hist-filters").addEventListener("click", e => {
    const t = e.target.closest(".tab[data-filter]"); if (!t) return;
    histFilter = t.dataset.filter;
    $("hist-filters").querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
    renderHistory();
});

/* ================= SHARE COINS ================= */
async function renderShare() {
    const u = Coins.user; if (!u) return;
    $("share-to").value = "";
    $("share-amount").value = "";
    document.querySelectorAll("#share-amounts .chip").forEach(c => c.classList.remove("active"));
    $("share-code").textContent = "----";
    $("friends-panel").classList.add("hidden");
    $("friends-toggle").setAttribute("aria-expanded", "false");
    try { $("share-code").textContent = await Coins.myCode(); }
    catch (e) { showNotification(e.message || "Could not load your code", "error"); }
}
// "See your friends' codes": every player's name, 4-digit code and coins (up to 1000 players by coins). Players who never opened Share Coins have no
// code yet, so they are left out. Cached for 2 minutes so re-opening costs no extra reads.
let friendsCache = null, friendsAt = 0;
async function loadFriends(force) {
    const list = $("friends-list");
    if (!force && friendsCache && Date.now() - friendsAt < 2 * 60 * 1000) { paintFriends(); return; }
    list.innerHTML = '<p class="empty">Loading...</p>';
    try {
        const qs = await Coins.richest(1000);
        friendsCache = qs.docs
            .map(d => ({ id: d.id, name: d.data().alias || d.data().name, coins: d.data().coins, code: d.data().code }))
            .filter(u => /^[0-9]{4}$/.test(String(u.code || "")));
        friendsAt = Date.now();
        paintFriends();
    } catch (e) { list.innerHTML = '<p class="empty">Could not load players right now.</p>'; }
}
function paintFriends() {
    const myId = Coins.user && Coins.user.uid;
    // you first, everybody else by coins (highest first)
    const others = (friendsCache || []).filter(u => u.id !== myId).sort((a, b) => (Number(b.coins) || 0) - (Number(a.coins) || 0));
    let mine = (friendsCache || []).find(u => u.id === myId);
    const myCode = $("share-code").textContent;
    // safety net: if you are somehow missing from the list, still show your own row
    if (!mine && myId && /^[0-9]{4}$/.test(myCode)) mine = { id: myId, name: myDisplayName(), coins: Coins.balance, code: myCode };
    $("friends-list").innerHTML = (mine ? [mine] : []).concat(others).map((u, i) => {
        const me = u.id === myId;
        return `<div class="row friend-row${me ? " me" : ""}">
            <span class="fr-name">${i + 1}. ${esc(u.name || "Player")}${me ? " (you)" : ""}</span>
            <span class="fr-meta"><span class="fr-code">${esc(u.code)}</span><span class="fr-coins">🪙 ${Number(u.coins) || 0}</span></span></div>`;
    }).join("") || '<p class="empty">No friends\' codes yet.</p>';
}
$("friends-toggle").onclick = e => {
    const btn = e.currentTarget, panel = $("friends-panel");
    const open = panel.classList.toggle("hidden") === false;
    btn.setAttribute("aria-expanded", String(open));
    if (open) loadFriends(false);
};

$("share-copy").onclick = async () => {
    const c = $("share-code").textContent;
    if (!/^[0-9]{4}$/.test(c)) return;
    try { await navigator.clipboard.writeText(c); showNotification("Code copied", "success"); }
    catch (e) { showNotification("Could not copy. Select the code and copy it.", "error"); }
};
$("share-to").addEventListener("input", e => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4); });
$("share-amounts").addEventListener("click", e => {
    const c = e.target.closest(".chip[data-a]"); if (!c) return;
    $("share-amount").value = c.dataset.a;
    document.querySelectorAll("#share-amounts .chip").forEach(x => x.classList.toggle("active", x === c));
});
$("share-amount").addEventListener("input", () => document.querySelectorAll("#share-amounts .chip").forEach(x => x.classList.remove("active")));
$("share-send").onclick = async e => {
    const btn = e.currentTarget;
    const code = $("share-to").value.trim();
    const amt = Math.floor(Number($("share-amount").value) || 0);
    if (!/^[0-9]{4}$/.test(code)) { showNotification("Enter your friend's 4-digit code", "error"); return; }
    if (amt < 1) { showNotification("Enter an amount of 1 or more", "error"); return; }
    btn.disabled = true;
    try {
        const f = await Coins.findByCode(code);
        if (await askConfirm("Share coins", `Send ${amt} coins to code ${f.code}?`, "Send")) {
            await Coins.sendCoins(f.id, f.code, amt);
            showNotification(`Sent ${amt} coins to code ${f.code}`, "success");
            $("share-to").value = ""; $("share-amount").value = "";
            document.querySelectorAll("#share-amounts .chip").forEach(x => x.classList.remove("active"));
        }
    } catch (err) { showNotification(err.message || "Could not send coins", "error"); }
    btn.disabled = false;
};

/* ================= LEADERBOARD ================= */
let lbCache = null, lbAt = 0;
async function renderLeaderboard() {
    const list = $("lb-list");
    list.innerHTML = '<p class="empty">Loading...</p>';
    try {
        // the full list (up to 1000 players) is kept for 5 minutes, so opening the screen again costs no reads
        if (!lbCache || Date.now() - lbAt > 5 * 60 * 1000) {
            const qs = await Coins.richest(1000);
            lbCache = qs.docs.map(d => ({ id: d.id, name: d.data().name, coins: d.data().coins }));
            lbAt = Date.now();
        }
        list.innerHTML = lbCache.map((u, i) => {
            const me = Coins.user && u.id === Coins.user.uid;
            return `<div class="row"><div><b>${i + 1}. ${esc(u.name || "Player")}${me ? " (you)" : ""}</b></div><b class="pos">🪙 ${u.coins}</b></div>`;
        }).join("") || '<p class="empty">No players yet.</p>';
    } catch (e) { list.innerHTML = '<p class="empty">The leaderboard is not available yet.</p>'; }
}

// Updates screen: each update card has its own stable data-upd-id. Reading the list does NOT
// mark anything read any more - only that card's own "Mark as read" button does, and the choice
// is remembered (Firestore), so an update stays unread - and counted - until it is read.
function updatesReadSet() { return new Set(store.get("updatesRead", [])); }
function paintUpdateItem(item, readSet) {
    const id = item.dataset.updId;
    const btn = item.querySelector("[data-mark-read]");
    const isRead = readSet.has(id);
    item.classList.toggle("read", isRead);
    if (btn) {
        btn.disabled = isRead;
        btn.innerHTML = isRead ? '<span class="tick">✓</span>Read' : "Mark as read";
    }
}
function markUpdateRead(id) {
    if (!id) return;
    const set = updatesReadSet();
    if (set.has(id)) return;
    set.add(id);
    store.set("updatesRead", Array.from(set));
    const item = document.querySelector(`.upd-item[data-upd-id="${id}"]`);
    if (item) paintUpdateItem(item, set);
    refreshUpdateBadges();
}
// Numbered badges (not a blinking dot any more): Profile/Updates show how many updates are
// still unread, Earn shows how many tasks are ready to claim right now.
function refreshUpdateBadges() {
    const read = updatesReadSet();
    const items = document.querySelectorAll("#screen-updates .upd-item");
    const unread = Array.from(items).filter(el => !read.has(el.dataset.updId)).length;
    document.querySelectorAll('#bottom-nav [data-open="profile"] .nav-badge, #screen-profile [data-open="updates"] .dot-new')
        .forEach(el => { el.textContent = unread ? String(unread) : ""; });
}
refreshUpdateBadges();

function renderUpdates() {
    const read = updatesReadSet();
    document.querySelectorAll("#screen-updates .upd-item").forEach(item => paintUpdateItem(item, read));
    const nowD = new Date(), todayLabel = `${nowD.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][nowD.getMonth()]} ${nowD.getFullYear()}`;
    document.querySelectorAll("#screen-updates .upd-date").forEach(head => {
        const span = head.querySelector("span");
        if (span) {
            const day = span.textContent.replace(/^Today\s*·\s*/, "").trim();
            span.textContent = day === todayLabel ? "Today · " + day : day;   // "Today" follows the real date
        }
        const n = head.nextElementSibling ? head.nextElementSibling.querySelectorAll(".upd-item").length : 0;
        const c = head.querySelector(".upd-count");
        if (c) c.textContent = `${n} update${n === 1 ? "" : "s"}`;
    });
    refreshUpdateBadges();
}

// "New" marker on recently added features: any element with data-new="key" (a menu row, a button...) shows a
// colour-changing New tag until the player opens that feature (click, or its screen is shown). Remembered
// in Firestore ("newSeen"). To mark another feature, add data-new="its-key" to its button; to retire the
// marker, just delete the attribute.
function newSeenSet() { return new Set(store.get("newSeen", [])); }
function paintNewFeatures() {
    const seen = newSeenSet();
    document.querySelectorAll("[data-new]").forEach(el => {
        const isNew = !seen.has(el.dataset.new);
        const tag = el.querySelector(":scope > .new-badge");
        if (isNew && !tag) {
            const t = document.createElement("span");
            t.className = "new-badge"; t.textContent = "New";
            el.appendChild(t);
        } else if (!isNew && tag) tag.remove();
    });
}
function markFeatureSeen(key) {
    if (!key) return;
    const seen = newSeenSet();
    if (seen.has(key)) return;
    seen.add(key);
    store.set("newSeen", Array.from(seen));
    paintNewFeatures();
}
paintNewFeatures();

// Earn nav badge: how many tasks (daily + weekly + monthly) are finished and
// waiting to be claimed right now. One-time tasks are not counted: they have no visible
// list on the Earn screen, so counting them showed a number with nothing to claim. Refreshed whenever the coin balance changes (every
// claim, win or spend touches it) and on every screen switch, reusing the cached ledger.
async function updateTaskBadge() {
    const els = document.querySelectorAll('#bottom-nav [data-open="earn"] .nav-badge');
    if (!els.length) return;
    if (!window.Coins || !Coins.user) { els.forEach(el => { el.textContent = ""; }); return; }
    try {
        const L = await getLedger();
        const c = taskContext(L);
        const ready = ["daily", "weekly", "monthly"].reduce((sum, kind) =>
            sum + TASKS[kind].filter(t => { const v = taskView(kind, t, c); return v.done && !v.claimed; }).length, 0);
        els.forEach(el => { el.textContent = ready ? String(ready) : ""; });
    } catch (e) { /* offline: leave the badge as it was */ }
}

/* ================= ADMIN DASHBOARD (owner only) ================= */
let adminUsers = [], adminGames = [], adminUserFilter = "all", adminRoomFilter = "live", adminSel = null;
const fmtTime = t => { const d = toDateAny(t); return d ? d.toLocaleString() : "--"; };

var adminCounts = {};
const nf = n => (Number(n) || 0).toLocaleString("en-US");   // 1740000 -> 1,740,000
function paintAdminStats() {
    const total = adminUsers.reduce((s, u) => s + (Number(u.coins) || 0), 0);
    const n = adminUsers.length;
    // the loaded list can be shorter than the real user count (it loads 100 at a time): show the real count when known
    const all = Number.isFinite(adminCounts.users) ? adminCounts.users : n;
    const partial = all > n;
    // no presence flag is stored on user documents, so this means "currently inside a game room"
    const inGame = adminUsers.filter(u => u.activeGame).length;
    const played = Number.isFinite(adminCounts.finished) ? adminCounts.finished : adminGames.filter(g => g.status === "finished").length;
    const rows = [
        ["Total users", nf(all)], [partial ? `Coins held (richest ${n} of ${all})` : "Total users coins", "🪙 " + nf(total)],
        ["Users not in a game" + (partial ? " (loaded)" : ""), n - inGame], ["Users in a game" + (partial ? " (loaded)" : ""), inGame],
        ["Total games played", nf(played)]
    ];
    $("admin-stats").innerHTML = rows.map(r => `<div class="row"><div><b>${r[0]}</b></div><b class="pos">${r[1]}</b></div>`).join("");
}

function paintAdminUsers() {
    const q = $("admin-search").value.trim().toLowerCase();
    let rows = adminUsers.filter(u => !q || (String(u.name || "") + " " + String(u.alias || "")).toLowerCase().includes(q) || u.id.toLowerCase().includes(q));
    if (adminUserFilter === "ingame") rows = rows.filter(u => u.activeGame);
    if (adminUserFilter === "name") rows = rows.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    paintAdminBulk();
    $("admin-list").innerHTML = rows.map((u, i) =>
        `<button type="button" class="row" data-uid="${esc(u.id)}" style="width:100%;text-align:left"><div><b>${i + 1}. ${esc(u.alias || u.name || "Player")}</b>${(u.alias || u.activeGame) ? "<small>" + [u.alias ? esc(u.name || "Player") : "", u.activeGame ? "in a game" : ""].filter(Boolean).join(" · ") + "</small>" : ""}</div><b class="pos">🪙 ${nf(u.coins)}</b></button>`
    ).join("") || '<p class="empty">No users found.</p>';
    let more = $("admin-more");
    if (!more) {
        more = document.createElement("button");
        more.id = "admin-more"; more.type = "button"; more.className = "btn-outline signout-btn";
        more.onclick = loadMoreAdminUsers;
        $("admin-list").insertAdjacentElement("afterend", more);
    }
    more.textContent = "Load more users";
    more.classList.toggle("hidden", !Coins.usersHasMore);
    paintAdminFav();
}
// every loaded user's favorite numbers (read from the same user documents: no extra reads)
function paintAdminFav() {
    const box = $("admin-fav-list"); if (!box) return;
    const rows = adminUsers.slice().sort((a, b) => adminName(a).localeCompare(adminName(b)));
    box.innerHTML = rows.map(u => {
        const f = Array.isArray(u.favoriteNumbers) ? u.favoriteNumbers.map(Number).filter(n => n >= 1 && n <= 90).sort((a, b) => a - b) : [];
        return `<div class="row"><div><b>${esc(adminName(u))}</b></div><div class="admin-fav-nums">` +
            (f.length ? f.map(n => `<span class="fav-chip">${String(n).padStart(2, "0")}</span>`).join("") : '<small>Not set</small>') + `</div></div>`;
    }).join("") || '<p class="empty">No users found.</p>';
}
async function loadMoreAdminUsers() {
    const b = $("admin-more"); if (b) { b.disabled = true; b.textContent = "Loading..."; }
    try {
        const next = await Coins.adminUsers(true);
        const have = new Set(adminUsers.map(u => u.id));
        adminUsers = adminUsers.concat(next.filter(u => !have.has(u.id)).map(u => Object.assign(u, { _more: true })));
        paintAdminStats(); paintAdminUsers();
    } catch (e) { showNotification((e && e.message) || "Could not load more users", "error"); }
    if (b) b.disabled = false;
}

const ADMIN_STALE_MS = 6 * 3600 * 1000;   // an unfinished room older than this is treated as abandoned
const adminShownRooms = () => adminGames.filter(g => adminRoomFilter === "all" || g.status !== "finished");
const adminLiveRooms = () => adminGames.filter(g => g.status !== "finished");
function paintAdminBulk() {
    const set = (id, text, n) => { const b = $(id); if (!b) return; b.textContent = text; b.disabled = !n; };
    set("admin-rooms-endall", `End all live (${adminLiveRooms().length})`, adminLiveRooms().length);
    set("admin-rooms-cleanall", `Clean finished data (${adminGames.filter(g => g.status === "finished" && !g.archived).length})`, adminGames.some(g => g.status === "finished" && !g.archived));
    set("admin-rooms-delall", `Delete all${adminRoomFilter === "all" ? "" : " live"} (${adminShownRooms().length})`, adminShownRooms().length);
    const inGame = adminUsers.filter(u => u.activeGame).length;
    set("admin-users-releaseall", `Release all in-game (${inGame})`, inGame);
}
function paintAdminRooms() {
    paintAdminBulk();
    const rows = adminShownRooms();
    $("admin-rooms").innerHTML = rows.map(g =>
        `<div class="row" style="flex-wrap:wrap"><div><b>${g.mode === "dev" ? "Developer match · " + esc(adminUserName(g.oppUid, g.oppName)) + " vs " + esc(g.devName || "Developer") : "Room " + esc(g.roomCode)} · ${esc(g.status)}${g.cancelled ? " (cancelled)" : ""}</b><small>${esc(g.playerCount)} player(s) · 🪙${esc(g.ticketPrice)}/ticket · total coins 🪙${esc(g.pot)} · ${(g.calledNumbers || []).length} numbers · ${esc(fmtTime(g.createdAt))}</small></div>` +
        `<div class="btns"><button class="btn-outline btn-sm" data-room="players" data-gid="${esc(g.id)}">Players</button>` +
        (g.status !== "finished" ? `<button class="btn-outline btn-sm" data-room="end" data-gid="${esc(g.id)}">End</button>` : "") +
        `<button class="btn-danger btn-sm" data-room="del" data-gid="${esc(g.id)}">Delete</button></div>` +
        `<div class="room-detail hidden" id="rd-${esc(g.id)}" style="width:100%"></div></div>`
    ).join("") || '<p class="empty">No rooms.</p>';
    // the list was redrawn: bring back the open player views (their live data is already in memory, no reads)
    [...adminOpenRooms].forEach(gid => {
        if ($("rd-" + gid)) { $("rd-" + gid).classList.remove("hidden"); renderRoomDetail(gid); }
        else { adminOpenRooms.delete(gid); closeRoomWatch(gid); }
    });
}


/* ----- LIVE admin feeds: balances, in-game state, rooms, online status and histories update by themselves ----- */
var adminLive = null, adminPaintTimer = null, adminPaintWhat = {}, adminCodeTried = new Set();   // adminCodeTried: users already given a code this session
function adminPaintSoon(what) {
    adminPaintWhat[what] = true;
    if (adminPaintTimer) return;
    adminPaintTimer = setTimeout(() => {   // one redraw for a burst of changes
        adminPaintTimer = null;
        const w = adminPaintWhat; adminPaintWhat = {};
        paintAdminStats();
        if (w.users) {
            paintAdminUsers(); paintTxChips();
            if (adminSel && $("admin-user-popup").classList.contains("active")) {
                const u = adminUsers.find(x => x.id === adminSel.id);
                if (u) { adminSel = u; $("au-name").textContent = u.alias || u.name || "Player"; $("au-meta").textContent = `${u.id} · 🪙 ${nf(u.coins)}${u.activeGame ? " · in game " + (u.activeGame.roomId || "") : ""}`; }
            }
        }
        if (w.games) paintAdminRooms();
        paintAdminBulk();
        autoReleaseUsers().catch(() => { });
        const noCode = adminUsers.filter(u => !u.code && !adminCodeTried.has(u.id)).slice(0, 10);
        if (noCode.length) { noCode.forEach(u => adminCodeTried.add(u.id)); Coins.adminAssignCodes(noCode.map(u => u.id)).catch(() => { }); }
    }, 250);
}
function refreshAdminCounts() {
    return Coins.adminCounts().then(c => { adminCounts = c || {}; paintAdminStats(); }).catch(() => { });
}
function startAdminLive() {
    if (adminLive || !Coins.isAdmin()) return;
    adminLive = {
        users: Coins.watchAdminUsers(list => {
            const have = new Set(list.map(u => u.id));
            // users added with "Load more" stay in the list; the first 100 follow the live feed
            adminUsers = list.concat(adminUsers.filter(u => u._more && !have.has(u.id)));
            adminLoadedAt = Date.now();
            adminPaintSoon("users");
        }),
        games: Coins.watchAdminGames(list => {
            adminGames = list;
            adminLoadedAt = Date.now();
            adminPaintSoon("games");
        }),
        timer: setInterval(() => {   // labels age (online -> offline) and the totals refresh
            adminRoomWatch.forEach((w, gid) => renderRoomDetail(gid));
        }, 30000),
        counts: setInterval(refreshAdminCounts, 120000)
    };
    refreshAdminCounts();
}
function stopAdminLive() {
    if (adminLive) {
        try { adminLive.users(); } catch (e) { }
        try { adminLive.games(); } catch (e) { }
        clearInterval(adminLive.timer); clearInterval(adminLive.counts);
        adminLive = null;
    }
    if (adminPaintTimer) { clearTimeout(adminPaintTimer); adminPaintTimer = null; adminPaintWhat = {}; }
    closeAllRoomWatch();
    stopAdminTxWatch();
    if (adminLedgerUnsub) { try { adminLedgerUnsub(); } catch (e) { } adminLedgerUnsub = null; }
    adminLedgerSeq++;
    adminLoadedAt = 0;   // the next visit starts from the live feed again
}
const adminRefresh = () => (adminLive ? refreshAdminCounts() : loadAdmin(true));

var adminOpenRooms = new Set();
function adminUserName(uid, fallback) {
    const u = adminUsers.find(x => x.id === uid);
    return (u && (u.alias || u.name)) || fallback || "Player";
}
var adminRoomWatch = new Map();   // gid -> { P: players or null, pres: {uid: last seen ms}, stop }
function closeRoomWatch(gid) { const w = adminRoomWatch.get(gid); if (w) { try { w.stop(); } catch (e) { } adminRoomWatch.delete(gid); } }
function closeAllRoomWatch() { [...adminRoomWatch.keys()].forEach(closeRoomWatch); }
// one live view of a room's players: joins, wins and online / offline show up without any refresh
function fillRoomDetail(gid) {
    const box = $("rd-" + gid); if (!box) return;
    box.classList.remove("hidden");
    if (!adminRoomWatch.has(gid)) {
        const w = { P: null, pres: {}, stop: null };
        const u1 = Coins.watchPlayers(gid, list => { w.P = list; renderRoomDetail(gid); });
        const u2 = Coins.watchPresence(gid, seen => { w.pres = seen || {}; renderRoomDetail(gid); });
        w.stop = () => { u1(); u2(); };
        adminRoomWatch.set(gid, w);
    }
    renderRoomDetail(gid);
}
function renderRoomDetail(gid) {
    const box = $("rd-" + gid), w = adminRoomWatch.get(gid); if (!box || !w) return;
    if (w.P === null) { box.innerHTML = "<small>Loading...</small>"; return; }
    const g = adminGames.find(x => x.id === gid) || {};
    const P = w.P;
    // online = a presence stamp in the last 5 minutes; players beat every 2 minutes
    const seenOf = p => {
        const hb = g.hostSeenAt && g.hostSeenAt.toMillis ? g.hostSeenAt.toMillis() : 0;   // the host stamps the room, not a presence doc
        const t = p.isHost && hb ? hb : w.pres[p.uid];
        if (!t) return "joined " + fmtTime(p.joinedAt);
        return (Date.now() - t < PRESENCE_OFFLINE_MS ? "● online" : "○ offline") + " · seen " + fmtTime(new Date(t));
    };
    if (g.mode === "dev") {
        // developer match: the opponent is the human (not a "host"), the developer is the auto-play side.
        // If the room data was already cleaned, rebuild both rows from the game record.
        const byUid = {}; P.forEach(p => { byUid[p.uid] = p; });
        const rows = [[g.oppUid, "Opponent", g.oppName], [g.devUid, "Developer (auto-play)", g.devName]].map(([uid, role, nm]) => {
            const p = byUid[uid];
            const name = (p && p.name) || adminUserName(uid, nm);
            const info = p
                ? `${esc(p.tickets)} ticket(s) · wins: ${esc((p.claims || []).join(", ") || "none")} · ${esc(seenOf(p))}`
                : "room data cleaned";
            return `<small>${esc(name)} · ${role} · ${info}</small>`;
        });
        box.innerHTML = rows.join("") + `<small>Entry 🪙${esc(g.stake || g.ticketPrice || 0)} each${g.cancelled ? " · cancelled, fees refunded" : ""}</small>`;
        return;
    }
    box.innerHTML = P.map(p => `<small>${esc(p.name || "Player")}${p.isHost ? " (host)" : ""} · ${esc(p.tickets)} ticket(s) · wins: ${esc((p.claims || []).join(", ") || "none")} · ${esc(seenOf(p))}</small>`).join("") || "<small>No players.</small>";
}
// Automatic: when a room is finished (or gone), every user still pointing at it is released.
var adminClearing = new Set(), adminOpenSeen = new Map(), adminReleasing = false;
var adminSwept = new Set();
// Automatic housekeeping while the admin screen is open: abandoned rooms are ended, and finished rooms
// that still hold temporary data (players / tickets / claims) are cleaned. Room records + history stay.
async function autoSweepRooms() {
    const todo = [];
    adminGames.forEach(g => {
        if (adminSwept.has(g.id)) return;
        const age = g.createdAt && g.createdAt.toMillis ? Date.now() - g.createdAt.toMillis() : 0;
        const hostSeen = g.hostSeenAt && g.hostSeenAt.toMillis ? g.hostSeenAt.toMillis() : 0;
        const hostGone = hostSeen && Date.now() - hostSeen > 2 * 3600 * 1000;      // no host heartbeat for 2 hours
        if (g.status !== "finished" && (age > ADMIN_STALE_MS || hostGone || Number(g.playerCount) <= 0)) todo.push([g.id, "end"]);
        else if (g.status === "finished" && !g.archived) todo.push([g.id, "clean"]);
    });
    if (!todo.length) return;
    for (const [id, kind] of todo.slice(0, 20)) {
        adminSwept.add(id);   // only rooms handled in this pass are marked; the rest are picked up on the next load
        try { await (kind === "end" ? Coins.adminEndGame(id) : Coins.adminCleanGame(id)); } catch (e) { adminSwept.delete(id); break; }
    }
}
async function autoReleaseUsers() {
    if (adminReleasing) return;
    adminReleasing = true;
    autoSweepRooms().catch(() => { });
    try {
        for (const u of adminUsers) {
            const ag = u.activeGame;
            if (!ag || !ag.gameId) continue;
            const key = u.id + ":" + ag.gameId;
            if (adminClearing.has(key)) continue;
            const g = adminGames.find(x => x.id === ag.gameId);
            let closed;
            if (g) closed = g.status === "finished";
            else {
                const seen = adminOpenSeen.get(ag.gameId);
                if (seen && Date.now() - seen < 30000) continue;   // checked recently and still open
                closed = await Coins.adminGameClosed(ag.gameId).catch(() => false);
                if (!closed) adminOpenSeen.set(ag.gameId, Date.now());
            }
            if (!closed) continue;
            adminClearing.add(key);
            Coins.adminClearActive(u.id).catch(() => { }).finally(() => setTimeout(() => adminClearing.delete(key), 5000));
        }
    } finally { adminReleasing = false; }
}
// One-time reads (users 100, rooms 100) so an open admin screen costs nothing while idle.
// Data is re-read when you tap Refresh, after an admin action, or when the screen is opened after 5 min.
var adminLoadedAt = 0, adminLoading = false, adminReloadQueued = false;
async function loadAdmin(force) {
    if (!Coins.isAdmin()) return;
    if (adminLoading) { if (force) adminReloadQueued = true; return; }
    if (!force && adminLoadedAt && Date.now() - adminLoadedAt < 5 * 60 * 1000) return;
    adminLoading = true;
    try {
        const [users, games, counts] = await Promise.all([Coins.adminUsers(false), Coins.adminGames(), Coins.adminCounts()]);
        adminUsers = users; adminGames = games; adminCounts = counts || {};
        adminLoadedAt = Date.now();
        paintAdminStats(); paintAdminUsers(); paintAdminRooms();
        adminOpenRooms.forEach(gid => fillRoomDetail(gid));
        if (adminSel && $("admin-user-popup").classList.contains("active")) {
            const u = adminUsers.find(x => x.id === adminSel.id);
            if (u) { adminSel = u; $("au-name").textContent = u.alias || u.name || "Player"; $("au-meta").textContent = `${u.id} · 🪙 ${nf(u.coins)}${u.activeGame ? " · in game " + (u.activeGame.roomId || "") : ""}`; }
        }
    } catch (e) {
        showNotification((e && e.message) || "Could not load admin data", "error");
    }
    adminLoading = false;
    autoReleaseUsers().catch(() => { });   // release users stuck in finished rooms + end abandoned rooms (was never called before)
    if (adminReloadQueued) { adminReloadQueued = false; await loadAdmin(true); }
}
function ensureAdminRefreshButton() {
    if ($("admin-refresh")) return;
    const panel = document.querySelector('[data-panel="a-overview"]');
    if (!panel) return;
    const b = document.createElement("button");
    b.id = "admin-refresh"; b.type = "button"; b.className = "btn-outline signout-btn";
    b.textContent = "Refresh";
    b.onclick = () => loadAdmin(true);
    panel.appendChild(b);
}
function renderAdmin() {
    if (!Coins.isAdmin()) { showView("profile"); return; }
    ensureAdminRefreshButton();
    if (!adminLoadedAt) {
        $("admin-list").innerHTML = '<p class="empty">Loading...</p>';
        $("admin-rooms").innerHTML = '<p class="empty">Loading...</p>';
    }
    startAdminLive();          // balance changes also call renderAdmin: starting again does nothing while the feeds run
}

var adminLedgerSeq = 0, adminLedgerUnsub = null;
async function paintAdminLedger(uid, list) {
    const my = ++adminLedgerSeq;
    let L = list;
    try { L = await Coins.sendNames(list); } catch (e) { }
    if (my !== adminLedgerSeq || !adminSel || adminSel.id !== uid || !$("admin-user-popup").classList.contains("active")) return;
    L = L.slice().sort((a, b) => timeOf(b).getTime() - timeOf(a).getTime());   // newest first, whatever order the server returned
    $("au-ledger").innerHTML = L.map(t => `<div class="row"><div><b>${esc(Coins.describe(t))}</b><small>${esc(fmtTime(rowTime(t)))}${t.note ? " · " + esc(t.note) : ""}</small></div><b class="${t.amount < 0 ? "neg" : "pos"}">${t.amount > 0 ? "+" : ""}${nf(t.amount)}</b></div>`).join("") || '<p class="empty">No transactions.</p>';
}
// one-off re-read of the open user's history (used as a safety net next to the live listener)
function refreshAdminLedger(uid) {
    return Coins.adminLedger(uid, 50).then(L => paintAdminLedger(uid, L)).catch(() => { });
}
async function openAdminUser(uid) {
    const u = adminUsers.find(x => x.id === uid); if (!u) return;
    adminSel = u;
    $("au-history").open = false;
    $("au-name").textContent = u.alias || u.name || "Player";
    $("au-alias").value = u.alias || "";
    $("au-meta").textContent = `${u.id} · 🪙 ${nf(u.coins)}${u.activeGame ? " · in game " + (u.activeGame.roomId || "") : ""}`;
    $("au-ledger").innerHTML = '<p class="empty">Loading...</p>';
    $("admin-user-popup").classList.add("active");
    if (adminLedgerUnsub) adminLedgerUnsub();
    adminLedgerUnsub = Coins.watchAdminLedger(uid, 50, L => paintAdminLedger(uid, L));   // live: new transactions appear by themselves
}
function closeAdminUser() {
    if (adminLedgerUnsub) { try { adminLedgerUnsub(); } catch (e) { } adminLedgerUnsub = null; }
    $("admin-user-popup").classList.remove("active");
}

$("admin-search").addEventListener("input", () => {
    $("admin-search-clear").classList.toggle("hidden", !$("admin-search").value);
    paintAdminUsers();
});
$("admin-search-clear").onclick = () => {
    $("admin-search").value = "";
    $("admin-search-clear").classList.add("hidden");
    $("admin-search").focus();
    paintAdminUsers();
};
$("admin-user-filters").addEventListener("click", e => {
    const c = e.target.closest(".chip"); if (!c) return;
    adminUserFilter = c.dataset.f;
    $("admin-user-filters").querySelectorAll(".chip").forEach(x => x.classList.toggle("active", x === c));
    paintAdminUsers();
});
$("admin-room-filters").addEventListener("click", e => {
    const c = e.target.closest(".chip"); if (!c) return;
    adminRoomFilter = c.dataset.f;
    $("admin-room-filters").querySelectorAll(".chip").forEach(x => x.classList.toggle("active", x === c));
    paintAdminRooms();
});
/* ----- Transactions tab (admin only): "All" = latest entries of every user, one button per user = that user's full list ----- */
var adminTxFilter = "", adminTxCache = {}, adminTxLoading = false, adminTxRerun = false;
const TX_USER_LIMIT = 50, TX_CACHE_MS = 5 * 60 * 1000;
const txMs = t => { const d = rowTime(t); return d ? d.getTime() : 0; };
const adminName = u => (u && (u.alias || u.name)) || "Player";
function txRow(t, who) {
    const amt = Number(t.amount) || 0;
    return `<div class="row"><div><b>${who ? '<span class="tx-who">' + esc(who) + '</span> · ' : ""}${esc(Coins.describe(t))}</b>` +
        `<small>${esc(fmtTime(rowTime(t)))}${t.note ? " · " + esc(t.note) : ""}</small></div>` +
        `<b class="${amt < 0 ? "neg" : "pos"}">${amt > 0 ? "+" : ""}${nf(amt)}</b></div>`;
}
var adminTxUnsub = null;
function stopAdminTxWatch() { if (adminTxUnsub) { try { adminTxUnsub(); } catch (e) { } adminTxUnsub = null; } }
// one button per user (by name); nothing is read until one is picked
function paintTxChips() {
    const chipBox = $("admin-tx-filters"); if (!chipBox) return;
    const byId = {}; adminUsers.forEach(u => { byId[u.id] = u; });
    chipBox.innerHTML = adminUsers.slice().sort((a, b) => adminName(a).localeCompare(adminName(b)))
        .map(u => `<button type="button" class="chip${adminTxFilter === u.id ? " active" : ""}" data-f="${esc(u.id)}">${esc(adminName(u))}</button>`).join("");
}
async function renderAdminTx(force) {
    if (!Coins.isAdmin()) return;
    if (adminTxLoading) { adminTxRerun = true; return; }
    const list = $("admin-tx-list");
    adminTxLoading = true;
    try {
        if (!adminUsers.length) { list.innerHTML = '<p class="empty">Loading...</p>'; startAdminLive(); await new Promise(r => setTimeout(r, 1200)); }
        if (adminTxFilter && !adminUsers.some(u => u.id === adminTxFilter)) adminTxFilter = "";
        paintTxChips();
        if (!adminTxFilter) {
            stopAdminTxWatch();
            list.innerHTML = '<p class="empty">Pick a user to see their latest transactions.</p>';
        } else if (force || !adminTxUnsub || adminTxUnsub.uid !== adminTxFilter) {
            // live: new transactions of the picked user appear by themselves
            stopAdminTxWatch();
            const uid = adminTxFilter;
            list.innerHTML = '<p class="empty">Loading...</p>';
            const off = Coins.watchAdminLedger(uid, TX_USER_LIMIT, L => {
                if (adminTxFilter !== uid) return;
                list.innerHTML = L.map(t => txRow(t, "")).join("") || '<p class="empty">No transactions.</p>';
            });
            adminTxUnsub = Object.assign(() => off(), { uid });
        }
    } catch (e) {
        list.innerHTML = '<p class="empty">Could not load transactions.</p>';
    }
    adminTxLoading = false;
    if (adminTxRerun) { adminTxRerun = false; renderAdminTx(false); }   // the filter changed while loading: show the latest pick
}
$("admin-tx-filters").addEventListener("click", e => {
    const c = e.target.closest(".chip"); if (!c) return;
    adminTxFilter = adminTxFilter === c.dataset.f ? "" : c.dataset.f;
    $("admin-tx-filters").querySelectorAll(".chip").forEach(x => x.classList.toggle("active", x === c));
    renderAdminTx(false);
});
$("admin-tabs").addEventListener("click", e => {
    const t = e.target.closest('.tab[data-tab="a-tx"]'); if (!t) return;
    // tapping the tab while it is already open reloads from the database; switching to it reuses the cache
    renderAdminTx(t.classList.contains("active"));
});
$("admin-list").addEventListener("click", e => { const r = e.target.closest("[data-uid]"); if (r) openAdminUser(r.dataset.uid); });
$("au-close").onclick = closeAdminUser;
$("au-alias-save").onclick = async () => {
    if (!adminSel) return;
    const v = $("au-alias").value.trim().slice(0, 30);
    try {
        await Coins.adminSetAlias(adminSel.id, v);
        $("au-name").textContent = v || adminSel.name || "Player";
        showNotification("Alias saved", "success");
        adminRefresh();
    } catch (err) { showNotification(err.message, "error"); }
};
$("au-delete").onclick = async () => {
    if (!adminSel) return;
    if (!confirm("Permanently delete " + (adminSel.alias || adminSel.name || "this user") + " and all their data? This cannot be undone.")) return;
    const btn = $("au-delete");
    btn.disabled = true;
    try {
        await Coins.adminDeleteUser(adminSel.id);
        closeAdminUser();
        showNotification("User deleted", "success");
        adminRefresh();
    } catch (err) { showNotification(err.message, "error"); }
    btn.disabled = false;
};
$("admin-rooms").addEventListener("click", async e => {
    const b = e.target.closest("[data-room]"); if (!b) return;
    const gid = b.dataset.gid;
    try {
        if (b.dataset.room === "players") {
            const box = $("rd-" + gid);
            if (adminOpenRooms.has(gid)) { adminOpenRooms.delete(gid); closeRoomWatch(gid); box.classList.add("hidden"); }
            else { adminOpenRooms.add(gid); box.innerHTML = "<small>Loading...</small>"; fillRoomDetail(gid); }
        } else if (b.dataset.room === "end") {
            if (!confirm("End this room now? Its temporary data is deleted; the room record and coin history are kept.")) return;
            await Coins.adminEndGame(gid); showNotification("Room ended", "success"); adminRefresh();
        } else if (b.dataset.room === "del") {
            if (!confirm("Delete this room and all its data? This cannot be undone.")) return;
            adminOpenRooms.delete(gid); closeRoomWatch(gid); await Coins.adminDeleteGame(gid); showNotification("Room deleted", "success"); adminRefresh();
        }
    } catch (err) { showNotification(err.message, "error"); }
});

/* ----- bulk "all" buttons (admin) ----- */
async function adminBulk(btn, confirmText, job, doneText) {
    if (!confirm(confirmText)) return;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Working...";
    try {
        const r = await job();
        showNotification(r.failed ? `${doneText}: ${r.ok} done, ${r.failed} failed` : `${doneText}: ${r.ok}`, r.failed ? "error" : "success");
    } catch (err) { showNotification(err.message || "Action failed", "error"); }
    btn.textContent = label;
    adminOpenRooms.clear(); closeAllRoomWatch();
    await adminRefresh();
    paintAdminBulk();
}
$("admin-rooms-endall").onclick = e => {
    const ids = adminLiveRooms().map(g => g.id);
    adminBulk(e.currentTarget, `End all ${ids.length} live room(s) now? Their temporary data is deleted; room records and coin history are kept.`, () => Coins.adminEndGames(ids), "Rooms ended");
};
$("admin-rooms-cleanall").onclick = e => {
    const ids = adminGames.filter(g => g.status === "finished" && !g.archived).map(g => g.id);
    adminBulk(e.currentTarget, `Delete leftover play data of ${ids.length} finished room(s)? Room records and coin history are kept.`, () => Coins.adminCleanGames(ids), "Rooms cleaned");
};
$("admin-rooms-delall").onclick = e => {
    const ids = adminShownRooms().map(g => g.id);
    adminBulk(e.currentTarget, `Permanently delete ${ids.length} room(s) INCLUDING their room records? This cannot be undone. (Coin history is not affected.)`, () => Coins.adminDeleteGames(ids), "Rooms deleted");
};
$("admin-users-releaseall").onclick = e => {
    const ids = adminUsers.filter(u => u.activeGame).map(u => u.id);
    adminBulk(e.currentTarget, `Release all ${ids.length} user(s) from their rooms?`, () => Coins.adminClearActiveMany(ids), "Users released");
};

const VIEW_LOADERS = { updates: renderUpdates, home: renderHome, lobby: initLobby, devlobby: renderDevLobby, earn: renderEarn, profile: renderProfile, stats: renderStats, history: renderHistory, theme: () => applyTheme(store.get("theme", "indigo")), favorites: () => { favEditing = false; favDraft = []; paintFav(); }, share: renderShare, leaderboard: renderLeaderboard, admin: renderAdmin };

/* ================= ARENA: menu, copy, feedback, hints ================= */
function closeMenu() {
    const d = $("menu-dropdown");
    if (d) d.classList.add("hidden");
    const b = $("btn-menu");
    if (b) b.setAttribute("aria-expanded", "false");
}
$("btn-menu").onclick = e => {
    e.stopPropagation();
    const d = $("menu-dropdown");
    const open = d.classList.toggle("hidden") === false;
    $("btn-menu").setAttribute("aria-expanded", String(open));
};
document.addEventListener("click", e => { if (!e.target.closest(".menu-wrap")) closeMenu(); });
$("btn-members").onclick = () => { closeMenu(); $("members-popup").classList.add("active"); };
$("members-close").onclick = () => $("members-popup").classList.remove("active");
$("btn-leave").addEventListener("click", closeMenu);


/* ================= RESULT BUTTONS ================= */
$("win-again").onclick = () => {
    sessionStorage.setItem("housie.again", "1");
    stopListeners();
    Coins.clearActiveGame();
    location.reload();
};

/* ================= BACK GESTURE / BROWSER BACK ================= */
window.addEventListener("popstate", e => {
    const pop = document.querySelector(".popup-overlay.active:not(#reconnect-overlay)");
    if (pop) {
        const btn = pop.querySelector("#leave-cancel, #members-close, #au-close, #delete-cancel, [data-v='0']");
        if (btn) btn.click(); else pop.classList.remove("active");
        history.pushState({ view: currentView }, "");
        return;
    }
    if (!window.Coins || !Coins.user) return;
    if (currentView === "arena") {
        if (!winScreen.classList.contains("active")) leavePopup.classList.add("active");
        history.pushState({ view: "arena" }, "");
        return;
    }
    let v = e.state && e.state.view;
    if (!v) return;
    if (v === "welcome" || v === "arena") v = "home";
    if (v === currentView) return;
    showView(v, true);
});