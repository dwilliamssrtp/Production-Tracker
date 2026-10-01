# SRTP Production Tracker — setup

**Already deployed once and just need to push an update?** Skip to [Updating later](#updating-later). This round needs a `Code.gs` redeploy (archiving) plus re-hosting `index.html`, and a **re-run of `setup()`** to add the three new `WorkOrders` columns (`Archived`, `ArchivedAt`, `ArchivedBy`). Append-only, no fresh Sheet needed and no data migration.

Two pieces:
- **Backend**: a Google Sheet + Apps Script (`AppsScript/Code.gs`) — this is the database, the JSON API, photo storage (Google Drive), the email sender, and the login/permission check.
- **Front end**: `index.html` — one file, hosted the same way as the splice logger (GitHub Pages). Works on any phone/tablet/PC. The whole site is behind a login now.

## Logins and access

There are two roles, and the role decides everything:

| | **Admin** (you / the controller) | **Operator** (the floor) |
|---|---|---|
| Work orders | create, edit targets | — |
| Reels + QR tags | create, print, reprint | — |
| Dashboard / TV view / Timers / Reports | yes | **no** |
| Open a reel and log against it | yes | yes — **one reel at a time** |
| Readings, thickness, notes, photos, material, problems, Stop/Resume, mark complete | yes | yes |
| Email the report out | yes | no |
| Archive / permanently delete a work order | yes | no |
| Manage logins, rotate the operator key | yes | no |

**An operator never types a password.** They scan the QR tag on the reel; that signs them in *and* opens that reel. Behind the scenes the tag's URL carries a shop-wide **operator key**, which the site trades for a session lasting about one shift (12 hours). The key is wiped out of the address bar immediately so it can't be copied out of the browser bar or a screenshot.

What an operator gets is genuinely just that one reel: no dashboard, no work-order lookup, no way to see another job, no way to edit a target. Typing a work order code into their screen returns "no reel found" rather than the work order. This is enforced on the **server**, not just by hiding buttons — a saved bookmark or a hand-edited URL gets refused the same way.

A few consequences worth knowing up front:

- **The printed tag is the credential.** Treat it like a key: it stays on the reel. Anyone who photographs a tag can sign in as an operator until you rotate the key.
- **Rotating the key invalidates every tag already printed.** Admin > **Rotate key** does this instantly (and kicks out anyone currently signed in by scan). Only do it if a tag has gone somewhere it shouldn't — and then reprint the tag for every reel still in production. There's a **Reprint** button next to each reel when you look up a work order.
- **Tags printed before this update won't sign anyone in** — they have no key in them. They'll still open the site, but the operator will land on the login screen. Reprint them once after deploying.
- **Operator logins with a password exist too**, as a fallback for a tag that won't scan (a torn label, a dead camera). Create one from the Admin panel; it can still only open one reel at a time.

Note on the deployment setting: "Who has access: **Anyone**" only means Google won't demand a Google account. The site's own login is what actually gates the data.

## The model: work orders and pipes

- A **work order** holds the shared targets/recipe reference (from the MDS + recipe cards) — set once by the controller. It also has a **project length** (the total footage the job needs).
- A **pipe** is one reel/run of production under that work order. Since a reel can't always hold the full project length, one work order can have several pipes, each with its own progress through Baseline → Braidline → Coverline, its own readings/notes/photos, and its own **actual length per section**. All pipes on a work order share the same targets.
- The **QR tag is per pipe** — it encodes the pipe code (and the work order code, for the human-readable text on the tag). Scanning it opens that specific pipe's operator view.
- The **dashboard and TV view are grouped by work order**, showing every active pipe underneath — so you can see pipe R1 on Braidline while R2 is still on Baseline, side by side, plus a progress bar toward the work order's total project length (summed from each pipe's finished/Coverline length).

## What's new this round

