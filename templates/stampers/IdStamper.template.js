/*************************************************************************************************
 *  ID STAMPER — paste-and-go template
 *  -----------------------------------------------------------------------------------------------
 *  Drop a copy of this into the SOURCE sheet's bound Apps Script (Extensions ▸ Apps Script ▸
 *  paste into a new .gs file). Then install two triggers (see installation steps below). No
 *  clasp, no repos, no dev setup required for the source-sheet owner.
 *
 *  Purpose: stamp a stable ID on any new row at the source, so downstream consumers (Goal
 *  Trackers, team rollups, etc.) read existing IDs and never have to backfill them.
 *
 *  ──────────────────────────────────────────────────────────────────────────────────────────────
 *  TEMPLATE — substitute these placeholders BEFORE pasting:
 *    <NAMESPACE>          short kebab-friendly prefix for function names, no spaces or symbols
 *                         examples: task | event | item | record
 *    <FRIENDLY_LABEL>     human label for the menu (no special chars)
 *                         examples: TaskIdStamper | EventIdStamper
 *  Then edit the STAMPER_CONFIG block below to match your tab + headers.
 *  ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 *  DEFENSIVE DESIGN — IMPORTANT for shared / team sheets:
 *    Apps Script merges every .gs file in a bound project into one global scope. Declaring
 *    `function onOpen()`, `function onEdit()`, or `function onChange()` HERE would silently
 *    clobber any sibling .gs's simple trigger of the same name. So this script declares ZERO
 *    magic-named functions. Everything is namespaced and runs via INSTALLABLE triggers
 *    configured by name through the Triggers UI.
 *
 *  INSTALLATION (one-time, by the source-sheet owner):
 *    1. Open the source sheet → Extensions ▸ Apps Script.
 *    2. File ▸ New ▸ Script file. Name it whatever you like (e.g., '<FRIENDLY_LABEL>').
 *    3. Paste this entire file into it. Save.
 *    4. EDIT STAMPER_CONFIG below to match your tab + headers.
 *    5. Function dropdown → `<NAMESPACE>StamperInstall` → Run. Authorize when prompted.
 *       This single function installs the two installable triggers (onChange + onOpen) needed
 *       to auto-stamp new rows + show the menu on sheet open. No manual Triggers-UI clicks.
 *    6. Reload the sheet — the menu appears.
 *    7. (Optional) Run <NAMESPACE>StamperBackfillAll once via the menu OR function dropdown to
 *       stamp every existing row that has a Name but no ID.
 *************************************************************************************************/

const <NAMESPACE>Stamper_CONFIG = {
  tab:        'EDIT_ME — name of the data tab',     // e.g., 'Items' or 'Tasks'
  headers: {
    name:     'EDIT_ME — name column header',       // header on row 1; a row is "real" if this cell is non-empty
    id:       'EDIT_ME — id column header'          // header on row 1; this is what we stamp
  },
  idPrefix:   'EDIT_ME-',                            // short prefix, e.g., 'T-' or 'WM-'
  idLength:   8                                      // characters of UUID after the prefix
};

// Safe alert helper — falls back to console.log + sheet toast when getUi() isn't available
// (which is the case when a function runs from the Apps Script editor's function dropdown
// rather than from a sheet menu). Use this anywhere a user-facing alert might be triggered
// from either context.
function <NAMESPACE>StamperSafeAlert(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (_) {
    console.log(message);
    try { SpreadsheetApp.getActive().toast(String(message).split('\n')[0], '<FRIENDLY_LABEL>', 8); } catch (__) {}
  }
}

/* ============================== INSTALLER + MENU + TRIGGER ENTRYPOINTS ============================== */

