const socket = io();

let code = null;
let questions = [];
let currentQuestionIndex = -1;

const el = {
  screenStart: document.getElementById('screen-start'),
  screenMain: document.getElementById('screen-main'),
  startStatus: document.getElementById('start-status'),
  startError: document.getElementById('start-error'),
  btnCreate: document.getElementById('btn-create'),
  roomCode: document.getElementById('room-code'),
  joinUrl: document.getElementById('join-url'),
  qr: document.getElementById('qr'),
  questionList: document.getElementById('question-list'),
  playerList: document.getElementById('player-list'),
  playerCount: document.getElementById('player-count'),
  currentStatus: document.getElementById('current-status'),
  currentControls: document.getElementById('current-controls'),
  btnClose: document.getElementById('btn-close'),
  btnPublish: document.getElementById('btn-publish'),
  answerTable: document.getElementById('answer-table'),
  leaderboard: document.getElementById('leaderboard'),
  btnEnd: document.getElementById('btn-end'),
};

const savedHostToken = localStorage.getItem('hostToken');

el.startStatus.textContent = 'サーバーに接続中…';

socket.on('connect', () => {
  el.startError.textContent = '';
  if (savedHostToken) {
    el.startStatus.textContent = '前回のルームに再接続しています…';
    emitWithTimeout('host:resumeRoom', { hostToken: savedHostToken }, (res) => {
      el.startStatus.textContent = '';
      if (res.ok) {
        enterRoom(res);
      } else {
        localStorage.removeItem('hostToken');
        el.startError.textContent = res.error || '';
      }
    });
  } else {
    el.startStatus.textContent = '';
  }
});

socket.on('connect_error', (err) => {
  console.error('socket connect_error', err);
  el.startStatus.textContent = '';
  el.startError.textContent = 'サーバーに接続できません。サーバー（npm start）が起動しているか確認してください。';
});

socket.io.on('reconnect_attempt', () => {
  el.startStatus.textContent = 'サーバーに再接続を試みています…';
});

el.btnCreate.onclick = () => {
  el.btnCreate.disabled = true;
  el.startError.textContent = '';
  el.startStatus.textContent = 'ルームを作成しています…';
  emitWithTimeout('host:createRoom', {}, (res) => {
    el.btnCreate.disabled = false;
    el.startStatus.textContent = '';
    if (!res) {
      el.startError.textContent = 'サーバーから応答がありません。ページを再読み込みするか、サーバーを再起動して最新版のファイルで npm start しているか確認してください。';
      return;
    }
    if (res.ok) {
      localStorage.setItem('hostToken', res.hostToken);
      enterRoom(res);
    } else {
      el.startError.textContent = res.error || 'ルームの作成に失敗しました';
    }
  });
};

// サーバーが古いまま（イベントを認識しない）だとACKが永遠に来ないことがあるため、
// 一定時間で諦めてエラーを表示する。
function emitWithTimeout(event, payload, callback, timeoutMs = 5000) {
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    callback(null);
  }, timeoutMs);
  socket.emit(event, payload, (res) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    callback(res);
  });
}

function enterRoom(data) {
  code = data.code;
  el.screenStart.style.display = 'none';
  el.screenMain.style.display = 'block';
  el.roomCode.textContent = data.code;
  el.joinUrl.textContent = data.joinUrl;
  if (data.qrDataUrl) el.qr.src = data.qrDataUrl;
  questions = data.questions;
  renderQuestionList();
  applyState(data.state);
  if (data.players) renderPlayers(data.players);
  if (data.answers) renderAnswers(data.answers);
  if (data.leaderboard) renderLeaderboard(data.leaderboard);
}

socket.on('host:state', applyState);
socket.on('host:players', renderPlayers);
socket.on('host:answers', renderAnswers);
socket.on('host:leaderboard', renderLeaderboard);

