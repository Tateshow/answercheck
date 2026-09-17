const socket = io();

let code = null;
let currentRoundIndex = -1;

const el = {
  screenStart: document.getElementById('screen-start'),
  screenMain: document.getElementById('screen-main'),
  startStatus: document.getElementById('start-status'),
  startError: document.getElementById('start-error'),
  btnCreate: document.getElementById('btn-create'),
  roomCode: document.getElementById('room-code'),
  joinUrl: document.getElementById('join-url'),
  qr: document.getElementById('qr'),
  roundNumber: document.getElementById('round-number'),
  inputDuration: document.getElementById('input-duration'),
  inputAnswers: document.getElementById('input-answers'),
  btnStartRound: document.getElementById('btn-start-round'),
  roundError: document.getElementById('round-error'),
  playerList: document.getElementById('player-list'),
  playerCount: document.getElementById('player-count'),
  currentStatus: document.getElementById('current-status'),
  currentControls: document.getElementById('current-controls'),
  btnClose: document.getElementById('btn-close'),
  btnPublish: document.getElementById('btn-publish'),
  answerTable: document.getElementById('answer-table'),
  publishedCard: document.getElementById('published-card'),
  publishedOrderLabel: document.getElementById('published-order-label'),
  publishedCorrectAnswers: document.getElementById('published-correct-answers'),
  publishedList: document.getElementById('published-list'),
  rankingList: document.getElementById('ranking-list'),
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
      if (res && res.ok) {
        enterRoom(res);
      } else {
        localStorage.removeItem('hostToken');
        el.startError.textContent = (res && res.error) || '';
      }
    });
  } else {
    el.startStatus.textContent = '';
  }
});

socket.on('connect_error', (err) => {
  console.error('socket connect_error', err);
  el.startStatus.textContent = '';
  el.startError.textContent = 'サーバーに接続できません。サーバーが起動しているか確認してください。';
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
      el.startError.textContent = 'サーバーから応答がありません。ページを再読み込みするか、サーバーを再起動してください。';
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
  applyState(data.state);
  if (data.players) renderPlayers(data.players);
  if (data.answers) renderAnswers(data.answers);
}

socket.on('host:state', applyState);
socket.on('host:players', renderPlayers);
socket.on('host:answers', renderAnswers);
socket.on('host:results', renderPublished);
socket.on('host:ranking', renderRanking);

function applyState(state) {
  currentRoundIndex = state.currentRoundIndex;
  el.roundNumber.textContent = state.totalRounds + 1;

  // 直前の設定をフォームの初期値として引き継ぐ
  if (state.lastSettings) {
    const resubmitRadio = document.querySelector(`input[name="allow-resubmit"][value="${state.lastSettings.allowResubmit}"]`);
    if (resubmitRadio) resubmitRadio.checked = true;
    const orderRadio = document.querySelector(`input[name="result-order"][value="${state.lastSettings.resultOrder}"]`);
    if (orderRadio) orderRadio.checked = true;
  }

  if (!state.round) {
    el.currentStatus.textContent = state.totalRounds > 0 ? 'つぎの問題を準備してください' : 'まだ出題していません';
    el.currentControls.style.display = 'none';
    if (state.phase !== 'published') el.publishedCard.style.display = 'none';
    return;
  }

  el.currentControls.style.display = 'block';
  const label = `第${state.round.index + 1}問（制限時間 ${state.round.durationSec}秒${state.round.allowResubmit ? '・修正可' : '・一度きり'}）`;
  if (state.phase === 'accepting') {
    el.currentStatus.textContent = `${label} — 回答受付中`;
    el.btnClose.disabled = false;
    el.btnPublish.disabled = true;
    el.publishedCard.style.display = 'none';
  } else if (state.phase === 'closed') {
    el.currentStatus.textContent = `${label} — 受付締切・採点中`;
    el.btnClose.disabled = true;
    el.btnPublish.disabled = false;
  } else if (state.phase === 'published') {
    el.currentStatus.textContent = `${label} — 公開済み`;
    el.btnClose.disabled = true;
    el.btnPublish.disabled = true;
  }
}

el.btnStartRound.onclick = () => {
  const durationSec = Number(el.inputDuration.value) || 30;
  const acceptedAnswersRaw = el.inputAnswers.value;
  const allowResubmit = document.querySelector('input[name="allow-resubmit"]:checked').value === 'true';
  const resultOrder = document.querySelector('input[name="result-order"]:checked').value;

  el.roundError.textContent = '';
  el.btnStartRound.disabled = true;
  emitWithTimeout('host:startRound', { code, durationSec, acceptedAnswersRaw, allowResubmit, resultOrder }, (res) => {
    el.btnStartRound.disabled = false;
    if (!res) {
      el.roundError.textContent = 'サーバーから応答がありません。';
      return;
    }
    if (!res.ok) {
      el.roundError.textContent = res.error || '出題に失敗しました';
      return;
    }
    el.inputAnswers.value = '';
  });
};

function renderPlayers(players) {
  el.playerCount.textContent = players.length;
  el.playerList.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    li.style.padding = '4px 0';
    li.textContent = `${p.name}${p.connected ? '' : '（切断中）'} — 正解 ${p.correctCount}問`;
    el.playerList.appendChild(li);
  });
}

