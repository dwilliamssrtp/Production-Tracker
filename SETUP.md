# SRTP Production Tracker — setup

**Already deployed once and just need to push an update?** Skip to [Updating later](#updating-later). This round needs a `Code.gs` redeploy (new Baseline recipe-card fields) plus re-hosting `index.html` — append-only, no fresh Sheet needed.

Two pieces:
- **Backend**: a Google Sheet + Apps Script (`AppsScript/Code.gs`) — this is the database, the JSON API, photo storage (Google Drive), and the email sender.
- **Front end**: `index.html` — one file, hosted the same way as the splice logger (GitHub Pages). Works on any phone/tablet/PC, no login required for operators.

## The model: work orders and pipes

- A **work order** holds the shared targets/recipe reference (from the MDS + recipe cards) — set once by the controller. It also has a **project length** (the total footage the job needs).
- A **pipe** is one reel/run of production under that work order. Since a reel can't always hold the full project length, one work order can have several pipes, each with its own progress through Baseline → Braidline → Coverline, its own readings/notes/photos, and its own **actual length per section**. All pipes on a work order share the same targets.
- The **QR tag is per pipe** — it encodes the pipe code (and the work order code, for the human-readable text on the tag). Scanning it opens that specific pipe's operator view.
- The **dashboard and TV view are grouped by work order**, showing every active pipe underneath — so you can see pipe R1 on Braidline while R2 is still on Baseline, side by side, plus a progress bar toward the work order's total project length (summed from each pipe's finished/Coverline length).

## What's new this round

- **Baseline setup now matches the real recipe card — three extruders, not one.** Baseline's recipe card has separate Backer, Co/Bonding, and Co/Inner Liner extruders, each with its own material and temperature zones (Coverline's card only has the one extruder, so that one's unchanged). Work order setup now has Material + RPM + temp zones for all three, and Setup Reference/the Baseline tab shows all three when filled in — headed exactly like the recipe card ("Backer Extruder Size: 3.5"", "Co/Bonding Extruder Size: 1.25"", "Co/Inner Liner Extruder Size: 2""). The sizes are fixed on the machine, so they're not something you enter — they're just always shown that way in the heading. Existing work orders just won't have the two new extruders' values until you edit them and fill those in.
- **Fixed "Longs" — it was never carriers × ends up.** The number of carriers on the braider is a fixed machine constant, not something that varies per job, so it never belonged in the recipe data. Braidline setup now just asks for **Longs — quantity needed** (one number), and the carrier-count field is gone from the form and from the Setup Reference/Braidline tab display.

### From last round
- **Braidline no longer uses Stop/Resume/Bobbin changeout — too much button-pressing for the team.** Braidline's card now just shows **Line speed**: Target speed alongside Actual — current and Actual — average (calculated from the footage marker logged with each OD check) and a Pace % comparing them. No buttons, nothing to remember to press for a changeout. Baseline and Coverline are unchanged — they still use the full Production Timer with Stop/Resume, since that's where "unplanned line down" actually needs a reason logged. The Timers page no longer shows Braidline reels either (nothing to stop/resume there) — it points you to the reel's Braidline tab instead. One side effect: the Dashboard and TV still show a Running/Down timer for every "In progress" section including Braidline, but since Braidline no longer logs downtime, it'll just always read "Running" there now — the real picture for Braidline is the Actual speed number on the reel itself, not that timer. Say the word if you'd like actual speed added to the Dashboard/TV too.
- **Backend sped up — this was the real bottleneck.** Every reel/dashboard load was reading every row of every history sheet (Readings, Notes, Photos, etc.) across *every work order ever entered*, not just the one you're looking at — so it keeps getting slower as the Sheet fills up with history, regardless of your device. Added a 15-second server-side cache for reel and dashboard loads (matches how often the Dashboard/TV already auto-refresh), so repeat loads of the same data are now near-instant instead of re-scanning the whole Sheet — any change you make still shows up immediately since the cache clears itself on writes. Also trimmed a couple of redundant full-sheet reads. This is a `Code.gs` change (see below); as the Sheet keeps growing over months, this buys time but isn't unlimited — if it creeps back up eventually, the next step is archiving old completed work orders out of the live sheets.
- **Fixed slow tab-switching in the operator view.** Photo thumbnails were pointing at Drive's file-view page instead of an actual image URL, so every photo silently failed to load and re-tried that failed request on every tab click — the more photos on a job, the worse it got. Now uses Drive's real thumbnail endpoint. Notes and Photos lists are also capped to the latest 20 (readings already were), same idea — a long-running job doesn't rebuild a giant list every time you switch tabs.
- **No more automatic emails.** Marking a section complete used to fire an email report automatically — since everything's already tracked live in the Sheet/Dashboard, that's gone now. Reports only send when someone taps **Email report now** (still on the pipe detail page and operator view).
- **Actual line speed from footage markers.** The Hourly reading form has an optional **Footage marker (ft)** field — log it alongside an OD check and you'll get *Actual — current* (from the last two footage readings) and *Actual — average* (whole run so far) in ft/min, next to the recipe's Target speed. Needs at least 2 footage-tagged readings in a section to show anything; skip it on checks where you don't want to walk out and read the marker.

