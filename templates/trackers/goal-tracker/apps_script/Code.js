/*************************************************************************************************
 *  JS GOAL TRACKER — BUILD KIT  (Google Apps Script)
 *  -----------------------------------------------------------------------------------------------
 *  HOW TO USE (full steps in the setup guide):
 *    1. Create a NEW blank Google Sheet.
 *    2. Extensions ▸ Apps Script. Delete the stub, paste THIS file, Save.
 *    3. Run  ▸  setup()   (authorize when prompted).
 *    4. Reload the sheet. Use the "🎯 Goal Tracker" menu that appears.
 *
 *  WHAT IT BUILDS:
 *    • Dashboard (Q2 Overview)  — quarter goals + cumulative QTD rollup across the month tabs
 *    • May 2026 / Jun 2026 / Jul 2026 — monthly detail tabs (same row layout, so they roll up)
 *    • Auto-Data — where syncAuto() drops live values pulled from your other sheets
 *    • Config — source spreadsheet IDs (edit here, no code changes needed)
 *    • 1:1 Snapshot — auto-list of at-risk / off-track rocks + blockers for your weekly sync
 *
 *  THE ACCEPT-OR-OVERRIDE PATTERN (per goal row):
 *    Auto-Reported  →  pulled by syncAuto() from your source sheets
 *    Manual Entry   →  you type a value
 *    Accept Auto?   →  checkbox. TRUE = use the auto value, FALSE = use your manual value
 *    Result         →  the single source of truth that feeds % and the rollup
 *************************************************************************************************/

/* ====================================== CONFIG ============================================== */

// Connections seed — pre-populates the Connections section on the Config tab with these connector
// rows. URLs are left blank for the user to paste; they're the connection consent signal.
// Adding a new connection type: append a row here and that connector shows up in Config on next setup.
// Template default is empty — edit this list to seed your tracker with the connectors you plan to use.
const DEFAULT_CONNECTIONS = [
  // { key: 'tasks',  description: 'My task tracker (read tasks, push status back)' },
  // Add a row per connector you want pre-populated in the Config tab.
];
// Optional pre-filled URLs (keyed by the same connector key). User can clear / overwrite in Config.
// Empty by default in this template — fill in your own URLs OR leave blank and paste them into
// the Config tab after setup.
const CONNECTION_URL_HINTS = {};

// Each auto metric maps to a STABLE handoff cell on the source sheet (see guide: the "_API" tab recipe).
// key = the AutoKey used on the month tabs. sourceKey = which SOURCES entry. a1 = cell to read.
const AUTO_METRICS = [
  // Reference / lower-priority autos
  { key: 'linkedin_followers',      desc: 'LinkedIn followers (latest) — WIRED: SUMIFS on JS:Dashboard',                       sourceKey: 'social',     a1: '_API!B2' },
  // Wired now (require _API formula on source — see SETUP_GUIDE §4)
  { key: 'launches_published_mtd',  desc: 'Obj 1 KR1 — product launches published in month — PENDING Items _API formula',     sourceKey: 'items',    a1: '_API!B2' },
  { key: 'nonito_wavemakers_mtd',   desc: 'Obj 2 KR2 — new WM members from non-ITO deals — PENDING Onboarding _API formula',    sourceKey: 'onboarding', a1: '_API!B2' },
  { key: 'wavemakers_mtd',          desc: 'Reference — total wavemakers added (all motions) — PENDING Onboarding _API',         sourceKey: 'onboarding', a1: '_API!B3' }
  // Deferred (manual until counting logic is defined):
  //   Obj 1 KR2 — high-quality storytelling posts (needs a 'storytelling post' classification on source)
  //   Obj 1 KR3 — engagement rate on product content (needs LI export pipeline)
  //   Obj 2 KR3 — Wavemaker Spotlight series impressions (manual until series exists)
];

// Tab names
const T = {
  dash:   'Dashboard',
  auto:   'Auto-Data',
  config: 'Config',
  goals:  'Goals',
  oneone: '1:1 Snapshot',
  mirror: 'Items-Mirror'
};

/* ============================ DEFAULT_GOALS TAB SCHEMA (Phase A2) =================================== */
// Headers for the Goals tab. The Goals tab is the source of truth for what shows up on each
// month tab. All lookups are by header name (not column position) so teammates can move/insert
// columns without breaking the engine. Same defensive design as Items.
const GOAL_TAB_HEADERS = [
  'GoalID',         // auto-backfilled UUID. Stable across renames.
  'Objective',      // e.g., 'Obj 1: Storytelling'
  'Label',          // e.g., 'KR1: Product launches published externally' or 'Office Hours held weekly'
  'Type',           // 'Metric' | 'Check'
  'Unit',           // 'launches', '%', 'posts', etc.
  'Roll-up',        // 'Sum' | 'Latest' | 'Max' | 'Check'
  'May Target',
  'Jun Target',
  'Jul Target',
  'Q Goal',
  'AutoKey',        // matches AUTO_METRICS.key, blank for manual-only
  'Criteria',       // free text — definition of done / how to measure
  'Visibility',     // 'team' (rollup-eligible) | 'internal' (Obj 4 default) | 'private' (only you)
  'Contributors'    // optional free text — e.g., 'PMs, Jacob'
];
const GOAL_REQUIRED_HEADERS = ['Objective', 'Label', 'Type', 'Roll-up'];
// Defaults for the three month tabs + primary month. ACTUAL values used at runtime come
// from cfg.settings (Config tab) via setup() — these are seeds + onEdit fallbacks.
const DEFAULT_MONTHS = ['May 2026', 'Jun 2026', 'Jul 2026'];
const DEFAULT_PRIMARY_MONTH = 'May 2026';
const DEFAULT_OWNER_NAME = 'YOUR_NAME';   // overridden by Config tab Settings → ownerName

// Read helpers — Script Properties is populated by setup() from cfg.settings.
// onEdit and the Items sync functions use these without a fresh sheet read.
function getMonths() {
  var p = PropertiesService.getScriptProperties();
  return [
    p.getProperty('month1') || DEFAULT_MONTHS[0],
    p.getProperty('month2') || DEFAULT_MONTHS[1],
    p.getProperty('month3') || DEFAULT_MONTHS[2]
  ];
}
function getPrimaryMonth() {
  return PropertiesService.getScriptProperties().getProperty('primaryMonth') || DEFAULT_PRIMARY_MONTH;
}
function getOwnerNeedle() {
  return PropertiesService.getScriptProperties().getProperty('ownerName') || DEFAULT_OWNER_NAME;
}
function getGoalsCount() {
  return parseInt(PropertiesService.getScriptProperties().getProperty('goalsCount') || String(DEFAULT_GOALS.length), 10);
}

/* ==================================== ITEMS CONFIG ======================================== */
// Items integration. We look up every column by HEADER NAME, not position — so the source
// sheet (which you may not fully own) can shift columns around without breaking us.
//
// Confirmed schema of Items today (cols A..K), team-controlled:
//   A Name | B Description | C Category | D Type | E Date | F Goals | G Actuals
//   H Owner | I Status | J Links | K Notes
//
// We augment the source with two NEW columns (add them anywhere on row 1; the code finds them):
//   Initiative   — generic grouping (covers Rocks + personal categories). Blank = "Other this month".
//   ItemID     — stable id, auto-backfilled on first sync (format T-<uuid8>).
//
// Owner matching is substring (case-insensitive) so co-owned rows like
// "Owner Name / Other Owner" still appear.
const ITEMS = {
  sourceKey:       'items',           // looks up SOURCES.items for the spreadsheet ID
  sourceTab:       'Items',
  ownerNeedle:     '',    // case-insensitive substring match on Owner column
  // Header names on the source sheet (exact, case-sensitive match against row 1).
  // The script resolves these to 1-indexed column numbers at runtime via resolveItemsCols().
  headers: {
    name:        'Name',
    description: 'Description',
    category:    'Category',
    type:        'Type',
    date:        'Date',
    actuals:     'Actuals',             // where Result is pushed back to
    owner:       'Owner',
    status:      'Status',              // where Status is pushed back to
    links:       'Links',
    notes:       'Notes',               // where Notes is pushed back to
    initiative:  'Initiative',          // NEW — you add this header on row 1
    itemId:    'ItemID'             // NEW — you add this header on row 1
  },
  // These headers MUST exist or syncItems aborts with a clear message.
  required: ['name', 'date', 'owner', 'initiative', 'itemId']
};
// Initiative values that, when matched on a item, get an inline subsection under their
// own header in the monthly items block. Anything else lands in "Other Initiatives";
// blank Initiative lands in "Other this month". Free-form — add new entries as you create them.
const ROCK_NAMES = [
  'Product launches', 'Office Hours',
  'Wavemaker Acquisition', 'Wavemaker Spotlight', 'Customer Spotlight',
  'Community Events', 'LinkedIn Content',
  'Triage', '1:1 Prep'
];
// Mirror tab columns: A..K
const MIRROR_HEADERS = ['ItemID', 'Source Row', 'Name', 'Description',
                        'Category', 'Type', 'Date', 'Initiative',
                        'Source Status', 'Source Notes', 'Links'];
// Items-section column layout on each month tab (relative to col A):
//   1 Initiative | 2 Item | 3 Type | 4 Date | 5 Status | 6 Notes | 7 Result
//   8 Sync? | 9 Last Synced | 10 ItemID (hidden) | 11 _SrcRow (hidden)
const TCOL = {
  initiative:1, item:2, type:3, date:4, status:5, notes:6, result:7,
  sync:8, last:9, itemId:10, srcRow:11
};
const TCOLS = 11;
const THEADERS = ['Initiative', 'Item', 'Type', 'Date', 'Status',
                  'Notes', 'Result', 'Sync?', 'Last Synced',
                  '_ItemID', '_SrcRow'];

