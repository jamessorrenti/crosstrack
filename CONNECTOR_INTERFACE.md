# Crosstrack — Connector Interface (v1)

A `Connector` is a self-contained adapter between an **external data source** (a Google Sheet, a Doc, an API) and a **tracker** (a Goal Tracker sheet, future team rollup, etc.).

Each connector owns:
- Its source schema (header names, required columns).
- How to identify rows stably (the `idField`).
- How to read data filtered by params.
- How to write specific updates back, safely.

The connector itself owns:
- The connector registry.
- Cross-cutting concerns: error handling, ID validation, transcript of changes.
- Nothing source-specific. Source-specific code lives in connectors.

---

## Shape of a connector

```js
const TasksConnector = {
  // ---- IDENTITY ----------------------------------------------------------
  key:        'tasks',                    // unique slug; tracker addresses the connector by this
  label:      'example task sheet',

  // ---- SOURCE LOCATION ---------------------------------------------------
  // The connector doesn't hardcode IDs; callers pass them in. The connector exposes
  // a SourceRegistry (see below) that maps logical keys to spreadsheet IDs.
  sourceKey:  'tasks',                    // matches a SourceRegistry entry
  sourceTab:  'Tasks',

  // ---- SCHEMA ------------------------------------------------------------
  // All lookups are by HEADER NAME. Column positions are runtime-resolved.
  // Required headers must exist on the source or read() / write() throw.
  schema: {
    headers: {
      name:        'Name',
      description: 'Description',
      category:    'Category',
      type:        'Type',
      date:        'Due Date',
      goals:       'Goals',
      actuals:     'Actuals',           // where 'result' is pushed back
      owner:       'Owner',
      status:      'Status',
      links:       'Links',
      notes:       'Notes',
      initiative:  'Initiative',
      itemId:    'ItemID'
    },
    required: ['name', 'date', 'owner', 'initiative', 'itemId'],
    idField:  'itemId',               // stable identifier
    primaryFields: {                     // logical → write-back semantics
      owner:  'owner',
      date:   'date',
      status: 'status',
      result: 'actuals',                // 'result' on tracker maps to 'actuals' on source
      notes:  'notes',
      tag:    'initiative'              // grouping label
    }
  },

  // ---- READ --------------------------------------------------------------
  // Pulls rows matching `params`. Returns array of plain objects keyed by logical name.
  // Caller is responsible for downstream filtering / display.
  read: function(spreadsheetId, params) {
    // params (all optional):
    //   ownerNeedle:   string substring (case-insensitive) — matched against owner field
    //   monthStart:    Date  — only rows where date >= this
    //   monthEnd:      Date  — only rows where date <= this
    //   ids:           string[] — only rows whose idField is in this set
    //
    // Returns: [
    //   {
    //     itemId:   'T-abc12345',     // the schema.idField value
    //     sourceRow:  47,               // 1-indexed row in the source sheet (for write-back)
    //     name:       'IT Factor',
    //     description: 'Weekly IT Factor Email',
    //     date:       Date(2026, 5, 12),
    //     owner:      'Owner Name',
    //     status:     'Live',
    //     initiative: 'IT Factor Newsletter',
    //     ...                            // all other schema.headers
    //   },
    //   ...
    // ]
    //
    // Throws ConnectorError with code 'MISSING_HEADER' if required headers absent.
  },

  // ---- WRITE -------------------------------------------------------------
  // Pushes a batch of updates. Each update specifies the idField value + fields to overwrite.
  // The connector MUST validate that the row at sourceRow still has the matching id (handles
  // row inserts/deletes since the last read), and either rebind to the correct row or reject.
  write: function(spreadsheetId, updates) {
    // updates: [
    //   { itemId: 'T-abc12345', status: '🟢 On track', notes: '...', actuals: '...' },
    //   ...
    // ]
    //
    // Returns: {
    //   pushed:  3,
    //   failed:  [{ itemId: 'T-xyz...', reason: 'NOT_FOUND' }, ...]
    // }
    //
    // The connector NEVER generates IDs in write(). IDs are owned by the source (e.g., the
    // the ID stamper bound to your source sheet). If an update references an unknown ID,
    // write() reports it in `failed` and skips it.
  }
};
```

