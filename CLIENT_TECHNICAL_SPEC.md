# Higher Logic + HubSpot Sync Tool

## Purpose

This application lets a client team:

- Explore communities and members from Higher Logic.
- Build and maintain a local SQLite cache of community/member data.
- Detect recent Higher Logic membership changes (joins/removals).
- Compare those changes with HubSpot contacts.
- Sync selected records to HubSpot (manual or automated).

The UI is browser-based and the server is a Node.js app.

## Who Should Use This

- Operations users maintaining community/member alignment.
- CRM admins validating HubSpot contact status fields.
- Technical admins running scheduled sync automation.

## System Architecture (Client View)

- **Frontend:** static web UI (`/public`) with three tabs: HubSpot, Explorer, Database.
- **Backend:** Express server (`server.js`) exposing internal API endpoints.
- **Local data store:** SQLite (`better-sqlite3`), default file `data/hl-sync.db`.
- **External systems:** Higher Logic API and HubSpot CRM API/OAuth.

## Prerequisites

- Node.js 18+ recommended (Node 20+ preferred).
- Valid Higher Logic API credentials.
- Valid Higher Logic IAM key.
- Optional HubSpot OAuth app or HubSpot private token.

## Installation And Start

1. Install dependencies:
   - `npm install`
2. Configure environment variables (see section below).
3. Start the server:
   - `npm start`
4. Open:
   - `http://localhost:3000`

## Required Configuration

Set these environment variables before starting the app.

### Core (Required)

- `HIGHERLOGIC_IAM_KEY`: Required for all Higher Logic API calls.
- One Higher Logic auth option:
  - `HIGHERLOGIC_BEARER_TOKEN` (simple token mode), or
  - OAuth config (`HIGHERLOGIC_OAUTH_CLIENT_ID`, plus optional secret and related vars).

### Higher Logic OAuth Mode (Recommended for interactive login)

- `HIGHERLOGIC_OAUTH_CLIENT_ID`
- `HIGHERLOGIC_OAUTH_CLIENT_SECRET` (tenant-dependent; optional in some setups)
- `HIGHERLOGIC_OAUTH_REDIRECT_URI` (default: `http://localhost:3000/auth/callback`)
- `HIGHERLOGIC_OAUTH_SCOPE` (default: `openid profile webapi email role offline_access`)
- `HIGHERLOGIC_BASE_URL` (default currently points to `https://members.globalplatform.org`)
- `HIGHERLOGIC_API_USERNAME` and `HIGHERLOGIC_API_PASSWORD` (used in login exchange flow)
- Optional: `HIGHERLOGIC_TENANT_KEY`

### App Login Protection (Optional)

If set, users must sign in to the app first:

- `APP_LOGIN_USERNAME`
- `APP_LOGIN_PASSWORD`

### HubSpot Connectivity (Optional but required for HubSpot features)

Option A: static token:

- `HUBSPOT_ACCESS_TOKEN`

Option B: OAuth:

- `HUBSPOT_OAUTH_CLIENT_ID`
- `HUBSPOT_OAUTH_CLIENT_SECRET`
- `HUBSPOT_OAUTH_REDIRECT_URI` (default: `http://localhost:3000/hubspot/oauth/callback`)
- `HUBSPOT_OAUTH_FLOW` (`classic` or `mcp`, default `classic`)
- `HUBSPOT_OAUTH_SCOPE` (classic flow only; default `crm.objects.contacts.read`)

Optional field mapping override:

- `HUBSPOT_CONTACT_MAP` (JSON mapping of local field -> HubSpot property internal name)

### Sync Performance Tuning (Optional)

- `SYNC_CONTACT_CONCURRENCY` (default: `4`)
- `SYNC_BATCH_DELAY_MS` (default: `75`)
- `SYNC_GETCONTACT_RETRIES` (default: `4`)
- `DATABASE_PATH` (override SQLite location; default `data/hl-sync.db`)

## First-Time Client Setup Checklist

