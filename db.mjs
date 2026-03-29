import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPath = path.join(__dirname, "data", "hl-sync.db");

let dbInstance = null;

export function getDatabasePath() {
  return process.env.DATABASE_PATH || defaultPath;
}

export function openDatabase() {
  if (dbInstance) return dbInstance;
  const dbPath = getDatabasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  dbInstance = new Database(dbPath);
  dbInstance.pragma("journal_mode = WAL");
  initSchema(dbInstance);
  return dbInstance;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS communities (
      community_key TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      contact_key TEXT PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      company_name TEXT,
      email TEXT,
      company_title TEXT,
      city TEXT,
      state_province_code TEXT,
      postal_code TEXT,
      country_code TEXT,
      create_date TEXT,
      is_member INTEGER,
      region TEXT,
      updated_on TEXT,
      membership_level TEXT,
      membership_status TEXT,
      db_updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_communities (
      contact_key TEXT NOT NULL,
      community_key TEXT NOT NULL,
      linked_at TEXT,
      PRIMARY KEY (contact_key, community_key)
    );

    CREATE INDEX IF NOT EXISTS idx_uc_community ON user_communities(community_key);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS sync_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_sync_started_at TEXT,
      last_sync_completed_at TEXT,
      last_sync_status TEXT,
      last_sync_error TEXT
    );
  `);
}

export function upsertCommunity(db, communityKey, name) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO communities (community_key, name, synced_at)
     VALUES (?, ?, ?)
     ON CONFLICT(community_key) DO UPDATE SET
       name = excluded.name,
       synced_at = excluded.synced_at`
  ).run(communityKey, name || "", now);
}

export function replaceAllMemberships(db, pairs) {
  const now = new Date().toISOString();
  const del = db.prepare("DELETE FROM user_communities");
  const ins = db.prepare(
    `INSERT INTO user_communities (contact_key, community_key, linked_at)
     VALUES (?, ?, ?)`
  );
  const run = db.transaction(() => {
    del.run();
    for (const [contactKey, communityKey] of pairs) {
      if (contactKey && communityKey) {
        ins.run(contactKey, communityKey, now);
      }
    }
  });
  run();
}

