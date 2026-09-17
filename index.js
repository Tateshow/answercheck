const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { createRoomManager } = require('./roomManager');
const questions = require('./questions.sample.json');

const PORT = process.env.PORT || 3000;

const app = express();
// このアプリは同一Wi-Fi内での小規模利用が主目的で、パフォーマンスよりも
// 「アップデートしたファイルがブラウザに確実に反映されること」を優先し、
// 静的ファイルはキャッシュさせない（no-store）。
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  })
);

const server = http.createServer(app);
const io = new Server(server);

const roomManager = createRoomManager(questions);

// socket.id -> { code, role: 'host' | 'player', playerId? }
const socketMeta = new Map();

function localIPs() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) results.push(net.address);
    }
  }
  return results;
}

// クラウド（Render等）にデプロイした場合は、そのサービスの公開URLを使う。
// Renderは RENDER_EXTERNAL_URL を自動で設定してくれるので、それがあれば優先する。
// 他のクラウドサービスでも、環境変数 PUBLIC_BASE_URL を手動で設定すれば同様に使える。
// どちらも無ければ、ローカルネットワーク運用とみなしPCのIPアドレスを使う。
function publicBaseUrl() {
  const fromEnv = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const ips = localIPs();
  const host = ips.length ? ips[0] : 'localhost';
  return `http://${host}:${PORT}`;
}

function joinUrl(code) {
  return `${publicBaseUrl()}/player.html?code=${code}`;
}

function hostRoom(code) {
  return `host:${code}`;
}

function playerRoom(code) {
  return `players:${code}`;
}

async function hostSnapshot(room) {
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(joinUrl(room.code));
  } catch (err) {
    console.error('QRコード生成に失敗しました', err);
  }
  return {
    ok: true,
    code: room.code,
    hostToken: room.hostToken,
    joinUrl: joinUrl(room.code),
    qrDataUrl,
    state: room.session.getPublicState(),
    questions: room.session.getQuestionSummaries(),
    players: room.session.getPlayerSummaries(),
    answers: room.session.getAnswerSummaries(),
    leaderboard: room.session.getLeaderboard(),
  };
}