- **Archive, and permanent delete from the archive.** Finished work orders no longer have to sit on the dashboard forever. Each work order card has an **Archive** button (also on the work order's own page), which takes it off the Dashboard, the Timers page and the TV view — nothing is deleted, and **Restore** in the Archive puts it back exactly as it was. **View archive** sits next to Open TV view on the Dashboard. Deleting is deliberately a second, separate step: it can only be done from the Archive, it shows you exactly what would be destroyed first (reels, readings, thickness checks, notes, photos, material rows, problem reports, downtime events), and you have to retype the work order code to confirm. The server enforces the archive-first rule too, not just the screen. Photos go to your Google Drive trash rather than being erased, so Drive keeps them about 30 days. This is the only action in the app that destroys production history. Admin only.
- **Thickness entry is now a clock face.** Instead of a grid of 16 (Baseline) or 12 (Coverline) numbered boxes, the points are laid out around a drawn pipe cross-section, each input sitting at its own clock position — point 1 at 12 o'clock, numbered clockwise, same order as before. As values go in, the **thinnest point is outlined blue and the thickest orange**, so a die running off-centre reads as a *direction on the pipe* rather than a row number you have to decode. The middle of the clock shows running average wall and how many points are in. Tab still walks the points in order, and nothing changed about what gets saved.
- **New Reports tab (admin only).** One reel's complete record on a single scrolling page: the setup/recipe it was built to (temps, die temps, braid pitch, longs, target OD/wall/length, line speeds), every OD reading, every thickness check *including each individual point measurement*, the OD chart, material usage, notes and problem reports — plus run time, downtime and **actual line speed vs. the recipe target**. It refreshes itself every 20 seconds while you have it open, so it tracks the floor live rather than being a snapshot you have to regenerate. **Print / PDF** prints it as a clean document, one page per section. Operators can't see it or reach it.
- **The whole site is behind a login now, and the dashboard is yours alone.** See [Logins and access](#logins-and-access) above for the full picture. The short version: you get an admin login that sees everything exactly as before; operators scan the reel's QR tag and land straight in that one reel with no password and no route to the dashboard, the TV view, the Timers page, or anybody else's work order. Setting this up takes one extra step — re-run `setup()`, which prints your first admin username and password once — and one bit of housekeeping: **reprint every reel tag**, because tags printed before this update don't carry the key that signs an operator in.
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
5. **Write down the admin username and password it shows you.** `setup()` pops up (and logs) the first admin login — username `controller` and a generated password. It is stored only as a hash, so this is the one and only time you'll see it. Change it after you sign in, from **Admin > Your password**. If you miss it, see [If you lose the admin password](#if-you-lose-the-admin-password).
6. Check the Sheet — you should now see 13 tabs: `WorkOrders`, `Pipes`, `Readings`, `ThicknessChecks`, `Notes`, `Photos`, `EmailLog`, `MaterialUsage`, `ProblemReports`, `DowntimeEvents`, `Accounts`, `Sessions`, `Settings`.

Re-running `setup()` later is safe: it never resets a password and never creates a second admin as long as one active admin exists.

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

1. Open the site — you get the **Sign in** screen. Sign in with the admin username/password `setup()` gave you. The header should then say **Connected** and you should see Home / Dashboard / Timers / Admin in the nav.
2. **+ New work order** → fill in customer/product/targets, including **Project length** and each section's **Target length per pipe**. Save.
3. You'll land on **Add a pipe** — give it a pipe code (e.g. `BL20260128-R1`), create it.
4. You get the QR tag for that pipe — print it, or **Start Baseline entry**.
5. Log a reading, do a thickness check. Click **Mark Baseline complete** — it'll ask for the **actual length** achieved before confirming, then advances status.
6. From Home, look up the work order code again → **+ Add new pipe** → create a second pipe (e.g. `-R2`) on the *same* work order. Notice it starts with a clean slate (Not started on every section) while R1 keeps its own progress.
7. Open **Dashboard** — the work order card shows both pipes side by side with their own status per section, plus the project-length progress bar. Click either pipe row for the full-size detail page with its chart.
8. Open the **TV view** (or `?tv=1`) — same grouped-by-work-order view, big-screen sized. Click a work order card to see its pipes, click a pipe to see its chart, use "← Back" to step out.
9. Open **Reports** → pick the reel → you should get the full live record: run summary with actual vs. target speed, the setup reference, the OD chart, and the thickness points broken out point by point. Hit **Print / PDF** to check it prints as a document rather than a screenshot of the page.
10. **Check the operator side.** Print (or just screenshot) a reel tag, then open it on a phone — or in a private/incognito window, so it doesn't reuse your admin session. Scanning the tag should sign you straight into that reel with no password. Confirm that the nav shows only **Open a reel** and **Sign out** — no Dashboard, no Timers, no Admin — and that typing the *work order* code into "Open a reel" comes back "no reel found". That's the lockdown working.

## If you lose the admin password

Nothing is recoverable from the Sheet — the `Accounts` tab holds only a hash. To get back in, open the Apps Script editor and either:

- delete your admin's row from the `Accounts` tab and run `setup()` again (it creates a fresh `controller` login and prints a new password), or
- run this once from the editor to set a known password on an existing account, then change it from the site:

  ```js
  function resetMyPassword() {
    var salt = makeSalt_();
    updateRowByKey_(SHEETS.ACCOUNTS, 'Username', 'controller', {
      PasswordHash: hashPassword_('pick-a-temp-password', salt), PasswordSalt: salt, Active: true
    });
  }
  ```

The `Sessions` tab is just live logins — deleting rows from it signs those people out and breaks nothing. Expired rows get cleaned up on their own whenever someone signs in.

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
- **The QR key is a shared shop secret, not a per-person identity.** Every tag carries the same key, so scanning tells you *someone on the floor* opened the reel, not *who* — attribution still comes from the operator's typed name on each entry, exactly as before. That's the trade for not making the floor type passwords. If you ever need per-person attribution to be enforced rather than self-reported, the next step is per-operator logins instead of the shared key.
- **Passwords are hashed (salted SHA-256), and traffic is HTTPS**, but this is shop-floor access control, not something to hold data you'd be in trouble for leaking. It keeps the dashboard off the floor and keeps casual visitors out; it isn't hardened against someone determined who already has a tag.