export function upsertUserFromRow(db, contactKey, row) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (
      contact_key, first_name, last_name, company_name, email, company_title,
      city, state_province_code, postal_code, country_code, create_date,
      is_member, region, updated_on, membership_level, membership_status, db_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contact_key) DO UPDATE SET
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      company_name = excluded.company_name,
      email = excluded.email,
      company_title = excluded.company_title,
      city = excluded.city,
      state_province_code = excluded.state_province_code,
      postal_code = excluded.postal_code,
      country_code = excluded.country_code,
      create_date = excluded.create_date,
      is_member = excluded.is_member,
      region = excluded.region,
      updated_on = excluded.updated_on,
      membership_level = excluded.membership_level,
      membership_status = excluded.membership_status,
      db_updated_at = excluded.db_updated_at`
  ).run(
    contactKey,
    row.FirstName || "",
    row.LastName || "",
    row.CompanyName || "",
    row.Email || "",
    row.CompanyTitle || "",
    row.City || "",
    row.StateProvinceCode || "",
    row.PostalCode || "",
    row.CountryCode || "",
    row.CreateDate || "",
    row.Member === "Yes" ? 1 : 0,
    row.Region || "",
    row.UpdatedOn || "",
    row.MembershipLevel || "",
    row.MembershipStatus || "",
    now
  );
}

export function getExistingContactKeys(db) {
  const rows = db.prepare("SELECT contact_key FROM users").all();
  return new Set(rows.map((r) => r.contact_key));
}

export function getStats(db) {
  const communities = db
    .prepare("SELECT COUNT(*) AS n FROM communities")
    .get().n;
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const links = db
    .prepare("SELECT COUNT(*) AS n FROM user_communities")
    .get().n;
  const contactsMissingDetails = db
    .prepare(
      `SELECT COUNT(DISTINCT uc.contact_key) AS n
       FROM user_communities uc
       LEFT JOIN users u ON u.contact_key = uc.contact_key
       WHERE u.contact_key IS NULL`
    )
    .get().n;
  const meta = db
    .prepare(
      "SELECT last_sync_started_at, last_sync_completed_at, last_sync_status, last_sync_error FROM sync_meta WHERE id = 1"
    )
    .get();
  return {
    communities,
    users,
    memberships: links,
    contactsMissingDetails,
    lastSyncStartedAt: meta?.last_sync_started_at || null,
    lastSyncCompletedAt: meta?.last_sync_completed_at || null,
    lastSyncStatus: meta?.last_sync_status || null,
    lastSyncError: meta?.last_sync_error || null
  };
}

export function setSyncMeta(db, fields) {
  const row = db
    .prepare("SELECT id FROM sync_meta WHERE id = 1")
    .get();
  if (!row) {
    db.prepare(
      `INSERT INTO sync_meta (id, last_sync_started_at, last_sync_completed_at, last_sync_status, last_sync_error)
       VALUES (1, ?, ?, ?, ?)`
    ).run(
      fields.last_sync_started_at ?? null,
      fields.last_sync_completed_at ?? null,
      fields.last_sync_status ?? null,
      fields.last_sync_error ?? null
    );
  } else {
    const updates = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        updates.push(`${k} = ?`);
        vals.push(v);
      }
    }
    if (updates.length) {
      db.prepare(`UPDATE sync_meta SET ${updates.join(", ")} WHERE id = 1`).run(
        ...vals
      );
    }
  }
}

const usersCommunitiesSubquery = `
  (SELECT GROUP_CONCAT(c.name, ' | ')
   FROM user_communities uc
   INNER JOIN communities c ON c.community_key = uc.community_key
   WHERE uc.contact_key = u.contact_key) AS communities_list`;

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function splitDisplayName(name) {
  const s = String(name || "").trim();
  if (!s) return { firstName: "", lastName: "" };
  const i = s.indexOf(" ");
  if (i <= 0) return { firstName: "", lastName: s };
  return { firstName: s.slice(0, i), lastName: s.slice(i + 1).trim() };
}

export function getContactKeyByEmail(db, email) {
  const n = normalizeEmail(email);
  if (!n) return null;
  const row = db
    .prepare("SELECT contact_key FROM users WHERE lower(trim(email)) = ?")
    .get(n);
  return row?.contact_key ?? null;
}

/** Prefer existing community row; otherwise create stub with Integration ID as key when present. */
export function resolveCommunityKeyForUpdate(
  db,
  communityIntegrationId,
  communityName
) {
  const id = String(communityIntegrationId || "").trim();
  const name = String(communityName || "").trim();
  if (id) {
    const byKey = db
      .prepare("SELECT community_key FROM communities WHERE community_key = ?")
      .get(id);
    if (byKey) return byKey.community_key;
  }
  if (name) {
    const byName = db
      .prepare(
        "SELECT community_key FROM communities WHERE lower(trim(name)) = lower(?)"
      )
      .get(name);
    if (byName) return byName.community_key;
  }
  if (id) {
    upsertCommunity(db, id, name || id);
    return id;
  }
  return null;
}

/**
 * Apply GetCommunityMemberUpdates payloads: only rows whose EmailAddress matches
 * an existing users.email get updated; community links are adjusted when a community key can be resolved.
 */
export function applyCommunityMemberUpdates(db, { communityJoins, communityRemovals }) {
  const joins = Array.isArray(communityJoins) ? communityJoins : [];
  const removals = Array.isArray(communityRemovals) ? communityRemovals : [];
  const touchedContactKeys = new Set();
  const stats = {
    usersTouchedJoins: 0,
    usersTouchedRemovals: 0,
    linksAdded: 0,
    linksRemoved: 0,
    skippedNoEmail: 0,
    skippedNotInDb: 0
  };
  const now = new Date().toISOString();
  const upd = db.prepare(
    `UPDATE users SET
      first_name = ?,
      last_name = ?,
      company_name = ?,
      updated_on = ?,
      db_updated_at = ?
     WHERE contact_key = ?`
  );
  const insLink = db.prepare(
    `INSERT OR IGNORE INTO user_communities (contact_key, community_key, linked_at)
     VALUES (?, ?, ?)`
  );
  const delLink = db.prepare(
    `DELETE FROM user_communities WHERE contact_key = ? AND community_key = ?`
  );

  for (const j of joins) {
    const email = normalizeEmail(j.EmailAddress);
    if (!email) {
      stats.skippedNoEmail++;
      continue;
    }
    const ck = getContactKeyByEmail(db, email);
    if (!ck) {
      stats.skippedNotInDb++;
      continue;
    }
    const { firstName, lastName } = splitDisplayName(j.Name);
    upd.run(
      firstName,
      lastName,
      String(j.CompanyName || "").trim(),
      j.JoinDate || now,
      now,
      ck
    );
    stats.usersTouchedJoins++;
    touchedContactKeys.add(ck);
    const commKey = resolveCommunityKeyForUpdate(
      db,
      j.CommunityIntegrationID,
      j.CommunityName
    );
    if (commKey) {
      const info = insLink.run(ck, commKey, j.JoinDate || now);
      if (info.changes > 0) stats.linksAdded++;
    }
  }

  for (const r of removals) {
    const email = normalizeEmail(r.EmailAddress);
    if (!email) {
      stats.skippedNoEmail++;
      continue;
    }
    const ck = getContactKeyByEmail(db, email);
    if (!ck) {
      stats.skippedNotInDb++;
      continue;
    }
    const { firstName, lastName } = splitDisplayName(r.Name);
    upd.run(
      firstName,
      lastName,
      String(r.CompanyName || "").trim(),
      r.RemoveDate || now,
      now,
      ck
    );
    stats.usersTouchedRemovals++;
    touchedContactKeys.add(ck);
    const commKey = resolveCommunityKeyForUpdate(
      db,
      r.CommunityIntegrationID,
      r.CommunityName
    );
    if (commKey) {
      const info = delLink.run(ck, commKey);
      if (info.changes > 0) stats.linksRemoved++;
    }
  }

  return {
    stats,
    touchedContactKeys: [...touchedContactKeys]
  };
}

export function getUsersByContactKeys(db, contactKeys) {
  const keys = [...new Set(contactKeys)].filter(Boolean);
  if (!keys.length) return [];
  const placeholders = keys.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM users WHERE contact_key IN (${placeholders})`)
    .all(...keys);
}