// Status options + colors
const STATUS = ['⚪ Not started', '🟢 On track', '🟡 At risk', '🔴 Off track', '✅ Done'];
const STATUS_COLOR = {
  '⚪ Not started': '#e8eaed',
  '🟢 On track':    '#d6f0d6',
  '🟡 At risk':     '#fdf2cc',
  '🔴 Off track':   '#f8d4d0',
  '✅ Done':        '#cfe2ff'
};

// Map source-sheet status vocabulary (free-form text used by the source's owner) to one of the
// 5 tracker STATUS values that this tracker's dropdown accepts. Unknown / blank → "⚪ Not started".
// Add patterns here as new sources surface new status words.
function mapSourceStatusToTracker(sourceStatus) {
  var s = String(sourceStatus || '').toLowerCase().trim();
  if (!s) return STATUS[0];                                     // ⚪ Not started
  if (s.indexOf('not started') === 0)            return STATUS[0]; // ⚪ Not started
  if (s.indexOf('complete') !== -1 || s.indexOf('done') !== -1)
                                                 return STATUS[4]; // ✅ Done
  if (s.indexOf('paused') !== -1 || s.indexOf('blocked') !== -1 || s.indexOf('at risk') !== -1)
                                                 return STATUS[2]; // 🟡 At risk
  if (s.indexOf('off track') !== -1 || s.indexOf('canceled') !== -1 || s.indexOf('killed') !== -1)
                                                 return STATUS[3]; // 🔴 Off track
  if (s.indexOf('live') !== -1 || s.indexOf('in progress') !== -1 || s.indexOf('on track') !== -1 || s.indexOf('active') !== -1)
                                                 return STATUS[1]; // 🟢 On track
  return STATUS[0];                                                // fallback
}

// Palette
const C = {
  ink:    '#1f2a37',
  band1:  '#ffffff',
  area:   '#eef2f7',   // area row tint base (overridden per area below)
  head:   '#1f2a37',
  headTx: '#ffffff',
  sub:    '#5b6b7b',
  edit:   '#fffbe6',   // tint for cells the user edits
  auto:   '#eef6ff',   // tint for auto cells
  line:   '#d0d7de'
};

// Area accent colors (left swimlanes). Areas now correspond to the 4 Objectives.
const AREA_COLOR = {
  'Obj 1: Storytelling': '#e3e9fb',
  'Obj 2: Community':    '#e2f0e4',
  'Obj 3: Events':       '#fde7d6',
  'Obj 4: Operating':    '#efe3f7'
};

/* ===================================== GOAL DATA ============================================ */
/*
 * OKR-shaped goals. Each row is one goal line.
 *   area       : the Objective it belongs to (drives swimlane color + grouping)
 *   objNum     : 1-4 (which Objective)
 *   krNum      : 1, 2, 3 — or '' for execution-check rows that support a KR
 *   rock       : the row label shown on month tabs
 *   type       : 'Metric' (numeric target) | 'Check' (done/not-done checkbox)
 *   unit       : display unit ('', '%', 'views', etc.)
 *   roll       : how the Dashboard rolls it across months: 'Sum' | 'Latest' | 'Max' | 'Check'
 *   mTarget    : May target (number, '' for checks/skip)
 *   junTarget  : June target
 *   julTarget  : July target
 *   qGoal      : Q2 quarter goal (the OKR target)
 *   autoKey    : matches an AUTO_METRICS key, or '' for manual-only
 *   crit       : execution criteria / definition-of-done note
 *
 * Sourced from the OKR strategy deck slides 73-74. Obj 4 is internal-only (not on the OKR slide).
 *
 * NOTE: This array is now SEED DATA only — it's used to populate the Goals tab on first setup().
 * Once the Goals tab exists, readGoals() reads from there and this const is no longer consulted.
 * Edit the Goals tab to change goals; re-run setup to rebuild month tabs.
 */
const DEFAULT_GOALS = [
  // Empty by default. Users populate their own goals via the Goals tab; setup() reads them
  // and rebuilds the month tabs / Dashboard. This array is a seed only — once the Goals tab
  // has rows, buildGoalsTab() preserves them across setup re-runs.
];

/* ============================== MONTH TAB COLUMN MAP ======================================= */
// Row layout on month tabs: title row(1), legend(2), header(3), data starts row 4.
const MROW0 = 4;                    // first data row
const MCOL = {
  area:1, rock:2, type:3, unit:4, roll:5, target:6, auto:7, manual:8,
  accept:9, result:10, pct:11, status:12, notes:13, blockers:14, updated:15, autoKey:16
};
const MCOLS = 16;
const MHEADERS = ['Area','Rock / Goal','Type','Unit','Roll-up','Target',
                  'Auto-Reported','Manual Entry','Accept Auto?','Result','% to Target',
                  'Status','This week / Notes','Blockers','Updated','_autoKey'];

/* ================================== MENU + TRIGGERS ======================================== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎯 Goal Tracker')
    .addItem('🔌 Test ticked connections', 'testTickedConnections')
    .addItem('🔄 Sync ticked connections', 'syncTickedConnections')
    .addItem('🔁 Sync all connections (auto-data + items)', 'syncAllConnections')
    .addSeparator()
    .addItem('⬆️  Push ticked items → Items', 'pushTickedItems')
    .addItem('📊 Refresh 1:1 snapshot', 'refreshOneOnOne')
    .addSeparator()
    .addItem('🏗️  Build / rebuild tracker', 'setup')
    .addItem('⏰ Install daily auto-sync', 'installTriggers')
    .addToUi();
}

function onEdit(e) {
  // Stamp "Updated" when an editable cell on a month tab changes.
  // Only applies to the DEFAULT_GOALS section (rows MROW0..MROW0+DEFAULT_GOALS.length-1) — not the items section below.
  try {
    var sh = e.range.getSheet();
    if (getMonths().indexOf(sh.getName()) === -1) return;
    var col = e.range.getColumn();
    if ([MCOL.manual, MCOL.accept, MCOL.status, MCOL.notes, MCOL.blockers].indexOf(col) === -1) return;
    var row = e.range.getRow();
    if (row < MROW0 || row >= MROW0 + getGoalsCount()) return;
    sh.getRange(row, MCOL.updated).setValue(new Date());
  } catch (err) { /* no-op */ }
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncAuto') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncAuto').timeBased().everyDays(1).atHour(7).create();
  SpreadsheetApp.getActive().toast('Daily auto-sync installed (runs ~7am).', '🎯 Goal Tracker', 5);
}

/* ===================================== SETUP =============================================== */

function setup() {
  var ss = SpreadsheetApp.getActive();
  buildConfig(ss);
  buildAutoData(ss);
  buildItemsMirror(ss);
  buildGoalsTab(ss);            // creates the Goals tab if missing, preserves edits if present, backfills GoalIDs
  var cfg   = readConfig(ss);   // { sources, settings } — read AFTER Config is built/seeded
  var goals = readGoals(ss);    // array of goal objects in DEFAULT_GOALS shape (sheet-driven now)

  // Cache settings into Script Properties so onEdit + Items fns can read them without
  // re-reading the sheet (cheap, fast, survives across script invocations).
  var props = PropertiesService.getScriptProperties();
  props.setProperties({
    goalsCount:   String(goals.length),
    ownerName:    cfg.settings.ownerName    || DEFAULT_OWNER_NAME,
    primaryMonth: cfg.settings.primaryMonth || DEFAULT_PRIMARY_MONTH,
    month1:       cfg.settings.month1       || DEFAULT_MONTHS[0],
    month2:       cfg.settings.month2       || DEFAULT_MONTHS[1],
    month3:       cfg.settings.month3       || DEFAULT_MONTHS[2],
    trackerId:    cfg.settings.trackerId    || ''
  });

  // Fallback chain: settings → DEFAULT_MONTHS. Also string-coerce as belt-and-suspenders
  // — ss.insertSheet(<Date>) and ss.getSheetByName(<Date>) both fail with cryptic errors.
  var months = [
    String(cfg.settings.month1 || DEFAULT_MONTHS[0]),
    String(cfg.settings.month2 || DEFAULT_MONTHS[1]),
    String(cfg.settings.month3 || DEFAULT_MONTHS[2])
  ];
  months.forEach(function (m, idx) { buildMonthTab(ss, m, idx, goals, cfg); });
  buildDashboard(ss, goals, cfg);
  buildOneOnOne(ss, goals, cfg);

  // remove default Sheet1 if empty
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && ss.getSheets().length > 1) { try { ss.deleteSheet(s1); } catch (e) {} }

  // order tabs
  orderTabs(ss, [T.dash, months[0], months[1], months[2], T.oneone, T.goals, T.auto, T.mirror, T.config]);
  ss.setActiveSheet(ss.getSheetByName(T.dash));
  safeAlert(
    '✅ Tracker built with ' + goals.length + ' goals across ' + months.join(', ') + '.\n\n' +
    'Reload the page to load the "🎯 Goal Tracker" menu, then run:\n' +
    '   1) Sync auto-data now\n' +
    '   2) Sync items now  (after adding "Initiative" + "ItemID" headers to Items — see SETUP_GUIDE.md §7)\n\n' +
    'Edit the Goals tab to change goals, then re-run setup to rebuild.'
  );
}

// Safe alert — falls back to console.log + sheet toast when getUi() isn't available
// (which is the case when a function runs from the Apps Script editor's function dropdown
// rather than from a sheet menu). All user-facing alerts should go through this.
function safeAlert(message) {
  try {
    safeAlert(message);
  } catch (_) {
    console.log(message);
    try { SpreadsheetApp.getActive().toast(message.split('\n')[0], '🎯 Goal Tracker', 8); } catch (__) {}
  }
}

function freshSheet(ss, name) {
  var sh = ss.getSheetByName(name);
  if (sh) { sh.clear(); sh.clearConditionalFormatRules(); ss.setActiveSheet(sh);
            // remove existing data validations
            var mr = sh.getMaxRows(), mc = sh.getMaxColumns();
            sh.getRange(1,1,mr,mc).clearDataValidations(); }
  else sh = ss.insertSheet(name);
  return sh;
}

