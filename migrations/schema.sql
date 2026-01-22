-- Kanban Database Schema
-- Security-first design with proper constraints

-- Invite keys for org-only signup
CREATE TABLE IF NOT EXISTS invite_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    used_at INTEGER,
    used_by TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
);

-- Users table with secure password storage
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Sessions for authentication
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    ip_address TEXT,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Boards
CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_boards_owner ON boards(owner_id);

-- Board members (access control)
CREATE TABLE IF NOT EXISTS board_members (
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    added_at INTEGER NOT NULL DEFAULT (unixepoch()),
    added_by TEXT REFERENCES users(id),
    PRIMARY KEY (board_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_board_members_user ON board_members(user_id);

-- Lists within boards
CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_lists_board ON lists(board_id);
CREATE INDEX IF NOT EXISTS idx_lists_position ON lists(board_id, position);

-- Cards within lists
CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    position INTEGER NOT NULL,
    due_date INTEGER,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_cards_list ON cards(list_id);
CREATE INDEX IF NOT EXISTS idx_cards_position ON cards(list_id, position);

-- Labels (per board)
CREATE TABLE IF NOT EXISTS labels (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_labels_board ON labels(board_id);

-- Card-Label assignments (many-to-many)
CREATE TABLE IF NOT EXISTS card_labels (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    assigned_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (card_id, label_id)
);

-- Card-User assignments (many-to-many)
CREATE TABLE IF NOT EXISTS card_assignees (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_at INTEGER NOT NULL DEFAULT (unixepoch()),
    assigned_by TEXT REFERENCES users(id),
    PRIMARY KEY (card_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_card_assignees_user ON card_assignees(user_id);

-- GitHub links for cards
CREATE TABLE IF NOT EXISTS card_github_links (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    link_type TEXT NOT NULL CHECK (link_type IN ('issue', 'pr')),
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT,
    state TEXT,
    url TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(card_id, repo_owner, repo_name, number)
);

CREATE INDEX IF NOT EXISTS idx_github_links_card ON card_github_links(card_id);

-- Activity log for audit trail
CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    details TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_activity_board ON activity_log(board_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
