import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDatabase,
  getDatabasePath,
  replaceAllMemberships,
  upsertCommunity,
  upsertUserFromRow,
  getExistingContactKeys,
  getStats,
  setSyncMeta,
  listUsers,
  listCommunitiesWithCounts,
  listMembershipsForCommunity,
  applyCommunityMemberUpdates,
  getUsersByContactKeys,
  getMembershipCommunityKeysByContactKeys,
  listHubspotCommunityMappings,
  createHubspotCommunityMapping,
  updateHubspotCommunityMapping,
  deleteHubspotCommunityMapping
} from "./db.mjs";
import {
  checkContactsExistInHubspot,
  getHubspotContactFieldMap,
  listHubspotContactProperties,
  upsertHubspotContactInputs
} from "./hubspot.mjs";
import {
  buildHubspotAuthorizeUrl,
  exchangeHubspotAuthorizationCode,
  refreshHubspotAccessToken,
  normalizeHubspotScopes
} from "./hubspot-oauth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set("trust proxy", 1);
const port = process.env.PORT || 3000;

/** HubSpot developer OAuth app (standard HubSpot OAuth, not Higher Logic). */
const HUBSPOT_OAUTH_CLIENT_ID = (process.env.HUBSPOT_OAUTH_CLIENT_ID || "").trim();
const HUBSPOT_OAUTH_CLIENT_SECRET = (process.env.HUBSPOT_OAUTH_CLIENT_SECRET || "").trim();
const HUBSPOT_OAUTH_REDIRECT_URI = (
  process.env.HUBSPOT_OAUTH_REDIRECT_URI ||
  `http://localhost:${port}/hubspot/oauth/callback`
).trim();
const HUBSPOT_OAUTH_SCOPE =
  normalizeHubspotScopes(
    process.env.HUBSPOT_OAUTH_SCOPE || "crm.objects.contacts.read"
  ) || "crm.objects.contacts.read";

/** `classic` = app.hubspot.com + scopes. `mcp` = MCP OAuth 2.1 (mcp.hubspot.com + PKCE, no scope param). */
const HUBSPOT_OAUTH_FLOW =
  (process.env.HUBSPOT_OAUTH_FLOW || "classic").trim().toLowerCase() === "mcp"
    ? "mcp"
    : "classic";

const hubspotOAuthStateStore = new Map();
const HUBSPOT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Must match the host you use for OAuth (e.g. iss …/members.globalplatform.org). No trailing slash. */
const BASE_URL = (
  process.env.HIGHERLOGIC_BASE_URL || "https://members.globalplatform.org"
).replace(/\/+$/, "");
const BEARER_TOKEN = (process.env.HIGHERLOGIC_BEARER_TOKEN || "").trim();
const HLIAM_KEY = (
  process.env.HIGHERLOGIC_IAM_KEY ||
  process.env.HLIAM_KEY ||
  ""
).trim();
const OAUTH_CLIENT_ID = (process.env.HIGHERLOGIC_OAUTH_CLIENT_ID || "").trim();
const OAUTH_CLIENT_SECRET = (process.env.HIGHERLOGIC_OAUTH_CLIENT_SECRET || "").trim();
const OAUTH_SCOPE = (
  process.env.HIGHERLOGIC_OAUTH_SCOPE ||
  "openid profile webapi email role offline_access"
).trim();
const OAUTH_AUTHORIZE_URL = `https://members.globalplatform.org/higherlogic/external/oauth/connect/authorize`;
const OAUTH_TOKEN_URL = `https://members.globalplatform.org/higherlogic/external/oauth/connect/token`;
const OAUTH_REDIRECT_URI = (
  process.env.HIGHERLOGIC_OAUTH_REDIRECT_URI ||
  `http://localhost:${port}/auth/callback`
).trim();
const APP_LOGIN_USERNAME = String(process.env.APP_LOGIN_USERNAME || "").trim();
const APP_LOGIN_PASSWORD = String(process.env.APP_LOGIN_PASSWORD || "").trim();
const APP_AUTH_COOKIE_NAME = "app_auth";
const APP_AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
const AUTOMATION_MIN_DAYS = 1;
const AUTOMATION_MAX_DAYS = 3650;
const API_USERNAME = (process.env.HIGHERLOGIC_API_USERNAME || "").trim();
const API_PASSWORD = (process.env.HIGHERLOGIC_API_PASSWORD || "").trim();
const HIGHERLOGIC_TENANT_KEY = (process.env.HIGHERLOGIC_TENANT_KEY || "").trim();
const oauthStateStore = new Map();
let oauthAccessToken = "";
let apiAccessToken = "";
let upstreamCookieHeader = "";
const upstreamCookieJar = new Map();

if (!HLIAM_KEY) {
  console.error(
    "Missing required env var: set HIGHERLOGIC_IAM_KEY (or HLIAM_KEY)."
  );
  process.exit(1);
}

if (!BEARER_TOKEN && !OAUTH_CLIENT_ID) {
  console.warn(
    "No auth credential configured. Set HIGHERLOGIC_BEARER_TOKEN or configure OAuth via HIGHERLOGIC_OAUTH_CLIENT_ID."
  );
}

