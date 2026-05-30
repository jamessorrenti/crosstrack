# JS Goal Tracker — Setup Guide

A Google Sheets tracker with a quarter dashboard that rolls up from monthly detail tabs, plus a sync engine that pulls live numbers from your existing sheets. You keep an accept-or-override toggle on every auto value.

---

## 1. Stand it up (5 minutes)

Two install paths — pick whichever fits.

### Path A — Apps Script editor (no dev setup, fastest)

1. Open your Google Sheet → **Extensions ▸ Apps Script**. A stub `Code.gs` opens.
2. Delete the stub contents. Paste in everything from [`apps_script/Code.js`](apps_script/Code.js) in this repo.
3. Save. Rename the project to **Goal Tracker** (click *Untitled project* at top).
4. Function dropdown → `setup` → **Run**. Authorize when prompted.
5. Reload the sheet. The **🎯 Goal Tracker** menu appears. From there:
   - **🔄 Sync auto-data now**
   - **📋 Sync items now** (after the source-side setup in §7)
   - **⏰ Install daily auto-sync** (optional — runs auto-sync each morning)

### Path B — clasp (local dev loop)

For when you want git history + edit-locally + `clasp push` to deploy:

```sh
git clone <this-repo> ~/src/goal-tracker
cd ~/src/goal-tracker/apps_script
clasp create --type sheets --title "Goal Tracker" --parentId <YOUR_SHEET_ID> --rootDir .
# Move the new scriptId from apps_script/.clasp.json → ../.clasp.json (replacing placeholder)
rm apps_script/.clasp.json
cd ..
clasp push --force
```

Then follow steps 4–5 above (run `setup` from the editor).

> Day-to-day: edit `apps_script/Code.js` → `clasp push` → reload the sheet → re-run `setup` if structure changed, or just exercise the new menu item.

---

## 2. What got built

| Tab | What it's for |
|---|---|
| **Dashboard** | Q2 overview. Status snapshot cards + every rock with its **Quarter Goal**, **cumulative quarter-to-date result**, **% to Q goal**, and the May/Jun/Jul breakout. This is your "see results" view. |
| **May 2026 / Jun 2026 / Jul 2026** | Monthly detail. Top section = goals. Below that = items for the month, grouped by Initiative (synced from any source you connect). |
| **1:1 Snapshot** | Auto-lists your big rocks' status and anything at risk/off track + blockers, with a manual "My asks" block. Built for your weekly/biweekly manager sync. |
| **Auto-Data** | Where the sync drops live values from your other sheets. You rarely touch it. |
| **Items-Mirror** | Read-only mirror of your items from `Items`, filtered to your owner name and refreshed by **Sync items now**. |
| **Config** | The source spreadsheet IDs (pre-filled). Edit here if a sheet ever moves. |

Only **five columns** ever need your input on a month tab: **Manual Entry · Accept Auto? · Status · This week / Notes · Blockers**. Everything else (Result, %, Updated, all rollups) is automatic. Editable cells are tinted yellow; auto cells are tinted blue.

---

## 3. The accept-or-override pattern (your idea)

Every goal row has four linked columns:

- **Auto-Reported** — filled by the sync from your source sheets.
- **Manual Entry** — what you type (a number, or a checkbox on "Check" rows).
- **Accept Auto?** — a checkbox. ✅ = use the auto value; unchecked = use your manual value.
- **Result** — the single source of truth that feeds % and every rollup: `=IF(Accept AND auto present, Auto, Manual)`.

So if the sync nails it, tick **Accept Auto?** and move on. If a number looks off or isn't wired yet, leave it unticked and type the real figure. The dashboard never cares which path you used — it only reads **Result**.

---

## 4. Wire the auto-data reliably (the important part)

IMPORTRANGE-style links break the moment a source sheet's layout shifts. The robust pattern is to give each source sheet **one tiny, stable output cell per metric** and point the tracker at those. Do this once per source.

On each source sheet, add a tab named **`_API`** with labels in column A and a formula in column B. The tracker reads column B by the addresses already configured in its **Auto-Data** tab.

