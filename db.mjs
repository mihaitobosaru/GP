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
  const meta = db
    .prepare(
      "SELECT last_sync_started_at, last_sync_completed_at, last_sync_status, last_sync_error FROM sync_meta WHERE id = 1"
    )
    .get();
  return {
    communities,
    users,
    memberships: links,
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

export function listUsers(db, { limit = 50, offset = 0, q = "" }) {
  const search = `%${(q || "").trim()}%`;
  const hasQ = Boolean((q || "").trim());
  const base = hasQ
    ? `FROM users WHERE
        first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR company_name LIKE ?
        OR contact_key LIKE ?`
    : "FROM users WHERE 1=1";
  const countSql = `SELECT COUNT(*) AS n ${base}`;
  const count = hasQ
    ? db.prepare(countSql).get(search, search, search, search, search).n
    : db.prepare(countSql).get().n;
  const rows = hasQ
    ? db
        .prepare(
          `SELECT * ${base} ORDER BY last_name, first_name LIMIT ? OFFSET ?`
        )
        .all(search, search, search, search, search, limit, offset)
    : db
        .prepare(`SELECT * FROM users ORDER BY last_name, first_name LIMIT ? OFFSET ?`)
        .all(limit, offset);
  return { rows, total: count };
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