function renderAnswers(answers) {
  el.answerTable.innerHTML = '';
  answers.forEach((a) => {
    const tr = document.createElement('tr');
    const answerLabel = a.submitted ? escapeHtml(a.text) : '未回答';
    const timeLabel = a.responseTimeMs != null ? `${(a.responseTimeMs / 1000).toFixed(1)}秒` : '-';
    let badge = '<span class="badge pending">未判定</span>';
    if (a.correct === true) badge = `<span class="badge correct">正解${a.auto ? '（自動）' : '（手動）'}</span>`;
    if (a.correct === false) badge = `<span class="badge incorrect">不正解${a.auto ? '（自動）' : '（手動）'}</span>`;

    tr.innerHTML = `
      <td>${escapeHtml(a.name)}</td>
      <td>${answerLabel}</td>
      <td>${timeLabel}</td>
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

function renderPublished(payload) {
  el.publishedCard.style.display = 'block';
  el.publishedOrderLabel.textContent = payload.resultOrder === 'joinOrder' ? 'ルーム入室順' : '回答が早かった順';
  el.publishedCorrectAnswers.textContent = payload.acceptedAnswers.join(' / ');
  el.publishedList.innerHTML = '';
  payload.players.forEach((p) => {
    const li = document.createElement('li');
    const timeLabel = p.responseTimeMs != null ? `${(p.responseTimeMs / 1000).toFixed(1)}秒` : '未回答';
    li.textContent = `${p.name} — ${p.correct ? '正解' : '不正解'}（${timeLabel}）`;
    el.publishedList.appendChild(li);
  });
}

function renderRanking(ranking) {
  el.rankingList.innerHTML = '';
  ranking.forEach((p) => {
    const li = document.createElement('li');
    const totalSec = (p.totalResponseTimeMs / 1000).toFixed(1);
    li.textContent = `${p.name} — 正解 ${p.correctCount}問 / 合計回答時間 ${totalSec}秒`;

    const toggle = document.createElement('button');
    toggle.textContent = '詳細を見る';
    toggle.className = 'ghost';
    toggle.style.marginLeft = '10px';
    toggle.style.padding = '2px 10px';
    toggle.style.fontSize = '0.85rem';

    const detail = document.createElement('table');
    detail.style.display = 'none';
    detail.style.marginTop = '8px';
    detail.innerHTML = `
      <thead><tr><th>問題</th><th>回答</th><th>判定</th><th>回答時間</th></tr></thead>
      <tbody>
        ${p.breakdown
          .map(
            (b) => `<tr>
              <td>第${b.roundIndex + 1}問</td>
              <td>${b.answered ? escapeHtml(b.text) : '未回答'}</td>
              <td>${b.correct ? '<span class="badge correct">正解</span>' : '<span class="badge incorrect">不正解</span>'}</td>
              <td>${(b.responseTimeMs / 1000).toFixed(1)}秒${b.answered ? '' : '（未回答のため制限時間分）'}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    `;
    toggle.onclick = () => {
      detail.style.display = detail.style.display === 'none' ? 'table' : 'none';
    };

    li.appendChild(toggle);
    li.appendChild(detail);
    el.rankingList.appendChild(li);
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
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
