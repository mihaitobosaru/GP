import express from "express";

const app = express();
const port = process.env.PORT || 3000;

const BASE_URL = process.env.HIGHERLOGIC_BASE_URL || "https://gpsb02.connectedcommunity.org";
const BEARER_TOKEN = (process.env.HIGHERLOGIC_BEARER_TOKEN || "").trim();
const HLIAM_KEY = (
  process.env.HIGHERLOGIC_IAM_KEY ||
  process.env.HLIAM_KEY ||
  ""
).trim();

if (!BEARER_TOKEN || !HLIAM_KEY) {
  console.error(
    "Missing required env vars. Set HIGHERLOGIC_BEARER_TOKEN and HIGHERLOGIC_IAM_KEY (or HLIAM_KEY)."
  );
  process.exit(1);
}

app.use(express.json());

function getHeaders() {
  return {
    Authorization: `Bearer CfDJ8EsVP4rQ1A9IiTVIkDJ7RYZf4JAoIYKNFWAprbCy1kbtY6myo8sCQlj5PBa2l3cpA_sbxvAuZxf30xBi48YXPcph9RWrl1DRTFjTQTFoGKfv2Gqy4md0hrYKKQn2a4LvpVRhe-xlshKLCBjygpXMNq1YT3d0T4WhIZilxGiQEREvYJ-7-svLLGcK1MM6TxYKjJ6J3h75ll0YooU--I9ahb41e7I9fDxGcg4GogpoikVs`,
    HLIAMKey: 'b9ec0893-8164-0098-c307-0c0e94614b28',
    "Content-Type": "application/json"
  };
}

async function hlFetch(path) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: getHeaders()
  });

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

/**
 * Adjust these endpoints if your exact member/member-detail routes differ.
 */
app.get("/api/communities", async (req, res) => {
  try {
    const data = await hlFetch(
      "/higherlogic/external/api/v1.0/Communities/GetViewableCommunities?includeStatistics=false"
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/communities/:communityId/members", async (req, res) => {
  try {
    const { communityId } = req.params;

    const data = await hlFetch(
      `/higherlogic/external/api/v1.0/Communities/${communityId}/Members`
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
      `/higherlogic/external/api/v1.0/Contacts/${memberId}`
    );

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Higher Logic Explorer</h1>
    <div class="sub">Load communities → pick one → load members → pick one → inspect full member details</div>

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
  </div>

  <script>
    const loadCommunitiesBtn = document.getElementById("loadCommunitiesBtn");
    const loadMembersBtn = document.getElementById("loadMembersBtn");
    const loadMemberDetailsBtn = document.getElementById("loadMemberDetailsBtn");

    const communitiesStatus = document.getElementById("communitiesStatus");
    const membersStatus = document.getElementById("membersStatus");
    const detailsStatus = document.getElementById("detailsStatus");

    const communitiesList = document.getElementById("communitiesList");
    const membersList = document.getElementById("membersList");
    const detailsOutput = document.getElementById("detailsOutput");

    const selectedCommunityIdEl = document.getElementById("selectedCommunityId");
    const selectedMemberIdEl = document.getElementById("selectedMemberId");
    const communityCountEl = document.getElementById("communityCount");
    const memberCountEl = document.getElementById("memberCount");

    let selectedCommunityId = null;
    let selectedMemberId = null;
    let communities = [];
    let members = [];

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
          loadMemberDetailsBtn.disabled = true;
          membersList.innerHTML = "";
          memberCountEl.style.display = "none";
          detailsOutput.textContent = "No member selected yet.";
          detailsStatus.textContent = "";
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
  </script>
</body>
</html>
  `);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});