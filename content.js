(function () {
  'use strict';

  /* ============================================================
     歌词悬浮面板

     打开全屏歌词页时，把底部那排播放控制（宿主自己的 #player-container）
     搬到歌词页里，变成底部居中的悬浮卡片：进度条、歌名、播放/收藏/倍速/
     播放模式/队列/音量，以及其他插件塞进这一排的按钮（下载、频谱、音质
     信息）全都在。搬 DOM 节点而不是复制，是因为这一整排都由宿主用 Vue
     渲染，节点搬过去还是原来那个，事件、状态、插件注入一概不用接管。

     刚进歌词页先半透明；鼠标在卡片上时完全清晰，离开卡片后按设定透明度淡下去；
     鼠标回到卡片立刻恢复清晰；离开卡片就淡到全透明，不做外围感应区和额外延迟。
     音量、播放模式、音质
     这些弹出菜单是卡片的后代元素，:hover 对祖先同样成立，所以鼠标停在
     菜单上时卡片不会淡。

     歌词页关闭时有 .slide-up-leave-active 的 0.3s 过渡，之后整棵
     .lyrics-bg 会被 Vue 摘掉。卡片此刻还在那棵树里，所以过渡一开始就把
     节点送回原位，不然它会跟着被摘出文档，底栏要等下一次轮询才回来。

     歌词页右上角的向下箭头（.close-btn）隐藏：关歌词页的入口在卡片里 ——
     歌名和封面本来就绑了 toggleLyrics，歌词页开着时点它们就是关闭，这跟
     宿主自己点右上角是同一个函数。注意 .extra-controls 最左边那个「词」
     是桌面歌词开关（title=桌面歌词，走 IPC desktop-lyrics-action），不是
     歌词页开关，所以不动它。

     淡出程度放在宿主的歌词设置面板（右侧那块 .settings-panel）里，跟频谱
     样式、逐字歌词同一个位置。
     ============================================================ */

  // 宿主底栏是 class="player-container"，没有 id：app.asar 的 CSS 里
  // #player-container 出现 0 次，Vue 模板里也没有 id:"player-container"。
  // 一开始按 #player-container 找，而离线夹具又是照这个错前提造的 DOM，28 项断言
  // 全绿、实机却一次都没挂上 —— 这种错只有真机才暴露。两个都留着，class 优先。
  var PANEL = '.player-container,#player-container';
  var BG = '.lyrics-bg';
  var SCREEN = '.lyrics-screen';
  var CARD = '.fullscreen-lyrics-settings .settings-panel';
  var KEY = 'lyric_panel_cfg';

  var DEF = { fade: 100 };
  var cfg = Object.assign({}, DEF);

  function log() { console.log.apply(console, ['[面板]'].concat([].slice.call(arguments))); }

  /* ---------- 配置 ---------- */

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        cfg = Object.assign({}, DEF, JSON.parse(raw) || {});
        if (Number(cfg.fade) === 70) cfg.fade = 100;
      }
      cfg.fade = Math.max(0, Math.min(100, Number(cfg.fade) || 0));
    } catch (e) {}
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {}
  }
  function op() { return String((100 - cfg.fade) / 100); }

  /* ---------- 搬动卡片 ---------- */

  var panel = null;   // 一直握着节点引用，即使它暂时脱离文档
  var home = null;    // 底栏原来的父节点
  var host = null;    // 当前承载它的 .lyrics-screen
  var rect = null;    // 卡片矩形缓存，鼠标移动时不做布局测量
  var mx = -1, my = -1;
  var lastVw = 0;
  // 卡片几何：左右贴边 + width:auto，元素自己撑满歌词页宽度，跟外面那排一样宽。
  // 不设固定宽度、不用 transform —— left:50% + translateX(-50%) 实机上只生效了
  // 一半（卡片右边缘停在窗口中线），宿主还有
  // body.player-bar-content-layout .player-container{left:var(--side-navigation-width)}
  // 和 .player-bar{max-width:880px} 在旁边盯着，所以一律内联 !important 钉死。
  var CARD_BOTTOM = 0;

  function applyGeometry(el) {
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    el.style.setProperty('position', 'absolute', 'important');
    el.style.setProperty('left', '0px', 'important');
    el.style.setProperty('right', '0px', 'important');
    el.style.setProperty('bottom', CARD_BOTTOM + 'px', 'important');
    el.style.setProperty('margin', '0px', 'important');
    el.style.setProperty('width', 'auto', 'important');
    el.style.setProperty('transform', 'none', 'important');
    return { vw: vw };
  }

  // 落一份实测数字到 leveldb：页面上的东西我截图看不清，但这个读得到。
  var lastDbg = 0;
  function writeDbg(el, g) {
    if (!el || !el.isConnected) return;
    var now = Date.now();
    if (now - lastDbg < 1500) return;
    lastDbg = now;
    var r = el.getBoundingClientRect();
    try {
      localStorage.setItem('lyric_panel_dbg', JSON.stringify({
        t: Math.round(now / 1000),
        vw: g.vw, screenW: window.innerWidth,
        left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
        gapBottom: Math.round(window.innerHeight - r.bottom),
        cls: el.className,
        op: getComputedStyle(el).opacity
      }));
    } catch (e) {}
  }

  // 关歌词页的入口交给卡片里的歌名/封面，但只在卡片真的挂上来的时候才藏宿主那个 ∨。
  // 之前是无条件 display:none：插件只要没挂上（选择器对不上、内容脚本没注入、
  // 页面结构变了），用户就既没有卡片也没有关闭按钮，直接困在歌词页里出不来。
  // 这个 class 由 mount/restore 加删，样式表里那条规则挂在它下面，所以插件一停就自动还原。
  var onRoot = false;
  function setOn(on) {
    on = !!on;
    if (on === onRoot) return;
    onRoot = on;
    var de = document.documentElement;
    if (de) de.classList.toggle('mk-lp-on', on);
  }

  function refit() {
    if (!panel || !host || !panel.isConnected) { measure(); return; }
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    if (vw !== lastVw) {                       // 窗口宽度变了才重算，别每帧动样式
      lastVw = vw;
      writeDbg(panel, applyGeometry(panel));
      measure();
    } else {
      measure();
    }
  }

  function measure() {
    if (!panel || !panel.isConnected) { rect = null; return; }
    var r = panel.getBoundingClientRect();
    rect = r.height ? r : null;
  }

  function mount(el, screen) {
    // 底栏和 .lyrics-bg 是同一个父节点下的兄弟，所以判断「在不在家」只能看
    // 直接父节点，不能用 contains —— 卡片待在歌词页里时 contains 也是 true。
    if (!home && el.parentNode && el.parentNode !== screen) home = el.parentNode;
    panel = el;
    host = screen;
    el.classList.add('mk-lp-in');
    el.style.setProperty('--mk-lp-op', op());
    el.classList.remove('mk-lp-dim');
    screen.appendChild(el);
    var g = applyGeometry(el);
    // 进入歌词页先给半透明，等鼠标第一次动或者过一会儿，再交给常态逻辑
    // （在卡片上=完全不透明，离开=全透明）。
    el.classList.add('mk-lp-enter');
    setOn(true);
    measure();
    writeDbg(el, g);
    setTimeout(function () { leaveEnter(); }, 1400);
  }

  function leaveEnter() {
    if (panel && panel.classList.contains('mk-lp-enter')) {
      panel.classList.remove('mk-lp-enter');
      if (mx < 0 || (!inside(mx, my) && !panel.matches(':hover'))) panel.classList.add('mk-lp-dim');
      step();
    }
  }

  function restore() {
    // home 有可能已经被 Vue 换掉了（不在文档里）。还往那上面挂，卡片就跟着进了
    // 一棵游离的子树，从此谁也找不到它 —— 表现就是底栏和卡片一起消失，歌词页里
    // 什么控件都没有。所以先确认落脚点还活着，再挑一个备用的。
    var target = (home && home.isConnected) ? home : null;
    if (!target) {
      var live = document.querySelector('.player-container,#player-container');
      if (live && live !== panel) { home = live.parentNode; target = home; }
      else { home = document.getElementById('app') || document.body; target = home; }
    }
    if (panel && panel.parentNode !== target) {
      if (target && target.isConnected) target.appendChild(panel);
      else if (document.body) { document.body.appendChild(panel); home = document.body; }
    }
    if (panel) {
      panel.classList.remove('mk-lp-in');
      panel.classList.remove('mk-lp-dim');
      panel.classList.remove('mk-lp-enter');
      panel.style.removeProperty('--mk-lp-op');
      ['position', 'left', 'right', 'width', 'margin', 'margin-left', 'margin-right', 'bottom', 'transform']
        .forEach(function (k) { panel.style.removeProperty(k); });
    }
    setOn(false);
    host = null;
    rect = null;
  }

  function leaving(bg) {
    return !!bg && /(?:^|\s)slide-up-leave-(?:active|to)(?:\s|$)/.test(bg.className || '');
  }

  function step() {
    var bg = document.querySelector(BG);
    var screen = document.querySelector(SCREEN);
    if (!screen || !bg || leaving(bg)) { restore(); return; }

    var el = document.querySelector(PANEL) || (panel && !panel.isConnected ? panel : null);
    if (!el) return;
    if (!screen.contains(el)) {
      mount(el, screen);
      return;
    }
    panel = el;
    host = screen;
    if (!rect) measure();
    // 鼠标停在卡片外且一直没动，也要淡下去
    if (mx >= 0 && !inside(mx, my) && !el.classList.contains('mk-lp-dim') && !el.matches(':hover')) {
      el.classList.add('mk-lp-dim');
    }
  }

  /* ---------- 悬停感应 ---------- */

  function inside(x, y) {
    if (!rect) return false;
    return x >= rect.left && x <= rect.right &&
           y >= rect.top && y <= rect.bottom;
  }

  function onMove(e) {
    mx = e.clientX; my = e.clientY;
    if (!panel || !host) return;
    if (panel.classList.contains('mk-lp-enter')) panel.classList.remove('mk-lp-enter');
    if (!rect) measure();
    var dim = panel.classList.contains('mk-lp-dim');
    if (inside(mx, my) || panel.matches(':hover')) {
      if (dim) panel.classList.remove('mk-lp-dim');
    } else if (!dim) {
      panel.classList.add('mk-lp-dim');
    }
  }

  window.addEventListener('mousemove', onMove, { passive: true });
  window.addEventListener('resize', refit, { passive: true });

  // 指针移出窗口 / 窗口失焦：立刻按「离开面板」处理
  function gone() {
    mx = my = -1;
    if (panel && host) panel.classList.add('mk-lp-dim');
  }
  document.addEventListener('mouseleave', gone);
  window.addEventListener('blur', gone);

  /* ---------- 设置行 ---------- */

  function build() {
    var sec = document.createElement('div');
    sec.className = 'mk-lp-sec';
    sec.innerHTML =
      '<div class="mk-lp-row">' +
      '<span>面板淡出</span>' +
      '<input class="mk-lp-range" type="range" min="0" max="100" step="10" value="' + cfg.fade + '">' +
      '<b class="mk-lp-num">' + cfg.fade + '%</b>' +
      '</div>' +
      '<div class="mk-lp-tip">歌词页里鼠标离开控制面板后淡到这个程度；100% 为全透明，0% 为不淡出。</div>';
    var input = sec.querySelector('input');
    var num = sec.querySelector('.mk-lp-num');
    input.addEventListener('input', function () {
      cfg.fade = Math.min(100, Math.max(0, Number(input.value) || 0));
      num.textContent = cfg.fade + '%';
      save();
      if (panel) panel.style.setProperty('--mk-lp-op', op());
    });
    return sec;
  }

  function ensureSetting() {
    var card = document.querySelector(CARD);
    if (!card) return;
    var sec = card.querySelector('.mk-lp-sec');
    if (!sec) {
      card.appendChild(build());
      return;
    }
    var input = sec.querySelector('input');
    if (document.activeElement !== input && Number(input.value) !== cfg.fade) {
      input.value = String(cfg.fade);
      sec.querySelector('.mk-lp-num').textContent = cfg.fade + '%';
    }
  }

  /* ---------- 启动 ---------- */

  if (!document.querySelector) return;

  load();

  setInterval(function () {
    try {
      step();
      ensureSetting();
    } catch (e) { log('出错: ' + e.message); }
  }, 90);

  // 面板位置缓存跟着窗口尺寸/歌词页进出刷新；歌词页刚开、指针一直没动时，
  // 1.2s 后按当前指针位置补判一次（进入歌词页往往是点歌名，点完手就停了）
  var seenScreen = false;
  setInterval(function () {
    try {
      if (host) refit();
      var has = !!document.querySelector(SCREEN);
      if (has && !seenScreen) {
        seenScreen = true;
        setTimeout(function () { try { step(); } catch (e) {} }, 1200);
      }
      if (!has) seenScreen = false;
    } catch (e) {}
  }, 300);

  log('已启用，淡出 ' + cfg.fade + '%');
})();
