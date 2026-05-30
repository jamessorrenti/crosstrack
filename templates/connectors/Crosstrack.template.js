/*************************************************************************************************
 *  CONNECTOR — paste-and-go helper module for tracker bound scripts
 *  -----------------------------------------------------------------------------------------------
 *  Paste this file into your tracker's bound Apps Script alongside Code.js + your chosen connector
 *  files. It's the shared helper layer every connector uses: URL → ID extraction, header resolution,
 *  typed errors.
 *
 *  Public functions exposed by this file:
 *      extractSpreadsheetId(urlOrId)
 *      resolveHeaders(sourceSheet, schemaHeaders)
 *      validateRequired(idx, required, schemaHeaders)
 *      connectorError(code, message, details)
 *      connectors()
 *      version()
 *
 *  This module is INTENTIONALLY STATELESS. It does not manage connections, source registries,
 *  or know which trackers connect to which sheets. Each tracker owns its own list of connections,
 *  stored in that tracker's own Config tab. Callers always pass a spreadsheetId to connector read()
 *  / write() functions — there is no central lookup.
 *
 *  Rationale: peer-to-peer connections avoid the data-leakage surface of a shared registry.
 *  Each tracker is autonomous; it knows only what its user has explicitly pasted into its Config.
 *
 *  See CONNECTOR_INTERFACE.md for the full connector contract.
 *************************************************************************************************/

/* ============================== PUBLIC API ============================== */

// Returns the list of connectors available in THIS bound script. Each tracker pastes only the
// connectors it actually needs alongside Connector. Customize this function to enumerate the
// connector objects you've added (e.g., return { tasks: TasksConnector, kpi: KpiConnector }).
function connectors() { return {}; }

function version() { return '0.2.0'; }

// Extract a Google Sheets spreadsheetId from a full URL or return the input if it already
// looks like an ID. Convenience for Config tabs that let users paste a URL.
function extractSpreadsheetId(urlOrId) {
  if (!urlOrId) return '';
  var s = String(urlOrId).trim();
  if (!s) return '';
  var m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  // Already an ID?
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  return '';
}

/* ============================== ERRORS ============================== */

function connectorError(code, message, details) {
  var e = new Error(message);
  e.code = code;
  e.details = details || null;
  return e;
}

/* ============================== HELPERS ============================== */

// Resolve connector.schema.headers → 1-indexed column positions on the source sheet.
// Centralized so every connector uses the same logic.
function resolveHeaders(sourceSheet, schemaHeaders) {
  var lastCol = sourceSheet.getLastColumn();
  var headerRow = sourceSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx = {};
  for (var key in schemaHeaders) {
    var headerName = schemaHeaders[key];
    var pos = headerRow.indexOf(headerName);
    idx[key] = (pos >= 0) ? pos + 1 : 0;
  }
  return idx;
}

function validateRequired(idx, required, schemaHeaders) {
  var missing = required.filter(function (k) { return !idx[k]; });
  if (missing.length === 0) return null;
  var names = missing.map(function (k) { return '"' + schemaHeaders[k] + '"'; }).join(', ');
  return connectorError('MISSING_HEADER', 'Source sheet missing required header(s): ' + names, { missing: missing });
}
