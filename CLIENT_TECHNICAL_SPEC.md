# Higher Logic -> HubSpot Sync Operations Guide

## Scope

This document is focused on the **main HubSpot tab workflow** only:

- **Manual sync**: user selects which records to sync.
- **Auto-sync**: scheduled sync runs.

Explorer/Database tabs are supporting utilities and are intentionally minimized here. Community → HubSpot property mappings are configured on the **Database** tab and documented below because they control which boolean fields sync writes.

## What The Main Tab Does

The HubSpot tab runs this pipeline:

1. Pull recent member updates from Higher Logic (joins/removals) for a selected day window.
2. Match those updates to local users (by email/contact key relationship).
3. Build a preview table with sync flags and HubSpot existence.
4. Sync only selected rows to HubSpot (manual mode), or sync all impacted rows in a scheduled run (auto mode).

## Required Credentials For Sync

### Higher Logic (required)

- `HIGHERLOGIC_IAM_KEY`
- OAuth route (recommended):
  - `HIGHERLOGIC_OAUTH_CLIENT_ID`
  - `HIGHERLOGIC_OAUTH_CLIENT_SECRET` (if required by tenant)
  - `HIGHERLOGIC_OAUTH_REDIRECT_URI`
  - `HIGHERLOGIC_API_USERNAME`
  - `HIGHERLOGIC_API_PASSWORD` (**admin/API account required**)
- OR static token route:
  - `HIGHERLOGIC_BEARER_TOKEN`

### HubSpot (required for syncing contacts)

- OAuth:
  - `HUBSPOT_OAUTH_CLIENT_ID`
  - `HUBSPOT_OAUTH_CLIENT_SECRET`
  - `HUBSPOT_OAUTH_REDIRECT_URI`
- OR static token:
  - `HUBSPOT_ACCESS_TOKEN`

## Important Login Behavior (HL)

The app requires admin/API username + password because it exchanges OAuth into an API bearer via Higher Logic `Authentication/Login`.

If HL token expires, sync calls fail with:

- `Higher Logic error 401: {"Message":"Authentication Token has expired.","ErrorCode":20}`

Recovery:

1. Click **Re-login with Higher Logic**.
2. Complete login flow.
3. Retry manual sync or run-now automation.

## Manual Sync (Primary Operational Flow)

This is the core day-to-day process.

1. Go to **HubSpot** tab.
2. Set **Past days** (usually 7-60 depending on your ops cycle).
3. Click **Check HL member updates**.
4. Review the generated table:
   - `member_update_join` and `member_update_removal`
   - `hubspot_exists`
   - mapped task-force/committee booleans
5. Select rows using checkboxes.
6. Click **Sync selected to HubSpot**.
7. Confirm status message reports attempted vs synced counts.

### Selection Strategy (Recommended)

- Start with small batches on first run.
- Prioritize rows with `member_update_join` or `member_update_removal = true`.
- Re-run preview before syncing if a long time has passed since check.

### What Gets Written To HubSpot

- Identity key: **email**.
- Standard properties: name, company, title, city/state/zip/country.
- Membership/task-force/committee booleans from **enabled** community mappings.
- Only resolved HubSpot properties are written (unresolved mappings are skipped).

## Community → HubSpot Property Mappings

Mappings are stored in SQLite (`hubspot_community_mappings`) and managed in the UI. They are no longer hardcoded in application code.

### Mapping Model

Each enabled mapping has:

| Field | Meaning |
|---|---|
| `community_key` | Higher Logic community GUID |
| `label` | Display name in preview tables |
| `field_key` | Stable internal key used on sync rows (e.g. `sesip_committee_member`) |
| `hubspot_property` | HubSpot contact property **internal name** (e.g. `hl_sesip_committee_member`) |
| `enabled` | Soft on/off; disabled mappings are ignored by sync/preview |
| `sort_order` | Column order |

On first database open, the table is seeded with the historical default committee/task-force mappings.

### How Sync Uses Mappings

1. Load enabled mappings from SQLite.
2. For each user, set each mapping’s `field_key` to `true`/`false` based on local membership in that `community_key`.
3. Resolve each `hubspot_property` against HubSpot contact properties (see below).
4. Write only properties that resolve successfully.

Preview tables (HL rows and HubSpot-found rows) build boolean columns dynamically from the same enabled mappings.

### Property Resolution

For each mapping, the app:

