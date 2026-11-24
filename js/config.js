/* ============================================================
   FOCUS FLOW — SINGLE CONFIG FILE
   >>> THIS IS THE ONLY FILE YOU EDIT FOR SETUP <<<
   Both the timer (index.html) and /analytics read from here.
   ============================================================ */

window.FF_CONFIG = {


  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbwY2xifXeIdHY7d2DaQKJZqnVnOJ4wwIMrGxcpYSCsSKvP-5P2sBhWGxcdjhhjisOVF/exec",

  API_KEY: "focus-flow-change-me",

  /* 3. Defaults for a fresh install (users can change them in ⚙ Settings) */
  DEFAULTS: {
    focusMin: 25,
    shortMin: 5,
    longMin: 15,
    longEvery: 4,            // long break after every N focus sessions
    autoStartBreaks: true,
    autoStartFocus: false,
    askTask: true,           // ask "what are you working on?" before focus
    dailyGoalMin: 180,       // used for the goal ring + heatmap colour levels
    sound: true,
    volume: 0.6,
    tick: false,             // soft tick each second during focus
    hourlyChime: true,       // chime every full hour in Flow (stopwatch) mode
    notifications: true,
    minLogSec: 60            // sessions shorter than this are not saved
  }
};