// One-shot trigger installer. Run this once from the function dropdown after pasting the file.
// Idempotent — deletes any existing triggers for our handlers first, then re-creates them, so
// re-running is safe (no duplicate triggers).
function <NAMESPACE>StamperInstall() {
  var ours = ['<NAMESPACE>StamperOnChange', '<NAMESPACE>StamperBuildMenu'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (ours.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('<NAMESPACE>StamperOnChange').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('<NAMESPACE>StamperBuildMenu').forSpreadsheet(ss).onOpen().create();
  // console.log (not getUi().alert) because this function runs from the Apps Script editor's
  // function dropdown — no spreadsheet UI context available there.
  console.log('<FRIENDLY_LABEL> triggers installed:\n  • <NAMESPACE>StamperOnChange (On change)\n  • <NAMESPACE>StamperBuildMenu (On open)\nReload the sheet to see the menu.');
  return { ok: true, triggers: ['<NAMESPACE>StamperOnChange', '<NAMESPACE>StamperBuildMenu'] };
}

function <NAMESPACE>StamperBuildMenu() {
  SpreadsheetApp.getUi()
    .createMenu('<FRIENDLY_LABEL>')
    .addItem('🏷  Backfill missing IDs', '<NAMESPACE>StamperBackfillAll')
    .addItem('🔬 Self-test (read-only diagnostic)', '<NAMESPACE>StamperSelfTest')
    .addToUi();
}

function <NAMESPACE>StamperOnChange(e) {
  try {
    var ct = (e && e.changeType) || '';
    if (['INSERT_ROW', 'EDIT', 'OTHER'].indexOf(ct) === -1) return;
    // Capture the user's active row as a hint — when there's a duplicate group involving
    // this row, it's the one we re-stamp (the "newer" copy, just touched).
    var activeRow = null;
    try {
      var ar = SpreadsheetApp.getActive().getActiveSheet().getActiveRange();
      if (ar) activeRow = ar.getRow();
    } catch (_) {}
    <NAMESPACE>StamperBackfillAll(/* silent: */ true, activeRow);
  } catch (err) {
    console.error('<NAMESPACE>Stamper onChange error:', err);
  }
}

/* ====================================== CORE LOGIC ====================================== */

// Stamps missing IDs AND re-stamps duplicates (handles copy-pasted rows).
// newerRowHint: optional 1-indexed sheet row — when a duplicate group includes this row, it's
//   the one we re-stamp. Falls back to "keep lowest-row, re-stamp others" when hint is null
//   or doesn't match a duplicate group.
function <NAMESPACE>StamperBackfillAll(silent, newerRowHint) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(<NAMESPACE>Stamper_CONFIG.tab);
  if (!sh) {
    if (!silent) ss.toast('Tab "' + <NAMESPACE>Stamper_CONFIG.tab + '" not found.', '<FRIENDLY_LABEL>', 5);
    return { stamped: 0, scanned: 0, error: 'TAB_NOT_FOUND' };
  }

  var cols = <NAMESPACE>StamperResolveCols(sh);
  if (!cols.name || !cols.id) {
    if (!silent) {
      <NAMESPACE>StamperSafeAlert(
        '<FRIENDLY_LABEL>: required header(s) missing on "' + <NAMESPACE>Stamper_CONFIG.tab + '" row 1.\n\n' +
        'Need: ' + <NAMESPACE>Stamper_CONFIG.headers.name + ', ' + <NAMESPACE>Stamper_CONFIG.headers.id + '.\n\n' +
        'Add the missing header anywhere on row 1 — the stamper finds columns by name.'
      );
    }
    return { stamped: 0, scanned: 0, error: 'MISSING_HEADER' };
  }

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { stamped: 0, scanned: 0 };

  var nameVals = sh.getRange(2, cols.name, lastRow - 1, 1).getValues();
  var idVals   = sh.getRange(2, cols.id,   lastRow - 1, 1).getValues();

  // Pass 1: collect existing IDs + group duplicates
  var existingIds = new Set();
  var idGroups = {};                    // id → array of array-indexes (idVals indexes)
  for (var i = 0; i < idVals.length; i++) {
    var id = idVals[i][0];
    if (!id) continue;
    existingIds.add(id);
    if (idGroups[id]) idGroups[id].push(i);
    else idGroups[id] = [i];
  }

  // Uniqueness-guaranteed ID generator (no collisions with existingIds)
  function uniqueId() {
    var newId;
    do {
      newId = <NAMESPACE>Stamper_CONFIG.idPrefix + Utilities.getUuid().replace(/-/g, '').slice(0, <NAMESPACE>Stamper_CONFIG.idLength);
    } while (existingIds.has(newId));
    existingIds.add(newId);
    return newId;
  }

  // Pass 2a: stamp blanks
  var stamped = 0;
  for (var j = 0; j < nameVals.length; j++) {
    if (nameVals[j][0] && !idVals[j][0]) { idVals[j][0] = uniqueId(); stamped++; }
  }

  // Pass 2b: re-stamp duplicate groups
  var hintIdx = (newerRowHint != null) ? newerRowHint - 2 : -1;
  var reStamped = 0;
  Object.keys(idGroups).forEach(function (gid) {
    var group = idGroups[gid];
    if (group.length < 2) return;
    var keeper;
    if (group.indexOf(hintIdx) !== -1) {
      var others = group.filter(function (x) { return x !== hintIdx; });
      keeper = Math.min.apply(Math, others);
    } else {
      keeper = Math.min.apply(Math, group);
    }
    group.forEach(function (idx) {
      if (idx !== keeper) { idVals[idx][0] = uniqueId(); reStamped++; }
    });
  });

  if (stamped > 0 || reStamped > 0) sh.getRange(2, cols.id, idVals.length, 1).setValues(idVals);

  if (!silent) {
    var parts = [];
    if (stamped > 0) parts.push('stamped ' + stamped + ' new');
    if (reStamped > 0) parts.push('re-stamped ' + reStamped + ' duplicates');
    if (parts.length === 0) parts.push('no missing or duplicate IDs');
    ss.toast(parts.join(' · ') + ' (' + nameVals.length + ' rows).', '<FRIENDLY_LABEL>', 5);
  }
  return { stamped: stamped, reStamped: reStamped, scanned: nameVals.length };
}

function <NAMESPACE>StamperSelfTest() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(<NAMESPACE>Stamper_CONFIG.tab);
  if (!sh) {
    <NAMESPACE>StamperSafeAlert('Tab "' + <NAMESPACE>Stamper_CONFIG.tab + '" not found.');
    return;
  }
  var cols = <NAMESPACE>StamperResolveCols(sh);
  var lastRow = sh.getLastRow();
  var nameVals = (cols.name && lastRow > 1) ? sh.getRange(2, cols.name, lastRow - 1, 1).getValues() : [];
  var idVals   = (cols.id   && lastRow > 1) ? sh.getRange(2, cols.id,   lastRow - 1, 1).getValues() : [];

  var rows = nameVals.length;
  var missingIds = 0;
  for (var i = 0; i < rows; i++) {
    if (nameVals[i][0] && !idVals[i][0]) missingIds++;
  }

  <NAMESPACE>StamperSafeAlert(
    '<FRIENDLY_LABEL> self-test\n' +
    '———\n' +
    'Tab: "' + <NAMESPACE>Stamper_CONFIG.tab + '" — ' + (sh ? 'found' : 'NOT FOUND') + '\n' +
    'Name header ("' + <NAMESPACE>Stamper_CONFIG.headers.name + '"): ' + (cols.name ? 'col ' + cols.name : 'MISSING') + '\n' +
    'ID header ("'   + <NAMESPACE>Stamper_CONFIG.headers.id   + '"): ' + (cols.id   ? 'col ' + cols.id   : 'MISSING') + '\n' +
    'Rows scanned: ' + rows + '\n' +
    'Rows missing ID (would be stamped): ' + missingIds + '\n\n' +
    'Read-only — nothing was changed.'
  );
}

/* ====================================== HELPERS ========================================= */

function <NAMESPACE>StamperResolveCols(sh) {
  var headerRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = {};
  for (var key in <NAMESPACE>Stamper_CONFIG.headers) {
    var headerName = <NAMESPACE>Stamper_CONFIG.headers[key];
    var pos = headerRow.indexOf(headerName);
    idx[key] = (pos >= 0) ? pos + 1 : 0;
  }
  return idx;
}