/** Whitelist keys for ORDER BY (SQL fragments; no user-controlled identifiers). */
const USER_SORT_EXPR = {
  contact_key: "u.contact_key",
  first_name: "u.first_name COLLATE NOCASE",
  last_name: "u.last_name COLLATE NOCASE",
  company_name: "u.company_name COLLATE NOCASE",
  email: "u.email COLLATE NOCASE",
  company_title: "u.company_title COLLATE NOCASE",
  city: "u.city COLLATE NOCASE",
  state_province_code: "u.state_province_code COLLATE NOCASE",
  postal_code: "u.postal_code COLLATE NOCASE",
  country_code: "u.country_code COLLATE NOCASE",
  region: "u.region COLLATE NOCASE",
  create_date: "u.create_date",
  updated_on: "u.updated_on",
  is_member: "u.is_member",
  membership_level: "u.membership_level COLLATE NOCASE",
  membership_status: "u.membership_status COLLATE NOCASE",
  db_updated_at: "u.db_updated_at",
  communities_list: `(SELECT GROUP_CONCAT(c.name, ' | ') FROM user_communities uc INNER JOIN communities c ON c.community_key = uc.community_key WHERE uc.contact_key = u.contact_key)`
};

const USER_SORT_TIE = "u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE";

function buildUserOrderBy(sortBy, sortDir) {
  const tie = USER_SORT_TIE;
  const d = sortDir === "asc" ? "asc" : "desc";
  if (sortBy === "updated_on" || sortBy === "db_updated_at" || sortBy === "create_date") {
    const col =
      sortBy === "updated_on"
        ? "u.updated_on"
        : sortBy === "db_updated_at"
          ? "u.db_updated_at"
          : "u.create_date";
    if (sortDir === "desc") {
      return `(${col} IS NULL), ${col} DESC, ${tie}`;
    }
    return `(${col} IS NOT NULL), ${col} ASC, ${tie}`;
  }
  const expr = USER_SORT_EXPR[sortBy];
  const dirSql = d === "asc" ? "ASC" : "DESC";
  return `${expr} ${dirSql}, ${tie}`;
}

export function listUsers(
  db,
  {
    limit = 50,
    offset = 0,
    q = "",
    sortBy = "updated_on",
    sortDir = "desc"
  } = {}
) {
  const search = `%${(q || "").trim()}%`;
  const hasQ = Boolean((q || "").trim());
  const base = hasQ
    ? `FROM users u WHERE
        u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.company_name LIKE ?
        OR u.contact_key LIKE ?`
    : "FROM users u WHERE 1=1";
  const countSql = `SELECT COUNT(*) AS n ${base}`;
  const count = hasQ
    ? db.prepare(countSql).get(search, search, search, search, search).n
    : db.prepare(countSql).get().n;
  let sb = String(sortBy || "").trim();
  let sd = String(sortDir || "").toLowerCase() === "asc" ? "asc" : "desc";
  if (!USER_SORT_EXPR[sb]) {
    sb = "updated_on";
    sd = "desc";
  }
  const orderBy = buildUserOrderBy(sb, sd);
  const selectSql = `SELECT u.*, ${usersCommunitiesSubquery} ${base} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = hasQ
    ? db.prepare(selectSql).all(search, search, search, search, search, limit, offset)
    : db.prepare(selectSql).all(limit, offset);
  return { rows, total: count, sortBy: sb, sortDir: sd };
}

export function listCommunitiesWithCounts(db) {
  return db
    .prepare(
      `SELECT c.community_key, c.name, c.synced_at,
        (SELECT COUNT(*) FROM user_communities uc WHERE uc.community_key = c.community_key) AS member_count
       FROM communities c
       ORDER BY c.name`
    )
    .all();
}

export function listMembershipsForCommunity(db, communityKey) {
  return db
    .prepare(
      `SELECT uc.contact_key, u.first_name, u.last_name, u.email, uc.linked_at
       FROM user_communities uc
       LEFT JOIN users u ON u.contact_key = uc.contact_key
       WHERE uc.community_key = ?
       ORDER BY u.last_name, u.first_name`
    )
    .all(communityKey);
}
