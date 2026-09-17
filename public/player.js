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

let timerHandle = null;
let myCode = null;
let currentAllowResubmit = false;
let hasAnsweredCurrent = false;

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
  if (state.round) {
    renderRound(state.round, state.hasAnswered, state.myAnswerText);
  } else if (state.phase === 'ended') {
    showScreen('ended');
  } else {
    showScreen('waiting');
    document.getElementById('waiting-message').textContent =
      state.phase === 'closed' ? '集計中です…' : 'ホストが問題を出題するまでお待ちください。';
  }
});

socket.on('player:round', (round) => {
  renderRound(round, false, null);
});

socket.on('player:waiting', (data) => {
  clearInterval(timerHandle);
  showScreen('waiting');
  document.getElementById('waiting-message').textContent = data.message || '集計中です…';
});

socket.on('player:answerAccepted', (data) => {
  hasAnsweredCurrent = true;
  document.getElementById('answer-error').textContent = '';
  document.getElementById('submitted-note').style.display = 'block';
  if (!currentAllowResubmit) {
    document.getElementById('answer-input').disabled = true;
    document.getElementById('btn-submit').disabled = true;
  }
});

socket.on('player:error', (data) => {
  document.getElementById('answer-error').textContent = data.error || '';
});

socket.on('player:results', (payload) => {
  clearInterval(timerHandle);
  showScreen('result');
  const mine = payload.players.find((p) => p.playerId === myPlayerId());
  const headline = document.getElementById('result-headline');
  const detail = document.getElementById('result-detail');
  if (mine) {
    headline.textContent = mine.correct ? '正解！' : '不正解';
    headline.style.color = mine.correct ? '#1f9d55' : '#d64545';
  } else {
    headline.textContent = '結果発表';
  }
  detail.textContent = `正解: ${payload.acceptedAnswers.join(' / ')}`;
  document.getElementById('result-order-label').textContent = payload.resultOrder === 'joinOrder' ? 'ルーム入室順' : '回答が早かった順';

  const list = document.getElementById('result-list');
  list.innerHTML = '';
  payload.players.forEach((p) => {
    const li = document.createElement('li');
    const timeLabel = p.responseTimeMs != null ? `${(p.responseTimeMs / 1000).toFixed(1)}秒` : '未回答';
    const isMe = p.playerId === myPlayerId();
    li.textContent = `${p.name}${isMe ? '（あなた）' : ''} — ${p.correct ? '正解' : '不正解'}（${timeLabel}）`;
    if (isMe) li.style.fontWeight = 'bold';
    list.appendChild(li);
  });
});

socket.on('player:ended', (data) => {
  clearInterval(timerHandle);
  showScreen('ended');
  const list = document.getElementById('final-ranking');
  list.innerHTML = '';
  data.ranking.forEach((p) => {
    const li = document.createElement('li');
    const isMe = p.playerId === myPlayerId();
    const totalSec = (p.totalResponseTimeMs / 1000).toFixed(1);
    li.textContent = `${p.name}${isMe ? '（あなた）' : ''} — 正解 ${p.correctCount}問 / 合計回答時間 ${totalSec}秒`;
    if (isMe) li.style.fontWeight = 'bold';

    const toggle = document.createElement('button');
    toggle.textContent = '詳細を見る';
    toggle.className = 'ghost';
    toggle.style.marginLeft = '10px';
    toggle.style.padding = '2px 10px';
    toggle.style.fontSize = '0.85rem';

    const detailTable = document.createElement('table');
    detailTable.style.display = 'none';
    detailTable.style.marginTop = '8px';
    detailTable.innerHTML = `
      <thead><tr><th>問題</th><th>回答</th><th>判定</th><th>回答時間</th></tr></thead>
      <tbody>
        ${p.breakdown
          .map(
            (b) => `<tr>
              <td>第${b.roundIndex + 1}問</td>
              <td>${b.answered ? escapeHtml(b.text) : '未回答'}</td>
              <td>${b.correct ? '<span class="badge correct">正解</span>' : '<span class="badge incorrect">不正解</span>'}</td>
              <td>${(b.responseTimeMs / 1000).toFixed(1)}秒</td>
            </tr>`
          )
          .join('')}
      </tbody>
    `;
    toggle.onclick = () => {
      detailTable.style.display = detailTable.style.display === 'none' ? 'table' : 'none';
    };

    li.appendChild(toggle);
    li.appendChild(detailTable);
    list.appendChild(li);
  });
});

function renderRound(round, alreadyAnswered, myAnswerText) {
  showScreen('question');
  currentAllowResubmit = !!round.allowResubmit;
  hasAnsweredCurrent = !!alreadyAnswered;

  const input = document.getElementById('answer-input');
  const btn = document.getElementById('btn-submit');
  const note = document.getElementById('submitted-note');

  input.value = myAnswerText || '';
  note.style.display = alreadyAnswered ? 'block' : 'none';
  document.getElementById('answer-error').textContent = '';

  if (alreadyAnswered && !currentAllowResubmit) {
    input.disabled = true;
    btn.disabled = true;
  } else {
    input.disabled = false;
    btn.disabled = false;
  }

  clearInterval(timerHandle);
  const timerEl = document.getElementById('question-timer');
  const tick = () => {
    const remaining = Math.max(0, Math.round((round.deadline - Date.now()) / 1000));
    timerEl.textContent = `残り ${remaining} 秒${currentAllowResubmit ? '（時間内なら回答を変更できます）' : ''}`;
    if (remaining <= 0) {
      clearInterval(timerHandle);
      input.disabled = true;
      btn.disabled = true;
    }
  };
  tick();
  timerHandle = setInterval(tick, 1000);
}

document.getElementById('btn-submit').onclick = submitAnswer;
document.getElementById('answer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitAnswer();
});

function submitAnswer() {
  const text = document.getElementById('answer-input').value;
  if (!text.trim()) {
    document.getElementById('answer-error').textContent = '回答を入力してください';
    return;
  }
  socket.emit('player:submitAnswer', { code: myCode, text });
}

function myPlayerId() {
  return localStorage.getItem('playerId');
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
