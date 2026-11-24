FOCUS FLOW — POMODORO PRO (Google Sheet as the database)
========================================================

Static site — no build step, no server. Same setup style as the PHI quiz:
one config file, one Apps Script, every call goes over JSONP.

FILES
-----
index.html                 Timer page            (URL: /)
analytics/index.html       Analytics page        (URL: /analytics)
css/styles.css             All styles (both pages)
js/config.js               >>> THE ONLY FILE YOU EDIT FOR SETUP <<<
js/api.js                  Data layer: JSONP to Apps Script, offline queue, local mode
js/sound.js                Start / stop / done / hourly sounds (Web Audio, no mp3 files)
js/app.js                  Timer logic
js/analytics.js            Charts, heatmap, day timeline, table
google-apps-script.gs      Paste into Google Sheets -> Extensions -> Apps Script


QUICK TRY (no setup)
--------------------
Leave APPS_SCRIPT_URL empty in js/config.js and open index.html.
It runs in LOCAL MODE (saves to this browser). On /analytics there's a
"Load 6 months of demo data" button so you can see every chart filled in.


SETUP — CONNECT TO GOOGLE SHEETS
--------------------------------
1. Create a new empty Google Sheet.
2. Extensions -> Apps Script. Delete everything, paste google-apps-script.gs.
3. Change  var API_KEY = 'focus-flow-change-me';  to your own secret. Save.
4. In the toolbar function dropdown pick  setup  -> Run -> allow permissions.
   This creates the "Sessions" tab and a "Daily" summary tab (QUERY formula).
5. Deploy -> New deployment -> gear -> Web app
      Execute as: Me        Who has access: Anyone
   Copy the Web app URL.
6. js/config.js:
      APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfy..../exec",
      API_KEY:         "<same secret as step 3>",
7. Open the site. Top-right pill should say "Synced" (green).

After ANY change to the .gs file:
Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy.
(The URL stays the same.)

If a JS/CSS change doesn't show up, bump ?v=1 -> ?v=2 in the <script>/<link>
tags or hard-refresh (Ctrl+Shift+R).


SHEET SCHEMA  ("Sessions" tab)
------------------------------
id | clientId | date | startTime | endTime | durationSec | durationMin | mode |
task | project | completed | pauses | plannedSec | note | device | createdAt

  mode        focus | short | long | flow
  durationSec real focused seconds (pauses are NOT counted)
  completed   TRUE if the timer hit 0 (flow = TRUE when you stop it);
              FALSE = you reset/skipped early (partial session)
  clientId    generated in the browser; used to de-duplicate retries

Settings (durations, goal, sound…) are stored in Script Properties so every
device shares them.


FEATURES
--------
Timer
  - Pomodoro / Short / Long break + FLOW mode (count-up stopwatch for open
    hours of work; ring fills once per hour, optional hourly gong)
  - Timestamp-based: stays accurate in background tabs, survives refresh,
    finishes correctly even if the tab was closed when it hit 0
  - Click the big time to set a custom length for this session
  - Task + project before each focus (autocomplete from past sessions)
  - Long break every N pomodoros, cycle dots, auto-start options
  - SOUNDS: rising chime on Start/Resume, falling chime on Pause/Stop,
    bell arpeggio on completion, ding when a break ends, optional tick,
    hourly gong in Flow. Volume + test buttons in ⚙ Settings.
  - Desktop notifications, screen wake-lock, live countdown in the tab title
  - Today panel: goal bar, streak, this-week total, 12-week mini heatmap
  - Shortcuts: Space start/pause, R reset, S skip, 1-4 modes, T task, M mute
  - Offline-first: sessions queue locally and upload when the sheet is reachable

Analytics (/analytics)
  - Range: 7D / 30D / 90D / 1Y / All / Custom; filter by project and mode
  - KPIs: total (vs previous period), sessions + completion %, daily avg,
    avg session, current/best streak, best day
  - Time series: zero-filled Day / Week / Month buckets, stacked by project,
    7-day moving average + daily-goal line, drag to zoom, shift+drag to pan
  - GitHub-style heatmap (last 12 months or any year), colour = % of daily
    goal; hover for details, click a day to open it below
  - Day timeline: every session placed on a 24h clock for the chosen day
  - Hour-of-day and weekday patterns, project + top-task breakdowns
  - Sessions table: sort, search, inline edit (task/project), delete,
    CSV export — edits and deletes go straight to the sheet

NOTE: like the PHI quiz, API_KEY sits in config.js, so anyone who reads the
page source can see it. It's a convenience gate, not real security.
