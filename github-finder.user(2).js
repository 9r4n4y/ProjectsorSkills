// ==UserScript==
// @name         GitHub Finder
// @namespace    https://github.com/github-finder-userscript
// @version      1.0.0
// @description  macOS Finder–style file manager overlay for any GitHub repository. Browse, create, rename, edit, move, upload, download and delete files with an instant optimistic UI — powered by the GitHub REST API.
// @author       GitHub Finder
// @license      MIT
// @match        https://github.com/*
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.github.com
// @run-at       document-idle
// ==/UserScript==

/*
 * ─────────────────────────────────────────────────────────────────────────────
 *  GITHUB FINDER — macOS Finder for GitHub repositories
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  SETUP
 *    1. Install the Tampermonkey browser extension (https://www.tampermonkey.net).
 *    2. Tampermonkey icon → "Create a new script" → paste this entire file → Save.
 *    3. Open any GitHub repository page and click the blue folder badge
 *       (bottom-right), or press Alt+Shift+F, or use the Tampermonkey menu.
 *    4. In the settings panel, create a Personal Access Token at
 *       https://github.com/settings/tokens (classic token with the "repo"
 *       scope — fine-grained tokens need "Contents: Read and write").
 *       Paste it and click "Save & Connect".
 *
 *  HOW IT WORKS
 *    • The full repository tree is loaded once via git/trees?recursive=1 and
 *      kept as a single in-memory tree model. Every render is derived from it.
 *    • All mutations (create / rename / move / delete / duplicate / upload /
 *      edit) are OPTIMISTIC: the model is patched locally within the same
 *      frame, the change is visible immediately, and only then is the API
 *      commit fired. If the server rejects it, the exact prior state is
 *      restored and an error toast explains why.
 *    • Mutations are committed atomically through the Git Data API
 *      (blobs → tree → commit → ref) so folder moves/deletes of any size are
 *      a single commit that re-uses existing tree/blob SHAs.
 *    • Your token is stored ONLY in Tampermonkey storage (GM_setValue). It is
 *      never written to the DOM, never logged, and only ever sent as an
 *      Authorization header to api.github.com.
 *
 *  ARCHITECTURE (search for the section banners)
 *    §2 CSS            – all styling, light + dark via CSS variables
 *    §3 Icons          – inline SVG icon set (SF-Symbols style)
 *    §4 Store/DOM      – persistence wrappers + DOM builder helpers + state
 *    §5 Core (pure)    – formats, paths, base64, CRC32/ZIP, syntax highlight
 *    §6 Tree model     – RepoTree with surgical mutations + undo journals
 *    §7 GitHub API     – request layer, rate-limit handling, retry/backoff,
 *                        atomic gitCommit()
 *    §8 Toast/Dialog/Menu frameworks
 *    §9 Window shell   – chrome, drag, resize, traffic lights, launcher
 *    §10 Virtual list  – windowed renderer for 10k+ items at 60fps
 *    §11 Renderers     – sidebar / main pane / breadcrumbs / status bar,
 *                        navigation + selection + live search
 *    §12 Operations    – optimistic file/folder operations
 *    §13 Drag & drop   – internal moves (rAF pointer drag) + file uploads
 *    §14 Menus         – context menus + toolbar menus
 *    §15 Sheets        – settings, code editor, preview, move picker
 *    §16 Keys & boot   – keyboard shortcuts, SPA navigation watcher, init
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  if (window.__GHF_LOADED__) return; // guard against double injection
  window.__GHF_LOADED__ = true;

  /* ══════════════════════════ §1 CONSTANTS ══════════════════════════ */

  const CFG = {
    id: 'ghf-root',
    API: 'https://api.github.com',
    API_VERSION: '2022-11-28',
    MIN_W: 640, MIN_H: 420, DEF_W: 980, DEF_H: 640,
    ROW_H: 30, ROW_H_SEARCH: 46, CELL_H: 118, CELL_W: 104,
    SIDE_CHUNK: 300,          // sidebar children rendered before "show all"
    OVERSCAN: 6,              // virtual list overscan rows
    SEARCH_CAP: 5000,         // max search results rendered
    ZIP_FILE_CAP: 400,        // confirm before zipping more files
    ZIP_BYTE_CAP: 150 * 1024 * 1024,
    BLOB_WARN: 25 * 1024 * 1024,   // warn above
    BLOB_MAX: 95 * 1024 * 1024,    // refuse above (GitHub hard limit ~100MB)
    EDIT_MAX: 2 * 1024 * 1024,     // max size opened in the editor
    HL_MAX: 600000,                // max chars syntax-highlighted
    FETCH_CONCURRENCY: 5,
    REQ_TIMEOUT: 30000,
    Z: { launcher: 2147479900, pill: 2147479950, win: 2147480000,
         modal: 2147480500, menu: 2147480800, toast: 2147480900, ghost: 2147480950 },
    RATE_COOLDOWN_KEY: 'ghf:rateCooldownUntil',
  };

  // Top-level GitHub paths that are never repositories.
  const RESERVED_TOP = new Set(('settings notifications explore marketplace topics trending collections ' +
    'events about pricing security features enterprise team organizations orgs new login join sessions ' +
    'password sync hooks integrations customer-stories sponsors gists gist readmes site-policy git-guides ' +
    'account features codespaces copilot education government community greenhouse opensource osi ' +
    'services atom hub games works-with profile community-guidelines global-campus campus experts ' +
    'security-lab github-sponsors discussions pages careers trust incidents chicory awards').split(' '));

  // Second-segment paths that are user-profile tabs, not repo names.
  const RESERVED_SECOND = new Set(
    'followers following stars sponsors gists projects packages pulse network graphs actions security wiki settings generate codespaces tab'.split(' '));

  const MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif', bmp: 'image/bmp',
    pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', json: 'application/json',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', css: 'text/css',
    js: 'text/javascript', ts: 'text/plain', py: 'text/x-python', sh: 'text/x-sh',
  };

  /* ══════════════════════════ §2 CSS ══════════════════════════
     All styling lives here. Light/dark themes via [data-theme] + CSS vars.
     Every animation uses only transform/opacity (GPU friendly). */

  const CSS = `
.ghf-root, .ghf-root * { box-sizing: border-box; margin: 0; padding: 0; }
.ghf-root {
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue",
          "Segoe UI", Roboto, "Noto Sans", "PingFang SC", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --ease: cubic-bezier(.32,.72,0,1);
  --accent: #007aff; --accent-soft: rgba(0,122,255,.16); --accent-ghost: rgba(0,122,255,.10);
  --danger: #e5484d; --warn: #d97706; --ok: #30a46c;
  --cat-folder: #3f9bf5; --cat-code: #4c8dff; --cat-image: #a970d8; --cat-markup: #e06c5a;
  --cat-style: #5b7ee0; --cat-data: #e0a03f; --cat-text: #8e8e93; --cat-markdown: #5b80b6;
  --cat-archive: #c9982f; --cat-pdf: #e5484d; --cat-audio: #e0468c; --cat-video: #61a12f;
  --cat-binary: #98989d; --cat-font: #d08770; --cat-config: #7d8590;
  font-family: var(--font); font-size: 13px; line-height: 1.45;
  color: var(--txt); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
.ghf-root[data-theme="light"] {
  --bg: rgba(246,246,248,.87); --bg-side: rgba(238,238,242,.55); --bg-main: rgba(252,252,254,.86);
  --txt: #1d1d1f; --txt-dim: #6e6e73; --txt-faint: #98989d;
  --line: rgba(0,0,0,.09); --line-strong: rgba(0,0,0,.16);
  --hover: rgba(0,0,0,.055); --hover-strong: rgba(0,0,0,.09);
  --menu-bg: rgba(250,250,252,.93); --field: rgba(255,255,255,.82); --field-line: rgba(0,0,0,.14);
  --sheet: rgba(253,253,255,.985); --shadow: 0 24px 70px rgba(0,0,0,.30), 0 4px 16px rgba(0,0,0,.14), 0 0 0 .5px rgba(0,0,0,.22);
  --folder-back: #3f9bf5; --folder-front: #63b0f9; --sel-txt: #fff;
  --scrim: rgba(0,0,0,.22); --spot: rgba(0,0,0,.06);
}
.ghf-root[data-theme="dark"] {
  --bg: rgba(34,34,38,.88); --bg-side: rgba(26,26,30,.62); --bg-main: rgba(28,28,32,.90);
  --txt: #f5f5f7; --txt-dim: #a1a1aa; --txt-faint: #6e6e76;
  --line: rgba(255,255,255,.10); --line-strong: rgba(255,255,255,.18);
  --hover: rgba(255,255,255,.075); --hover-strong: rgba(255,255,255,.13);
  --menu-bg: rgba(46,46,50,.95); --field: rgba(0,0,0,.28); --field-line: rgba(255,255,255,.16);
  --sheet: rgba(38,38,42,.99); --shadow: 0 28px 80px rgba(0,0,0,.60), 0 0 0 .5px rgba(255,255,255,.14);
  --folder-back: #2f86d6; --folder-front: #4d9be4; --sel-txt: #fff;
  --scrim: rgba(0,0,0,.45); --spot: rgba(255,255,255,.06);
  --accent: #0a84ff; --accent-soft: rgba(10,132,255,.24); --accent-ghost: rgba(10,132,255,.14);
}
.ghf-root :where(button) { font: inherit; color: inherit; background: none; border: 0; cursor: default; }
.ghf-root :where(input, select, textarea) { font: inherit; color: var(--txt); }
.ghf-root ::-webkit-scrollbar { width: 9px; height: 9px; }
.ghf-root ::-webkit-scrollbar-track { background: transparent; }
.ghf-root ::-webkit-scrollbar-thumb { background: rgba(128,128,138,.4); border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }
.ghf-root ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,138,.65); border: 2px solid transparent; background-clip: content-box; }
.ghf-root svg { display: block; }
.ghf-root .ghf-icon { width: 16px; height: 16px; flex: none; }
.ghf-root .ghf-icon > svg { width: 100%; height: 100%; }
.ghf-root .ghf-icon.use-color > svg { color: var(--ic); }

/* ── Launcher ─────────────────────────────────────────── */
.ghf-launcher {
  position: fixed; right: 22px; bottom: 22px; z-index: ${CFG.Z.launcher};
  width: 54px; height: 54px; border-radius: 15px; cursor: pointer;
  background: linear-gradient(180deg, #4facf7 0%, #1d7ce0 100%);
  box-shadow: 0 8px 24px rgba(29,124,224,.45), 0 1px 2px rgba(0,0,0,.2), inset 0 1px 0 rgba(255,255,255,.35);
  display: flex; align-items: center; justify-content: center;
  transition: transform .18s var(--ease), box-shadow .18s var(--ease), opacity .18s var(--ease);
}
.ghf-launcher:hover { transform: scale(1.07); box-shadow: 0 12px 32px rgba(29,124,224,.55), 0 1px 2px rgba(0,0,0,.25), inset 0 1px 0 rgba(255,255,255,.35); }
.ghf-launcher:active { transform: scale(.97); }
.ghf-launcher > svg { width: 30px; height: 30px; filter: drop-shadow(0 1px 1px rgba(0,0,0,.2)); }
.ghf-launcher.ghf-hidden { opacity: 0; transform: scale(.6); pointer-events: none; }
.ghf-launcher.ghf-pulse::after {
  content: ""; position: absolute; inset: -4px; border-radius: 19px;
  border: 2px solid rgba(29,124,224,.55); animation: ghf-pulse 1.6s var(--ease) infinite;
}
@keyframes ghf-pulse { 0% { transform: scale(.9); opacity: 1; } 100% { transform: scale(1.55); opacity: 0; } }

/* ── Dock pill (minimized) ─────────────────────────────── */
.ghf-pill {
  position: fixed; right: 22px; bottom: 22px; z-index: ${CFG.Z.pill};
  display: none; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 13px; cursor: pointer;
  background: var(--bg); backdrop-filter: blur(24px) saturate(1.8); -webkit-backdrop-filter: blur(24px) saturate(1.8);
  box-shadow: var(--shadow); font-size: 12.5px; font-weight: 600;
  transition: transform .18s var(--ease);
}
.ghf-pill:hover { transform: translateY(-2px); }
.ghf-pill.ghf-on { display: flex; }
.ghf-pill .ghf-icon { width: 20px; height: 20px; }

/* ── Window frame ──────────────────────────────────────── */
.ghf-win {
  position: fixed; z-index: ${CFG.Z.win}; display: none; flex-direction: column;
  border-radius: 12px; overflow: hidden;
  background: var(--bg); backdrop-filter: blur(30px) saturate(1.9); -webkit-backdrop-filter: blur(30px) saturate(1.9);
  box-shadow: var(--shadow);
  opacity: 0; transform: scale(.96) translateY(8px);
}
.ghf-win.ghf-open { display: flex; animation: ghf-win-in .22s var(--ease) forwards; }
.ghf-win.ghf-closing { display: flex; animation: ghf-win-out .16s ease forwards; }
@keyframes ghf-win-in { from { opacity: 0; transform: scale(.96) translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes ghf-win-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: scale(.96) translateY(8px); } }
.ghf-win.ghf-inactive .ghf-light { background: #c9c9cf; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.12); }
.ghf-root[data-theme="dark"] .ghf-win.ghf-inactive .ghf-light { background: #57575d; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.3); }
.ghf-win.ghf-inactive .ghf-light * { opacity: 0 !important; }
.ghf-win.ghf-dragging, .ghf-win.ghf-resizing { transition: none; will-change: transform; }
.ghf-win.ghf-dragging { cursor: grabbing; user-select: none; -webkit-user-select: none; }

/* ── Title bar + traffic lights ────────────────────────── */
.ghf-titlebar {
  display: flex; align-items: center; height: 38px; padding: 0 12px; flex: none;
  cursor: default; user-select: none; -webkit-user-select: none; touch-action: none;
}
.ghf-lights { display: flex; gap: 8px; align-items: center; }
.ghf-light {
  width: 12px; height: 12px; border-radius: 50%; position: relative; cursor: pointer;
  display: flex; align-items: center; justify-content: center; padding: 0;
  box-shadow: inset 0 0 0 .5px rgba(0,0,0,.18), inset 0 1px 1px rgba(255,255,255,.25);
}
.ghf-light > svg { width: 7px; height: 7px; opacity: 0; color: rgba(0,0,0,.55); }
.ghf-lights:hover .ghf-light > svg { opacity: 1; }
.ghf-l-red { background: #ff5f57; } .ghf-l-yel { background: #febc2e; } .ghf-l-grn { background: #28c840; }
.ghf-light.ghf-dirty::after { content: ""; position: absolute; width: 5px; height: 5px; border-radius: 50%; background: rgba(0,0,0,.55); }
.ghf-wtitle {
  flex: 1; text-align: center; font-weight: 600; font-size: 13.5px; color: var(--txt);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 14px;
  pointer-events: none;
}
.ghf-wtitle .ghf-sub { font-weight: 400; color: var(--txt-dim); font-size: 12px; }

/* ── Toolbar ───────────────────────────────────────────── */
.ghf-toolbar { display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 10px; flex: none; border-top: 1px solid var(--line); }
.ghf-tbtn {
  width: 30px; height: 28px; border-radius: 7px; display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--txt-dim); position: relative;
  transition: background-color .12s ease, color .12s ease, transform .1s ease;
}
.ghf-tbtn:hover { background: var(--hover); color: var(--txt); }
.ghf-tbtn:active { transform: scale(.94); }
.ghf-tbtn.ghf-on { background: var(--accent-ghost); color: var(--accent); }
.ghf-tbtn:disabled { opacity: .35; cursor: default; }
.ghf-tbtn:disabled:hover { background: none; color: var(--txt-dim); }
.ghf-tsep { width: 1px; height: 18px; background: var(--line); margin: 0 4px; flex: none; }
.ghf-tspacer { flex: 1; }
.ghf-tbtn .ghf-badge { position: absolute; top: -3px; right: -3px; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px; background: var(--accent); color: #fff; font-size: 9.5px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.ghf-seg { display: flex; background: var(--spot); border-radius: 8px; padding: 2px; position: relative; }
.ghf-seg .ghf-tbtn { width: 32px; height: 24px; border-radius: 6px; }
.ghf-seg-thumb { position: absolute; top: 2px; left: 2px; width: 32px; height: 24px; border-radius: 6px; background: var(--sheet); box-shadow: 0 1px 3px rgba(0,0,0,.18), 0 0 0 .5px var(--line-strong); transition: transform .18s var(--ease); }
.ghf-sortwrap { display: flex; align-items: center; gap: 4px; }
.ghf-sortwrap select {
  height: 26px; border-radius: 7px; border: 1px solid var(--field-line); background: var(--field);
  padding: 0 6px; font-size: 12px; color: var(--txt-dim); cursor: pointer; outline: none;
}
.ghf-sortwrap select:focus { border-color: var(--accent); }

/* ── Body: sidebar + main ──────────────────────────────── */
.ghf-body { flex: 1; display: flex; min-height: 0; position: relative; }
.ghf-side {
  width: 212px; min-width: 160px; max-width: 380px; flex: none; display: flex; flex-direction: column;
  background: var(--bg-side); border-right: 1px solid var(--line-strong); position: relative;
}
.ghf-side-resize { position: absolute; top: 0; right: -3px; bottom: 0; width: 6px; cursor: col-resize; z-index: 5; }
.ghf-search { padding: 8px 10px; flex: none; }
.ghf-searchbox {
  display: flex; align-items: center; gap: 6px; height: 28px; border-radius: 7px; padding: 0 8px;
  background: var(--field); border: 1px solid var(--field-line); transition: border-color .15s ease, box-shadow .15s ease;
}
.ghf-searchbox:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ghost); }
.ghf-searchbox .ghf-icon { width: 13px; height: 13px; color: var(--txt-faint); }
.ghf-searchbox input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; font-size: 12.5px; }
.ghf-searchbox input::placeholder { color: var(--txt-faint); }
.ghf-searchbox .ghf-clear { cursor: pointer; display: none; color: var(--txt-faint); border-radius: 50%; width: 16px; height: 16px; align-items: center; justify-content: center; }
.ghf-searchbox .ghf-clear:hover { color: var(--txt); }
.ghf-searchbox .ghf-clear svg { width: 10px; height: 10px; }
.ghf-searchbox.ghf-has-q .ghf-clear { display: flex; }
.ghf-side-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 2px 8px 14px; }
.ghf-shead { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--txt-faint); padding: 12px 8px 5px; }
.ghf-srow {
  display: flex; align-items: center; gap: 6px; height: 27px; border-radius: 6px; padding: 0 8px;
  margin: 0 2px; cursor: default; position: relative; white-space: nowrap;
  color: var(--txt); transition: background-color .1s ease;
}
.ghf-srow:hover { background: var(--hover); }
.ghf-srow.ghf-cur { background: var(--hover-strong); font-weight: 600; }
.ghf-srow .ghf-chevron { width: 10px; height: 10px; flex: none; color: var(--txt-faint); cursor: pointer; display: flex; align-items: center; border-radius: 3px; transition: transform .15s var(--ease); }
.ghf-srow .ghf-chevron:hover { color: var(--txt); }
.ghf-srow .ghf-chevron svg { width: 100%; height: 100%; }
.ghf-srow.ghf-exp .ghf-chevron { transform: rotate(90deg); }
.ghf-srow.ghf-drop-hint { background: var(--accent-soft); box-shadow: inset 0 0 0 1.5px var(--accent); }
.ghf-srow.ghf-drop-bad { background: rgba(229,72,77,.14); box-shadow: inset 0 0 0 1.5px var(--danger); }
.ghf-slabel { overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; }
.ghf-srow.ghf-pending-row { opacity: .55; }
.ghf-morebtn { margin: 3px 10px; font-size: 11.5px; color: var(--accent); cursor: pointer; border-radius: 6px; padding: 4px 8px; }
.ghf-morebtn:hover { background: var(--accent-ghost); }

/* ── Main pane ─────────────────────────────────────────── */
.ghf-main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg-main); position: relative; }
.ghf-crumbbar { display: flex; align-items: center; height: 34px; padding: 0 10px; gap: 2px; flex: none; border-bottom: 1px solid var(--line); }
.ghf-crumb { display: flex; align-items: center; gap: 5px; height: 24px; padding: 0 7px; border-radius: 6px; font-size: 12.5px; color: var(--txt-dim); cursor: pointer; max-width: 220px; white-space: nowrap; transition: background-color .1s ease; }
.ghf-crumb:hover { background: var(--hover); color: var(--txt); }
.ghf-crumb.ghf-last { color: var(--txt); font-weight: 600; }
.ghf-crumb .ghf-ell { overflow: hidden; text-overflow: ellipsis; }
.ghf-crumb .ghf-icon { width: 14px; height: 14px; }
.ghf-crumb-sep { color: var(--txt-faint); display: flex; width: 9px; height: 9px; }
.ghf-crumb-sep svg { width: 100%; height: 100%; }
.ghf-crumb.ghf-drop-hint { background: var(--accent-soft); box-shadow: inset 0 0 0 1.5px var(--accent); }
.ghf-crumbbar .ghf-spacer { flex: 1; min-width: 8px; }
.ghf-lastcommit { font-size: 11.5px; color: var(--txt-dim); display: flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 6px; max-width: 46%; overflow: hidden; white-space: nowrap; }
.ghf-lastcommit .ghf-ell { overflow: hidden; text-overflow: ellipsis; }
.ghf-lastcommit .ghf-when { color: var(--txt-faint); flex: none; }

/* main scroll area */
.ghf-main-scroll { flex: 1; overflow: auto; position: relative; min-height: 0; }
.ghf-cols {
  display: grid; grid-template-columns: minmax(0,1fr) 88px 132px 12px; align-items: center;
  height: 26px; padding: 0 4px 0 14px; position: sticky; top: 0; z-index: 3;
  background: var(--bg-main); border-bottom: 1px solid var(--line); font-size: 11.5px; color: var(--txt-dim);
}
.ghf-col { display: flex; align-items: center; gap: 4px; cursor: pointer; height: 100%; padding: 0 4px; border-radius: 5px; user-select: none; }
.ghf-col:hover { background: var(--hover); color: var(--txt); }
.ghf-col.ghf-colright { justify-content: flex-end; }
.ghf-col .ghf-sortarrow { width: 9px; height: 9px; opacity: 0; transition: opacity .12s ease; }
.ghf-col .ghf-sortarrow svg { width: 100%; height: 100%; }
.ghf-col.ghf-sorted { color: var(--txt); font-weight: 600; }
.ghf-col.ghf-sorted .ghf-sortarrow { opacity: 1; }
.ghf-col.ghf-desc .ghf-sortarrow { transform: rotate(180deg); }
.ghf-vinner { position: relative; }
.ghf-row, .ghf-gridrow { position: absolute; left: 0; right: 0; will-change: transform; }
.ghf-row {
  display: grid; grid-template-columns: minmax(0,1fr) 88px 132px 12px; align-items: center;
  height: 29px; padding: 0 4px 0 14px; cursor: default; border-radius: 6px; margin: 0 6px 1px;
  width: calc(100% - 12px); transition: background-color .08s ease;
}
.ghf-row.ghf-searchrow { height: 45px; align-items: flex-start; padding-top: 7px; }
.ghf-row:hover { background: var(--hover); }
.ghf-row.ghf-sel { background: var(--accent); }
.ghf-row.ghf-sel .ghf-name, .ghf-row.ghf-sel .ghf-size, .ghf-row.ghf-sel .ghf-kind, .ghf-row.ghf-sel .ghf-sub { color: var(--sel-txt); }
.ghf-row.ghf-sel .ghf-fi { --ic: #fff !important; }
.ghf-row.ghf-sel .ghf-fi.ghf-folder svg .ghf-fold-back { fill: #fff; opacity: .9; }
.ghf-row.ghf-sel .ghf-fi.ghf-folder svg .ghf-fold-front { fill: rgba(255,255,255,.75); }
.ghf-row.ghf-cut { opacity: .5; }
.ghf-row.ghf-pending-row { opacity: .6; }
.ghf-row.ghf-drop-hint { background: var(--accent-soft); box-shadow: inset 0 0 0 1.5px var(--accent); }
.ghf-row.ghf-drop-bad { background: rgba(229,72,77,.12); box-shadow: inset 0 0 0 1.5px var(--danger); }
.ghf-namewrap { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ghf-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--txt); }
.ghf-sub { font-size: 11px; color: var(--txt-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ghf-size { font-size: 11.5px; color: var(--txt-dim); text-align: right; white-space: nowrap; padding-right: 8px; font-variant-numeric: tabular-nums; }
.ghf-kind { font-size: 11.5px; color: var(--txt-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ghf-row.ghf-searchrow .ghf-namewrap { flex-direction: column; align-items: flex-start; gap: 1px; }
.ghf-mainname { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ghf-renamewrap { flex: 1; min-width: 0; }
.ghf-rename {
  width: 100%; font-size: 13px; border: 1.5px solid var(--accent); border-radius: 5px; padding: 1px 5px;
  outline: none; background: var(--sheet); box-shadow: 0 0 0 3px var(--accent-ghost); height: 22px;
}
.ghf-mark { background: var(--accent-soft); border-radius: 2px; color: var(--accent); font-weight: 600; }
.ghf-row.ghf-sel .ghf-mark { background: rgba(255,255,255,.25); color: #fff; }

/* grid view */
.ghf-gridrow { display: flex; height: ${CFG.CELL_H}px; padding: 0 3px; }
.ghf-cell {
  flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 8px 6px 6px;
  margin: 0 1.5px 3px; border-radius: 9px; cursor: default; transition: background-color .08s ease;
}
.ghf-cell:hover { background: var(--hover); }
.ghf-cell.ghf-sel { background: var(--accent); }
.ghf-cell.ghf-sel .ghf-gname { color: var(--sel-txt); }
.ghf-cell.ghf-sel .ghf-fi { --ic: #fff !important; }
.ghf-cell.ghf-sel .ghf-fi.ghf-folder svg .ghf-fold-back { fill: #fff; opacity: .9; }
.ghf-cell.ghf-sel .ghf-fi.ghf-folder svg .ghf-fold-front { fill: rgba(255,255,255,.75); }
.ghf-cell .ghf-fi { width: 50px; height: 50px; }
.ghf-cell .ghf-fi > svg { width: 100%; height: 100%; }
.ghf-gname {
  font-size: 11.5px; text-align: center; color: var(--txt); max-width: 100%;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  word-break: break-word; line-height: 1.3;
}
.ghf-cell.ghf-cut { opacity: .5; } .ghf-cell.ghf-pending-row { opacity: .6; }
.ghf-cell.ghf-drop-hint { background: var(--accent-soft); box-shadow: inset 0 0 0 1.5px var(--accent); }
.ghf-cell.ghf-drop-bad { background: rgba(229,72,77,.12); box-shadow: inset 0 0 0 1.5px var(--danger); }

/* file icons */
.ghf-fi { width: 19px; height: 19px; flex: none; --ic: var(--cat-text); }
.ghf-fi > svg { width: 100%; height: 100%; }
.ghf-fi.ghf-cat-code { --ic: var(--cat-code); } .ghf-fi.ghf-cat-image { --ic: var(--cat-image); }
.ghf-fi.ghf-cat-markup { --ic: var(--cat-markup); } .ghf-fi.ghf-cat-style { --ic: var(--cat-style); }
.ghf-fi.ghf-cat-data { --ic: var(--cat-data); } .ghf-fi.ghf-cat-markdown { --ic: var(--cat-markdown); }
.ghf-fi.ghf-cat-archive { --ic: var(--cat-archive); } .ghf-fi.ghf-cat-pdf { --ic: var(--cat-pdf); }
.ghf-fi.ghf-cat-audio { --ic: var(--cat-audio); } .ghf-fi.ghf-cat-video { --ic: var(--cat-video); }
.ghf-fi.ghf-cat-binary { --ic: var(--cat-binary); } .ghf-fi.ghf-cat-font { --ic: var(--cat-font); }
.ghf-fi.ghf-cat-config { --ic: var(--cat-config); } .ghf-fi.ghf-cat-text { --ic: var(--cat-text); }

/* empty + drop overlays */
.ghf-empty { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 20px; text-align: center; z-index: 2; }
.ghf-empty.ghf-on { display: flex; }
.ghf-empty .ghf-bigicon { width: 62px; height: 62px; color: var(--txt-faint); opacity: .8; }
.ghf-empty .ghf-bigicon > svg { width: 100%; height: 100%; }
.ghf-empty .ghf-et { font-size: 14px; font-weight: 600; color: var(--txt-dim); }
.ghf-empty .ghf-ed { font-size: 12px; color: var(--txt-faint); max-width: 420px; }
.ghf-empty .ghf-ebtns { display: flex; gap: 8px; margin-top: 4px; }
.ghf-loading { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 14px; z-index: 4; background: var(--bg-main); }
.ghf-loading.ghf-on { display: flex; }
.ghf-loading .ghf-lt { font-size: 12.5px; color: var(--txt-dim); }
.ghf-dropveil { position: absolute; inset: 0; display: none; z-index: 5; border-radius: 0; pointer-events: none; }
.ghf-dropveil.ghf-on { display: block; box-shadow: inset 0 0 0 2.5px var(--accent); background: var(--accent-ghost); }
.ghf-dropchip {
  position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 6; pointer-events: none;
  display: none; background: var(--accent); color: #fff; font-size: 12px; font-weight: 600; padding: 6px 14px; border-radius: 999px;
  box-shadow: 0 6px 20px rgba(0,122,255,.4); white-space: nowrap;
}
.ghf-dropchip.ghf-on { display: block; }

/* status bar */
.ghf-status { flex: none; display: flex; align-items: center; height: 26px; padding: 0 12px; gap: 14px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--txt-dim); user-select: none; }
.ghf-status .ghf-spart { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ghf-status .ghf-sright { margin-left: auto; display: flex; gap: 12px; align-items: center; }
.ghf-status .ghf-rate { cursor: pointer; border-radius: 5px; padding: 1px 6px; }
.ghf-status .ghf-rate:hover { background: var(--hover); }
.ghf-status .ghf-rate.ghf-low { color: var(--warn); font-weight: 600; }
.ghf-status .ghf-rate.ghf-out { color: var(--danger); font-weight: 600; }
.ghf-syncing { display: inline-flex; align-items: center; gap: 5px; color: var(--accent); }
.ghf-spin { width: 11px; height: 11px; border-radius: 50%; border: 1.6px solid var(--accent-soft); border-top-color: var(--accent); animation: ghf-spin .7s linear infinite; flex: none; }
.ghf-spin.ghf-big { width: 22px; height: 22px; border-width: 2.4px; }
@keyframes ghf-spin { to { transform: rotate(360deg); } }

/* resize handles */
.ghf-rh { position: absolute; z-index: 8; }
.ghf-rh-n { top: -3px; left: 10px; right: 10px; height: 7px; cursor: ns-resize; }
.ghf-rh-s { bottom: -3px; left: 10px; right: 10px; height: 7px; cursor: ns-resize; }
.ghf-rh-e { right: -3px; top: 10px; bottom: 10px; width: 7px; cursor: ew-resize; }
.ghf-rh-w { left: -3px; top: 10px; bottom: 10px; width: 7px; cursor: ew-resize; }
.ghf-rh-ne { top: -3px; right: -3px; width: 13px; height: 13px; cursor: nesw-resize; }
.ghf-rh-nw { top: -3px; left: -3px; width: 13px; height: 13px; cursor: nwse-resize; }
.ghf-rh-se { bottom: -3px; right: -3px; width: 13px; height: 13px; cursor: nwse-resize; }
.ghf-rh-sw { bottom: -3px; left: -3px; width: 13px; height: 13px; cursor: nesw-resize; }
.ghf-win.ghf-maxed .ghf-rh { display: none; }

/* ── Sheets (inside window) ────────────────────────────── */
.ghf-sheet-layer { position: absolute; inset: 0; z-index: 20; display: none; }
.ghf-sheet-layer.ghf-on { display: block; }
.ghf-sheet-bg { position: absolute; inset: 0; background: var(--scrim); opacity: 0; animation: ghf-fade .2s ease forwards; }
@keyframes ghf-fade { to { opacity: 1; } }
.ghf-sheet {
  position: absolute; inset: 10px; border-radius: 11px; overflow: hidden; display: flex; flex-direction: column;
  background: var(--sheet); backdrop-filter: blur(30px) saturate(1.8); -webkit-backdrop-filter: blur(30px) saturate(1.8);
  box-shadow: 0 12px 40px rgba(0,0,0,.28), 0 0 0 .5px var(--line-strong);
  animation: ghf-sheet-in .24s var(--ease);
}
@keyframes ghf-sheet-in { from { opacity: 0; transform: translateY(-14px); } to { opacity: 1; transform: none; } }
.ghf-sheet-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--line); flex: none; }
.ghf-sheet-head .ghf-fi { width: 22px; height: 22px; }
.ghf-sheet-title { font-weight: 700; font-size: 13.5px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ghf-sheet-path { font-size: 11.5px; color: var(--txt-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ghf-sheet-x { width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--txt-dim); }
.ghf-sheet-x:hover { background: var(--hover); color: var(--txt); }
.ghf-sheet-x .ghf-icon { width: 13px; height: 13px; }
.ghf-sheet-body { flex: 1; min-height: 0; display: flex; }
.ghf-sheet-foot { flex: none; display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--line); }
.ghf-sheet-foot .ghf-meta { font-size: 11.5px; color: var(--txt-faint); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ── Buttons / inputs (shared) ─────────────────────────── */
.ghf-btn {
  height: 30px; padding: 0 14px; border-radius: 8px; font-size: 12.5px; font-weight: 600; cursor: pointer;
  display: inline-flex; align-items: center; gap: 7px; transition: transform .1s ease, filter .12s ease, background-color .12s ease;
  background: var(--spot); color: var(--txt); border: 0; user-select: none;
}
.ghf-btn:hover { filter: brightness(1.05); }
.ghf-btn:active { transform: scale(.97); }
.ghf-btn:disabled { opacity: .45; cursor: default; pointer-events: none; }
.ghf-btn.ghf-primary { background: var(--accent); color: #fff; }
.ghf-btn.ghf-danger { background: var(--danger); color: #fff; }
.ghf-btn.ghf-big { height: 34px; padding: 0 18px; font-size: 13px; }
.ghf-btn .ghf-icon { width: 14px; height: 14px; }
.ghf-btn.ghf-loading-btn { pointer-events: none; opacity: .7; }
.ghf-input {
  width: 100%; height: 32px; border-radius: 8px; border: 1px solid var(--field-line); background: var(--field);
  padding: 0 10px; font-size: 13px; outline: none; transition: border-color .15s ease, box-shadow .15s ease;
}
.ghf-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ghost); }
.ghf-input::placeholder { color: var(--txt-faint); }
textarea.ghf-input { height: auto; padding: 8px 10px; resize: none; }
.ghf-field-label { display: block; font-size: 12px; font-weight: 600; color: var(--txt-dim); margin: 0 0 6px 1px; }
.ghf-hint { font-size: 11.5px; color: var(--txt-faint); line-height: 1.5; }
.ghf-hint a { color: var(--accent); text-decoration: none; font-weight: 600; }
.ghf-hint a:hover { text-decoration: underline; }

/* ── Modals (settings / dialogs) ───────────────────────── */
.ghf-modal-layer { position: fixed; inset: 0; z-index: ${CFG.Z.modal}; display: none; align-items: center; justify-content: center; }
.ghf-modal-layer.ghf-on { display: flex; }
.ghf-modal-veil { position: absolute; inset: 0; background: rgba(0,0,0,.30); animation: ghf-fade .18s ease forwards; opacity: 0; }
.ghf-modal {
  position: relative; width: 460px; max-width: calc(100vw - 40px); max-height: calc(100vh - 60px);
  border-radius: 12px; overflow: hidden; display: flex; flex-direction: column;
  background: var(--bg); backdrop-filter: blur(32px) saturate(1.9); -webkit-backdrop-filter: blur(32px) saturate(1.9);
  box-shadow: var(--shadow); animation: ghf-modal-in .2s var(--ease);
}
@keyframes ghf-modal-in { from { opacity: 0; transform: scale(.96) translateY(8px); } to { opacity: 1; transform: none; } }
.ghf-modal.ghf-narrow { width: 400px; }
.ghf-modal-title { display: flex; align-items: center; gap: 9px; padding: 13px 16px 11px; font-size: 14px; font-weight: 700; flex: none; }
.ghf-modal-title .ghf-icon { width: 18px; height: 18px; color: var(--txt-dim); }
.ghf-modal-body { padding: 2px 16px 18px; overflow-y: auto; min-height: 0; flex: 1; }
.ghf-modal-foot { display: flex; justify-content: flex-end; gap: 9px; padding: 12px 16px; border-top: 1px solid var(--line); flex: none; background: transparent; }
.ghf-dialog-items { margin: 8px 0; padding: 8px 10px; border-radius: 8px; background: var(--spot); font-size: 12px; color: var(--txt-dim); max-height: 130px; overflow-y: auto; }
.ghf-dialog-items div { padding: 1px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ghf-status-line { display: flex; align-items: center; gap: 7px; font-size: 12px; min-height: 20px; margin-top: 8px; }
.ghf-status-line.ghf-ok { color: var(--ok); font-weight: 600; }
.ghf-status-line.ghf-err { color: var(--danger); font-weight: 600; }
.ghf-status-line .ghf-icon { width: 14px; height: 14px; }
.ghf-token-row { display: flex; gap: 8px; align-items: center; }
.ghf-token-row .ghf-input { flex: 1; }
.ghf-eye { width: 30px; height: 30px; border-radius: 7px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--txt-dim); flex: none; }
.ghf-eye:hover { background: var(--hover); color: var(--txt); }
.ghf-eye .ghf-icon { width: 15px; height: 15px; }
.ghf-account { display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 10px; background: var(--spot); }
.ghf-account img { width: 40px; height: 40px; border-radius: 50%; }
.ghf-account .ghf-a-name { font-weight: 700; font-size: 13.5px; }
.ghf-account .ghf-a-sub { font-size: 11.5px; color: var(--txt-faint); }
.ghf-account .ghf-a-btns { margin-left: auto; display: flex; gap: 7px; }
.ghf-setsec { margin: 14px 0 8px; font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--txt-faint); }
.ghf-keys { display: grid; grid-template-columns: auto 1fr; gap: 5px 14px; font-size: 12px; }
.ghf-keys kbd {
  font-family: var(--mono); font-size: 10.5px; background: var(--spot); border: 1px solid var(--line);
  border-bottom-width: 2px; border-radius: 5px; padding: 1px 6px; color: var(--txt-dim); white-space: nowrap; justify-self: start;
}
.ghf-keys span { color: var(--txt-dim); }

/* ── Menus ─────────────────────────────────────────────── */
.ghf-menu {
  position: fixed; z-index: ${CFG.Z.menu}; min-width: 214px; max-width: 320px; padding: 5px;
  border-radius: 9px; background: var(--menu-bg); backdrop-filter: blur(28px) saturate(1.8); -webkit-backdrop-filter: blur(28px) saturate(1.8);
  box-shadow: 0 12px 44px rgba(0,0,0,.28), 0 0 0 .5px var(--line-strong);
  animation: ghf-menu-in .1s var(--ease); transform-origin: top left; user-select: none;
}
@keyframes ghf-menu-in { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: none; } }
.ghf-mi {
  display: flex; align-items: center; gap: 9px; height: 27px; padding: 0 9px; border-radius: 6px;
  font-size: 12.5px; cursor: pointer; white-space: nowrap; color: var(--txt); position: relative;
}
.ghf-mi:hover:not(.ghf-dis), .ghf-mi.ghf-hot:not(.ghf-dis) { background: var(--accent); color: #fff; }
.ghf-mi:hover:not(.ghf-dis) .ghf-icon, .ghf-mi.ghf-hot:not(.ghf-dis) .ghf-icon { color: #fff; }
.ghf-mi .ghf-icon { width: 15px; height: 15px; color: var(--txt-dim); flex: none; }
.ghf-mi .ghf-mlabel { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.ghf-mi .ghf-mkey { font-size: 11px; color: var(--txt-faint); padding-left: 18px; }
.ghf-mi:hover:not(.ghf-dis) .ghf-mkey { color: rgba(255,255,255,.85); }
.ghf-mi.ghf-dis { opacity: .38; cursor: default; }
.ghf-mi.ghf-danger:not(.ghf-dis) .ghf-icon { color: var(--danger); }
.ghf-mi.ghf-danger:hover:not(.ghf-dis) { background: var(--danger); color: #fff; }
.ghf-mi.ghf-danger:hover:not(.ghf-dis) .ghf-icon { color: #fff; }
.ghf-msep { height: 1px; background: var(--line); margin: 5px 8px; }
.ghf-msub { width: 10px; height: 10px; color: var(--txt-faint); }
.ghf-mi:hover:not(.ghf-dis) .ghf-msub { color: #fff; }

/* ── Toasts ────────────────────────────────────────────── */
.ghf-toasts { position: fixed; right: 18px; bottom: 18px; z-index: ${CFG.Z.toast}; display: flex; flex-direction: column; gap: 8px; width: 340px; max-width: calc(100vw - 36px); pointer-events: none; }
.ghf-toast {
  pointer-events: auto; display: flex; gap: 10px; padding: 11px 13px; border-radius: 11px; align-items: flex-start;
  background: var(--menu-bg); backdrop-filter: blur(26px) saturate(1.8); -webkit-backdrop-filter: blur(26px) saturate(1.8);
  box-shadow: 0 10px 34px rgba(0,0,0,.25), 0 0 0 .5px var(--line-strong);
  animation: ghf-toast-in .22s var(--ease); position: relative; overflow: hidden;
}
.ghf-toast.ghf-out { animation: ghf-toast-out .18s ease forwards; }
@keyframes ghf-toast-in { from { opacity: 0; transform: translateX(22px); } to { opacity: 1; transform: none; } }
@keyframes ghf-toast-out { to { opacity: 0; transform: translateX(22px); } }
.ghf-toast .ghf-tic { width: 21px; height: 21px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; margin-top: 1px; }
.ghf-toast .ghf-tic .ghf-icon { width: 12px; height: 12px; color: #fff; }
.ghf-toast.ghf-success .ghf-tic { background: var(--ok); }
.ghf-toast.ghf-error .ghf-tic { background: var(--danger); }
.ghf-toast.ghf-info .ghf-tic { background: var(--accent); }
.ghf-toast .ghf-tmsg { font-size: 12.5px; font-weight: 600; color: var(--txt); line-height: 1.35; word-break: break-word; }
.ghf-toast .ghf-tdet { font-size: 11.5px; color: var(--txt-dim); margin-top: 2px; line-height: 1.4; word-break: break-word; }
.ghf-toast.ghf-progress .ghf-tic { background: var(--accent); }
.ghf-toast .ghf-tbar { position: absolute; left: 0; bottom: 0; height: 2.5px; background: var(--accent); opacity: .75; transform-origin: left; animation: ghf-tbar linear forwards; }
@keyframes ghf-tbar { from { transform: scaleX(1); } to { transform: scaleX(0); } }

/* ── Drag ghost ────────────────────────────────────────── */
.ghf-ghost {
  position: fixed; left: 0; top: 0; z-index: ${CFG.Z.ghost}; pointer-events: none; display: none;
  align-items: center; gap: 8px; padding: 6px 12px 6px 9px; border-radius: 10px; max-width: 320px;
  background: var(--menu-bg); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 14px 40px rgba(0,0,0,.32), 0 0 0 .5px var(--line-strong);
  font-size: 12.5px; font-weight: 600; color: var(--txt); will-change: transform;
}
.ghf-ghost.ghf-on { display: flex; }
.ghf-ghost .ghf-fi { width: 20px; height: 20px; }
.ghf-ghost .ghf-count { background: var(--accent); color: #fff; border-radius: 9px; font-size: 10.5px; padding: 1px 7px; font-weight: 700; }
.ghf-root.ghf-dragging, .ghf-root.ghf-dragging * { cursor: grabbing !important; user-select: none !important; -webkit-user-select: none !important; }
.ghf-root.ghf-dragging .ghf-row:hover, .ghf-root.ghf-dragging .ghf-cell:hover, .ghf-root.ghf-dragging .ghf-srow:hover { background: transparent; }

/* ── Editor sheet ──────────────────────────────────────── */
.ghf-ed { display: flex; flex: 1; min-height: 0; }
.ghf-ed-gut {
  flex: none; width: 46px; overflow: hidden; padding: 10px 0; text-align: right; border-right: 1px solid var(--line);
  color: var(--txt-faint); font-family: var(--mono); font-size: 11.5px; line-height: 1.55; user-select: none; background: var(--bg-side);
  white-space: pre;
}
.ghf-ed-wrap { flex: 1; position: relative; min-width: 0; display: flex; }
.ghf-ed-hl, .ghf-ed-ta {
  flex: 1; padding: 10px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.55; tab-size: 2;
  white-space: pre; word-wrap: normal; overflow: auto; border: 0; outline: 0; letter-spacing: 0;
}
.ghf-ed-hl { position: absolute; inset: 0; color: var(--txt); pointer-events: none; background: transparent; overflow: hidden; }
.ghf-ed-ta { position: relative; resize: none; background: transparent; color: transparent; caret-color: var(--txt); z-index: 1; }
.ghf-ed-ta::selection { background: rgba(0,122,255,.30); }
.ghf-ed-ta[readonly] { caret-color: transparent; }
.ghf-tok-com { color: #8e8e93; font-style: italic; }
.ghf-tok-str { color: #c2802b; }
.ghf-tok-num { color: #9a6ee0; }
.ghf-tok-kw  { color: #d3506e; font-weight: 600; }
.ghf-tok-tag { color: #4c8dff; }
.ghf-root[data-theme="dark"] .ghf-tok-com { color: #7f8494; }
.ghf-root[data-theme="dark"] .ghf-tok-str { color: #d9b06c; }
.ghf-root[data-theme="dark"] .ghf-tok-num { color: #b294f2; }
.ghf-root[data-theme="dark"] .ghf-tok-kw  { color: #ef7d92; }
.ghf-root[data-theme="dark"] .ghf-tok-tag { color: #74b6ff; }
.ghf-langbadge { font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: .04em; color: var(--txt-faint); background: var(--spot); border-radius: 5px; padding: 2px 7px; flex: none; }

/* ── Preview sheet ─────────────────────────────────────── */
.ghf-pv-stage { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 18px; position: relative; }
.ghf-pv-stage.ghf-checker { background-image: linear-gradient(45deg, var(--spot) 25%, transparent 25%), linear-gradient(-45deg, var(--spot) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--spot) 75%), linear-gradient(-45deg, transparent 75%, var(--spot) 75%); background-size: 18px 18px; background-position: 0 0, 0 9px, 9px -9px, -9px 0; }
.ghf-pv-stage img { max-width: 100%; max-height: 100%; object-fit: contain; }
.ghf-pv-stage iframe { width: 100%; height: 100%; border: 0; }
.ghf-pv-meta { width: 230px; flex: none; border-left: 1px solid var(--line); padding: 14px; overflow-y: auto; font-size: 12px; }
.ghf-pv-meta .ghf-mk { display: flex; gap: 8px; padding: 5px 0; }
.ghf-pv-meta .ghf-mk b { color: var(--txt-faint); font-weight: 600; width: 52px; flex: none; }
.ghf-pv-meta .ghf-mv { word-break: break-all; color: var(--txt); }
.ghf-pv-meta .ghf-shacopy { cursor: pointer; color: var(--accent); }
.ghf-pv-meta .ghf-shacopy:hover { text-decoration: underline; }
.ghf-pv-fallback { display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--txt-dim); }
.ghf-pv-fallback .ghf-fi { width: 64px; height: 64px; }

/* ── Move picker ───────────────────────────────────────── */
.ghf-mv { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.ghf-mv-crumbs { display: flex; align-items: center; gap: 2px; padding: 8px 12px; border-bottom: 1px solid var(--line); flex: none; flex-wrap: wrap; }
.ghf-mv-list { flex: 1; overflow-y: auto; padding: 6px; min-height: 140px; }
.ghf-mv-row { display: flex; align-items: center; gap: 9px; height: 30px; padding: 0 9px; border-radius: 7px; cursor: pointer; font-size: 13px; }
.ghf-mv-row:hover { background: var(--hover); }
.ghf-mv-row.ghf-empty-hint { color: var(--txt-faint); cursor: default; font-size: 12px; }
.ghf-mv-row .ghf-fi { width: 18px; height: 18px; }
.ghf-mv-up { color: var(--accent); display: flex; align-items: center; gap: 7px; font-size: 12.5px; padding: 7px 9px; border-radius: 7px; cursor: pointer; }
.ghf-mv-up:hover { background: var(--hover); }

@media (prefers-reduced-motion: reduce) {
  .ghf-root *, .ghf-root { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`;

  /* ══════════════════════════ §3 ICONS ══════════════════════════
     Inline SVG set, stroke-based (SF Symbols style). Static strings only —
     safe for innerHTML. Folder uses two-tone fills via CSS vars. */

  const ICON_PATHS = {
    chevron: '<path d="M9 5.5 15.5 12 9 18.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    chevronDown: '<path d="M5.5 9 12 15.5 18.5 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    back: '<path d="M14.5 5.5 8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    fwd: '<path d="M9.5 5.5 16 12l-6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    close: '<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>',
    minus: '<path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>',
    zoomIn: '<path d="M6 10h8M10 6v8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M4.5 4.5h11v11h-11z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M15.5 15.5 20 20" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.5-5.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M20 3.5V8h-4.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    list: '<path d="M4 6.5h2M4 12h2M4 17.5h2M9.5 6.5H20M9.5 12H20M9.5 17.5H20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    grid: '<rect x="4" y="4" width="6.6" height="6.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    search: '<circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M15.6 15.6 20 20" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    gear: '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3.8l1 2.4a6 6 0 0 1 2 1.2l2.5-.6 1.4 2.4-1.8 1.8a6 6 0 0 1 0 2l1.8 1.8-1.4 2.4-2.5-.6a6 6 0 0 1-2 1.2l-1 2.4h-.1l-1-2.4a6 6 0 0 1-2-1.2l-2.5.6-1.4-2.4 1.8-1.8a6 6 0 0 1 0-2L4.9 8.6l1.4-2.4 2.5.6a6 6 0 0 1 2-1.2l1-2.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
    star: '<path d="M12 3.6l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.8l5.9-.9z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    starFill: '<path d="M12 3.6l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.8l5.9-.9z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
    trash: '<path d="M4.5 7h15M9.5 7V5.4c0-.8.6-1.4 1.4-1.4h2.2c.8 0 1.4.6 1.4 1.4V7m3.4 0-.6 12.1a1.9 1.9 0 0 1-1.9 1.8H9.1a1.9 1.9 0 0 1-1.9-1.8L6.6 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    pencil: '<path d="M14.8 4.6l4.6 4.6L8.5 20.1H3.9v-4.6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12.6 6.8l4.6 4.6" stroke="currentColor" stroke-width="1.8"/>',
    download: '<path d="M12 4v11m0 0-4.2-4.2M12 15l4.2-4.2M4.5 20h15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    upload: '<path d="M12 15V4m0 0L7.8 8.2M12 4l4.2 4.2M4.5 20h15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 14.5h-.3A1.7 1.7 0 0 1 3.5 12.8V4.7c0-1 .8-1.7 1.7-1.7h8.1c1 0 1.7.8 1.7 1.7v.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    scissors: '<circle cx="6.5" cy="6.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="6.5" cy="17.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.6 8.2 19 17.5M8.6 15.8 19 6.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    paste: '<rect x="5" y="5" width="14" height="16" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 5V3.8c0-.7.6-1.3 1.3-1.3h3.4c.7 0 1.3.6 1.3 1.3V5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 11h6M9 15h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    move: '<path d="M3.5 8.5c0-1.1.9-2 2-2h4l2-2.5h5c1.1 0 2 .9 2 2V10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M3.5 8.5V19c0 1.1.9 2 2 2h10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M16.5 21.5v-9M13 15.5l3.5-3.5 3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    duplicate: '<rect x="4" y="4" width="11" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 20h7.7c1 0 1.8-.8 1.8-1.8V8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    link: '<path d="M10.2 13.8a4.4 4.4 0 0 0 6.6.5l2.6-2.6a4.4 4.4 0 0 0-6.2-6.2l-1.5 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M13.8 10.2a4.4 4.4 0 0 0-6.6-.5l-2.6 2.6a4.4 4.4 0 0 0 6.2 6.2l1.5-1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    copypath: '<path d="M4.5 4.5v15h15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 15.5 18.5 5M18.5 5h-6M18.5 5v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    info: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 10.8V16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.8" r="1.15" fill="currentColor"/>',
    warning: '<path d="M12 4 21 19.5H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.05" fill="currentColor"/>',
    check: '<path d="M5 12.8l4.4 4.4L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    eye: '<path d="M2.5 12S6.2 5.5 12 5.5 21.5 12 21.5 12 17.8 18.5 12 18.5 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    ellipsis: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
    extlink: '<path d="M14 4h6v6M20 4 11 13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 13.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6.5A1.5 1.5 0 0 1 5 5h5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    repo: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4 19.5V5a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6.5A2.5 2.5 0 0 1 4 19.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 7.5h7M8.5 11h7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    clock: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    branch: '<circle cx="6.5" cy="5.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="6.5" cy="18.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="17.5" cy="8.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6.5 7.8v8.4M6.5 12c0-3 2.5-3.5 8-3.5" fill="none" stroke="currentColor" stroke-width="1.7"/>',
    code: '<path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    braces: '<path d="M9.5 4.5C7 4.5 8 9 5.5 9.7c2.5.7 1.5 5.2 4 5.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M14.5 4.5c2.5 0 1.5 4.5 4 5.2-2.5.7-1.5 5.2-4 5.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 3.5v17" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".45"/>',
    hash: '<path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    markup: '<path d="M8.5 8.5 5 12l3.5 3.5M15.5 8.5 19 12l-3.5 3.5M13 6l-2.5 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    markdown: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6.5 15.5v-7l2.7 3.4L12 8.5v7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 9v6.5M14 13.5l2 2 2-2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8.7" cy="9.7" r="1.7" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4.5 17.5l4.8-4.8 3.4 3.4 3-3 4.3 4.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    archive: '<path d="M4 8.5h16V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 4.5h18v4H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10.2 12h3.6v3h-3.6z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 8.5v1.2M13.5 8.5v1.2" stroke="currentColor" stroke-width="1.4"/>',
    audio: '<path d="M9.5 17.5V6.5l9-1.8v10.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7" cy="17.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="16" cy="15.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor"/>',
    font: '<path d="M5.5 19 12 5l6.5 14M8 14.5h8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    binary: '<rect x="4" y="3.5" width="16" height="17" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.5 9c-1.2 0-1.5-.8-1.5-1.7s.3-1.8 1.5-1.8 1.5.9 1.5 1.8S9.7 9 8.5 9zM8.5 9v5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 15c-1.2 0-1.5-.8-1.5-1.7s.3-1.8 1.5-1.8 1.5.9 1.5 1.8-.3 1.7-1.5 1.7zM15.5 15v5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    config: '<path d="M12 9.2c.4-1.4 1.7-2.4 3.2-2.2 1.9.2 3 2 2.5 3.8-.3 1.3-1.5 2-2.5 2.6M12 9.2c-.4-1.4-1.7-2.4-3.2-2.2-1.9.2-3 2-2.5 3.8.3 1.3 1.5 2 2.5 2.6M13.4 12.6l4.1 4.1M13.4 12.6l-1.4 5.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="9.2" r="1.1" fill="currentColor"/><path d="M6.6 12.6l5.4 5.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    pdf: '<path d="M7 3.5h7.5L19 8v12a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-16a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14.5 3.5V8H19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><text x="12" y="16.2" text-anchor="middle" font-size="6" font-weight="700" fill="currentColor" font-family="inherit">PDF</text>',
    doc: '<path d="M7 3.5h7.5L19 8v12a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-16a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14.5 3.5V8H19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9.5 12h5M9.5 15.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    docPlain: '<path d="M7 3.5h7.5L19 8v12a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-16a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14.5 3.5V8H19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    folder: '<path class="ghf-fold-back" d="M3 8.2V6.3c0-.8.7-1.5 1.5-1.5h4.1c.5 0 1 .25 1.3.65L11.5 7.4h8c.8 0 1.5.7 1.5 1.5v1.6H3z" fill="var(--folder-back)"/><path class="ghf-fold-front" d="M2.6 10h18.8a.6.6 0 0 1 .6.7l-1.5 8.6c-.13.74-.78 1.27-1.53 1.27H4.97c-.75 0-1.4-.53-1.53-1.27L2 10.7a.6.6 0 0 1 .6-.7z" fill="var(--folder-front)"/>',
    folderBig: '<path class="ghf-fold-back" d="M3 8.2V6.3c0-.8.7-1.5 1.5-1.5h4.1c.5 0 1 .25 1.3.65L11.5 7.4h8c.8 0 1.5.7 1.5 1.5v1.6H3z" fill="var(--folder-back)"/><path class="ghf-fold-front" d="M2.6 10h18.8a.6.6 0 0 1 .6.7l-1.5 8.6c-.13.74-.78 1.27-1.53 1.27H4.97c-.75 0-1.4-.53-1.53-1.27L2 10.7a.6.6 0 0 1 .6-.7z" fill="var(--folder-front)"/>',
    folderGhost: '<path d="M3 8V6.3c0-.8.7-1.5 1.5-1.5h4.1c.5 0 1 .25 1.3.65L11.5 7.3h8c.8 0 1.5.7 1.5 1.5v9.7c0 .8-.7 1.5-1.5 1.5h-15c-.8 0-1.5-.7-1.5-1.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" opacity=".9"/>',
    folderPlus: '<path class="ghf-fold-back" d="M3 8.2V6.3c0-.8.7-1.5 1.5-1.5h4.1c.5 0 1 .25 1.3.65L11.5 7.4h8c.8 0 1.5.7 1.5 1.5v1.6H3z" fill="var(--folder-back)"/><path class="ghf-fold-front" d="M2.6 10h18.8a.6.6 0 0 1 .6.7l-1.5 8.6c-.13.74-.78 1.27-1.53 1.27H4.97c-.75 0-1.4-.53-1.53-1.27L2 10.7a.6.6 0 0 1 .6-.7z" fill="var(--folder-front)"/><path d="M12 12.7v5M9.5 15.2h5" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>',
    docPlus: '<path d="M7 3.5h7.5L19 8v12a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-16a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14.5 3.5V8H19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 11v5M9.5 13.5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    key: '<circle cx="8" cy="14.5" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M11 11.5 19.5 3M16 6.5l2.8 2.8M13.8 8.7l2.1 2.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    logout: '<path d="M14 4.5H7A1.5 1.5 0 0 0 5.5 6v12A1.5 1.5 0 0 0 7 19.5h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M10.5 12H20m0 0-3.5-3.5M20 12l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    externalDrive: '<rect x="3" y="12" width="18" height="7.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 12 7.8 5.4c.2-.55.7-.9 1.3-.9h5.8c.6 0 1.1.35 1.3.9L18.5 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="17" cy="15.8" r="1" fill="currentColor"/>',
    arrowUpRight: '<path d="M7 17 17 7M9 7h8v8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  };

  /** Build an inline SVG string for a named icon. */
  function icon(name, size) {
    const p = ICON_PATHS[name] || ICON_PATHS.docPlain;
    const s = size || 16;
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true">${p}</svg>`;
  }
  const iconEl = (name, cls) => {
    const w = document.createElement('span');
    w.className = 'ghf-icon' + (cls ? ' ' + cls : '');
    w.innerHTML = icon(name);
    return w;
  };

  /* ══════════════════════════ §4 STORE / DOM UTILS / STATE ══════════════════════════ */

  /** Tampermonkey-backed JSON storage. The token lives ONLY here. */
  const store = {
    get(key, def) {
      try {
        const raw = GM_getValue('ghf:' + key, null);
        if (raw == null) return def;
        return JSON.parse(raw);
      } catch (e) { return def; }
    },
    set(key, val) { try { GM_setValue('ghf:' + key, JSON.stringify(val)); } catch (e) { /* storage full — non fatal */ } },
    del(key) { try { GM_deleteValue('ghf:' + key); } catch (e) { /* ignore */ } },
  };

  /** Create a DOM node with attributes / children. All dynamic text goes
   *  through here (textContent) — never innerHTML with untrusted values. */
  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v === true) n.setAttribute(k, '');
        else n.setAttribute(k, String(v));
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  }
  const qs = (root, sel) => root.querySelector(sel);
  const qsa = (root, sel) => [...root.querySelectorAll(sel)];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');
  const MOD = isMac ? '⌘' : 'Ctrl+';

  /** Copy text to the clipboard with a textarea fallback. */
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    try {
      const ta = el('textarea', { style: 'position:fixed;left:-999px;top:0;opacity:0' });
      ta.value = text;
      document.documentElement.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  /** Trigger a browser download for a Blob. */
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  /* ── Global application state ─────────────────────────── */
  const S = {
    token: store.get('token', ''),
    user: store.get('user', null),          // {login, avatar_url, name}
    repo: null,                             // {owner, name, branch, info, lazy}
    model: null,                            // RepoTree
    view: Object.assign({ mode: 'list', sortKey: 'name', sortDir: 1 }, store.get('view', {})),
    nav: { path: '', history: [], hi: -1, query: null },
    sel: new Set(), focus: '', anchor: '',
    clip: null,                             // {mode:'copy'|'cut', paths:[]}
    favorites: new Set(),
    expanded: new Set(['']),
    rate: { limit: 5000, remaining: 5000, reset: 0 },
    cooldownUntil: store.get('rateCooldownUntil', 0),
    pendingOps: 0,
    win: { open: false, min: false, max: false, rect: null, prevRect: null },
    repoKey: '',
    lastRepo: store.get('lastRepo', null),  // {owner, name}
    firstRun: !store.get('openedOnce', false),
  };

  const E = {};   // element refs, filled by the builders

  /** rAF-coalesced dirty rendering. markDirty('main','status',...) */
  const dirty = new Set();
  let flushQueued = false;
  function markDirty(...parts) {
    for (const p of parts) dirty.add(p);
    if (flushQueued) return;
    flushQueued = true;
    requestAnimationFrame(() => {
      flushQueued = false;
      flushDirty();
    });
  }
  function flushDirty() {
    if (!dirty.size) return;
    const parts = new Set(dirty);
    dirty.clear();
    try {
      if (parts.has('sidebar')) renderSidebar();
      if (parts.has('favorites')) renderFavorites();
      if (parts.has('main')) renderMain();
      if (parts.has('crumbs')) renderCrumbs();
      if (parts.has('title')) renderTitle();
      if (parts.has('status')) renderStatus();
      if (parts.has('toolbar')) renderToolbar();
    } catch (err) { /* a render error must never take the page down */ }
  }
  /** Force a full repaint (used after repo load / refresh). */
  function markAll() { markDirty('sidebar', 'favorites', 'main', 'crumbs', 'title', 'status', 'toolbar'); }

  /* ══════════════════════════ §5 CORE (pure, DOM-free) ══════════════════════════
     Everything between @@CORE_START@@ and @@CORE_END@@ is free of DOM access and
     unit-tested in Node (see scripts/test-core.mjs). */
  /* @@CORE_START@@ */

  /* ── Formatting ───────────────────────────────────────── */
  function formatBytes(n) {
    if (n == null || isNaN(n)) return '—';
    if (n < 1000) return n + ' bytes';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1000, i = 0;
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
    return (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')) + ' ' + units[i];
  }
  function formatCount(n) { return n.toLocaleString('en-US'); }

  /** macOS-style relative time. `now` is injectable for tests. */
  function relTime(ts, now) {
    const t = typeof ts === 'string' ? Date.parse(ts) : ts;
    if (isNaN(t)) return '';
    const n = now == null ? Date.now() : now;
    const s = Math.round((n - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 90) return 'a minute ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' minutes ago';
    const h = Math.round(m / 60);
    if (h < 24) return h === 1 ? 'an hour ago' : h + ' hours ago';
    const d = Math.round(h / 24);
    if (d < 31) return d === 1 ? 'yesterday' : d + ' days ago';
    const mo = Math.round(d / 30);
    if (mo < 12) return mo === 1 ? 'a month ago' : mo + ' months ago';
    const y = Math.round(mo / 12);
    return y === 1 ? 'a year ago' : y + ' years ago';
  }
  function formatClock(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  /* ── Path utilities ───────────────────────────────────── */
  const pathJoin = (dir, name) => (dir ? dir + '/' + name : name);
  function pathDir(p) {
    if (!p) return '';
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
  }
  function pathBase(p) { const i = p.lastIndexOf('/'); return i === -1 ? p : p.slice(i + 1); }
  function pathExt(name) {
    const i = name.lastIndexOf('.');
    if (i <= 0 || i === name.length - 1) return '';
    return name.slice(i + 1).toLowerCase();
  }
  const isDescendant = (ancestor, path) =>
    !!ancestor && !!path && (path === ancestor || path.startsWith(ancestor + '/'));
  function pathSegments(p) { return p ? p.split('/') : []; }

  /** Validate a user-supplied file/folder name. Throws Error with a reason. */
  function validateName(name) {
    const n = (name || '').trim();
    if (!n) throw new Error('The name cannot be empty.');
    if (n.length > 200) throw new Error('The name is too long (max 200 characters).');
    if (n === '.' || n === '..') throw new Error('“' + n + '” is not a valid name.');
    if (/[\\/\u0000-\u001f]/.test(n)) throw new Error('The name cannot contain “/”, “\\” or control characters.');
    return n;
  }
  /** URL-encode a repo path segment-by-segment, preserving slashes. */
  const encodePath = (p) => (p || '').split('/').map(encodeURIComponent).join('/');

  /* ── Base64 helpers (binary-safe, chunked) ────────────── */
  function bytesToB64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    const clean = (b64 || '').replace(/\s+/g, '');
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const utf8ToB64 = (str) => bytesToB64(new TextEncoder().encode(str));
  function b64ToUtf8(b64) { return new TextDecoder().decode(b64ToBytes(b64)); }
  const byteLength = (str) => new TextEncoder().encode(str).length;

  /* ── Natural compare (Finder-like: numeric aware, case folded) ── */
  const _coll = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  function naturalCompare(a, b) {
    const c = _coll.compare(a || '', b || '');
    return c !== 0 ? c : (a || '').localeCompare(b || '');
  }

  /* ── Kind / category mapping for files ────────────────── */
  const KIND_TABLE = {
    js: ['JavaScript Source', 'code', 'code'], mjs: ['JavaScript Source', 'code', 'code'],
    cjs: ['JavaScript Source', 'code', 'code'], jsx: ['React Component', 'code', 'code'],
    ts: ['TypeScript Source', 'code', 'code'], tsx: ['React Component', 'code', 'code'],
    py: ['Python Script', 'code', 'code'], rb: ['Ruby Script', 'code', 'code'],
    go: ['Go Source', 'code', 'code'], rs: ['Rust Source', 'code', 'code'],
    java: ['Java Source', 'code', 'code'], kt: ['Kotlin Source', 'code', 'code'],
    swift: ['Swift Source', 'code', 'code'], c: ['C Source', 'code', 'code'],
    h: ['C Header', 'code', 'code'], cpp: ['C++ Source', 'code', 'code'],
    cc: ['C++ Source', 'code', 'code'], hpp: ['C++ Header', 'code', 'code'],
    cs: ['C# Source', 'code', 'code'], php: ['PHP Script', 'code', 'code'],
    sh: ['Shell Script', 'code', 'code'], bash: ['Shell Script', 'code', 'code'],
    zsh: ['Shell Script', 'code', 'code'], sql: ['SQL Script', 'code', 'code'],
    dart: ['Dart Source', 'code', 'code'], lua: ['Lua Script', 'code', 'code'],
    pl: ['Perl Script', 'code', 'code'], r: ['R Script', 'code', 'code'],
    vue: ['Vue Component', 'markup', 'markup'], svelte: ['Svelte Component', 'markup', 'markup'],
    html: ['HTML Document', 'markup', 'markup'], htm: ['HTML Document', 'markup', 'markup'],
    xml: ['XML Document', 'markup', 'markup'], svg: ['SVG Image', 'image', 'image'],
    css: ['Style Sheet', 'style', 'hash'], scss: ['Sass Style Sheet', 'style', 'hash'],
    less: ['Less Style Sheet', 'style', 'hash'],
    json: ['JSON Data', 'data', 'braces'], yml: ['YAML Config', 'data', 'config'],
    yaml: ['YAML Config', 'data', 'config'], toml: ['TOML Config', 'data', 'config'],
    csv: ['CSV Data', 'data', 'doc'], tsv: ['TSV Data', 'data', 'doc'],
    md: ['Markdown Document', 'markdown', 'markdown'], mdx: ['MDX Document', 'markdown', 'markdown'],
    markdown: ['Markdown Document', 'markdown', 'markdown'], rst: ['reStructuredText', 'markdown', 'markdown'],
    png: ['PNG Image', 'image', 'image'], jpg: ['JPEG Image', 'image', 'image'],
    jpeg: ['JPEG Image', 'image', 'image'], gif: ['GIF Image', 'image', 'image'],
    webp: ['WebP Image', 'image', 'image'], avif: ['AVIF Image', 'image', 'image'],
    bmp: ['Bitmap Image', 'image', 'image'], ico: ['Icon Image', 'image', 'image'],
    tiff: ['TIFF Image', 'image', 'image'],
    mp3: ['MP3 Audio', 'audio', 'audio'], wav: ['WAV Audio', 'audio', 'audio'],
    ogg: ['OGG Audio', 'audio', 'audio'], flac: ['FLAC Audio', 'audio', 'audio'],
    m4a: ['M4A Audio', 'audio', 'audio'],
    mp4: ['MP4 Video', 'video', 'video'], mov: ['QuickTime Movie', 'video', 'video'],
    webm: ['WebM Video', 'video', 'video'], avi: ['AVI Video', 'video', 'video'],
    mkv: ['Matroska Video', 'video', 'video'],
    zip: ['ZIP Archive', 'archive', 'archive'], gz: ['Gzip Archive', 'archive', 'archive'],
    tar: ['Tar Archive', 'archive', 'archive'], '7z': ['7-Zip Archive', 'archive', 'archive'],
    rar: ['RAR Archive', 'archive', 'archive'], bz2: ['Bzip2 Archive', 'archive', 'archive'],
    pdf: ['PDF Document', 'pdf', 'pdf'],
    woff: ['Web Font', 'font', 'font'], woff2: ['Web Font', 'font', 'font'],
    ttf: ['TrueType Font', 'font', 'font'], otf: ['OpenType Font', 'font', 'font'],
    txt: ['Plain Text', 'text', 'docPlain'], text: ['Plain Text', 'text', 'docPlain'],
    log: ['Log File', 'text', 'docPlain'], lic: ['License File', 'text', 'doc'],
    lock: ['Lock File', 'config', 'config'], env: ['Environment File', 'config', 'config'],
    gitignore: ['Git Config', 'config', 'config'], gitattributes: ['Git Config', 'config', 'config'],
    editorconfig: ['Editor Config', 'config', 'config'],
    exe: ['Executable', 'binary', 'binary'], dll: ['Binary Library', 'binary', 'binary'],
    so: ['Binary Library', 'binary', 'binary'], dylib: ['Binary Library', 'binary', 'binary'],
    bin: ['Binary File', 'binary', 'binary'], dat: ['Data File', 'binary', 'binary'],
    wasm: ['WebAssembly', 'binary', 'binary'],
  };
  const SPECIAL_NAMES = {
    'package.json': ['npm Manifest', 'data', 'braces'],
    'package-lock.json': ['npm Lock File', 'data', 'braces'],
    'tsconfig.json': ['TypeScript Config', 'data', 'braces'],
    'dockerfile': ['Dockerfile', 'config', 'config'],
    'makefile': ['Makefile', 'config', 'config'],
    'license': ['License File', 'text', 'doc'],
    'readme': ['Readme', 'markdown', 'markdown'],
  };
  /** → {label, cat, icon} — category drives colour, icon drives the glyph. */
  function kindInfo(name, isDir) {
    if (isDir) return { label: 'Folder', cat: 'folder', icon: 'folder' };
    const special = SPECIAL_NAMES[name.toLowerCase()];
    if (special) return { label: special[0], cat: special[1], icon: special[2] };
    const ext = pathExt(name);
    const k = KIND_TABLE[ext];
    if (k) return { label: k[0], cat: k[1], icon: k[2] };
    return { label: ext ? ext.toUpperCase() + ' File' : 'Document', cat: 'text', icon: ext ? 'doc' : 'docPlain' };
  }
  /** Can the file be previewed/edited as text? */
  function isTextKind(name) {
    const ki = kindInfo(name, false);
    return ['text', 'code', 'markup', 'style', 'data', 'markdown', 'config'].includes(ki.cat);
  }
  function langForFile(name) {
    const ext = pathExt(name);
    const map = {
      js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts',
      json: 'json', py: 'py', rb: 'rb', sh: 'sh', bash: 'sh', zsh: 'sh',
      yml: 'yml', yaml: 'yml', toml: 'yml', css: 'css', scss: 'css', less: 'css',
      html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', md: 'md', mdx: 'md',
      c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', java: 'java', cs: 'java',
      go: 'go', rs: 'rs', php: 'php', sql: 'sql', swift: 'swift', kt: 'swift', dart: 'swift',
      lua: 'lua', env: 'sh', lock: 'json',
    };
    return map[ext] || null;
  }

  /* ── CRC32 + minimal ZIP writer (STORE method) ────────── */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function _u16(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }
  function _u32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
  function _concatU8(arr) {
    let len = 0;
    for (const a of arr) len += a.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const a of arr) { out.set(a, o); o += a.length; }
    return out;
  }
  function dosDateTime(d) {
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, date };
  }
  /** Build a zip (no compression). entries: [{name, data:Uint8Array}] —
   *  a trailing "/" marks a directory entry. Returns Blob parts. */
  function buildZip(entries) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;
    const push = (u8) => { chunks.push(u8); offset += u8.length; };
    for (const e of entries) {
      const nameB = enc.encode(e.name);
      const data = e.data || new Uint8Array(0);
      const isDir = e.name.endsWith('/');
      const crc = data.length ? crc32(data) : 0;
      const external = isDir ? 0x41ED0010 : 0x81A40000;
      const lfhOffset = offset;
      push(_concatU8([
        _u32(0x04034b50), _u16(20), _u16(0x0800), _u16(0), _u16(time), _u16(date),
        _u32(crc), _u32(data.length), _u32(data.length), _u16(nameB.length), _u16(0), nameB,
      ]));
      if (data.length) push(data);
      central.push({ nameB, crc, size: data.length, external, lfhOffset });
    }
    const cdStart = offset;
    for (const c of central) {
      push(_concatU8([
        _u32(0x02014b50), _u16((3 << 8) | 20), _u16(20), _u16(0x0800), _u16(0), _u16(time), _u16(date),
        _u32(c.crc), _u32(c.size), _u32(c.size), _u16(c.nameB.length), _u16(0), _u16(0), _u16(0), _u16(0),
        _u32(c.external), _u32(c.lfhOffset), c.nameB,
      ]));
    }
    const cdSize = offset - cdStart;
    push(_concatU8([
      _u32(0x06054b50), _u16(0), _u16(0), _u16(central.length), _u16(central.length),
      _u32(cdSize), _u32(cdStart), _u16(0),
    ]));
    return chunks;
  }

  /* ── Syntax highlighter (safe, streaming, per-language config) ── */
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  const KW = (s) => new Set(s.split(' '));
  const LANGS = {
    js: { line: '//', block: ['/*', '*/'], quotes: ['\'', '"', '`'], kw: KW('async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined NaN') },
    ts: { line: '//', block: ['/*', '*/'], quotes: ['\'', '"', '`'], kw: KW('abstract any as asserts async await boolean break case catch class const continue declare default delete do else enum export extends finally for from function get if implements import in infer interface is keyof let module namespace never new of private protected public readonly return satisfies set static string super switch symbol this throw try type typeof undefined union unknown var void while yield true false null') },
    json: { line: null, block: null, quotes: ['"'], kw: KW('true false null') },
    py: { line: '#', block: null, quotes: ['\'', '"'], kw: KW('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self') },
    rb: { line: '#', block: null, quotes: ['\'', '"'], kw: KW('begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true unless until when while yield require') },
    sh: { line: '#', block: null, quotes: ['\'', '"', '`'], kw: KW('if then else elif fi for while do done case esac function return in export local source echo cd rm mkdir cp mv') },
    yml: { line: '#', block: null, quotes: ['\'', '"'], kw: KW('true false null yes no on off') },
    css: { line: null, block: ['/*', '*/'], quotes: ['\'', '"'], kw: KW('important media supports keyframes import from to and not only') },
    html: { line: null, block: ['<!--', '-->'], quotes: ['"', '\''], kw: KW('') },
    md: null, // handled by its own renderer
    c: { line: '//', block: ['/*', '*/'], quotes: ['"', '\''], kw: KW('auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while include define NULL true false') },
    java: { line: '//', block: ['/*', '*/'], quotes: ['"', '\''], kw: KW('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var true false null record') },
    go: { line: '//', block: ['/*', '*/'], quotes: ['"', '\'', '`'], kw: KW('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota make new len cap append copy delete panic recover') },
    rs: { line: '//', block: ['/*', '*/'], quotes: ['"', '\''], kw: KW('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while') },
    php: { line: '//', block: ['/*', '*/'], quotes: ['\'', '"'], kw: KW('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include instanceof insteadof interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while xor yield true false null') },
    sql: { line: '--', block: ['/*', '*/'], quotes: ['\'', '"'], kw: KW('SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS AND OR NOT NULL IS LIKE IN BETWEEN DISTINCT UNION ALL PRIMARY KEY FOREIGN REFERENCES DEFAULT CHECK UNIQUE CASCADE BEGIN COMMIT ROLLBACK') },
    swift: { line: '//', block: ['/*', '*/'], quotes: ['"', '\''], kw: KW('associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as Any catch false is nil super self throw throws true try') },
    lua: { line: '--', block: ['--[[', ']]'], quotes: ['\'', '"'], kw: KW('and break do else elseif end false for function goto if in local nil not or repeat return then true until while') },
  };

  function _kwRegex(kw) {
    const words = [...kw].filter(Boolean);
    return words.length
      ? new RegExp('\\b(?:' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b|\\b0x[0-9a-fA-F]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b', 'g')
      : /\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
  }
  const _kwCache = new Map();
  function _kwFor(lang) {
    if (!_kwCache.has(lang)) _kwCache.set(lang, _kwRegex(LANGS[lang].kw));
    return _kwCache.get(lang);
  }

  /** Emit plain text, applying keyword + number tokens. */
  function _emitPlain(out, text, lang) {
    if (!text) return;
    const re = _kwFor(lang);
    re.lastIndex = 0;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(escapeHtml(text.slice(last, m.index)));
      out.push('<span class="ghf-tok-' + (/^\d|^0x/.test(m[0]) ? 'num' : 'kw') + '">' + escapeHtml(m[0]) + '</span>');
      last = m.index + m[0].length;
    }
    out.push(escapeHtml(text.slice(last)));
  }

  /** Tokenize + highlight. Returns HTML (fully escaped — safe for innerHTML). */
  function highlightCode(code, lang) {
    if (!code) return '';
    if (lang === 'md') return highlightMd(code);
    const cfg = LANGS[lang];
    if (!cfg || code.length > 600000) return escapeHtml(code);
    const specials = [];
    if (cfg.line) specials.push(cfg.line);
    if (cfg.block) { specials.push(cfg.block[0]); }
    for (const q of cfg.quotes) specials.push(q);
    if (lang === 'html') specials.push('<'); // tag scanning
    const startRe = new RegExp(specials.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');

    /** Emit an HTML tag segment (tag wrapper + strings inside). */
    const emitTag = (tagText) => {
      // Highlight attribute strings inside the tag.
      const parts = [];
      let last = 0;
      const re = /("[^"]*"|'[^']*')/g;
      let m;
      while ((m = re.exec(tagText))) {
        if (m.index > last) parts.push(escapeHtml(tagText.slice(last, m.index)));
        parts.push('<span class="ghf-tok-str">' + escapeHtml(m[0]) + '</span>');
        last = m.index + m[0].length;
      }
      parts.push(escapeHtml(tagText.slice(last)));
      return '<span class="ghf-tok-tag">' + parts.join('') + '</span>';
    };

    const out = [];
    let i = 0;
    const n = code.length;
    while (i < n) {
      startRe.lastIndex = i;
      const m = startRe.exec(code);
      if (!m || m.index !== i) {
        // plain run until next special (or EOF)
        const nextIdx = m ? m.index : n;
        _emitPlain(out, code.slice(i, nextIdx), lang);
        i = nextIdx;
        continue;
      }
      const tok = m[0];
      if (lang === 'html' && tok === '<') {
        const end = code.indexOf('>', i);
        const stop = end === -1 ? n : end + 1;
        out.push(emitTag(code.slice(i, stop)));
        i = stop;
      } else if (cfg.block && tok === cfg.block[0]) {
        const end = code.indexOf(cfg.block[1], i + tok.length);
        const stop = end === -1 ? n : end + cfg.block[1].length;
        out.push('<span class="ghf-tok-com">' + escapeHtml(code.slice(i, stop)) + '</span>');
        i = stop;
      } else if (cfg.line && tok === cfg.line) {
        let end = code.indexOf('\n', i);
        if (end === -1) end = n;
        out.push('<span class="ghf-tok-com">' + escapeHtml(code.slice(i, end)) + '</span>');
        i = end; // keep the newline for the next plain run
      } else {
        // string: find the closing quote; ' and " stop at newline, ` spans
        const q = tok;
        let j = i + 1;
        while (j < n) {
          const ch = code[j];
          if (ch === '\\') { j += 2; continue; }
          if (ch === q) { j++; break; }
          if (ch === '\n' && q !== '`') break;
          j++;
        }
        out.push('<span class="ghf-tok-str">' + escapeHtml(code.slice(i, Math.min(j, n))) + '</span>');
        i = Math.min(j, n);
      }
    }
    return out.join('');
  }

  /** Markdown renderer (headings, fences, inline code, bold, links, quotes). */
  function highlightMd(code) {
    if (code.length > 600000) return escapeHtml(code);
    const out = [];
    let inFence = false;
    for (const rawLine of code.split('\n')) {
      let line = escapeHtml(rawLine);
      if (/^\s*(```|~~~)/.test(rawLine)) {
        inFence = !inFence;
        out.push('<span class="ghf-tok-com">' + line + '</span>');
        continue;
      }
      if (inFence) { out.push('<span class="ghf-tok-str">' + line + '</span>'); continue; }
      // inline code
      line = line.replace(/(`[^`]+`)/g, '<span class="ghf-tok-str">$1</span>');
      // bold + links
      line = line.replace(/(\*\*[^*]+\*\*)/g, '<span class="ghf-tok-kw">$1</span>');
      line = line.replace(/(\[[^\]]*\]\([^)]*\))/g, '<span class="ghf-tok-tag">$1</span>');
      let wrapped = line;
      if (/^\s{0,3}#{1,6}\s/.test(rawLine)) wrapped = '<span class="ghf-tok-kw">' + line + '</span>';
      else if (/^\s{0,3}>/.test(rawLine)) wrapped = '<span class="ghf-tok-com">' + line + '</span>';
      out.push(wrapped);
    }
    return out.join('\n');
  }
  /* @@CORE_END@@ */

  /* ══════════════════════════ §6 TREE MODEL ══════════════════════════
     Single in-memory repository tree. All structural mutations go through
     the methods here; each returns an `undo` closure restoring the exact
     prior state (used for optimistic rollback). byPath is the O(1) index. */
  /* @@CORE2_START@@ */

  let _nodeUid = 0;
  class Node {
    constructor(props) {
      this.id = ++_nodeUid;
      this.name = '';          // segment name
      this.path = '';          // repo-relative path ('' = root)
      this.type = 'file';      // 'file' | 'dir'
      this.size = 0;
      this.sha = null;         // blob sha (files) / tree sha (dirs)
      this.mode = '100644';
      this.parent = null;
      this.children = null;    // Map<name, Node> for dirs
      this.pending = false;    // optimistic change still in flight
      this.lazy = false;       // subtree not fully loaded (truncated repos)
      this.loaded = true;      // children fetched?
      this.loading = false;
      this.lastCommit = null;  // {when, data} cache for folder chip / preview
      Object.assign(this, props);
      if (this.type === 'dir' && !this.children) this.children = new Map();
    }
  }

  class RepoTree {
    constructor(rootSha) {
      this.root = new Node({ type: 'dir', path: '', name: '', sha: rootSha || null, children: new Map() });
      this.byPath = new Map([['', this.root]]);
      this._sorted = new Map(); // path -> {key, dir, arr}
    }
    _mapNode(n) {
      this.byPath.set(n.path, n);
      if (n.children) for (const c of n.children.values()) this._mapNode(c);
    }
    _unmapNode(n) {
      this.byPath.delete(n.path);
      if (n.children) for (const c of n.children.values()) this._unmapNode(c);
    }
    _touchAll() { this._sorted.clear(); }

    get(path) { return this.byPath.get(path) || null; }
    has(path) { return this.byPath.has(path); }

    /** Build from `git/trees?recursive=1` entries (order-independent). */
    static build(entries, rootSha) {
      const t = new RepoTree(rootSha);
      for (const e of entries) t._insertEntry(e);
      t._touchAll();
      return t;
    }
    /** Insert a single raw tree entry (skips duplicates). */
    _insertEntry(e) {
      if (!e || typeof e.path !== 'string' || !e.path) return null;
      if (this.byPath.has(e.path)) return this.byPath.get(e.path);
      const parent = this._ensureDir(pathDir(e.path), true);
      const node = new Node({
        name: pathBase(e.path), path: e.path,
        type: e.type === 'tree' ? 'dir' : 'file',
        sha: e.sha || null,
        size: e.type === 'blob' ? (e.size || 0) : 0,
        mode: e.mode || (e.type === 'tree' ? '040000' : '100644'),
        parent,
        lazy: e.type === 'tree',
        loaded: e.type !== 'tree',
      });
      parent.children.set(node.name, node);
      this.byPath.set(node.path, node);
      return node;
    }
    /** Ensure a dir exists at `path`, creating placeholder lazy dirs as needed. */
    _ensureDir(path, lazy) {
      if (!path) return this.root;
      const ex = this.byPath.get(path);
      if (ex) return ex;
      const parent = this._ensureDir(pathDir(path), lazy);
      const node = new Node({ type: 'dir', name: pathBase(path), path, parent, lazy: !!lazy, loaded: !lazy });
      parent.children.set(node.name, node);
      this.byPath.set(node.path, node);
      return node;
    }

    /** Sorted children of a dir (dirs first, then by current sort). */
    sortedChildren(dirPath, sortKey, sortDir) {
      const dir = this.byPath.get(dirPath);
      if (!dir || !dir.children) return [];
      const cacheKey = dirPath + '|' + sortKey + '|' + sortDir;
      const hit = this._sorted.get(cacheKey);
      if (hit) return hit;
      const arr = [...dir.children.values()].sort((a, b) => {
        const ad = a.type === 'dir' ? 1 : 0, bd = b.type === 'dir' ? 1 : 0;
        if (ad !== bd) return bd - ad;                       // folders first
        let c = 0;
        if (sortKey === 'size') c = (a.type === 'dir' ? a.children.size : a.size) - (b.type === 'dir' ? b.children.size : b.size);
        else if (sortKey === 'kind') c = naturalCompare(kindInfo(a.name, a.type === 'dir').label, kindInfo(b.name, b.type === 'dir').label);
        if (c !== 0) return c * (sortDir || 1);
        return naturalCompare(a.name, b.name);
      });
      this._sorted.set(cacheKey, arr);
      return arr;
    }

    /** Flatten subtree into a list of file nodes. */
    filesUnder(node) {
      const out = [];
      const walk = (n) => {
        if (n.type === 'file') out.push(n);
        else if (n.children) for (const c of n.children.values()) walk(c);
      };
      walk(node || this.root);
      return out;
    }
    /** Recursive size of a subtree (files only). */
    treeSize(node) {
      if (!node) return 0;
      if (node.type === 'file') return node.size || 0;
      let s = 0;
      for (const c of node.children.values()) s += this.treeSize(c);
      return s;
    }
    countUnder(node) {
      let n = 0;
      const walk = (x) => { if (x.children) for (const c of x.children.values()) { n++; walk(c); } };
      walk(node || this.root);
      return n;
    }

    /* ── Mutations (each returns {undo, touchedDirs}) ─────── */

    /** Detach node from its parent (keeps subtree intact). */
    _detach(node) {
      if (!node.parent) return;
      node.parent.children.delete(node.name);
      this._unmapNode(node);
      this._touchAll();
    }
    /** Recompute .path for a whole subtree from parent links, then re-index. */
    _repathAndMap(node) {
      if (node.parent) node.path = pathJoin(node.parent.path, node.name);
      this.byPath.set(node.path, node);
      if (node.children) for (const c of node.children.values()) this._repathAndMap(c);
    }
    _attach(node, dirNode) {
      node.parent = dirNode;
      dirNode.children.set(node.name, node);
      this._repathAndMap(node);
      this._touchAll();
    }
    /** Remove dirs that became empty, bottom-up. Returns detached dirs. */
    _cascadeEmpty(startDir) {
      const removed = [];
      let d = startDir;
      while (d && d !== this.root && d.children && d.children.size === 0) {
        const parent = d.parent;
        this._detach(d);
        removed.push(d);
        d = parent;
      }
      return removed;
    }

    /** Add a brand-new node under dirPath. */
    addNew(dirPath, props) {
      const dir = this.byPath.get(dirPath);
      if (!dir || dir.type !== 'dir') throw new Error('Destination folder not found.');
      const name = props.name;
      if (dir.children.has(name)) throw new Error('An item named “' + name + '” already exists here.');
      const node = new Node(Object.assign({ parent: dir, path: pathJoin(dirPath, name), pending: true }, props));
      dir.children.set(name, node);
      this.byPath.set(node.path, node);
      if (node.type === 'dir') node.loaded = true;
      this._touchAll();
      const undo = () => { dir.children.delete(name); this._unmapNode(node); this._touchAll(); };
      return { node, undo, touchedDirs: [dirPath] };
    }

    /** Remove nodes by path (descendants of other removed nodes skipped).
     *  Empty parent folders are pruned (git cannot store them). */
    removeNodes(paths) {
      const tops = [];
      const seen = new Set();
      for (const p of paths) {
        const node = this.byPath.get(p);
        if (!node || !node.parent) continue;
        if (paths.some((q) => q !== p && isDescendant(q, p))) continue; // inside another removed node
        if (seen.has(p)) continue;
        seen.add(p);
        tops.push(node);
      }
      if (!tops.length) throw new Error('Nothing to delete.');
      const snapshot = tops.map((n) => ({ node: n, parentPath: pathDir(n.path) }));
      const removed = [];
      for (const n of tops) { this._detach(n); removed.push(n); }
      const cascade = new Set();
      for (const s of snapshot) {
        for (const d of this._cascadeEmpty(this.byPath.get(s.parentPath))) {
          removed.push(d);
          cascade.add(pathDir(d.path));
        }
      }
      this._touchAll();
      const undo = () => {
        for (let i = removed.length - 1; i >= 0; i--) {
          const n = removed[i];
          const parent = this.byPath.get(pathDir(n.path));
          if (parent) this._attach(n, parent);
        }
        this._touchAll();
      };
      const touched = new Set([...snapshot.map((s) => s.parentPath), ...cascade]);
      return { removed, undo, touchedDirs: [...touched] };
    }

    /** Rename a node in place (keeps its position in the same folder). */
    rename(path, newName) {
      const node = this.byPath.get(path);
      if (!node || !node.parent) throw new Error('Item not found.');
      if (node.parent.children.has(newName) && node.parent.children.get(newName) !== node) {
        throw new Error('An item named “' + newName + '” already exists here.');
      }
      const oldName = node.name, oldPath = node.path;
      node.parent.children.delete(oldName);
      this._unmapNode(node); // drop all old-path keys (whole subtree)
      node.name = newName;
      node.parent.children.set(newName, node);
      this._repathAndMap(node); // rewrite descendant paths + re-index
      this._touchAll();
      const undo = () => {
        node.parent.children.delete(newName);
        this._unmapNode(node);
        node.name = oldName;
        node.parent.children.set(oldName, node);
        this._repathAndMap(node);
        this._touchAll();
      };
      return { undo, touchedDirs: [node.parent.path], newPath: node.path };
    }

    /** Move nodes into destDir. moves: [{path, destDirPath}] (validated first). */
    moveNodes(moves) {
      if (!moves.length) throw new Error('Nothing to move.');
      const prepared = [];
      for (const mv of moves) {
        const node = this.byPath.get(mv.path);
        const dest = this.byPath.get(mv.destDirPath);
        if (!node || !node.parent) throw new Error('Item not found: ' + mv.path);
        if (!dest || dest.type !== 'dir') throw new Error('Destination folder not found.');
        if (mv.path === mv.destDirPath || isDescendant(mv.path, mv.destDirPath)) {
          throw new Error('A folder cannot be moved into itself.');
        }
        if (pathDir(mv.path) === mv.destDirPath) continue; // no-op
        if (dest.children.has(node.name)) {
          throw new Error('An item named “' + node.name + '” already exists in the destination.');
        }
        prepared.push({ node, dest });
      }
      if (!prepared.length) throw new Error('Already in that folder.');
      for (const p of prepared) p.origParent = pathDir(p.node.path); // record before detaching
      const oldParents = prepared.map((p) => p.origParent);
      for (const p of prepared) this._detach(p.node);
      const cascades = [];
      oldParents.forEach((pp) => {
        for (const d of this._cascadeEmpty(this.byPath.get(pp))) { cascades.push({ dir: d, parentPath: pathDir(d.path) }); }
      });
      for (const p of prepared) this._attach(p.node, p.dest);
      this._touchAll();
      const newPaths = prepared.map((p) => p.node.path);
      const undo = () => {
        for (const p of prepared) this._detach(p.node);
        // re-attach pruned (emptied) source folders first, deepest chains first
        for (let i = cascades.length - 1; i >= 0; i--) {
          const parent = this.byPath.get(cascades[i].parentPath);
          if (parent) this._attach(cascades[i].dir, parent);
        }
        for (const p of prepared) {
          const parent = this.byPath.get(p.origParent);
          if (parent) this._attach(p.node, parent);
        }
        this._touchAll();
      };
      const touched = new Set([...oldParents, ...moves.map((m) => m.destDirPath)]);
      for (const c of cascades) touched.add(c.parentPath);
      return { undo, touchedDirs: [...touched], newPaths };
    }

    /** Deep-clone a node (same blob/tree shas) into destDir under newName. */
    cloneNode(path, destDirPath, newName) {
      const src = this.byPath.get(path);
      const dest = this.byPath.get(destDirPath);
      if (!src) throw new Error('Item not found.');
      if (!dest || dest.type !== 'dir') throw new Error('Destination folder not found.');
      if (dest.children.has(newName)) throw new Error('An item named “' + newName + '” already exists here.');
      const cloneInto = (srcNode, parentNode, name) => {
        const copy = new Node({
          name, path: pathJoin(parentNode.path, name), type: srcNode.type,
          size: srcNode.size, sha: srcNode.sha, mode: srcNode.mode, parent: parentNode, pending: true,
        });
        if (srcNode.children) {
          copy.children = new Map();
          for (const c of srcNode.children.values()) cloneInto(c, copy, c.name);
        }
        parentNode.children.set(name, copy);
        this.byPath.set(copy.path, copy);
        return copy;
      };
      const top = cloneInto(src, dest, newName);
      this._touchAll();
      const undo = () => { dest.children.delete(newName); this._unmapNode(top); this._touchAll(); };
      return { node: top, undo, touchedDirs: [destDirPath] };
    }

    /** Patch node props (sha/size/pending…) — no undo needed. */
    patchNode(path, props) {
      const n = this.byPath.get(path);
      if (!n) return null;
      Object.assign(n, props);
      this._touchAll();
      return n;
    }
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  /* @@CORE2_END@@ */

  /* ══════════════════════════ §7 GITHUB API CLIENT ══════════════════════════ */

  class ApiError extends Error {
    constructor(message, status, extra) {
      super(message);
      this.name = 'ApiError';
      this.status = status || 0;
      Object.assign(this, extra || {});
    }
  }

  /** Low-level request: GM_xmlhttpRequest with a fetch fallback. */
  function xmr({ method, url, headers, body, timeout }) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method, url, headers: headers || {}, data: body == null ? undefined : body,
          timeout: timeout || CFG.REQ_TIMEOUT,
          onload: (res) => {
            const hmap = {};
            (res.responseHeaders || '').split(/\r?\n/).forEach((line) => {
              const i = line.indexOf(':');
              if (i > 0) hmap[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
            });
            resolve({ status: res.status, headers: hmap, text: res.responseText || '' });
          },
          onerror: () => reject(new ApiError('Network error — request could not reach api.github.com', 0)),
          ontimeout: () => reject(new ApiError('Request timed out', 0)),
        });
      } else {
        // Fallback for userscript managers without GM_xmlhttpRequest.
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout || CFG.REQ_TIMEOUT);
        fetch(url, { method, headers, body: body == null ? undefined : body, signal: ctrl.signal })
          .then(async (res) => {
            const hmap = {};
            res.headers.forEach((v, k) => { hmap[k.toLowerCase()] = v; });
            resolve({ status: res.status, headers: hmap, text: await res.text() });
          })
          .catch(() => reject(new ApiError('Network error — request could not reach api.github.com', 0)))
          .finally(() => clearTimeout(t));
      }
    });
  }

  function friendlyApiError(status, parsed, context, headers) {
    const srvMsg = parsed && typeof parsed.message === 'string' ? parsed.message.replace(/\s+/g, ' ').trim() : '';
    if (status === 401) return new ApiError('GitHub rejected your token (401 Unauthorized). Open Settings and paste a valid token.', status);
    if (status === 403) {
      const reset = headers && headers['x-ratelimit-reset'];
      if (reset && +headers['x-ratelimit-remaining'] === 0) {
        const when = new Date(+reset * 1000);
        return new ApiError('Rate limit exceeded — resets at ' + when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + '.', status, { rateLimited: true, resetAt: +reset * 1000 });
      }
      return new ApiError((srvMsg || 'Access denied') + ' (403). If this repo is private, your token needs the “repo” scope.', status);
    }
    if (status === 404) return new ApiError((srvMsg || 'Not found') + ' (404). Check that the repo and branch exist and your token can see them.', status);
    if (status === 409) return new ApiError((srvMsg || 'Conflict') + ' (409).', status, { conflict: true });
    if (status === 422) {
      let det = srvMsg;
      if (parsed && Array.isArray(parsed.errors) && parsed.errors.length && parsed.errors[0].message) det += ' — ' + parsed.errors[0].message;
      return new ApiError((det || 'Validation failed') + ' (422).', status, { conflict: true });
    }
    return new ApiError(srvMsg || ('Request failed with status ' + status), status);
  }

  const API = {
    /** Core request with rate-limit tracking + retry/backoff. */
    async request(method, path, opts = {}) {
      const { body, query, token, context = '' } = opts;
      if (Date.now() < S.cooldownUntil) {
        const when = new Date(S.cooldownUntil).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        throw new ApiError('Rate limit exceeded — pausing until ' + when + '.', 403, { rateLimited: true });
      }
      const useToken = token != null ? token : S.token;
      let url = CFG.API + path;
      if (query) url += '?' + new URLSearchParams(query).toString();
      const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': CFG.API_VERSION };
      if (useToken) headers.Authorization = 'Bearer ' + useToken;
      let payload;
      if (body != null) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        let res;
        try { res = await xmr({ method, url, headers, body: payload }); }
        catch (e) { lastErr = e; await sleep(450 * Math.pow(2, attempt) + Math.random() * 250); continue; }
        // Track rate limits from every response.
        const h = res.headers;
        if (h['x-ratelimit-limit']) {
          S.rate = {
            limit: +h['x-ratelimit-limit'] || S.rate.limit,
            remaining: h['x-ratelimit-remaining'] != null ? +h['x-ratelimit-remaining'] : S.rate.remaining,
            reset: h['x-ratelimit-reset'] ? +h['x-ratelimit-reset'] * 1000 : S.rate.reset,
          };
          markDirty('status');
        }
        let parsed = null;
        try { parsed = res.text ? JSON.parse(res.text) : null; } catch (e) { parsed = null; }

        if (res.status >= 200 && res.status < 300) return parsed;

        // Secondary rate limit: honor Retry-After once.
        if ((res.status === 403 || res.status === 429) && h['retry-after'] && attempt < 2) {
          await sleep(Math.min(+h['retry-after'] * 1000, 30) * 1 + 1000);
          continue;
        }
        if (res.status >= 500 && attempt < 2) {
          lastErr = friendlyApiError(res.status, parsed, context, h);
          await sleep(500 * Math.pow(2, attempt) + Math.random() * 300);
          continue;
        }
        const err = friendlyApiError(res.status, parsed, context, h);
        if (err.rateLimited) { S.cooldownUntil = err.resetAt || (Date.now() + 60000); store.set('rateCooldownUntil', S.cooldownUntil); }
        if (res.status === 401) err.needsSettings = true;
        throw err;
      }
      throw lastErr || new ApiError('Request failed', 0);
    },

    /* ── Typed endpoint helpers ─────────────────────────── */
    getUser: (token) => API.request('GET', '/user', { token, context: 'user' }),
    getRepo: (ctx) => API.request('GET', '/repos/' + encodeURIComponent(ctx.owner) + '/' + encodeURIComponent(ctx.name), { context: 'repo' }),
    getBranch: (ctx, branch) => API.request('GET', '/repos/' + encodeURIComponent(ctx.owner) + '/' + encodeURIComponent(ctx.name) + '/branches/' + branch.split('/').map(encodeURIComponent).join('/'), { context: 'branch' }).catch((e) => e.status === 404 ? null : Promise.reject(e)),
    getTreeRecursive: (ctx) => API.request('GET', '/repos/' + encodeURIComponent(ctx.owner) + '/' + encodeURIComponent(ctx.name) + '/git/trees/' + encodeURIComponent(ctx.branch), { query: { recursive: 1 }, context: 'tree' }),
    getTree: (ctx, sha) => API.request('GET', '/repos/' + encodeURIComponent(ctx.owner) + '/' + encodeURIComponent(ctx.name) + '/git/trees/' + encodeURIComponent(sha), { context: 'tree' }),
    getRef: (ctx) => API.request('GET', '/repos/' + encodeURIComponent(ctx.owner) + '/' + encodeURIComponent(ctx.name) + '/git/ref/heads/' + ctx.branch.split('/').map(encodeURIComponent).join('/'), { context: 'getRef' }),
    getCommitObj: (ctx, sha) => API.request('GET', '/repos/' + encodeURIComponent(ctx.owner) + '/' + encodeURIComponent(ctx.name) + '/git/commits/' + encodeURIComponent(sha), { context: 'getCommit' }),
    createBlob: (ctx, content, encoding) => API.request('POST', '/repos/' + encodeURIComponent(ctx.owner) + '/' + encodeURIComponent(ctx.name) + '/git/blobs', { body: { content, encoding }, context: 'createBlob' }),
    createTree: (ctx, tree, baseTreeSha) => API.request('POST', '/repos/' + encodeURIComponent(ctx.owner) + '/' + encodeURIComponent(ctx.name) + '/git/trees', {
      body: baseTreeSha ? { base_tree: baseTreeSha, tree } : { tree }, context: 'createTree',
    }),
    createCommitObj: (ctx, body) => API.request('POST', '/repos/' + encodeURIComponent(ctx.owner) + '/' + encodeURIComponent(ctx.name) + '/git/commits', { body, context: 'createCommit' }),
    updateRef: (ctx, sha) => API.request('PATCH', '/repos/' + encodeURIComponent(ctx.owner) + '/' + encodeURIComponent(ctx.name) + '/git/refs/heads/' + ctx.branch.split('/').map(encodeURIComponent).join('/'), { body: { sha, force: false }, context: 'updateRef' }),
    createRef: (ctx, fullRef, sha) => API.request('POST', '/repos/' + encodeURIComponent(ctx.owner) + '/' + encodeURIComponent(ctx.name) + '/git/refs', { body: { ref: fullRef, sha }, context: 'createRef' }),
    getBlob: (ctx, sha) => API.request('GET', '/repos/' + encodeURIComponent(ctx.owner) + '/' + encodeURIComponent(ctx.name) + '/git/blobs/' + encodeURIComponent(sha), { context: 'getBlob' }),
    lastCommitFor: (ctx, path) => API.request('GET', '/repos/' + encodeURIComponent(ctx.owner) + '/' + encodeURIComponent(ctx.name) + '/commits', {
      query: Object.assign({ sha: ctx.branch, per_page: 1 }, path ? { path } : {}), context: 'lastCommit',
    }),
  };

  /**
   * Commit a set of tree entries atomically via the Git Data API.
   * entries: [{path, mode, type, sha?, content?, encoding?}] — sha:null deletes.
   * Blobs for `content` entries are created first; entry.sha is filled in-place.
   * Handles the empty-repo case (first commit, no ref yet) and retries on
   * non-fast-forward ref updates (422) by rebuilding on the fresh base.
   */
  async function gitCommit(ctx, message, entries) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let baseSha = null, baseTreeSha = null, parentless = false;
      try {
        const ref = await API.getRef(ctx);
        baseSha = ref.object.sha;
        const commitObj = await API.getCommitObj(ctx, baseSha);
        baseTreeSha = commitObj.tree.sha;
      } catch (e) {
        if (e.status === 404 || e.status === 409) { parentless = true; } // empty repository
        else throw e;
      }
      const tree = [];
      for (const e of entries) {
        if (e.content != null && e.content !== undefined) {
          const blob = await API.createBlob(ctx, e.content, e.encoding || 'utf-8');
          e.sha = blob.sha;
        }
        tree.push({ path: e.path, mode: e.mode, type: e.type, sha: e.sha === undefined ? null : e.sha });
      }
      let newTree;
      try { newTree = await API.createTree(ctx, tree, parentless ? null : baseTreeSha); }
      catch (e) { if ((e.status === 422 || e.status === 409) && attempt < 2) { lastErr = e; await sleep(350); continue; } throw e; }
      const commit = await API.createCommitObj(ctx, {
        message, tree: newTree.sha, parents: parentless ? [] : [baseSha],
      });
      try {
        if (parentless) await API.createRef(ctx, 'refs/heads/' + ctx.branch, commit.sha);
        else await API.updateRef(ctx, commit.sha);
        return commit;
      } catch (e) {
        // Ref moved between read and write (concurrent commit) → rebuild and retry.
        if ((e.status === 422 || e.status === 409) && attempt < 2) { lastErr = e; await sleep(350); continue; }
        throw e;
      }
    }
    throw lastErr || new ApiError('Commit failed after retries', 0);
  }

  /* ══════════════════════════ §8 TOASTS / DIALOGS / MENUS ══════════════════════════ */

  /* ── Toasts ───────────────────────────────────────────── */
  const Toast = {
    box: null, items: new Map(), _id: 0, MAX: 6,
    ensure() {
      if (!this.box) { this.box = el('div', { class: 'ghf-toasts' }); E.root.append(this.box); }
      return this.box;
    },
    /** Create a toast. kind: success | error | info. Returns a handle. */
    show(kind, msg, detail, opts = {}) {
      this.ensure();
      // De-duplicate identical messages shown within 1.5s.
      for (const [, t] of this.items) {
        if (t.kind === kind && t.msg === msg && Date.now() - t.born < 1500) return t.handle;
      }
      const ic = kind === 'success' ? 'check' : kind === 'error' ? 'warning' : 'info';
      const node = el('div', { class: 'ghf-toast ghf-' + kind, role: 'status' },
        el('span', { class: 'ghf-tic' }, iconEl(ic)),
        el('div', { class: 'ghf-tmsg' }, msg, detail ? el('div', { class: 'ghf-tdet' }, detail) : null));
      let ms = opts.ms || (kind === 'error' ? 6000 : 3500);
      if (!opts.noBar) {
        const bar = el('div', { class: 'ghf-tbar' });
        bar.style.animationDuration = ms + 'ms';
        node.append(bar);
      }
      this.box.append(node);
      while (this.items.size >= this.MAX) {
        const first = this.box.firstElementChild;
        const rec = first && [...this.items.entries()].find(([, t]) => t.node === first);
        if (rec) { this.dismiss(rec[0]); } else break;
      }
      const id = ++this._id;
      const rec = { kind, msg, node, born: Date.now(), timer: 0, closed: false };
      const arm = () => { rec.timer = setTimeout(() => this.dismiss(id), ms); };
      const handle = {
        update: (m, d) => { const msgEl = qs(node, '.ghf-tmsg'); if (msgEl) msgEl.textContent = m; },
        done: (kind2, m, d) => {
          node.className = 'ghf-toast ghf-' + kind2;
          const tic = qs(node, '.ghf-tic');
          if (tic) tic.innerHTML = icon(kind2 === 'success' ? 'check' : kind2 === 'error' ? 'warning' : 'info');
          if (m) handle.update(m, d);
          ms = kind2 === 'error' ? 6000 : 3500;
          clearTimeout(rec.timer);
          const oldBar = qs(node, '.ghf-tbar'); if (oldBar) oldBar.remove();
          arm();
        },
        close: () => this.dismiss(id),
      };
      rec.handle = handle;
      this.items.set(id, rec);
      node.addEventListener('mouseenter', () => clearTimeout(rec.timer));
      node.addEventListener('mouseleave', arm);
      node.addEventListener('click', () => this.dismiss(id)); // click a toast to dismiss it
      arm();
      return handle;
    },
    dismiss(id) {
      const rec = this.items.get(id);
      if (!rec || rec.closed) return;
      rec.closed = true;
      clearTimeout(rec.timer);
      this.items.delete(id);
      rec.node.classList.add('ghf-out');
      setTimeout(() => rec.node.remove(), 200);
    },
  };
  const toast = (kind, msg, detail) => Toast.show(kind, msg, detail);

  /* ── Modal dialogs (custom, never window.prompt) ──────── */
  const Layers = []; // stack of open layers: {el, onEsc, onEnter}
  function topLayer() { return Layers[Layers.length - 1] || null; }

  function modal({ title, icon: ic, body, buttons, width, veilClose = true }) {
    const layer = el('div', { class: 'ghf-modal-layer' });
    const veil = el('div', { class: 'ghf-modal-veil' });
    const box = el('div', { class: 'ghf-modal' + (width === 'narrow' ? ' ghf-narrow' : ''), role: 'dialog', 'aria-label': title || 'Dialog' });
    const foot = el('div', { class: 'ghf-modal-foot' });
    layer.append(veil, box);
    if (title) box.append(el('div', { class: 'ghf-modal-title' }, ic ? iconEl(ic) : null, title));
    if (body) box.append(el('div', { class: 'ghf-modal-body' }, body));
    box.append(foot);
    E.root.append(layer);
    requestAnimationFrame(() => layer.classList.add('ghf-on'));

    const rec = { el: layer, onEsc: null, onEnter: null };
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      const i = Layers.indexOf(rec);
      if (i >= 0) Layers.splice(i, 1);
      layer.classList.remove('ghf-on');
      setTimeout(() => layer.remove(), 160);
    };
    rec.close = close;
    for (const b of (buttons || [])) {
      const btn = el('button', {
        class: 'ghf-btn' + (b.kind ? ' ghf-' + b.kind : '') + (b.primary ? ' ghf-primary' : ''),
        onclick: async () => {
          if (b.onClick) {
            const keep = await b.onClick();
            if (keep === true) return; // dialog stays open
          }
          close();
        },
      }, b.label);
      if (b.primary) rec.primaryBtn = btn;
      foot.append(btn);
    }
    if (veilClose) veil.addEventListener('pointerdown', close);
    Layers.push(rec);
    // Focus first input, else primary button.
    const firstInput = qs(box, 'input, textarea, select');
    setTimeout(() => (firstInput || rec.primaryBtn || foot.firstElementChild || box).focus({ preventScroll: true }), 30);
    return rec;
  }

  /** Confirmation dialog. Returns Promise<boolean>. */
  function confirmDialog({ title, message, items, confirmLabel = 'Delete', danger = true, note }) {
    return new Promise((resolve) => {
      let result = false;
      const body = el('div', null,
        el('div', { class: 'ghf-hint' }, message),
        items && items.length ? el('div', { class: 'ghf-dialog-items' },
          items.slice(0, 6).map((i) => el('div', null, i)),
          items.length > 6 ? el('div', null, '…and ' + (items.length - 6) + ' more') : null) : null,
        note ? el('div', { class: 'ghf-hint', style: { marginTop: '8px' } }, note) : null);
      const m = modal({
        title, icon: danger ? 'warning' : 'info', body, width: 'narrow',
        buttons: [
          { label: 'Cancel', onClick: () => { result = false; } },
          { label: confirmLabel, kind: danger ? 'danger' : 'primary', primary: true, onClick: () => { result = true; } },
        ],
      });
      m.onEnter = () => { result = true; m.close(); };
      const wait = setInterval(() => {
        if (!Layers.includes(m)) { clearInterval(wait); resolve(result); }
      }, 80);
    });
  }

  /** Prompt dialog with a validated text input. Returns Promise<string|null>. */
  function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'OK', validator, icon: ic, extraBody, selectBasename }) {
    return new Promise((resolve) => {
      let result = null;
      const input = el('input', { class: 'ghf-input', value, placeholder, spellcheck: 'false' });
      const status = el('div', { class: 'ghf-status-line' });
      const body = el('div', null,
        label ? el('label', { class: 'ghf-field-label' }, label) : null,
        input,
        status, extraBody || null);
      const validate = () => {
        try {
          const v = validator ? validator(input.value) : validateName(input.value);
          status.className = 'ghf-status-line';
          status.textContent = '';
          return v;
        } catch (e) {
          status.className = 'ghf-status-line ghf-err';
          status.textContent = e.message || String(e.message);
          return undefined;
        }
      };
      const m = modal({
        title, icon: ic || 'pencil', body,
        buttons: [
          { label: 'Cancel', onClick: () => { result = null; } },
          { label: confirmLabel, primary: true, onClick: async () => {
            const v = validate();
            if (v === undefined) return true; // keep open on validation error
            result = v;
          } },
        ],
      });
      input.addEventListener('input', () => validate());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const v = validate();
          if (v !== undefined) { result = v; m.close(); }
        }
      });
      m.onEnter = () => {
        const v = validate();
        if (v !== undefined) { result = v; m.close(); }
      };
      setTimeout(() => {
        input.focus({ preventScroll: true });
        if (selectBasename) {
          const dot = value.lastIndexOf('.');
          input.setSelectionRange(0, dot > 0 ? dot : value.length);
        } else input.select();
      }, 40);
      const wait = setInterval(() => { if (!Layers.includes(m)) { clearInterval(wait); resolve(result); } }, 80);
    });
  }

  /* ── Context menu framework ───────────────────────────── */
  const Menu = {
    el: null, items: [], sub: null, _closeOnScroll: null, activeIdx: -1,
    isOpen() { return !!this.el; },
    /** items: {label, icon, key, disabled, danger, checked, sep, submenu, onClick} */
    open(x, y, items) {
      this.close();
      const menu = el('div', { class: 'ghf-menu', role: 'menu' });
      this.el = menu;
      this.items = [];
      this.activeIdx = -1;
      for (const it of items) {
        if (it.sep) { menu.append(el('div', { class: 'ghf-msep' })); this.items.push(null); continue; }
        const row = el('div', {
          class: 'ghf-mi' + (it.disabled ? ' ghf-dis' : '') + (it.danger ? ' ghf-danger' : ''),
          role: 'menuitem',
        },
          it.icon ? iconEl(it.icon) : el('span', { class: 'ghf-icon' }),
          el('span', { class: 'ghf-mlabel' }, it.label),
          it.key ? el('span', { class: 'ghf-mkey' }, it.key) : null,
          it.submenu ? (() => { const s = iconEl('chevron'); s.className = 'ghf-msub'; s.innerHTML = icon('chevron'); return s; })() : null);
        if (!it.disabled && it.onClick) row.addEventListener('click', () => { this.close(); it.onClick(); });
        if (!it.disabled && it.submenu) {
          let openTimer = 0;
          row.addEventListener('mouseenter', () => {
            openTimer = setTimeout(() => {
              if (this.sub) { this.sub.remove(); this.sub = null; }
              const r = row.getBoundingClientRect();
              this.sub = this._buildSub(r.right - 4, r.top - 5, it.submenu);
              document.body ? E.root.append(this.sub) : null;
            }, 140);
          });
          row.addEventListener('mouseleave', () => clearTimeout(openTimer));
        }
        menu.append(row);
        this.items.push({ it, row });
      }
      E.root.append(menu);
      // Position: prefer at cursor, clamp into viewport.
      const vw = window.innerWidth, vh = window.innerHeight;
      const rect = menu.getBoundingClientRect();
      let px = Math.min(x, vw - rect.width - 8);
      let py = Math.min(y, vh - rect.height - 8);
      menu.style.left = Math.max(8, px) + 'px';
      menu.style.top = Math.max(8, py) + 'px';
      this._closeOnScroll = () => this.close();
      window.addEventListener('scroll', this._closeOnScroll, true);
      return menu;
    },
    _buildSub(x, y, items) {
      const menu = el('div', { class: 'ghf-menu' });
      for (const it of items) {
        if (it.sep) { menu.append(el('div', { class: 'ghf-msep' })); continue; }
        const row = el('div', { class: 'ghf-mi' + (it.disabled ? ' ghf-dis' : '') },
          it.icon ? iconEl(it.icon) : el('span', { class: 'ghf-icon' }),
          el('span', { class: 'ghf-mlabel' }, it.label),
          it.checked ? (() => { const c = iconEl('check'); return c; })() : null);
        if (!it.disabled && it.onClick) row.addEventListener('click', () => { this.close(); it.onClick(); });
        menu.append(row);
      }
      const vw = window.innerWidth;
      const rect = { width: 220, height: items.length * 30 };
      menu.style.left = clamp(x + 220 > vw ? x - 224 - 176 : x, 8, vw - 228) + 'px';
      menu.style.top = clamp(y, 8, window.innerHeight - items.length * 30 - 12) + 'px';
      return menu;
    },
    moveHot(delta) {
      if (!this.el) return;
      const idxs = this.items.map((r, i) => (r && !r.it.disabled ? i : -1)).filter((i) => i >= 0);
      if (!idxs.length) return;
      const cur = idxs.indexOf(this.activeIdx);
      let next;
      if (delta > 0) next = idxs[(cur + 1) % idxs.length];
      else if (delta < 0) next = idxs[(cur - 1 + idxs.length) % idxs.length];
      else next = idxs[0];
      this.activeIdx = next;
      this.items.forEach((r, i) => r && r.row.classList.toggle('ghf-hot', i === next));
    },
    triggerHot() {
      if (!this.el || this.activeIdx < 0) return;
      const r = this.items[this.activeIdx];
      if (r && !r.it.disabled && r.it.onClick) { this.close(); r.it.onClick(); }
    },
    close() {
      if (this._closeOnScroll) { window.removeEventListener('scroll', this._closeOnScroll, true); this._closeOnScroll = null; }
      if (this.sub) { this.sub.remove(); this.sub = null; }
      if (this.el) { this.el.remove(); this.el = null; }
      this.items = [];
    },
  };
  // Close menus on any outside pointerdown.
  document.addEventListener('pointerdown', (e) => {
    if (Menu.el && !Menu.el.contains(e.target) && !(Menu.sub && Menu.sub.contains(e.target))) Menu.close();
  }, true);

  /* ══════════════════════════ §9 WINDOW SHELL ══════════════════════════ */

  function injectCSS() {
    const style = document.createElement('style');
    style.id = 'ghf-style';
    style.textContent = CSS;
    document.head.append(style);
  }

  function applyTheme() {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    E.root.dataset.theme = dark ? 'dark' : 'light';
  }

  /** Build the root container, launcher, dock pill and the Finder window. */
  function buildShell() {
    E.root = el('div', { id: CFG.id, class: 'ghf-root' });

    // ── Launcher button ──
    E.launcher = el('button', {
      class: 'ghf-launcher' + (S.firstRun ? ' ghf-pulse' : ''),
      title: 'GitHub Finder (Alt+Shift+F)', 'aria-label': 'Open GitHub Finder',
      onclick: () => { E.launcher.classList.remove('ghf-pulse'); openFinder(); },
    });
    E.launcher.innerHTML = icon('folder', 30);

    // ── Dock pill (minimized state) ──
    E.pill = el('div', {
      class: 'ghf-pill', title: 'Restore GitHub Finder', onclick: () => restoreWindow(),
    }, iconEl('folder'), el('span', { class: 'ghf-pill-label' }, 'GitHub Finder'));

    // ── Window ──
    E.win = el('div', { class: 'ghf-win', role: 'application', 'aria-label': 'GitHub Finder' });

    // Title bar
    const lightRed = el('button', { class: 'ghf-light ghf-l-red', title: 'Close', 'aria-label': 'Close', onclick: () => closeFinder() });
    lightRed.innerHTML = icon('close', 7);
    const lightYel = el('button', { class: 'ghf-light ghf-l-yel', title: 'Minimize', 'aria-label': 'Minimize', onclick: () => minimizeWindow() });
    lightYel.innerHTML = icon('minus', 7);
    const lightGrn = el('button', { class: 'ghf-light ghf-l-grn', title: 'Zoom', 'aria-label': 'Zoom', onclick: () => toggleMaximize() });
    lightGrn.innerHTML = icon('zoomIn', 7);
    E.lights = el('div', { class: 'ghf-lights' }, lightRed, lightYel, lightGrn);
    E.title = el('div', { class: 'ghf-wtitle' }, 'GitHub Finder');
    const titlebar = el('div', { class: 'ghf-titlebar' }, E.lights, E.title);

    // Toolbar
    const tbtn = (ic, tip, fn, id) => {
      const b = el('button', { class: 'ghf-tbtn', title: tip, 'aria-label': tip, onclick: fn });
      b.innerHTML = icon(ic, 17);
      if (id) E[id] = b;
      return b;
    };
    E.btnBack = tbtn('back', 'Back (' + MOD + '[)', () => navigateHistory(-1), 'btnBack');
    E.btnBack.disabled = true;
    E.btnFwd = tbtn('fwd', 'Forward (' + MOD + '])', () => navigateHistory(1), 'btnFwd');
    E.btnFwd.disabled = true;
    E.btnPlus = tbtn('plus', 'New file or folder', (e) => openPlusMenu(e.currentTarget), 'btnPlus');
    E.btnUpload = tbtn('upload', 'Upload files to this folder', () => pickFiles(S.nav.path || '', false));
    E.btnRefresh = tbtn('refresh', 'Refresh repository', () => refreshTree());
    E.seg = el('div', { class: 'ghf-seg' });
    E.segThumb = el('div', { class: 'ghf-seg-thumb' });
    E.segBtnList = el('button', { class: 'ghf-tbtn', title: 'List view', onclick: () => setViewMode('list') });
    E.segBtnList.innerHTML = icon('list', 15);
    E.segBtnGrid = el('button', { class: 'ghf-tbtn', title: 'Gallery view', onclick: () => setViewMode('grid') });
    E.segBtnGrid.innerHTML = icon('grid', 15);
    E.seg.append(E.segThumb, E.segBtnList, E.segBtnGrid);
    const sortSel = el('select', {
      title: 'Sort by',
      onchange: (e) => { setSort(e.target.value, null); },
    },
      el('option', { value: 'name' }, 'Sort: Name'),
      el('option', { value: 'size' }, 'Sort: Size'),
      el('option', { value: 'kind' }, 'Sort: Kind'));
    E.sortSel = sortSel;
    E.sortDirBtn = el('button', { class: 'ghf-tbtn', title: 'Toggle sort direction', onclick: () => setSort(null, -S.view.sortDir) });
    E.sortDirBtn.innerHTML = icon('chevronDown', 12);
    E.sortDirBtn.style.paddingBottom = '2px';
    E.btnSettings = tbtn('gear', 'Settings / token', () => openSettings());

    const toolbar = el('div', { class: 'ghf-toolbar' },
      E.btnBack, E.btnFwd,
      el('span', { class: 'ghf-tsep' }),
      E.btnPlus, E.btnUpload, E.btnRefresh,
      el('span', { class: 'ghf-tsep' }),
      E.seg,
      el('span', { class: 'ghf-tsep' }),
      el('span', { class: 'ghf-sortwrap' }, sortSel, E.sortDirBtn),
      el('span', { class: 'ghf-tspacer' }),
      E.btnSettings);

    // Sidebar
    const searchInput = el('input', { type: 'text', placeholder: 'Search repo…', 'aria-label': 'Search repository', spellcheck: 'false' });
    E.searchInput = searchInput;
    E.searchClear = el('span', { class: 'ghf-clear', title: 'Clear', onclick: () => { searchInput.value = ''; exitSearch(); } });
    E.searchClear.innerHTML = icon('close', 10);
    const searchbox = el('div', { class: 'ghf-searchbox' }, iconEl('search'), searchInput, E.searchClear);
    E.searchbox = searchbox;
    E.sideScroll = el('div', { class: 'ghf-side-scroll' });
    E.sideScroll.dataset.drop = '';
    E.sideResize = el('div', { class: 'ghf-side-resize' });
    const side = el('div', { class: 'ghf-side' },
      el('div', { class: 'ghf-search' }, searchbox), E.sideScroll, E.sideResize);
    E.side = side;

    // Main pane
    E.crumbs = el('div', { class: 'ghf-crumbbar' });
    E.mainScroll = el('div', { class: 'ghf-main-scroll', tabindex: '-1' });
    E.mainScroll.dataset.drop = '';
    E.empty = el('div', { class: 'ghf-empty' });
    E.dropVeil = el('div', { class: 'ghf-dropveil' });
    E.dropChip = el('div', { class: 'ghf-dropchip' });
    E.main = el('div', { class: 'ghf-main' }, E.crumbs, E.mainScroll);
    E.mainScroll.append(E.empty, E.dropVeil, E.dropChip);

    // Status bar
    E.stLeft = el('span', { class: 'ghf-spart' });
    E.stMid = el('span', { class: 'ghf-spart' });
    E.stRate = el('span', { class: 'ghf-rate', title: 'GitHub API rate limit (click for reset time)', onclick: () => {
      const r = S.rate;
      toast('info', 'API rate limit', r.remaining.toLocaleString() + ' of ' + r.limit.toLocaleString() + ' calls remaining' +
        (r.reset ? ' — resets ' + relTime(r.reset < 1e12 ? r.reset * 1000 : r.reset) : ''));
    } });
    E.stRight = el('span', { class: 'ghf-sright' }, E.stMid, E.stRate);
    const status = el('div', { class: 'ghf-status' }, E.stLeft, E.stRight);

    // Sheet layer (editor / preview / move picker live inside the window)
    E.sheets = el('div', { class: 'ghf-sheet-layer' });

    // Resize handles
    const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => {
      const h = el('div', { class: 'ghf-rh ghf-rh-' + d, 'data-dir': d });
      return h;
    });

    E.win.append(titlebar, toolbar, el('div', { class: 'ghf-body' }, side, E.main), status, E.sheets, ...handles);
    E.root.append(E.launcher, E.pill, E.win);
    document.body.append(E.root);

    // Window activity tracking (traffic lights dim when not focused)
    E.root.addEventListener('pointerdown', (e) => {
      if (E.win.contains(e.target) || E.sheets.contains(e.target)) E.win.classList.remove('ghf-inactive');
    }, true);
    document.addEventListener('pointerdown', (e) => {
      if (!E.root.contains(e.target)) E.win.classList.add('ghf-inactive');
    }, true);

    bindShellEvents();
  }

  /* ── Window open / close / minimize / maximize ────────── */
  function applyRect(r) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = clamp(r.w, CFG.MIN_W, vw - 24), h = clamp(r.h, CFG.MIN_H, vh - 24);
    const x = clamp(r.x, 12 - w + 120, vw - 120);
    const y = clamp(r.y, 8, vh - 60);
    E.win.style.left = x + 'px'; E.win.style.top = y + 'px';
    E.win.style.width = w + 'px'; E.win.style.height = h + 'px';
    return { x, y, w, h };
  }
  function currentRect() {
    return {
      x: parseFloat(E.win.style.left) || 0, y: parseFloat(E.win.style.top) || 0,
      w: E.win.offsetWidth, h: E.win.offsetHeight,
    };
  }
  function openFinder() {
    if (S.win.open) { restoreWindow(); return; }
    S.win.open = true;
    store.set('openedOnce', true);
    S.firstRun = false;
    E.launcher.classList.add('ghf-hidden');
    E.pill.classList.remove('ghf-on');
    E.win.classList.remove('ghf-closing');
    E.win.classList.add('ghf-open');
    E.win.classList.remove('ghf-inactive');
    // Restore persisted geometry.
    const saved = store.get('rect', null);
    const vw = window.innerWidth, vh = window.innerHeight;
    applyRect(saved || { x: (vw - CFG.DEF_W) / 2, y: Math.max(16, (vh - CFG.DEF_H) / 2 - 20), w: CFG.DEF_W, h: CFG.DEF_H });
    // Wire up data.
    const repo = parseRepo(location);
    if (!S.token) {
      renderEmptyState('needs-token');
      openSettings(true);
    } else if (!repo) {
      renderEmptyState('no-repo');
    } else if (!S.repo || S.repo.owner !== repo.owner || S.repo.name !== repo.name) {
      loadRepo(repo).catch(() => {});
    } else {
      markAll();
    }
    markDirty('toolbar');
  }
  function closeFinder() {
    if (!S.win.open) return;
    S.win.open = false;
    store.set('rect', currentRect());
    E.win.classList.add('ghf-closing');
    setTimeout(() => { E.win.classList.remove('ghf-open', 'ghf-closing'); }, 170);
    E.launcher.classList.remove('ghf-hidden');
    E.pill.classList.remove('ghf-on');
  }
  function minimizeWindow() {
    if (!S.win.open || S.win.min) return;
    S.win.min = true;
    store.set('rect', currentRect());
    E.win.classList.add('ghf-closing');
    setTimeout(() => { E.win.classList.remove('ghf-open', 'ghf-closing'); }, 170);
    const label = qs(E.pill, '.ghf-pill-label');
    if (label) label.textContent = S.repo ? S.repo.owner + '/' + S.repo.name : 'GitHub Finder';
    E.pill.classList.add('ghf-on');
    E.launcher.classList.add('ghf-hidden');
  }
  function restoreWindow() {
    if (!S.win.open) { openFinder(); return; }
    S.win.min = false;
    E.pill.classList.remove('ghf-on');
    E.win.classList.add('ghf-open');
  }
  function toggleMaximize() {
    if (S.win.max) {
      S.win.max = false;
      E.win.classList.remove('ghf-maxed');
      applyRect(S.win.prevRect || { x: 80, y: 60, w: CFG.DEF_W, h: CFG.DEF_H });
    } else {
      S.win.prevRect = currentRect();
      S.win.max = true;
      E.win.classList.add('ghf-maxed');
      applyRect({ x: 10, y: 8, w: window.innerWidth - 20, h: window.innerHeight - 16 });
    }
    setTimeout(() => store.set('rect', currentRect()), 50);
  }

  /* ── Dragging + resizing (pointer events, rAF-coalesced) ── */
  function bindShellEvents() {
    // Title drag
    const titlebar = qs(E.win, '.ghf-titlebar');
    titlebar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.ghf-light')) return;
      if (e.target.closest('.ghf-wtitle')) { /* still draggable */ }
      startWindowDrag(e);
    });
    titlebar.addEventListener('dblclick', (e) => { if (!e.target.closest('.ghf-light')) toggleMaximize(); });

    // Resize handles
    for (const h of qsa(E.win, '.ghf-rh')) {
      h.addEventListener('pointerdown', (e) => { if (e.button === 0) startWindowResize(e, h.dataset.dir); });
    }
    // Sidebar resize
    E.sideResize.addEventListener('pointerdown', (e) => { if (e.button === 0) startSideResize(e); });
    // Prevent native image drag inside the overlay
    E.root.addEventListener('dragstart', (e) => { if (e.target.closest('.ghf-root')) e.preventDefault(); });
  }
  function startWindowDrag(e) {
    if (S.win.max) return;
    const win = E.win;
    const startX = e.clientX, startY = e.clientY;
    const rect = currentRect();
    let nx = rect.x, ny = rect.y, raf = 0;
    win.classList.add('ghf-dragging');
    const apply = () => {
      raf = 0;
      win.style.left = nx + 'px';
      win.style.top = ny + 'px';
    };
    const onMove = (ev) => {
      nx = clamp(rect.x + ev.clientX - startX, 12 - rect.w + 140, window.innerWidth - 140);
      ny = clamp(rect.y + ev.clientY - startY, 6, window.innerHeight - 48);
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      if (raf) cancelAnimationFrame(raf);
      win.classList.remove('ghf-dragging');
      store.set('rect', currentRect());
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }
  function startWindowResize(e, dir) {
    const win = E.win;
    const startX = e.clientX, startY = e.clientY;
    const r0 = currentRect();
    let r = { ...r0 }, raf = 0;
    win.classList.add('ghf-resizing');
    const apply = () => {
      raf = 0;
      win.style.left = r.x + 'px'; win.style.top = r.y + 'px';
      win.style.width = r.w + 'px'; win.style.height = r.h + 'px';
    };
    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      let { x, y, w, h } = r0;
      if (dir.includes('e')) w = r0.w + dx;
      if (dir.includes('s')) h = r0.h + dy;
      if (dir.includes('w')) { w = r0.w - dx; x = r0.x + dx; }
      if (dir.includes('n')) { h = r0.h - dy; y = r0.y + dy; }
      if (w < CFG.MIN_W) { if (dir.includes('w')) x -= (CFG.MIN_W - w); w = CFG.MIN_W; }
      if (h < CFG.MIN_H) { if (dir.includes('n')) y -= (CFG.MIN_H - h); h = CFG.MIN_H; }
      y = Math.max(6, y);
      r = { x, y, w, h };
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      if (raf) cancelAnimationFrame(raf);
      win.classList.remove('ghf-resizing');
      store.set('rect', currentRect());
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }
  function startSideResize(e) {
    const startX = e.clientX, startW = E.side.offsetWidth;
    let w = startW, raf = 0;
    const apply = () => { raf = 0; E.side.style.width = w + 'px'; };
    const onMove = (ev) => {
      w = clamp(startW + ev.clientX - startX, 160, 380);
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      if (raf) cancelAnimationFrame(raf);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }

  /** GitHub Turbo/pjax can wipe body children — re-attach ourselves. */
  function guardReattach() {
    const mo = new MutationObserver(() => {
      if (E.root && !E.root.isConnected) {
        try { document.body.append(E.root); } catch (e) { /* page unloading */ }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ══════════════════════════ §10 VIRTUAL LIST ══════════════════════════
     Windowed renderer: only visible rows (± overscan) exist in the DOM.
     Rows are keyed; unchanged rows survive re-renders so selection state,
     hover state and scroll position are never disturbed. All positioning is
     transform-based (GPU composited). */

  class VList {
    /**
     * @param container scrollable element (owns scrollTop)
     * @param opts { itemH, key(i), render(i)→element, onRemove(el), mode }
     */
    constructor(container, opts) {
      this.c = container;
      this.inner = el('div', { class: 'ghf-vinner' });
      this.c.prepend(this.inner);
      this.itemH = opts.itemH;
      this.overscan = CFG.OVERSCAN;
      this._key = opts.key;
      this._render = opts.render;
      this._onRemove = opts.onRemove || null;
      this.mode = 'list';
      this.cols = 1;
      this.count = 0;
      this.rendered = new Map(); // index → {key, el}
      this._raf = 0;
      this.c.addEventListener('scroll', () => this.schedule(), { passive: true });
      this._ro = new ResizeObserver(() => { this._computeCols(); this.clear(); this.schedule(); });
      this._ro.observe(this.c);
    }
    _computeCols() {
      if (this.mode === 'grid') {
        const w = this.c.clientWidth || 1;
        this.cols = Math.max(1, Math.floor(w / CFG.CELL_W));
      } else this.cols = 1;
    }
    setMode(mode, itemH) {
      if (this.mode === mode && this.itemH === itemH) return;
      this.mode = mode;
      this.itemH = itemH;
      this._computeCols();
      // Rows are keyed by mode+height, so the next render() swaps them
      // atomically — no blank frame between clear and repaint.
      this.schedule();
    }
    rows() { return this.mode === 'grid' ? Math.ceil(this.count / this.cols) : this.count; }
    setCount(n, resetScroll) {
      this.count = Math.max(0, n | 0);
      if (resetScroll) this.c.scrollTop = 0;
      this.inner.style.height = this.rows() * this.itemH + 'px';
      if (this.mode === 'grid') this.inner.style.setProperty('--cols', this.cols);
      this.schedule();
    }
    clear() {
      for (const [, rec] of this.rendered) { if (this._onRemove) this._onRemove(rec.el); rec.el.remove(); }
      this.rendered.clear();
    }
    schedule() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
    }
    /** Row keys include the mode/height so a mode switch rebuilds rows in the
     *  same paint (atomic swap) instead of a clear→blank→repaint sequence. */
    keyFor(i) {
      const prefix = this.mode + ':' + this.itemH + ':';
      if (this.mode === 'grid') {
        const ks = [];
        for (let c = i * this.cols; c < Math.min((i + 1) * this.cols, this.count); c++) ks.push(this._key(c));
        return prefix + ks.join('¦');
      }
      return prefix + this._key(i);
    }
    render() {
      this._computeCols();
      const total = this.rows();
      const st = this.c.scrollTop, h = this.c.clientHeight || 400;
      const start = Math.max(0, Math.floor(st / this.itemH) - this.overscan);
      const end = Math.min(total, Math.ceil((st + h) / this.itemH) + this.overscan);
      // prune out-of-range
      for (const [i, rec] of [...this.rendered]) {
        if (i < start || i >= end) {
          if (this._onRemove) this._onRemove(rec.el);
          rec.el.remove();
          this.rendered.delete(i);
        }
      }
      // add / refresh in-range
      for (let i = start; i < end; i++) {
        const key = this.keyFor(i);
        const rec = this.rendered.get(i);
        if (rec && rec.key === key) continue;
        if (rec) { if (this._onRemove) this._onRemove(rec.el); rec.el.remove(); }
        const elm = this._render(i);
        elm.style.transform = 'translate3d(0,' + (i * this.itemH) + 'px,0)';
        if (this.mode === 'grid') {
          elm.style.setProperty('--cols', this.cols);
          elm.style.width = (this.cols * CFG.CELL_W) + 'px';
        }
        this.inner.append(elm);
        this.rendered.set(i, { key, el: elm });
      }
    }
    /** Scroll an index into view (used to reveal created/selected items). */
    reveal(i) {
      if (i < 0) return;
      const st = this.c.scrollTop, h = this.c.clientHeight || 400;
      const top = i * this.itemH;
      if (top < st + 4) this.c.scrollTop = Math.max(0, top - 6);
      else if (top + this.itemH > st + h - 4) this.c.scrollTop = top + this.itemH - h + 6;
    }
    indexOf(el) {
      for (const [i, rec] of this.rendered) if (rec.el === el) return i;
      return -1;
    }
    destroy() { this._ro.disconnect(); this.clear(); }
  }

  /* ══════════════════════════ §11 RENDERERS / NAVIGATION / SELECTION ══════════════════════════ */

  /* ── Repo detection from the page URL ─────────────────── */
  function parseRepo(loc) {
    const m = (loc.pathname || '/').match(/^\/([^/]+)\/([^/]+)((?:\/[^/]+)*)\/?$/);
    if (!m) return null;
    const owner = m[1], second = m[2].replace(/\.git$/, '');
    if (RESERVED_TOP.has(owner.toLowerCase())) return null;
    if (RESERVED_SECOND.has(second.toLowerCase())) return null;
    const out = { owner, name: second };
    const rest = (m[3] || '').split('/').filter(Boolean);
    if (rest[0] === 'tree' || rest[0] === 'blob') {
      out.urlMode = rest[0];
      out.urlBranch = rest[1] ? decodeURIComponent(rest[1]) : null;
      out.urlPath = rest.slice(2).map(decodeURIComponent).join('/');
    }
    return out;
  }
  const ctxNow = () => {
    if (!S.repo) throw new ApiError('No repository loaded.', 0);
    return { owner: S.repo.owner, name: S.repo.name, branch: S.repo.branch };
  };
  const githubTreeUrl = (path) =>
    'https://github.com/' + encodeURIComponent(S.repo.owner) + '/' + encodeURIComponent(S.repo.name) +
    '/tree/' + encodePath(S.repo.branch) + (path ? '/' + encodePath(path) : '');
  const githubFileUrl = (path) =>
    'https://github.com/' + encodeURIComponent(S.repo.owner) + '/' + encodeURIComponent(S.repo.name) +
    '/blob/' + encodePath(S.repo.branch) + '/' + encodePath(path);

  /* ── Shared bits ──────────────────────────────────────── */
  function fileIconEl(node, cls) {
    const ki = kindInfo(node.name, node.type === 'dir');
    const span = el('span', { class: 'ghf-fi ghf-cat-' + ki.cat + (node.type === 'dir' ? ' ghf-folder' : '') + (cls ? ' ' + cls : '') });
    span.innerHTML = icon(node.type === 'dir' ? 'folder' : ki.icon);
    return span;
  }
  function markText(text, query) {
    if (!query) return [text];
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    const out = [];
    let i = 0;
    while (true) {
      const at = t.indexOf(q, i);
      if (at === -1) { out.push(text.slice(i)); break; }
      if (at > i) out.push(text.slice(i, at));
      out.push(el('mark', { class: 'ghf-mark' }, text.slice(at, at + q.length)));
      i = at + q.length;
    }
    return out;
  }
  const itemLabel = (n) => n.type === 'dir' ? (n.children ? n.children.size : 0) + ' items' : formatBytes(n.size);

  /* ── Main pane state ──────────────────────────────────── */
  let mainItems = [];          // nodes currently displayed
  let mainIndex = new Map();   // path → index
  let navResetScroll = true;

  function buildMainList() {
    if (S.nav.query != null) {
      const q = S.nav.query.toLowerCase();
      const hits = [];
      for (const node of S.model.byPath.values()) {
        if (!node.parent) continue;
        if (node.name.toLowerCase().includes(q)) hits.push(node);
      }
      hits.sort((a, b) => {
        const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
        const ap = an.startsWith(q) ? 0 : 1, bp = bn.startsWith(q) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return naturalCompare(a.path, b.path);
      });
      return hits.slice(0, CFG.SEARCH_CAP);
    }
    const dir = S.model.get(S.nav.path) || S.model.root;
    return S.model.sortedChildren(dir.path, S.view.sortKey, S.view.sortDir);
  }

  /** Render (or surgically re-render) the main pane. */
  function renderMain() {
    if (!S.win.open) return;
    // List header (list view only)
    const oldHead = qs(E.mainScroll, '.ghf-cols');
    if (oldHead) oldHead.remove();
    if (!S.model) { E.empty.classList.add('ghf-on'); return; }

    mainItems = buildMainList();
    mainIndex = new Map(mainItems.map((n, i) => [n.path, i]));
    const searching = S.nav.query != null;

    // Ensure the virtual list exists and matches the view mode — created BEFORE
    // the column header is prepended so the header always renders above rows.
    if (!E.vlist) {
      E.vlist = new VList(E.mainScroll, {
        itemH: itemHeightNow(),
        key: (i) => mainItems[i] ? mainItems[i].path + '¦' + (mainItems[i].size || 0) + '¦' + (mainItems[i].pending ? 'p' : '') : '×' + i,
        render: (i) => (E.vlist.mode === 'grid' ? renderMainRowGrid(i) : renderMainRow(i)),
        onRemove: (elm) => { if (renameState && renameState.input && elm.contains(renameState.input)) commitRename(); },
      });
    }
    E.vlist._key = (i) => mainItems[i] ? mainItems[i].path + '¦' + (mainItems[i].size || 0) + '¦' + (mainItems[i].pending ? 'p' : '') : '×' + i;
    E.vlist.setMode(S.view.mode === 'grid' && !searching ? 'grid' : 'list', itemHeightNow());
    E.vlist.setCount(mainItems.length, navResetScroll);
    navResetScroll = false;
    if (S.view.mode === 'list' && !searching) {
      E.mainScroll.prepend(buildColHeaders());
    }

    // Empty state
    if (searching) {
      if (!mainItems.length) renderEmptyState('no-results');
      else E.empty.classList.remove('ghf-on');
    } else {
      const dir = S.model.get(S.nav.path) || S.model.root;
      if (!mainItems.length) renderEmptyState(dir.path === '' && !S.model.root.children.size ? 'empty-repo' : 'empty-folder');
      else E.empty.classList.remove('ghf-on');
    }
    updateSelClasses();
    fetchLastCommitDebounced();
  }
  function itemHeightNow() {
    if (S.nav.query != null) return CFG.ROW_H_SEARCH;
    return S.view.mode === 'grid' ? CFG.CELL_H : CFG.ROW_H;
  }
  function buildColHeaders() {
    const head = el('div', { class: 'ghf-cols' });
    const mk = (key, label, right) => {
      const b = el('div', { class: 'ghf-col' + (right ? ' ghf-colright' : '') + (S.view.sortKey === key ? ' ghf-sorted' : '') + (S.view.sortKey === key && S.view.sortDir < 0 ? ' ghf-desc' : '') },
        el('span', null, label),
        (() => { const a = iconEl('chevronDown'); a.className = 'ghf-sortarrow'; return a; })());
      b.addEventListener('click', () => setSort(key, S.view.sortKey === key ? -S.view.sortDir : 1));
      return b;
    };
    head.append(mk('name', 'Name'), mk('size', 'Size', true), mk('kind', 'Kind'), el('span'));
    return head;
  }

  function rowClasses(node, extraPath) {
    let cls = '';
    if (S.sel.has(node.path)) cls += ' ghf-sel';
    if (S.clip && S.clip.mode === 'cut' && S.clip.paths.includes(node.path)) cls += ' ghf-cut';
    if (node.pending) cls += ' ghf-pending-row';
    return cls;
  }

  /** Build one list row (browse or search mode). */
  function renderMainRow(i) {
    const node = mainItems[i];
    const searching = S.nav.query != null;
    const isDir = node.type === 'dir';
    const ki = kindInfo(node.name, isDir);
    const nameContent = searching
      ? el('span', { class: 'ghf-mainname' }, fileIconEl(node), markText(node.name, S.nav.query))
      : el('span', { class: 'ghf-mainname' }, fileIconEl(node), el('span', { class: 'ghf-name' }, node.name), node.pending ? el('span', { class: 'ghf-spin' }) : null);
    const row = el('div', {
      class: 'ghf-row' + (searching ? ' ghf-searchrow' : '') + rowClasses(node),
      dataset: Object.assign({ path: node.path }, isDir ? { drop: node.path } : {}),
    },
      el('div', { class: 'ghf-namewrap' },
        nameContent,
        searching ? el('span', { class: 'ghf-sub' }, node.path) : null),
      el('span', { class: 'ghf-size' }, itemLabel(node)),
      el('span', { class: 'ghf-kind' }, ki.label));
    return row;
  }

  /** Build one grid row (a strip of cells). */
  function renderMainRowGrid(i) {
    const row = el('div', { class: 'ghf-gridrow' });
    for (let c = i * E.vlist.cols; c < Math.min((i + 1) * E.vlist.cols, mainItems.length); c++) {
      const node = mainItems[c];
      const isDir = node.type === 'dir';
      row.append(el('div', {
        class: 'ghf-cell' + rowClasses(node),
        dataset: Object.assign({ path: node.path }, isDir ? { drop: node.path } : {}),
      },
        fileIconEl(node),
        el('span', { class: 'ghf-gname' }, node.name, node.pending ? el('span', { class: 'ghf-spin' }) : null)));
    }
    return row;
  }

  /** Patch selection / cut / drop classes on rendered rows without rebuilding.
   *  Sidebar rows deliberately never show selection — only the current-folder
   *  highlight (ghf-cur), matching Finder. */
  function updateSelClasses() {
    if (!E.vlist) return;
    for (const [, rec] of E.vlist.rendered) {
      const rows = rec.el.matches('.ghf-row,.ghf-cell') ? [rec.el] : [...rec.el.querySelectorAll('.ghf-row,.ghf-cell')];
      for (const r of rows) {
        const p = r.dataset.path;
        if (!p) continue;
        r.classList.toggle('ghf-sel', S.sel.has(p));
        r.classList.toggle('ghf-cut', !!(S.clip && S.clip.mode === 'cut' && S.clip.paths.includes(p)));
      }
    }
  }

  /* ── Empty / loading / error states ───────────────────── */
  function renderEmptyState(kind, extra) {
    const box = E.empty;
    box.textContent = '';
    box.classList.add('ghf-on');
    const bigIcon = (name) => { const s = el('span', { class: 'ghf-bigicon' }); s.innerHTML = icon(name, 62); return s; };
    const btn = (label, ic, fn, primary) => el('button', { class: 'ghf-btn' + (primary ? ' ghf-primary' : ''), onclick: fn }, ic ? iconEl(ic) : null, label);
    if (kind === 'needs-token') {
      box.append(bigIcon('folderGhost'),
        el('div', { class: 'ghf-et' }, 'Connect GitHub Finder'),
        el('div', { class: 'ghf-ed' }, 'Paste a Personal Access Token to browse and manage this repository like a Finder window.'),
        el('div', { class: 'ghf-ebtns' }, btn('Open Settings', 'gear', () => openSettings(), true)));
    } else if (kind === 'no-repo') {
      const last = S.lastRepo;
      box.append(bigIcon('repo'),
        el('div', { class: 'ghf-et' }, 'No repository open'),
        el('div', { class: 'ghf-ed' }, 'Navigate to a GitHub repository page (github.com/owner/repo) to browse it here.'),
        last ? el('div', { class: 'ghf-ebtns' }, btn('Reopen ' + last.owner + '/' + last.name, 'repo', () => { location.href = 'https://github.com/' + last.owner + '/' + last.name; }, true)) : null);
    } else if (kind === 'loading') {
      box.append(el('span', { class: 'ghf-spin ghf-big' }),
        el('div', { class: 'ghf-et' }, extra || 'Loading repository…'));
    } else if (kind === 'error') {
      box.append(bigIcon('warning'),
        el('div', { class: 'ghf-et' }, 'Something went wrong'),
        el('div', { class: 'ghf-ed' }, extra || ''),
        el('div', { class: 'ghf-ebtns' },
          btn('Retry', 'refresh', () => { const r = parseRepo(location); if (r) loadRepo(r); }, true),
          btn('Settings', 'gear', () => openSettings())));
    } else if (kind === 'empty-repo') {
      box.append(bigIcon('folderGhost'),
        el('div', { class: 'ghf-et' }, 'This repository is empty'),
        el('div', { class: 'ghf-ed' }, 'Create your first file to get started.'),
        el('div', { class: 'ghf-ebtns' },
          btn('New File', 'docPlus', () => newFilePrompt(''), true),
          btn('New Folder', 'folderPlus', () => newFolderPrompt(''))));
    } else if (kind === 'empty-folder') {
      box.append(bigIcon('folderGhost'),
        el('div', { class: 'ghf-et' }, 'Folder is empty'),
        el('div', { class: 'ghf-ebtns' },
          btn('New File', 'docPlus', () => newFilePrompt(S.nav.path), true),
          btn('New Folder', 'folderPlus', () => newFolderPrompt(S.nav.path)),
          btn('Upload', 'upload', () => pickFiles(S.nav.path, false))));
    } else if (kind === 'no-results') {
      box.append(bigIcon('search'),
        el('div', { class: 'ghf-et' }, 'No results'),
        el('div', { class: 'ghf-ed' }, 'Nothing in this repository matches “' + (S.nav.query || '') + '”.'));
    }
  }

  /* ── Sidebar ──────────────────────────────────────────── */
  function renderSidebar() {
    if (!S.win.open) return;
    const scroll = E.sideScroll;
    const keepTop = scroll.scrollTop;
    scroll.textContent = '';
    // Favorites section
    if (S.favorites.size) {
      scroll.append(el('div', { class: 'ghf-shead' }, 'Favorites'));
      const wrap = el('div', { class: 'ghf-side-sec' });
      for (const p of [...S.favorites].sort(naturalCompare)) {
        const node = S.model ? S.model.get(p) : null;
        if (!node) { S.favorites.delete(p); continue; }
        wrap.append(sideRow(node, 0, false));
      }
      scroll.append(wrap);
    }
    if (S.model) {
      scroll.append(el('div', { class: 'ghf-shead' }, S.repo.owner + ' / ' + S.repo.name));
      const wrap = el('div', { class: 'ghf-side-sec' });
      const rootRow = sideRow(S.model.root, 0, true);
      rootRow.dataset.path = '';
      rootRow.dataset.drop = '';
      wrap.append(rootRow, el('div', { class: 'ghf-side-children', dataset: { children: '' } }));
      scroll.append(wrap);
      fillSidebarChildren(wrap, S.model.root, '');
    }
    scroll.scrollTop = keepTop;
  }
  /** Build a sidebar row for a node. */
  function sideRow(node, depth, isRoot) {
    const isDir = node.type === 'dir';
    const expanded = isDir && S.expanded.has(node.path);
    const chev = el('span', { class: 'ghf-chevron' });
    chev.innerHTML = icon('chevron', 10);
    const row = el('div', {
      class: 'ghf-srow' + (expanded ? ' ghf-exp' : '') + (S.nav.path === node.path && S.nav.query == null ? ' ghf-cur' : '') + (node.pending ? ' ghf-pending-row' : '') + (node.loading ? ' ghf-pending-row' : ''),
      dataset: Object.assign({ path: node.path }, isDir ? { drop: node.path } : {}),
      style: { paddingLeft: (8 + depth * 13) + 'px' },
    },
      isDir ? chev : el('span', { class: 'ghf-chevron', style: { visibility: 'hidden' } }),
      fileIconEl(node),
      el('span', { class: 'ghf-slabel' }, isRoot ? (S.repo ? S.repo.name : 'Repository') : node.name));
    row.dataset.depth = depth;
    return row;
  }
  /** Recursively fill expanded children under `wrap`. */
  function fillSidebarChildren(parentEl, dirNode, indentPath) {
    const kids = [...dirNode.children.values()].sort((a, b) =>
      (b.type === 'dir') - (a.type === 'dir') || naturalCompare(a.name, b.name));
    const depth = pathSegments(dirNode.path).length + 1;
    const box = qs(parentEl, '.ghf-side-children[data-children="' + cssEscape(dirNode.path) + '"]');
    const target = box || parentEl;
    if (box) box.textContent = '';
    let shown = kids.slice(0, CFG.SIDE_CHUNK);
    const chunkKey = '_sideChunk';
    const extra = (dirNode[chunkKey] || 0);
    if (extra > 0) shown = kids.slice(0, CFG.SIDE_CHUNK + extra);
    for (const node of shown) {
      const isDir = node.type === 'dir';
      target.append(sideRow(node, depth, false));
      if (isDir && S.expanded.has(node.path)) {
        const childBox = el('div', { class: 'ghf-side-children', dataset: { children: node.path } });
        target.append(childBox);
        fillSidebarChildren(childBox, node, node.path);
      }
    }
    if (kids.length > shown.length) {
      const more = el('div', { class: 'ghf-morebtn', onclick: (e) => { e.stopPropagation(); dirNode[chunkKey] = (dirNode[chunkKey] || 0) + 1500; refreshDirSide(dirNode.path); } },
        'Show all ' + formatCount(kids.length) + ' items…');
      target.append(more);
    }
    if (isLazyUnloaded(dirNode)) {
      target.append(el('div', { class: 'ghf-morebtn', onclick: (e) => { e.stopPropagation(); ensureDirLoaded(dirNode); } }, 'Load deeper items…'));
    }
  }
  const isLazyUnloaded = (node) => node.lazy && !node.loaded && node.children.size === 0;
  function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  /** Surgical sidebar update: rebuild only one folder's children box. */
  function refreshDirSide(dirPath) {
    if (!S.model || !S.win.open) return;
    if (dirPath === '') { renderSidebar(); return; }
    const box = qs(E.sideScroll, '.ghf-side-children[data-children="' + cssEscape(dirPath) + '"]');
    const dirNode = S.model.get(dirPath);
    if (!box || !dirNode) { renderSidebar(); return; }
    const keep = box.scrollTop;
    box.textContent = '';
    const holder = el('div');
    box.append(holder);
    fillSidebarChildren(holder, dirNode, dirPath);
    // move children up into box
    while (holder.firstElementChild) box.append(holder.firstElementChild);
    holder.remove();
    box.scrollTop = keep;
    // refresh the folder's own row state (pending etc.) via full cheap pass
    const row = qs(E.sideScroll, '.ghf-srow[data-path="' + cssEscape(dirPath) + '"]');
    if (row && dirNode.children.size) row.classList.remove('ghf-pending-row');
  }

  function renderFavorites() { renderSidebar(); }

  /* ── Breadcrumbs ──────────────────────────────────────── */
  function renderCrumbs() {
    if (!S.win.open) return;
    const bar = E.crumbs;
    bar.textContent = '';
    if (S.nav.query != null) {
      bar.append(el('span', { class: 'ghf-crumb ghf-last' }, iconEl('search'), 'Search'),
        el('span', { class: 'ghf-spacer' }),
        el('span', { class: 'ghf-lastcommit' }, formatCount(mainItems.length) + ' result' + (mainItems.length === 1 ? '' : 's')));
      return;
    }
    if (!S.model || !S.repo) return;
    const repoCrumb = el('span', { class: 'ghf-crumb', dataset: { drop: '' }, title: 'Repository root' },
      iconEl('repo'), el('span', { class: 'ghf-ell' }, S.repo.owner + '/' + S.repo.name));
    repoCrumb.addEventListener('click', () => navTo(''));
    bar.append(repoCrumb);
    let acc = '';
    for (const seg of pathSegments(S.nav.path)) {
      acc = pathJoin(acc, seg);
      const p = acc;
      bar.append(el('span', { class: 'ghf-crumb-sep' }, (() => { const s = el('span'); s.innerHTML = icon('chevron', 9); return s; })()));
      const crumb = el('span', { class: 'ghf-crumb', dataset: { drop: p }, title: p },
        iconEl('folder'), el('span', { class: 'ghf-ell' }, seg));
      crumb.addEventListener('click', () => navTo(p));
      bar.append(crumb);
    }
    if (bar.lastElementChild) bar.lastElementChild.classList.add('ghf-last');
    bar.append(el('span', { class: 'ghf-spacer' }));
    // Last-commit chip for the current folder
    const dirNode = S.model.get(S.nav.path);
    if (dirNode && dirNode.lastCommit && dirNode.lastCommit.data) {
      const c = dirNode.lastCommit.data;
      bar.append(el('span', {
        class: 'ghf-lastcommit',
        title: (c.message || '') + (c.author ? '\nby ' + c.author : ''),
      },
        iconEl('clock'),
        el('span', { class: 'ghf-when' }, relTime(c.when)),
        el('span', { class: 'ghf-ell' }, (c.message || '').split('\n')[0])));
    }
  }
  let _lcTimer = 0;
  function fetchLastCommitDebounced() {
    clearTimeout(_lcTimer);
    _lcTimer = setTimeout(async () => {
      if (!S.model || !S.repo || S.nav.query != null) return;
      const dirNode = S.model.get(S.nav.path);
      if (!dirNode) return;
      const fresh = dirNode.lastCommit && Date.now() - dirNode.lastCommit.when < 5 * 60 * 1000;
      if (fresh) return;
      const wantPath = S.nav.path;
      const wantModel = S.model;
      try {
        const ctx = ctxNow();
        const arr = await API.lastCommitFor(ctx, wantPath || null);
        const c = arr && arr[0];
        if (c && S.model === wantModel && S.nav.path === wantPath) {
          const when = c.commit && c.commit.author ? Date.parse(c.commit.author.date) : Date.now();
          dirNode.lastCommit = {
            when,
            data: { when, message: c.commit ? c.commit.message : '', author: c.commit && c.commit.author ? c.commit.author.name : '' },
          };
          markDirty('crumbs');
        }
      } catch (e) { /* background info — stay silent */ }
    }, 350);
  }

  /* ── Title / status / toolbar ─────────────────────────── */
  function renderTitle() {
    if (!S.win.open) return;
    if (S.nav.query != null) { E.title.textContent = 'Search'; return; }
    if (!S.repo) { E.title.textContent = 'GitHub Finder'; return; }
    E.title.textContent = S.nav.path ? pathBase(S.nav.path) : S.repo.owner + '/' + S.repo.name;
  }
  function renderStatus() {
    if (!S.win.open) return;
    const parts = [];
    if (S.model) {
      parts.push(formatCount(mainItems.length) + ' item' + (mainItems.length === 1 ? '' : 's'));
      if (S.sel.size) {
        let bytes = 0, dirs = 0;
        for (const p of S.sel) {
          const n = S.model.get(p);
          if (!n) continue;
          if (n.type === 'dir') dirs++; else bytes += n.size || 0;
        }
        let sel = formatCount(S.sel.size) + ' selected';
        if (bytes) sel += ', ' + formatBytes(bytes);
        if (dirs) sel += dirs === S.sel.size ? '' : '';
        parts.push(sel);
      }
      if (S.pendingOps > 0) parts.push('');
    }
    E.stLeft.textContent = '';
    for (const p of parts) {
      if (p === '') { E.stLeft.append(el('span', { class: 'ghf-syncing' }, el('span', { class: 'ghf-spin' }), 'syncing')); continue; }
      if (E.stLeft.childNodes.length) E.stLeft.append(' · ');
      E.stLeft.append(p);
    }
    E.stMid.textContent = S.repo ? (S.repo.owner + '/' + S.repo.name + ' @ ' + S.repo.branch) : 'not connected';
    const pct = S.rate.limit ? S.rate.remaining / S.rate.limit : 1;
    E.stRate.textContent = 'API ' + formatCount(Math.max(0, S.rate.remaining)) + '/' + formatCount(S.rate.limit);
    E.stRate.classList.toggle('ghf-low', pct <= 0.05 && pct > 0);
    E.stRate.classList.toggle('ghf-out', S.rate.remaining <= 0 || Date.now() < S.cooldownUntil);
  }
  function renderToolbar() {
    if (!S.win.open) return;
    E.btnBack.disabled = S.nav.hi <= 0;
    E.btnFwd.disabled = S.nav.hi >= S.nav.history.length - 1;
    E.segThumb.style.transform = 'translateX(' + (S.view.mode === 'list' ? 0 : 32) + 'px)';
    E.segBtnList.classList.toggle('ghf-on', S.view.mode === 'list');
    E.segBtnGrid.classList.toggle('ghf-on', S.view.mode === 'grid');
    E.sortSel.value = S.view.sortKey;
    E.sortDirBtn.style.transform = S.view.sortDir < 0 ? 'rotate(180deg)' : 'none';
  }

  /* ── View / sort setters (persisted) ──────────────────── */
  function setViewMode(mode) {
    S.view.mode = mode;
    store.set('view', S.view);
    navResetScroll = false;
    markDirty('main', 'toolbar');
  }
  function setSort(key, dir) {
    if (key) S.view.sortKey = key;
    if (dir) S.view.sortDir = dir;
    store.set('view', S.view);
    S.model && (S.model._sorted = new Map());
    navResetScroll = false;
    markDirty('main', 'toolbar');
  }

  /* ── Navigation ───────────────────────────────────────── */
  function navTo(path, opts = {}) {
    if (!S.model) return;
    path = path || '';
    const dir = S.model.get(path);
    if (!dir || dir.type !== 'dir') path = '';
    if (opts.push !== false) {
      S.nav.history = S.nav.history.slice(0, S.nav.hi + 1);
      if (S.nav.history[S.nav.hi] !== path) {
        S.nav.history.push(path);
        S.nav.hi = S.nav.history.length - 1;
      }
    }
    S.nav.path = path;
    if (S.nav.query != null && !opts.stayInSearch) exitSearch(false);
    navResetScroll = true;
    pruneSel(true);
    ensureExpanded(path);
    store.set('lastPath:' + S.repoKey, path);
    markDirty('main', 'crumbs', 'title', 'status', 'toolbar');
    revealInSidebar(path);
  }
  function navigateHistory(delta) {
    const ni = S.nav.hi + delta;
    if (ni < 0 || ni >= S.nav.history.length) return;
    S.nav.hi = ni;
    S.nav.path = S.nav.history[ni];
    if (S.nav.query != null) exitSearch(false);
    navResetScroll = true;
    pruneSel(true);
    ensureExpanded(S.nav.path);
    markDirty('main', 'crumbs', 'title', 'status', 'toolbar');
    revealInSidebar(S.nav.path);
  }
  function ensureExpanded(dirPath) {
    let acc = '';
    for (const seg of pathSegments(dirPath)) {
      acc = pathJoin(acc, seg);
      S.expanded.add(acc);
    }
    persistExpanded();
  }
  function persistExpanded() {
    if (!S.repoKey) return;
    store.set('exp:' + S.repoKey, [...S.expanded].slice(0, 4000));
  }
  function toggleExpand(dirPath) {
    const node = S.model && S.model.get(dirPath);
    if (!node || node.type !== 'dir') return;
    if (isLazyUnloaded(node)) { ensureDirLoaded(node); return; }
    if (S.expanded.has(dirPath)) S.expanded.delete(dirPath);
    else S.expanded.add(dirPath);
    persistExpanded();
    renderSidebar();
    markDirty('main'); // folders keep their icon state fresh
  }
  function revealInSidebar(dirPath) {
    ensureExpanded(dirPath);
    // A full sidebar render is cheap relative to correctness here (chunking).
    renderSidebar();
    const row = qs(E.sideScroll, '.ghf-srow[data-path="' + cssEscape(dirPath) + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  /** Lazy-load a subtree folder (large/truncated repos). */
  async function ensureDirLoaded(node) {
    if (!node || node.loading || node.loaded) return;
    node.loading = true;
    renderSidebar();
    try {
      const ctx = ctxNow();
      const data = await API.getTree(ctx, node.sha);
      for (const e of (data.tree || [])) {
        if (node.children.has(pathBase(e.path))) continue;
        const child = new Node({
          name: pathBase(e.path), path: pathJoin(node.path, pathBase(e.path)),
          type: e.type === 'tree' ? 'dir' : 'file', sha: e.sha || null,
          size: e.type === 'blob' ? (e.size || 0) : 0,
          mode: e.mode || (e.type === 'tree' ? '040000' : '100644'),
          parent: node, lazy: e.type === 'tree', loaded: e.type !== 'tree',
        });
        node.children.set(child.name, child);
        S.model.byPath.set(child.path, child);
      }
      node.loaded = true;
      node.lazy = false;
      S.model._touchAll();
      markDirty('main');
    } catch (e) {
      toast('error', 'Could not load folder', e.message);
    } finally {
      node.loading = false;
      renderSidebar();
    }
  }

  /* ── Selection ────────────────────────────────────────── */
  function setSel(paths, focusPath) {
    S.sel = new Set(paths);
    S.focus = focusPath != null ? focusPath : (paths[0] || '');
    S.anchor = S.focus;
    updateSelClasses();
    markDirty('status');
  }
  function clickSelect(path, ev) {
    const items = mainItems;
    const idx = mainIndex.get(path);
    if (ev && (ev.metaKey || ev.ctrlKey)) {
      if (S.sel.has(path)) S.sel.delete(path); else S.sel.add(path);
      S.focus = path; S.anchor = path;
    } else if (ev && ev.shiftKey && S.anchor) {
      const a = mainIndex.get(S.anchor) || 0;
      const b = idx || 0;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      S.sel = new Set(items.slice(lo, hi + 1).map((n) => n.path));
      S.focus = path;
    } else {
      S.sel = new Set([path]);
      S.focus = path; S.anchor = path;
    }
    updateSelClasses();
    markDirty('status');
  }
  function selectAll() {
    S.sel = new Set(mainItems.map((n) => n.path));
    updateSelClasses();
    markDirty('status');
  }
  function clearSel() {
    if (renameState) { cancelRename(); return; }
    S.sel.clear();
    updateSelClasses();
    markDirty('status');
  }
  /** Drop selections/anchors that no longer exist in the model. */
  function pruneSel(clearAll) {
    if (clearAll) { S.sel.clear(); S.focus = ''; S.anchor = ''; return; }
    for (const p of [...S.sel]) if (!S.model || !S.model.has(p)) S.sel.delete(p);
    if (S.focus && !S.model.has(S.focus)) S.focus = '';
    if (S.anchor && !S.model.has(S.anchor)) S.anchor = '';
    if (S.clip) S.clip.paths = S.clip.paths.filter((p) => S.model && S.model.has(p));
  }
  function selectedNodes() {
    if (!S.model) return [];
    const out = [];
    for (const p of S.sel) { const n = S.model.get(p); if (n) out.push(n); }
    return out;
  }
  function revealPath(path) {
    const i = mainIndex.get(path);
    if (i != null && E.vlist) E.vlist.reveal(i);
  }
  function focusNext(delta) {
    if (!mainItems.length) return;
    const cur = mainIndex.get(S.focus);
    let next;
    if (cur == null) next = delta > 0 ? 0 : mainItems.length - 1;
    else next = clamp(cur + delta, 0, mainItems.length - 1);
    const node = mainItems[next];
    setSel([node.path], node.path);
    revealPath(node.path);
  }

  /* ── Live search ──────────────────────────────────────── */
  let _searchDebounce = 0;
  function onSearchInput() {
    const q = E.searchInput.value;
    E.searchbox.classList.toggle('ghf-has-q', !!q);
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      if (q.trim()) enterSearch(q.trim());
      else if (S.nav.query != null) exitSearch(true);
    }, 140);
  }
  function enterSearch(q) {
    S.nav.query = q;
    navResetScroll = true;
    S.sel.clear();
    markDirty('main', 'crumbs', 'title', 'status');
  }
  function exitSearch(clearInput) {
    S.nav.query = null;
    if (clearInput) { E.searchInput.value = ''; E.searchbox.classList.remove('ghf-has-q'); }
    navResetScroll = true;
    markDirty('main', 'crumbs', 'title', 'status');
  }

  /* ── Inline rename ────────────────────────────────────── */
  let renameState = null; // {path, input, orig}
  function startInlineRename(path) {
    const node = S.model && S.model.get(path);
    if (!node) return;
    if (node.pending) { toast('info', 'Still syncing', 'Wait a moment for the previous change to finish.'); return; }
    if (S.view.mode === 'grid') {
      promptRename(node);
      return;
    }
    const rowEl = qs(E.mainScroll, '.ghf-row[data-path="' + cssEscape(path) + '"]');
    const nameEl = rowEl && qs(rowEl, '.ghf-name');
    if (!nameEl) { promptRename(node); return; }
    commitRename(false);
    const input = el('input', { class: 'ghf-rename', value: node.name, spellcheck: 'false' });
    renameState = { path, input, orig: node.name };
    nameEl.replaceWith(input);
    input.focus();
    const dot = node.name.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : node.name.length);
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const val = input.value;
      renameState = null;
      if (commit && val !== node.name) ops.renameNode(node, val);
      else markDirty('main');
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  }
  function commitRename() { // called with any args — always commits
    if (!renameState) return;
    const rs = renameState;
    renameState = null;
    const node = S.model && S.model.get(rs.path);
    if (node && rs.input.value !== rs.orig) ops.renameNode(node, rs.input.value);
    else markDirty('main');
  }
  function cancelRename() {
    if (!renameState) return;
    renameState = null;
    markDirty('main');
  }
  function promptRename(node) {
    promptDialog({
      title: 'Rename “' + node.name + '”', label: 'New name', value: node.name, selectBasename: true,
      confirmLabel: 'Rename', icon: 'pencil',
    }).then((val) => { if (val != null && val !== node.name) ops.renameNode(node, val); });
  }

  /* ══════════════════════════ §12 OPERATIONS (OPTIMISTIC) ══════════════════════════
     Every mutation: 1) validate → 2) patch the model instantly (zero perceived
     delay) → 3) fire the API commit → 4) on success clear pending flags; on
     failure run the recorded undo journal, restore the exact prior state and
     explain in a toast. Renders are rAF-coalesced (one paint per frame). */

  /** uniqueName: “name”, “name copy”, “name copy 2”… (Finder convention) */
  function uniqueName(dirPath, desired) {
    const dir = S.model.get(dirPath);
    if (!dir || !dir.children) return desired;
    if (!dir.children.has(desired)) return desired;
    const dot = desired.lastIndexOf('.');
    const base = dot > 0 ? desired.slice(0, dot) : desired;
    const ext = dot > 0 ? desired.slice(dot) : '';
    for (let i = 1; i < 500; i++) {
      const cand = i === 1 ? base + ' copy' + ext : base + ' copy ' + i + ext;
      if (!dir.children.has(cand)) return cand;
    }
    return base + ' copy ' + Date.now() + ext;
  }
  function assertWritable(node) {
    if (node && node.pending) throw new Error('“' + node.name + '” is still syncing — try again in a moment.');
  }
  /** Where the "+" button creates items: inside a single selected folder, else the viewed folder. */
  function targetDirForNew() {
    if (S.sel.size === 1) {
      const n = S.model.get([...S.sel][0]);
      if (n && n.type === 'dir') return n.path;
    }
    return S.nav.path || '';
  }

  /**
   * Run one optimistic operation.
   * @param apply()   → {undo, touchedDirs:[...]}, throws on validation errors
   * @param api()     → Promise (the actual commit)
   * @param done(res) → optional success patch (shas, pending=false…)
   */
  function runOptimistic({ apply, api, done, successMsg, errorLabel }) {
    if (!S.model || !S.repo) { toast('error', 'No repository loaded.'); return; }
    let journal;
    try {
      journal = apply();
    } catch (e) {
      toast('error', errorLabel, e.message);
      return;
    }
    const touched = journal.touchedDirs || [];
    const refresh = () => {
      if (S.nav.query != null) markDirty('main');
      else { markDirty('main', 'status'); for (const d of touched) refreshDirSide(d); }
      markDirty('status', 'crumbs');
    };
    refresh();
    S.pendingOps++;
    markDirty('status');
    const myModel = S.model;
    const apiFn = api;
    apiFn().then((res) => {
      S.pendingOps = Math.max(0, S.pendingOps - 1);
      if (S.model === myModel && done) done(res);
      refresh();
      if (successMsg) toast('success', successMsg);
    }).catch((err) => {
      S.pendingOps = Math.max(0, S.pendingOps - 1);
      try { journal.undo(); } catch (e) { /* undo must never throw */ }
      if (S.model === myModel) {
        pruneSel();
        refresh();
      }
      const reason = err && err.message ? err.message : 'Unknown error';
      toast('error', (errorLabel || 'Operation') + ' — reverted', reason);
      if (err && err.needsSettings) openSettings();
    });
  }

  const ops = {
    /* ── New file ─────────────────────────────────────── */
    newFile(dirPath, name, content) {
      const dir = dirPath != null && dirPath !== '' ? dirPath : targetDirForNew();
      let finalName;
      try {
        finalName = validateName(name);
        if (!S.model.get(dir) || S.model.get(dir).type !== 'dir') throw new Error('Destination folder not found.');
        if (S.model.get(dir).children.has(finalName)) throw new Error('An item named “' + finalName + '” already exists here.');
      } catch (e) { toast('error', 'Could not create file', e.message); return; }
      const text = content || '';
      const ctx = ctxNow();
      const entry = { path: pathJoin(dir, finalName), mode: '100644', type: 'blob', content: text, encoding: 'utf-8' };
      runOptimistic({
        errorLabel: 'Could not create “' + finalName + '”',
        successMsg: 'Created ' + entry.path,
        apply: () => S.model.addNew(dir, { name: finalName, type: 'file', size: byteLength(text) }),
        api: () => gitCommit(ctx, 'Create ' + entry.path, [entry]),
        done: () => {
          S.model.patchNode(entry.path, { pending: false, sha: entry.sha });
          S.expanded.add(dir); persistExpanded();
          setSel([entry.path]); revealPath(entry.path);
        },
      });
    },

    /* ── New folder (git keeps no empty dirs → .gitkeep) ─ */
    newFolder(dirPath, name) {
      const dir = dirPath != null && dirPath !== '' ? dirPath : targetDirForNew();
      let finalName;
      try {
        finalName = validateName(name);
        if (!S.model.get(dir) || S.model.get(dir).type !== 'dir') throw new Error('Destination folder not found.');
        if (S.model.get(dir).children.has(finalName)) throw new Error('An item named “' + finalName + '” already exists here.');
      } catch (e) { toast('error', 'Could not create folder', e.message); return; }
      const ctx = ctxNow();
      const keepPath = pathJoin(pathJoin(dir, finalName), '.gitkeep');
      const entry = { path: keepPath, mode: '100644', type: 'blob', content: '', encoding: 'utf-8' };
      runOptimistic({
        errorLabel: 'Could not create folder “' + finalName + '”',
        successMsg: 'Folder created (with .gitkeep)',
        apply: () => {
          const res = S.model.addNew(dir, { name: finalName, type: 'dir' });
          const keep = S.model.addNew(res.node.path, { name: '.gitkeep', type: 'file', size: 0 });
          const undo = () => { keep.undo(); res.undo(); };
          return { undo, touchedDirs: [dir, res.node.path] };
        },
        api: () => gitCommit(ctx, 'Create ' + pathJoin(dir, finalName) + '/.gitkeep', [entry]),
        done: () => {
          S.model.patchNode(keepPath, { pending: false, sha: entry.sha });
          S.model.patchNode(pathJoin(dir, finalName), { pending: false });
          S.expanded.add(dir); persistExpanded();
          setSel([pathJoin(dir, finalName)]);
          revealPath(pathJoin(dir, finalName));
        },
      });
    },

    /* ── Rename ───────────────────────────────────────── */
    renameNode(node, newName) {
      if (!node || !node.parent) return;
      try {
        assertWritable(node);
        newName = validateName(newName);
      } catch (e) { toast('error', 'Could not rename', e.message); markDirty('main'); return; }
      if (newName === node.name) { markDirty('main'); return; }
      // Pre-validate collisions without mutating the model.
      if (node.parent.children.has(newName) && node.parent.children.get(newName) !== node) {
        toast('error', 'Could not rename', 'An item named “' + newName + '” already exists here.');
        markDirty('main');
        return;
      }
      const ctx = ctxNow();
      const oldPath = node.path;
      const dirPath = pathDir(oldPath);
      const newPath = pathJoin(dirPath, newName);
      const entry = node.type === 'dir'
        ? { path: newPath, mode: '040000', type: 'tree', sha: node.sha }
        : { path: newPath, mode: node.mode || '100644', type: 'blob', sha: node.sha };
      const del = { path: oldPath, mode: node.mode || '100644', type: node.type === 'dir' ? 'tree' : 'blob', sha: null };
      runOptimistic({
        errorLabel: 'Could not rename “' + node.name + '”',
        successMsg: 'Renamed to ' + newName,
        apply: () => S.model.rename(oldPath, newName),
        api: () => gitCommit(ctx, 'Rename ' + oldPath + ' → ' + entry.path, [entry, del]),
        done: () => { S.model.patchNode(entry.path, { pending: false }); setSel([entry.path]); },
      });
    },

    /* ── Delete ───────────────────────────────────────── */
    async deleteNodes(nodes) {
      nodes = (nodes || []).filter((n) => n && n.parent);
      if (!nodes.length) return;
      // Pending items: their commit is still in flight; block gently.
      const pend = nodes.find((n) => n.pending);
      if (pend) { toast('info', 'Still syncing', 'Wait for “' + pend.name + '” to finish before deleting it.'); return; }
      const paths = nodes.map((n) => n.path);
      const names = nodes.map((n) => n.name);
      const one = nodes.length === 1 && names[0];
      const ok = await confirmDialog({
        title: one ? 'Delete “' + one + '”?' : 'Delete ' + nodes.length + ' items?',
        message: one
          ? 'This removes the item from branch ' + S.repo.branch + ' with a new commit. You can restore it from the commit history on GitHub.'
          : 'This removes ' + nodes.length + ' items from branch ' + S.repo.branch + ' with a new commit.',
        items: names,
        note: 'Folders that become empty are removed too — git cannot store empty folders.',
        confirmLabel: one ? 'Delete' : 'Delete ' + nodes.length + ' Items',
      });
      if (!ok) return;
      const ctx = ctxNow();
      const entries = nodes.map((n) => ({
        path: n.path, mode: n.mode || (n.type === 'dir' ? '040000' : '100644'),
        type: n.type === 'dir' ? 'tree' : 'blob', sha: null,
      }));
      runOptimistic({
        errorLabel: 'Could not delete',
        successMsg: one ? 'Deleted ' + one : 'Deleted ' + nodes.length + ' items',
        apply: () => S.model.removeNodes(paths),
        api: () => gitCommit(ctx, 'Delete ' + (one ? one : nodes.length + ' items') +
          (nodes.length > 1 ? ': ' + names.slice(0, 8).join(', ') : ''), entries),
        done: () => { pruneSel(); closeSheetsForPaths(paths); },
      });
    },

    /* ── Move (drag & drop / Move to… / cut+paste) ────── */
    moveNodes(nodes, destDirPath) {
      nodes = (nodes || []).filter((n) => n && n.parent);
      if (!nodes.length) return;
      const dest = S.model.get(destDirPath);
      if (!dest || dest.type !== 'dir') { toast('error', 'Move failed', 'Destination folder not found.'); return; }
      const pend = nodes.find((n) => n.pending);
      if (pend) { toast('info', 'Still syncing', 'Wait for “' + pend.name + '” to finish before moving it.'); return; }
      const moves = [];
      for (const n of nodes) {
        if (n.path === destDirPath) continue;
        if (isDescendant(n.path, destDirPath)) {
          toast('error', 'Cannot move “' + n.name + '”', 'A folder cannot be moved into itself.');
          return;
        }
        if (pathDir(n.path) === destDirPath) continue;
        if (dest.children.has(n.name)) {
          toast('error', 'Cannot move “' + n.name + '”', 'An item with that name already exists in “' + (pathBase(destDirPath) || 'repository root') + '”.');
          return;
        }
        moves.push({ path: n.path, destDirPath });
      }
      if (!moves.length) { toast('info', 'Already there', 'The item is already in that folder.'); return; }
      const ctx = ctxNow();
      const entries = [];
      const newPaths = [];
      for (const mv of moves) {
        const node = S.model.get(mv.path);
        const newPath = pathJoin(destDirPath, node.name);
        newPaths.push(newPath);
        entries.push({
          path: newPath, mode: node.mode || (node.type === 'dir' ? '040000' : '100644'),
          type: node.type === 'dir' ? 'tree' : 'blob', sha: node.sha,
        });
        entries.push({ path: mv.path, mode: node.mode || (node.type === 'dir' ? '040000' : '100644'), type: node.type === 'dir' ? 'tree' : 'blob', sha: null });
      }
      runOptimistic({
        errorLabel: 'Could not move ' + (moves.length > 1 ? moves.length + ' items' : '“' + pathBase(moves[0].path) + '”'),
        successMsg: 'Moved to ' + (pathBase(destDirPath) || 'repository root'),
        apply: () => S.model.moveNodes(moves),
        api: () => gitCommit(ctx, 'Move ' + (moves.length > 1 ? moves.length + ' items' : moves[0].path) + ' → ' + destDirPath + '/', entries),
        done: () => {
          for (const p of newPaths) S.model.patchNode(p, { pending: false });
          S.expanded.add(destDirPath); persistExpanded();
          pruneSel();
        },
      });
    },

    /* ── Duplicate ────────────────────────────────────── */
    duplicateNodes(nodes, destDirPath) {
      nodes = (nodes || []).filter((n) => n && n.parent);
      if (!nodes.length) return;
      const pend = nodes.find((n) => n.pending);
      if (pend) { toast('info', 'Still syncing', 'Wait for “' + pend.name + '” to finish before duplicating it.'); return; }
      const dest = destDirPath != null ? destDirPath : pathDir(nodes[0].path);
      const ctx = ctxNow();
      const entries = [];
      const clones = [];
      for (const n of nodes) {
        const newName = uniqueName(dest, n.name);
        clones.push({ src: n, newName, dest });
        entries.push(n.type === 'dir'
          ? { path: pathJoin(dest, newName), mode: '040000', type: 'tree', sha: n.sha }
          : { path: pathJoin(dest, newName), mode: n.mode || '100644', type: 'blob', sha: n.sha });
      }
      runOptimistic({
        errorLabel: 'Could not duplicate',
        successMsg: nodes.length === 1 ? 'Duplicated as “' + clones[0].newName + '”' : 'Duplicated ' + nodes.length + ' items',
        apply: () => {
          let undoAll = () => {};
          const touched = new Set([dest]);
          for (let i = clones.length - 1; i >= 0; i--) {
            const c = clones[i];
            const r = S.model.cloneNode(c.src.path, c.dest, c.newName);
            const prev = undoAll;
            undoAll = () => { r.undo(); prev(); };
            touched.add(c.dest);
          }
          return { undo: undoAll, touchedDirs: [...touched] };
        },
        api: () => gitCommit(ctx, 'Duplicate ' + (nodes.length > 1 ? nodes.length + ' items' : clones[0].src.path), entries),
        done: () => {
          for (const c of clones) S.model.patchNode(pathJoin(c.dest, c.newName), { pending: false });
          setSel(clones.map((c) => pathJoin(c.dest, c.newName)));
        },
      });
    },

    /* ── Edit file content ────────────────────────────── */
    editContent(node, text) {
      if (!node) return;
      const ctx = ctxNow();
      const entry = { path: node.path, mode: node.mode || '100644', type: 'blob', content: text, encoding: 'utf-8' };
      const oldSize = node.size, oldSha = node.sha, oldPending = node.pending;
      runOptimistic({
        errorLabel: 'Could not save “' + node.name + '”',
        successMsg: 'Saved ' + node.name,
        apply: () => {
          S.model.patchNode(node.path, { size: byteLength(text), pending: true });
          return { undo: () => S.model.patchNode(node.path, { size: oldSize, sha: oldSha, pending: oldPending }), touchedDirs: [] };
        },
        api: () => gitCommit(ctx, 'Edit ' + node.path, [entry]),
        done: () => S.model.patchNode(node.path, { pending: false, sha: entry.sha }),
      });
    },

    /* ── Upload files (base64) ────────────────────────── */
    uploadFiles(dirPath, files) {
      files = (files || []).filter((f) => f && f.name);
      if (!files.length) return;
      const dir = dirPath || S.nav.path || '';
      if (!S.model.get(dir) || S.model.get(dir).type !== 'dir') { toast('error', 'Upload failed', 'Destination folder not found.'); return; }
      for (const f of files) {
        if (f.size > CFG.BLOB_MAX) {
          toast('error', 'File too large', '“' + f.name + '” is ' + formatBytes(f.size) + ' — GitHub blocks API uploads above ~100 MB.');
          return;
        }
      }
      const big = files.find((f) => f.size > CFG.BLOB_WARN);
      const doUpload = () => this._uploadNow(dir, files);
      if (big) {
        confirmDialog({
          title: 'Upload large files?',
          message: '“' + big.name + '” is ' + formatBytes(big.size) + '. Large uploads via the API can be slow.',
          confirmLabel: 'Upload', danger: false,
        }).then((ok) => { if (ok) doUpload(); });
      } else doUpload();
    },
    _uploadNow(dir, files) {
      const ctx = ctxNow();
      // Plan final paths: intermediate folders keep their names; only the final
      // file name is uniquified on collision.
      const planned = files.map((f) => {
        const segs = (f.relPath || f.name).split('/').filter(Boolean).map((s) => validateName(s));
        const fname = segs.pop();
        const fdir = segs.length ? pathJoin(dir, ...segs) : dir;
        const exists = S.model.get(fdir);
        const collision = exists && exists.children && exists.children.has(fname);
        const finalName = collision ? uniqueName(fdir, fname) : fname;
        return { file: f, path: pathJoin(fdir, finalName), dir: fdir };
      });
      const entries = planned.map((p) => ({ path: p.path, mode: '100644', type: 'blob', content: p.file.b64, encoding: 'base64' }));
      runOptimistic({
        errorLabel: 'Upload failed',
        successMsg: 'Uploaded ' + planned.length + ' file' + (planned.length > 1 ? 's' : ''),
        apply: () => {
          let undoAll = () => {};
          const touched = new Set([dir]);
          const created = [];
          for (const p of planned) {
            // Ensure intermediate folders exist in the model.
            const relSegs = p.path.slice(dir ? dir.length + 1 : 0).split('/').slice(0, -1);
            let acc = dir;
            for (const seg of relSegs) {
              acc = pathJoin(acc, seg);
              if (!S.model.has(acc)) {
                const r = S.model.addNew(pathDir(acc), { name: seg, type: 'dir', pending: true });
                created.push(r);
                const prev = undoAll;
                undoAll = () => { r.undo(); prev(); };
                touched.add(pathDir(acc));
              }
            }
            const r = S.model.addNew(p.dir, { name: pathBase(p.path), type: 'file', size: p.file.size, pending: true });
            created.push(r);
            const prev = undoAll;
            undoAll = () => { r.undo(); prev(); };
            touched.add(p.dir);
          }
          return { undo: undoAll, touchedDirs: [...touched] };
        },
        api: () => gitCommit(ctx, 'Upload ' + planned.length + ' file' + (planned.length > 1 ? 's' : '') + ' to ' + (dir || '/') + '/', entries),
        done: () => {
          for (const p of planned) {
            const e = entries.find((x) => x.path === p.path);
            S.model.patchNode(p.path, { pending: false, sha: e ? e.sha : null });
          }
          S.expanded.add(dir); persistExpanded();
        },
      });
    },

    /* ── Clipboard paste ──────────────────────────────── */
    paste() {
      if (!S.clip || !S.clip.paths.length) { toast('info', 'Nothing to paste', 'Copy or cut items first.'); return; }
      const nodes = S.clip.paths.map((p) => S.model.get(p)).filter(Boolean);
      if (!nodes.length) { S.clip = null; updateSelClasses(); return; }
      if (S.clip.mode === 'cut') {
        const dest = S.nav.path || '';
        const moving = nodes.filter((n) => pathDir(n.path) !== dest);
        this.moveNodes(moving, dest);
        S.clip = null;
        updateSelClasses();
      } else {
        this.duplicateNodes(nodes, S.nav.path || '');
      }
    },
  };

  /* ── Sheet registry: close sheets whose nodes vanished ── */
  const sheetRegistry = []; // {paths:[], close()}
  function closeSheetsForPaths(paths) {
    for (const s of [...sheetRegistry]) {
      if (s.paths && s.paths.some((p) => paths.includes(p))) s.close();
    }
  }

  /* ── Dialog-driven entry points (toolbar +, empty states, menus) ── */
  function newFilePrompt(dirPath) {
    const dir = dirPath != null && dirPath !== '' ? dirPath : targetDirForNew();
    promptDialog({
      title: 'New File', label: 'File name', value: '', placeholder: 'e.g. notes.md', confirmLabel: 'Create File', icon: 'docPlus',
    }).then((name) => { if (name) ops.newFile(dir, name, ''); });
  }
  function newFolderPrompt(dirPath) {
    const dir = dirPath != null && dirPath !== '' ? dirPath : targetDirForNew();
    promptDialog({
      title: 'New Folder', label: 'Folder name', value: '', placeholder: 'e.g. docs', confirmLabel: 'Create Folder', icon: 'folderPlus',
    }).then((name) => { if (name) ops.newFolder(dir, name); });
  }

  /* ══════════════════════════ REPO LOADING ══════════════════════════ */

  async function resolveBranch(info, repo) {
    if (repo.urlBranch) {
      // The URL may carry a branch with slashes — probe prefixes, longest first.
      const segs = repo.urlBranch.split('/').filter(Boolean);
      if (segs.length) {
        for (let take = segs.length; take >= 1; take--) {
          const cand = segs.slice(0, take).join('/');
          const b = await API.getBranch({ owner: repo.owner, name: repo.name }, cand);
          if (b) return { branch: cand, path: segs.slice(take).concat(repo.urlPath || '').filter(Boolean).join('/') };
        }
        toast('info', 'Branch not found', '“' + repo.urlBranch + '” is not a branch — using ' + (info.default_branch || 'main') + '.');
      }
    }
    return { branch: info.default_branch || 'main', path: '' };
  }

  async function loadRepo(repo) {
    if (!S.token) { renderEmptyState('needs-token'); openSettings(true); return; }
    S.repo = { owner: repo.owner, name: repo.name, branch: '', info: null, lazy: false };
    S.repoKey = repo.owner + '/' + repo.name;
    S.model = null;
    S.nav = { path: '', history: [], hi: -1, query: null };
    S.sel.clear(); S.clip = null;
    renderEmptyState('loading', 'Loading ' + repo.owner + '/' + repo.name + '…');
    markAll();
    try {
      const info = await API.getRepo({ owner: repo.owner, name: repo.name });
      S.repo.info = info;
      const rb = await resolveBranch(info, repo);
      S.repo.branch = rb.branch;
      store.set('lastRepo', { owner: repo.owner, name: repo.name });
      S.lastRepo = { owner: repo.owner, name: repo.name };
      // Restore per-repo state.
      S.favorites = new Set(store.get('fav:' + S.repoKey, []));
      S.expanded = new Set(['', ...store.get('exp:' + S.repoKey, [])]);
      // Load the tree.
      let treeData = null;
      try {
        treeData = await API.getTreeRecursive({ owner: repo.owner, name: repo.name, branch: S.repo.branch });
      } catch (e) {
        if (e.status === 404 || e.status === 409 || e.status === 422) treeData = { empty: true };
        else throw e;
      }
      if (treeData.empty || (!treeData.tree || !treeData.tree.length)) {
        S.model = new RepoTree(treeData.sha || null);
        S.model.root.loaded = true;
      } else if (treeData.truncated) {
        // Very large repo: load only the root level eagerly; deeper folders
        // lazy-load on expand.
        const rootTree = await API.getTree({ owner: repo.owner, name: repo.name, branch: S.repo.branch }, treeData.sha);
        S.model = new RepoTree(treeData.sha);
        S.repo.lazy = true;
        for (const e of rootTree.tree || []) S.model._insertEntry(e);
        toast('info', 'Large repository', 'Tree was truncated — deep folders load on demand.');
      } else {
        S.model = RepoTree.build(treeData.tree, treeData.sha);
      }
      // Navigate to the last-opened folder (or the URL path).
      const lastPath = rb.path || store.get('lastPath:' + S.repoKey, '');
      const target = S.model.has(lastPath) && S.model.get(lastPath).type === 'dir' ? lastPath : '';
      E.empty.classList.remove('ghf-on');
      markAll();
      navTo(target, { push: true });
      if (rb.path) {
        // A file path from a /blob/ URL: select it.
        const fileNode = S.model.get(rb.path);
        if (fileNode) setSel([fileNode.path]);
      }
    } catch (e) {
      S.model = null;
      if (e.status === 401) { renderEmptyState('needs-token'); openSettings(true); return; }
      renderEmptyState('error', e.message || 'Could not load the repository.');
      toast('error', 'Could not load repository', e.message);
    }
  }

  async function refreshTree() {
    if (!S.repo || !S.model) return;
    if (S.pendingOps > 0) {
      const ok = await confirmDialog({ title: 'Refresh while syncing?', message: S.pendingOps + ' change(s) are still being committed. Refreshing now may show stale data.', confirmLabel: 'Refresh Anyway', danger: false });
      if (!ok) return;
    }
    const keepPath = S.nav.path;
    const keepSel = [...S.sel];
    renderEmptyState('loading', 'Refreshing…');
    try {
      const ctx = ctxNow();
      const data = await API.getTreeRecursive(ctx);
      S.model = data.tree && data.tree.length ? RepoTree.build(data.tree, data.sha) : new RepoTree(data.sha);
      // restore folder last-commit caches where possible is unnecessary — they refresh lazily.
      const target = S.model.has(keepPath) ? keepPath : '';
      navResetScroll = false;
      markAll();
      navTo(target, { push: false });
      const restored = keepSel.filter((p) => S.model.has(p));
      if (restored.length) { S.sel = new Set(restored); updateSelClasses(); markDirty('status'); }
      E.empty.classList.remove('ghf-on');
      toast('success', 'Repository refreshed');
    } catch (e) {
      E.empty.classList.remove('ghf-on');
      markAll();
      toast('error', 'Could not refresh', e.message);
      if (e.status === 401) openSettings();
    }
  }

  /* ══════════════════════════ §13 DRAG & DROP / UPLOAD / DOWNLOAD ══════════════════════════ */

  /* ── Internal drag (pointer-based, rAF-driven, 60fps) ── */
  const DnD = {
    cand: null,       // {x, y, paths, pointerId} — pending, not yet started
    drag: null,       // active drag state
    ghost: null,

    maybeStart(e, paths) {
      if (e.button !== 0 || !paths || !paths.length) return;
      if (e.target.closest('input, textarea, button, select')) return;
      if (renameState) commitRename();
      this.cand = { x: e.clientX, y: e.clientY, paths, pointerId: e.pointerId, src: e.target };
    },
    onMove(e) {
      if (this.drag) {
        this.drag.x = e.clientX; this.drag.y = e.clientY;
        e.preventDefault();
        return;
      }
      if (!this.cand || e.pointerId !== this.cand.pointerId) return;
      const dx = e.clientX - this.cand.x, dy = e.clientY - this.cand.y;
      if (dx * dx + dy * dy > 36) this._start(e);
    },
    _start(e) {
      const paths = this.cand.paths;
      this.cand = null;
      // Dragging an unselected item drags just that item.
      const dragPaths = paths.length === 1 && !S.sel.has(paths[0]) ? paths : [...S.sel];
      if (!dragPaths.length) dragPaths.push(...paths);
      const nodes = dragPaths.map((p) => S.model && S.model.get(p)).filter(Boolean);
      if (!nodes.length) return;
      if (nodes.some((n) => n.pending)) return; // can't drag while syncing
      this.drag = { x: e.clientX, y: e.clientY, paths: nodes.map((n) => n.path), nodes, target: null, valid: false, raf: 0 };
      // Build the ghost chip.
      const first = nodes[0];
      const label = nodes.length === 1 ? first.name : first.name + ' + ' + (nodes.length - 1) + ' more';
      this.ghost = el('div', { class: 'ghf-ghost ghf-on' },
        fileIconEl(first),
        el('span', { class: 'ghf-ell', style: { maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
        nodes.length > 1 ? el('span', { class: 'ghf-count' }, String(nodes.length)) : null);
      E.root.append(this.ghost);
      E.root.classList.add('ghf-dragging');
      const loop = () => {
        if (!this.drag) return;
        this._positionGhost();
        this._hitTest();
        this._autoScroll();
        this.drag.raf = requestAnimationFrame(loop);
      };
      this.drag.raf = requestAnimationFrame(loop);
    },
    _positionGhost() {
      if (!this.ghost || !this.drag) return;
      this.ghost.style.transform = 'translate3d(' + (this.drag.x + 12) + 'px,' + (this.drag.y + 14) + 'px,0)';
    },
    _resolveTarget() {
      const g = this.ghost;
      if (g) g.style.display = 'none';
      const under = document.elementFromPoint(this.drag.x, this.drag.y);
      if (g) g.style.display = '';
      const holder = under && (under.closest ? under.closest('[data-drop]') : null);
      if (!holder) return null;
      let p = holder.dataset.drop;
      if (p === undefined) return null;
      if (p === '') p = S.nav.path || '';           // main background / root crumb
      const node = S.model && S.model.get(p);
      if (!node || node.type !== 'dir') return null;
      return node;
    },
    _hitTest() {
      const target = this._resolveTarget();
      // Clear previous highlight.
      qsa(E.root, '.ghf-drop-hint, .ghf-drop-bad').forEach((n) => n.classList.remove('ghf-drop-hint', 'ghf-drop-bad'));
      if (!target) { this.drag.target = null; return; }
      const valid = !this.drag.paths.some((p) => p === target.path || isDescendant(p, target.path));
      this.drag.target = target;
      this.drag.valid = valid;
      const row = this._rowElForPath(target.path);
      if (row) row.classList.add(valid ? 'ghf-drop-hint' : 'ghf-drop-bad');
    },
    _rowElForPath(path) {
      const esc = cssEscape(path);
      return qs(E.root, '.ghf-row[data-drop="' + esc + '"], .ghf-cell[data-drop="' + esc + '"], .ghf-srow[data-drop="' + esc + '"], .ghf-crumb[data-drop="' + esc + '"], .ghf-main-scroll[data-drop="' + esc + '"]')
        || (path === S.nav.path ? E.mainScroll : null);
    },
    _autoScroll() {
      for (const c of [E.mainScroll, E.sideScroll]) {
        if (!c) continue;
        const r = c.getBoundingClientRect();
        const y = this.drag.y;
        const EDGE = 34, STEP = 11;
        if (y > r.top - EDGE && y < r.top + EDGE) c.scrollTop -= STEP;
        else if (y > r.bottom - EDGE && y < r.bottom + EDGE) c.scrollTop += STEP;
      }
    },
    onUp() {
      if (this.cand) { this.cand = null; return; }   // plain click, no drag
      if (!this.drag) return;
      const d = this.drag;
      cancelAnimationFrame(d.raf);
      const target = d.valid ? d.target : null;
      this._cleanup();
      if (target) {
        // Same-folder drops are no-ops.
        const moves = d.nodes.filter((n) => pathDir(n.path) !== target.path);
        if (moves.length) ops.moveNodes(moves, target.path);
        else toast('info', 'Already in that folder');
      }
      // Swallow the click that follows the drag.
      suppressNextClick();
    },
    cancel() {
      if (!this.drag) { this.cand = null; return; }
      cancelAnimationFrame(this.drag.raf);
      this._cleanup();
      suppressNextClick();
    },
    _cleanup() {
      this.drag = null;
      this.cand = null;
      if (this.ghost) { this.ghost.remove(); this.ghost = null; }
      E.root.classList.remove('ghf-dragging');
      qsa(E.root, '.ghf-drop-hint, .ghf-drop-bad').forEach((n) => n.classList.remove('ghf-drop-hint', 'ghf-drop-bad'));
    },
  };
  let _suppressClick = 0;
  function suppressNextClick() { _suppressClick = Date.now(); }
  const clickSuppressed = () => Date.now() - _suppressClick < 250;

  /* ── External file uploads (HTML5 DnD) ────────────────── */
  const ExtDnD = {
    depth: 0, dir: null,
    bind() {
      E.win.addEventListener('dragenter', (e) => {
        if (!this._hasFiles(e)) return;
        e.preventDefault();
        this.depth++;
        this._update(e);
      });
      E.win.addEventListener('dragover', (e) => {
        if (!this._hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        this._update(e);
      });
      E.win.addEventListener('dragleave', (e) => {
        if (!this._hasFiles(e)) return;
        this.depth = Math.max(0, this.depth - 1);
        if (this.depth === 0) this._hide();
      });
      E.win.addEventListener('drop', async (e) => {
        if (!this._hasFiles(e)) return;
        e.preventDefault();
        const dir = this.dir;
        this.depth = 0;
        this._hide();
        const files = await collectDroppedFiles(e.dataTransfer);
        if (files.length) ops.uploadFiles(dir, files);
      });
    },
    _hasFiles(e) {
      return e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    },
    _update(e) {
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const holder = under && under.closest ? under.closest('[data-drop]') : null;
      let dir = S.nav.path || '';
      if (holder && holder.dataset.drop) dir = holder.dataset.drop;
      this.dir = dir;
      const node = S.model && S.model.get(dir);
      const label = node && node.type === 'dir' ? (pathBase(dir) || 'repository root') : (pathBase(S.nav.path) || 'repository root');
      E.dropChip.textContent = 'Drop to upload into “' + label + '”';
      E.dropChip.classList.add('ghf-on');
      E.dropVeil.classList.add('ghf-on');
    },
    _hide() {
      E.dropChip.classList.remove('ghf-on');
      E.dropVeil.classList.remove('ghf-on');
    },
  };

  /** Read dropped items (incl. directories, recursively). */
  async function collectDroppedFiles(dt) {
    const out = [];
    const entries = [];
    if (dt.items && dt.items.length) {
      for (const it of dt.items) {
        const entry = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
        if (entry) entries.push(entry);
      }
    }
    if (entries.length) {
      const walk = async (entry, prefix) => {
        if (entry.isFile) {
          const file = await new Promise((res, rej) => entry.file(res, rej));
          out.push(await toUploadItem(file, prefix + file.name));
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          // readEntries returns ≤100 entries per call — loop until empty.
          while (true) {
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
            if (!batch.length) break;
            for (const e of batch) await walk(e, prefix + entry.name + '/');
          }
        }
      };
      for (const entry of entries) await walk(entry, '');
      return out;
    }
    // Fallback: plain file list.
    for (const f of (dt.files || [])) out.push(await toUploadItem(f, f.name));
    return out;
  }

  /** File → {name, size, relPath, b64}. */
  async function toUploadItem(file, relPath) {
    const buf = await file.arrayBuffer();
    return { name: file.name, size: file.size, relPath: relPath || file.name, b64: bytesToB64(new Uint8Array(buf)) };
  }

  /** File picker (toolbar / context menu). directory=true → webkitdirectory. */
  function pickFiles(dirPath, directory) {
    const input = el('input', { type: 'file', multiple: '', style: 'position:fixed;left:-999px;top:0;opacity:0' });
    if (directory) input.setAttribute('webkitdirectory', '');
    input.addEventListener('change', async () => {
      const files = [];
      for (const f of input.files || []) {
        files.push(await toUploadItem(f, f.webkitRelativePath || f.name));
      }
      input.remove();
      if (files.length) ops.uploadFiles(dirPath != null ? dirPath : S.nav.path || '', files);
    });
    E.root.append(input);
    input.click();
  }

  /* ── Downloads ────────────────────────────────────────── */
  async function fetchBlobBytes(node) {
    const ctx = ctxNow();
    const data = await API.getBlob(ctx, node.sha);
    return b64ToBytes((data.content || '').replace(/\s+/g, ''));
  }
  async function downloadFile(node) {
    if (!node || node.type !== 'file') return;
    const h = toast('info', 'Downloading ' + node.name + '…');
    try {
      const bytes = await fetchBlobBytes(node);
      saveBlob(new Blob([bytes], { type: MIME[pathExt(node.name)] || 'application/octet-stream' }), node.name);
      h.done('success', 'Downloaded ' + node.name);
    } catch (e) {
      h.done('error', 'Download failed', e.message);
    }
  }
  /** Download files+folders as one zip (built client-side, STORE method). */
  async function downloadZip(nodes, zipName) {
    if (!nodes || !nodes.length) return;
    const files = [];
    for (const n of nodes) {
      if (n.type === 'file') files.push(n);
      else files.push(...S.model.filesUnder(n));
    }
    if (!files.length) { toast('info', 'Nothing to download', 'The selection contains no files.'); return; }
    const total = files.reduce((s, f) => s + (f.size || 0), 0);
    if (files.length > CFG.ZIP_FILE_CAP || total > CFG.ZIP_BYTE_CAP) {
      const ok = await confirmDialog({
        title: 'Download a large archive?',
        message: 'The selection contains ' + formatCount(files.length) + ' files (' + formatBytes(total) + '). This needs one API request per file and may take a while.',
        confirmLabel: 'Download Anyway', danger: false,
      });
      if (!ok) return;
    }
    const h = Toast.show('info', 'Zipping ' + formatCount(files.length) + ' files…', '', { noBar: true });
    try {
      // Directory entries for a well-structured zip (all ancestors of files).
      const dirSet = new Set();
      for (const f of files) {
        const segs = pathSegments(pathDir(f.path));
        for (let i = 1; i <= segs.length; i++) dirSet.add(segs.slice(0, i).join('/') + '/');
      }
      const entries = [...dirSet].sort().map((d) => ({ name: d, data: new Uint8Array(0) }));
      // Fetch file blobs with bounded concurrency.
      let done = 0;
      const queue = [...files];
      const worker = async () => {
        while (queue.length) {
          const f = queue.shift();
          const bytes = await fetchBlobBytes(f);
          entries.push({ name: f.path, data: bytes });
          done++;
          h.update('Zipping — ' + done + ' of ' + files.length + ' files…');
        }
      };
      await Promise.all(Array.from({ length: Math.min(CFG.FETCH_CONCURRENCY, files.length) }, worker));
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const chunks = buildZip(entries);
      saveBlob(new Blob(chunks, { type: 'application/zip' }), zipName || 'archive.zip');
      h.done('success', 'Downloaded ' + zipName);
    } catch (e) {
      h.done('error', 'Zip download failed', e.message);
    }
  }
  function downloadRepoZip() {
    if (!S.repo) return;
    const a = el('a', {
      href: 'https://github.com/' + encodeURIComponent(S.repo.owner) + '/' + encodeURIComponent(S.repo.name) +
        '/archive/refs/heads/' + encodePath(S.repo.branch) + '.zip',
    });
    document.body.append(a);
    a.click();
    a.remove();
    toast('success', 'Downloading repository archive');
  }

  /* ── Copy link / path ─────────────────────────────────── */
  async function copyLinks(nodes) {
    if (!nodes.length) return;
    const links = nodes.map((n) => (n.type === 'dir' ? githubTreeUrl(n.path) : githubFileUrl(n.path)));
    const ok = await copyText(links.join('\n'));
    if (ok) toast('success', nodes.length === 1 ? 'Link copied' : links.length + ' links copied',
      nodes.length === 1 ? links[0] : '');
    else toast('error', 'Could not copy', 'Clipboard access was blocked by the browser.');
  }
  async function copyPaths(nodes) {
    if (!nodes.length) return;
    const ok = await copyText(nodes.map((n) => n.path).join('\n'));
    if (ok) toast('success', nodes.length === 1 ? 'Path copied' : nodes.length + ' paths copied');
    else toast('error', 'Could not copy', 'Clipboard access was blocked by the browser.');
  }

  /* ══════════════════════════ §14 CONTEXT MENUS ══════════════════════════ */

  /** Menu for a single selected item (or each item when several are picked). */
  function itemMenuItems(nodes) {
    const node = nodes[0];
    const isDir = node.type === 'dir';
    const multi = nodes.length > 1;
    const fav = S.favorites.has(node.path);
    const items = [];
    if (!multi) {
      items.push(
        { label: isDir ? 'Open' : 'Preview', icon: isDir ? 'folder' : 'eye', key: 'Enter', onClick: () => openNode(node) },
        { label: 'View on GitHub', icon: 'extlink', onClick: () => window.open(isDir ? githubTreeUrl(node.path) : githubFileUrl(node.path), '_blank') },
      );
      if (!isDir && isTextKind(node.name)) {
        items.push({ label: 'Edit', icon: 'pencil', key: 'Space', onClick: () => openEditor(node, false) });
      }
      if (!isDir) {
        items.push({ label: 'Download', icon: 'download', onClick: () => downloadFile(node) });
      }
      items.push({ sep: true });
      items.push({ label: 'Rename…', icon: 'pencil', key: 'F2', onClick: () => startInlineRename(node.path) });
    }
    if (!multi) {
      items.push({ label: 'Duplicate', icon: 'duplicate', key: MOD + 'D', onClick: () => ops.duplicateNodes([node]) });
    } else {
      items.push({ label: 'Duplicate ' + nodes.length + ' Items', icon: 'duplicate', onClick: () => ops.duplicateNodes(nodes) });
    }
    items.push({ label: multi ? 'Move ' + nodes.length + ' Items…' : 'Move to…', icon: 'move', onClick: () => openMovePicker(nodes) });
    items.push({ sep: true });
    items.push({ label: 'Cut', icon: 'scissors', key: MOD + 'X', onClick: () => setClipboard('cut', nodes) });
    items.push({ label: 'Copy', icon: 'copy', key: MOD + 'C', onClick: () => setClipboard('copy', nodes) });
    if (!multi) {
      items.push({ sep: true });
      items.push({ label: 'Copy GitHub Link', icon: 'link', onClick: () => copyLinks([node]) });
      items.push({ label: 'Copy Path', icon: 'copypath', onClick: () => copyPaths([node]) });
      items.push({ label: fav ? 'Remove from Favorites' : 'Add to Favorites', icon: fav ? 'starFill' : 'star', onClick: () => toggleFavorite(node.path) });
      if (isDir) {
        items.push({ sep: true });
        items.push({ label: 'Download as ZIP', icon: 'archive', onClick: () => downloadZip([node], node.name + '.zip') });
        items.push({ label: 'New File in “' + node.name + '”', icon: 'docPlus', onClick: () => newFilePrompt(node.path) });
        items.push({ label: 'New Folder in “' + node.name + '”', icon: 'folderPlus', onClick: () => newFolderPrompt(node.path) });
        items.push({ label: 'Upload to “' + node.name + '”', icon: 'upload', onClick: () => pickFiles(node.path, false) });
      }
    } else {
      items.push({ label: 'Copy ' + nodes.length + ' Links', icon: 'link', onClick: () => copyLinks(nodes) });
      items.push({ label: 'Download as ZIP', icon: 'archive', onClick: () => downloadZip(nodes, 'selection.zip') });
    }
    items.push({ sep: true });
    items.push({
      label: multi ? 'Delete ' + nodes.length + ' Items' : 'Delete', icon: 'trash', key: '⌫', danger: true,
      onClick: () => ops.deleteNodes(nodes),
    });
    return items;
  }

  /** Menu for empty space in the main pane (or a folder background). */
  function emptyMenuItems(dirPath) {
    const dir = dirPath != null ? dirPath : S.nav.path || '';
    const items = [
      { label: 'New File', icon: 'docPlus', onClick: () => newFilePrompt(dir) },
      { label: 'New Folder', icon: 'folderPlus', onClick: () => newFolderPrompt(dir) },
      { label: 'Upload Files…', icon: 'upload', onClick: () => pickFiles(dir, false) },
      { label: 'Upload Folder…', icon: 'externalDrive', onClick: () => pickFiles(dir, true) },
    ];
    if (S.clip && S.clip.paths.length) {
      items.push({ sep: true });
      items.push({
        label: 'Paste ' + S.clip.paths.length + ' Item' + (S.clip.paths.length > 1 ? 's' : '') + (S.clip.mode === 'cut' ? ' (move)' : ' (copy)'),
        icon: 'paste', key: MOD + 'V', onClick: () => ops.paste(),
      });
    }
    items.push({ sep: true });
    items.push({ label: 'Select All', icon: 'check', key: MOD + 'A', onClick: () => selectAll() });
    items.push({ label: 'Refresh', icon: 'refresh', onClick: () => refreshTree() });
    items.push({ sep: true });
    items.push({
      label: 'View', icon: S.view.mode === 'list' ? 'list' : 'grid',
      submenu: [
        { label: 'as List', icon: 'list', checked: S.view.mode === 'list', onClick: () => setViewMode('list') },
        { label: 'as Gallery', icon: 'grid', checked: S.view.mode === 'grid', onClick: () => setViewMode('grid') },
      ],
    });
    items.push({
      label: 'Sort By', icon: 'hash',
      submenu: [
        { label: 'Name', checked: S.view.sortKey === 'name', onClick: () => setSort('name', 1) },
        { label: 'Size', checked: S.view.sortKey === 'size', onClick: () => setSort('size', 1) },
        { label: 'Kind', checked: S.view.sortKey === 'kind', onClick: () => setSort('kind', 1) },
      ],
    });
    if (!dir) items.push({ label: 'Download repository (.zip)', icon: 'archive', onClick: () => downloadRepoZip() });
    return items;
  }

  /** Sidebar favorite context menu. */
  function favoriteMenuItems(node) {
    return [
      { label: 'Open', icon: node.type === 'dir' ? 'folder' : 'eye', onClick: () => openNode(node) },
      { label: 'Reveal in Sidebar', icon: 'repo', onClick: () => { if (node.type === 'dir') navTo(node.path); else { navTo(pathDir(node.path)); setSel([node.path]); } } },
      { sep: true },
      { label: 'Remove from Favorites', icon: 'starFill', onClick: () => toggleFavorite(node.path) },
    ];
  }

  /** Toolbar “+” menu. */
  function openPlusMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const dir = targetDirForNew();
    const label = pathBase(dir) || 'repository root';
    Menu.open(r.left, r.bottom + 6, [
      { label: 'New File in “' + label + '”', icon: 'docPlus', onClick: () => newFilePrompt(dir) },
      { label: 'New Folder in “' + label + '”', icon: 'folderPlus', onClick: () => newFolderPrompt(dir) },
      { sep: true },
      { label: 'Upload Files…', icon: 'upload', onClick: () => pickFiles(dir, false) },
      { label: 'Upload Folder…', icon: 'externalDrive', onClick: () => pickFiles(dir, true) },
    ]);
  }

  /* ── Favorites / clipboard helpers ────────────────────── */
  function toggleFavorite(path) {
    if (!S.repoKey) return;
    if (S.favorites.has(path)) {
      S.favorites.delete(path);
      toast('info', 'Removed from Favorites');
    } else {
      S.favorites.add(path);
      toast('success', 'Added to Favorites');
    }
    store.set('fav:' + S.repoKey, [...S.favorites]);
    renderFavorites();
  }
  function setClipboard(mode, nodes) {
    if (!nodes || !nodes.length) return;
    const pend = nodes.find((n) => n.pending);
    if (pend) { toast('info', 'Still syncing', 'Wait for “' + pend.name + '” to finish first.'); return; }
    S.clip = { mode, paths: nodes.map((n) => n.path) };
    updateSelClasses();
    markDirty('status');
    toast('info', mode === 'cut' ? 'Cut ' + nodes.length + ' item' + (nodes.length > 1 ? 's' : '') : 'Copied ' + nodes.length + ' item' + (nodes.length > 1 ? 's' : ''),
      mode === 'cut' ? 'Paste (⌘V / Ctrl+V) moves them into the current folder.' : 'Paste (⌘V / Ctrl+V) duplicates them into the current folder.');
  }

  /** Open (dblclick / Enter): folder → navigate, file → preview. */
  function openNode(node) {
    if (!node) return;
    if (node.type === 'dir') { navTo(node.path); }
    else openPreview(node);
  }

  /* ══════════════════════════ §15 SHEETS: SETTINGS / EDITOR / PREVIEW / MOVE ══════════════════════════ */

  /* ── Settings (token management) ──────────────────────── */
  let settingsModal = null;
  function openSettings(onboarding) {
    if (settingsModal) return;
    const body = el('div');
    const render = () => {
      body.textContent = '';
      if (S.token && S.user) {
        /* Connected state */
        const avatar = el('img', { src: S.user.avatar_url || '', alt: '' });
        avatar.addEventListener('error', () => { avatar.style.display = 'none'; });
        body.append(
          el('div', { class: 'ghf-setsec' }, 'Account'),
          el('div', { class: 'ghf-account' },
            avatar,
            el('div', null,
              el('div', { class: 'ghf-a-name' }, 'Connected as ' + S.user.login),
              el('div', { class: 'ghf-a-sub' }, 'Token ending in …' + S.token.slice(-4) + ' · stored only in Tampermonkey storage')),
            el('div', { class: 'ghf-a-btns' },
              el('button', { class: 'ghf-btn', onclick: () => { renderTokenForm(); } }, 'Change token'),
              el('button', { class: 'ghf-btn ghf-danger', onclick: async () => {
                const ok = await confirmDialog({ title: 'Disconnect?', message: 'This removes your token from Tampermonkey storage. The Finder will keep working read-only until you add a new one — actually, it needs a token for everything. Reconnect any time.', confirmLabel: 'Disconnect' });
                if (!ok) return;
                S.token = ''; S.user = null;
                store.del('token'); store.del('user');
                toast('success', 'Disconnected', 'Your token was removed from local storage.');
                closeSettings();
                if (S.win.open) { renderEmptyState('needs-token'); openSettings(true); }
              } }, 'Disconnect'))));
      } else {
        renderTokenForm(true);
      }
      body.append(
        el('div', { class: 'ghf-setsec' }, 'Rate limit'),
        el('div', { class: 'ghf-hint' },
          formatCount(Math.max(0, S.rate.remaining)) + ' of ' + formatCount(S.rate.limit) + ' requests remaining this hour' +
          (S.rate.reset ? ' · resets ' + relTime(S.rate.reset < 1e12 ? S.rate.reset * 1000 : S.rate.reset) : '') +
          '. Every file operation uses a handful of requests; large zips use one per file.'),
        el('div', { class: 'ghf-setsec' }, 'Keyboard shortcuts'),
        el('div', { class: 'ghf-keys' },
          el('kbd', null, 'Enter'), el('span', null, 'Open / preview'), el('kbd', null, 'F2'), el('span', null, 'Rename'),
          el('kbd', null, 'Space'), el('span', null, 'Quick preview'), el('kbd', null, '⌫'), el('span', null, 'Delete'),
          el('kbd', null, MOD + 'C'), el('span', null, 'Copy'), el('kbd', null, MOD + 'X'), el('span', null, 'Cut'),
          el('kbd', null, MOD + 'V'), el('span', null, 'Paste'), el('kbd', null, MOD + 'D'), el('span', null, 'Duplicate'),
          el('kbd', null, MOD + 'A'), el('span', null, 'Select all'), el('kbd', null, MOD + '[ / ]'), el('span', null, 'Back / forward'),
          el('kbd', null, 'Esc'), el('span', null, 'Close / clear'), el('kbd', null, 'Alt+Shift+F'), el('span', null, 'Toggle Finder')),
        el('div', { class: 'ghf-setsec' }, 'About'),
        el('div', { class: 'ghf-hint' }, 'GitHub Finder v1.0 — a macOS Finder–style overlay for GitHub repositories. All requests go directly from your browser to api.github.com with your token; nothing is sent anywhere else.'));
    };
    const renderTokenForm = () => {
      body.textContent = '';
      const input = el('input', {
        class: 'ghf-input', type: 'password', placeholder: 'ghp_…', autocomplete: 'off', spellcheck: 'false',
        'aria-label': 'GitHub Personal Access Token',
      });
      const status = el('div', { class: 'ghf-status-line' });
      const eye = el('button', { class: 'ghf-eye', title: 'Show / hide token', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; } });
      eye.innerHTML = icon('eye', 15);
      const saveBtn = el('button', { class: 'ghf-btn ghf-primary ghf-big' }, 'Save & Connect');
      const form = el('div', null,
        el('div', { class: 'ghf-setsec' }, 'GitHub Personal Access Token'),
        el('label', { class: 'ghf-field-label', for: '' }, 'GitHub Personal Access Token'),
        el('div', { class: 'ghf-token-row' }, input, eye),
        el('div', { class: 'ghf-hint', style: { marginTop: '8px' } },
          'Create a token at ', el('a', { href: 'https://github.com/settings/tokens', target: '_blank', rel: 'noreferrer' }, 'github.com/settings/tokens'),
          ' — the ', el('b', null, 'repo'), ' scope is required to browse and edit private repositories (',
          el('b', null, 'public_repo'), ' is enough for public ones). Fine-grained tokens need “Contents: Read and write”.'),
        status,
        el('div', { style: { display: 'flex', gap: '9px', marginTop: '6px', justifyContent: 'flex-end' } }, saveBtn));
      if (onboarding) {
        body.append(el('div', { class: 'ghf-hint', style: { marginBottom: '4px' } },
          'Welcome to GitHub Finder 👋 — paste a Personal Access Token to browse and manage repositories like a Finder window.'));
      }
      body.append(form);
      const doSave = async () => {
        const tok = input.value.trim();
        if (!tok) {
          status.className = 'ghf-status-line ghf-err';
          status.textContent = 'Paste a token first.';
          return;
        }
        saveBtn.classList.add('ghf-loading-btn');
        saveBtn.textContent = 'Checking…';
        status.className = 'ghf-status-line';
        status.textContent = 'Validating token…';
        try {
          const user = await API.getUser(tok);
          S.token = tok;
          S.user = { login: user.login, avatar_url: user.avatar_url, name: user.name || '' };
          store.set('token', tok);
          store.set('user', S.user);
          status.className = 'ghf-status-line ghf-ok';
          status.append(iconEl('check'), 'Connected as ' + user.login);
          toast('success', 'Connected as ' + user.login);
          setTimeout(() => {
            closeSettings();
            if (S.win.open) {
              const r = parseRepo(location);
              if (r) loadRepo(r);
            }
          }, 650);
        } catch (e) {
          saveBtn.classList.remove('ghf-loading-btn');
          saveBtn.textContent = 'Save & Connect';
          status.className = 'ghf-status-line ghf-err';
          status.append(iconEl('warning'), e.message || 'Could not validate the token.');
          if (e.status !== 401 && e.status !== 403) status.append(' — ' + (e.message || ''));
        }
      };
      saveBtn.addEventListener('click', doSave);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
      setTimeout(() => input.focus({ preventScroll: true }), 50);
    };
    render();
    settingsModal = modal({
      title: onboarding ? 'Welcome to GitHub Finder' : 'Settings',
      icon: 'gear', body, width: 'narrow',
      buttons: [{ label: 'Done', primary: true }],
    });
    const origClose = settingsModal.close.bind(settingsModal);
    settingsModal.close = () => { settingsModal = null; origClose(); };
  }
  function closeSettings() { if (settingsModal) settingsModal.close(); }

  /* ── Generic in-window sheet ──────────────────────────── */
  function openSheet({ head, body, foot, paths, onEsc }) {
    E.sheets.textContent = '';
    E.sheets.classList.add('ghf-on');
    const bg = el('div', { class: 'ghf-sheet-bg' });
    const sheet = el('div', { class: 'ghf-sheet', role: 'dialog' });
    if (head) sheet.append(head);
    if (body) sheet.append(body);
    if (foot) sheet.append(foot);
    E.sheets.append(bg, sheet);
    let closed = false;
    const rec = { el: sheet, paths, onEsc };
    rec.close = () => {
      if (closed) return;
      closed = true;
      const i = Layers.indexOf(rec);
      if (i >= 0) Layers.splice(i, 1);
      const j = sheetRegistry.indexOf(rec);
      if (j >= 0) sheetRegistry.splice(j, 1);
      E.sheets.classList.remove('ghf-on');
      E.sheets.textContent = '';
    };
    Layers.push(rec);
    sheetRegistry.push(rec);
    bg.addEventListener('pointerdown', () => rec.close());
    return rec;
  }
  function sheetHead(node, extra) {
    const x = el('button', { class: 'ghf-sheet-x', title: 'Close', 'aria-label': 'Close', onclick: () => { closeTopLayer(); } });
    x.innerHTML = icon('close', 13);
    return el('div', { class: 'ghf-sheet-head' },
      fileIconEl(node),
      el('div', { style: { flex: '1', minWidth: '0' } },
        el('div', { class: 'ghf-sheet-title' }, node.name),
        el('div', { class: 'ghf-sheet-path' }, (node.path ? node.path : 'repository root'))),
      extra || null,
      x);
  }
  function closeTopLayer() {
    const t = topLayer();
    if (t && t.close) t.close();
  }

  /* ── Code / text editor sheet ─────────────────────────── */
  function openEditor(node, previewMode) {
    if (node.type === 'dir') return;
    if (node.size > CFG.EDIT_MAX && !previewMode) {
      toast('error', 'File too large to edit', '“' + node.name + '” is ' + formatBytes(node.size) + ' — the in-app editor handles files up to ' + formatBytes(CFG.EDIT_MAX) + '.');
      return;
    }
    const lang = langForFile(node.name);
    const h = toast('info', 'Opening ' + node.name + '…');
    fetchBlobBytes(node).then((bytes) => {
      h.done('success', 'Opened ' + node.name);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (e) { toast('error', 'Not a text file', '“' + node.name + '” contains binary data.'); return; }
      buildEditorSheet(node, text, lang, !!previewMode);
    }).catch((e) => {
      h.done('error', 'Could not open file', e.message);
    });
  }
  function buildEditorSheet(node, initialText, lang, previewMode) {
    let text = initialText;
    let dirty = false;
    let mode = previewMode ? 'preview' : 'edit';

    const ta = el('textarea', { class: 'ghf-ed-ta', spellcheck: 'false', wrap: 'off', 'aria-label': 'File content' });
    ta.value = text;
    if (previewMode) ta.setAttribute('readonly', '');
    const hl = el('pre', { class: 'ghf-ed-hl', 'aria-hidden': 'true' });
    const gut = el('div', { class: 'ghf-ed-gut' });
    const meta = el('span', { class: 'ghf-meta' });
    const saveBtn = el('button', { class: 'ghf-btn ghf-primary', onclick: () => save() }, 'Save');
    const editBtn = el('button', { class: 'ghf-btn', onclick: () => switchToEdit() }, 'Edit');
    const dlBtn = el('button', { class: 'ghf-btn', onclick: () => downloadFile(node) }, 'Download');
    const langBadge = el('span', { class: 'ghf-langbadge' }, lang ? lang.toUpperCase() : 'TXT');

    const paint = () => {
      const useHL = lang && text.length <= CFG.HL_MAX;
      hl.innerHTML = useHL ? highlightCode(text, lang) + '\n' : escapeHtml(text) + '\n';
      hl.style.display = useHL ? '' : 'none';
      const lines = text.split('\n').length;
      gut.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
      meta.textContent = formatCount(lines) + ' lines · ' + formatCount(text.length) + ' chars' + (dirty ? ' · unsaved changes' : '');
      saveBtn.style.display = mode === 'edit' ? '' : 'none';
      editBtn.style.display = mode === 'preview' ? '' : 'none';
      dlBtn.style.display = mode === 'preview' ? '' : 'none';
    };
    let raf = 0;
    const schedulePaint = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); };
    ta.addEventListener('input', () => {
      text = ta.value;
      dirty = true;
      schedulePaint();
    });
    ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; gut.scrollTop = ta.scrollTop; });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Tab' && mode === 'edit') {
        e.preventDefault();
        if (!document.execCommand || !document.execCommand('insertText', false, '  ')) {
          const s = ta.selectionStart, epos = ta.selectionEnd;
          ta.setRangeText('  ', s, epos, 'end');
        }
        text = ta.value; dirty = true; schedulePaint();
      } else if (e.key === 'Escape') { e.preventDefault(); maybeClose(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (mode === 'edit') save(); }
    });

    const switchToEdit = () => {
      mode = 'edit';
      ta.removeAttribute('readonly');
      paint();
      setTimeout(() => ta.focus(), 30);
    };
    const save = () => {
      if (mode !== 'edit') return;
      const t = ta.value;
      saveBtn.classList.add('ghf-loading-btn');
      saveBtn.textContent = 'Saving…';
      ops.editContent(node, t);
      // Close once the optimistic commit settles (watch the pending flag).
      const poll = setInterval(() => {
        const n = S.model && S.model.get(node.path);
        if (!n) { clearInterval(poll); rec.close(); return; }
        if (!n.pending) {
          clearInterval(poll);
          saveBtn.classList.remove('ghf-loading-btn');
          saveBtn.textContent = 'Save';
          if (n.size === byteLength(t)) { // commit succeeded (or unchanged)
            dirty = false;
            text = t;
            paint();
            rec.close();
          } else { // server rejected → rollback happened, keep editing
            dirty = true;
            paint();
          }
        }
      }, 120);
      setTimeout(() => clearInterval(poll), 30000);
    };
    const maybeClose = async () => {
      if (dirty && mode === 'edit') {
        const ok = await confirmDialog({ title: 'Unsaved changes', message: '“' + node.name + '” has unsaved changes.', confirmLabel: 'Discard Changes' });
        if (!ok) return;
      }
      rec.close();
    };

    const head = sheetHead(node, langBadge);
    const body = el('div', { class: 'ghf-ed' }, gut, el('div', { class: 'ghf-ed-wrap' }, hl, ta));
    const foot = el('div', { class: 'ghf-sheet-foot' }, meta, dlBtn, editBtn, saveBtn);
    const rec = openSheet({ head, body, foot, paths: [node.path], onEsc: maybeClose });
    paint();
    setTimeout(() => ta.focus({ preventScroll: true }), 60);
  }

  /* ── Preview sheet (images / text / pdf / metadata) ───── */
  function openPreview(node) {
    if (node.type === 'dir') { navTo(node.path); return; }
    const ext = pathExt(node.name);
    const ki = kindInfo(node.name, false);
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif', 'bmp'].includes(ext);
    const isPdf = ext === 'pdf';
    const isText = isTextKind(node.name) && node.size <= CFG.EDIT_MAX;

    const stage = el('div', { class: 'ghf-pv-stage' + (isImage ? ' ghf-checker' : '') },
      el('span', { class: 'ghf-spin ghf-big' }));
    const metaBox = el('div', { class: 'ghf-pv-meta' });
    const metaRow = (k, v) => el('div', { class: 'ghf-mk' }, el('b', null, k), el('span', { class: 'ghf-mv' }, v));
    const editBtn = el('button', { class: 'ghf-btn', onclick: () => { rec.close(); openEditor(node, false); } }, 'Edit');
    const dlBtn = el('button', { class: 'ghf-btn', onclick: () => downloadFile(node) }, 'Download');

    const fillMeta = () => {
      metaBox.textContent = '';
      metaBox.append(
        el('div', { class: 'ghf-setsec', style: { marginTop: '0' } }, 'Info'),
        metaRow('Name', node.name),
        metaRow('Path', node.path),
        metaRow('Kind', ki.label),
        metaRow('Size', formatBytes(node.size)),
        (() => {
          const span = el('span', { class: 'ghf-mv' });
          const sha = el('span', { class: 'ghf-shacopy', title: 'Copy full SHA', onclick: async () => { await copyText(node.sha || ''); toast('success', 'SHA copied'); } }, (node.sha || '').slice(0, 10) + '…');
          span.append(sha);
          return el('div', { class: 'ghf-mk' }, el('b', null, 'SHA'), span);
        })(),
        metaRow('Branch', S.repo ? S.repo.branch : ''));
      // Last commit touching this file (one cheap request).
      API.lastCommitFor(ctxNow(), node.path).then((arr) => {
        const c = arr && arr[0];
        if (!c || !metaBox.isConnected) return;
        const when = c.commit && c.commit.author ? relTime(Date.parse(c.commit.author.date)) : '';
        metaBox.append(metaRow('Modified', when + (c.commit && c.commit.author ? ' by ' + (c.commit.author.name || c.commit.author.login || '') : '')),
          el('div', { class: 'ghf-mk' }, el('b', null, 'Commit'), el('span', { class: 'ghf-mv' }, (c.commit ? c.commit.message : '').split('\n')[0])));
      }).catch(() => { /* silent */ });
    };
    fillMeta();

    const foot = el('div', { class: 'ghf-sheet-foot' },
      el('span', { class: 'ghf-meta' }, ki.label + ' · ' + formatBytes(node.size)),
      dlBtn, isText ? editBtn : null);
    const rec = openSheet({
      head: sheetHead(node), body: el('div', { style: { display: 'flex', flex: '1', minHeight: '0' } }, stage, metaBox), foot, paths: [node.path],
    });

    fetchBlobBytes(node).then((bytes) => {
      stage.textContent = '';
      if (isImage) {
        const blob = new Blob([bytes], { type: MIME[ext] || 'image/png' });
        const url = URL.createObjectURL(blob);
        const img = el('img', { src: url, alt: node.name });
        stage.append(img);
        rec.onCloseCleanup = () => URL.revokeObjectURL(url);
        const oldClose = rec.close.bind(rec);
        rec.close = () => { if (rec.onCloseCleanup) rec.onCloseCleanup(); oldClose(); };
      } else if (isPdf) {
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        stage.append(el('iframe', { src: url, title: node.name }));
        const oldClose = rec.close.bind(rec);
        rec.close = () => { URL.revokeObjectURL(url); oldClose(); };
      } else if (isText) {
        let text = '';
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch (e) { text = new TextDecoder().decode(bytes); }
        const pre = el('pre', { class: 'ghf-ed-hl', style: { position: 'relative', inset: 'auto', flex: '1', whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '16px', overflow: 'auto' } });
        pre.innerHTML = langForFile(node.name) ? highlightCode(text, langForFile(node.name)) : escapeHtml(text);
        stage.style.padding = '0';
        stage.append(pre);
      } else {
        stage.append(el('div', { class: 'ghf-pv-fallback' },
          fileIconEl(node),
          el('div', null, 'No preview available for ' + ki.label + ' files.'),
          el('button', { class: 'ghf-btn ghf-primary', onclick: () => downloadFile(node) }, 'Download')));
      }
    }).catch((e) => {
      stage.textContent = '';
      stage.append(el('div', { class: 'ghf-pv-fallback' }, iconEl('warning'), el('div', null, 'Could not load file: ' + e.message)));
    });
  }

  /* ── Move-to picker sheet ─────────────────────────────── */
  function openMovePicker(nodes) {
    nodes = (nodes || []).filter(Boolean);
    if (!nodes.length) return;
    if (nodes.some((n) => n.pending)) { toast('info', 'Still syncing', 'Wait a moment for the previous change to finish.'); return; }
    let current = S.nav.path || '';
    const crumbs = el('div', { class: 'ghf-mv-crumbs' });
    const list = el('div', { class: 'ghf-mv-list' });
    const upBtn = el('div', { class: 'ghf-mv-up', onclick: () => { current = pathDir(current); render2(); } }, iconEl('back'), 'Enclosing folder');
    const chooseBtn = el('button', { class: 'ghf-btn ghf-primary', onclick: () => { rec.close(); ops.moveNodes(nodes, current); } }, 'Move Here');
    const newFolderBtn = el('button', { class: 'ghf-btn', onclick: () => {
      promptDialog({ title: 'New Folder', label: 'Folder name in “' + (pathBase(current) || 'root') + '”', confirmLabel: 'Create', icon: 'folderPlus' })
        .then((name) => { if (name) { ops.newFolder(current, name); setTimeout(render2, 250); } });
    } }, 'New Folder');

    const render2 = () => {
      // crumbs
      crumbs.textContent = '';
      const rootC = el('span', { class: 'ghf-crumb' + (current === '' ? ' ghf-last' : ''), onclick: () => { current = ''; render2(); } },
        iconEl('repo'), el('span', { class: 'ghf-ell' }, S.repo.owner + '/' + S.repo.name));
      crumbs.append(rootC);
      let acc = '';
      for (const seg of pathSegments(current)) {
        acc = pathJoin(acc, seg);
        const p = acc;
        crumbs.append(el('span', { class: 'ghf-crumb-sep' }, (() => { const s = el('span'); s.innerHTML = icon('chevron', 9); return s; })()));
        const c = el('span', { class: 'ghf-crumb' + (p === current ? ' ghf-last' : ''), onclick: () => { current = p; render2(); } },
          iconEl('folder'), el('span', { class: 'ghf-ell' }, seg));
        crumbs.append(c);
      }
      // folder list
      list.textContent = '';
      const dirNode = S.model.get(current);
      const kids = dirNode ? [...dirNode.children.values()].filter((n) => n.type === 'dir').sort((a, b) => naturalCompare(a.name, b.name)) : [];
      if (!kids.length) list.append(el('div', { class: 'ghf-mv-row ghf-empty-hint' }, 'No subfolders here.'));
      for (const k of kids.slice(0, 800)) {
        const disabled = nodes.some((n) => n.path === k.path || isDescendant(n.path, k.path));
        list.append(el('div', {
          class: 'ghf-mv-row' + (disabled ? ' ghf-pending-row' : ''),
          onclick: () => { if (!disabled) { current = k.path; render2(); } },
        }, fileIconEl(k), el('span', { class: 'ghf-ell' }, k.name), disabled ? el('span', { class: 'ghf-hint' }, 'inside selection') : null));
      }
      if (kids.length > 800) list.append(el('div', { class: 'ghf-mv-row ghf-empty-hint' }, '…and ' + (kids.length - 800) + ' more folders'));
      // Moving into the folder the items are already in is pointless.
      const noOp = nodes.every((n) => pathDir(n.path) === current);
      chooseBtn.disabled = noOp;
      chooseBtn.textContent = noOp ? 'Already here' : 'Move to “' + (pathBase(current) || 'root') + '”';
    };
    render2();
    const body = el('div', { class: 'ghf-mv' }, crumbs, upBtn, list);
    const foot = el('div', { class: 'ghf-sheet-foot' },
      el('span', { class: 'ghf-meta' }, 'Moving ' + nodes.length + ' item' + (nodes.length > 1 ? 's' : '')),
      newFolderBtn, chooseBtn);
    const headNode = {
      name: 'Move ' + nodes.length + ' item' + (nodes.length > 1 ? 's' : ''),
      path: nodes.map((n) => n.name).join(', ').slice(0, 90),
      type: 'dir',
    };
    const rec = openSheet({ head: sheetHead(headNode), body, foot, paths: nodes.map((n) => n.path) });
  }

  /* ══════════════════════════ §16 KEYS / SPA WATCHER / BOOT ══════════════════════════ */

  /* ── Event delegation for items ───────────────────────── */
  function isTypingContext() {
    const a = document.activeElement;
    return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable));
  }
  function bindEvents() {
    // Global drag tracking (internal pointer drag).
    window.addEventListener('pointermove', (e) => { if (DnD.drag || DnD.cand) DnD.onMove(e); }, true);
    window.addEventListener('pointerup', () => { if (DnD.drag || DnD.cand) DnD.onUp(); }, true);
    window.addEventListener('pointercancel', () => { if (DnD.drag || DnD.cand) DnD.cancel(); }, true);
    window.addEventListener('blur', () => { if (DnD.drag || DnD.cand) DnD.cancel(); });

    // Main pane
    E.mainScroll.addEventListener('pointerdown', (e) => {
      const item = e.target.closest('.ghf-row,.ghf-cell');
      if (!item || !item.dataset.path) return;
      const p = item.dataset.path;
      const paths = S.sel.has(p) ? [...S.sel] : [p];
      DnD.maybeStart(e, paths);
      e.preventDefault();
    });
    E.mainScroll.addEventListener('click', (e) => {
      if (clickSuppressed()) return;
      const item = e.target.closest('.ghf-row,.ghf-cell');
      if (item && item.dataset.path != null) { clickSelect(item.dataset.path, e); return; }
      if (S.nav.query == null) clearSel();
    });
    E.mainScroll.addEventListener('dblclick', (e) => {
      const item = e.target.closest('.ghf-row,.ghf-cell');
      if (!item || !item.dataset.path) return;
      const node = S.model && S.model.get(item.dataset.path);
      if (node) openNode(node);
    });
    E.mainScroll.addEventListener('contextmenu', (e) => {
      if (!S.model) return;
      e.preventDefault();
      e.stopPropagation();
      const item = e.target.closest('.ghf-row,.ghf-cell');
      if (item && item.dataset.path) {
        const p = item.dataset.path;
        let nodes;
        if (S.sel.has(p)) nodes = selectedNodes();
        else { clickSelect(p, e); nodes = [S.model.get(p)].filter(Boolean); }
        if (nodes.length) Menu.open(e.clientX, e.clientY, itemMenuItems(nodes));
      } else {
        Menu.open(e.clientX, e.clientY, emptyMenuItems(S.nav.path));
      }
    });

    // Sidebar
    E.sideScroll.addEventListener('pointerdown', (e) => {
      const row = e.target.closest('.ghf-srow');
      if (!row || row.dataset.path === undefined) return;
      const p = row.dataset.path;
      const paths = S.sel.has(p) ? [...S.sel] : [p];
      DnD.maybeStart(e, paths);
      e.preventDefault();
    });
    E.sideScroll.addEventListener('click', (e) => {
      if (clickSuppressed()) return;
      const row = e.target.closest('.ghf-srow');
      if (!row || row.dataset.path === undefined) return;
      const p = row.dataset.path;
      const node = S.model && S.model.get(p);
      if (!node) return;
      if (e.target.closest('.ghf-chevron') && node.type === 'dir') { toggleExpand(p); return; }
      if (node.type === 'dir') navTo(p);
      else { navTo(pathDir(p)); setSel([p]); revealPath(p); }
    });
    E.sideScroll.addEventListener('contextmenu', (e) => {
      if (!S.model) return;
      e.preventDefault();
      e.stopPropagation();
      const row = e.target.closest('.ghf-srow');
      if (!row || row.dataset.path === undefined) return;
      const node = S.model.get(row.dataset.path);
      if (!node) return;
      if (row.dataset.fav) Menu.open(e.clientX, e.clientY, favoriteMenuItems(node));
      else Menu.open(e.clientX, e.clientY, itemMenuItems([node]));
    });

    // Breadcrumbs — context menu per crumb folder
    E.crumbs.addEventListener('contextmenu', (e) => {
      const crumb = e.target.closest('.ghf-crumb');
      if (!crumb || !S.model) return;
      e.preventDefault();
      e.stopPropagation();
      Menu.open(e.clientX, e.clientY, emptyMenuItems(crumb.dataset.drop || ''));
    });

    // Search box
    E.searchInput.addEventListener('input', onSearchInput);
    E.searchInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && S.nav.query != null && mainItems.length) {
        e.preventDefault();
        exitSearch(true);
        const n = mainItems[0];
        openNode(n);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        E.searchInput.value = '';
        exitSearch(true);
        E.searchInput.blur();
      }
    });

    // Suppress GitHub's context menu inside our overlay (except in inputs).
    E.root.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('input, textarea')) { e.preventDefault(); }
    }, true);

    // Keep the window on screen when the browser is resized.
    window.addEventListener('resize', () => {
      if (S.win.open && !S.win.max) {
        const r = currentRect();
        applyRect(r);
      }
    });
  }

  /* ── Keyboard shortcuts ───────────────────────────────── */
  function onKeyDown(e) {
    // Global toggle — works even when the finder is closed.
    if (e.altKey && e.shiftKey && (e.code === 'KeyF')) {
      e.preventDefault();
      e.stopPropagation();
      if (S.win.open && !S.win.min) closeFinder();
      else if (S.win.min) restoreWindow();
      else openFinder();
      return;
    }
    if (!S.win.open || S.win.min) return;

    // Menus have their own navigation.
    if (Menu.isOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); Menu.moveHot(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); Menu.moveHot(-1); return; }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); Menu.triggerHot(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); Menu.close(); return; }
      return;
    }

    const typing = isTypingContext();
    const top = topLayer();

    if (typing) {
      // Inside our inputs: only Escape bubbles out (editor manages its own).
      if (e.key === 'Escape' && !(document.activeElement && document.activeElement.classList.contains('ghf-ed-ta'))) {
        if (top) {
          e.preventDefault();
          e.stopPropagation();
          if (top.onEsc) top.onEsc();
          else if (top.close) top.close();
        }
      }
      return;
    }

    if (top) { // modal or sheet open, not typing
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (top.onEsc) top.onEsc();
        else if (top.close) top.close();
      } else if (e.key === 'Enter' && top.onEnter) {
        e.preventDefault();
        e.stopPropagation();
        top.onEnter();
      }
      return;
    }

    if (E.win.classList.contains('ghf-inactive')) return; // page has focus
    if (!S.model) return;

    const mod = e.metaKey || e.ctrlKey;
    const node = S.focus ? S.model.get(S.focus) : null;
    const cols = E.vlist ? E.vlist.cols : 1;

    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); e.stopPropagation(); focusNext(S.view.mode === 'grid' ? cols : 1); return;
      case 'ArrowUp': e.preventDefault(); e.stopPropagation(); focusNext(S.view.mode === 'grid' ? -cols : -1); return;
      case 'ArrowRight':
        e.preventDefault(); e.stopPropagation();
        if (S.view.mode === 'grid') focusNext(1);
        else if (node && node.type === 'dir') navTo(node.path);
        return;
      case 'ArrowLeft':
        e.preventDefault(); e.stopPropagation();
        if (S.view.mode === 'grid') focusNext(-1);
        else if (S.nav.path) navTo(pathDir(S.nav.path));
        return;
      case 'Home': e.preventDefault(); e.stopPropagation(); focusNext(-Infinity); return;
      case 'End': e.preventDefault(); e.stopPropagation(); focusNext(Infinity); return;
      case 'Enter':
        e.preventDefault(); e.stopPropagation();
        if (mod) { if (node) startInlineRename(node.path); }   // ⌘/Ctrl+Enter → rename
        else if (node) openNode(node);                          // Enter → open / preview
        return;
      case 'F2':
        e.preventDefault(); e.stopPropagation();
        if (node) startInlineRename(node.path);
        return;
      case ' ':
        e.preventDefault(); e.stopPropagation();
        if (node && node.type === 'file') openPreview(node);
        return;
      case 'Backspace':
        e.preventDefault(); e.stopPropagation();
        if (S.nav.path) navTo(pathDir(S.nav.path));
        return;
      case 'Delete':
        e.preventDefault(); e.stopPropagation();
        if (S.sel.size) ops.deleteNodes(selectedNodes());
        return;
      case 'Escape':
        e.preventDefault(); e.stopPropagation();
        if (S.nav.query != null) exitSearch(true);
        else clearSel();
        return;
    }
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'a') { e.preventDefault(); e.stopPropagation(); selectAll(); return; }
      if (k === 'c' && S.sel.size) { e.preventDefault(); e.stopPropagation(); setClipboard('copy', selectedNodes()); return; }
      if (k === 'x' && S.sel.size) { e.preventDefault(); e.stopPropagation(); setClipboard('cut', selectedNodes()); return; }
      if (k === 'v') { e.preventDefault(); e.stopPropagation(); ops.paste(); return; }
      if (k === 'd' && S.sel.size) { e.preventDefault(); e.stopPropagation(); ops.duplicateNodes(selectedNodes()); return; }
      if (e.key === '[') { e.preventDefault(); e.stopPropagation(); navigateHistory(-1); return; }
      if (e.key === ']') { e.preventDefault(); e.stopPropagation(); navigateHistory(1); return; }
    }
  }

  /* ── SPA navigation watcher (GitHub Turbo/pjax) ───────── */
  function watchNavigation() {
    let lastHref = location.href;
    const changed = () => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      onRouteChange();
    };
    for (const ev of ['turbo:load', 'turbo:render', 'pjax:end', 'pjax:complete', 'popstate', 'hashchange']) {
      window.addEventListener(ev, () => setTimeout(changed, 0));
    }
    setInterval(changed, 800);
  }
  function onRouteChange() {
    const repo = parseRepo(location);
    if (!S.win.open) {
      E.launcher.classList.remove('ghf-hidden');
      return;
    }
    if (!repo) {
      // Left the repo pages — show a hint but keep the window usable.
      S.repo = null; S.model = null; S.repoKey = '';
      S.sel.clear(); S.clip = null;
      renderEmptyState('no-repo');
      markAll();
      return;
    }
    if (!S.repo || S.repo.owner !== repo.owner || S.repo.name !== repo.name) {
      toast('info', 'Switching to ' + repo.owner + '/' + repo.name);
      loadRepo(repo).catch(() => {});
    } else if (repo.urlBranch && repo.urlBranch !== S.repo.branch) {
      loadRepo(repo).catch(() => {});
    }
  }

  /* ── Tampermonkey menu + boot ─────────────────────────── */
  function registerMenus() {
    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Open GitHub Finder', () => { openFinder(); }, 'o');
        GM_registerMenuCommand('Finder settings / token', () => { openFinder(); openSettings(); }, 's');
      }
    } catch (e) { /* menu registration is optional */ }
  }

  function boot() {
    injectCSS();
    buildShell();
    applyTheme();
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', applyTheme);
      else if (mq.addListener) mq.addListener(applyTheme);
    } catch (e) { /* theme watching is best-effort */ }
    bindEvents();
    ExtDnD.bind();
    watchNavigation();
    guardReattach();
    registerMenus();
    window.addEventListener('keydown', onKeyDown, true);
  }

  boot();
})();
