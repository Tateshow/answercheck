const socket = io();

const screens = {
  join: document.getElementById('screen-join'),
  waiting: document.getElementById('screen-waiting'),
  question: document.getElementById('screen-question'),
  result: document.getElementById('screen-result'),
  ended: document.getElementById('screen-ended'),
};

const btnLeaveRoom = document.getElementById('btn-leave-room');

function showScreen(name) {
  Object.values(screens).forEach((s) => (s.style.display = 'none'));
  screens[name].style.display = 'block';
  // ルームに参加済みの画面（待機中・出題中・結果・最終結果）でのみ「退出する」ボタンを表示する。
  btnLeaveRoom.style.display = name === 'join' ? 'none' : 'block';
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

  // 以前このルームに参加していて「退出する」で戻ってきた場合は、同じプレーヤーとして
  // 復帰させる（回答履歴・スコアはそのまま）。ニックネームの再入力は不要。
  const storedCode = localStorage.getItem('roomCode');
  const storedPlayerId = localStorage.getItem('playerId');
  if (storedCode === code && storedPlayerId) {
    socket.emit('player:rejoin', { code, playerId: storedPlayerId }, (res) => {
      if (res && res.ok) {
        myCode = code;
        document.getElementById('join-error').textContent = '';
      } else {
        // 復帰できなかった場合は通常の新規参加にフォールバックする。
        doFreshJoin(code, name);
      }
    });
    return;
  }

  doFreshJoin(code, name);
}

