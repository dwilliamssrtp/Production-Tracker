# Supabase backend — setup

A replacement for the Google Sheet + Apps Script backend. The front end is the same
`index.html`; it will be able to talk to either, chosen by the **API URL** box on the
login screen, so you can switch back at any time.

## Why

Measured against the live Apps Script deployment, calling an endpoint that does **no work
at all** (no sheet touched, server-reported execution time 0–1 ms):

| Round trip | Server work |
|---|---|
| 171 ms | 0 ms |
| 742 ms | 0 ms |
| 1,532 ms | 0 ms |
| 5,549 ms | 1 ms |
| 14,656 ms | — *(returned a 404 HTML page)* |
| 17,831 ms | 0 ms |

The waiting was the platform, not the code — which is why successive rounds of backend
optimisation kept failing to make the app feel faster. Roughly 2 requests in 11 also came
back as an HTML error page rather than data. Moving to the Workspace account made no
difference.

Postgres answers the same questions in single-digit milliseconds, and the history tables
are *indexed* — the sheets had no index, so every lookup scanned every row and got slower
as the plant accumulated history.

## Status

Done so far:

- `01_schema.sql` — tables, indexes, row-level security lockdown
- `02_auth.sql` — sign in / out, accounts, operator key
- `03_seed.sql` — first admin and operator key

Still to come: the production API (work orders, reels, readings, thickness, voiding,
archiving, reports), the front-end adapter, the data migration, and photo storage.

**Run the three files below and tell me it worked before I build on top of them.** If the
shape is wrong it's far cheaper to find out now than after another 1,500 lines.

## Setup

1. Create a project at [supabase.com](https://supabase.com) — free tier is ample for this.
   Pick a region close to the plant.

2. **SQL Editor → New query.** Paste and run each file **in order**:
   `01_schema.sql`, `02_auth.sql`, `03_seed.sql`.

3. After `03_seed.sql`, open the **Messages/Notices** pane in the results. It prints the
   first admin username and password, and the operator QR key. **Copy them now** —
   the password is hashed on the way in and can't be read back.

4. **Project Settings → API.** Copy two values and send them to me (or keep them to hand):
   - **Project URL** — `https://<something>.supabase.co`
   - **anon public** key

### Is the anon key a secret?

No, and it isn't meant to be. It's designed to ship in a web page.

Every table has Row Level Security enabled with **no policies**, which denies all direct
access. The only things the anon key can reach are the `api_*` functions, and each one
checks your session token and role before doing anything. Holding the key lets you *ask*;
it doesn't let you *read*.

This is a real improvement over the Sheet, where anyone with edit access to the file could
bypass every login, role check and void approval by typing into the spreadsheet directly.
There is no equivalent back door here.

**Do not** use the `service_role` key anywhere in the front end — that one does bypass
everything. It should never leave the Supabase dashboard.

## What stays the same

- Admin signs in with username and password; operators scan a reel tag.
- The QR key, tag printing and reprinting work exactly as now.
- Roles: Admin sees everything, Operator sees one reel at a time.

## What changes

- **Passwords are bcrypt** instead of salted SHA-256. Existing hashes can't be converted,
  so the seed sets a new admin password. Everything else migrates.
- **Sessions are a primary-key lookup** rather than a scan of a sheet that grew with every
  tag scan — the thing that made requests get slower through a shift.
- **Nothing is scheduled.** Backups stay manual, as you asked.
