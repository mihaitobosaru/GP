/**
 * HubSpot CRM contacts batch upsert (email as unique key).
 * Optional env: HUBSPOT_CONTACT_MAP — JSON object mapping SQLite column → HubSpot property internal name.
 */

const BATCH_SIZE = 100;
const UPSERT_URL = "https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert";
const BATCH_READ_URL = "https://api.hubapi.com/crm/v3/objects/contacts/batch/read";
const CONTACT_PROPERTIES_URL = "https://api.hubapi.com/crm/v3/properties/contacts";

function defaultContactFieldMap() {
  return {
    email: "email",
    first_name: "firstname",
    last_name: "lastname",
    company_name: "company",
    company_title: "jobtitle",
    city: "city",
    state_province_code: "state",
    postal_code: "zip",
    country_code: "country",
    create_date: "hl_create_date",
    is_member: "hl_member",
    region: "hl_region",
    membership_level: "hl_membership_level",
    membership_status: "hl_membership_status",
    sesip_committee_member: "hl_sesip_committee_member",
    se_committee_member: "hl_se_committee_member",
    tes_committee_member: "hl_tes_committee_member",
    automotive_task_force: "hl_automotive_task_force",
    china_task_force: "hl_china_task_force",
    japan_task_force: "hl_japan_task_force",
    security_task_force: "hl_security_task_force",
    digital_wallets_task_force: "hl_digital_wallets_task_force",
    trusted_open_source_silicon_tf: "hl_trusted_open_source_silicon_tf"
  };
}

export function getHubspotContactFieldMap() {
  const map = { ...defaultContactFieldMap() };
  const raw = (process.env.HUBSPOT_CONTACT_MAP || "").trim();
  if (!raw) return map;
  try {
    const extra = JSON.parse(raw);
    if (extra && typeof extra === "object") {
      Object.assign(map, extra);
    }
  } catch {
    console.warn("[hubspot] HUBSPOT_CONTACT_MAP is not valid JSON; using defaults only.");
  }
  return map;
}

function rowToHubspotInput(row, fieldMap) {
  const emailRaw = row.email;
  const email =
    emailRaw == null ? "" : String(emailRaw).trim().toLowerCase();
  if (!email) return null;

  const properties = {};
  for (const [dbCol, hsProp] of Object.entries(fieldMap)) {
    if (!hsProp || typeof hsProp !== "string") continue;
    const v = row[dbCol];
    if (dbCol === "email") {
      properties[hsProp] = email;
      continue;
    }
    if (v == null || v === "") continue;
    if (dbCol === "is_member" || typeof v === "boolean") {
      properties[hsProp] = v === 1 || v === true ? "true" : "false";
      continue;
    }
    properties[hsProp] = String(v).trim();
  }
  if (!properties.email) properties.email = email;

  return {
    id: email,
    idProperty: "email",
    properties
  };
}

/**
 * @param {string} accessToken - Private app token (or OAuth access token)
 * @param {object[]} userRows - SQLite user rows
 * @param {Record<string,string>} [fieldMap]
 * @returns {Promise<{ attempted: number, results: number, errors: { status?: number, body: string }[] }>}
 */
export async function upsertContactsToHubspot(accessToken, userRows, fieldMap) {
  const map = fieldMap || getHubspotContactFieldMap();
  const inputs = [];
  for (const row of userRows) {
    const input = rowToHubspotInput(row, map);
    if (input) inputs.push(input);
  }

  const errors = [];
  let results = 0;

  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const chunk = inputs.slice(i, i + BATCH_SIZE);
    const res = await fetch(UPSERT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ inputs: chunk })
    });
    const text = await res.text();
    if (!res.ok) {
      errors.push({ status: res.status, body: text.slice(0, 2000) });
      continue;
    }
    try {
      const data = JSON.parse(text);
      const n = Array.isArray(data.results) ? data.results.length : chunk.length;
      results += n;
    } catch {
      results += chunk.length;
    }
  }

  return { attempted: inputs.length, results, errors };
}

/**
 * Check if contacts already exist in HubSpot by email.
 *
 * @param {string} accessToken - Private app token (or OAuth access token)
 * @param {object[]} userRows - SQLite user rows (must include email)
 * @param {string[]} [properties] - HubSpot contact properties to return
 * @returns {Promise<{ checked: number, found: number, missing: number, existingEmails: Set<string>, foundContacts: object[], errors: { status?: number, body: string }[] }>}
 */
export async function checkContactsExistInHubspot(accessToken, userRows, properties = []) {
  const uniqueEmails = Array.from(
    new Set(
      userRows
        .map((row) => String(row?.email || "").trim().toLowerCase())
        .filter(Boolean)
    )
  );

  const existingEmails = new Set();
  const foundContacts = [];
  const errors = [];
  const propList = Array.from(new Set(["email", ...properties])).filter(Boolean);

  for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
    const chunk = uniqueEmails.slice(i, i + BATCH_SIZE);
    const res = await fetch(BATCH_READ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        idProperty: "email",
        properties: propList,
        inputs: chunk.map((email) => ({ id: email }))
      })
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      errors.push({
        status: res.status,
        body: String(text || JSON.stringify(data)).slice(0, 2000)
      });
      continue;
    }

    const results = Array.isArray(data?.results) ? data.results : [];
    for (const item of results) {
      const email = String(item?.properties?.email || "").trim().toLowerCase();
      if (email) existingEmails.add(email);
      foundContacts.push(item);
    }
  }

  return {
    checked: uniqueEmails.length,
    found: existingEmails.size,
    missing: Math.max(0, uniqueEmails.length - existingEmails.size),
    existingEmails,
    foundContacts,
    errors
  };
}

/**
 * Read HubSpot contact property definitions (internal name + label).
 *
 * @param {string} accessToken - Private app token (or OAuth access token)
 * @returns {Promise<Array<{ name: string, label: string }>>}
 */
export async function listHubspotContactProperties(accessToken) {
  const out = [];
  let after = "";
  do {
    const url = new URL(CONTACT_PROPERTIES_URL);
    url.searchParams.set("limit", "500");
    if (after) url.searchParams.set("after", after);
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
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
        `HubSpot properties API error ${res.status}: ${String(text || JSON.stringify(data)).slice(0, 1200)}`
      );
    }
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const p of results) {
      const name = String(p?.name || "").trim();
      if (!name) continue;
      out.push({
        name,
        label: String(p?.label || "").trim()
      });
    }
    after = String(data?.paging?.next?.after || "").trim();
  } while (after);
  return out;
}
