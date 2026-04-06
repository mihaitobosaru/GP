import { initSortableTable } from "./table-sort.js";

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
const memberUpdatesTableStatus = document.getElementById("memberUpdatesTableStatus");
const memberUpdatesTableWrap = document.getElementById("memberUpdatesTableWrap");

let dbUsersOffset = 0;
const dbUsersLimit = 100;
/** Column keys that map to server-side ORDER BY (see db.mjs USER_SORT_EXPR). */
const DB_USER_SORTABLE = new Set([
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
]);
let dbUsersSortBy = "updated_on";
let dbUsersSortDir = "desc";
let syncPollTimer = null;

const memberUpdatesDefaultColumns = [
  "first_name",
  "last_name",
  "company_name",
  "email",
  "company_title",
  "city",
  "state_province_code",
  "postal_code",
  "country_code",
  "create_date",
  "is_member",
  "region",
  "membership_level",
  "membership_status",
  "sesip_committee_member",
  "se_committee_member",
  "tes_committee_member",
  "automotive_task_force",
  "china_task_force",
  "japan_task_force",
  "security_task_force",
  "digital_wallets_task_force",
  "trusted_open_source_silicon_tf"
];

function renderMemberUpdatesHubspotTable(preview) {
  if (!memberUpdatesTableWrap || !memberUpdatesTableStatus) return;
  memberUpdatesTableWrap.innerHTML = "";
  const rows = Array.isArray(preview?.rows) ? preview.rows : [];
  const labels = preview?.columns || {};
  if (!rows.length) {
    memberUpdatesTableStatus.textContent = "No matched users to sync to HubSpot.";
    return;
  }
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  const cols = memberUpdatesDefaultColumns.filter((c) =>
    rows.some((r) => Object.prototype.hasOwnProperty.call(r, c))
  );
  cols.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = labels[c] || c;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    cols.forEach((c) => {
      const td = document.createElement("td");
      const v = r[c];
      if (typeof v === "boolean" || c === "is_member") {
        td.textContent = v === true || v === 1 ? "Yes" : "No";
      } else {
        td.textContent = v == null ? "" : String(v);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  memberUpdatesTableWrap.appendChild(table);
  memberUpdatesTableStatus.textContent = `HubSpot sync preview rows: ${rows.length}`;
  initSortableTable(table);
}

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
  const fileEl = document.getElementById("dbFileInfo");
  try {
    const res = await fetch("/api/db/info");
    const s = await res.json();
    if (!res.ok) throw new Error(s.error || "stats failed");
    if (fileEl) {
      const size =
        s.fileExists && s.sizeBytes != null
          ? `${(s.sizeBytes / 1024).toFixed(1)} KB`
          : "file not present";
      fileEl.textContent = `SQLite: ${s.databasePath} · ${size}`;
    }
    document.getElementById("dbStatCommunities").textContent = s.communities;
    document.getElementById("dbStatUsers").textContent = s.users;
    document.getElementById("dbStatLinks").textContent = s.memberships;
    const elP = document.getElementById("dbStatPending");
    if (elP) elP.textContent = s.contactsMissingDetails != null ? s.contactsMissingDetails : "—";
    document.getElementById("dbStatLastSync").textContent =
      s.lastSyncCompletedAt || "—";
  } catch (e) {
    if (fileEl) fileEl.textContent = "Could not load DB info: " + e.message;
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
  initSortableTable(table);
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
    if (DB_USER_SORTABLE.has(c)) {
      th.classList.add("sortable");
      th.setAttribute("role", "button");
      th.tabIndex = 0;
      th.title = "Sort entire database by this column";
      if (c === dbUsersSortBy) {
        th.classList.add(dbUsersSortDir === "asc" ? "sort-asc" : "sort-desc");
      }
      const runSort = () => {
        if (dbUsersSortBy === c) {
          dbUsersSortDir = dbUsersSortDir === "asc" ? "desc" : "asc";
        } else {
          dbUsersSortBy = c;
          dbUsersSortDir = "asc";
        }
        dbUsersOffset = 0;
        loadDbUsersPage();
      };
      th.addEventListener("click", runSort);
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          runSort();
        }
      });
    }
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
    const params = new URLSearchParams({
      limit: String(dbUsersLimit),
      offset: String(dbUsersOffset),
      q,
      sort: dbUsersSortBy,
      dir: dbUsersSortDir
    });
    const res = await fetch("/api/db/users?" + params.toString());
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "failed");
    if (data.sortBy) dbUsersSortBy = data.sortBy;
    if (data.sortDir) dbUsersSortDir = data.sortDir;
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

const dbMemberUpdatesBtn = document.getElementById("dbMemberUpdatesBtn");
const memberUpdatesProgress = document.getElementById("memberUpdatesProgress");

if (dbMemberUpdatesBtn && memberUpdatesProgress) {
  dbMemberUpdatesBtn.onclick = async () => {
    const daysRaw = document.getElementById("memberUpdatesDays")?.value || "60";
    const days = Math.min(3660, Math.max(1, parseInt(daysRaw, 10) || 60));
    memberUpdatesProgress.textContent = "Loading…";
    if (memberUpdatesTableStatus) memberUpdatesTableStatus.textContent = "";
    if (memberUpdatesTableWrap) memberUpdatesTableWrap.innerHTML = "";
    try {
      const res = await fetch("/api/db/member-updates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "failed");
      const a = data.applied;
      let msg =
        `API: ${data.api.joinCount} joins, ${data.api.removalCount} removals. ` +
        `DB: touched ${a.usersTouchedJoins} join rows / ${a.usersTouchedRemovals} removal rows; ` +
        `links +${a.linksAdded} −${a.linksRemoved}; ` +
        `skipped (not in DB) ${a.skippedNotInDb}, (no email) ${a.skippedNoEmail}`;
      const h = data.hubspot;
      if (h) {
        if (h.skipped) {
          msg += ` HubSpot: skipped — ${h.reason}`;
        } else if (h.error) {
          msg += ` HubSpot error: ${h.error}`;
        } else {
          msg += ` HubSpot: batch upsert reported ${h.resultsReported}/${h.attempted} contacts.`;
          if (h.batchErrors && h.batchErrors.length) {
            msg += ` (${h.batchErrors.length} batch request(s) failed — check server logs.)`;
          }
        }
      }
      memberUpdatesProgress.textContent = msg;
      renderMemberUpdatesHubspotTable(data.hubspotPreview);
      loadDbStats();
      loadDbCommunities();
      loadDbUsersPage();
    } catch (e) {
      memberUpdatesProgress.textContent = "Error: " + e.message;
      if (memberUpdatesTableStatus) {
        memberUpdatesTableStatus.textContent = "Could not load sync preview.";
      }
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
  initSortableTable(table);
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
