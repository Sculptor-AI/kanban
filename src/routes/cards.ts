// Card routes

import { Hono } from 'hono';
import { generateId } from '../utils/crypto';
import { validateCardTitle, parseGitHubUrl } from '../utils/validation';
import { requireAuth, checkBoardAccess } from '../middleware/auth';
import type { AppContext, Card, List } from '../types';

const cards = new Hono<AppContext>();

cards.use('*', requireAuth);

// Helper to get board ID from list
async function getBoardIdFromList(db: D1Database, listId: string): Promise<string | null> {
  const list = await db.prepare(
    'SELECT board_id FROM lists WHERE id = ?'
  ).bind(listId).first<{ board_id: string }>();
  return list?.board_id || null;
}

// Helper to get board ID from card
async function getBoardIdFromCard(db: D1Database, cardId: string): Promise<string | null> {
  const result = await db.prepare(`
    SELECT l.board_id FROM cards c
    JOIN lists l ON c.list_id = l.id
    WHERE c.id = ?
  `).bind(cardId).first<{ board_id: string }>();
  return result?.board_id || null;
}

// Create a new card
cards.post('/', async (c) => {
  const user = c.get('user')!;

  try {
    const body = await c.req.json();
    const { listId, title, description, position } = body;

    if (!listId) {
      return c.json({ success: false, error: 'List ID required' }, 400);
    }

    const boardId = await getBoardIdFromList(c.env.DB, listId);
    if (!boardId) {
      return c.json({ success: false, error: 'List not found' }, 404);
    }

    const access = await checkBoardAccess(c.env.DB, boardId, user.id);
    if (!access.hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    const validation = validateCardTitle(title);
    if (!validation.valid) {
      return c.json({ success: false, error: validation.error }, 400);
    }

    // Get max position if not specified
    let cardPosition = position;
    if (cardPosition === undefined) {
      const maxPos = await c.env.DB.prepare(
        'SELECT MAX(position) as max FROM cards WHERE list_id = ?'
      ).bind(listId).first<{ max: number | null }>();
      cardPosition = (maxPos?.max ?? -1) + 1;
    }

    const cardId = generateId();
    const now = Math.floor(Date.now() / 1000);

    await c.env.DB.prepare(`
      INSERT INTO cards (id, list_id, title, description, position, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(cardId, listId, title.trim(), description?.trim() || null, cardPosition, user.id, now, now).run();

    return c.json({
      success: true,
      data: {
        card: {
          id: cardId,
          list_id: listId,
          title: title.trim(),
          description: description?.trim() || null,
          position: cardPosition,
          created_by: user.id,
          created_at: now,
          updated_at: now
        }
      }
    }, 201);
  } catch (error) {
    console.error('Card creation error:', error);
    return c.json({ success: false, error: 'Failed to create card' }, 500);
  }
});

// Get a single card with details
cards.get('/:cardId', async (c) => {
  const user = c.get('user')!;
  const cardId = c.req.param('cardId');

  const boardId = await getBoardIdFromCard(c.env.DB, cardId);
  if (!boardId) {
    return c.json({ success: false, error: 'Card not found' }, 404);
  }

  const access = await checkBoardAccess(c.env.DB, boardId, user.id);
  if (!access.hasAccess) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  const card = await c.env.DB.prepare('SELECT * FROM cards WHERE id = ?').bind(cardId).first<Card>();

  const labels = await c.env.DB.prepare(`
    SELECT l.* FROM labels l
    JOIN card_labels cl ON l.id = cl.label_id
    WHERE cl.card_id = ?
  `).bind(cardId).all();

  const assignees = await c.env.DB.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url
    FROM users u
    JOIN card_assignees ca ON u.id = ca.user_id
    WHERE ca.card_id = ?
  `).bind(cardId).all();

  const githubLinks = await c.env.DB.prepare(
    'SELECT * FROM card_github_links WHERE card_id = ?'
  ).bind(cardId).all();

  return c.json({
    success: true,
    data: {
      card,
      labels: labels.results,
      assignees: assignees.results,
      githubLinks: githubLinks.results
    }
  });
});

// Update a card
cards.patch('/:cardId', async (c) => {
  const user = c.get('user')!;
  const cardId = c.req.param('cardId');

  try {
    const boardId = await getBoardIdFromCard(c.env.DB, cardId);
    if (!boardId) {
      return c.json({ success: false, error: 'Card not found' }, 404);
    }

    const access = await checkBoardAccess(c.env.DB, boardId, user.id);
    if (!access.hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    const body = await c.req.json();
    const { title, description, dueDate } = body;

    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (title !== undefined) {
      const validation = validateCardTitle(title);
      if (!validation.valid) {
        return c.json({ success: false, error: validation.error }, 400);
      }
      updates.push('title = ?');
      values.push(title.trim());
    }

    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description?.trim() || null);
    }

    if (dueDate !== undefined) {
      updates.push('due_date = ?');
      values.push(dueDate ? Math.floor(new Date(dueDate).getTime() / 1000) : null);
    }

    if (updates.length === 0) {
      return c.json({ success: false, error: 'No updates provided' }, 400);
    }

    updates.push('updated_at = unixepoch()');
    values.push(cardId);

    await c.env.DB.prepare(`
      UPDATE cards SET ${updates.join(', ')} WHERE id = ?
    `).bind(...values).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('Card update error:', error);
    return c.json({ success: false, error: 'Failed to update card' }, 500);
  }
});

// Move a card to a different list or position
cards.post('/:cardId/move', async (c) => {
  const user = c.get('user')!;
  const cardId = c.req.param('cardId');

  try {
    const body = await c.req.json();
    const { listId, position } = body;

    if (!listId || position === undefined) {
      return c.json({ success: false, error: 'List ID and position required' }, 400);
    }

    // Verify access to current card's board
    const currentBoardId = await getBoardIdFromCard(c.env.DB, cardId);
    if (!currentBoardId) {
      return c.json({ success: false, error: 'Card not found' }, 404);
    }

    let access = await checkBoardAccess(c.env.DB, currentBoardId, user.id);
    if (!access.hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    // Verify access to target list's board
    const targetBoardId = await getBoardIdFromList(c.env.DB, listId);
    if (!targetBoardId) {
      return c.json({ success: false, error: 'Target list not found' }, 404);
    }

    // Cards can only move within the same board
    if (currentBoardId !== targetBoardId) {
      return c.json({ success: false, error: 'Cannot move card to a different board' }, 400);
    }

    await c.env.DB.prepare(`
      UPDATE cards SET list_id = ?, position = ?, updated_at = unixepoch()
      WHERE id = ?
    `).bind(listId, position, cardId).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('Card move error:', error);
    return c.json({ success: false, error: 'Failed to move card' }, 500);
  }
});

// Delete a card
cards.delete('/:cardId', async (c) => {
  const user = c.get('user')!;
  const cardId = c.req.param('cardId');

  const boardId = await getBoardIdFromCard(c.env.DB, cardId);
  if (!boardId) {
    return c.json({ success: false, error: 'Card not found' }, 404);
  }

  const access = await checkBoardAccess(c.env.DB, boardId, user.id);
  if (!access.hasAccess) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  await c.env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(cardId).run();

  return c.json({ success: true });
});

// Assign user to card
cards.post('/:cardId/assignees', async (c) => {
  const user = c.get('user')!;
  const cardId = c.req.param('cardId');

  try {
    const body = await c.req.json();
    const { userId } = body;

    if (!userId) {
      return c.json({ success: false, error: 'User ID required' }, 400);
    }

    const boardId = await getBoardIdFromCard(c.env.DB, cardId);
    if (!boardId) {
      return c.json({ success: false, error: 'Card not found' }, 404);
    }

    const access = await checkBoardAccess(c.env.DB, boardId, user.id);
    if (!access.hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    // Verify target user is a board member
    const targetAccess = await checkBoardAccess(c.env.DB, boardId, userId);
    if (!targetAccess.hasAccess) {
      return c.json({ success: false, error: 'User is not a board member' }, 400);
    }

    await c.env.DB.prepare(`
      INSERT OR IGNORE INTO card_assignees (card_id, user_id, assigned_at, assigned_by)
      VALUES (?, ?, unixepoch(), ?)
    `).bind(cardId, userId, user.id).run();

    return c.json({ success: true }, 201);
  } catch (error) {
    console.error('Assign user error:', error);
    return c.json({ success: false, error: 'Failed to assign user' }, 500);
  }
});

// Remove assignee from card
cards.delete('/:cardId/assignees/:userId', async (c) => {
  const user = c.get('user')!;
  const cardId = c.req.param('cardId');
  const targetUserId = c.req.param('userId');

  const boardId = await getBoardIdFromCard(c.env.DB, cardId);
  if (!boardId) {
    return c.json({ success: false, error: 'Card not found' }, 404);
  }

  const access = await checkBoardAccess(c.env.DB, boardId, user.id);
  if (!access.hasAccess) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  await c.env.DB.prepare(
    'DELETE FROM card_assignees WHERE card_id = ? AND user_id = ?'
  ).bind(cardId, targetUserId).run();

  return c.json({ success: true });
});

// Add label to card
cards.post('/:cardId/labels', async (c) => {
  const user = c.get('user')!;
  const cardId = c.req.param('cardId');

  try {
    const body = await c.req.json();
    const { labelId } = body;

    if (!labelId) {
      return c.json({ success: false, error: 'Label ID required' }, 400);
    }

    const boardId = await getBoardIdFromCard(c.env.DB, cardId);
    if (!boardId) {
      return c.json({ success: false, error: 'Card not found' }, 404);
    }

    const access = await checkBoardAccess(c.env.DB, boardId, user.id);
    if (!access.hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    // Verify label belongs to same board
    const label = await c.env.DB.prepare(
      'SELECT board_id FROM labels WHERE id = ?'
    ).bind(labelId).first<{ board_id: string }>();

    if (!label || label.board_id !== boardId) {
      return c.json({ success: false, error: 'Label not found' }, 404);
    }

    await c.env.DB.prepare(`
      INSERT OR IGNORE INTO card_labels (card_id, label_id, assigned_at)
      VALUES (?, ?, unixepoch())
    `).bind(cardId, labelId).run();

    return c.json({ success: true }, 201);
  } catch (error) {
    console.error('Add label error:', error);
    return c.json({ success: false, error: 'Failed to add label' }, 500);
  }
});

// Remove label from card
cards.delete('/:cardId/labels/:labelId', async (c) => {
  const user = c.get('user')!;
  const cardId = c.req.param('cardId');
  const labelId = c.req.param('labelId');

  const boardId = await getBoardIdFromCard(c.env.DB, cardId);
  if (!boardId) {
    return c.json({ success: false, error: 'Card not found' }, 404);
  }

  const access = await checkBoardAccess(c.env.DB, boardId, user.id);
  if (!access.hasAccess) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  await c.env.DB.prepare(
    'DELETE FROM card_labels WHERE card_id = ? AND label_id = ?'
  ).bind(cardId, labelId).run();

  return c.json({ success: true });
});

// Add GitHub link to card
cards.post('/:cardId/github', async (c) => {
  const user = c.get('user')!;
  const cardId = c.req.param('cardId');

  try {
    const body = await c.req.json();
    const { url } = body;

    if (!url) {
      return c.json({ success: false, error: 'URL required' }, 400);
    }

    const parsed = parseGitHubUrl(url);
    if (!parsed.valid) {
      return c.json({ success: false, error: parsed.error }, 400);
    }

    const boardId = await getBoardIdFromCard(c.env.DB, cardId);
    if (!boardId) {
      return c.json({ success: false, error: 'Card not found' }, 404);
    }

    const access = await checkBoardAccess(c.env.DB, boardId, user.id);
    if (!access.hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    const linkId = generateId();
    const now = Math.floor(Date.now() / 1000);

    await c.env.DB.prepare(`
      INSERT INTO card_github_links (id, card_id, link_type, repo_owner, repo_name, number, url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(card_id, repo_owner, repo_name, number) DO UPDATE SET
        url = excluded.url,
        updated_at = excluded.updated_at
    `).bind(linkId, cardId, parsed.type, parsed.owner, parsed.repo, parsed.number, url, now, now).run();

    return c.json({ success: true }, 201);
  } catch (error) {
    console.error('Add GitHub link error:', error);
    return c.json({ success: false, error: 'Failed to add GitHub link' }, 500);
  }
});

// Remove GitHub link from card
cards.delete('/:cardId/github/:linkId', async (c) => {
  const user = c.get('user')!;
  const cardId = c.req.param('cardId');
  const linkId = c.req.param('linkId');

  const boardId = await getBoardIdFromCard(c.env.DB, cardId);
  if (!boardId) {
    return c.json({ success: false, error: 'Card not found' }, 404);
  }

  const access = await checkBoardAccess(c.env.DB, boardId, user.id);
  if (!access.hasAccess) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  await c.env.DB.prepare(
    'DELETE FROM card_github_links WHERE id = ? AND card_id = ?'
  ).bind(linkId, cardId).run();

  return c.json({ success: true });
});

export default cards;
