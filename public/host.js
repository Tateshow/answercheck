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
  btnDissolve: document.getElementById('btn-dissolve'),
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
  publishedPanel: document.getElementById('published-panel'),
  standingsCard: document.getElementById('standings-card'),
  standingsRoundLabel: document.getElementById('standings-round-label'),
  standingsTable: document.getElementById('standings-table'),
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
socket.on('host:standings', renderStandings);
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
    const revealRadio = document.querySelector(`input[name="reveal-style"][value="${state.lastSettings.revealStyle || 'list'}"]`);
    if (revealRadio) revealRadio.checked = true;
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
    el.standingsCard.style.display = 'none';
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
  const revealStyle = document.querySelector('input[name="reveal-style"]:checked').value;

  el.roundError.textContent = '';
  el.btnStartRound.disabled = true;
  emitWithTimeout('host:startRound', { code, durationSec, acceptedAnswersRaw, allowResubmit, resultOrder, revealStyle }, (res) => {
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

function formatSeconds(ms) {
  return ms == null ? '-' : `${(ms / 1000).toFixed(1)}秒`;
}

function renderPlayers(players) {
  el.playerCount.textContent = players.length;
  el.playerList.innerHTML = '';
  players.forEach((p) => {
    let statusLabel = '';
    if (p.left) statusLabel = ' <span class="muted">（退出）</span>';
    else if (!p.connected) statusLabel = ' <span class="muted">（切断中）</span>';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}${statusLabel}</td>
      <td>${p.correctCount}</td>
      <td>${p.incorrectCount}</td>
      <td>${formatSeconds(p.totalResponseTimeMs)}</td>
      <td></td>
    `;
    if (p.connected) {
      const transferBtn = document.createElement('button');
      transferBtn.textContent = 'ホストにする';
      transferBtn.className = 'ghost';
      transferBtn.style.padding = '2px 10px';
      transferBtn.style.fontSize = '0.85rem';
      transferBtn.onclick = () => requestTransferHost(p);
      tr.lastElementChild.appendChild(transferBtn);
    }
    el.playerList.appendChild(tr);
  });
}

function requestTransferHost(player) {
  if (!confirm(`${player.name} さんにホスト権限を譲りますか？\nあなた自身は新しいニックネームでプレーヤーとして参加し直します。`)) {
    return;
  }
  const nickname = prompt('プレーヤーとして参加する際のニックネームを入力してください', '');
  if (nickname === null) return;
  const trimmed = nickname.trim().slice(0, 20);
  if (!trimmed) {
    alert('ニックネームを入力してください');
    return;
  }
  emitWithTimeout('host:transferHost', { code, targetPlayerId: player.id, newHostNickname: trimmed }, (res) => {
    if (!res) {
      alert('サーバーから応答がありません。');
      return;
    }
    if (!res.ok) {
      alert(res.error || 'ホスト権限の移譲に失敗しました');
      return;
    }
    try {
      localStorage.removeItem('hostToken');
      localStorage.setItem('roomCode', res.code);
      localStorage.setItem('playerId', res.playerId);
    } catch (e) {
      /* localStorageが使えない場合でも遷移自体は行う */
    }
    window.location.href = 'player.html';
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

// パネル式の回答公開1枚分のDOMを組み立てる（案3: 回答ゾーン左上に小さく回答時間、
// 中央に太字で回答、下部の濃色帯に細字でプレイヤー名のみ）。host.js / player.js で共通の見た目。
function buildPanelItem(p, timeLabel) {
  const box = document.createElement('div');
  box.className = 'panel-item' + (p.correct ? ' correct' : '');
  const answered = p.text != null;
  box.innerHTML = `
    <div class="panel-answer-zone">
      ${answered ? `<div class="panel-time">${timeLabel}</div>` : ''}
      <div class="panel-answer${answered ? '' : ' unanswered'}">${answered ? escapeHtml(p.text) : '未回答'}</div>
    </div>
    <div class="panel-name">${escapeHtml(p.name)}</div>
  `;
  return box;
}

function renderPublished(payload) {
  el.publishedCard.style.display = 'block';
  el.publishedOrderLabel.textContent = payload.resultOrder === 'joinOrder' ? 'ルーム入室順' : '回答が早かった順';
  el.publishedCorrectAnswers.textContent = payload.acceptedAnswers.join(' / ');

  const isPanel = payload.revealStyle === 'panel';
  el.publishedList.style.display = isPanel ? 'none' : 'block';
  el.publishedPanel.style.display = isPanel ? 'grid' : 'none';

  el.publishedList.innerHTML = '';
  el.publishedPanel.innerHTML = '';

  payload.players.forEach((p) => {
    const timeLabel = p.responseTimeMs != null ? `${(p.responseTimeMs / 1000).toFixed(1)}秒` : '未回答';
    if (isPanel) {
      el.publishedPanel.appendChild(buildPanelItem(p, timeLabel));
    } else {
      const li = document.createElement('li');
      li.textContent = `${p.name} — ${p.correct ? '正解' : '不正解'}（${timeLabel}）`;
      el.publishedList.appendChild(li);
    }
  });
}

function renderStandings(standings) {
  el.standingsCard.style.display = 'block';
  el.standingsRoundLabel.textContent = standings.totalRounds;
  buildRankingRows(el.standingsTable, standings.ranking);
}

function renderRanking(ranking) {
  buildRankingRows(el.rankingList, ranking);
}

// 「現在のランキング」「最終結果」で共通のテーブル描画（順位・プレイヤー名・正解数・誤答数・総回答時間・詳細）。
function buildRankingRows(tbody, ranking) {
  tbody.innerHTML = '';
  ranking.forEach((p, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx + 1}位</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${p.correctCount}</td>
      <td>${p.incorrectCount}</td>
      <td>${formatSeconds(p.totalResponseTimeMs)}</td>
      <td></td>
    `;

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
                <td>${(b.responseTimeMs / 1000).toFixed(1)}秒${b.answered ? '' : '（未回答のため制限時間分）'}</td>
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

    tbody.appendChild(tr);
    tbody.appendChild(detailRow);
  });
}

el.btnClose.onclick = () => socket.emit('host:closeAnswers', { code });
el.btnPublish.onclick = () => socket.emit('host:publishResults', { code });
el.btnEnd.onclick = () => {
  if (confirm('セッションを終了し、最終結果をプレーヤーに表示します。よろしいですか？')) {
    socket.emit('host:endSession', { code });
  }
};

el.btnDissolve.onclick = () => {
  if (!confirm('ルームを解散します。参加者全員がルームコードで参加・復帰できなくなります。よろしいですか？')) {
    return;
  }
  el.btnDissolve.disabled = true;
  emitWithTimeout('host:dissolveRoom', { code }, () => {
    try {
      localStorage.removeItem('hostToken');
    } catch (e) {
      /* ignore */
    }
    window.location.reload();
  });
};

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
