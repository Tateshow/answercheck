const socket = io();

const screens = {
  join: document.getElementById('screen-join'),
  waiting: document.getElementById('screen-waiting'),
  question: document.getElementById('screen-question'),
  result: document.getElementById('screen-result'),
  ended: document.getElementById('screen-ended'),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => (s.style.display = 'none'));
  screens[name].style.display = 'block';
}

let hasAnsweredCurrent = false;
let timerHandle = null;
let myCode = null;

// URLの ?code=xxxxx を入力欄に自動反映（QRコード経由での参加を想定）
const urlParams = new URLSearchParams(window.location.search);
const codeFromUrl = urlParams.get('code');
if (codeFromUrl) document.getElementById('code-input').value = codeFromUrl;

// --- 参加 / 再接続 ---

const savedCode = localStorage.getItem('roomCode');
const savedPlayerId = localStorage.getItem('playerId');

socket.on('connect', () => {
  if (savedCode && savedPlayerId) {
    myCode = savedCode;
    socket.emit('player:rejoin', { code: savedCode, playerId: savedPlayerId }, (res) => {
      if (!res || !res.ok) {
        localStorage.removeItem('roomCode');
        localStorage.removeItem('playerId');
        myCode = null;
        showScreen('join');
      }
    });
  } else {
    showScreen('join');
  }
});

document.getElementById('btn-join').onclick = doJoin;
['name-input', 'code-input'].forEach((id) => {
  document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });
});

function doJoin() {
  const code = document.getElementById('code-input').value.trim();
  const name = document.getElementById('name-input').value;
  if (!code) {
    document.getElementById('join-error').textContent = 'ルームコードを入力してください';
    return;
  }
  socket.emit('player:join', { code, name }, (res) => {
    if (!res.ok) {
      document.getElementById('join-error').textContent = res.error;
      return;
    }
    myCode = code;
    localStorage.setItem('roomCode', code);
    localStorage.setItem('playerId', res.playerId);
    document.getElementById('join-error').textContent = '';
  });
}

// --- 状態反映 ---

socket.on('player:state', (state) => {
  applyScore(state.score);
  if (state.question) {
    hasAnsweredCurrent = state.hasAnswered;
    renderQuestion(state.question, hasAnsweredCurrent);
  } else if (state.phase === 'ended') {
    showScreen('ended');
  } else {
    showScreen('waiting');
    document.getElementById('waiting-message').textContent =
      state.phase === 'closed' ? '集計中です…' : 'ホストが問題を出題するまでお待ちください。';
  }
});

socket.on('player:question', (q) => {
  hasAnsweredCurrent = false;
  renderQuestion(q, false);
});

socket.on('player:waiting', (data) => {
  clearInterval(timerHandle);
  showScreen('waiting');
  document.getElementById('waiting-message').textContent = data.message || '集計中です…';
});

socket.on('player:results', (payload) => {
  clearInterval(timerHandle);
  const mine = payload.players.find((p) => p.playerId === myPlayerId());
  showScreen('result');
  const headline = document.getElementById('result-headline');
  const detail = document.getElementById('result-detail');
  if (mine) {
    headline.textContent = mine.correct ? '正解！' : '不正解';
    headline.style.color = mine.correct ? '#1f9d55' : '#d64545';
  } else {
    headline.textContent = '結果発表';
  }
  detail.textContent = `問題: ${payload.questionText}`;
  document.getElementById('result-score').textContent = mine ? mine.score : 0;
});

socket.on('player:ended', (data) => {
  clearInterval(timerHandle);
  showScreen('ended');
  const list = document.getElementById('final-leaderboard');
  list.innerHTML = '';
  data.leaderboard.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = `${p.name} — ${p.score}点`;
    list.appendChild(li);
  });
});

socket.on('player:error', (data) => {
  alert(data.error);
});

function renderQuestion(q, alreadyAnswered) {
  showScreen('question');
  document.getElementById('question-text').textContent = q.text;
  const choicesEl = document.getElementById('choices');
  choicesEl.innerHTML = '';
  const note = document.getElementById('submitted-note');
  note.style.display = alreadyAnswered ? 'block' : 'none';

  q.choices.forEach((choice, index) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.textContent = choice;
    btn.disabled = alreadyAnswered;
    btn.onclick = () => {
      if (hasAnsweredCurrent) return;
      hasAnsweredCurrent = true;
      Array.from(choicesEl.children).forEach((c) => (c.disabled = true));
      btn.classList.add('selected');
      note.style.display = 'block';
      socket.emit('player:submitAnswer', { code: myCode, choiceIndex: index });
    };
    choicesEl.appendChild(btn);
  });

  clearInterval(timerHandle);
  const timerEl = document.getElementById('question-timer');
  const tick = () => {
    const remaining = Math.max(0, Math.round((q.deadline - Date.now()) / 1000));
    timerEl.textContent = `残り ${remaining} 秒`;
    if (remaining <= 0) clearInterval(timerHandle);
  };
  tick();
  timerHandle = setInterval(tick, 1000);
}

function applyScore(score) {
  const waitingScore = document.getElementById('waiting-score');
  if (waitingScore) waitingScore.textContent = score;
}

function myPlayerId() {
  return localStorage.getItem('playerId');
}
