/*************************************************************************************************
 *  WRITE-CAPABLE CONNECTOR — paste-and-go template
 *  -----------------------------------------------------------------------------------------------
 *  Use when the connector both reads AND writes back to the source. Requires a stable ID column
 *  on the source (e.g., 'TaskID', 'RecordID') so updates can match rows by ID rather than
 *  position, which protects against row inserts/deletes between read and write.
 *
 *  If the source has no stable ID column, install a source-side ID stamper first — see
 *  ~/src/crosstrack/templates/stampers/IdStamper.template.js. The stamper drops into
 *  the source sheet's bound Apps Script and stamps IDs on new rows automatically.
 *
 *  Substitute placeholders before pasting:
 *    <ConnectorKey>    PascalCase, e.g., 'Tasks'
 *    <connectorKey>    kebab-case slug, e.g., 'tasks'
 *    plus schema headers + idField name.
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
      name:    '<source header for name>',
      owner:   '<source header for owner>',
      date:    '<source header for date>',
      status:  '<source header for status>',      // commonly written back
      notes:   '<source header for notes>',       // commonly written back
      result:  '<source header for result>',      // where 'result' is pushed
      id:      '<source header for stable id>'    // REQUIRED for write mode
    },
    required: ['name', 'date', 'owner', 'id'],
    idField:  'id',                               // logical name of the stable id column
    primaryFields: {                              // logical names of fields write() accepts
      status: 'status',
      notes:  'notes',
      result: 'result'
    }
  },

  // Reads rows matching `params`. Returns an array of plain objects, each keyed by logical name.
  // See ReadOnlyConnector.template.js for the parameter shape.
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
    var idSet       = params.ids ? new Set(params.ids) : null;

    var rows = [];
    var schemaHeaders = this.schema.headers;
    var idCol = col[this.schema.idField];

    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      var id = r[idCol - 1];
      if (!id) continue;                          // skip rows without an ID
      if (idSet && !idSet.has(id)) continue;

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

      var row = { sourceRow: i + 2 };
      for (var key in schemaHeaders) {
        if (col[key]) row[key] = r[col[key] - 1];
      }
      rows.push(row);
    }
    return rows;
  },

  // Pushes a batch of updates. Each update specifies the idField value + fields to overwrite.
  // updates: [{ id: '<id>', status: '...', notes: '...', result: '...' }, ...]
  // Returns: { pushed: N, failed: [{ id, reason }] }
  write: function(spreadsheetId, updates) {
    if (!updates || updates.length === 0) return { pushed: 0, failed: [] };

    var src = openSourceOrThrow(spreadsheetId);
    var srcSh = src.getSheetByName(this.sourceTab);
    if (!srcSh) throw connectorError('TAB_NOT_FOUND', 'Tab "' + this.sourceTab + '" not found.');

    var col = resolveHeaders(srcSh, this.schema.headers);
    var idField = this.schema.idField;
    var pushTargets = [idField].concat(Object.keys(this.schema.primaryFields || {}));
    var missing = pushTargets.filter(function (k) { return !col[k]; });
    if (missing.length) {
      var headers = this.schema.headers;
      var names = missing.map(function (k) { return '"' + headers[k] + '"'; }).join(', ');
      throw connectorError('MISSING_HEADER',
        'Cannot push — source missing column(s): ' + names + '. Add them to row 1.');
    }

    // Build an id → row lookup ONCE (faster than per-update single-cell reads).
    var lastRow = srcSh.getLastRow();
    var idColValues = srcSh.getRange(2, col[idField], lastRow - 1, 1).getValues();
    var idToRow = {};
    for (var k = 0; k < idColValues.length; k++) {
      var id = idColValues[k][0];
      if (id) idToRow[id] = k + 2;
    }

    var pushed = 0;
    var failed = [];
    var primaryFields = this.schema.primaryFields || {};

    for (var u = 0; u < updates.length; u++) {
      var upd = updates[u];
      var rowNum = idToRow[upd.id];
      if (!rowNum) {
        failed.push({ id: upd.id, reason: 'NOT_FOUND' });
        continue;
      }
      // Write each declared primary field
      for (var logical in primaryFields) {
        if (logical in upd) {
          srcSh.getRange(rowNum, col[primaryFields[logical]]).setValue(upd[logical] || '');
        }
      }
      pushed++;
    }
    return { pushed: pushed, failed: failed };
  },

  selfTest: function(spreadsheetId) {
    try {
      var rows = this.read(spreadsheetId, { ids: [] });
      return { ok: true, message: 'Schema valid; ' + rows.length + ' rows readable.' };
    } catch (e) {
      return { ok: false, code: e.code || 'UNKNOWN', message: e.message };
    }
  }
};
