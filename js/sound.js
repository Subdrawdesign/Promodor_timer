/* ============================================================
   FOCUS FLOW — SOUNDS (Web Audio, generated in code: no mp3 files,
   works offline, no CORS issues)
     start()    rising 2-note chime      — timer started / resumed
     stop()     falling 2-note chime     — timer paused / stopped
     complete() 3x bell                  — session finished
     breakEnd() soft double ding         — break finished
     hourly()   deep gong                — every full hour in Flow mode
     tick()     very soft click          — optional per-second tick
   ============================================================ */
(function () {
  "use strict";
  var ctx = null, master = null;
  var enabled = true, volume = 0.6;

  function ac() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  /* one bell-ish note: sine + a quieter octave partial, fast attack, exp decay */
  function note(freq, at, dur, gain, type) {
    var c = ac(); if (!c || !enabled) return;
    var t = c.currentTime + (at || 0);
    [[1, 1], [2, 0.25], [3, 0.08]].forEach(function (p) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || "sine";
      o.frequency.setValueAtTime(freq * p[0], t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime((gain || 0.5) * p[1], t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.6));
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + (dur || 0.6) + 0.05);
    });
  }

  var S = {
    unlock: function () { ac(); },
    setEnabled: function (v) { enabled = !!v; },
    setVolume: function (v) {
      volume = Math.max(0, Math.min(1, Number(v)));
      if (master) master.gain.value = volume;
    },
    start: function () {            // C5 -> G5
      note(523.25, 0, 0.35, 0.45);
      note(783.99, 0.12, 0.55, 0.45);
    },
    stop: function () {             // G5 -> C5
      note(783.99, 0, 0.3, 0.4);
      note(523.25, 0.12, 0.5, 0.4);
    },
    complete: function () {         // C-E-G-C arpeggio, three times
      for (var r = 0; r < 3; r++) {
        var b = r * 0.9;
        note(523.25, b, 0.5, 0.5);
        note(659.25, b + 0.12, 0.5, 0.5);
        note(783.99, b + 0.24, 0.5, 0.5);
        note(1046.5, b + 0.36, 0.9, 0.55);
      }
    },
    breakEnd: function () {
      note(880, 0, 0.5, 0.45);
      note(880, 0.35, 0.8, 0.45);
    },
    hourly: function () {
      note(196, 0, 2.2, 0.6);
      note(392, 0.02, 1.6, 0.25);
    },
    tick: function () {
      var c = ac(); if (!c || !enabled) return;
      var t = c.currentTime;
      var o = c.createOscillator(), g = c.createGain();
      o.type = "square"; o.frequency.value = 1800;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.03, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.05);
    }
  };

  window.FF = window.FF || {};
  window.FF.sound = S;
})();
