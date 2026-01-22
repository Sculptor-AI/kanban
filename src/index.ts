// Main entry point for Kanban Cloudflare Worker

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { authMiddleware } from './middleware/auth';
import authRoutes from './routes/auth';
import boardRoutes from './routes/boards';
import listRoutes from './routes/lists';
import cardRoutes from './routes/cards';
import labelRoutes from './routes/labels';
import uploadRoutes from './routes/upload';
import type { AppContext, Env } from './types';

// Re-export Durable Object
export { BoardRoom } from './durable-objects/board-room';

const app = new Hono<AppContext>();

// Security headers
app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:'],
    connectSrc: ["'self'", 'wss:'],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    upgradeInsecureRequests: []
  },
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin'
}));

// CORS - only for same origin
app.use('/api/*', cors({
  origin: (origin) => origin,
  credentials: true,
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization']
}));

// Auth middleware for all routes
app.use('*', authMiddleware);

// API routes
app.route('/api/auth', authRoutes);
app.route('/api/boards', boardRoutes);
app.route('/api/lists', listRoutes);
app.route('/api/cards', cardRoutes);
app.route('/api/labels', labelRoutes);
app.route('/api/upload', uploadRoutes);

// WebSocket endpoint for real-time collaboration
app.get('/api/ws/:boardId', async (c) => {
  const boardId = c.req.param('boardId');
  const token = c.req.query('token');

  if (!token) {
    return c.json({ success: false, error: 'Token required' }, 400);
  }

  // Get or create Durable Object for this board
  const id = c.env.BOARD_ROOM.idFromName(boardId);
  const stub = c.env.BOARD_ROOM.get(id);

  // Forward the WebSocket upgrade request
  const url = new URL(c.req.url);
  url.pathname = '/';
  url.searchParams.set('token', token);
  url.searchParams.set('boardId', boardId);

  return stub.fetch(new Request(url.toString(), {
    headers: c.req.raw.headers
  }));
});

// Broadcast endpoint for API to notify WebSocket clients
app.post('/api/boards/:boardId/broadcast', async (c) => {
  const boardId = c.req.param('boardId');
  const user = c.get('user');

  if (!user) {
    return c.json({ success: false, error: 'Authentication required' }, 401);
  }

  const body = await c.req.json();

  const id = c.env.BOARD_ROOM.idFromName(boardId);
  const stub = c.env.BOARD_ROOM.get(id);

  await stub.fetch(new Request('https://internal/broadcast', {
    method: 'POST',
    body: JSON.stringify(body)
  }));

  return c.json({ success: true });
});

// Serve R2 storage files
app.get('/storage/*', async (c) => {
  const key = c.req.path.replace('/storage/', '');

  const object = await c.env.STORAGE.get(key);
  if (!object) {
    return c.notFound();
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', object.httpMetadata?.cacheControl || 'public, max-age=31536000');
  headers.set('ETag', object.httpEtag);

  return new Response(object.body, { headers });
});

// Search users (for adding to boards)
app.get('/api/users/search', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ success: false, error: 'Authentication required' }, 401);
  }

  const query = c.req.query('q');
  if (!query || query.length < 2) {
    return c.json({ success: true, data: { users: [] } });
  }

  const users = await c.env.DB.prepare(`
    SELECT id, username, display_name, avatar_url
    FROM users
    WHERE username LIKE ? OR display_name LIKE ?
    LIMIT 10
  `).bind(`%${query}%`, `%${query}%`).all();

  return c.json({
    success: true,
    data: { users: users.results }
  });
});

// Health check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() });
});

// Serve static files for frontend
app.get('*', async (c) => {
  const url = new URL(c.req.url);
  let path = url.pathname;

  // Default to index.html for SPA routing
  if (!path.includes('.')) {
    path = '/index.html';
  }

  // Try to get from R2 (where we'll store the frontend build)
  const object = await c.env.STORAGE.get(`public${path}`);
  if (object) {
    const headers = new Headers();
    headers.set('Content-Type', getContentType(path));
    headers.set('Cache-Control', path === '/index.html' ? 'no-cache' : 'public, max-age=31536000');
    return new Response(object.body, { headers });
  }

  // Fall back to embedded HTML for the SPA
  return c.html(getIndexHtml());
});

function getContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'woff': 'font/woff',
    'woff2': 'font/woff2'
  };
  return types[ext || ''] || 'application/octet-stream';
}

function getIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kanban</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📋</text></svg>">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #fafafa;
      --bg-secondary: #fff;
      --border: #e0e0e0;
      --text: #1a1a1a;
      --text-secondary: #666;
      --accent: #333;
      --danger: #c00;
      --success: #060;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
    }
    #app { min-height: 100vh; }
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: var(--text-secondary);
    }
    button {
      font-family: inherit;
      font-size: inherit;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--bg-secondary);
      padding: 0.5rem 1rem;
      border-radius: 4px;
      transition: background 0.15s, border-color 0.15s;
    }
    button:hover { border-color: var(--accent); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.primary {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    button.danger { color: var(--danger); }
    input, textarea {
      font-family: inherit;
      font-size: inherit;
      border: 1px solid var(--border);
      padding: 0.5rem;
      border-radius: 4px;
      width: 100%;
    }
    input:focus, textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header h1 { font-size: 1rem; font-weight: 600; }
    .header-actions { display: flex; gap: 0.5rem; align-items: center; }
    .avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-secondary);
      overflow: hidden;
    }
    .avatar img { width: 100%; height: 100%; object-fit: cover; }

    /* Auth forms */
    .auth-container {
      max-width: 360px;
      margin: 4rem auto;
      padding: 2rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .auth-container h2 { margin-bottom: 1.5rem; font-size: 1.25rem; }
    .form-group { margin-bottom: 1rem; }
    .form-group label { display: block; margin-bottom: 0.25rem; font-size: 0.875rem; }
    .form-error { color: var(--danger); font-size: 0.875rem; margin-top: 0.5rem; }
    .form-actions { margin-top: 1.5rem; }
    .form-actions button { width: 100%; }
    .auth-switch { margin-top: 1rem; text-align: center; font-size: 0.875rem; color: var(--text-secondary); }

    /* Board list */
    .boards-container { padding: 1.5rem; max-width: 900px; margin: 0 auto; }
    .boards-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
    .boards-header h2 { font-size: 1.25rem; }
    .board-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; }
    .board-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 1rem;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .board-card:hover { border-color: var(--accent); }
    .board-card h3 { font-size: 1rem; margin-bottom: 0.5rem; }
    .board-card p { font-size: 0.875rem; color: var(--text-secondary); }

    /* Board view */
    .board-container { height: calc(100vh - 49px); display: flex; flex-direction: column; }
    .board-header {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--bg-secondary);
    }
    .board-title { font-size: 1rem; font-weight: 600; }
    .board-content {
      flex: 1;
      overflow-x: auto;
      padding: 1rem;
      display: flex;
      gap: 1rem;
      align-items: flex-start;
    }

    /* Lists */
    .list {
      flex-shrink: 0;
      width: 280px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      max-height: 100%;
      display: flex;
      flex-direction: column;
    }
    .list-header {
      padding: 0.75rem;
      font-weight: 600;
      font-size: 0.875rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: grab;
    }
    .list-header.dragging { cursor: grabbing; }
    .list-cards {
      padding: 0.5rem;
      overflow-y: auto;
      flex: 1;
      min-height: 40px;
    }
    .add-card-btn {
      padding: 0.5rem 0.75rem;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      text-align: left;
      font-size: 0.875rem;
    }
    .add-card-btn:hover { color: var(--text); }
    .add-list {
      flex-shrink: 0;
      width: 280px;
      background: var(--bg);
      border: 1px dashed var(--border);
      border-radius: 6px;
      padding: 0.75rem;
    }
    .add-list button {
      width: 100%;
      background: transparent;
      border: none;
      color: var(--text-secondary);
      text-align: left;
    }

    /* Cards */
    .card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 0.5rem 0.75rem;
      margin-bottom: 0.5rem;
      cursor: pointer;
      font-size: 0.875rem;
      transition: border-color 0.15s;
    }
    .card:hover { border-color: var(--accent); }
    .card.dragging { opacity: 0.5; }
    .card-labels { display: flex; gap: 0.25rem; margin-bottom: 0.25rem; flex-wrap: wrap; }
    .card-label {
      height: 6px;
      width: 32px;
      border-radius: 3px;
    }
    .card-title { margin-bottom: 0.25rem; }
    .card-meta { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem; }
    .card-assignees { display: flex; margin-left: auto; }
    .card-assignees .avatar { width: 22px; height: 22px; margin-left: -6px; border: 2px solid var(--bg); }
    .card-assignees .avatar:first-child { margin-left: 0; }

    /* Modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal {
      background: var(--bg-secondary);
      border-radius: 8px;
      width: 100%;
      max-width: 600px;
      max-height: 90vh;
      overflow-y: auto;
      margin: 1rem;
    }
    .modal-header {
      padding: 1rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .modal-header h3 { font-size: 1rem; }
    .modal-close {
      background: none;
      border: none;
      font-size: 1.25rem;
      color: var(--text-secondary);
      padding: 0.25rem;
    }
    .modal-body { padding: 1rem; }
    .modal-actions {
      padding: 1rem;
      border-top: 1px solid var(--border);
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
    }

    /* Card detail */
    .card-detail-section { margin-bottom: 1.5rem; }
    .card-detail-section h4 { font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 0.5rem; }
    .card-description { min-height: 80px; }
    .label-list { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .label-badge {
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      color: #fff;
    }
    .member-list { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .member-badge {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.5rem;
      background: var(--bg);
      border-radius: 4px;
      font-size: 0.875rem;
    }
    .github-link {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem;
      background: var(--bg);
      border-radius: 4px;
      margin-bottom: 0.5rem;
      font-size: 0.875rem;
    }
    .github-link-type {
      font-size: 0.75rem;
      padding: 0.125rem 0.375rem;
      background: var(--border);
      border-radius: 3px;
    }

    /* Settings */
    .settings-section { margin-bottom: 2rem; }
    .settings-section h3 { font-size: 1rem; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
    .member-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--border);
    }
    .member-info { display: flex; align-items: center; gap: 0.5rem; }
    .member-role { font-size: 0.75rem; color: var(--text-secondary); }

    /* Online indicator */
    .online-users { display: flex; align-items: center; gap: 0.25rem; font-size: 0.75rem; color: var(--text-secondary); }
    .online-dot { width: 6px; height: 6px; background: var(--success); border-radius: 50%; }
  </style>
</head>
<body>
  <div id="app">
    <div class="loading">Loading...</div>
  </div>
  <script>
    // Minimal SPA framework
    const state = {
      user: null,
      boards: [],
      currentBoard: null,
      currentCard: null,
      ws: null,
      wsReconnectTimeout: null,
      onlineUsers: 0
    };

    // API helper
    async function api(path, options = {}) {
      const res = await fetch('/api' + path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        credentials: 'include'
      });
      return res.json();
    }

    // Router
    function navigate(path) {
      history.pushState(null, '', path);
      render();
    }

    window.addEventListener('popstate', render);

    // Render
    function render() {
      const path = location.pathname;
      const app = document.getElementById('app');

      if (!state.user) {
        if (path === '/register') {
          app.innerHTML = renderRegister();
        } else {
          app.innerHTML = renderLogin();
        }
      } else if (path.startsWith('/board/')) {
        const boardId = path.split('/')[2];
        loadBoard(boardId).then(() => {
          app.innerHTML = renderBoard();
          setupBoardDragDrop();
          connectWebSocket(boardId);
        });
      } else if (path === '/settings') {
        app.innerHTML = renderSettings();
      } else {
        loadBoards().then(() => {
          app.innerHTML = renderBoards();
        });
      }
    }

    // Auth views
    function renderLogin() {
      return \`
        <div class="auth-container">
          <h2>Sign In</h2>
          <form onsubmit="handleLogin(event)">
            <div class="form-group">
              <label>Username</label>
              <input type="text" name="username" required autocomplete="username">
            </div>
            <div class="form-group">
              <label>Password</label>
              <input type="password" name="password" required autocomplete="current-password">
            </div>
            <div id="login-error" class="form-error" style="display:none"></div>
            <div class="form-actions">
              <button type="submit" class="primary">Sign In</button>
            </div>
          </form>
          <div class="auth-switch">
            Don't have an account? <a href="/register" onclick="navigate('/register');return false;">Sign Up</a>
          </div>
        </div>
      \`;
    }

    function renderRegister() {
      return \`
        <div class="auth-container">
          <h2>Create Account</h2>
          <form onsubmit="handleRegister(event)">
            <div class="form-group">
              <label>Invite Key</label>
              <input type="text" name="inviteKey" required placeholder="Enter your invite key">
            </div>
            <div class="form-group">
              <label>Username</label>
              <input type="text" name="username" required autocomplete="username">
            </div>
            <div class="form-group">
              <label>Display Name</label>
              <input type="text" name="displayName" placeholder="Optional">
            </div>
            <div class="form-group">
              <label>Password</label>
              <input type="password" name="password" required autocomplete="new-password">
            </div>
            <div id="register-error" class="form-error" style="display:none"></div>
            <div class="form-actions">
              <button type="submit" class="primary">Create Account</button>
            </div>
          </form>
          <div class="auth-switch">
            Already have an account? <a href="/login" onclick="navigate('/login');return false;">Sign In</a>
          </div>
        </div>
      \`;
    }

    async function handleLogin(e) {
      e.preventDefault();
      const form = e.target;
      const errEl = document.getElementById('login-error');
      errEl.style.display = 'none';

      const res = await api('/auth/login', {
        method: 'POST',
        body: {
          username: form.username.value,
          password: form.password.value
        }
      });

      if (res.success) {
        state.user = res.data.user;
        navigate('/');
      } else {
        errEl.textContent = res.error;
        errEl.style.display = 'block';
      }
    }

    async function handleRegister(e) {
      e.preventDefault();
      const form = e.target;
      const errEl = document.getElementById('register-error');
      errEl.style.display = 'none';

      const res = await api('/auth/register', {
        method: 'POST',
        body: {
          inviteKey: form.inviteKey.value,
          username: form.username.value,
          displayName: form.displayName.value || undefined,
          password: form.password.value
        }
      });

      if (res.success) {
        state.user = res.data.user;
        navigate('/');
      } else {
        errEl.textContent = res.error;
        errEl.style.display = 'block';
      }
    }

    async function handleLogout() {
      await api('/auth/logout', { method: 'POST' });
      state.user = null;
      if (state.ws) state.ws.close();
      navigate('/');
    }

    // Board list
    async function loadBoards() {
      const res = await api('/boards');
      if (res.success) {
        state.boards = res.data.boards;
      }
    }

    function renderBoards() {
      return \`
        <div class="header">
          <h1>Kanban</h1>
          <div class="header-actions">
            <a href="/settings" onclick="navigate('/settings');return false;">Settings</a>
            <div class="avatar" onclick="handleLogout()" title="Sign out">
              \${state.user.avatar_url ? '<img src="'+state.user.avatar_url+'">' : state.user.display_name.charAt(0).toUpperCase()}
            </div>
          </div>
        </div>
        <div class="boards-container">
          <div class="boards-header">
            <h2>Your Boards</h2>
            <button onclick="showCreateBoard()">New Board</button>
          </div>
          <div class="board-grid">
            \${state.boards.map(b => \`
              <div class="board-card" onclick="navigate('/board/\${b.id}')">
                <h3>\${escapeHtml(b.name)}</h3>
                <p>\${b.description ? escapeHtml(b.description) : 'No description'}</p>
              </div>
            \`).join('')}
            \${state.boards.length === 0 ? '<p style="color:var(--text-secondary)">No boards yet. Create one to get started.</p>' : ''}
          </div>
        </div>
        <div id="modal-container"></div>
      \`;
    }

    function showCreateBoard() {
      document.getElementById('modal-container').innerHTML = \`
        <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
          <div class="modal">
            <div class="modal-header">
              <h3>Create Board</h3>
              <button class="modal-close" onclick="closeModal()">&times;</button>
            </div>
            <form onsubmit="handleCreateBoard(event)">
              <div class="modal-body">
                <div class="form-group">
                  <label>Board Name</label>
                  <input type="text" name="name" required autofocus>
                </div>
                <div class="form-group">
                  <label>Description (optional)</label>
                  <textarea name="description" rows="3"></textarea>
                </div>
              </div>
              <div class="modal-actions">
                <button type="button" onclick="closeModal()">Cancel</button>
                <button type="submit" class="primary">Create</button>
              </div>
            </form>
          </div>
        </div>
      \`;
    }

    async function handleCreateBoard(e) {
      e.preventDefault();
      const form = e.target;
      const res = await api('/boards', {
        method: 'POST',
        body: {
          name: form.name.value,
          description: form.description.value || undefined
        }
      });
      if (res.success) {
        closeModal();
        navigate('/board/' + res.data.board.id);
      }
    }

    function closeModal() {
      const container = document.getElementById('modal-container');
      if (container) container.innerHTML = '';
      state.currentCard = null;
    }

    // Board view
    async function loadBoard(boardId) {
      const res = await api('/boards/' + boardId);
      if (res.success) {
        state.currentBoard = {
          ...res.data.board,
          lists: res.data.lists,
          cards: res.data.cards,
          labels: res.data.labels,
          members: res.data.members,
          cardLabels: res.data.cardLabels,
          cardAssignees: res.data.cardAssignees,
          githubLinks: res.data.githubLinks,
          userRole: res.data.userRole
        };
      } else {
        navigate('/');
      }
    }

    function renderBoard() {
      const b = state.currentBoard;
      if (!b) return '<div class="loading">Loading...</div>';

      return \`
        <div class="header">
          <h1><a href="/" onclick="navigate('/');return false;">Kanban</a></h1>
          <div class="header-actions">
            <div class="online-users"><span class="online-dot"></span> \${state.onlineUsers} online</div>
            <button onclick="showBoardSettings()">Settings</button>
            <div class="avatar" onclick="handleLogout()" title="Sign out">
              \${state.user.avatar_url ? '<img src="'+state.user.avatar_url+'">' : state.user.display_name.charAt(0).toUpperCase()}
            </div>
          </div>
        </div>
        <div class="board-container">
          <div class="board-header">
            <span class="board-title">\${escapeHtml(b.name)}</span>
          </div>
          <div class="board-content" id="board-content">
            \${b.lists.sort((a,c)=>a.position-c.position).map(list => renderList(list)).join('')}
            <div class="add-list">
              <button onclick="showAddList()">+ Add List</button>
            </div>
          </div>
        </div>
        <div id="modal-container"></div>
      \`;
    }

    function renderList(list) {
      const cards = state.currentBoard.cards.filter(c => c.list_id === list.id).sort((a,b) => a.position - b.position);
      return \`
        <div class="list" data-list-id="\${list.id}">
          <div class="list-header" draggable="true" data-list-id="\${list.id}">
            <span>\${escapeHtml(list.name)}</span>
            <button class="modal-close" onclick="deleteList('\${list.id}')" title="Delete list">&times;</button>
          </div>
          <div class="list-cards" data-list-id="\${list.id}">
            \${cards.map(card => renderCard(card)).join('')}
          </div>
          <button class="add-card-btn" onclick="showAddCard('\${list.id}')">+ Add Card</button>
        </div>
      \`;
    }

    function renderCard(card) {
      const cardLabels = state.currentBoard.cardLabels.filter(cl => cl.card_id === card.id);
      const cardAssignees = state.currentBoard.cardAssignees.filter(ca => ca.card_id === card.id);
      const labels = cardLabels.map(cl => state.currentBoard.labels.find(l => l.id === cl.label_id)).filter(Boolean);
      const assignees = cardAssignees.map(ca => state.currentBoard.members.find(m => m.user_id === ca.user_id)).filter(Boolean);
      const githubLinks = state.currentBoard.githubLinks.filter(gl => gl.card_id === card.id);

      return \`
        <div class="card" draggable="true" data-card-id="\${card.id}" onclick="showCardDetail('\${card.id}')">
          \${labels.length ? '<div class="card-labels">' + labels.map(l => '<div class="card-label" style="background:\${l.color}"></div>').join('') + '</div>' : ''}
          <div class="card-title">\${escapeHtml(card.title)}</div>
          \${githubLinks.length || assignees.length ? \`
            <div class="card-meta">
              \${githubLinks.length ? '<span style="font-size:0.75rem;color:var(--text-secondary)">🔗 \${githubLinks.length}</span>' : ''}
              \${assignees.length ? '<div class="card-assignees">' + assignees.slice(0,3).map(a => \`
                <div class="avatar" title="\${escapeHtml(a.display_name || a.username)}">
                  \${a.avatar_url ? '<img src="'+a.avatar_url+'">' : (a.display_name || a.username).charAt(0).toUpperCase()}
                </div>
              \`).join('') + '</div>' : ''}
            </div>
          \` : ''}
        </div>
      \`;
    }

    function showAddList() {
      document.getElementById('modal-container').innerHTML = \`
        <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
          <div class="modal" style="max-width:400px">
            <div class="modal-header">
              <h3>Add List</h3>
              <button class="modal-close" onclick="closeModal()">&times;</button>
            </div>
            <form onsubmit="handleAddList(event)">
              <div class="modal-body">
                <div class="form-group">
                  <label>List Name</label>
                  <input type="text" name="name" required autofocus>
                </div>
              </div>
              <div class="modal-actions">
                <button type="button" onclick="closeModal()">Cancel</button>
                <button type="submit" class="primary">Add</button>
              </div>
            </form>
          </div>
        </div>
      \`;
    }

    async function handleAddList(e) {
      e.preventDefault();
      const form = e.target;
      const res = await api('/lists', {
        method: 'POST',
        body: {
          boardId: state.currentBoard.id,
          name: form.name.value
        }
      });
      if (res.success) {
        state.currentBoard.lists.push(res.data.list);
        closeModal();
        document.getElementById('app').innerHTML = renderBoard();
        setupBoardDragDrop();
        broadcastUpdate({ type: 'list_created', payload: res.data.list });
      }
    }

    async function deleteList(listId) {
      if (!confirm('Delete this list and all its cards?')) return;
      const res = await api('/lists/' + listId, { method: 'DELETE' });
      if (res.success) {
        state.currentBoard.lists = state.currentBoard.lists.filter(l => l.id !== listId);
        state.currentBoard.cards = state.currentBoard.cards.filter(c => c.list_id !== listId);
        document.getElementById('app').innerHTML = renderBoard();
        setupBoardDragDrop();
        broadcastUpdate({ type: 'list_deleted', payload: { id: listId } });
      }
    }

    function showAddCard(listId) {
      document.getElementById('modal-container').innerHTML = \`
        <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
          <div class="modal" style="max-width:400px">
            <div class="modal-header">
              <h3>Add Card</h3>
              <button class="modal-close" onclick="closeModal()">&times;</button>
            </div>
            <form onsubmit="handleAddCard(event, '\${listId}')">
              <div class="modal-body">
                <div class="form-group">
                  <label>Card Title</label>
                  <input type="text" name="title" required autofocus>
                </div>
              </div>
              <div class="modal-actions">
                <button type="button" onclick="closeModal()">Cancel</button>
                <button type="submit" class="primary">Add</button>
              </div>
            </form>
          </div>
        </div>
      \`;
    }

    async function handleAddCard(e, listId) {
      e.preventDefault();
      const form = e.target;
      const res = await api('/cards', {
        method: 'POST',
        body: {
          listId: listId,
          title: form.title.value
        }
      });
      if (res.success) {
        state.currentBoard.cards.push(res.data.card);
        closeModal();
        document.getElementById('app').innerHTML = renderBoard();
        setupBoardDragDrop();
        broadcastUpdate({ type: 'card_created', payload: res.data.card });
      }
    }

    function showCardDetail(cardId) {
      state.currentCard = state.currentBoard.cards.find(c => c.id === cardId);
      if (!state.currentCard) return;

      const card = state.currentCard;
      const cardLabels = state.currentBoard.cardLabels.filter(cl => cl.card_id === card.id);
      const cardAssignees = state.currentBoard.cardAssignees.filter(ca => ca.card_id === card.id);
      const labels = cardLabels.map(cl => state.currentBoard.labels.find(l => l.id === cl.label_id)).filter(Boolean);
      const assignees = cardAssignees.map(ca => state.currentBoard.members.find(m => m.user_id === ca.user_id)).filter(Boolean);
      const githubLinks = state.currentBoard.githubLinks.filter(gl => gl.card_id === card.id);

      document.getElementById('modal-container').innerHTML = \`
        <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
          <div class="modal">
            <div class="modal-header">
              <h3>\${escapeHtml(card.title)}</h3>
              <button class="modal-close" onclick="closeModal()">&times;</button>
            </div>
            <div class="modal-body">
              <div class="card-detail-section">
                <h4>Description</h4>
                <textarea class="card-description" id="card-desc" placeholder="Add a description...">\${card.description || ''}</textarea>
              </div>
              <div class="card-detail-section">
                <h4>Labels</h4>
                <div class="label-list">
                  \${labels.map(l => '<span class="label-badge" style="background:'+l.color+'">'+escapeHtml(l.name)+'</span>').join('')}
                  <button onclick="showLabelPicker('\${card.id}')" style="font-size:0.75rem">+ Add</button>
                </div>
              </div>
              <div class="card-detail-section">
                <h4>Assignees</h4>
                <div class="member-list">
                  \${assignees.map(a => '<span class="member-badge"><span class="avatar" style="width:18px;height:18px">'+(a.display_name||a.username).charAt(0).toUpperCase()+'</span>'+escapeHtml(a.display_name||a.username)+'</span>').join('')}
                  <button onclick="showAssigneePicker('\${card.id}')" style="font-size:0.75rem">+ Add</button>
                </div>
              </div>
              <div class="card-detail-section">
                <h4>GitHub Links</h4>
                \${githubLinks.map(gl => \`
                  <div class="github-link">
                    <span class="github-link-type">\${gl.link_type.toUpperCase()}</span>
                    <a href="\${gl.url}" target="_blank">\${gl.repo_owner}/\${gl.repo_name}#\${gl.number}</a>
                    <button class="modal-close" onclick="removeGithubLink('\${card.id}', '\${gl.id}')">&times;</button>
                  </div>
                \`).join('')}
                <form onsubmit="addGithubLink(event, '\${card.id}')" style="display:flex;gap:0.5rem">
                  <input type="url" name="url" placeholder="GitHub issue or PR URL" style="flex:1">
                  <button type="submit">Add</button>
                </form>
              </div>
            </div>
            <div class="modal-actions">
              <button class="danger" onclick="deleteCard('\${card.id}')">Delete Card</button>
              <button onclick="closeModal()">Cancel</button>
              <button class="primary" onclick="saveCardDetail('\${card.id}')">Save</button>
            </div>
          </div>
        </div>
      \`;
    }

    async function saveCardDetail(cardId) {
      const desc = document.getElementById('card-desc').value;
      const res = await api('/cards/' + cardId, {
        method: 'PATCH',
        body: { description: desc }
      });
      if (res.success) {
        const card = state.currentBoard.cards.find(c => c.id === cardId);
        if (card) card.description = desc;
        closeModal();
        broadcastUpdate({ type: 'card_updated', payload: { id: cardId, description: desc } });
      }
    }

    async function deleteCard(cardId) {
      if (!confirm('Delete this card?')) return;
      const res = await api('/cards/' + cardId, { method: 'DELETE' });
      if (res.success) {
        state.currentBoard.cards = state.currentBoard.cards.filter(c => c.id !== cardId);
        state.currentBoard.cardLabels = state.currentBoard.cardLabels.filter(cl => cl.card_id !== cardId);
        state.currentBoard.cardAssignees = state.currentBoard.cardAssignees.filter(ca => ca.card_id !== cardId);
        state.currentBoard.githubLinks = state.currentBoard.githubLinks.filter(gl => gl.card_id !== cardId);
        closeModal();
        document.getElementById('app').innerHTML = renderBoard();
        setupBoardDragDrop();
        broadcastUpdate({ type: 'card_deleted', payload: { id: cardId } });
      }
    }

    function showLabelPicker(cardId) {
      const cardLabels = state.currentBoard.cardLabels.filter(cl => cl.card_id === cardId);
      const html = \`
        <div style="position:absolute;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;padding:0.5rem;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
          \${state.currentBoard.labels.map(l => {
            const hasLabel = cardLabels.some(cl => cl.label_id === l.id);
            return '<div style="display:flex;align-items:center;gap:0.5rem;padding:0.25rem;cursor:pointer" onclick="toggleLabel(\\''+cardId+'\\', \\''+l.id+'\\', '+!hasLabel+')"><span style="width:12px;height:12px;border-radius:2px;background:'+l.color+'"></span>'+escapeHtml(l.name)+(hasLabel?' ✓':'')+'</div>';
          }).join('')}
          <button onclick="showCreateLabel('\${cardId}')" style="width:100%;margin-top:0.5rem;font-size:0.75rem">+ New Label</button>
        </div>
      \`;
      event.target.insertAdjacentHTML('afterend', html);
    }

    async function toggleLabel(cardId, labelId, add) {
      if (add) {
        await api('/cards/' + cardId + '/labels', { method: 'POST', body: { labelId } });
        state.currentBoard.cardLabels.push({ card_id: cardId, label_id: labelId });
      } else {
        await api('/cards/' + cardId + '/labels/' + labelId, { method: 'DELETE' });
        state.currentBoard.cardLabels = state.currentBoard.cardLabels.filter(cl => !(cl.card_id === cardId && cl.label_id === labelId));
      }
      showCardDetail(cardId);
      broadcastUpdate({ type: 'card_label_changed', payload: { cardId, labelId, add } });
    }

    function showAssigneePicker(cardId) {
      const cardAssignees = state.currentBoard.cardAssignees.filter(ca => ca.card_id === cardId);
      const html = \`
        <div style="position:absolute;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;padding:0.5rem;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
          \${state.currentBoard.members.map(m => {
            const isAssigned = cardAssignees.some(ca => ca.user_id === m.user_id);
            return '<div style="display:flex;align-items:center;gap:0.5rem;padding:0.25rem;cursor:pointer" onclick="toggleAssignee(\\''+cardId+'\\', \\''+m.user_id+'\\', '+!isAssigned+')"><span class="avatar" style="width:18px;height:18px">'+(m.display_name||m.username).charAt(0).toUpperCase()+'</span>'+escapeHtml(m.display_name||m.username)+(isAssigned?' ✓':'')+'</div>';
          }).join('')}
        </div>
      \`;
      event.target.insertAdjacentHTML('afterend', html);
    }

    async function toggleAssignee(cardId, userId, add) {
      if (add) {
        await api('/cards/' + cardId + '/assignees', { method: 'POST', body: { userId } });
        state.currentBoard.cardAssignees.push({ card_id: cardId, user_id: userId });
      } else {
        await api('/cards/' + cardId + '/assignees/' + userId, { method: 'DELETE' });
        state.currentBoard.cardAssignees = state.currentBoard.cardAssignees.filter(ca => !(ca.card_id === cardId && ca.user_id === userId));
      }
      showCardDetail(cardId);
      broadcastUpdate({ type: 'card_assignee_changed', payload: { cardId, userId, add } });
    }

    async function addGithubLink(e, cardId) {
      e.preventDefault();
      const url = e.target.url.value;
      const res = await api('/cards/' + cardId + '/github', { method: 'POST', body: { url } });
      if (res.success) {
        await loadBoard(state.currentBoard.id);
        showCardDetail(cardId);
      }
    }

    async function removeGithubLink(cardId, linkId) {
      await api('/cards/' + cardId + '/github/' + linkId, { method: 'DELETE' });
      state.currentBoard.githubLinks = state.currentBoard.githubLinks.filter(gl => gl.id !== linkId);
      showCardDetail(cardId);
    }

    // Drag and drop
    function setupBoardDragDrop() {
      let draggedCard = null;
      let draggedList = null;

      document.querySelectorAll('.card[draggable]').forEach(card => {
        card.addEventListener('dragstart', (e) => {
          e.stopPropagation();
          draggedCard = card;
          card.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('dragging');
          draggedCard = null;
        });
      });

      document.querySelectorAll('.list-cards').forEach(list => {
        list.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (!draggedCard) return;
          const afterElement = getDragAfterElement(list, e.clientY);
          if (afterElement) {
            list.insertBefore(draggedCard, afterElement);
          } else {
            list.appendChild(draggedCard);
          }
        });
        list.addEventListener('drop', async (e) => {
          e.preventDefault();
          if (!draggedCard) return;
          const cardId = draggedCard.dataset.cardId;
          const newListId = list.dataset.listId;
          const cards = [...list.querySelectorAll('.card')];
          const newPosition = cards.indexOf(draggedCard);

          await api('/cards/' + cardId + '/move', {
            method: 'POST',
            body: { listId: newListId, position: newPosition }
          });

          const card = state.currentBoard.cards.find(c => c.id === cardId);
          if (card) {
            card.list_id = newListId;
            card.position = newPosition;
          }
          broadcastUpdate({ type: 'card_moved', payload: { cardId, listId: newListId, position: newPosition } });
        });
      });

      document.querySelectorAll('.list-header[draggable]').forEach(header => {
        header.addEventListener('dragstart', (e) => {
          draggedList = header.closest('.list');
          header.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
        });
        header.addEventListener('dragend', () => {
          header.classList.remove('dragging');
          draggedList = null;
        });
      });

      const boardContent = document.getElementById('board-content');
      if (boardContent) {
        boardContent.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (!draggedList) return;
          const afterElement = getListDragAfterElement(boardContent, e.clientX);
          if (afterElement) {
            boardContent.insertBefore(draggedList, afterElement);
          } else {
            boardContent.insertBefore(draggedList, document.querySelector('.add-list'));
          }
        });
        boardContent.addEventListener('drop', async (e) => {
          if (!draggedList) return;
          const lists = [...boardContent.querySelectorAll('.list')];
          const listIds = lists.map(l => l.dataset.listId);
          await api('/lists/reorder', {
            method: 'POST',
            body: { boardId: state.currentBoard.id, listIds }
          });
          broadcastUpdate({ type: 'lists_reordered', payload: { listIds } });
        });
      }
    }

    function getDragAfterElement(container, y) {
      const cards = [...container.querySelectorAll('.card:not(.dragging)')];
      return cards.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset, element: child };
        }
        return closest;
      }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    function getListDragAfterElement(container, x) {
      const lists = [...container.querySelectorAll('.list:not(:has(.dragging))')].filter(l => !l.querySelector('.list-header.dragging'));
      return lists.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = x - box.left - box.width / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset, element: child };
        }
        return closest;
      }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    // WebSocket
    function connectWebSocket(boardId) {
      if (state.ws) state.ws.close();
      clearTimeout(state.wsReconnectTimeout);

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(protocol + '//' + location.host + '/api/ws/' + boardId + '?token=' + encodeURIComponent(document.cookie.match(/session=([^;]+)/)?.[1] || ''));

      ws.onopen = () => {
        console.log('WebSocket connected');
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          handleWSMessage(msg);
        } catch {}
      };

      ws.onclose = () => {
        state.wsReconnectTimeout = setTimeout(() => {
          if (location.pathname.startsWith('/board/')) {
            connectWebSocket(boardId);
          }
        }, 3000);
      };

      state.ws = ws;
    }

    function handleWSMessage(msg) {
      switch (msg.type) {
        case 'user_joined':
        case 'user_left':
          state.onlineUsers = msg.payload.onlineCount || 0;
          const onlineEl = document.querySelector('.online-users');
          if (onlineEl) onlineEl.innerHTML = '<span class="online-dot"></span> ' + state.onlineUsers + ' online';
          break;
        case 'card_created':
        case 'card_updated':
        case 'card_deleted':
        case 'card_moved':
        case 'list_created':
        case 'list_deleted':
        case 'lists_reordered':
        case 'card_label_changed':
        case 'card_assignee_changed':
          // Reload board to sync changes
          if (state.currentBoard) {
            loadBoard(state.currentBoard.id).then(() => {
              document.getElementById('app').innerHTML = renderBoard();
              setupBoardDragDrop();
            });
          }
          break;
      }
    }

    function broadcastUpdate(msg) {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(msg));
      }
    }

    // Board settings
    function showBoardSettings() {
      const b = state.currentBoard;
      const isOwner = b.userRole === 'owner';
      const isAdmin = ['owner', 'admin'].includes(b.userRole);

      document.getElementById('modal-container').innerHTML = \`
        <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
          <div class="modal">
            <div class="modal-header">
              <h3>Board Settings</h3>
              <button class="modal-close" onclick="closeModal()">&times;</button>
            </div>
            <div class="modal-body">
              <div class="settings-section">
                <h3>Board Info</h3>
                <form onsubmit="updateBoard(event)">
                  <div class="form-group">
                    <label>Name</label>
                    <input type="text" name="name" value="\${escapeHtml(b.name)}" \${!isAdmin?'disabled':''}>
                  </div>
                  <div class="form-group">
                    <label>Description</label>
                    <textarea name="description" rows="2" \${!isAdmin?'disabled':''}>\${b.description||''}</textarea>
                  </div>
                  \${isAdmin ? '<button type="submit" class="primary">Save</button>' : ''}
                </form>
              </div>
              <div class="settings-section">
                <h3>Members</h3>
                \${b.members.map(m => \`
                  <div class="member-row">
                    <div class="member-info">
                      <div class="avatar">\${(m.display_name||m.username).charAt(0).toUpperCase()}</div>
                      <span>\${escapeHtml(m.display_name||m.username)}</span>
                      <span class="member-role">\${m.role}</span>
                    </div>
                    \${isAdmin && m.role !== 'owner' ? '<button class="danger" onclick="removeMember(\\''+m.user_id+'\\')">Remove</button>' : ''}
                  </div>
                \`).join('')}
                \${isAdmin ? \`
                  <form onsubmit="addMember(event)" style="margin-top:1rem;display:flex;gap:0.5rem">
                    <input type="text" name="username" placeholder="Username" style="flex:1">
                    <button type="submit">Add</button>
                  </form>
                \` : ''}
              </div>
              <div class="settings-section">
                <h3>Labels</h3>
                <div class="label-list" style="margin-bottom:1rem">
                  \${b.labels.map(l => \`
                    <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem">
                      <span class="label-badge" style="background:\${l.color}">\${escapeHtml(l.name)}</span>
                      <button class="modal-close" onclick="deleteLabel('\${l.id}')">&times;</button>
                    </div>
                  \`).join('')}
                </div>
                <form onsubmit="createLabel(event)" style="display:flex;gap:0.5rem">
                  <input type="text" name="name" placeholder="Label name" style="flex:1">
                  <input type="color" name="color" value="#666666" style="width:40px;padding:0">
                  <button type="submit">Add</button>
                </form>
              </div>
              \${isOwner ? \`
                <div class="settings-section">
                  <h3>Danger Zone</h3>
                  <button class="danger" onclick="deleteBoard()">Delete Board</button>
                </div>
              \` : ''}
            </div>
          </div>
        </div>
      \`;
    }

    async function updateBoard(e) {
      e.preventDefault();
      const form = e.target;
      await api('/boards/' + state.currentBoard.id, {
        method: 'PATCH',
        body: { name: form.name.value, description: form.description.value }
      });
      state.currentBoard.name = form.name.value;
      state.currentBoard.description = form.description.value;
      document.getElementById('app').innerHTML = renderBoard();
      setupBoardDragDrop();
    }

    async function addMember(e) {
      e.preventDefault();
      const form = e.target;
      const res = await api('/boards/' + state.currentBoard.id + '/members', {
        method: 'POST',
        body: { username: form.username.value }
      });
      if (res.success) {
        await loadBoard(state.currentBoard.id);
        showBoardSettings();
      } else {
        alert(res.error);
      }
    }

    async function removeMember(userId) {
      if (!confirm('Remove this member?')) return;
      await api('/boards/' + state.currentBoard.id + '/members/' + userId, { method: 'DELETE' });
      await loadBoard(state.currentBoard.id);
      showBoardSettings();
    }

    async function createLabel(e) {
      e.preventDefault();
      const form = e.target;
      const res = await api('/labels', {
        method: 'POST',
        body: { boardId: state.currentBoard.id, name: form.name.value, color: form.color.value }
      });
      if (res.success) {
        state.currentBoard.labels.push(res.data.label);
        showBoardSettings();
      }
    }

    async function deleteLabel(labelId) {
      await api('/labels/' + labelId, { method: 'DELETE' });
      state.currentBoard.labels = state.currentBoard.labels.filter(l => l.id !== labelId);
      state.currentBoard.cardLabels = state.currentBoard.cardLabels.filter(cl => cl.label_id !== labelId);
      showBoardSettings();
    }

    async function deleteBoard() {
      if (!confirm('Delete this board? This cannot be undone.')) return;
      await api('/boards/' + state.currentBoard.id, { method: 'DELETE' });
      navigate('/');
    }

    // Settings page
    function renderSettings() {
      return \`
        <div class="header">
          <h1><a href="/" onclick="navigate('/');return false;">Kanban</a></h1>
          <div class="header-actions">
            <div class="avatar" onclick="handleLogout()" title="Sign out">
              \${state.user.avatar_url ? '<img src="'+state.user.avatar_url+'">' : state.user.display_name.charAt(0).toUpperCase()}
            </div>
          </div>
        </div>
        <div class="boards-container">
          <h2 style="margin-bottom:1.5rem">Account Settings</h2>
          <div class="settings-section">
            <h3>Profile</h3>
            <form onsubmit="updateProfile(event)">
              <div class="form-group">
                <label>Display Name</label>
                <input type="text" name="displayName" value="\${escapeHtml(state.user.display_name)}">
              </div>
              <button type="submit" class="primary">Save</button>
            </form>
          </div>
          <div class="settings-section">
            <h3>Avatar</h3>
            <form onsubmit="uploadAvatar(event)" enctype="multipart/form-data">
              <div class="form-group">
                <input type="file" name="file" accept="image/png,image/jpeg,image/webp">
              </div>
              <button type="submit">Upload</button>
              \${state.user.avatar_url ? '<button type="button" class="danger" onclick="deleteAvatar()">Remove</button>' : ''}
            </form>
          </div>
          <div class="settings-section">
            <h3>Change Password</h3>
            <form onsubmit="changePassword(event)">
              <div class="form-group">
                <label>Current Password</label>
                <input type="password" name="currentPassword" autocomplete="current-password">
              </div>
              <div class="form-group">
                <label>New Password</label>
                <input type="password" name="newPassword" autocomplete="new-password">
              </div>
              <button type="submit" class="primary">Change Password</button>
            </form>
          </div>
        </div>
      \`;
    }

    async function updateProfile(e) {
      e.preventDefault();
      const form = e.target;
      const res = await api('/auth/profile', {
        method: 'PATCH',
        body: { displayName: form.displayName.value }
      });
      if (res.success) {
        state.user.display_name = form.displayName.value;
        render();
      }
    }

    async function uploadAvatar(e) {
      e.preventDefault();
      const form = e.target;
      const file = form.file.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/upload/avatar', {
        method: 'POST',
        body: formData,
        credentials: 'include'
      }).then(r => r.json());

      if (res.success) {
        state.user.avatar_url = res.data.avatarUrl;
        render();
      } else {
        alert(res.error);
      }
    }

    async function deleteAvatar() {
      const res = await api('/upload/avatar', { method: 'DELETE' });
      if (res.success) {
        state.user.avatar_url = null;
        render();
      }
    }

    async function changePassword(e) {
      e.preventDefault();
      const form = e.target;
      const res = await api('/auth/change-password', {
        method: 'POST',
        body: {
          currentPassword: form.currentPassword.value,
          newPassword: form.newPassword.value
        }
      });
      if (res.success) {
        alert('Password changed successfully');
        form.reset();
      } else {
        alert(res.error);
      }
    }

    // Utilities
    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // Init
    async function init() {
      const res = await api('/auth/me');
      if (res.success) {
        state.user = res.data.user;
      }
      render();
    }

    init();
  </script>
</body>
</html>`;
}

export default app;
