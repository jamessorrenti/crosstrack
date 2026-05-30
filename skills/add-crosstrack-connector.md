---
name: add-crosstrack-connector
description: Generate a new crosstrack connector from a source-sheet URL plus a description of what to track. Produces connector code, a Connections-row instruction to paste into the tracker's Config tab, and (if the source has no stable ID column and the connector will write back) an optional ID-stamper script. Use when the user says "add a connector for X", "I want to track Y from sheet Z", "create a tracker connector", or invokes /add-crosstrack-connector.
---

# Add Tracker Connector

A skill that walks the user through adding a new connector to the **crosstrack** Apps Script Library (see `~/src/crosstrack/CONNECTOR_INTERFACE.md`). Outputs all artifacts inline as copy-pasteable code blocks. **Does not write to disk.** Designed to be usable by anyone running Claude Code, regardless of whether they have the source repo locally.

## When to invoke

Trigger phrases the user might say:
- "Add a connector for [X]"
- "I want to track [Y] from [Z sheet]"
- "Create a tracker connector"
- "/add-crosstrack-connector"
- "Connect [some sheet] to my tracker"

If the user describes a new data source they want to surface in a Goal Tracker, this is the right skill.

## Inputs to gather (ask the user, in order)

1. **What to track** — one sentence in plain English (e.g., "items completed per week from a project tracker").
2. **Connector direction** — *read-only* or *read + write-back*?
   - Read-only: the connector just pulls data (e.g., follower counts).
   - Read + write: the connector updates rows on the source (e.g., the example "tasks" connector pushes Status/Notes/Result back).
   - This decides whether a stable ID is required.
3. **Source sheet URL** — full URL the user pastes.
4. *(Optional)* **Goal context** — if a row should also be added to the user's Goals tab, capture: Objective, KR/label, type (Metric/Check), unit, May/Jun/Jul targets, Q goal, criteria.

## Required reading (load these before generating anything)

- `~/src/crosstrack/CONNECTOR_INTERFACE.md` — the contract every connector implements.
- `~/src/crosstrack/templates/connectors/Connector.template.js` — the shared helpers module (`extractSpreadsheetId`, `resolveHeaders`, `validateRequired`, `connectorError`). Every connector depends on these.
- `~/src/crosstrack/templates/connectors/ReadOnlyConnector.template.js` — paste-source template for connectors that only read.
- `~/src/crosstrack/templates/connectors/WriteCapableConnector.template.js` — paste-source template for connectors that also write back. Requires the source to have a stable ID column.
- `~/src/crosstrack/templates/stampers/IdStamper.template.js` — paste-and-go source-side ID stamper template (used when write-capable but the source has no ID column).

If the user doesn't have the repos locally (teammate scenario), don't read these files — work from the conceptual structure described later in this skill. Mention the repo paths so they can verify against canonical code.

## Workflow

### Step 1 — read the source sheet (if accessible)

If `mcp__google-sheets__fetch` and `mcp__google-sheets__get_metadata` tools are available AND the user has authenticated google-sheets MCP:

1. Extract `spreadsheetId` from the URL: regex `/\/d\/([a-zA-Z0-9_-]{20,})/`.
2. `get_metadata` to list tabs. Ask the user which tab is the data source.
3. `fetch` the first 5 rows of that tab to inspect headers.
4. Print the detected headers and propose a logical-name → header mapping.

If the tools aren't available:
- Ask the user to paste the header row of the relevant tab.
- Build the schema mapping from their input.

### Step 2 — schema mapping

Propose a mapping like:

| Logical name | Source header | Required? | Notes |
|---|---|---|---|
| `name`       | `Customer Name`     | yes | row identity |
| `owner`      | `WM Owner`          | yes | filter target |
| `date`       | `Joined Date`       | yes | for month filtering |
| `status`     | `WM Status`         | optional | only if writing back |
| `id`         | `RecordID`       | **required for write mode** | stable identifier |

For write-capable connectors: if no stable ID column exists on the source, present two options:
- **A. Add an ID column + stamper script.** Skill generates a stamper code (template at end of this file) — user installs it on the source's bound script before using this connector. Recommended.
- **B. Make this connector read-only.** No write() function; key off row numbers. Faster to ship, locks out future write needs.

User picks. If A: also output the stamper code in step 4.

### Step 3 — generate the connector code

