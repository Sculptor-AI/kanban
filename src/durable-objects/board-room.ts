// Durable Object for real-time board collaboration

import type { Env, WSMessage } from '../types';
import { hashToken } from '../utils/crypto';

interface WebSocketWithData extends WebSocket {
  userId?: string;
  username?: string;
}

export class BoardRoom {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Map<WebSocket, { userId: string; username: string }>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    // Handle broadcast from API
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const message = await request.json() as WSMessage;
      this.broadcast(message);
      return new Response('OK');
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    const boardId = url.searchParams.get('boardId');

    if (!token || !boardId) {
      return new Response('Missing token or boardId', { status: 400 });
    }

    // Verify session token
    const tokenHash = await hashToken(token);
    const session = await this.env.DB.prepare(`
      SELECT s.user_id, u.username, u.display_name
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at > unixepoch()
    `).bind(tokenHash).first<{ user_id: string; username: string; display_name: string }>();

    if (!session) {
      return new Response('Invalid session', { status: 401 });
    }

    // Verify board access
    const access = await this.env.DB.prepare(`
      SELECT 1 FROM board_members WHERE board_id = ? AND user_id = ?
    `).bind(boardId, session.user_id).first();

    if (!access) {
      return new Response('Access denied', { status: 403 });
    }

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket
    this.state.acceptWebSocket(server);

    // Store session info
    this.sessions.set(server, {
      userId: session.user_id,
      username: session.display_name || session.username
    });

    // Send current online count to the new user
    server.send(JSON.stringify({
      type: 'user_joined',
      payload: {
        userId: session.user_id,
        username: session.display_name || session.username,
        onlineCount: this.uniqueUserCount
      }
    }));

    // Notify others of new user
    this.broadcast({
      type: 'user_joined',
      payload: {
        userId: session.user_id,
        username: session.display_name || session.username,
        onlineCount: this.uniqueUserCount
      }
    }, server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = this.sessions.get(ws);
    if (!session) return;

    try {
      const data = JSON.parse(message as string) as WSMessage;

      // Handle different message types
      switch (data.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        case 'cursor_move':
        case 'card_drag_start':
        case 'card_drag_end':
          // Broadcast cursor/drag events to other users
          this.broadcast({
            type: data.type,
            payload: {
              ...data.payload as object,
              userId: session.userId,
              username: session.username
            }
          }, ws);
          break;

        default:
          // For other events, just broadcast with user info
          this.broadcast({
            type: data.type,
            payload: {
              ...data.payload as object,
              userId: session.userId
            }
          }, ws);
      }
    } catch (e) {
      console.error('WebSocket message error:', e);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);

    if (session) {
      this.broadcast({
        type: 'user_left',
        payload: {
          userId: session.userId,
          username: session.username,
          onlineCount: this.uniqueUserCount
        }
      });
    }
  }

  private get uniqueUserCount(): number {
    const uniqueUsers = new Set<string>();
    for (const session of this.sessions.values()) {
      uniqueUsers.add(session.userId);
    }
    return uniqueUsers.size;
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
    this.sessions.delete(ws);
  }

  private broadcast(message: WSMessage, exclude?: WebSocket): void {
    const json = JSON.stringify(message);

    for (const ws of this.state.getWebSockets()) {
      if (ws !== exclude) {
        try {
          ws.send(json);
        } catch (e) {
          // Socket might be closed
        }
      }
    }
  }
}
