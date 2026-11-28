/* ===== FX: sounds, animation helpers, lucky wheel (merged from fx.js) ===== */
/* ============================================================================
   fx.js - sounds, animation helpers and the lucky wheel for Housie.

   - All sounds are synthesized with the Web Audio API: no audio files to ship or load.
   - Settings (sound on/off, volume, number voice) are kept in the browser's localStorage
     (not Persist: Persist only accepts room data).
   - Every call is safe: if audio is blocked or unsupported the game just stays silent.

   API (window.FX):
     FX.play(name)            click mark unmark ball coin success error info nav claim win wheelTick wheelWin
     FX.say(text)             speaks text when "Call out numbers" is on
     FX.Music.sync()          starts / stops the background music to match its settings
     FX.burst(el|{x,y}, n)    emoji particle burst
     FX.bump(el, cls)         restart a CSS animation class on an element
     FX.spinWheel(values)     opens the wheel; resolves { index, value } once it has landed (null if closed)
   ============================================================================ */
(function () {
    "use strict";
    const AC = window.AudioContext || window.webkitAudioContext;
    const LS = {
        get(k, d) { try { const v = localStorage.getItem("housie.fx." + k); return v === null ? d : v; } catch (e) { return d; } },
        set(k, v) { try { localStorage.setItem("housie.fx." + k, v); } catch (e) { } }
    };
    const reduced = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Number reading is ON by default for everyone. A one-time reset switches it on for users who still carry an old "off" value;
    // after that it only turns off when the user switches the toggle off themselves.
    if (LS.get("voiceDefaultOn", "0") !== "1") { LS.set("voice2", "1"); LS.set("sound", "1"); LS.set("voiceDefaultOn", "1"); }
    const S = { sound: LS.get("sound", "1") !== "0", voice: LS.get("voice2", "1") === "1", vol: Number(LS.get("vol", "0.6")), map: {}, pack: LS.get("pack", "classic"), rate: 1.2 };   // number call-out speed (1 = normal)
    try { S.map = JSON.parse(LS.get("map", "{}")) || {}; } catch (e) { S.map = {}; }
    let ctx = null, master = null;

    function ac() {
        if (!AC) return null;
        if (!ctx) {
            try { ctx = new AC(); master = ctx.createGain(); master.gain.value = S.vol; master.connect(ctx.destination); }
            catch (e) { ctx = null; return null; }
        }
        if (ctx.state === "suspended") ctx.resume().catch(() => { });
        return ctx;
    }
    // browsers only allow audio after a tap: unlock on the first one
    ["pointerdown", "touchstart", "keydown"].forEach(ev => document.addEventListener(ev, () => { ac(); if (window.FX && FX.Music) FX.Music.sync(); }, { once: true, passive: true }));

    // one oscillator note with a quick attack and exponential release
    function tone(o) {
        const c = ac(); if (!c || !S.sound) return;
        const t0 = c.currentTime + (o.at || 0), d = o.d || 0.15, v = o.v == null ? 0.3 : o.v;
        const osc = c.createOscillator(), g = c.createGain();
        osc.type = o.type || "sine";
        osc.frequency.setValueAtTime(o.f, t0);
        if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + d);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(v, t0 + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
        osc.connect(g); g.connect(master);
        osc.start(t0); osc.stop(t0 + d + 0.03);
    }
    // filtered noise burst (swooshes, ball knocks)
    function noise(o) {
        const c = ac(); if (!c || !S.sound) return;
        const t0 = c.currentTime + (o.at || 0), d = o.d || 0.12;
        const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * d)), c.sampleRate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
        const src = c.createBufferSource(); src.buffer = buf;
        const f = c.createBiquadFilter(); f.type = o.filter || "bandpass";
        f.frequency.setValueAtTime(o.f || 1200, t0);
        if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t0 + d);
        const g = c.createGain();
        g.gain.setValueAtTime(o.v || 0.2, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
        src.connect(f); f.connect(g); g.connect(master);
        src.start(t0);
    }
    const arp = (notes, step, o) => notes.forEach((f, i) => tone(Object.assign({ f, at: i * step }, o)));

    const SOUNDS = {
        click() { tone({ f: 440, to: 880, d: 0.07, type: "sine", v: 0.22 }); },   // soft "bloop" tap
        nav() { tone({ f: 330, to: 660, d: 0.08, type: "sine", v: 0.16 }); tone({ f: 990, d: 0.09, at: 0.05, type: "triangle", v: 0.1 }); },   // two-step "ba-ding" for screens
        mark() { tone({ f: 988, to: 1480, d: 0.07, type: "triangle", v: 0.26 }); },   // crisp one-note tap on a ticket number
        unmark() { tone({ f: 523, to: 392, d: 0.08, type: "triangle", v: 0.2 }); },
        ball() {   // a drawn number: knock + two-note chime
            noise({ d: 0.07, f: 900, v: 0.3 });
            tone({ f: 220, to: 110, d: 0.12, type: "sine", v: 0.35 });
            tone({ f: 784, d: 0.22, at: 0.08, type: "triangle", v: 0.2 });
            tone({ f: 1175, d: 0.3, at: 0.16, type: "triangle", v: 0.16 });
        },
        coin() { tone({ f: 988, d: 0.09, type: "square", v: 0.12 }); tone({ f: 1319, d: 0.32, at: 0.08, type: "square", v: 0.12 }); },
        // ---- alerts: every kind sounds different ----
        success() { arp([523, 659, 784, 1047], 0.06, { d: 0.2, type: "triangle", v: 0.22 }); tone({ f: 2093, d: 0.25, at: 0.24, type: "sine", v: 0.07 }); },   // rising sparkle
        error() { tone({ f: 392, d: 0.11, type: "square", v: 0.12 }); tone({ f: 294, d: 0.11, at: 0.12, type: "square", v: 0.12 }); tone({ f: 196, to: 150, d: 0.3, at: 0.24, type: "square", v: 0.13 }); },   // "uh-oh": three steps down
        warn() { for (let i = 0; i < 3; i++) tone({ f: 740, d: 0.09, at: i * 0.13, type: "square", v: 0.1 }); },   // triple beep
        info() { tone({ f: 1047, d: 0.5, type: "sine", v: 0.18 }); tone({ f: 2093, d: 0.35, at: 0.01, type: "sine", v: 0.05 }); },   // soft bell
        otherWin() { tone({ f: 784, d: 0.12, type: "triangle", v: 0.2 }); tone({ f: 1175, d: 0.3, at: 0.1, type: "triangle", v: 0.2 }); },   // somebody else won
        // ---- prize claims: every prize has its own tune ----
        prizeJaldi() {   // quick bright run
            arp([784, 880, 988, 1175, 1319, 1568], 0.06, { d: 0.16, type: "triangle", v: 0.24 });
            tone({ f: 2349, d: 0.4, at: 0.4, type: "sine", v: 0.08 });
        },
        prizeLine1() {   // C major arpeggio
            arp([523, 659, 784, 1047], 0.1, { d: 0.3, type: "triangle", v: 0.28 });
            tone({ f: 262, d: 0.6, type: "sine", v: 0.2 }); tone({ f: 1568, d: 0.4, at: 0.45, type: "sine", v: 0.1 });
        },
        prizeLine2() {   // higher, with a second voice
            arp([587, 740, 880, 1175, 1480], 0.09, { d: 0.3, type: "triangle", v: 0.27 });
            arp([294, 370, 440], 0.12, { d: 0.5, type: "sine", v: 0.18 });
            noise({ d: 0.4, f: 4000, to: 8000, v: 0.05, at: 0.4, filter: "highpass" });
        },
        prizeLine3() {   // full chord rise + shimmer
            arp([659, 784, 988, 1319, 1568, 1976], 0.08, { d: 0.35, type: "triangle", v: 0.26 });
            [330, 415, 494].forEach(f => tone({ f, d: 0.9, at: 0.3, type: "sine", v: 0.14 }));
            noise({ d: 0.6, f: 4000, to: 9000, v: 0.06, at: 0.45, filter: "highpass" });
        },
        win() {    // Housie: the big fanfare
            arp([523, 659, 784, 1047, 784, 1047, 1319, 1568], 0.11, { d: 0.32, type: "triangle", v: 0.3 });
            arp([262, 330, 392, 523, 659], 0.2, { d: 0.6, type: "sine", v: 0.22 });
            arp([1568, 2093, 1760, 2349, 2093, 2637], 0.07, { d: 0.2, type: "sine", v: 0.1, at: 0.8 });
            noise({ d: 0.9, f: 3000, to: 9000, v: 0.07, at: 0.9, filter: "highpass" });
            for (let i = 0; i < 5; i++) tone({ f: 988, d: 0.07, at: 1.1 + i * 0.09, type: "square", v: 0.07 });
        },
        wheelTick() { tone({ f: 1500, to: 900, d: 0.03, type: "triangle", v: 0.2 }); },
        wheelStart() { noise({ d: 0.5, f: 300, to: 3000, v: 0.14 }); },
        wheelWin() {
            arp([659, 784, 988, 1319], 0.1, { d: 0.3, type: "triangle", v: 0.28 });
            for (let i = 0; i < 6; i++) { tone({ f: 988, d: 0.07, at: 0.5 + i * 0.1, type: "square", v: 0.09 }); tone({ f: 1319, d: 0.12, at: 0.55 + i * 0.1, type: "square", v: 0.09 }); }
        }
    };
    /* ---------- sound styles: any event can use any style (Profile > Sound & effects) ---------- */
    const arpN = (fs, step, d, v, at0) => fs.map((f, i) => [f, (at0 || 0) + i * step, d, v]);
    // n = notes [freq, start, length, volume, glideTo]; g = pack group (tap / alert / prize); big = music ducks while it plays
    const EVENTS = [
        { id: "click", g: "tap", sec: "Buttons & screens", label: "Button tap", n: [[440, 0, .07, .22, 880]] },
        { id: "nav", g: "tap", sec: "Buttons & screens", label: "Open a screen", n: [[330, 0, .08, .16, 660], [990, .05, .09, .1]] },
        { id: "mark", g: "tap", sec: "On your ticket", label: "Mark a number", n: [[988, 0, .07, .26, 1480]] },
        { id: "unmark", g: "tap", sec: "On your ticket", label: "Unmark a number", n: [[523, 0, .08, .2, 392]] },
        { id: "ball", g: "tap", sec: "Draws & prizes", label: "Number drawn (when voice is off)", n: [[220, 0, .12, .3, 110], [784, .08, .22, .2], [1175, .16, .3, .16]] },
        { id: "otherWin", g: "alert", sec: "Draws & prizes", label: "Someone else wins", n: [[784, 0, .12, .2], [1175, .1, .3, .2]] },
        { id: "prizeJaldi", g: "prize", big: 1, sec: "Draws & prizes", label: "Jaldi 5 claimed", n: arpN([784, 880, 988, 1175, 1319, 1568], .06, .16, .24).concat([[2349, .4, .4, .08]]) },
        { id: "prizeLine1", g: "prize", big: 1, sec: "Draws & prizes", label: "Line 1 claimed", n: arpN([523, 659, 784, 1047], .1, .3, .28).concat([[262, 0, .6, .2], [1568, .45, .4, .1]]) },
        { id: "prizeLine2", g: "prize", big: 1, sec: "Draws & prizes", label: "Line 2 claimed", n: arpN([587, 740, 880, 1175, 1480], .09, .3, .27).concat(arpN([294, 370, 440], .12, .5, .18)) },
        { id: "prizeLine3", g: "prize", big: 1, sec: "Draws & prizes", label: "Line 3 claimed", n: arpN([659, 784, 988, 1319, 1568, 1976], .08, .35, .26).concat([330, 415, 494].map(f => [f, .3, .9, .14])) },
        { id: "win", g: "prize", big: 1, sec: "Draws & prizes", label: "Full Housie!", n: arpN([523, 659, 784, 1047, 784, 1047, 1319, 1568], .11, .32, .3).concat(arpN([262, 330, 392, 523, 659], .2, .6, .22), arpN([1568, 2093, 1760, 2349, 2093, 2637], .07, .2, .1, .8)) },
        { id: "coin", g: "tap", sec: "Coins & lucky wheel", label: "Coins earned", n: [[988, 0, .09, .14], [1319, .08, .32, .14]] },
        { id: "wheelStart", g: "tap", sec: "Coins & lucky wheel", label: "Wheel starts", n: [[300, 0, .5, .12, 1500]] },
        { id: "wheelTick", g: "tap", sec: "Coins & lucky wheel", label: "Wheel tick", n: [[1500, 0, .03, .2, 900]] },
        { id: "wheelWin", g: "prize", big: 1, sec: "Coins & lucky wheel", label: "Wheel prize", n: arpN([659, 784, 988, 1319], .1, .3, .28).concat([0, 1, 2, 3, 4, 5].reduce((a, i) => a.concat([[988, .5 + i * .1, .07, .09], [1319, .55 + i * .1, .12, .09]]), [])) },
        { id: "success", g: "alert", sec: "Alerts", label: "Success", n: arpN([523, 659, 784, 1047], .06, .2, .22) },
        { id: "error", g: "alert", sec: "Alerts", label: "Error", n: [[392, 0, .11, .14], [294, .12, .11, .14], [196, .24, .3, .14, 150]] },
        { id: "warn", g: "alert", sec: "Alerts", label: "Warning", n: [0, 1, 2].map(i => [740, i * .13, .09, .12]) },
        { id: "info", g: "alert", sec: "Alerts", label: "Info", n: [[1047, 0, .5, .18], [2093, .01, .35, .05]] }
    ];
    const EV = {}; EVENTS.forEach(e => EV[e.id] = e);
    // t wave, h harmonics [ratio, gain], dm length multiplier, v volume, lp low-pass Hz, a attack s, pm pitch multiplier, sw glide [from, to] x pitch, nz noise tick
    const INST = {
        bell: { n: "Bell", e: "🔔", t: "sine", h: [[2.76, .35], [5.4, .12]], dm: 2.2, v: .9 },
        chip: { n: "8-bit chip", e: "👾", t: "square", dm: .85, v: .5 },
        harp: { n: "Harp", e: "🪕", t: "triangle", h: [[2, .3], [3, .12]], dm: 2, v: 1 },
        synth: { n: "Synth", e: "🎹", t: "sawtooth", lp: 2200, dm: 1.1, v: .45 },
        brass: { n: "Brass", e: "🎺", t: "sawtooth", lp: 1600, a: .03, dm: 1.1, v: .4 },
        bubble: { n: "Bubble", e: "💧", t: "sine", sw: [.7, 1.5], dm: .9, v: 1.1 },
        laser: { n: "Laser", e: "⚡", t: "sawtooth", sw: [2, .45], dm: .7, v: .35 },
        wood: { n: "Wood block", e: "🪵", t: "triangle", h: [[2.4, .3]], dm: .35, nz: .35, v: 1.2 }
    };
    // one-tap packs: a style for each group of sounds
    const PACKS = [
        { id: "classic", n: "Classic", e: "🎲", tap: "classic", alert: "classic", prize: "classic" },
        { id: "retro", n: "Retro 8-bit", e: "👾", tap: "chip", alert: "chip", prize: "chip" },
        { id: "soft", n: "Soft bells", e: "🔔", tap: "bell", alert: "bell", prize: "harp" },
        { id: "wooden", n: "Wooden", e: "🪵", tap: "wood", alert: "wood", prize: "harp" },
        { id: "arcade", n: "Arcade", e: "🕹️", tap: "laser", alert: "chip", prize: "synth" },
        { id: "orchestra", n: "Orchestra", e: "🎺", tap: "harp", alert: "harp", prize: "brass" },
        { id: "bubbly", n: "Bubbly", e: "💧", tap: "bubble", alert: "bubble", prize: "bell" },
        { id: "quiet", n: "Quiet", e: "🌙", tap: "off", alert: "bell", prize: "bell" }
    ];
    function playNotes(cfg, notes) {
        const c = ac(); if (!c) return;
        const now = c.currentTime;
        notes.forEach(nt => {
            const f = nt[0], at = nt[1], dur = Math.max(.04, nt[2] * (cfg.dm || 1)), vol = Math.max(.02, nt[3] * (cfg.v || 1));
            const t0 = now + at, a = Math.min(cfg.a || .008, dur * .4);
            const g = c.createGain(); g.gain.setValueAtTime(.0001, t0);
            g.gain.exponentialRampToValueAtTime(vol, t0 + a); g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
            g.connect(master);
            let head = g;
            if (cfg.lp) { const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = cfg.lp; lp.connect(g); head = lp; }
            const base = f * (cfg.pm || 1);
            [[1, 1]].concat(cfg.h || []).forEach((hm, i) => {
                const o = c.createOscillator(), hg = c.createGain();
                o.type = i ? "sine" : cfg.t; hg.gain.value = hm[1];
                o.frequency.setValueAtTime(base * (cfg.sw ? cfg.sw[0] : 1) * hm[0], t0);
                if (cfg.sw) o.frequency.exponentialRampToValueAtTime(base * cfg.sw[1] * hm[0], t0 + dur);
                o.connect(hg); hg.connect(head); o.start(t0); o.stop(t0 + dur + .03);
            });
            if (cfg.nz) noise({ d: .04, f: 2500, v: cfg.nz, at });
        });
    }
    const last = {};
    function play(name, force) {
        if (!S.sound) return;
        const ev = EV[name]; if (!ev && !SOUNDS[name]) return;
        const now = Date.now();
        if (!force && name !== "wheelTick" && last[name] && now - last[name] < 60) return;   // never stack identical sounds
        last[name] = now;
        // Prize and win sounds (Jaldi, Lines, Housie, wheel prize) follow the music toggle: music off = they stay silent, whatever any setting says
        if (!force && ev && ev.g === "prize" && !(typeof M !== "undefined" && M && M.on)) return;
        const pick = S.map[name] || "classic";
        if (pick === "off") return;
        if (ev && ev.big) duck(2600);
        try { if (pick !== "classic" && INST[pick] && ev) playNotes(INST[pick], ev.n); else if (SOUNDS[name]) SOUNDS[name](); } catch (e) { }
    }
    const saveMap = () => LS.set("map", JSON.stringify(S.map));

    // Indian English voice (en-IN) if the device has one, else Hindi (hi-IN); voices can load late
    let voiceCache = null;
    // Browsers do not report a voice's gender, so it is judged from the voice name.
    const FEMALE = /female|woman|zira|heera|hazel|susan|samantha|veena|lekha|priya|kalpana|swara|neerja|aditi|raveena|tessa|karen|moira|fiona|victoria|serena|google.*(hindi|हिन्दी)|x-(ena|enc|ahp|hif)\b/i;
    const MALE = /\bmale\b|david|mark|ravi|hemant|prabhat|james|george|daniel|rishi|guy|x-(end|cxx|hid)\b/i;
    function indianVoice() {
        try {
            const list = speechSynthesis.getVoices() || [];
            if (!list.length) return voiceCache;
            const norm = x => String(x.lang || "").replace("_", "-").toLowerCase();
            const tag = x => (x.name || "") + " " + (x.voiceURI || "");
            const score = x => {
                const l = norm(x), t = tag(x);
                let sc = 0;
                if (l === "en-in") sc += 40; else if (/^en(-|$)/.test(l)) sc += 20; else if (l === "hi-in") sc += 10; else if (/india/i.test(x.name)) sc += 5; else return -1;
                if (FEMALE.test(t)) sc += 100;       // a female voice always beats a better-matching language
                if (MALE.test(t) && !/female/i.test(t)) sc -= 100;
                return sc;
            };
            voiceCache = list.map(x => [score(x), x]).filter(a => a[0] >= 0).sort((a, b) => b[0] - a[0]).map(a => a[1])[0] || null;
        } catch (e) { }
        return voiceCache;
    }
    if (window.speechSynthesis && speechSynthesis.addEventListener) speechSynthesis.addEventListener("voiceschanged", indianVoice);
    const canSpeak = () => S.voice && !!window.speechSynthesis && typeof SpeechSynthesisUtterance !== "undefined";
    function say(text) {
        if (!canSpeak()) return;
        try {
            speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(String(text));
            const v = indianVoice();
            if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-IN";   // Indian English accent
            u.rate = S.rate; u.pitch = 1.25;   /* a higher pitch keeps the call-out sounding female even when the device has only one voice */  u.volume = S.vol <= 0 ? 0 : Math.min(1, S.vol + 0.2); duck(1500);
            speechSynthesis.speak(u);
        } catch (e) { }
    }
    const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
    const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
    function numberWords(n) {
        n = Math.floor(Number(n));
        if (n < 20) return ONES[n];
        if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
        return String(n);
    }
    function callOut(n) {
        n = Number(n); if (!(n > 0)) return false;
        if (!canSpeak()) return false;
        say(numberWords(n));   // spelled out as words ("sixty seven", "fifty") so no voice reads it digit by digit
        return true;
    }
    // a drawn number makes ONE sound: the voice reads it out, or (voice off / unsupported) the ball chime plays
    function drawn(n) { if (!callOut(n)) play("ball"); }

    /* ---------- animation helpers ---------- */
    function bump(el, cls) {
        if (!el || reduced()) return;
        el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
        setTimeout(() => el.classList.remove(cls), 900);
    }
    function burst(target, n, emojis) {
        if (reduced()) return;
        let x, y;
        if (target && target.getBoundingClientRect) { const r = target.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
        else if (target && target.x != null) { x = target.x; y = target.y; }
        else { x = innerWidth / 2; y = innerHeight / 2; }
        emojis = emojis || ["🪙", "✨", "⭐", "🪙"];
        n = n || 14;
        for (let i = 0; i < n; i++) {
            const p = document.createElement("span");
            p.className = "fx-particle";
            p.textContent = emojis[i % emojis.length];
            const a = Math.random() * Math.PI * 2, dist = 70 + Math.random() * 110;
            p.style.left = x + "px"; p.style.top = y + "px";
            p.style.setProperty("--dx", Math.cos(a) * dist + "px");
            p.style.setProperty("--dy", Math.sin(a) * dist - 50 + "px");
            p.style.setProperty("--rot", (Math.random() * 540 - 270) + "deg");
            p.style.animationDelay = Math.random() * 0.12 + "s";
            document.body.appendChild(p);
            setTimeout(() => p.remove(), 1500);
        }
    }

    // "+500" floats up from where you tapped, the coin counter bumps, and coins rain from the top right down to half the screen
    function coinsAdded(amount, from) {
        if (reduced()) return;
        const num = Number(amount) || 0;
        let x = innerWidth / 2, y = innerHeight * 0.55;
        if (from && from.getBoundingClientRect) { const r = from.getBoundingClientRect(); if (r.width || r.height) { x = r.left + r.width / 2; y = r.top + r.height / 2; } }
        const lab = document.createElement("div");
        lab.className = "fx-plus"; lab.textContent = "+" + num.toLocaleString("en-US") + " 🪙";
        lab.style.left = Math.min(Math.max(x, 60), innerWidth - 60) + "px"; lab.style.top = y + "px";
        document.body.appendChild(lab); setTimeout(() => lab.remove(), 1800);
        // the coin counter at the top right
        const chip = Array.from(document.querySelectorAll(".coin-chip")).find(c => c.offsetParent !== null);
        let cx = innerWidth - 50;
        if (chip) { const r = chip.getBoundingClientRect(); cx = r.left + r.width / 2; bump(chip, "fx-bump"); }
        // falling coins: start at the top right, fall until half of the screen height
        const fall = Math.round(innerHeight * 0.5);
        for (let i = 0; i < 30; i++) {
            const c = document.createElement("span");
            c.className = "fx-rain"; c.textContent = i % 5 === 0 ? "✨" : "🪙";
            c.style.left = Math.min(innerWidth - 16, Math.max(16, cx + (Math.random() - 0.7) * 150)) + "px";
            c.style.setProperty("--fall", fall * (0.65 + Math.random() * 0.35) + "px");
            c.style.setProperty("--spin", (Math.random() * 720 - 360) + "deg");
            c.style.fontSize = 18 + Math.random() * 12 + "px";
            c.style.animationDelay = Math.random() * 0.7 + "s";
            c.style.animationDuration = 1.1 + Math.random() * 0.7 + "s";
            document.body.appendChild(c); setTimeout(() => c.remove(), 2800);
        }
    }

    /* ============================ BACKGROUND MUSIC ============================
       10 gaming tracks, all synthesized live (no files). A tiny step sequencer plays drums, bass, chords and a lead
       melody; everything can be customised: track, volume, speed, key, layers, auto-next, ducking under the voice. */
    const SC = {
        major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], mixo: [0, 2, 4, 5, 7, 9, 10],
        lydian: [0, 2, 4, 6, 7, 9, 11], bhairav: [0, 1, 4, 5, 7, 8, 11], harm: [0, 2, 3, 5, 7, 8, 11]
    };
    // melody: 4 bars x 8 eighth-notes. number = scale degree, _ rest, = hold. drums/bass: 8 chars per bar (x hit, o ghost, . rest)
    const TRACKS = [
        {
            n: "Lo-fi Chill", e: "🌙", d: "Slow, warm and relaxed", bpm: 76, root: 55, sc: SC.dorian, prog: [0, 3, 6, 3], swing: .15,
            drums: { k: "x....x..", s: "..x...x.", h: "o.x.o.x." }, bass: "x...5...", bw: "sine", pw: "triangle", pv: .06, lw: "triangle", lv: .13, llp: 2200, echo: 1,
            mel: ["4 _ 2 _ 0 = 2 _", "5 = _ 7 _ 5 3 _", "4 _ 6 = _ 8 6 _", "5 _ 3 = _ 2 _ 3"]
        },
        {
            n: "8-bit Adventure", e: "🎮", d: "Cheerful retro quest", bpm: 140, root: 60, sc: SC.major, prog: [0, 4, 5, 3], chip: 1,
            drums: { k: "x...x...", s: "..x...x.", h: "xxxxxxxx" }, bass: "xoxoxoxo", bw: "square", pw: "square", pv: .025, arp: [0, 2, 4, 2], aw: "square", lw: "square", lv: .08, llp: 5000, alt: 1,
            mel: ["4 4 7 = 4 2 0 2", "8 = 6 4 6 8 11 8", "9 = 7 5 7 9 7 5", "7 5 3 = 5 7 4 7"]
        },
        {
            n: "Arcade Rush", e: "🕹️", d: "Fast, driving and tense", bpm: 160, root: 57, sc: SC.minor, prog: [0, 5, 2, 6], chip: 1,
            drums: { k: "x.x.x.x.", s: "..x...x.", h: "xxxxxxxx" }, bass: "xxxxxxxx", bw: "sawtooth", pw: "sawtooth", pv: .02, plp: 1200, arp: [0, 2, 4, 7], aw: "square", lw: "sawtooth", lv: .08, llp: 3500, alt: 1,
            mel: ["7 = 4 7 9 = 7 4", "9 = 7 9 11 = 9 7", "6 = 4 6 7 = 6 4", "8 6 8 10 9 8 6 4"]
        },
        {
            n: "Casino Night", e: "🎰", d: "Jazzy, swinging lounge", bpm: 120, root: 60, sc: SC.major, prog: [0, 5, 3, 4], swing: .2,
            drums: { k: "x...x...", s: "..x...x.", h: "x.xxx.xx" }, bass: "x.5.o.5.", bw: "triangle", pw: "triangle", pv: .05, lw: "triangle", lv: .14, llp: 3000,
            mel: ["4 = 2 4 7 = 6 4", "9 = 7 5 = 7 9 7", "7 = 5 3 5 7 = 5", "6 4 6 8 = 7 6 4"]
        },
        {
            n: "Space Odyssey", e: "🚀", d: "Floating, dreamy and wide", bpm: 90, root: 52, sc: SC.lydian, prog: [0, 1, 4, 1],
            drums: { k: "x.......", s: "....x...", h: "..x...x." }, bass: "x.......", bw: "sine", pw: "sawtooth", pv: .035, plp: 900, pa: .5, arp: [0, 2, 4, 2], aw: "triangle", lw: "sine", lv: .14, llp: 4000, echo: 1, la: .05,
            mel: ["5 _ _ 8 = = 7 _", "5 _ _ 8 = = 7 _", "8 _ _ 6 = = 4 _", "5 _ 3 = = 1 _ _"]
        },
        {
            n: "Jungle Quest", e: "🌴", d: "Tribal drums and adventure", bpm: 128, root: 62, sc: SC.mixo, prog: [0, 6, 3, 0],
            drums: { k: "x..xx...", s: "..x...x.", h: "x.x.x.xx" }, bass: "x.x.5.x.", bw: "triangle", pw: "triangle", pv: .045, lw: "triangle", lv: .15, llp: 2600, alt: 1,
            mel: ["4 4 2 = 4 7 = 4", "6 = 8 6 = 4 6 8", "5 5 3 = 5 7 = 5", "7 4 2 4 2 = 0 _"]
        },
        {
            n: "Epic Quest", e: "⚔️", d: "Big, heroic and powerful", bpm: 112, root: 50, sc: SC.minor, prog: [0, 5, 6, 0],
            drums: { k: "x...x...", s: "....x...", h: "o...o..." }, bass: "x.x.x.x.", bw: "sawtooth", pw: "sawtooth", pv: .04, plp: 1100, pa: .25, lw: "sawtooth", lv: .09, llp: 1800, la: .04, alt: 1,
            mel: ["7 = = 4 7 = 9 =", "9 = = 7 9 = 11 =", "10 = = 8 = 6 8 =", "7 = 4 = 2 = 0 _"]
        },
        {
            n: "Synthwave Drive", e: "🌆", d: "Neon night-time cruising", bpm: 108, root: 57, sc: SC.minor, prog: [0, 5, 3, 6],
            drums: { k: "x.x.x.x.", s: "..x...x.", h: "oxoxoxox" }, bass: "xxxxxxxx", bw: "sawtooth", pw: "sawtooth", pv: .03, plp: 1400, pa: .1, arp: [0, 2, 4, 2], aw: "sawtooth", lw: "sawtooth", lv: .07, llp: 2600, echo: 1, alt: 1,
            mel: ["7 = 4 = 7 9 = 7", "9 = 7 = 9 11 = 9", "7 = 5 = 7 8 = 7", "8 = 6 = 8 10 = 8"]
        },
        {
            n: "Bazaar Beat", e: "🪔", d: "Indian-flavoured festival groove", bpm: 118, root: 50, sc: SC.bhairav, prog: [0, 3, 0, 4], swing: .08,
            drums: { k: "x..x..x.", s: "..x...x.", h: "x.x.x.x." }, bass: "x.x.5.x.", bw: "triangle", pw: "triangle", pv: .045, lw: "sawtooth", lv: .08, llp: 2400, echo: 1,
            mel: ["4 = 5 4 2 1 = 0", "5 = 3 2 = 1 0 _", "2 4 = 5 4 = 2 0", "4 = 5 6 7 = 6 4"]
        },
        {
            n: "Mystery Dungeon", e: "🕯️", d: "Dark, slow and suspenseful", bpm: 84, root: 52, sc: SC.harm, prog: [0, 5, 4, 0],
            drums: { k: "x.......", s: "........", h: "....o..." }, bass: "x...x...", bw: "sine", pw: "sine", pv: .05, pa: .4, lw: "triangle", lv: .13, llp: 2500, echo: 1,
            mel: ["4 _ 2 = _ 0 _ _", "5 _ 7 = _ 9 _ 7", "6 = _ 4 _ 6 = _", "2 _ 0 = = _ _ _"]
        },
        {
            n: "Boss Battle", e: "🐉", d: "Heavy, fast and intense", bpm: 150, root: 52, sc: SC.minor, prog: [0, 0, 5, 6],
            drums: { k: "x.x.x.x.", s: "..x...x.", h: "xxxxxxxx" }, bass: "xxoxxxox", bw: "sawtooth", pw: "sawtooth", pv: .03, plp: 1300, lw: "sawtooth", lv: .08, llp: 3000, alt: 1,
            mel: ["7 = 4 7 = 9 7 4", "7 = 4 7 = 9 7 4", "9 = 7 9 = 11 9 7", "8 6 8 10 = 9 8 6"]
        },
        {
            n: "Tropical Beach", e: "🏝️", d: "Sunny, breezy and easygoing", bpm: 100, root: 60, sc: SC.major, prog: [0, 3, 4, 0], swing: .1,
            drums: { k: "x....x..", s: "..x...x.", h: "x.x.x.x." }, bass: "x...5...", bw: "triangle", pw: "triangle", pv: .05, lw: "sine", lv: .15, llp: 3500, echo: 1,
            mel: ["4 = 2 4 = 7 4 2", "5 = 3 5 = 7 5 3", "6 = 4 6 = 8 6 4", "4 2 0 = 2 = 0 _"]
        },
        {
            n: "Festival Dhol", e: "🥁", d: "Loud, joyful celebration beat", bpm: 132, root: 57, sc: SC.mixo, prog: [0, 6, 0, 4],
            drums: { k: "x..x.x..", s: "..x...xx", h: "x.xxx.xx" }, bass: "x.x.x.5.", bw: "triangle", pw: "triangle", pv: .04, lw: "sawtooth", lv: .08, llp: 2200, echo: 1, alt: 1,
            mel: ["4 4 = 7 = 6 4 2", "6 6 = 8 = 7 6 4", "4 4 = 7 = 9 7 4", "6 = 4 = 8 = 4 _"]
        },
        {
            n: "Cosmic Lullaby", e: "✨", d: "Gentle, calm and sleepy", bpm: 66, root: 60, sc: SC.major, prog: [0, 4, 5, 3],
            drums: { k: "........", s: "........", h: "......o." }, bass: "x.......", bw: "sine", pw: "sine", pv: .06, pa: .5, arp: [0, 2, 4, 7], aw: "sine", lw: "sine", lv: .13, llp: 3000, echo: 1, la: .03,
            mel: ["4 _ _ 2 = _ 0 _", "6 _ _ 4 = _ 2 _", "7 _ _ 5 = _ 4 _", "5 _ _ 3 = _ 0 _"]
        }
    ];
    TRACKS.forEach(T => {   // compile melody strings once: step -> { deg, len }
        T.L = {}; let prev = null, step = 0;
        T.mel.forEach(bar => bar.split(" ").forEach(tok => {
            if (tok === "=") { if (prev) prev.len++; }
            else if (tok !== "_") { prev = { deg: Number(tok), len: 1 }; T.L[step] = prev; }
            else prev = null;
            step++;
        }));
    });
    const MDEF = { on: false, track: 0, vol: .7, tempo: 100, key: 0, drums: true, bass: true, chords: true, lead: true, duck: true, auto: false, game: false };
    let M = Object.assign({}, MDEF);
    try { Object.assign(M, JSON.parse(LS.get("music", "{}")) || {}); } catch (e) { }
    if (!TRACKS[M.track]) M.track = 0;
    const saveMusic = () => LS.set("music", JSON.stringify(M));
    const midi = m => 440 * Math.pow(2, (m - 69) / 12);
    const degMidi = (T, d) => { const n = T.sc.length; return T.root + M.key + T.sc[((d % n) + n) % n] + 12 * Math.floor(d / n); };

    let mTimer = null, mStep = 0, mNext = 0, mLoops = 0, mBus = null, mDuck = null, mEcho = null, nbuf = null, curView = "welcome";
    function musicNodes(c) {
        if (mBus) return;
        mBus = c.createGain(); mDuck = c.createGain(); mBus.gain.value = M.vol * 1.3;
        const lim = c.createDynamicsCompressor(); mBus.connect(mDuck); mDuck.connect(lim); lim.connect(c.destination);   // limiter keeps the louder mix from clipping
        mEcho = c.createDelay(1); mEcho.delayTime.value = .34;
        const fb = c.createGain(), ef = c.createGain(); fb.gain.value = .35; ef.gain.value = .5;
        mEcho.connect(fb); fb.connect(mEcho); mEcho.connect(ef); ef.connect(mBus);
    }
    function mTone(o) {
        const c = ctx, g = c.createGain(), a = Math.min(o.a || .01, o.d * .5), osc = c.createOscillator();
        g.gain.setValueAtTime(.0001, o.at); g.gain.exponentialRampToValueAtTime(o.v, o.at + a); g.gain.exponentialRampToValueAtTime(.0001, o.at + o.d);
        osc.type = o.t; osc.frequency.setValueAtTime(o.f, o.at);
        if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, o.at + o.d);
        if (o.lp) { const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = o.lp; osc.connect(f); f.connect(g); } else osc.connect(g);
        g.connect(mBus); if (o.echo) g.connect(mEcho);
        osc.start(o.at); osc.stop(o.at + o.d + .05);
    }
    function mNoise(at, d, v, type, freq) {
        const c = ctx;
        if (!nbuf) { nbuf = c.createBuffer(1, Math.floor(c.sampleRate * .6), c.sampleRate); const ch = nbuf.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1; }
        const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
        s.buffer = nbuf; f.type = type; f.frequency.value = freq;
        g.gain.setValueAtTime(v, at); g.gain.exponentialRampToValueAtTime(.0001, at + d);
        s.connect(f); f.connect(g); g.connect(mBus); s.start(at, Math.random() * .3); s.stop(at + d + .02);
    }
    function schedStep(T, step, t, spb) {
        const i = step % 8, bar = Math.floor(step / 8) % T.prog.length, r = T.prog[bar];
        if (T.swing && i % 2) t += spb * T.swing;
        if (M.drums) {
            const k = T.drums.k[i], s = T.drums.s[i], h = T.drums.h[i];
            if (k !== ".") mTone({ f: 150, to: 45, t: T.chip ? "square" : "sine", at: t, d: .15, v: k === "x" ? .5 : .25 });
            if (s !== ".") { mNoise(t, .13, s === "x" ? .28 : .12, "bandpass", 1800); mTone({ f: 200, to: 120, t: "triangle", at: t, d: .08, v: .12 }); }
            if (h !== ".") mNoise(t, .04, h === "x" ? .12 : .05, "highpass", 7500);
        }
        if (M.bass && T.bass[i] !== ".") {
            const ch = T.bass[i], deg = ch === "5" ? r + 4 - 7 : ch === "o" ? r : r - 7;
            mTone({ f: midi(degMidi(T, deg)), t: T.bw, at: t, d: spb * 1.7, v: .26, lp: 700, a: .01 });
        }
        if (M.chords) {
            if (i === 0) [0, 2, 4].forEach(k => mTone({ f: midi(degMidi(T, r + k)), t: T.pw, at: t, d: spb * 7.6, v: T.pv, a: T.pa || .15, lp: T.plp || 1800 }));
            if (T.arp) mTone({ f: midi(degMidi(T, r + T.arp[i % T.arp.length] + 7)), t: T.aw, at: t, d: spb * .8, v: .035, lp: 3500 });
        }
        const ev = T.L[step % 32];
        if (M.lead && ev) mTone({ f: midi(degMidi(T, ev.deg) + (T.alt && mLoops % 2 ? 12 : 0)), t: T.lw, at: t, d: spb * ev.len * .92, v: T.lv, lp: T.llp, echo: T.echo, a: T.la || .01 });
    }
    function mTick() {
        const c = ctx; if (!c || !mBus) return;
        const T = TRACKS[M.track], spb = 60 / (T.bpm * M.tempo / 100) / 2;
        if (mNext < c.currentTime - .5) mNext = c.currentTime + .05;   // fell far behind (tab was throttled): resync
        while (mNext < c.currentTime + .15) {
            schedStep(T, mStep, mNext, spb); mNext += spb; mStep++;
            if (mStep >= 32) {
                mStep = 0; mLoops++;
                if (M.auto && mLoops >= 4) { mLoops = 0; M.track = (M.track + 1) % TRACKS.length; saveMusic(); paintMusic(); }
            }
        }
    }
    const musicAllowed = () => M.on && (!M.game || curView === "arena" || curView === "devlobby");
    function musicStop() {
        if (!mTimer) return;
        clearInterval(mTimer); mTimer = null;
        const bus = mBus, c = ctx; mBus = null; mDuck = null; mEcho = null;
        if (bus && c) { try { bus.gain.cancelScheduledValues(c.currentTime); bus.gain.setTargetAtTime(0, c.currentTime, .08); } catch (e) { } setTimeout(() => { try { bus.disconnect(); } catch (e) { } }, 600); }
    }
    function musicStart() {
        const c = ac(); if (!c || mTimer || !musicAllowed()) return;
        musicNodes(c);
        mBus.gain.setValueAtTime(0, c.currentTime); mBus.gain.linearRampToValueAtTime(M.vol * 1.3, c.currentTime + .8);
        mStep = 0; mLoops = 0; mNext = c.currentTime + .08;
        mTimer = setInterval(mTick, 30); mTick();
    }
    function musicSync() { if (musicAllowed() && !document.hidden) musicStart(); else musicStop(); }
    function musicRestart() { musicStop(); musicSync(); }
    function duck(ms) {
        if (!M.duck || !mDuck || !mTimer) return;
        const t = ctx.currentTime; mDuck.gain.cancelScheduledValues(t);
        mDuck.gain.setTargetAtTime(.22, t, .05); mDuck.gain.setTargetAtTime(1, t + ms / 1000, .35);
    }
    document.addEventListener("visibilitychange", () => musicSync());
    const Music = { sync: musicSync, view(id) { curView = id; if (M.game) musicSync(); }, state: M, tracks: TRACKS };

    /* ---------- customise screens (packs, per-sound styles, music) ---------- */
    const $id = x => document.getElementById(x);
    const paintRange = el => el.style.setProperty("--pct", ((el.value - el.min) / (el.max - el.min) * 100) + "%");
    const paintRanges = () => document.querySelectorAll(".fx-card input[type=range]").forEach(paintRange);
    const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[ch]);
    const styleOptions = cur => [["classic", "🎲 Classic (original)"], ["off", "🔇 Silent"]].concat(Object.keys(INST).map(k => [k, INST[k].e + " " + INST[k].n]))
        .map(o => "<option value=\"" + o[0] + "\"" + (o[0] === cur ? " selected" : "") + ">" + esc(o[1]) + "</option>").join("");
    function paintPacks() {
        const box = $id("fx-packs"); if (!box) return;
        box.innerHTML = PACKS.map(p => "<div class=\"fx-pack" + (S.pack === p.id ? " active" : "") + "\" role=\"button\" tabindex=\"0\" data-pack=\"" + p.id + "\"><span>" + p.e + "</span><b>" + esc(p.n) + "</b></div>").join("");
        const c = $id("fx-pack-note"); if (c) c.textContent = S.pack === "custom" ? "Custom mix - you changed individual sounds below." : "";
    }
    function paintEvents() {
        const box = $id("fx-events"); if (!box) return;
        let html = "", sec = "";
        EVENTS.forEach(ev => {
            if (ev.sec !== sec) { sec = ev.sec; html += "<div class=\"fx-sec\">" + esc(sec) + "</div>"; }
            html += "<div class=\"fx-row\"><span class=\"fx-lab\">" + esc(ev.label) + "</span><select data-ev=\"" + ev.id + "\" aria-label=\"" + esc(ev.label) + "\">" + styleOptions(S.map[ev.id] || "classic") + "</select><button type=\"button\" class=\"fx-play\" data-prev=\"" + ev.id + "\" aria-label=\"Preview\"><svg viewBox=\"0 0 24 24\" width=\"14\" height=\"14\" aria-hidden=\"true\"><path d=\"M8 5v14l11-7z\" fill=\"currentColor\"/></svg></button></div>";
        });
        box.innerHTML = html;
    }
    function paintMusic() {
        const tr = $id("fx-tracks"); if (!tr) return;
        tr.innerHTML = TRACKS.map((T, i) => "<div class=\"fx-track" + (M.track === i ? " active" : "") + (M.track === i && M.on ? " playing" : "") + "\" role=\"button\" tabindex=\"0\" data-track=\"" + i + "\"><span class=\"fx-t-ico\">" + T.e + "</span><span class=\"fx-t-txt\"><b>" + esc(T.n) + "</b><small>" + esc(T.d) + " · " + T.bpm + " BPM</small></span></div>").join("");
        const set = (id, fn) => { const el = $id(id); if (el) fn(el); };
        set("fx-music-on", el => el.checked = M.on);
        set("fx-music-vol", el => el.value = Math.round(M.vol * 100));
        set("fx-music-tempo", el => el.value = M.tempo); set("fx-music-tempo-v", el => el.textContent = M.tempo + "%");
        set("fx-music-key", el => el.value = M.key); set("fx-music-key-v", el => el.textContent = (M.key > 0 ? "+" : "") + M.key);
        ["drums", "bass", "chords", "lead", "duck", "auto", "game"].forEach(k => set("fx-m-" + k, el => el.checked = !!M[k]));
        paintRanges();
    }
    function buildAdvanced() {
        const packs = $id("fx-packs"), evs = $id("fx-events"), mus = $id("fx-music-card");
        if (!packs && !evs && !mus) return;
        paintPacks(); paintEvents(); paintMusic();
        if (packs) {
            const pick = el => {
                const p = PACKS.find(x => x.id === el.dataset.pack); if (!p) return;
                EVENTS.forEach(ev => { S.map[ev.id] = p[ev.g]; });
                if (p.id === "classic") S.map = {};
                S.pack = p.id; LS.set("pack", S.pack); saveMap(); paintPacks(); paintEvents(); play("success", true);
            };
            packs.addEventListener("click", e => { const el = e.target.closest("[data-pack]"); if (el) pick(el); });
        }
        if (evs) {
            evs.addEventListener("change", e => {
                const sel = e.target.closest("select[data-ev]"); if (!sel) return;
                S.map[sel.dataset.ev] = sel.value; S.pack = "custom"; LS.set("pack", S.pack); saveMap(); paintPacks(); play(sel.dataset.ev, true);
            });
            evs.addEventListener("click", e => { const b = e.target.closest("[data-prev]"); if (b) play(b.dataset.prev, true); });
        }
        const reset = $id("fx-reset-sounds");
        if (reset) reset.onclick = () => { S.map = {}; S.pack = "classic"; LS.set("pack", "classic"); saveMap(); paintPacks(); paintEvents(); play("success", true); };
        if (!mus) return;
        const on = (id, fn) => { const el = $id(id); if (el) el.oninput = el.onchange = fn; };
        on("fx-music-on", () => { M.on = $id("fx-music-on").checked; if (M.on) { try { window.nbMark && nbMark("music"); } catch (e) { } } saveMusic(); paintMusic(); if (M.on) { ac(); musicRestart(); } else musicStop(); });
        on("fx-music-vol", () => { M.vol = $id("fx-music-vol").value / 100; if (mBus) mBus.gain.value = M.vol * 1.3; saveMusic(); });
        on("fx-music-tempo", () => { M.tempo = Number($id("fx-music-tempo").value); $id("fx-music-tempo-v").textContent = M.tempo + "%"; saveMusic(); });
        on("fx-music-key", () => { M.key = Number($id("fx-music-key").value); $id("fx-music-key-v").textContent = (M.key > 0 ? "+" : "") + M.key; saveMusic(); });
        ["drums", "bass", "chords", "lead", "duck", "auto"].forEach(k => on("fx-m-" + k, () => { M[k] = $id("fx-m-" + k).checked; saveMusic(); }));
        on("fx-m-game", () => { M.game = $id("fx-m-game").checked; saveMusic(); musicSync(); });
        $id("fx-tracks").addEventListener("click", e => {
            const el = e.target.closest("[data-track]"); if (!el) return;
            M.track = Number(el.dataset.track); M.on = true; saveMusic(); ac(); paintMusic(); musicRestart();
        });
        $id("fx-reset-music").onclick = () => { const wasOn = M.on; M = Object.assign(M, MDEF, { on: wasOn }); Music.state = M; saveMusic(); paintMusic(); musicRestart(); };
    }

    /* ---------- global button click sound + press feel ---------- */
    document.addEventListener("click", e => {
        const b = e.target.closest && e.target.closest("button, .nav-item, .chip, .tab, [data-open]");
        if (!b || b.disabled || b.closest(".fx-wheel")) return;
        if (b.closest(".number-cell") || b.id === "btn-draw" || b.classList.contains("claim-btn")) return;
        play(b.matches(".nav-item, [data-open]") ? "nav" : "click");
    }, true);

    /* ---------- sound settings (Profile > Sound & effects screen) ---------- */
    function buildSettings() {
        const sEl = document.getElementById("fx-sound"), vEl = document.getElementById("fx-voice"), volEl = document.getElementById("fx-vol");
        if (!sEl || !vEl || !volEl) return;
        sEl.checked = S.sound; vEl.checked = S.voice; volEl.value = Math.round(S.vol * 100);
        sEl.onchange = () => { S.sound = sEl.checked; LS.set("sound", S.sound ? "1" : "0"); if (S.sound) play("success"); };
        vEl.onchange = () => { S.voice = vEl.checked; LS.set("voice2", S.voice ? "1" : "0"); if (S.voice) { S.sound = true; sEl.checked = true; LS.set("sound", "1"); callOut(47); } };
        volEl.oninput = () => { S.vol = volEl.value / 100; if (master) master.gain.value = S.vol; LS.set("vol", String(S.vol)); };
        volEl.onchange = () => play("coin");
        buildAdvanced();
        paintRanges();
        document.addEventListener("input", e => { if (e.target.matches && e.target.matches(".fx-card input[type=range]")) paintRange(e.target); });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildSettings); else buildSettings();

    /* ============================ LUCKY WHEEL ============================ */
    const PALETTE = [["#6366f1", "#4f46e5"], ["#f59e0b", "#d97706"], ["#10b981", "#059669"], ["#ec4899", "#db2777"],
    ["#0ea5e9", "#0284c7"], ["#a855f7", "#9333ea"], ["#ef4444", "#dc2626"], ["#14b8a6", "#0d9488"]];
    let wheelEl = null, wheelRot = 0, spinning = false;

    function drawWheel(canvas, values) {
        const size = 320, dpr = Math.min(window.devicePixelRatio || 1, 3);
        canvas.width = canvas.height = size * dpr;
        const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const cx = size / 2, cy = size / 2, n = values.length, seg = Math.PI * 2 / n, top = -Math.PI / 2;
        const OUT = size / 2 - 2, RIM = 16, R = OUT - RIM, HUB = 27;       // outer edge, rim width, slice radius, hub radius
        const big = Math.max.apply(null, values);                           // the biggest prize gets the gold (jackpot) slice
        g.clearRect(0, 0, size, size);

        // rim: gold ring with a thin dark line where it meets the slices
        const rim = g.createLinearGradient(0, 0, 0, size);
        rim.addColorStop(0, "#fde68a"); rim.addColorStop(.5, "#f59e0b"); rim.addColorStop(1, "#b45309");
        g.beginPath(); g.arc(cx, cy, OUT, 0, Math.PI * 2); g.fillStyle = rim; g.fill();
        g.beginPath(); g.arc(cx, cy, R + 1.5, 0, Math.PI * 2); g.lineWidth = 3; g.strokeStyle = "rgba(120,53,15,.65)"; g.stroke();

        // slices
        values.forEach((val, i) => {
            const a0 = top + i * seg, a1 = a0 + seg;
            const [c1, c2] = n > 1 && val === big ? ["#fde047", "#f59e0b"] : PALETTE[i % PALETTE.length];
            const grd = g.createRadialGradient(cx, cy, HUB, cx, cy, R);
            grd.addColorStop(0, c1); grd.addColorStop(1, c2);
            g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a0, a1); g.closePath();
            g.fillStyle = grd; g.fill();
            g.lineWidth = 2; g.strokeStyle = "rgba(255,255,255,.6)"; g.stroke();
        });

        // rim studs: exactly on the line between two slices, so they always line up with the pointer
        for (let i = 0; i < n; i++) {
            const a = top + i * seg, r = R + RIM / 2 + 1;
            g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 3, 0, Math.PI * 2);
            g.fillStyle = "#fffbeb"; g.shadowColor = "rgba(120,53,15,.6)"; g.shadowBlur = 3; g.fill(); g.shadowBlur = 0;
        }

        // labels: every number is centred in the same band (between hub and rim), reads outward along the
        // slice's middle line, and uses ONE font size for the whole wheel (the widest number decides it)
        const r0 = HUB + 11, r1 = R - 10, mid = (r0 + r1) / 2, maxW = r1 - r0;
        const texts = values.map(v => Number(v).toLocaleString("en-US"));
        let fs = 22; const font = s => `800 ${s}px Poppins, system-ui, sans-serif`;
        g.font = font(fs);
        const widest = texts.reduce((w, t) => Math.max(w, g.measureText(t).width), 0);
        if (widest > maxW) fs = Math.max(11, Math.floor(fs * maxW / widest));
        g.font = font(fs); g.textAlign = "center"; g.textBaseline = "alphabetic";
        values.forEach((val, i) => {
            const isBig = n > 1 && val === big, m = g.measureText(texts[i]);
            const dy = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;   // true vertical centre of the digits
            g.save();
            g.translate(cx, cy); g.rotate(top + i * seg + seg / 2);
            g.fillStyle = isBig ? "#78350f" : "#fff";
            g.shadowColor = isBig ? "transparent" : "rgba(0,0,0,.4)"; g.shadowBlur = 4;
            g.fillText(texts[i], mid, dy);
            g.restore();
        });

        // hub
        g.save();
        g.shadowColor = "rgba(0,0,0,.35)"; g.shadowBlur = 8;
        const hub = g.createRadialGradient(cx - 7, cy - 7, 2, cx, cy, HUB);
        hub.addColorStop(0, "#fff"); hub.addColorStop(1, "#cbd5e1");
        g.beginPath(); g.arc(cx, cy, HUB, 0, Math.PI * 2); g.fillStyle = hub; g.fill();
        g.restore();
        g.beginPath(); g.arc(cx, cy, HUB, 0, Math.PI * 2); g.lineWidth = 4; g.strokeStyle = "#fbbf24"; g.stroke();
        g.font = "22px system-ui, 'Apple Color Emoji', 'Noto Color Emoji'"; g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText("🎡", cx, cy + 1);
    }

    function buildWheel() {
        const el = document.createElement("div");
        el.className = "fx-overlay fx-wheel";
        el.innerHTML =
            `<div class="fx-wheel-box" role="dialog" aria-label="Try your luck">
                <button class="fx-wheel-close icon-btn" type="button" aria-label="Close">✕</button>
                <div class="fx-wheel-head">
                    <h3>🎡 Try your luck</h3>
                    <p class="fx-wheel-sub">Spin the wheel and win coins!</p>
                </div>
                <div class="fx-wheel-stage">
                    <div class="fx-wheel-pointer" aria-hidden="true"></div>
                    <canvas class="fx-wheel-canvas"></canvas>
                </div>
                <div class="fx-wheel-result" aria-live="polite"></div>
                <button class="btn-primary fx-wheel-go" type="button">SPIN</button>
            </div>`;
        document.body.appendChild(el);
        return el;
    }

    // Opens the wheel. `values` are the prize amounts printed on it; the winner is picked here at random.
    function spinWheel(values, forceIndex) {
        if (spinning) return Promise.resolve(null);
        return new Promise(resolve => {
            if (!wheelEl) wheelEl = buildWheel();
            const box = wheelEl.querySelector(".fx-wheel-box"), canvas = wheelEl.querySelector(".fx-wheel-canvas");
            const go = wheelEl.querySelector(".fx-wheel-go"), close = wheelEl.querySelector(".fx-wheel-close");
            const result = wheelEl.querySelector(".fx-wheel-result"), pointer = wheelEl.querySelector(".fx-wheel-pointer");
            const n = values.length, seg = 360 / n;
            drawWheel(canvas, values);
            wheelRot = 0; canvas.style.transform = "rotate(0deg)";
            result.textContent = ""; result.classList.remove("show");
            go.disabled = false; go.textContent = "SPIN"; close.disabled = false;
            box.classList.remove("won");
            wheelEl.classList.add("active");
            let done = false;

            const finish = val => { if (done) return; done = true; wheelEl.classList.remove("active"); go.onclick = close.onclick = wheelEl.onclick = null; resolve(val); };
            close.onclick = () => { if (!spinning) finish(null); };
            wheelEl.onclick = e => { if (e.target === wheelEl && !spinning) finish(null); };

            go.onclick = () => {
                if (spinning) return;
                spinning = true; go.disabled = true; close.disabled = true; go.textContent = "Spinning...";
                const index = Number.isInteger(forceIndex) && forceIndex >= 0 && forceIndex < n ? forceIndex : Math.floor(Math.random() * n);
                // land somewhere inside the winning slice (not on its edge)
                const centre = index * seg + seg / 2, jitter = (Math.random() - 0.5) * seg * 0.6;
                const base = ((wheelRot % 360) + 360) % 360;
                const target = ((360 - centre - jitter) % 360 + 360) % 360;
                const turns = 5 + Math.floor(Math.random() * 3);
                const delta = turns * 360 + ((target - base) % 360 + 360) % 360;
                const from = wheelRot, dur = reduced() ? 1200 : 5200, t0 = performance.now();
                let lastSeg = Math.floor(((from % 360) + 360) % 360 / seg);
                play("wheelStart");
                const ease = t => 1 - Math.pow(1 - t, 4);   // fast start, long slow stop
                const frame = now => {
                    const t = Math.min(1, (now - t0) / dur);
                    const rot = from + delta * ease(t);
                    canvas.style.transform = `rotate(${rot}deg)`;
                    // a tick (and a pointer flick) every time a slice boundary passes under the pointer
                    const s = Math.floor((((rot % 360) + 360) % 360) / seg);
                    if (s !== lastSeg) { lastSeg = s; play("wheelTick"); bump(pointer, "flick"); }
                    if (t < 1) return requestAnimationFrame(frame);
                    wheelRot = rot; spinning = false;
                    const val = values[index];
                    result.innerHTML = `You won <b>🪙 ${Number(val).toLocaleString("en-US")}</b>`;
                    result.classList.add("show"); box.classList.add("won");
                    go.textContent = "Collecting...";
                    play("wheelWin"); burst(canvas, 26);
                    setTimeout(() => burst(canvas, 18, ["🎉", "✨", "🪙"]), 450);
                    setTimeout(() => finish({ index, value: val }), reduced() ? 600 : 1900);
                };
                requestAnimationFrame(frame);
            };
        });
    }

    // quick controls used by the room menu (Adjust volume)
    const Quick = {
        get() { return { music: !!M.on, voice: !!S.voice, vol: S.vol }; },
        setMusic(on) { M.on = !!on; saveMusic(); paintMusic(); if (M.on) { ac(); musicRestart(); } else musicStop(); },
        setVoice(on) {
            S.voice = !!on; LS.set("voice2", S.voice ? "1" : "0");
            if (S.voice) { S.sound = true; LS.set("sound", "1"); }
            const v = document.getElementById("fx-voice"), sn = document.getElementById("fx-sound");
            if (v) v.checked = S.voice; if (sn) sn.checked = S.sound;
            if (!S.voice && window.speechSynthesis) { try { speechSynthesis.cancel(); } catch (e) { } }
        },
        setVol(p) {   // p = 0..1: one slider for sounds, voice and music
            p = Math.max(0, Math.min(1, p));
            S.vol = p; if (master) master.gain.value = p; LS.set("vol", String(p));
            M.vol = p; if (mBus) mBus.gain.value = M.vol * 1.3; saveMusic();
            const a = document.getElementById("fx-vol"), b = document.getElementById("fx-music-vol");
            if (a) { a.value = Math.round(p * 100); paintRange(a); } if (b) { b.value = Math.round(p * 100); paintRange(b); }
        }
    };
    window.FX = { play, say, callOut, drawn, coinsAdded, bump, burst, spinWheel, state: S, Music, Quick };
})();

/* ===== END FX ===== */
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
        apiKey: "AIzaSyC5_bWzsDzQ3ciR62zEA3Jlx6sf4wdzee4",
        authDomain: "housie-v02.firebaseapp.com",
        projectId: "housie-v02",
        storageBucket: "housie-v02.firebasestorage.app",
        messagingSenderId: "188557160776",
        appId: "1:188557160776:web:7cc25b16fe08abe53dc37d"
    };
    const START_COINS = 1000;          // default welcome bonus; must match firestore.rules
    const ADMIN_EMAIL = "sairuthwik2002@gmail.com"; // must match isAdmin() in firestore.rules
    const HOUSIE_BONUS = 500;          // extra coins for winning Housie, paid in EVERY room
    const SPLIT = { jaldi: 10, line1: 15, line2: 15, line3: 15, housie: 45 };
    const PRIZE_NAMES = { jaldi: "Jaldi", line1: "1st Line", line2: "2nd Line", line3: "3rd Line", housie: "Housie" };

    const api = { user: null, balance: null, enabled: false, ready: Promise.resolve(null), SPLIT, HOUSIE_BONUS };
    if (typeof firebase === "undefined") { console.warn("Firebase SDK failed to load - coins disabled."); return api; }
    api.enabled = true;
    api.favorites = [];

    /* ---------- DEVICE STORE (Persist): room data + settings ----------
       the active room (tickets, marks, room info), the numbers drawn in a "Play with Developer" match, and the
       user's settings (housie.pref.*). Firestore keeps only coins and the task / coin history (see CLOUD STORE). */
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

    /* ---------- CLOUD STORE: only the coin history (task progress) is kept in Firestore ----------
       history = users/{uid}/data/history = { items: JSON text }  capped copy of the coin history (powers Stats, Tasks, Daily bonus, History)
       Settings (name, theme, auto-draw speed, read updates ...) live ON THE DEVICE (Persist, keys housie.pref.<uid>.*).
       1 read per sign-in for the history; history writes wait 20 s (and always go out when the app is hidden).
       The old prefs document is read ONCE per device to copy settings over, then deleted. */
    const LMAX = 1000;
    // The tasks (daily / weekly / monthly) are counted from this history, so nothing from the current week or month may ever be
    // cut off by the size limit (a busy player makes well over 1000 entries a month; the old plain cut made their progress and
    // claimed tasks disappear). Only OLDER entries are trimmed.
    const TASK_KEEP_MAX = 6000;
    const keepFromMs = () => {
        const n = new Date(), m = new Date(n.getFullYear(), n.getMonth(), 1), w = new Date(n.getFullYear(), n.getMonth(), n.getDate());
        w.setDate(w.getDate() - ((w.getDay() + 6) % 7));    // Monday of this week (may fall in the previous month)
        return Math.min(m.getTime(), w.getTime());
    };
    const trimHist = list => {             // list is newest first
        const from = keepFromMs();
        let k = list.findIndex(e => (Number(e.time) || 0) < from);
        if (k < 0) k = list.length;        // everything is from this week / month
        const keep = Math.min(k, TASK_KEEP_MAX);
        const room = Math.max(0, LMAX - keep);
        // older entries: the small reward entries (daily bonus streak, claimed tasks) are kept first, then the newest of the rest,
        // so a busy player's login streak and "already claimed" tasks are not lost to hundreds of old game entries
        const older = list.slice(k), small = older.filter(e => SMALL_TYPES.has(e.type)).slice(0, 400);
        const keepSmall = new Set(small);
        const rest = older.filter(e => !keepSmall.has(e)).slice(0, Math.max(0, room - small.length));
        const merged = small.concat(rest).sort((x, y) => (Number(y.time) || 0) - (Number(x.time) || 0));
        list.length = Math.min(list.length, k);
        merged.forEach(e => list.push(e));
        return list;
    };
    const SMALL_TYPES = new Set(["daily", "task", "bonus", "wheel", "refill", "favbuy"]);
    const LEGACY = /^housie\.(name$|theme$|randomTheme$|autoSec$|awake$|updatesRead$|newSeen$|bonusPrompt$|timesRepaired\.v1$)/;
    const dRef = (uid, name) => uRef(uid).collection("data").doc(name);
    const ck = k => String(k).replace(/[.\/]/g, "_");           // map keys: no dots or slashes
    const PKEY = (uid, c) => "housie.pref." + uid + "." + c;
    let cloudLoaded = false, cloudLoading = null, cloudDead = false;
    let cloudTimer = null, cloudBusy = false, cloudAgain = false, cloudFails = 0, cloudWarned = false;
    let lcache = [], luid = null, histDirty = false, legacyDrop = [];
    const cloudReset = () => {
        if (cloudTimer) { clearTimeout(cloudTimer); cloudTimer = null; }
        cloudLoaded = false; cloudLoading = null; cloudDead = false;
        cloudBusy = false; cloudAgain = false; cloudFails = 0;
        lcache = []; luid = null; histDirty = false; legacyDrop = [];
    };
    const cloudSchedule = () => { if (cloudTimer) clearTimeout(cloudTimer); cloudTimer = setTimeout(() => { cloudTimer = null; cloudFlush(); }, 20000); };
    const TX_DAYS = 15, TX_TYPES = new Set(["send", "gift"]);
    const TX_OLD = e => TX_TYPES.has(e.type) && (Number(e.time) || 0) > 0 && Date.now() - Number(e.time) > TX_DAYS * 864e5;
    // once a day: delete coin-transfer entries older than 15 days from the online ledger too
    api.pruneTx = async u => {
        try {
            if (!u || !api.user || api.user.uid !== u.uid) return;
            const flag = PKEY(u.uid, "_txPruned"), today = new Date().toDateString();
            if (Persist.getItem(flag) === today) return;
            const cutoff = new Date(Date.now() - TX_DAYS * 864e5);
            const qs = await uRef(u.uid).collection("ledger").where("time", "<", cutoff).orderBy("time", "desc").limit(400).get();
            const old = qs.docs.filter(d => TX_TYPES.has(d.data().type));
            for (let i = 0; i < old.length; i += 400) {
                const b = db.batch(); old.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit();
            }
            Persist.setItem(flag, today);
        } catch (e) { console.warn("[prune tx]", e); }
    };
    const mergeHist = (...lists) => {
        const seen = new Set(), out = [];
        lists.forEach(L => (L || []).forEach(e => {
            if (!e) return;
            if (TX_OLD(e)) return;      // coin transfers are removed after 15 days
            if (e.id) { if (seen.has(e.id)) return; seen.add(e.id); }
            out.push(e);
        }));
        out.sort((x, y) => (Number(y.time) || 0) - (Number(x.time) || 0));
        return trimHist(out);
    };
    // settings: device only (no Firestore read / write)
    api.cloudGet = k => { const u = api.user; if (!u) return null; try { return Persist.getItem(PKEY(u.uid, ck(k))); } catch (e) { return null; } };
    api.cloudSet = (k, json) => { const u = api.user; if (!u) return; try { Persist.setItem(PKEY(u.uid, ck(k)), json); } catch (e) { } };
    api.cloudLoaded = () => cloudLoaded;
    api.cloudReady = Promise.resolve(false);
    api.hydrateLocal = () => api.cloudReady;
    function cloudLoad(u) {
        if (cloudLoading) return cloudLoading;
        cloudLoading = (async () => {
            try {
                try { await Persist.ready; } catch (e) { }           // device file must be read before settings are looked up
                const h = await dRef(u.uid, "history").get();
                if (!api.user || api.user.uid !== u.uid) return false;           // signed out / switched meanwhile
                let list = [];
                if (h.exists) { try { list = JSON.parse(h.data().items || "[]"); } catch (e) { list = []; } if (!Array.isArray(list)) list = []; }
                // one-time move of the old device copies (settings, coin history) into the new device settings
                let dump = {}; try { dump = Persist.dump(); } catch (e) { }
                let legacyList = [];
                Object.keys(dump).forEach(k => {
                    if (k === "housie.ledger." + u.uid) { try { legacyList = JSON.parse(dump[k]) || []; } catch (e) { legacyList = []; } legacyDrop.push(k); return; }
                    if (k === "housie.hydrated." + u.uid) { legacyDrop.push(k); return; }
                    if (!LEGACY.test(k)) return;
                    const pk = PKEY(u.uid, ck(k.slice(7)));
                    if (Persist.getItem(pk) === null) Persist.setItem(pk, dump[k]);
                    legacyDrop.push(k);
                });
                // one-time (per device): copy the settings that were saved online, then delete that online document
                const mk = PKEY(u.uid, "_fsMoved");
                if (Persist.getItem(mk) === null) {
                    try {
                        const p = await dRef(u.uid, "prefs").get();
                        const kv = p.exists && p.data().kv && typeof p.data().kv === "object" ? p.data().kv : {};
                        Object.keys(kv).forEach(c => { const pk = PKEY(u.uid, c); if (Persist.getItem(pk) === null) Persist.setItem(pk, kv[c]); });
                        Persist.setItem(mk, "1");
                        if (p.exists) dRef(u.uid, "prefs").delete().catch(() => { });
                    } catch (e) { console.warn("[prefs move]", e); }
                }
                if (!Array.isArray(legacyList)) legacyList = [];
                // very first time on a new account / device with nothing to move: pull the latest ledger once.
                // Once per device per month (and again after a reinstall) the whole month is also pulled, so task
                // progress and claimed tasks are restored even when the saved history is out of date or cut short.
                let fromFs = [];
                const firstTime = !h.exists && !legacyList.length;
                const nowM = new Date(), monthTag = nowM.getFullYear() + "-" + (nowM.getMonth() + 1), monthFlag = PKEY(u.uid, "_monthRestored2");   // v2: pulls everything from this week / month once more (older versions cut it at 1000 entries)
                if (firstTime || Persist.getItem(monthFlag) !== monthTag) {
                    const conv = d => { const x = d.data(); const t = x.time && typeof x.time.toMillis === "function" ? x.time.toMillis() : x.time; return Object.assign({}, x, { id: d.id, time: t }); };
                    if (firstTime) {
                        try {
                            const qs = await uRef(u.uid).collection("ledger").orderBy("time", "desc").limit(300).get();
                            fromFs = qs.docs.map(conv);
                        } catch (e) { console.warn("[hydrate]", e); }
                    }
                    // everything from this month, so the weekly / monthly task progress is complete
                    try {
                        const monthStart = new Date(keepFromMs());
                        const mq = await uRef(u.uid).collection("ledger").where("time", ">=", monthStart).orderBy("time", "desc").limit(6000).get();
                        fromFs = fromFs.concat(mq.docs.map(conv));
                        Persist.setItem(monthFlag, monthTag);
                    } catch (e) { console.warn("[hydrate month]", e); }
                }
                if (!api.user || api.user.uid !== u.uid) return false;
                luid = u.uid;
                lcache = mergeHist(list, legacyList, fromFs, lcache);
                if (!h.exists || lcache.length !== list.length) histDirty = true;     // also when old transfers were dropped
                setTimeout(() => api.pruneTx(u), 4000);
                cloudLoaded = true;
                if (histDirty || legacyDrop.length) cloudSchedule();
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
                if (histDirty) {
                    histDirty = false;
                    let json = JSON.stringify(lcache);
                    while (json.length > 900000 && lcache.length > 50) {
                        // too big for one document: cut the OLDER entries first, never this week / month's task entries
                        const from = keepFromMs(), k = lcache.findIndex(e => (Number(e.time) || 0) < from);
                        lcache.length = k > 0 && k < lcache.length ? k + Math.floor((lcache.length - k) / 2) : Math.floor(lcache.length / 2);
                        json = JSON.stringify(lcache);
                    }
                    try { await dRef(u.uid, "history").set({ items: json }); }
                    catch (e) { histDirty = true; throw e; }
                }
                legacyDrop.splice(0).forEach(k => { try { Persist.removeItem(k); } catch (e) { } });   // now safely stored
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
    document.addEventListener("pause", () => { cloudFlush(); });   // Capacitor: app backgrounded (mirrors Persist's own "pause" flush)

    // Pulls ledger entries the local copy is missing (coins received from friends, prizes paid while the app
    // was closed, rewards made on another device). The ledger is the source of truth; only entries newer than
    // what we already hold are read (1 day of overlap for clock differences), so this costs very few reads.
    let syncAt = 0, syncBusy = false;
    api.syncLedger = async force => {
        const u = api.user;
        if (!u || !cloudLoaded || syncBusy || (!force && Date.now() - syncAt < 60000)) return false;
        syncBusy = true; syncAt = Date.now();
        try {
            const newest = lcache.reduce((m, e) => Math.max(m, Number(e.time) || 0), 0);
            let q = uRef(u.uid).collection("ledger");
            if (newest) q = q.where("time", ">=", new Date(newest - 15 * 60 * 1000));
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
        trimHist(lcache);
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
        let seenRef = null;   // last "lastRef" we already reacted to, so a gift card is never built twice
        unsubUser = uRef(uid).onSnapshot(snap => {
            if (!snap.exists) return;
            const d = snap.data();
            const coins = d.coins;
            const favRaw = d.favoriteNumbers;
            api.favorites = Array.isArray(favRaw) ? favRaw.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 90) : [];
            if (api.onFavorites) { try { api.onFavorites(api.favorites); } catch (e) { } }
            const diff = api.balance === null ? 0 : coins - api.balance;
            api.balance = coins;
            document.querySelectorAll("[data-coin]").forEach(el => { el.textContent = coins; });
            if (coins !== lastCoins) { lastCoins = coins; if (api.onBalance) api.onBalance(coins); }
            const ref = d.lastRef;
            const freshGift = !first && diff > 0 && ref && ref !== seenRef && /^recv_/.test(ref) && Date.now() > (api.quietUntil || 0);
            if (ref) seenRef = ref;
            if (freshGift) {
                // "lastRef" points at the ledger doc the sender's transaction wrote for us - one
                // extra read tells us who sent it, so the balance bump becomes a shareable gift card
                // instead of a bare "+N coins" toast.
                lRef(uid, ref).get().then(gs => {
                    const g = gs.exists ? gs.data() : null;
                    if (g && g.type === "gift") {
                        toast(`${g.fromName || "A friend"} sent you ${diff} coins!`, "success");
                        if (typeof showSpecialCard === "function") {
                            showSpecialCard("gift", diff, g.fromName ? "From " + g.fromName : "").catch(() => { });
                        }
                    } else {
                        toast(`+${diff} coins`, "success");
                    }
                }).catch(() => toast(`+${diff} coins`, "success"));
            } else if (!first && diff > 0 && Date.now() > (api.quietUntil || 0)) {
                toast(`+${diff} coins`, "success");
            }
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
        // shareable "Welcome!" card - delayed a moment so it lands after the app shell is up,
        // not mid-way through the sign-in transition
        if (typeof showSpecialCard === "function") {
            setTimeout(() => showSpecialCard("welcome", bonus).catch(() => { }), 1200);
        }
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
    // saves this account's favorite numbers (no limit; each newly added number costs coins, see the Favorite Numbers screen) on users/{uid} (the rules allow only the owner to change this field)
    api.saveFavorites = nums => {
        const u = api.user;
        if (!u) return Promise.reject(new Error("Please sign in first."));
        const clean = Array.from(new Set((nums || []).map(Number))).filter(n => Number.isInteger(n) && n >= 1 && n <= 90);   // keeps the order added: newest last
        // = FAV_MAX
        return wrap(uRef(u.uid).update({ favoriteNumbers: clean })).then(() => { api.favorites = clean; return clean; });
    };

    // Buys + saves favorite numbers in ONE transaction: the price is worked out on the server copy of the account
    // (only numbers that are not already saved cost coins; removing is always free), the coins are deducted,
    // one ledger entry is written and the list is saved - all together or not at all.
    api.serverFavorites = async () => {
        const u = api.user; if (!u) return null;
        try { const s = await uRef(u.uid).get({ source: "server" }); return s.exists ? (s.data().favoriteNumbers || []).map(Number) : []; }
        catch (e) { return null; }
    };
    api.buyFavorites = (nums, price, expectedCost) => {
        const u = api.user;
        if (!u) return Promise.reject(new Error("Please sign in first."));
        const clean = Array.from(new Set((nums || []).map(Number))).filter(n => Number.isInteger(n) && n >= 1 && n <= 90);   // keeps the order added: newest last
        const id = "favnum_" + Date.now();
        const run = () => db.runTransaction(async tx => {
            const snap = await tx.get(uRef(u.uid));
            if (!snap.exists) throw new Error("Account not ready. Try again in a moment.");
            const d = snap.data();
            const had = new Set((d.favoriteNumbers || []).map(Number));
            const added = clean.filter(n => !had.has(n));
            const cost = added.length * price;
            if (expectedCost !== undefined && cost !== expectedCost) { const e = new Error("Your favorite numbers changed. Please open the editor again."); e.app = true; throw e; }
            if (cost > 0) {
                if ((Number(d.coins) || 0) < cost) { const e = new Error(`Not enough coins. You have ${Number(d.coins) || 0}, need ${cost}.`); e.app = true; throw e; }
                tx.set(lRef(u.uid, id), { type: "favbuy", amount: -cost, time: TS(), note: "Favorite numbers: " + added.join(", ") });
                tx.update(uRef(u.uid), { coins: INC(-cost), lastRef: id, favoriteNumbers: clean });
            } else {
                tx.update(uRef(u.uid), { favoriteNumbers: clean });
            }
            return { cost, added, id };
        });
        // a permission-denied right after sign-in is often a stale ID token (rewards already retry like this):
        // get a fresh token and try once more before giving up
        const isDenied = e => /permission|insufficient/i.test(String((e && e.code) || "") + " " + String((e && e.message) || ""));
        const attempt = async () => {
            try { return await run(); }
            catch (e) {
                if (!e || e.app || !isDenied(e)) throw e;
                try { await api.user.getIdToken(true); } catch (e2) { }
                return run();
            }
        };
        return attempt().then(r => {
            api.favorites = clean;
            if (r.cost > 0) api.localAdd({ id: r.id, type: "favbuy", amount: -r.cost, note: "Favorite numbers: " + r.added.join(", ") });
            return r;
        }, e => {
            if (e && e.app) throw e;
            // "Can't do that now. The game may have started..." is the room message: wrong here, so say what really happened
            const denied = isDenied(e);
            console.error("[Firestore] favorite numbers", e);
            const err = new Error(denied ? "The server refused this save, so no coins were taken. Try again; if it keeps happening the Firestore rules must allow the favorite-numbers purchase." : friendly(e));
            err.code = e && e.code; err.raw = e; err.denied = denied; throw err;
        });
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
    /* ---------- export (admin): ONLY the users list, their coins and their task progress ----------
       users/{uid}                 profile + coins (name, email, coins, code, ...)  = the users list
       users/{uid}/ledger/*        every coin transaction                            = coins data
       users/{uid}/data/history    capped history copy with the "played" stamps      = task progress
       Rooms (games) and the codes index are NOT exported: rooms are temporary and a share code is rebuilt from
       the user's own "code" field on import. */
    api.exportData = async onProgress => {
        const me = api.user;
        if (!me) throw new Error("Please sign in first.");
        needAdmin();
        const out = { app: "Housie", exportedAt: new Date().toISOString(), by: me.uid, scope: "users-coins-tasks", users: [] };
        const users = await db.collection("users").get();
        let done = 0;
        const dumpUser = async u => {
            const node = { id: u.id, data: u.data(), sub: {} };
            const [led, hist] = await Promise.all([
                u.ref.collection("ledger").get().catch(() => null),
                u.ref.collection("data").doc("history").get().catch(() => null)
            ]);
            if (led && !led.empty) node.sub.ledger = led.docs.map(d => ({ id: d.id, data: d.data() }));
            if (hist && hist.exists) node.sub.data = [{ id: "history", data: hist.data() }];
            out.users.push(node);
            if (onProgress) onProgress(++done, users.size);
        };
        await pool(users.docs, dumpUser, 6);
        out.users.sort((x, y) => (Number(y.data && y.data.coins) || 0) - (Number(x.data && x.data.coins) || 0));
        out.counts = { users: out.users.length, ledgerEntries: out.users.reduce((n, x) => n + ((x.sub.ledger || []).length), 0) };
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
        (backup.users || []).forEach(n => {
            queue("users", n);
            const c = n.data && n.data.code;
            if (c && !(backup.codes || []).length) jobs.push([db.collection("codes").doc(String(c)), { uid: n.id }]);   // share-code index
        });
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
            { const tb = db.batch(); tb.set(db.collection("deletedUsers").doc(uid), { at: TS() }); tb.delete(uRef(uid)); await tb.commit(); }   // tombstone + user doc together (rules)
            if (me.exists && me.data().code) await db.collection("codes").doc(me.data().code).delete().catch(() => { });   // rules free the code only after the account is gone
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
                tx.set(lRef(uid, "entry_" + gid), { type: "entry", gameId: gid, amount: cost ? -cost : 0, host: true, time: TS() });
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
    // The 500 Housie bonus is paid in every room (any player count, any pot).
    api.bonusFor = (k, playerCount, pot) => (k === "housie" ? HOUSIE_BONUS : 0);   // every game pays the Housie bonus
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
    // Presence is switched off to save reads / writes: players are simply never shown as offline.
    // (The host heartbeat below still tells players when the host has gone quiet.)
    api.presenceBeat = gid => Promise.resolve();
    api.watchPresence = (gid, cb) => { try { cb({}); } catch (e) { } return () => { }; };
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
            claimedTickets: UNION(Object.assign({ claim: c.claim, ticket: c.ticket, row: c.row }, Array.isArray(c.nums) ? { nums: c.nums } : {}))
        });
        const total = c.share + (c.bonus || 0); // Housie also pays the winning bonus (every room)
        if (total > 0) {
            const id = "win_" + gid + "_" + c.claim;
            b.set(lRef(c.uid, id), Object.assign({ type: "win", gameId: gid, prize: c.claim, amount: total, time: TS() }, extra || {}));
            b.update(uRef(c.uid), { coins: INC(total), lastRef: id });
        }
        return wrap(b.commit());
    };

    // Asks the SERVER (not the local cache) whether this claim's prize was really recorded for this player.
    // A failed batch can leave a half-true local picture (the room looks "claimed" because of the optimistic
    // local write), so a failure is only final once the server has been asked.
    // Names that the SERVER lists as winners of this prize (null when unknown)
    api.claimWinner = async (gid, claim) => {
        try {
            const s = await gRef(gid).get({ source: "server" });
            const w = s.exists && s.data().claimsTaken && s.data().claimsTaken[claim];
            return Array.isArray(w) ? w : null;
        } catch (e) { return null; }
    };
    api.claimRecorded = async (gid, claim, uid) => {
        try {
            const s = await gRef(gid).collection("prizes").doc(claim).get({ source: "server" });
            return !!(s.exists && (s.data().winners || []).includes(uid));
        } catch (e) { return false; }
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
                coins: dev.coins - stake, lastRef: "deventry_" + gid,   // lastRef: the rules only accept a coin change paired with its ledger entry
                devChallenge: { active: true, gameId: gid, oppUid, stake, lockedAt: TS() }
            });
            tx.update(uRef(oppUid), {
                coins: opp.coins - stake, lastRef: "deventry_" + gid,
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
        if (devS.exists) tx.update(uRef(devUid), { coins: INC(stake), lastRef: "devrefund_" + gid, devChallenge: { active: false } });
        if (oppS.exists) tx.update(uRef(oppUid), { coins: INC(stake), lastRef: "devrefund_" + gid, activeGame: null });
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
            share: api.prizeShare(g.pot, k), bonus: api.bonusFor(k, g.playerCount, g.pot)
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

    /* ---------- SHARED DRAW CLOCK (saves almost every read / write of a game) ----------
       Before: every drawn number was one write + one read for EVERY player (10 players x 60 numbers = 600 reads).
       Now the numbers come from a seeded shuffle (dSeed) plus a clock: dK0 numbers are shown at time dT0, then one more
       every dMs while dRun is on. Each phone works the next number out by itself, so an auto-draw game only writes
       when it starts, pauses, changes speed or ends. A manual tap is one checkpoint write (same cost as before).
       If the security rules refuse the new fields, tlOff switches back to the old one-write-per-number way. */
    let tlOff = false;
    const seqCache = new Map();
    const seqFor = seed => {
        let q = seqCache.get(seed);
        if (!q) {
            let a = seed | 0;
            const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
            q = Array.from({ length: 90 }, (_, i) => i + 1);
            for (let i = 89; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const x = q[i]; q[i] = q[j]; q[j] = x; }
            seqCache.set(seed, q);
            if (seqCache.size > 20) seqCache.delete(seqCache.keys().next().value);
        }
        return q;
    };
    // A fresh, unpredictable seed for every game (crypto random, not Math.random). The opening of each game's number order is
    // remembered on this device, and a seed whose opening looks like one of the last games is thrown away, so a pattern never repeats.
    const RECENT_KEY = () => "housie.pref." + ((api.user && api.user.uid) || "anon") + ".recentDraws";
    const rand31 = () => {
        try { const v = new Uint32Array(1); crypto.getRandomValues(v); return 1 + (v[0] % 2147483646); }
        catch (e) { return 1 + Math.floor(Math.random() * 2147483646); }
    };
    const newSeed = () => {
        let recent = [];
        try { recent = JSON.parse(Persist.getItem(RECENT_KEY()) || "[]"); if (!Array.isArray(recent)) recent = []; } catch (e) { recent = []; }
        let seed = rand31(), head = [];
        for (let i = 0; i < 40; i++) {
            seed = i ? rand31() : seed;
            head = seqFor(seed).slice(0, 12);
            // too alike = 3 or more of the first 12 numbers sit at the same position in a recent game (chance would give about 0.1)
            const alike = recent.some(r => r.reduce((m, n, k) => m + (n === head[k] ? 1 : 0), 0) >= 3);
            if (!alike) break;
        }
        try { recent.push(head); Persist.setItem(RECENT_KEY(), JSON.stringify(recent.slice(-30))); } catch (e) { }
        return seed;
    };
    const msOf = t => (t && typeof t.toMillis === "function" ? t.toMillis() : 0);
    // how many numbers are showing according to the clock (skew = this phone's clock minus the server clock)
    const tlK = (g, skew) => {
        const base = Math.min(90, Math.max(Number(g.dK0) || 0, (g.calledNumbers || []).length));
        const t0 = msOf(g.dT0);
        if (!g.dRun || !t0 || !(g.dMs > 0)) return base;
        if (g.status === "finished" || (g.claimsLocked && g.claimsLocked.housie) || (g.claimsTaken && g.claimsTaken.housie && g.claimsTaken.housie.length)) return base;
        const now = Date.now() - skew;
        const hb = msOf(g.hostSeenAt);
        if (hb && now - hb > 240000) return base;           // the host went quiet: the clock stops
        const e = now - t0;
        return Math.min(90, base + (e >= 0 ? Math.floor(e / g.dMs) + 1 : 0));
    };
    const tlWrite = (gid, seed, k, run, ms, extra) => {
        const seq = seqFor(seed);
        const patch = Object.assign({ dSeed: seed, dK0: k, dRun: !!run, dMs: run ? ms : 0, dT0: TS(), calledNumbers: seq.slice(0, k), currentNumber: k ? seq[k - 1] : null, hostSeenAt: TS() }, extra || {});
        return gRef(gid).update(patch).then(r => { lastBeatAt = Date.now(); return r; },
            e => { if (e && e.code === "permission-denied" && !(roomNow[gid] && roomNow[gid].seed)) tlOff = true; throw e; });
    };
    // host: start the clock (returns false when it can't, the caller then draws number by number)
    api.autoStart = async (gid, ms) => {
        const known = roomNow[gid];
        if (!known || tlOff || isDevGid(gid)) return false;
        const seed = known.seed || (known.called.length ? 0 : newSeed());
        if (!seed || known.called.length >= 90) return false;
        try { await tlWrite(gid, seed, known.called.length, true, ms, known.status === "open" ? { status: "started" } : null); return true; }
        catch (e) { return false; }
    };
    api.autoSpeed = (gid, ms) => { const k = roomNow[gid]; return (!k || !k.seed) ? Promise.resolve(false) : tlWrite(gid, k.seed, k.called.length, true, ms).then(() => true, () => false); };
    api.autoPause = gid => { const k = roomNow[gid]; return (!k || !k.seed) ? Promise.resolve(true) : tlWrite(gid, k.seed, k.called.length, false, 0).then(() => true, () => false); };

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
        if (known.seed || (!tlOff && !known.called.length)) {           // shared clock game: a tap is one checkpoint write
            const seed = known.seed || newSeed(), k = known.called.length, seq = seqFor(seed);
            roomNow[gid] = { called: seq.slice(0, k + 1), status: "started", seed };
            return tlWrite(gid, seed, k + 1, false, 0, known.status === "open" ? { status: "started" } : null).then(
                () => ({ num: seq[k], done: false }),
                e => { roomNow[gid] = known; if (!known.seed && tlOff) return api.draw(gid); throw e; });
        }
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

    api.watchGame = (gid, cb) => {
        if (isDevGid(gid)) {
            return resilient(onErr => gRef(gid).onSnapshot(s => {
                if (s.exists) { const g = Object.assign({ id: s.id }, s.data()); const st = devState(gid); st.last = g; st.emit = cb; cb(withLocal(gid, g)); return; }
                if (!s.metadata.fromCache) cb({ id: gid, status: "finished", calledNumbers: [], claimsTaken: {}, claimsLocked: {} });
            }, onErr));
        }
        const st = { base: null, skew: 0, skewS: Infinity, seenT0: null, first: true, lastK: 0, tick: null };
        const emit = fromTick => {
            const g = st.base;
            if (!g) return;
            let out = g;
            if (g.dSeed) {
                const k = Math.max(tlK(g, st.skew), st.lastK);
                if (fromTick && k === st.lastK) return;
                st.lastK = k;
                const seq = seqFor(g.dSeed);
                out = Object.assign({}, g, { calledNumbers: seq.slice(0, k), currentNumber: k ? seq[k - 1] : null });
            }
            roomNow[gid] = { called: out.calledNumbers || [], status: out.status, seed: g.dSeed || null };
            cb(out);
        };
        const unsub = resilient(onErr => {
            st.first = true;
            return gRef(gid).onSnapshot(s => {
                if (s.exists) {
                    const g = Object.assign({ id: s.id }, s.data());
                    // learn this phone's clock offset from a checkpoint that arrives live (not from an old one read on joining)
                    const t0 = msOf(g.dT0);
                    if (g.dSeed && t0 && t0 !== st.seenT0) {
                        st.seenT0 = t0;
                        const obs = Date.now() - t0;
                        if (!st.first && !s.metadata.hasPendingWrites && Math.abs(obs) < 20000 && obs < st.skewS) { st.skewS = obs; st.skew = obs; }
                    }
                    st.first = false;
                    st.base = g;
                    emit(false);
                    return;
                }
                if (!s.metadata.fromCache) cb({ id: gid, status: "finished", calledNumbers: [], claimsTaken: {}, claimsLocked: {} });
            }, onErr);
        });
        st.tick = setInterval(() => { if (st.base && st.base.dRun) emit(true); }, 250);
        return () => { clearInterval(st.tick); unsub(); };
    };
    api.watchPlayers = (gid, cb) => resilient(onErr => gRef(gid).collection("players").orderBy("joinedAt").onSnapshot(snap => {
        cb(snap.docs.map(d => Object.assign({ uid: d.id }, d.data())), snap.metadata.hasPendingWrites);
    }, onErr));
    // players (not the host) listen to their OWN player document only; the full list is read on demand
    api.watchMyPlayer = (gid, cb) => resilient(onErr => pRef(gid, api.user.uid).onSnapshot(snap => {
        if (snap.exists) cb(Object.assign({ uid: snap.id }, snap.data()), snap.metadata.hasPendingWrites);
    }, onErr));
    api.getPlayers = gid => gRef(gid).collection("players").orderBy("joinedAt").get().then(snap => snap.docs.map(d => Object.assign({ uid: d.id }, d.data())));
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
        let settled = false, unsub = () => { }, timer = null;
        const end = fn => v => { if (settled) return; settled = true; clearTimeout(timer); unsub(); fn(v); };
        const okEnd = end(resolve), failEnd = end(reject);
        const ref = gRef(gid).collection("claimRequests").doc();
        // listen first: the host's answer is picked up the moment it exists (no waiting for our own write to be confirmed)
        unsub = ref.onSnapshot(snap => {
            if (settled || !snap.exists) return;
            const d = snap.data();
            if (d.processed) okEnd(d.result || { ok: false, silent: true });
        }, err => failEnd(new Error(friendly(err))));
        // give the host a fair time (it throws the request away itself after 60 s); the buttons are NOT held meanwhile (see submitClaimNow)
        timer = setTimeout(() => okEnd({ ok: false, silent: true }), 45000);   // no "host not responding" message is shown
        ref.set(Object.assign({}, payload, { uid: api.user.uid, requestedAt: TS(), processed: false, result: null }))
            .catch(e => failEnd(new Error(friendly(e))));
    });
    api.watchClaimRequests = (gid, cb) => resilient(onErr => gRef(gid).collection("claimRequests").where("processed", "==", false)
        .onSnapshot(snap => {
            const ms = d => (d.requestedAt && d.requestedAt.toMillis ? d.requestedAt.toMillis() : Infinity);
            snap.docChanges().filter(ch => ch.type === "added").map(ch => Object.assign({ id: ch.doc.id }, ch.doc.data()))
                .sort((a, b) => ms(a) - ms(b))          // the player who tapped first is judged first
                .forEach(cb);
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
        // nobody (or no host) left in the room: close it now so it cannot stay "live" in the background
        try {
            const left = await gRef(gid).collection("players").get({ source: "server" });
            if (left.empty || !left.docs.some(d => d.data().isHost)) await api.endGame(gid);
        } catch (e) { /* best effort: the host's own sweep and the admin sweep back this up */ }
    };
    // Ends every unfinished room this user hosts, except the one they are still playing (keepGid).
    // Covers a host who closed the app / lost connection without pressing Leave. Best effort, once per session.
    let mySweepDone = false;
    api.endMyStaleRooms = async keepGid => {
        if (mySweepDone || !api.user) return;
        mySweepDone = true;
        try {
            const qs = await db.collection("games").where("hostUid", "==", api.user.uid).get();
            const stale = qs.docs.filter(d => {
                const g = d.data();
                return d.id !== keepGid && g.mode !== "dev" && ["open", "started"].includes(g.status);
            });
            for (const d of stale.slice(0, 10)) {
                try { await api.endGame(d.id); await api.wipeRoom(d.id); } catch (e) { }
            }
        } catch (e) { mySweepDone = false; }
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
            const gs = await gRef(gid).get().catch(() => null);
            if (gs && gs.exists && gs.data().archived) return;     // already cleaned by someone else: no reads / deletes
            await Promise.all(ROOM_SUBS.map(sub => wipeCollection(gRef(gid).collection(sub))));
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
        task: "Task reward", favbuy: "Favorite number", admin: "Admin adjustment", deventry: "Developer challenge entry fee", devrefund: "Developer challenge refund", refund: "Room refund (host offline)", invite: "Invite bonus"
    };
    // task reward -> the real task name (e.g. "Daily task: Play 10 games"), looked up from TASKS by the id stored in the entry
    const taskLabel = t => {
        try {
            const id = t.task || (String(t.id || "").match(/^task_.*?_((?:[a-z]+_)?[a-z0-9]+_v\d+|first_game|first_win|first_housie|games25)$/) || [])[1];
            const groups = { daily: "Daily task", weekly: "Weekly task", monthly: "Monthly task", once: "Achievement", newbie: "Welcome task" };
            for (const k in groups) { const f = (TASKS[k] || []).find(x => x.id === id); if (f) return groups[k] + ": " + f.title; }
        } catch (e) { }
        return t.note ? "Task reward: " + t.note : "Task reward";
    };
    const describe = t => t.type === "win" ? `Won ${PRIZE_NAMES[t.prize] || t.prize} prize`
        : t.type === "task" ? taskLabel(t)
            : t.type === "send" ? "Sent to " + (t.toName || nameCache.get(t.to) || "code " + (t.toCode || ""))
                : t.type === "gift" ? "Received from " + (t.fromName || "a friend")
                    : t.type === "entry" ? "Room entry fee"
                        : t.type === "daily" ? "Daily login bonus"
                            : t.type === "wheel" ? "Try your luck spin win"
                                : t.type === "refill" ? "Free coin refill"
                                    : (LEDGER_LABELS[t.type] || t.type);
    // older "send" entries only hold the friend's uid + code: look the name up once per friend (one read each) and remember it
    const nameCache = new Map(), nameTried = new Set();
    api.nameOf = uid => nameCache.get(uid) || "";
    api.resolveNames = async list => {
        const need = [...new Set((list || []).filter(t => t && t.type === "send" && !t.toName && t.to && !nameCache.has(t.to) && !nameTried.has(t.to)).map(t => t.to))].slice(0, 40);
        await Promise.all(need.map(async uid => {
            nameTried.add(uid);
            try { const sn = await uRef(uid).get(); const d = sn.exists ? sn.data() : null; const nm = d && (d.alias || d.name); if (nm) nameCache.set(uid, String(nm).slice(0, 60)); } catch (e) { }
        }));
        return need.length;
    };
    api.esc = esc;
    api.describe = describe;
    api.taskLabel = taskLabel;

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
            const upd = { coins: INC(amount), lastRef: id };
            // the 25,000 jackpot also stamps today's date on the account; firestore.rules only accept a newer date, so it can be paid once a day
            if (type === "wheel" && amount >= WHEEL_BIG) upd.bigDay = dayKey(new Date());
            tx.update(uRef(uid), upd);
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
                    const why = (e2 && (e2.code || e2.message)) ? " (" + String(e2.code || e2.message).replace(/^.*?:\s*/, "").slice(0, 60) + ")" : "";
                    throw new Error("Could not claim this reward right now. Try again later." + why);
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
    // 6-digit invite codes. They are kept in the same "codes" collection as the 4-digit friend codes (a different length, so they never clash).
    // The first try is worked out from the account id; if another player already holds that code, the next try is used.
    const inviteTry = (uid, n) => {
        let hsh = 2166136261; const t = uid + ":" + n;   // FNV-1a
        for (let k = 0; k < t.length; k++) { hsh ^= t.charCodeAt(k); hsh = Math.imul(hsh, 16777619) >>> 0; }
        return String(100000 + hsh % 900000);
    };
    api.myInviteCode = async () => {
        const me = api.user.uid;
        for (let n = 0; n < 12; n++) {
            const code = inviteTry(me, n);
            let snap;
            try { snap = await codeRef(code).get(); } catch (e) { throw new Error(friendly(e)); }
            if (snap.exists) { if (snap.data().uid === me) return code; continue; }   // mine already, or someone else's: next try
            try { await codeRef(code).set({ uid: me }); return code; }
            catch (e) { if (/permission|insufficient|already|exists/i.test((e && e.message) || "")) continue; throw new Error(friendly(e)); }
        }
        throw appErr("Could not create your invite code. Try again.");
    };
    // an invite code -> who owns it (uid + name)
    api.findInvite = async code => {
        code = String(code || "").trim();
        if (!/^[0-9]{6}$/.test(code)) throw appErr("Enter the 6-digit invite code.");
        let snap, u;
        try {
            snap = await codeRef(code).get();
            if (snap.exists) u = await uRef(snap.data().uid).get();
        } catch (e) { throw new Error(friendly(e)); }
        if (!snap.exists || !u || !u.exists) throw appErr("No player found with that invite code.");
        if (snap.data().uid === api.user.uid) throw appErr("That is your own invite code.");
        const d = u.data();
        return { uid: snap.data().uid, name: d.alias || d.name || "A friend", code };
    };
    // records who invited me (once). The coins are claimed later: 25,000 by me (Welcome task), 50,000 by the inviter (Invite friends)
    api.payInviter = async inviterUid => {
        const me = api.user.uid;
        try {
            await db.runTransaction(async tx => {
                const m = await tx.get(uRef(me));
                if (m.data().invitedBy) return;
                tx.update(uRef(me), { invitedBy: inviterUid, invitedAt: TS() });
            });
        } catch (e) { throw new Error(friendly(e)); }
    };
    // my welcome-task progress (0-8), shared on my account so the friend who invited me can see it
    api.setNwDone = n => wrap(uRef(api.user.uid).update({ nwDone: n }));
    // players who joined with my invite code (their account says invitedBy = me)
    api.myInvitees = async () => {
        let q;
        try { q = await db.collection("users").where("invitedBy", "==", api.user.uid).get(); }
        catch (e) { throw new Error(friendly(e)); }
        return q.docs.map(d => ({ uid: d.id, name: String(d.data().alias || d.data().name || "A friend").slice(0, 40), at: d.data().invitedAt || null, nw: Number(d.data().nwDone) || 0 }));
    };

    // same list, but live: calls cb(list) now and again every time a friend joins or their welcome-task count changes (only the changed accounts are read). Returns the stop function.
    api.watchInvitees = (cb, onErr) => {
        try {
            return db.collection("users").where("invitedBy", "==", api.user.uid).onSnapshot(
                snap => cb(snap.docs.map(d => ({ uid: d.id, name: String(d.data().alias || d.data().name || "A friend").slice(0, 40), at: d.data().invitedAt || null, nw: Number(d.data().nwDone) || 0 }))),
                e => { if (onErr) onErr(e); });
        } catch (e) { if (onErr) onErr(e); return () => { }; }
    };

    // one transaction: debit the sender, credit the friend, one ledger entry each
    api.sendCoins = async (toUid, toCode, amount) => {
        const me = api.user.uid;
        amount = Math.floor(Number(amount));
        if (!(amount >= 1)) throw appErr("Enter an amount of 1 or more.");
        if (!toUid || toUid === me) throw appErr("Pick a friend to send to.");
        const sid = "send_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
        const rid = "recv_" + sid;
        let toName = "";
        api.quietUntil = Date.now() + 4000;
        try {
            await db.runTransaction(async tx => {
                const m = await tx.get(uRef(me));
                if ((m.data().coins || 0) < amount) throw appErr("Insufficient balance");
                const t = await tx.get(uRef(toUid));
                toName = String((t.exists && (t.data().alias || t.data().name)) || "").slice(0, 60);
                tx.set(lRef(me, sid), Object.assign({ type: "send", amount: -amount, to: toUid, toCode, time: TS() }, toName ? { toName } : {}));
                tx.update(uRef(me), { coins: INC(-amount), lastRef: sid });
                tx.set(lRef(toUid, rid), { type: "gift", amount, from: me, fromName: m.data().name || "Player", ref: sid, time: TS() });
                tx.update(uRef(toUid), { coins: INC(amount), lastRef: rid });
            });
            api.localAdd(Object.assign({ id: sid, type: "send", amount: -amount, to: toUid, toCode }, toName ? { toName } : {}));
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
        timer = setInterval(() => { if (!document.hidden) pull(); }, 10 * 60 * 1000);
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
    // only the rooms that are still open / started (used by the 1-minute sweep while the admin screen is open)
    api.adminLiveGames = async () => {
        needAdmin();
        const qs = await db.collection("games").where("status", "in", ["open", "started"]).get();
        return qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
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
        // games played = finished rooms, minus rooms that were cancelled before any number was called (full refund, nothing was played)
        try {
            const fin = (await db.collection("games").where("status", "==", "finished").count().get()).data().count;
            let cancelled = 0;
            try { cancelled = (await db.collection("games").where("status", "==", "finished").where("cancelled", "==", true).count().get()).data().count; } catch (e) { }
            out.finished = Math.max(0, fin - cancelled);
        } catch (e) { }
        return out;
    };
    // when each player last sent a presence stamp (best effort)
    api.adminPresence = async gid => ({});   // presence documents are no longer written
    api.adminPlayers = async gid => {
        needAdmin();
        const qs = await gRef(gid).collection("players").get();
        return qs.docs.map(d => Object.assign({ uid: d.id }, d.data()));
    };
    // newest ledger entry of each user = when they were last active (uid -> ms)
    api.adminLastActive = async uids => {
        needAdmin();
        const out = {};
        await pool(uids, async uid => {
            const qs = await uRef(uid).collection("ledger").orderBy("time", "desc").limit(1).get();
            const t = qs.docs[0] && qs.docs[0].data().time;
            out[uid] = t && t.toMillis ? t.toMillis() : 0;
        }, 6);
        return out;
    };
    api.adminLedger = async (uid, n) => {
        needAdmin();
        const qs = await uRef(uid).collection("ledger").orderBy("time", "desc").limit(Math.min(n || 50, 50)).get();
        return qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
    };
    // ---- live admin feeds: attached only while the admin screen is open, detached when it is left ----
    // Admin feeds: a plain read now and again every 5 minutes while the tab is visible (was a live listener:
    // one read for every coin change of every top-100 player and for every drawn number of every live room).
    const pollFeed = (fetch, cb, ms) => {
        let stopped = false, timer = null;
        const pull = async () => { try { const r = await fetch(); if (!stopped) cb(r); } catch (e) { console.warn("[admin feed]", e); } };
        pull();
        timer = setInterval(() => { if (!document.hidden) pull(); }, ms);
        return () => { stopped = true; clearInterval(timer); };
    };
    api.watchAdminUsers = cb => pollFeed(async () => {
        const qs = await db.collection("users").orderBy("coins", "desc").limit(100).get();
        if (!usersPaged) { if (qs.docs.length) usersCursor = qs.docs[qs.docs.length - 1]; api.usersHasMore = qs.docs.length === 100; }   // keeps "Load more users" working
        return qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
    }, cb, 5 * 60 * 1000);
    api.watchAdminGames = cb => pollFeed(() => api.adminGames(), cb, 5 * 60 * 1000);
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
    // ends the room for everyone AND removes it from the database (players, tickets, claims, prizes and the room record).
    // Coin balances and every player's coin history are separate documents, so they are not touched.
    api.adminEndAndDelete = async gid => {
        needAdmin();
        try { await gRef(gid).update({ status: "finished" }); } catch (e) { /* already finished / gone: the delete below decides */ }
        await api.adminDeleteGame(gid);
    };
    api.adminEndGames = ids => { needAdmin(); return pool(ids, id => api.adminEndAndDelete(id), 5); };
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
let liteMembers = false, membersAt = 0;      // players who are not the host read the player list only when they open it
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
let mineSeen = false;                 // my own player document was received at least once in this room
let usedLineRows = new Set();        // "ticket|row" of every row that already won a line prize on my tickets

const ticketsContainer = document.getElementById("tickets-container");
const leavePopup = document.getElementById("leave-popup");
const leaveCancel = document.getElementById("leave-cancel");
const leaveConfirm = document.getElementById("leave-confirm");
const winScreen = document.getElementById("win-screen");

let myTicketsData = [];   // the ticket grids actually rendered for this player (set by generateTickets) - used to draw win cards
const pendingWinCards = new Set();   // win cards still being drawn (the end-of-room display waits for them)
let lastWinCard = null;   // most recently generated shareable win card: { id, dataUrl, thumb, claim, amount, room, time }

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
    // draws, claims and coin rewards have their own sound, so their toast stays silent
    if (window.FX && !/^New Number Drawn|^Checking your claim|Claimed!|\+[\d,]+ coins/.test(String(msg))) FX.play(/ won /.test(String(msg)) ? "otherWin" : ({ error: "error", success: "success", warn: "warn" })[tone] || "info");

    let stack = document.getElementById("toast-stack");
    if (!stack) {
        stack = document.createElement("div");
        stack.id = "toast-stack";
        stack.setAttribute("role", "status");
        stack.setAttribute("aria-live", "polite");
        document.body.appendChild(stack);
    }
    // inside a game the toasts go into the reserved empty strip under the sticky header
    // (never over the tickets); everywhere else they float at the top as before. But that
    // strip is part of the arena screen itself, so if a full-screen popup or win/result
    // overlay is currently open on top of the arena, the strip is hidden behind it - route
    // the toast to the floating top-of-screen stack instead so it's actually visible
    // (this is what made "Copied to clipboard!" invisible behind the win-card popup).
    const slot = document.getElementById("arena-toast-slot");
    const overlayOpen = !!document.querySelector(".popup-overlay.active, .win-overlay.active");
    const inArena = !!slot && !!document.querySelector("#screen-arena.active") && !overlayOpen;
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
const NAV_OF = { home: "home", earn: "earn", lobby: "lobby", devlobby: "home", stats: "stats", transactions: "profile", profile: "profile", history: "profile", theme: "profile", favorites: "profile", share: "home", invite: "profile", leaderboard: "profile", updates: "profile", admin: "profile", wincards: "profile", sounds: "profile" };
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
    try { if (NB_VIEWS[id]) nbMark(NB_VIEWS[id]); } catch (e) { }   // welcome tasks: first visit
    if (window.FX && FX.Music) FX.Music.view(id);
    if (id === "invite") startInviteWatch(); else stopInviteWatch();   // friends' welcome-task progress is live while this screen is open
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
    const rawPrice = $("ticket-price").value.trim();
    if (rawPrice === "") { showNotification("Enter the ticket price first", "error"); $("ticket-price").focus(); return; }   // no default price: the host must type one
    const price = Number(rawPrice);
    if (!Number.isInteger(price) || price < 0 || price > 5000) { showNotification("Ticket price must be 0 to 5000 coins"); return; }
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
        .then(roomCode => ensureFavoritesLoaded().then(() => {
            const gid = roomCode + "-" + Date.now().toString(36);
            const ticketsData = generateMyTickets(ticketCount);
            return withTimeout(Coins.createGame(gid, roomCode, ticketPrice, ticketCount, myName, ticketsData), 15000,
                "Could not create the room. Check your network and try again.")
                .then(() => ({ gid, roomCode, ticketsData }));
        }))
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
                return ensureFavoritesLoaded().then(() => {
                    const ticketsData = generateMyTickets(ticketCount);
                    return Coins.joinGame(game.id, ticketCount, myName, ticketsData).then(r => {
                        ticketCount = r.tickets;
                        enter(game, { ticketsData, marked: {}, claimedTickets: [], claims: [] }, false);
                    });
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
    usedLineRows = new Set();
    claimRecords = {};
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
        claimedTickets.forEach(({ claim, ticket, row, nums }) => { if (claim) applyClaimVisuals(claim, ticket, false, row, nums); });
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
    closeRoomTimer = null;       // a new room starts with a clean slate
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
        const gid = gameId, last = liteMembers ? (Number(gameData && gameData.playerCount) || 99) <= 2 : !members.some(m => !m.isHost && m.uid !== Coins.user.uid);
        goHome(last ? Coins.endGame(gid).catch(() => { }) : null);   // the last player out closes the room
    } catch (e) { showNotification(e.message || "Could not refund. Try again.", "error"); }
}
document.addEventListener("visibilitychange", () => {
    if (document.hidden && isHost && gameId && gameData && !isDevGame && gameData.status !== "finished") {
        const g = gameData;
        const done = (g.claimsTaken && g.claimsTaken.housie && g.claimsTaken.housie.length) || (g.claimsLocked && g.claimsLocked.housie) || (g.calledNumbers || []).length >= 90;
        if (done) Coins.endGame(g.id || gameId).catch(() => { });   // the 3.5s close timer may never fire once the app is in the background
    }
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
    let finalCardsShown = false;
    let orphanTimer = null;
    let prevTaken = {};

    const onGame = g => {
        const prevLen = calledNumbers.length;
        gameData = g;
        if (isHost && !isDevGame) tlHostSync(g);
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

        if (primed && calledNumbers.length > prevLen && g.currentNumber != null) {
            showNotification(`New Number Drawn: ${g.currentNumber}`);
            if (window.FX) { FX.drawn(g.currentNumber); }
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
        const roomDone = (g.claimsTaken && g.claimsTaken.housie && g.claimsTaken.housie.length) || (g.claimsLocked && g.claimsLocked.housie) || (g.calledNumbers || []).length >= 90;
        if (g.status !== "finished" && !isDevGame && roomDone) {
            // the host closes the room after a short celebration; any other player does it as a backup if the host's phone is gone
            closeRoomSoon(g.id || gameId, isHost ? ROOM_CLOSE_MS : 20000);
            // everybody sees their win cards from this room while it waits to close
            if (!finalCardsShown) { finalCardsShown = true; showRoomWinCards(g.id || gameId).catch(e => console.warn("[wincard]", e)); }
        }

        if (g.status === "finished" && !intentionalExit && !finishHandled) {
            finishHandled = true;
            if (isDevGame) {
                // show my win cards first, then the result screen after 5 seconds
                showRoomWinCards(g.id || gameId, true)
                    .then(shown => { if (shown) setTimeout(() => { $("wincard-popup").classList.remove("active"); showDevResultScreen(g); }, ROOM_CLOSE_MS); else showDevResultScreen(g); })
                    .catch(() => showDevResultScreen(g));
            }
            else {
                showNotification("Game over. The room is closed.");
                setTimeout(() => { try { if (Coins.syncLedger) Coins.syncLedger(true); } catch (e) { } }, 1500);   // pick up any prize the host paid
                // the room is over: delete its temporary data from the backend (the room record + coin history stay)
                const gid = g.id || gameId;
                goHome(isHost ? new Promise(r => setTimeout(r, 800)).then(() => Coins.wipeRoom(gid)) : Coins.leaveGame(gid));
            }
        }
    };
    unwatchGame = Coins.watchGame(gid, onGame);

    // Players who are not the host only listen to their OWN player document (claims / wins); the full list
    // (Players popup) is read when it is opened. A live list cost every player a read for every change of every player.
    const lite = !isHost && !isDevGame;
    liteMembers = lite; membersAt = 0; mineSeen = false;
    if (lite) members = [];
    const applyMine = mine => {
        if (!mine) return;
        myClaims = new Set(mine.claims || []);
        (mine.claimedTickets || []).forEach(c => {
            if (c && c.claim) applyClaimVisuals(c.claim, c.ticket, mineSeen, c.row, c.nums);   // always: re-checks the strikes every update
        });
        mineSeen = true;                                    // the first snapshot only restores what was already won
        updateClaimButtons();
        syncMyWins(mine);   // every prize I win counts at once in the tasks
    };
    const onPlayers = (list, pending) => {
        members = list.map(p => Object.assign({}, p, {
            online: presenceOnline(p.uid)      // was always true; undefined = unknown
        }));
        renderMembers();
        if (isHost && !isDevGame) list.forEach(p => { if (p && p.uid && !(ticketsByUid[p.uid] && ticketsByUid[p.uid].length)) ensureTickets(p.uid); });   // tickets are ready before anyone claims
        if (!pending) syncMyWins();     // a write the server has not accepted yet is not a win
        // Nobody is the host any more (host left / account removed) but the room is still open:
        // close it, so a room can never stay alive without its host. Best effort (rules / admin sweep back it up).
        if (!isHost && !isDevGame && list.length && !list.some(p => p.isHost) && gameData && gameData.status !== "finished") {
            if (!orphanTimer) orphanTimer = setTimeout(() => {
                orphanTimer = null;
                Coins.endGame(gid).catch(() => { });
            }, 4000);
        } else if (orphanTimer) { clearTimeout(orphanTimer); orphanTimer = null; }
        if (Coins.user && !pending) applyMine(list.find(p => p.uid === Coins.user.uid));
    };
    const onMine = (p, pending) => {
        const i = members.findIndex(x => x.uid === p.uid);
        if (i >= 0) members[i] = Object.assign({}, members[i], p); else members.push(p);
        renderMembers();
        if (pending) return;
        syncMyWins();
        applyMine(p);
    };
    const startPlayers = () => (lite ? Coins.watchMyPlayer(gid, onMine) : Coins.watchPlayers(gid, onPlayers));
    unwatchPlayers = startPlayers();

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
                    unwatchPlayers = startPlayers();
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
function syncMyWins(mine) {
    if (!gameData || !gameId || !window.Coins || !Coins.user) return;
    // players who are not the host only listen to their own player document (no member list), so it is passed in
    const me = mine || members.find(x => x.uid === Coins.user.uid);
    if (!me) return;
    (me.claimedTickets || []).forEach(c => {
        if (!c || !c.claim) return;
        const pct = (gameData.split || {})[c.claim];
        if (!Number.isFinite(pct)) return;
        const total = Coins.prizeShare(gameData.pot, c.claim, gameData.split) + Coins.bonusFor(c.claim, gameData.playerCount, gameData.pot);
        if (total > 0) Coins.localAdd({ id: "win_" + gameId + "_" + c.claim, type: "win", gameId, prize: c.claim, amount: total, mode: isDevGame ? "dev" : undefined });
    });
}

// Reloads the page, but only after the local coin/task history has actually been saved to
// Firestore. localAdd() (wins, entry fees) only queues that save - it waits up to 20s so repeated
// plays don't spam writes - and a reload wipes the in-memory copy before that timer can fire. Every
// "leave the game screen" path must go through this (or otherwise flush first), or the games played
// and prizes won in that session silently vanish from Tasks/Stats/History after the reload.
function reloadApp() {
    const flush = (window.Coins && Coins.cloudFlush) ? Coins.cloudFlush().catch(() => { }) : Promise.resolve();
    Promise.race([flush, new Promise(r => setTimeout(r, 4000))]).then(() => location.reload());
}

// cleanup (optional promise): runs before reload so the backend clean-up is never cut off (max 5s wait)
function goHome(cleanup) {
    stopListeners();
    const wait = Promise.race([Promise.resolve(cleanup).catch(() => { }), new Promise(r => setTimeout(r, 5000))]);
    wait.then(() => Coins.clearActiveGame()).catch(() => { }).then(() => reloadApp());
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
const ROOM_CLOSE_MS = 5000;   // after Housie is won (or all 90 numbers are drawn) the win cards are shown, then the room closes after 5 seconds
// Ends the room (status finished) and retries when it fails. A failed attempt used to be forgotten for good,
// which left finished games listed as live. Safe to call many times: only one timer runs.
function closeRoomSoon(gid, delay, tries) {
    if (closeRoomTimer || !gid) return;
    closeRoomTimer = setTimeout(async () => {
        await Promise.allSettled([...inFlight]);
        for (let i = 0; i < 3; i++) {
            if (gameData && (gameData.id || gid) === gid && gameData.status === "finished") return;
            try { await Coins.endGame(gid); return; }
            catch (e) { console.warn("[close room]", e); await new Promise(r => setTimeout(r, 2500)); }
        }
        closeRoomTimer = null;       // every try failed: try again in 10s (up to 5 rounds), and any new update of the room also retries
        if ((tries || 0) < 5) setTimeout(() => {
            if (gameData && (gameData.id || gid) === gid && gameData.status !== "finished") closeRoomSoon(gid, 0, (tries || 0) + 1);
        }, 10000);
    }, delay);
}

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
    let row = null, nums;

    if (req.claim === "jaldi") {
        if (all.filter(hit).length < 5) return { ok: false, reason: "Marked numbers not matching. Check with host." };
        const mine = new Set(all.filter(hit));
        nums = calledNumbers.map(Number).filter((n, i, a) => mine.has(n) && a.indexOf(n) === i).slice(0, 5);   // the five that won it, in the order they were called
    } else if (req.claim === "housie") {
        if (!all.length || !all.every(hit)) return { ok: false, reason: "Ticket is not full" };
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
    return { ok: true, ticket: idx, row, nums, share: Coins.prizeShare(gameData.pot, req.claim, gameData.split), bonus: Coins.bonusFor(req.claim, gameData.playerCount, gameData.pot) };
}

// Judges a claim and, if valid, records it. Resolves with the verdict.
function handleClaimRequest(req) {
    if (req.id) {
        if (handledRequests.has(req.id)) return Promise.resolve(null);
        handledRequests.add(req.id);
    }
    // Strict first-come-first-served: every claim is judged AND reserved (pendingPrizes / pendingRows) one after the
    // other in the order it arrived. A claim whose tickets still had to load used to be judged AFTER a later claim
    // that already had its tickets, so the slower tap could win. Only the judge + reservation wait in line; the paying
    // write (network) runs on its own, so nobody waits behind another player's payment.
    const started = claimChain
        .then(() => ensureTickets(req.uid))
        .then(() => ({ job: processClaim(orderLineClaim(req)) }));   // wrapped, so the line does not wait for the payment
    claimChain = started.catch(() => { });
    return started.then(o => o.job);
}
let claimChain = Promise.resolve();   // claims waiting to be judged, oldest first

// Line prizes are always awarded in order (1st, then 2nd, then 3rd), whichever line button the player tapped:
// a line claim is turned into the first line prize nobody has won (or is being paid for) yet.
function orderLineClaim(req) {
    if (!req || !/^line[123]$/.test(req.claim)) return req;
    const next = ["line1", "line2", "line3"].find(k => !claimsLocked[k] && !(k in pendingPrizes));
    if (!next || next === req.claim) return req;
    return Object.assign({}, req, { claim: next });
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

    const payload = {
        claim: req.claim, uid: req.uid, name: req.name,
        ticket: verdict.ticket, row: verdict.row, nums: verdict.nums, share: verdict.share, bonus: verdict.bonus
    };
    const ok = () => {
        release();
        recordClaimLocally(req, verdict);
        return { ok: true, claim: req.claim, ticket: verdict.ticket, row: verdict.row, nums: verdict.nums };
    };
    const gid = gameId;
    const attempt = tryNo => Coins.settleClaim(gid, payload).then(ok, async e => {
        console.error("[claim] attempt " + tryNo, e);
        // the write may have landed even though the answer was lost (slow / dropped network)
        if (await Coins.claimRecorded(gid, req.claim, req.uid)) return ok();
        const msg = (e && e.message) || "";
        const permanent = /Can't do that now|Quota/i.test(msg);
        if (!permanent && tryNo < 3) {                 // network trouble: wait a moment and write again
            await new Promise(r => setTimeout(r, 1200 * tryNo));
            if (await Coins.claimRecorded(gid, req.claim, req.uid)) return ok();
            return attempt(tryNo + 1);
        }
        release();
        if (permanent) {
            // the server refused it: most often another claim for the same prize got there first
            const who = await Coins.claimWinner(gid, req.claim);
            if (who && who.length) return { ok: false, reason: `${CLAIM_LABELS[req.claim]} was already claimed by ${who.join(", ")}` };
            if (/Quota/i.test(msg)) return { ok: false, reason: "Server limit reached for today. Claim will work again after the daily reset." };
            return { ok: false, reason: "Could not record this claim: the server refused it (" + msg.replace(/\.\s.*$/, "") + ")." };
        }
        return { ok: false, reason: msg ? "Could not record this claim: " + msg : "Could not record this claim. Try again." };
    });
    const job = attempt(1);
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
        m.claimedTickets = (m.claimedTickets || []).concat({ claim: req.claim, ticket: v.ticket, row: v.row, nums: v.nums });
    }
    updateClaimButtons();
    renderMembers();
    syncMyWins();     // the server accepted the claim: count it in the history now (idempotent by id)
    // in a match against the developer, the developer's own wins must not show "paid" to the player (the live listener already says who won)
    if (!(isDevGame && Coins.user && req.uid !== Coins.user.uid))
        showNotification(v.share ? `${CLAIM_LABELS[req.claim]} paid: 🪙 ${v.share}` : `${CLAIM_LABELS[req.claim]} claimed`, "success");
    if (req.claim === "housie" && isDevGame && gameData && gameData.devUid) {
        // 1:1 developer match: it is over now, so end it and free the developer straight away
        // (do not wait for a timer that "Back to Home" could cancel)
        endDevMatch(gameData.devUid, gameId);
    }
    if (req.claim === "housie") closeRoomSoon(gameId, ROOM_CLOSE_MS);      // Housie is the last prize: show the win cards, then close the room after 5 seconds
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

    // beating the developer 1-on-1 is a bigger deal than any single prize, so it gets its own
    // shareable card too, on top of the per-prize cards already shown during the match
    if (iWonHousie && typeof showSpecialCard === "function") {
        let total = 0;
        PRIZE_ORDER.forEach(k => {
            const w = taken[k];
            if (w && w.includes(myName)) total += Coins.prizeShare(g.pot, k, split) + Coins.bonusFor(k, g.playerCount, g.pot);
        });
        setTimeout(() => showSpecialCard("devwin", total).catch(() => { }), 600);
    }

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
    reloadApp();
};
$("devresult-again").onclick = () => {
    $("devresult-screen").classList.remove("active");
    sessionStorage.setItem("housie.devagain", "1");
    reloadApp();
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

    const totalMem = (liteMembers && gameData && Number(gameData.playerCount)) ? Math.max(members.length, Number(gameData.playerCount)) : members.length;
    document.getElementById("total-members").textContent = totalMem;
    // the room document and the player list arrive separately: if the list is ahead (someone just joined),
    // use it for the total instead of showing a stale counter
    const potFresh = gameData && Number.isFinite(gameData.pot) && !(Number.isFinite(gameData.playerCount) && members.length > gameData.playerCount);
    const totalPot = potFresh ? gameData.pot : Math.max(totalTickets * ticketPrice, (gameData && gameData.pot) || 0);
    document.getElementById("total-price").textContent = totalPot;
    const msub = document.getElementById("members-sub");
    if (msub) msub.textContent = `${totalMem} ${totalMem === 1 ? "player" : "players"} · 🪙 ${totalPot}`;
}

/* ================= GAMEPLAY ACTIONS ================= */
let lastDrawAt = 0;
document.getElementById("btn-draw").onclick = () => {
    if (!isHost || !gameId) return;
    if (autoOn) { autoStop("Auto generate paused"); return; }
    // the first tap of a game starts auto generate (one write for the whole game instead of one per number)
    if (!calledNumbers.length && !isDevGame) { autoStart(); return; }
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
const AUTO_SPEEDS = [1, 2, 3, 4, 5, 8], AUTO_DEFAULT = 4;
const DRAW_LABEL = "Generate Number";
let autoOn = false, autoTimer = null, autoTL = false;   // autoTL: this auto run uses the shared clock
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
    const was = autoOn, tl = autoTL;
    autoOn = false; autoTL = false;
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    paintAutoUI();
    if (was && msg) showNotification(msg);
    // shared clock: the pause has to reach every phone (they would keep drawing otherwise)
    if (was && tl && gameId && gameData && gameData.status !== "finished") {
        Coins.autoPause(gameId).then(ok => { if (!ok && msg) showNotification("Could not pause for everyone. Auto generate stays on.", "error"); });
    }
}
// after a reload the host finds the clock still running: show it as auto generate again
function tlHostSync(g) {
    if (autoOn || !g.dRun || g.status === "finished" || (g.claimsLocked && g.claimsLocked.housie)) return;
    autoOn = true; autoTL = true;
    const sec = Math.round((Number(g.dMs) || 0) / 1000);
    if (AUTO_SPEEDS.includes(sec)) autoSec = sec;
    paintAutoUI(); autoSchedule(1000);
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
    if (autoTL) { autoSchedule(1000); return; }       // the shared clock draws by itself: this is only a watchdog
    Coins.draw(gameId).then(r => {
        if (r && r.done) { autoStop("All numbers drawn!"); return; }
        if (autoOn) autoSchedule(autoSec * 1000);
    }).catch(e => autoStop((e && e.message) || "Auto generate paused: could not draw a number"));
}
async function autoStart() {
    if (!isHost || !gameId || autoOn) return;
    autoOn = true; autoTL = false;
    paintAutoUI();
    let ok = false;
    if (!isDevGame) ok = await Coins.autoStart(gameId, autoSec * 1000);
    if (!autoOn) return;                                // paused while the start was being saved
    autoTL = ok;
    showNotification(`Auto generate on · every ${autoSec} sec. Tap Pause to draw yourself.`);
    autoSchedule(ok ? 1000 : 400);
}
$("auto-head").onclick = () => {
    const p = $("auto-panel");
    const open = p.classList.toggle("hidden") === false;
    $("auto-head").setAttribute("aria-expanded", String(open));
    $("auto-head").classList.toggle("open", open);
    menuFocus("auto-menu", open);
};
$("auto-toggle").onchange = e => {
    closeMenu();
    if (e.target.checked) { autoStart(); nbMark("auto"); } else autoStop("Auto generate paused");
};
document.querySelectorAll(".auto-speed button").forEach(b => {
    b.onclick = () => {
        autoSec = Number(b.dataset.sec);
        store.set("autoSec", autoSec);
        paintAutoUI();
        if (autoOn && autoTL) Coins.autoSpeed(gameId, autoSec * 1000);          // everyone's clock follows the new speed
        else if (autoOn) autoSchedule(autoSec * 1000); // new speed applies from now
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
    myTicketsData = ticketsData || [];
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
        marked[card.dataset.ticket] = Array.from(card.querySelectorAll(".number-cell.active, .number-cell.claimed")).map(c => Number(c.textContent));
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
            if (cell.classList.contains("claimed")) { cell.classList.add("active"); return; }   // a number that already won a prize stays marked
            cell.classList.toggle("active");
            if (window.FX) FX.play(cell.classList.contains("active") ? "mark" : "unmark");
            const card = cell.closest(".ticket-card");
            if (card) scheduleMarkedSave(card.dataset.ticket);
        };
    });
}

/* ================= CLAIM HANDLING ================= */
let claimBusy = false;
const claimsWaiting = new Set();   // claims sent to the host that have no answer yet
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
    const isMatch = c => (c.classList.contains("active") || c.classList.contains("claimed")) && called.has(Number(c.textContent));
    for (let t = 1; t <= ticketCount; t++) {
        const card = document.querySelector(`[data-ticket="${t}"]`);
        if (!card) continue;
        const cells = Array.from(card.querySelectorAll(".number-cell"));
        if (claim === "jaldi") {
            if (cells.filter(isMatch).length >= 5) return { ticket: t, row: null };
        } else if (claim === "housie") {
            if (cells.length && cells.every(isMatch)) return { ticket: t, row: null };
        } else {
            // 1st / 2nd / 3rd line: first complete row of this ticket that has not already won a line
            const rows = Array.from(card.querySelectorAll(".ticket-row"));
            for (const rowEl of rows) {
                if (rowEl.classList.contains("line-strike") || usedLineRows.has(t + "|" + rowEl.dataset.row)) continue;   // this row already won a line
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
        applyClaimVisuals(result.claim, result.ticket, true, result.row, result.nums);
        // no popup during the game: the card is saved quietly and shown with the other wins when the room ends (see showRoomWinCards)
        const job = showWinCard(result, false).catch(e => console.warn("[wincard]", e));
        pendingWinCards.add(job);
        job.then(() => pendingWinCards.delete(job));
        if (result.claim === "housie" && !isDevGame && gameId) showRoomWinCards(gameId).catch(e => console.warn("[wincard]", e));
    } else {
        if (result && result.silent) return;          // host never answered: nothing is shown
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
    if (!document.querySelector(".ticket-card .number-cell.active, .ticket-card .number-cell.claimed")) {
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
    const activeCells = ticket ? Array.from(ticket.querySelectorAll(".number-cell.active, .number-cell.claimed")) : [];
    if (!activeCells.length) { showNotification("Mark numbers first!", "error"); return; }

    const payload = {
        claim: selectedClaim,
        name: myName,
        ticket: ticketIndex,
        marked: activeCells.map(c => Number(c.textContent))
    };
    if (row !== null && row !== undefined) payload.row = row;

    // a claim already waiting for the host is never sent twice
    if (claimsWaiting.has(selectedClaim)) return;
    const myKey = selectedClaim;
    claimsWaiting.add(myKey);
    setClaimBusy(true);                          // instant feedback + ignore repeat taps
    showNotification("Checking your claim…");
    // a slow host must not freeze the buttons: after 4 s they work again while this claim keeps waiting in the background
    const slow = setTimeout(() => { setClaimBusy(false); }, 4000);
    const finish = () => { clearTimeout(slow); claimsWaiting.delete(myKey); setClaimBusy(false); };
    const done = r => { finish(); handleClaimResult(r); };
    const fail = e => { finish(); showNotification((e && e.message) || "Claim failed", "error"); };
    if (isHost) {
        handleClaimRequest(Object.assign({ id: null, uid: Coins.user.uid }, payload)).then(done).catch(fail);
    } else {
        Coins.submitClaim(gameId, payload).then(done).catch(fail);
    }
}

// The ONLY source the strikes are drawn from: what the host approved for MY tickets, claim -> { ticket, row, nums }.
// renderClaimVisuals() rebuilds every strike / claimed cell from it, so a missed update, a reconnect or a late
// ticket render can never leave a wrong strike behind: the next render corrects it.
let claimRecords = {};
const ticketCardOf = n => document.querySelector(`.ticket-card[data-ticket="${Number(n)}"]`);

function renderClaimVisuals() {
    const called = new Set(calledNumbers.map(Number));
    const order = calledNumbers.map(Number);
    const isHit = c => (c.classList.contains("active") || c.classList.contains("claimed")) && (!called.size || called.has(Number(c.textContent)));   // called list not loaded yet (reconnect): trust the marks
    const wantClaimed = new Set(), wantStrike = new Set(), wantRows = new Set(), used = new Set();
    const recs = Object.keys(claimRecords).map(k => [k, claimRecords[k]]);
    // rows the host named are taken first, so an older claim that has no row can never grab one of them
    recs.forEach(([k, r]) => { if (k.startsWith("line") && r.row !== null) used.add(r.ticket + "|" + r.row); });
    recs.forEach(([claim, r]) => {
        const card = ticketCardOf(r.ticket);
        if (!card) return;                                   // tickets not drawn yet: the next render does it
        const cells = Array.from(card.querySelectorAll(".number-cell"));
        if (claim === "jaldi") {
            let five;
            if (r.nums) {
                const w = new Set(r.nums);                   // exactly the five numbers the host judged
                five = cells.filter(c => w.has(Number(c.textContent)));
            } else {
                const kept = cells.filter(c => c.classList.contains("strike"));   // older claim: keep the five already struck
                five = kept.length ? kept : cells.filter(isHit).sort((x, y) => {
                    const ix = order.indexOf(Number(x.textContent)), iy = order.indexOf(Number(y.textContent));
                    return (ix < 0 ? 1e9 : ix) - (iy < 0 ? 1e9 : iy);
                }).slice(0, 5);
            }
            five.forEach(c => { wantClaimed.add(c); wantStrike.add(c); });
        } else if (claim.startsWith("line")) {
            const rows = Array.from(card.querySelectorAll(".ticket-row"));
            let rowEl = null;
            if (r.row !== null) rowEl = rows.find(x => Number(x.dataset.row) === r.row) || null;   // the host judged this exact row
            else {
                // older claim without a row: first completed row nobody else owns; remembered once found
                rowEl = rows.find(x => !used.has(r.ticket + "|" + x.dataset.row) && x.querySelectorAll(".number-cell").length && Array.from(x.querySelectorAll(".number-cell")).every(isHit)) || null;
                if (rowEl) { r.row = Number(rowEl.dataset.row); used.add(r.ticket + "|" + r.row); }
            }
            if (rowEl) { wantRows.add(rowEl); rowEl.querySelectorAll(".number-cell").forEach(c => wantClaimed.add(c)); }
        } else if (claim === "housie") {
            cells.forEach(c => wantClaimed.add(c));          // the host judged the whole ticket as full
        }
    });
    // change only what differs (no flicker / re-animation of cells that are already right)
    document.querySelectorAll(".ticket-card .number-cell").forEach(c => {
        const has = c.classList.contains("claimed");
        if (wantClaimed.has(c)) { if (!has) c.classList.add("claimed"); }
        else if (has) { c.classList.remove("claimed"); c.classList.add("active"); }   // no longer claimed, but it stays marked
        if (wantStrike.has(c) !== c.classList.contains("strike")) c.classList.toggle("strike", wantStrike.has(c));
    });
    document.querySelectorAll(".ticket-card .ticket-row").forEach(el => {
        if (wantRows.has(el) !== el.classList.contains("line-strike")) el.classList.toggle("line-strike", wantRows.has(el));
    });
    usedLineRows = used;
}

// Runs for the player whose claim the host accepted (celebrate = false when silently restoring a past claim on
// reconnect, instead of re-firing the toast / win screen for something already won). Safe to call any number of times.
function applyClaimVisuals(claim, ticketIndex, celebrate = true, row, nums) {
    if (!claim || !ticketIndex) return;
    const newRow = (row === null || row === undefined || row === "") ? null : Number(row);
    const prev = claimRecords[claim];
    claimRecords[claim] = {
        ticket: Number(ticketIndex),
        row: newRow !== null ? newRow : (prev && prev.ticket === Number(ticketIndex) ? prev.row : null),
        nums: Array.isArray(nums) && nums.length ? nums.map(Number) : (prev && prev.nums) || null
    };
    renderClaimVisuals();
    if (appliedClaimVisuals.has(claim)) return;              // celebrated (or silently restored) already
    appliedClaimVisuals.add(claim);
    if (!celebrate) return;
    if (claim === "jaldi") { showNotification("Jaldi 5 Claimed!"); if (window.FX) FX.play("prizeJaldi"); }
    else if (claim.startsWith("line")) {
        const lineIdx = parseInt(claim.replace("line", "")) - 1;
        showNotification(`Line ${lineIdx + 1} Claimed!`); if (window.FX) FX.play("prizeLine" + Math.min(3, Math.max(1, lineIdx + 1)));
    } else if (claim === "housie") showWinScreen();
}

/* ================= WIN CARDS (shareable / copyable / downloadable) ================= */
// One shareable 1080x1920 PNG per prize won (Jaldi / a Line / Housie), stored on-device
// (IndexedDB - this app has no server to keep media on) and shown in Profile > Win Cards.

const PRIZE_CARD = {
    jaldi: { sub: "FIRST 5 NUMBERS", title: "JALDI FIVE!" },
    line1: { sub: "FIRST LINE", title: "1ST LINE!" },
    line2: { sub: "SECOND LINE", title: "2ND LINE!" },
    line3: { sub: "THIRD LINE", title: "3RD LINE!" },
    housie: { sub: "FULL HOUSE", title: "HOUSIE!" }
};

// Non-game rewards that also get a shareable card: daily login bonus, the lucky wheel spin,
// and task rewards (daily / weekly / monthly). "refill" (the small low-balance top-up) is
// left out on purpose - it's too small to be worth sharing.
const REWARD_CARD = {
    daily: { sub: "LOGIN STREAK", title: "DAILY BONUS!", icon: "🎁", c1: "#0ea5e9", c2: "#38bdf8" },
    wheel: { sub: "SPIN THE WHEEL", title: "LUCKY SPIN!", icon: "🎡", c1: "#9333ea", c2: "#c084fc" },
    task: { sub: "TASK REWARD", title: "TASK DONE!", icon: "🏆", c1: "#059669", c2: "#34d399" }
};
const REWARD_CARD_TYPES = new Set(Object.keys(REWARD_CARD));

// One-off celebratory cards that don't go through the generic reward()/showRewardCard path:
// the first-sign-up welcome bonus, a coin gift received from a friend, and beating the
// developer in a "Play with Developer" match (on top of the per-prize cards that match
// already gets via the normal claim flow).
const SPECIAL_CARD = {
    welcome: { sub: "YOU'RE IN!", title: "WELCOME!", icon: "🎉", c1: "#f59e0b", c2: "#fde68a" },
    gift: { sub: "FROM A FRIEND", title: "GIFT RECEIVED!", icon: "🎁", c1: "#ec4899", c2: "#f9a8d4" },
    devwin: { sub: "1-ON-1 MATCH", title: "BEAT THE DEVELOPER!", icon: "🤖", c1: "#ef4444", c2: "#fca5a5" }
};

// --- tiny IndexedDB wrapper: one object store, keyed by card id, read back per-user ---
const WinCardsDB = (function () {
    const DB_NAME = "housie-wincards", STORE = "cards";
    let dbp = null;
    function open() {
        if (dbp) return dbp;
        dbp = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: "id" });
                    store.createIndex("uid", "uid", { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
        });
        return dbp;
    }
    async function put(record) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).put(record);
            tx.oncomplete = () => resolve(record);
            tx.onerror = () => reject(tx.error);
        });
    }
    async function get(id) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, "readonly");
            const r = tx.objectStore(STORE).get(id);
            r.onsuccess = () => resolve(r.result || null);
            r.onerror = () => reject(r.error);
        });
    }
    async function all(uid) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, "readonly");
            const out = [];
            const store = tx.objectStore(STORE);
            const run = idx => {
                idx.openCursor(null, "prev").onsuccess = e => {
                    const cur = e.target.result;
                    if (!cur) { resolve(out); return; }
                    if (!uid || cur.value.uid === uid) out.push(cur.value);
                    cur.continue();
                };
            };
            try { run(store.index("uid")); } catch (e) { run(store); }
            tx.onerror = () => reject(tx.error);
        });
    }
    async function del(id) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    return { put, get, all, del };
})();

// Which cells of the winning ticket were actually claimed (cyan, struck) vs merely
// marked-but-not-claimed (indigo) vs never touched, for the win-card ticket drawing.
function winCardClaimedCells(claim, grid, row, calledSet, markedSet, nums) {
    const claimed = new Set();
    if (claim === "jaldi") {
        const where = new Map();   // number -> "row_col"
        grid.forEach((r, ri) => r.forEach((n, ci) => { if (n) where.set(Number(n), ri + "_" + ci); }));
        if (Array.isArray(nums) && nums.length) {
            // the five numbers the host judged: exactly the ones struck on the ticket
            nums.forEach(n => { if (where.has(Number(n))) claimed.add(where.get(Number(n))); });
        } else {
            // older claims carry no numbers: the first five marked numbers in the order they were called
            let count = 0;
            for (const n of calledSet) {
                if (count >= 5) break;
                if (where.has(n) && markedSet.has(n)) { claimed.add(where.get(n)); count++; }
            }
        }
    } else if (claim === "housie") {
        grid.forEach((r, ri) => r.forEach((n, ci) => { if (n) claimed.add(ri + "_" + ci); }));
    } else {
        let ri = row != null && row !== "" ? Number(row) : grid.findIndex(r => {
            const ns = r.filter(Boolean);
            return ns.length && ns.every(n => markedSet.has(Number(n)) && calledSet.has(Number(n)));
        });
        if (ri < 0) ri = 0;
        (grid[ri] || []).forEach((n, ci) => { if (n) claimed.add(ri + "_" + ci); });
    }
    return claimed;
}

function wcRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function wcSpacedText(ctx, text, cx, y, spacing) {
    const widths = Array.from(text).map(ch => ctx.measureText(ch).width);
    const total = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1);
    let x = cx - total / 2;
    for (let i = 0; i < text.length; i++) {
        ctx.fillText(text[i], x + widths[i] / 2, y);
        x += widths[i] + spacing;
    }
}

let wcFontsPromise = null;
function wcFontsReady() {
    if (!wcFontsPromise) {
        wcFontsPromise = Promise.all([
            document.fonts.load("800 90px Poppins"),
            document.fonts.load("700 48px Poppins"),
            document.fonts.load("600 32px Poppins")
        ]).then(() => document.fonts.ready).catch(() => { });
    }
    return wcFontsPromise;
}

// Draws the 3x9 ticket grid used at the bottom of a win card. `claimedCells` (Set of
// "row_col") get the cyan fill AND a diagonal red strike-through; `markedSet` numbers
// that are marked-but-not-claimed get the indigo "marked" fill with no strike.
function drawWinTicket(ctx, grid, claimedCells, markedSet, cx, top, width, claim) {
    const isLineWin = /^line[123]$/.test(claim || "");
    const cols = 9, rows = grid.length;
    const gap = Math.round(width * 0.012);
    const cellW = (width - gap * (cols - 1)) / cols;
    const cellH = cellW * 1.05;
    const left = cx - width / 2;

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const num = grid[r][c];
            const x = left + c * (cellW + gap);
            const y = top + r * (cellH + gap);
            const key = r + "_" + c;
            const isClaimed = num && claimedCells.has(key);
            const isMarked = num && !isClaimed && markedSet.has(num);

            ctx.save();
            wcRoundRect(ctx, x, y, cellW, cellH, cellW * 0.16);
            if (!num) {
                ctx.strokeStyle = "rgba(148,163,184,.4)";
                ctx.lineWidth = 2.5;
                ctx.setLineDash([4, 4]);
                ctx.stroke();
                ctx.restore();
                continue;
            }
            if (isClaimed) {
                ctx.fillStyle = "#22d3ee";
            } else if (isMarked) {
                ctx.fillStyle = "#6366f1";
            } else {
                ctx.fillStyle = "#1e293b";
            }
            ctx.fill();
            // border around every ticket number (lighter shade of the cell's own colour)
            ctx.lineWidth = Math.max(3, cellW * 0.04);
            ctx.setLineDash([]);
            ctx.strokeStyle = isClaimed ? "#cffafe" : isMarked ? "#c7d2fe" : "rgba(148,163,184,.6)";
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.fillStyle = isClaimed || isMarked ? "#0b1220" : "#e2e8f0";
            ctx.font = "700 " + Math.round(cellW * 0.42) + "px Poppins, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(num), x + cellW / 2, y + cellH / 2 + cellW * 0.02);
            ctx.restore();

            // per-cell diagonal strike, claimed cells only - number must stay readable underneath
            if (isClaimed && !isLineWin) {
                ctx.save();
                ctx.translate(x + cellW / 2, y + cellH / 2);
                ctx.rotate(-30 * Math.PI / 180);
                const strikeLen = cellW * 1.3;
                ctx.strokeStyle = "rgba(239,68,68,.85)";
                ctx.lineWidth = Math.max(6, cellW * 0.065);
                ctx.lineCap = "round";
                ctx.shadowColor = "rgba(239,68,68,.65)";
                ctx.shadowBlur = cellW * 0.18;
                ctx.beginPath();
                ctx.moveTo(-strikeLen / 2, 0);
                ctx.lineTo(strikeLen / 2, 0);
                ctx.stroke();
                ctx.restore();
            }
        }
    }

    // Line wins: ONE continuous strike-off through the whole winning row, edge to edge
    if (isLineWin) {
        let rowIdx = 0;
        outer: for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) { if (claimedCells.has(r + "_" + c)) { rowIdx = r; break outer; } }
        }
        const yMid = top + rowIdx * (cellH + gap) + cellH / 2;
        ctx.save();
        ctx.strokeStyle = "rgba(239,68,68,.92)";
        ctx.lineWidth = Math.max(8, cellH * 0.1);
        ctx.lineCap = "round";
        ctx.shadowColor = "rgba(239,68,68,.7)";
        ctx.shadowBlur = cellW * 0.25;
        ctx.beginPath();
        ctx.moveTo(left - cellW * 0.12, yMid);
        ctx.lineTo(left + width + cellW * 0.12, yMid);
        ctx.stroke();
        ctx.restore();
    }
    return top + rows * cellH + (rows - 1) * gap;
}

// Shortens `text` with an ellipsis so it fits within `maxWidth` at the ctx's current font.
function wcEllipsize(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    const ch = Array.from(String(text));   // by character, so an emoji is never cut in half
    while (ch.length > 1 && ctx.measureText(ch.join("") + "…").width > maxWidth) ch.pop();
    return ch.join("") + "…";
}

// A crisp vector prize wheel (white / dark segments, rim lights, hub, pointer) used instead of the thin
// 🎡 emoji on the wheel-spin card. Only whites and greys, so the random colour theme can't muddy it.
function drawSpinWheelIcon(ctx, cx, cy, r) {
    const R = r * 0.74, N = 8, rot = -Math.PI / 2 + Math.PI / N;
    ctx.save();
    // outer rim
    ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(cx, cy, R + 14, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    // segments
    for (let i = 0; i < N; i++) {
        const a0 = rot + i * 2 * Math.PI / N, a1 = a0 + 2 * Math.PI / N;
        ctx.fillStyle = i % 2 ? "rgba(255,255,255,.96)" : "rgba(15,23,42,.55)";
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a0, a1); ctx.closePath(); ctx.fill();
    }
    // segment dividers
    ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 3;
    for (let i = 0; i < N; i++) {
        const a = rot + i * 2 * Math.PI / N;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
    }
    // rim lights
    ctx.fillStyle = "rgba(15,23,42,.55)";
    for (let i = 0; i < N * 2; i++) {
        const a = rot + i * Math.PI / N;
        ctx.beginPath(); ctx.arc(cx + Math.cos(a) * (R + 7), cy + Math.sin(a) * (R + 7), 3.6, 0, Math.PI * 2); ctx.fill();
    }
    // star in every light segment
    ctx.fillStyle = "rgba(15,23,42,.55)"; ctx.font = "700 " + Math.round(R * 0.26) + "px Poppins, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let i = 1; i < N; i += 2) {
        const a = rot + (i + 0.5) * 2 * Math.PI / N;
        ctx.fillText("\u2605", cx + Math.cos(a) * R * 0.66, cy + Math.sin(a) * R * 0.66 + 2);
    }
    // hub
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(cx, cy, R * 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(15,23,42,.55)"; ctx.beginPath(); ctx.arc(cx, cy, R * 0.09, 0, Math.PI * 2); ctx.fill();
    // pointer at the top
    ctx.shadowColor = "rgba(0,0,0,.4)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 4;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(cx, cy - R - 2); ctx.lineTo(cx - 20, cy - R - 38); ctx.lineTo(cx + 20, cy - R - 38); ctx.closePath(); ctx.fill();
    ctx.restore();
}

// Drawn in place of the ticket for non-game reward cards (daily bonus / wheel spin / task
// reward): a glowing circular badge with the reward's icon, plus an optional note line
// underneath (the streak day, or the task's title).
function drawRewardBadge(ctx, spec, top, cx) {
    const r = 150, cy = top + r;
    ctx.save();
    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    g.addColorStop(0, spec.badgeColor2 || "#38bdf8");
    g.addColorStop(1, spec.badgeColor1 || "#0ea5e9");
    ctx.fillStyle = g;
    ctx.shadowColor = (spec.badgeColor1 || "#0ea5e9") + "99";
    ctx.shadowBlur = 55;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (spec.icon === "🎡") {
        drawSpinWheelIcon(ctx, cx, cy + 8, r);
    } else {
        ctx.save();
        ctx.font = Math.round(r * 0.95) + "px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(spec.icon || "🎉", cx, cy + r * 0.04);
        ctx.restore();
    }

    let y2 = cy + r + 76;
    if (spec.note) {
        ctx.save();
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "700 40px Poppins, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(wcEllipsize(ctx, spec.note, 880), cx, y2);
        ctx.restore();
    }
}

/* ---------- Celebration theme for the shareable win cards ---------- */
function wcSparkle(ctx, x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 - Math.PI / 2, rr = i % 2 ? r * 0.3 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    ctx.closePath(); ctx.fill();
}
function wcBalloon(ctx, x, y, r, color) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, y + r * 1.2); ctx.bezierCurveTo(x - 22, y + r * 1.2 + 60, x + 22, y + r * 1.2 + 120, x, y + r * 1.2 + 220); ctx.stroke();
    ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, y, r * 0.82, r, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x, y + r * 0.98); ctx.lineTo(x - 9, y + r * 1.2); ctx.lineTo(x + 9, y + r * 1.2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.35)"; ctx.beginPath(); ctx.ellipse(x - r * 0.32, y - r * 0.38, r * 0.14, r * 0.26, -0.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
}
// everything that sits BEHIND the text: gradient + glow only (confetti removed)
function wcCelebrationBG(ctx, W, H, cy) {
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0c1a2e"); bg.addColorStop(0.5, "#0a2236"); bg.addColorStop(1, "#050914");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, cy, 60, W / 2, cy, W * 0.8);
    glow.addColorStop(0, "rgba(34,211,238,.26)"); glow.addColorStop(1, "rgba(34,211,238,0)");
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
    // no confetti / squiggles / dots - background is just the gradient + glow
}
// gold frame + sparkles drawn on top of everything
function wcCelebrationFG(ctx, W, H) { }
// gold ribbon banner behind the small heading
function wcRibbon(ctx, W, text, cy) {
    ctx.save();
    ctx.font = "800 48px Poppins, sans-serif";
    const sw = ctx.measureText(text).width, rw = sw + 110, rh = 72, rx = W / 2 - rw / 2, ry = cy - rh / 2 + 4;
    ctx.fillStyle = "#b45309";
    [[rx, -1], [rx + rw, 1]].forEach(([ex, d]) => {
        ctx.beginPath(); ctx.moveTo(ex - d * 20, ry + 14); ctx.lineTo(ex + d * 60, ry + 14); ctx.lineTo(ex + d * 30, ry + rh / 2 + 14); ctx.lineTo(ex + d * 60, ry + rh + 14); ctx.lineTo(ex - d * 20, ry + rh + 14); ctx.closePath(); ctx.fill();
    });
    const g = ctx.createLinearGradient(0, ry, 0, ry + rh); g.addColorStop(0, "#fde68a"); g.addColorStop(1, "#f59e0b");
    ctx.fillStyle = g; wcRoundRect(ctx, rx, ry, rw, rh, 10); ctx.fill();
    ctx.fillStyle = "#4a1d00"; ctx.textAlign = "center"; ctx.fillText(text, W / 2, ry + rh / 2 + 17);
    ctx.restore();
}

async function renderWinCardCanvas(spec) {
    await wcFontsReady();
    const W = 1080, H = 1920;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    // The content block (brand -> title -> chip -> prize -> ticket/badge -> footer) used to be
    // laid out from a fixed top offset while the footer was pinned near the bottom regardless
    // of how tall the ticket/badge above it actually was - on a 3-row ticket (or any reward
    // badge, which is shorter still) that left a huge dead gap in the lower half of the card.
    // Measuring the content's real height up front and shifting the whole block by one offset
    // centers it vertically instead, with even margin top and bottom, whatever the card holds.
    const topMargin = 72;                 // visual top of the "HOUSIE GAME" brand text
    const ticketWidthCalc = W * 0.88;
    const gapCalc = Math.round(ticketWidthCalc * 0.012);
    const cellWCalc = (ticketWidthCalc - gapCalc * 8) / 9;
    const contentBottom = spec.grid
        ? 882 + (cellWCalc * 1.05 * spec.grid.length + gapCalc * (spec.grid.length - 1))
        : (spec.noBadge ? (spec.noWrap ? 772 : 892 + 60) : 892 + 300 + (spec.note ? 76 + 40 : 0));
    const footY = contentBottom + 110 + (spec.grid ? 22 : 0);
    const totalHeight = (footY + 200) - topMargin;
    const offsetY = Math.round((H - totalHeight) / 2 - topMargin);

    wcCelebrationBG(ctx, W, H, topMargin + offsetY + totalHeight * 0.4);

    // "SAMPLE"-style small corner label omitted on purpose: this is a real win, not a sample

    // everything from here down is the content block, shifted as one unit to center it
    ctx.save();
    ctx.translate(0, offsetY);

    // brand text
    ctx.fillStyle = "rgba(226,232,240,.75)";
    ctx.font = "600 34px Poppins, sans-serif";
    wcSpacedText(ctx, "HOUSIE GAME", W / 2, 100, 7);

    // subtitle
    ctx.fillStyle = "#22d3ee";
    ctx.font = "800 46px Poppins, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(spec.sub, W / 2, 172);

    // big gradient title with glow
    ctx.save();
    let titleFs = 124;                       // long titles shrink until they fit inside the card
    ctx.font = "800 " + titleFs + "px Poppins, sans-serif";
    const tickExtra = () => (spec.titleTick ? Math.round(titleFs * 0.76) + 28 : 0);    // room for the green tick beside the title
    while (titleFs > 60 && ctx.measureText(spec.title).width + tickExtra() > W - 100) { titleFs -= 4; ctx.font = "800 " + titleFs + "px Poppins, sans-serif"; }
    ctx.textAlign = "center";
    const titleGrad = ctx.createLinearGradient(W / 2 - 300, 0, W / 2 + 300, 0);
    titleGrad.addColorStop(0, "#ffffff");
    titleGrad.addColorStop(0.5, "#67e8f9");
    titleGrad.addColorStop(1, "#3b82f6");
    ctx.fillStyle = titleGrad;
    ctx.shadowColor = "rgba(34,211,238,.65)";
    ctx.shadowBlur = 36;
    if (spec.titleTick) {
        const tw = ctx.measureText(spec.title).width, tr = Math.round(titleFs * 0.38), gap = 28;
        const x0 = W / 2 - (tw + gap + tr * 2) / 2;
        ctx.textAlign = "left";
        ctx.fillText(spec.title, x0, 326);
        ctx.restore();
        ctx.save();
        const cx = x0 + tw + gap + tr, cy = 326 - titleFs * 0.36;
        ctx.shadowColor = "rgba(34,197,94,.7)"; ctx.shadowBlur = 28;
        ctx.fillStyle = "#22c55e";
        ctx.beginPath(); ctx.arc(cx, cy, tr, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "#fff"; ctx.lineWidth = Math.max(8, tr * 0.2); ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.beginPath(); ctx.moveTo(cx - tr * 0.42, cy + tr * 0.02); ctx.lineTo(cx - tr * 0.1, cy + tr * 0.34); ctx.lineTo(cx + tr * 0.46, cy - tr * 0.3); ctx.stroke();
        ctx.restore();
        ctx.save();
    } else ctx.fillText(spec.title, W / 2, 326);
    ctx.restore();

    // winner chip: avatar circle + "<Name> won!"
    const chipY = 420, chipH = 112;
    ctx.save();
    // a long name first gets a smaller font (50px down to 34px), then a "..." cut, so "won!" and both chip ends stay inside the card
    const wonTxt = spec.chipSuffix != null ? spec.chipSuffix : " won!", fullName = String(spec.name || "Player").trim() || "Player";
    const chipMaxText = W - 120 - chipH - 80;
    let nameFs = 50;
    while (nameFs > 34) {
        ctx.font = `700 ${nameFs}px Poppins, sans-serif`;
        if (ctx.measureText(fullName + wonTxt).width <= chipMaxText) break;
        nameFs -= 2;
    }
    ctx.font = `700 ${nameFs}px Poppins, sans-serif`;
    const nameTxt = wcEllipsize(ctx, fullName, chipMaxText - ctx.measureText(wonTxt).width) + wonTxt;
    const nameW = ctx.measureText(nameTxt).width;
    const chipW = nameW + chipH + 80;
    const chipX = W / 2 - chipW / 2;
    if (!spec.noWrap) {          // receipts have no box around the name
        ctx.fillStyle = "rgba(255,255,255,.1)";
        wcRoundRect(ctx, chipX, chipY, chipW, chipH, chipH / 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = 3; ctx.stroke();
    }
    const avCx = chipX + chipH / 2, avCy = chipY + chipH / 2, avR = chipH / 2 - 8;
    const avGrad = ctx.createLinearGradient(avCx - avR, avCy - avR, avCx + avR, avCy + avR);
    avGrad.addColorStop(0, "#a855f7");
    avGrad.addColorStop(1, "#6366f1");
    ctx.fillStyle = avGrad;
    ctx.beginPath(); ctx.arc(avCx, avCy, avR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "700 48px Poppins, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(spec.initial, avCx, avCy + 2);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${nameFs}px Poppins, sans-serif`;
    ctx.fillText(nameTxt, chipX + chipH + 14 + nameW / 2, chipY + chipH / 2 + Math.round(nameFs * 0.36));
    ctx.restore();

    // PRIZE PAID block
    const compact = !!(spec.noBadge && spec.noWrap);   // receipts: no "DEBITED"/"COINS" labels, tight spacing
    let y = chipY + chipH + 80;
    ctx.fillStyle = "rgba(148,163,184,.8)";
    ctx.font = "700 38px Poppins, sans-serif";
    ctx.textAlign = "center";
    if (!compact) wcSpacedText(ctx, spec.amountLabel || "PRIZE PAID", W / 2, y, 6);
    y += compact ? 10 : 76;
    // gold star coin + amount: measured so the pair is always centred and never overlaps
    const coinR = 42, coinGap = 22;
    const amtTxt = spec.amountText || String(spec.amount);
    ctx.font = "800 88px Poppins, sans-serif";
    const amtW = ctx.measureText(amtTxt).width;
    const groupW = coinR * 2 + coinGap + amtW;
    const groupX = W / 2 - groupW / 2;
    ctx.save();
    ctx.translate(groupX + coinR, y);
    const coinGrad = ctx.createRadialGradient(-8, -8, 4, 0, 0, coinR);
    coinGrad.addColorStop(0, "#fde68a");
    coinGrad.addColorStop(1, "#f59e0b");
    ctx.fillStyle = coinGrad;
    ctx.beginPath(); ctx.arc(0, 0, coinR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#b45309";
    ctx.font = "800 42px Poppins, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("★", 0, 2);
    ctx.restore();
    ctx.fillStyle = "#fff";
    ctx.font = "800 88px Poppins, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(amtTxt, groupX + coinR * 2 + coinGap, y + 30);
    ctx.textAlign = "center";
    y += compact ? 0 : 100;
    ctx.fillStyle = "rgba(148,163,184,.8)";
    ctx.font = "700 34px Poppins, sans-serif";
    if (!compact) wcSpacedText(ctx, "COINS", W / 2, y, 7);
    if (spec.claim === "housie" && spec.bonus) {
        ctx.fillStyle = "#fbbf24";
        ctx.font = "800 30px Poppins, sans-serif";
        ctx.fillText("YOU WON HOUSIE BONUS  -  " + spec.bonus + " COINS", W / 2, y + 50);
    }
    y += compact ? 50 : 64;

    // ticket (game wins) OR a reward badge + icon (daily bonus / wheel spin / task reward)
    if (spec.grid) {
        const ticketTop = y + 30;
        const ticketWidth = W * 0.88;
        const tg = Math.round(ticketWidth * 0.012), tcw = (ticketWidth - tg * 8) / 9;
        const th = tcw * 1.05 * spec.grid.length + tg * (spec.grid.length - 1), pad = 22;
        ctx.save();
        const bg2 = ctx.createLinearGradient(0, ticketTop - pad, 0, ticketTop + th + pad);
        bg2.addColorStop(0, "rgba(34,211,238,.10)"); bg2.addColorStop(1, "rgba(99,102,241,.10)");
        ctx.fillStyle = bg2; wcRoundRect(ctx, W / 2 - ticketWidth / 2 - pad, ticketTop - pad, ticketWidth + pad * 2, th + pad * 2, 30); ctx.fill();
        ctx.shadowColor = "rgba(34,211,238,.5)"; ctx.shadowBlur = 18;
        ctx.strokeStyle = "rgba(34,211,238,.85)"; ctx.lineWidth = 4; ctx.stroke();
        ctx.restore();
        drawWinTicket(ctx, spec.grid, spec.claimedCells, spec.markedSet, W / 2, ticketTop, ticketWidth, spec.claim);
    } else if (spec.noBadge) {
        if (spec.note) {
            ctx.save();
            ctx.fillStyle = "#e2e8f0"; ctx.font = "700 40px Poppins, sans-serif";
            ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
            ctx.fillText(wcEllipsize(ctx, spec.note, 880), W / 2, y + 60);
            ctx.restore();
        }
    } else {
        drawRewardBadge(ctx, spec, y + 40, W / 2);
    }

    // footer: pill (room code, or the brand for non-game rewards) + tagline + site
    // (footY was computed up front, right after the ticket/badge, so the whole card centers)
    ctx.save();
    ctx.font = "700 42px Poppins, sans-serif";
    const roomTxt = String(spec.pill || spec.room || "HOUSIE GAME").toUpperCase();
    const pillW = ctx.measureText(roomTxt).width + 84;
    if (!spec.noWrap) {          // receipts have no box around the brand name
        wcRoundRect(ctx, W / 2 - pillW / 2, footY, pillW, 80, 40);
        ctx.fillStyle = "rgba(34,211,238,.12)";
        ctx.fill();
        ctx.strokeStyle = "rgba(34,211,238,.6)";
        ctx.lineWidth = 3;
        ctx.stroke();
    }
    ctx.fillStyle = "#22d3ee";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(roomTxt, W / 2, footY + 42);
    ctx.restore();

    ctx.fillStyle = "rgba(226,232,240,.85)";
    ctx.font = "700 42px Poppins, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("Join me & win coins!", W / 2, footY + 146);
    ctx.fillStyle = "rgba(148,163,184,.85)";
    ctx.font = "600 32px Poppins, sans-serif";
    ctx.fillText("myhousiegame.vercel.app", W / 2, footY + 192);

    ctx.restore(); // matches the translate(0, offsetY) above
    wcCelebrationFG(ctx, W, H);
    return canvas;
}

function wcThumb(canvas) {
    const t = document.createElement("canvas");
    t.width = 216; t.height = 384;
    t.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
    return t.toDataURL("image/jpeg", 0.82);
}

// A fresh random colour theme for a finished card image. Used when the card is CREATED, so the version kept in
// the gallery (and its thumbnail) already has the random look - not only the copy that gets shared.
async function wcRandomTheme(canvas) {
    try {
        const dataUrl = await wcRecolor(canvas.toDataURL("image/png"));
        const im = await wcLoadImg(dataUrl);
        const c = document.createElement("canvas"); c.width = canvas.width; c.height = canvas.height;
        c.getContext("2d").drawImage(im, 0, 0);
        return { dataUrl, thumb: wcThumb(c) };
    } catch (e) {
        console.warn("[wincard] random theme failed", e);
        return { dataUrl: canvas.toDataURL("image/png"), thumb: wcThumb(canvas) };
    }
}

// Re-lays out a card image saved by an older version: content block + footer are moved so the empty
// middle is split evenly into top/bottom space, and (game cards) a border is added around the ticket.
function wcUpgradeImage(card) {
    return new Promise(resolve => {
        const im = new Image();
        im.onerror = () => resolve(null);
        im.onload = () => {
            try {
                const W = 1080, H = 1920;
                if (im.naturalWidth !== W || im.naturalHeight !== H) { resolve(null); return; }
                const c0 = document.createElement("canvas"); c0.width = W; c0.height = H;
                const x0 = c0.getContext("2d"); x0.drawImage(im, 0, 0);
                const src = x0.getImageData(0, 0, W, H), d = src.data;
                const px = (x, y, k) => d[(y * W + x) * 4 + k];
                // background colour of every row (median of 4 edge pixels, so a confetti piece can't skew it)
                const bg = new Array(H);
                for (let y = 0; y < H; y++) {
                    const col = [0, 1, 2].map(k => { const v = [4, 6, 8, 10].map(x => px(x, y, k)).sort((a, b) => a - b); return (v[1] + v[2]) / 2; });
                    bg[y] = col;
                }
                // rows that hold real content (bright text / cells), ignoring faint confetti
                const ink = new Array(H).fill(false);
                for (let y = 0; y < H; y++) {
                    let n = 0;
                    for (let x = 120; x < 960; x += 2) { if (Math.max(px(x, y, 0), px(x, y, 1), px(x, y, 2)) > 150) n++; }
                    ink[y] = n >= 6;
                }
                let t = -1, b = -1;
                for (let y = 0; y < H; y++) if (ink[y]) { if (t < 0) t = y; b = y; }
                if (t < 0) { resolve(null); return; }
                // biggest empty run between the first and last content row = the dead gap
                let g0 = -1, g1 = -1, run0 = -1;
                for (let y = t; y <= b + 1; y++) {
                    if (y <= b && !ink[y]) { if (run0 < 0) run0 = y; }
                    else if (run0 >= 0) { if (g0 < 0 || y - run0 > g1 - g0) { g0 = run0; g1 = y; } run0 = -1; }
                }
                if (g0 < 0 || g1 - g0 < 220) { resolve(null); return; }
                const pad = 80, ts = Math.max(0, t - pad), te = g0 + pad, bs = g1 - pad, be = Math.min(H, b + pad);
                const topH = te - ts, botH = be - bs, gapLen = bs - te;
                if (gapLen < 40) { resolve(null); return; }
                const gapNew = 170, m = Math.round((H - (g0 - t) - (b - g1) - gapNew) / 2);   // top/bottom space (ink only)
                const yTop = m - (t - ts), yBot = H - m - (be - bs) + (be - b);                // where each cropped block lands
                const out = document.createElement("canvas"); out.width = W; out.height = H;
                const xo = out.getContext("2d");
                // base: the old empty background rows (gradient + confetti), tiled to fill the whole card
                for (let y = 0; y < H; y += gapLen) xo.drawImage(im, 0, te, W, gapLen, 0, y, W, gapLen);
                // each block is pasted with soft top/bottom edges so no seam shows
                const paste = (sy, sh, dy, fTop, fBot) => {
                    const tc = document.createElement("canvas"); tc.width = W; tc.height = sh;
                    const tx = tc.getContext("2d"); tx.drawImage(im, 0, sy, W, sh, 0, 0, W, sh);
                    const mk = tx.createLinearGradient(0, 0, 0, sh);
                    mk.addColorStop(0, "rgba(0,0,0,0)"); mk.addColorStop(Math.min(.49, fTop / sh), "#000");
                    mk.addColorStop(Math.max(.51, 1 - fBot / sh), "#000"); mk.addColorStop(1, "rgba(0,0,0,0)");
                    tx.globalCompositeOperation = "destination-in"; tx.fillStyle = mk; tx.fillRect(0, 0, W, sh);
                    xo.drawImage(tc, 0, dy);
                };
                paste(ts, topH, yTop, Math.max(8, t - ts - 6), 70);
                paste(bs, be - bs, yBot, 70, Math.max(8, be - b - 6));
                // outer border around the ticket (game cards): the ticket sits at old y 815..1125, x 87..993
                if (/^(jaldi|line[123]|housie)$/.test(card.claim || "")) {
                    const pd = 22, tx = 87 - pd, tw = 906 + pd * 2, ty = 815 - t + m - pd, th = 310 + pd * 2;
                    const rr = (x, y, w, h, r) => { xo.beginPath(); xo.moveTo(x + r, y); xo.arcTo(x + w, y, x + w, y + h, r); xo.arcTo(x + w, y + h, x, y + h, r); xo.arcTo(x, y + h, x, y, r); xo.arcTo(x, y, x + w, y, r); xo.closePath(); };
                    xo.save();
                    const g = xo.createLinearGradient(0, ty, 0, ty + th); g.addColorStop(0, "rgba(34,211,238,.10)"); g.addColorStop(1, "rgba(99,102,241,.10)");
                    xo.fillStyle = g; rr(tx, ty, tw, th, 30); xo.fill();
                    xo.shadowColor = "rgba(34,211,238,.5)"; xo.shadowBlur = 18;
                    xo.strokeStyle = "rgba(34,211,238,.85)"; xo.lineWidth = 4; xo.stroke();
                    xo.restore();
                }
                resolve(out);
            } catch (e) { resolve(null); }
        };
        im.src = card.dataUrl;
    });
}

// One-time upgrade of cards saved before the centred layout (card.v < 2): re-lays out the image, saves it back.
async function wcUpgradeCards(cards) {
    for (const c of cards) {
        if (!c || c.v >= 2 || !/^data:image\//.test(c.dataUrl || "")) continue;
        try {
            const cv = await wcUpgradeImage(c);
            if (cv) { c.dataUrl = cv.toDataURL("image/png"); c.thumb = wcThumb(cv); }
            c.v = 2;
            await WinCardsDB.put(c);
        } catch (e) { console.warn("[wincard] upgrade failed", e); }
    }
    return cards;
}

// Snapshot of the room at the moment of a win (members, tickets, prizes and the coins each member
// took home). It is saved inside the card record, so the Win Cards gallery can show every room's
// details later without any network read.
async function wcRoomSnapshot(extraClaim) {
    if (!gameData || !gameId || !window.Coins || !Coins.user) return null;
    try {
        let list = (members || []).slice();
        // players who are not the host only hold their own player document: read the full list once
        if (liteMembers && list.length < Math.max(2, Number(gameData.playerCount) || 0) && Coins.getPlayers) {
            try {
                const got = await Promise.race([Coins.getPlayers(gameId), new Promise(r => setTimeout(() => r(null), 3000))]);
                if (got && got.length) list = got;
            } catch (e) { }
        }
        const pot = Number(gameData.pot) || 0, split = gameData.split || {};
        const coinsFor = k => (Coins.prizeShare(pot, k, split) || 0) + Coins.bonusFor(k, gameData.playerCount, gameData.pot);
        const me = Coins.user.uid;
        const mem = list.map(p => {
            const claims = new Set(p.claims || []);
            if (p.uid === me && extraClaim) claims.add(extraClaim);
            const cl = Array.from(claims);
            return {
                uid: p.uid, name: p.name || "Player", isHost: !!p.isHost,
                tickets: Number.isFinite(p.tickets) ? p.tickets : 0,
                claims: cl, coins: cl.reduce((a, k) => a + coinsFor(k), 0)
            };
        });
        if (!mem.some(m => m.uid === me)) {
            mem.push({ uid: me, name: myDisplayName(), isHost: !!isHost, tickets: (myTicketsData || []).length, claims: extraClaim ? [extraClaim] : [], coins: extraClaim ? coinsFor(extraClaim) : 0 });
        }
        const prizes = {};
        Object.keys(PRIZE_CARD).forEach(k => { if (Number.isFinite(split[k])) prizes[k] = coinsFor(k); });
        const host = mem.find(m => m.isHost);
        return {
            id: gameId, label: roomLabel(gameId), dev: !!isDevGame,
            pot, ticketPrice: Number.isFinite(gameData.ticketPrice) ? gameData.ticketPrice : ticketPrice,
            playerCount: Math.max(mem.length, Number(gameData.playerCount) || 0),
            called: (gameData.calledNumbers || calledNumbers || []).length,
            host: host ? host.name : "", members: mem, prizes, at: Date.now()
        };
    } catch (e) { console.warn("[wincard] room snapshot failed", e); return null; }
}

// Builds and stores a shareable win card for `result` ({ claim, ticket, row }).
// Game wins pass autoOpen = false: nothing pops up during the game. The card is saved, shown with the
// player's other wins when the room ends (showRoomWinCards), and kept in Profile > Win Cards.
async function showWinCard(result, autoOpen) {
    if (!result || !result.claim || !window.Coins || !Coins.user) return;
    const grid = (myTicketsData[result.ticket - 1] || []).map(r => r.slice());
    if (!grid.length) return;

    const calledSet = new Set((calledNumbers || []).map(Number));
    const ticketEl = document.querySelector(`[data-ticket="${result.ticket}"]`);
    const markedSet = new Set(ticketEl
        ? Array.from(ticketEl.querySelectorAll(".number-cell.active, .number-cell.claimed")).map(c => Number(c.textContent))
        : []);
    const claimedCells = winCardClaimedCells(result.claim, grid, result.row, calledSet, markedSet, result.nums);

    let amount = 0;
    if (gameData) {
        amount = Coins.prizeShare(gameData.pot, result.claim, gameData.split) || 0;
        amount += Coins.bonusFor(result.claim, gameData.playerCount, gameData.pot);
    }

    const name = myDisplayName();
    const meta = PRIZE_CARD[result.claim] || { sub: "WINNER", title: "YOU WON!" };
    const spec = {
        sub: meta.sub, title: meta.title,
        name, initial: avatarLetter(name),
        amount, room: roomLabel(gameId),
        bonus: gameData ? Coins.bonusFor(result.claim, gameData.playerCount, gameData.pot) : 0,
        grid, claimedCells, markedSet, claim: result.claim
    };

    let canvas;
    try { canvas = await renderWinCardCanvas(spec); }
    catch (e) { console.warn("[wincard] render failed", e); return; }

    const dataUrl = canvas.toDataURL("image/png");
    const roomInfo = await wcRoomSnapshot(result.claim);
    const card = {
        id: (gameId || "g") + "_" + result.claim + "_" + Date.now(),
        uid: Coins.user.uid,
        gameId: gameId || "",
        roomInfo,
        claim: result.claim,
        label: CLAIM_SHORT[result.claim] || "Win",
        amount, room: spec.room,
        time: Date.now(),
        dataUrl, thumb: wcThumb(canvas), v: 2
    };
    try { await WinCardsDB.put(card); } catch (e) { console.warn("[wincard] save failed", e); }
    lastWinCard = card;
    if (autoOpen) openWinCardPopup(card);
}

// Builds and stores a shareable card for a non-game reward (daily bonus / wheel spin / task).
// Daily bonus and wheel spin open the popup right away (once-a-day moments worth celebrating);
// task rewards save quietly into Profile > Win Cards instead, since several can be claimed in a
// row and a popup after every tap would get in the way - the "complete all" bonus tasks are the
// exception, since those are a real milestone.
async function showRewardCard(type, amount, label, extra) {
    if (!REWARD_CARD_TYPES.has(type) || !window.Coins || !Coins.user) return;
    const meta = REWARD_CARD[type];
    const name = myDisplayName();
    let note = "";
    let autoOpen = type === "daily" || type === "wheel";
    try {
        if (type === "daily") {
            const b = bonusState(await getLedger());
            note = "Day " + (b.done || 1) + " of 7";
        } else if (type === "task" && extra && extra.task) {
            const t = Object.values(TASKS).flat().find(x => x.id === extra.task);
            note = t ? t.title : (label || "");
            if (/_all_/.test(extra.task)) autoOpen = true; // "complete all" bonus - worth a popup
        }
    } catch (e) { /* note is cosmetic only - a lookup failure should never block the card */ }

    const spec = {
        sub: meta.sub, title: meta.title,
        name, initial: avatarLetter(name),
        amount, pill: "HOUSIE GAME",
        icon: meta.icon, badgeColor1: meta.c1, badgeColor2: meta.c2, note
    };

    let canvas;
    try { canvas = await renderWinCardCanvas(spec); }
    catch (e) { console.warn("[wincard] render failed", e); return; }

    const themed = await wcRandomTheme(canvas);               // random theme, also for the copy stored in the gallery
    const dataUrl = themed.dataUrl;
    const card = {
        id: type + "_" + Date.now(),
        uid: Coins.user.uid,
        claim: type,
        label: label || (meta && meta.title) || "Reward",
        amount, room: spec.pill,
        time: Date.now(),
        dataUrl, thumb: themed.thumb, v: 2
    };
    try { await WinCardsDB.put(card); } catch (e) { console.warn("[wincard] save failed", e); }
    lastWinCard = card;
    if (autoOpen) openWinCardPopup(card);
}

// Builds and stores a one-off celebratory card (SPECIAL_CARD: welcome / gift / devwin) and
// opens it right away - each of these only ever fires at most a handful of times per account.
async function showSpecialCard(kind, amount, note) {
    const meta = SPECIAL_CARD[kind];
    if (!meta || !window.Coins || !Coins.user) return null;
    const name = myDisplayName();
    const spec = {
        sub: meta.sub, title: meta.title,
        name, initial: avatarLetter(name),
        amount, pill: "HOUSIE GAME",
        icon: meta.icon, badgeColor1: meta.c1, badgeColor2: meta.c2, note: note || ""
    };
    let canvas;
    try { canvas = await renderWinCardCanvas(spec); }
    catch (e) { console.warn("[wincard] render failed", e); return null; }

    const dataUrl = canvas.toDataURL("image/png");
    const card = {
        id: kind + "_" + Date.now(),
        uid: Coins.user.uid,
        claim: kind,
        label: meta.title,
        amount, room: spec.pill,
        time: Date.now(),
        dataUrl, thumb: wcThumb(canvas), v: 2
    };
    try { await WinCardsDB.put(card); } catch (e) { console.warn("[wincard] save failed", e); }
    lastWinCard = card;
    openWinCardPopup(card);
    return card;
}

// Opening ANY card makes it the one Share / Copy / Download / Favorite / Delete act on. `ids` (optional) is the
// ordered list of card ids the viewer can step through (the visible cards of one room / shelf).
const wcV = { ids: [], i: 0, cache: new Map() };
// the re-themed picture currently on screen (never saved: the gallery keeps the original card)
let wcThemed = null;
const wcCur = card => (card && wcThemed && wcThemed.id === card.id) ? Object.assign({}, card, { dataUrl: wcThemed.url }) : card;
async function wcRetheme(card) {
    const url = card.spec ? (await renderInfoCardCanvas(Object.assign({}, card.spec, { pal: randomPalette() }))).toDataURL("image/png")
        : await wcRecolor(card.dataUrl);                            // card.dataUrl is always the original, so colours never degrade
    const out = Object.assign({}, card, { dataUrl: url });
    if ($("wincard-popup").classList.contains("active") && lastWinCard && lastWinCard.id === card.id) {
        wcThemed = { id: card.id, url };
        const img = $("wincard-img"); img.src = url; img.classList.remove("in"); void img.offsetWidth; img.classList.add("in");
    }
    return out;
}
// favorites (cards saved from an older version under "wcpins" carry over once)
const wcFavs = () => new Set(store.get("wcfavs", store.get("wcpins", [])));
function wcSetFavs(set) { store.set("wcfavs", Array.from(set)); }
function openWinCardPopup(card, ids) {
    if (!card) return;
    wcV.cache.set(card.id, card);
    wcV.ids = ids && ids.indexOf(card.id) >= 0 ? ids : [card.id];
    wcV.i = wcV.ids.indexOf(card.id);
    wcShow(card);
    $("wincard-popup").style.zIndex = winScreen.classList.contains("active") ? "2100" : "";   // the win screen (z-index 2000) must not cover it
    $("wincard-popup").classList.add("active");
}
function wcShow(card) {
    lastWinCard = card;
    const img = $("wincard-img");
    img.classList.remove("in"); void img.offsetWidth;
    if (wcThemed && wcThemed.id !== card.id) wcThemed = null;
    img.src = wcCur(card).dataUrl; img.classList.add("in");
    const wrap = $("wincard-tilt");
    const setAr = () => { if (img.naturalWidth) { wrap.style.setProperty("--ar", img.naturalWidth + " / " + img.naturalHeight); wrap.classList.toggle("wide", img.naturalWidth > img.naturalHeight * 0.8); } };
    img.onload = setAr; if (img.complete) setAr();
    $("wincard-title").textContent = card.label || "Your winning card";
    $("wincard-meta").innerHTML = `${esc(card.room || "")} &middot; ${esc(wcDate(card.time) + ", " + wcTime(card.time))}${card.amount ? ` &middot; ${WC_COIN}${esc(card.amount)}` : ""}`;
    const n = wcV.ids.length;
    $("wincard-popup").classList.toggle("multi", n > 1);
    $("wincard-dots").innerHTML = n > 1 ? wcV.ids.map((_, k) => `<i class="${k === wcV.i ? "on" : ""}"></i>`).join("") : "";
    $("wincard-fav").setAttribute("aria-pressed", wcFavs().has(card.id));
    const synthetic = /^collage_/.test(card.id), inGallery = !!document.querySelector(`#wincards-grid .wc-slot[data-id="${card.id}"]`);
    $("wincard-fav").hidden = synthetic;
    $("wincard-del").hidden = synthetic || !inGallery;
    $("wincard-note").hidden = synthetic;
    $("wincard-note").value = card.note || "";
    $("wincard-tilt").classList.remove("zoom");
}
async function wcStep(d) {
    const n = wcV.ids.length; if (n < 2) return;
    wcV.i = (wcV.i + d + n) % n;
    const id = wcV.ids[wcV.i];
    let c = wcV.cache.get(id);
    if (!c) { try { c = await WinCardsDB.get(id); } catch (e) { } if (c) wcV.cache.set(id, c); }
    if (c) { $("wincard-stage").dataset.dir = d > 0 ? "next" : "prev"; wcShow(c); }
}

/* ---------- Share as an image card (tasks, leaderboard, analytics) ----------
   Plain app-theme look (no celebration wrapper). The card opens in the win-card popup, so Share / Copy / Download
   work exactly the same. These cards are not stored (id starts with "collage_", so Favorite / Delete / note are hidden). */

/* ---------- Random themes: a new look every time a card is shared ----------
   randomPalette(): a fresh colour mix every call (random hue, harmony, light or dark, gradient angle) - never the same
   hue family twice in a row. wcRecolor(): the same idea for finished win-card images (hue / saturation turn). */
let lastPalHue = -999;
function randomPalette() {
    const rnd = (a, b) => a + Math.random() * (b - a), pick = a => a[Math.floor(Math.random() * a.length)];
    let h, tries = 0;
    do { h = rnd(0, 360); tries++; } while (tries < 20 && Math.min(Math.abs(h - lastPalHue), 360 - Math.abs(h - lastPalHue)) < 55);
    lastPalHue = h;
    const hh = n => Math.round(((h + n) % 360 + 360) % 360);
    const hsl = (n, s, l, a) => `hsla(${hh(n)}, ${Math.round(s)}%, ${Math.round(l)}%, ${a === undefined ? 1 : a})`;
    const harmony = pick([30, 60, 120, 150, 180, 210, 240]);       // how far the accent colour sits from the main one
    const light = Math.random() < 0.28, s = rnd(55, 92);
    if (light) return {
        bg: hsl(0, rnd(60, 90), rnd(92, 96)), bg2: hsl(pick([-40, 30, harmony / 2]), rnd(60, 90), rnd(84, 90)), tilt: rnd(0, 1),
        card: hsl(0, 40, 99), text: hsl(0, 40, 12), muted: hsl(0, 18, 38), pri: hsl(0, s, rnd(38, 48)), soft: hsl(0, s, 50, .16),
        gold: hsl(harmony, s, rnd(36, 44)), border: hsl(0, 30, 50, .28), row: hsl(0, 40, 50, .07), avText: "#fff"
    };
    return {
        bg: hsl(0, rnd(40, 70), rnd(5, 9)), bg2: hsl(pick([-50, -25, 25, 50, harmony / 2]), rnd(40, 70), rnd(9, 16)), tilt: rnd(0, 1),
        card: hsl(0, rnd(30, 55), rnd(12, 17)), text: hsl(0, 40, 96), muted: hsl(0, rnd(18, 32), rnd(66, 76)),
        pri: hsl(0, s, rnd(56, 68)), soft: hsl(0, s, 60, .2), gold: hsl(harmony, rnd(75, 95), rnd(60, 70)),
        border: hsl(0, s, 65, .3), row: "rgba(255,255,255,.06)", avText: "#fff"
    };
}
function wcLoadImg(url) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; }); }
let lastRecolorDeg = -999;
async function wcRecolor(dataUrl) {
    const im = await wcLoadImg(dataUrl);
    const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const ctx = c.getContext("2d"); ctx.drawImage(im, 0, 0);
    const id = ctx.getImageData(0, 0, c.width, c.height), d = id.data;
    let deg, tries = 0;
    do { deg = 35 + Math.random() * 290; tries++; } while (tries < 20 && Math.abs(deg - lastRecolorDeg) < 45);
    lastRecolorDeg = deg;
    const a = deg * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a), sat = 0.85 + Math.random() * 0.6, lum = 0.94 + Math.random() * 0.14;
    const m = [.213 + cs * .787 - sn * .213, .715 - cs * .715 - sn * .715, .072 - cs * .072 + sn * .928,
    .213 - cs * .213 + sn * .143, .715 + cs * .285 + sn * .140, .072 - cs * .072 - sn * .283,
    .213 - cs * .213 - sn * .787, .715 - cs * .715 + sn * .715, .072 + cs * .928 + sn * .072];
    for (let i = 0; i < d.length; i += 4) {
        const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
        let r1 = r0 * m[0] + g0 * m[1] + b0 * m[2], g1 = r0 * m[3] + g0 * m[4] + b0 * m[5], b1 = r0 * m[6] + g0 * m[7] + b0 * m[8];
        const y = .299 * r1 + .587 * g1 + .114 * b1;                 // saturation turn around the grey level
        r1 = (y + (r1 - y) * sat) * lum; g1 = (y + (g1 - y) * sat) * lum; b1 = (y + (b1 - y) * sat) * lum;
        d[i] = r1 < 0 ? 0 : r1 > 255 ? 255 : r1; d[i + 1] = g1 < 0 ? 0 : g1 > 255 ? 255 : g1; d[i + 2] = b1 < 0 ? 0 : b1 > 255 ? 255 : b1;
    }
    ctx.putImageData(id, 0, 0);
    return c.toDataURL("image/png");
}

async function renderInfoCardCanvas(spec) {
    await wcFontsReady();
    const W = 1080, MIN_H = 1920, MARGIN = 80;
    const emoji = "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
    const mctx = document.createElement("canvas").getContext("2d");   // used only to measure text

    // ---------- layout: every y below is relative to the top of ONE content block ----------
    // The block (brand / title / chip / list / summary / footer) is measured first, then the canvas is made
    // exactly tall enough and the block is placed in the exact vertical centre. A long list (e.g. the whole
    // leaderboard) makes the image taller instead of cutting names off.
    const rows = spec.rows || [], n = rows.length;
    const gap = 12, inner = 22, px = 70, pw = W - 140, chipH = 104;
    const capOf = fs => Math.round(fs * 0.72);                     // cap height of the Poppins text
    let y = 0, brandBase = 0, subBase = 0, titleBase = 0, titleFs = 0, chipTop = 0;
    if (spec.headAbove) {
        // the title sits right on top of the list, sized from the list's width
        mctx.font = "800 100px Poppins, sans-serif";
        const w100 = mctx.measureText(spec.title).width;
        titleFs = Math.max(30, Math.min(64, Math.floor(100 * pw * 0.72 / w100)));   // compact heading: ~72% of the list width, max 64px
        titleBase = capOf(titleFs); y = titleBase + 36;
    } else {
        titleFs = 118;                                                 // no "HOUSIE GAME" / sub lines above the title any more
        while (titleFs > 60) { mctx.font = `800 ${titleFs}px Poppins, sans-serif`; if (mctx.measureText(spec.title).width <= W - 140) break; titleFs -= 4; }
        titleBase = capOf(titleFs); y = titleBase;
        if (spec.chip) { chipTop = y + 56; y = chipTop + chipH; }
        y += spec.chip ? 60 : 70;
    }
    const panelTop = y;
    const footGap = spec.summary ? 150 : 76, footH = 192;            // panel bottom -> footer pill, footer pill -> url baseline
    const avail = MIN_H - 2 * MARGIN - panelTop - footGap - footH - inner * 2 - gap * Math.max(n - 1, 0);
    const rh = n ? Math.max(64, Math.min(112, avail / n)) : 0;       // rows shrink to fit one screen, never below 64px
    const used = n ? rh * n + gap * (n - 1) : 0;
    // number grid (favorite numbers): bubbles in a centred grid instead of list rows
    const nums = spec.numbers || [], ngap = 14;
    let ncols = 0, ncell = 0, nrowsN = 0, nused = 0;
    if (nums.length) {
        ncols = Math.min(nums.length, nums.length <= 10 ? 5 : nums.length <= 24 ? 6 : nums.length <= 48 ? 8 : 9);
        ncell = Math.min(124, Math.floor((pw - inner * 2 - 24 - ngap * (ncols - 1)) / ncols));
        nrowsN = Math.ceil(nums.length / ncols);
        nused = nrowsN * ncell + ngap * (nrowsN - 1);
    }
    const ph = Math.max((nums.length ? nused : used) + inner * 2 + (nums.length ? 24 : 0), 300);
    const footTop = panelTop + ph + footGap;
    const contentH = footTop + footH;
    const H = Math.max(MIN_H, contentH + 2 * MARGIN);
    const oy = Math.round((H - contentH) / 2);                       // exact vertical centre

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    // the app's own theme colours (read from the page, so every theme works) - no confetti / glow wrapper
    const cs = getComputedStyle(document.body), T = (k, d) => cs.getPropertyValue(k).trim() || d;
    const P = spec.pal || {};   // a random palette (see randomPalette) when given, else the app's own theme
    const cBg = P.bg || T("--bg", "#020617"), cCard = P.card || T("--card", "#0f172a"), cText = P.text || T("--text", "#f8fafc"), cMuted = P.muted || T("--muted", "#94a3b8");
    const cPri = P.pri || T("--primary", "#6366f1"), cSoft = P.soft || T("--primary-soft", "rgba(99,102,241,.16)"), cGold = P.gold || T("--gold", "#f59e0b"), cBorder = P.border || T("--border", "rgba(255,255,255,.09)");
    const cRow = P.row || "rgba(255,255,255,.05)", cAv = P.avText || "#fff";
    if (P.bg2) { const bgG = ctx.createLinearGradient(0, 0, W * P.tilt, H); bgG.addColorStop(0, cBg); bgG.addColorStop(1, P.bg2); ctx.fillStyle = bgG; }
    else ctx.fillStyle = cBg;
    ctx.fillRect(0, 0, W, H);
    ctx.translate(0, oy);                                            // everything below is drawn inside the centred block

    // title
    ctx.save();
    ctx.font = `800 ${titleFs}px Poppins, sans-serif`; ctx.fillStyle = cText;
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillText(spec.title, W / 2, titleBase);
    ctx.restore();

    // chip: avatar + text
    const chipY = chipTop;
    if (spec.chip) {
        ctx.save();
        let nf2 = 46;
        const maxT = W - 120 - chipH - 80;
        while (nf2 > 32) { ctx.font = `700 ${nf2}px Poppins, sans-serif`; if (ctx.measureText(spec.chip).width <= maxT) break; nf2 -= 2; }
        ctx.font = `700 ${nf2}px Poppins, sans-serif`;
        const chipTxt = wcEllipsize(ctx, spec.chip, maxT);
        const tw = ctx.measureText(chipTxt).width, chipW = tw + chipH + 70, chipX = W / 2 - chipW / 2;
        ctx.fillStyle = cCard; wcRoundRect(ctx, chipX, chipY, chipW, chipH, chipH / 2); ctx.fill();
        ctx.strokeStyle = cBorder; ctx.lineWidth = 3; ctx.stroke();
        const ax = chipX + chipH / 2, ay = chipY + chipH / 2, ar = chipH / 2 - 8;
        ctx.fillStyle = cPri; ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = cAv; ctx.font = "700 44px Poppins, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(spec.initial, ax, ay + 2);
        ctx.fillStyle = cText;
        ctx.textBaseline = "alphabetic"; ctx.font = `700 ${nf2}px Poppins, sans-serif`;
        ctx.fillText(chipTxt, chipX + chipH + 10 + tw / 2 + 20, chipY + chipH / 2 + Math.round(nf2 * 0.36));
        ctx.restore();
    }

    // rows panel
    const py = panelTop;
    ctx.save();
    ctx.fillStyle = cCard; wcRoundRect(ctx, px, py, pw, ph, 36); ctx.fill();
    ctx.strokeStyle = cBorder; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();

    let ry = py + (ph - used) / 2;
    rows.forEach(r => {
        ctx.save();
        ctx.fillStyle = r.hl ? cSoft : cRow;
        wcRoundRect(ctx, px + inner, ry, pw - inner * 2, rh, 24); ctx.fill();
        if (r.hl) { ctx.strokeStyle = cPri; ctx.lineWidth = 3; ctx.stroke(); }
        const cy2 = ry + rh / 2;
        if (r.sub !== undefined) {   // task row, laid out like the Tasks screen: title + progress bar on the left, reward over status on the right
            if (r.dim) ctx.globalAlpha = 0.55;
            const padL = px + inner + 34, padR = px + pw - inner - 34, fsT = Math.round(rh * 0.30), fsS = Math.round(rh * 0.25);
            ctx.textBaseline = "middle"; ctx.textAlign = "right";
            ctx.font = `800 ${fsT}px Poppins, ${emoji}`; ctx.fillStyle = cGold;
            ctx.fillText(r.right, padR, ry + rh * 0.34);
            const rw1 = ctx.measureText(r.right).width;
            ctx.font = `600 ${fsS}px Poppins, ${emoji}`; ctx.fillStyle = cMuted;
            ctx.fillText(r.sub, padR, ry + rh * 0.70);
            const rw2 = ctx.measureText(r.sub).width, colW = Math.max(rw1, rw2) + 40;
            ctx.textAlign = "left"; ctx.font = `700 ${fsT}px Poppins, ${emoji}`; ctx.fillStyle = cText;
            ctx.fillText(wcEllipsize(ctx, r.text, padR - padL - colW), padL, ry + rh * 0.34);
            const bw = padR - padL - colW, bh = Math.max(8, Math.round(rh * 0.10)), by = ry + rh * 0.62;
            ctx.fillStyle = cBorder; wcRoundRect(ctx, padL, by, bw, bh, bh / 2); ctx.fill();
            const fw = Math.max(0, Math.min(1, (r.pct || 0) / 100)) * bw;
            if (fw > 0) {
                const pgf = ctx.createLinearGradient(padL, 0, padL + bw, 0); pgf.addColorStop(0, cPri); pgf.addColorStop(1, cGold);
                ctx.fillStyle = pgf; wcRoundRect(ctx, padL, by, Math.max(fw, bh), bh, bh / 2); ctx.fill();
            }
            ctx.restore(); ry += rh + gap; return;
        }
        ctx.textBaseline = "middle"; ctx.textAlign = "center";
        ctx.font = `700 ${Math.round(rh * 0.46)}px Poppins, ${emoji}`;
        ctx.fillStyle = cText;
        ctx.fillText(r.lead, px + inner + 56, cy2 + 2);
        // right value first, so the label can use what is left
        ctx.textAlign = "right"; ctx.font = `800 ${Math.round(rh * 0.36)}px Poppins, ${emoji}`;
        ctx.fillStyle = cGold;
        ctx.fillText(r.right, px + pw - inner - 30, cy2 + 2);
        const rw = ctx.measureText(r.right).width;
        // the whole name is shown: the text shrinks to fit, "…" only as a last resort
        const nameW = pw - inner * 2 - 56 - 70 - rw - 50;
        let nfs = Math.round(rh * 0.36);
        ctx.textAlign = "left"; ctx.fillStyle = cText;
        while (nfs > 20) { ctx.font = `700 ${nfs}px Poppins, ${emoji}`; if (ctx.measureText(r.text).width <= nameW) break; nfs -= 2; }
        ctx.font = `700 ${nfs}px Poppins, ${emoji}`;
        ctx.fillText(wcEllipsize(ctx, r.text, nameW), px + inner + 108, cy2 + 2);
        ctx.restore();
        ry += rh + gap;
    });
    if (nums.length) {
        let gy = py + (ph - nused) / 2;
        for (let r0 = 0; r0 < nrowsN; r0++) {
            const items = nums.slice(r0 * ncols, r0 * ncols + ncols), rowW = items.length * ncell + ngap * (items.length - 1);
            let gx = px + pw / 2 - rowW / 2;
            items.forEach(v => {
                ctx.save();
                ctx.fillStyle = cSoft; wcRoundRect(ctx, gx, gy, ncell, ncell, Math.round(ncell * 0.28)); ctx.fill();
                ctx.strokeStyle = cPri; ctx.lineWidth = 3; ctx.stroke();
                ctx.fillStyle = cText; ctx.font = `800 ${Math.round(ncell * 0.46)}px Poppins, sans-serif`;
                ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillText(String(v).padStart(2, "0"), gx + ncell / 2, gy + ncell / 2 + 2);
                ctx.restore();
                gx += ncell + ngap;
            });
            gy += ncell + ngap;
        }
    }
    if (!rows.length && !nums.length) {
        ctx.fillStyle = cMuted; ctx.font = "700 40px Poppins, sans-serif"; ctx.textAlign = "center";
        ctx.fillText("Nothing here yet", W / 2, py + ph / 2);
    }

    // summary line
    if (spec.summary) {
        ctx.fillStyle = cText; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
        let sf = 52;
        while (sf > 30) { ctx.font = `800 ${sf}px Poppins, ${emoji}`; if (ctx.measureText(spec.summary).width <= W - 120) break; sf -= 2; }
        ctx.fillText(spec.summary, W / 2, py + ph + 92);
    }

    // footer
    const footY = footTop;
    ctx.save();
    ctx.font = "700 40px Poppins, sans-serif";
    const pill = "HOUSIE GAME", pwid = ctx.measureText(pill).width + 84;
    wcRoundRect(ctx, W / 2 - pwid / 2, footY, pwid, 76, 38);
    ctx.fillStyle = cSoft; ctx.fill();
    ctx.strokeStyle = cPri; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = cPri; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(pill, W / 2, footY + 40);
    ctx.restore();
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "center";
    ctx.fillStyle = cText; ctx.font = "700 40px Poppins, sans-serif";
    ctx.fillText(spec.tagline || "Join me & win coins!", W / 2, footY + 138);
    ctx.fillStyle = cMuted; ctx.font = "600 32px Poppins, sans-serif";
    ctx.fillText("myhousiegame.vercel.app", W / 2, footY + 184);
    return canvas;
}
async function openShareImage(kind, spec, shareTitle, shareText) {
    spec.pal = randomPalette();                                     // a new random theme on every share
    const canvas = await renderInfoCardCanvas(spec);
    const card = {
        id: "collage_share_" + kind + "_" + Date.now(), claim: "share-" + kind,
        label: spec.title, room: "HOUSIE GAME", amount: 0, time: Date.now(),
        dataUrl: canvas.toDataURL("image/png"), thumb: wcThumb(canvas), v: 2,
        shareTitle, shareText, spec
    };
    openWinCardPopup(card);
}

/* ---------- End of the room: show my win cards, then the room closes ---------- */
// No win card pops up while the game is running. When the room is over (Housie claimed or all 90 numbers drawn),
// everybody who won something sees their cards from this room, and the room closes ROOM_CLOSE_MS (5s) later:
// the host ends it (closeRoomSoon) and every player is sent home by the "finished" update. Cards stay in Profile > Win Cards.
let roomCardsFor = null, roomCardsTimer = null;
async function showRoomWinCards(gid, afterFinish) {
    if (!gid || roomCardsFor === gid || !window.Coins || !Coins.user) return false;
    roomCardsFor = gid;
    const endsAt = Date.now() + ROOM_CLOSE_MS;
    // my last claim may still be on its way, or its card still being drawn: give it a moment
    const t0 = Date.now();
    while ((claimBusy || pendingWinCards.size) && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 150));
    if (intentionalExit || (!afterFinish && gameData && gameData.status === "finished")) return false;
    let cards = [];
    try { cards = (await WinCardsDB.all(Coins.user.uid)).filter(c => c.gameId === gid && PRIZE_CARD[c.claim]); } catch (e) { }
    if (!cards.length) return false;               // I won nothing in this room
    cards.sort((a, b) => (a.time || 0) - (b.time || 0));   // the order they were won, Housie last
    const ids = cards.map(c => c.id);
    openWinCardPopup(cards[0], ids);

    // Each card's roomInfo is a snapshot taken the moment it was won, so an early card (e.g. a Jaldi
    // won early on) can still say "Not won" for prizes other players claimed later - Housie especially,
    // since it's always last. Now that the room is confirmed done, every claim is known (gameData /
    // the player list are both final), so take one fresh, complete snapshot and stamp it onto every
    // one of my cards for this room - the gallery picks whichever card happens to carry roomInfo, so
    // they all need to agree. Runs in the background so it never delays the popup above.
    wcRoomSnapshot().then(finalInfo => {
        if (!finalInfo) return;
        return Promise.all(cards.map(c => {
            c.roomInfo = finalInfo;
            return WinCardsDB.put(c).catch(e => { });
        }));
    }).catch(e => console.warn("[wincard] final room snapshot failed", e));

    let cd = $("wincard-countdown");
    if (!cd) {
        cd = document.createElement("p");
        cd.id = "wincard-countdown";
        cd.style.cssText = "margin:2px 0 8px;text-align:center;font-weight:700;font-size:14px;color:#fbbf24";
        $("wincard-meta").insertAdjacentElement("afterend", cd);
    }
    cd.hidden = false;
    // more than one card: flip through them on their own (a tap or swipe takes over)
    let manual = false, lastStep = Date.now();
    const stepMs = Math.max(1000, Math.floor(Math.max(1500, endsAt - Date.now()) / ids.length));
    $("wincard-popup").addEventListener("pointerdown", () => { manual = true; }, { once: true });
    if (roomCardsTimer) clearInterval(roomCardsTimer);
    const stop = () => { clearInterval(roomCardsTimer); roomCardsTimer = null; cd.hidden = true; };
    const tick = () => {
        if (!$("wincard-popup").classList.contains("active")) { stop(); return; }   // closed by the player
        const left = Math.ceil((endsAt - Date.now()) / 1000);
        cd.textContent = left > 0 ? (afterFinish ? `Result in ${left}s` : `Room closes in ${left}s`) : (afterFinish ? "Opening the result…" : "Closing the room…");
        if (left < -10) { stop(); return; }
        if (!manual && wcV.i < ids.length - 1 && Date.now() - lastStep >= stepMs) { lastStep = Date.now(); wcStep(1); }
    };
    tick();
    roomCardsTimer = setInterval(tick, 250);
    return true;
}
$("wincard-close").onclick = () => $("wincard-popup").classList.remove("active");
$("wincard-popup").addEventListener("click", e => { if (e.target === $("wincard-popup")) $("wincard-popup").classList.remove("active"); });
$("wincard-prev").onclick = () => wcStep(-1);
$("wincard-next").onclick = () => wcStep(1);
$("wincard-fav").onclick = () => {
    if (!lastWinCard) return;
    const p = wcFavs(), id = lastWinCard.id;
    if (p.has(id)) p.delete(id); else p.add(id);
    wcSetFavs(p); if (p.has(id)) nbMark("wcfav"); wcShow(lastWinCard);
    wcSetFavDom(id, p.has(id));
    wcRefresh();
    showNotification(p.has(id) ? "Added to favorites" : "Removed from favorites");
};
document.addEventListener("keydown", e => {
    if (!$("wincard-popup").classList.contains("active") || (e.target && e.target.tagName === "INPUT")) return;
    if (e.key === "ArrowLeft") wcStep(-1);
    else if (e.key === "ArrowRight") wcStep(1);
    else if (e.key === "Escape") $("wincard-popup").classList.remove("active");
});
// swipe left / right to change card + 3D tilt that follows the finger or mouse
(function () {
    const st = $("wincard-stage"), tilt = $("wincard-tilt"); let x0 = null;
    st.addEventListener("pointerdown", e => { x0 = e.clientX; });
    st.addEventListener("pointerup", e => { if (x0 !== null && Math.abs(e.clientX - x0) > 50) wcStep(e.clientX < x0 ? 1 : -1); x0 = null; tilt.style.transform = ""; });
    st.addEventListener("pointercancel", () => { x0 = null; tilt.style.transform = ""; });
    st.addEventListener("dblclick", () => tilt.classList.toggle("zoom"));
    st.addEventListener("pointermove", e => {
        if (tilt.classList.contains("zoom")) return;
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const r = tilt.getBoundingClientRect(), px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5;
        if (Math.abs(px) > .8 || Math.abs(py) > .8) return;
        tilt.style.transform = `perspective(700px) rotateY(${px * 14}deg) rotateX(${-py * 14}deg)`;
        tilt.style.setProperty("--sx", (px + .5) * 100 + "%");
    });
    st.addEventListener("pointerleave", () => { tilt.style.transform = ""; });
})();

function wcFileFromCard(card) {
    const bytes = atob(card.dataUrl.split(",")[1]);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new File([arr], `housie-${card.claim}-${card.room || "win"}.png`.replace(/\s+/g, ""), { type: "image/png" });
}

// Shared Share / Copy / Download actions - each takes the exact card to act on, so the same
// code runs whether it was triggered from the big popup or from a thumbnail in the gallery.
function downloadCard(card) {
    if (!card) return;
    const a = document.createElement("a");
    a.href = card.dataUrl;
    a.download = `housie-${card.claim}-${card.time || "win"}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

async function copyCard(card) {
    if (!card) return;
    try {
        if (!navigator.clipboard || !window.ClipboardItem) throw new Error("unsupported");
        const res = await fetch(card.dataUrl);
        const blob = await res.blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        showNotification("Copied to clipboard!");
    } catch (e) {
        showNotification("Copy isn't supported in this browser - try Download instead", "error");
    }
}

async function shareCard(card) {
    if (!card) return;
    try { card = await wcRetheme(card); } catch (e) { console.warn("[share] theme failed, sharing as is", e); }   // every share gets a new random theme
    try {
        const file = wcFileFromCard(card);
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: card.shareTitle || "Housie win!", text: card.shareText || "I just won on Housie Game!" });
            return;
        }
        throw new Error("no share target");
    } catch (e) {
        if (e && e.name === "AbortError") return; // user cancelled the share sheet
        try {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": await (await fetch(card.dataUrl)).blob() })]);
            showNotification("Sharing isn't available here - copied the image instead!");
        } catch (e2) {
            showNotification("Sharing isn't supported in this browser - try Download", "error");
        }
    }
}

$("wincard-download").onclick = () => { nbMark("wcsave"); downloadCard(wcCur(lastWinCard)); };
$("wincard-copy").onclick = () => { nbMark("wcsave"); copyCard(wcCur(lastWinCard)); };
$("wincard-share").onclick = () => { nbMark("wcsave"); shareCard(lastWinCard); };

/* ---------- Win Cards gallery: one shelf (collection) per room + one for rewards ---------- */
const WC_SVG = p => `<svg class="wc-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const WC_ICON = {
    share: WC_SVG('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.7l6.8-4.4M8.6 13.3l6.8 4.4"/>'),
    copy: WC_SVG('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
    download: WC_SVG('<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/>'),
    lock: WC_SVG('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    users: WC_SVG('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3c2.2.7 3.5 2.6 3.5 5.7"/>'),
    ticket: WC_SVG('<path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v3z"/><path d="M13 5v14" stroke-dasharray="2 3"/>'),
    trophy: WC_SVG('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
    chev: WC_SVG('<path d="M6 9l6 6 6-6"/>'),
    crown: WC_SVG('<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5L3 8z"/>'),
    gift: WC_SVG('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8"/><path d="M7.5 8a2.5 2.5 0 1 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 1 1 0 5"/>'),
    cards: WC_SVG('<rect x="3" y="5" width="11" height="15" rx="2"/><path d="M17 8l3 1-3.4 10.2"/>'),
    door: WC_SVG('<path d="M5 21V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v17"/><path d="M3 21h18"/><circle cx="12.5" cy="12" r=".6"/>')
};
const WC_COIN = '<i class="wc-coin" aria-hidden="true"></i>';
const WC_ORDER = ["jaldi", "line1", "line2", "line3", "housie"];
const WC_GAME_CLAIM = /_(jaldi|line[123]|housie)_\d+$/;

function wcRoomKey(card) {
    if (!PRIZE_CARD[card.claim]) return null;                       // reward / special cards go to the rewards shelf
    if (card.gameId) return card.gameId;
    return WC_GAME_CLAIM.test(card.id || "") ? card.id.replace(WC_GAME_CLAIM, "") : (card.room || "room");
}
const wcTime = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const wcDate = t => new Date(t).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

function wcSlotHTML(card) {
    return `
        <div class="wc-slot" data-claim="${esc(card.claim)}" data-id="${esc(card.id)}" data-q="${esc(((card.label || "") + " " + (card.room || "") + " " + (card.note || "")).toLowerCase())}">
            <div class="wc-stand">
                <button type="button" class="wc-frame${wcFavs().has(card.id) ? " is-fav" : ""}" data-claim="${esc(card.claim)}" data-id="${esc(card.id)}" aria-label="Open ${esc(card.label)} card">
                    <img src="${card.thumb}" alt="${esc(card.label)} winning card" loading="lazy">
                    <i class="wc-favmark" aria-hidden="true">&#9829;</i><i class="wc-check" aria-hidden="true"></i><i class="wc-shine"></i>
                </button>
            </div>
            <div class="wc-plaque"><b>${esc(card.label)}</b><span>${WC_COIN}${esc(card.amount)}</span></div>
        </div>`;
}

function wcEmptySlotHTML(key, info) {
    const winner = info && (info.members || []).find(m => (m.claims || []).includes(key));
    const coins = info && info.prizes && info.prizes[key];
    return `
        <div class="wc-slot is-empty">
            <div class="wc-stand">
                <div class="wc-frame is-empty">${WC_ICON.lock}<span>${esc(CLAIM_SHORT[key] || key)}</span></div>
            </div>
            <div class="wc-plaque"><b${winner ? ` class="wc-wonby" title="${esc(winner.name)}"` : ""}>${winner ? "Won by " + esc(winner.name) : "Not won"}</b>${coins ? `<span>${WC_COIN}${esc(coins)}</span>` : ""}</div>
        </div>`;
}

function wcDetailsHTML(info, myUid) {
    const ms = (info.members || []).slice().sort((a, b) => (b.coins - a.coins) || (a.isHost ? -1 : 1));
    const palette = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];
    const rows = ms.map((m, i) => `
        <li class="wc-member${m.uid === myUid ? " is-me" : ""}">
            <span class="wc-av" style="background:${palette[i % palette.length]}">${esc(avatarLetter(m.name))}</span>
            <span class="wc-m-main">
                <span class="wc-m-name"><span class="wc-m-nm">${esc(m.name)}</span>${m.isHost ? '<em class="wc-tag host">HOST</em>' : ""}${m.uid === myUid ? '<em class="wc-tag you">YOU</em>' : ""}</span>
                <span class="wc-m-sub">${WC_ICON.ticket}${esc(m.tickets)} ticket${m.tickets === 1 ? "" : "s"}${(m.claims || []).length ? " · " + m.claims.map(k => esc(CLAIM_SHORT[k] || k)).join(", ") : ""}</span>
            </span>
            <span class="wc-m-coins${m.coins ? " won" : ""}">${WC_COIN}${esc(m.coins)}</span>
        </li>`).join("");
    const prizeRows = WC_ORDER.filter(k => info.prizes && info.prizes[k] != null).map(k => {
        const w = (info.members || []).filter(m => (m.claims || []).includes(k));
        return `<li><span class="wc-p-name">${WC_ICON.trophy}${esc(CLAIM_SHORT[k])}</span>
            <span class="wc-p-win">${w.length ? w.map(x => esc(x.name)).join(", ") : "Not claimed"}</span>
            <span class="wc-m-coins${w.length ? " won" : ""}">${WC_COIN}${esc(info.prizes[k])}</span></li>`;
    }).join("");
    return `
        <h4 class="wc-sub-h">Members &amp; coins</h4>
        <ul class="wc-members">${rows}</ul>
        ${prizeRows ? `<h4 class="wc-sub-h">Prizes</h4><ul class="wc-prizes">${prizeRows}</ul>` : ""}`;
}

function wcRoomHTML(group, myUid) {
    const { key, cards } = group;
    const info = (cards.find(c => c.roomInfo) || {}).roomInfo || null;
    const latest = Math.max.apply(null, cards.map(c => c.time || 0));
    const won = cards.reduce((a, c) => a + (Number(c.amount) || 0), 0);
    const title = (info && info.label) || (cards[0].room) || "Room";
    const keys = WC_ORDER.filter(k => cards.some(c => c.claim === k) || (info && info.prizes && info.prizes[k] != null));
    const slots = keys.map(k => {
        const c = cards.find(x => x.claim === k);
        return c ? wcSlotHTML(c) : wcEmptySlotHTML(k, info);
    }).join("");
    const stat = (icon, val, lab) => `<div class="wc-stat">${icon}<b>${val}</b><span>${lab}</span></div>`;
    const stats = info ? `
        <div class="wc-stats">
            ${stat(WC_ICON.users, esc(info.playerCount), "Players")}
            ${stat(WC_COIN, esc(info.pot), "Prize pot")}
            ${stat(WC_ICON.ticket, esc(info.ticketPrice), "Ticket")}
            ${stat(WC_ICON.trophy, esc(won), "You won")}
        </div>` : "";
    const sub = [wcDate(latest) + ", " + wcTime(latest)];
    if (info && info.host) sub.push("Host: " + esc(info.host));
    if (info && info.called) sub.push(esc(info.called) + " numbers called");
    return `
    <section class="wc-room" data-i="${group.i}">
        <header class="wc-room-head">
            <span class="wc-room-ico">${info && info.dev ? WC_ICON.cards : WC_ICON.door}</span>
            <div class="wc-room-title"><h3>${esc(title)}</h3><small>${sub.join(" · ")}</small></div>
            <span class="wc-room-count">${cards.length}<i>/</i>${keys.length || cards.length}</span>
            <button type="button" class="wc-selbtn wc-hbtn wc-recapbtn" data-b="recap">Recap</button>
            <button type="button" class="wc-selbtn wc-hbtn" data-b="selmode">Select</button>
        </header>
        ${stats}
        <div class="wc-shelf">${slots}</div>
        ${info && (info.members || []).length ? `
        <button type="button" class="wc-toggle" data-toggle="${esc(key)}" aria-expanded="false">${WC_ICON.users}<span>Members &amp; coins</span>${WC_ICON.chev}</button>
        <div class="wc-details" hidden>${wcDetailsHTML(info, myUid)}</div>` : `
        <p class="wc-note">Member and coin details are saved with new wins.</p>`}
    </section>`;
}

function wcRewardsHTML(cards) {
    const won = cards.reduce((a, c) => a + (Number(c.amount) || 0), 0);
    return `
    <section class="wc-room wc-rewards" data-i="r">
        <header class="wc-room-head">
            <span class="wc-room-ico">${WC_ICON.gift}</span>
            <div class="wc-room-title"><h3>Rewards &amp; Bonuses</h3><small>${WC_COIN}${esc(won)} coins earned · bonuses, spins, tasks &amp; gifts</small></div>
            <span class="wc-room-count">${cards.length}</span>
            <button type="button" class="wc-selbtn wc-hbtn" data-b="selmode">Select</button>
        </header>
        <div class="wc-shelf cols4">${cards.map(wcSlotHTML).join("")}</div>
    </section>`;
}

WC_ICON.next = WC_SVG('<path d="M9 5l7 7-7 7"/>');
WC_ICON.back = WC_SVG('<path d="M15 5l-7 7 7 7"/>');
WC_ICON.check = WC_SVG('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
const WC_SORTS = [["new", "Newest"], ["old", "Oldest"], ["coins", "Most coins"]];
const WC_KIND = { daily: "Daily", wheel: "Spin", task: "Tasks", gift: "Gifts", welcome: "Welcome", devwin: "Vs Dev" };
const wcMatch = (f, claim, fav) => f === "all" || (f === "fav" && fav) || claim === f;
let wcFilter = "all", wcQuery = "", wcOpen = null;

const wcGrid = () => $("wincards-grid");
const wcOpenRoom = () => { const g = wcGrid(); return g && g.querySelector(".wc-room.open"); };

// main list: search hides tiles whose room name, prize names or notes don't match
function wcApplyTiles() {
    const g = wcGrid(); if (!g) return;
    let shown = 0;
    g.querySelectorAll(".wc-tile").forEach(t => {
        const room = g.querySelector(`.wc-room[data-i="${t.dataset.i}"]`);
        const q = (t.dataset.title + " " + Array.from(room ? room.querySelectorAll(".wc-slot") : []).map(s => s.dataset.q || "").join(" ")).toLowerCase();
        t.hidden = !!wcQuery && q.indexOf(wcQuery) < 0;
        if (!t.hidden) shown++;
    });
    const none = g.querySelector(".wc-nomatch"); if (none) none.hidden = shown > 0;
}
// open collection: prize / kind / favorites filter + cards waiting for undo-delete
const wcKindLabel = k => WC_KIND[k] || CLAIM_SHORT[k] || k;
function wcApplyFilter() {
    const g = wcGrid(); if (!g) return;
    g.querySelectorAll(".wc-slot").forEach(s => {
        const empty = s.classList.contains("is-empty");
        const off = s.dataset.del === "1" || (wcFilter !== "all" && (empty || !wcMatch(wcFilter, s.dataset.claim || "", s.dataset.fav === "1")));
        s.hidden = off; s.classList.toggle("wc-off", off);
    });
    const room = wcOpenRoom();
    const real = room ? Array.from(room.querySelectorAll(".wc-slot:not(.is-empty)")).filter(s => s.dataset.del !== "1") : [];
    const shown = real.filter(s => !s.hidden).length;
    const none = g.querySelector(".wc-dnone"); if (none) none.hidden = !room || shown > 0;
    const note = g.querySelector(".wc-fnote");
    if (note) { note.hidden = !room || wcFilter === "all" || !shown; note.textContent = "Showing " + shown + " of " + real.length + " cards"; }
    wcApplyTiles();
}
// chips: All, one per prize / reward kind in this collection, and Favorites (once something is a favorite)
function wcCounts() {
    const g = wcGrid(), box = g && g.querySelector(".wc-dchips"), room = wcOpenRoom();
    if (!box) return;
    if (!room) { box.innerHTML = ""; return; }
    const slots = Array.from(room.querySelectorAll(".wc-slot:not(.is-empty)")).filter(s => s.dataset.del !== "1");
    const has = new Set(slots.map(s => s.dataset.claim || "").filter(Boolean));
    const kinds = (room.classList.contains("wc-rewards") ? Object.keys(WC_KIND) : WC_ORDER).filter(k => has.has(k));
    has.forEach(k => { if (kinds.indexOf(k) < 0) kinds.push(k); });
    const list = [["all", "All"]];
    if (kinds.length > 1) kinds.forEach(k => list.push([k, wcKindLabel(k)]));
    if (slots.some(s => s.dataset.fav === "1")) list.push(["fav", "Favorites"]);
    if (!list.some(x => x[0] === wcFilter)) wcFilter = "all";
    box.innerHTML = list.length > 1 ? list.map(([f, l]) => {
        const n = slots.filter(s => wcMatch(f, s.dataset.claim || "", s.dataset.fav === "1")).length;
        return `<button type="button" class="wc-chip${f === wcFilter ? " on" : ""}" data-f="${esc(f)}" aria-pressed="${f === wcFilter}">${esc(l)}<b>${n}</b></button>`;
    }).join("") : "";
}
// always count the chips first (they may reset the filter), then hide / show the cards
function wcRefresh() { wcCounts(); wcApplyFilter(); }
function wcOpenColl(i) {
    const g = wcGrid(); if (!g) return;
    const room = g.querySelector(`.wc-room[data-i="${i}"]`); if (!room) return;
    wcOpen = i; wcFilter = "all";
    g.classList.add("detail");
    g.classList.toggle("is-rewards", room.classList.contains("wc-rewards"));
    g.querySelectorAll(".wc-room").forEach(r => r.classList.toggle("open", r === room));
    const t = room.querySelector(".wc-room-title h3");
    g.querySelector(".wc-dtitle").textContent = t ? t.textContent : "";
    wcRefresh();
    window.scrollTo(0, 0); const v = $("screen-wincards"); if (v) v.scrollTop = 0;
}
function wcCloseColl() {
    const g = wcGrid(); if (!g) return;
    wcSelMode(false);
    wcOpen = null; wcFilter = "all";
    g.classList.remove("detail");
    g.querySelectorAll(".wc-room").forEach(r => r.classList.remove("open"));
    wcRefresh();
    window.scrollTo(0, 0); const v = $("screen-wincards"); if (v) v.scrollTop = 0;
}
function wcSort(v) {
    const box = document.querySelector("#wincards-grid .wc-tiles"); if (!box) return;
    const ts = Array.from(box.querySelectorAll(":scope > .wc-tile"));
    ts.sort((a, b) => v === "old" ? a.dataset.t - b.dataset.t : v === "coins" ? b.dataset.w - a.dataset.w : b.dataset.t - a.dataset.t);
    ts.forEach(t => box.appendChild(t));
}
// themed sort menu (replaces the browser's plain dropdown)
function wcSortMenu(open) {
    const w = document.querySelector("#wincards-grid .wc-sortwrap"); if (!w) return;
    const m = w.querySelector(".wc-sortmenu"), on = typeof open === "boolean" ? open : m.hidden;
    m.hidden = !on; w.classList.toggle("open", on);
    w.querySelector(".wc-sortbtn").setAttribute("aria-expanded", on ? "true" : "false");
    if (on) { const cur = m.querySelector('[aria-selected="true"]'); if (cur) cur.focus(); }
}
function wcPickSort(v) {
    const w = document.querySelector("#wincards-grid .wc-sortwrap"); if (!w) return;
    const hit = WC_SORTS.find(s => s[0] === v) || WC_SORTS[0];
    w.querySelector(".wc-sortlabel").textContent = hit[1];
    w.querySelectorAll(".wc-sortmenu [data-sort]").forEach(o => o.setAttribute("aria-selected", o.dataset.sort === hit[0] ? "true" : "false"));
    wcSort(hit[0]); wcSortMenu(false);
    const b = w.querySelector(".wc-sortbtn"); if (b) b.focus();
}
document.addEventListener("click", e => { if (!e.target.closest(".wc-sortwrap")) wcSortMenu(false); });
document.addEventListener("keydown", e => {
    const w = e.target.closest && e.target.closest(".wc-sortwrap"), m = document.querySelector("#wincards-grid .wc-sortmenu");
    if (!m || m.hidden) return;
    if (e.key === "Escape") { wcSortMenu(false); const b = document.querySelector("#wincards-grid .wc-sortbtn"); if (b) b.focus(); return; }
    if (!w || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const items = Array.from(m.querySelectorAll("[data-sort]")), i = items.indexOf(document.activeElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
});
function wcCountUp() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    document.querySelectorAll("#wincards-grid .wc-sum b").forEach(b => {
        const t = parseInt(b.textContent, 10); if (!(t > 0)) return;
        const t0 = performance.now();
        (function f(n) { const p = Math.min(1, (n - t0) / 700); b.textContent = Math.round(t * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(f); })(t0);
    });
}
function wcTileHTML(i, title, sub, cards, rewards) {
    const won = cards.reduce((a, c) => a + (Number(c.amount) || 0), 0);
    const t = Math.max.apply(null, cards.map(c => c.time || 0));
    const fan = cards.slice(0, 3).map((c, n) => `<img src="${c.thumb}" alt="" style="--i:${n}" loading="lazy">`).join("");
    return `<button type="button" class="wc-tile${rewards ? " wc-tile-rewards" : ""}" data-i="${i}" data-t="${t}" data-w="${won}" data-title="${esc(title.toLowerCase())}">
        <span class="wc-fan" style="--n:${Math.min(3, cards.length)}">${fan}</span>
        <span class="wc-tile-main"><b>${esc(title)}</b><small>${sub}</small>
            <span class="wc-tile-meta"><em>${cards.length} card${cards.length === 1 ? "" : "s"}</em><em>${WC_COIN}${esc(won)}</em></span></span>
        ${WC_ICON.next}</button>`;
}

async function renderWinCards() {
    const grid = $("wincards-grid");
    if (!grid) return;
    grid.classList.remove("detail");
    grid.innerHTML = `<p class="empty">Loading...</p>`;
    if (!window.Coins || !Coins.user) { grid.innerHTML = `<p class="empty">Sign in to see your winning cards</p>`; return; }
    let cards = [];
    try { cards = await WinCardsDB.all(Coins.user.uid); cards = await wcUpgradeCards(cards); } catch (e) { }
    if (!cards.length) {
        grid.innerHTML = `<div class="wc-blank">${WC_ICON.trophy}<h3>Your gallery is empty</h3><p>Win a Jaldi, a Line or Housie and your card will be displayed here.</p></div>`;
        return;
    }
    const rooms = new Map(), rewards = [];
    cards.forEach(c => {
        const k = wcRoomKey(c);
        if (!k) { rewards.push(c); return; }
        if (!rooms.has(k)) rooms.set(k, { key: k, cards: [] });
        rooms.get(k).cards.push(c);
    });
    const groups = Array.from(rooms.values());
    const latest = g => Math.max.apply(null, g.cards.map(c => c.time || 0));
    groups.sort((a, b) => latest(b) - latest(a));
    groups.forEach((g, i) => { g.i = i; });
    const total = cards.reduce((a, c) => a + (Number(c.amount) || 0), 0);
    const best = cards.reduce((a, c) => Math.max(a, Number(c.amount) || 0), 0);
    const tile = (icon, v, l) => `<div class="wc-sum">${icon}<b>${v}</b><span>${l}</span></div>`;
    wcFilter = "all"; wcQuery = ""; wcOpen = null; wcSel.on = false; wcSel.ids.clear();

    const tiles = groups.map(g => {
        const info = (g.cards.find(c => c.roomInfo) || {}).roomInfo || null;
        return wcTileHTML(g.i, (info && info.label) || g.cards[0].room || "Room", wcDate(latest(g)) + " &middot; " + wcTime(latest(g)), g.cards, false);
    }).join("") + (rewards.length ? wcTileHTML("r", "Rewards & Bonuses", "Daily, spins, tasks & gifts", rewards, true) : "");

    grid.innerHTML = `
        <div class="wc-main wc-summary">
            ${tile(WC_ICON.cards, cards.length, "Cards")}
            ${tile(WC_ICON.door, groups.length, "Rooms")}
            ${tile(WC_COIN, esc(total), "Coins won")}
            ${tile(WC_ICON.crown, best, "Best win")}
        </div>
        <div class="wc-main wc-tools">
            <label class="wc-searchbox">${WC_ICON.search}<input class="wc-search" type="search" placeholder="Search rooms, prizes, notes" autocomplete="off"></label>
            <div class="wc-sortwrap">
                <button type="button" class="wc-sortbtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Sort rooms"><span class="wc-sortlabel">Newest</span>${WC_ICON.chev}</button>
                <div class="wc-sortmenu" role="listbox" aria-label="Sort rooms" hidden>${WC_SORTS.map(([v, l], i) => `<button type="button" role="option" data-sort="${v}" aria-selected="${i === 0}"><span>${l}</span>${WC_ICON.check}</button>`).join("")}</div>
            </div>
        </div>
        <div class="wc-main wc-tiles">${tiles}</div>
        <p class="wc-main wc-none wc-nomatch" hidden>No rooms match your search.</p>
        <span class="wc-dtitle"></span>
        <div class="wc-chips wc-dchips" role="group" aria-label="Filter cards"></div>
        <p class="wc-fnote" hidden></p>
        <div class="wc-rooms">
            ${groups.map(g => wcRoomHTML(g, Coins.user.uid)).join("")}
            ${rewards.length ? wcRewardsHTML(rewards) : ""}
        </div>
        <div class="wc-none wc-dnone" hidden><p>No cards match this filter.</p><button type="button" class="wc-chip wc-showall" data-f="all">Show all cards</button></div>

        <div class="wc-bulk" hidden>
            <span class="wc-bcount">Tap cards to select</span>
            <button type="button" data-b="all">All</button>
            <button type="button" data-b="fav" disabled>Favorite</button>
            <button type="button" data-b="dl" disabled>Save</button>
            <button type="button" data-b="collage" disabled>Collage</button>
            <button type="button" data-b="del" class="danger" disabled>Delete</button>
            <button type="button" data-b="cancel" aria-label="Exit select mode">&times;</button>
        </div>
        <div class="wc-undo" hidden><span></span><button type="button" data-b="undo">Undo</button></div>`;
    wcSort("new");
    const favs = wcFavs();
    grid.querySelectorAll(".wc-slot:not(.is-empty)").forEach(s => { s.dataset.fav = favs.has(s.dataset.id) ? "1" : ""; });
    wcCountUp();
}
// Tap a room -> its cards and details; chips filter inside it; "All rooms" returns; tap a card -> viewer
// the header back arrow first steps out of an open collection, then leaves the screen as before
(function () {
    const b = document.querySelector("#screen-wincards .page-head [data-open]");
    if (b) b.addEventListener("click", e => { const g = wcGrid(); if (g && g.classList.contains("detail")) { e.stopPropagation(); wcCloseColl(); } });
})();
$("wincards-grid") && ($("wincards-grid").onclick = e => {
    if (wcBulkClick(e)) return;
    if (e.target.closest(".wc-sortbtn")) { wcSortMenu(); return; }
    const so = e.target.closest(".wc-sortmenu [data-sort]");
    if (so) { wcPickSort(so.dataset.sort); return; }
    const tl = e.target.closest(".wc-tile");
    if (tl) { wcOpenColl(tl.dataset.i); return; }
    const chip = e.target.closest(".wc-chip");
    if (chip) { wcFilter = chip.dataset.f; wcRefresh(); return; }
    const tg = e.target.closest(".wc-toggle");
    if (tg) {
        const box = tg.nextElementSibling;
        const open = box.hasAttribute("hidden");
        if (open) box.removeAttribute("hidden"); else box.setAttribute("hidden", "");
        tg.setAttribute("aria-expanded", open ? "true" : "false");
        tg.classList.toggle("open", open);
        return;
    }
    const btn = e.target.closest("button.wc-frame");
    if (!btn) return;
    if (wcLP) { wcLP = false; return; }
    if (wcSel.on) { wcToggleSel(btn); return; }
    const room = btn.closest(".wc-room");
    const ids = Array.from(room.querySelectorAll(".wc-slot:not([hidden]) button.wc-frame")).map(b => b.dataset.id);
    WinCardsDB.get(btn.dataset.id).then(card => { if (card) openWinCardPopup(card, ids); });
});

/* ---------- Win Cards management: search, sort, select mode, bulk actions, collage, notes, undo-delete ---------- */
WC_ICON.search = WC_SVG('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>');
const wcSel = { on: false, ids: new Set() };
let wcLP = false, wcLPT = null, wcUndo = null;
const wcBuzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch (e) { } };

function wcSelUI() {
    const g = $("wincards-grid"); if (!g) return;
    g.classList.toggle("selecting", wcSel.on);
    g.querySelectorAll(".wc-frame").forEach(f => f.classList.toggle("sel", wcSel.ids.has(f.dataset.id)));
    const bar = g.querySelector(".wc-bulk"); if (!bar) return;
    const n = wcSel.ids.size;
    bar.hidden = !wcSel.on;
    bar.querySelector(".wc-bcount").textContent = n ? n + " selected" : "Tap cards to select";
    bar.querySelectorAll("[data-b=fav],[data-b=dl],[data-b=collage],[data-b=del]").forEach(b => { b.disabled = !n; });
    g.querySelectorAll("[data-b=selmode]").forEach(sb => { sb.classList.toggle("on", wcSel.on); sb.textContent = wcSel.on ? "Done" : "Select"; });
}
function wcSelMode(on) { wcSel.on = on; if (!on) wcSel.ids.clear(); wcSelUI(); }
function wcToggleSel(btn) {
    const id = btn.dataset.id;
    if (wcSel.ids.has(id)) wcSel.ids.delete(id); else wcSel.ids.add(id);
    wcBuzz(); wcSelUI();
}
// long-press any card to start selecting
(function () {
    const g = $("wincards-grid"); if (!g) return;
    g.addEventListener("pointerdown", e => {
        const f = e.target.closest(".wc-frame:not(.is-empty)"); wcLP = false; clearTimeout(wcLPT);
        if (!f) return;
        wcLPT = setTimeout(() => { wcLP = true; wcSel.on = true; if (!wcSel.ids.has(f.dataset.id)) wcSel.ids.add(f.dataset.id); wcBuzz(); wcSelUI(); }, 450);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(t => g.addEventListener(t, () => clearTimeout(wcLPT)));
    g.addEventListener("contextmenu", e => { if (e.target.closest(".wc-frame")) e.preventDefault(); });
    g.addEventListener("input", e => { if (e.target.classList.contains("wc-search")) { wcQuery = e.target.value.trim().toLowerCase(); wcApplyFilter(); } });
})();


function wcBulkClick(e) {
    const t = e.target.closest("[data-b]"); if (!t) return false;
    const a = t.dataset.b;
    if (a === "selmode") wcSelMode(!wcSel.on);
    else if (a === "cancel") wcSelMode(false);
    else if (a === "back") wcCloseColl();
    else if (a === "recap") wcRecap();
    else if (a === "export") wcExport();
    else if (a === "import") { const f = $("wincards-grid").querySelector(".wc-file"); if (f) f.click(); }
    else if (a === "all") {
        const vis = Array.from($("wincards-grid").querySelectorAll(".wc-room.open .wc-slot:not([hidden]):not(.is-empty) .wc-frame")).map(f => f.dataset.id);
        const all = vis.length && vis.every(i => wcSel.ids.has(i));
        vis.forEach(i => all ? wcSel.ids.delete(i) : wcSel.ids.add(i)); wcSelUI();
    }
    else if (a === "fav") wcBulkFav();
    else if (a === "dl") wcBulkDownload();
    else if (a === "collage") wcCollage();
    else if (a === "del") { wcDeleteIds(Array.from(wcSel.ids)); wcSelMode(false); }
    else if (a === "undo") wcUndoNow();
    return true;
}

function wcSetFavDom(id, on) {
    document.querySelectorAll(`.wc-frame[data-id="${id}"]`).forEach(f => f.classList.toggle("is-fav", on));
    document.querySelectorAll(`.wc-slot[data-id="${id}"]`).forEach(s => { s.dataset.fav = on ? "1" : ""; });
}
function wcBulkFav() {
    const ids = Array.from(wcSel.ids), p = wcFavs(), allFav = ids.every(i => p.has(i));
    ids.forEach(i => { if (allFav) p.delete(i); else p.add(i); wcSetFavDom(i, !allFav); });
    wcSetFavs(p); wcRefresh();
    showNotification(allFav ? "Removed " + ids.length + " from favorites" : "Added " + ids.length + " to favorites");
}
async function wcBulkDownload() {
    const ids = Array.from(wcSel.ids);
    for (const id of ids) {
        const c = await WinCardsDB.get(id);
        if (c) downloadCard(c);
        await new Promise(r => setTimeout(r, 350));
    }
    showNotification(ids.length + " card" + (ids.length === 1 ? "" : "s") + " saved");
}

// one picture with the selected cards (up to 12): handy for sharing a whole day or room
async function wcCollage() {
    const ids = Array.from(wcSel.ids).slice(0, 12); if (!ids.length) return;
    const cs = (await Promise.all(ids.map(i => WinCardsDB.get(i)))).filter(Boolean);
    const imgs = await Promise.all(cs.map(c => new Promise(r => { const im = new Image(); im.onload = () => r(im); im.onerror = () => r(null); im.src = c.dataUrl; })));
    const list = imgs.map((im, i) => ({ im, c: cs[i] })).filter(x => x.im);
    if (!list.length) return;
    const cols = list.length === 1 ? 1 : list.length <= 4 ? 2 : 3, cw = 420, pad = 24, head = 120;
    const ch = Math.round(cw * list[0].im.height / list[0].im.width), rows = Math.ceil(list.length / cols);
    const W = pad + cols * (cw + pad), H = head + rows * (ch + pad) + 8;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const x = cv.getContext("2d"), total = list.reduce((a, v) => a + (Number(v.c.amount) || 0), 0);
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#0f172a"); g.addColorStop(1, "#1e1b4b");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = "#f8fafc"; x.font = "800 38px system-ui, sans-serif"; x.fillText(myDisplayName() + "'s Housie wins", pad, 62);
    x.fillStyle = "#94a3b8"; x.font = "600 22px system-ui, sans-serif"; x.fillText(list.length + " cards  |  " + total + " coins", pad, 98);
    list.forEach((v, i) => {
        const px = pad + (i % cols) * (cw + pad), py = head + Math.floor(i / cols) * (ch + pad);
        x.save(); wcRoundRect(x, px, py, cw, ch, 18); x.clip(); x.drawImage(v.im, px, py, cw, ch); x.restore();
    });
    openWinCardPopup({ id: "collage_" + Date.now(), claim: "collage", label: "Collage", room: "My Housie wins", amount: total, time: Date.now(), dataUrl: cv.toDataURL("image/png") });
}

// delete with a 6 second undo
function wcDeleteIds(ids) {
    if (!ids.length) return;
    if (wcUndo) wcCommit();
    const g = $("wincards-grid");
    ids.forEach(id => g.querySelectorAll(`.wc-slot[data-id="${id}"]`).forEach(s => { s.dataset.del = "1"; }));
    wcUndo = { ids, timer: setTimeout(wcCommit, 6000) };
    const bar = g.querySelector(".wc-undo");
    if (bar) { bar.hidden = false; bar.querySelector("span").textContent = ids.length + " card" + (ids.length === 1 ? "" : "s") + " deleted"; }
    wcRefresh();
}
function wcUndoNow() {
    if (!wcUndo) return;
    clearTimeout(wcUndo.timer);
    wcUndo.ids.forEach(id => document.querySelectorAll(`.wc-slot[data-id="${id}"]`).forEach(s => { s.dataset.del = ""; }));
    wcUndo = null;
    const bar = document.querySelector("#wincards-grid .wc-undo"); if (bar) bar.hidden = true;
    wcRefresh();
}
function wcCommit() {
    if (!wcUndo) return;
    clearTimeout(wcUndo.timer);
    const ids = wcUndo.ids; wcUndo = null;
    const p = wcFavs(); let changed = false; ids.forEach(i => { if (p.delete(i)) changed = true; }); if (changed) wcSetFavs(p);
    Promise.all(ids.map(i => WinCardsDB.del(i).catch(() => { }))).then(() => {
        const v = $("screen-wincards");
        if (v && v.classList.contains("active")) renderWinCards();
    });
}
$("wincard-del").onclick = () => {
    if (!lastWinCard) return;
    const id = lastWinCard.id;
    $("wincard-popup").classList.remove("active");
    wcDeleteIds([id]);
};
// notes are saved with the card and searched along with room and prize names
$("wincard-note").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
$("wincard-note").addEventListener("change", async e => {
    if (!lastWinCard || /^collage_/.test(lastWinCard.id)) return;
    lastWinCard.note = e.target.value.trim().slice(0, 80);
    try { await WinCardsDB.put(lastWinCard); } catch (err) { return; }
    document.querySelectorAll(`.wc-slot[data-id="${lastWinCard.id}"]`).forEach(s => {
        s.dataset.q = ((lastWinCard.label || "") + " " + (lastWinCard.room || "") + " " + lastWinCard.note).toLowerCase();
    });
    showNotification("Note saved");
});
window.addEventListener("pagehide", () => { if (wcUndo) wcCommit(); });

/* ---------- Extras: room recap picture, backup / restore ---------- */
async function wcRecap() {
    const room = wcOpenRoom(); if (!room || room.classList.contains("wc-rewards")) return;
    const ids = Array.from(room.querySelectorAll(".wc-slot:not(.is-empty):not([hidden])")).map(s => s.dataset.id);
    const cs = (await Promise.all(ids.map(i => WinCardsDB.get(i)))).filter(Boolean);
    if (!cs.length) return;
    const info = (cs.find(c => c.roomInfo) || {}).roomInfo || null;
    const imgs = (await Promise.all(cs.slice(0, 5).map(c => new Promise(r => { const im = new Image(); im.onload = () => r(im); im.onerror = () => r(null); im.src = c.dataUrl; })))).filter(Boolean);
    const title = (info && info.label) || cs[0].room || "Room", won = cs.reduce((a, c) => a + (Number(c.amount) || 0), 0);
    const W = 1080, pad = 48, cw = Math.floor((W - pad * 2 - 16 * (imgs.length - 1)) / imgs.length), ch = imgs.length ? Math.round(cw * imgs[0].height / imgs[0].width) : 0;
    // everyone who won a prize in this room (at most 5, one per prize), biggest winner first
    const mem = info ? (info.members || []).filter(m => (m.claims || []).length).sort((a, b) => (b.coins - a.coins) || (b.claims.length - a.claims.length)).slice(0, 5) : [];
    const H = 250 + ch + 60 + (mem.length ? 50 + mem.length * 92 : 0) + 50;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const x = cv.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#0f172a"); g.addColorStop(1, "#312e81");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = "#f8fafc"; x.font = "800 64px system-ui, sans-serif"; x.fillText(title, pad, 100);
    x.fillStyle = "#94a3b8"; x.font = "600 30px system-ui, sans-serif";
    const bits = [wcDate(Math.max.apply(null, cs.map(c => c.time || 0)))];
    if (info) { bits.push(info.playerCount + " players"); bits.push("pot " + info.pot); }
    x.fillText(bits.join("   |   "), pad, 150);
    x.fillStyle = "#fbbf24"; x.font = "800 40px system-ui, sans-serif"; x.fillText("I won " + won + " coins", pad, 210);
    imgs.forEach((im, i) => { const px = pad + i * (cw + 16); x.save(); wcRoundRect(x, px, 250, cw, ch, 20); x.clip(); x.drawImage(im, px, 250, cw, ch); x.restore(); });
    if (mem.length) {
        let y = 250 + ch + 70;
        x.fillStyle = "#94a3b8"; x.font = "700 26px system-ui, sans-serif"; x.fillText("Prize winners", pad, y);
        mem.forEach((m, i) => {
            y += 50;
            x.font = "700 30px system-ui, sans-serif";
            const coinTxt = String(m.coins), coinW = x.measureText(coinTxt).width;
            x.fillStyle = "#f8fafc";
            x.fillText(wcEllipsize(x, (i + 1) + ".  " + (m.name || "Player"), W - pad * 2 - coinW - 28), pad, y);   // the name never runs into the coins
            x.textAlign = "right"; x.fillStyle = "#fbbf24"; x.fillText(coinTxt, W - pad, y); x.textAlign = "left";
            y += 32;
            x.fillStyle = "#94a3b8"; x.font = "600 22px system-ui, sans-serif";
            x.fillText(wcEllipsize(x, m.claims.map(k => CLAIM_SHORT[k] || k).join(", "), W - pad * 2), pad, y);   // which prizes they won
            y += 10;
        });
    }
    openWinCardPopup({ id: "collage_recap_" + Date.now(), claim: "recap", label: "Room recap", room: title, amount: won, time: Date.now(), dataUrl: cv.toDataURL("image/png") });
}

async function wcExport() {
    let cards = []; try { cards = await WinCardsDB.all(Coins.user.uid); } catch (e) { }
    if (!cards.length) { showNotification("No cards to back up", "error"); return; }
    const blob = new Blob([JSON.stringify({ app: "housie-wincards", v: 1, favs: Array.from(wcFavs()), cards })], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "housie-wincards-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    showNotification(cards.length + " cards backed up");
}
async function wcImport(file) {
    if (!file) return;
    try {
        const d = JSON.parse(await file.text());
        if (!d || d.app !== "housie-wincards" || !Array.isArray(d.cards)) throw new Error("bad file");
        let n = 0;
        for (const c of d.cards.slice(0, 2000)) {
            if (!c || typeof c.id !== "string" || typeof c.claim !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(c.dataUrl || "")) continue;
            if (c.thumb && !/^data:image\//.test(c.thumb)) c.thumb = c.dataUrl;
            c.uid = Coins.user.uid; await WinCardsDB.put(c); n++;
        }
        const fl = Array.isArray(d.favs) ? d.favs : Array.isArray(d.pins) ? d.pins : null;   // older backups called them pins
        if (fl) { const p = wcFavs(); fl.filter(x => typeof x === "string").forEach(x => p.add(x)); wcSetFavs(p); }
        showNotification(n + " cards restored"); renderWinCards();
    } catch (e) { showNotification("That isn't a Housie card backup", "error"); }
}
(function () {
    const g = $("wincards-grid"); if (!g) return;
    g.addEventListener("change", e => { if (e.target.classList.contains("wc-file")) { wcImport(e.target.files[0]); e.target.value = ""; } });
})();

document.getElementById("win-share").onclick = () => openWinCardPopup(lastWinCard);

/* ================= WIN & LEAVE ================= */
function showWinScreen() {
    const prize = gameData ? Coins.prizeShare(gameData.pot, "housie", gameData.split) : 0;
    $("win-coins").textContent = "+" + prize;
    const bonus = gameData ? Coins.bonusFor("housie", gameData.playerCount, gameData.pot) : Coins.HOUSIE_BONUS;
    $("win-bonus").textContent = "+" + bonus;
    const bonusBox = $("win-bonus").parentElement;
    if (bonusBox) bonusBox.style.display = bonus ? "" : "none";
    $("win-text").textContent = "You claimed Housie!";
    winScreen.classList.add("active");
    if (window.FX) FX.play("win");
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
    const go = () => { stopListeners(); Coins.clearActiveGame(); reloadApp(); };
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
leaveCancel.onclick = () => { if (!leaveCancel.disabled) leavePopup.classList.remove("active"); };
leaveConfirm.onclick = () => {
    if (leaveConfirm.classList.contains("loading")) return;   // already leaving: ignore repeat taps
    // spinner on the Leave button while the room is being left (the page reloads when it is done)
    leaveConfirm.classList.add("loading");
    leaveConfirm.disabled = true;
    leaveCancel.disabled = true;
    leaveConfirm.innerHTML = '<span class="spinner"></span>Leaving';
    intentionalExit = true;
    const finish = () => { stopListeners(); reloadApp(); };
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
// No limit on favorite numbers: any of the 90 numbers can be a favorite (FAV_MAX is just "all numbers").
const FAV_MAX = 90;
// unique numbers 1-90. generateTambolaSet spreads them over the player's tickets (15 on ticket 1, then ticket 2 ...; a ticket
// never holds more than 15 numbers, so favorites beyond 15 per ticket are not used).
function validFavorites(list) {
    return Array.from(new Set((list || []).map(Number))).filter(n => Number.isInteger(n) && n >= 1 && n <= 90).slice(0, FAV_MAX);   // keeps the order the player picked them in
}
// Picker rule: any numbers, no limit.
const favRowOf = n => Math.floor((n - 1) / 10);
const favRowName = r => (r * 10 + 1) + "-" + (r * 10 + 10);
function favoritesFitOneTicket(list) {
    return true;   // no limit at all
}
// Builds the player's `count` tickets around their favorite numbers. EVERY ticket has exactly 15 numbers, 5 in every row
// (3 rows x 9 columns, 1-3 numbers per column, no two blanks side by side). Ticket 1 takes up to 15 favorites first, then
// ticket 2, and so on; favorites beyond 15 per ticket (15 x the number of tickets) are left out. Every favorite lands on exactly
// ONE ticket. For each ticket the column layout that keeps the most favorites in their own column is chosen; a favorite that
// does not fit its own column moves to the nearest column with room. The remaining cells are filled with random numbers that
// are not used anywhere else on these tickets.
// Which tickets each favorite goes on: first fit, ascending, ticket 1 first. A ticket takes at most 3 numbers per column and only
// column counts that a real ticket layout can hold. Returns { groups: [{cols, list}], left: favorites that fit on none }.
function favAssign(favs, count, keepOrder) {
    const colOf = n => Math.min(8, Math.floor(n / 10));
    const groups = Array.from({ length: count }, () => ({ cols: Array(9).fill(0), list: [] }));
    // a ticket can hold these favorites when no column has more than 3 and the columns still fit in 15 numbers (an empty column still needs 1)
    const fits = (g, c) => {
        if (g.cols[c] >= 3) return false;
        const cols = g.cols.slice(); cols[c]++;
        return cols.reduce((sum, v) => sum + Math.max(v, 1), 0) <= 15;
    };
    const left = [];
    (keepOrder ? favs.slice() : favs.slice().sort((x, y) => x - y)).forEach(n => {   // keepOrder: the first numbers picked get ticket 1
        const c = colOf(n), g = groups.find(gr => fits(gr, c));
        if (g) { g.cols[c]++; g.list.push(n); } else left.push(n);
    });
    return { groups, left };
}
// fewest tickets (1 to 4) that can hold every number of the list, or null when even 4 tickets cannot
function favTicketsNeeded(list) {
    for (let t = 1; t <= 4; t++) if (!favAssign(list, t).left.length) return t;
    return null;
}
function favTickets(favs, count, colOf, shuffle, layoutRows) {
    const all = [...Array(90).keys()].map(i => i + 1);
    const kvList = allColumnCounts();
    const spreadKeys = spreadLayouts().byKey;
    const rnd = a => a[Math.floor(Math.random() * a.length)];
    for (let attempt = 0; attempt < 1500; attempt++) {
        // Favorites fill ticket 1 first, then ticket 2, and so on (see favAssign)
        let asg = favAssign(favs, count, true);                      // the numbers picked first go on ticket 1
        if (asg.left.length && !favAssign(favs, count).left.length) asg = favAssign(favs, count);   // pick order does not fit: use the packing that holds them all
        const groups = asg.groups;
        const pool = [].concat(...groups.map(g => g.list));
        const used = new Set(pool);
        const tickets = [];
        let ok = true;
        for (let t = 0; t < count && ok; t++) {
            const mine = groups[t].list;
            const byCol = Array.from({ length: 9 }, () => []);
            mine.forEach(n => byCol[colOf(n)].push(n));
            // the layout (numbers per column) that keeps the most favorites in their own column
            // later tickets that hold none of their own favorites in a column still need one random number there
            const later = Array(9).fill(0);
            for (let u = t + 1; u < count; u++) {
                const has = Array(9).fill(false);
                groups[u].list.forEach(n => { has[colOf(n)] = true; });
                has.forEach((h, c) => { if (!h) later[c]++; });
            }
            // numbers still free in every column, keeping at least one per column for each ticket still to come
            const free = Array.from({ length: 9 }, (_, c) => all.filter(n => colOf(n) === c && !used.has(n)).length - later[c]);
            let best = -1, cands = [];
            for (const kv of kvList) {
                if (kv.some((v, c) => v - Math.min(byCol[c].length, v) > free[c])) continue;   // would run out of numbers in a column
                const sc = kv.reduce((s, v, c) => s + Math.min(byCol[c].length, v), 0);
                if (sc > best) { best = sc; cands = [kv]; } else if (sc === best) cands.push(kv);
            }
            if (!cands.length) { ok = false; break; }
            const nice = cands.filter(k => spreadKeys[k.join()]);   // prefer a layout with no two blanks side by side
            const kv = rnd(nice.length ? nice : cands), cols = Array.from({ length: 9 }, () => []), overflow = [];
            byCol.forEach((list, c) => list.forEach((n, i) => (i < kv[c] ? cols[c].push(n) : overflow.push(n))));
            // a favorite that has no room in its OWN column is left out (never moved to another column), so every column keeps its own range
            overflow.forEach(n => used.delete(n));
            for (let c = 0; c < 9 && ok; c++) {                    // fill what is left with random unused numbers of that column
                while (cols[c].length < kv[c]) {
                    const p = all.filter(n => colOf(n) === c && !used.has(n));
                    if (!p.length) { ok = false; break; }
                    const n = rnd(p); used.add(n); cols[c].push(n);
                }
            }
            if (!ok) break;
            const g = layoutRows(kv);
            if (!g) { ok = false; break; }
            const grid = Array.from({ length: 3 }, () => Array(9).fill(null));
            for (let c = 0; c < 9; c++) {
                const rows = [0, 1, 2].filter(r => g[r][c]);
                cols[c].sort((x, y) => x - y).forEach((n, i) => { grid[rows[i]][c] = n; });
            }
            tickets.push(grid);
        }
        if (ok) return tickets;
    }
    return null;
}
// the player's tickets built around their favorites (favorites that do not fit are silently skipped)
// Which favorites go on which ticket. The numbers picked FIRST fill ticket 1, what does not fit there goes to ticket 2,
// then 3, then 4 (a ticket holds at most 3 numbers per column and 15 in all). `left` = favorites no ticket can hold.
function favPlan(favs, count) {
    let asg = favAssign(favs, count, true);
    if (asg.left.length && !favAssign(favs, count).left.length) asg = favAssign(favs, count);   // pick order does not fit: use the packing that holds them all
    return asg;
}
// Counts what is wrong with a generated set: 1000 for a broken ticket (not 15 numbers, 5 per row, 1-3 per column in the
// column's own range, no repeats) plus 1 for every favorite that is not on the ticket it was planned for.
function ticketsProblems(tickets, count, plan) {
    if (!Array.isArray(tickets) || tickets.length < count) return 1000;
    const seen = new Set();
    let bad = 0;
    for (let t = 0; t < count; t++) {
        const g = tickets[t];
        if (!Array.isArray(g) || g.length !== 3) return 1000;
        const ns = g.flat().filter(Boolean);
        if (ns.length !== 15 || g.some(r => r.filter(Boolean).length !== 5)) return 1000;
        for (let c = 0; c < 9; c++) {
            const col = g.map(r => r[c]).filter(Boolean);
            if (col.length < 1 || col.length > 3 || col.some(n => Math.min(8, Math.floor(n / 10)) !== c)) return 1000;
        }
        for (const n of ns) { if (seen.has(n)) return 1000; seen.add(n); }
    }
    if (plan) plan.groups.forEach((gr, t) => { const has = new Set((tickets[t] || []).flat().filter(Boolean)); gr.list.forEach(n => { if (!has.has(n)) bad++; }); });
    return bad;
}
function generateMyTickets(count) {
    const favs = myFavorites();
    const n = Math.max(1, Math.min(6, count | 0));
    const plan = favs.length ? favPlan(favs, n) : null;
    // every set is checked; a bad one is thrown away and built again, so a favorite is never silently lost
    let best = null, bestBad = Infinity;
    for (let i = 0; i < 8 && bestBad > 0; i++) {
        const t = generateTambolaSet(count, favs);
        const bad = ticketsProblems(t, n, plan);
        if (bad < bestBad) { best = t; bestBad = bad; }
    }
    if (bestBad) console.warn("[tickets] " + bestBad + " problem(s) left after 8 tries");
    if (plan && plan.left.length) showNotification(`${plan.left.length > 1 ? "These favorites do" : "This favorite does"} not fit on your ${n} ticket${n > 1 ? "s" : ""}: ${plan.left.join(", ")}`);
    return best;
}
// Tickets are built from Coins.favorites, which is filled by the live account listener. Right after the app opens
// (or sign-in) that list can still be empty, and the tickets were then built with NO favorites. When the list is
// empty, ask the server once (max 4 s) before building tickets.
function ensureFavoritesLoaded() {
    if (!window.Coins || !Coins.user || (Coins.favorites && Coins.favorites.length)) return Promise.resolve();
    return withTimeout(Coins.serverFavorites(), 4000, "")
        .then(srv => { if (srv && srv.length && !(Coins.favorites && Coins.favorites.length)) Coins.favorites = validFavorites(srv); })
        .catch(() => { });
}
// Every way to split 15 numbers over the 9 columns with 1-3 numbers in each column (the spread rule is NOT required here).
let KV_CACHE = null;
function allColumnCounts() {
    if (KV_CACHE) return KV_CACHE;
    const out = [], cur = [];
    (function go(c, left) {
        if (c === 9) { if (left === 0) out.push(cur.slice()); return; }
        for (let v = 1; v <= 3; v++) {
            if (left - v < 8 - c || left - v > 3 * (8 - c)) continue;
            cur[c] = v; go(c + 1, left - v);
        }
    })(0, 15);
    return (KV_CACHE = out);
}
// A 3 x 9 layout with exactly these numbers per column and 5 in every row. Used when no spread layout has these column counts.
function plainLayout(kv) {
    const g = [Array(9).fill(false), Array(9).fill(false), Array(9).fill(false)], room = [5, 5, 5];
    kv.map((v, c) => [v, c]).sort((a, b) => b[0] - a[0]).forEach(([v, c]) => {
        [0, 1, 2].sort((a, b) => room[b] - room[a]).slice(0, v).forEach(r => { g[r][c] = true; room[r]--; });
    });
    return room.every(x => x === 0) ? g : null;
}
// All ticket layouts (3 rows x 9 columns) where every row has 5 numbers with no two blanks side by side and every column
// has 1-3 numbers. Built once, grouped by their per-column counts.
let SPREAD_CACHE = null;
function spreadLayouts() {
    if (SPREAD_CACHE) return SPREAD_CACHE;
    const pats = [];
    for (let m = 0; m < 512; m++) {
        const row = [...Array(9).keys()].map(c => !!((m >> c) & 1));
        if (row.filter(Boolean).length !== 5) continue;
        let ok = true;
        for (let c = 1; c < 9; c++) if (!row[c] && !row[c - 1]) ok = false;
        if (ok) pats.push(row);
    }
    const list = [], byKey = {};
    for (const a of pats) for (const b of pats) for (const c of pats) {
        const g = [a, b, c], kv = [...Array(9).keys()].map(i => g.filter(r => r[i]).length);
        if (kv.some(x => x < 1)) continue;
        const L = { g, kv };
        list.push(L); (byKey[kv.join()] || (byKey[kv.join()] = [])).push(L);
    }
    return (SPREAD_CACHE = { list, byKey });
}
// 6 spread layouts whose column counts add up to the size of every column (9,10,...,10,11) - one standard strip
function pickSpreadStrip(ranges) {
    const { list, byKey } = spreadLayouts(), target = ranges.map(r => r[1] - r[0] + 1);
    for (let attempt = 0; attempt < 4000; attempt++) {
        const rem = target.slice(), picks = [];
        let ok = true;
        for (let t = 0; t < 5 && ok; t++) {
            const left = 5 - t;   // tickets still to come after this one
            ok = false;
            for (let i = 0; i < 40; i++) {
                const L = list[Math.floor(Math.random() * list.length)];
                if (rem.every((r, c) => r - L.kv[c] >= left && r - L.kv[c] <= 3 * left)) { L.kv.forEach((v, c) => { rem[c] -= v; }); picks.push(L); ok = true; break; }
            }
        }
        if (!ok) continue;
        const last = byKey[rem.join()];
        if (last) { picks.push(last[Math.floor(Math.random() * last.length)]); return picks; }
    }
    return null;
}
function generateTambolaSet(count, favs) {
    favs = validFavorites(favs);
    count = Math.max(1, Math.min(6, count | 0));
    const ranges = [[1, 9], [10, 19], [20, 29], [30, 39], [40, 49], [50, 59], [60, 69], [70, 79], [80, 90]];
    const colOf = n => Math.min(8, Math.floor(n / 10));
    const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; };
    // rows: give every column its numbers so each row ends with exactly 5 (always works when the counts add up to 15)
    // SPREAD RULE: no two blank cells side by side in a row, so the 5 numbers of a row are spread across it.
    // layoutRows picks a random ready-made spread layout that has exactly these per-column counts (null when none exists).
    const layoutRows = kv => { const a = spreadLayouts().byKey[kv.join()]; return a ? a[Math.floor(Math.random() * a.length)].g : plainLayout(kv); };
    if (favs.length) {
        // if the builder cannot place them all, drop the LAST picked favorites one by one - never every favorite
        const use = favs.slice();
        for (let drop = 0; use.length && drop < 12; drop++) {
            const fs = favTickets(use, count, colOf, shuffle, layoutRows);
            if (fs) return fs;
            use.pop();
        }
    }
    const fvPlace = [], placed = [];   // standard strip (no favorites)
    for (let attempt = 0; attempt < 3000; attempt++) {
        const fv = Array.from({ length: 6 }, () => Array.from({ length: 9 }, () => []));
        const picks = pickSpreadStrip(ranges);   // 6 spread layouts that together use every number of every column
        if (!picks) continue;
        const grids = picks.map(p => p.g);
        // 3) deal each column: a ticket's own favorites first, then the other numbers of the column (none repeated), ascending top to bottom
        const tickets = Array.from({ length: 6 }, () => Array.from({ length: 3 }, () => Array(9).fill(null)));
        for (let c = 0; c < 9; c++) {
            const pool = [];
            for (let n = ranges[c][0]; n <= ranges[c][1]; n++) if (!placed.includes(n)) pool.push(n);
            shuffle(pool);
            for (let t = 0; t < 6; t++) {
                const rows = [0, 1, 2].filter(r => grids[t][r][c]);
                fv[t][c].concat(pool.splice(0, rows.length - fv[t][c].length)).sort((x, y) => x - y).forEach((n, i) => { tickets[t][rows[i]][c] = n; });
            }
        }
        // the player's tickets are the first `count` of the strip (favorites were only given to those)
        return placed.length ? tickets.slice(0, count) : shuffle(tickets).slice(0, count);
    }
    // extremely unlikely fallback: independent tickets
    return Array.from({ length: count }, () => generateTambolaTicket());
}

/* ================= TAMBOLA SINGLE TICKET ================= */
function generateTambolaTicket() {
    const ranges = [[1, 9], [10, 19], [20, 29], [30, 39], [40, 49], [50, 59], [60, 69], [70, 79], [80, 90]];
    // 5 numbers per row, and every column must hold at least one number
    let cols;
    // every row: 5 numbers with no two blanks side by side (spread across the row)
    const spreadRow = p => { for (let c = 1; c < 9; c++) if (!p.has(c) && !p.has(c - 1)) return false; return true; };
    do {
        cols = Array.from({ length: 3 }, () => {
            let picked;
            do {
                picked = new Set();
                while (picked.size < 5) picked.add(Math.floor(Math.random() * 9));
            } while (!spreadRow(picked));
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
    ensureInviteCode().catch(() => { });   // makes sure my invite code is registered so friends can use it
    maybeAskInvite();
    if (!devUnwatch) startDevWatch();
    if (currentView === "arena") return;
    attemptResume(user);
}
if (window.Coins && Coins.enabled) {
    Coins.authListeners.push(onAuth);
    Coins.ready.then(u => { if (!authHandled) onAuth(u); });
    // only screens that draw from local data are re-drawn (no screen here does a Firestore read any more)
    const LOCAL_VIEWS = ["home", "earn", "stats", "transactions", "profile", "history"];
    const refreshLocalViews = () => {
        updateCost();
        updateTaskBadge();
        if (LOCAL_VIEWS.includes(currentView) && VIEW_LOADERS[currentView]) VIEW_LOADERS[currentView]();
        else if (currentView === "invite") renderWelcomeTasks();
    };
    Coins.onBalance = refreshLocalViews;
    Coins.onLocal = refreshLocalViews;
    Coins.onCloud = applyCloudSettings;
}

/* ================= SMALL HELPERS ================= */
const BONUS_DAYS = [1000, 1000, 1000, 1000, 1000, 1000, 1000];
// Try your luck: one spin every hour. The wheel shows 1k to 10k and one 25k slice.
// 25,000 is paid exactly once a day, and always on the first spin AFTER the day's first 3 spins (the 4th spin of the day);
// every other spin pays one of 1,000 to 10,000 (1k,2k,...,10k). firestore.rules allow only those amounts and accept the 25k once per day (users/{uid}.bigDay).
const WHEEL_BIG = 25000, WHEEL_BIG_AFTER = 3;
const WHEEL_VALUES = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, WHEEL_BIG];   // prizes printed on the wheel
const WHEEL_EVERY_MS = 60 * 60 * 1000;
// which slice today's next spin lands on: the 25k slice on the 4th spin of the day (if 25k was not paid today yet), otherwise a random 1k-10k slice
function wheelPick(L) {
    const today = dayKey(new Date());
    const spins = L.filter(e => e.type === "wheel" && dayKey(timeOf(e)) === today);
    const gotBig = spins.some(e => Number(e.amount) >= WHEEL_BIG);
    if (!gotBig && spins.length >= WHEEL_BIG_AFTER) return WHEEL_VALUES.indexOf(WHEEL_BIG);
    return Math.floor(Math.random() * (WHEEL_VALUES.length - 1));   // never the 25k slice
}
const wheelPrize = L => WHEEL_VALUES[wheelPick(L)];
// ledger id "wheel_<hour number>": one hour can only ever pay once, even from two devices
const wheelSlot = () => Math.floor(Date.now() / WHEEL_EVERY_MS);
// milliseconds until the next spin (0 = ready now): one hour after the latest spin in the coin history
function wheelWait(L) {
    let last = 0;
    L.forEach(e => { if (e.type === "wheel") { const t = rowTime(e); if (t) last = Math.max(last, t.getTime()); } });
    return Math.min(WHEEL_EVERY_MS, Math.max(0, last + WHEEL_EVERY_MS - Date.now()));   // capped, so a wrong phone clock can't lock it for long
}
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
    return (Array.from(String(name || "P").trim())[0] || "P").toUpperCase();   // Array.from keeps an emoji whole
}
function setAvatar(el, name) {
    if (el) el.textContent = avatarLetter(name);
}

// The coin history is a capped copy kept in Firestore (users/{uid}/data/history, see Coins.localAdd): 1 read per sign-in.
async function getLedger() { return Coins.localLedger(); }

/* ================= DERIVED DATA (from the ledger) ================= */
// Games that really took place: every room entry and every match against the developer, except those whose entry fee
// was given back (room cancelled / host offline / developer match cancelled before the first number). Used by the
// Stats screen, the one-time tasks and the daily / weekly / monthly tasks, so all of them count games the same way.
function playedGames(L) {
    const refunded = new Set(L.filter(e => (e.type === "refund" || e.type === "devrefund") && e.gameId).map(e => e.gameId));
    return L.filter(e => (e.type === "entry" || e.type === "deventry") && !refunded.has(e.gameId));
}
function computeStats(L) {
    const entries = playedGames(L);
    const wins = L.filter(e => e.type === "win");
    const games = entries.length;
    const winGames = new Set(wins.map(w => w.gameId)).size;
    const coinsWon = sum(wins, w => w.amount);
    const spent = -sum(L.filter(e => e.type === "entry" || e.type === "deventry"), e => e.amount) - sum(L.filter(e => e.type === "refund" || e.type === "devrefund"), e => e.amount);   // every fee paid, minus the fees given back
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
function periodStats(L, inP) {
    // Every game counts for the tasks, whatever kind of game it is (normal room, free room or a match against the developer),
    // and so does every prize won in it.
    const entries = playedGames(L).filter(inP);   // a game whose entry fee was refunded does not count
    const wins = L.filter(e => e.type === "win" && inP(e));
    const prize = p => wins.filter(w => w.prize === p).length;
    return {
        hosted: entries.filter(e => e.host).length,      // games played as the host
        spins: L.filter(e => e.type === "wheel" && inP(e)).length,   // "Try your luck" spins
        // different friends who were sent 100 or more coins in one go (sending 3 times to the same friend counts once)
        shared: new Set(L.filter(e => e.type === "send" && -e.amount >= 100 && inP(e)).map(e => e.to || e.toCode).filter(Boolean)).size,
        play: entries.length,
        win: wins.length,
        jaldi: prize("jaldi"),
        lines: prize("line1") + prize("line2") + prize("line3"),
        housie: prize("housie")
    };
}
function taskContext(L) {
    if (typeof nbPending !== "undefined" && nbPending.size) nbMark();   // apply actions that were done before the account was ready
    const st = computeStats(L);
    const now = new Date();
    const today = dayKey(now), week = weekKey(now), month = monthKey(now);
    return {
        st,
        day: periodStats(L, e => dayKey(timeOf(e)) === today),
        week: periodStats(L, e => weekKey(timeOf(e)) === week),
        month: periodStats(L, e => monthKey(timeOf(e)) === month),
        invBy: store.get("invitedBy", null),                       // { uid, name, code } of the friend whose invite code was entered
        nb: new Set(store.get("nbFlags", [])),                     // welcome-task actions done so far (see nbMark)
        fav: favSaved().length,                                    // favorite numbers saved
        joined: playedGames(L).filter(e => e.type === "entry" && !e.host).length,   // rooms joined as a player (not host)
        dailyBonus: L.some(e => e.type === "daily"),               // has claimed a Daily bonus
        devGames: playedGames(L).filter(e => e.type === "deventry").length,         // matches against the developer
        claimed: new Set(L.filter(e => e.type === "task").map(e => e.id))
    };
}
// Task ids end in "_v4": the new targets/rewards start fresh, so tasks already claimed under the old values can be earned again once.
// Daily tasks use "_v4" ids (new targets/rewards). Daily 9 tasks + a "complete all" bonus, weekly 6 + a "complete all" bonus, monthly 6 + a "complete all" bonus. Daily refreshes at midnight, weekly on Monday 00:00, monthly on the 1st at 00:00 (device time).
// firestore.rules must allow the task ledger entries up to the biggest reward below (1740000).
const TASKS = {
    daily: [
        { id: "play10_v4", title: "Play 10 games", target: 10, reward: 3000, calc: c => c.day.play },
        { id: "play15_v4", title: "Play 15 games", target: 15, reward: 5000, calc: c => c.day.play },
        { id: "jaldi5_v4", title: "Win 5 Jaldi", target: 5, reward: 4000, calc: c => c.day.jaldi },
        { id: "line5_v4", title: "Win 5 Lines", target: 5, reward: 5500, calc: c => c.day.lines },
        { id: "win15_v4", title: "Win any 15 prizes", target: 15, reward: 7000, calc: c => c.day.win },
        { id: "housie5_v4", title: "Win 5 Housie", target: 5, reward: 6500, calc: c => c.day.housie },
        { id: "host5_v4", title: "Be the host in 5 games", target: 5, reward: 6000, calc: c => c.day.hosted },
        { id: "spin5_v4", title: "Spin \"Try your luck\" 5 times", target: 5, reward: 8500, calc: c => c.day.spins },
        { id: "share3_v4", title: "Share 100+ coins to 3 friends", target: 3, reward: 9000, calc: c => c.day.shared },
        { id: "d_all_v4", title: "Complete all daily tasks", target: 9, reward: 15000, calc: c => allDone("daily", c) }
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
    // Welcome tasks: only for new joiners, for NEWBIE_DAYS days after the account was made. They are NOT the same as the daily / weekly / monthly
    // tasks: they are about getting to know the app (profile, favorites, rooms, friends). Paid once each (ledger id task_once_<id>).
    // c.nb = the "first time" actions remembered by nbMark(); c.fav / c.joined / c.devGames come from the account and the ledger.
    newbie: [
        { id: "nw_earn_v1", title: "Visit the Tasks tab", target: 1, reward: 1000, calc: c => c.nb.has("earn") ? 1 : 0 },
        { id: "nw_lb_v2", title: "Check the Leaderboard", target: 1, reward: 1500, calc: c => c.nb.has("lb") ? 1 : 0 },
        { id: "nw_stats_v2", title: "Open your Analytics", target: 1, reward: 2000, calc: c => c.nb.has("stats") ? 1 : 0 },
        { id: "nw_tx_v1", title: "Check your Transactions", target: 1, reward: 2500, calc: c => c.nb.has("tx") ? 1 : 0 },
        { id: "nw_hist_v1", title: "Open your Play history", target: 1, reward: 3000, calc: c => c.nb.has("hist") ? 1 : 0 },
        { id: "nw_upd_v1", title: "Read the latest Updates", target: 1, reward: 3500, calc: c => c.nb.has("upd") ? 1 : 0 },
        { id: "nw_cards_v1", title: "Open your Win Cards", target: 1, reward: 4000, calc: c => c.nb.has("cards") ? 1 : 0 },
        { id: "nw_sounds_v1", title: "Explore the Sounds settings", target: 1, reward: 4500, calc: c => c.nb.has("sounds") ? 1 : 0 },
        { id: "nw_invite_v1", title: "Open Invite friends", target: 1, reward: 5000, extra: true, calc: c => c.nb.has("invite") ? 1 : 0 },
        { id: "nw_sendscr_v1", title: "Open Send coins", target: 1, reward: 5500, extra: true, calc: c => c.nb.has("send") ? 1 : 0 },
        { id: "nw_read_v1", title: "Mark an Update as read", target: 1, reward: 6000, extra: true, calc: c => c.nb.has("read") ? 1 : 0 },
        { id: "nw_theme_v2", title: "Choose a ticket theme", target: 1, reward: 6500, calc: c => c.nb.has("theme") ? 1 : 0 },
        // ---- explore-the-app tasks: features the daily / weekly / monthly tasks never touch (extra: true -> not counted for the inviter's reward) ----
        { id: "nw_random_v1", title: "Try the Random theme mode", target: 1, reward: 7000, extra: true, calc: c => c.nb.has("random") ? 1 : 0 },
        { id: "nw_name_v2", title: "Set your own display name", target: 1, reward: 7500, calc: c => c.nb.has("name") ? 1 : 0 },
        { id: "nw_code_v1", title: "Copy your Friend code", target: 1, reward: 8000, extra: true, calc: c => c.nb.has("code") ? 1 : 0 },
        { id: "nw_music_v1", title: "Turn on the background music", target: 1, reward: 8500, extra: true, calc: c => c.nb.has("music") ? 1 : 0 },
        { id: "nw_fav_v2", title: "Pick your first favorite number", target: 1, reward: 9000, calc: c => c.fav },
        { id: "nw_bonus_v1", title: "Claim your first Daily bonus", target: 1, reward: 9500, extra: true, calc: c => c.dailyBonus ? 1 : 0 },
        { id: "nw_wcfav_v1", title: "Star a Win Card as favorite", target: 1, reward: 10000, extra: true, calc: c => c.nb.has("wcfav") ? 1 : 0 },
        { id: "nw_wcsave_v1", title: "Share, copy or download a Win Card", target: 1, reward: 10500, extra: true, calc: c => c.nb.has("wcsave") ? 1 : 0 },
        { id: "nw_auto_v1", title: "Try Auto-draw as a host", target: 1, reward: 11000, extra: true, calc: c => c.nb.has("auto") ? 1 : 0 },
        { id: "nw_dev_v2", title: "Play a match with the Developer", target: 1, reward: 11500, calc: c => c.devGames },
        { id: "nw_joininv_v1", title: "Joined with a friend's invite code", target: 1, reward: 25000, invOnly: true, calc: c => c.invBy ? 1 : 0 },
        { id: "nw_all_v3", title: "Complete all welcome tasks", target: 22, reward: 20000, calc: c => allDone("newbie", c) }
    ],
    once: [
        { id: "first_game", title: "Play your first game", target: 1, reward: 20, calc: c => c.st.games },
        { id: "first_win", title: "Win your first prize", target: 1, reward: 30, calc: c => c.st.wins },
        { id: "first_housie", title: "Win a Housie", target: 1, reward: 100, calc: c => c.st.housie },
        { id: "games25", title: "Play 25 games", target: 25, reward: 100, calc: c => c.st.games }
    ]
};
// progress of the "Complete all ... tasks" bonus: how many of the other tasks in the set have reached their target
TASKS.newbie.find(t => /_all_/.test(t.id)).target = TASKS.newbie.filter(t => !/_all_/.test(t.id) && !t.invOnly).length;   // always = number of tasks in the set
const allDone = (kind, c) => TASKS[kind].filter(x => !/_all_/.test(x.id) && !x.invOnly && x.calc(c) >= x.target).length;   // invOnly tasks are an extra gift, not part of "complete all"
// Welcome tasks are open for 7 days after the account was created (Firebase account creation time).
const NEWBIE_DAYS = 7;
function newbieEnds() {
    const u = window.Coins && Coins.user;
    const t = u && u.metadata ? Date.parse(u.metadata.creationTime) : NaN;
    return Number.isFinite(t) ? t + NEWBIE_DAYS * 86400000 : 0;
}
const newbieActive = () => newbieEnds() > Date.now();
// the welcome tasks that count towards the inviter's reward (not the "complete all" bonus, not the invite-code gift)
const NW_TOTAL = TASKS.newbie.filter(t => !/_all_/.test(t.id) && !t.invOnly && !t.extra).length;
// players who joined with an invite code share how many welcome tasks they have completed, so their inviter can see it (written only when it changes)
function syncNwProgress(c) {
    try {
        if (!c.invBy || !newbieActive() || !window.Coins || !Coins.user) return;
        const n = TASKS.newbie.filter(t => !/_all_/.test(t.id) && !t.invOnly && !t.extra && t.calc(c) >= t.target).length;
        const last = store.get("nwSent", -1);
        if (n === last) return;
        store.set("nwSent", n);
        Coins.setNwDone(n).catch(() => store.set("nwSent", last));
    } catch (e) { }
}
// remembers a first-time action for the welcome tasks (only while the welcome tasks are open, so older players cost no writes)
const nbPending = new Set();   // actions done before the account was ready
function nbMark(flag) {
    try {
        if (flag) nbPending.add(flag);
        if (!window.Coins || !Coins.user) return;   // kept in nbPending, applied by the next nbMark / taskContext
        if (!newbieActive()) { nbPending.clear(); return; }
        const seen = store.get("nbFlags", []);
        const add = [...nbPending].filter(f => !seen.includes(f));
        nbPending.clear();
        if (!add.length) return;
        store.set("nbFlags", seen.concat(add));
        updateTaskBadge();
        if (currentView === "invite") renderWelcomeTasks();
    } catch (e) { }
}
const NB_VIEWS = { leaderboard: "lb", stats: "stats", wincards: "cards", sounds: "sounds", transactions: "tx", history: "hist", updates: "upd", earn: "earn", invite: "invite", share: "send" };
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
    // the Create | Join switcher is hidden: Home's two buttons decide which single form is shown
    const title = $("lobby-title");
    if (title) title.textContent = name === "join" ? "Join room" : "Create room";
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
    btnBusy(btn, true);
    try {
        const n = await Coins.importData(JSON.parse(await f.text()), (done, total) => { btn.lastChild.textContent = "Importing " + done + "/" + total; });
        showNotification("Imported " + n + " documents", "success");
        autoRepairTimes(true);
    } catch (err) { showNotification(err.message || "Import failed", "error"); }
    btn.lastChild.textContent = "Import data";
    btnBusy(btn, false);
};
$("admin-backup-export").onclick = async () => {
    const btn = $("admin-backup-export");
    btnBusy(btn, true);
    try {
        const data = await Coins.exportData((d, t) => { btn.lastChild.textContent = "Exporting " + d + "/" + t; });
        const json = JSON.stringify(data, function (k, v) { const raw = this[k]; return (raw && typeof raw.toDate === "function") ? { __ts: raw.toDate().toISOString() } : v; }, 2);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        a.download = "housie-users-coins-tasks-" + new Date().toISOString().slice(0, 10) + ".json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        showNotification("Exported " + data.users.length + " users, " + data.counts.ledgerEntries + " coin entries", "success");
    } catch (err) { showNotification(err.message || "Export failed", "error"); }
    btn.lastChild.textContent = "Export data";
    btnBusy(btn, false);
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
// spinner + disabled on a button while its job runs (the spinner itself is drawn by CSS: button.is-busy::before)
function btnBusy(btn, on) {
    if (!btn) return;
    btn.classList.toggle("is-busy", !!on);
    btn.disabled = !!on;
}
$("delete-cancel").onclick = () => delPopup.classList.remove("active");
$("delete-confirm").onclick = async e => {
    const btn = e.currentTarget, cancel = $("delete-cancel");
    btn.disabled = cancel.disabled = true;
    btn.classList.add("is-busy");
    btn.textContent = "Deleting...";
    try {
        const delUid = Coins.user && Coins.user.uid;
        await Coins.deleteAccount();
        if (delUid) await Persist.purge(delUid);
        location.reload();
    } catch (err) {
        showNotification(err.message || "Could not delete the account.", "error");
        btn.disabled = cancel.disabled = false;
        btn.classList.remove("is-busy");
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
        if (Coins.endMyStaleRooms) Coins.endMyStaleRooms(info && info.gameId).catch(() => { });   // rooms I hosted and left behind
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
        if (window.FX) { FX.play("coin"); FX.coinsAdded(amount, btn || null); }
        showNotification(`${label}: +${Number(amount).toLocaleString("en-US")} coins`, "success");
        if (REWARD_CARD_TYPES.has(type)) showRewardCard(type, amount, label, extra).catch(e => console.warn("[wincard]", e));
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
    lockLobbyName();
    updateCost();
}
// Name box (Create + Join): locked until the pencil "Edit" button is pressed, like in Profile.
function lockLobbyName() {
    const n = $("username");
    n.readOnly = !!n.value.trim();   // an empty name stays editable so it can be typed
}
$("username-edit").onclick = () => {
    const n = $("username");
    n.readOnly = false;
    n.focus();
    n.setSelectionRange(n.value.length, n.value.length);
};
$("username").addEventListener("blur", lockLobbyName);
$("username").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
function setTickets(n) {
    $("ticket-count").value = Math.min(4, Math.max(1, n));
    updateCost();
}
$("tk-minus").onclick = () => setTickets(Number($("ticket-count").value) - 1);
$("tk-plus").onclick = () => setTickets(Number($("ticket-count").value) + 1);
// price starts empty (the host must enter it); no leading zeros no leading zeros ("025" -> "25")
$("ticket-price").addEventListener("focus", e => { const el = e.target; setTimeout(() => { try { el.select(); } catch (x) { } }, 0); });
$("ticket-price").addEventListener("input", e => {
    const el = e.target, clean = el.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
    if (el.value !== clean) el.value = clean;
});
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
    let oppTicketsData, devTicketsData;
    ensureFavoritesLoaded().then(() => {
        oppTicketsData = generateMyTickets(devWantedTickets);
        devTicketsData = generateTambolaSet(devWantedTickets);
        return withTimeout(Coins.devStartGame(devUid, Coins.user.uid, devStake, devWantedTickets, oppName, devName, oppTicketsData, devTicketsData),
            15000, "Could not start the game. Check your network and try again.");
    })
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
let wheelTimer = null, wheelReadyAt = 0;
function stopWheelCountdown() {
    if (wheelTimer) { clearInterval(wheelTimer); wheelTimer = null; }
}
function startWheelCountdown() {
    stopWheelCountdown();
    const tick = () => {
        const left = Math.max(0, Math.ceil((wheelReadyAt - Date.now()) / 1000));
        if (left <= 0) {
            stopWheelCountdown();
            if (currentView === "earn") renderEarn();
            return;
        }
        $("wheel-text").textContent = `Next spin in ${fmtLeft(left, false)}`;
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

        const wait = wheelWait(L);
        wheelReadyAt = Date.now() + wait;
        const spun = wait > 0;
        $("btn-spin").disabled = spun;
        $("btn-spin").innerHTML = spun ? '<span class="tick">✓</span>Spinned' : "Spin";
        if (spun) startWheelCountdown();
        else { stopWheelCountdown(); $("wheel-text").textContent = "Spin every hour. Win 1,000 to 10,000 coins, plus a 25,000 jackpot once a day."; }

        ["daily", "weekly", "monthly", "once"].forEach(kind => {
            // ready to claim first, then in progress, then already claimed
            const views = TASKS[kind].map((t, i) => ({ t, i, v: taskView(kind, t, c) }));
            const rank = x => (x.v.claimed ? 2 : x.v.done ? 0 : 1);
            views.sort((x, y) => rank(x) - rank(y) || x.i - y.i);
            $("tasks-" + kind).innerHTML = views.map(({ t, v }, n) => {
                const state = v.claimed ? "done" : v.done ? "ready" : "";
                const side = v.claimed ? '<small class="task-count">✓ Claimed</small>'
                    : v.done ? `<button class="btn-primary btn-sm" data-task="${kind}:${t.id}">Claim</button>`
                        : `<small class="task-count">${v.progress}/${t.target}</small>`;
                return `<div class="task-row ${state}">
                    <span class="task-no">${n + 1}</span>
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
$("btn-spin").onclick = async e => {
    const btn = e.currentTarget;
    let L;
    try { L = await getLedger(); } catch (err) { return; }
    if (wheelWait(L) > 0) { renderEarn(); return; }   // already spun (other device / tab): show the countdown instead
    const pick = wheelPick(L);
    if (!window.FX) { reward(btn, "wheel_" + wheelSlot(), "wheel", WHEEL_VALUES[pick], "Try your luck"); return; }
    // the wheel is told which slice to land on (the rules above decide it); the coins are paid once it stops
    const res = await FX.spinWheel(WHEEL_VALUES, pick);
    if (!res) return;   // closed without spinning
    reward(btn, "wheel_" + wheelSlot(), "wheel", res.value, "Try your luck");
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
    // "Joined on 12 Mar 2026": the date the account was created
    const created = u.metadata && Date.parse(u.metadata.creationTime);
    $("profile-joined").textContent = created ? "Joined on " + new Date(created).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
    $("profile-joined").classList.toggle("hidden", !created);
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
    nbMark("name");
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
    nbMark("theme");
    store.set("randomTheme", false); // picking a colour switches random mode off
    applyTheme(c.dataset.theme);
});
$("theme-random").addEventListener("change", e => {
    store.set("randomTheme", e.target.checked);
    if (e.target.checked) nbMark("random");
    applyTheme(store.get("theme", "indigo"));
});
/* ================= FAVORITE NUMBERS (Profile) ================= */
let favDraft = [], favEditing = false, favSaving = false;
const FAV_PRICE = 50;   // every favorite number you ADD or CHANGE costs 50 coins. No free numbers, no number limit at all. Removing a number is free.
const favSaved = () => ((window.Coins && Coins.favorites) || []).map(Number);
const favNewCount = list => list.filter(n => !favSaved().includes(n)).length;   // numbers not saved before = numbers to pay for
function refreshFavPaid() { paintFav(); return Promise.resolve(); }
const favPad = n => String(n).padStart(2, "0");
const favCol = n => Math.min(8, Math.floor(n / 10));
const favColName = c => (c === 0 ? "1-9" : c === 8 ? "80-90" : c * 10 + "-" + (c * 10 + 9));
function paintFav() {
    if (!$("fav-card")) return;
    const saved = ((window.Coins && Coins.favorites) || []).slice();   // order added: newest last
    const has = saved.length > 0;
    $("fav-view").classList.toggle("hidden", favEditing);
    $("fav-editor").classList.toggle("hidden", !favEditing);
    if (!favEditing) {
        let fv = $("fav-fit-view");
        if (!fv) { fv = document.createElement("p"); fv.id = "fav-fit-view"; fv.className = "fav-note hidden"; $("fav-note").after(fv); }
        const needSaved = favTicketsNeeded(saved);
        fv.classList.toggle("hidden", !has || needSaved === null || needSaved <= 1);
        fv.textContent = needSaved > 1 ? `Your numbers need ${needSaved} tickets to all appear. With fewer tickets, some of them will be left out (a ticket holds at most 3 numbers from the same range).` : "";
        $("fav-chips").innerHTML = has ? saved.map(n => `<span class="fav-chip">${favPad(n)}</span>`).join("") : "";
        $("fav-count").textContent = saved.length + "/" + FAV_MAX + " Selected";
        $("fav-empty").classList.toggle("hidden", has);
        $("fav-note").classList.toggle("hidden", !has);
        $("fav-choose").classList.toggle("hidden", has);
        $("fav-edit").classList.toggle("hidden", !has);
        return;
    }
    document.querySelectorAll("#fav-grid .fav-num").forEach(b => b.classList.toggle("sel", favDraft.includes(Number(b.dataset.n))));
    const extra = favNewCount(favDraft), cost = extra * FAV_PRICE;
    $("fav-live").textContent = favDraft.length + "/" + FAV_MAX + " Selected";
    $("fav-done").classList.toggle("hidden", favDraft.length !== FAV_MAX);
    $("fav-cost").classList.toggle("hidden", !extra);
    $("fav-cost").textContent = extra ? `${extra} new number${extra > 1 ? "s" : ""}: 🪙 ${cost} will be deducted when you save.` : "";
    let fit = $("fav-fit");
    if (!fit) { fit = document.createElement("p"); fit.id = "fav-fit"; fit.className = "fav-note hidden"; $("fav-cost").after(fit); }
    const need = favTicketsNeeded(favDraft);
    fit.classList.toggle("hidden", !favDraft.length || need === null || need <= 1);
    fit.textContent = need > 1 ? `Your numbers need ${need} tickets to all appear. With fewer tickets, some of them will be left out (a ticket holds at most 3 numbers from the same range).` : "";
    if (favSaving) return;           // keep the spinner on the Save button while it is saving
    $("fav-save").textContent = extra ? `Save (-🪙 ${cost})` : "Save";
    $("fav-save").disabled = false;   // saving an empty list removes all favorite numbers
    $("fav-clear").disabled = favDraft.length < 1;
}
function favBusy(on) {
    favSaving = on;
    const b = $("fav-save");
    b.classList.toggle("loading", on);
    b.disabled = on;
    $("fav-clear").disabled = on;
    if (on) b.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Saving…</span>';
}
function favOpen(list) { favDraft = list.slice(); favEditing = true; paintFav(); refreshFavPaid(); }
(function initFav() {
    const grid = $("fav-grid");
    if (!grid) return;
    grid.innerHTML = Array.from({ length: 90 }, (_, i) => `<button type="button" class="fav-num" data-n="${i + 1}">${i + 1}</button>`).join("");
    grid.addEventListener("click", e => {
        const b = e.target.closest(".fav-num"); if (!b) return;
        const n = Number(b.dataset.n);
        if (favDraft.includes(n)) favDraft = favDraft.filter(x => x !== n);
        else if (!favSaved().includes(n) && Coins.balance !== null && Coins.balance < (favNewCount(favDraft) + 1) * FAV_PRICE) { showNotification(`Not enough coins: each new number costs 🪙 ${FAV_PRICE}`, "error"); return; }
        else if (favTicketsNeeded(favDraft.concat(n)) === null) {
            const c = favCol(n);
            showNotification(`${n} won't fit on your tickets: one ticket holds only 3 numbers from ${favColName(c)}, and the numbers you picked already fill up to 4 tickets.`, "error");
            return;
        }
        else favDraft.push(n);
        paintFav();
    });
    $("fav-edit").onclick = () => favOpen((Coins.favorites || []).slice());
    $("fav-choose").onclick = () => favOpen([]);
    $("fav-clear").onclick = () => { favDraft = []; paintFav(); };
    $("fav-save").onclick = async () => {
        if (favDraft.length > FAV_MAX || new Set(favDraft).size !== favDraft.length) return;
        const btn = $("fav-save");
        btn.disabled = true;
        try {
            const removedAll = favDraft.length === 0;
            const added = favDraft.filter(n => !favSaved().includes(n));   // new / changed numbers
            if (added.length) {
                const cost = added.length * FAV_PRICE;
                if (Coins.balance !== null && Coins.balance < cost) throw new Error(`You need 🪙 ${cost} for ${added.length} new number${added.length > 1 ? "s" : ""}.`);
                const ok = await askConfirm("Save favorite numbers?", `${added.length} new number${added.length > 1 ? "s" : ""} will cost 🪙 ${cost} (🪙 ${FAV_PRICE} each). Adding or changing a number always costs 🪙 ${FAV_PRICE}; removing is free.`, "Pay 🪙 " + cost);
                if (!ok) { paintFav(); return; }
                favBusy(true);
                // 1) preferred: one atomic transaction (exact price, coins + list saved together, nothing half-done)
                try {
                    await Coins.buyFavorites(favDraft, FAV_PRICE, cost);
                    favEditing = false; favDraft = [];
                    showNotification(`Favorite numbers saved. 🪙 ${cost} deducted`, "success");
                    favBusy(false); paintFav();
                    return;
                } catch (e) {
                    if (e && (e.app || e.denied)) throw e;          // a clear answer (not enough coins / list changed / refused): show it, do not retry number by number
                    console.warn("[fav] atomic save not accepted, paying number by number", e && (e.raw || e));
                    // the write may have landed although the answer was lost: never charge twice
                    const srv = await Coins.serverFavorites();
                    if (srv && favDraft.every(n => srv.includes(n))) {
                        Coins.favorites = srv.slice();
                        favEditing = false; favDraft = [];
                        showNotification("Favorite numbers saved", "success");
                        favBusy(false); paintFav();
                        return;
                    }
                    if (srv) { const left = favDraft.filter(n => !srv.includes(n)); added.length = 0; left.forEach(n => added.push(n)); }
                }
                // 2) fallback: one atomic purchase per number (each adds exactly one number and charges exactly FAV_PRICE)
                const paid = [];
                let payErr = null;
                let base = (await Coins.serverFavorites()) || favSaved().slice();
                for (const n of added) {
                    let ok = false;
                    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
                        try {
                            await Coins.buyFavorites(base.concat([n]), FAV_PRICE, FAV_PRICE);
                            ok = true;
                        } catch (e) {
                            if (e && e.denied) { payErr = e; break; }      // refused by the server: stop, nothing was charged
                            await new Promise(r => setTimeout(r, 800));
                            const srv = await Coins.serverFavorites();   // the write may have landed although the answer was lost: never charge twice
                            if (srv && srv.includes(n)) { ok = true; base = srv; break; }
                            if (attempt === 1) payErr = e;
                        }
                    }
                    if (!ok) break;
                    if (!base.includes(n)) base.push(n);
                    paid.push(n);
                }
                if (payErr) {
                    // never take coins for numbers that are then not saved: keep everything that was paid for
                    const keep = favDraft.filter(n => favSaved().includes(n) || paid.includes(n));
                    if (paid.length) { favBusy(true); try { await Coins.saveFavorites(keep); } catch (e) { } }
                    favEditing = false; favDraft = [];
                    throw new Error(paid.length
                        ? `Saved ${paid.length} of ${added.length} new numbers (🪙 ${paid.length * FAV_PRICE} charged). ${payErr.message}`
                        : payErr.message);
                }
            }
            favBusy(true);
            await Coins.saveFavorites(favDraft);   // removing numbers never costs anything
            favEditing = false; favDraft = [];
            showNotification(removedAll ? "All favorite numbers removed" : "Favorite numbers saved", "success");
        } catch (err) { showNotification(err.message || "Could not save", "error"); }
        favBusy(false);
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
        try { await Coins.resolveNames(L); } catch (e) { }
        const taskTypes = ["task", "daily", "wheel", "refill", "bonus", "invite"];
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

/* ================= TRANSACTIONS (PhonePe / UPI style) ================= */
// Every coin movement from the local copy of the coin history (zero Firestore reads): search, filters, month groups,
// a detail sheet with the transaction ID + balance after, a shareable receipt and a CSV statement.
let txRange = "all", txQuery = "", txShown = [];
const TX_CAT = e => ({
    send: "sent", gift: "received", win: "win", entry: "game", deventry: "game", refund: "refund", devrefund: "refund",
    task: "reward", daily: "reward", wheel: "reward", refill: "reward", bonus: "reward", invite: "reward"
}[e.type] || "other");
const TX_ICON = { win: "🏆", game: "🎟️", refund: "↩️", reward: "🎁", other: "🪙" };
const TX_TYPE = { sent: "Sent to friend", received: "Received from friend", win: "Prize won", game: "Game entry fee", refund: "Refund", reward: "Reward", other: "Other" };
let txNames = null;   // uid -> name, taken from the leaderboard (top 100) for older transfers that did not save a name
async function txLoadNames() {
    if (txNames) return;
    txNames = new Map();
    try {
        (lbCache || friendsCache || []).forEach(u => { if (u && u.id && u.name) txNames.set(u.id, u.name); });
        const qs = await Coins.richest(100);
        qs.docs.forEach(d => { const nm = d.data().alias || d.data().name; if (nm) txNames.set(d.id, nm); });
    } catch (err) { /* names are cosmetic: fall back to the code */ }
}
const txPerson = e => e.type === "send" ? (e.toName || (txNames && txNames.get(e.to)) || Coins.nameOf(e.to) || "Code " + (e.toCode || "----")) : (e.fromName || "A friend");
const txId = e => (e.type === "gift" && e.ref) ? e.ref : String(e.id || "");
const txHue = str => { let n = 0; for (const ch of String(str)) n = (n * 31 + ch.charCodeAt(0)) % 360; return n; };
function txAvatar(e, n) {
    const cat = TX_CAT(e);
    if (cat === "sent" || cat === "received" || Number(e.amount) < 0) {
        const nm = cat === "sent" || cat === "received" ? txPerson(e) : String(e.type || "x"), num = String(n || 1);      // the circle shows the transaction's number: 1, 2, 3 ...
        const small = "font-size:" + (num.length > 3 ? 12 : num.length > 2 ? 14 : 17) + "px;";
        return `<span class="tx-ico person${Number(e.amount) < 0 ? " blink" : ""}" style="${small}background:hsl(${txHue(nm)} 55% 38%)">${esc(num)}</span>`;
    }
    return `<span class="tx-ico">${TX_ICON[cat]}</span>`;
}
function txBalances(L) {
    // balance after each entry, walking back from the current balance (newest first)
    const map = new Map();
    let run = typeof Coins.balance === "number" ? Coins.balance : null;
    if (run === null) return map;
    [...L].sort((a, b) => timeOf(b) - timeOf(a)).forEach(e => { map.set(e, run); run -= Number(e.amount) || 0; });
    return map;
}
async function renderTransactions() {
    const list = $("tx-list");
    try {
        if (window.Coins && Coins.syncLedger) Coins.syncLedger();
        await txLoadNames();
        try { await Coins.resolveNames(await Coins.localLedger()); } catch (e) { }
        const todayKey = dayKey(new Date());
        // only today's "Share 100+ coins to 3 friends" task: the 100+ coin transfers to friends and the task reward
        const all = (await Coins.localLedger()).filter(e => dayKey(timeOf(e)) === todayKey && Number(e.amount) !== 0 &&
            ((e.type === "send" && -e.amount >= 100) || (e.type === "task" && /share3_v4$/.test(String(e.id || "")))));
        const bal = txBalances(all);
        const now = new Date(), today = dayKey(now), week = weekKey(now), month = monthKey(now);
        const inRange = e => { const t = timeOf(e); return txRange === "all" || (txRange === "day" && dayKey(t) === today) || (txRange === "week" && weekKey(t) === week) || (txRange === "month" && monthKey(t) === month); };
        const q = txQuery.trim().toLowerCase();
        const match = e => {
            if (!q) return true;
            return [Coins.describe(e), txId(e), TX_TYPE[TX_CAT(e)], txPerson(e), String(Math.abs(e.amount)), e.toCode || "", e.gameId ? roomLabel(e.gameId) : ""].join(" ").toLowerCase().includes(q);
        };
        const rows = all.filter(inRange).filter(match).sort((a, b) => timeOf(b) - timeOf(a));
        txShown = rows.map(e => ({ e, bal: bal.get(e) }));

        const cin = rows.filter(e => e.amount > 0).reduce((n, e) => n + e.amount, 0);
        const cout = rows.filter(e => e.amount < 0).reduce((n, e) => n - e.amount, 0);
        $("tx-balance").textContent = typeof Coins.balance === "number" ? Coins.balance.toLocaleString() : "--";
        $("tx-in").textContent = "+" + cin.toLocaleString();
        $("tx-out").textContent = "-" + cout.toLocaleString();
        $("tx-count").textContent = rows.length;
        $("tx-bar-in").style.width = (cin + cout ? Math.round(cin / (cin + cout) * 100) : 0) + "%";

        let html = "", lastMonth = "";
        txShown.forEach(({ e, bal: b }, i) => {
            const d = timeOf(e), mk = monthKey(d);
            if (mk !== lastMonth) {
                lastMonth = mk;
                const inM = rows.filter(x => monthKey(timeOf(x)) === mk);
                const mi = inM.filter(x => x.amount > 0).reduce((n, x) => n + x.amount, 0), mo = inM.filter(x => x.amount < 0).reduce((n, x) => n - x.amount, 0);
                html += `<div class="tx-month"><b>${esc(d.toLocaleDateString([], { month: "long", year: "numeric" }))}</b><span><i class="pos">+${mi.toLocaleString()}</i> <i class="neg">-${mo.toLocaleString()}</i></span></div>`;
            }
            const pos = e.amount >= 0, cat = TX_CAT(e);
            const title = cat === "sent" ? "Paid to " + txPerson(e) : cat === "received" ? "Received from " + txPerson(e) : Coins.describe(e);
            const room = e.gameId ? " · " + esc(roomLabel(e.gameId)) : "";
            const when = d.toLocaleDateString([], { day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            html += `<button class="tx-row" data-i="${i}" type="button">${txAvatar(e, i + 1)}
                <span class="tx-mid"><b>${esc(title)}</b><small>${esc(when)}${room}</small></span>
                <span class="tx-amt"><b class="${pos ? "pos" : "neg"}">${pos ? "+" : "-"}🪙${Math.abs(e.amount).toLocaleString()}</b><small>${pos ? "Credited" : "Debited"}</small></span></button>`;
        });
        list.innerHTML = html;
    } catch (err) { list.innerHTML = '<p class="empty">Could not load transactions.</p>'; }
}
function txReceiptText(e, b) {
    const d = timeOf(e), cat = TX_CAT(e);
    const lines = ["Housie transaction", `${e.amount >= 0 ? "Credited" : "Debited"}: ${Math.abs(e.amount)} coins`, "Status: Successful",
        `${(cat === "sent" ? "To" : cat === "received" ? "From" : "Details")}: ${cat === "sent" || cat === "received" ? txPerson(e) : Coins.describe(e)}`,
        "Date: " + d.toLocaleString(), "Transaction ID: " + txId(e)];
    if (typeof b === "number") lines.push("Balance after: " + b);
    return lines.join("\n");
}
// the receipt is shared as an image card, drawn by the same renderer as the win / reward cards
async function txReceiptCard(e, b) {
    try {
        const cat = TX_CAT(e), d = timeOf(e), pos = e.amount >= 0;
        const look = {
            sent: { sub: "SENT TO FRIEND", title: "COINS SENT", icon: "💸", c1: "#f97316", c2: "#fb923c" },
            received: { sub: "FROM A FRIEND", title: "COINS RECEIVED!", icon: "🎁", c1: "#16a34a", c2: "#4ade80" },
            win: { sub: "PRIZE WON", title: "TRANSACTION", icon: "🏆", c1: "#d97706", c2: "#fbbf24" }
        }[cat] || { sub: String(TX_TYPE[cat] || "TRANSACTION").toUpperCase(), title: "TRANSACTION", icon: "🪙", c1: "#0ea5e9", c2: "#38bdf8" };
        const who = cat === "sent" || cat === "received" ? (cat === "sent" ? "To " : "From ") + txPerson(e) : Coins.describe(e);
        const name = myDisplayName();
        const spec = {
            sub: look.sub, title: look.title, name, initial: avatarLetter(name),
            amount: Math.abs(e.amount), amountText: (pos ? "+" : "-") + Math.abs(e.amount).toLocaleString(),
            amountLabel: pos ? "CREDITED" : "DEBITED", pill: "HOUSIE GAME",
            chipSuffix: cat === "sent" ? " paid" : cat === "received" ? " received" : "",
            noBadge: true, noWrap: true, titleTick: true,
            icon: look.icon, badgeColor1: look.c1, badgeColor2: look.c2,
            note: who + " · " + d.toLocaleDateString([], { day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        };
        const canvas = await renderWinCardCanvas(spec);
        const themed = await wcRandomTheme(canvas);
        return {
            id: "receipt_" + Date.now(), uid: Coins.user && Coins.user.uid, claim: "receipt", label: "Transaction", amount: Math.abs(e.amount), room: "Transaction",
            time: Date.now(), dataUrl: themed.dataUrl, thumb: themed.thumb, v: 2, shareTitle: "Housie transaction", shareText: txReceiptText(e, b)
        };
    } catch (err) { console.warn("[receipt card]", err); return null; }
}
function txOpenSheet(i) {
    const it = txShown[i]; if (!it) return;
    const { e, bal: b } = it, d = timeOf(e), cat = TX_CAT(e), pos = e.amount >= 0;
    let sh = $("tx-sheet");
    if (!sh) { sh = document.createElement("div"); sh.id = "tx-sheet"; sh.className = "tx-sheet"; document.body.appendChild(sh); }
    const row = (k, v) => v ? `<div class="tx-d"><span>${k}</span><b>${esc(v)}</b></div>` : "";
    sh.innerHTML = `<div class="tx-backdrop" data-close="1"></div>
        <div class="tx-panel" role="dialog" aria-label="Transaction details">
            <div class="tx-grab"></div>
            <div class="tx-top">${txAvatar(e, i + 1)}<b class="${pos ? "pos" : "neg"} tx-big">${pos ? "+" : "-"}🪙${Math.abs(e.amount).toLocaleString()}</b>
                <div class="tx-ok">✓ ${pos ? "Credited" : "Debited"} successfully</div>
                <small>${esc(d.toLocaleString([], { weekday: "short", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }))}</small></div>
            <div class="tx-details">
                ${row("Details", Coins.describe(e))}
                ${row("Type", TX_TYPE[cat])}
                ${cat === "sent" ? row("Paid to", txPerson(e)) : ""}
                ${cat === "received" ? row("Received from", txPerson(e)) : ""}
                ${e.toCode ? row("Friend code", e.toCode) : ""}
                ${e.gameId ? row("Game", roomLabel(e.gameId)) : ""}
                ${e.prize ? row("Prize", (typeof PRIZE_NAMES !== "undefined" && PRIZE_NAMES[e.prize]) || e.prize) : ""}
                ${typeof b === "number" ? row("Balance after", "🪙 " + b.toLocaleString()) : ""}
                ${row("Status", "Successful")}
                <div class="tx-d"><span>Transaction ID</span><b class="tx-idv">${esc(txId(e))}</b></div>
            </div>
            <div class="tx-actions">
                <button class="tx-btn tx-share" type="button" data-act="share">Share transaction</button>
            </div>
        </div>`;
    sh.classList.add("open");
    sh.onclick = async ev => {
        if (ev.target.closest("[data-close]")) { sh.classList.remove("open"); return; }
        const act = ev.target.closest("[data-act]"); if (!act) return;
        {
            act.disabled = true;
            try {
                const card = await txReceiptCard(e, b);
                if (card) {
                    // same preview as every other card: image, themes, Share / Copy / Download
                    sh.classList.remove("open");
                    openWinCardPopup(card);
                    $("wincard-popup").style.zIndex = "7300";   // above the transaction sheet layer
                } else {
                    const text = txReceiptText(e, b);
                    if (navigator.share) await navigator.share({ title: "Housie transaction", text });
                    else { await navigator.clipboard.writeText(text); showNotification("Receipt copied", "success"); }
                }
            } catch (x) { if (!x || x.name !== "AbortError") showNotification("Could not share", "error"); }
            act.disabled = false;
        }
    };
}
document.addEventListener("keydown", e => { if (e.key === "Escape") { const sh = $("tx-sheet"); if (sh) sh.classList.remove("open"); } });
$("tx-list").addEventListener("click", e => { const r = e.target.closest(".tx-row"); if (r) txOpenSheet(Number(r.dataset.i)); });
$("tx-search").addEventListener("input", e => { txQuery = e.target.value; renderTransactions(); });

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
// "See your friends' codes": name, 4-digit code and coins of the richest 100 players. Players who never opened Share Coins have no
// code yet, so they are left out. Cached for 10 minutes so re-opening costs no extra reads.
let friendsCache = null, friendsAt = 0;
async function loadFriends(force) {
    const list = $("friends-list");
    if (!force && friendsCache && Date.now() - friendsAt < 10 * 60 * 1000) { paintFriends(); return; }
    list.innerHTML = '<p class="empty">Loading...</p>';
    try {
        const qs = await Coins.richest(100);
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
    try { await navigator.clipboard.writeText(c); nbMark("code"); showNotification("Code copied", "success"); }
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

/* ================= INVITE FRIENDS (Profile) ================= */
// My 6-digit invite code is made once (Coins.myInviteCode keeps it in the "codes" collection) and remembered in my settings.
const INVITE_URL = "https://myhousiegame.vercel.app/";
let myInvite = "", myInviteUid = "";
async function ensureInviteCode() {
    const uid = Coins.user && Coins.user.uid; if (!uid) throw new Error("Sign in first");
    if (myInvite && myInviteUid === uid) return myInvite;
    const cached = store.get("inviteCode", "");
    if (/^[0-9]{6}$/.test(cached)) { myInviteUid = uid; return (myInvite = cached); }
    const code = await Coins.myInviteCode();
    store.set("inviteCode", code);
    myInviteUid = uid;
    return (myInvite = code);
}
function paintInviteCode(code) {
    $("invite-code").innerHTML = String(code).split("").map(ch => `<i>${esc(ch)}</i>`).join("");   // one tile per digit
}
async function renderInvite() {
    if (!Coins.user) return;
    paintInviteCode(myInvite && myInviteUid === Coins.user.uid ? myInvite : "------");
    try { paintInviteCode(await ensureInviteCode()); }
    catch (e) { showNotification(e.message || "Could not load your invite code", "error"); }
    renderInvitees();
    renderWelcomeTasks();
}
let inviteCopiedTimer = null;
$("invite-code-copy").onclick = async e => {
    const btn = e.currentTarget, label = btn.querySelector("span");
    try {
        await navigator.clipboard.writeText(await ensureInviteCode());
        nbMark("code");
        label.textContent = "Code copied ✓";
        btn.classList.add("copied");
        showNotification("Code copied", "success");
        clearTimeout(inviteCopiedTimer);
        inviteCopiedTimer = setTimeout(() => { label.textContent = "Copy code"; btn.classList.remove("copied"); }, 2000);
    } catch (err) { showNotification("Could not copy the code", "error"); }
};
let inviteLinkTimer = null;
$("invite-copy").onclick = async e => {
    const btn = e.currentTarget, label = btn.querySelector("span");
    try {
        await navigator.clipboard.writeText(INVITE_URL);
        label.textContent = "Website link copied ✓";
        btn.classList.add("copied");
        showNotification("Website link copied", "success");
        clearTimeout(inviteLinkTimer);
        inviteLinkTimer = setTimeout(() => { label.textContent = "Copy website link"; btn.classList.remove("copied"); }, 2000);
    } catch (err) { showNotification("Could not copy the link", "error"); }
};

// Friend invite reward: 50,000 coins per friend who joined with MY code, paid once each (ledger id task_once_<friendUid>_invfriend).
// A reward unlocks only when that friend has completed all their welcome tasks (their account shows nwDone = NW_TOTAL; firestore.rules check it too).
// One Claim button collects every unlocked reward; the list shows who joined, when, and each friend's welcome-task progress.
const INVITER_REWARD = 50000;
let invPending = [];
var invLive = null, invUnsub = null;   // live list of invited friends (only while the Invite friends screen is open)
function startInviteWatch() {
    if (invUnsub || !window.Coins || !Coins.user || !Coins.watchInvitees) return;
    invUnsub = Coins.watchInvitees(list => { invLive = list; if (currentView === "invite" && !invClaiming) renderInvitees(); }, () => { });
}
function stopInviteWatch() { if (invUnsub) { try { invUnsub(); } catch (e) { } invUnsub = null; } invLive = null; }
const fmtDay = v => { const d = toDateAny(v); return d ? d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "Earlier"; };
async function renderInvitees() {
    const sec = $("invfriends-section");
    let list = [], claimed = new Set();
    try {
        list = invLive || await Coins.myInvitees();
        claimed = new Set((await getLedger()).filter(e => e.type === "task").map(e => e.id));
    } catch (e) { list = []; }
    const views = list.map(f => {
        const done = claimed.has(`task_once_${f.uid}_invfriend`), nw = Math.min(f.nw, NW_TOTAL);
        return { f, nw, done, ready: !done && nw >= NW_TOTAL, ms: (toDateAny(f.at) || 0) * 1 };
    });
    const rank = x => (x.ready ? 0 : x.done ? 2 : 1);   // unlocked first, then in progress, then claimed
    views.sort((x, y) => rank(x) - rank(y) || y.ms - x.ms);
    invPending = views.filter(x => x.ready).map(x => x.f);
    const waiting = views.filter(x => !x.done && !x.ready).length;
    const waitTxt = `${waiting} friend${waiting > 1 ? "s are" : " is"} still completing welcome tasks`;
    $("invfriends-hint").textContent = waiting ? (invPending.length ? `${invPending.length} ready to claim · ${waitTxt}` : waitTxt) : (invPending.length ? "Ready to claim" : "All rewards claimed");   // the count and the coins below follow the number of invited friends
    $("invfriends-claim").disabled = !invPending.length;
    $("invfriends-claim").textContent = invPending.length || !waiting ? (invPending.length ? "Claim" : "Claimed") : "Locked";
    $("invfriends-count").textContent = `${views.filter(x => x.done).length}/${views.length} claimed`;
    $("invfriends-list").innerHTML = views.map(({ f, nw, done, ready }, n) => `<div class="inv-person ${done ? "done" : ready ? "ready" : ""}">
        <span class="task-no">${n + 1}</span>
        <div class="inv-person-info"><b>${esc(f.name)}</b><small>Joined ${esc(fmtDay(f.at))} · ${nw}/${NW_TOTAL} tasks done</small>
            <div class="progress"><span style="width:${Math.round(nw / NW_TOTAL * 100)}%"></span></div></div>
        <span class="inv-person-state">${done ? "✓ Claimed" : ready ? "🪙 " + INVITER_REWARD.toLocaleString("en-US") : "🔒 Locked"}</span></div>`).join("");
    sec.classList.toggle("hidden", !views.length);
}
let invClaiming = false;
$("invfriends-claim").onclick = async e => {
    if (invClaiming || !invPending.length) return;
    invClaiming = true;
    const btn = e.currentTarget, todo = invPending.slice();
    claimingOn(btn); btn.disabled = true;
    let got = 0, failed = null;
    for (const f of todo) {
        try {
            await Coins.grant(`task_once_${f.uid}_invfriend`, "task", INVITER_REWARD, { task: "invfriend", from: f.uid, note: `${f.name} completed all welcome tasks` });
            got += INVITER_REWARD;
        } catch (err) { if (!(err && err.message === "Already claimed.")) { failed = err; break; } }
    }
    claimingOff(btn);
    if (got) {
        if (window.FX) { FX.play("coin"); FX.coinsAdded(got, btn); }
        showNotification(`Friend invite reward: +${got.toLocaleString("en-US")} coins`, "success");
    }
    if (failed) showNotification(failed.message || "Could not claim.", "error");
    invClaiming = false;
    renderInvitees();
    updateTaskBadge();
};

// Welcome tasks (new joiners only, first NEWBIE_DAYS days): shown inside Invite friends
async function renderWelcomeTasks() {
    const nb = newbieActive();
    $("newbie-section").classList.toggle("hidden", !nb);
    if (!nb) return;
    try {
        const c = taskContext(await getLedger());
        syncNwProgress(c);
        const views = TASKS.newbie.filter(t => !t.invOnly || c.invBy).map((t, i) => ({ t, i, v: taskView("newbie", t, c) }));
        const rank = x => (x.v.claimed ? 2 : x.v.done ? 0 : 1);
        views.sort((x, y) => rank(x) - rank(y) || x.i - y.i);
        $("newbie-count").textContent = `${views.filter(x => x.v.claimed).length}/${views.length} claimed`;
        $("tasks-newbie").innerHTML = views.map(({ t, i, v }) => {
            const state = v.claimed ? "done" : v.done ? "ready" : "";
            const side = v.claimed ? '<small class="task-count">✓ Claimed</small>'
                : v.done ? `<button class="btn-primary btn-sm" data-task="newbie:${t.id}">Claim</button>`
                    : `<small class="task-count">${v.progress}/${t.target}</small>`;
            return `<div class="task-row ${state}">
                <span class="task-no">${i + 1}</span>
                <div class="task-info"><b>${esc(t.title)}</b>
                    <div class="progress"><span style="width:${v.pct}%"></span></div></div>
                <div class="task-side"><span class="reward">🪙 ${t.reward.toLocaleString("en-US")}</span>${side}</div></div>`;
        }).join("");
    } catch (e) { }
}
$("tasks-newbie").addEventListener("click", e => {
    const b = e.target.closest("[data-task]"); if (!b) return;
    const id = b.dataset.task.split(":")[1];
    const t = TASKS.newbie.find(x => x.id === id); if (!t) return;
    reward(b, `task_${periodOf("newbie")}_${id}`, "task", t.reward, t.title, { task: id });
});

// New account: "Do you have an invite?" Yes / No. Yes -> enter the 6-digit code -> shows who invited you.
let inviteAskShown = false;
function inviteStep(step) {
    ["q", "code", "done"].forEach(k => $("ia-" + k).classList.toggle("hidden", k !== step));
    if (step === "code") { $("ia-err").textContent = ""; $("ia-input").value = ""; setTimeout(() => $("ia-input").focus(), 50); }
}
function maybeAskInvite() {
    if (inviteAskShown || !Coins.user) return;
    if (store.get("inviteAsked", false) || !newbieActive()) return;   // asked once, and only for new accounts
    inviteAskShown = true;
    setTimeout(() => { if (!Coins.user) return; inviteStep("q"); $("invite-ask-popup").classList.add("active"); }, 700);
}
const closeInviteAsk = () => { store.set("inviteAsked", true); $("invite-ask-popup").classList.remove("active"); };
$("ia-no").onclick = closeInviteAsk;
$("ia-yes").onclick = () => inviteStep("code");
$("ia-back").onclick = () => inviteStep("q");
$("ia-input").addEventListener("input", e => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); $("ia-err").textContent = ""; });
$("ia-input").addEventListener("keydown", e => { if (e.key === "Enter") $("ia-verify").click(); });
$("ia-verify").onclick = async e => {
    const btn = e.currentTarget, code = $("ia-input").value.trim();
    if (!/^[0-9]{6}$/.test(code)) { $("ia-err").textContent = "Enter the 6-digit invite code."; return; }
    btn.disabled = true; $("ia-err").textContent = "";
    try {
        const f = await Coins.findInvite(code);
        await Coins.payInviter(f.uid);
        store.set("invitedBy", { uid: f.uid, name: f.name, code: f.code });
        store.set("inviteAsked", true);
        $("ia-name").textContent = f.name;
        inviteStep("done");
        updateTaskBadge();
    } catch (err) { $("ia-err").textContent = err.message || "Could not verify the code."; }
    btn.disabled = false;
};
$("ia-ok").onclick = () => { $("invite-ask-popup").classList.remove("active"); if (currentView === "invite") renderInvite(); };

/* ================= LEADERBOARD ================= */
let lbCache = null, lbAt = 0;
async function renderLeaderboard() {
    const list = $("lb-list");
    list.innerHTML = '<p class="empty">Loading...</p>';
    try {
        // the top 100 players are kept for 15 minutes, so opening the screen again costs no reads
        if (!lbCache || Date.now() - lbAt > 15 * 60 * 1000) {
            const qs = await Coins.richest(100);
            lbCache = qs.docs.map(d => ({ id: d.id, name: d.data().alias || d.data().name, own: d.data().name, alias: d.data().alias || "", coins: d.data().coins }));   // the admin's alias (if set) replaces the player's own name
            lbAt = Date.now();
        }
        list.innerHTML = lbCache.map((u, i) => {
            const me = Coins.user && u.id === Coins.user.uid;
            const edit = Coins.isAdmin() ? `<button type="button" class="icon-btn lb-edit" data-lb-edit="${esc(u.id)}" aria-label="Change name" title="Change name">✎</button>` : "";
            return `<div class="row"><div><b>${i + 1}. ${esc(u.name || "Player")}${me ? " (you)" : ""}</b>${u.alias && Coins.isAdmin() ? `<small>Original: ${esc(u.own || "Player")}</small>` : ""}</div><div class="lb-right"><b class="pos">🪙 ${u.coins}</b>${edit}</div></div>`;
        }).join("") || '<p class="empty">No players yet.</p>';
    } catch (e) { list.innerHTML = '<p class="empty">The leaderboard is not available yet.</p>'; }
}


// Admin only: change a player's name right from the leaderboard (same alias the admin dashboard edits)
let lbEditId = null;
$("lb-list").addEventListener("click", e => {
    const b = e.target.closest("[data-lb-edit]"); if (!b || !Coins.isAdmin()) return;
    const u = (lbCache || []).find(x => x.id === b.dataset.lbEdit); if (!u) return;
    lbEditId = u.id;
    $("lbn-title").textContent = u.own || u.name || "Player";
    $("lbn-input").value = u.alias || "";
    $("lb-name-popup").classList.add("active");
    setTimeout(() => $("lbn-input").focus(), 50);
});
$("lbn-close").onclick = () => $("lb-name-popup").classList.remove("active");
async function saveLbName(v, btn) {
    if (!lbEditId) return;
    btnBusy(btn, true);
    try {
        await Coins.adminSetAlias(lbEditId, v);
        $("lb-name-popup").classList.remove("active");
        lbCache = null; friendsCache = null;
        showNotification(v ? "Name saved" : "Name reset to the player's own", "success");
        renderLeaderboard();
        try { adminRefresh(); } catch (e) { }
    } catch (err) { showNotification(err.message || "Could not save the name", "error"); }
    btnBusy(btn, false);
}
$("lbn-save").onclick = e => saveLbName($("lbn-input").value.trim().slice(0, 30), e.currentTarget);
$("lbn-reset").onclick = e => saveLbName("", e.currentTarget);
$("lbn-input").addEventListener("keydown", e => { if (e.key === "Enter") $("lbn-save").click(); });

/* ================= SHARE (tasks, leaderboard, analytics) ================= */
// The phone's share sheet when there is one; otherwise the text is copied so it can be pasted anywhere.
async function shareText(title, text) {
    try {
        if (!navigator.share) throw new Error("no share sheet");
        await navigator.share({ title, text });
    } catch (e) {
        if (e && e.name === "AbortError") return;   // the share sheet was closed
        try {
            await navigator.clipboard.writeText(text);
            showNotification("Copied! Paste it anywhere to share.");
        } catch (e2) { showNotification("Sharing isn't supported here", "error"); }
    }
}
const shareNum = n => Number(n || 0).toLocaleString("en-US");

async function tasksShareText(kind) {
    const c = taskContext(await getLedger());
    const label = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" }[kind] || "";
    const views = TASKS[kind].map(t => taskView(kind, t, c));
    const earned = views.filter(v => v.claimed).reduce((a, v) => a + v.t.reward, 0);
    return [
        `🎯 My Housie ${label} tasks`, "",
        ...views.map(v => `${v.claimed ? "✅" : v.done ? "🎁" : "⬜"} ${v.t.title} (${v.progress}/${v.t.target})`), "",
        `Done: ${views.filter(v => v.done).length} of ${views.length} · 🪙 ${shareNum(earned)} claimed`,
        "Play Housie and beat me!"
    ].join("\n");
}
function leaderboardShareText() {
    const medal = ["🥇", "🥈", "🥉"], me = Coins.user && Coins.user.uid;
    const rows = lbCache.slice(0, 10).map((u, i) => `${medal[i] || (i + 1) + "."} ${u.name || "Player"} - 🪙 ${shareNum(u.coins)}`);
    const mine = lbCache.findIndex(u => u.id === me);
    return [
        "🏆 Housie Players", "", ...rows,
        ...(mine >= 10 ? ["", `My rank: #${mine + 1} - 🪙 ${shareNum(lbCache[mine].coins)}`] : []),
        "", "Can you reach the top? Play Housie!"
    ].join("\n");
}
async function statsShareText() {
    const L = await getLedger(), st = computeStats(L);
    const prizes = PRIZE_ORDER.map(k => `${CLAIM_SHORT[k]} ${st.winsList.filter(w => w.prize === k).length}`).join(" · ");
    return [
        "📊 My Housie stats", "",
        `🎮 Games played: ${st.games}`,
        `🏅 Wins: ${st.winGames} (${st.winRate}% win rate)`,
        `🏠 Rooms hosted: ${L.filter(e => e.type === "entry" && e.host).length}`,
        `🪙 Coins won from prizes: ${shareNum(st.coinsWon)}`,
        `🎯 Prizes: ${prizes}`,
        "", "Think you can beat me? Play Housie!"
    ].join("\n");
}

async function tasksShareSpec(kind) {
    const c = taskContext(await getLedger());
    const label = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" }[kind] || "";
    const views = TASKS[kind].map((t, i) => ({ t, i, v: taskView(kind, t, c) }));
    const rank = x => (x.v.claimed ? 2 : x.v.done ? 0 : 1);
    views.sort((x, y) => rank(x) - rank(y) || x.i - y.i);            // ready, in progress, claimed - same as the Tasks screen
    const earned = views.filter(x => x.v.claimed).reduce((a, x) => a + x.t.reward, 0);
    const name = myDisplayName();
    return {
        title: label.toUpperCase() + " TASKS PROGRESS", headAbove: true,
        rows: views.map(({ t, v }) => ({
            text: t.title, right: "🪙 " + shareNum(t.reward), pct: v.pct,
            sub: v.claimed ? "✓ Claimed" : v.done ? "🎁 Ready" : v.progress + "/" + t.target,
            hl: v.done && !v.claimed, dim: v.claimed
        })),
        summary: `Done ${views.filter(x => x.v.done).length}/${views.length} · 🪙 ${shareNum(earned)} claimed`,
        tagline: "Play Housie and beat me!"
    };
}
function leaderboardShareSpec() {
    const medal = ["🥇", "🥈", "🥉"], me = Coins.user && Coins.user.uid, name = myDisplayName();
    const mine = lbCache.findIndex(u => u.id === me);
    return {
        sub: "HOUSIE", title: "HOUSIE PLAYERS", chip: mine >= 0 ? `My rank #${mine + 1}` : "Top players", initial: avatarLetter(name),
        rows: lbCache.map((u, i) => ({ lead: medal[i] || String(i + 1), text: u.name || "Player", right: "🪙 " + shareNum(u.coins), hl: u.id === me })),
        summary: "",   // every player is listed, so "my rank" is already highlighted in the list
        tagline: "Can you reach the top?"
    };
}
async function statsShareSpec() {
    const L = await getLedger(), st = computeStats(L), name = myDisplayName();
    const rows = [
        { lead: "🎮", text: "Games played", right: String(st.games) },
        { lead: "🏅", text: "Wins", right: `${st.winGames} (${st.winRate}%)` },
        { lead: "🏠", text: "Rooms hosted", right: String(L.filter(e => e.type === "entry" && e.host).length) },
        { lead: "🪙", text: "Coins won from prizes", right: shareNum(st.coinsWon) },
        ...PRIZE_ORDER.map(k => ({ lead: "🎯", text: CLAIM_SHORT[k], right: String(st.winsList.filter(w => w.prize === k).length) }))
    ];
    return { title: "MY STATS", rows, summary: "", tagline: "Think you can beat me?" };
}
function favoritesShareText() {
    const favs = favSaved().filter(n => n >= 1 && n <= 90).sort((a, b) => a - b);
    return [
        "⭐ My Housie favorite numbers", "",
        favs.map(favPad).join(", "), "",
        `${favs.length} favorite number${favs.length === 1 ? "" : "s"}`,
        "Play Housie with me!"
    ].join("\n");
}
function favoritesShareSpec() {
    const favs = favSaved().filter(n => n >= 1 && n <= 90).sort((a, b) => a - b);
    return {
        title: "MY FAVORITE NUMBERS", headAbove: true, numbers: favs,
        summary: `${favs.length} favorite number${favs.length === 1 ? "" : "s"}`,
        tagline: "Play Housie with me!"
    };
}
document.addEventListener("click", async e => {
    const b = e.target.closest("[data-share]");
    if (!b || b.disabled) return;
    const [what, arg] = b.dataset.share.split(":");
    b.disabled = true;
    try {
        let title = "Housie", text = "", spec = null;
        if (what === "tasks") { title = "My Housie tasks"; text = await tasksShareText(arg); spec = await tasksShareSpec(arg); }
        else if (what === "leaderboard") {
            if (!lbCache || !lbCache.length) { showNotification("The leaderboard is still loading. Try again in a moment."); return; }
            title = "Housie leaderboard"; text = leaderboardShareText(); spec = leaderboardShareSpec();
        } else if (what === "stats") { title = "My Housie stats"; text = await statsShareText(); spec = await statsShareSpec(); }
        else if (what === "favorites") {
            if (!favSaved().length) { showNotification("Choose your favorite numbers first, then share them."); return; }
            title = "My Housie favorite numbers"; text = favoritesShareText(); spec = favoritesShareSpec();
        }
        else return;
        try { await openShareImage(what + (arg ? "_" + arg : ""), spec, title, text); }   // image card first, like the win cards
        catch (imgErr) { console.warn("[share] image failed, sharing text", imgErr); await shareText(title, text); }
    } catch (err) { showNotification("Could not share right now.", "error"); }
    finally { b.disabled = false; }
});

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
    nbMark("read");
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
// Updates disappear on their own 48 hours after their date (the date in data-upd-id, from 12:00 AM)
function removeExpiredUpdates() {
    document.querySelectorAll("#screen-updates .upd-item").forEach(item => {
        const m = /^upd-(\d{4})-(\d{2})-(\d{2})/.exec(item.dataset.updId || "");
        if (m && Date.now() - new Date(+m[1], m[2] - 1, +m[3]).getTime() >= 48 * 60 * 60 * 1000) item.remove();
    });
    document.querySelectorAll("#screen-updates .upd-date").forEach(head => {
        const list = head.nextElementSibling;
        if (list && list.classList.contains("upd-list") && !list.querySelector(".upd-item")) { list.remove(); head.remove(); }
    });
}
function refreshUpdateBadges() {
    removeExpiredUpdates();
    const read = updatesReadSet();
    const items = document.querySelectorAll("#screen-updates .upd-item");
    const unread = Array.from(items).filter(el => !read.has(el.dataset.updId)).length;
    document.querySelectorAll('#bottom-nav [data-open="profile"] .nav-badge, #screen-profile [data-open="updates"] .dot-new')
        .forEach(el => { el.textContent = unread ? String(unread) : ""; });
}
refreshUpdateBadges();

function renderUpdates() {
    removeExpiredUpdates();
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
        syncNwProgress(c);
        let ready = ["daily", "weekly", "monthly"].reduce((sum, kind) =>
            sum + TASKS[kind].filter(t => { const v = taskView(kind, t, c); return v.done && !v.claimed; }).length, 0);
        if (!bonusState(L).claimedToday) ready++;   // Daily bonus waiting
        if (wheelWait(L) <= 0) ready++;             // Try your luck spin available
        els.forEach(el => { el.textContent = ready ? String(ready) : ""; });
    } catch (e) { /* offline: leave the badge as it was */ }
}

setInterval(() => { if (!document.hidden) updateTaskBadge(); }, 30000);   // the spin (hourly) and the daily bonus (midnight) become ready by themselves

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
    const rows = [
        ["Total users", nf(all)], [partial ? `Coins held (richest ${n} of ${all})` : "Total users coins", "🪙 " + nf(total)]
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

const ADMIN_STALE_MS = 3 * 3600 * 1000;   // an unfinished room older than this is treated as abandoned
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
            refreshAdminCounts();   // keep Total games played in step with the room list
        }),
        timer: setInterval(() => {   // labels age (online -> offline) and the totals refresh
            adminRoomWatch.forEach((w, gid) => renderRoomDetail(gid));
        }, 30000),
        counts: setInterval(() => { if (!document.hidden) refreshAdminCounts(); }, 30000),
        // every minute, while a live room exists: re-read ONLY the live rooms and sweep (end abandoned / finished-by-Housie rooms,
        // clean finished ones). The full list is only polled every 5 min, so rooms that became stale in between were missed.
        sweep: setInterval(async () => {
            if (document.hidden || !adminGames.some(g => g.status !== "finished")) return;
            try {
                const live = await Coins.adminLiveGames();
                const fresh = new Map(live.map(g => [g.id, g]));
                const gone = adminGames.filter(g => !fresh.has(g.id)).map(g => g.status !== "finished" ? Object.assign({}, g, { status: "finished" }) : g);
                const ms = t => (t && t.toMillis ? t.toMillis() : 0);
                adminGames = [...fresh.values(), ...gone].sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
                adminPaintSoon("games");     // repaints and runs autoReleaseUsers -> autoSweepRooms
                if (gone.length) refreshAdminCounts();   // a room just finished: update Total games played
            } catch (e) { console.warn("[admin sweep]", e); }
        }, 60000)
    };
    refreshAdminCounts();
}
function stopAdminLive() {
    if (adminLive) {
        try { adminLive.users(); } catch (e) { }
        try { adminLive.games(); } catch (e) { }
        clearInterval(adminLive.timer); clearInterval(adminLive.counts); clearInterval(adminLive.sweep);
        adminLive = null;
    }
    if (adminPaintTimer) { clearTimeout(adminPaintTimer); adminPaintTimer = null; adminPaintWhat = {}; }
    closeAllRoomWatch();
    stopAdminTxWatch();
    if (adminLedgerUnsub) { try { adminLedgerUnsub(); } catch (e) { } adminLedgerUnsub = null; }
    adminLedgerSeq++;
    adminLoadedAt = 0;   // the next visit starts from the live feed again
}
const adminRefresh = async () => {
    if (!adminLive) return loadAdmin(true);
    // live mode only polls the room list every 5 minutes, so re-read it now or ended / deleted rooms stay on screen
    try { adminGames = await Coins.adminGames(); adminLoadedAt = Date.now(); paintAdminRooms(); }
    catch (e) { console.warn("[admin refresh]", e); }
    return refreshAdminCounts();
};

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
        const hostGone = hostSeen && Date.now() - hostSeen > 15 * 60 * 1000;      // no host heartbeat for 15 minutes
        const over = (g.claimsTaken && g.claimsTaken.housie && g.claimsTaken.housie.length) || (g.claimsLocked && g.claimsLocked.housie) || (g.calledNumbers || []).length >= 90;
        const quiet = !hostSeen || Date.now() - hostSeen > 60000;       // Housie won / all numbers drawn and nothing has happened for a minute
        if (g.status !== "finished" && (age > ADMIN_STALE_MS || hostGone || Number(g.playerCount) <= 0 || (over && quiet))) todo.push([g.id, "end"]);
        else if (g.status === "finished" && !g.archived) todo.push([g.id, "clean"]);
    });
    if (!todo.length) return;
    for (const [id, kind] of todo.slice(0, 20)) {
        adminSwept.add(id);   // only rooms handled in this pass are marked; the rest are picked up on the next load
        try { await (kind === "end" ? Coins.adminEndAndDelete(id) : Coins.adminCleanGame(id)); } catch (e) { adminSwept.delete(id); break; }
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
const TX_TYPES = { win: "Prize won", entry: "Room entry fee", bonus: "Welcome coins", daily: "Daily bonus", wheel: "Try your luck", refill: "Free refill", task: "Task reward", favbuy: "Favorite number bought", admin: "Admin adjustment", send: "Coins sent", gift: "Coins received", deventry: "Developer match entry", devrefund: "Developer match refund", refund: "Room refund", invite: "Invite bonus" };
function txRow(t, who) {
    const amt = Number(t.amount) || 0;
    const d = rowTime(t);
    const when = d ? d.toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--";
    const bits = [];
    bits.push("Type: " + esc(TX_TYPES[t.type] || t.type || "—"));
    if (t.type === "task") bits.push("Task: " + esc(Coins.taskLabel(t).replace(/^[^:]*:\s*/, "")) + " (" + esc((Coins.taskLabel(t).match(/^(Daily|Weekly|Monthly|Achievement)/) || ["One-time"])[0]) + ")");
    if (t.gameId) bits.push(esc(roomLabel(t.gameId)));
    if (t.prize) bits.push("Prize: " + esc((CLAIM_LABELS && CLAIM_LABELS[t.prize]) || t.prize));
    if (t.mode) bits.push("Mode: " + esc(t.mode));
    if (t.toName || t.toCode) bits.push("To: " + esc(t.toName || "") + (t.toCode ? " (code " + esc(t.toCode) + ")" : ""));
    if (t.fromName || t.fromCode) bits.push("From: " + esc(t.fromName || "") + (t.fromCode ? " (code " + esc(t.fromCode) + ")" : ""));
    if (t.note) bits.push("Note: " + esc(t.note));
    return `<div class="row" style="flex-wrap:wrap"><div style="min-width:0;flex:1"><b>${who ? '<span class="tx-who">' + esc(who) + '</span> · ' : ""}${esc(Coins.describe(t))}</b>` +
        `<small>${esc(when)}</small><small>${bits.join(" · ")}</small>` +
        (t.id ? `<small style="opacity:.55;word-break:break-all">ID: ${esc(t.id)}</small>` : "") + `</div>` +
        `<b class="${amt < 0 ? "neg" : "pos"}">${amt > 0 ? "+" : ""}${nf(amt)}</b></div>`;
}
var adminTxUnsub = null;
function stopAdminTxWatch() { if (adminTxUnsub) { try { adminTxUnsub(); } catch (e) { } adminTxUnsub = null; } }
// one button per user (by name); nothing is read until one is picked
var adminLastActive = {}, adminLastActiveAt = 0, adminAllCache = null;
function paintTxChips() {
    const chipBox = $("admin-tx-filters"); if (!chipBox) return;
    const la = u => adminLastActive[u.id] || 0;
    // most recently active users first (users with no history, then by name)
    const users = adminUsers.slice().sort((a, b) => (la(b) - la(a)) || (b.activeGame ? 1 : 0) - (a.activeGame ? 1 : 0) || adminName(a).localeCompare(adminName(b)));
    chipBox.innerHTML = `<button type="button" class="chip${adminTxFilter === "" ? " active" : ""}" data-f="">All</button>` +
        users.map(u => `<button type="button" class="chip${adminTxFilter === u.id ? " active" : ""}" data-f="${esc(u.id)}">${esc(adminName(u))}</button>`).join("");
}
// latest entries of every user, merged, newest first (cached for 5 minutes)
async function loadAllTx(force) {
    if (!force && adminAllCache && Date.now() - adminAllCache.at < TX_CACHE_MS) return adminAllCache.rows;
    const rows = [];
    await Promise.all(adminUsers.map(async u => {
        try { (await Coins.adminLedger(u.id, 15)).forEach(t => rows.push({ t, who: adminName(u) })); } catch (e) { }
    }));
    rows.sort((a, b) => txMs(b.t) - txMs(a.t));
    adminAllCache = { at: Date.now(), rows };
    return rows;
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
        if (force || !adminLastActiveAt || Date.now() - adminLastActiveAt > TX_CACHE_MS) {
            try { adminLastActive = await Coins.adminLastActive(adminUsers.map(u => u.id)); adminLastActiveAt = Date.now(); paintTxChips(); } catch (e) { }
        }
        if (!adminTxFilter) {
            stopAdminTxWatch();
            list.innerHTML = '<p class="empty">Loading...</p>';
            const rows = await loadAllTx(force);
            // if a user was picked while loading, the rerun below shows that user instead
            if (!adminTxFilter) list.innerHTML = rows.map(r => txRow(r.t, r.who)).join("") || '<p class="empty">No transactions.</p>';
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
    const saveBtn = $("au-alias-save");
    btnBusy(saveBtn, true);
    try {
        await Coins.adminSetAlias(adminSel.id, v);
        $("au-name").textContent = v || adminSel.name || "Player";
        lbCache = null; friendsCache = null;   // the leaderboard and friends list reload with the new name
        showNotification(v ? "Name saved" : "Name reset to the player's own", "success");
        adminRefresh();
    } catch (err) { showNotification(err.message, "error"); }
    btnBusy(saveBtn, false);
};
$("au-delete").onclick = async () => {
    if (!adminSel) return;
    if (!confirm("Permanently delete " + (adminSel.alias || adminSel.name || "this user") + " and all their data? This cannot be undone.")) return;
    const btn = $("au-delete");
    btnBusy(btn, true);
    try {
        await Coins.adminDeleteUser(adminSel.id);
        closeAdminUser();
        showNotification("User deleted", "success");
        adminRefresh();
    } catch (err) { showNotification(err.message, "error"); }
    btnBusy(btn, false);
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
            if (!confirm("End this room now and delete it? Coin balances and coin history are not affected.")) return;
            adminOpenRooms.delete(gid); closeRoomWatch(gid);
            await Coins.adminEndAndDelete(gid); showNotification("Room ended and deleted", "success"); adminRefresh();
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
    btnBusy(btn, true); btn.textContent = "Working...";
    try {
        const r = await job();
        showNotification(r.failed ? `${doneText}: ${r.ok} done, ${r.failed} failed` : `${doneText}: ${r.ok}`, r.failed ? "error" : "success");
    } catch (err) { showNotification(err.message || "Action failed", "error"); }
    btn.textContent = label;
    btnBusy(btn, false);
    adminOpenRooms.clear(); closeAllRoomWatch();
    await adminRefresh();
    paintAdminBulk();
}
$("admin-rooms-endall").onclick = e => {
    const ids = adminLiveRooms().map(g => g.id);
    adminBulk(e.currentTarget, `End all ${ids.length} live room(s) now and delete them? Players are sent out; coin balances and coin history are not affected.`, () => Coins.adminEndGames(ids), "Rooms ended");
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

const VIEW_LOADERS = { updates: renderUpdates, home: renderHome, lobby: initLobby, devlobby: renderDevLobby, earn: renderEarn, profile: renderProfile, stats: renderStats, transactions: renderTransactions, history: renderHistory, theme: () => applyTheme(store.get("theme", "indigo")), favorites: () => { favEditing = false; favDraft = []; paintFav(); refreshFavPaid(); }, share: renderShare, invite: renderInvite, leaderboard: renderLeaderboard, admin: renderAdmin, wincards: renderWinCards };

/* ================= ARENA: menu, copy, feedback, hints ================= */
/* one-at-a-time menu: opening Auto generate / Adjust volume hides every other item until Close */
function menuFocus(menuId, open) {
    const d = $("menu-dropdown"); if (!d) return;
    d.classList.toggle("focus-one", open);
    d.querySelectorAll(".auto-menu").forEach(m => m.classList.toggle("is-open", open && m.id === menuId));
}
function menuUnfocus() {
    menuFocus("", false);
    [["auto-head", "auto-panel"], ["btn-members", "members-panel"], ["vol-head", "vol-panel"]].forEach(([h, p]) => {
        const hb = $(h), pn = $(p); if (!hb || !pn) return;
        pn.classList.add("hidden"); hb.classList.remove("open"); hb.setAttribute("aria-expanded", "false");
    });
}
function closeMenu() {
    const d = $("menu-dropdown");
    menuUnfocus();
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
async function refreshMembersLite() {
    if (!liteMembers || !gameId || Date.now() - membersAt < 60000) return;
    membersAt = Date.now();
    try { members = (await Coins.getPlayers(gameId)).map(p => Object.assign({}, p, { online: undefined })); renderMembers(); }
    catch (e) { membersAt = 0; }
}
$("btn-members").onclick = () => {
    const p = $("members-panel");
    const open = p.classList.toggle("hidden") === false;
    $("btn-members").setAttribute("aria-expanded", String(open));
    $("btn-members").classList.toggle("open", open);
    menuFocus("members-menu", open);
    if (open) refreshMembersLite();
};

/* ---- Adjust volume (room menu): Music / Number reading toggles + volume slider ---- */
function paintVolMenu() {
    if (!window.FX || !FX.Quick) return;
    const q = FX.Quick.get(), pct = Math.round(q.vol * 100);
    $("vol-music").checked = q.music; $("vol-voice").checked = q.voice;
    $("vol-range").value = pct; $("vol-pct").textContent = pct + "%";
    $("vol-range").style.setProperty("--pct", pct + "%");
    $("vol-sub").textContent = "Music " + (q.music ? "on" : "off") + " · Voice " + (q.voice ? "on" : "off");
}
$("vol-head").onclick = () => {
    const p = $("vol-panel");
    const open = p.classList.toggle("hidden") === false;
    $("vol-head").setAttribute("aria-expanded", String(open));
    $("vol-head").classList.toggle("open", open);
    menuFocus("vol-menu", open);
    if (open) paintVolMenu();
};
document.querySelectorAll("[data-close-panel]").forEach(b => b.onclick = e => { e.stopPropagation(); menuUnfocus(); });
$("vol-music").onchange = e => { FX.Quick.setMusic(e.target.checked); paintVolMenu(); };
$("vol-voice").onchange = e => { FX.Quick.setVoice(e.target.checked); paintVolMenu(); };
$("vol-range").oninput = e => { FX.Quick.setVol(e.target.value / 100); $("vol-pct").textContent = e.target.value + "%"; e.target.style.setProperty("--pct", e.target.value + "%"); };
$("vol-range").onchange = () => FX.play("coin");
paintVolMenu();
$("btn-leave").addEventListener("click", closeMenu);


/* ================= RESULT BUTTONS ================= */
$("win-again").onclick = () => {
    sessionStorage.setItem("housie.again", "1");
    stopListeners();
    Coins.clearActiveGame();
    reloadApp();
};

/* ================= BACK GESTURE / BROWSER BACK ================= */
window.addEventListener("popstate", e => {
    const pop = document.querySelector(".popup-overlay.active:not(#reconnect-overlay)");
    if (pop) {
        const btn = pop.querySelector("#leave-cancel, #au-close, #delete-cancel, [data-v='0']");
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