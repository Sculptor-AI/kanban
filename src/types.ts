// TypeScript type definitions

export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  BOARD_ROOM: DurableObjectNamespace;
  JWT_SECRET: string;
  INVITE_KEY_SALT: string;
  ENVIRONMENT: string;
}

export interface User {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface Session {
  id: string;
  user_id: string;
  expires_at: number;
}

export interface Board {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: number;
  updated_at: number;
}

export interface BoardMember {
  board_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  added_at: number;
}

export interface List {
  id: string;
  board_id: string;
  name: string;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface Card {
  id: string;
  list_id: string;
  title: string;
  description: string | null;
  position: number;
  due_date: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface Label {
  id: string;
  board_id: string;
  name: string;
  color: string;
  created_at: number;
}

export interface CardAssignee {
  card_id: string;
  user_id: string;
  assigned_at: number;
}

export interface CardLabel {
  card_id: string;
  label_id: string;
  assigned_at: number;
}

export interface GitHubLink {
  id: string;
  card_id: string;
  link_type: 'issue' | 'pr';
  repo_owner: string;
  repo_name: string;
  number: number;
  title: string | null;
  state: string | null;
  url: string;
  created_at: number;
  updated_at: number;
}

export interface ActivityLog {
  id: string;
  board_id: string;
  user_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: string | null;
  created_at: number;
}

// API Response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// WebSocket message types
export interface WSMessage {
  type: string;
  payload: unknown;
}

export interface BoardState {
  lists: (List & { cards: CardWithDetails[] })[];
  labels: Label[];
  members: (BoardMember & { user: User })[];
}

export interface CardWithDetails extends Card {
  labels: Label[];
  assignees: User[];
  github_links: GitHubLink[];
}

// Context type for Hono middleware
export interface AppContext {
  Bindings: Env;
  Variables: {
    user?: User;
    session?: Session;
  };
}