function orderTabs(ss, order) {
  order.forEach(function (name, i) {
    var sh = ss.getSheetByName(name);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
  });
}

/* ===================================== CONFIG TAB ========================================== */

// Default settings — used to seed the Settings section of the Config tab on first setup.
// trackerId is auto-generated per tracker (UUID). Stable across renames; used by future team
// dashboard to identify this tracker.
function generateTrackerId() {
  return 'TR-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}
function defaultSettings() {
  return [
    ['trackerId',    generateTrackerId(),         'Stable UUID for this tracker. Used by team dashboard to identify this person.'],
    ['ownerName',    DEFAULT_OWNER_NAME,          'Substring-matched against Items Owner column. Edit to match your name.'],
    ['ownerEmail',   'you@example.com',   'Your email — stable identifier for team rollups.'],
    ['quarterId',    '2026Q2',                    'Machine-readable quarter ID. Format YYYYQn.'],
    ['quarterLabel', 'Q2 2026',                   'Display label for the quarter.'],
    ['month1',       DEFAULT_MONTHS[0],           'First month tab name.'],
    ['month2',       DEFAULT_MONTHS[1],           'Second month tab name.'],
    ['month3',       DEFAULT_MONTHS[2],           'Third month tab name.'],
    ['primaryMonth', DEFAULT_PRIMARY_MONTH,       'Month used by Dashboard for current-month status snapshot.']
  ];
}

// Connections section schema. The user pastes a URL into URL; the sync extracts the spreadsheetId.
// Test? / Sync? are checkboxes — ticked rows are picked up by the menu items.
const CONNECTIONS_HEADERS = [
  'Connector', 'Description', 'URL', 'Status', 'Test?', 'Sync?', 'Last Tested', 'Last Synced'
];
// 1-indexed column positions within the Connections table
const CONN_COL = {
  connector: 1, desc: 2, url: 3, status: 4, test: 5, sync: 6, lastTested: 7, lastSynced: 8
};

function buildConfig(ss) {
  // Preserve existing values (Settings + Connection URLs / timestamps) if the tab already exists
  var existing = { settings: {}, connections: {} };
  if (ss.getSheetByName(T.config)) {
    try {
      var snap = readConfig(ss);
      existing.settings = snap.settings || {};
      existing.connections = snap.connections || {};
    } catch (e) { /* first run */ }
  }

  var sh = freshSheet(ss, T.config);
  sh.getRange('A1').setValue('CONFIG — Connections + Settings').setFontSize(14).setFontWeight('bold');
  sh.getRange('A2').setValue('Connections are peer-to-peer: paste a URL for each connector you want to use; tick Test? / Sync? and run the matching menu item. URLs are the consent signal — first access prompts Google to authorize.')
    .setFontColor(C.sub).setFontSize(9).setWrapStrategy(SpreadsheetApp.WrapStrategy.OVERFLOW);

  // ----- Section 1: Connections -----
  var connHeaderRow = 4;
  sh.getRange(connHeaderRow - 1, 1).setValue('CONNECTIONS — paste a URL per connector row').setFontSize(13).setFontWeight('bold').setFontColor(C.sub);
  sh.getRange(connHeaderRow, 1, 1, CONNECTIONS_HEADERS.length).setValues([CONNECTIONS_HEADERS])
    .setBackground(C.head).setFontColor(C.headTx).setFontWeight('bold');

  // Build the union of connection keys: DEFAULT_CONNECTIONS seeds + any existing rows from
  // a prior build. This lets users add connections in the Config tab (manually or via MCP)
  // and have them PRESERVED across setup re-runs, even if DEFAULT_CONNECTIONS is empty.
  var seenKeys = {};
  var connSpecs = [];
  DEFAULT_CONNECTIONS.forEach(function (c) {
    seenKeys[c.key] = true;
    connSpecs.push({ key: c.key, description: c.description });
  });
  Object.keys(existing.connections).forEach(function (k) {
    if (!seenKeys[k]) {
      seenKeys[k] = true;
      connSpecs.push({ key: k, description: existing.connections[k].description || '' });
    }
  });

  var connRows = connSpecs.map(function (c) {
    var saved = existing.connections[c.key] || {};
    return [
      c.key,
      c.description || saved.description || '',
      saved.url || CONNECTION_URL_HINTS[c.key] || '',
      saved.status || '',
      false,                                // Test? — always start unchecked
      false,                                // Sync? — always start unchecked
      saved.lastTested || '',
      saved.lastSynced || ''
    ];
  });
  var connStartRow = connHeaderRow + 1;
  // Only write connection rows + apply per-row formatting if DEFAULT_CONNECTIONS isn't empty.
  // (Template default is empty; user adds rows later or seeds DEFAULT_CONNECTIONS in code.)
  if (connRows.length > 0) {
    sh.getRange(connStartRow, 1, connRows.length, CONNECTIONS_HEADERS.length).setValues(connRows);
    sh.getRange(connStartRow, CONN_COL.url, connRows.length, 1).setBackground(C.edit);
    sh.getRange(connStartRow, CONN_COL.test, connRows.length, 1).insertCheckboxes();
    sh.getRange(connStartRow, CONN_COL.sync, connRows.length, 1).insertCheckboxes();
    sh.getRange(connStartRow, CONN_COL.lastTested, connRows.length, 1).setNumberFormat('m/d h:mm');
    sh.getRange(connStartRow, CONN_COL.lastSynced, connRows.length, 1).setNumberFormat('m/d h:mm');
    sh.getRange(connStartRow, CONN_COL.status, connRows.length, 1).setWrap(true);
  } else {
    // Leave a hint row so the section isn't visually empty
    sh.getRange(connStartRow, 1).setValue('(no connections yet — add rows below to wire plugins)').setFontColor(C.sub).setFontStyle('italic');
  }
  // Borders around header (and rows if any)
  sh.getRange(connHeaderRow, 1, Math.max(connRows.length, 1) + 1, CONNECTIONS_HEADERS.length).setBorder(true, true, true, true, true, true, C.line, null);

  // ----- Section 2: Settings -----
  var settingsHeaderRow = connStartRow + connRows.length + 2;
  sh.getRange(settingsHeaderRow - 1, 1).setValue('SETTINGS — owner / quarter / month names').setFontSize(13).setFontWeight('bold').setFontColor(C.sub);
  var setHead = ['Setting', 'Value', 'Description'];
  sh.getRange(settingsHeaderRow, 1, 1, 3).setValues([setHead]).setBackground(C.head).setFontColor(C.headTx).setFontWeight('bold');
  var seeds = defaultSettings();
  var setRows = seeds.map(function (s) {
    var key = s[0];
    var preserved = (key in existing.settings) ? existing.settings[key] : s[1];
    return [key, preserved, s[2]];
  });
  // CRITICAL: set the Value column to plain-text format BEFORE writing values — otherwise
  // Sheets auto-converts date-like strings ("May 2026") into Date objects on write, and
  // setNumberFormat afterwards doesn't un-convert. Order matters.
  sh.getRange(settingsHeaderRow + 1, 2, setRows.length, 1).setNumberFormat('@');
  sh.getRange(settingsHeaderRow + 1, 1, setRows.length, 3).setValues(setRows);
  sh.getRange(settingsHeaderRow + 1, 2, setRows.length, 1).setBackground(C.edit);
  sh.getRange(settingsHeaderRow, 1, setRows.length + 1, 3).setBorder(true, true, true, true, true, true, C.line, null);

  // Widths sized for both sections
  var widths = [110, 280, 360, 200, 65, 65, 110, 110];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setFrozenRows(4);
}

// Read Config tab → { connections: {key: {url, spreadsheetId, status, ...}, ...}, settings: {key: val, ...} }.
// Tolerates either section being absent.
function readConfig(ss) {
  var sh = ss.getSheetByName(T.config);
  if (!sh) return { connections: {}, settings: {}, sources: {} };
  var lastRow = sh.getLastRow();
  var lastCol = Math.max(sh.getLastColumn(), 8);
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();

  var connections = {}, settings = {};
  var section = null;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var a = String(row[0] || '').trim();
    if (a === 'Connector')  { section = 'connections'; continue; }
    if (a === 'Setting') { section = 'settings'; continue; }
    if (!a && !row[1])   { section = null; continue; }

    if (section === 'connections' && a) {
      var url = String(row[CONN_COL.url - 1] || '').trim();
      connections[a] = {
        connectorKey:     a,
        description:   row[CONN_COL.desc - 1] || '',
        url:           url,
        spreadsheetId: extractSpreadsheetIdFromUrl(url),
        status:        row[CONN_COL.status - 1] || '',
        testTicked:    row[CONN_COL.test - 1] === true,
        syncTicked:    row[CONN_COL.sync - 1] === true,
        lastTested:    row[CONN_COL.lastTested - 1] || '',
        lastSynced:    row[CONN_COL.lastSynced - 1] || ''
      };
    }
    if (section === 'settings' && a) {
      var raw = row[1];
      // Coerce to string — Sheets auto-converts date-like strings (e.g. "May 2026") into Date
      // objects on cell write. Format them back to a readable string instead of passing Date
      // values downstream (where ss.insertSheet(Date) etc. fail).
      if (raw === '' || raw == null) settings[a] = '';
      else if (raw instanceof Date) settings[a] = Utilities.formatDate(raw, Session.getScriptTimeZone(), 'MMM yyyy');
      else settings[a] = String(raw);
    }
  }

  // sources is a back-compat shim: {items: 'spreadsheet-id', ...}
  var sources = {};
  Object.keys(connections).forEach(function (k) { sources[k] = connections[k].spreadsheetId; });

  return { connections: connections, settings: settings, sources: sources };
}

