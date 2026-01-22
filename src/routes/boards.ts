// Board routes

import { Hono } from 'hono';
import { generateId } from '../utils/crypto';
import { validateBoardName } from '../utils/validation';
import { requireAuth, checkBoardAccess, checkBoardAdmin, checkBoardOwner } from '../middleware/auth';
import type { AppContext, Board, BoardMember, User } from '../types';

const boards = new Hono<AppContext>();

// All routes require authentication
boards.use('*', requireAuth);

// List all boards for current user
boards.get('/', async (c) => {
  const user = c.get('user')!;

  const result = await c.env.DB.prepare(`
    SELECT b.*, bm.role
    FROM boards b
    JOIN board_members bm ON b.id = bm.board_id
    WHERE bm.user_id = ?
    ORDER BY b.updated_at DESC
  `).bind(user.id).all<Board & { role: string }>();

  return c.json({
    success: true,
    data: { boards: result.results }
  });
});

// Create a new board
boards.post('/', async (c) => {
  const user = c.get('user')!;

  try {
    const body = await c.req.json();
    const { name, description } = body;

    const validation = validateBoardName(name);
    if (!validation.valid) {
      return c.json({ success: false, error: validation.error }, 400);
    }

    const boardId = generateId();
    const now = Math.floor(Date.now() / 1000);

    // Create board and add owner as member in a batch
    await c.env.DB.batch([
      c.env.DB.prepare(`
        INSERT INTO boards (id, name, description, owner_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(boardId, name.trim(), description?.trim() || null, user.id, now, now),
      c.env.DB.prepare(`
        INSERT INTO board_members (board_id, user_id, role, added_at, added_by)
        VALUES (?, ?, 'owner', ?, ?)
      `).bind(boardId, user.id, now, user.id),
      // Create default lists
      c.env.DB.prepare(`
        INSERT INTO lists (id, board_id, name, position, created_at, updated_at)
        VALUES (?, ?, 'To Do', 0, ?, ?)
      `).bind(generateId(), boardId, now, now),
      c.env.DB.prepare(`
        INSERT INTO lists (id, board_id, name, position, created_at, updated_at)
        VALUES (?, ?, 'In Progress', 1, ?, ?)
      `).bind(generateId(), boardId, now, now),
      c.env.DB.prepare(`
        INSERT INTO lists (id, board_id, name, position, created_at, updated_at)
        VALUES (?, ?, 'Done', 2, ?, ?)
      `).bind(generateId(), boardId, now, now)
    ]);

    return c.json({
      success: true,
      data: {
        board: {
          id: boardId,
          name: name.trim(),
          description: description?.trim() || null,
          owner_id: user.id,
          created_at: now,
          updated_at: now
        }
      }
    }, 201);
  } catch (error) {
    console.error('Board creation error:', error);
    return c.json({ success: false, error: 'Failed to create board' }, 500);
  }
});

// Get a single board with full details
boards.get('/:boardId', async (c) => {
  const user = c.get('user')!;
  const boardId = c.req.param('boardId');

  // Check access
  const access = await checkBoardAccess(c.env.DB, boardId, user.id);
  if (!access.hasAccess) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  // Get board
  const board = await c.env.DB.prepare(`
    SELECT * FROM boards WHERE id = ?
  `).bind(boardId).first<Board>();

  if (!board) {
    return c.json({ success: false, error: 'Board not found' }, 404);
  }

  // Get lists with cards
  const lists = await c.env.DB.prepare(`
    SELECT * FROM lists WHERE board_id = ? ORDER BY position
  `).bind(boardId).all();

  // Get all cards for this board
  const cards = await c.env.DB.prepare(`
    SELECT c.* FROM cards c
    JOIN lists l ON c.list_id = l.id
    WHERE l.board_id = ?
    ORDER BY c.position
  `).bind(boardId).all();

  // Get labels
  const labels = await c.env.DB.prepare(`
    SELECT * FROM labels WHERE board_id = ? ORDER BY name
  `).bind(boardId).all();

  // Get members
  const members = await c.env.DB.prepare(`
    SELECT bm.*, u.username, u.display_name, u.avatar_url
    FROM board_members bm
    JOIN users u ON bm.user_id = u.id
    WHERE bm.board_id = ?
    ORDER BY bm.role, u.display_name
  `).bind(boardId).all();

  // Get card labels
  const cardLabels = await c.env.DB.prepare(`
    SELECT cl.* FROM card_labels cl
    JOIN cards c ON cl.card_id = c.id
    JOIN lists l ON c.list_id = l.id
    WHERE l.board_id = ?
  `).bind(boardId).all();

  // Get card assignees
  const cardAssignees = await c.env.DB.prepare(`
    SELECT ca.*, u.username, u.display_name, u.avatar_url
    FROM card_assignees ca
    JOIN users u ON ca.user_id = u.id
    JOIN cards c ON ca.card_id = c.id
    JOIN lists l ON c.list_id = l.id
    WHERE l.board_id = ?
  `).bind(boardId).all();

  // Get GitHub links
  const githubLinks = await c.env.DB.prepare(`
    SELECT gl.* FROM card_github_links gl
    JOIN cards c ON gl.card_id = c.id
    JOIN lists l ON c.list_id = l.id
    WHERE l.board_id = ?
  `).bind(boardId).all();

  return c.json({
    success: true,
    data: {
      board,
      lists: lists.results,
      cards: cards.results,
      labels: labels.results,
      members: members.results,
      cardLabels: cardLabels.results,
      cardAssignees: cardAssignees.results,
      githubLinks: githubLinks.results,
      userRole: access.role
    }
  });
});

// Update board
boards.patch('/:boardId', async (c) => {
  const user = c.get('user')!;
  const boardId = c.req.param('boardId');

  // Must be admin or owner
  const isAdmin = await checkBoardAdmin(c.env.DB, boardId, user.id);
  if (!isAdmin) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  try {
    const body = await c.req.json();
    const { name, description } = body;

    const updates: string[] = [];
    const values: (string | null)[] = [];

    if (name !== undefined) {
      const validation = validateBoardName(name);
      if (!validation.valid) {
        return c.json({ success: false, error: validation.error }, 400);
      }
      updates.push('name = ?');
      values.push(name.trim());
    }

    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description?.trim() || null);
    }

    if (updates.length === 0) {
      return c.json({ success: false, error: 'No updates provided' }, 400);
    }

    updates.push('updated_at = unixepoch()');
    values.push(boardId);

    await c.env.DB.prepare(`
      UPDATE boards SET ${updates.join(', ')} WHERE id = ?
    `).bind(...values).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('Board update error:', error);
    return c.json({ success: false, error: 'Failed to update board' }, 500);
  }
});

// Delete board (owner only)
boards.delete('/:boardId', async (c) => {
  const user = c.get('user')!;
  const boardId = c.req.param('boardId');

  const isOwner = await checkBoardOwner(c.env.DB, boardId, user.id);
  if (!isOwner) {
    return c.json({ success: false, error: 'Only the owner can delete this board' }, 403);
  }

  await c.env.DB.prepare('DELETE FROM boards WHERE id = ?').bind(boardId).run();

  return c.json({ success: true });
});

// Get board members
boards.get('/:boardId/members', async (c) => {
  const user = c.get('user')!;
  const boardId = c.req.param('boardId');

  const access = await checkBoardAccess(c.env.DB, boardId, user.id);
  if (!access.hasAccess) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  const members = await c.env.DB.prepare(`
    SELECT bm.*, u.username, u.display_name, u.avatar_url
    FROM board_members bm
    JOIN users u ON bm.user_id = u.id
    WHERE bm.board_id = ?
    ORDER BY bm.role, u.display_name
  `).bind(boardId).all();

  return c.json({
    success: true,
    data: { members: members.results }
  });
});

// Add member to board
boards.post('/:boardId/members', async (c) => {
  const user = c.get('user')!;
  const boardId = c.req.param('boardId');

  const isAdmin = await checkBoardAdmin(c.env.DB, boardId, user.id);
  if (!isAdmin) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  try {
    const body = await c.req.json();
    const { username, role = 'member' } = body;

    if (!username) {
      return c.json({ success: false, error: 'Username required' }, 400);
    }

    if (!['admin', 'member'].includes(role)) {
      return c.json({ success: false, error: 'Invalid role' }, 400);
    }

    // Find user
    const targetUser = await c.env.DB.prepare(
      'SELECT id FROM users WHERE username = ? COLLATE NOCASE'
    ).bind(username.trim()).first<{ id: string }>();

    if (!targetUser) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }

    // Check if already a member
    const existing = await c.env.DB.prepare(
      'SELECT 1 FROM board_members WHERE board_id = ? AND user_id = ?'
    ).bind(boardId, targetUser.id).first();

    if (existing) {
      return c.json({ success: false, error: 'User is already a member' }, 400);
    }

    await c.env.DB.prepare(`
      INSERT INTO board_members (board_id, user_id, role, added_at, added_by)
      VALUES (?, ?, ?, unixepoch(), ?)
    `).bind(boardId, targetUser.id, role, user.id).run();

    return c.json({ success: true }, 201);
  } catch (error) {
    console.error('Add member error:', error);
    return c.json({ success: false, error: 'Failed to add member' }, 500);
  }
});

// Update member role
boards.patch('/:boardId/members/:userId', async (c) => {
  const user = c.get('user')!;
  const boardId = c.req.param('boardId');
  const targetUserId = c.req.param('userId');

  const isOwner = await checkBoardOwner(c.env.DB, boardId, user.id);
  if (!isOwner) {
    return c.json({ success: false, error: 'Only the owner can change roles' }, 403);
  }

  // Can't change owner's role
  if (targetUserId === user.id) {
    return c.json({ success: false, error: "Can't change your own role" }, 400);
  }

  try {
    const body = await c.req.json();
    const { role } = body;

    if (!['admin', 'member'].includes(role)) {
      return c.json({ success: false, error: 'Invalid role' }, 400);
    }

    await c.env.DB.prepare(`
      UPDATE board_members SET role = ?
      WHERE board_id = ? AND user_id = ?
    `).bind(role, boardId, targetUserId).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('Update member error:', error);
    return c.json({ success: false, error: 'Failed to update member' }, 500);
  }
});

// Remove member from board
boards.delete('/:boardId/members/:userId', async (c) => {
  const user = c.get('user')!;
  const boardId = c.req.param('boardId');
  const targetUserId = c.req.param('userId');

  const isAdmin = await checkBoardAdmin(c.env.DB, boardId, user.id);

  // Can remove yourself, or admins can remove others
  if (!isAdmin && targetUserId !== user.id) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  // Can't remove owner
  const isTargetOwner = await checkBoardOwner(c.env.DB, boardId, targetUserId);
  if (isTargetOwner) {
    return c.json({ success: false, error: "Can't remove the board owner" }, 400);
  }

  await c.env.DB.prepare(
    'DELETE FROM board_members WHERE board_id = ? AND user_id = ?'
  ).bind(boardId, targetUserId).run();

  return c.json({ success: true });
});

export default boards;
