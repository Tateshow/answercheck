const { v4: uuidv4 } = require('uuid');

/**
 * 単一ルーム分の状態を保持するインメモリのマネージャ。
 *
 * 問題文そのものはこのアプリの外（別のスライドや紙など）で提示される前提で、
 * ホストは各ラウンドの開始時に「制限時間」と「自動判定用の正解（表記ゆれ対応で複数可）」
 * だけを入力する。プレーヤーは自由記述で回答し、正誤と回答時間が記録される。
 */

// 表記ゆれをできるだけ吸収するための正規化（前後空白除去・全角英数字/スペースの半角化・大文字小文字無視）。
function normalizeAnswer(raw) {
  if (raw == null) return '';
  return String(raw)
    .trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[　\s]+/g, '')
    .toLowerCase();
}

// 複数の正解候補を改行区切りで受け取り、空行を除いた配列にする。
function parseAcceptedAnswers(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function createSessionManager() {
  const state = {
    phase: 'idle', // idle | accepting | closed | published | ended
    rounds: [], // { index, acceptedAnswers(raw), acceptedNormalized, durationSec, allowResubmit, resultOrder, startedAt, deadline }
    currentRoundIndex: -1,
    players: new Map(), // playerId -> player
    socketToPlayer: new Map(), // socketId -> playerId
    nextJoinSeq: 0,
    // 直近のラウンドで使った設定を次回のフォーム初期値として引き継ぐ。
    lastSettings: { allowResubmit: false, resultOrder: 'speed' },
  };

  function currentRound() {
    return state.currentRoundIndex >= 0 ? state.rounds[state.currentRoundIndex] : null;
  }

  function hasNameTaken(name) {
    for (const p of state.players.values()) {
      if (p.connected && p.name === name) return true;
    }
    return false;
  }

  function addPlayer(socketId, name) {
    const id = uuidv4();
    const player = {
      id,
      name,
      socketId,
      connected: true,
      joinSeq: state.nextJoinSeq++,
      answers: new Map(), // roundIndex -> { text, submittedAt, responseTimeMs, correct, auto, judged }
    };
    state.players.set(id, player);
    state.socketToPlayer.set(socketId, id);
    return player;
  }

  function getPlayerBySocket(socketId) {
    const id = state.socketToPlayer.get(socketId);
    return id ? state.players.get(id) : null;
  }

  function reconnectPlayer(playerId, socketId) {
    const player = state.players.get(playerId);
    if (!player) return null;
    player.socketId = socketId;
    player.connected = true;
    state.socketToPlayer.set(socketId, playerId);
    return player;
  }

  function markDisconnected(playerId) {
    const player = state.players.get(playerId);
    if (player) player.connected = false;
  }

  function startRound({ durationSec, acceptedAnswersRaw, allowResubmit, resultOrder }) {
    const seconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 30;
    const accepted = parseAcceptedAnswers(acceptedAnswersRaw);
    if (accepted.length === 0) return { ok: false, error: '自動判定用の正解を1つ以上入力してください' };

    const round = {
      index: state.rounds.length,
      acceptedAnswersRaw: accepted,
      acceptedNormalized: accepted.map(normalizeAnswer),
      durationSec: seconds,
      allowResubmit: !!allowResubmit,
      resultOrder: resultOrder === 'joinOrder' ? 'joinOrder' : 'speed',
      startedAt: Date.now(),
      deadline: Date.now() + seconds * 1000,
    };
    state.rounds.push(round);
    state.currentRoundIndex = round.index;
    state.phase = 'accepting';
    state.lastSettings = { allowResubmit: round.allowResubmit, resultOrder: round.resultOrder };

    return {
      ok: true,
      round: { index: round.index, durationSec: round.durationSec, deadline: round.deadline, allowResubmit: round.allowResubmit },
    };
  }

  function submitAnswer(socketId, text) {
    if (state.phase !== 'accepting') return { ok: false, error: '現在は受付時間外です' };
    const player = getPlayerBySocket(socketId);
    if (!player) return { ok: false, error: '参加者情報が見つかりません' };
    const round = currentRound();
    if (!round) return { ok: false, error: '出題中の問題がありません' };
    const trimmed = String(text || '').trim();
    if (!trimmed) return { ok: false, error: '回答を入力してください' };

    const existing = player.answers.get(round.index);
    if (existing && !round.allowResubmit) {
      return { ok: false, error: '回答は一度きりの設定です（既に回答済み）' };
    }

    const responseTimeMs = Date.now() - round.startedAt;
    const correct = round.acceptedNormalized.includes(normalizeAnswer(trimmed));
    player.answers.set(round.index, {
      text: trimmed,
      submittedAt: Date.now(),
      responseTimeMs,
      correct,
      auto: true,
      judged: true,
    });
    return { ok: true, correct };
  }

  function closeAnswers() {
    if (state.phase === 'accepting') state.phase = 'closed';
  }

  function overrideJudgment(playerId, correct) {
    const player = state.players.get(playerId);
    const round = currentRound();
    if (!player || !round) return;
    const existing = player.answers.get(round.index) || { text: '', responseTimeMs: null, auto: false };
    player.answers.set(round.index, { ...existing, correct: !!correct, auto: false, judged: true });
  }

  function orderPlayers(list, order) {
    if (order === 'joinOrder') {
      return list.sort((a, b) => a._joinSeq - b._joinSeq);
    }
    // speed: 回答者を回答時間の速い順、未回答者は最後（入室順）
    return list.sort((a, b) => {
      const at = a._responseTimeMs;
      const bt = b._responseTimeMs;
      if (at == null && bt == null) return a._joinSeq - b._joinSeq;
      if (at == null) return 1;
      if (bt == null) return -1;
      return at - bt;
    });
  }

  function publishResults() {
    const round = currentRound();
    if (!round) return { roundIndex: null, acceptedAnswers: [], players: [] };
    const rows = Array.from(state.players.values()).map((p) => {
      const ans = p.answers.get(round.index);
      return {
        playerId: p.id,
        name: p.name,
        text: ans ? ans.text : null,
        correct: !!(ans && ans.correct),
        responseTimeMs: ans ? ans.responseTimeMs : null,
        _responseTimeMs: ans ? ans.responseTimeMs : null,
        _joinSeq: p.joinSeq,
      };
    });
    orderPlayers(rows, round.resultOrder);
    state.phase = 'published';
    return {
      roundIndex: round.index,
      acceptedAnswers: round.acceptedAnswersRaw,
      resultOrder: round.resultOrder,
      players: rows.map(({ _responseTimeMs, _joinSeq, ...rest }) => rest),
    };
  }

  function endSession() {
    state.phase = 'ended';
    return getFinalRanking();
  }

  // タイブレークの公平性のため、未回答の問題は「その問題の制限時間フル」をペナルティとして加算する。
  function getFinalRanking() {
    const list = Array.from(state.players.values()).map((p) => {
      let correctCount = 0;
      let totalResponseTimeMs = 0;
      const breakdown = state.rounds.map((round) => {
        const ans = p.answers.get(round.index);
        const answered = !!ans;
        const correct = !!(ans && ans.correct);
        const responseTimeMs = answered ? ans.responseTimeMs : round.durationSec * 1000;
        if (correct) correctCount += 1;
        totalResponseTimeMs += responseTimeMs;
        return { roundIndex: round.index, answered, correct, responseTimeMs, text: answered ? ans.text : null };
      });
      return { playerId: p.id, name: p.name, correctCount, totalResponseTimeMs, breakdown, _joinSeq: p.joinSeq };
    });
    list.sort((a, b) => b.correctCount - a.correctCount || a.totalResponseTimeMs - b.totalResponseTimeMs || a._joinSeq - b._joinSeq);
    return list.map(({ _joinSeq, ...rest }) => rest);
  }

  function getPublicState() {
    const round = currentRound();
    return {
      phase: state.phase,
      currentRoundIndex: state.currentRoundIndex,
      totalRounds: state.rounds.length,
      round: round ? { index: round.index, durationSec: round.durationSec, deadline: round.deadline, allowResubmit: round.allowResubmit, resultOrder: round.resultOrder } : null,
      lastSettings: state.lastSettings,
    };
  }

  function getPlayerSummaries() {
    return Array.from(state.players.values()).map((p) => {
      let correctCount = 0;
      for (const ans of p.answers.values()) if (ans.correct) correctCount += 1;
      return { id: p.id, name: p.name, connected: p.connected, correctCount };
    });
  }

  function getAnswerSummaries() {
    const round = currentRound();
    if (!round) return [];
    const rows = Array.from(state.players.values()).map((p) => {
      const ans = p.answers.get(round.index);
      return {
        playerId: p.id,
        name: p.name,
        text: ans ? ans.text : null,
        submitted: !!ans,
        correct: ans ? ans.correct : null,
        auto: ans ? ans.auto : null,
        responseTimeMs: ans ? ans.responseTimeMs : null,
        _responseTimeMs: ans ? ans.responseTimeMs : null,
        _joinSeq: p.joinSeq,
      };
    });
    orderPlayers(rows, round.resultOrder);
    return rows.map(({ _responseTimeMs, _joinSeq, ...rest }) => rest);
  }

  function getStateForPlayer(playerId) {
    const player = state.players.get(playerId);
    const round = currentRound();
    const existingAnswer = round && player ? player.answers.get(round.index) : null;
    return {
      phase: state.phase,
      round:
        round && state.phase === 'accepting'
          ? { index: round.index, durationSec: round.durationSec, deadline: round.deadline, allowResubmit: round.allowResubmit }
          : null,
      hasAnswered: !!existingAnswer,
      myAnswerText: existingAnswer ? existingAnswer.text : null,
    };
  }

  return {
    hasNameTaken,
    addPlayer,
    getPlayerBySocket,
    reconnectPlayer,
    markDisconnected,
    startRound,
    submitAnswer,
    closeAnswers,
    overrideJudgment,
    publishResults,
    endSession,
    getFinalRanking,
    getPublicState,
    getPlayerSummaries,
    getAnswerSummaries,
    getStateForPlayer,
  };
}

module.exports = { createSessionManager };
