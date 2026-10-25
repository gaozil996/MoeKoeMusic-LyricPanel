/*
 * The queue uses Vue's RecycleScroller in the page MAIN world. Content scripts default
 * to an isolated JS world, so this tiny companion script only adjusts the queue's
 * virtual row step while the lyrics screen is active. All queue buttons and data stay
 * owned by MoeKoe; closing the queue or lyrics restores the host's 50px itemSize.
 */
(function () {
  'use strict';

  var ROOT = '.queue-popup';
  var LIST = '.queue-list';
  var COMPACT = 36;
  var CLASS = 'mk-lp-queue-compact';
  var activeList = null;
  var scroller = null;
  var originalSize = 50;
  var observer = null;
  var formatMilliseconds = null;

  function correctDuration(item) {
    if (!formatMilliseconds || !scroller || !scroller.props || !Array.isArray(scroller.props.items)) return;
    var title = item.querySelector('.queue-song-title');
    var duration = item.querySelector('.queue-artist');
    if (!title || !duration) return;
    var name = title.textContent;
    var song = null;
    var view = item.closest('.vue-recycle-scroller__item-view');
    var transform = view && (view.getAttribute('style') || '');
    var marker = transform && transform.indexOf('translateY(');
    if (marker >= 0) {
      var end = transform.indexOf('px', marker);
      var offset = Number(transform.slice(marker + 11, end));
      var step = Number(scroller.props.itemSize) || COMPACT;
      var index = Math.round(offset / step);
      if (Number.isFinite(index) && index >= 0) song = scroller.props.items[index] || null;
    }
    if (!song || song.name !== name) {
      song = scroller.props.items.find(function (candidate) { return candidate.name === name; });
    }
    var timeLength = Number(song && song.timeLength);
    if (Number.isFinite(timeLength) && timeLength > 0) {
      var formatted = formatMilliseconds(timeLength);
      if (duration.textContent !== formatted) duration.textContent = formatted;
    }
  }

  function findScroller(list) {
    var app = document.querySelector('#app')?.__vue_app__;
    var root = app && app._container && app._container._vnode;
    if (!root) return null;
    var seen = new Set();

    function visit(vnode, depth) {
      if (!vnode || typeof vnode !== 'object' || depth > 80 || seen.has(vnode)) return null;
      seen.add(vnode);

      var instance = vnode.component;
      if (instance) {
        var name = instance.type && (instance.type.__name || instance.type.name);
        if (name === 'RecycleScroller' &&
            (instance.vnode?.el === list || instance.proxy?.$el === list || instance.subTree?.el === list)) {
          return instance;
        }
        var found = visit(instance.subTree, depth + 1);
        if (found) return found;
      }

      if (vnode.suspense) {
        var active = visit(vnode.suspense.activeBranch, depth + 1);
        if (active) return active;
        var pending = visit(vnode.suspense.pendingBranch, depth + 1);
        if (pending) return pending;
      }

      var keys = ['children', 'dynamicChildren'];
      for (var k = 0; k < keys.length; k++) {
        var children = vnode[keys[k]];
        if (!Array.isArray(children)) continue;
        for (var i = 0; i < children.length; i++) {
          var child = visit(children[i], depth + 1);
          if (child) return child;
        }
      }
      return null;
    }

    return visit(root, 0);
  }

  function setStep(size, keepIndex) {
    if (!scroller || !activeList || !scroller.props || !scroller.proxy) return;
    scroller.props.itemSize = size;
    scroller.proxy.updateVisibleItems(true);
    scroller.proxy.scrollToPosition(Math.max(0, keepIndex) * size);
    scroller.proxy.updateVisibleItems(true);
  }

  function restore() {
    if (scroller && activeList && activeList.isConnected &&
        Number(scroller.props?.itemSize) === COMPACT) {
      var index = Math.floor((activeList.scrollTop || 0) / COMPACT);
      try { setStep(originalSize || 50, index); } catch (e) {}
    }
    if (observer) observer.disconnect();
    observer = null;
    activeList = null;
    scroller = null;
    originalSize = 50;
    formatMilliseconds = null;
    document.documentElement.classList.remove(CLASS);
  }

  function sync() {
    var lyrics = document.querySelector('.lyrics-bg');
    var popup = document.querySelector(ROOT);
    var list = popup && popup.querySelector(LIST);
    if (!lyrics || !popup || !list) {
      restore();
      return;
    }

    if (list !== activeList) {
      restore();
      activeList = list;
      scroller = findScroller(list);
      if (!scroller || !scroller.props || !scroller.proxy) {
        activeList = null;
        scroller = null;
        return;
      }
      originalSize = Number(scroller.props.itemSize) || 50;
      var app = document.querySelector('#app')?.__vue_app__;
      formatMilliseconds = app?._context?.config?.globalProperties?.$formatMilliseconds || null;
      observer = new MutationObserver(function () {
        if (activeList !== list || !list.isConnected || !document.querySelector('.lyrics-bg')) {
          restore();
          return;
        }
        list.querySelectorAll('.queue-item').forEach(function (item) {
          item.style.setProperty('height', COMPACT + 'px', 'important');
          item.querySelectorAll('.queue-song-info, .queue-song-title, .queue-artist, .queue-actions').forEach(function (node) {
            node.style.setProperty('display', 'flex', 'important');
            node.style.setProperty('align-items', 'center', 'important');
          });
          var info = item.querySelector('.queue-song-info');
          if (info) {
            info.style.setProperty('flex-direction', 'row', 'important');
            info.style.setProperty('gap', '8px', 'important');
            info.style.setProperty('min-width', '0', 'important');
            info.style.setProperty('flex', '1 1 auto', 'important');
            info.style.setProperty('height', '100%', 'important');
          }
          var title = item.querySelector('.queue-song-title');
          if (title) {
            title.style.setProperty('width', 'auto', 'important');
            title.style.setProperty('min-width', '0', 'important');
            title.style.setProperty('flex', '1 1 auto', 'important');
            title.style.setProperty('font-size', '14px', 'important');
            title.style.setProperty('line-height', '20px', 'important');
          }
          var duration = item.querySelector('.queue-artist');
          if (duration) {
            duration.style.setProperty('flex', '0 0 auto', 'important');
            duration.style.setProperty('font-size', '12px', 'important');
            duration.style.setProperty('line-height', '18px', 'important');
            duration.style.setProperty('white-space', 'nowrap', 'important');
            correctDuration(item);
          }
          var actions = item.querySelector('.queue-actions');
          if (actions) actions.style.setProperty('flex', '0 0 auto', 'important');
        });
      });
      observer.observe(list, { childList: true, subtree: true });
    }

    document.documentElement.classList.add(CLASS);
    var current = Number(scroller.props.itemSize) || originalSize;
    if (current !== COMPACT) {
      var index = Math.floor((list.scrollTop || 0) / current);
      setStep(COMPACT, index);
    }
    if (observer) observer.takeRecords();
    list.querySelectorAll('.queue-item').forEach(function (item) {
      item.style.setProperty('height', COMPACT + 'px', 'important');
      var info = item.querySelector('.queue-song-info');
      if (info) {
        info.style.setProperty('display', 'flex', 'important');
        info.style.setProperty('flex-direction', 'row', 'important');
        info.style.setProperty('align-items', 'center', 'important');
        info.style.setProperty('gap', '8px', 'important');
        info.style.setProperty('min-width', '0', 'important');
        info.style.setProperty('flex', '1 1 auto', 'important');
        info.style.setProperty('height', '100%', 'important');
      }
      var title = item.querySelector('.queue-song-title');
      if (title) {
        title.style.setProperty('display', 'block', 'important');
        title.style.setProperty('width', 'auto', 'important');
        title.style.setProperty('min-width', '0', 'important');
        title.style.setProperty('flex', '1 1 auto', 'important');
        title.style.setProperty('font-size', '14px', 'important');
        title.style.setProperty('line-height', '20px', 'important');
      }
      var duration = item.querySelector('.queue-artist');
      if (duration) {
        duration.style.setProperty('display', 'block', 'important');
        duration.style.setProperty('flex', '0 0 auto', 'important');
        duration.style.setProperty('font-size', '12px', 'important');
        duration.style.setProperty('line-height', '18px', 'important');
        duration.style.setProperty('white-space', 'nowrap', 'important');
        correctDuration(item);
      }
      var actions = item.querySelector('.queue-actions');
      if (actions) {
        actions.style.setProperty('display', 'flex', 'important');
        actions.style.setProperty('align-items', 'center', 'important');
        actions.style.setProperty('flex', '0 0 auto', 'important');
      }
    });
  }

  setInterval(function () {
    try { sync(); } catch (e) { console.warn('[面板] 队列紧凑布局失败:', e); }
  }, 120);
})();