// Back-compat shim — older code paths use configMap()
function configMap(ss) {
  return readConfig(ss).sources;
}

// Extract a spreadsheetId from a Google Sheets URL (or pass-through if already an ID).
function extractSpreadsheetIdFromUrl(urlOrId) {
  if (!urlOrId) return '';
  var s = String(urlOrId).trim();
  if (!s) return '';
  var m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  return '';
}

/* ==================================== AUTO-DATA TAB ======================================== */

function buildAutoData(ss) {
  var sh = freshSheet(ss, T.auto);
  sh.getRange('A1').setValue('AUTO-DATA — live values pulled from your source sheets')
    .setFontSize(14).setFontWeight('bold');
  sh.getRange('A2').setValue('Run "🎯 Goal Tracker ▸ Sync auto-data now" to refresh. Edit Source Key / Handoff A1 to re-map.')
    .setFontColor(C.sub);
  var head = ['Metric Key', 'Description', 'Source Key', 'Handoff A1', 'Value', 'Last Synced', 'Status'];
  sh.getRange(4, 1, 1, head.length).setValues([head]).setBackground(C.head).setFontColor(C.headTx).setFontWeight('bold');
  var rows = AUTO_METRICS.map(function (m) { return [m.key, m.desc, m.sourceKey, m.a1, '', '', '']; });
  sh.getRange(5, 1, rows.length, head.length).setValues(rows);
  sh.getRange(5, 3, rows.length, 2).setBackground(C.edit); // editable mapping cells
  sh.getRange(5, 5, rows.length, 1).setBackground(C.auto); // value cells
  [150, 240, 110, 120, 90, 160, 220].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange(4, 1, rows.length + 1, head.length).setBorder(true, true, true, true, true, true, C.line, null);
  sh.setFrozenRows(4);
}

function syncAuto() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(T.auto);
  var cfg = configMap(ss);
  var n = sh.getLastRow() - 4;
  if (n < 1) return;
  var rng = sh.getRange(5, 1, n, 7);
  var rows = rng.getValues();
  var now = new Date();
  rows.forEach(function (r) {
    var sourceKey = r[2], a1 = r[3];
    var id = cfg[sourceKey];
    if (!id || !a1) { r[4] = ''; r[5] = now; r[6] = '⚠️ missing source/handoff'; return; }
    try {
      var src = SpreadsheetApp.openById(id);
      var v = src.getRange(a1).getValue();
      r[4] = v;
      r[5] = now;
      r[6] = (v === '' || v === null) ? '⚠️ empty cell' : '✅ ok';
    } catch (err) {
      r[5] = now;
      r[6] = '❌ ' + String(err).slice(0, 80);
    }
  });
  rng.setValues(rows);
  ss.toast('Auto-data synced.', '🎯 Goal Tracker', 4);
}

/* ==================================== MONTH TABS =========================================== */

// monthIdx: 0 = May, 1 = Jun, 2 = Jul. Determines which target field to use per goal row.
// goals: array from readGoals(). cfg: { sources, settings } from readConfig().
function buildMonthTab(ss, name, monthIdx, goals, cfg) {
  var sh = freshSheet(ss, name);
  var n = goals.length;
  var targetFields = ['mTarget', 'junTarget', 'julTarget'];
  var targetField = targetFields[monthIdx] || 'mTarget';

  // Title + legend
  sh.getRange(1, 1).setValue(name + ' — Goals').setFontSize(15).setFontWeight('bold');
  sh.getRange(2, 1).setValue('Edit only: Manual Entry · Accept Auto? · Status · This week · Blockers.  Result / % / Updated are automatic.')
    .setFontColor(C.sub).setFontSize(9);

  // Header
  sh.getRange(3, 1, 1, MCOLS).setValues([MHEADERS])
    .setBackground(C.head).setFontColor(C.headTx).setFontWeight('bold').setVerticalAlignment('middle');

  // If there are no goals yet, leave a hint row and skip all the per-row machinery.
  // Setup is idempotent — the user can fill the Goals tab and re-run setup.
  if (n === 0) {
    sh.getRange(MROW0, 1).setValue('(no goals yet — add rows on the Goals tab, then re-run "Build / rebuild tracker")')
      .setFontColor(C.sub).setFontStyle('italic');
  } else {
    // Data — pick this month's target from the goals row
    var data = goals.map(function (g) {
      return [g.area, g.rock, g.type, g.unit, g.roll,
              (g.type === 'Check' ? '' : g[targetField]),
              '', '', '', '', '', STATUS[0], '', '', '', g.autoKey];
    });
    sh.getRange(MROW0, 1, n, MCOLS).setValues(data);

    // Formulas per row
    for (var i = 0; i < n; i++) {
      var r = MROW0 + i;
      sh.getRange(r, MCOL.auto).setFormula(
        '=IF($P' + r + '="","",IFERROR(VLOOKUP($P' + r + ',\'' + T.auto + '\'!$A:$E,5,FALSE),""))');
      sh.getRange(r, MCOL.result).setFormula(
        '=IF(AND($I' + r + '=TRUE,$G' + r + '<>""),$G' + r + ',$H' + r + ')');
      sh.getRange(r, MCOL.pct).setFormula(
        '=IF($C' + r + '="Check",IF($J' + r + '=TRUE,1,0),IFERROR($J' + r + '/$F' + r + ',""))');
    }

    sh.getRange(MROW0, MCOL.accept, n, 1).insertCheckboxes();
    for (var j = 0; j < n; j++) {
      if (goals[j].type === 'Check') sh.getRange(MROW0 + j, MCOL.manual, 1, 1).insertCheckboxes();
    }

    var dv = SpreadsheetApp.newDataValidation().requireValueInList(STATUS, true).setAllowInvalid(false).build();
    sh.getRange(MROW0, MCOL.status, n, 1).setDataValidation(dv);

    sh.getRange(MROW0, MCOL.pct, n, 1).setNumberFormat('0%');
    sh.getRange(MROW0, MCOL.updated, n, 1).setNumberFormat('m/d h:mm');
    sh.getRange(MROW0, MCOL.manual, n, 1).setBackground(C.edit);
    sh.getRange(MROW0, MCOL.notes, n, 2).setBackground(C.edit);
    sh.getRange(MROW0, MCOL.status, n, 1).setBackground(C.edit);
    sh.getRange(MROW0, MCOL.auto, n, 1).setBackground(C.auto);

    for (var k = 0; k < n; k++) {
      var col = AREA_COLOR[goals[k].area] || C.area;
      sh.getRange(MROW0 + k, MCOL.area).setBackground(col).setFontSize(9).setFontColor(C.sub);
    }
  }

  // Hide helper autoKey column
  sh.hideColumns(MCOL.autoKey);

  // Widths
  var widths = [165, 195, 60, 80, 70, 70, 95, 90, 70, 75, 75, 110, 220, 180, 95];
  widths.forEach(function (w, idx) { sh.setColumnWidth(idx + 1, w); });

  // Borders + freeze + wrap (only if there are goal rows; n=0 would error on the wrap calls)
  sh.getRange(3, 1, Math.max(n, 1) + 1, MCOLS).setBorder(true, true, true, true, true, true, C.line, null);
  if (n > 0) {
    sh.getRange(MROW0, MCOL.rock, n, 1).setWrap(true);
    sh.getRange(MROW0, MCOL.notes, n, 2).setWrap(true);
  }
  sh.setFrozenRows(3);
  sh.setFrozenColumns(2);

  // Conditional formatting on Status column
  if (n > 0) applyStatusCF(sh, MROW0, MCOL.status, n);

  // Lay out (empty) items section below the goals. Populated by syncItems().
  try { refreshItemsSection(SpreadsheetApp.getActive(), name); } catch (e) { /* mirror not built yet — safe */ }
}

function applyStatusCF(sh, row0, col, n) {
  var rng = sh.getRange(row0, col, n, 1);
  var rules = sh.getConditionalFormatRules();
  STATUS.forEach(function (s) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(s).setBackground(STATUS_COLOR[s]).setRanges([rng]).build());
  });
  sh.setConditionalFormatRules(rules);
}

/* ===================================== DASHBOARD ========================================== */

