/**
 * Self-contained local control dashboard served at http://127.0.0.1:4190/
 * Zero CDN dependencies, works 100% offline, strictly escapes all dynamic content.
 */

export function renderDashboardHtml(opts?: {
  tokenRequired?: boolean;
  nonce?: string;
}): string {
  const tokenRequired = Boolean(opts?.tokenRequired);
  const scriptNonceAttr = opts?.nonce ? ` nonce="${opts.nonce.replace(/[^A-Za-z0-9+/=_-]/g, "")}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hem Vault — Local Brain Daemon</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --surface-2: #1f2630;
      --border: #2d3542;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --accent-soft: rgba(88, 166, 255, 0.14);
      --ok: #3fb950;
      --ok-soft: rgba(63, 185, 80, 0.14);
      --warn: #d29922;
      --warn-soft: rgba(210, 153, 34, 0.15);
      --danger: #f85149;
      --danger-soft: rgba(248, 81, 73, 0.15);
      --radius: 10px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f8fa;
        --surface: #ffffff;
        --surface-2: #f0f3f6;
        --border: #d0d7de;
        --text: #1f2328;
        --muted: #59636e;
        --accent: #0969da;
        --accent-soft: rgba(9, 105, 218, 0.1);
        --ok: #1a7f37;
        --ok-soft: rgba(26, 127, 55, 0.1);
        --warn: #9a6700;
        --warn-soft: rgba(154, 103, 0, 0.12);
        --danger: #cf222e;
        --danger-soft: rgba(207, 34, 46, 0.1);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      background: var(--bg);
      color: var(--text);
      line-height: 1.45;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 20;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 12px 20px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      font-size: 16px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--ok);
      box-shadow: 0 0 0 3px var(--ok-soft);
    }
    .meta-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      color: var(--muted);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface-2);
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text);
    }
    .pill.ok { color: var(--ok); background: var(--ok-soft); border-color: transparent; }
    .pill.warn { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
    .pill.danger { color: var(--danger); background: var(--danger-soft); border-color: transparent; }
    .pill.accent { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 18px 20px 48px;
    }
    nav.tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 18px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 10px;
    }
    button, select, input, textarea {
      font: inherit;
      color: inherit;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 6px 10px;
    }
    button {
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: border-color 0.12s, background 0.12s;
    }
    button:hover { border-color: var(--accent); }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
    button.danger {
      color: var(--danger);
      border-color: var(--danger-soft);
      background: var(--danger-soft);
    }
    button.tab {
      background: transparent;
      border-color: transparent;
      color: var(--muted);
      padding: 7px 12px;
    }
    button.tab.active {
      background: var(--accent-soft);
      color: var(--accent);
      border-color: transparent;
    }
    .panel { display: none; }
    .panel.active { display: block; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .card h3 {
      margin: 0 0 10px;
      font-size: 14px;
      font-weight: 600;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 14px;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .between { justify-content: space-between; }
    .muted { color: var(--muted); font-size: 12px; }
    .mono { font-family: var(--mono); font-size: 12px; }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: var(--muted);
    }
    .field input, .field select, .field textarea { color: var(--text); font-size: 13px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12.5px;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
    .hit {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      margin-top: 10px;
      background: var(--surface-2);
    }
    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      background: var(--surface);
      border: 1px solid var(--accent);
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      display: none;
      z-index: 40;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    }
    .auth-banner {
      background: var(--warn-soft);
      border: 1px solid var(--warn);
      border-radius: var(--radius);
      padding: 12px 14px;
      margin-bottom: 16px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    }
    label.chk {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      color: var(--text);
      cursor: pointer;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span class="dot" id="statusDot"></span>
      <span>Hem Vault Daemon</span>
      <span class="pill accent" id="streamBadge">live</span>
    </div>
    <div class="meta-bar">
      <span class="pill" id="vaultPill">vault: …</span>
      <span class="pill" id="countsPill">notes: …</span>
      <span class="pill" id="sessionsPill">sessions: 0</span>
      <button id="reindexBtn" title="Incrementally sync vault into SQLite index">Reindex</button>
    </div>
  </header>

  <main>
    <div id="authBanner" class="auth-banner" style="display:none">
      <span><strong>Daemon token required.</strong> Enter your <code>BRAIN_DAEMON_TOKEN</code> to unlock the control API:</span>
      <input id="tokenInput" type="password" placeholder="Bearer token" style="min-width:220px" />
      <button class="primary" id="saveTokenBtn">Unlock</button>
    </div>

    <nav class="tabs">
      <button class="tab active" data-tab="apps">Harnesses &amp; ACLs</button>
      <button class="tab" data-tab="logs">Live Access Log</button>
      <button class="tab" data-tab="search">Search Score Debugger</button>
      <button class="tab" data-tab="memories">Atomic Memories</button>
    </nav>

    <!-- Panel 1: Apps & ACLs -->
    <section id="tab-apps" class="panel active">
      <div class="card">
        <div class="row between">
          <div>
            <h3>Connected Harnesses &amp; Per-App Permissions</h3>
            <div class="muted">Point any MCP client at <code id="mcpBaseUrl">http://127.0.0.1:4190/mcp?app=&lt;name&gt;</code>. Pause or scope any app instantly.</div>
          </div>
          <form id="addAppForm" class="row">
            <input id="newAppName" placeholder="Add app (e.g. cursor, claude)" pattern="[a-z0-9][a-z0-9_-]{0,31}" required />
            <select id="newAppMode">
              <option value="read-write">read-write</option>
              <option value="read-only">read-only</option>
              <option value="disabled">disabled</option>
            </select>
            <button type="submit" class="primary">Add Policy</button>
          </form>
        </div>
      </div>
      <div id="appsGrid" class="grid"></div>
    </section>

    <!-- Panel 2: Live Access Log -->
    <section id="tab-logs" class="panel">
      <div class="card">
        <div class="row between">
          <div class="row">
            <input id="logFilterApp" placeholder="Filter app" style="width:130px" />
            <input id="logFilterTool" placeholder="Filter tool" style="width:150px" />
            <select id="logFilterOp">
              <option value="">All ops</option>
              <option value="read">read</option>
              <option value="write">write</option>
            </select>
            <select id="logFilterStatus">
              <option value="">All statuses</option>
              <option value="ok">ok</option>
              <option value="denied">denied</option>
              <option value="error">error</option>
            </select>
            <button id="refreshLogsBtn">Refresh</button>
          </div>
          <button id="clearLogsBtn" class="danger">Clear Logs</button>
        </div>
      </div>
      <div class="card" style="padding:0; overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>App</th>
              <th>Tool</th>
              <th>Op</th>
              <th>Status</th>
              <th>Summary</th>
              <th>Hits</th>
              <th>Latency</th>
            </tr>
          </thead>
          <tbody id="logsBody"></tbody>
        </table>
      </div>
    </section>

    <!-- Panel 3: Search Score Debugger -->
    <section id="tab-search" class="panel">
      <div class="card">
        <h3>Hybrid Retrieval Score Debugger (FTS5 BM25 + Vector Cosine + RRF)</h3>
        <form id="searchForm" class="row" style="align-items:flex-end">
          <div class="field" style="flex:1; min-width:220px">
            <label>Query</label>
            <input id="searchQuery" placeholder="e.g. how do we handle postgres pooling?" required />
          </div>
          <div class="field">
            <label>Target</label>
            <select id="searchTarget">
              <option value="notes">Vault Notes</option>
              <option value="memories">Atomic Memories</option>
            </select>
          </div>
          <div class="field">
            <label>Mode</label>
            <select id="searchMode">
              <option value="hybrid">hybrid (FTS + Vector)</option>
              <option value="fts">fts (BM25 only)</option>
              <option value="vector">vector (Cosine only)</option>
            </select>
          </div>
          <div class="field">
            <label>Project (optional)</label>
            <input id="searchProject" placeholder="slug" style="width:130px" />
          </div>
          <div class="field">
            <label>Limit</label>
            <input id="searchLimit" type="number" value="10" min="1" max="50" style="width:72px" />
          </div>
          <button type="submit" class="primary">Run Search</button>
        </form>
        <div id="searchMeta" class="muted" style="margin-top:10px"></div>
        <div id="searchHits"></div>
      </div>
    </section>

    <!-- Panel 4: Atomic Memories -->
    <section id="tab-memories" class="panel">
      <div class="card">
        <h3>Quick Add Atomic Memory</h3>
        <form id="addMemForm" class="row" style="align-items:flex-end">
          <div class="field" style="min-width:190px; flex:1">
            <label>Title</label>
            <input id="memTitle" placeholder="Concise memory title" required />
          </div>
          <div class="field" style="min-width:240px; flex:2">
            <label>Content</label>
            <input id="memContent" placeholder="Durable fact, preference, or decision (no secrets)" required />
          </div>
          <div class="field">
            <label>Category</label>
            <select id="memCategory">
              <option value="facts">facts</option>
              <option value="preferences">preferences</option>
              <option value="decisions">decisions</option>
              <option value="gotchas">gotchas</option>
              <option value="profile">profile</option>
            </select>
          </div>
          <div class="field">
            <label>Project (blank=global)</label>
            <input id="memProject" placeholder="slug" style="width:120px" />
          </div>
          <button type="submit" class="primary">Save Memory</button>
        </form>
      </div>
      <div class="card">
        <div class="row between" style="margin-bottom:10px">
          <div class="row">
            <select id="memFilterStatus">
              <option value="active">active</option>
              <option value="superseded">superseded</option>
              <option value="all">all</option>
            </select>
            <select id="memFilterCategory">
              <option value="">All categories</option>
              <option value="profile">profile</option>
              <option value="preferences">preferences</option>
              <option value="decisions">decisions</option>
              <option value="facts">facts</option>
              <option value="gotchas">gotchas</option>
            </select>
            <input id="memFilterApp" placeholder="App" style="width:110px" />
            <input id="memFilterProject" placeholder="Project" style="width:120px" />
            <button id="refreshMemBtn">Refresh</button>
          </div>
          <span class="muted" id="memCountLabel"></span>
        </div>
        <div id="memoriesList"></div>
      </div>
    </section>
  </main>

  <div class="toast" id="toast"></div>

  <script${scriptNonceAttr}>
    const TOKEN_REQUIRED = ${JSON.stringify(tokenRequired)};
    const BASE_ORIGIN = window.location.origin;
    document.getElementById("mcpBaseUrl").textContent = BASE_ORIGIN + "/mcp?app=<name>";

    function getToken() {
      return sessionStorage.getItem("brain_daemon_token") || "";
    }

    function esc(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    let toastTimer = null;
    function showToast(msg) {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.style.display = "block";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { el.style.display = "none"; }, 2800);
    }

    async function api(path, opts = {}) {
      const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
      const tok = getToken();
      if (tok) headers["Authorization"] = "Bearer " + tok;
      const res = await fetch(path, Object.assign({}, opts, { headers }));
      if (res.status === 401) {
        document.getElementById("authBanner").style.display = "flex";
        throw new Error("Unauthorized — enter daemon token");
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || ("HTTP " + res.status));
      }
      return data;
    }

    // Tabs
    document.querySelectorAll("button.tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("button.tab").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll("section.panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
        if (btn.dataset.tab === "logs") loadLogs();
        if (btn.dataset.tab === "memories") loadMemories();
        if (btn.dataset.tab === "apps") loadApps();
      });
    });

    document.getElementById("saveTokenBtn").addEventListener("click", () => {
      const val = document.getElementById("tokenInput").value.trim();
      if (!val) return;
      sessionStorage.setItem("brain_daemon_token", val);
      document.getElementById("authBanner").style.display = "none";
      boot();
    });

    async function loadHealth() {
      try {
        const h = await api("/api/health");
        document.getElementById("vaultPill").textContent = "vault: " + h.vault;
        document.getElementById("countsPill").textContent =
          "notes: " + h.noteCount + " · memories: " + h.memoryCount;
        document.getElementById("sessionsPill").textContent = "sessions: " + h.activeSessions;
        document.getElementById("statusDot").style.background = h.readable ? "var(--ok)" : "var(--danger)";
      } catch (err) {
        document.getElementById("statusDot").style.background = "var(--danger)";
      }
    }

    async function loadApps() {
      const grid = document.getElementById("appsGrid");
      try {
        const { apps } = await api("/api/apps");
        if (!apps.length) {
          grid.innerHTML = '<div class="card muted">No harnesses connected yet. Connect Cursor, Claude, Codex, or Zed to <code>' +
            esc(BASE_ORIGIN + "/mcp?app=cursor") + '</code> or add a policy above.</div>';
          return;
        }
        grid.innerHTML = apps.map((a) => {
          const paused = !a.enabled || a.mode === "disabled";
          const statusClass = paused ? "danger" : a.mode === "read-only" ? "warn" : "ok";
          const statusLabel = !a.enabled ? "paused" : a.mode;
          const mcpUrl = BASE_ORIGIN + "/mcp?app=" + encodeURIComponent(a.app);
          return '<div class="card" data-app="' + esc(a.app) + '">' +
            '<div class="row between" style="margin-bottom:8px">' +
              '<div class="row"><strong>' + esc(a.app) + '</strong>' +
              '<span class="pill ' + statusClass + '">' + esc(statusLabel) + '</span>' +
              '<span class="pill">' + esc(a.source) + '</span>' +
              (a.activeSessions ? '<span class="pill accent">' + esc(a.activeSessions) + ' live</span>' : '') +
              '</div>' +
              '<div class="row">' +
                '<button class="js-copy" data-url="' + esc(mcpUrl) + '">Copy URL</button>' +
                '<button class="js-toggle ' + (paused ? "primary" : "danger") + '" data-app="' + esc(a.app) + '" data-next="' + (a.enabled ? "0" : "1") + '">' +
                  (a.enabled ? "Pause" : "Resume") + '</button>' +
              '</div>' +
            '</div>' +
            '<div class="muted mono" style="margin-bottom:10px">' +
              'calls: ' + esc(a.stats.totalCalls) + ' · reads: ' + esc(a.stats.readCalls) +
              ' · writes: ' + esc(a.stats.writeCalls) + ' · denied: ' + esc(a.stats.deniedCalls) +
              '<br/>last seen: ' + esc(a.lastSeen) +
            '</div>' +
            '<div class="row" style="margin-bottom:8px">' +
              '<div class="field"><label>Mode</label>' +
                '<select class="js-mode">' +
                  '<option value="read-write"' + (a.mode === "read-write" ? " selected" : "") + '>read-write</option>' +
                  '<option value="read-only"' + (a.mode === "read-only" ? " selected" : "") + '>read-only</option>' +
                  '<option value="disabled"' + (a.mode === "disabled" ? " selected" : "") + '>disabled</option>' +
                '</select></div>' +
              '<div class="field"><label>Read scopes</label><div class="row">' +
                '<label class="chk"><input type="checkbox" class="js-rs" value="global"' + (a.readScopes.includes("global") ? " checked" : "") + '/>global</label>' +
                '<label class="chk"><input type="checkbox" class="js-rs" value="project"' + (a.readScopes.includes("project") ? " checked" : "") + '/>project</label>' +
              '</div></div>' +
              '<div class="field"><label>Write scopes</label><div class="row">' +
                '<label class="chk"><input type="checkbox" class="js-ws" value="global"' + (a.writeScopes.includes("global") ? " checked" : "") + '/>global</label>' +
                '<label class="chk"><input type="checkbox" class="js-ws" value="project"' + (a.writeScopes.includes("project") ? " checked" : "") + '/>project</label>' +
              '</div></div>' +
            '</div>' +
            '<div class="row" style="margin-bottom:10px">' +
              '<div class="field" style="flex:1"><label>Allowed projects (comma slugs, blank = all)</label>' +
                '<input class="js-projects" value="' + esc(a.allowedProjects.join(", ")) + '" placeholder="*" /></div>' +
              '<div class="field" style="flex:1"><label>Denied tools (comma names)</label>' +
                '<input class="js-denied" value="' + esc(a.deniedTools.join(", ")) + '" placeholder="e.g. delete_memory" /></div>' +
            '</div>' +
            '<div class="row between">' +
              '<button class="js-reset">Reset to default</button>' +
              '<button class="primary js-save">Save ACL</button>' +
            '</div>' +
          '</div>';
        }).join("");

        grid.querySelectorAll(".js-copy").forEach((b) => {
          b.addEventListener("click", async () => {
            try { await navigator.clipboard.writeText(b.dataset.url); showToast("Copied MCP URL"); }
            catch { showToast(b.dataset.url); }
          });
        });
        grid.querySelectorAll(".js-toggle").forEach((b) => {
          b.addEventListener("click", async () => {
            const app = b.dataset.app;
            const enabled = b.dataset.next === "1";
            try {
              await api("/api/apps/" + encodeURIComponent(app), {
                method: "PUT",
                body: JSON.stringify({ enabled }),
              });
              showToast((enabled ? "Resumed " : "Paused ") + app);
              loadApps();
            } catch (err) { showToast(err.message); }
          });
        });
        grid.querySelectorAll(".js-save").forEach((b) => {
          b.addEventListener("click", async () => {
            const card = b.closest(".card");
            const app = card.dataset.app;
            const mode = card.querySelector(".js-mode").value;
            const readScopes = [...card.querySelectorAll(".js-rs:checked")].map((x) => x.value);
            const writeScopes = [...card.querySelectorAll(".js-ws:checked")].map((x) => x.value);
            const allowedProjects = card.querySelector(".js-projects").value.split(",").map((s) => s.trim()).filter(Boolean);
            const deniedTools = card.querySelector(".js-denied").value.split(",").map((s) => s.trim()).filter(Boolean);
            try {
              await api("/api/apps/" + encodeURIComponent(app), {
                method: "PUT",
                body: JSON.stringify({
                  enabled: mode !== "disabled",
                  mode,
                  readScopes,
                  writeScopes,
                  allowedProjects,
                  deniedTools,
                }),
              });
              showToast("Saved ACL for " + app);
              loadApps();
            } catch (err) { showToast(err.message); }
          });
        });
        grid.querySelectorAll(".js-reset").forEach((b) => {
          b.addEventListener("click", async () => {
            const app = b.closest(".card").dataset.app;
            try {
              await api("/api/apps/" + encodeURIComponent(app) + "/override", { method: "DELETE" });
              showToast("Reset " + app + " to default");
              loadApps();
            } catch (err) { showToast(err.message); }
          });
        });
      } catch (err) {
        grid.innerHTML = '<div class="card muted">' + esc(err.message) + '</div>';
      }
    }

    document.getElementById("addAppForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const app = document.getElementById("newAppName").value.trim().toLowerCase();
      const mode = document.getElementById("newAppMode").value;
      try {
        await api("/api/apps/" + encodeURIComponent(app), {
          method: "PUT",
          body: JSON.stringify({ enabled: mode !== "disabled", mode }),
        });
        document.getElementById("newAppName").value = "";
        showToast("Added policy for " + app);
        loadApps();
      } catch (err) { showToast(err.message); }
    });

    function renderLogRow(entry) {
      const stCls = entry.status === "ok" ? "ok" : entry.status === "denied" ? "warn" : "danger";
      const opCls = entry.operation === "write" ? "accent" : "";
      const time = (entry.ts || "").replace("T", " ").slice(0, 19);
      return '<tr>' +
        '<td class="mono muted">' + esc(time) + '</td>' +
        '<td class="mono"><strong>' + esc(entry.app) + '</strong></td>' +
        '<td class="mono">' + esc(entry.tool) + '</td>' +
        '<td><span class="pill ' + opCls + '">' + esc(entry.operation) + '</span></td>' +
        '<td><span class="pill ' + stCls + '">' + esc(entry.status) + '</span></td>' +
        '<td class="mono">' + esc(entry.summary) + '</td>' +
        '<td class="mono">' + (entry.resultCount === null || entry.resultCount === undefined ? "—" : esc(entry.resultCount)) + '</td>' +
        '<td class="mono">' + esc(entry.durationMs) + 'ms</td>' +
      '</tr>';
    }

    async function loadLogs() {
      const params = new URLSearchParams();
      const app = document.getElementById("logFilterApp").value.trim();
      const tool = document.getElementById("logFilterTool").value.trim();
      const op = document.getElementById("logFilterOp").value;
      const st = document.getElementById("logFilterStatus").value;
      if (app) params.set("app", app);
      if (tool) params.set("tool", tool);
      if (op) params.set("operation", op);
      if (st) params.set("status", st);
      params.set("limit", "100");
      try {
        const { logs } = await api("/api/logs?" + params.toString());
        const body = document.getElementById("logsBody");
        body.innerHTML = logs.length
          ? logs.map(renderLogRow).join("")
          : '<tr><td colspan="8" class="muted">No access events yet.</td></tr>';
      } catch (err) { showToast(err.message); }
    }

    document.getElementById("refreshLogsBtn").addEventListener("click", loadLogs);
    document.getElementById("clearLogsBtn").addEventListener("click", async () => {
      try {
        await api("/api/logs", { method: "DELETE" });
        showToast("Cleared access log");
        loadLogs();
        loadApps();
      } catch (err) { showToast(err.message); }
    });

    document.getElementById("searchForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const query = document.getElementById("searchQuery").value.trim();
      const target = document.getElementById("searchTarget").value;
      const mode = document.getElementById("searchMode").value;
      const project = document.getElementById("searchProject").value.trim() || undefined;
      const limit = Number(document.getElementById("searchLimit").value) || 10;
      const hitsEl = document.getElementById("searchHits");
      const metaEl = document.getElementById("searchMeta");
      hitsEl.innerHTML = '<div class="muted" style="margin-top:10px">Searching…</div>';
      try {
        const res = await api("/api/search", {
          method: "POST",
          body: JSON.stringify({ query, target, mode, project, limit }),
        });
        metaEl.textContent = "target=" + target + " · mode=" + res.modeUsed + " · hits=" + res.hits.length + " · " + res.searchMs + "ms" +
          (res.embedWarning ? " · warning: " + res.embedWarning : "");
        if (!res.hits.length) {
          hitsEl.innerHTML = '<div class="muted" style="margin-top:10px">No matches found.</div>';
          return;
        }
        hitsEl.innerHTML = res.hits.map((h, i) => {
          if (target === "memories") {
            const m = h.memory;
            return '<div class="hit">' +
              '<div class="row between"><strong>' + (i + 1) + '. [' + esc(m.id) + '] ' + esc(m.title) + '</strong>' +
              '<div class="row"><span class="pill accent">score=' + esc(h.score) + '</span>' +
              (h.vectorScore !== null ? '<span class="pill ok">sim=' + esc(h.vectorScore) + '</span>' : '') +
              '<span class="pill">' + esc(h.matchedBy.join("+")) + '</span></div></div>' +
              '<div class="muted mono">' + esc(m.path) + ' · ' + esc(m.category) + ' · app=' + esc(m.app) + ' · updated=' + esc(m.updated) + '</div>' +
              '<div style="margin-top:6px">' + esc(m.content) + '</div></div>';
          }
          return '<div class="hit">' +
            '<div class="row between"><strong>' + (i + 1) + '. ' + esc(h.path) + ' — ' + esc(h.heading || h.title) + '</strong>' +
            '<div class="row"><span class="pill accent">score=' + esc(h.score) + '</span>' +
            (h.vectorScore !== null ? '<span class="pill ok">sim=' + esc(h.vectorScore) + '</span>' : '') +
            '<span class="pill">' + esc(h.matchedBy.join("+")) + '</span></div></div>' +
            '<div class="muted mono">' +
              [h.type ? "type=" + h.type : null, h.project ? "project=" + h.project : h.scope ? "scope=" + h.scope : null, h.updated ? "updated=" + h.updated : null].filter(Boolean).map(esc).join(" · ") +
            '</div>' +
            '<div style="margin-top:6px">' + esc(h.snippet) + '</div>' +
            (h.relatedLinks && h.relatedLinks.length ? '<div class="muted mono" style="margin-top:4px">links: ' + esc(h.relatedLinks.join(", ")) + '</div>' : '') +
          '</div>';
        }).join("");
      } catch (err) {
        hitsEl.innerHTML = '<div class="muted">' + esc(err.message) + '</div>';
      }
    });

    async function loadMemories() {
      const params = new URLSearchParams();
      params.set("status", document.getElementById("memFilterStatus").value);
      const cat = document.getElementById("memFilterCategory").value;
      const app = document.getElementById("memFilterApp").value.trim();
      const proj = document.getElementById("memFilterProject").value.trim();
      if (cat) params.set("category", cat);
      if (app) params.set("app", app);
      if (proj) params.set("project", proj);
      params.set("limit", "60");
      const list = document.getElementById("memoriesList");
      try {
        const { count, memories } = await api("/api/memories?" + params.toString());
        document.getElementById("memCountLabel").textContent = count + " memories";
        if (!memories.length) {
          list.innerHTML = '<div class="muted">No memories matched the filter.</div>';
          return;
        }
        list.innerHTML = memories.map((m) =>
          '<div class="hit">' +
            '<div class="row between">' +
              '<div class="row"><span class="pill mono">' + esc(m.id) + '</span><strong>' + esc(m.title) + '</strong>' +
              '<span class="pill ' + (m.status === "active" ? "ok" : "warn") + '">' + esc(m.status) + '</span>' +
              '<span class="pill">' + esc(m.category) + '</span>' +
              '<span class="pill">' + esc(m.project ? "project:" + m.project : "global") + '</span>' +
              '<span class="pill">app:' + esc(m.app) + '</span></div>' +
              '<div class="row">' +
                (m.status === "active" ? '<button class="js-sup" data-id="' + esc(m.id) + '">Supersede</button>' : '') +
                '<button class="danger js-del" data-id="' + esc(m.id) + '">Delete</button>' +
              '</div>' +
            '</div>' +
            '<div class="muted mono" style="margin-top:4px">' + esc(m.path) + ' · updated ' + esc(m.updated) +
              (m.supersedes ? ' · supersedes ' + esc(m.supersedes) : '') +
              (m.supersededBy ? ' · superseded by ' + esc(m.supersededBy) : '') +
            '</div>' +
            '<div style="margin-top:6px; white-space:pre-wrap">' + esc(m.content) + '</div>' +
          '</div>'
        ).join("");
        list.querySelectorAll(".js-del").forEach((b) => {
          b.addEventListener("click", async () => {
            if (!confirm("Permanently delete memory " + b.dataset.id + "?")) return;
            try {
              await api("/api/memories/" + encodeURIComponent(b.dataset.id), { method: "DELETE" });
              showToast("Deleted " + b.dataset.id);
              loadMemories();
              loadHealth();
            } catch (err) { showToast(err.message); }
          });
        });
        list.querySelectorAll(".js-sup").forEach((b) => {
          b.addEventListener("click", async () => {
            const content = prompt("Enter replacement content for " + b.dataset.id + ":");
            if (!content || !content.trim()) return;
            try {
              await api("/api/memories/" + encodeURIComponent(b.dataset.id) + "/supersede", {
                method: "POST",
                body: JSON.stringify({ content: content.trim() }),
              });
              showToast("Superseded " + b.dataset.id);
              loadMemories();
            } catch (err) { showToast(err.message); }
          });
        });
      } catch (err) {
        list.innerHTML = '<div class="muted">' + esc(err.message) + '</div>';
      }
    }

    document.getElementById("refreshMemBtn").addEventListener("click", loadMemories);
    document.getElementById("addMemForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = document.getElementById("memTitle").value.trim();
      const content = document.getElementById("memContent").value.trim();
      const category = document.getElementById("memCategory").value;
      const project = document.getElementById("memProject").value.trim() || undefined;
      try {
        const res = await api("/api/memories", {
          method: "POST",
          body: JSON.stringify({ title, content, category, project, scope: project ? "project" : "global" }),
        });
        document.getElementById("memTitle").value = "";
        document.getElementById("memContent").value = "";
        showToast("Memory " + res.action + ": " + res.memory.id);
        loadMemories();
        loadHealth();
      } catch (err) { showToast(err.message); }
    });

    document.getElementById("reindexBtn").addEventListener("click", async () => {
      try {
        showToast("Reindexing vault…");
        const res = await api("/api/reindex", { method: "POST", body: JSON.stringify({}) });
        showToast("Index synced: " + res.chunksIndexed + " chunks (" + res.durationMs + "ms)");
        loadHealth();
      } catch (err) { showToast(err.message); }
    });

    let sse = null;
    let pollTimer = null;
    function connectLiveStream() {
      if (sse) { sse.close(); sse = null; }
      clearInterval(pollTimer);
      // EventSource cannot attach Authorization headers, so fall back to polling when token auth is active
      if (TOKEN_REQUIRED || getToken()) {
        document.getElementById("streamBadge").textContent = "polling";
        pollTimer = setInterval(() => {
          loadHealth();
          if (document.getElementById("tab-logs").classList.contains("active")) loadLogs();
          if (document.getElementById("tab-apps").classList.contains("active")) loadApps();
        }, 4000);
        return;
      }
      sse = new EventSource("/api/events");
      sse.addEventListener("access", () => {
        loadHealth();
        if (document.getElementById("tab-logs").classList.contains("active")) loadLogs();
        if (document.getElementById("tab-apps").classList.contains("active")) loadApps();
      });
      sse.onerror = () => {
        document.getElementById("streamBadge").textContent = "reconnecting";
      };
      sse.onopen = () => {
        document.getElementById("streamBadge").textContent = "live";
      };
    }

    function boot() {
      if (TOKEN_REQUIRED && !getToken()) {
        document.getElementById("authBanner").style.display = "flex";
        return;
      }
      loadHealth();
      loadApps();
      loadLogs();
      connectLiveStream();
    }

    boot();
  </script>
</body>
</html>
`;
}
