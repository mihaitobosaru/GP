/**
 * HubSpot OAuth: classic (app.hubspot.com) or MCP OAuth 2.1 (mcp.hubspot.com + PKCE).
 * MCP metadata: https://mcp.hubspot.com/.well-known/oauth-authorization-server
 * @see https://developers.hubspot.com/docs/api/working-with-oauth
 * @see https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-hubspot-mcp-server
 */

export const HUBSPOT_CLASSIC_AUTHORIZE_URL =
  "https://app.hubspot.com/oauth/authorize";
export const HUBSPOT_CLASSIC_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";

/** MCP OAuth 2.1 — PKCE required; authorize URL does not use scope (per AS metadata). */
export const HUBSPOT_MCP_AUTHORIZE_URL =
  "https://mcp.hubspot.com/oauth/authorize/user";
export const HUBSPOT_MCP_TOKEN_URL = "https://mcp.hubspot.com/oauth/v3/token";

/** Space-separated HubSpot scope strings; commas in env become spaces. */
export function normalizeHubspotScopes(scope) {
  if (scope == null || String(scope).trim() === "") return "";
  return String(scope)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * @param {"classic"|"mcp"} flow
 * @param {object} opts - For `mcp`, pass `codeChallenge` (S256); for `classic`, pass `scope`.
 */
export function buildHubspotAuthorizeUrl({
  clientId,
  redirectUri,
  state,
  flow = "classic",
  scope,
  codeChallenge
}) {
  if (flow === "mcp") {
    if (!codeChallenge) {
      throw new Error("MCP OAuth requires PKCE (code_challenge).");
    }
    const u = new URL(HUBSPOT_MCP_AUTHORIZE_URL);
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  }

  const u = new URL(HUBSPOT_CLASSIC_AUTHORIZE_URL);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  const normalized = normalizeHubspotScopes(scope);
  if (!normalized) {
    throw new Error("HubSpot OAuth scope is empty; set HUBSPOT_OAUTH_SCOPE.");
  }
  u.searchParams.set("scope", normalized);
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeHubspotAuthorizationCode({
  clientId,
  clientSecret,
  redirectUri,
  code,
  flow = "classic",
  codeVerifier
}) {
  const tokenUrl =
    flow === "mcp" ? HUBSPOT_MCP_TOKEN_URL : HUBSPOT_CLASSIC_TOKEN_URL;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code: String(code)
  });
  if (flow === "mcp") {
    if (!codeVerifier) {
      throw new Error("MCP OAuth requires code_verifier (PKCE).");
    }
    body.set("code_verifier", codeVerifier);
  }
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `HubSpot token exchange failed (${res.status}): ${text.slice(0, 800)}`
    );
  }
  return data;
}

export async function refreshHubspotAccessToken({
  clientId,
  clientSecret,
  refreshToken,
  flow = "classic"
}) {
  const tokenUrl =
    flow === "mcp" ? HUBSPOT_MCP_TOKEN_URL : HUBSPOT_CLASSIC_TOKEN_URL;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `HubSpot refresh failed (${res.status}): ${text.slice(0, 800)}`
    );
  }
  return data;
}