Use the template at the bottom of this skill. Fill in:
- `connectorKey` — short kebab-case (e.g., `onboarding`, `social`, `gong-calls`).
- `label` — human-readable.
- `version` — start at `0.1.0`.
- `sourceTab` — from the user.
- `schema.headers` — the logical→source mapping from step 2.
- `schema.required` — the required logical names.
- `schema.idField` — present iff write mode.
- `schema.primaryFields` — only for write-capable connectors (which fields can be pushed back).
- `read()` — copy from TasksConnector.js, swap the filter params to match what makes sense for this source (e.g., for onboarding, filter by `ownerNeedle` and `monthStart/End`; for social, no filtering at all if it's a singleton KPI).
- `write()` — only if write mode. Copy from TasksConnector.js, adapt the push targets.
- `selfTest()` — keep identical to TasksConnector.js's; it just runs read with an empty `ids` set.

### Step 4 — generate ancillary artifacts

Produce, in this order:

**A. Connector file** — full contents, ready to drop into `~/src/crosstrack/apps_script/<ConnectorKey>Connector.js`. Print as a code block.

**B. Connections row** — exactly what to paste into the user's tracker Config tab Connections section:

```
Connector:      <connectorKey>
Description: <one-line description>
URL:         <source URL>
```

**C. (If applicable) Stamper code** — a customized copy of ItemIdStamper.js with renamed namespace (`<source>IdStamper` → use the connector's `connectorKey` as the prefix). Print as a code block.

**D. Library registration** — the line to add to Connector.js to expose the new connector:

```js
function <connectorKey>() { return <ConnectorKey>Connector; }
```

…and update the `connectors()` accessor to include it.

**E. "Allow access" walkthrough** — short numbered list:

1. Save the connector file to `~/src/crosstrack/apps_script/`, run `clasp push`.
2. (If stamper applies) Save the stamper file + install onChange + onOpen triggers per the stamper README.
3. In your tracker sheet's Config tab Connections section, paste the URL and tick `Test?`.
4. Menu: 🎯 Goal Tracker ▸ Test ticked connections. First time triggers Google's "Allow access" prompt — accept.
5. Status updates to `✓ <sheet name> — schema valid` (or an actionable error).
6. Then tick `Sync?` and run the matching sync menu item.

### Step 5 — (optional) goal-row instruction

If the user said the connector should be tied to a goal, also output:

```
On the Goals tab, add a row with:
  Objective:  <Obj N: ...>
  Label:      <KRn: ... or check label>
  Type:       Metric | Check
  Unit:       <unit>
  Roll-up:    Sum | Latest | Max | Check
  May Target: <n>
  Jun Target: <n>
  Jul Target: <n>
  Q Goal:     <n>
  AutoKey:    <connectorKey>__<metric_name>  (matches what connector emits)
  Criteria:   <how to measure>
  Visibility: team | internal | private
```

## Style rules

- Connector keys: kebab-case, short, no `Connector` suffix in the key (the key is `tasks`, not `tasksConnector`).
- File names: `<ConnectorKey>Connector.js` with PascalCase (`OnboardingConnector.js`, `SocialConnector.js`).
- Always set `version: '0.1.0'` on a new connector. Bump deliberately.
- Comments should explain *why*, not *what*.
- Headers in `schema.headers` use the EXACT string from the source sheet — case-sensitive. If the user has a typo on the source, mirror it (or recommend they fix the source first).
- Never write to disk in this skill. Always print artifacts as code blocks for the user to copy.

## Anti-goals

- Don't try to scaffold a whole new tracker. That's a separate "create-tracker" skill (not built yet).
- Don't auto-write the Connections row to the user's Config tab. Explicit consent = user pastes it themselves.
- Don't auto-`clasp push`. User reviews artifacts first.
- Don't propose schema changes to the source sheet beyond adding ID column + stamper. The connector adapts to the source, not the other way around.

## Templates (standalone files in the repo)

When generating connector code, start from the standalone template files in the repo:

| Template | When to use | Path |
|---|---|---|
| **Connector** | Shared helpers (connectorError, resolveHeaders, validateRequired). Every connector depends on these. Paste once per tracker, shared across all connectors. | `templates/connectors/Connector.template.js` |
| **Read-only connector** | The connector only reads from source. No `write()`. Doesn't require a stable ID column on source. | `templates/connectors/ReadOnlyConnector.template.js` |
| **Write-capable connector** | The connector both reads AND writes back. REQUIRES a stable ID column on source. | `templates/connectors/WriteCapableConnector.template.js` |
| **ID stamper** | Source-side script that auto-stamps IDs on new rows. Drop into the source sheet's bound Apps Script. Use when generating a write-capable connector against a source without an ID column. | `templates/stampers/IdStamper.template.js` |

For each placeholder in the template (`<ConnectorKey>`, `<connectorKey>`, schema header names), substitute the user's values before printing the result inline to the user.

## Template: Source-side ID stamper

When the user's connector is write-capable but the source has no ID column, generate a stamper modeled on `~/src/crosstrack/templates/stampers/IdStamper.template.js`. Rules:

- Namespace all functions with the source's connectorKey (e.g., `taskOnChange`, `taskBuildMenu`).
- NEVER declare `function onOpen()`, `function onEdit()`, or `function onChange()` at top level (silent collision risk on shared sheets).
- Wire via installable triggers only.
- README install steps point to triggers, not magic functions.

The full template lives at `~/src/crosstrack/templates/stampers/IdStamper.template.js`. Substitute the two placeholders (`<NAMESPACE>`, `<FRIENDLY_LABEL>`) and print the result inline for the user to paste into their source sheet's Apps Script. The user does NOT need clasp or a local repo to install a stamper — paste into Extensions ▸ Apps Script, edit `STAMPER_CONFIG`, install two triggers per the file header.

## Pre-flight checklist (run mentally before generating output)

- [ ] Have I read CONNECTOR_INTERFACE.md (or have the user confirm what's in it)?
- [ ] Have I confirmed the schema mapping with the user before generating code?
- [ ] If write-capable: is there a stable ID column on the source, or am I generating a stamper too?
- [ ] Have I used exact source header strings (case-sensitive)?
- [ ] Have I bumped to `version: '0.1.0'` (new) — not copied an old version?
- [ ] Are all output artifacts in copy-pasteable code blocks?
- [ ] Have I told the user this skill doesn't write to disk, so they need to save the files themselves?
