const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { createRoomManager } = require('./roomManager');

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

const roomManager = createRoomManager();

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
    players: room.session.getPlayerSummaries(),
    answers: room.session.getAnswerSummaries(),
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

  socket.on('player:submitAnswer', ({ code, text } = {}) => {
    const room = roomManager.getRoomByCode(code);
    if (!room) return;
    const result = room.session.submitAnswer(socket.id, text);
    if (!result.ok) {
      socket.emit('player:error', { error: result.error });
      return;
    }
    socket.emit('player:answerAccepted', { text: String(text || '').trim() });
    io.to(hostRoom(code)).emit('host:answers', room.session.getAnswerSummaries());
  });

  // プレーヤーが自分の意思でルームを退出する。データは残るので、同じルームコードで
  // 再入室（player:join → 保存済みのplayerIdと一致すればplayer:rejoin扱い）すれば復元される。
  socket.on('player:leaveRoom', ({ code } = {}, ack) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role !== 'player' || meta.code !== code) {
      if (ack) ack({ ok: false });
      return;
    }
    const room = roomManager.getRoomByCode(code);
    if (room) {
      room.session.leaveRoom(meta.playerId);
      io.to(hostRoom(code)).emit('host:players', room.session.getPlayerSummaries());
    }
    socket.leave(playerRoom(code));
    socketMeta.delete(socket.id);
    if (ack) ack({ ok: true });
  });

  // --- ホスト操作: すべて自分のホストルームに属する code に対してのみ許可 ---

  function requireHostRoom(code) {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role !== 'host' || meta.code !== code) return null;
    return roomManager.getRoomByCode(code);
  }

  socket.on('host:startRound', ({ code, durationSec, acceptedAnswersRaw, allowResubmit, resultOrder, revealStyle } = {}, ack) => {
    const room = requireHostRoom(code);
    if (!room) return;
    const result = room.session.startRound({ durationSec, acceptedAnswersRaw, allowResubmit, resultOrder, revealStyle });
    if (!result.ok) {
      if (ack) ack(result);
      return;
    }
    if (ack) ack(result);
    io.to(playerRoom(code)).emit('player:round', result.round);
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
    const standings = room.session.getStandings();
    io.to(playerRoom(code)).emit('player:results', payload);
    io.to(playerRoom(code)).emit('player:standings', standings);
    io.to(hostRoom(code)).emit('host:state', room.session.getPublicState());
    io.to(hostRoom(code)).emit('host:results', payload);
    io.to(hostRoom(code)).emit('host:standings', standings);
    io.to(hostRoom(code)).emit('host:players', room.session.getPlayerSummaries());
  });

  socket.on('host:endSession', ({ code } = {}) => {
    const room = requireHostRoom(code);
    if (!room) return;
    const standings = room.session.endSession();
    io.to(playerRoom(code)).emit('player:ended', { ranking: standings.ranking });
    io.to(hostRoom(code)).emit('host:state', room.session.getPublicState());
    io.to(hostRoom(code)).emit('host:ranking', standings.ranking);
  });

  // ルームを完全に解散する。入室コードそのものを無効化するので、以降は誰も参加・再接続できない。
  socket.on('host:dissolveRoom', ({ code } = {}, ack) => {
    const room = requireHostRoom(code);
    if (!room) {
      if (ack) ack({ ok: false });
      return;
    }
    io.to(playerRoom(code)).emit('player:roomDissolved', {});
    const playerSocketIds = io.sockets.adapter.rooms.get(playerRoom(code));
    if (playerSocketIds) {
      for (const sid of Array.from(playerSocketIds)) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.leave(playerRoom(code));
        socketMeta.delete(sid);
      }
    }
    socket.leave(hostRoom(code));
    socketMeta.delete(socket.id);
    roomManager.closeRoom(code);
    if (ack) ack({ ok: true });
  });

  // ホスト権限を、現在接続中の参加者の1人に譲る。譲った側（自分）は新しいニックネームで
  // プレーヤーとしてそのルームに参加し直し、譲られた側のブラウザはホスト画面へ切り替わる。
  socket.on('host:transferHost', ({ code, targetPlayerId, newHostNickname } = {}, ack) => {
    const room = requireHostRoom(code);
    if (!room) {
      if (ack) ack({ ok: false, error: 'ルームが見つかりません' });
      return;
    }
    const targetPlayer = room.session.getPlayerById(targetPlayerId);
    if (!targetPlayer || !targetPlayer.connected) {
      if (ack) ack({ ok: false, error: '指定した参加者が見つからないか、接続していません' });
      return;
    }
    const nickname = String(newHostNickname || '').trim().slice(0, 20);
    if (!nickname) {
      if (ack) ack({ ok: false, error: 'ニックネームを入力してください' });
      return;
    }
    if (room.session.hasNameTaken(nickname)) {
      if (ack) ack({ ok: false, error: 'その名前は既に使われています' });
      return;
    }

    const targetSocketId = targetPlayer.socketId;
    room.session.removePlayer(targetPlayerId);
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) targetSocket.leave(playerRoom(code));
    socketMeta.delete(targetSocketId);
    const newHostToken = roomManager.rotateHostToken(code);
    // 自分（元ホスト）を新しいプレイヤーとして登録する。今のソケットで一旦登録するが、
    // このあとブラウザがplayer.htmlへ遷移して再接続するとplayer:rejoinで上書きされる。
    const newPlayer = room.session.addPlayer(socket.id, nickname);
    socket.leave(hostRoom(code));
    socket.join(playerRoom(code));
    socketMeta.set(socket.id, { code, role: 'player', playerId: newPlayer.id });

    io.to(targetSocketId).emit('player:promotedToHost', { hostToken: newHostToken });
    if (ack) ack({ ok: true, code, playerId: newPlayer.id, name: newPlayer.name });

    io.to(hostRoom(code)).emit('host:players', room.session.getPlayerSummaries());
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
