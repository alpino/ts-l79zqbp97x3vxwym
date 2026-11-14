/* 積読スワイプ — 依存なしの静的アプリ */
(() => {
  'use strict';

  const STORE_KEY = 'tsundoku-swipe:v1';
  const $ = (sel) => document.querySelector(sel);

  const el = {
    deck: $('#deck'),
    progress: $('#progress'),
    barFill: $('#bar-fill'),
    savedCount: $('#saved-count'),
    btnSave: $('#btn-save'),
    btnSkip: $('#btn-skip'),
    btnUndo: $('#btn-undo'),
    btnSaved: $('#btn-saved'),
    dialog: $('#saved-dialog'),
    btnClose: $('#btn-close-saved'),
    list: $('#saved-list'),
    empty: $('#saved-empty'),
    titleCount: $('#saved-title-count'),
    btnCsv: $('#btn-export-csv'),
    btnJson: $('#btn-export-json'),
    btnCopy: $('#btn-copy'),
    exportStatus: $('#export-status'),
    toast: $('#toast'),
    credit: $('#credit'),
  };

  const state = {
    books: [],
    generatedAt: '',
    decisions: {},  // isbn -> 'save' | 'skip'
    saved: [],      // 保存順のスナップショット
    last: null,     // 直近1回分 { isbn, action, addedToSaved }
    busy: false,
  };

  // ------------------------------------------------------------ storage
  function loadStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        state.decisions = raw.decisions || {};
        state.saved = Array.isArray(raw.saved) ? raw.saved : [];
        state.last = raw.last || null;
      }
    } catch (_) { /* 壊れていたら初期状態から */ }
  }
  function persist() {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      version: 1, decisions: state.decisions, saved: state.saved, last: state.last,
    }));
  }

  // ------------------------------------------------------------ helpers
  function hueFor(text) {
    let h = 0;
    for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }
  function initialOf(title) {
    const t = String(title || '').replace(/^[\s「『（(【〈《]+/, '');
    return t ? Array.from(t)[0] : '本';
  }
  function makePlaceholder(book) {
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.style.setProperty('--h', hueFor(book.isbn || book.title));
    ph.textContent = initialOf(book.title);
    ph.setAttribute('role', 'img');
    ph.setAttribute('aria-label', `書影なし：${book.title || ''}`);
    return ph;
  }
  function makeCover(book, alt) {
    if (!book.cover) return makePlaceholder(book);
    const img = document.createElement('img');
    img.src = book.cover;
    img.alt = alt;
    img.decoding = 'async';
    img.draggable = false;
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.replaceWith(makePlaceholder(book)), { once: true });
    return img;
  }
  function fmtDate(p) {
    if (!p) return '';
    const m = String(p).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (!m) return p;
    return m[3] ? `${m[1]}年${+m[2]}月${+m[3]}日` : `${m[1]}年${+m[2]}月`;
  }
  function textEl(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.textContent = text;
    return e;
  }
  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1800);
  }

  // ------------------------------------------------------------ deck
  function currentIndex() {
    return state.books.findIndex((b) => !state.decisions[b.isbn]);
  }
  function decidedCount() {
    return state.books.reduce((n, b) => n + (state.decisions[b.isbn] ? 1 : 0), 0);
  }

  function buildCard(book, role) {
    const card = document.createElement('article');
    card.className = `card ${role}`;
    card.dataset.isbn = book.isbn;
    card.setAttribute('aria-label', book.title);

    const stampSave = textEl('div', 'stamp stamp-save', '保存');
    const stampSkip = textEl('div', 'stamp stamp-skip', 'スキップ');
    card.append(stampSave, stampSkip);

    const coverWrap = document.createElement('div');
    coverWrap.className = 'cover-wrap';
    coverWrap.append(makeCover(book, `書影：${book.title}`));
    card.append(coverWrap);

    const info = document.createElement('div');
    info.className = 'info';
    info.append(textEl('h2', 'title', book.title || '（タイトル不明）'));
    if (book.author) info.append(textEl('p', 'author', book.author));
    const pubBits = [book.publisher, fmtDate(book.pubdate) && `${fmtDate(book.pubdate)}発売`].filter(Boolean);
    info.append(textEl('p', 'pub', pubBits.join('　')));

    if (book.description) {
      const desc = textEl('p', 'desc', book.description);
      info.append(desc);
      const more = textEl('button', 'more-btn', '続きを読む');
      more.type = 'button';
      more.hidden = true;
      more.addEventListener('click', () => {
        const open = card.classList.toggle('expanded');
        more.textContent = open ? '閉じる' : '続きを読む';
      });
      info.append(more);
      // 4行に収まらない時だけ「続きを読む」を出す
      requestAnimationFrame(() => {
        if (desc.scrollHeight > desc.clientHeight + 2) more.hidden = false;
      });
    } else {
      info.append(textEl('p', 'desc-empty', '概要文：データなし'));
    }

    const src = document.createElement('p');
    src.className = 'source';
    src.append(`ISBN ${book.isbn}　出典: ${book.source || ''}`);
    if (book.source_url) {
      src.append('　');
      const a = document.createElement('a');
      a.href = book.source_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '書誌ページ';
      src.append(a);
    }
    info.append(src);
    card.append(info);
    return card;
  }

  function render(mode) {
    el.deck.textContent = '';
    const idx = currentIndex();
    const total = state.books.length;
    const done = decidedCount();

    if (idx === -1) {
      el.progress.innerHTML = '';
      el.progress.append('全', textEl('b', '', String(total)), '冊チェック完了');
      renderDone();
    } else {
      el.progress.innerHTML = '';
      el.progress.append(textEl('b', '', String(done + 1)), ` / ${total}冊目・残り${total - done}冊`);
      const nextIdx = state.books.findIndex((b, i) => i > idx && !state.decisions[b.isbn]);
      if (nextIdx !== -1) el.deck.append(buildCard(state.books[nextIdx], 'next'));
      const card = buildCard(state.books[idx], 'current');
      if (mode === 'undo') card.classList.add('undo-enter');
      else if (mode === 'advance') card.classList.add('enter');
      el.deck.append(card);
      attachDrag(card);
      preload(idx);
    }
    el.barFill.style.width = total ? `${(done / total) * 100}%` : '0';
    el.btnSave.disabled = idx === -1;
    el.btnSkip.disabled = idx === -1;
    el.btnUndo.disabled = !state.last;
    el.savedCount.textContent = String(state.saved.length);
  }

  function renderDone() {
    const box = document.createElement('section');
    box.className = 'done';
    box.id = 'deck-done';
    box.append(
      textEl('h2', '', 'すべての本を見終わりました'),
      textEl('p', '', `保存 ${state.saved.length}冊`),
    );
    const openBtn = textEl('button', 'act', '保存一覧を見る');
    openBtn.type = 'button';
    openBtn.addEventListener('click', openSaved);
    const again = textEl('button', 'act', 'スキップした本をもう一度見る');
    again.type = 'button';
    again.addEventListener('click', () => {
      for (const [isbn, act] of Object.entries(state.decisions)) if (act === 'skip') delete state.decisions[isbn];
      state.last = null;
      persist();
      render('advance');
    });
    box.append(openBtn, again);
    el.deck.append(box);
  }

  const preloaded = new Set();
  function preload(idx) {
    let n = 0;
    for (let i = idx + 1; i < state.books.length && n < 3; i++) {
      const b = state.books[i];
      if (state.decisions[b.isbn]) continue;
      n++;
      if (b.cover && !preloaded.has(b.cover)) {
        preloaded.add(b.cover);
        const im = new Image();
        im.referrerPolicy = 'no-referrer';
        im.src = b.cover;
      }
    }
  }

  // ------------------------------------------------------------ actions
  function decide(action, card) {
    if (state.busy) return;
    const idx = currentIndex();
    if (idx === -1) return;
    const book = state.books[idx];
    card = card || el.deck.querySelector('.card.current');

    state.decisions[book.isbn] = action;
    let addedToSaved = false;
    if (action === 'save' && !state.saved.some((s) => s.isbn === book.isbn)) {
      state.saved.push({
        isbn: book.isbn, title: book.title, author: book.author, publisher: book.publisher,
        pubdate: book.pubdate, cover: book.cover, source: book.source, source_url: book.source_url,
        savedAt: new Date().toISOString(),
      });
      addedToSaved = true;
    }
    state.last = { isbn: book.isbn, action, addedToSaved };
    persist();
    el.savedCount.textContent = String(state.saved.length);
    toast(action === 'save' ? `保存しました：${book.title}` : `スキップ：${book.title}`);

    if (card) {
      state.busy = true;
      const dir = action === 'save' ? 1 : -1;
      const cur = card.dataset.dy ? Number(card.dataset.dy) : 0;
      card.classList.remove('dragging', 'settle');
      card.classList.add('fly');
      const stamp = card.querySelector(action === 'save' ? '.stamp-save' : '.stamp-skip');
      if (stamp) stamp.style.opacity = '1';
      card.style.transform = `translate(${dir * (window.innerWidth + 200)}px, ${cur}px) rotate(${dir * 28}deg)`;
      card.style.opacity = '0';
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        state.busy = false;
        render('advance');
      };
      card.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 380);
    } else {
      render('advance');
    }
  }

  function undo() {
    if (state.busy || !state.last) return;
    const { isbn, action, addedToSaved } = state.last;
    delete state.decisions[isbn];
    if (action === 'save' && addedToSaved) {
      state.saved = state.saved.filter((s) => s.isbn !== isbn);
    }
    state.last = null; // 取り消しは直近1回分のみ
    persist();
    const book = state.books.find((b) => b.isbn === isbn);
    toast(`取り消しました：${book ? book.title : isbn}`);
    render('undo');
    if (el.dialog.open) renderSaved();
  }

  // ------------------------------------------------------------ drag (pointer events: mouse / touch / pen)
  function attachDrag(card) {
    let d = null;
    const stampSave = card.querySelector('.stamp-save');
    const stampSkip = card.querySelector('.stamp-skip');

    const threshold = () => Math.min(120, card.clientWidth * 0.28);

    card.addEventListener('pointerdown', (e) => {
      if (state.busy) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('button, a')) return;
      d = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, t0: performance.now(), active: false };
      try { card.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    });

    card.addEventListener('pointermove', (e) => {
      if (!d || e.pointerId !== d.id) return;
      d.dx = e.clientX - d.x0;
      d.dy = e.clientY - d.y0;
      if (!d.active) {
        if (Math.abs(d.dx) > 8 && Math.abs(d.dx) > Math.abs(d.dy)) {
          d.active = true;
          card.classList.remove('settle', 'enter', 'undo-enter');
          card.classList.add('dragging');
        } else {
          return;
        }
      }
      e.preventDefault();
      const dy = d.dy * 0.25;
      card.dataset.dy = String(dy);
      card.style.transform = `translate(${d.dx}px, ${dy}px) rotate(${d.dx / 18}deg)`;
      const p = Math.min(1, Math.abs(d.dx) / threshold());
      stampSave.style.opacity = d.dx > 0 ? String(p) : '0';
      stampSkip.style.opacity = d.dx < 0 ? String(p) : '0';
    });

    const end = (e, cancelled) => {
      if (!d || e.pointerId !== d.id) return;
      const { dx, active, t0 } = d;
      d = null;
      if (!active) return;
      const v = Math.abs(dx) / Math.max(1, performance.now() - t0); // px/ms
      const commit = !cancelled && (Math.abs(dx) >= threshold() || (v > 0.7 && Math.abs(dx) > 50));
      if (commit) {
        decide(dx > 0 ? 'save' : 'skip', card);
      } else {
        card.classList.remove('dragging');
        card.classList.add('settle');
        card.style.transform = '';
        stampSave.style.opacity = '0';
        stampSkip.style.opacity = '0';
      }
    };
    card.addEventListener('pointerup', (e) => end(e, false));
    card.addEventListener('pointercancel', (e) => end(e, true));
    card.addEventListener('lostpointercapture', (e) => end(e, false));
  }

  // ------------------------------------------------------------ saved list
  function renderSaved() {
    const items = state.saved.slice().reverse(); // 新しい順
    el.list.textContent = '';
    el.titleCount.textContent = String(items.length);
    el.empty.hidden = items.length > 0;
    el.btnCsv.disabled = items.length === 0;
    el.btnJson.disabled = items.length === 0;
    el.btnCopy.disabled = items.length === 0;
    for (const b of items) {
      const li = document.createElement('li');
      li.className = 'saved-item';
      li.dataset.isbn = b.isbn;
      const th = document.createElement('div');
      th.className = 'saved-thumb';
      th.append(makeCover(b, ''));
      const body = document.createElement('div');
      body.className = 'saved-body';
      body.append(
        textEl('p', 's-title', b.title),
        textEl('p', 's-meta', [b.author, b.publisher, fmtDate(b.pubdate)].filter(Boolean).join(' ／ ')),
        textEl('p', 's-meta', `ISBN ${b.isbn}`),
      );
      const rm = textEl('button', 'remove-btn', '削除');
      rm.type = 'button';
      rm.setAttribute('aria-label', `${b.title} を保存一覧から削除`);
      rm.addEventListener('click', () => {
        state.saved = state.saved.filter((s) => s.isbn !== b.isbn);
        if (state.last && state.last.isbn === b.isbn) state.last = null;
        persist();
        renderSaved();
        render();
      });
      li.append(th, body, rm);
      el.list.append(li);
    }
  }
  function openSaved() {
    el.exportStatus.textContent = '';
    renderSaved();
    if (typeof el.dialog.showModal === 'function') el.dialog.showModal();
    else el.dialog.setAttribute('open', '');
  }
  function closeSaved() {
    if (typeof el.dialog.close === 'function') el.dialog.close();
    else el.dialog.removeAttribute('open');
  }

  // ------------------------------------------------------------ export
  const CSV_COLS = [
    ['isbn', 'ISBN'], ['title', 'タイトル'], ['author', '著者'], ['publisher', '出版社'],
    ['pubdate', '発売日'], ['source', '出典'], ['source_url', '参照URL'], ['savedAt', '保存日時'],
  ];
  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function buildCsv() {
    const rows = [CSV_COLS.map(([, label]) => label)];
    for (const b of state.saved) rows.push(CSV_COLS.map(([k]) => b[k]));
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  function download(blob, ext) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    a.href = url;
    a.download = `tsundoku-saved-${stamp}.${ext}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportCsv() {
    download(new Blob(['﻿' + buildCsv()], { type: 'text/csv;charset=utf-8' }), 'csv');
    el.exportStatus.textContent = `CSVを書き出しました（${state.saved.length}冊）`;
  }
  function exportJson() {
    // 保存リストに加え、保存/スキップの判定も含める（別端末への手動の引き継ぎ・バックアップ用）
    const data = {
      app: 'tsundoku-swipe', version: 1, exportedAt: new Date().toISOString(),
      dataGeneratedAt: state.generatedAt, savedCount: state.saved.length,
      saved: state.saved, decisions: state.decisions,
    };
    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'json');
    el.exportStatus.textContent = `JSONを書き出しました（${state.saved.length}冊）`;
  }
  function buildPlainText() {
    return state.saved.map((b) => [b.title, b.author, b.publisher, fmtDate(b.pubdate), `ISBN ${b.isbn}`]
      .filter(Boolean).join(' ／ ')).join('\n');
  }
  async function copyList() {
    const text = buildPlainText();
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); ok = true; } catch (_) { ok = false; }
    }
    if (!ok) {
      // http://LAN IP など非セキュアコンテキスト用のフォールバック
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      el.dialog.append(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
    }
    el.exportStatus.textContent = ok
      ? `コピーしました（${state.saved.length}冊）`
      : 'コピーできませんでした。CSVダウンロードをお使いください';
  }

  // ------------------------------------------------------------ wiring
  el.btnSave.addEventListener('click', () => decide('save'));
  el.btnSkip.addEventListener('click', () => decide('skip'));
  el.btnUndo.addEventListener('click', undo);
  el.btnSaved.addEventListener('click', openSaved);
  el.btnClose.addEventListener('click', closeSaved);
  el.btnCsv.addEventListener('click', exportCsv);
  el.btnJson.addEventListener('click', exportJson);
  el.btnCopy.addEventListener('click', copyList);
  el.dialog.addEventListener('click', (e) => { if (e.target === el.dialog) closeSaved(); });

  document.addEventListener('keydown', (e) => {
    if (el.dialog.open || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); decide('save'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); decide('skip'); }
    else if (e.key === 'z' || e.key === 'Z' || e.key === 'Backspace') { e.preventDefault(); undo(); }
  });

  // ------------------------------------------------------------ boot
  async function boot() {
    loadStore();
    try {
      const res = await fetch('books.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.books = Array.isArray(data) ? data : (data.books || []);
      state.generatedAt = data.generated_at || '';
    } catch (err) {
      el.deck.textContent = '';
      el.deck.append(textEl('p', 'deck-msg', `books.json を読み込めませんでした（${err.message}）`));
      el.progress.textContent = '';
      return;
    }
    if (state.generatedAt) {
      el.credit.textContent = `書誌・書影: openBD／国立国会図書館サーチ／版元ドットコム　データ取得: ${state.generatedAt.slice(0, 10)}`;
    }
    document.body.dataset.ready = '1';
    render();
  }
  boot();
})();
