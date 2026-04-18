import { Router, Request, Response } from 'express';
import { listEvents, eventStats } from '../shared/events';

// /inspect is PUBLIC by default (testing). Set INSPECT_TOKEN env var to
// require ?token=<secret> or x-admin-secret header. When unset, anyone who
// knows the URL sees all events (including user IDs + utterances). Fine for
// pilot testing; not for production with real users.
export type InspectConfig = {
  token: string;   // empty string = public
};

function tokenFromReq(req: Request): string {
  return (
    (req.query?.token as string) ||
    (req.headers['x-admin-secret'] as string) ||
    ''
  );
}

export function buildInspectRouter(cfg: InspectConfig): Router {
  const router = Router();

  const maybeAuth = (req: Request, res: Response, next: any) => {
    if (!cfg.token) return next();  // public mode
    if (tokenFromReq(req) !== cfg.token) {
      return res.status(401).json({ error: 'unauthorized — append ?token=<INSPECT_TOKEN>' });
    }
    next();
  };

  router.get('/events', maybeAuth, (req: Request, res: Response) => {
    const since = req.query.since ? Number(req.query.since) : undefined;
    const skill = (req.query.skill as string) || undefined;
    const level = (req.query.level as string) || undefined;
    const kind = (req.query.kind as string) || undefined;
    const user = (req.query.user as string) || undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const events = listEvents({ since, skill, level, kind, user, limit });
    res.json({
      stats: eventStats(),
      events,
    });
  });

  router.get('/', maybeAuth, (_req: Request, res: Response) => {
    res.type('text/html').send(HTML);
  });

  return router;
}

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Trace Skills · Inspect</title>
<style>
  :root {
    --bg:      #0d1117;
    --panel:   #161b22;
    --border:  #30363d;
    --text:    #c9d1d9;
    --muted:   #8b949e;
    --accent:  #58a6ff;
    --warn:    #d29922;
    --error:   #f85149;
    --ok:      #3fb950;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: var(--bg); color: var(--text); font-size: 13px;
  }
  header {
    padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  }
  header h1 { margin: 0; font-size: 14px; font-weight: 600; }
  header .muted { color: var(--muted); }
  header .pill {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: #21262d; font-size: 11px; color: var(--muted);
  }
  header select, header input[type="text"] {
    background: #0d1117; color: var(--text); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 8px; font-family: inherit; font-size: 12px;
  }
  header button {
    background: var(--accent); color: #fff; border: 0; border-radius: 4px;
    padding: 4px 10px; font-family: inherit; font-size: 12px; cursor: pointer;
  }
  header button:disabled { opacity: .5; cursor: default; }
  header label.toggle { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; cursor: pointer; }
  main { padding: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td {
    padding: 6px 10px; text-align: left; vertical-align: top;
    border-bottom: 1px solid var(--border);
  }
  thead th {
    position: sticky; top: 0; background: var(--panel);
    font-weight: 500; font-size: 11px; color: var(--muted);
    text-transform: uppercase; letter-spacing: .5px;
  }
  tbody tr:hover { background: #131822; }
  .ts      { color: var(--muted); white-space: nowrap; }
  .skill   { font-weight: 500; }
  .skill.object-memory { color: #a5d6ff; }
  .skill.shopping-cart { color: #ffa657; }
  .skill.system        { color: var(--muted); }
  .kind    { color: var(--muted); }
  .user    { color: #d2a8ff; }
  .req     { color: #39d0d8; font-size: 11px; }
  .sum     { }
  .level-warn  { color: var(--warn); }
  .level-error { color: var(--error); font-weight: 600; }
  details { margin-top: 4px; }
  details summary { cursor: pointer; color: var(--muted); font-size: 11px; }
  details pre {
    margin: 4px 0 0 0; padding: 8px; background: #0a0d12; border: 1px solid var(--border);
    border-radius: 4px; font-size: 11px; max-width: 90vw; overflow: auto;
  }
  .empty { padding: 40px 16px; text-align: center; color: var(--muted); }
  .stats { display: flex; gap: 16px; font-size: 11px; color: var(--muted); margin-left: auto; }
  .pulse {
    width: 8px; height: 8px; border-radius: 50%; background: var(--ok);
    display: inline-block; animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
</style>
</head>
<body>
<header>
  <h1>🔭 Trace Skills · Inspect</h1>
  <span class="pill"><span class="pulse"></span> LIVE</span>
  <select id="skill">
    <option value="">all skills</option>
    <option value="object-memory">object-memory</option>
    <option value="shopping-cart">shopping-cart</option>
    <option value="system">system</option>
  </select>
  <select id="level">
    <option value="">all levels</option>
    <option value="info">info</option>
    <option value="warn">warn</option>
    <option value="error">error</option>
  </select>
  <input type="text" id="kindFilter" placeholder="kind contains…" size="18">
  <input type="text" id="userFilter" placeholder="user id…" size="18">
  <label class="toggle"><input type="checkbox" id="pause"> pause</label>
  <button id="clear">clear view</button>
  <div class="stats" id="stats"></div>
</header>
<main>
  <table>
    <thead>
      <tr>
        <th style="width:12%">time</th>
        <th style="width:13%">skill</th>
        <th style="width:15%">kind</th>
        <th style="width:10%">user</th>
        <th style="width:10%">req</th>
        <th>summary / detail</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="empty" class="empty" hidden>No events yet. Take a photo on the glasses or say something to a skill.</div>
</main>
<script>
  const rows = document.getElementById('rows');
  const empty = document.getElementById('empty');
  const stats = document.getElementById('stats');
  const skillSel = document.getElementById('skill');
  const levelSel = document.getElementById('level');
  const kindInput = document.getElementById('kindFilter');
  const userInput = document.getElementById('userFilter');
  const pause = document.getElementById('pause');
  const clearBtn = document.getElementById('clear');
  const token = new URLSearchParams(location.search).get('token') || '';
  let lastId = 0;
  let viewCleared = false;

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }
  function truncate(s, n) { return !s ? '' : s.length > n ? s.slice(0, n-1) + '…' : s; }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function renderRow(e) {
    const tr = document.createElement('tr');
    const levelClass = e.level && e.level !== 'info' ? ' level-' + e.level : '';
    let detailHtml = '';
    if (e.detail) {
      try {
        const pretty = JSON.stringify(JSON.parse(e.detail), null, 2);
        detailHtml = '<details><summary>detail</summary><pre>' + esc(pretty) + '</pre></details>';
      } catch {
        detailHtml = '<details><summary>detail</summary><pre>' + esc(e.detail) + '</pre></details>';
      }
    }
    tr.innerHTML = ''
      + '<td class="ts">' + fmtTime(e.ts) + '</td>'
      + '<td class="skill ' + esc(e.skill) + '">' + esc(e.skill) + '</td>'
      + '<td class="kind">' + esc(e.kind) + '</td>'
      + '<td class="user">' + esc(truncate(e.user_id, 10)) + '</td>'
      + '<td class="req">' + esc(truncate(e.request_id, 8)) + '</td>'
      + '<td class="sum' + levelClass + '">' + esc(e.summary) + detailHtml + '</td>';
    return tr;
  }

  async function poll() {
    if (pause.checked) return;
    const params = new URLSearchParams();
    params.set('since', String(lastId));
    if (skillSel.value) params.set('skill', skillSel.value);
    if (levelSel.value) params.set('level', levelSel.value);
    if (kindInput.value) params.set('kind', kindInput.value);
    if (userInput.value) params.set('user', userInput.value);
    if (token) params.set('token', token);
    try {
      const r = await fetch('/inspect/events?' + params.toString());
      if (!r.ok) { stats.textContent = 'fetch failed (HTTP ' + r.status + ')'; return; }
      const body = await r.json();
      const newEvents = body.events.slice().reverse(); // oldest first for prepend-at-top
      if (newEvents.length > 0) {
        for (const e of newEvents) {
          if (e.id > lastId) lastId = e.id;
          rows.prepend(renderRow(e));
        }
        // cap DOM to 300 rows so long runs stay snappy
        while (rows.children.length > 300) rows.removeChild(rows.lastChild);
      }
      const s = body.stats;
      stats.innerHTML = ''
        + '<span>' + s.total + '/' + s.max + ' events</span>'
        + '<span>OM: ' + (s.bySkill['object-memory'] || 0) + '</span>'
        + '<span>Cart: ' + (s.bySkill['shopping-cart'] || 0) + '</span>'
        + '<span style="color:var(--error)">err: ' + (s.byLevel.error || 0) + '</span>';
      empty.hidden = rows.children.length > 0;
    } catch (e) {
      stats.textContent = 'poll error: ' + e.message;
    }
  }

  clearBtn.addEventListener('click', () => {
    rows.innerHTML = '';
    empty.hidden = false;
    viewCleared = true;
  });
  for (const el of [skillSel, levelSel, kindInput, userInput]) {
    el.addEventListener('change', () => { rows.innerHTML = ''; lastId = 0; });
    el.addEventListener('keyup', () => { rows.innerHTML = ''; lastId = 0; });
  }

  poll();
  setInterval(poll, 2000);
</script>
</body>
</html>
`;
