// ライト/ダークモードの切り替え。ホスト画面・プレーヤー画面で共通。
// 基本はライトモード。一度切り替えると、そのブラウザでは次回以降も記憶される。
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem('theme');
  } catch (e) {
    /* プライベートブラウズ等でlocalStorageが使えない場合は既定（ライト）のまま */
  }
  var theme = stored === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);

  function setupToggleButton() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    function refresh() {
      var current = document.documentElement.getAttribute('data-theme');
      btn.textContent = current === 'dark' ? '☀️ ライトモード' : '🌙 ダークモード';
    }
    btn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try {
        localStorage.setItem('theme', next);
      } catch (e) {
        /* 保存できなくても表示の切り替え自体は継続する */
      }
      refresh();
    });
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupToggleButton);
  } else {
    setupToggleButton();
  }
})();
