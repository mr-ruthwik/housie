/* =====================================================================
   COINS + GAME STATE - Google sign-in + Firestore (free Spark plan, no
   server code). Firestore is now the ONLY place state lives: there is no
   PeerJS and no localStorage anywhere in this file. Every client (host
   included) subscribes to the same Firestore documents and reacts to
   whatever changes there; the host is still the single judge of claims
   and the only one who draws numbers, but it talks to everyone else
   through Firestore instead of a peer-to-peer link.
   Every coin change is a ledger entry + balance update written together;
   the Firestore security rules (firestore.rules) check each pair.
   ===================================================================== */
window.Coins = (function () {
    const firebaseConfig = {
        apiKey: "AIzaSyBlt80pZGpuz4wtJ7pnkMUB_1_3ZV52S5w",
        authDomain: "housie-v3.firebaseapp.com",
        projectId: "housie-v3",
        storageBucket: "housie-v3.firebasestorage.app",
        messagingSenderId: "241611752897",
        appId: "1:241611752897:web:2a65bdb7b1e0da43ef1b40"
    };
    const START_COINS = 1000;          // default welcome bonus; must match firestore.rules
    const ADMIN_START_COINS = 50000;   // admin's own welcome bonus; must match firestore.rules
    const ADMIN_EMAIL = "sairuthwik2002@gmail.com"; // must match isAdmin() in firestore.rules
    const HOUSIE_BONUS = 250;          // extra coins for winning Housie; must match firestore.rules
    const SPLIT = { jaldi: 10, line1: 15, line2: 15, line3: 15, housie: 45 };
    const PRIZE_NAMES = { jaldi: "Jaldi", line1: "1st Line", line2: "2nd Line", line3: "3rd Line", housie: "Housie" };

    const api = { user: null, balance: null, enabled: false, ready: Promise.resolve(null), SPLIT, HOUSIE_BONUS };
    if (typeof firebase === "undefined") { console.warn("Firebase SDK failed to load - coins disabled."); return api; }
    api.enabled = true;

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

    const friendly = e => {
        console.error("[Firestore]", e);
        const m = (e && e.message) || "";
        if (/permission|insufficient/i.test(m)) return "Not allowed. The game may have started, or you don't have enough coins.";
        if (/network|unavailable|offline/i.test(m)) return "Network problem. Check your connection and try again.";
        return m || "Something went wrong. Try again.";
    };
    const wrap = p => p.catch(e => { throw new Error(friendly(e)); });
    const toast = (m, t) => { if (typeof showNotification === "function") showNotification(m, t); };

    const tRef = (gid, uid) => gRef(gid).collection("tickets").doc(uid);
    // Ticket grids are stored as one JSON string (Firestore can't hold arrays inside arrays).
    const parseTickets = json => { try { return JSON.parse(json || "[]"); } catch (e) { return []; } };

    let unsubUser = null;
    function watchBalance(uid) {
        if (unsubUser) unsubUser();
        let first = true;
        unsubUser = uRef(uid).onSnapshot(snap => {
            if (!snap.exists) return;
            const coins = snap.data().coins;
            const diff = api.balance === null ? 0 : coins - api.balance;
            api.balance = coins;
            document.querySelectorAll("[data-coin]").forEach(el => { el.textContent = coins; });
            if (api.onBalance) api.onBalance(coins);
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
        const bonus = isAdmin ? ADMIN_START_COINS : START_COINS;
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
            if (unsubUser) { unsubUser(); unsubUser = null; }
            if (user) {
                try { await ensureUser(user); } catch (e) { console.warn("ensureUser", e); }
                watchBalance(user.uid);
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
    api.signOut = () => auth.signOut();
    api.getIdToken = () => api.user.getIdToken();

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
    const ROOM_SUBS = ["claimRequests", "prizes", "tickets", "players", "voice", "signals"];
    /* ---------- export: admin = whole database, everyone else = own account + history ---------- */
    async function dumpDoc(ref) {
        const snap = await ref.get();
        const out = { id: ref.id, data: snap.exists ? snap.data() : null, sub: {} };
        const subs = ["ledger", "players", "tickets", "prizes", "claimRequests"];
        for (const name of subs) {
            const col = await ref.collection(name).get().catch(() => null);
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
        for (const u of users.docs) out.users.push(await dumpDoc(u.ref));
        const games = await db.collection("games").get();
        for (const g of games.docs) out.games.push(await dumpDoc(g.ref));
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
            if (typeof v.seconds === "number" && typeof v.nanoseconds === "number" && Object.keys(v).length === 2) return new firebase.firestore.Timestamp(v.seconds, v.nanoseconds);
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
                for (const sub of ["players", "tickets", "prizes", "claimRequests"]) await wipeCollection(g.ref.collection(sub));
                await g.ref.delete();
                joined.delete(g.id);
            }
            // player docs in rooms hosted by others
            for (const gid of joined) { try { await pRef(gid, uid).delete(); await tRef(gid, uid).delete(); } catch (e) { } }
            await wipeCollection(uRef(uid).collection("ledger"));
            await uRef(uid).delete();
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
        return wrap(db.runTransaction(async tx => {
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
                return { tickets, already: false };
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
            return { tickets, already: false };
        }));
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

    // Draws one not-yet-called number, atomically: two quick taps can never draw the same number.
    api.draw = gid => wrap(db.runTransaction(async tx => {
        const gs = await tx.get(gRef(gid));
        if (!gs.exists) throw new Error("Room not found.");
        const g = gs.data();
        const called = g.calledNumbers || [];
        if (called.length >= 90) return { num: null, done: true };
        let n;
        do { n = Math.floor(Math.random() * 90) + 1; } while (called.includes(n));
        const patch = { calledNumbers: [...called, n], currentNumber: n };
        if (g.status === "open") patch.status = "started";
        tx.update(gRef(gid), patch);
        return { num: n, done: false };
    }));

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
                mode: "dev", devUid, oppUid, devName, hostUid: oppUid, roomCode: null,
                ticketPrice: stake, stake, split: SPLIT, pot, totalTickets: tickets * 2, playerCount: 2,
                status: "started", createdAt: TS(), calledNumbers: [], currentNumber: null,
                claimsTaken: {}, claimsLocked: {}
            });
            tx.set(pRef(gid, oppUid), { tickets, name: oppName, isHost: true, isBot: false, claims: [], claimedTickets: [], joinedAt: TS(), lastActive: TS() });
            tx.set(pRef(gid, devUid), { tickets, name: devName, isHost: false, isBot: true, claims: [], claimedTickets: [], joinedAt: TS(), lastActive: TS() });
            tx.set(tRef(gid, oppUid), { ticketsJson: JSON.stringify(oppTicketsData), marked: {} });
            tx.set(tRef(gid, devUid), { ticketsJson: JSON.stringify(devTicketsData), marked: {} });
            return { gid };
        }));
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
    }));
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
            share: Math.floor((g.pot || 0) * SPLIT[k] / 100)
        }, { mode: "dev", note: "Opponent forfeited" }));
        return Promise.all(jobs).then(() => gRef(gid).update({ status: "finished" }));
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
    const resilient = subscribe => {
        let unsub = null, stopped = false, timer = null, tries = 0, startedAt = 0;
        const MAX_TRIES = 5;
        const start = () => {
            if (stopped) return;
            startedAt = Date.now();
            unsub = subscribe(err => {
                if (unsub) { try { unsub(); } catch (e) { } unsub = null; }
                if (stopped) return;
                const code = err && err.code;
                if (code === "permission-denied" || code === "unauthenticated") {
                    console.warn("[listener] stopped (not allowed):", err); return;
                }
                if (Date.now() - startedAt > 30000) tries = 0;   // it ran fine for a while: start counting again
                if (++tries > MAX_TRIES) { console.warn("[listener] giving up after", MAX_TRIES, "tries:", err); return; }
                const wait = Math.min(2000 * Math.pow(2, tries - 1), 30000);
                console.warn("[listener] re-subscribing in " + wait / 1000 + "s:", err);
                timer = setTimeout(start, wait);
            });
        };
        start();
        return () => { stopped = true; clearTimeout(timer); if (unsub) unsub(); };
    };
    api.watchGame = (gid, cb) => resilient(onErr => gRef(gid).onSnapshot(s => {
        if (s.exists) cb(Object.assign({ id: s.id }, s.data()));
        else if (!s.metadata.fromCache) cb({ id: gid, status: "finished", calledNumbers: [], claimsTaken: {}, claimsLocked: {} });
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

    // Debounced per-tap persistence of marked numbers, and a periodic
    // heartbeat so other players can tell roughly who is still around.
    api.saveMarked = (gid, uid, ticketIdx, nums) => tRef(gid, uid).update({ [`marked.${ticketIdx}`]: nums }).catch(() => { });
    api.heartbeat = (gid, uid) => pRef(gid, uid).update({ lastActive: TS() }).catch(() => { });

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

    // Explicit "Leave Room": removes the player's own temporary data (player doc, tickets, voice)
    // and clears their active-game pointer. If nobody is left in the room afterwards, the room is
    // closed and cleaned up right here, so an empty room can never stay open.
    api.leaveGame = async gid => {
        const uid = api.user.uid;
        await wrap(Promise.all([
            pRef(gid, uid).delete(), tRef(gid, uid).delete(),
            gRef(gid).collection("voice").doc(uid).delete().catch(() => { }),
            uRef(uid).update({ activeGame: null })
        ]));
        try {
            const left = await gRef(gid).collection("players").get();
            if (left.empty) { await api.endGame(gid); await api.wipeRoom(gid); }
        } catch (e) { console.warn("[leaveGame] empty-room close skipped:", e); }
    };
    // Deletes ALL temporary play data of a finished room (players, tickets, claim requests, prizes,
    // voice, signals). The game document itself is KEPT as the room's record (code, price, pot,
    // player count, called numbers, winners, times), and users/ + users/{uid}/ledger are untouched,
    // so coins, history and stats stay. Safe to call more than once and from several clients.
    api.wipeRoom = async gid => {
        const g = gRef(gid);
        await Promise.allSettled(ROOM_SUBS.map(sub => wipeCollection(g.collection(sub))));
        try { await g.update({ archived: true }); } catch (e) { /* rules may not allow the flag: the data is gone anyway */ }
    };
    // end + clean in one go (any room participant / admin)
    api.closeRoom = async gid => { await api.endGame(gid); await api.wipeRoom(gid); };
    api.clearActiveGame = () => (api.user ? wrap(uRef(api.user.uid).update({ activeGame: null })) : Promise.resolve());
    api.getActiveGame = () => uRef(api.user.uid).get().then(s => (s.exists ? s.data().activeGame : null));

    /* ---------- ledger helpers (history, stats, rewards) ---------- */
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const LEDGER_LABELS = {
        bonus: "Welcome coins", entry: "Entry fee", daily: "Daily bonus", wheel: "Try your luck", refill: "Free refill",
        task: "Task reward", admin: "Admin adjustment", deventry: "Developer challenge entry fee", devrefund: "Developer challenge refund"
    };
    const describe = t => t.type === "win" ? `Won ${PRIZE_NAMES[t.prize] || t.prize}`
        : t.type === "send" ? "Sent to " + (t.toName || "code " + (t.toCode || ""))
            : t.type === "gift" ? "Received from " + (t.fromName || "a friend")
                : (LEDGER_LABELS[t.type] || t.type);
    api.esc = esc;
    api.describe = describe;

    // "send" entries only hold the friend's uid + code: look up the friend's display name once and cache it
    const nameCache = {};
    api.sendNames = async list => {
        const ids = [...new Set(list.filter(t => t.type === "send" && t.to && !t.toName).map(t => t.to))].filter(id => !(id in nameCache));
        await Promise.all(ids.map(id => uRef(id).get()
            .then(s => { nameCache[id] = s.exists ? (s.data().name || null) : null; })
            .catch(() => { nameCache[id] = null; })));
        list.forEach(t => { if (t.type === "send" && t.to && nameCache[t.to]) t.toName = nameCache[t.to]; });
        return list;
    };

    api.getLedger = n => uRef(api.user.uid).collection("ledger").orderBy("time", "desc").limit(n || 300).get();
    api.getLedgerSince = d => uRef(api.user.uid).collection("ledger")
        .where("time", ">=", firebase.firestore.Timestamp.fromDate(d)).orderBy("time", "desc").get();

    // One-off coin reward (daily bonus, refill, wheel, task). The ledger doc
    // id is unique per period, so the same reward can't be taken twice.
    // NOTE: firestore.rules must allow these ledger types (see notes).
    api.grant = async (id, type, amount, extra) => {
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
        let stop = null, stopped = false;
        api.findDeveloper().then(uid => {
            if (stopped) return;
            if (!uid) { cb(null); return; }
            stop = resilient(onErr => uRef(uid).onSnapshot(snap => {
                if (!snap.exists) { cb(null); return; }
                const d = snap.data();
                cb({ uid, name: d.name || "Developer", coins: d.coins, busy: !!(d.devChallenge && d.devChallenge.active) });
            }, onErr));
        }).catch(() => cb(null));
        return () => { stopped = true; if (stop) stop(); };
    };

    // Admin only (the Firestore rules enforce this too, the UI check is just cosmetic).
    api.isAdmin = () => !!(api.user && api.user.email === ADMIN_EMAIL && api.user.emailVerified
        && api.user.providerData.some(p => p.providerId === "google.com"));
    api.allUsers = async () => {
        if (!api.isAdmin()) throw new Error("Not allowed.");
        const out = [];
        let last = null;
        for (; ;) {
            let q = db.collection("users").orderBy("coins", "desc").limit(300);
            if (last) q = q.startAfter(last);
            const qs = await q.get();
            qs.docs.forEach(d => out.push(Object.assign({ id: d.id }, d.data())));
            if (qs.docs.length < 300) break;
            last = qs.docs[qs.docs.length - 1];
        }
        return out;
    };
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
    api.adminGames = async () => {
        needAdmin();
        const qs = await db.collection("games").orderBy("createdAt", "desc").limit(100).get();
        return qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
    };
    api.adminUsers = async () => {
        needAdmin();
        const qs = await db.collection("users").orderBy("coins", "desc").limit(100).get();
        return qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
    };
    api.watchAdminUsers = cb => {
        needAdmin(); return resilient(onErr => db.collection("users").orderBy("coins", "desc")
            .onSnapshot(qs => cb(qs.docs.map(d => Object.assign({ id: d.id }, d.data()))), onErr));
    };
    api.watchAdminGames = cb => {
        needAdmin(); return resilient(onErr => db.collection("games").orderBy("createdAt", "desc").limit(100)
            .onSnapshot(qs => cb(qs.docs.map(d => Object.assign({ id: d.id }, d.data()))), onErr));
    };
    api.watchAdminLedger = (uid, cb) => {
        needAdmin(); return resilient(onErr => uRef(uid).collection("ledger").orderBy("time", "desc")
            .onSnapshot(qs => cb(qs.docs.map(d => Object.assign({ id: d.id }, d.data()))), onErr));
    };
    api.adminPlayers = async gid => {
        needAdmin();
        const qs = await gRef(gid).collection("players").get();
        return qs.docs.map(d => Object.assign({ uid: d.id }, d.data()));
    };
    api.adminLedger = async (uid, n) => {
        needAdmin();
        const qs = await uRef(uid).collection("ledger").orderBy("time", "desc").limit(n || 50).get();
        return qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
    };
    api.adminClearActive = uid => { needAdmin(); return awrap(uRef(uid).update({ activeGame: null })); };
    // ends the room, removes its temporary data (keeps the room record) and releases everyone still pointing at it
    api.adminEndGame = async gid => {
        needAdmin();
        try {
            const players = await gRef(gid).collection("players").get();
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
                for (const sub of ["players", "tickets", "prizes", "claimRequests"]) await wipeCollection(g.ref.collection(sub));
                await g.ref.delete();
                joined.delete(g.id);
                await Promise.all(players.docs.filter(d => d.id !== uid).map(d => uRef(d.id).update({ activeGame: null }).catch(() => { })));
            }
            for (const gid of joined) { try { await pRef(gid, uid).delete(); await tRef(gid, uid).delete(); } catch (e) { } }
            await wipeCollection(uRef(uid).collection("ledger"));
            await uRef(uid).delete();
        } catch (e) { await awrap(Promise.reject(e)); }
    };
    api.adminDeleteGame = async gid => {
        needAdmin();
        try {
            const players = await gRef(gid).collection("players").get();
            await Promise.allSettled(ROOM_SUBS.map(sub => wipeCollection(gRef(gid).collection(sub))));
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

    /* ---------- voice chat: mic state + WebRTC signalling over Firestore ---------- */
    api.voiceSetMic = (gid, uid, on) => (on
        ? gRef(gid).collection("voice").doc(uid).set({ mic: true, t: TS() })
        : gRef(gid).collection("voice").doc(uid).delete()).catch(() => { });
    api.watchVoice = (gid, cb) => resilient(onErr => gRef(gid).collection("voice").onSnapshot(snap => {
        const o = {};
        snap.docs.forEach(d => { o[d.id] = !!d.data().mic; });
        cb(o);
    }, onErr));
    api.sendSignal = (gid, to, type, data) => gRef(gid).collection("signals")
        .add({ from: api.user.uid, to, type, data: JSON.stringify(data), t: TS() }).catch(() => { });
    api.watchSignals = (gid, cb) => resilient(onErr => gRef(gid).collection("signals").where("to", "==", api.user.uid)
        .onSnapshot(snap => {
            snap.docChanges().forEach(ch => {
                if (ch.type !== "added") return;
                cb(Object.assign({ id: ch.doc.id }, ch.doc.data()));
                ch.doc.ref.delete().catch(() => { });
            });
        }, onErr));

    /* ---------- public chat (one room for all users, only the newest CHAT_KEEP messages are ever kept) ---------- */
    const chatDoc = d => Object.assign({ id: d.id }, d.data({ serverTimestamps: "estimate" }));
    api.watchChat = (cb, n) => resilient(onErr => db.collection("chat").orderBy("time", "desc").limit(n || 20)
        .onSnapshot(snap => cb(snap.docs.map(chatDoc)), onErr));
    api.chatSend = (name, text) => db.collection("chat").add({ uid: api.user.uid, name: String(name || "Player").slice(0, 60), text, time: TS() });
    // Deletes everything past the newest `keep` messages so the collection never grows: called
    // right after sending a message and whenever the chat screen is opened, so the backend
    // self-prunes without needing any separate scheduled job.
    api.chatTrim = async (keep) => {
        const newest = await db.collection("chat").orderBy("time", "desc").limit(keep).get();
        if (newest.size < keep) return; // fewer than `keep` messages exist, nothing to prune
        let cursor = newest.docs[newest.size - 1];
        for (; ;) {
            const extra = await db.collection("chat").orderBy("time", "desc").startAfter(cursor).limit(450).get();
            if (extra.empty) break;
            const b = db.batch();
            extra.docs.forEach(d => b.delete(d.ref));
            await b.commit();
            if (extra.size < 450) break;
            cursor = extra.docs[extra.docs.length - 1];
        }
    };

    return api;
})();

if (!window.Coins || !Coins.enabled) {
    setTimeout(() => { if (typeof showNotification === "function") showNotification("Sign-in is unavailable. Check your connection and reload.", "error"); }, 500);
}

/* small shared helpers + local preferences (UI settings only, never game state) */
const $ = id => document.getElementById(id);
const store = {
    get(k, d) { try { const v = localStorage.getItem("housie." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("housie." + k, JSON.stringify(v)); } catch (e) { } }
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
let heartbeatTimer = null;
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
const popup = document.getElementById("ticket-popup");
const ticketOptions = document.getElementById("ticket-options");
const popupClose = document.getElementById("popup-close");
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

function showNotification(msg, tone) {
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
    toast.innerHTML = `<span class="toast-msg"></span><span class="toast-bar"></span>`;
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

/* ================= SERVICE WORKER + RETURN HEARTBEAT ================= */
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js")
        .catch(() => { /* needs https or localhost; fall back silently */ });
}

document.addEventListener("visibilitychange", () => {
    if (!document.hidden && gameId) sendBeat(gameId);
});

/* ================= GAME / PRIZES (coins) ================= */
function updatePrizeCard() {
    const list = document.getElementById("prize-list");
    if (!list || !gameData) return;
    document.getElementById("prize-pot").textContent = `Total 🪙 ${gameData.pot}`;
    list.innerHTML = PRIZE_ORDER.map(k => {
        const amt = Math.floor(gameData.pot * (gameData.split[k] || 0) / 100);
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
const NAV_OF = { home: "home", earn: "earn", lobby: "lobby", devlobby: "home", stats: "stats", profile: "profile", history: "profile", share: "home", chat: "home", leaderboard: "profile", updates: "profile", admin: "profile" };
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
    if (id !== "admin" && typeof stopAdminWatch === "function") stopAdminWatch();
    if (id !== "chat" && typeof stopChat === "function") stopChat();
    document.body.classList.add("auth-ready");
    const nav = $("bottom-nav");
    if (nav) nav.classList.toggle("hidden", !(window.Coins && Coins.user));
    document.querySelectorAll("#bottom-nav .nav-item").forEach(b => b.classList.toggle("active", b.dataset.open === (NAV_OF[id] || id)));
    closeMenu();
    window.scrollTo(0, 0);
    if (id === "arena") { updateCalledBoard(); updateHistory(); keepAwake(); }
    else if (VIEW_LOADERS[id]) VIEW_LOADERS[id]();
    refreshUpdateBadges();
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
            const ticketsData = generateTambolaSet(ticketCount);
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
            isHost = false;
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
            if (mine) { ticketCount = mine.tickets; enter(game, mine, true); return; }
            if (game.status !== "open") { back(); showGameInProgressPopup(); return; }
            const cost = game.ticketPrice * ticketCount;
            const ask = cost > 0
                ? askConfirm("Join this room?", `Entry fee: 🪙 ${cost} for ${ticketCount} ticket(s).`, "Pay & Join")
                : Promise.resolve(true);
            return ask.then(ok => {
                if (!ok) { back(); return; }
                const ticketsData = generateTambolaSet(ticketCount);
                return Coins.joinGame(game.id, ticketCount, myName, ticketsData).then(r => {
                    ticketCount = r.tickets;
                    enter(game, { ticketsData, marked: {}, claimedTickets: [], claims: [] }, false);
                });
            });
        });
    }).catch(e => back(e.message || "Could not join the room."));
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
    showView("arena");
    appliedClaimVisuals = new Set();
    generateTickets(ticketCount, playerState.ticketsData || []);
    applyRestoredState(playerState.marked, playerState.claimedTickets, playerState.claims);
    ticketsByUid[Coins.user.uid] = playerState.ticketsData || [];
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
    if (unwatchGame) { unwatchGame(); unwatchGame = null; }
    if (unwatchPlayers) { unwatchPlayers(); unwatchPlayers = null; }
    if (unwatchClaimRequests) { unwatchClaimRequests(); unwatchClaimRequests = null; }
    if (unwatchTickets) { unwatchTickets(); unwatchTickets = null; }
    Voice.stop();
    stopHeartbeat();
}

function startListeners(gid) {
    stopListeners();
    let primed = false;
    let finishHandled = false;
    let orphanTimer = null;
    let prevTaken = {};

    unwatchGame = Coins.watchGame(gid, g => {
        const prevLen = calledNumbers.length;
        gameData = g;
        calledNumbers = g.calledNumbers || [];
        claimsTaken = g.claimsTaken || {};
        claimsLocked = g.claimsLocked || {};
        if (Number.isFinite(g.ticketPrice)) ticketPrice = g.ticketPrice;
        document.getElementById("current-number").textContent = g.currentNumber != null ? g.currentNumber : "--";
        updatePrizeCard();
        updateCalledBoard();
        updateHistory();
        updateClaimButtons();

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
    });

    unwatchPlayers = Coins.watchPlayers(gid, list => {
        members = list.map(p => Object.assign({}, p, {
            online: p.lastActive ? (Date.now() - p.lastActive.toMillis() < 10 * 60 * 1000) : false
        }));
        renderMembers();
        Voice.sync(members);
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
    });

    if (isHost) {
        unwatchClaimRequests = Coins.watchClaimRequests(gid, handleIncomingClaimRequest);
        // tickets are no longer watched live: judgeClaim loads the claimer's ticket once (see ensureTickets)
    }

    startHeartbeat(gid);
    Voice.start(gid);
}

const HEARTBEAT_MS = 4 * 60 * 1000;      // regular beat every 4 min
const MIN_BEAT_GAP = 2 * 60 * 1000;      // never beat more often than every 2 min
let lastBeatAt = 0;

function sendBeat(gid) {
    if (!gid || !window.Coins || !Coins.user) return;
    if (Date.now() - lastBeatAt < MIN_BEAT_GAP) return;
    lastBeatAt = Date.now();
    Coins.heartbeat(gid, Coins.user.uid);
}

function startHeartbeat(gid) {
    stopHeartbeat();
    lastBeatAt = 0;
    sendBeat(gid);
    heartbeatTimer = setInterval(() => { if (!document.hidden) sendBeat(gid); }, HEARTBEAT_MS);
}
function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
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
        for (let r = 0; r < rows.length && row === null; r++) {
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
    return { ok: true, ticket: idx, row, share: Math.floor(gameData.pot * split / 100) };
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
        const amt = Math.floor((g.pot || 0) * (split[k] || 0) / 100);
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
            ${Voice.micHTML(m)}
        `;
        container.appendChild(div);
    });

    Voice.paint();
    document.getElementById("total-members").textContent = members.length;
    document.getElementById("total-price").textContent = (gameData && Number.isFinite(gameData.pot)) ? gameData.pot : totalTickets * ticketPrice;
}

/* ================= VOICE CHAT ================= */
const Voice = (function () {
    const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] };
    let gid = null, me = null, stream = null, micOn = false, denied = false, blocked = false;
    let peers = {}, early = {}, micState = {}, speaking = {}, meters = {};
    let unsubSig = null, unsubVoice = null, timer = null, ac = null;

    const myUid = () => me || (Coins.user && Coins.user.uid) || "";
    const ctx = () => {
        if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } }
        return ac;
    };

    function meter(key, s) {
        const c = ctx();
        if (!c || meters[key]) return;
        try {
            const src = c.createMediaStreamSource(s);
            const an = c.createAnalyser();
            an.fftSize = 512;
            src.connect(an);
            meters[key] = { an, src, buf: new Uint8Array(an.fftSize) };
        } catch (e) { }
    }
    function unmeter(key) {
        const m = meters[key];
        if (m) { try { m.src.disconnect(); } catch (e) { } delete meters[key]; }
        delete speaking[key];
    }
    function tick() {
        let changed = false;
        Object.keys(meters).forEach(k => {
            const m = meters[k];
            m.an.getByteTimeDomainData(m.buf);
            let s = 0;
            for (let i = 0; i < m.buf.length; i++) { const v = (m.buf[i] - 128) / 128; s += v * v; }
            const on = Math.sqrt(s / m.buf.length) > 0.03;
            if (!!speaking[k] !== on) { speaking[k] = on; changed = true; }
        });
        if (changed) paint();
    }

    function micHTML(m) {
        const mine = m && m.uid === myUid();
        return `<button type="button" class="mic-btn${mine ? " me" : ""}" aria-label="Microphone"><svg class="ico"><use href="#i-mic-off"/></svg></button>`;
    }

    function paint() {
        const st = $("voice-status");
        if (st) {
            st.textContent = denied ? "Mic blocked. Allow it in browser settings" : micOn ? "Mic is live" : "Mic is off";
            st.classList.toggle("live", micOn);
        }
        const ub = $("voice-audio-unlock");
        if (ub) ub.classList.toggle("hidden", !blocked);
        document.querySelectorAll("#members-list-container .member-item").forEach(row => {
            const uid = row.dataset.uid;
            const isMe = uid === myUid();
            const on = isMe ? micOn : !!micState[uid];
            const talk = on && !!speaking[uid];
            row.classList.toggle("is-speaking", talk);
            const b = row.querySelector(".mic-btn");
            if (!b) return;
            const wasOn = b.classList.contains("on");
            b.classList.toggle("on", on);
            b.classList.toggle("speaking", talk);
            b.classList.toggle("denied", isMe && denied);
            if (wasOn !== on || !b.firstElementChild) b.innerHTML = `<svg class="ico"><use href="#${on ? "i-mic" : "i-mic-off"}"/></svg>`;
        });
    }

    /* ----- peers ----- */
    function attach(p) {
        if (!p || !p.sender) return;
        p.sender.replaceTrack(stream ? stream.getAudioTracks()[0] || null : null).catch(() => { });
    }
    function closePeer(uid) {
        const p = peers[uid];
        if (!p) return;
        delete peers[uid];
        try { p.pc.close(); } catch (e) { }
        if (p.el) p.el.remove();
        unmeter(uid);
    }
    function flush(p) {
        const list = p.pending.splice(0);
        list.forEach(c => p.pc.addIceCandidate(c).catch(() => { }));
    }
    function makePeer(uid, initiator) {
        closePeer(uid);
        const pc = new RTCPeerConnection(ICE);
        const p = { pc, pending: [], sender: null, el: null };
        peers[uid] = p;
        pc.onicecandidate = e => { if (e.candidate) Coins.sendSignal(gid, uid, "ice", e.candidate.toJSON()); };
        pc.ontrack = e => {
            const s = (e.streams && e.streams[0]) || new MediaStream([e.track]);
            if (!p.el) {
                p.el = document.createElement("audio");
                p.el.autoplay = true;
                p.el.playsInline = true;
                $("voice-audio-sink").appendChild(p.el);
            }
            p.el.srcObject = s;
            p.el.play().catch(() => { blocked = true; paint(); });
            meter(uid, s);
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed" && peers[uid] === p) {
                closePeer(uid);
                setTimeout(() => sync(members), 1500);
            }
        };
        if (initiator) {
            const t = pc.addTransceiver("audio", { direction: "sendrecv" });
            p.sender = t.sender;
            attach(p);
            pc.createOffer()
                .then(o => pc.setLocalDescription(o))
                .then(() => Coins.sendSignal(gid, uid, "offer", { type: pc.localDescription.type, sdp: pc.localDescription.sdp }))
                .catch(e => console.warn("[voice] offer", e));
        }
        return p;
    }

    async function onSignal(s) {
        const sent = s.t && s.t.toMillis ? s.t.toMillis() : 0;
        if (sent && Date.now() - sent > 30000) return; // stale
        let d;
        try { d = JSON.parse(s.data); } catch (e) { return; }
        try {
            if (s.type === "offer") {
                const p = makePeer(s.from, false);
                p.pending = (early[s.from] || []).splice(0);
                await p.pc.setRemoteDescription(d);
                p.pc.getTransceivers().forEach(t => { t.direction = "sendrecv"; if (!p.sender) p.sender = t.sender; });
                attach(p);
                const a = await p.pc.createAnswer();
                await p.pc.setLocalDescription(a);
                Coins.sendSignal(gid, s.from, "answer", { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp });
                flush(p);
            } else if (s.type === "answer") {
                const p = peers[s.from];
                if (!p || p.pc.signalingState !== "have-local-offer") return;
                await p.pc.setRemoteDescription(d);
                flush(p);
            } else if (s.type === "ice") {
                const p = peers[s.from];
                if (!p) { (early[s.from] = early[s.from] || []).push(d); return; }
                if (p.pc.remoteDescription) p.pc.addIceCandidate(d).catch(() => { });
                else p.pending.push(d);
            }
        } catch (e) { console.warn("[voice] signal", e); }
    }

    // the player with the smaller uid always sends the offer, so two players never offer at once
    function sync(list) {
        if (!gid || !me) return;
        const ids = (list || []).map(m => m.uid).filter(u => u && u !== me);
        Object.keys(peers).forEach(u => { if (!ids.includes(u)) closePeer(u); });
        ids.forEach(u => { if (!peers[u] && me < u) makePeer(u, true); });
    }

    function start(gameId) {
        stop();
        if (!Coins.user) return;
        gid = gameId;
        me = Coins.user.uid;
        unsubSig = Coins.watchSignals(gid, onSignal);
        unsubVoice = Coins.watchVoice(gid, o => { micState = o; paint(); });
        timer = setInterval(tick, 200);
        sync(members);
        paint();
    }
    function stop() {
        if (!gid) return;
        const g = gid, u = me;
        if (unsubSig) { unsubSig(); unsubSig = null; }
        if (unsubVoice) { unsubVoice(); unsubVoice = null; }
        clearInterval(timer);
        timer = null;
        Object.keys(peers).forEach(closePeer);
        Object.keys(meters).forEach(unmeter);
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        if (micOn) Coins.voiceSetMic(g, u, false);
        micOn = false; blocked = false; micState = {}; speaking = {}; early = {};
        gid = null; me = null;
        paint();
    }

    async function toggle() {
        if (!gid) return;
        if (micOn) {
            micOn = false;
            if (stream) stream.getTracks().forEach(t => t.stop());
            stream = null;
            unmeter(me);
            Object.keys(peers).forEach(u => attach(peers[u]));
            Coins.voiceSetMic(gid, me, false);
            paint();
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showNotification("Microphone is not supported here", "error");
            return;
        }
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        } catch (e) {
            denied = true;
            showNotification("Microphone permission denied", "error");
            paint();
            return;
        }
        if (!gid) { stream.getTracks().forEach(t => t.stop()); stream = null; return; }
        denied = false;
        micOn = true;
        const c = ctx();
        if (c && c.state === "suspended") c.resume().catch(() => { });
        meter(me, stream);
        Object.keys(peers).forEach(u => attach(peers[u]));
        Coins.voiceSetMic(gid, me, true);
        paint();
    }

    function unlock() {
        const c = ctx();
        if (c && c.state === "suspended") c.resume().catch(() => { });
        Object.keys(peers).forEach(u => { if (peers[u].el) peers[u].el.play().catch(() => { }); });
        blocked = false;
        paint();
    }

    return { start, stop, sync, toggle, unlock, paint, micHTML };
})();

$("members-list-container").addEventListener("click", e => { if (e.target.closest(".mic-btn.me")) Voice.toggle(); });
$("voice-audio-unlock").onclick = () => Voice.unlock();

/* ================= GAMEPLAY ACTIONS ================= */
let lastDrawAt = 0;
document.getElementById("btn-draw").onclick = () => {
    if (!isHost || !gameId) return;
    const now = Date.now();
    if (now - lastDrawAt < 600) return; // ignore accidental double taps
    lastDrawAt = now;
    Coins.draw(gameId).then(r => {
        if (r.done) showNotification("All numbers drawn!");
        // the game-doc listener (shared by host and joiners alike) is what
        // actually updates the board and current-number display
    }).catch(e => showNotification(e.message || "Could not draw a number.", "error"));
};

// tapping anywhere in the box (including the number) draws a number
document.querySelector(".game-controls").addEventListener("click", e => {
    if (!e.target.closest("#btn-draw")) document.getElementById("btn-draw").click();
});

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
        const ticketData = ticketsData[i - 1] || generateTambolaTicket();
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

let markSaveTimers = {};
const MARK_SAVE_MS = 10000;      // marks are saved 10 s after the last tap on that ticket
function saveMarkedNow(ticketIdx) {
    delete markSaveTimers[ticketIdx];
    if (!gameId || !Coins.user) return;
    const card = document.querySelector(`[data-ticket="${ticketIdx}"]`);
    if (!card) return;
    const nums = Array.from(card.querySelectorAll(".number-cell.active")).map(c => Number(c.textContent));
    Coins.saveMarked(gameId, Coins.user.uid, ticketIdx, nums);
}
function scheduleMarkedSave(ticketIdx) {
    clearTimeout(markSaveTimers[ticketIdx]);
    markSaveTimers[ticketIdx] = setTimeout(() => saveMarkedNow(ticketIdx), MARK_SAVE_MS);
}
// save every waiting ticket right now (used on claim, when the tab is hidden, and when the page closes)
function flushMarkedSaves() {
    Object.keys(markSaveTimers).forEach(idx => { clearTimeout(markSaveTimers[idx]); saveMarkedNow(idx); });
}
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
document.querySelectorAll(".claim-btn").forEach(btn => {
    btn.onclick = () => {
        if (btn.disabled) return;
        btn.blur();
        selectedClaim = btn.dataset.claim;
        if (ticketCount === 1) { markClaim(1); } else { openTicketPopup(); }
    };
});

function openTicketPopup() {
    popup.classList.add("active");
    ticketOptions.innerHTML = "";
    const title = document.createElement("p");
    title.textContent = `Claim ${CLAIM_LABELS[selectedClaim] || selectedClaim} with:`;
    ticketOptions.appendChild(title);

    for (let i = 1; i <= ticketCount; i++) {
        const b = document.createElement("button");
        b.className = "btn-outline";
        b.textContent = "Ticket " + i;
        b.onclick = () => {
            popup.classList.remove("active");
            markClaim(i);
        };
        ticketOptions.appendChild(b);
    }
}

popupClose.onclick = () => popup.classList.remove("active");

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
        showNotification((result && result.reason) || "Claim rejected");
    }
}

function markClaim(ticketIndex) {
    flushMarkedSaves();
    if (claimsLocked[selectedClaim] || myClaims.has(selectedClaim)) {
        showNotification(`${CLAIM_LABELS[selectedClaim]} is no longer available`);
        return;
    }
    const ticket = document.querySelector(`[data-ticket="${ticketIndex}"]`);
    const activeCells = ticket ? Array.from(ticket.querySelectorAll(".number-cell.active")) : [];
    if (activeCells.length === 0) {
        showNotification("Mark numbers first!");
        return;
    }
    if (!gameId || !Coins.user) { showNotification("Not connected to the room"); return; }

    // the claim names the ticket and the marked numbers; the host checks them against that ticket
    const payload = {
        claim: selectedClaim,
        name: myName,
        ticket: ticketIndex,
        marked: activeCells.map(c => Number(c.textContent))
    };
    if (isHost) {
        handleClaimRequest(Object.assign({ id: null, uid: Coins.user.uid }, payload)).then(handleClaimResult);
    } else {
        Coins.submitClaim(gameId, payload).then(handleClaimResult).catch(e => showNotification(e.message || "Claim failed", "error"));
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
    const prize = gameData ? Math.floor(gameData.pot * ((gameData.split || {}).housie || 45) / 100) : 0;
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
document.getElementById("win-home").onclick = () => {
    stopListeners();
    Coins.clearActiveGame();
    location.reload();
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
function generateTambolaSet(count) {
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
        pool.sort(() => Math.random() - .5);
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
   (name, theme, random-theme, screen-awake) live in localStorage.
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
    showReconnectOverlay();
    Coins.getActiveGame().then(info => {
        if (!info || !info.gameId) return false;
        return Coins.myPlayer(info.gameId).then(mine => {
            if (!mine) { Coins.clearActiveGame(); return false; }
            return Coins.gameRef(info.gameId).get().then(gs => {
                if (!gs.exists || gs.data().status === "finished") { Coins.clearActiveGame(); return false; }
                const g = Object.assign({ id: gs.id }, gs.data());
                myName = mine.name;
                ticketCount = mine.tickets;
                isHost = !!mine.isHost;
                isDevGame = g.mode === "dev";
                gameId = g.id;
                myRoomId = g.roomCode;
                ticketPrice = isDevGame ? g.stake : g.ticketPrice;
                enterArena(mine);
                showNotification("Welcome back! Room restored.");
                return true;
            });
        });
    }).then(entered => {
        hideReconnectOverlay();
        if (!entered) enterHome();
    }).catch(() => { hideReconnectOverlay(); enterHome(); });
}

// Safety net: if auth never answers (offline), reveal the sign-in screen after a while.
setTimeout(() => document.body.classList.add("auth-ready"), 6000);
if (!window.Coins || !Coins.enabled) document.body.classList.add("auth-ready");

let authHandled = false;
function onAuth(user) {
    authHandled = true;
    if (!user) {
        ledgerCache = null;
        if (devUnwatch) { devUnwatch(); devUnwatch = null; }
        devInfo = null;
        showView("welcome");
        return;
    }
    if (!devUnwatch) devUnwatch = Coins.watchDeveloper(info => { devInfo = info; paintDevWidgets(); });
    if (currentView === "arena") return;
    attemptResume(user);
}
if (window.Coins && Coins.enabled) {
    Coins.authListeners.push(onAuth);
    Coins.ready.then(u => { if (!authHandled) onAuth(u); });
    Coins.onBalance = () => {
        ledgerCache = null;
        updateCost();
        updateTaskBadge();
        if (currentView !== "arena" && VIEW_LOADERS[currentView] && currentView !== "lobby") VIEW_LOADERS[currentView]();
    };
}

/* ================= SMALL HELPERS ================= */
const BONUS_DAYS = [1000, 1000, 1000, 1000, 1000, 1000, 1000];
const WHEEL_PRIZES = [100, 100, 150, 200, 250, 300, 500];
const MIN_TICKET_PRICE = 10;

const pad = n => String(n).padStart(2, "0");
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

let ledgerCache = null, ledgerAt = 0, ledgerBalance = null;
const LEDGER_CACHE_MS = 5 * 60 * 1000;
async function getLedger(force) {
    // reuse for 5 min, but read again at once if the coin balance has changed since (a new ledger entry exists)
    if (!force && ledgerCache && Date.now() - ledgerAt < LEDGER_CACHE_MS && Coins.balance === ledgerBalance) return ledgerCache;
    const qs = await Coins.getLedger(300);
    let list = qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
    // weekly / monthly tasks count the whole week + month: if the 300 latest entries stop short of it, read the rest
    const since = new Date(Math.min(new Date(monthKey(new Date()) + "T00:00:00"), new Date(weekKey(new Date()) + "T00:00:00")));
    if (list.length >= 300 && timeOf(list[list.length - 1]) > since) {
        try {
            const more = await Coins.getLedgerSince(since), seen = new Set(list.map(e => e.id));
            more.docs.forEach(d => { if (!seen.has(d.id)) list.push(Object.assign({ id: d.id }, d.data())); });
            list.sort((a, b) => timeOf(b) - timeOf(a));
        } catch (e) { /* keep the 300 latest */ }
    }
    ledgerCache = await Coins.sendNames(list);
    ledgerAt = Date.now();
    ledgerBalance = Coins.balance;
    return ledgerCache;
}

/* ================= DERIVED DATA (from the ledger) ================= */
function computeStats(L) {
    const entries = L.filter(e => e.type === "entry");
    const wins = L.filter(e => e.type === "win");
    const games = entries.length;
    const winGames = new Set(wins.map(w => w.gameId)).size;
    const coinsWon = sum(wins, w => w.amount);
    const spent = -sum(entries, e => e.amount);
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
        if (!e.gameId || (e.type !== "entry" && e.type !== "win")) return;
        const s = map.get(e.gameId) || { gameId: e.gameId, time: timeOf(e), fee: 0, won: [], net: 0 };
        if (e.type === "entry") { s.fee = -e.amount; s.time = timeOf(e); }
        else s.won.push(CLAIM_LABELS[e.prize] || e.prize);
        s.net += e.amount;
        map.set(e.gameId, s);
    });
    return [...map.values()].sort((a, b) => b.time - a.time);
}

/* ---------- tasks ---------- */
// everything a task can count, for one period (today / this week / this month)
function periodStats(L, inP) {
    const entries = L.filter(e => e.type === "entry" && inP(e));
    const wins = L.filter(e => e.type === "win" && inP(e));
    const prize = p => wins.filter(w => w.prize === p).length;
    return {
        play: entries.length,
        win: wins.length,
        jaldi: prize("jaldi"),
        lines: prize("line1") + prize("line2") + prize("line3"),
        housie: prize("housie"),
        days: new Set(entries.map(e => dayKey(timeOf(e)))).size,
        bonus: L.filter(e => e.type === "daily" && inP(e)).length,
        spin: L.filter(e => e.type === "wheel" && inP(e)).length
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
// Task ids end in "_v3": the new targets/rewards start fresh, so tasks already claimed under the old values can be earned again once.
// Daily 6 tasks, weekly 8, monthly 7. Daily refreshes at midnight, weekly on Monday 00:00, monthly on the 1st at 00:00 (device time).
// firestore.rules must allow the task ledger entries up to the biggest reward below (9500000).
const TASKS = {
    daily: [
        { id: "play20_v3", title: "Play 10 games", target: 10, reward: 5000, calc: c => c.day.play },
        { id: "play50_v3", title: "Play 25 games", target: 25, reward: 6000, calc: c => c.day.play },
        { id: "jaldi10_v3", title: "Win 10 Jaldi", target: 10, reward: 7000, calc: c => c.day.jaldi },
        { id: "line10_v3", title: "Win 10 Lines", target: 10, reward: 8000, calc: c => c.day.lines },
        { id: "win25_v3", title: "Win any 25 prizes", target: 25, reward: 9000, calc: c => c.day.win },
        { id: "housie10_v3", title: "Win 5 Housie", target: 5, reward: 10000, calc: c => c.day.housie }
    ],
    weekly: [
        { id: "w_play60_v3", title: "Play 60 games", target: 60, reward: 60000, calc: c => c.week.play },
        { id: "w_days7_v3", title: "Play on 7 different days", target: 7, reward: 50000, calc: c => c.week.days },
        { id: "w_bonus7_v3", title: "Claim the daily bonus 7 times", target: 7, reward: 55000, calc: c => c.week.bonus },
        { id: "w_win50_v3", title: "Win 50 prizes", target: 50, reward: 90000, calc: c => c.week.win },
        { id: "w_jaldi30_v3", title: "Win 30 Jaldi", target: 30, reward: 70000, calc: c => c.week.jaldi },
        { id: "w_line30_v3", title: "Win 30 Lines", target: 30, reward: 75000, calc: c => c.week.lines },
        { id: "w_play200_v3", title: "Play 200 games", target: 200, reward: 80000, calc: c => c.week.play },
        { id: "w_housie30_v3", title: "Win 30 Housie", target: 30, reward: 100000, calc: c => c.week.housie }
    ],
    monthly: [
        { id: "m_play10000_v3", title: "Play 10000 games", target: 10000, reward: 5000000, calc: c => c.month.play },
        { id: "m_win8000_v3", title: "Win 8000 prizes", target: 8000, reward: 8000000, calc: c => c.month.win },
        { id: "m_jaldi300_v3", title: "Win 300 Jaldi", target: 300, reward: 5500000, calc: c => c.month.jaldi },
        { id: "m_play20000_v3", title: "Play 20000 games", target: 20000, reward: 6000000, calc: c => c.month.play },
        { id: "m_line300_v3", title: "Win 300 Lines", target: 300, reward: 6500000, calc: c => c.month.lines },
        { id: "m_housie300_v3", title: "Win 300 Housie", target: 300, reward: 7500000, calc: c => c.month.housie },
        { id: "m_play80000_v3", title: "Play 80000 games", target: 80000, reward: 9500000, calc: c => c.month.play }
    ],
    once: [
        { id: "first_game", title: "Play your first game", target: 1, reward: 20, calc: c => c.st.games },
        { id: "first_win", title: "Win your first prize", target: 1, reward: 30, calc: c => c.st.wins },
        { id: "first_housie", title: "Win a Housie", target: 1, reward: 100, calc: c => c.st.housie },
        { id: "games25", title: "Play 25 games", target: 25, reward: 100, calc: c => c.st.games }
    ]
};
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
    } catch (err) { showNotification(err.message || "Import failed", "error"); }
    btn.lastChild.textContent = "Import data";
    btn.disabled = false;
};
$("admin-backup-export").onclick = async () => {
    const btn = $("admin-backup-export");
    btn.disabled = true;
    try {
        const data = await Coins.exportData();
        const json = JSON.stringify(data, (k, v) => (v && typeof v.toDate === "function") ? { __ts: v.toDate().toISOString() } : v, 2);
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
$("delete-cancel").onclick = () => delPopup.classList.remove("active");
$("delete-confirm").onclick = async e => {
    const btn = e.currentTarget, cancel = $("delete-cancel");
    btn.disabled = cancel.disabled = true;
    btn.textContent = "Deleting...";
    try {
        await Coins.deleteAccount();
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
        const picks = [["daily", "play20_v3"], ["daily", "win25_v3"], ["daily", "jaldi10_v3"], ["weekly", "w_play60_v3"]]
            .map(([k, id]) => taskView(k, TASKS[k].find(t => t.id === id), c));
        $("home-tasks").innerHTML = picks.map(v => `
            <div class="task-mini"><b>${esc(v.t.title)}</b>
                <div class="progress"><span style="width:${v.pct}%"></span></div>
                <small>${v.progress}/${v.t.target} · 🪙 ${v.t.reward}${v.claimed ? " · claimed" : ""}</small></div>`).join("");

        const rows = sessionsFrom(L).slice(0, 5);
        $("recent-sessions").innerHTML = rows.length ? rows.map(s => `
            <div class="row"><div><b>Room ${esc(roomOf(s.gameId))}</b>
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
        ledgerCache = null;
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
        showNotification(`${label}: +${amount} coins`, "success");
    } catch (e) {
        showNotification(e.message || "Could not claim.", "error");
    }
    if (isClaim) claimingOff(btn);
    rewardBusy.delete(id);
    ledgerCache = null;
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
    if (devInfo.busy) { showNotification("The developer is already in a challenge. Try again shortly."); return; }
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
    const oppTicketsData = generateTambolaSet(devWantedTickets);
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
                    <div class="task-side"><span class="reward">🪙 ${t.reward}</span>${side}</div></div>`;
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
            clearInterval(taskTimer); taskTimer = null; ledgerCache = null; renderEarn(); updateTaskBadge(); return;
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

async function renderProfile() {
    const u = Coins.user; if (!u) return;
    const name = myDisplayName();
    setAvatar($("profile-avatar"), name);
    $("profile-name").value = name;
    $("profile-email").textContent = u.email || "";
    $("profile-admin").classList.toggle("hidden", !Coins.isAdmin());
    applyTheme(store.get("theme", "indigo"));
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
        $("st-net").textContent = signed(st.net);
        lineChart($("chart-coins"), coinSeries(L, statsRange));
        barChart($("chart-prizes"), PRIZE_ORDER.map(k => ({ n: CLAIM_SHORT[k].replace(" Line", ""), v: st.winsList.filter(w => w.prize === k).length })));

        const dow = [0, 0, 0, 0, 0, 0, 0];
        st.entries.forEach(e => dow[timeOf(e).getDay()]++);
        const top = Math.max(...dow);
        const dayName = d => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d];
        $("st-insight").textContent = st.games
            ? `You have won prizes in ${st.winGames} of ${st.games} games and earned ${st.coinsWon} coins from prizes.${top ? " You play most on " + dayName(dow.indexOf(top)) + "s." : ""}`
            : "Play a few games to see insights here.";
    } catch (e) { }
    Coins.hostedGames().then(qs => {
        const g = qs.docs.map(d => d.data());
        $("st-hosted").textContent = g.length;
    }).catch(() => { });
}
$("range-tabs").addEventListener("click", e => {
    const t = e.target.closest(".tab[data-range]"); if (!t) return;
    statsRange = t.dataset.range;
    $("range-tabs").querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
    renderStats();
});

/* ================= HISTORY ================= */
let histFilter = "all";
async function renderHistory() {
    const list = $("history-list");
    try {
        const L = await getLedger();
        const taskTypes = ["task", "daily", "wheel", "refill", "bonus"];
        const isDevEntry = e => e.type === "deventry" || e.type === "devrefund" || (e.gameId && String(e.gameId).startsWith("dev-"));
        const rows = L.filter(e => histFilter === "all" || (histFilter === "prize" && e.type === "win") ||
            (histFilter === "entry" && e.type === "entry") || (histFilter === "task" && taskTypes.includes(e.type)) ||
            (histFilter === "shared" && (e.type === "send" || e.type === "gift")) ||
            (histFilter === "dev" && isDevEntry(e)));
        list.innerHTML = rows.length ? rows.map(t => {
            const room = t.gameId ? " · Room " + esc(roomOf(t.gameId)) : "";
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
// "See your friends' codes": every player's name, 4-digit code and coins (top 50 by coins,
// the most the rules let a normal player list). Players who never opened Share Coins have no
// code yet, so they are left out. Cached for 2 minutes so re-opening costs no extra reads.
let friendsCache = null, friendsAt = 0;
async function loadFriends(force) {
    const list = $("friends-list");
    if (!force && friendsCache && Date.now() - friendsAt < 2 * 60 * 1000) { paintFriends(); return; }
    list.innerHTML = '<p class="empty">Loading...</p>';
    try {
        const qs = await Coins.richest(50);
        friendsCache = qs.docs
            .map(d => ({ id: d.id, name: d.data().alias || d.data().name, coins: d.data().coins, code: d.data().code }))
            .filter(u => /^[0-9]{4}$/.test(String(u.code || "")));
        friendsAt = Date.now();
        paintFriends();
    } catch (e) { list.innerHTML = '<p class="empty">Could not load players right now.</p>'; }
}
function paintFriends() {
    const myId = Coins.user && Coins.user.uid;
    $("friends-list").innerHTML = (friendsCache || []).map(u => {
        const me = u.id === myId;
        return `<div class="row friend-row${me ? " me" : ""}">
            <span class="fr-name">${esc(u.name || "Player")}${me ? " (you)" : ""}</span>
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
        // the top 10 is kept for 5 minutes, so opening the screen again costs no reads
        if (!lbCache || Date.now() - lbAt > 5 * 60 * 1000) {
            const qs = await Coins.richest(10);
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
// is remembered (localStorage), so an update stays unread - and counted - until it is read.
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
    document.querySelectorAll("#screen-updates .upd-date").forEach(head => {
        const n = head.nextElementSibling ? head.nextElementSibling.querySelectorAll(".upd-item").length : 0;
        const c = head.querySelector(".upd-count");
        if (c) c.textContent = `${n} update${n === 1 ? "" : "s"}`;
    });
    refreshUpdateBadges();
}

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

function paintAdminStats() {
    const total = adminUsers.reduce((s, u) => s + (Number(u.coins) || 0), 0);
    const n = adminUsers.length;
    // no presence flag is stored on user documents, so "online" = currently inside a game room
    const online = adminUsers.filter(u => u.activeGame).length;
    const played = adminGames.filter(g => g.status === "finished").length;
    const rows = [
        ["Total users", n], ["Total users coins", "🪙 " + total],
        ["Users offline", n - online], ["Users online", online],
        ["Total games played", played]
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
        `<button type="button" class="row" data-uid="${esc(u.id)}" style="width:100%;text-align:left"><div><b>${i + 1}. ${esc(u.alias || u.name || "Player")}</b>${(u.alias || u.activeGame) ? "<small>" + [u.alias ? esc(u.name || "Player") : "", u.activeGame ? "in a game" : ""].filter(Boolean).join(" · ") + "</small>" : ""}</div><b class="pos">🪙 ${Number(u.coins) || 0}</b></button>`
    ).join("") || '<p class="empty">No users found.</p>';
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
        `<div class="row" style="flex-wrap:wrap"><div><b>Room ${esc(g.roomCode)} · ${esc(g.status)}</b><small>${g.playerCount} player(s) · 🪙${g.ticketPrice}/ticket · total coins 🪙${g.pot} · ${(g.calledNumbers || []).length} numbers · ${esc(fmtTime(g.createdAt))}</small></div>` +
        `<div class="btns"><button class="btn-outline btn-sm" data-room="players" data-gid="${esc(g.id)}">Players</button>` +
        (g.status !== "finished" ? `<button class="btn-outline btn-sm" data-room="end" data-gid="${esc(g.id)}">End</button>` : "") +
        `<button class="btn-danger btn-sm" data-room="del" data-gid="${esc(g.id)}">Delete</button></div>` +
        `<div class="room-detail hidden" id="rd-${esc(g.id)}" style="width:100%"></div></div>`
    ).join("") || '<p class="empty">No rooms.</p>';
}

var adminUnsubs = [];     // var: showView() may call stopAdminWatch() before this line has run
var adminOpenRooms = new Set();
var adminLedgerUnsub = null;
function stopAdminWatch() {
    adminUnsubs.forEach(f => { try { f(); } catch (e) { } });
    adminUnsubs = [];
    if (adminLedgerUnsub) { adminLedgerUnsub(); adminLedgerUnsub = null; }
}
async function fillRoomDetail(gid) {
    const box = $("rd-" + gid); if (!box) return;
    box.classList.remove("hidden");
    try {
        const P = await Coins.adminPlayers(gid);
        box.innerHTML = P.map(p => `<small>${esc(p.name || "Player")}${p.isHost ? " (host)" : ""} · ${p.tickets} ticket(s) · wins: ${(p.claims || []).join(", ") || "none"} · seen ${esc(fmtTime(p.lastActive))}</small>`).join("") || "<small>No players.</small>";
    } catch (e) { box.innerHTML = "<small>Could not load players.</small>"; }
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
        if (g.status !== "finished" && (age > ADMIN_STALE_MS || Number(g.playerCount) <= 0)) todo.push([g.id, "end"]);
        else if (g.status === "finished" && !g.archived) todo.push([g.id, "clean"]);
    });
    if (!todo.length) return;
    todo.forEach(t => adminSwept.add(t[0]));
    for (const [id, kind] of todo.slice(0, 20)) {
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
var adminLoadedAt = 0, adminLoading = false;
function adminStamp(text) {
    const note = document.querySelector('[data-panel="a-overview"] .live-note');
    if (note) note.textContent = text;
}
async function loadAdmin(force) {
    if (!Coins.isAdmin() || adminLoading) return;
    if (!force && adminLoadedAt && Date.now() - adminLoadedAt < 5 * 60 * 1000) return;
    adminLoading = true;
    adminStamp("Loading...");
    try {
        const [users, games] = await Promise.all([Coins.adminUsers(), Coins.adminGames()]);
        adminUsers = users; adminGames = games;
        adminLoadedAt = Date.now();
        paintAdminStats(); paintAdminUsers(); paintAdminRooms();
        adminOpenRooms.forEach(gid => fillRoomDetail(gid));
        if (adminSel && $("admin-user-popup").classList.contains("active")) {
            const u = adminUsers.find(x => x.id === adminSel.id);
            if (u) { adminSel = u; $("au-name").textContent = u.alias || u.name || "Player"; $("au-meta").textContent = `${u.id} · 🪙 ${u.coins}${u.activeGame ? " · in game " + (u.activeGame.roomId || "") : ""}`; }
        }
        adminStamp("Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · tap Refresh for the latest");
        autoReleaseUsers();
    } catch (e) {
        adminStamp("Could not load. Tap Refresh to try again.");
        showNotification((e && e.message) || "Could not load admin data", "error");
    }
    adminLoading = false;
}
// Live: users + rooms are listened to while the admin screen is open (stopped when you leave it),
// so Users online / offline, totals, lists and rooms update the moment anything changes.
function startAdminWatch() {
    if (!Coins.isAdmin() || adminUnsubs.length) return;
    adminUnsubs.push(Coins.watchAdminUsers(list => {
        adminUsers = list;
        adminLoadedAt = Date.now();
        paintAdminStats(); paintAdminUsers();
        if (adminSel && $("admin-user-popup").classList.contains("active")) {
            const u = adminUsers.find(x => x.id === adminSel.id);
            if (u) { adminSel = u; $("au-name").textContent = u.alias || u.name || "Player"; $("au-meta").textContent = `${u.id} · 🪙 ${u.coins}${u.activeGame ? " · in game " + (u.activeGame.roomId || "") : ""}`; }
        }
        adminStamp("Live · updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
        autoReleaseUsers();
    }));
    adminUnsubs.push(Coins.watchAdminGames(list => {
        adminGames = list;
        paintAdminStats(); paintAdminBulk();
        if (!adminOpenRooms.size) paintAdminRooms();   // keep an opened players list from being wiped; Refresh redraws it
        autoReleaseUsers();
    }));
}
function ensureAdminRefreshButton() {
    if ($("admin-refresh")) return;
    const note = document.querySelector('[data-panel="a-overview"] .live-note');
    if (!note) return;
    const b = document.createElement("button");
    b.id = "admin-refresh"; b.type = "button"; b.className = "btn-outline signout-btn";
    b.textContent = "Refresh";
    b.onclick = () => loadAdmin(true);
    note.parentNode.insertBefore(b, note);
}
function renderAdmin() {
    if (!Coins.isAdmin()) { showView("profile"); return; }
    ensureAdminRefreshButton();
    if (!adminLoadedAt) {
        $("admin-list").innerHTML = '<p class="empty">Loading...</p>';
        $("admin-rooms").innerHTML = '<p class="empty">Loading...</p>';
    }
    loadAdmin(false);          // balance changes also call renderAdmin: loadAdmin skips if loaded less than 5 min ago
    startAdminWatch();
}

async function openAdminUser(uid) {
    const u = adminUsers.find(x => x.id === uid); if (!u) return;
    adminSel = u;
    $("au-history").open = false;
    $("au-name").textContent = u.alias || u.name || "Player";
    $("au-alias").value = u.alias || "";
    $("au-meta").textContent = `${u.id} · 🪙 ${u.coins}${u.activeGame ? " · in game " + (u.activeGame.roomId || "") : ""}`;
    $("au-ledger").innerHTML = '<p class="empty">Loading...</p>';
    $("admin-user-popup").classList.add("active");
    if (adminLedgerUnsub) { adminLedgerUnsub(); adminLedgerUnsub = null; }
    Coins.adminLedger(uid).then(L => Coins.sendNames(L)).then(L => {
        $("au-ledger").innerHTML = L.map(t => `<div class="row"><div><b>${esc(Coins.describe(t))}</b><small>${esc(fmtTime(rowTime(t)))}${t.note ? " · " + esc(t.note) : ""}</small></div><b class="${t.amount < 0 ? "neg" : "pos"}">${t.amount > 0 ? "+" : ""}${t.amount}</b></div>`).join("") || '<p class="empty">No transactions.</p>';
    }).catch(() => { $("au-ledger").innerHTML = '<p class="empty">Could not load.</p>'; });
}
function closeAdminUser() {
    $("admin-user-popup").classList.remove("active");
    if (adminLedgerUnsub) { adminLedgerUnsub(); adminLedgerUnsub = null; }
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
var adminTxFilter = "all", adminTxAll = null, adminTxAllAt = 0, adminTxLoading = false;
const TX_ALL_PER_USER = 20, TX_ALL_SHOWN = 200, TX_USER_LIMIT = 200;
const txMs = t => { const d = rowTime(t); return d ? d.getTime() : 0; };
const adminName = u => (u && (u.alias || u.name)) || "Player";
function txRow(t, who) {
    const amt = Number(t.amount) || 0;
    return `<div class="row"><div><b>${who ? '<span class="tx-who">' + esc(who) + '</span> · ' : ""}${esc(Coins.describe(t))}</b>` +
        `<small>${esc(fmtTime(rowTime(t)))}${t.note ? " · " + esc(t.note) : ""}</small></div>` +
        `<b class="${amt < 0 ? "neg" : "pos"}">${amt > 0 ? "+" : ""}${amt}</b></div>`;
}
async function renderAdminTx(force) {
    if (!Coins.isAdmin() || adminTxLoading) return;
    const list = $("admin-tx-list"), note = $("admin-tx-note"), chipBox = $("admin-tx-filters");
    adminTxLoading = true;
    try {
        if (!adminUsers.length) { list.innerHTML = '<p class="empty">Loading...</p>'; await loadAdmin(false); }
        const byId = {}; adminUsers.forEach(u => { byId[u.id] = u; });
        // "All" button + one button per user (by name); the chosen one stays highlighted
        if (adminTxFilter !== "all" && !byId[adminTxFilter]) adminTxFilter = "all";
        chipBox.innerHTML = `<button type="button" class="chip${adminTxFilter === "all" ? " active" : ""}" data-f="all">All</button>` +
            adminUsers.slice().sort((a, b) => adminName(a).localeCompare(adminName(b)))
                .map(u => `<button type="button" class="chip${adminTxFilter === u.id ? " active" : ""}" data-f="${esc(u.id)}">${esc(adminName(u))}</button>`).join("");

        if (adminTxFilter !== "all") {
            list.innerHTML = '<p class="empty">Loading...</p>';
            let L = await Coins.adminLedger(adminTxFilter, TX_USER_LIMIT);
            L = await Coins.sendNames(L);
            note.textContent = `${L.length} transaction${L.length === 1 ? "" : "s"} · latest ${TX_USER_LIMIT} per user`;
            list.innerHTML = L.map(t => txRow(t, "")).join("") || '<p class="empty">No transactions.</p>';
        } else {
            // every user's latest entries, merged newest first (kept 5 minutes so switching tabs is free)
            if (force || !adminTxAll || Date.now() - adminTxAllAt > 5 * 60 * 1000) {
                list.innerHTML = '<p class="empty">Loading...</p>';
                const parts = await Promise.all(adminUsers.map(u =>
                    Coins.adminLedger(u.id, TX_ALL_PER_USER).then(L => L.map(t => Object.assign(t, { _uid: u.id }))).catch(() => [])));
                let all = [].concat(...parts).sort((a, b) => txMs(b) - txMs(a)).slice(0, TX_ALL_SHOWN);
                await Coins.sendNames(all);
                adminTxAll = all; adminTxAllAt = Date.now();
            }
            note.textContent = `Latest ${adminTxAll.length} across all users · tap the Transactions tab again to refresh`;
            list.innerHTML = adminTxAll.map(t => txRow(t, adminName(byId[t._uid]))).join("") || '<p class="empty">No transactions.</p>';
        }
    } catch (e) {
        list.innerHTML = '<p class="empty">Could not load transactions.</p>';
    }
    adminTxLoading = false;
}
$("admin-tx-filters").addEventListener("click", e => {
    const c = e.target.closest(".chip"); if (!c) return;
    adminTxFilter = c.dataset.f;
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
        loadAdmin(true);
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
        loadAdmin(true);
    } catch (err) { showNotification(err.message, "error"); }
    btn.disabled = false;
};
$("admin-rooms").addEventListener("click", async e => {
    const b = e.target.closest("[data-room]"); if (!b) return;
    const gid = b.dataset.gid;
    try {
        if (b.dataset.room === "players") {
            const box = $("rd-" + gid);
            if (adminOpenRooms.has(gid)) { adminOpenRooms.delete(gid); box.classList.add("hidden"); }
            else { adminOpenRooms.add(gid); box.innerHTML = "<small>Loading...</small>"; fillRoomDetail(gid); }
        } else if (b.dataset.room === "end") {
            if (!confirm("End this room now? Its temporary data is deleted; the room record and coin history are kept.")) return;
            await Coins.adminEndGame(gid); showNotification("Room ended", "success"); loadAdmin(true);
        } else if (b.dataset.room === "del") {
            if (!confirm("Delete this room and all its data? This cannot be undone.")) return;
            adminOpenRooms.delete(gid); await Coins.adminDeleteGame(gid); showNotification("Room deleted", "success"); loadAdmin(true);
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
    adminOpenRooms.clear();
    await loadAdmin(true);
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

const VIEW_LOADERS = { updates: renderUpdates, home: renderHome, lobby: initLobby, devlobby: renderDevLobby, earn: renderEarn, profile: renderProfile, stats: renderStats, history: renderHistory, share: renderShare, chat: renderChat, leaderboard: renderLeaderboard, admin: renderAdmin };

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
        const btn = pop.querySelector("#popup-close, #leave-cancel, #members-close, #au-close, #delete-cancel, [data-v='0']");
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

/* ================= CHAT (one public room for all users) =================
   Only the newest CHAT_KEEP messages are ever kept: reads restore exactly those on open,
   then 1 read per new message while the screen is open and the tab is visible (the listener
   closes when you leave the screen or hide the tab). Anything past CHAT_KEEP is deleted from
   Firestore automatically (chatTrim, below) so the backend never accumulates chat history. */
var chatUnsub = null;
var chatLive = [], chatLastSend = 0, chatFirstPaint = true, chatTrimming = false;
const CHAT_KEEP = 20, CHAT_MAX = 10000, CHAT_FOLD = 600;

function stopChat() { if (chatUnsub) { chatUnsub(); chatUnsub = null; } }
function startChat() {
    stopChat();
    if (!window.Coins || !Coins.user || document.hidden) return;
    chatUnsub = Coins.watchChat(list => { chatLive = list; paintChat(); }, CHAT_KEEP);
}
function trimChat() {
    if (chatTrimming || !window.Coins || typeof Coins.chatTrim !== "function") return;
    chatTrimming = true;
    Coins.chatTrim(CHAT_KEEP).catch(() => { }).finally(() => { chatTrimming = false; });
}
function renderChat() {
    if (!window.Coins || !Coins.user) { showView("home"); return; }
    chatLive = []; chatFirstPaint = true;
    $("chat-list").innerHTML = '<p class="empty">Loading...</p>';
    startChat();
    trimChat(); // sweep anything left over beyond the last 20 as soon as someone opens chat
}
document.addEventListener("visibilitychange", () => {
    if (currentView !== "chat") return;
    if (document.hidden) stopChat(); else startChat();
});

function chatTime(t) {
    const d = t && t.toDate ? t.toDate() : null;
    if (!d) return "";
    const same = d.toDateString() === new Date().toDateString();
    return same ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : fmtDate(d);
}
function paintChat() {
    const box = $("chat-list");
    const all = chatLive.slice().sort((a, b) => (a.time ? a.time.toMillis() : 0) - (b.time ? b.time.toMillis() : 0));
    const nearBottom = chatFirstPaint || (window.innerHeight + window.scrollY >= document.body.scrollHeight - 140);
    const me = Coins.user && Coins.user.uid;
    box.innerHTML = all.map(m => {
        const mine = m.uid === me, text = String(m.text || "");
        const long = text.length > CHAT_FOLD;
        const body = long ? esc(text.slice(0, CHAT_FOLD)) + '… <button type="button" class="chat-more" data-more="' + esc(m.id) + '">Show more</button>' : esc(text);
        return `<div class="chat-msg${mine ? " mine" : ""}" data-id="${esc(m.id)}">
            <div class="chat-meta"><b>${mine ? "You" : esc(m.name || "Player")}</b><small>${esc(chatTime(m.time))}</small></div>
            <div class="chat-text">${body}</div></div>`;
    }).join("") || '<p class="empty">No messages yet. Say hi!</p>';
    box._all = all;
    if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
    chatFirstPaint = false;
}
$("chat-list").addEventListener("click", e => {
    const box = $("chat-list");
    const more = e.target.closest("[data-more]");
    if (more) {
        const m = (box._all || []).find(x => x.id === more.dataset.more);
        if (m) more.closest(".chat-text").textContent = m.text;
    }
});
async function sendChat() {
    const input = $("chat-input"), btn = $("chat-send");
    const text = input.value.trim();
    if (!text) return;
    if (text.length > CHAT_MAX) { showNotification("That message is too long (max " + CHAT_MAX + " characters).", "error"); return; }
    if (Date.now() - chatLastSend < 1500) { showNotification("Slow down a little."); return; }
    chatLastSend = Date.now();
    btn.disabled = true;
    try {
        await Coins.chatSend(myDisplayName(), text);
        input.value = ""; input.style.height = "";
        chatFirstPaint = true;
        trimChat(); // the room just grew past CHAT_KEEP; delete the oldest message straight away
    } catch (err) { showNotification("Message not sent. Try again.", "error"); }
    btn.disabled = false;
}
$("chat-send").onclick = sendChat;
$("chat-input").addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); } });
$("chat-input").addEventListener("input", e => { const t = e.target; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; });