if ((APP_LOGIN_USERNAME && !APP_LOGIN_PASSWORD) || (!APP_LOGIN_USERNAME && APP_LOGIN_PASSWORD)) {
  console.warn(
    "APP login auth is partially configured. Set both APP_LOGIN_USERNAME and APP_LOGIN_PASSWORD (or neither)."
  );
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const db = openDatabase();

function getEnabledCommunityMappings() {
  return listHubspotCommunityMappings(db, { enabledOnly: true });
}

function buildHubspotSyncRows(
  userRows,
  membershipsByContact,
  joinContactKeys = new Set(),
  removalContactKeys = new Set(),
  communityMappings = null
) {
  const mappings = Array.isArray(communityMappings)
    ? communityMappings
    : getEnabledCommunityMappings();
  const joinSet =
    joinContactKeys instanceof Set ? joinContactKeys : new Set(joinContactKeys);
  const removalSet =
    removalContactKeys instanceof Set
      ? removalContactKeys
      : new Set(removalContactKeys);
  return userRows.map((u) => {
    const communitySet = membershipsByContact.get(u.contact_key) || new Set();
    const out = {
      contact_key: u.contact_key,
      first_name: u.first_name || "",
      last_name: u.last_name || "",
      company_name: u.company_name || "",
      email: u.email || "",
      company_title: u.company_title || "",
      city: u.city || "",
      state_province_code: u.state_province_code || "",
      postal_code: u.postal_code || "",
      country_code: u.country_code || "",
      create_date: u.create_date || "",
      is_member: u.is_member === 1 || u.is_member === true,
      region: u.region || "",
      membership_level: u.membership_level || "",
      membership_status: u.membership_status || "",
      member_update_join: joinSet.has(u.contact_key),
      member_update_removal: removalSet.has(u.contact_key)
    };
    for (const m of mappings) {
      out[m.field_key] = communitySet.has(m.community_key);
    }
    return out;
  });
}

function normalizeHubspotBoolString(v) {
  const s = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  return ["true", "yes", "1", "y"].includes(s) ? "true" : "false";
}

function buildHubspotPreviewColumns(mappings) {
  const columns = {
    first_name: "FirstName",
    last_name: "LastName",
    company_name: "CompanyName",
    email: "Email",
    company_title: "CompanyTitle",
    city: "City",
    state_province_code: "StateProvinceCode",
    postal_code: "PostalCode",
    country_code: "CountryCode",
    create_date: "Create Date",
    is_member: "Member",
    region: "Region",
    membership_level: "Membership Level",
    membership_status: "Membership Status",
    member_update_join: "Join event (this run)",
    member_update_removal: "Removal event (this run)",
    hubspot_exists: "Exists in HubSpot"
  };
  for (const m of mappings) {
    columns[m.field_key] = m.label || m.field_key;
  }
  return columns;
}

function normalizeAutomationDays(v, fallback) {
  return Math.min(
    AUTOMATION_MAX_DAYS,
    Math.max(AUTOMATION_MIN_DAYS, parseInt(String(v || fallback), 10) || fallback)
  );
}

function isAppLoginEnabled() {
  return Boolean(APP_LOGIN_USERNAME && APP_LOGIN_PASSWORD);
}

function getAppAuthCookieValue() {
  if (!isAppLoginEnabled()) return "";
  return crypto
    .createHash("sha256")
    .update(`${APP_LOGIN_USERNAME}:${APP_LOGIN_PASSWORD}`)
    .digest("hex");
}

function isAppLoginAuthenticated(req) {
  const cookies = parseCookies(req?.headers?.cookie || "");
  const cookieValue = String(cookies[APP_AUTH_COOKIE_NAME] || "").trim();
  const expected = getAppAuthCookieValue();
  return Boolean(expected && cookieValue && cookieValue === expected);
}

function setAppLoginCookie(res, req) {
  const secure = cookieSecure(req);
  const value = getAppAuthCookieValue();
  res.append(
    "Set-Cookie",
    `${APP_AUTH_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${APP_AUTH_COOKIE_MAX_AGE}${secure ? "; Secure" : ""}`
  );
}

function clearAppLoginCookie(res, req) {
  const secure = cookieSecure(req);
  res.append(
    "Set-Cookie",
    `${APP_AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`
  );
}

function renderAppLoginHtml(error = "") {
  const safeError = String(error || "").trim();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>App Login</title>
  <style>
    body { font-family: Arial, sans-serif; background:#f6f7fb; color:#111827; margin:0; padding:32px; }
    .card { max-width:420px; margin:60px auto; background:#fff; border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,.08); padding:20px; }
    h1 { margin:0 0 12px; font-size:22px; }
    label { display:block; margin-top:10px; font-size:13px; color:#374151; }
    input { width:100%; box-sizing:border-box; margin-top:6px; padding:10px; border:1px solid #d1d5db; border-radius:8px; }
    button { margin-top:14px; width:100%; background:#111827; color:#fff; border:0; border-radius:8px; padding:10px 12px; cursor:pointer; }
    .error { margin-top:10px; color:#b91c1c; font-size:13px; min-height:18px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in</h1>
    <form method="post" action="/app/login">
      <label>Username<input name="username" autocomplete="username" required /></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
      <button type="submit">Login</button>
      <div class="error">${safeError}</div>
    </form>
  </div>
</body>
</html>`;
}

async function resolveHubspotCustomFields(accessToken, mappings = null) {
  const requested = Array.isArray(mappings)
    ? mappings
    : getEnabledCommunityMappings();
  const configuredMap = getHubspotContactFieldMap();
  const propertyDefs = await listHubspotContactProperties(accessToken);
  const byInternal = new Map(propertyDefs.map((p) => [p.name.toLowerCase(), p]));
  const byLabel = new Map(
    propertyDefs.map((p) => [String(p.label || "").trim().toLowerCase(), p])
  );
  const resolvedByKey = {};
  const resolution = [];
  for (const m of requested) {
    const key = m.field_key;
    const label = m.label || key;
    const configuredInternal = String(
      m.hubspot_property || configuredMap[key] || ""
    ).trim();
    const configuredDef = configuredInternal
      ? byInternal.get(configuredInternal.toLowerCase())
      : null;
    const labelDef = byLabel.get(String(label).toLowerCase()) || null;
    const chosen = configuredDef || labelDef || null;
    resolvedByKey[key] = chosen?.name || "";
    resolution.push({
      key,
      label,
      community_key: m.community_key,
      configuredInternalName: configuredInternal || null,
      resolvedInternalName: chosen?.name || null,
      resolvedBy: configuredDef
        ? "configured-map"
        : labelDef
          ? "label-match"
          : "unresolved"
    });
  }
  return { resolvedByKey, resolution, mappings: requested };
}

async function collectHubspotRowsFromHlUpdates(days, cookieHeader = "") {
  const clampedDays = normalizeAutomationDays(days, 60);
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - clampedDays * 86400000);
  const payload = {
    StartDate: startDate.toISOString(),
    EndDate: endDate.toISOString()
  };
  const syncReq = makeSyncReq(cookieHeader);
  getActiveBearerToken(syncReq);
  const data = await hlPost(
    "/higherlogic/external/api/v2.0/System/GetCommunityMemberUpdates",
    syncReq,
    payload
  );
  const joins = Array.isArray(data.CommunityJoins) ? data.CommunityJoins : [];
  const removals = Array.isArray(data.CommunityRemovals) ? data.CommunityRemovals : [];
  const { stats: applied, touchedContactKeys, joinContactKeys, removalContactKeys } =
    applyCommunityMemberUpdates(db, {
      communityJoins: joins,
      communityRemovals: removals
    });
  const rawRows = touchedContactKeys.length
    ? getUsersByContactKeys(db, touchedContactKeys)
    : [];
  const membershipsByContact = getMembershipCommunityKeysByContactKeys(
    db,
    touchedContactKeys
  );
  const hubspotRows = buildHubspotSyncRows(
    rawRows,
    membershipsByContact,
    new Set(joinContactKeys),
    new Set(removalContactKeys)
  );
  return {
    days: clampedDays,
    payload,
    data,
    applied,
    hubspotRows
  };
}

async function syncHubspotRowsByEmail(hubspotRows, hubspotToken) {
  const mappings = getEnabledCommunityMappings();
  const normalizedRows = (Array.isArray(hubspotRows) ? hubspotRows : [])
    .map((r) => {
      const row = {
        email: String(r?.email || "")
          .trim()
          .toLowerCase(),
        first_name: String(r?.first_name || "").trim(),
        last_name: String(r?.last_name || "").trim(),
        company_name: String(r?.company_name || "").trim(),
        company_title: String(r?.company_title || "").trim(),
        city: String(r?.city || "").trim(),
        state_province_code: String(r?.state_province_code || "").trim(),
        postal_code: String(r?.postal_code || "").trim(),
        country_code: String(r?.country_code || "").trim()
      };
      for (const m of mappings) {
        row[m.field_key] = r?.[m.field_key];
      }
      return row;
    })
    .filter((r) => r.email);
  const { resolvedByKey, resolution } = await resolveHubspotCustomFields(
    hubspotToken,
    mappings
  );
  const hsProperties = [
    "firstname",
    "lastname",
    "company",
    "email",
    "jobtitle",
    "city",
    "state",
    "zip",
    "country",
    ...Object.values(resolvedByKey).filter(Boolean)
  ];
  const hs = await checkContactsExistInHubspot(hubspotToken, normalizedRows, hsProperties);
  const existingByEmail = new Map();
  for (const c of hs.foundContacts || []) {
    const email = String(c?.properties?.email || "")
      .trim()
      .toLowerCase();
    if (email) existingByEmail.set(email, c.properties || {});
  }
  const inputs = normalizedRows.map((row) => {
    const existing = existingByEmail.get(row.email) || null;
    const properties = { email: row.email };
    const standardPairs = [
      ["firstname", row.first_name],
      ["lastname", row.last_name],
      ["company", row.company_name],
      ["jobtitle", row.company_title],
      ["city", row.city],
      ["state", row.state_province_code],
      ["zip", row.postal_code],
      ["country", row.country_code]
    ];
    for (const [hsKey, hlValue] of standardPairs) {
      const next = String(hlValue || "").trim();
      if (!next) continue;
      if (!existing) {
        properties[hsKey] = next;
        continue;
      }
      const prev = String(existing[hsKey] || "").trim();
      if (!prev) properties[hsKey] = next;
    }
    for (const m of mappings) {
      const hsKey = resolvedByKey[m.field_key];
      if (!hsKey) continue;
      properties[hsKey] = normalizeHubspotBoolString(row[m.field_key]);
    }
    return {
      id: row.email,
      idProperty: "email",
      properties
    };
  });
  const result = await upsertHubspotContactInputs(hubspotToken, inputs);
  return {
    selected: normalizedRows.length,
    existing: hs.found,
    createdOrUpdated: result.results,
    attempted: result.attempted,
    errors: result.errors,
    hubspotCustomFieldResolution: resolution
  };
}

const automationState = {
  enabled: false,
  intervalDays: 7,
  lookbackDays: 7,
  running: false,
  lastRunAt: null,
  lastRunResult: null,
  lastError: null,
  nextRunAt: null
};
let automationTimer = null;

function stopAutomationTimer() {
  if (automationTimer) clearInterval(automationTimer);
  automationTimer = null;
}

async function runAutomationCycle() {
  if (!automationState.enabled || automationState.running) return;
  automationState.running = true;
  automationState.lastError = null;
  try {
    const hubspotToken = String(process.env.HUBSPOT_ACCESS_TOKEN || "").trim();
    if (!hubspotToken) {
      throw new Error("HUBSPOT_ACCESS_TOKEN is not configured.");
    }
    const collected = await collectHubspotRowsFromHlUpdates(
      automationState.lookbackDays,
      ""
    );
    const syncResult = await syncHubspotRowsByEmail(collected.hubspotRows, hubspotToken);
    automationState.lastRunResult = {
      lookedBackDays: automationState.lookbackDays,
      hlRows: collected.hubspotRows.length,
      synced: syncResult.createdOrUpdated,
      attempted: syncResult.attempted,
      errors: syncResult.errors?.length || 0
    };
    automationState.lastRunAt = new Date().toISOString();
  } catch (e) {
    automationState.lastError = String(e?.message || e);
  } finally {
    automationState.running = false;
    const now = Date.now();
    automationState.nextRunAt = new Date(
      now + automationState.intervalDays * 24 * 60 * 60 * 1000
    ).toISOString();
  }
}

function startAutomationTimer() {
  stopAutomationTimer();
  if (!automationState.enabled) return;
  if (!automationState.nextRunAt) {
    automationState.nextRunAt = new Date(
      Date.now() + automationState.intervalDays * 24 * 60 * 60 * 1000
    ).toISOString();
  }
  automationTimer = setInterval(async () => {
    if (!automationState.enabled) return;
    if (automationState.running) return;
    const nextMs = Date.parse(String(automationState.nextRunAt || ""));
    if (Number.isFinite(nextMs) && Date.now() >= nextMs) {
      await runAutomationCycle();
    }
  }, 30000);
}

function makeSyncReq(cookieHeader) {
  return { headers: { cookie: cookieHeader || "" } };
}

function extractCommunityMeta(item) {
  const key =
    item.CommunityKey ||
    item.Id ||
    item.CommunityId ||
    item.id ||
    item.communityId;
  const name =
    item.Name ||
    item.Title ||
    item.CommunityName ||
    item.name ||
    "Unnamed community";
  return { key, name };
}

async function fetchCommunityMemberPairs(hlPostFn, syncReq, communityKey) {
  const pairs = [];
  const pageSize = 3000;
  let start = 1;
  while (true) {
    const data = await hlPostFn(
      "/higherlogic/external/api/v1.0/Communities/GetCommunityMembers",
      syncReq,
      {
        CommunityKey: communityKey,
        LegacyGroupKey: "",
        StartRecord: start,
        EndRecord: start + pageSize - 1
      }
    );
    const members = normalizeArray(data);
    if (!members.length) break;
    for (const m of members) {
      const ck = extractMemberId(m);
      if (ck) pairs.push([ck, communityKey]);
    }
    if (members.length < pageSize) break;
    start += pageSize;
  }
  return pairs;
}

let syncJobRunning = false;
const syncState = {
  running: false,
  phase: "",
  communitiesTotal: 0,
  communitiesDone: 0,
  membershipsWritten: 0,
  contactsToFetch: 0,
  contactsFetched: 0,
  contactsSkipped: 0,
  contactsSucceeded: 0,
  contactsFailed: 0,
  message: "",
  error: null
};

async function hlFetchContactWithRetry(contactKey, syncReq) {
  const path = `/higherlogic/external/api/v1.0/Contacts/GetContact?contactKey=${encodeURIComponent(contactKey)}`;
  const maxRetries = Math.max(1, parseInt(process.env.SYNC_GETCONTACT_RETRIES || "4", 10));
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await hlFetch(path, syncReq);
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries - 1) {
        const delay = Math.min(25000, 500 * 2 ** attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function runFullSync(cookieHeader, refreshAllDetails) {
  const startedAt = new Date().toISOString();
  Object.assign(syncState, {
    running: true,
    phase: "starting",
    communitiesTotal: 0,
    communitiesDone: 0,
    membershipsWritten: 0,
    contactsToFetch: 0,
    contactsFetched: 0,
    contactsSkipped: 0,
    contactsSucceeded: 0,
    contactsFailed: 0,
    message: "Starting…",
    error: null
  });

  setSyncMeta(db, {
    last_sync_started_at: startedAt,
    last_sync_status: "running",
    last_sync_error: null
  });

  const syncReq = makeSyncReq(cookieHeader);
  const concurrency = Math.max(
    1,
    Math.min(
      32,
      parseInt(process.env.SYNC_CONTACT_CONCURRENCY || "4", 10)
    )
  );
  const batchDelayMs = Math.max(
    0,
    parseInt(process.env.SYNC_BATCH_DELAY_MS || "75", 10)
  );

  try {
    getActiveBearerToken(syncReq);

    syncState.phase = "communities";
    syncState.message = "Loading communities…";
    const commData = await hlFetch(
      "/higherlogic/external/api/v1.0/Communities/GetViewableCommunities?includeStatistics=false",
      syncReq
    );
    const commList = normalizeArray(commData);
    syncState.communitiesTotal = commList.length;

    const allPairs = [];
    for (let i = 0; i < commList.length; i++) {
      const item = commList[i];
      const { key: communityKey, name } = extractCommunityMeta(item);
      if (!communityKey) continue;
      upsertCommunity(db, communityKey, name);
      syncState.communitiesDone = i + 1;
      syncState.phase = "members";
      syncState.message = `Community ${i + 1}/${commList.length}: loading members…`;
      const pairs = await fetchCommunityMemberPairs(
        hlPost,
        syncReq,
        communityKey
      );
      allPairs.push(...pairs);
    }

    syncState.phase = "linking";
    syncState.message = "Writing membership links…";
    replaceAllMemberships(db, allPairs);
    syncState.membershipsWritten = allPairs.length;

    const uniqueKeys = [...new Set(allPairs.map((p) => p[0]))];
    const existing = getExistingContactKeys(db);
    const toFetch = refreshAllDetails
      ? uniqueKeys
      : uniqueKeys.filter((k) => !existing.has(k));
    syncState.contactsSkipped = uniqueKeys.length - toFetch.length;
    syncState.contactsToFetch = toFetch.length;
    syncState.contactsFetched = 0;
    syncState.contactsSucceeded = 0;
    syncState.contactsFailed = 0;

    syncState.phase = "contacts";
    syncState.message = `Fetching contact details (${toFetch.length} API calls)…`;

    for (let i = 0; i < toFetch.length; i += concurrency) {
      const batch = toFetch.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (contactKey) => {
          try {
            const detail = await hlFetchContactWithRetry(contactKey, syncReq);
            upsertUserFromRow(db, contactKey, toTableRow(detail));
            return "ok";
          } catch (e) {
            console.error("[sync] GetContact failed", contactKey, e.message);
            return "fail";
          }
        })
      );
      const ok = results.filter((r) => r === "ok").length;
      syncState.contactsSucceeded += ok;
      syncState.contactsFailed += results.length - ok;
      syncState.contactsFetched += results.length;
      syncState.message = `Contacts ${syncState.contactsFetched}/${toFetch.length} (ok ${syncState.contactsSucceeded}, failed ${syncState.contactsFailed})…`;
      if (batchDelayMs > 0 && i + concurrency < toFetch.length) {
        await new Promise((r) => setTimeout(r, batchDelayMs));
      }
    }

    const completedAt = new Date().toISOString();
    setSyncMeta(db, {
      last_sync_completed_at: completedAt,
      last_sync_status: "ok",
      last_sync_error: null
    });
    syncState.phase = "done";
    syncState.message = `Done. Contact details: ${syncState.contactsSucceeded} succeeded, ${syncState.contactsFailed} failed (after retries).`;
  } catch (e) {
    syncState.error = e.message;
    syncState.phase = "error";
    syncState.message = e.message;
    setSyncMeta(db, {
      last_sync_status: "failed",
      last_sync_error: e.message,
      last_sync_completed_at: new Date().toISOString()
    });
  } finally {
    syncState.running = false;
  }
}

function base64UrlEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createPkcePair() {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(64));
  const codeChallenge = base64UrlEncode(
    crypto.createHash("sha256").update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

function parseCookies(cookieHeader = "") {
  const cookies = {};
  if (!cookieHeader) return cookies;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) continue;
    cookies[rawKey] = decodeURIComponent(rawValue.join("=") || "");
  }
  return cookies;
}

function cookieSecure(req) {
  return (
    process.env.NODE_ENV === "production" ||
    req.get("x-forwarded-proto") === "https"
  );
}

function getHubspotOAuthCookies(req) {
  const c = parseCookies(req.headers.cookie || "");
  return { access: c.hs_oauth_at || "", refresh: c.hs_oauth_rt || "" };
}

function getHubspotApiToken(req) {
  const { access } = getHubspotOAuthCookies(req);
  if (access) return access;
  return String(process.env.HUBSPOT_ACCESS_TOKEN || "").trim();
}

function setHubspotOAuthCookies(res, req, tokenData) {
  const access = String(tokenData.access_token || "").trim();
  const refresh = String(tokenData.refresh_token || "").trim();
  const expiresIn = Math.min(
    Math.max(60, parseInt(String(tokenData.expires_in || 1800), 10)),
    60 * 60 * 24
  );
  const secure = cookieSecure(req);
  const cookies = [
    `hs_oauth_at=${encodeURIComponent(access)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expiresIn}${secure ? "; Secure" : ""}`
  ];
  if (refresh) {
    cookies.push(
      `hs_oauth_rt=${encodeURIComponent(refresh)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure ? "; Secure" : ""}`
    );
  }
  for (const line of cookies) {
    res.append("Set-Cookie", line);
  }
}

function clearHubspotOAuthCookies(res, req) {
  const secure = cookieSecure(req);
  const tail = `Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
  res.append("Set-Cookie", `hs_oauth_at=; ${tail}`);
  res.append("Set-Cookie", `hs_oauth_rt=; ${tail}`);
}

function getTokenSource(req) {
  const cookies = parseCookies(req?.headers?.cookie || "");
  if (cookies.hl_api_access_token) return "cookie";
  if (apiAccessToken) return "api-memory";
  if (BEARER_TOKEN) return "env";
  return "none";
}

function getActiveBearerToken(req) {
  const cookies = parseCookies(req?.headers?.cookie || "");
  return cookies.hl_api_access_token || apiAccessToken || BEARER_TOKEN;
}

function primeApiAccessTokenFromRequest(req) {
  const cookies = parseCookies(req?.headers?.cookie || "");
  const cookieToken = String(cookies.hl_api_access_token || "").trim();
  if (cookieToken) {
    apiAccessToken = cookieToken;
  }
}

function extractToken(data) {
  if (!data || typeof data !== "object") return "";
  return (
    data.access_token ||
    data.accessToken ||
    data.AccessToken ||
    data.Token ||
    data.token ||
    data.Data?.access_token ||
    data.Data?.accessToken ||
    data.Data?.AccessToken ||
    data.Data?.Token ||
    ""
  );
}

/** OAuth token endpoint body shapes differ by tenant. */
function extractOAuthAccessToken(data) {
  return String(extractToken(data) || "").trim();
}

/** Deeper extraction for Authentication/Login JSON (shape varies by tenant / HL version). */
function extractLoginApiToken(data, depth = 0) {
  if (!data || depth > 4) return "";
  if (Array.isArray(data) && data.length && typeof data[0] === "object") {
    return extractLoginApiToken(data[0], depth + 1);
  }
  if (typeof data !== "object") return "";
  const base = String(extractToken(data) || "").trim();
  if (base) return base;
  const keyCandidates = [
    "ApiToken",
    "APIToken",
    "api_token",
    "BearerToken",
    "WebApiToken",
    "AuthenticationToken",
    "AuthToken",
    "UserToken",
    "SessionToken",
    "SecurityToken",
    "OAuthToken"
  ];
  for (const k of keyCandidates) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const nestedKeys = [
    "Data",
    "data",
    "Result",
    "result",
    "Value",
    "value",
    "Payload",
    "payload",
    "Response",
    "response"
  ];
  for (const nk of nestedKeys) {
    const child = data[nk];
    if (child && typeof child === "object") {
      const t = extractLoginApiToken(child, depth + 1);
      if (t) return t;
    }
  }
  return "";
}

/** Some tenants return the bearer only in Set-Cookie, not in the JSON body. */
function extractTokenFromSetCookieHeaders(setCookieValues) {
  if (!Array.isArray(setCookieValues) || !setCookieValues.length) return "";
  const preferredNames =
    /^access_token$|^AccessToken$|^Token$|^ApiToken$|^BearerToken$|^AuthenticationToken$/i;
  for (const line of setCookieValues) {
    const pair = String(line).split(";")[0].trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep raw */
    }
    if (!value || value.length < 8) continue;
    if (preferredNames.test(name)) return value;
  }
  for (const line of setCookieValues) {
    const pair = String(line).split(";")[0].trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep raw */
    }
    if (
      value &&
      value.length >= 16 &&
      /token|auth|session|bearer|access/i.test(name)
    ) {
      return value;
    }
  }
  return "";
}

function extractTokenFromUpstreamCookieJar() {
  for (const [name, value] of upstreamCookieJar.entries()) {
    if (!value || String(value).length < 16) continue;
    if (/token|auth|session|bearer|access|oauth/i.test(name)) {
      return String(value).trim();
    }
  }
  return "";
}

function getAuthDebug(req) {
  const cookies = parseCookies(req?.headers?.cookie || "");
  const activeToken = getActiveBearerToken(req) || "";
  return {
    source: getTokenSource(req),
    hasCookieToken: Boolean(cookies.hl_api_access_token),
    hasApiMemoryToken: Boolean(apiAccessToken),
    hasOauthMemoryToken: Boolean(oauthAccessToken),
    hasUpstreamCookie: Boolean(upstreamCookieHeader),
    hasEnvToken: Boolean(BEARER_TOKEN),
    tokenLength: activeToken.length,
    tokenPreview: activeToken ? `${activeToken.slice(0, 12)}...${activeToken.slice(-8)}` : null,
    hliamKeyPresent: Boolean(HLIAM_KEY),
    hliamKeyPreview: HLIAM_KEY ? `${HLIAM_KEY.slice(0, 8)}...${HLIAM_KEY.slice(-4)}` : null
  };
}

function getHeaders(req) {
  const token = getActiveBearerToken(req);
  if (!token) {
    throw new Error(
      "No access token available. Configure HIGHERLOGIC_BEARER_TOKEN or login via /auth/login."
    );
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    HLIAMKey: HLIAM_KEY
  };
  if (upstreamCookieHeader) {
    headers.Cookie = upstreamCookieHeader;
  }
  // Some Higher Logic tenants also expect a tenant-key cookie keyed by tenant GUID.
  if (HIGHERLOGIC_TENANT_KEY && token) {
    const tenantCookiePair = `${HIGHERLOGIC_TENANT_KEY}=${token}`;
    headers.Cookie = headers.Cookie
      ? `${headers.Cookie}; ${tenantCookiePair}`
      : tenantCookiePair;
  }
  return headers;
}

function getSetCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

function getCookieNamesFromHeader(cookieHeader = "") {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((pair) => pair.trim().split("=")[0]?.trim())
    .filter(Boolean);
}

function updateUpstreamCookieJarFromSetCookie(setCookieValues) {
  if (!Array.isArray(setCookieValues)) return;
  for (const entry of setCookieValues) {
    const pair = String(entry).split(";")[0].trim();
    if (!pair) continue;
    const [name, ...valueParts] = pair.split("=");
    if (!name) continue;
    upstreamCookieJar.set(name.trim(), valueParts.join("="));
  }
  upstreamCookieHeader = Array.from(upstreamCookieJar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function hlFetch(path, req) {
  const url = new URL(`${BASE_URL}${path}`);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getHeaders(req)
  });
  updateUpstreamCookieJarFromSetCookie(getSetCookieHeaders(response));

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `Higher Logic error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function hlPost(path, req, payload) {
  const url = new URL(`${BASE_URL}${path}`);
  const headers = {
    ...getHeaders(req),
    "Content-Type": "application/json"
  };
  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  updateUpstreamCookieJarFromSetCookie(getSetCookieHeaders(response));

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `Higher Logic error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

function normalizeArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.Data)) return data.Data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.Results)) return data.Results;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

function extractMemberId(item) {
  return item?.ContactKey || item?.UserKey || item?.MemberId || item?.Id || item?.id || "";
}

function mapMembershipStatus(code) {
  if (code === "A") return "Active";
  if (code === "I") return "Inactive";
  if (code === "S") return "Suspended";
  return code || "";
}

function pickBestAddress(detail) {
  const addresses = Array.isArray(detail?.Addresses) ? detail.Addresses : [];
  if (!addresses.length) return {};
  const withLocation = addresses.find((a) => a?.City || a?.StateProvinceCode || a?.PostalCode);
  return withLocation || addresses[0] || {};
}

function toTableRow(detail) {
  const addr = pickBestAddress(detail);
  const createDate = detail?.AgreedToTermsDateTime || "";
  return {
    FirstName: detail?.FirstName || "",
    LastName: detail?.LastName || "",
    CompanyName: detail?.CompanyName || "",
    Email: detail?.EmailAddress || "",
    CompanyTitle: detail?.CompanyTitle || "",
    City: addr?.City || "",
    StateProvinceCode: addr?.StateProvinceCode || "",
    PostalCode: addr?.PostalCode || "",
    CountryCode: addr?.CountryCode || "",
    CreateDate: createDate,
    Member: detail?.IsMember ? "Yes" : "No",
    Region: addr?.Region || "",
    UpdatedOn: detail?.UpdatedOn || "",
    MembershipLevel: detail?.MembershipLevel || detail?.MemberType || "",
    MembershipStatus: mapMembershipStatus(detail?.ContactStatusCode)
  };
}

app.get("/app/login", (req, res) => {
  if (!isAppLoginEnabled()) {
    return res.redirect("/");
  }
  if (isAppLoginAuthenticated(req)) {
    return res.redirect("/");
  }
  res.status(200).send(renderAppLoginHtml());
});

app.post("/app/login", (req, res) => {
  if (!isAppLoginEnabled()) {
    return res.redirect("/");
  }
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "").trim();
  if (username === APP_LOGIN_USERNAME && password === APP_LOGIN_PASSWORD) {
    setAppLoginCookie(res, req);
    return res.redirect("/");
  }
  clearAppLoginCookie(res, req);
  return res.status(401).send(renderAppLoginHtml("Invalid username or password."));
});

app.post("/app/logout", (req, res) => {
  clearAppLoginCookie(res, req);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (!isAppLoginEnabled()) return next();
  const p = req.path || "";
  if (p === "/health" || p === "/app/login") return next();
  if (isAppLoginAuthenticated(req)) return next();
  if (p.startsWith("/api/")) {
    return res.status(401).json({ error: "App login required." });
  }
  return res.redirect("/app/login");
});

app.get("/auth/login", (req, res) => {
  if (!OAUTH_CLIENT_ID) {
    return res.status(500).send("Missing HIGHERLOGIC_OAUTH_CLIENT_ID.");
  }

  const state = crypto.randomUUID();
  const { codeVerifier, codeChallenge } = createPkcePair();
  oauthStateStore.set(state, { codeVerifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state
  });

  res.redirect(`${OAUTH_AUTHORIZE_URL}?${params.toString()}`);
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res
      .status(400)
      .send(`OAuth error: ${error}${errorDescription ? ` (${errorDescription})` : ""}`);
  }

  if (!code || !state || !oauthStateStore.has(state)) {
    return res.status(400).send("Invalid OAuth callback state or missing code.");
  }

  const { codeVerifier } = oauthStateStore.get(state);
  oauthStateStore.delete(state);

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: OAUTH_REDIRECT_URI,
      client_id: OAUTH_CLIENT_ID,
      code_verifier: codeVerifier
    });

    if (OAUTH_CLIENT_SECRET) {
      body.set("client_secret", OAUTH_CLIENT_SECRET);
    }

    const tokenResponse = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        HLIAMKey: HLIAM_KEY
      },
      body: body.toString()
    });
    updateUpstreamCookieJarFromSetCookie(getSetCookieHeaders(tokenResponse));

    const text = await tokenResponse.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!tokenResponse.ok) {
      return res
        .status(500)
        .send(`Token exchange failed (${tokenResponse.status}): ${JSON.stringify(data)}`);
    }

    oauthAccessToken = extractOAuthAccessToken(data);
    if (!oauthAccessToken) {
      const keys =
        data && typeof data === "object" && !data.raw
          ? Object.keys(data).join(", ")
          : "parse failed or non-object";
      return res.status(500).send(
        `Token response did not include a usable access token. Keys: ${keys}`
      );
    }

    if (!API_USERNAME || !API_PASSWORD) {
      return res.status(500).send(
        "Missing HIGHERLOGIC_API_USERNAME or HIGHERLOGIC_API_PASSWORD for Authentication/Login exchange."
      );
    }

    const loginUrl = new URL(
      `${BASE_URL}/higherlogic/external/api/v1.0/Authentication/Login`
    );
    // Match Postman "Add authorization data to: Request URL".
    loginUrl.searchParams.set("access_token", oauthAccessToken);

    const loginResponse = await fetch(loginUrl.toString(), {
      method: "POST",
      headers: {
        HLIAMKey: HLIAM_KEY,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        Username: API_USERNAME,
        Password: API_PASSWORD
      })
    });

    const loginText = await loginResponse.text();
    const loginCtHeader =
      loginResponse.headers.get("content-type") || "";
    let loginData;
    try {
      loginData = loginText ? JSON.parse(loginText) : {};
    } catch {
      loginData = { raw: loginText };
    }

    const loginParseFailed =
      Boolean(loginData && Object.prototype.hasOwnProperty.call(loginData, "raw")) ||
      (loginCtHeader && !/json/i.test(loginCtHeader));

    console.log("[auth/callback] Authentication/Login status:", loginResponse.status);
    console.log("[auth/callback] Authentication/Login Content-Type:", loginCtHeader);
    console.log(
      "[auth/callback] Authentication/Login response (truncated):",
      loginParseFailed
        ? `(non-JSON body, length ${String(loginText).length})`
        : loginData
    );

    if (!loginResponse.ok) {
      return res.status(500).send(
        `Authentication/Login failed (${loginResponse.status}): ${JSON.stringify(loginData)}`
      );
    }

    const loginSetCookies = getSetCookieHeaders(loginResponse);
    updateUpstreamCookieJarFromSetCookie(loginSetCookies);
    console.log(
      "[auth/callback] Upstream login cookies captured:",
      loginSetCookies.length
    );
    console.log(
      "[auth/callback] Upstream login cookie names:",
      getCookieNamesFromHeader(upstreamCookieHeader)
    );

    let apiToken = "";
    if (!loginParseFailed) {
      apiToken =
        extractLoginApiToken(loginData) ||
        extractTokenFromSetCookieHeaders(loginSetCookies) ||
        extractTokenFromUpstreamCookieJar();
    } else {
      console.warn(
        "[auth/callback] Login body was not JSON (wrong BASE_URL, HTML error page, or API shape). Trying cookies, then OAuth access_token."
      );
      apiToken =
        extractTokenFromSetCookieHeaders(loginSetCookies) ||
        extractTokenFromUpstreamCookieJar();
    }
    if (!apiToken && oauthAccessToken) {
      console.log(
        "[auth/callback] Using OAuth access_token as API bearer (Login did not yield a token in JSON/cookies)."
      );
      apiToken = oauthAccessToken;
    }
    apiAccessToken = String(apiToken || "").trim();
    console.log("[auth/callback] Extracted API token length:", apiAccessToken.length);
    if (!apiAccessToken) {
      return res.status(500).send(
        `Authentication/Login succeeded but no API token could be resolved. ` +
          `Login JSON (keys): ${loginData && typeof loginData === "object" ? Object.keys(loginData).join(", ") : "n/a"}. ` +
          `Set-Cookie count: ${loginSetCookies.length}. ` +
          `Full body: ${JSON.stringify(loginData)}`
      );
    }

    const isHttps = OAUTH_REDIRECT_URI.startsWith("https://");
    res.setHeader(
      "Set-Cookie",
      `hl_api_access_token=${encodeURIComponent(apiAccessToken)}; Path=/; HttpOnly; SameSite=Lax${isHttps ? "; Secure" : ""}`
    );

    return res.redirect("/?auth=success");
  } catch (tokenError) {
    return res.status(500).send(`OAuth callback failed: ${tokenError.message}`);
  }
});

