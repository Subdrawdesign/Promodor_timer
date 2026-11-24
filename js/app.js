/* ============================================================
   FOCUS FLOW — TIMER PAGE
   Timestamp-based timer (accurate even when the tab is in the
   background), survives refresh, syncs every session to the sheet.
   ============================================================ */
(function () {
  "use strict";
  var api = FF.api, U = FF.util, sound = FF.sound;
  var $ = function (id) { return document.getElementById(id); };

  var MODES = {
    focus: { label: "Focus",       color: "#ff0037", rgb: "255,0,55",   key: "focusMin" },
    short: { label: "Short Break", color: "#00ffcd", rgb: "0,255,205",  key: "shortMin" },
    long:  { label: "Long Break",  color: "#008cff", rgb: "0,140,255",  key: "longMin" },
    flow:  { label: "Flow",        color: "#a970ff", rgb: "169,112,255", key: null }
  };
  var STATE_KEY = "ff_timer";
  var RING_LEN = 2 * Math.PI * 136;

  var settings = Object.assign({}, FF_CONFIG.DEFAULTS);
  var st = null;          // timer state (persisted)
  var loopId = null;
  var lastWholeSec = -1;
  var wakeLock = null;
  var recentSessions = [];

  /* ---------------------------------------------------------------- state */
  function freshState(mode, keep) {
    keep = keep || {};
    return {
      mode: mode,
      plannedSec: mode === "flow" ? 0 : Math.round((settings[MODES[mode].key] || 25) * 60),
      running: false,
      elapsedBase: 0,        // seconds accumulated before the current run
      runStartedAt: 0,       // ms timestamp of the current run
      sessionStart: null,    // ISO of the first start
      pauses: 0,
      cycle: keep.cycle || 0,             // focus sessions done in this cycle
      task: keep.task || "",
      project: keep.project || "",
      lastHour: 0,
      clientId: U.uuid()
    };
  }
  function save() { U.write(STATE_KEY, st); }
  function elapsed() {
    return st.elapsedBase + (st.running ? (Date.now() - st.runStartedAt) / 1000 : 0);
  }
  function remaining() { return Math.max(0, st.plannedSec - elapsed()); }
  function isCountdown() { return st.mode !== "flow"; }

  /* ---------------------------------------------------------------- render */
  function render() {
    var m = MODES[st.mode];
    var el = elapsed();
    var shown = isCountdown() ? Math.ceil(remaining() - 0.001) : Math.floor(el);
    var progress = isCountdown()
      ? (st.plannedSec ? Math.min(1, el / st.plannedSec) : 0)
      : (el % 3600) / 3600;

    $("timeDisplay").textContent = U.fmtClock(shown);
    $("timeDisplay").classList.toggle("long", shown >= 3600);
    $("ringBar").style.strokeDashoffset = String(RING_LEN * (1 - progress));

    var card = $("timerCard");
    card.dataset.mode = st.mode;
    card.classList.toggle("running", st.running);
    card.style.setProperty("--mode-rgb", m.rgb);
    card.style.setProperty("--progress", progress.toFixed(4));

    $("start").textContent = st.running ? "Pause" : (el > 0 ? "Resume" : "Start");
    $("reset").querySelector("span").textContent = st.mode === "flow" ? "Stop & save" : "Reset";
    $("phaseLabel").textContent = st.running ? m.label : (el > 0 ? "Paused" : m.label);

    if (st.mode === "focus") {
      $("subLabel").textContent = "Session " + (st.cycle + 1) + " of " + settings.longEvery;
    } else if (st.mode === "flow") {
      var h = Math.floor(el / 3600);
      $("subLabel").textContent = h ? h + "h done · ring = this hour" : "Stopwatch · ring = this hour";
    } else if (st.mode === "long") {
      $("subLabel").textContent = "Cycle complete 🎉 Recharge";
    } else {
      $("subLabel").textContent = "Next: Pomodoro " + Math.min(st.cycle + 1, settings.longEvery) + " of " + settings.longEvery;
    }

    document.querySelectorAll("[data-mode-button]").forEach(function (b) {
      b.classList.toggle("active", b.dataset.modeButton === st.mode);
    });

    $("taskText").textContent = st.task || (st.mode === "focus" || st.mode === "flow" ? "No task — click to add one" : "Break time — breathe 🌿");
    $("projText").textContent = st.project || "";
    $("projText").hidden = !st.project;

    var dots = "";
    for (var i = 0; i < settings.longEvery; i++) {
      var cls = i < st.cycle ? "done" : (i === st.cycle && st.mode === "focus" ? "now" : "");
      dots += '<span class="' + cls + '"></span>';
    }
    $("cycleDots").innerHTML = dots;

    document.title = (st.running || el > 0 ? U.fmtClock(shown) + " · " + m.label + " — " : "") + "Focus Flow";
  }

  /* ---------------------------------------------------------------- loop */
  function loop() {
    if (!st.running) return;
    var el = elapsed();
    if (isCountdown() && el >= st.plannedSec) { complete(); return; }

    var whole = Math.floor(el);
    if (whole !== lastWholeSec) {
      lastWholeSec = whole;
      if (settings.tick && st.mode === "focus") sound.tick();
      if (st.mode === "flow" && settings.hourlyChime) {
        var hours = Math.floor(el / 3600);
        if (hours > st.lastHour) {
          st.lastHour = hours; save();
          sound.hourly();
          notify("⏰ " + hours + " hour" + (hours > 1 ? "s" : "") + " in flow", st.task || "Keep going!");
        }
      }
    }
    render();
  }
  function startLoop() { stopLoop(); loopId = setInterval(loop, 250); }
  function stopLoop() { if (loopId) clearInterval(loopId); loopId = null; }

  /* ---------------------------------------------------------------- actions */
  async function start(opts) {
    opts = opts || {};
    if (st.running) return;
    sound.unlock();
    var fresh = elapsed() === 0;
    if (fresh && (st.mode === "focus" || st.mode === "flow") && settings.askTask && !opts.noPrompt) {
      var picked = await promptTask();
      if (picked === null) return;          // closed with Esc
      st.task = picked.task; st.project = picked.project;
    }
    if (!st.sessionStart) st.sessionStart = new Date().toISOString();
    st.running = true;
    st.runStartedAt = Date.now();
    save();
    if (!opts.silent) sound.start();
    askNotifyPermission();
    requestWakeLock();
    startLoop();
    render();
  }

  function pause() {
    if (!st.running) return;
    st.elapsedBase = elapsed();
    st.running = false;
    st.pauses++;
    save();
    stopLoop();
    sound.stop();
    releaseWakeLock();
    render();
  }

  function toggle() { st.running ? pause() : start(); }

  /* logs whatever has been done so far, returns true if saved */
  function logCurrent(completed, endDate) {
    var dur = Math.round(Math.min(elapsed(), isCountdown() ? st.plannedSec : Infinity));
    if (dur < (settings.minLogSec || 0) || dur <= 0) return false;
    var end = endDate || new Date();
    var startIso = st.sessionStart || new Date(end.getTime() - dur * 1000).toISOString();
    var rec = {
      clientId: st.clientId,
      date: U.dateKey(new Date(startIso)),
      startTime: startIso,
      endTime: end.toISOString(),
      durationSec: dur,
      mode: st.mode,
      task: st.task,
      project: st.project,
      completed: !!completed,
      pauses: st.pauses,
      plannedSec: st.plannedSec,
      note: "",
      device: U.device()
    };
    recentSessions.push(rec);
    renderToday();
    api.logSession(rec).then(function () { refreshToday(); });
    return true;
  }

  function goTo(mode, autoStart) {
    var keep = { cycle: st.cycle, task: st.task, project: st.project };
    // a finished cycle (after the long break) starts over
    if (mode === "focus" && (st.mode === "long" || keep.cycle >= settings.longEvery)) keep.cycle = 0;
    st = freshState(mode, keep);
    save();
    lastWholeSec = -1;
    render();
    if (autoStart) start({ noPrompt: true, silent: true });
  }

  function nextModeAfter(mode) {
    if (mode === "focus") return (st.cycle >= settings.longEvery) ? "long" : "short";
    if (mode === "long") return "focus";
    return "focus";
  }

  function complete(endDate) {
    stopLoop();
    var mode = st.mode;
    // freeze elapsed at the planned length
    st.elapsedBase = st.plannedSec; st.running = false;
    logCurrent(true, endDate);
    releaseWakeLock();

    if (mode === "focus") {
      sound.complete();
      st.cycle = st.cycle + 1;
      var next = nextModeAfter("focus");
      notify("🍅 Pomodoro done!", (st.task ? st.task + " · " : "") + "Time for a " + MODES[next].label.toLowerCase() + ".");
      U.toast("Pomodoro complete — saved ✓", "ok");
      goTo(next, settings.autoStartBreaks);
    } else {
      sound.breakEnd();
      notify("☕ Break over", "Ready for the next pomodoro?");
      goTo("focus", settings.autoStartFocus);
    }
  }

  function reset() {
    var el = elapsed();
    if (el > 0) {
      var saved = logCurrent(st.mode === "flow", null);
      if (saved) U.toast((st.mode === "flow" ? "Flow saved: " : "Partial session saved: ") + U.fmtDur(el), "ok");
      sound.stop();
    }
    stopLoop(); releaseWakeLock();
    st = freshState(st.mode, { cycle: st.cycle, task: st.task, project: st.project });
    save(); render();
  }

  function skip() {
    var el = elapsed();
    if (el > 0) {
      var saved = logCurrent(st.mode === "flow", null);
      if (saved) U.toast("Saved " + U.fmtDur(el) + " and skipped", "ok");
    }
    stopLoop(); releaseWakeLock();
    var mode = st.mode;
    if (mode === "focus") {
      if (el >= (settings.minLogSec || 0) && el > 0) st.cycle++;
      var next = nextModeAfter("focus");
      goTo(next, false);
    } else if (mode === "flow") {
      goTo("flow", false);
    } else {
      goTo("focus", false);
    }
  }

  function switchMode(mode) {
    if (mode === st.mode && elapsed() === 0) return;
    if (elapsed() > 0) {
      var saved = logCurrent(st.mode === "flow", null);
      if (saved) U.toast("Saved " + U.fmtDur(elapsed()) + " of " + MODES[st.mode].label, "ok");
      if (st.running) sound.stop();
    }
    stopLoop(); releaseWakeLock();
    goTo(mode, false);
  }

  /* ---------------------------------------------------------------- modals */
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  function promptTask() {
    return new Promise(function (resolve) {
      var modal = $("taskModal"), ti = $("taskInput"), pi = $("projectInput");
      ti.value = st.task || ""; pi.value = st.project || "";
      $("confirmTask").textContent = st.mode === "flow" ? "Start flow" : (st.running || elapsed() > 0 ? "Save" : "Start focus");
      openModal("taskModal");
      setTimeout(function () { ti.focus(); ti.select(); }, 30);

      function done(val) {
        closeModal("taskModal");
        $("confirmTask").onclick = $("skipTask").onclick = null;
        modal.onkeydown = null;
        resolve(val);
      }
      $("confirmTask").onclick = function () { done({ task: ti.value.trim(), project: pi.value.trim() }); };
      $("skipTask").onclick = function () { done({ task: "", project: pi.value.trim() }); };
      modal.onkeydown = function (e) {
        if (e.key === "Enter") { e.preventDefault(); $("confirmTask").click(); }
        if (e.key === "Escape") { e.preventDefault(); done(null); }
      };
    });
  }

  async function editTask() {
    var picked = await promptTask();
    if (!picked) return;
    st.task = picked.task; st.project = picked.project; save(); render();
  }

  function openCustomTime() {
    if (st.mode === "flow") { U.toast("Flow mode counts up — no fixed length"); return; }
    if (st.running) { U.toast("Pause the timer first"); return; }
    var sec = st.plannedSec;
    $("customMin").value = Math.floor(sec / 60);
    $("customSec").value = sec % 60;
    $("timeModeName").textContent = MODES[st.mode].label;
    openModal("timeModal");
    setTimeout(function () { $("customMin").select(); }, 30);
  }
  function confirmCustomTime() {
    var m = parseInt($("customMin").value, 10) || 0;
    var s = parseInt($("customSec").value, 10) || 0;
    var total = m * 60 + s;
    if (total <= 0) { U.toast("Enter a time greater than 0", "err"); return; }
    st.plannedSec = total;
    if (st.elapsedBase >= total) st.elapsedBase = 0;
    save(); closeModal("timeModal"); render();
  }

  function openSettings() {
    var f = $("settingsForm");
    Array.prototype.forEach.call(f.elements, function (el) {
      if (!el.name) return;
      if (el.type === "checkbox") el.checked = !!settings[el.name];
      else el.value = settings[el.name];
    });
    $("dbInfo").innerHTML = api.isRemote
      ? 'Database: <b>Google Sheet</b> · <span id="sheetLink">loading…</span>'
      : 'Database: <b>this browser only</b> (local mode). Add your Apps Script URL in <code>js/config.js</code> to sync to Google Sheets.';
    if (api.isRemote) api.meta().then(function (r) {
      var l = $("sheetLink"); if (!l) return;
      l.innerHTML = r.sheetUrl ? '<a href="' + U.esc(r.sheetUrl) + '" target="_blank" rel="noopener">open sheet ↗</a> · ' + (r.totalSessions || 0) + " rows" : "offline";
    });
    openModal("settingsModal");
  }
  function saveSettingsForm() {
    var f = $("settingsForm");
    var next = Object.assign({}, settings);
    Array.prototype.forEach.call(f.elements, function (el) {
      if (!el.name) return;
      if (el.type === "checkbox") next[el.name] = el.checked;
      else next[el.name] = Number(el.value);
    });
    ["focusMin", "shortMin", "longMin", "longEvery", "dailyGoalMin"].forEach(function (k) {
      if (!(next[k] > 0)) next[k] = FF_CONFIG.DEFAULTS[k];
    });
    settings = next;
    applySoundSettings();
    api.saveSettings(settings);
    // update planned length of an untouched session
    if (!st.running && elapsed() === 0 && st.mode !== "flow") {
      st.plannedSec = Math.round(settings[MODES[st.mode].key] * 60); save();
    }
    if (st.cycle >= settings.longEvery) st.cycle = 0;
    closeModal("settingsModal");
    render(); renderToday();
    U.toast("Settings saved", "ok");
  }

  function applySoundSettings() {
    sound.setEnabled(settings.sound);
    sound.setVolume(settings.volume);
    $("muteBtn").textContent = settings.sound ? "🔊" : "🔇";
  }

  /* ---------------------------------------------------------------- notify / wake */
  function askNotifyPermission() {
    if (settings.notifications && "Notification" in window && Notification.permission === "default") {
      try { Notification.requestPermission(); } catch (e) {}
    }
  }
  function notify(title, body) {
    if (!settings.notifications || !("Notification" in window) || Notification.permission !== "granted") return;
    try { new Notification(title, { body: body, silent: true, tag: "focus-flow" }); } catch (e) {}
  }
  function requestWakeLock() {
    if (!("wakeLock" in navigator) || wakeLock) return;
    navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; l.addEventListener("release", function () { wakeLock = null; }); }).catch(function () {});
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; } }

  /* ---------------------------------------------------------------- today panel */
  var historyCache = [];
  function refreshToday() {
    var today = new Date();
    var from = U.dateKey(U.addDays(today, -7 * 12 - 6));
    return api.getSessions(from, U.dateKey(today)).then(function (list) {
      historyCache = list;
      var ids = {};
      list.forEach(function (s) { ids[s.clientId] = 1; });
      recentSessions = recentSessions.filter(function (s) { return !ids[s.clientId]; });
      renderToday();
    });
  }

  function renderToday() {
    var all = historyCache.concat(recentSessions);
    var todayKey = U.dateKey(new Date());
    var focusModes = { focus: 1, flow: 1 };
    var byDay = {};
    all.forEach(function (s) { if (focusModes[s.mode]) byDay[s.date] = (byDay[s.date] || 0) + s.durationSec; });

    var today = all.filter(function (s) { return s.date === todayKey; })
      .sort(function (a, b) { return a.startTime < b.startTime ? 1 : -1; });
    var focusSec = byDay[todayKey] || 0;
    var goal = settings.dailyGoalMin * 60;

    $("todayFocus").textContent = U.fmtDur(focusSec);
    $("goalText").textContent = U.fmtDur(goal);
    $("goalFill").style.width = Math.min(100, focusSec / goal * 100) + "%";
    $("goalFill").classList.toggle("hit", focusSec >= goal);
    $("todaySessions").textContent = today.filter(function (s) { return focusModes[s.mode]; }).length;

    // streak: consecutive days with focus, today optional
    var streak = 0, d = new Date();
    if (!byDay[U.dateKey(d)]) d = U.addDays(d, -1);
    while (byDay[U.dateKey(d)]) { streak++; d = U.addDays(d, -1); }
    $("streakVal").textContent = streak;

    // this week (Mon-start)
    var now = new Date(), wd = (now.getDay() + 6) % 7, wk = 0;
    for (var i = 0; i <= wd; i++) wk += byDay[U.dateKey(U.addDays(now, -i))] || 0;
    $("weekFocus").textContent = U.fmtDur(wk);

    // mini heatmap: last 12 weeks, columns = weeks (Mon..Sun rows)
    var start = U.addDays(now, -wd - 7 * 11);
    var html = "";
    for (var w = 0; w < 12; w++) {
      html += '<div class="mh-col">';
      for (var r = 0; r < 7; r++) {
        var day = U.addDays(start, w * 7 + r);
        var key = U.dateKey(day);
        var future = day > now;
        var sec = byDay[key] || 0;
        var lvl = future ? -1 : level(sec, goal);
        html += '<i class="lv' + lvl + '" title="' + key + ": " + (sec ? U.fmtDur(sec) : "no focus") + '"></i>';
      }
      html += "</div>";
    }
    $("miniHeat").innerHTML = html;

    var ul = $("todayList");
    if (!today.length) { ul.innerHTML = '<li class="empty">Nothing tracked yet today. Hit Start 🚀</li>'; return; }
    ul.innerHTML = today.map(function (s) {
      var t = new Date(s.startTime);
      var time = U.pad(t.getHours()) + ":" + U.pad(t.getMinutes());
      return '<li class="m-' + s.mode + '">' +
        '<span class="sl-time">' + time + "</span>" +
        '<span class="sl-main"><b>' + U.esc(s.task || MODES[s.mode].label) + "</b>" +
        (s.project ? '<em>' + U.esc(s.project) + "</em>" : "") + "</span>" +
        '<span class="sl-dur">' + U.fmtDur(s.durationSec) + (s.completed ? " ✓" : "") + "</span></li>";
    }).join("");
  }

  function level(sec, goal) {
    if (!sec) return 0;
    var r = sec / goal;
    return r < 0.25 ? 1 : r < 0.5 ? 2 : r < 1 ? 3 : 4;
  }

  /* ---------------------------------------------------------------- sync pill */
  function syncPill(status, q) {
    var p = $("syncPill");
    p.dataset.status = status;
    var label = { local: "Local", online: "Synced", syncing: "Syncing…", offline: "Offline" }[status] || status;
    if (q && status !== "local") label += " · " + q + " queued";
    p.querySelector("b").textContent = label;
    p.title = status === "local" ? "Saving to this browser only (no Apps Script URL in config.js)"
      : status === "offline" ? "Can't reach the Google Sheet — sessions are queued and will upload automatically"
      : "Google Sheet";
  }

  /* ---------------------------------------------------------------- events */
  function bind() {
    $("start").addEventListener("click", toggle);
    $("reset").addEventListener("click", reset);
    $("skip").addEventListener("click", skip);
    $("timeDisplay").addEventListener("click", openCustomTime);
    $("taskChip").addEventListener("click", editTask);
    $("settingsBtn").addEventListener("click", openSettings);
    $("muteBtn").addEventListener("click", function () {
      settings.sound = !settings.sound; applySoundSettings(); api.saveSettings(settings);
      U.toast(settings.sound ? "Sound on" : "Sound off");
    });
    document.querySelectorAll("[data-mode-button]").forEach(function (b) {
      b.addEventListener("click", function () { switchMode(b.dataset.modeButton); });
    });

    $("confirmTime").addEventListener("click", confirmCustomTime);
    $("cancelTime").addEventListener("click", function () { closeModal("timeModal"); });
    $("timeModal").addEventListener("keydown", function (e) {
      if (e.key === "Enter") confirmCustomTime();
      if (e.key === "Escape") closeModal("timeModal");
    });
    document.querySelectorAll("[data-preset]").forEach(function (c) {
      c.addEventListener("click", function () { $("customMin").value = c.dataset.preset; $("customSec").value = 0; });
    });

    $("saveSettings").addEventListener("click", saveSettingsForm);
    $("cancelSettings").addEventListener("click", function () { closeModal("settingsModal"); });
    $("settingsModal").addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal("settingsModal"); });
    document.querySelectorAll("[data-test-sound]").forEach(function (b) {
      b.addEventListener("click", function () {
        sound.setEnabled(true);
        sound.setVolume($("settingsForm").elements.volume.value);
        sound[b.dataset.testSound]();
        setTimeout(applySoundSettings, 3000);
      });
    });

    // click on backdrop closes modals (not the task modal mid-start)
    ["timeModal", "settingsModal"].forEach(function (id) {
      $(id).addEventListener("mousedown", function (e) { if (e.target.id === id) closeModal(id); });
    });

    document.addEventListener("keydown", function (e) {
      var tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector(".custom-modal:not([hidden])")) return;
      var k = e.key.toLowerCase();
      if (k === " ") { e.preventDefault(); toggle(); }
      else if (k === "r") reset();
      else if (k === "s") skip();
      else if (k === "t") editTask();
      else if (k === "m") $("muteBtn").click();
      else if (k === "1") switchMode("focus");
      else if (k === "2") switchMode("short");
      else if (k === "3") switchMode("long");
      else if (k === "4") switchMode("flow");
    });

    // keep multiple tabs in sync
    window.addEventListener("storage", function (e) {
      if (e.key !== STATE_KEY || !e.newValue) return;
      try { st = JSON.parse(e.newValue); } catch (x) { return; }
      st.running ? startLoop() : stopLoop();
      render();
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") { loop(); if (st.running && st.mode === "focus") requestWakeLock(); }
    });

    window.addEventListener("beforeunload", function (e) {
      if (st.running) { save(); }
      if (api.queueLength()) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  function loadAutocomplete() {
    api.meta().then(function (r) {
      $("taskList").innerHTML = (r.tasks || []).map(function (t) { return '<option value="' + U.esc(t) + '">'; }).join("");
      $("projectList").innerHTML = (r.projects || []).map(function (t) { return '<option value="' + U.esc(t) + '">'; }).join("");
      $("recentProjects").innerHTML = (r.projects || []).slice(0, 6).map(function (p) {
        return '<button type="button" class="chip" data-proj="' + U.esc(p) + '">#' + U.esc(p) + "</button>";
      }).join("");
      $("recentProjects").querySelectorAll("[data-proj]").forEach(function (b) {
        b.addEventListener("click", function () { $("projectInput").value = b.dataset.proj; $("taskInput").focus(); });
      });
    });
  }

  /* ---------------------------------------------------------------- init */
  async function init() {
    settings = Object.assign({}, FF_CONFIG.DEFAULTS, U.read("ff_settings", {}));
    applySoundSettings();

    st = U.read(STATE_KEY, null);
    if (!st || !MODES[st.mode]) st = freshState("focus");
    if (!st.clientId) st.clientId = U.uuid();

    bind();
    api.onStatus(syncPill);

    // restore a running timer — and finish it if it ended while the tab was closed
    if (st.running && isCountdown() && elapsed() >= st.plannedSec) {
      var endedAt = new Date(st.runStartedAt + (st.plannedSec - st.elapsedBase) * 1000);
      render();
      complete(endedAt);
    } else if (st.running) {
      startLoop();
    }
    render();
    renderToday();
    refreshToday();
    loadAutocomplete();

    // pull synced settings (sheet) without blocking the UI
    api.getSettings().then(function (s) {
      settings = s; applySoundSettings();
      if (!st.running && elapsed() === 0 && st.mode !== "flow") { st.plannedSec = Math.round(settings[MODES[st.mode].key] * 60); save(); }
      render(); renderToday();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
