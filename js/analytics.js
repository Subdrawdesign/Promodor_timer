/* ============================================================
   FOCUS FLOW — ANALYTICS PAGE
   Loads every session once, then filters + aggregates in the browser.
   ============================================================ */
(function () {
  "use strict";
  var api = FF.api, U = FF.util;
  var $ = function (id) { return document.getElementById(id); };

  /* validated categorical palette (dark surface) — colour follows the project, not its rank */
  var PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9"];
  var OTHER = "#6b6a64";
  var MODE_COLOR = { focus: "rgb(255,0,55)", flow: "rgb(169,112,255)", short: "rgb(0,255,205)", long: "rgb(0,140,255)" };
  var MODE_NAME = { focus: "Pomodoro", flow: "Flow", short: "Short break", long: "Long break" };
  var MODE_SETS = {
    focus: { focus: 1, flow: 1 },
    focusOnly: { focus: 1 },
    flowOnly: { flow: 1 },
    "break": { short: 1, long: 1 }
  };
  var NO_PROJECT = "No project";
  var WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  var settings = Object.assign({}, FF_CONFIG.DEFAULTS, U.read("ff_settings", {}));
  var S = {
    all: [],
    range: "30", from: null, to: null,
    project: "", mode: "focus",
    gran: "day",
    heatYear: "last",
    day: U.dateKey(new Date()),
    sortKey: "startTime", sortDir: -1,
    search: ""
  };
  var projColor = {};
  var charts = {};
  var tip = null;

  /* ---------------------------------------------------------------- helpers */
  function todayKey() { return U.dateKey(new Date()); }
  function hours(sec) { return Math.round(sec / 36) / 100; }
  function projOf(s) { return s.project || NO_PROJECT; }
  function inModes(s) { return !!MODE_SETS[S.mode][s.mode]; }
  function inProject(s) { return !S.project || projOf(s) === S.project; }
  function weekStart(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; }
  function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function daysBetween(a, b) { return Math.round((U.parseKey(b) - U.parseKey(a)) / 864e5) + 1; }
  function fmtDate(key, opts) { return U.parseKey(key).toLocaleDateString(undefined, opts || { weekday: "short", day: "numeric", month: "short", year: "numeric" }); }
  function hhmm(d) { d = new Date(d); return U.pad(d.getHours()) + ":" + U.pad(d.getMinutes()); }

  function computeRange() {
    var to = todayKey(), from;
    if (S.range === "custom") {
      from = $("fromDate").value || U.dateKey(U.addDays(new Date(), -29));
      to = $("toDate").value || to;
      if (from > to) { var t = from; from = to; to = t; }
    } else if (S.range === "all") {
      from = S.all.reduce(function (m, s) { return s.date < m ? s.date : m; }, to);
    } else {
      from = U.dateKey(U.addDays(new Date(), -(Number(S.range) - 1)));
    }
    S.from = from; S.to = to;
  }

  function filtered(from, to) {
    from = from || S.from; to = to || S.to;
    return S.all.filter(function (s) { return s.date >= from && s.date <= to && inModes(s) && inProject(s); });
  }

  function dailyTotals(list) {
    var m = {};
    list.forEach(function (s) { m[s.date] = (m[s.date] || 0) + s.durationSec; });
    return m;
  }

  function streaks(byDay, from, to) {
    var cur = 0, best = 0, run = 0;
    for (var d = U.parseKey(from), end = U.parseKey(to); d <= end; d = U.addDays(d, 1)) {
      if (byDay[U.dateKey(d)]) { run++; if (run > best) best = run; } else run = 0;
    }
    // current streak counted back from today (today itself may still be empty)
    var x = new Date();
    if (!byDay[U.dateKey(x)]) x = U.addDays(x, -1);
    while (byDay[U.dateKey(x)]) { cur++; x = U.addDays(x, -1); }
    return { current: cur, best: best };
  }

  function level(sec) {
    if (!sec) return 0;
    var r = sec / (settings.dailyGoalMin * 60);
    return r < 0.25 ? 1 : r < 0.5 ? 2 : r < 1 ? 3 : 4;
  }

  /* stable project colours: rank projects over ALL focus data once */
  function assignProjectColors() {
    var tot = {};
    S.all.forEach(function (s) { if (s.mode === "focus" || s.mode === "flow") tot[projOf(s)] = (tot[projOf(s)] || 0) + s.durationSec; });
    var ranked = Object.keys(tot).sort(function (a, b) { return tot[b] - tot[a]; });
    projColor = {};
    ranked.forEach(function (p, i) { projColor[p] = i < PALETTE.length ? PALETTE[i] : OTHER; });
    var sel = $("projectFilter"), cur = sel.value;
    sel.innerHTML = '<option value="">All projects</option>' + ranked.map(function (p) {
      return '<option value="' + U.esc(p) + '">' + U.esc(p) + "</option>";
    }).join("");
    sel.value = ranked.indexOf(cur) >= 0 ? cur : "";
    S.project = sel.value;
  }

  /* ---------------------------------------------------------------- tooltip */
  function showTip(e, html) {
    if (!tip) { tip = document.createElement("div"); tip.className = "chart-tip"; document.body.appendChild(tip); }
    tip.innerHTML = html; tip.hidden = false;
    var r = e.target.getBoundingClientRect();
    tip.style.left = (r.left + r.width / 2) + "px";
    tip.style.top = r.top + "px";
  }
  function hideTip() { if (tip) tip.hidden = true; }

  /* ---------------------------------------------------------------- KPIs */
  function renderKpis() {
    var list = filtered();
    var total = list.reduce(function (a, s) { return a + s.durationSec; }, 0);
    var n = list.length;
    var days = daysBetween(S.from, S.to);
    var byDay = dailyTotals(list);
    var active = Object.keys(byDay).length;

    // previous period of the same length
    var pTo = U.dateKey(U.addDays(U.parseKey(S.from), -1));
    var pFrom = U.dateKey(U.addDays(U.parseKey(S.from), -days));
    var prev = filtered(pFrom, pTo).reduce(function (a, s) { return a + s.durationSec; }, 0);
    var delta = prev ? Math.round((total - prev) / prev * 100) : null;

    var completed = list.filter(function (s) { return s.completed; }).length;
    var longest = list.reduce(function (m, s) { return Math.max(m, s.durationSec); }, 0);

    var allFocus = dailyTotals(S.all.filter(function (s) { return inModes(s) && inProject(s); }));
    var earliest = Object.keys(allFocus).sort()[0] || todayKey();
    var st = streaks(allFocus, earliest, todayKey());

    var bestKey = null;
    Object.keys(byDay).forEach(function (k) { if (!bestKey || byDay[k] > byDay[bestKey]) bestKey = k; });

    var k = [
      { l: "Total time", v: U.fmtDur(total),
        s: delta === null ? "no data in previous period" : '<span class="' + (delta >= 0 ? "up" : "down") + '">' + (delta >= 0 ? "▲ " : "▼ ") + Math.abs(delta) + "%</span> vs previous " + days + "d" },
      { l: "Sessions", v: n, s: n ? Math.round(completed / n * 100) + "% completed" : "—" },
      { l: "Daily average", v: U.fmtDur(total / days), s: active + " of " + days + " days active" },
      { l: "Avg session", v: n ? U.fmtDur(total / n) : "—", s: "longest " + U.fmtDur(longest) },
      { l: "Streak", v: st.current + (st.current === 1 ? " day" : " days"), s: "best ever " + st.best + " days" },
      { l: "Best day", v: bestKey ? U.fmtDur(byDay[bestKey]) : "—", s: bestKey ? fmtDate(bestKey, { day: "numeric", month: "short", year: "numeric" }) : "—" }
    ];
    $("kpis").innerHTML = k.map(function (x) {
      return '<div class="kpi"><div class="k-label">' + x.l + '</div><div class="k-val">' + x.v + '</div><div class="k-sub">' + x.s + "</div></div>";
    }).join("");
  }

  /* ---------------------------------------------------------------- time series */
  function bucketKey(dateKey) {
    var d = U.parseKey(dateKey);
    if (S.gran === "week") return U.dateKey(weekStart(d));
    if (S.gran === "month") return U.dateKey(monthStart(d));
    return dateKey;
  }

  function renderTimeSeries() {
    var list = filtered();
    // all buckets between from and to (zero-filled — a real time series has no gaps)
    var buckets = [], seen = {};
    for (var d = U.parseKey(S.from), end = U.parseKey(S.to); d <= end; d = U.addDays(d, 1)) {
      var bk = bucketKey(U.dateKey(d));
      if (!seen[bk]) { seen[bk] = 1; buckets.push(bk); }
    }

    // which series: projects (stable colours) folded into Other past the palette
    var groupOf, groups = {}, order = [];
    if (S.mode === "break") groupOf = function (s) { return MODE_NAME[s.mode]; };
    else groupOf = function (s) { var p = projOf(s); return projColor[p] && projColor[p] !== OTHER ? p : "Other"; };

    var sums = {};
    list.forEach(function (s) {
      var g = groupOf(s), b = bucketKey(s.date);
      if (!groups[g]) { groups[g] = 0; order.push(g); }
      groups[g] += s.durationSec;
      sums[g] = sums[g] || {};
      sums[g][b] = (sums[g][b] || 0) + s.durationSec;
    });
    order.sort(function (a, b) {
      if (a === "Other") return 1; if (b === "Other") return -1;
      return groups[b] - groups[a];
    });

    var datasets = order.map(function (g) {
      var color = S.mode === "break" ? (g === "Short break" ? "#199e70" : "#3987e5") : (g === "Other" ? OTHER : projColor[g]);
      return {
        type: "bar", label: g, stack: "t",
        data: buckets.map(function (b) { return { x: U.parseKey(b).getTime(), y: hours((sums[g] || {})[b] || 0) }; }),
        backgroundColor: color, borderColor: "#1a1a19", borderWidth: { top: 2 }, borderSkipped: "bottom",
        borderRadius: 3, maxBarThickness: 38, order: 2
      };
    });

    var totals = buckets.map(function (b) {
      return order.reduce(function (a, g) { return a + ((sums[g] || {})[b] || 0); }, 0);
    });

    if (S.gran === "day" && buckets.length >= 7) {
      datasets.push({
        type: "line", label: "7-day average", stack: "avg",
        data: buckets.map(function (b, i) {
          var from = Math.max(0, i - 6), sum = 0;
          for (var j = from; j <= i; j++) sum += totals[j];
          return { x: U.parseKey(b).getTime(), y: hours(sum / (i - from + 1)) };
        }),
        borderColor: "#f0efec", backgroundColor: "#f0efec", borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
        tension: 0.35, order: 1
      });
    }
    if (S.gran === "day" && S.mode !== "break") {
      datasets.push({
        type: "line", label: "Daily goal", stack: "goal",
        data: buckets.map(function (b) { return { x: U.parseKey(b).getTime(), y: hours(settings.dailyGoalMin * 60) }; }),
        borderColor: "#8b8a83", borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, order: 0
      });
    }

    var unitLabel = { day: "hours per day", week: "hours per week", month: "hours per month" }[S.gran];
    $("tsHint").textContent = unitLabel + (S.mode === "break" ? "" : " · stacked by project") + " · drag to zoom, shift+drag to pan";

    if (charts.ts) charts.ts.destroy();
    charts.ts = new Chart($("tsChart"), {
      data: { datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            type: "time", stacked: true, offset: true,
            time: { unit: S.gran, tooltipFormat: S.gran === "month" ? "MMM yyyy" : S.gran === "week" ? "'Week of' d MMM yyyy" : "EEE, d MMM yyyy",
                    displayFormats: { day: "d MMM", week: "d MMM", month: "MMM yy" } },
            grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 14 }
          },
          y: { stacked: true, beginAtZero: true, title: { display: true, text: "hours" }, grid: { color: "#262624" }, border: { display: false } }
        },
        plugins: {
          legend: { position: "top", align: "start", labels: { boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3, padding: 14 } },
          tooltip: {
            backgroundColor: "#0b0b0b", borderColor: "#383835", borderWidth: 1, padding: 10,
            filter: function (it) { return it.dataset.type === "line" || it.parsed.y > 0; },
            callbacks: {
              label: function (c) { return " " + c.dataset.label + ": " + U.fmtDur(c.parsed.y * 3600); },
              footer: function (items) {
                var t = items.filter(function (i) { return i.dataset.type === "bar"; }).reduce(function (a, i) { return a + i.parsed.y; }, 0);
                return "Total: " + U.fmtDur(t * 3600);
              }
            }
          },
          zoom: {
            zoom: { drag: { enabled: true, backgroundColor: "rgba(76,73,237,0.15)", borderColor: "#4c49ed", borderWidth: 1 }, pinch: { enabled: true }, mode: "x" },
            pan: { enabled: true, mode: "x", modifierKey: "shift" },
            limits: { x: { min: "original", max: "original", minRange: 864e5 * 3 } }
          }
        },
        onClick: function (evt, els) {
          if (!els.length || S.gran !== "day") return;
          var x = charts.ts.data.datasets[els[0].datasetIndex].data[els[0].index].x;
          selectDay(U.dateKey(new Date(x)), true);
        }
      }
    });
  }

  /* ---------------------------------------------------------------- heatmap */
  function heatRange() {
    if (S.heatYear === "last") {
      var to = new Date();
      return { from: U.dateKey(U.addDays(to, -364)), to: U.dateKey(to) };
    }
    return { from: S.heatYear + "-01-01", to: S.heatYear + "-12-31" };
  }

  function renderHeatYears() {
    var years = {};
    S.all.forEach(function (s) { years[s.date.slice(0, 4)] = 1; });
    years[String(new Date().getFullYear())] = 1;
    var sel = $("heatYear");
    sel.innerHTML = '<option value="last">Last 12 months</option>' + Object.keys(years).sort().reverse().map(function (y) {
      return '<option value="' + y + '">' + y + "</option>";
    }).join("");
    sel.value = S.heatYear;
  }

  function renderHeatmap() {
    var r = heatRange();
    var list = S.all.filter(function (s) { return s.date >= r.from && s.date <= r.to && inModes(s) && inProject(s); });
    var byDay = dailyTotals(list), count = {};
    list.forEach(function (s) { count[s.date] = (count[s.date] || 0) + 1; });

    var startD = weekStart(U.parseKey(r.from));
    var endD = U.parseKey(r.to);
    var todayD = U.parseKey(todayKey());
    var nCols = Math.floor(Math.round((endD - startD) / 864e5) / 7) + 1;
    var cells = "", months = "", prevMonth = -1, lastLabelCol = -9;

    for (var c = 0; c < nCols; c++) {
      var monday = U.addDays(startD, c * 7);
      // month label at the first week whose Monday falls in a new month (GitHub style)
      var labelDay = c === 0 ? U.parseKey(r.from) : monday;
      if (labelDay.getMonth() !== prevMonth) {
        var tooLate = c === 0 && labelDay.getDate() > 20;   // first month barely visible -> skip its label
        if (c - lastLabelCol >= 3 && !tooLate) {
          months += '<span style="left:' + (c / nCols * 100) + '%">' + labelDay.toLocaleDateString(undefined, { month: "short" }) + "</span>";
          lastLabelCol = c;
        }
        prevMonth = labelDay.getMonth();
      }
      for (var w = 0; w < 7; w++) {
        var d = U.addDays(monday, w);
        var key = U.dateKey(d);
        var outside = key < r.from || key > r.to || d > todayD;
        var sec = byDay[key] || 0;
        cells += '<i class="lv' + (outside ? "-1" : level(sec)) + (key === S.day ? " sel" : "") + '" data-d="' + key + '"' +
          (outside ? "" : ' data-s="' + sec + '" data-n="' + (count[key] || 0) + '"') + "></i>";
      }
    }

    $("heatmap").innerHTML =
      '<div class="heat-days"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span>Sun</span></div>' +
      '<div class="heat-main"><div class="heat-months">' + months + '</div><div class="heat-grid" style="grid-template-columns:repeat(' + nCols + ',1fr)">' + cells + "</div></div>";

    var total = list.reduce(function (a, s) { return a + s.durationSec; }, 0);
    var st = streaks(byDay, r.from, r.to);
    $("heatSummary").textContent = U.fmtDur(total) + " · " + Object.keys(byDay).length + " active days · longest streak " + st.best + " days";
    var g = settings.dailyGoalMin * 60;
    $("heatLegendText").textContent = "0 · <" + U.fmtDur(g * 0.25) + " · <" + U.fmtDur(g * 0.5) + " · <" + U.fmtDur(g) + " · ≥ " + U.fmtDur(g) + " (daily goal)";

    var grid = $("heatmap").querySelector(".heat-grid");
    grid.addEventListener("mouseover", function (e) {
      var c = e.target.closest("i[data-s]"); if (!c) return;
      var sec = +c.dataset.s, n = +c.dataset.n;
      showTip(e, "<b>" + (sec ? U.fmtDur(sec) : "No focus") + (n ? " · " + n + " session" + (n > 1 ? "s" : "") : "") + "</b><span>" + fmtDate(c.dataset.d) + "</span>");
    });
    grid.addEventListener("mouseleave", hideTip);
    grid.addEventListener("click", function (e) {
      var c = e.target.closest("i[data-s]"); if (c) selectDay(c.dataset.d, true);
    });
  }

  /* ---------------------------------------------------------------- day timeline */
  function selectDay(key, scroll) {
    S.day = key;
    renderDay();
    document.querySelectorAll(".heat-grid i.sel").forEach(function (x) { x.classList.remove("sel"); });
    var c = document.querySelector('.heat-grid i[data-d="' + key + '"]'); if (c) c.classList.add("sel");
    if (scroll) $("dayCard").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderDay() {
    var key = S.day;
    $("dayPick").value = key;
    var list = S.all.filter(function (s) { return s.date === key; })
      .sort(function (a, b) { return a.startTime < b.startTime ? -1 : 1; });
    var focus = list.filter(function (s) { return s.mode === "focus" || s.mode === "flow"; });
    var fsec = focus.reduce(function (a, s) { return a + s.durationSec; }, 0);
    var bsec = list.filter(function (s) { return s.mode === "short" || s.mode === "long"; }).reduce(function (a, s) { return a + s.durationSec; }, 0);
    var goalPct = Math.round(fsec / (settings.dailyGoalMin * 60) * 100);

    $("dayHead").innerHTML = "<b>" + fmtDate(key, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) + "</b>" +
      '<span class="muted">' + (list.length
        ? U.fmtDur(fsec) + " focus · " + focus.length + " sessions · " + U.fmtDur(bsec) + " breaks · " +
          hhmm(list[0].startTime) + "–" + hhmm(list[list.length - 1].endTime || list[list.length - 1].startTime) + " · " + goalPct + "% of goal"
        : "nothing tracked") + "</span>";

    // visible window: at least 07:00–22:00, widened to fit sessions
    var dayStart = U.parseKey(key).getTime();
    var minH = 7, maxH = 22;
    list.forEach(function (s) {
      var a = (new Date(s.startTime).getTime() - dayStart) / 36e5;
      var b = (new Date(s.endTime || s.startTime).getTime() - dayStart) / 36e5;
      minH = Math.min(minH, Math.floor(Math.max(0, a)));
      maxH = Math.max(maxH, Math.ceil(Math.min(24, b)));
    });
    var span = maxH - minH;
    function pos(h) { return ((h - minH) / span * 100); }

    var html = "", axis = "";
    for (var h = minH; h <= maxH; h++) {
      if (h > minH && h < maxH) html += '<div class="tl-hour" style="left:' + pos(h) + '%"></div>';
      if ((h - minH) % (span > 12 ? 2 : 1) === 0) axis += '<span style="left:' + pos(h) + '%">' + U.pad(h % 24) + ":00</span>";
    }
    list.forEach(function (s, i) {
      var a = Math.max(minH, (new Date(s.startTime).getTime() - dayStart) / 36e5);
      var b = Math.min(maxH, (new Date(s.endTime || s.startTime).getTime() - dayStart) / 36e5);
      if (b <= a) b = a + s.durationSec / 3600;
      html += '<div class="tl-block" data-i="' + i + '" style="left:' + pos(a) + "%;width:" + Math.max(0.3, pos(b) - pos(a)) + "%;background:" + MODE_COLOR[s.mode] + '"></div>';
    });
    if (key === todayKey()) {
      var nowH = (Date.now() - dayStart) / 36e5;
      if (nowH > minH && nowH < maxH) html += '<div class="tl-now" style="left:' + pos(nowH) + '%" title="now"></div>';
    }
    $("timeline").innerHTML = html;
    $("tlAxis").innerHTML = axis;

    $("timeline").onmouseover = function (e) {
      var b = e.target.closest(".tl-block"); if (!b) return;
      var s = list[+b.dataset.i];
      showTip(e, "<b>" + U.esc(s.task || MODE_NAME[s.mode]) + " · " + U.fmtDur(s.durationSec) + "</b><span>" +
        MODE_NAME[s.mode] + (s.project ? " · " + U.esc(s.project) : "") + " · " + hhmm(s.startTime) + "–" + hhmm(s.endTime) +
        (s.completed ? " · ✓" : "") + "</span>");
    };
    $("timeline").onmouseleave = hideTip;

    var dl = $("dayList");
    dl.innerHTML = list.length ? list.slice().reverse().map(function (s) {
      return '<li class="m-' + s.mode + '"><span class="sl-time">' + hhmm(s.startTime) + '</span><span class="sl-main"><b>' +
        U.esc(s.task || MODE_NAME[s.mode]) + "</b>" + (s.project ? "<em>" + U.esc(s.project) + "</em>" : "<em>" + MODE_NAME[s.mode] + "</em>") +
        '</span><span class="sl-dur">' + U.fmtDur(s.durationSec) + (s.completed ? " ✓" : "") + "</span></li>";
    }).join("") : '<li class="empty">No sessions on this day</li>';
  }

  /* ---------------------------------------------------------------- distributions */
  function baseBarOptions(yTitle, tooltipLabel) {
    return {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 6 } },
        y: { beginAtZero: true, title: { display: true, text: yTitle }, grid: { color: "#262624" }, border: { display: false } }
      },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: "#0b0b0b", borderColor: "#383835", borderWidth: 1, padding: 10,
          callbacks: { label: tooltipLabel } }
      }
    };
  }

  function renderHourChart() {
    var list = filtered();
    var perHour = new Array(24).fill(0);
    // spread each session across the clock hours it actually covered
    list.forEach(function (s) {
      var t = new Date(s.startTime).getTime(), left = s.durationSec;
      while (left > 0) {
        var d = new Date(t);
        var toNextHour = 3600 - (d.getMinutes() * 60 + d.getSeconds());
        var chunk = Math.min(left, toNextHour);
        perHour[d.getHours()] += chunk;
        left -= chunk; t += chunk * 1000;
      }
    });
    if (charts.hour) charts.hour.destroy();
    charts.hour = new Chart($("hourChart"), {
      type: "bar",
      data: {
        labels: perHour.map(function (_, h) { return U.pad(h); }),
        datasets: [{ label: "Focus", data: perHour.map(hours), backgroundColor: "#3987e5", borderRadius: 4, borderSkipped: "bottom", maxBarThickness: 22 }]
      },
      options: baseBarOptions("hours", function (c) { return " " + U.fmtDur(c.parsed.y * 3600) + " between " + c.label + ":00–" + U.pad((+c.label + 1) % 24) + ":00"; })
    });
  }

  function renderWeekdayChart() {
    var list = filtered();
    var sum = new Array(7).fill(0), cnt = new Array(7).fill(0);
    for (var d = U.parseKey(S.from), end = U.parseKey(S.to); d <= end; d = U.addDays(d, 1)) cnt[(d.getDay() + 6) % 7]++;
    list.forEach(function (s) { sum[(U.parseKey(s.date).getDay() + 6) % 7] += s.durationSec; });
    var avg = sum.map(function (v, i) { return cnt[i] ? v / cnt[i] : 0; });
    if (charts.wd) charts.wd.destroy();
    charts.wd = new Chart($("weekdayChart"), {
      type: "bar",
      data: { labels: WD, datasets: [{ label: "Average", data: avg.map(hours), backgroundColor: "#3987e5", borderRadius: 4, borderSkipped: "bottom", maxBarThickness: 44 }] },
      options: baseBarOptions("avg hours", function (c) { return " avg " + U.fmtDur(c.parsed.y * 3600) + " on " + c.label + "s (" + cnt[c.dataIndex] + " in range)"; })
    });
  }

  function barRows(entries, colorFn) {
    var max = entries.length ? entries[0][1] : 1;
    var total = entries.reduce(function (a, e) { return a + e[1]; }, 0) || 1;
    return entries.map(function (e) {
      return '<div class="bar-row"><span class="name" title="' + U.esc(e[0]) + '">' + U.esc(e[0]) + '</span>' +
        '<span class="track"><span class="fill" style="display:block;width:' + (e[1] / max * 100) + "%;background:" + colorFn(e[0]) + '"></span></span>' +
        '<span class="val">' + U.fmtDur(e[1]) + ' <span class="muted">' + Math.round(e[1] / total * 100) + "%</span></span></div>";
    }).join("") || '<p class="muted">No data in this range</p>';
  }

  function renderBreakdowns() {
    var list = filtered();
    var p = {}, t = {};
    list.forEach(function (s) {
      p[projOf(s)] = (p[projOf(s)] || 0) + s.durationSec;
      var tk = s.task || "(no task)";
      t[tk] = (t[tk] || 0) + s.durationSec;
    });
    var pe = Object.entries(p).sort(function (a, b) { return b[1] - a[1]; });
    var te = Object.entries(t).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);
    $("projHint").textContent = pe.length + " project" + (pe.length === 1 ? "" : "s");
    $("projectBars").innerHTML = barRows(pe, function (name) { return projColor[name] || OTHER; });
    $("taskBars").innerHTML = barRows(te, function () { return "#3987e5"; });
  }

  /* ---------------------------------------------------------------- table */
  function renderTable() {
    var q = S.search.toLowerCase();
    var list = filtered().filter(function (s) {
      return !q || (s.task || "").toLowerCase().indexOf(q) >= 0 || (s.project || "").toLowerCase().indexOf(q) >= 0;
    });
    var k = S.sortKey, dir = S.sortDir;
    list.sort(function (a, b) {
      var x = a[k], y = b[k];
      if (typeof x === "string") { x = x.toLowerCase(); y = String(y || "").toLowerCase(); }
      return (x > y ? 1 : x < y ? -1 : 0) * dir;
    });
    var shown = list.slice(0, 500);
    $("tableHint").textContent = list.length > 500 ? "showing 500 of " + list.length : list.length + " sessions";
    $("tableBody").innerHTML = shown.map(function (s) {
      var d = new Date(s.startTime);
      return '<tr data-id="' + U.esc(s.clientId) + '">' +
        "<td>" + d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit" }) + " " + hhmm(d) + "</td>" +
        '<td><span class="mode-pill ' + s.mode + '">' + MODE_NAME[s.mode] + "</span></td>" +
        '<td class="task" data-f="task">' + U.esc(s.task || "—") + "</td>" +
        '<td data-f="project">' + (s.project ? '<span class="legend"><span><i style="background:' + (projColor[s.project] || OTHER) + '"></i>' + U.esc(s.project) + "</span></span>" : '<span class="muted">—</span>') + "</td>" +
        '<td class="num">' + U.fmtDur(s.durationSec) + "</td>" +
        "<td>" + (s.completed ? "✓" : '<span class="muted">partial</span>') + "</td>" +
        '<td class="num">' + (s.pauses || 0) + "</td>" +
        '<td class="row-actions"><button data-act="edit" title="Edit task / project">✎</button><button data-act="del" title="Delete">🗑</button></td></tr>';
    }).join("") || '<tr><td colspan="8" class="muted" style="text-align:center;padding:2rem">No sessions match</td></tr>';

    document.querySelectorAll("th[data-sort]").forEach(function (th) {
      var base = th.textContent.replace(/ [↑↓]$/, "");
      th.textContent = base + (th.dataset.sort === S.sortKey ? (S.sortDir < 0 ? " ↓" : " ↑") : "");
    });
  }

  function editRow(tr) {
    var id = tr.dataset.id;
    var s = S.all.find(function (x) { return x.clientId === id; }); if (!s) return;
    var tTd = tr.querySelector('[data-f="task"]'), pTd = tr.querySelector('[data-f="project"]');
    tTd.innerHTML = '<input class="inline-input" value="' + U.esc(s.task) + '" maxlength="300">';
    pTd.innerHTML = '<input class="inline-input" value="' + U.esc(s.project) + '" maxlength="80">';
    var ti = tTd.firstChild, pi = pTd.firstChild;
    ti.focus();
    function commit() {
      var task = ti.value.trim(), project = pi.value.trim();
      if (task === s.task && project === s.project) { renderAll(); return; }
      s.task = task; s.project = project;
      api.updateSession(id, { task: task, project: project })
        .then(function () { U.toast("Updated ✓", "ok"); })
        .catch(function (e) { U.toast("Update failed: " + e.message, "err"); });
      assignProjectColors(); renderAll();
    }
    [ti, pi].forEach(function (inp) {
      inp.addEventListener("keydown", function (e) {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") renderTable();
      });
    });
    pi.addEventListener("blur", function () { setTimeout(function () { if (document.activeElement !== ti) commit(); }, 50); });
  }

  function deleteRow(tr) {
    var id = tr.dataset.id;
    var s = S.all.find(function (x) { return x.clientId === id; }); if (!s) return;
    if (!confirm("Delete this " + U.fmtDur(s.durationSec) + " session" + (s.task ? ' "' + s.task + '"' : "") + "? This also removes the row from the sheet.")) return;
    S.all = S.all.filter(function (x) { return x.clientId !== id; });
    renderAll();
    api.deleteSession(id).then(function () { U.toast("Deleted", "ok"); })
      .catch(function (e) { U.toast("Delete failed: " + e.message, "err"); load(); });
  }

  function exportCsv() {
    var cols = ["date", "startTime", "endTime", "durationSec", "mode", "task", "project", "completed", "pauses", "plannedSec", "device", "clientId"];
    var rows = filtered().sort(function (a, b) { return a.startTime < b.startTime ? -1 : 1; });
    var csv = [cols.join(",")].concat(rows.map(function (s) {
      return cols.map(function (c) { var v = s[c] == null ? "" : String(s[c]); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(",");
    })).join("\n");
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "focus-flow_" + S.from + "_to_" + S.to + ".csv";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------------------------------------------------------------- orchestration */
  function renderAll() {
    computeRange();
    var empty = !S.all.length;
    $("emptyState").hidden = !empty;
    $("dash").hidden = empty;
    $("demoBtn").hidden = api.isRemote;
    if (empty) return;
    renderKpis();
    renderTimeSeries();
    renderHeatmap();
    renderDay();
    renderHourChart();
    renderWeekdayChart();
    renderBreakdowns();
    renderTable();
  }

  function load() {
    $("loading").hidden = false;
    return api.getSessions("0000-00-00", "9999-12-31").then(function (list) {
      S.all = list.filter(function (s) { return s && s.date && MODE_NAME[s.mode]; })
        .map(function (s) { s.durationSec = Number(s.durationSec) || 0; return s; });
      if (list.fromCache) U.toast("Offline — showing cached data", "err");
      assignProjectColors();
      renderHeatYears();
      renderAll();
    }).finally(function () { $("loading").hidden = true; });
  }

  function syncPill(status, q) {
    var p = $("syncPill");
    p.dataset.status = status;
    var label = { local: "Local", online: "Synced", syncing: "Syncing…", offline: "Offline" }[status] || status;
    if (q && status !== "local") label += " · " + q + " queued";
    p.querySelector("b").textContent = label;
  }

  function bind() {
    $("rangeSeg").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      S.range = b.dataset.range;
      this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("active", x === b); });
      $("customRange").hidden = S.range !== "custom";
      if (S.range === "custom" && !$("fromDate").value) {
        $("fromDate").value = U.dateKey(U.addDays(new Date(), -29)); $("toDate").value = todayKey();
      }
      if (S.range === "365" || S.range === "all") { if (S.gran === "day") setGran("week"); }
      renderAll();
    });
    ["fromDate", "toDate"].forEach(function (id) { $(id).addEventListener("change", renderAll); });
    $("granSeg").addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) { setGran(b.dataset.gran); renderTimeSeries(); } });
    $("projectFilter").addEventListener("change", function () { S.project = this.value; renderAll(); });
    $("modeFilter").addEventListener("change", function () { S.mode = this.value; renderAll(); });
    $("heatYear").addEventListener("change", function () { S.heatYear = this.value; renderHeatmap(); });
    $("refreshBtn").addEventListener("click", function () { api.flush().then(load); });
    $("csvBtn").addEventListener("click", exportCsv);
    $("resetZoom").addEventListener("click", function () { if (charts.ts && charts.ts.resetZoom) charts.ts.resetZoom(); });

    $("dayPick").addEventListener("change", function () { if (this.value) selectDay(this.value); });
    $("dayPrev").addEventListener("click", function () { selectDay(U.dateKey(U.addDays(U.parseKey(S.day), -1))); });
    $("dayNext").addEventListener("click", function () { selectDay(U.dateKey(U.addDays(U.parseKey(S.day), 1))); });
    $("dayToday").addEventListener("click", function () { selectDay(todayKey()); });

    $("tableSearch").addEventListener("input", function () { S.search = this.value; renderTable(); });
    document.querySelectorAll("th[data-sort]").forEach(function (th) {
      th.addEventListener("click", function () {
        if (S.sortKey === th.dataset.sort) S.sortDir *= -1; else { S.sortKey = th.dataset.sort; S.sortDir = th.dataset.sort === "startTime" || th.dataset.sort === "durationSec" ? -1 : 1; }
        renderTable();
      });
    });
    $("tableBody").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-act]"); if (!b) return;
      var tr = b.closest("tr");
      if (b.dataset.act === "edit") editRow(tr); else deleteRow(tr);
    });

    $("demoBtn").addEventListener("click", function () {
      api.seedDemo().then(function (n) { U.toast("Added " + n + " demo sessions", "ok"); load(); });
    });

    window.addEventListener("scroll", hideTip, { passive: true });
  }

  function setGran(g) {
    S.gran = g;
    $("granSeg").querySelectorAll("button").forEach(function (x) { x.classList.toggle("active", x.dataset.gran === g); });
  }

  function initChartDefaults() {
    if (!window.Chart) return;
    Chart.defaults.color = "#c3c2b7";
    Chart.defaults.borderColor = "#2c2c2a";
    Chart.defaults.font.family = "Inter, -apple-system, sans-serif";
    Chart.defaults.font.size = 12;
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!window.Chart) {
      $("loading").hidden = true;
      $("dash").innerHTML = '<div class="card empty-state"><h3>Charts could not load</h3><p>Chart.js comes from cdn.jsdelivr.net — check your internet connection.</p></div>';
      return;
    }
    initChartDefaults();
    bind();
    api.onStatus(syncPill);
    if (api.isRemote) api.meta().then(function (r) { if (r.sheetUrl) { $("sheetBtn").href = r.sheetUrl; $("sheetBtn").hidden = false; } });
    api.getSettings().then(function (s) { settings = s; });
    load();
  });
})();