app.get("/api/auth/status", (req, res) => {
  const activeToken = getActiveBearerToken(req);
  res.json({
    authenticated: Boolean(activeToken),
    source: getTokenSource(req),
    hasIamKey: Boolean(HLIAM_KEY),
    oauthConfigured: Boolean(OAUTH_CLIENT_ID)
  });

});

app.get("/api/debug/auth", (req, res) => {
  res.json(getAuthDebug(req));
});

app.get("/api/hubspot/oauth/start", (req, res) => {
  if (!HUBSPOT_OAUTH_CLIENT_ID || !HUBSPOT_OAUTH_CLIENT_SECRET) {
    return res.status(503).send(
      "HubSpot OAuth is not configured. Set HUBSPOT_OAUTH_CLIENT_ID and HUBSPOT_OAUTH_CLIENT_SECRET (and register HUBSPOT_OAUTH_REDIRECT_URI in HubSpot)."
    );
  }
  const state = crypto.randomBytes(16).toString("hex");
  if (HUBSPOT_OAUTH_FLOW === "mcp") {
    const { codeVerifier, codeChallenge } = createPkcePair();
    hubspotOAuthStateStore.set(state, {
      createdAt: Date.now(),
      codeVerifier
    });
    const authorizeUrl = buildHubspotAuthorizeUrl({
      clientId: HUBSPOT_OAUTH_CLIENT_ID,
      redirectUri: HUBSPOT_OAUTH_REDIRECT_URI,
      state,
      flow: "mcp",
      codeChallenge
    });
    return res.redirect(authorizeUrl);
  }
  hubspotOAuthStateStore.set(state, { createdAt: Date.now() });
  const authorizeUrl = buildHubspotAuthorizeUrl({
    clientId: HUBSPOT_OAUTH_CLIENT_ID,
    redirectUri: HUBSPOT_OAUTH_REDIRECT_URI,
    scope: HUBSPOT_OAUTH_SCOPE,
    state,
    flow: "classic"
  });
  res.redirect(authorizeUrl);
});