function applyState(state) {
  currentQuestionIndex = state.currentIndex;
  renderQuestionList();

  if (state.currentIndex < 0) {
    el.currentStatus.textContent = 'まだ出題していません';
    el.currentControls.style.display = 'none';
    return;
  }

  el.currentControls.style.display = 'block';
  const label = `問題 ${state.currentIndex + 1} / ${state.totalQuestions}: ${state.questionText}`;
  if (state.phase === 'accepting') {
    el.currentStatus.textContent = `${label}（回答受付中）`;
    el.btnClose.disabled = false;
    el.btnPublish.disabled = true;
  } else if (state.phase === 'closed') {
    el.currentStatus.textContent = `${label}（受付締切・採点中）`;
    el.btnClose.disabled = true;
    el.btnPublish.disabled = false;
  } else if (state.phase === 'published') {
    el.currentStatus.textContent = `${label}（公開済み）`;
    el.btnClose.disabled = true;
    el.btnPublish.disabled = true;
  } else if (state.phase === 'ended') {
    el.currentStatus.textContent = 'セッションは終了しました';
    el.currentControls.style.display = 'none';
  }
}

function renderQuestionList() {
  el.questionList.innerHTML = '';
  questions.forEach((q) => {
    const row = document.createElement('div');
    row.className = 'qlist-item';
    const isActive = q.index === currentQuestionIndex;
    row.innerHTML = `<span>${isActive ? '▶ ' : ''}問題${q.index + 1}: ${escapeHtml(q.text)}</span>`;
    const btn = document.createElement('button');
    btn.textContent = isActive ? '再出題' : '出題する';
    btn.className = isActive ? 'secondary' : '';
    btn.onclick = () => {
      const duration = Number(prompt('回答受付時間（秒）を入力してください', '30')) || 30;
      socket.emit('host:startQuestion', { code, index: q.index, durationSec: duration });
    };
    row.appendChild(btn);
    el.questionList.appendChild(row);
  });
}

function renderPlayers(players) {
  el.playerCount.textContent = players.length;
  el.playerList.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    li.style.padding = '4px 0';
    li.textContent = `${p.name}${p.connected ? '' : '（切断中）'} — ${p.score}点`;
    el.playerList.appendChild(li);
  });
}

function renderAnswers(answers) {
  el.answerTable.innerHTML = '';
  answers.forEach((a) => {
    const tr = document.createElement('tr');
    const choiceLabel = a.submitted ? `選択肢 ${a.choiceIndex + 1}` : '未回答';
    let badge = '<span class="badge pending">未判定</span>';
    if (a.correct === true) badge = `<span class="badge correct">正解${a.auto ? '（自動）' : '（手動）'}</span>`;
    if (a.correct === false) badge = `<span class="badge incorrect">不正解${a.auto ? '（自動）' : '（手動）'}</span>`;

    tr.innerHTML = `
      <td>${escapeHtml(a.name)}</td>
      <td>${choiceLabel}</td>
      <td>${badge}</td>
      <td></td>
    `;
    const actionCell = tr.lastElementChild;
    if (a.submitted) {
      const okBtn = document.createElement('button');
      okBtn.textContent = '○にする';
      okBtn.className = 'secondary';
      okBtn.style.marginRight = '6px';
      okBtn.onclick = () => socket.emit('host:overrideJudgment', { code, playerId: a.playerId, correct: true });

      const ngBtn = document.createElement('button');
      ngBtn.textContent = '×にする';
      ngBtn.className = 'ghost';
      ngBtn.onclick = () => socket.emit('host:overrideJudgment', { code, playerId: a.playerId, correct: false });

      actionCell.appendChild(okBtn);
      actionCell.appendChild(ngBtn);
    }
    el.answerTable.appendChild(tr);
  });
}

function renderLeaderboard(list) {
  el.leaderboard.innerHTML = '';
  list.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = `${p.name} — ${p.score}点`;
    el.leaderboard.appendChild(li);
  });
}

el.btnClose.onclick = () => socket.emit('host:closeAnswers', { code });
el.btnPublish.onclick = () => socket.emit('host:publishResults', { code });
el.btnEnd.onclick = () => {
  if (confirm('セッションを終了し、最終結果をプレーヤーに表示します。よろしいですか？')) {
    socket.emit('host:endSession', { code });
  }
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
