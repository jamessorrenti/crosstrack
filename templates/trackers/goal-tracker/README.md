# Goal Tracker

A Google Sheets goal tracker — quarterly OKR-shaped goals with cumulative roll-up across monthly detail tabs, a Connections section for pulling data from other sheets, a Dashboard, and a 1:1 Snapshot.

This is a **template**. Clone, point at your own Google Sheet via `clasp`, edit the Goals + Config tabs to fit your context, and run `setup()`.

## What it builds

| Tab | What it's for |
|---|---|
| **Dashboard** | Quarter overview — status snapshot, every KR with its quarter goal, cumulative QTD result, % to Q goal, and monthly breakouts. |
| **Month tabs** (×3) | Monthly detail. Top section = goals. Below = items for the month, grouped by Initiative (synced from any source you connect). |
| **Goals** | Your editable list of goals — Objective / KR / per-month targets / quarter goals / criteria / visibility. Drives what shows on month tabs and Dashboard. |
| **Config** | Connections to other sheets (URL paste + Test? / Sync? checkboxes) + Settings (your name, email, quarter label, month names). |
| **Auto-Data** | Live values pulled from connected sources. |
| **Items-Mirror** | Read-only mirror of items from a connected source sheet. |
| **1:1 Snapshot** | KR-level status pull for your weekly/biweekly manager sync. |

## Set up (one-time)

Two paths — pick the one that fits your workflow.

### Path A — Apps Script editor (no dev setup required, most common)

1. Open your Google Sheet (any sheet will work — fresh blank one is fine).
2. **Extensions ▸ Apps Script**. The editor opens with a stub `Code.gs`.
3. Delete the stub contents. Paste in everything from [`apps_script/Code.js`](apps_script/Code.js).
4. **Save** (Ctrl/Cmd+S). Click *Untitled project* at top, rename to **Goal Tracker**.
5. Function dropdown → `setup` → **Run**. Authorize when prompted.
6. Reload the sheet — **🎯 Goal Tracker** menu appears.

### Path B — clasp (local dev loop)

For when you want git history + a local editor + push updates without re-pasting:

```sh
git clone <this-repo> ~/src/goal-tracker
cd ~/src/goal-tracker/apps_script
clasp create --type sheets --title "Goal Tracker" --parentId <YOUR_SHEET_ID> --rootDir .
# Move the new scriptId from apps_script/.clasp.json into the project-root .clasp.json:
#   cat .clasp.json                            # note the scriptId
#   (paste into ../​.clasp.json, replacing the placeholder)
rm apps_script/.clasp.json
cd ..
clasp push --force
```

Then in the sheet → Apps Script editor → function dropdown: `setup` → Run.

### After setup (either path)

1. **Config tab**:
   - Settings section: fill in your name, email, quarter label, month names.
   - Connections section: empty by default — add rows for any sheets you want this tracker to read from. See [crosstrack](https://github.com/...) for the connector templates.
2. **Goals tab**: empty by default — add rows. Use the `Visibility` column to mark which goals are `team` / `internal` / `private` (for future team rollup).
3. **🎯 Goal Tracker ▸ Build / rebuild tracker** to rebuild month tabs / Dashboard from your new Goals + Settings.

## Adding a connector connection

Use the [`add-crosstrack-connector`](https://github.com/.../crosstrack/blob/main/skills/add-crosstrack-connector.md) Claude Code skill, OR follow the [CONNECTOR_INTERFACE.md](https://github.com/.../crosstrack/blob/main/CONNECTOR_INTERFACE.md) contract manually.

For each connector you add:
1. Generate the connector file (printed by the skill or written by hand).
2. Get it into the bound Apps Script:
   - **Path A**: Apps Script editor → File ▸ New ▸ Script file → paste the connector code.
   - **Path B**: drop the `.js` file into `apps_script/` locally, `clasp push`.
3. Same for `Connector.template.js` — paste once (shared by all connectors).
4. Add a Connections row in the Config tab with the source URL.
5. 🎯 Goal Tracker ▸ **Test ticked connections** → 🎯 Goal Tracker ▸ **Sync ticked connections**.

## Files

- `apps_script/Code.js` — the bound script. Builds all tabs, drives sync menus, owns dashboards.
- `apps_script/appsscript.json` — manifest (V8, America/New_York, Stackdriver logging).
- `.clasp.json` — bound-script ID (placeholder until you bind to your sheet).
- `SETUP_GUIDE.md` — end-user setup walkthrough.

## License

[your choice]