function buildDashboard(ss, goals, cfg) {
  var sh = freshSheet(ss, T.dash);
  var n = goals.length;
  var primaryMonth = cfg.settings.primaryMonth;
  var month1 = cfg.settings.month1, month2 = cfg.settings.month2, month3 = cfg.settings.month3;
  var owner = cfg.settings.ownerName || '';

  sh.getRange(1, 1).setValue(cfg.settings.quarterLabel + ' — Goal Dashboard (' + owner + ')').setFontSize(16).setFontWeight('bold');
  sh.getRange(2, 1).setValue('Quarter goals + cumulative quarter-to-date (rolled up from the month tabs). Edit Quarter Goal here; everything else flows from the months.')
    .setFontColor(C.sub).setFontSize(9);

  // Summary cards (row 3-4)
  var cards = [
    ['On track', '🟢 On track'], ['At risk', '🟡 At risk'],
    ['Off track', '🔴 Off track'], ['Done', '✅ Done'], ['Not started', '⚪ Not started']
  ];
  sh.getRange(3, 1).setValue('STATUS SNAPSHOT (current month: ' + primaryMonth + ')').setFontWeight('bold').setFontColor(C.sub);
  cards.forEach(function (c, i) {
    var col = 1 + i;
    sh.getRange(4, col).setValue(c[0]).setFontColor(C.sub).setHorizontalAlignment('center');
    sh.getRange(5, col).setFormula("=COUNTIF('" + primaryMonth + "'!L" + MROW0 + ":L" + (MROW0 + n - 1) + ",\"" + c[1] + "\")")
      .setFontSize(20).setFontWeight('bold').setHorizontalAlignment('center')
      .setBackground(STATUS_COLOR[c[1]]);
  });

  // Table header
  var hr = 7;
  var head = ['Area', 'Rock / Goal', 'Metric', 'Unit', 'Roll-up', 'Quarter Goal',
              'QTD Result', '% to Q Goal', month1, month2, month3, 'Status (' + month1 + ')', 'Notes'];
  sh.getRange(hr, 1, 1, head.length).setValues([head])
    .setBackground(C.head).setFontColor(C.headTx).setFontWeight('bold');

  // If no goals yet, drop a hint row and skip the per-row machinery.
  if (n === 0) {
    sh.getRange(hr + 1, 1).setValue('(no goals yet — add rows on the Goals tab, then re-run "Build / rebuild tracker")')
      .setFontColor(C.sub).setFontStyle('italic');
    return;
  }

  // Rows mirror goals order (1:1 with month-tab rows)
  var rows = [];
  for (var i = 0; i < n; i++) {
    var g = goals[i];
    rows.push([g.area, g.rock, g.crit, g.unit, g.roll, (g.type === 'Check' ? '' : g.qGoal),
               '', '', '', '', '', '', '']);
  }
  sh.getRange(hr + 1, 1, n, head.length).setValues(rows);

  for (var k = 0; k < n; k++) {
    var dr = hr + 1 + k;          // dashboard row
    var mr = MROW0 + k;           // month row
    var may = "'" + month1 + "'!J" + mr;
    var jun = "'" + month2 + "'!J" + mr;
    var jul = "'" + month3 + "'!J" + mr;
    // month result mirrors (J = Result on month tab)
    sh.getRange(dr, 9).setFormula('=' + may);
    sh.getRange(dr, 10).setFormula('=' + jun);
    sh.getRange(dr, 11).setFormula('=' + jul);
    // QTD by roll-up type
    sh.getRange(dr, 7).setFormula(
      '=IF($E' + dr + '="Sum",N(I' + dr + ')+N(J' + dr + ')+N(K' + dr + '),' +
      'IF($E' + dr + '="Max",MAX(N(I' + dr + '),N(J' + dr + '),N(K' + dr + ')),' +
      'IF($E' + dr + '="Latest",IFERROR(IF(K' + dr + '<>"",K' + dr + ',IF(J' + dr + '<>"",J' + dr + ',I' + dr + ')),I' + dr + '),' +
      'IF($E' + dr + '="Check",IF(OR(I' + dr + '=TRUE,J' + dr + '=TRUE,K' + dr + '=TRUE),"✓","—"),""))))');
    // % to quarter goal (metrics only)
    sh.getRange(dr, 8).setFormula('=IF($F' + dr + '="","",IFERROR(N(G' + dr + ')/$F' + dr + ',""))');
    // Status mirror (primary month)
    sh.getRange(dr, 12).setFormula("='" + primaryMonth + "'!L" + mr);
    // Notes mirror (primary month)
    sh.getRange(dr, 13).setFormula("='" + primaryMonth + "'!M" + mr);
  }

  // Formats
  sh.getRange(hr + 1, 8, n, 1).setNumberFormat('0%');
  for (var a = 0; a < n; a++) {
    var col = AREA_COLOR[goals[a].area] || C.area;
    sh.getRange(hr + 1 + a, 1).setBackground(col).setFontSize(9).setFontColor(C.sub);
  }
  sh.getRange(hr + 1, 6, n, 1).setBackground(C.edit); // quarter goal editable

  var widths = [165, 195, 250, 90, 65, 95, 90, 90, 70, 70, 70, 110, 240];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange(hr, 1, n + 1, head.length).setBorder(true, true, true, true, true, true, C.line, null);
  sh.getRange(hr + 1, 2, n, 1).setWrap(true);
  sh.getRange(hr + 1, 3, n, 1).setWrap(true);
  sh.setFrozenRows(hr);
  sh.setFrozenColumns(2);

  // % to Q goal color scale
  var rules = sh.getConditionalFormatRules();
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .setGradientMaxpointWithValue('#57bb8a', SpreadsheetApp.InterpolationType.NUMBER, '1')
    .setGradientMidpointWithValue('#fdf2cc', SpreadsheetApp.InterpolationType.NUMBER, '0.5')
    .setGradientMinpointWithValue('#f8d4d0', SpreadsheetApp.InterpolationType.NUMBER, '0')
    .setRanges([sh.getRange(hr + 1, 8, n, 1)]).build());
  // status color on col 12
  STATUS.forEach(function (s) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(s).setBackground(STATUS_COLOR[s])
      .setRanges([sh.getRange(hr + 1, 12, n, 1)]).build());
  });
  sh.setConditionalFormatRules(rules);
}

/* ==================================== 1:1 SNAPSHOT ======================================== */

function buildOneOnOne(ss, goals, cfg) {
  var sh = freshSheet(ss, T.oneone);
  var n = goals.length;
  var dataEnd = MROW0 + n - 1;
  var primaryMonth = cfg.settings.primaryMonth;

  sh.getRange(1, 1).setValue('1:1 Snapshot — auto-built from ' + primaryMonth)
    .setFontSize(15).setFontWeight('bold');
  sh.getRange(2, 1).setValue('Run "🎯 Goal Tracker ▸ Refresh 1:1 snapshot" before your sync. Fill the Asks section yourself.')
    .setFontColor(C.sub).setFontSize(9);

  // No goals yet → drop a hint and skip the rest (queries below would fail with empty range).
  if (n === 0) {
    sh.getRange(4, 1).setValue('(no goals yet — add rows on the Goals tab, then re-run setup)')
      .setFontColor(C.sub).setFontStyle('italic');
    return;
  }

  // KR status block — all KR-level rows across the four objectives
  sh.getRange(4, 1).setValue('KEY RESULTS — status').setFontWeight('bold').setFontColor(C.sub);
  sh.getRange(5, 1, 1, 4).setValues([['KR', '% to Target', 'Status', 'This week']])
    .setBackground(C.head).setFontColor(C.headTx).setFontWeight('bold');
  // Pull every KR-level row (label starts with "KR") for status snapshot
  sh.getRange(6, 1).setFormula(
    "=IFERROR(QUERY({'" + primaryMonth + "'!B" + MROW0 + ":B" + dataEnd + "," +
    "'" + primaryMonth + "'!K" + MROW0 + ":K" + dataEnd + "," +
    "'" + primaryMonth + "'!L" + MROW0 + ":L" + dataEnd + "," +
    "'" + primaryMonth + "'!M" + MROW0 + ":M" + dataEnd + "}," +
    "\"select Col1, Col2, Col3, Col4 where Col1 starts with 'KR' label Col1 '', Col2 '', Col3 '', Col4 ''\",0),\"\")");

  // At-risk / off-track block: Rock(B), %(K), Status(L), Blockers(N)
  var rb = 6 + 12;
  sh.getRange(rb - 1, 1).setValue('NEEDS ATTENTION — at risk / off track').setFontWeight('bold').setFontColor(C.sub);
  sh.getRange(rb, 1, 1, 4).setValues([['Rock', '% to Target', 'Status', 'Blockers']])
    .setBackground(C.head).setFontColor(C.headTx).setFontWeight('bold');
  sh.getRange(rb + 1, 1).setFormula(
    "=IFERROR(QUERY({'" + primaryMonth + "'!B" + MROW0 + ":B" + dataEnd + "," +
    "'" + primaryMonth + "'!K" + MROW0 + ":K" + dataEnd + "," +
    "'" + primaryMonth + "'!L" + MROW0 + ":L" + dataEnd + "," +
    "'" + primaryMonth + "'!N" + MROW0 + ":N" + dataEnd + "}," +
    "\"select Col1, Col2, Col3, Col4 where Col3 = '🟡 At risk' or Col3 = '🔴 Off track' label Col1 '', Col2 '', Col3 '', Col4 ''\",0),\"No items at risk — nice.\")");

  // % columns formatted for both blocks (column B spans the rocks rows)
  sh.getRange(6, 2, rb - 6, 1).setNumberFormat('0%');
  sh.getRange(rb + 1, 2, n, 1).setNumberFormat('0%');

  // Asks block (manual)
  var ab = rb + 1 + n + 2;
  sh.getRange(ab, 1).setValue('MY ASKS FOR THIS 1:1 (fill in)').setFontWeight('bold').setFontColor(C.sub);
  sh.getRange(ab + 1, 1, 5, 4).setBackground(C.edit)
    .setBorder(true, true, true, true, true, true, C.line, null);
  sh.getRange(ab + 1, 1).setValue('• ');

  [240, 95, 110, 380].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setFrozenRows(3);
}

function refreshOneOnOne() {
  // Formulas are live; just bounce the sheet + toast.
  SpreadsheetApp.getActive().toast('1:1 snapshot is live (formula-driven).', '🎯 Goal Tracker', 4);
}

/* =================================== ITEMS INTEGRATION ================================== *
 * Read items from the GTM Marketing Calendar "Items" tab (filtered to owner), mirror
 * them locally, and surface them per-month grouped by Initiative under each Rock section.
 *
 * Source augment (one-time, on the GTM Marketing Calendar):
 *   - Add header "Initiative" in cell L1, "ItemID" in cell M1.
 *   - Leave Initiative blank to land items in "Other this month". Match a Rock name
 *     (e.g., "LinkedIn Content") to nest a item inline under that Rock.
 *   - ItemID is auto-filled by syncItems(); never type into it.
 *
 * Sync model:
 *   syncItems()      reads source → backfills ItemIDs in source → writes Items-Mirror
 *                      → rebuilds the items section on each month tab (preserves user edits).
 *   pushTickedItems() walks each month tab's items section; for every row with Sync? TRUE
 *                      it writes Status, Notes, Result back to the source row (by ItemID).
 *                      The checkbox auto-unticks and a "Last Synced" timestamp stamps.
 * ============================================================================================ */

