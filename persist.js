/* ============================================================================
   persist.js - device file storage (ROOM DATA ONLY)

   Only the room being played is kept on the device: the active room (tickets, marks, room info) and
   the numbers drawn in a "Play with Developer" match. Both are temporary and not needed afterwards.
   Everything personal (settings, coin history copy, stats) lives in Firestore - see
   Coins.cloudGet / cloudSet in script.js. Any other key is refused here so it can never end up on the phone.

   - Inside the Capacitor app (Android / iOS): read once at start into memory, every change is
     written back to Documents/housie-data.json (debounced). Backup copy: housie-data.bak.json.
   - In a normal browser (no native file access): falls back to the browser's localStorage.

   SAFETY RULE: the file is only ever written when we KNOW what is in it. If a read fails for any
   reason other than "the file is really not there" (permission, I/O error, corrupt JSON), nothing
   is written. Changes stay in memory and are merged in as soon as the file can be read again.
   A corrupt main file is copied to housie-data.corrupt.json before it can ever be replaced.

   API (sync, same shape as localStorage): getItem / setItem / removeItem
   Extra: ready (Promise), flush(), dump(), purge(text), native, where, ok
   ============================================================================ */
(function () {
    "use strict";
    const FILE = "housie-data.json", BAK = "housie-data.bak.json", BAD = "housie-data.corrupt.json", PREFIX = "housie.";
    const ROOM_KEY = /^housie\.(active\.|devcalled\.)/;   // the only keys that may be stored on the device
    const DIRS = ["DOCUMENTS", "DATA"];
    const cap = window.Capacitor;
    const FS = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.Filesystem;
    const P = { native: !!FS, where: FS ? "Documents/" + FILE : "browser storage", ok: true };
    let data = {}, dir = "DOCUMENTS", timer = null, writing = false, again = false;
    let loaded = false;          // true once `data` really reflects the file (or the file is confirmed absent)
    let dirty = {};              // changes made while not loaded: key -> string, or null for "removed"
    let lastGood = "";           // text of the last version known to be safely on disk
    const safe = new Set();      // folders we know it is OK to write into

    const parse = txt => { const o = JSON.parse(txt); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; };
    const read = (path, d) => FS.readFile({ path, directory: d, encoding: "utf8" }).then(r => r.data);
    const write = (path, d, text) => FS.writeFile({ path, directory: d, data: text, encoding: "utf8", recursive: true });
    const listNames = async d => {
        const r = await FS.readdir({ path: "", directory: d });
        return (r.files || r || []).map(x => (typeof x === "string" ? x : x.name));
    };
    const setWhere = () => { P.where = (dir === "DOCUMENTS" ? "Documents/" : "app folder/") + FILE; };

    // Reads the file. Returns true when `data` can be trusted, false when it must stay protected.
    async function load() {
        let found = null, corrupt = null, blocked = false;   // blocked: a data file is known to exist but could not be used
        const unsure = {};                                   // folder -> true when we can't be sure it holds no data
        for (const d of DIRS) {
            let names = null;
            try { names = await listNames(d); } catch (e) { }   // names stays null when the folder can't be listed
            for (const f of [FILE, BAK]) {                   // main file first, then the backup copy
                if (names && names.indexOf(f) < 0) continue; // the folder was listed and the file is really not there
                let txt;
                try { txt = await read(f, d); } catch (e) { unsure[d] = true; if (names) blocked = true; continue; }
                try { if (!found) found = { obj: parse(txt), d, f }; }
                catch (e) { unsure[d] = true; blocked = true; if (f === FILE) corrupt = txt; }
            }
            if (found) break;
        }

        if (found) {
            data = found.obj; dir = found.d; safe.add(dir);
            lastGood = JSON.stringify(data);
            if (corrupt) { try { await write(BAD, dir, corrupt); } catch (e) { } }   // keep what we could not parse
        } else {
            // nothing usable was read. Only a folder where every file is CONFIRMED absent may be written to.
            if (!blocked) DIRS.forEach(d => { if (!unsure[d]) safe.add(d); });   // an unreadable existing file: write nowhere
            if (safe.has("DOCUMENTS")) {
                dir = "DOCUMENTS";
                try { await write(FILE, "DOCUMENTS", "{}"); }
                catch (e) { if (safe.has("DATA")) dir = "DATA"; else safe.delete("DOCUMENTS"); }
            } else if (safe.has("DATA")) dir = "DATA";
            data = {}; lastGood = "";
        }

        loaded = safe.size > 0 && safe.has(dir);
        P.ok = loaded;
        if (!loaded) { console.warn("[persist] could not read the data file - writes are paused to protect it"); return false; }
        setWhere();
        // changes made before the file could be read go on top of what the file holds
        Object.keys(dirty).forEach(k => { if (dirty[k] === null) delete data[k]; else data[k] = dirty[k]; });
        const hadDirty = Object.keys(dirty).length > 0;
        dirty = {};
        if (hadDirty || (found && found.f === BAK)) schedule();     // also rebuilds a missing main file from the backup
        return true;
    }

    async function init() { if (FS) await load(); }

    async function save() {
        if (writing) { again = true; return; }
        writing = true;
        try {
            if (!loaded) await load();
            if (loaded) {
                const text = JSON.stringify(data);
                if (text !== lastGood) {
                    // the backup is the previous good version, so a bad save can never also destroy the backup
                    if (lastGood && lastGood !== "{}") { try { await write(BAK, dir, lastGood); } catch (e) { } }
                    try { await write(FILE, dir, text); }
                    catch (e) {
                        const alt = dir === "DOCUMENTS" ? "DATA" : "DOCUMENTS";
                        if (!safe.has(alt)) throw e;          // never fall back into a folder we haven't verified
                        dir = alt; setWhere();
                        await write(FILE, dir, text);
                    }
                    lastGood = text;
                }
            }
        } catch (e) { console.warn("[persist]", e); }
        writing = false;
        if (again) { again = false; save(); }
    }
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; save(); }, 400); };

    P.getItem = k => (FS ? (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null) : localStorage.getItem(k));
    P.setItem = (k, v) => {
        if (!ROOM_KEY.test(k)) { console.warn("[persist] not a room key, not stored on the device:", k); return; }
        if (FS) { data[k] = String(v); if (!loaded) dirty[k] = String(v); schedule(); }
        else localStorage.setItem(k, v);
    };
    P.removeItem = k => {
        if (FS) { delete data[k]; if (!loaded) dirty[k] = null; schedule(); }
        else localStorage.removeItem(k);
    };
    P.flush = () => { if (!FS) return Promise.resolve(); if (timer) { clearTimeout(timer); timer = null; } return save(); };

    // everything this game stores, as a plain object
    P.dump = () => {
        if (FS) return Object.assign({}, data);
        const o = {};
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.indexOf(PREFIX) === 0) o[k] = localStorage.getItem(k); }
        return o;
    };
    // removes every key that contains `text` (used when an account is deleted)
    P.purge = text => { Object.keys(P.dump()).forEach(k => { if (k.indexOf(text) !== -1) P.removeItem(k); }); return P.flush(); };

    document.addEventListener("visibilitychange", () => { if (document.hidden) P.flush(); else if (FS && !loaded) schedule(); });
    window.addEventListener("pagehide", () => { P.flush(); });
    document.addEventListener("pause", () => { P.flush(); });

    P.ready = init().catch(e => console.warn("[persist init]", e));
    window.Persist = P;
})();