io.on('connection', (socket) => {
  // --- ホスト: ルーム作成 / 再接続 ---

  socket.on('host:createRoom', async (_payload, ack) => {
    const room = roomManager.createRoom();
    room.hostSocketId = socket.id;
    socket.join(hostRoom(room.code));
    socketMeta.set(socket.id, { code: room.code, role: 'host' });
    if (ack) ack(await hostSnapshot(room));
  });

  socket.on('host:resumeRoom', async ({ hostToken } = {}, ack) => {
    const room = roomManager.getRoomByHostToken(hostToken);
    if (!room) {
      if (ack) ack({ ok: false, error: 'このルームは見つかりませんでした（サーバー再起動などで失効した可能性があります）' });
      return;
    }
    room.hostSocketId = socket.id;
    socket.join(hostRoom(room.code));
    socketMeta.set(socket.id, { code: room.code, role: 'host' });
    if (ack) ack(await hostSnapshot(room));
  });

  // --- プレーヤー: 参加 / 再接続 ---

  socket.on('player:join', ({ code, name } = {}, ack) => {
    const room = roomManager.getRoomByCode(code);
    if (!room) {
      if (ack) ack({ ok: false, error: 'ルームコードが見つかりません。コードを確認してください' });
      return;
    }
    const trimmed = (name || '').trim().slice(0, 20);
    if (!trimmed) {
      if (ack) ack({ ok: false, error: '名前を入力してください' });
      return;
    }
    if (room.session.hasNameTaken(trimmed)) {
      if (ack) ack({ ok: false, error: 'その名前は既に使われています' });
      return;
    }
    const player = room.session.addPlayer(socket.id, trimmed);
    socket.join(playerRoom(code));
    socketMeta.set(socket.id, { code, role: 'player', playerId: player.id });
    if (ack) ack({ ok: true, code, playerId: player.id, name: player.name });
    socket.emit('player:state', room.session.getStateForPlayer(player.id));
    io.to(hostRoom(code)).emit('host:players', room.session.getPlayerSummaries());
  });

  socket.on('player:rejoin', ({ code, playerId } = {}, ack) => {
    const room = roomManager.getRoomByCode(code);
    if (!room) {
      if (ack) ack({ ok: false });
      return;
    }
    const player = room.session.reconnectPlayer(playerId, socket.id);
    if (!player) {
      if (ack) ack({ ok: false });
      return;
    }
    socket.join(playerRoom(code));
    socketMeta.set(socket.id, { code, role: 'player', playerId });
    if (ack) ack({ ok: true, name: player.name });
    socket.emit('player:state', room.session.getStateForPlayer(playerId));
    io.to(hostRoom(code)).emit('host:players', room.session.getPlayerSummaries());
  });

  socket.on('player:submitAnswer', ({ code, choiceIndex } = {}) => {
    const room = roomManager.getRoomByCode(code);
    if (!room) return;
    const result = room.session.submitAnswer(socket.id, choiceIndex);
    if (!result.ok) {
      socket.emit('player:error', { error: result.error });
      return;
    }
    io.to(hostRoom(code)).emit('host:answers', room.session.getAnswerSummaries());
  });

  // --- ホスト操作: すべて自分のホストルームに属する code に対してのみ許可 ---

  function requireHostRoom(code) {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role !== 'host' || meta.code !== code) return null;
    return roomManager.getRoomByCode(code);
  }

  socket.on('host:startQuestion', ({ code, index, durationSec } = {}) => {
    const room = requireHostRoom(code);
    if (!room) return;
    const q = room.session.startQuestion(index, durationSec);
    if (!q) return;
    io.to(playerRoom(code)).emit('player:question', q);
    io.to(hostRoom(code)).emit('host:state', room.session.getPublicState());
    io.to(hostRoom(code)).emit('host:answers', room.session.getAnswerSummaries());
  });

  socket.on('host:closeAnswers', ({ code } = {}) => {
    const room = requireHostRoom(code);
    if (!room) return;
    room.session.closeAnswers();
    io.to(playerRoom(code)).emit('player:waiting', { message: '集計中です…' });
    io.to(hostRoom(code)).emit('host:state', room.session.getPublicState());
    io.to(hostRoom(code)).emit('host:answers', room.session.getAnswerSummaries());
  });

  socket.on('host:overrideJudgment', ({ code, playerId, correct } = {}) => {
    const room = requireHostRoom(code);
    if (!room) return;
    room.session.overrideJudgment(playerId, correct);
    io.to(hostRoom(code)).emit('host:answers', room.session.getAnswerSummaries());
  });

  socket.on('host:publishResults', ({ code } = {}) => {
    const room = requireHostRoom(code);
    if (!room) return;
    const payload = room.session.publishResults();
    io.to(playerRoom(code)).emit('player:results', payload);
    io.to(hostRoom(code)).emit('host:state', room.session.getPublicState());
    io.to(hostRoom(code)).emit('host:leaderboard', room.session.getLeaderboard());
  });

  socket.on('host:endSession', ({ code } = {}) => {
    const room = requireHostRoom(code);
    if (!room) return;
    const leaderboard = room.session.endSession();
    io.to(playerRoom(code)).emit('player:ended', { leaderboard });
    io.to(hostRoom(code)).emit('host:state', room.session.getPublicState());
  });

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socketMeta.delete(socket.id);
    const room = roomManager.getRoomByCode(meta.code);
    if (!room) return;
    if (meta.role === 'player') {
      room.session.markDisconnected(meta.playerId);
      io.to(hostRoom(meta.code)).emit('host:players', room.session.getPlayerSummaries());
    }
    // ホストの切断は室を閉じない（ページ再読み込み等で hostToken により復帰できるようにするため）。
  });
});

server.listen(PORT, () => {
  console.log('== 回答一斉確認アプリ (MVP / ルーム対応) ==');
  console.log(`公開URL      : ${publicBaseUrl()}`);
  console.log(`ホスト画面   : ${publicBaseUrl()}/host.html`);
  console.log(`プレーヤー画面: ${publicBaseUrl()}/player.html （実際の参加にはホスト画面が発行するルームコードが必要です）`);
});
