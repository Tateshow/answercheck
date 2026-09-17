const { v4: uuidv4 } = require('uuid');
const { createSessionManager } = require('./session');

/**
 * 複数ルーム（セッション）を並行運用するためのマネージャ。
 *
 * - code: プレーヤーに共有する5桁の入室コード（公開情報）
 * - hostToken: ホストのブラウザだけが持つ再接続用の秘密トークン（非公開）
 *
 * プレーヤーは code だけでルームに参加できるが、ホスト操作（出題・採点・公開など）は
 * そのルームの hostToken を知っているソケットからしか行えないようにし、
 * 入室コードを知っただけの第三者がホスト権限を奪えないようにする。
 */
function createRoomManager(defaultQuestions) {
  const roomsByCode = new Map(); // code -> room
  const codeByToken = new Map(); // hostToken -> code

  function generateCode() {
    let code;
    do {
      code = String(Math.floor(10000 + Math.random() * 90000)); // 常に5桁
    } while (roomsByCode.has(code));
    return code;
  }

  function createRoom(questions = defaultQuestions) {
    const code = generateCode();
    const hostToken = uuidv4();
    const room = {
      code,
      hostToken,
      session: createSessionManager(questions),
      hostSocketId: null,
      createdAt: Date.now(),
    };
    roomsByCode.set(code, room);
    codeByToken.set(hostToken, code);
    return room;
  }

  function getRoomByCode(code) {
    return roomsByCode.get(code) || null;
  }

  function getRoomByHostToken(hostToken) {
    const code = codeByToken.get(hostToken);
    return code ? roomsByCode.get(code) : null;
  }

  function closeRoom(code) {
    const room = roomsByCode.get(code);
    if (!room) return;
    codeByToken.delete(room.hostToken);
    roomsByCode.delete(code);
  }

  return { createRoom, getRoomByCode, getRoomByHostToken, closeRoom };
}

module.exports = { createRoomManager };
