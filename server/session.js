const { v4: uuidv4 } = require('uuid');

/**
 * 単一セッション（1回のクイズ/謎解きイベント）分の状態を保持するインメモリのマネージャ。
 * MVPでは選択式問題のみを対象とし、正誤は自動採点した上でホストが上書きできる。
 */
function createSessionManager(questions) {
  const state = {
    questions,
    currentIndex: -1,
    phase: 'idle', // idle | accepting | closed | published | ended
    deadline: null,
    players: new Map(), // playerId -> player
    socketToPlayer: new Map(), // socketId -> playerId
  };

  function currentQuestion() {
    return state.currentIndex >= 0 && state.currentIndex < state.questions.length
      ? state.questions[state.currentIndex]
      : null;
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
      score: 0,
      answers: new Map(), // questionId -> { choiceIndex, correct, auto, judged }
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

  function startQuestion(index, durationSec) {
    if (index < 0 || index >= state.questions.length) return null;
    state.currentIndex = index;
    state.phase = 'accepting';
    const seconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 30;
    state.deadline = Date.now() + seconds * 1000;
    const q = state.questions[index];
    // 出題し直された場合に備え、この問題への既存回答はクリアする。
    for (const p of state.players.values()) {
      p.answers.delete(q.id);
    }
    return { id: q.id, text: q.text, choices: q.choices, deadline: state.deadline };
  }

  function submitAnswer(socketId, choiceIndex) {
    if (state.phase !== 'accepting') return { ok: false, error: '現在は受付時間外です' };
    const player = getPlayerBySocket(socketId);
    if (!player) return { ok: false, error: '参加者情報が見つかりません' };
    const q = currentQuestion();
    if (!q) return { ok: false, error: '出題中の問題がありません' };
    if (typeof choiceIndex !== 'number' || choiceIndex < 0 || choiceIndex >= q.choices.length) {
      return { ok: false, error: '選択肢が不正です' };
    }
    const correct = choiceIndex === q.correctIndex;
    player.answers.set(q.id, { choiceIndex, correct, auto: true, judged: true });
    return { ok: true };
  }

  function closeAnswers() {
    if (state.phase === 'accepting') state.phase = 'closed';
  }

  function overrideJudgment(playerId, correct) {
    const player = state.players.get(playerId);
    const q = currentQuestion();
    if (!player || !q) return;
    const existing = player.answers.get(q.id) || { choiceIndex: null, auto: false };
    player.answers.set(q.id, { ...existing, correct: !!correct, auto: false, judged: true });
  }

  function publishResults() {
    const q = currentQuestion();
    if (!q) return { questionId: null, correctIndex: null, players: [] };
    const results = [];
    for (const p of state.players.values()) {
      const ans = p.answers.get(q.id);
      const correct = !!(ans && ans.correct);
      if (correct) p.score += q.points || 1;
      results.push({
        playerId: p.id,
        name: p.name,
        choiceIndex: ans ? ans.choiceIndex : null,
        correct,
        score: p.score,
      });
    }
    state.phase = 'published';
    return { questionId: q.id, questionText: q.text, correctIndex: q.correctIndex, players: results };
  }

  function endSession() {
    state.phase = 'ended';
    return getLeaderboard();
  }

  function getLeaderboard() {
    return Array.from(state.players.values())
      .map((p) => ({ playerId: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
  }

  function getPublicState() {
    const q = currentQuestion();
    return {
      phase: state.phase,
      currentIndex: state.currentIndex,
      totalQuestions: state.questions.length,
      questionText: q ? q.text : null,
      deadline: state.deadline,
    };
  }

  function getQuestionSummaries() {
    return state.questions.map((q, i) => ({ index: i, id: q.id, text: q.text }));
  }

  function getPlayerSummaries() {
    return Array.from(state.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: p.score,
    }));
  }

  function getAnswerSummaries() {
    const q = currentQuestion();
    if (!q) return [];
    return Array.from(state.players.values()).map((p) => {
      const ans = p.answers.get(q.id);
      return {
        playerId: p.id,
        name: p.name,
        choiceIndex: ans ? ans.choiceIndex : null,
        submitted: !!ans,
        correct: ans ? ans.correct : null,
        auto: ans ? ans.auto : null,
      };
    });
  }

  function getStateForPlayer(playerId) {
    const player = state.players.get(playerId);
    const q = currentQuestion();
    return {
      phase: state.phase,
      score: player ? player.score : 0,
      question:
        q && state.phase === 'accepting'
          ? { id: q.id, text: q.text, choices: q.choices, deadline: state.deadline }
          : null,
      hasAnswered: q && player ? player.answers.has(q.id) : false,
    };
  }

  return {
    hasNameTaken,
    addPlayer,
    getPlayerBySocket,
    reconnectPlayer,
    markDisconnected,
    startQuestion,
    submitAnswer,
    closeAnswers,
    overrideJudgment,
    publishResults,
    endSession,
    getLeaderboard,
    getPublicState,
    getQuestionSummaries,
    getPlayerSummaries,
    getAnswerSummaries,
    getStateForPlayer,
  };
}

module.exports = { createSessionManager };