1. Start app and open home page.
2. Confirm **Auth status** is healthy.
3. Click **Login with Higher Logic** (if OAuth mode is enabled).
4. Connect HubSpot (if OAuth mode configured for HubSpot).
5. Go to **Database** tab and run **Re-sync now** once.
6. Verify counts are populated (communities, users, links).
7. Go to **HubSpot** tab and run **Check HL member updates**.
8. Review preview table, then sync a small sample first.

## How To Use (Client Workflow)

## 1) Explorer Tab

Use for direct inspection and validation:

- Load communities.
- Select a community.
- Load members.
- Select member.
- Load member details.
- Optionally load full community member table.

This is best for spot-checking data and troubleshooting individual contacts.

## 2) Database Tab

Use for maintaining local cache and analytics:

- Click **Re-sync now** to run full import:
  - Fetches all communities.
  - Fetches all members per community.
  - Fetches contact details (new users only unless refresh-all enabled).
- Use **Refresh all contact details** only when you need a full rebuild (slower).
- Review:
  - Community list with member counts.
  - Paginated searchable users table with sortable server-side columns.

## 3) HubSpot Tab: Member Updates And Sync

Main operational flow:

1. Set **Past days** (window for Higher Logic updates).
2. Click **Check HL member updates**.
3. Review generated preview:
   - Join/removal flags.
   - Boolean task-force fields.
   - HubSpot existence status.
4. Select rows to sync.
5. Click **Sync selected to HubSpot**.

Notes:

- Sync uses email as the HubSpot identity key.
- Contact properties are updated using mapped standard + custom fields.
- If HubSpot custom fields are missing/unresolved, those fields are skipped.

## 4) Automation

Automation executes periodic update-and-sync runs:

- Enable automation.
- Set run interval in days.
- Set lookback window in days.
- Save automation config.
- Optionally trigger **Run now**.

Automation run behavior:

- Collect Higher Logic membership updates for configured lookback.
- Apply updates to local SQLite links/users.
- Sync mapped rows to HubSpot.
- Record last run result and next run timestamp.

## Local Database Model

The database contains:

- `communities`: known communities.
- `users`: contact details and metadata.
- `user_communities`: many-to-many membership links.
- `sync_meta`: global sync status/timestamps/errors.

Operational implication:

- The app can continue to report previously synced data even when upstream APIs are temporarily unavailable.

## Security And Access Notes

- API tokens are handled server-side.
- Auth/session cookies are `HttpOnly` and `SameSite=Lax`.
- In production, run behind HTTPS and set secure deployment defaults.
- Do not expose this tool publicly without network restrictions.
- Treat environment variables as secrets.

## Expected Errors And What They Mean

- `Missing HIGHERLOGIC_IAM_KEY`: core HL configuration not present.
- `Not authenticated`: no active HL bearer available in env/session.
- `Sync already running`: full DB sync already in progress.
- `HubSpot is not connected`: no HubSpot token or OAuth session.
- `Set HUBSPOT_ACCESS_TOKEN first`: endpoint requires direct token mode.
- HubSpot property resolution issues: custom field labels/internal names do not match app expectations.

## Recommended Client Operating Procedure

- Daily/weekly:
  - Run **Check HL member updates**.
  - Review and sync selected records.
- Periodic:
  - Run **Database Re-sync now** (or schedule during off-hours).
- Before enabling full automation:
  - Validate field mapping on a test subset.
  - Confirm HubSpot custom properties exist and types match expected values.

## Deployment Guidance

- Run this app in an internal environment (VPN/private network).
- Use process management (for example PM2/systemd/container runtime).
- Add reverse proxy + TLS.
- Back up `data/hl-sync.db` if local state is operationally important.

## Support Handoff Data To Provide

When raising an issue, collect:

- Timestamp of action.
- Active tab and operation attempted.
- Error message from UI.
- Server console log snippet.
- `/api/debug/auth` output (redact secrets before sharing).
- `/api/sync/status` and `/api/automation/status` output.