function buildItemsMirror(ss) {
  var sh = freshSheet(ss, T.mirror);
  sh.getRange('A1').setValue('ITEMS-MIRROR — read-only copy of "Items" (filtered to ' + getOwnerNeedle() + ')')
    .setFontSize(14).setFontWeight('bold');
  sh.getRange('A2').setValue('Refreshed by "🎯 Goal Tracker ▸ Sync items now". Do not edit; edit on the month tabs instead.')
    .setFontColor(C.sub).setFontSize(9);
  sh.getRange(4, 1, 1, MIRROR_HEADERS.length).setValues([MIRROR_HEADERS])
    .setBackground(C.head).setFontColor(C.headTx).setFontWeight('bold');
  var widths = [110, 80, 230, 280, 90, 90, 95, 170, 110, 220, 110];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange(4, 1, 1, MIRROR_HEADERS.length).setBorder(true, true, true, true, true, true, C.line, null);
  sh.setFrozenRows(4);
  return sh;
}

// Resolve ITEMS.headers → 1-indexed column positions by reading row 1 of the source.
// Returns a map keyed by the logical name (e.g. 'name', 'initiative'); 0 = not found.
function resolveItemsCols(srcSh) {
  var lastCol = srcSh.getLastColumn();
  var headerRow = srcSh.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx = {};
  for (var key in ITEMS.headers) {
    var headerName = ITEMS.headers[key];
    var pos = headerRow.indexOf(headerName);
    idx[key] = (pos >= 0) ? pos + 1 : 0;
  }
  return idx;
}

function syncItems() {
  var ss = SpreadsheetApp.getActive();
  var cfg = configMap(ss);
  var sourceId = cfg[ITEMS.sourceKey];
  if (!sourceId) {
    ss.toast('Items source ID missing in Config tab.', '🎯 Goal Tracker', 6);
    return;
  }
  var src;
  try { src = SpreadsheetApp.openById(sourceId); }
  catch (e) {
    ss.toast('Cannot open Items source: ' + String(e).slice(0, 80), '🎯 Goal Tracker', 8);
    return;
  }
  var srcSh = src.getSheetByName(ITEMS.sourceTab);
  if (!srcSh) {
    ss.toast('Tab "' + ITEMS.sourceTab + '" not found in source spreadsheet.', '🎯 Goal Tracker', 8);
    return;
  }

  // Resolve all column positions by header name. Abort if any REQUIRED header is missing.
  var col = resolveItemsCols(srcSh);
  var missing = ITEMS.required.filter(function (k) { return !col[k]; });
  if (missing.length) {
    var names = missing.map(function (k) { return '"' + ITEMS.headers[k] + '"'; }).join(', ');
    safeAlert(
      'Items is missing required header(s): ' + names + '.\n\n' +
      'Add these as new column headers on row 1 of the "Items" tab (any column position — the script finds them by name). See SETUP_GUIDE.md §7a.'
    );
    return;
  }

  var lastRow = srcSh.getLastRow();
  var lastCol = srcSh.getLastColumn();
  if (lastRow < 2) { ss.toast('No item rows in source.', '🎯 Goal Tracker', 4); return; }

  // Read the full source range (row 2..end across all populated columns).
  var data = srcSh.getRange(2, 1, lastRow - 1, lastCol).getValues();

  // Backfill ItemID in any row that has a Name but no ID. Write back to source.
  var backfilled = 0;
  var idIdx = col.itemId - 1;
  var nameIdx = col.name - 1;
  for (var i = 0; i < data.length; i++) {
    if (data[i][nameIdx] && !data[i][idIdx]) {
      var newId = 'T-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
      data[i][idIdx] = newId;
      srcSh.getRange(i + 2, col.itemId).setValue(newId);
      backfilled++;
    }
  }

  // Filter to owner-matched, real-date rows with an ID.
  var ownerNeedle = getOwnerNeedle().toLowerCase();
  var rows = [];
  for (var j = 0; j < data.length; j++) {
    var r = data[j];
    var owner = String(r[col.owner - 1] || '').toLowerCase();
    if (owner.indexOf(ownerNeedle) === -1) continue;
    var dt = r[col.date - 1];
    if (!(dt instanceof Date)) continue;
    if (!r[idIdx]) continue;
    rows.push([
      r[idIdx],                                       // ItemID
      j + 2,                                          // SourceRow (1-indexed in the source sheet)
      r[col.name - 1] || '',
      col.description ? (r[col.description - 1] || '') : '',
      col.category    ? (r[col.category - 1]    || '') : '',
      col.type        ? (r[col.type - 1]        || '') : '',
      dt,
      r[col.initiative - 1] || '',
      col.status ? (r[col.status - 1] || '') : '',
      col.notes  ? (r[col.notes - 1]  || '') : '',
      col.links  ? (r[col.links - 1]  || '') : ''
    ]);
  }

  // Write mirror — clear data rows then write fresh.
  var sh = ss.getSheetByName(T.mirror) || buildItemsMirror(ss);
  var mirrorLastRow = sh.getLastRow();
  if (mirrorLastRow >= 5) sh.getRange(5, 1, mirrorLastRow - 4, MIRROR_HEADERS.length).clearContent();
  if (rows.length > 0) {
    sh.getRange(5, 1, rows.length, MIRROR_HEADERS.length).setValues(rows);
    sh.getRange(5, 7, rows.length, 1).setNumberFormat('m/d/yyyy');
  }
  // Stamp last-synced in M1
  sh.getRange('M1').setValue('Last sync: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d HH:mm'))
    .setFontColor(C.sub).setFontSize(9);

  // Rebuild the section on each month tab.
  getMonths().forEach(function (m) { refreshItemsSection(ss, m); });

  ss.toast('Items synced: ' + rows.length + ' rows. Backfilled IDs: ' + backfilled + '.', '🎯 Goal Tracker', 6);
}

// Compute month start/end (inclusive) from a tab name like "May 2026".
function monthBounds(name) {
  var monthIdx = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    .indexOf(name.slice(0, 3));
  var year = parseInt(name.slice(4), 10);
  var start = new Date(year, monthIdx, 1);
  var end = new Date(year, monthIdx + 1, 0, 23, 59, 59);
  return { start: start, end: end };
}

// Row where items section starts on a month tab.
function itemsStartRow() {
  return MROW0 + getGoalsCount() + 2;     // gap of 2 rows after goals
}

function refreshItemsSection(ss, monthName) {
  var sh = ss.getSheetByName(monthName);
  if (!sh) return;
  var mirror = ss.getSheetByName(T.mirror);
  if (!mirror) return;

  // Read mirror data
  var mLast = mirror.getLastRow();
  var mirrorRows = (mLast >= 5) ? mirror.getRange(5, 1, mLast - 4, MIRROR_HEADERS.length).getValues() : [];
  var bounds = monthBounds(monthName);

  // Filter to this month
  var thisMonth = mirrorRows.filter(function (r) {
    var d = r[6];
    return d instanceof Date && d >= bounds.start && d <= bounds.end;
  });

  // Preserve user edits keyed by ItemID before we clear
  var startRow = itemsStartRow();
  var maxKeep = 250;                     // clear buffer — generous
  var existing = sh.getRange(startRow, 1, maxKeep, TCOLS).getValues();
  var preserved = {};
  for (var i = 0; i < existing.length; i++) {
    var id = existing[i][TCOL.itemId - 1];
    if (id) {
      preserved[id] = {
        status: existing[i][TCOL.status - 1],
        notes:  existing[i][TCOL.notes - 1],
        result: existing[i][TCOL.result - 1],
        last:   existing[i][TCOL.last - 1]
      };
    }
  }

  // Clear the section (data + checkboxes + validations + formatting)
  var clearRange = sh.getRange(startRow, 1, maxKeep, TCOLS);
  clearRange.clearContent();
  clearRange.clearDataValidations();
  clearRange.clearFormat();
  clearRange.setBorder(false, false, false, false, false, false);

  // Group by Initiative bucket
  var rockSet = {}; ROCK_NAMES.forEach(function (r) { rockSet[r] = true; });
  var byBucket = { rock: {}, other: {}, blank: [] };
  thisMonth.forEach(function (r) {
    var ini = String(r[7] || '').trim();
    if (!ini) { byBucket.blank.push(r); return; }
    if (rockSet[ini]) {
      (byBucket.rock[ini] = byBucket.rock[ini] || []).push(r);
    } else {
      (byBucket.other[ini] = byBucket.other[ini] || []).push(r);
    }
  });

  // Build output: rows + per-row flags (header/subheader vs item)
  var out = [];
  var rowKinds = [];   // 'title' | 'sub' | 'item'
  // Section title
  out.push(['ITEMS — ' + monthName + ' (Owner: ' + getOwnerNeedle() + ')', '', '', '', '', '', '', '', '', '', '']);
  rowKinds.push('title');
  // Column headers — so you know what each column is at a glance.
  out.push(THEADERS);
  rowKinds.push('header');

  function pushGroup(label, list) {
    if (!list || list.length === 0) return;
    // sort by date ascending
    list.sort(function (a, b) { return a[6] - b[6]; });
    out.push(['▸ ' + label, '', '', '', '', '', '', '', '', '', '']);
    rowKinds.push('sub');
    list.forEach(function (r) {
      var id = r[0];
      var saved = preserved[id] || {};
      out.push([
        r[7] || '',                     // Initiative (echoed for filtering convenience)
        r[2] + (r[3] ? ' — ' + r[3] : ''),
        r[5] || '',                     // Type
        r[6],                           // Date
        saved.status || mapSourceStatusToTracker(r[8]),
        saved.notes  || r[9] || '',
        saved.result || '',
        false,                          // Sync? checkbox always starts unchecked
        saved.last || '',
        id,
        r[1]                            // _SrcRow
      ]);
      rowKinds.push('item');
    });
  }

  // Rocks in declared order (only those with items this month)
  ROCK_NAMES.forEach(function (rock) {
    if (byBucket.rock[rock]) pushGroup('Rock: ' + rock, byBucket.rock[rock]);
  });
  // Non-rock initiatives, alphabetical
  Object.keys(byBucket.other).sort().forEach(function (ini) {
    pushGroup('Initiative: ' + ini, byBucket.other[ini]);
  });
  // Blank initiative bucket
  pushGroup('Other this month (un-tagged)', byBucket.blank);

  if (out.length === 1) {
    // No items — just title. Add a friendly line.
    out.push(['No items this month for ' + getOwnerNeedle() + '. Add rows to "Items" with your name in Owner.', '', '', '', '', '', '', '', '', '', '']);
    rowKinds.push('sub');
  }

  // Write the block
  sh.getRange(startRow, 1, out.length, TCOLS).setValues(out);

  // Style each row by kind
  for (var k = 0; k < rowKinds.length; k++) {
    var r = startRow + k;
    if (rowKinds[k] === 'title') {
      sh.getRange(r, 1, 1, TCOLS).setBackground(C.head).setFontColor(C.headTx).setFontWeight('bold');
      sh.getRange(r, 1).setFontSize(11);
    } else if (rowKinds[k] === 'header') {
      sh.getRange(r, 1, 1, TCOLS).setBackground('#5b6b7b').setFontColor('#ffffff').setFontWeight('bold').setFontSize(9);
      // Dim the helper columns (ItemID, _SrcRow) but keep them readable for debugging
      sh.getRange(r, TCOL.itemId, 1, 2).setBackground('#8a9aab');
    } else if (rowKinds[k] === 'sub') {
      sh.getRange(r, 1, 1, TCOLS).setBackground('#eef2f7').setFontColor(C.sub).setFontWeight('bold');
    } else if (rowKinds[k] === 'item') {
      // editable cells tint
      sh.getRange(r, TCOL.status).setBackground(C.edit);
      sh.getRange(r, TCOL.notes, 1, 2).setBackground(C.edit);
    }
  }

  // Item rows: dropdowns, checkboxes, formats — apply across the contiguous item rows in bulk
  // Find contiguous item-row ranges; simpler: iterate per row.
  var itemRowNums = [];
  for (var t = 0; t < rowKinds.length; t++) if (rowKinds[t] === 'item') itemRowNums.push(startRow + t);

  if (itemRowNums.length > 0) {
    var dv = SpreadsheetApp.newDataValidation().requireValueInList(STATUS, true).setAllowInvalid(false).build();
    itemRowNums.forEach(function (r) {
      sh.getRange(r, TCOL.status).setDataValidation(dv);
      sh.getRange(r, TCOL.sync).insertCheckboxes();
      sh.getRange(r, TCOL.date).setNumberFormat('m/d');
      sh.getRange(r, TCOL.last).setNumberFormat('m/d h:mm');
    });
    // Conditional formatting on status (reuse helper)
    var firstT = itemRowNums[0];
    var lastT = itemRowNums[itemRowNums.length - 1];
    applyStatusCF(sh, firstT, TCOL.status, lastT - firstT + 1);
  }

  // Hide helper columns _ItemID and _SrcRow (defensive — already hidden from goals tab columns 16)
  // Goals tab only uses cols 1-16 visibly; items cols 10-11 share columns with goals' col 10-11 ("Result"/"% to Target")
  // which means we can't physically hide them on the month tab. Instead, dim them visually.
  if (itemRowNums.length > 0) {
    itemRowNums.forEach(function (r) {
      sh.getRange(r, TCOL.itemId, 1, 2).setFontColor('#cccccc').setFontSize(8);
    });
  }

  // Borders around the whole block
  sh.getRange(startRow, 1, out.length, TCOLS).setBorder(true, true, true, true, true, true, C.line, null);
}