### a) `JS: Dashboard` (social) → tab `_API`  ✅ CONFIRMED
Your KPI table has columns `Channel | Metric | Data | …`, with the follower count in the **Data** column on the `LinkedIn / Followers` row. The formula below is row-order-proof.

| Cell | Put this |
|---|---|
| `A2` `linkedin_followers` | `B2` → `=SUMIFS('<KPI tab>'!C:C, '<KPI tab>'!A:A, "LinkedIn", '<KPI tab>'!B:B, "Followers")` — replace `<KPI tab>` with the actual name of the tab that holds the Channel/Metric/Data table. Returns the current value (2,123 as of 5/29). |

> **Not available in this sheet:** `JS: Dashboard` does **not** track a LinkedIn post count or customer-spotlight impressions. Those two rows will fall back to **Manual Entry** (and show `⚠️ empty cell` in Auto-Data) until you log them somewhere. If/when you do, add `_API!B3` / `_API!B4` and point the Auto-Data handoff at them.

### b) `<your source sheet>` → tab `_API`  
I couldn't read this sheet's `Items` tab yet (the connector returned "no approval"). Once you approve access — or paste me the header row of the `Items` tab — I'll drop in the exact `COUNTIFS`. The shape will be:

| Cell | Template (adjust column letters once confirmed) |
|---|---|
| `A2` `release_sets_mtd` | `B2` → `=COUNTIFS('Items'!<type col>,"Product Release Comms", '<date col>',">="&EOMONTH(TODAY(),-1)+1, '<date col>',"<="&EOMONTH(TODAY(),0))` |
| `A3` `office_hours_mtd` | `B3` → same, filtered to your Office Hours item |

### c) `ITO Onboarding Tracker - Phase 2` → tab `_API`  
Same situation. Once approved (or you paste the header row + how you mark a row as a won wavemaker), I'll finalize:

| Cell | Template (adjust once confirmed) |
|---|---|
| `A2` `wavemakers_mtd` | `B2` → `=COUNTIFS('<status col>',"<wavemaker flag>", '<date col>',">="&EOMONTH(TODAY(),-1)+1, '<date col>',"<="&EOMONTH(TODAY(),0))` |

Replace the column letters/tab names with your real ones — the formulas above are templates. After this, the only thing the tracker depends on is `_API!B2/B3/B4`, which never moves even when you restructure the source.

> If you'd rather not edit a source sheet yet, just leave that metric unwired — the row falls back to **Manual Entry** automatically, and the **Auto-Data** tab shows a `⚠️ empty cell` so you know which ones still need the `_API` handoff.

To re-map without touching code: edit **Source Key** / **Handoff A1** directly in the **Auto-Data** tab, or the IDs in **Config**.

---

## 5. Monthly rhythm — carrying May into the quarter

- **During the month:** update Manual Entry / Accept Auto / Status / Notes / Blockers as you go. The Dashboard's cumulative **QTD Result** and **% to Q Goal** update live.
- **Roll-up types** (column E) make the quarter math correct automatically: `Sum` adds the months (wavemakers, posts, attendees), `Latest` takes the most recent month (followers), `Max` takes the best (distribution channels), `Check` rolls up to ✓ if done in any month.
- **At month end:** open the next month tab and fill its **Target** cells (left blank on purpose). This is where you "extrapolate from the quarter": for a metric you missed in May, set June's target to the remaining gap (Quarter Goal − May Result) so you still hit the spirit by EOQ. For the ones you crushed, raise the bar.
- The **Quarter Goal** on the Dashboard is editable (yellow) — defaults are roughly 3× May; adjust to your real Q2 ambition.

---

## 6. Troubleshooting

- **No 🎯 menu** → reload the sheet tab after running `setup`.
- **Auto values blank / ⚠️** → the `_API` handoff cell on that source isn't set yet (section 4), or you don't have access to that sheet.
- **A source moved** → update its ID in the **Config** tab; no code change needed.
- **Want to rebuild from scratch** → 🎯 Goal Tracker ▸ Build / rebuild tracker (it clears and re-creates each tab; your typed values on month tabs will be wiped, so export first if needed).
- **Re-run sync manually anytime** → 🎯 Goal Tracker ▸ Sync auto-data now.

