/**
 * HubSpot standard OAuth 2.0 (developer app), not Higher Logic.
 * @see https://developers.hubspot.com/docs/api/working-with-oauth
 */

export const HUBSPOT_OAUTH_AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
export const HUBSPOT_OAUTH_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";

/** Space-separated HubSpot scope strings; commas in env become spaces. */
export function normalizeHubspotScopes(scope) {
  if (scope == null || String(scope).trim() === "") return "";
  return String(scope)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}

export function buildHubspotAuthorizeUrl({
  clientId,
  redirectUri,
  scope,
  state
}) {
  const u = new URL(HUBSPOT_OAUTH_AUTHORIZE_URL);
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
  code
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code: String(code)
  });
  const res = await fetch(HUBSPOT_OAUTH_TOKEN_URL, {
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
  refreshToken
}) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });
  const res = await fetch(HUBSPOT_OAUTH_TOKEN_URL, {
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