function pushTickedItems() {
  var ss = SpreadsheetApp.getActive();
  var cfg = configMap(ss);
  var sourceId = cfg[ITEMS.sourceKey];
  if (!sourceId) { ss.toast('Items source ID missing.', '🎯 Goal Tracker', 6); return; }
  var src;
  try { src = SpreadsheetApp.openById(sourceId); }
  catch (e) { ss.toast('Cannot open Items source: ' + String(e).slice(0, 80), '🎯 Goal Tracker', 8); return; }
  var srcSh = src.getSheetByName(ITEMS.sourceTab);
  if (!srcSh) { ss.toast('Tab "' + ITEMS.sourceTab + '" not found.', '🎯 Goal Tracker', 8); return; }

  // Resolve source columns by header name. Push targets are status/notes/actuals (plus itemId for lookup).
  var col = resolveItemsCols(srcSh);
  var pushTargets = ['itemId', 'status', 'notes', 'actuals'];
  var missing = pushTargets.filter(function (k) { return !col[k]; });
  if (missing.length) {
    var names = missing.map(function (k) { return '"' + ITEMS.headers[k] + '"'; }).join(', ');
    safeAlert(
      'Cannot push: Items is missing column(s): ' + names + '.\n\n' +
      'Run "Sync items now" first, or add the missing header(s) to row 1.'
    );
    return;
  }

  var pushed = 0;
  var startRow = itemsStartRow();
  var maxScan = 250;

  getMonths().forEach(function (monthName) {
    var sh = ss.getSheetByName(monthName);
    if (!sh) return;
    var block = sh.getRange(startRow, 1, maxScan, TCOLS).getValues();
    var now = new Date();

    for (var i = 0; i < block.length; i++) {
      var row = block[i];
      var sync = row[TCOL.sync - 1];
      var id = row[TCOL.itemId - 1];
      var srcRowNum = row[TCOL.srcRow - 1];
      if (sync !== true || !id || !srcRowNum) continue;

      // Verify the source row's ItemID still matches (handles row inserts/deletes in source)
      var srcId = srcSh.getRange(srcRowNum, col.itemId).getValue();
      if (srcId !== id) {
        // try to find by scanning the ItemID column
        var lastSrcRow = srcSh.getLastRow();
        var idCol = srcSh.getRange(2, col.itemId, lastSrcRow - 1, 1).getValues();
        var found = -1;
        for (var k = 0; k < idCol.length; k++) {
          if (idCol[k][0] === id) { found = k + 2; break; }
        }
        if (found < 0) {
          // give up on this row; mark it
          sh.getRange(startRow + i, TCOL.last).setValue('⚠️ not found in source').setFontColor('#a30000');
          sh.getRange(startRow + i, TCOL.sync).setValue(false);
          continue;
        }
        srcRowNum = found;
      }

      // Write back: Status, Notes, Result → Actuals (column positions resolved by header)
      srcSh.getRange(srcRowNum, col.status).setValue(row[TCOL.status - 1] || '');
      srcSh.getRange(srcRowNum, col.notes).setValue(row[TCOL.notes - 1] || '');
      srcSh.getRange(srcRowNum, col.actuals).setValue(row[TCOL.result - 1] || '');

      // Reset checkbox + stamp Last Synced (on the month tab)
      sh.getRange(startRow + i, TCOL.sync).setValue(false);
      sh.getRange(startRow + i, TCOL.last).setValue(now).setFontColor(C.ink);
      pushed++;
    }
  });

  ss.toast('Pushed ' + pushed + ' item update(s) → Items.', '🎯 Goal Tracker', 6);
}

/* ===================================== GOALS TAB =========================================== *
 * The Goals tab is the source of truth for what shows up on each month tab.
 * - On first setup, buildGoalsTab() seeds the tab from DEFAULT_GOALS.
 * - On subsequent setups, buildGoalsTab() PRESERVES whatever's there and just backfills GoalIDs
 *   for any rows missing one. So you can edit goals in-place and re-run setup safely.
 * - readGoals() reads the tab into the same shape the engine has always consumed.
 *
 * Schema: 14 columns, header-resolved (column positions don't matter, header names do).
 * Headers defined in GOAL_TAB_HEADERS at the top of the file.
 * ============================================================================================ */

// Resolve Goals tab headers → 1-indexed positions. Returns null if required headers missing.
function resolveGoalCols(sh) {
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return null;
  var headerRow = sh.getRange(4, 1, 1, lastCol).getValues()[0];
  var idx = {};
  GOAL_TAB_HEADERS.forEach(function (name) {
    var pos = headerRow.indexOf(name);
    idx[name] = (pos >= 0) ? pos + 1 : 0;
  });
  return idx;
}