## How tracker connections work (peer-to-peer)

**The library has NO shared registry.** This is deliberate. Each tracker owns its own list of connections, stored in that tracker's Config tab. The library is pure connector code — given a spreadsheetId, it knows how to read/write. It does not know or care which trackers connect to which sheets.

### Consumer pattern

Each tracker's Config tab has a "Connections" table:

| Connector | URL (user pastes) | Status | Sync? | Last Synced |
|---|---|---|---|---|
| `tasks` | `https://docs.google.com/spreadsheets/d/abc…/edit` | ✓ Connected · 47 rows | ☐ | 5/29 8:15pm |
| `team`    | (blank — not configured) | — | ☐ | — |

The bound script reads the URLs, extracts spreadsheet IDs via `Crosstrack.extractSpreadsheetId(url)`, and passes those IDs to the relevant connector's `read()` / `write()`.

### Security model

- **Each connection is an explicit user action.** Pasting a URL into Config and ticking Sync? is the consent signal.
- **Google's OAuth flow gates first access.** The first time a bound script tries to open a new URL, Google prompts the user (the script runs as the user, who must have access to the sheet themselves).
- **No tracker can discover or read sources it wasn't explicitly told about.** No central registry to query.
- **Bidirectional ≠ symmetric.** A team tracker pulling from an employee tracker is one connection (configured in the team tracker's Config). An employee tracker pulling team goals from the team tracker is a *separate* connection (configured in the employee tracker's Config). Either can exist without the other.

## Error handling

Connectors throw typed errors:

```js
class ConnectorError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
```

Standard codes:

- `MISSING_HEADER` — a required header is missing on the source.
- `NOT_FOUND` — write update references an id not present in the source.
- `STALE_REF` — sourceRow no longer holds the expected id (row shift). Connector auto-rebinds before treating as `NOT_FOUND`.
- `PERMISSION_DENIED` — caller can't open the source.
- `UNKNOWN_SOURCE` — `sourceKey` not in the SourceRegistry.

## What's NOT a connector's job

- **ID generation.** That's done by an ID stamper dropped into the source sheet's own bound Apps Script. See `templates/IdStamper.template.js` for the paste-and-go template — owner of the source sheet customizes ~5 lines, pastes into Extensions ▸ Apps Script, installs two triggers. No clasp or repo required. Connectors read existing IDs; they never mint new ones.
- **Display, grouping, dashboards.** The tracker decides how to present read() output.
- **Cross-source joins.** That's the team rollup's job (which itself uses N connectors).

## Source-side stampers — separate from connectors

A stamper is a small, parametric Apps Script that lives on the source sheet (NOT in this library) and stamps stable IDs on new rows. It's the source-side companion to a write-capable connector. Reasons to keep it separate from connectors:

- **Different audience.** Connectors are consumed by tracker developers (Claude Code users with clasp setups). Stampers are dropped into source sheets by source owners — often non-developers — who need a paste-and-go path.
- **Different lifecycle.** A connector's `read()`/`write()` can evolve while the source sheet's stamper stays put. Decoupling avoids forcing source-sheet redeploys for every connector change.
- **Different security boundary.** Putting a stamper on a team-owned source sheet is a deliberate, separate act from publishing a library — and may involve a different person.

The template handles all the defensive design (no magic-named function declarations, installable triggers only, namespaced names, header-resolved columns).

## Versioning

Connectors declare a `version`:

```js
const TasksConnector = { key: 'tasks', version: '1.0.0', ... };
```

The connector exposes the registry; consumers can check versions and degrade gracefully when needed. Breaking schema changes bump the major version.

## Testing surface

Every connector SHOULD include:

- A `selfTest(spreadsheetId)` function that runs read({ids:[]}) and reports schema status without writing.
- A typed schema declaration so the connector can pre-flight check before any read/write.