1. Looks up the configured HubSpot **internal name** in the portal’s contact properties.
2. If not found, tries an exact **label** match against HubSpot property labels.
3. If both fail → `resolvedBy: "unresolved"`.

Unresolved fields:

- appear as `(unresolved)` in the HubSpot-found preview headers,
- are listed in the status message after **Check HL member updates**,
- are **not written** during sync.

Typical causes: property missing in HubSpot, wrong internal name, or label mismatch for the fallback.

### Admin APIs

- `GET /api/hubspot/community-mappings` — list mappings (`?enabledOnly=1` optional)
- `POST /api/hubspot/community-mappings` — create
- `PUT /api/hubspot/community-mappings/:id` — update
- `DELETE /api/hubspot/community-mappings/:id` — delete
- `GET /api/hubspot/contact-properties` — HubSpot contact property picker source

### Where To Configure In The UI

**Database** tab → **HubSpot community mappings**:

1. Ensure communities are synced (`Re-sync now`) so the community dropdown is populated.
2. Create the HubSpot contact boolean property first (if it does not exist).
3. Add or edit a mapping: community, label, field key, HubSpot property internal name.
4. Use **Refresh HubSpot properties** to reload the property datalist.
5. Re-run **Check HL member updates** on the HubSpot tab to see new columns and resolution status.

After any mapping change, re-check member updates (and optionally automation **Run now**) so operators confirm resolution before relying on sync.

## Auto-Sync (Scheduled Operations)

Auto-sync is for unattended continuous alignment.

### Configure

1. In **Automation** section, enable automation.
2. Set **Run every X days** (`intervalDays`).
3. Set **Sync changes from past Y days** (`lookbackDays`).
4. Click **Save automation**.
5. Optional: click **Run now** to validate immediately.

### Runtime Behavior

Each cycle:

1. Pull HL member updates for `lookbackDays`.
2. Apply updates to local membership/user state.
3. Build sync rows.
4. Sync rows to HubSpot by email.
5. Store run result:
   - rows considered
   - attempted/synced
   - error count
   - last/next run timestamps

### Tuning Guidance

- If updates are sparse: interval 1-3 days, lookback 7-14 days.
- If updates are frequent: interval daily, lookback 2-7 days.
- Keep lookback larger than interval to avoid missing delayed updates.

## Manual Vs Auto-Sync Decision

- Use **manual sync** when human review/approval is required.
- Use **auto-sync** when mapping is stable and process is trusted.
- Common model: automation enabled + manual sync for exceptions.

## Error Handling For Sync Operators

### Higher Logic Errors

- `Token has expired (ErrorCode 20)`: re-login required.
- `Missing HIGHERLOGIC_API_USERNAME/HIGHERLOGIC_API_PASSWORD`: OAuth callback cannot resolve HL API bearer.
- `Not authenticated`: no valid HL bearer in session/env.

### HubSpot Errors

- `HubSpot is not connected`: connect OAuth or provide `HUBSPOT_ACCESS_TOKEN`.
- Field/property mismatch / **Unresolved custom fields**: HubSpot contact property missing or wrong internal name in the community mapping. Fix on Database → HubSpot community mappings (copy exact internal name from HubSpot), then re-check member updates.

### Job State Errors

- `Sync already running`: wait for current run to finish, then retry.
- Automation running: avoid parallel manual bulk sync at same moment.

## Minimal Supporting Setup (Outside Main Tab)

- **Database tab**: run one initial full `Re-sync now` before relying on member update sync.
- **Database tab → HubSpot community mappings**: confirm enabled mappings and that HubSpot properties resolve (no unresolved fields after a member-updates check).
- **Explorer tab**: optional spot-check only.

## Daily Operator Runbook

1. Confirm HL and HubSpot are connected.
2. On HubSpot tab, run **Check HL member updates**.
3. Review and **Sync selected to HubSpot**.
4. Check sync status message for failures.
5. If auto-sync is enabled, verify last run and next run times.

## Weekly Admin Runbook

1. Re-validate HL and HubSpot auth.
2. On Database → HubSpot community mappings, confirm mappings are correct; after **Check HL member updates**, confirm no unresolved custom fields.
3. Review automation settings (`intervalDays`, `lookbackDays`).
4. Trigger **Run now** after any credential or mapping change.

## Security Notes

- Keep HL admin/API credentials in environment variables only.
- Do not share raw `/api/debug/auth` outputs without redaction.
- Run app behind internal network + HTTPS in production.