function buildGoalsTab(ss) {
  var existing = ss.getSheetByName(T.goals);
  if (existing && existing.getLastRow() >= 5) {
    // Tab already has data — preserve user edits, just backfill missing GoalIDs.
    var cols = resolveGoalCols(existing);
    if (cols && cols.GoalID) {
      var n = existing.getLastRow() - 4;
      var idRange = existing.getRange(5, cols.GoalID, n, 1);
      var ids = idRange.getValues();
      var labelRange = existing.getRange(5, cols.Label, n, 1).getValues();
      var changed = false;
      for (var i = 0; i < n; i++) {
        if (!ids[i][0] && labelRange[i][0]) {
          ids[i][0] = 'G-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
          changed = true;
        }
      }
      if (changed) idRange.setValues(ids);
    }
    return existing;
  }

  // Fresh build — seed from DEFAULT_GOALS
  var sh = freshSheet(ss, T.goals);
  sh.getRange('A1').setValue('GOALS — edit goals here; setup() reads this on next rebuild').setFontSize(14).setFontWeight('bold');
  sh.getRange('A2').setValue('GoalID auto-fills. Visibility: team = rolls up to team dashboard; internal = personal/operating; private = only you.')
    .setFontColor(C.sub).setFontSize(9);

  sh.getRange(4, 1, 1, GOAL_TAB_HEADERS.length).setValues([GOAL_TAB_HEADERS])
    .setBackground(C.head).setFontColor(C.headTx).setFontWeight('bold');

  var rows = DEFAULT_GOALS.map(function (g) {
    var visibility = (g.area && g.area.indexOf('Obj 4') === 0) ? 'internal' : 'team';
    return [
      'G-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8),
      g.area,
      g.rock,
      g.type,
      g.unit || '',
      g.roll,
      g.mTarget,
      g.junTarget,
      g.julTarget,
      g.qGoal,
      g.autoKey || '',
      g.crit || '',
      visibility,
      ''                          // Contributors — left blank for user to fill
    ];
  });
  sh.getRange(5, 1, rows.length, GOAL_TAB_HEADERS.length).setValues(rows);

  // Dropdowns
  var typeDv = SpreadsheetApp.newDataValidation().requireValueInList(['Metric', 'Check'], true).build();
  sh.getRange(5, 4, rows.length, 1).setDataValidation(typeDv);
  var rollDv = SpreadsheetApp.newDataValidation().requireValueInList(['Sum', 'Latest', 'Max', 'Check'], true).build();
  sh.getRange(5, 6, rows.length, 1).setDataValidation(rollDv);
  var visDv = SpreadsheetApp.newDataValidation().requireValueInList(['team', 'internal', 'private'], true).build();
  sh.getRange(5, 13, rows.length, 1).setDataValidation(visDv);

  // Widths + formatting
  var widths = [105, 165, 320, 75, 85, 75, 80, 80, 80, 80, 130, 280, 90, 140];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange(4, 1, rows.length + 1, GOAL_TAB_HEADERS.length).setBorder(true, true, true, true, true, true, C.line, null);
  sh.setFrozenRows(4);
  sh.setFrozenColumns(1);                   // freeze GoalID col
  sh.getRange(5, 3, rows.length, 1).setWrap(true);  // Label
  sh.getRange(5, 12, rows.length, 1).setWrap(true); // Criteria
  // Subtle dim the helper column (GoalID)
  sh.getRange(5, 1, rows.length, 1).setFontColor('#8a8a8a').setFontSize(9);
  return sh;
}

/* =============================== CONNECTION ACTIONS ======================================== *
 * Walk the Connections section of the Config tab. For each row where Test? or Sync? is ticked,
 * run the action against that connector's URL. After completion: untick the checkbox, stamp the
 * corresponding Last Tested / Last Synced cell, and write Status.
 * =========================================================================================== */

// Locate Connection rows on the Config tab. Returns { startRow, count } in 1-indexed coords.
function locateConnectionsBlock(sh) {
  var lastRow = sh.getLastRow();
  var vals = sh.getRange(1, 1, lastRow, 1).getValues();
  var startRow = 0;
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === 'Connector') { startRow = i + 2; break; }
  }
  if (!startRow) return { startRow: 0, count: 0 };
  var count = 0;
  for (var j = startRow - 1; j < vals.length; j++) {
    var a = String(vals[j][0]).trim();
    if (!a || a === 'Setting') break;
    count++;
  }
  return { startRow: startRow, count: count };
}

function testTickedConnections() { runConnectionAction('test'); }
function syncTickedConnections() { runConnectionAction('sync'); }
function syncAllConnections()    { runConnectionAction('sync', /* allRows: */ true); }

function runConnectionAction(action, allRows) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(T.config);
  if (!sh) { ss.toast('No Config tab.', '🎯 Goal Tracker', 4); return; }
  var loc = locateConnectionsBlock(sh);
  if (!loc.startRow) { ss.toast('No Connections section.', '🎯 Goal Tracker', 4); return; }

  var rng = sh.getRange(loc.startRow, 1, loc.count, CONNECTIONS_HEADERS.length);
  var data = rng.getValues();
  var tickCol  = (action === 'test') ? CONN_COL.test - 1 : CONN_COL.sync - 1;
  var stampCol = (action === 'test') ? CONN_COL.lastTested : CONN_COL.lastSynced;

  var ran = 0, ok = 0, errs = 0;
  var now = new Date();
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (!allRows && row[tickCol] !== true) continue;
    var connectorKey = String(row[CONN_COL.connector - 1] || '').trim();
    var url = String(row[CONN_COL.url - 1] || '').trim();
    if (!connectorKey || !url) {
      sh.getRange(loc.startRow + i, CONN_COL.status).setValue('⚠️ URL not set').setFontColor('#a30000');
      sh.getRange(loc.startRow + i, tickCol + 1).setValue(false);
      ran++; errs++;
      continue;
    }
    var spreadsheetId = extractSpreadsheetIdFromUrl(url);
    if (!spreadsheetId) {
      sh.getRange(loc.startRow + i, CONN_COL.status).setValue('⚠️ Bad URL format').setFontColor('#a30000');
      sh.getRange(loc.startRow + i, tickCol + 1).setValue(false);
      ran++; errs++;
      continue;
    }
    var result;
    try {
      result = (action === 'test')
        ? testConnection(connectorKey, spreadsheetId)
        : syncConnection(connectorKey, spreadsheetId);
      sh.getRange(loc.startRow + i, CONN_COL.status).setValue(result.statusText).setFontColor(result.ok ? '#1a7f37' : '#a30000');
      if (result.ok) ok++; else errs++;
    } catch (err) {
      sh.getRange(loc.startRow + i, CONN_COL.status).setValue('❌ ' + String(err).slice(0, 80)).setFontColor('#a30000');
      errs++;
    }
    sh.getRange(loc.startRow + i, tickCol + 1).setValue(false);   // untick
    sh.getRange(loc.startRow + i, stampCol).setValue(now);
    ran++;
  }

  ss.toast(
    'Ran ' + action + ' on ' + ran + ' connection(s). OK: ' + ok + ', Errors: ' + errs + '.',
    '🎯 Goal Tracker', 6
  );
}

// Test a connection: try to open the source and run the connector's selfTest-style check.
function testConnection(connectorKey, spreadsheetId) {
  try {
    var src = SpreadsheetApp.openById(spreadsheetId);
    var name = src.getName();
    // Connector-specific schema check
    if (connectorKey === 'items') {
      var srcSh = src.getSheetByName(ITEMS.sourceTab);
      if (!srcSh) return { ok: false, statusText: '⚠️ tab "' + ITEMS.sourceTab + '" not found in "' + name + '"' };
      var col = resolveItemsCols(srcSh);
      var miss = ITEMS.required.filter(function (k) { return !col[k]; });
      if (miss.length) return { ok: false, statusText: '⚠️ missing headers on "' + name + '": ' + miss.map(function(k){return ITEMS.headers[k];}).join(', ') };
      return { ok: true, statusText: '✓ "' + name + '" — all required headers present' };
    }
    // social / onboarding / generic: just confirm we can open it
    return { ok: true, statusText: '✓ Reachable — "' + name + '"' };
  } catch (e) {
    return { ok: false, statusText: '❌ ' + String(e).slice(0, 120) };
  }
}

// Sync a connection: dispatch to the connector-specific sync function. Items and social/onboarding
// have different shapes — items has its own multi-step sync; social/onboarding feed AutoData.
function syncConnection(connectorKey, spreadsheetId) {
  if (connectorKey === 'items') {
    // Items sync: refresh mirror + month-tab items sections.
    // Calls existing syncItems() machinery, which already uses cfg.sources.items.
    // The URL→ID extraction we just did is reflected via readConfig().sources.items,
    // so syncItems() will pick it up.
    syncItems();
    return { ok: true, statusText: '✓ Items synced (see Items-Mirror tab + month tabs)' };
  }
  if (connectorKey === 'social' || connectorKey === 'onboarding') {
    // These feed AutoData. We run a full syncAuto which iterates all AUTO_METRICS for all sources.
    syncAuto();
    return { ok: true, statusText: '✓ Auto-Data refreshed (see Auto-Data tab for this source\'s metrics)' };
  }
  return { ok: false, statusText: '⚠️ No sync handler for connector "' + connectorKey + '"' };
}

// Read the Goals tab → array of goal objects matching the DEFAULT_GOALS shape.
// All lookups are by header name; column positions can be reordered without breaking.
function readGoals(ss) {
  var sh = ss.getSheetByName(T.goals);
  if (!sh || sh.getLastRow() < 5) return DEFAULT_GOALS.slice();  // fall back to seed
  var cols = resolveGoalCols(sh);
  if (!cols) return DEFAULT_GOALS.slice();
  // Validate required headers
  var missing = GOAL_REQUIRED_HEADERS.filter(function (h) { return !cols[h]; });
  if (missing.length) {
    SpreadsheetApp.getActive().toast('Goals tab missing headers: ' + missing.join(', ') + ' — falling back to defaults.', '🎯 Goal Tracker', 8);
    return DEFAULT_GOALS.slice();
  }

  var n = sh.getLastRow() - 4;
  var lastCol = sh.getLastColumn();
  var data = sh.getRange(5, 1, n, lastCol).getValues();
  var goals = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    var label = r[cols.Label - 1];
    if (!label) continue;                   // skip blank rows
    goals.push({
      goalId:     r[cols.GoalID - 1] || '',
      area:       r[cols.Objective - 1] || '',
      rock:       label,
      type:       r[cols.Type - 1] || 'Metric',
      unit:       r[cols.Unit - 1] || '',
      roll:       r[cols['Roll-up'] - 1] || 'Sum',
      mTarget:    cols['May Target'] ? r[cols['May Target'] - 1] : '',
      junTarget:  cols['Jun Target'] ? r[cols['Jun Target'] - 1] : '',
      julTarget:  cols['Jul Target'] ? r[cols['Jul Target'] - 1] : '',
      qGoal:      cols['Q Goal']     ? r[cols['Q Goal'] - 1]     : '',
      autoKey:    cols.AutoKey       ? r[cols.AutoKey - 1]       : '',
      crit:       cols.Criteria      ? r[cols.Criteria - 1]      : '',
      visibility: cols.Visibility    ? r[cols.Visibility - 1]    : 'team',
      contributors: cols.Contributors ? r[cols.Contributors - 1] : ''
    });
  }
  return goals;
}
