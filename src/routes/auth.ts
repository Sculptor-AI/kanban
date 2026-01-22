// Authentication routes

import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { generateId, generateToken, hashPassword, verifyPassword, hashToken, hashInviteKey } from '../utils/crypto';
import { validateUsername, validatePassword, validateDisplayName } from '../utils/validation';
import type { AppContext } from '../types';

const auth = new Hono<AppContext>();

// Register new user
auth.post('/register', async (c) => {
  try {
    const body = await c.req.json();
    const { username, password, displayName, inviteKey } = body;

    // Validate invite key first
    if (!inviteKey) {
      return c.json({ success: false, error: 'Invite key is required' }, 400);
    }

    const keyHash = await hashInviteKey(inviteKey);
    const validKey = await c.env.DB.prepare(`
      SELECT id FROM invite_keys
      WHERE key_hash = ? AND is_active = 1 AND used_at IS NULL
    `).bind(keyHash).first();

    if (!validKey) {
      return c.json({ success: false, error: 'Invalid or expired invite key' }, 400);
    }

    // Validate inputs
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      return c.json({ success: false, error: usernameValidation.error }, 400);
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return c.json({ success: false, error: passwordValidation.error }, 400);
    }

    const displayNameValidation = validateDisplayName(displayName || username);
    if (!displayNameValidation.valid) {
      return c.json({ success: false, error: displayNameValidation.error }, 400);
    }

    // Check if username exists
    const existingUser = await c.env.DB.prepare(
      'SELECT id FROM users WHERE username = ? COLLATE NOCASE'
    ).bind(username.trim()).first();

    if (existingUser) {
      return c.json({ success: false, error: 'Username already taken' }, 400);
    }

    // Create user
    const userId = generateId();
    const passwordHash = await hashPassword(password);

    await c.env.DB.prepare(`
      INSERT INTO users (id, username, password_hash, display_name)
      VALUES (?, ?, ?, ?)
    `).bind(userId, username.trim().toLowerCase(), passwordHash, (displayName || username).trim()).run();

    // Mark invite key as used (skip if unlimited)
    if (!validKey.id.startsWith('unlimited-')) {
      await c.env.DB.prepare(`
        UPDATE invite_keys SET used_at = unixepoch(), used_by = ?
        WHERE id = ?
      `).bind(userId, validKey.id).run();
    }

    // Create session
    const token = generateToken();
    const tokenHash = await hashToken(token);
    const sessionId = generateId();
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

    await c.env.DB.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      sessionId,
      userId,
      tokenHash,
      expiresAt,
      c.req.header('CF-Connecting-IP') || '',
      c.req.header('User-Agent') || ''
    ).run();

    // Set session cookie
    setCookie(c, 'session', token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      maxAge: 30 * 24 * 60 * 60 // 30 days
    });

    return c.json({
      success: true,
      data: {
        user: {
          id: userId,
          username: username.trim().toLowerCase(),
          display_name: (displayName || username).trim()
        }
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    return c.json({ success: false, error: 'Registration failed' }, 500);
  }
});

// Login
auth.post('/login', async (c) => {
  try {
    const body = await c.req.json();
    const { username, password } = body;

    if (!username || !password) {
      return c.json({ success: false, error: 'Username and password required' }, 400);
    }

    // Get user
    const user = await c.env.DB.prepare(`
      SELECT id, username, password_hash, display_name, avatar_url
      FROM users WHERE username = ? COLLATE NOCASE
    `).bind(username.trim()).first<{
      id: string;
      username: string;
      password_hash: string;
      display_name: string;
      avatar_url: string | null;
    }>();

    if (!user) {
      // Timing-safe: still do a password hash to prevent timing attacks
      await hashPassword(password);
      return c.json({ success: false, error: 'Invalid username or password' }, 401);
    }

    // Verify password
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return c.json({ success: false, error: 'Invalid username or password' }, 401);
    }

    // Create session
    const token = generateToken();
    const tokenHash = await hashToken(token);
    const sessionId = generateId();
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

    await c.env.DB.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      sessionId,
      user.id,
      tokenHash,
      expiresAt,
      c.req.header('CF-Connecting-IP') || '',
      c.req.header('User-Agent') || ''
    ).run();

    // Set session cookie
    setCookie(c, 'session', token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      maxAge: 30 * 24 * 60 * 60 // 30 days
    });

    return c.json({
      success: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          display_name: user.display_name,
          avatar_url: user.avatar_url
        }
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    return c.json({ success: false, error: 'Login failed' }, 500);
  }
});

// Logout
auth.post('/logout', async (c) => {
  const session = c.get('session');

  if (session) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(session.id).run();
  }

  deleteCookie(c, 'session', { path: '/' });

  return c.json({ success: true });
});

// Get current user
auth.get('/me', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }

  return c.json({
    success: true,
    data: { user }
  });
});

// Update profile
auth.patch('/profile', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }

  try {
    const body = await c.req.json();
    const { displayName } = body;

    if (displayName !== undefined) {
      const validation = validateDisplayName(displayName);
      if (!validation.valid) {
        return c.json({ success: false, error: validation.error }, 400);
      }

      await c.env.DB.prepare(`
        UPDATE users SET display_name = ?, updated_at = unixepoch()
        WHERE id = ?
      `).bind(displayName.trim(), user.id).run();
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Profile update error:', error);
    return c.json({ success: false, error: 'Update failed' }, 500);
  }
});

// Change password
auth.post('/change-password', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }

  try {
    const body = await c.req.json();
    const { currentPassword, newPassword } = body;

    if (!currentPassword || !newPassword) {
      return c.json({ success: false, error: 'Current and new password required' }, 400);
    }

    const validation = validatePassword(newPassword);
    if (!validation.valid) {
      return c.json({ success: false, error: validation.error }, 400);
    }

    // Verify current password
    const userRecord = await c.env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?'
    ).bind(user.id).first<{ password_hash: string }>();

    if (!userRecord) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }

    const valid = await verifyPassword(currentPassword, userRecord.password_hash);
    if (!valid) {
      return c.json({ success: false, error: 'Current password is incorrect' }, 401);
    }

    // Update password
    const newHash = await hashPassword(newPassword);
    await c.env.DB.prepare(`
      UPDATE users SET password_hash = ?, updated_at = unixepoch()
      WHERE id = ?
    `).bind(newHash, user.id).run();

    // Invalidate all other sessions
    const session = c.get('session');
    if (session) {
      await c.env.DB.prepare(
        'DELETE FROM sessions WHERE user_id = ? AND id != ?'
      ).bind(user.id, session.id).run();
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Password change error:', error);
    return c.json({ success: false, error: 'Password change failed' }, 500);
  }
});

export default auth;
