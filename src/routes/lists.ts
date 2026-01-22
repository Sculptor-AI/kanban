// List routes

import { Hono } from 'hono';
import { generateId } from '../utils/crypto';
import { validateListName } from '../utils/validation';
import { requireAuth, checkBoardAccess } from '../middleware/auth';
import type { AppContext, List } from '../types';

const lists = new Hono<AppContext>();

lists.use('*', requireAuth);

// Create a new list
lists.post('/', async (c) => {
  const user = c.get('user')!;

  try {
    const body = await c.req.json();
    const { boardId, name, position } = body;

    if (!boardId) {
      return c.json({ success: false, error: 'Board ID required' }, 400);
    }

    const access = await checkBoardAccess(c.env.DB, boardId, user.id);
    if (!access.hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    const validation = validateListName(name);
    if (!validation.valid) {
      return c.json({ success: false, error: validation.error }, 400);
    }

    // Get max position if not specified
    let listPosition = position;
    if (listPosition === undefined) {
      const maxPos = await c.env.DB.prepare(
        'SELECT MAX(position) as max FROM lists WHERE board_id = ?'
      ).bind(boardId).first<{ max: number | null }>();
      listPosition = (maxPos?.max ?? -1) + 1;
    }

    const listId = generateId();
    const now = Math.floor(Date.now() / 1000);

    await c.env.DB.prepare(`
      INSERT INTO lists (id, board_id, name, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(listId, boardId, name.trim(), listPosition, now, now).run();

    return c.json({
      success: true,
      data: {
        list: {
          id: listId,
          board_id: boardId,
          name: name.trim(),
          position: listPosition,
          created_at: now,
          updated_at: now
        }
      }
    }, 201);
  } catch (error) {
    console.error('List creation error:', error);
    return c.json({ success: false, error: 'Failed to create list' }, 500);
  }
});

// Update a list
lists.patch('/:listId', async (c) => {
  const user = c.get('user')!;
  const listId = c.req.param('listId');

  try {
    // Get list and verify access
    const list = await c.env.DB.prepare(
      'SELECT * FROM lists WHERE id = ?'
    ).bind(listId).first<List>();

    if (!list) {
      return c.json({ success: false, error: 'List not found' }, 404);
    }

    const access = await checkBoardAccess(c.env.DB, list.board_id, user.id);
    if (!access.hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    const body = await c.req.json();
    const { name } = body;

    if (name !== undefined) {
      const validation = validateListName(name);
      if (!validation.valid) {
        return c.json({ success: false, error: validation.error }, 400);
      }

      await c.env.DB.prepare(`
        UPDATE lists SET name = ?, updated_at = unixepoch()
        WHERE id = ?
      `).bind(name.trim(), listId).run();
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('List update error:', error);
    return c.json({ success: false, error: 'Failed to update list' }, 500);
  }
});

// Reorder lists
lists.post('/reorder', async (c) => {
  const user = c.get('user')!;

  try {
    const body = await c.req.json();
    const { boardId, listIds } = body;

    if (!boardId || !Array.isArray(listIds)) {
      return c.json({ success: false, error: 'Board ID and list IDs required' }, 400);
    }

    const access = await checkBoardAccess(c.env.DB, boardId, user.id);
    if (!access.hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    // Update positions
    const statements = listIds.map((id: string, index: number) =>
      c.env.DB.prepare(
        'UPDATE lists SET position = ?, updated_at = unixepoch() WHERE id = ? AND board_id = ?'
      ).bind(index, id, boardId)
    );

    await c.env.DB.batch(statements);

    return c.json({ success: true });
  } catch (error) {
    console.error('List reorder error:', error);
    return c.json({ success: false, error: 'Failed to reorder lists' }, 500);
  }
});

// Delete a list
lists.delete('/:listId', async (c) => {
  const user = c.get('user')!;
  const listId = c.req.param('listId');

  try {
    const list = await c.env.DB.prepare(
      'SELECT board_id FROM lists WHERE id = ?'
    ).bind(listId).first<{ board_id: string }>();

    if (!list) {
      return c.json({ success: false, error: 'List not found' }, 404);
    }

    const access = await checkBoardAccess(c.env.DB, list.board_id, user.id);
    if (!access.hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    await c.env.DB.prepare('DELETE FROM lists WHERE id = ?').bind(listId).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('List delete error:', error);
    return c.json({ success: false, error: 'Failed to delete list' }, 500);
  }
});

export default lists;
