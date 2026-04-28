# User Guide - Main Sync Tab

## What This App Is For

This app helps you sync member changes from Higher Logic into HubSpot contacts.

Your main workspace is the **HubSpot** tab. This is where you:

- check recent member changes,
- choose which users to sync,
- run sync manually,
- or let automation run on a schedule.

## Before You Start

Make sure:

- you have the **app access username/password** (for the app sign-in screen),
- the app is running,
- you are logged in to Higher Logic in the app,
- HubSpot is connected.

At the top of the page, you should see authentication status for both Higher Logic and HubSpot.

## App Access Login (Username/Password)

This app can be protected with its own login screen.

- If prompted, enter the app username and password provided by your admin.
- This login is separate from Higher Logic and HubSpot authentication.
- After app login, continue with Higher Logic login and HubSpot connection if needed.

If you do not have app login credentials, contact your internal administrator.

## Daily Flow (Recommended)

1. Open the **HubSpot** tab.
2. In **Past days**, choose the period you want to review (for example 7, 14, or 30).
3. Click **Check HL member updates**.
4. Review the preview table.
5. Select the users you want to sync.
6. Click **Sync selected to HubSpot**.
7. Check the status message to confirm how many users were synced.

## How To Read The Preview Table

Important columns:

- **Join event**: user recently joined a community.
- **Removal event**: user was recently removed from a community.
- **Exists in HubSpot**: whether a matching HubSpot contact was found.
- Task force / committee columns: boolean values sent to HubSpot custom fields.

Tip:

- If you are not sure, sync a small batch first.

## Manual Sync (Step-by-Step)

### 1) Choose Date Range

Set **Past days** based on how often you run sync:

- frequent sync: 7 days
- weekly review: 14 days
- monthly cleanup: 30-60 days

### 2) Load Member Updates

Click **Check HL member updates** and wait for the table to load.

### 3) Select Users

Use row checkboxes to select only the users you want to push to HubSpot.

Suggested approach:

- prioritize rows with join/removal events,
- leave uncertain rows for a second pass.

### 4) Run Sync

Click **Sync selected to HubSpot**.

### 5) Verify Result

Read the status text after sync. It tells you:

- how many records were attempted,
- how many were created/updated,
- whether there were errors.

## Auto-Sync (Scheduled Sync)

Use this when you want the app to sync changes automatically.

### Setup

1. In the **Automation** section, enable **Enabled**.
2. Set **Run every X days**.
3. Set **Sync changes from past Y days**.
4. Click **Save automation**.
5. Optionally click **Run now** to test immediately.

### Good Starting Values

- **Run every:** 1 day
- **Lookback:** 7 days

This setup is safe for most teams because lookback is larger than run frequency.

## When To Use Manual vs Auto

- Use **Manual** when you want human review before sending updates.
- Use **Auto** when your process is stable and you want continuous syncing.
- Common setup: automation enabled + manual sync for exceptions.

## How To Use The Database Tab

Use this tab to build/refresh the local data used by the app.

### When To Use It

- first-time setup,
- after long downtime,
- after major data changes in Higher Logic.

### Main Action: Re-sync now

1. Open the **Database** tab.
2. Click **Re-sync now**.
3. Wait for progress to complete.
4. Check that stats are populated (communities, users, memberships).

### Optional: Refresh All Contact Details

- Enable **Refresh all contact details** only when needed.
- This is slower because it re-fetches all contact details.
- Use it for deep refresh/correction, not daily operation.

### Useful Views In This Tab

- **Communities in database**: confirms communities and member counts were imported.
- **Users in database**: search, sort, and page through cached users.

## How To Use The Explorer Tab

Use this tab for investigation and spot checks.

### Typical Explorer Flow

1. Click **Load communities**.
2. Select a community from the list.
3. Click **Load members**.
4. Select a member.
5. Click **Load member details**.

### Community Member Table

- Click **Load member table** after selecting a community.
- Use this to quickly review a full community list in table format.

### When Explorer Helps Most

- validating one specific user,
- checking one specific community,
- confirming source data before manual sync.

## If Something Fails

### Token Expired (Higher Logic)

If you see an authentication expired error:

1. Click **Re-login with Higher Logic**.
2. Complete login.
3. Run the action again.

### HubSpot Not Connected

If sync says HubSpot is not connected:

1. Reconnect HubSpot OAuth (or check token setup).
2. Retry sync.

### Sync Already Running

If you get "Sync already running":

- wait for the current run to finish,
- then run again.

## Quick Checklist For Operators

Use this checklist each day:

1. Confirm HL and HubSpot are connected.
2. Check updates for the selected day range.
3. Review and select users.
4. Sync selected users.
5. Confirm success message.
6. Re-login if auth expired.

## Notes

- The **Database** tab is mainly for initial/full data sync.
- The **Explorer** tab is for lookup and spot checks.
- Most daily work should happen in the **HubSpot** tab.