### From two rounds ago
- **Uptime/downtime tracking, per reel per section.** Each of a reel's sections (Baseline/Braidline/Coverline) gets a **Production timer** once it's "In progress": running time, an **expected time** (auto-computed from that section's target length ÷ line speed — set **Line speed (ft/min)** on the work order form, same number as your recipe card's "Line Speed (Reference)"), and a pace percentage. Operators hit **Stop production** (picks a reason, plus optional notes) when a line goes down mid-reel, and **Resume production** to restart the clock.
- **"Timers" page** (third nav button) — every currently-active reel's timer, grouped by Baseline/Braidline/Coverline, with Stop/Resume right there. "Open reel" jumps into its full operator view.
- **TV view shows it too** — every reel tile has a Running/Down line with elapsed vs. expected time.
- **Email report** gets a Downtime section per production stage.
- **TV view is interactive**: click a work order card to see all its pipes; click a pipe to see its full OD chart with section tabs. A "← Back" link steps out one level at a time.
- **Setup Reference tile layout**: chiller temp / RPM / temp zones / die temps render as individual labeled tiles.

### From earlier rounds (still current)
- **Problem reports**: a "Report Problem" tab in the operator view — flag an issue with the pipe (section, footage marker, description, photos). Shows up as a red badge on the Dashboard, Work Order Dashboard, TV view, and the pipe's chart until someone resolves it from the same tab.
- **Setup Reference tab**: shows the entire recipe/MDS reference (all three sections at once) so an operator scanning in for setup sees everything without hunting through section tabs.
- **Chart deviation labels**: out-of-tolerance points on the OD chart show their exact deviation from target (e.g. "+0.030""), and problem reports appear as a marked line on the chart at the time they were reported.

## 1. Create the backend

1. Sheet → **Extensions > Apps Script**.
2. Select all the existing code (Ctrl+A), delete it, and paste in the entire contents of `AppsScript/Code.gs` from this folder.
3. Save (Ctrl+S / the save icon).
4. In the function dropdown at the top (next to the bug icon), select **setup**, then click **Run** (▶). Authorize when prompted (Sheets, Drive for photos, Gmail for reports).
5. Check the Sheet — you should now see 10 tabs: `WorkOrders`, `Pipes`, `Readings`, `ThicknessChecks`, `Notes`, `Photos`, `EmailLog`, `MaterialUsage`, `ProblemReports`, `DowntimeEvents`.

## 2. Deploy the API

1. **Deploy > New deployment** → gear icon → **Web app**.
2. Execute as: **Me**. Who has access: **Anyone**.
3. **Deploy**, authorize if prompted, copy the **Web app URL** (ends in `/exec`).

## 3. Configure the front end

Open `index.html`, find near the top of the `<script>`:

```js
var DEFAULT_API_URL = '...';
```

Replace with your `/exec` URL from step 2 (the copy I sent this round already has last round's URL in it — if you created a fresh Sheet/deployment for this round's schema change, you'll have a **new** URL to swap in here).

## 4. Host it

Same as always: paste `index.html`'s contents into your GitHub repo's `index.html` via the web editor, commit. Live at `https://dwilliamssrtp.github.io/production-tracker/`.

## 5. Try it end-to-end

1. Open the site — header should say **Connected**.
2. **+ New work order** → fill in customer/product/targets, including **Project length** and each section's **Target length per pipe**. Save.
3. You'll land on **Add a pipe** — give it a pipe code (e.g. `BL20260128-R1`), create it.
4. You get the QR tag for that pipe — print it, or **Start Baseline entry**.
5. Log a reading, do a thickness check. Click **Mark Baseline complete** — it'll ask for the **actual length** achieved before confirming, then advances status.
6. From Home, look up the work order code again → **+ Add new pipe** → create a second pipe (e.g. `-R2`) on the *same* work order. Notice it starts with a clean slate (Not started on every section) while R1 keeps its own progress.
7. Open **Dashboard** — the work order card shows both pipes side by side with their own status per section, plus the project-length progress bar. Click either pipe row for the full-size detail page with its chart.
8. Open the **TV view** (or `?tv=1`) — same grouped-by-work-order view, big-screen sized. Click a work order card to see its pipes, click a pipe to see its chart, use "← Back" to step out.

## How the pieces fit together

- **Controller** creates the work order once (targets from MDS + recipe card, including project length and per-section target length), then adds a pipe for each reel as production needs it. Pipe codes are typed in manually.
- **Operators** scan a pipe's tag (or type its code) at whichever station it's at, pick the section, and log readings against that pipe. No login — just a name field, remembered per-browser.
- **Marking a section complete** prompts for that pipe's actual length in that section (mirrors the "Good Length" field in your existing `Pipe_Inspection_Template.html`) — this is what feeds the project-length progress bar (summed from each pipe's Coverline/finished length).
- **ID is computed** the same way as your existing inspection tool: average the wall-thickness points, then `ID = OD − 2 × avg wall`. Ovality is max − min across the points.
- The **dashboard and TV** poll every 20 seconds, grouped by work order with every active pipe listed underneath.
- **Email** only sends on-demand via "Email report now" — per pipe, with the work order's overall project-length progress included for context. Nothing sends automatically; everything's already live in the Sheet/Dashboard.
- **Material usage** (Baseline and Coverline) logs each material load's start/end weight per pipe; multiple loads per material are totaled automatically.
- **Problem reports** are pipe-wide (not locked to one section, though you can tag one) — anyone can submit one from the "Report Problem" tab, and anyone can resolve one from the same tab (no separate login/role, consistent with the rest of the app). They surface as a red badge wherever that pipe or its work order shows up, and as a marked point on the OD chart.

## Updating later

Whenever I send a new `Code.gs`:

1. Apps Script editor → select all, delete, paste in the new code, save.
2. Run **setup** again — this only *adds* new columns/tabs (this round: the `ProblemReports` tab, and a `ProblemReportId` column on `Photos`), never reorders existing ones, so nothing you've entered gets scrambled.
3. **Deploy > Manage deployments** → pencil icon → **New version** → Deploy. **Same URL** — `index.html` doesn't need touching unless I say otherwise.

If `index.html` also changed, re-host it the normal way.

## Known limitations / things to sanity-check with Engineering

- **ID/thickness formula** assumes wall thickness gauge readings are individual point measurements (not diametrically opposed pairs). Adjust in `apiAddThicknessCheck_` (`Code.gs`) and `liveThicknessCalc` (`index.html`) if your gauge measures differently — search for `2 * avgThk` / `2*avg`.
- **Tolerance flags** only show once a target + tolerance is set on the work order.
- This system tracks **dimensional QC data** (OD, ID, wall, pitch, longs, length) — it does not digitize the full extrusion recipe (temperature zones, line speed, etc. are reference-only fields), which stays a controlled paper document with Engineering sign-off.
- Apps Script Web Apps have Google's standard quotas (URL fetch/email sends per day) — not a concern at this volume, but worth knowing if usage grows a lot.
