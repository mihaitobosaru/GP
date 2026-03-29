import express from "express";
import crypto from "node:crypto";
import {
  openDatabase,
  replaceAllMemberships,
  upsertCommunity,
  upsertUserFromRow,
  getExistingContactKeys,
  getStats,
  setSyncMeta,
  listUsers,
  listCommunitiesWithCounts,
  listMembershipsForCommunity
} from "./db.mjs";

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

app.get("/api/db/users", (req, res) => {
  try {
    const limit = Math.min(
      500,
      Math.max(1, parseInt(req.query.limit || "100", 10))
    );
    const offset = Math.max(0, parseInt(req.query.offset || "0", 10));
    const q = req.query.q || "";
    const { rows, total } = listUsers(db, { limit, offset, q });
    const stats = getStats(db);
    res.json({
      rows,
      total,
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

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Higher Logic Explorer</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body {
      font-family: Arial, sans-serif;
      background: #f6f7fb;
      margin: 0;
      padding: 24px;
      color: #1f2937;
    }
    .wrap {
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 {
      margin-bottom: 8px;
    }
    .sub {
      color: #6b7280;
      margin-bottom: 24px;
    }
    .grid {
      display: grid;
      grid-template-columns: 320px 320px 1fr;
      gap: 16px;
    }
    .card {
      background: white;
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.06);
      min-height: 220px;
    }
    .card h2 {
      margin-top: 0;
      font-size: 18px;
    }
    button {
      background: #111827;
      color: white;
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      cursor: pointer;
      margin-bottom: 12px;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    select {
      width: 100%;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid #d1d5db;
      margin-bottom: 12px;
      background: white;
    }
    .status {
      font-size: 13px;
      color: #374151;
      margin-bottom: 10px;
      min-height: 18px;
    }
    .list {
      max-height: 420px;
      overflow: auto;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
    }
    .item {
      padding: 10px 12px;
      border-bottom: 1px solid #eef2f7;
      cursor: pointer;
    }
    .item:hover {
      background: #f9fafb;
    }
    .item:last-child {
      border-bottom: 0;
    }
    .muted {
      color: #6b7280;
      font-size: 12px;
    }
    pre {
      background: #0f172a;
      color: #e5e7eb;
      padding: 14px;
      border-radius: 10px;
      overflow: auto;
      min-height: 520px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .pill {
      display: inline-block;
      font-size: 12px;
      padding: 3px 8px;
      border-radius: 999px;
      background: #eef2ff;
      color: #4338ca;
      margin-left: 8px;
    }
    .tableWrap {
      overflow: auto;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background: white;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid #eef2f7;
      white-space: nowrap;
    }
    th {
      position: sticky;
      top: 0;
      background: #f9fafb;
      z-index: 1;
    }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    .tab {
      background: #e5e7eb;
      color: #111827;
    }
    .tab.active {
      background: #111827;
      color: white;
    }
    .tab-panel { display: block; }
    .tab-panel.hidden { display: none; }
    .statRow {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 16px;
    }
    .statBox {
      background: white;
      border-radius: 10px;
      padding: 12px 16px;
      border: 1px solid #e5e7eb;
      min-width: 140px;
    }
    .statBox strong { display: block; font-size: 22px; }
    .statBox span { color: #6b7280; font-size: 12px; }
    .progressLine {
      font-size: 13px;
      color: #374151;
      margin-bottom: 12px;
      min-height: 20px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Higher Logic Explorer</h1>
    <div class="sub">Browse communities and sync members to a local database.</div>
    <div class="tabs">
      <button type="button" class="tab active" id="tabBtnExplorer">Explorer</button>
      <button type="button" class="tab" id="tabBtnDatabase">Database</button>
    </div>

    <div class="status">
      Auth status: <strong id="authStatus">Checking...</strong>
      <button id="loginBtn" style="margin-left:10px;">Login with Higher Logic</button>
    </div>

    <div id="panelExplorer" class="tab-panel">
    <div class="sub" style="margin-top:12px;">Load communities → pick one → load members → pick one → inspect full member details</div>

    <div class="grid">
      <div class="card">
        <h2>1. Communities <span id="communityCount" class="pill" style="display:none;"></span></h2>
        <button id="loadCommunitiesBtn">Load communities</button>
        <div id="communitiesStatus" class="status"></div>
        <div id="communitiesList" class="list"></div>
      </div>

      <div class="card">
        <h2>2. Members <span id="memberCount" class="pill" style="display:none;"></span></h2>
        <div class="status">Selected community ID: <strong id="selectedCommunityId">-</strong></div>
        <button id="loadMembersBtn" disabled>Load members</button>
        <button id="loadMemberTableBtn" disabled>Load member table</button>
        <div id="membersStatus" class="status"></div>
        <div id="membersList" class="list"></div>
      </div>

      <div class="card">
        <h2>3. Member details</h2>
        <div class="status">Selected member ID: <strong id="selectedMemberId">-</strong></div>
        <button id="loadMemberDetailsBtn" disabled>Load member details</button>
        <div id="detailsStatus" class="status"></div>
        <pre id="detailsOutput">No member selected yet.</pre>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <h2>4. Community members table</h2>
      <div id="memberTableStatus" class="status"></div>
      <div id="memberTableWrap" class="tableWrap"></div>
    </div>
    </div>

    <div id="panelDatabase" class="tab-panel hidden">
      <div class="card">
        <h2>Database sync</h2>
        <p class="muted" style="margin-top:0;">Fetches all communities, all members per community, then contact details only for users not yet stored (unless you refresh all). Failed API calls are retried; tune <code>SYNC_CONTACT_CONCURRENCY</code> (default 4) and <code>SYNC_BATCH_DELAY_MS</code> (default 75) if Higher Logic rate-limits you.</p>
        <div class="statRow" id="dbStatsRow">
          <div class="statBox"><span>Communities</span><strong id="dbStatCommunities">0</strong></div>
          <div class="statBox"><span>Unique users</span><strong id="dbStatUsers">0</strong></div>
          <div class="statBox"><span>Membership links</span><strong id="dbStatLinks">0</strong></div>
          <div class="statBox"><span>Memberships still missing contact row</span><strong id="dbStatPending">0</strong></div>
          <div class="statBox"><span>Last sync completed</span><strong id="dbStatLastSync" style="font-size:14px;">—</strong></div>
        </div>
        <label class="muted" style="display:block;margin-bottom:8px;">
          <input type="checkbox" id="syncRefreshAll" /> Refresh all contact details (slow; re-fetches every user)
        </label>
        <button type="button" id="dbSyncBtn">Re-sync now</button>
        <div id="dbSyncProgress" class="progressLine"></div>
      </div>

      <div class="card" style="margin-top:16px;">
        <h2>Communities in database</h2>
        <div id="dbCommunitiesStatus" class="status"></div>
        <div id="dbCommunitiesWrap" class="tableWrap"></div>
      </div>

      <div class="card" style="margin-top:16px;">
        <h2>Users in database</h2>
        <p class="muted" style="margin-top:0;">All user columns from SQLite, plus <strong>communities_list</strong> (names) and global sync times. Use paging below; default page size is 100 rows.</p>
        <div style="margin-bottom:10px;">
          <input type="search" id="dbUserSearch" placeholder="Search name, email, key…" style="width:100%;max-width:320px;padding:8px;border-radius:8px;border:1px solid #d1d5db;" />
        </div>
        <div id="dbUsersStatus" class="status"></div>
        <div id="dbUsersWrap" class="tableWrap"></div>
        <div style="margin-top:10px;display:flex;gap:8px;align-items:center;">
          <button type="button" id="dbUsersPrev" disabled>Previous</button>
          <span id="dbUsersPage" class="muted"></span>
          <button type="button" id="dbUsersNext" disabled>Next</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const authStatusEl = document.getElementById("authStatus");
    const loginBtn = document.getElementById("loginBtn");
    const loadCommunitiesBtn = document.getElementById("loadCommunitiesBtn");
    const loadMembersBtn = document.getElementById("loadMembersBtn");
    const loadMemberTableBtn = document.getElementById("loadMemberTableBtn");
    const loadMemberDetailsBtn = document.getElementById("loadMemberDetailsBtn");

    const communitiesStatus = document.getElementById("communitiesStatus");
    const membersStatus = document.getElementById("membersStatus");
    const detailsStatus = document.getElementById("detailsStatus");
    const memberTableStatus = document.getElementById("memberTableStatus");

    const communitiesList = document.getElementById("communitiesList");
    const membersList = document.getElementById("membersList");
    const detailsOutput = document.getElementById("detailsOutput");
    const memberTableWrap = document.getElementById("memberTableWrap");

    const selectedCommunityIdEl = document.getElementById("selectedCommunityId");
    const selectedMemberIdEl = document.getElementById("selectedMemberId");
    const communityCountEl = document.getElementById("communityCount");
    const memberCountEl = document.getElementById("memberCount");

    let selectedCommunityId = null;
    let selectedMemberId = null;
    let communities = [];
    let members = [];
    const memberTableColumns = [
      "FirstName",
      "LastName",
      "CompanyName",
      "Email",
      "CompanyTitle",
      "City",
      "StateProvinceCode",
      "PostalCode",
      "CountryCode",
      "CreateDate",
      "Member",
      "Region",
      "UpdatedOn",
      "MembershipLevel",
      "MembershipStatus"
    ];

    const tabBtnExplorer = document.getElementById("tabBtnExplorer");
    const tabBtnDatabase = document.getElementById("tabBtnDatabase");
    const panelExplorer = document.getElementById("panelExplorer");
    const panelDatabase = document.getElementById("panelDatabase");
    const dbSyncBtn = document.getElementById("dbSyncBtn");
    const dbSyncProgress = document.getElementById("dbSyncProgress");
    const dbCommunitiesWrap = document.getElementById("dbCommunitiesWrap");
    const dbCommunitiesStatus = document.getElementById("dbCommunitiesStatus");
    const dbUsersWrap = document.getElementById("dbUsersWrap");
    const dbUsersStatus = document.getElementById("dbUsersStatus");
    const dbUserSearch = document.getElementById("dbUserSearch");
    const dbUsersPrev = document.getElementById("dbUsersPrev");
    const dbUsersNext = document.getElementById("dbUsersNext");
    const dbUsersPage = document.getElementById("dbUsersPage");

    let dbUsersOffset = 0;
    const dbUsersLimit = 100;
    let syncPollTimer = null;

    function showTab(which) {
      if (which === "explorer") {
        panelExplorer.classList.remove("hidden");
        panelDatabase.classList.add("hidden");
        tabBtnExplorer.classList.add("active");
        tabBtnDatabase.classList.remove("active");
      } else {
        panelExplorer.classList.add("hidden");
        panelDatabase.classList.remove("hidden");
        tabBtnExplorer.classList.remove("active");
        tabBtnDatabase.classList.add("active");
        loadDbStats();
        loadDbCommunities();
        dbUsersOffset = 0;
        loadDbUsersPage();
      }
    }

    tabBtnExplorer.onclick = () => showTab("explorer");
    tabBtnDatabase.onclick = () => showTab("database");

    async function loadDbStats() {
      try {
        const res = await fetch("/api/db/stats");
        const s = await res.json();
        if (!res.ok) throw new Error(s.error || "stats failed");
        document.getElementById("dbStatCommunities").textContent = s.communities;
        document.getElementById("dbStatUsers").textContent = s.users;
        document.getElementById("dbStatLinks").textContent = s.memberships;
        const elP = document.getElementById("dbStatPending");
        if (elP) elP.textContent = s.contactsMissingDetails != null ? s.contactsMissingDetails : "—";
        document.getElementById("dbStatLastSync").textContent =
          s.lastSyncCompletedAt || "—";
      } catch (e) {
        document.getElementById("dbStatLastSync").textContent = "Error";
      }
    }

    function renderDbCommunitiesTable(rows) {
      dbCommunitiesWrap.innerHTML = "";
      if (!rows.length) {
        dbCommunitiesWrap.textContent = "No communities synced yet.";
        return;
      }
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      ["Name", "Community key", "Members", "Synced at"].forEach((h) => {
        const th = document.createElement("th");
        th.textContent = h;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      rows.forEach((r) => {
        const tr = document.createElement("tr");
        [r.name, r.community_key, r.member_count, r.synced_at || ""].forEach(
          (cell) => {
            const td = document.createElement("td");
            td.textContent = cell == null ? "" : String(cell);
            tr.appendChild(td);
          }
        );
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      dbCommunitiesWrap.appendChild(table);
    }

    async function loadDbCommunities() {
      dbCommunitiesStatus.textContent = "Loading…";
      try {
        const res = await fetch("/api/db/communities");
        const rows = await res.json();
        if (!res.ok) throw new Error(rows.error || "failed");
        renderDbCommunitiesTable(Array.isArray(rows) ? rows : []);
        dbCommunitiesStatus.textContent = "";
      } catch (e) {
        dbCommunitiesStatus.textContent = "Error: " + e.message;
      }
    }

    function orderUserTableColumns(keys) {
      const priority = [
        "contact_key",
        "first_name",
        "last_name",
        "company_name",
        "email",
        "company_title",
        "city",
        "state_province_code",
        "postal_code",
        "country_code",
        "region",
        "create_date",
        "updated_on",
        "is_member",
        "membership_level",
        "membership_status",
        "db_updated_at",
        "communities_list"
      ];
      const out = [];
      for (const p of priority) {
        if (keys.includes(p)) out.push(p);
      }
      for (const k of [...keys].sort()) {
        if (!out.includes(k)) out.push(k);
      }
      return out;
    }

    function renderDbUsersTable(rows, meta) {
      dbUsersWrap.innerHTML = "";
      if (!rows.length) {
        dbUsersWrap.textContent = "No users.";
        return;
      }
      const sampleKeys = Object.keys(rows[0]);
      const cols = orderUserTableColumns(sampleKeys);
      if (!cols.includes("last_global_sync_completed")) {
        cols.push("last_global_sync_completed");
      }
      if (!cols.includes("last_global_sync_started")) {
        cols.push("last_global_sync_started");
      }
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      cols.forEach((c) => {
        const th = document.createElement("th");
        th.textContent = c;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      rows.forEach((r) => {
        const tr = document.createElement("tr");
        cols.forEach((c) => {
          const td = document.createElement("td");
          let val;
          if (c === "last_global_sync_completed") {
            val = meta && meta.lastGlobalSyncCompleted || "";
          } else if (c === "last_global_sync_started") {
            val = meta && meta.lastGlobalSyncStarted || "";
          } else {
            val = r[c];
          }
          if (c === "is_member") {
            val = val === 1 || val === true ? "Yes" : val === 0 || val === false ? "No" : val;
          }
          td.textContent = val == null ? "" : String(val);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      dbUsersWrap.appendChild(table);
    }

    async function loadDbUsersPage() {
      dbUsersStatus.textContent = "Loading…";
      const q = (dbUserSearch && dbUserSearch.value) || "";
      try {
        const res = await fetch(
          "/api/db/users?limit=" +
            dbUsersLimit +
            "&offset=" +
            dbUsersOffset +
            "&q=" +
            encodeURIComponent(q)
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "failed");
        const meta = {
          lastGlobalSyncCompleted: data.lastGlobalSyncCompleted || "",
          lastGlobalSyncStarted: data.lastGlobalSyncStarted || "",
          contactsMissingDetails: data.contactsMissingDetails
        };
        renderDbUsersTable(data.rows || [], meta);
        const total = data.total || 0;
        dbUsersPage.textContent =
          "Showing " +
          (dbUsersOffset + 1) +
          "–" +
          Math.min(dbUsersOffset + dbUsersLimit, total) +
          " of " +
          total;
        dbUsersPrev.disabled = dbUsersOffset <= 0;
        dbUsersNext.disabled = dbUsersOffset + dbUsersLimit >= total;
        dbUsersStatus.textContent =
          "Memberships still missing a stored contact row (run sync): " +
          (data.contactsMissingDetails != null ? data.contactsMissingDetails : "—");
      } catch (e) {
        dbUsersStatus.textContent = "Error: " + e.message;
      }
    }

    dbUsersPrev.onclick = () => {
      dbUsersOffset = Math.max(0, dbUsersOffset - dbUsersLimit);
      loadDbUsersPage();
    };
    dbUsersNext.onclick = () => {
      dbUsersOffset += dbUsersLimit;
      loadDbUsersPage();
    };

    let searchDebounce = null;
    if (dbUserSearch) {
      dbUserSearch.addEventListener("input", () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
          dbUsersOffset = 0;
          loadDbUsersPage();
        }, 400);
      });
    }

    function startSyncPoll() {
      if (syncPollTimer) clearInterval(syncPollTimer);
      syncPollTimer = setInterval(async () => {
        try {
          const res = await fetch("/api/sync/status");
          const s = await res.json();
          if (s.running) {
            dbSyncProgress.textContent =
              (s.phase || "") +
              ": " +
              (s.message || "") +
              " — communities " +
              (s.communitiesDone || 0) +
              "/" +
              (s.communitiesTotal || 0) +
              ", contacts " +
              (s.contactsFetched || 0) +
              "/" +
              (s.contactsToFetch || 0) +
              (s.contactsSkipped ? " (already in DB " + s.contactsSkipped + ")" : "") +
              (s.contactsSucceeded != null || s.contactsFailed != null
                ? " — ok " + (s.contactsSucceeded || 0) + ", failed " + (s.contactsFailed || 0)
                : "");
          } else {
            dbSyncProgress.textContent = s.error
              ? "Error: " + s.error
              : "Idle. Last completed: " +
                (s.stats && s.stats.lastSyncCompletedAt
                  ? s.stats.lastSyncCompletedAt
                  : "—");
            clearInterval(syncPollTimer);
            syncPollTimer = null;
            loadDbStats();
            loadDbCommunities();
            dbUsersOffset = 0;
            loadDbUsersPage();
          }
        } catch {
          clearInterval(syncPollTimer);
          syncPollTimer = null;
        }
      }, 1000);
    }

    if (dbSyncBtn) {
      dbSyncBtn.onclick = async () => {
        const refreshAll = document.getElementById("syncRefreshAll").checked;
        dbSyncProgress.textContent = "Starting…";
        try {
          const res = await fetch("/api/db/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshAllDetails: refreshAll })
          });
          const data = await res.json();
          if (res.status === 409) {
            dbSyncProgress.textContent = data.error || "Already running";
            startSyncPoll();
            return;
          }
          if (!res.ok) {
            dbSyncProgress.textContent = data.error || "Failed";
            return;
          }
          startSyncPoll();
        } catch (e) {
          dbSyncProgress.textContent = "Error: " + e.message;
        }
      };
    }

    async function refreshAuthStatus() {
      try {
        const res = await fetch("/api/auth/status");
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Failed to read auth status");
        }

        if (data.authenticated) {
          authStatusEl.textContent = "Authenticated (" + data.source + ")";
        } else if (data.oauthConfigured) {
          authStatusEl.textContent = "Not authenticated";
        } else {
          authStatusEl.textContent = "No token configured";
        }
      } catch (err) {
        authStatusEl.textContent = "Error: " + err.message;
      }
    }

    loginBtn.onclick = () => {
      window.location.href = "/auth/login";
    };

    function safeArray(data) {
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.Data)) return data.Data;
      if (Array.isArray(data?.data)) return data.data;
      if (Array.isArray(data?.Results)) return data.Results;
      if (Array.isArray(data?.results)) return data.results;
      return [];
    }

    function getCommunityId(item) {
      return item.CommunityKey || item.Id || item.CommunityId || item.id || item.communityId;
    }

    function getCommunityName(item) {
      return item.Name || item.Title || item.CommunityName || item.name || "Unnamed community";
    }

    function getMemberId(item) {
      return item.ContactKey || item.UserKey || item.MemberId || item.Id || item.id;
    }

    function getMemberName(item) {
      const first = item.FirstName || item.firstName || "";
      const last = item.LastName || item.lastName || "";
      const full = (first + " " + last).trim();
      return full || item.DisplayName || item.Name || item.EmailAddress || "Unnamed member";
    }

    function renderCommunities(items) {
      communitiesList.innerHTML = "";
      if (!items.length) {
        communitiesList.innerHTML = '<div class="item">No communities found</div>';
        return;
      }

      items.forEach((item) => {
        const id = getCommunityId(item);
        const name = getCommunityName(item);

        const div = document.createElement("div");
        div.className = "item";
        div.innerHTML = '<strong>' + name + '</strong><div class="muted">ID: ' + id + '</div>';
        div.onclick = () => {
          selectedCommunityId = id;
          selectedMemberId = null;
          selectedCommunityIdEl.textContent = id || "-";
          selectedMemberIdEl.textContent = "-";
          loadMembersBtn.disabled = !selectedCommunityId;
          loadMemberTableBtn.disabled = !selectedCommunityId;
          loadMemberDetailsBtn.disabled = true;
          membersList.innerHTML = "";
          memberCountEl.style.display = "none";
          detailsOutput.textContent = "No member selected yet.";
          detailsStatus.textContent = "";
          memberTableStatus.textContent = "";
          memberTableWrap.innerHTML = "";
        };
        communitiesList.appendChild(div);
      });
    }

    function renderMembers(items) {
      membersList.innerHTML = "";
      if (!items.length) {
        membersList.innerHTML = '<div class="item">No members found</div>';
        return;
      }

      items.forEach((item) => {
        const id = getMemberId(item);
        const name = getMemberName(item);

        const div = document.createElement("div");
        div.className = "item";
        div.innerHTML = '<strong>' + name + '</strong><div class="muted">ID: ' + id + '</div>';
        div.onclick = () => {
          selectedMemberId = id;
          selectedMemberIdEl.textContent = id || "-";
          loadMemberDetailsBtn.disabled = !selectedMemberId;
        };
        membersList.appendChild(div);
      });
    }

    function renderMemberTable(rows) {
      memberTableWrap.innerHTML = "";
      if (!rows.length) {
        memberTableWrap.textContent = "No member details found.";
        return;
      }

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      memberTableColumns.forEach((col) => {
        const th = document.createElement("th");
        th.textContent = col;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      rows.forEach((row) => {
        const tr = document.createElement("tr");
        memberTableColumns.forEach((col) => {
          const td = document.createElement("td");
          td.textContent = row[col] ?? "";
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      memberTableWrap.appendChild(table);
    }

    loadCommunitiesBtn.onclick = async () => {
      communitiesStatus.textContent = "Loading communities...";
      communitiesList.innerHTML = "";
      communityCountEl.style.display = "none";

      try {
        const res = await fetch("/api/communities");
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Failed to load communities");
        }

        communities = safeArray(data);
        renderCommunities(communities);

        communitiesStatus.textContent = "Communities loaded";
        communityCountEl.style.display = "inline-block";
        communityCountEl.textContent = communities.length;
      } catch (err) {
        communitiesStatus.textContent = "Error: " + err.message;
      }
    };

    loadMembersBtn.onclick = async () => {
      if (!selectedCommunityId) return;

      membersStatus.textContent = "Loading members...";
      membersList.innerHTML = "";
      memberCountEl.style.display = "none";

      try {
        const res = await fetch('/api/communities/' + encodeURIComponent(selectedCommunityId) + '/members');
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Failed to load members");
        }

        members = safeArray(data);
        renderMembers(members);

        membersStatus.textContent = "Members loaded";
        memberCountEl.style.display = "inline-block";
        memberCountEl.textContent = members.length;
      } catch (err) {
        membersStatus.textContent = "Error: " + err.message;
      }
    };

    loadMemberDetailsBtn.onclick = async () => {
      if (!selectedMemberId) return;

      detailsStatus.textContent = "Loading member details...";
      detailsOutput.textContent = "";

      try {
        const res = await fetch('/api/members/' + encodeURIComponent(selectedMemberId));
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Failed to load member details");
        }

        detailsOutput.textContent = JSON.stringify(data, null, 2);
        detailsStatus.textContent = "Member details loaded";
      } catch (err) {
        detailsStatus.textContent = "Error: " + err.message;
      }
    };

    loadMemberTableBtn.onclick = async () => {
      if (!selectedCommunityId) return;

      memberTableStatus.textContent = "Loading full member table...";
      memberTableWrap.innerHTML = "";

      try {
        const res = await fetch(
          "/api/communities/" + encodeURIComponent(selectedCommunityId) + "/member-details-table"
        );
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Failed to load member table");
        }

        renderMemberTable(Array.isArray(data.rows) ? data.rows : []);
        memberTableStatus.textContent =
          "Loaded " + (data.detailedMembers || 0) + " member detail records.";
      } catch (err) {
        memberTableStatus.textContent = "Error: " + err.message;
      }
    };

    refreshAuthStatus();
  </script>
</body>
</html>
  `);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});