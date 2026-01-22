// Broadcast utility - No-op since we removed Durable Objects
// Changes will sync via polling instead

import { Env, WSMessage } from '../types';

// This function is now a no-op - polling handles sync
export async function broadcastToBoard(env: Env, boardId: string, message: WSMessage) {
  // No longer broadcasting via WebSocket
  // Clients poll for updates instead
}