---

## 7. Items integration (`Initiative` + `ItemID` + push-back sync)

The tracker pulls your items from your **source sheet** (a tab you connect via the Config tab), surfaces them under each month tab grouped by *Initiative*, and lets you push Status / Notes / Result back to the master Items with an explicit checkbox — so a normal edit never accidentally overwrites the source.

### 7a. One-time augment of Items

Open your source sheet and add **two new column headers** on row 1 — **anywhere on the row, in any column**. The script finds them by name, so if a teammate later inserts or moves columns, nothing breaks.

| Header text | What it does |
|---|---|
| `Initiative` | Generic grouping. Matches a Rock name (e.g., `LinkedIn Content`) to nest a item inline under that Rock on the month tab. Any other non-blank value lands in an "Other Initiatives" group. **Blank = "Other this month."** Leave blank to start — tag as you go. |
| `ItemID` | Stable identifier. Auto-filled by `syncItems`. **Never type into it.** |

Recommended: put them at the far right (today, cols L–M are empty) and right-click ▸ Hide columns until you're ready to expose Initiative to the team. The sync writes to them regardless of visibility.

The script's required-header check will pop a clear dialog if either header is missing or misspelled (e.g., `Initiave`), so you'll know immediately if a teammate accidentally renames one.

### 7b. The Rock vs. Initiative mapping

When `syncItems()` runs, each item falls into one of three buckets on the month tab:

| Initiative value | Where it lands on month tab |
|---|---|
| Exactly matches a known Rock (`Product Release Comms`, `Office Hours`, `Wavemaker Acquisition`, `Community Events`, `Customer Spotlight`, `LinkedIn Content`, `Wavemaker & MacAdmins Triage`, `1:1 Prep`) | **Inline under that Rock**, in a `▸ Rock: <name>` subsection |
| Any other non-blank string (e.g., `IT Factor Newsletter`, `Customer Marketing`, `Personal Brand`) | **"Other Initiatives"**, grouped alphabetically with a `▸ Initiative: <name>` subsection |
| Blank | **"Other this month (un-tagged)"** at the bottom |

This gives you Rocks today, room for personal initiative categories tomorrow, and a sane fallback for items you haven't classified yet.

### 7c. Day-to-day sync mechanic

1. **Pull (read):** click **🎯 Goal Tracker ▸ Sync items now**. The script
   - reads owner-matched rows from the source (substring match on the Owner column, so co-owned rows still appear),
   - auto-backfills any blank `ItemID` cells in the source,
   - refreshes `Items-Mirror`,
   - rebuilds the items section on each month tab, preserving any Status / Notes / Result you'd already typed for the same ItemID.
2. **Edit:** type Status / Notes / Result directly on the month tab. Items rows are the bottom block below the goals; editable cells are tinted yellow.
3. **Push (write back):** tick the `Sync?` checkbox on any row you want to push to Items. Run **🎯 Goal Tracker ▸ Push ticked items → Items**. The script
   - matches by `ItemID` (so it survives row insert/delete shuffling in the source),
   - writes `Status → I Status`, `Notes → K Notes`, `Result → G Actuals`,
   - unticks the checkbox and stamps `Last Synced`.

The `Sync?` checkbox is the contract: untouched = no push, ever. Ticking is the only way a write reaches the source — so a stray edit never overwrites it.

### 7d. Date logic

Items belong to a month if their `Date` cell falls in that month. There's no concept of "quarterly items" in the source — every row I saw has a single date — so the logic is simple. If you ever need to model a item that spans, the right move is to add a second item row with a later date and re-tag with the same `Initiative`.

---

### A couple of judgment calls I made (flag any to change)
- I grouped your goals into four areas — *Push Motions (Big Rocks)*, *Community & Wavemakers*, *Content & Thought Leadership*, *Operating Cadence*. Area is a plain column, so recategorize freely.
- Quarter goals are placeholder defaults; the real numbers are yours to set.
- The triage SLAs (≤4h in-hours, 12:30 ET out-of-hours) are modeled as a **% of questions met** that you log manually — there's no clean auto source for them. If you start logging triage in a sheet, add an `_API` cell and wire it like the rest.
