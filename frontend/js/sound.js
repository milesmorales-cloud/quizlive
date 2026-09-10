// ============================================================
// QuizLive - Synthesized sound effects (Web Audio API)
// No audio asset files needed — every sound is generated in
// real time from oscillators. Lazy-creates/resumes the AudioContext
// so it satisfies browser autoplay policies on the first user tap.
// ============================================================

(function () {
    let ctx = null;

    // Browsers require the AudioContext to be created/resumed after a
    // user gesture. We lazily build it on first playSound call (which is
    // always triggered by a user tap in this app).
    function ensureContext() {
        if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            ctx = new AC();
        }
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
        return ctx;
    }

    // Play a short tonal blip. freq -> gain envelope.
    function blip(freq, start, dur, { type = 'sine', gain = 0.2, freqEnd = null } = {}) {
        if (!ctx) return;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, start);
        if (freqEnd !== null) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), start + dur);
        }

        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(gain, start + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, start + dur);

        osc.connect(g).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + dur + 0.02);
    }

    const sounds = {
        correct: () => {
            // Bright two-note "ding" (C6 -> G6)
            const t = ctx.currentTime;
            blip(1046.5, t, 0.18, { type: 'sine', gain: 0.22 });
            blip(1568, t + 0.12, 0.25, { type: 'sine', gain: 0.2 });
        },
        wrong: () => {
            // Short descending buzz (A3 -> D3)
            const t = ctx.currentTime;
            blip(220, t, 0.3, { type: 'sawtooth', gain: 0.12, freqEnd: 146.8 });
        },
        tick: () => {
            // Metronomic high click for the last seconds of the countdown
            const t = ctx.currentTime;
            blip(1200, t, 0.05, { type: 'square', gain: 0.08 });
        },
        reveal: () => {
            // "Rise" fanfare when the correct answer is revealed
            const t = ctx.currentTime;
            blip(523.25, t, 0.15, { type: 'triangle', gain: 0.18 });
            blip(659.25, t + 0.12, 0.15, { type: 'triangle', gain: 0.18 });
            blip(783.99, t + 0.24, 0.3, { type: 'triangle', gain: 0.2 });
        },
        gameover: () => {
            // Triumphant three-note chord arpeggio for the results screen
            const t = ctx.currentTime;
            blip(523.25, t, 0.2, { type: 'triangle', gain: 0.2 });
            blip(659.25, t + 0.15, 0.2, { type: 'triangle', gain: 0.2 });
            blip(783.99, t + 0.3, 0.2, { type: 'triangle', gain: 0.2 });
            blip(1046.5, t + 0.45, 0.45, { type: 'triangle', gain: 0.22 });
        }
    };

    function playSound(name) {
        if (!ensureContext()) return;
        const fn = sounds[name];
        if (fn) fn();
    }

    // Track whether a low-countdown tick has already fired for the current
    // second so we don't spam clicks every frame.
    let lastTickSecond = null;
    function tickAtSecond(second) {
        if (second === lastTickSecond) return;
        lastTickSecond = second;
        playSound('tick');
    }
    function resetTick() {
        lastTickSecond = null;
    }

    window.QuizLiveSound = {
        play: playSound,
        tickAtSecond,
        resetTick
    };
})();
