
import { Env, WSMessage } from '../types';

export async function broadcastToBoard(env: Env, boardId: string, message: WSMessage) {
  const id = env.BOARD_ROOM.idFromName(boardId);
  const stub = env.BOARD_ROOM.get(id);

  await stub.fetch(new Request('https://internal/broadcast', {
    method: 'POST',
    body: JSON.stringify(message)
  }));
}
