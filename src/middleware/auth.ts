// Authentication middleware

import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { hashToken } from '../utils/crypto';
import type { AppContext, User, Session } from '../types';

// Authenticate user from session cookie
export async function authMiddleware(c: Context<AppContext>, next: Next) {
  const token = getCookie(c, 'session');

  if (!token) {
    c.set('user', undefined);
    c.set('session', undefined);
    return next();
  }

  try {
    const tokenHash = await hashToken(token);

    // Get session and user
    const result = await c.env.DB.prepare(`
      SELECT
        s.id as session_id,
        s.user_id,
        s.expires_at,
        u.id,
        u.username,
        u.display_name,
        u.avatar_url,
        u.created_at,
        u.updated_at
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ?
        AND s.expires_at > unixepoch()
    `).bind(tokenHash).first<{
      session_id: string;
      user_id: string;
      expires_at: number;
      id: string;
      username: string;
      display_name: string;
      avatar_url: string | null;
      created_at: number;
      updated_at: number;
    }>();

    if (result) {
      c.set('user', {
        id: result.id,
        username: result.username,
        display_name: result.display_name,
        avatar_url: result.avatar_url,
        created_at: result.created_at,
        updated_at: result.updated_at
      } as User);

      c.set('session', {
        id: result.session_id,
        user_id: result.user_id,
        expires_at: result.expires_at
      } as Session);
    }
  } catch (error) {
    console.error('Auth middleware error:', error);
  }

  return next();
}

// Require authentication
export async function requireAuth(c: Context<AppContext>, next: Next) {
  const user = c.get('user');

  if (!user) {
    return c.json({ success: false, error: 'Authentication required' }, 401);
  }

  return next();
}

// Check if user has access to a board
export async function checkBoardAccess(
  db: D1Database,
  boardId: string,
  userId: string
): Promise<{ hasAccess: boolean; role?: string }> {
  const member = await db.prepare(`
    SELECT role FROM board_members
    WHERE board_id = ? AND user_id = ?
  `).bind(boardId, userId).first<{ role: string }>();

  if (member) {
    return { hasAccess: true, role: member.role };
  }

  return { hasAccess: false };
}

// Check if user is board admin or owner
export async function checkBoardAdmin(
  db: D1Database,
  boardId: string,
  userId: string
): Promise<boolean> {
  const member = await db.prepare(`
    SELECT role FROM board_members
    WHERE board_id = ? AND user_id = ?
    AND role IN ('owner', 'admin')
  `).bind(boardId, userId).first<{ role: string }>();

  return !!member;
}

// Check if user is board owner
export async function checkBoardOwner(
  db: D1Database,
  boardId: string,
  userId: string
): Promise<boolean> {
  const board = await db.prepare(`
    SELECT owner_id FROM boards
    WHERE id = ? AND owner_id = ?
  `).bind(boardId, userId).first();

  return !!board;
}