app.get("/hubspot/oauth/callback", async (req, res) => {
  const { code, state, error, error_description: errDesc } = req.query;
  if (error) {
    return res
      .status(400)
      .send(`HubSpot OAuth error: ${error}${errDesc ? ` — ${errDesc}` : ""}`);
  }
  if (!code || !state || !hubspotOAuthStateStore.has(String(state))) {
    return res.status(400).send("Invalid OAuth state or missing code.");
  }
  const entry = hubspotOAuthStateStore.get(String(state));
  hubspotOAuthStateStore.delete(String(state));
  if (Date.now() - entry.createdAt > HUBSPOT_OAUTH_STATE_TTL_MS) {
    return res.status(400).send("OAuth state expired. Try connecting again.");
  }
  if (HUBSPOT_OAUTH_FLOW === "mcp" && !entry.codeVerifier) {
    return res
      .status(400)
      .send("Missing PKCE data. Click Connect HubSpot again (use HUBSPOT_OAUTH_FLOW=mcp).");
  }
  if (!HUBSPOT_OAUTH_CLIENT_ID || !HUBSPOT_OAUTH_CLIENT_SECRET) {
    return res.status(503).send("HubSpot OAuth not configured.");
  }
  try {
    const tokenData = await exchangeHubspotAuthorizationCode({
      clientId: HUBSPOT_OAUTH_CLIENT_ID,
      clientSecret: HUBSPOT_OAUTH_CLIENT_SECRET,
      redirectUri: HUBSPOT_OAUTH_REDIRECT_URI,
      code: String(code),
      flow: HUBSPOT_OAUTH_FLOW,
      codeVerifier:
        HUBSPOT_OAUTH_FLOW === "mcp" ? entry.codeVerifier : undefined
    });
    setHubspotOAuthCookies(res, req, tokenData);
    res.redirect("/?hubspot_oauth=success");
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

app.get("/api/hubspot/oauth/status", (req, res) => {
  const { access, refresh } = getHubspotOAuthCookies(req);
  const envToken = String(process.env.HUBSPOT_ACCESS_TOKEN || "").trim();
  res.json({
    configured: Boolean(HUBSPOT_OAUTH_CLIENT_ID && HUBSPOT_OAUTH_CLIENT_SECRET),
    connected: Boolean(access || envToken),
    connectionType: access ? "oauth-cookie" : envToken ? "env-token" : "none",
    hasRefresh: Boolean(refresh)
  });
});

/** No secrets — compare with HubSpot app settings. */
app.get("/api/hubspot/oauth/config", (req, res) => {
  const scope = HUBSPOT_OAUTH_SCOPE;
  const isMcp = HUBSPOT_OAUTH_FLOW === "mcp";
  res.json({
    flow: HUBSPOT_OAUTH_FLOW,
    pkce: isMcp,
    authorizationEndpoint: isMcp
      ? "https://mcp.hubspot.com/oauth/authorize/user"
      : "https://app.hubspot.com/oauth/authorize",
    tokenEndpoint: isMcp
      ? "https://mcp.hubspot.com/oauth/v3/token"
      : "https://api.hubapi.com/oauth/v1/token",
    redirectUri: HUBSPOT_OAUTH_REDIRECT_URI,
    scope: isMcp ? null : scope,
    scopesRequested: isMcp ? [] : scope.split(/\s+/).filter(Boolean)
  });
});

app.post("/api/hubspot/oauth/disconnect", (req, res) => {
  clearHubspotOAuthCookies(res, req);
  res.json({ ok: true });
});

app.get("/api/hubspot/contacts", async (req, res) => {
  let { refresh } = getHubspotOAuthCookies(req);
  let access = getHubspotApiToken(req);
  if (!access) {
    return res.status(401).json({
      error:
        "HubSpot is not connected. Either connect OAuth or set HUBSPOT_ACCESS_TOKEN."
    });
  }
  async function withHubspotAccess(doRequest) {
    let r = await doRequest(access);
    if (
      r.status === 401 &&
      refresh &&
      HUBSPOT_OAUTH_CLIENT_ID &&
      HUBSPOT_OAUTH_CLIENT_SECRET
    ) {
      const td = await refreshHubspotAccessToken({
        clientId: HUBSPOT_OAUTH_CLIENT_ID,
        clientSecret: HUBSPOT_OAUTH_CLIENT_SECRET,
        refreshToken: refresh,
        flow: HUBSPOT_OAUTH_FLOW
      });
      setHubspotOAuthCookies(res, req, td);
      access = String(td.access_token || "").trim();
      r = await doRequest(access);
    }
    return r;
  }
  try {
    const updatedDaysRaw = String(req.query.updatedDays || "").trim();
    const updatedDays = updatedDaysRaw
      ? Math.min(3650, Math.max(1, parseInt(updatedDaysRaw, 10) || 30))
      : 0;
    if (updatedDays > 0) {
      const sinceMs = Date.now() - updatedDays * 24 * 60 * 60 * 1000;
      const results = [];
      let after = "";
      do {
        const body = {
          limit: 100,
          properties: [
            "email",
            "firstname",
            "lastname",
            "company",
            "lastmodifieddate"
          ],
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "lastmodifieddate",
                  operator: "GTE",
                  value: String(sinceMs)
                }
              ]
            }
          ],
          sorts: [{ propertyName: "lastmodifieddate", direction: "DESCENDING" }]
        };
        if (after) body.after = after;
        const r = await withHubspotAccess((token) =>
          fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
          })
        );
        const text = await r.text();
        let data;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = { raw: text };
        }
        if (!r.ok) {
          return res.status(r.status).json({
            error: "HubSpot CRM API error",
            status: r.status,
            details: data
          });
        }
        const pageResults = Array.isArray(data.results) ? data.results : [];
        results.push(...pageResults);
        after = String(data?.paging?.next?.after || "").trim();
      } while (after);
      return res.json({
        mode: "updatedDays",
        updatedDays,
        total: results.length,
        results
      });
    }
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "10", 10)));
    const props = "email,firstname,lastname,company,lastmodifieddate,hs_object_id";
    const listUrl = new URL("https://api.hubapi.com/crm/v3/objects/contacts");
    listUrl.searchParams.set("limit", String(limit));
    listUrl.searchParams.set("properties", props);
    const r = await withHubspotAccess((token) =>
      fetch(listUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` }
      })
    );
    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!r.ok) {
      return res.status(r.status).json({
        error: "HubSpot CRM API error",
        status: r.status,
        details: data
      });
    }
    return res.json(data);
  } catch (e) {
    return res.status(401).json({ error: String(e.message || e) });
  }
});

/**
 * Adjust these endpoints if your exact member/member-detail routes differ.
 */
app.get("/api/communities", async (req, res) => {
  try {
    const tokenUsed = getActiveBearerToken(req);
    const source = getTokenSource(req);
    const outboundHeaders = getHeaders(req);
    console.log("[/api/communities] HLIAMKey:", HLIAM_KEY);
    console.log("[/api/communities] Bearer token used:", tokenUsed);
    console.log("[/api/communities] Token source:", source);
    console.log(
      "[/api/communities] Upstream cookie names:",
      getCookieNamesFromHeader(upstreamCookieHeader)
    );
    console.log(
      "[/api/communities] Outbound cookie names:",
      getCookieNamesFromHeader(outboundHeaders.Cookie || "")
    );

    const data = await hlFetch(
      "/higherlogic/external/api/v1.0/Communities/GetViewableCommunities?includeStatistics=false",
      req
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: error.message,
      debug: getAuthDebug(req)
    });
  }
});

app.get("/api/communities/:communityId/members", async (req, res) => {
  try {
    const { communityId } = req.params;

    const data = await hlPost(
      "/higherlogic/external/api/v1.0/Communities/GetCommunityMembers",
      req,
      {
        CommunityKey: communityId,
        LegacyGroupKey: "",
        StartRecord: 1,
        EndRecord: 3000
      }
    );

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/members/:memberId", async (req, res) => {
  try {
    const { memberId } = req.params;

    const data = await hlFetch(
      `/higherlogic/external/api/v1.0/Contacts/GetContact?contactKey=${encodeURIComponent(memberId)}`,
      req
    );

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/communities/:communityId/member-details-table", async (req, res) => {
  try {
    const { communityId } = req.params;
    const membersData = await hlPost(
      "/higherlogic/external/api/v1.0/Communities/GetCommunityMembers",
      req,
      {
        CommunityKey: communityId,
        LegacyGroupKey: "",
        StartRecord: 1,
        EndRecord: 3000
      }
    );

    const members = normalizeArray(membersData);
    const ids = members
      .map((member) => extractMemberId(member))
      .filter(Boolean);

    const rows = [];
    for (const memberId of ids) {
      try {
        const detail = await hlFetch(
          `/higherlogic/external/api/v1.0/Contacts/GetContact?contactKey=${encodeURIComponent(memberId)}`,
          req
        );
        rows.push(toTableRow(detail));
      } catch {
        rows.push({
          FirstName: "",
          LastName: "",
          CompanyName: "",
          Email: "",
          CompanyTitle: "",
          City: "",
          StateProvinceCode: "",
          PostalCode: "",
          CountryCode: "",
          CreateDate: "",
          Member: "",
          Region: "",
          UpdatedOn: "",
          MembershipLevel: "",
          MembershipStatus: ""
        });
      }
    }

    res.json({
      communityId,
      totalMembers: members.length,
      detailedMembers: rows.length,
      rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/sync/status", (req, res) => {
  res.json({
    ...syncState,
    stats: getStats(db)
  });
});

app.get("/api/db/stats", (req, res) => {
  try {
    res.json(getStats(db));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/db/info", (req, res) => {
  try {
    const databasePath = getDatabasePath();
    let fileExists = false;
    let sizeBytes = 0;
    try {
      const st = fs.statSync(databasePath);
      fileExists = st.isFile();
      sizeBytes = st.size;
    } catch {
      // file missing or not readable
    }
    res.json({
      databasePath,
      fileExists,
      sizeBytes,
      ...getStats(db)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/db/users", (req, res) => {
  try {
    const limit = Math.min(
      500,
      Math.max(1, parseInt(req.query.limit || "100", 10))
    );
    const offset = Math.max(0, parseInt(req.query.offset || "0", 10));
    const q = req.query.q || "";
    const sortBy = String(req.query.sort || "updated_on").trim();
    const sortDir =
      String(req.query.dir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const { rows, total, sortBy: appliedSort, sortDir: appliedDir } = listUsers(
      db,
      { limit, offset, q, sortBy, sortDir }
    );
    const stats = getStats(db);
    res.json({
      rows,
      total,
      sortBy: appliedSort,
      sortDir: appliedDir,
      lastGlobalSyncCompleted: stats.lastSyncCompletedAt,
      lastGlobalSyncStarted: stats.lastSyncStartedAt,
      contactsMissingDetails: stats.contactsMissingDetails
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/db/communities", (req, res) => {
  try {
    res.json(listCommunitiesWithCounts(db));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/db/memberships", (req, res) => {
  try {
    const ck = req.query.communityKey || "";
    if (!ck) {
      return res.status(400).json({ error: "communityKey query required" });
    }
    res.json(listMembershipsForCommunity(db, ck));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/db/sync", (req, res) => {
  if (syncJobRunning) {
    return res.status(409).json({ error: "Sync already running" });
  }
  const cookieHeader = req.headers.cookie || "";
  let refreshAll = false;
  try {
    primeApiAccessTokenFromRequest(req);
    refreshAll = Boolean(req.body?.refreshAllDetails);
    getActiveBearerToken(makeSyncReq(cookieHeader));
  } catch {
    return res.status(401).json({ error: "Not authenticated" });
  }
  syncJobRunning = true;
  runFullSync(cookieHeader, refreshAll).finally(() => {
    syncJobRunning = false;
  });
  res.json({ ok: true, started: true });
});

app.get("/api/hubspot/community-mappings", (req, res) => {
  try {
    const enabledOnly = String(req.query.enabledOnly || "") === "1";
    res.json(listHubspotCommunityMappings(db, { enabledOnly }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/hubspot/community-mappings", (req, res) => {
  try {
    const row = createHubspotCommunityMapping(db, req.body || {});
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/hubspot/community-mappings/:id", (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const row = updateHubspotCommunityMapping(db, id, req.body || {});
    res.json(row);
  } catch (e) {
    const status = String(e.message || "").includes("not found") ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

app.delete("/api/hubspot/community-mappings/:id", (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const ok = deleteHubspotCommunityMapping(db, id);
    if (!ok) return res.status(404).json({ error: "Mapping not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/hubspot/contact-properties", async (req, res) => {
  try {
    const token = getHubspotApiToken(req);
    if (!token) {
      return res.status(503).json({
        error:
          "HubSpot is not connected. Connect OAuth or set HUBSPOT_ACCESS_TOKEN."
      });
    }
    const properties = await listHubspotContactProperties(token);
    properties.sort((a, b) =>
      String(a.label || a.name).localeCompare(String(b.label || b.name))
    );
    res.json({ properties });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/db/member-updates", async (req, res) => {
  const cookieHeader = req.headers.cookie || "";
  try {
    primeApiAccessTokenFromRequest(req);
    getActiveBearerToken(makeSyncReq(cookieHeader));
  } catch {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const days = Math.min(
    3660,
    Math.max(1, parseInt(String(req.body?.days ?? 60), 10))
  );
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 86400000);
  const payload = {
    StartDate: startDate.toISOString(),
    EndDate: endDate.toISOString()
  };
  const syncReq = makeSyncReq(cookieHeader);
  try {
    getActiveBearerToken(syncReq);
    const data = await hlPost(
      "/higherlogic/external/api/v2.0/System/GetCommunityMemberUpdates",
      syncReq,
      payload
    );
    const joins = Array.isArray(data.CommunityJoins)
      ? data.CommunityJoins
      : [];
    const removals = Array.isArray(data.CommunityRemovals)
      ? data.CommunityRemovals
      : [];
    const {
      stats: applied,
      touchedContactKeys,
      joinContactKeys,
      removalContactKeys
    } = applyCommunityMemberUpdates(db, {
      communityJoins: joins,
      communityRemovals: removals
    });

    const rawRows = touchedContactKeys.length
      ? getUsersByContactKeys(db, touchedContactKeys)
      : [];
    const membershipsByContact = getMembershipCommunityKeysByContactKeys(
      db,
      touchedContactKeys
    );
    const communityMappings = getEnabledCommunityMappings();
    const hubspotRows = buildHubspotSyncRows(
      rawRows,
      membershipsByContact,
      new Set(joinContactKeys),
      new Set(removalContactKeys),
      communityMappings
    );

    const hubspotToken =
      getHubspotApiToken(req) ||
      String(process.env.HUBSPOT_ACCESS_TOKEN || "").trim();
    let hubspot;
    let hubspotFoundPreview = { columns: {}, rows: [] };
    let hubspotCustomFieldResolution = [];
    if (!hubspotToken) {
      hubspot = {
        skipped: true,
        reason:
          "HubSpot is not connected. Connect OAuth or set HUBSPOT_ACCESS_TOKEN."
      };
    } else if (!hubspotRows.length) {
      hubspot = {
        skipped: true,
        reason: "No SQLite users matched member-update events (by email)."
      };
    } else {
      try {
        const {
          resolvedByKey,
          resolution: customResolution
        } = await resolveHubspotCustomFields(hubspotToken, communityMappings);
        hubspotCustomFieldResolution = customResolution;
        const hsProperties = [
          "firstname",
          "lastname",
          "company",
          "email",
          "jobtitle",
          "city",
          "state",
          "zip",
          "country",
          "createdate",
          "lastmodifieddate",
          ...Object.values(resolvedByKey).filter(Boolean)
        ];
        const hs = await checkContactsExistInHubspot(
          hubspotToken,
          hubspotRows,
          hsProperties
        );
        const existing = hs.existingEmails || new Set();
        for (const row of hubspotRows) {
          const email = String(row.email || "").trim().toLowerCase();
          row.hubspot_exists = Boolean(email && existing.has(email));
        }
        const hlByEmail = new Map();
        for (const row of hubspotRows) {
          const email = String(row.email || "").trim().toLowerCase();
          if (email) hlByEmail.set(email, row);
        }
        const normalizeBoolish = (v) => {
          const s = String(v == null ? "" : v)
            .trim()
            .toLowerCase();
          if (!s) return "false";
          if (["true", "yes", "1", "y"].includes(s)) return "true";
          if (["false", "no", "0", "n"].includes(s)) return "false";
          return s;
        };
        const normalizeTextish = (v) =>
          String(v == null ? "" : v)
            .trim()
            .toLowerCase();
        const foundRows = (hs.foundContacts || []).map((item) => {
          const p = item?.properties || {};
          const email = String(p.email || "").trim().toLowerCase();
          const hl = hlByEmail.get(email) || {};
          const hsValues = {
            first_name: p.firstname || "",
            last_name: p.lastname || "",
            company_name: p.company || "",
            email: email || p.email || "",
            job_title: p.jobtitle || "",
            city: p.city || "",
            state_region: p.state || "",
            postal_code: p.zip || "",
            country_gp_data: p.country || "",
            contact_create_date: p.createdate || "",
            contact_last_updated_date: p.lastmodifieddate || ""
          };
          for (const m of communityMappings) {
            const hsProp = resolvedByKey[m.field_key];
            hsValues[m.field_key] = hsProp ? p[hsProp] || "" : "";
          }
          const comparePairs = [
            ["first_name", "first_name", "text"],
            ["last_name", "last_name", "text"],
            ["company_name", "company_name", "text"],
            ["email", "email", "text"],
            ["job_title", "company_title", "text"],
            ["city", "city", "text"],
            ["state_region", "state_province_code", "text"],
            ["postal_code", "postal_code", "text"],
            ["country_gp_data", "country_code", "text"],
            ...communityMappings.map((m) => [
              m.field_key,
              m.field_key,
              "boolish"
            ])
          ];
          const mismatchFields = [];
          for (const [hsKey, hlKey, kind] of comparePairs) {
            const hsRaw = hsValues[hsKey];
            const hlRaw = hl[hlKey];
            const hsNorm =
              kind === "boolish"
                ? normalizeBoolish(hsRaw)
                : normalizeTextish(hsRaw);
            const hlNorm =
              kind === "boolish"
                ? normalizeBoolish(hlRaw)
                : normalizeTextish(hlRaw);
            if (hsNorm !== hlNorm) mismatchFields.push(hsKey);
          }
          return {
            ...hsValues,
            mismatch_fields: mismatchFields
          };
        });
        foundRows.sort((a, b) => String(a.email).localeCompare(String(b.email)));
        const resolvedNameFor = (key) =>
          hubspotCustomFieldResolution.find((r) => r.key === key)
            ?.resolvedInternalName || "unresolved";
        const foundColumns = {
          first_name: "First Name",
          last_name: "Last Name",
          company_name: "Company Name",
          email: "Email",
          job_title: "Job Title",
          city: "City",
          state_region: "State/Region",
          postal_code: "Postal Code",
          country_gp_data: "Country (GP Data)",
          contact_create_date: "Contact Create Date",
          contact_last_updated_date: "Contact Last Updated Date"
        };
        for (const m of communityMappings) {
          foundColumns[m.field_key] =
            `${m.label || m.field_key} (${resolvedNameFor(m.field_key)})`;
        }
        hubspotFoundPreview = {
          columns: foundColumns,
          rows: foundRows
        };
        hubspot = {
          skipped: false,
          checked: hs.checked,
          found: hs.found,
          missing: hs.missing,
          batchErrors: hs.errors.length ? hs.errors : undefined
        };
        if (hs.errors.length) {
          console.error("[hubspot] batch existence-check errors:", hs.errors);
        }
      } catch (err) {
        hubspot = {
          skipped: false,
          error: err.message,
          checked: hubspotRows.length
        };
      }
    }

    res.json({
      ok: true,
      range: {
        days,
        startDate: payload.StartDate,
        endDate: payload.EndDate
      },
      api: {
        joinCount: data.JoinCount ?? joins.length,
        removalCount: data.RemovalCount ?? removals.length
      },
      applied,
      communityMappings: communityMappings.map((m) => ({
        id: m.id,
        field_key: m.field_key,
        label: m.label,
        community_key: m.community_key,
        hubspot_property: m.hubspot_property
      })),
      hubspotPreview: {
        columns: buildHubspotPreviewColumns(communityMappings),
        rows: hubspotRows
      },
      hubspotFoundPreview,
      hubspotCustomFieldResolution,
      hubspot
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/db/member-updates/sync-hubspot", async (req, res) => {
  const hubspotToken =
    getHubspotApiToken(req) ||
    String(process.env.HUBSPOT_ACCESS_TOKEN || "").trim();
  if (!hubspotToken) {
    return res.status(503).json({
      error:
        "HubSpot is not connected. Connect OAuth or set HUBSPOT_ACCESS_TOKEN."
    });
  }
  const selectedRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!selectedRows.length) {
    return res.status(400).json({ error: "No rows selected." });
  }
  const rowsWithEmail = selectedRows.filter((r) =>
    Boolean(String(r?.email || "").trim())
  );
  if (!rowsWithEmail.length) {
    return res.status(400).json({ error: "No selected rows have an email." });
  }
  try {
    const result = await syncHubspotRowsByEmail(rowsWithEmail, hubspotToken);
    return res.json({
      ok: true,
      ...result
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/automation/status", (req, res) => {
  res.json({
    ...automationState
  });
});

app.post("/api/automation/config", (req, res) => {
  primeApiAccessTokenFromRequest(req);
  const enabled = Boolean(req.body?.enabled);
  const intervalDays = normalizeAutomationDays(req.body?.intervalDays, 7);
  const lookbackDays = normalizeAutomationDays(req.body?.lookbackDays, 7);
  automationState.enabled = enabled;
  automationState.intervalDays = intervalDays;
  automationState.lookbackDays = lookbackDays;
  automationState.lastError = null;
  if (enabled) {
    automationState.nextRunAt = new Date(
      Date.now() + intervalDays * 24 * 60 * 60 * 1000
    ).toISOString();
    startAutomationTimer();
  } else {
    automationState.nextRunAt = null;
    stopAutomationTimer();
  }
  res.json({ ok: true, ...automationState });
});

app.post("/api/automation/run-now", async (req, res) => {
  primeApiAccessTokenFromRequest(req);
  if (!automationState.enabled) {
    return res.status(400).json({ error: "Automation is disabled." });
  }
  if (automationState.running) {
    return res.status(409).json({ error: "Automation already running." });
  }
  await runAutomationCycle();
  res.json({ ok: true, ...automationState });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});