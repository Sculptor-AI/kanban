// Upload routes for profile pictures

import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { generateId } from '../utils/crypto';
import type { AppContext } from '../types';

const upload = new Hono<AppContext>();

upload.use('*', requireAuth);

// Maximum file size (500KB for profile pictures)
const MAX_FILE_SIZE = 500 * 1024;

// Upload profile picture
upload.post('/avatar', async (c) => {
  const user = c.get('user')!;

  try {
    const contentType = c.req.header('content-type') || '';

    if (!contentType.includes('multipart/form-data')) {
      return c.json({ success: false, error: 'Multipart form data required' }, 400);
    }

    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ success: false, error: 'No file provided' }, 400);
    }

    // Validate file type
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      return c.json({ success: false, error: 'Only PNG, JPEG, and WebP images are allowed' }, 400);
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return c.json({ success: false, error: 'File size must be under 500KB' }, 400);
    }

    // Read file data
    const arrayBuffer = await file.arrayBuffer();
    const fileData = new Uint8Array(arrayBuffer);

    // Generate unique filename
    const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
    const filename = `avatars/${user.id}/${generateId()}.${extension}`;

    // Delete old avatar if exists
    const oldAvatar = user.avatar_url;
    if (oldAvatar && oldAvatar.startsWith('/storage/avatars/')) {
      const oldKey = oldAvatar.replace('/storage/', '');
      try {
        await c.env.STORAGE.delete(oldKey);
      } catch (e) {
        // Ignore deletion errors
      }
    }

    // Upload to R2
    await c.env.STORAGE.put(filename, fileData, {
      httpMetadata: {
        contentType: file.type,
        cacheControl: 'public, max-age=31536000'
      }
    });

    // Update user avatar URL
    const avatarUrl = `/storage/${filename}`;
    await c.env.DB.prepare(`
      UPDATE users SET avatar_url = ?, updated_at = unixepoch()
      WHERE id = ?
    `).bind(avatarUrl, user.id).run();

    return c.json({
      success: true,
      data: { avatarUrl }
    });
  } catch (error) {
    console.error('Upload error:', error);
    return c.json({ success: false, error: 'Upload failed' }, 500);
  }
});

// Delete profile picture
upload.delete('/avatar', async (c) => {
  const user = c.get('user')!;

  try {
    const avatarUrl = user.avatar_url;
    if (avatarUrl && avatarUrl.startsWith('/storage/avatars/')) {
      const key = avatarUrl.replace('/storage/', '');
      try {
        await c.env.STORAGE.delete(key);
      } catch (e) {
        // Ignore deletion errors
      }
    }

    await c.env.DB.prepare(`
      UPDATE users SET avatar_url = NULL, updated_at = unixepoch()
      WHERE id = ?
    `).bind(user.id).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('Delete avatar error:', error);
    return c.json({ success: false, error: 'Delete failed' }, 500);
  }
});

export default upload;
