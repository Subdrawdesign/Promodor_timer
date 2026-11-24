/* ============================================================
   FOCUS FLOW — DATA LAYER
   - Remote mode: Google Sheet via Apps Script (JSONP)
   - Local mode : localStorage (when APPS_SCRIPT_URL is empty)
   - Offline-first: every session is written to a local queue first,
     then flushed to the sheet; retried automatically until it lands.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.FF_CONFIG || {};
  var URL_ = (CFG.APPS_SCRIPT_URL || "").trim();
  var REMOTE = !!URL_;

  var K = {
    local: "ff_local_sessions",   // local-mode database
    queue: "ff_queue",            // unsynced sessions (remote mode)
    cache: "ff_cache_sessions",   // last copy fetched from the sheet
    settings: "ff_settings",
    meta: "ff_meta"
  };

  /* ------------------------------------------------------------ utils */
  var util = {
    pad: function (n) { return String(n).padStart(2, "0"); },
    dateKey: function (d) {
      d = d instanceof Date ? d : new Date(d);
      return d.getFullYear() + "-" + util.pad(d.getMonth() + 1) + "-" + util.pad(d.getDate());
    },
    parseKey: function (k) {
      var p = k.split("-");
      return new Date(+p[0], +p[1] - 1, +p[2]);
    },
    addDays: function (d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; },
    uuid: function () {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    },
    fmtDur: function (sec) {
      sec = Math.round(sec || 0);
      var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
      if (h && m) return h + "h " + m + "m";
      if (h) return h + "h";
      if (m) return m + "m";
      return sec + "s";
    },
    fmtClock: function (sec) {
      sec = Math.max(0, Math.round(sec));
      var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return (h ? h + ":" + util.pad(m) : util.pad(m)) + ":" + util.pad(s);
    },
    esc: function (s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    },
    device: function () {
      var ua = navigator.userAgent;
      var os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac/.test(ua) ? "Mac" :
        /Win/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Other";
      var br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" :
        /Safari\//.test(ua) ? "Safari" : "Browser";
      return br + " · " + os;
    },
    read: function (key, fallback) {
      try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
      catch (e) { return fallback; }
    },
    write: function (key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* quota */ }
    },
    toast: function (msg, type) {
      var box = document.getElementById("toasts");
      if (!box) { box = document.createElement("div"); box.id = "toasts"; document.body.appendChild(box); }
      var t = document.createElement("div");
      t.className = "toast " + (type || "");
      t.textContent = msg;
      box.appendChild(t);
      setTimeout(function () { t.classList.add("out"); }, 2600);
      setTimeout(function () { t.remove(); }, 3100);
    }
  };

  /* ------------------------------------------------------------ JSONP */
  function jsonp(payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var cb = "ffCb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      var params = new URLSearchParams();
      Object.keys(payload).forEach(function (k) {
        var v = payload[k];
        if (v === undefined || v === null) return;
        params.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      });
      params.set("key", CFG.API_KEY || "");
      params.set("callback", cb);

      var script = document.createElement("script");
      var done = false;
      function cleanup() {
        done = true;
        clearTimeout(timer);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        script.remove();
      }
      window[cb] = function (data) {
        if (done) return;
        cleanup();
        if (data && data.result === "success") resolve(data);
        else reject(new Error((data && data.error) || "Unknown error"));
      };
      script.onerror = function () { if (!done) { cleanup(); reject(new Error("Network error")); } };
      var timer = setTimeout(function () { if (!done) { cleanup(); reject(new Error("Timed out")); } }, timeoutMs || 20000);
      script.src = URL_ + (URL_.indexOf("?") >= 0 ? "&" : "?") + params.toString();
      document.head.appendChild(script);
    });
  }

  /* ------------------------------------------------------------ status */
  var status = REMOTE ? "syncing" : "local";
  var listeners = [];
  function setStatus(s) {
    status = s;
    listeners.forEach(function (fn) { try { fn(s, queueLen()); } catch (e) {} });
  }
  function queueLen() { return util.read(K.queue, []).length; }

  /* ------------------------------------------------------------ queue */
  var flushing = null;
  function flush() {
    if (!REMOTE) return Promise.resolve();
    if (flushing) return flushing;
    var q = util.read(K.queue, []);
    if (!q.length) { setStatus("online"); return Promise.resolve(); }
    setStatus("syncing");

    flushing = (async function () {
      try {
        while (true) {
          q = util.read(K.queue, []);
          if (!q.length) break;
          var chunk = q.slice(0, 4);  // keep the GET URL short
          var res = chunk.length === 1
            ? await jsonp(Object.assign({ action: "log" }, chunk[0]))
                .then(function () { return { saved: [chunk[0].clientId] }; })
            : await jsonp({ action: "logBatch", items: chunk }, 25000);
          var saved = res.saved || [];
          var rest = util.read(K.queue, []).filter(function (x) { return saved.indexOf(x.clientId) < 0; });
          // move saved ones into the cache so analytics sees them immediately
          var cache = util.read(K.cache, []);
          chunk.forEach(function (x) { if (saved.indexOf(x.clientId) >= 0) cache.push(x); });
          util.write(K.cache, dedupe(cache));
          util.write(K.queue, rest);
          if (!saved.length) throw new Error("Nothing saved");
        }
        setStatus("online");
      } catch (e) {
        setStatus("offline");
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  function dedupe(list) {
    var seen = {}, out = [];
    list.forEach(function (s) { if (!seen[s.clientId]) { seen[s.clientId] = 1; out.push(s); } });
    return out;
  }

  window.addEventListener("online", function () { flush(); });
  setInterval(function () { if (queueLen()) flush(); }, 30000);

  /* ------------------------------------------------------------ public API */
  var api = {
    isRemote: REMOTE,
    get status() { return status; },
    onStatus: function (fn) { listeners.push(fn); fn(status, queueLen()); },
    queueLength: queueLen,
    flush: flush,

    ping: function () {
      if (!REMOTE) return Promise.resolve({ local: true });
      return jsonp({ action: "ping" }, 12000)
        .then(function (r) { if (!queueLen()) setStatus("online"); return r; })
        .catch(function (e) { setStatus("offline"); throw e; });
    },

    /* Save one session. Always resolves (queued if offline). */
    logSession: function (s) {
      s.clientId = s.clientId || util.uuid();
      if (!REMOTE) {
        var db = util.read(K.local, []);
        db.push(s);
        util.write(K.local, dedupe(db));
        return Promise.resolve({ local: true });
      }
      var q = util.read(K.queue, []);
      q.push(s);
      util.write(K.queue, q);
      return flush().then(function () { return { queued: queueLen() > 0 }; });
    },

    /* Sessions between two yyyy-MM-dd keys (inclusive). Falls back to cache. */
    getSessions: function (from, to) {
      function inRange(x) { return x.date >= from && x.date <= to; }
      if (!REMOTE) return Promise.resolve(util.read(K.local, []).filter(inRange));
      return jsonp({ action: "sessions", from: from, to: to }, 30000)
        .then(function (r) {
          var remote = r.sessions || [];
          // refresh cache for this range
          var cache = util.read(K.cache, []).filter(function (x) { return !inRange(x); });
          util.write(K.cache, dedupe(cache.concat(remote)));
          if (!queueLen()) setStatus("online");
          return dedupe(remote.concat(util.read(K.queue, []))).filter(inRange);
        })
        .catch(function () {
          setStatus("offline");
          var all = dedupe(util.read(K.cache, []).concat(util.read(K.queue, [])));
          var out = all.filter(inRange);
          out.fromCache = true;
          return out;
        });
    },

    deleteSession: function (clientId) {
      function drop(key) { util.write(key, util.read(key, []).filter(function (x) { return x.clientId !== clientId; })); }
      drop(K.local); drop(K.cache);
      var q = util.read(K.queue, []);
      if (!REMOTE || q.some(function (x) { return x.clientId === clientId; })) {
        drop(K.queue);
        return Promise.resolve({});
      }
      return jsonp({ action: "delete", clientId: clientId });
    },

    updateSession: function (clientId, fields) {
      function patch(key) {
        util.write(key, util.read(key, []).map(function (x) {
          return x.clientId === clientId ? Object.assign({}, x, fields) : x;
        }));
      }
      patch(K.local); patch(K.cache); patch(K.queue);
      if (!REMOTE) return Promise.resolve({});
      if (util.read(K.queue, []).some(function (x) { return x.clientId === clientId; })) return Promise.resolve({});
      return jsonp(Object.assign({ action: "update", clientId: clientId }, fields));
    },

    getSettings: function () {
      var defaults = Object.assign({}, CFG.DEFAULTS || {});
      var local = Object.assign(defaults, util.read(K.settings, {}));
      if (!REMOTE) return Promise.resolve(local);
      return jsonp({ action: "getSettings" }, 12000)
        .then(function (r) {
          // settings saved in the sheet win, so every device shares them
          var merged = Object.assign({}, defaults, util.read(K.settings, {}), r.settings || {});
          util.write(K.settings, merged);
          return merged;
        })
        .catch(function () { return local; });
    },

    saveSettings: function (s) {
      util.write(K.settings, s);
      if (!REMOTE) return Promise.resolve({});
      return jsonp({ action: "saveSettings", settings: s }).catch(function () { return {}; });
    },

    meta: function () {
      if (!REMOTE) {
        var db = util.read(K.local, []);
        var tasks = {}, projects = {};
        db.slice(-500).reverse().forEach(function (x) {
          if (x.task) tasks[x.task] = 1;
          if (x.project) projects[x.project] = 1;
        });
        return Promise.resolve({ local: true, tasks: Object.keys(tasks).slice(0, 40), projects: Object.keys(projects).slice(0, 40), totalSessions: db.length });
      }
      return jsonp({ action: "meta" })
        .then(function (r) { util.write(K.meta, r); return r; })
        .catch(function () { return util.read(K.meta, { tasks: [], projects: [] }); });
    },

    /* Local mode only: fill the browser DB with ~6 months of realistic demo data */
    seedDemo: function () {
      if (REMOTE) return Promise.reject(new Error("Demo data only in local mode"));
      var projects = ["TDF Payments", "DSA Practice", "IITJ Coursework", "GATE Prep", "Side Project"];
      var tasks = {
        "TDF Payments": ["Approval flow API", "Checker screen", "Bug fixes"],
        "DSA Practice": ["Graphs", "DP problems", "Codeforces round"],
        "IITJ Coursework": ["Foundations of AI", "Assignment 3", "Lecture notes"],
        "GATE Prep": ["OS revision", "TOC PYQs", "CN mock"],
        "Side Project": ["Landing page", "Docker setup"]
      };
      var out = [], today = new Date();
      for (var i = 180; i >= 0; i--) {
        var day = util.addDays(today, -i);
        var dow = day.getDay();
        if (Math.random() < (dow === 0 ? 0.55 : 0.12)) continue;     // rest days
        var n = Math.max(1, Math.round((dow === 0 || dow === 6 ? 3 : 6) * (0.4 + Math.random())));
        var t = new Date(day); t.setHours(9 + Math.floor(Math.random() * 3), Math.floor(Math.random() * 60), 0, 0);
        for (var j = 0; j < n; j++) {
          var p = projects[Math.floor(Math.pow(Math.random(), 1.4) * projects.length)];
          var flow = Math.random() < 0.15;
          var dur = flow ? (40 + Math.floor(Math.random() * 70)) * 60 : (Math.random() < 0.85 ? 1500 : 600 + Math.floor(Math.random() * 800));
          var start = new Date(t);
          var end = new Date(start.getTime() + dur * 1000 + (Math.random() < 0.3 ? 120000 : 0));
          if (end > today) break;                                   // nothing in the future
          out.push({
            clientId: util.uuid(), date: util.dateKey(start), startTime: start.toISOString(), endTime: end.toISOString(),
            durationSec: dur, mode: flow ? "flow" : "focus", task: tasks[p][Math.floor(Math.random() * tasks[p].length)],
            project: p, completed: flow || dur === 1500, pauses: Math.random() < 0.3 ? 1 : 0, plannedSec: flow ? 0 : 1500,
            note: "", device: "Demo"
          });
          t = new Date(end.getTime() + (5 + Math.floor(Math.random() * 25)) * 60000);
          if (j === 2) t = new Date(t.getTime() + 60 * 60000); // lunch
          if (t.getHours() >= 23) break;
        }
      }
      util.write(K.local, util.read(K.local, []).concat(out));
      return Promise.resolve(out.length);
    },

    clearLocal: function () { localStorage.removeItem(K.local); }
  };

  window.FF = window.FF || {};
  window.FF.api = api;
  window.FF.util = util;

  if (REMOTE) { api.ping().then(flush).catch(function () {}); }
})();
