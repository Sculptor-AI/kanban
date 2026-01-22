// Label routes

import { Hono } from 'hono';
import { generateId } from '../utils/crypto';
import { validateLabelName, validateColor, normalizeColor } from '../utils/validation';
import { requireAuth, checkBoardAccess } from '../middleware/auth';
import type { AppContext, Label } from '../types';

const labels = new Hono<AppContext>();

labels.use('*', requireAuth);

// Get all labels for a board
labels.get('/board/:boardId', async (c) => {
  const user = c.get('user')!;
  const boardId = c.req.param('boardId');

  const access = await checkBoardAccess(c.env.DB, boardId, user.id);
  if (!access.hasAccess) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  const result = await c.env.DB.prepare(
    'SELECT * FROM labels WHERE board_id = ? ORDER BY name'
  ).bind(boardId).all<Label>();

  return c.json({
    success: true,
    data: { labels: result.results }
  });
});

// Create a new label
labels.post('/', async (c) => {
  const user = c.get('user')!;

  try {
    const body = await c.req.json();
    const { boardId, name, color } = body;

    if (!boardId) {
      return c.json({ success: false, error: 'Board ID required' }, 400);
    }

    const access = await checkBoardAccess(c.env.DB, boardId, user.id);
    if (!access.hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    const nameValidation = validateLabelName(name);
    if (!nameValidation.valid) {
      return c.json({ success: false, error: nameValidation.error }, 400);
    }

    const colorValidation = validateColor(color);
    if (!colorValidation.valid) {
      return c.json({ success: false, error: colorValidation.error }, 400);
    }

    const labelId = generateId();
    const normalizedColor = normalizeColor(color);
    const now = Math.floor(Date.now() / 1000);

    await c.env.DB.prepare(`
      INSERT INTO labels (id, board_id, name, color, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(labelId, boardId, name.trim(), normalizedColor, now).run();

    return c.json({
      success: true,
      data: {
        label: {
          id: labelId,
          board_id: boardId,
          name: name.trim(),
          color: normalizedColor,
          created_at: now
        }
      }
    }, 201);
  } catch (error) {
    console.error('Label creation error:', error);
    return c.json({ success: false, error: 'Failed to create label' }, 500);
  }
});

// Update a label
labels.patch('/:labelId', async (c) => {
  const user = c.get('user')!;
  const labelId = c.req.param('labelId');

  try {
    const label = await c.env.DB.prepare(
      'SELECT * FROM labels WHERE id = ?'
    ).bind(labelId).first<Label>();

    if (!label) {
      return c.json({ success: false, error: 'Label not found' }, 404);
    }

    const access = await checkBoardAccess(c.env.DB, label.board_id, user.id);
    if (!access.hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    const body = await c.req.json();
    const { name, color } = body;

    const updates: string[] = [];
    const values: string[] = [];

    if (name !== undefined) {
      const validation = validateLabelName(name);
      if (!validation.valid) {
        return c.json({ success: false, error: validation.error }, 400);
      }
      updates.push('name = ?');
      values.push(name.trim());
    }

    if (color !== undefined) {
      const validation = validateColor(color);
      if (!validation.valid) {
        return c.json({ success: false, error: validation.error }, 400);
      }
      updates.push('color = ?');
      values.push(normalizeColor(color));
    }

    if (updates.length === 0) {
      return c.json({ success: false, error: 'No updates provided' }, 400);
    }

    values.push(labelId);

    await c.env.DB.prepare(`
      UPDATE labels SET ${updates.join(', ')} WHERE id = ?
    `).bind(...values).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('Label update error:', error);
    return c.json({ success: false, error: 'Failed to update label' }, 500);
  }
});

// Delete a label
labels.delete('/:labelId', async (c) => {
  const user = c.get('user')!;
  const labelId = c.req.param('labelId');

  const label = await c.env.DB.prepare(
    'SELECT board_id FROM labels WHERE id = ?'
  ).bind(labelId).first<{ board_id: string }>();

  if (!label) {
    return c.json({ success: false, error: 'Label not found' }, 404);
  }

  const access = await checkBoardAccess(c.env.DB, label.board_id, user.id);
  if (!access.hasAccess) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  await c.env.DB.prepare('DELETE FROM labels WHERE id = ?').bind(labelId).run();

  return c.json({ success: true });
});

export default labels;
