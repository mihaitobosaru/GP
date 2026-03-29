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
  applyCommunityMemberUpdates
} from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const port = process.env.PORT || 3000;

const BASE_URL = process.env.HIGHERLOGIC_BASE_URL || "https://gpsb02.connectedcommunity.org";
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
const OAUTH_AUTHORIZE_URL = `https://gpsb02.connectedcommunity.org/higherlogic/external/oauth/connect/authorize`;
const OAUTH_TOKEN_URL = `https://gpsb02.connectedcommunity.org/higherlogic/external/oauth/connect/token`;
const OAUTH_REDIRECT_URI = (
  process.env.HIGHERLOGIC_OAUTH_REDIRECT_URI ||
  `http://localhost:${port}/auth/callback`
).trim();
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

app.use(express.json());

const db = openDatabase();

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

function extractToken(data) {
  if (!data || typeof data !== "object") return "";
  return (
    data.access_token ||
    data.AccessToken ||
    data.Token ||
    data.token ||
    data.Data?.access_token ||
    data.Data?.AccessToken ||
    data.Data?.Token ||
    ""
  );
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

    oauthAccessToken = String(data.access_token || "").trim();
    if (!oauthAccessToken) {
      return res.status(500).send("Token response did not include access_token.");
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
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        Username: API_USERNAME,
        Password: API_PASSWORD
      })
    });

    const loginText = await loginResponse.text();
    let loginData;
    try {
      loginData = loginText ? JSON.parse(loginText) : {};
    } catch {
      loginData = { raw: loginText };
    }

    console.log("[auth/callback] Authentication/Login status:", loginResponse.status);
    console.log("[auth/callback] Authentication/Login response:", loginData);

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

    apiAccessToken = String(extractToken(loginData)).trim();
    console.log("[auth/callback] Extracted API token length:", apiAccessToken.length);
    if (!apiAccessToken) {
      return res.status(500).send(
        `Authentication/Login succeeded but no API token found in response: ${JSON.stringify(loginData)}`
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

app.post("/api/db/member-updates", async (req, res) => {
  const cookieHeader = req.headers.cookie || "";
  try {
    getActiveBearerToken(makeSyncReq(cookieHeader));
  } catch {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const days = Math.min(
    366,
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
    const applied = applyCommunityMemberUpdates(db, {
      communityJoins: joins,
      communityRemovals: removals
    });
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
      applied
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});