function doFreshJoin(code, name) {
  if (!name || !name.trim()) {
    document.getElementById('join-error').textContent = 'ニックネームを入力してください';
    return;
  }
  socket.emit('player:join', { code, name }, (res) => {
    if (!res.ok) {
      document.getElementById('join-error').textContent = res.error;
      return;
    }
    myCode = code;
    try {
      localStorage.setItem('roomCode', code);
      localStorage.setItem('playerId', res.playerId);
    } catch (e) {
      /* ignore */
    }
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

// ホストが「ルームを解散する」を押した場合。ルームコード自体が無効になるため、
// 保存していた参加情報も破棄して参加登録画面に戻す。
socket.on('player:roomDissolved', () => {
  clearInterval(timerHandle);
  try {
    localStorage.removeItem('roomCode');
    localStorage.removeItem('playerId');
  } catch (e) {
    /* ignore */
  }
  myCode = null;
  showScreen('join');
  document.getElementById('join-error').textContent = 'ホストによってルームが解散されました。';
});

// ホストから「ホスト権限を移す」で自分が新しいホストに指名された場合。
// ホスト用トークンを保存してホスト画面へ切り替える（プレーヤー側の参加情報は不要になるので削除）。
socket.on('player:promotedToHost', ({ hostToken }) => {
  try {
    localStorage.setItem('hostToken', hostToken);
    localStorage.removeItem('roomCode');
    localStorage.removeItem('playerId');
  } catch (e) {
    /* ignore */
  }
  window.location.href = 'host.html';
});

btnLeaveRoom.onclick = () => {
  if (!myCode) return;
  if (!confirm('ルームを退出しますか？（同じルームコードを入力すれば、これまでの回答履歴を引き継いで再入室できます）')) {
    return;
  }
  const leavingCode = myCode;
  socket.emit('player:leaveRoom', { code: leavingCode }, () => {
    clearInterval(timerHandle);
    myCode = null;
    showScreen('join');
    document.getElementById('code-input').value = leavingCode;
    document.getElementById('name-input').value = '';
    document.getElementById('join-error').textContent = '';
  });
};

// パネル式の回答公開1枚分のDOMを組み立てる（案3: 回答ゾーン左上に小さく回答時間、
// 中央に太字で回答、下部の濃色帯に細字でプレイヤー名のみ）。host.js と共通の見た目。
function buildPanelItem(p, timeLabel, isMe) {
  const box = document.createElement('div');
  box.className = 'panel-item' + (p.correct ? ' correct' : '');
  const answered = p.text != null;
  box.innerHTML = `
    <div class="panel-answer-zone">
      ${answered ? `<div class="panel-time">${timeLabel}</div>` : ''}
      <div class="panel-answer${answered ? '' : ' unanswered'}">${answered ? escapeHtml(p.text) : '未回答'}</div>
    </div>
    <div class="panel-name">${escapeHtml(p.name)}${isMe ? '（あなた）' : ''}</div>
  `;
  return box;
}

socket.on('player:results', (payload) => {
  clearInterval(timerHandle);
  showScreen('result');
  const mine = payload.players.find((p) => p.playerId === myPlayerId());
  const headline = document.getElementById('result-headline');
  const detail = document.getElementById('result-detail');
  if (mine) {
    headline.textContent = mine.correct ? '正解！' : '不正解';
    headline.className = mine.correct ? 'correct-text' : 'incorrect-text';
  } else {
    headline.textContent = '結果発表';
    headline.className = '';
  }
  detail.textContent = `正解: ${payload.acceptedAnswers.join(' / ')}`;
  document.getElementById('result-order-label').textContent = payload.resultOrder === 'joinOrder' ? 'ルーム入室順' : '回答が早かった順';

  const isPanel = payload.revealStyle === 'panel';
  const list = document.getElementById('result-list');
  const panel = document.getElementById('result-panel');
  list.style.display = isPanel ? 'none' : 'block';
  panel.style.display = isPanel ? 'grid' : 'none';
  list.innerHTML = '';
  panel.innerHTML = '';

  payload.players.forEach((p) => {
    const timeLabel = p.responseTimeMs != null ? `${(p.responseTimeMs / 1000).toFixed(1)}秒` : '未回答';
    const isMe = p.playerId === myPlayerId();
    if (isPanel) {
      panel.appendChild(buildPanelItem(p, timeLabel, isMe));
    } else {
      const li = document.createElement('li');
      li.textContent = `${p.name}${isMe ? '（あなた）' : ''} — ${p.correct ? '正解' : '不正解'}（${timeLabel}）`;
      if (isMe) li.style.fontWeight = 'bold';
      list.appendChild(li);
    }
  });
});

socket.on('player:standings', (standings) => {
  const section = document.getElementById('standings-section');
  section.style.display = 'block';
  document.getElementById('standings-round-label').textContent = standings.totalRounds;
  buildRankingRows(document.getElementById('standings-table'), standings.ranking, { withDetail: false });
});

socket.on('player:ended', (data) => {
  clearInterval(timerHandle);
  showScreen('ended');
  buildRankingRows(document.getElementById('final-ranking'), data.ranking, { withDetail: true });
});

// 「現在のランキング」「最終結果」で共通のテーブル描画。withDetail=true なら各問の内訳を開閉できる。
function buildRankingRows(tbody, ranking, { withDetail }) {
  tbody.innerHTML = '';
  ranking.forEach((p, idx) => {
    const isMe = p.playerId === myPlayerId();
    const tr = document.createElement('tr');
    if (isMe) tr.style.fontWeight = 'bold';
    tr.innerHTML = `
      <td>${idx + 1}位</td>
      <td>${escapeHtml(p.name)}${isMe ? '（あなた）' : ''}</td>
      <td>${p.correctCount}</td>
      <td>${p.incorrectCount}</td>
      <td>${(p.totalResponseTimeMs / 1000).toFixed(1)}秒</td>
      ${withDetail ? '<td></td>' : ''}
    `;
    tbody.appendChild(tr);

    if (!withDetail) return;

    const toggle = document.createElement('button');
    toggle.textContent = '詳細を見る';
    toggle.className = 'ghost';
    toggle.style.padding = '2px 10px';
    toggle.style.fontSize = '0.85rem';
    tr.lastElementChild.appendChild(toggle);

    const detailRow = document.createElement('tr');
    detailRow.style.display = 'none';
    const detailCell = document.createElement('td');
    detailCell.colSpan = 6;
    detailCell.innerHTML = `
      <table>
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
      </table>
    `;
    detailRow.appendChild(detailCell);
    toggle.onclick = () => {
      detailRow.style.display = detailRow.style.display === 'none' ? 'table-row' : 'none';
    };
    tbody.appendChild(detailRow);
  });
}

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
