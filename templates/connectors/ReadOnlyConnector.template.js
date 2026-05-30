/*************************************************************************************************
 *  READ-ONLY CONNECTOR — paste-and-go template
 *  -----------------------------------------------------------------------------------------------
 *  Use when the connector only reads from the source — it never writes back. Read-only connectors
 *  don't need a stable ID column on the source; row identity comes from `sourceRow` (the
 *  1-indexed row number) which is fine as long as you're not writing.
 *
 *  Substitute placeholders before pasting:
 *    <ConnectorKey>    PascalCase, e.g., 'Tasks', 'Kpi', 'Followers'
 *    <connectorKey>    kebab-case slug,  e.g., 'tasks', 'kpi', 'followers'
 *    plus the schema headers below.
 *
 *  Depends on helper functions defined in Connector.template.js:
 *    openSourceOrThrow, resolveHeaders, validateRequired, connectorError
 *
 *  See CONNECTOR_INTERFACE.md for the contract.
 *************************************************************************************************/

const <ConnectorKey>Connector = {
  key:      '<connectorKey>',
  label:    '<human-readable label>',
  version:  '0.1.0',

  sourceKey: '<connectorKey>',
  sourceTab: '<exact tab name on source>',

  schema: {
    headers: {
      name:  '<source header for name>',
      owner: '<source header for owner>',
      date:  '<source header for date>',
      // add other logical → source-header mappings as needed
    },
    required: ['name' /* , 'date', 'owner', ... */]
    // No idField — read-only connectors don't need one.
  },

  // Reads rows matching `params`. Returns an array of plain objects, each keyed by logical name.
  // params (all optional):
  //   ownerNeedle:  string substring (case-insensitive) — matched against owner field
  //   monthStart:   Date — only rows with date >= this
  //   monthEnd:     Date — only rows with date <= this
  read: function(spreadsheetId, params) {
    params = params || {};
    var src = openSourceOrThrow(spreadsheetId);
    var srcSh = src.getSheetByName(this.sourceTab);
    if (!srcSh) throw connectorError('TAB_NOT_FOUND', 'Tab "' + this.sourceTab + '" not found.');

    var col = resolveHeaders(srcSh, this.schema.headers);
    var headerErr = validateRequired(col, this.schema.required, this.schema.headers);
    if (headerErr) throw headerErr;

    var lastRow = srcSh.getLastRow();
    if (lastRow < 2) return [];

    var lastCol = srcSh.getLastColumn();
    var data = srcSh.getRange(2, 1, lastRow - 1, lastCol).getValues();

    var ownerNeedle = params.ownerNeedle ? params.ownerNeedle.toLowerCase() : null;
    var monthStart  = params.monthStart || null;
    var monthEnd    = params.monthEnd || null;

    var rows = [];
    var schemaHeaders = this.schema.headers;
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (ownerNeedle && col.owner) {
        var owner = String(r[col.owner - 1] || '').toLowerCase();
        if (owner.indexOf(ownerNeedle) === -1) continue;
      }
      if ((monthStart || monthEnd) && col.date) {
        var date = r[col.date - 1];
        if (!(date instanceof Date)) continue;
        if (monthStart && date < monthStart) continue;
        if (monthEnd && date > monthEnd) continue;
      }

      var row = { sourceRow: i + 2 };          // 1-indexed in the source sheet
      for (var key in schemaHeaders) {
        if (col[key]) row[key] = r[col[key] - 1];
      }
      rows.push(row);
    }
    return rows;
  },

  // Read-only diagnostic. Returns { ok, message } or { ok, code, message } on failure.
  selfTest: function(spreadsheetId) {
    try {
      var rows = this.read(spreadsheetId, {});
      return { ok: true, message: 'Schema valid; ' + rows.length + ' rows readable.' };
    } catch (e) {
      return { ok: false, code: e.code || 'UNKNOWN', message: e.message };
    }
  }
};
