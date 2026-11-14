/* 積読スワイプ — 依存なしの静的アプリ */
(() => {
  'use strict';

  const STORE_KEY = 'tsundoku-swipe:v1';
  const SYNC_KEY = 'tsundoku-swipe:sync';       // 同期設定（この端末のブラウザにだけ保存）
  const SYNC_FILE = 'records.json';
  const SYNC_DEBOUNCE_MS = 2000;                // 変更をまとめて書き込むまでの待ち時間
  const QR_PREFIX = 'tsundoku-swipe-sync:1:';
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
    btnSync: $('#btn-sync'),
    syncLine: $('#sync-line'),
    syncDialog: $('#sync-dialog'),
    btnCloseSync: $('#btn-close-sync'),
    syncState: $('#sync-state'),
    syncOnActions: $('#sync-on-actions'),
    btnSyncNow: $('#btn-sync-now'),
    btnShowQr: $('#btn-show-qr'),
    btnSyncEdit: $('#btn-sync-edit'),
    btnSyncOff: $('#btn-sync-off'),
    qrBox: $('#qr-box'),
    qrCanvas: $('#qr-canvas'),
    btnHideQr: $('#btn-hide-qr'),
    syncForm: $('#sync-form'),
    syncRepo: $('#sync-repo'),
    syncToken: $('#sync-token'),
    btnSyncSave: $('#btn-sync-save'),
    btnScan: $('#btn-scan'),
    syncFormMsg: $('#sync-form-msg'),
    scanBox: $('#scan-box'),
    scanVideo: $('#scan-video'),
    scanMsg: $('#scan-msg'),
    btnScanStop: $('#btn-scan-stop'),
  };

  const state = {
    books: [],
    generatedAt: '',
    decisions: {},  // isbn -> 'save' | 'skip'
    saved: [],      // 保存順のスナップショット
    stamps: {},     // isbn -> 最後に変更した時刻(ms)。端末間のマージで「新しい方」を決める
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
        state.stamps = raw.stamps && typeof raw.stamps === 'object' ? raw.stamps : {};
        state.last = raw.last || null;
      }
    } catch (_) { /* 壊れていたら初期状態から */ }
  }
  function persist() {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      version: 1, decisions: state.decisions, saved: state.saved, last: state.last, stamps: state.stamps,
    }));
  }
  // 本ごとの変更時刻を進める（端末の時計が多少ずれていても、その本の直前の記録より必ず新しくする）
  function touch(isbn) {
    state.stamps[isbn] = Math.max(Date.now(), (Number(state.stamps[isbn]) || 0) + 1);
  }
  // ローカルで記録を変えた時：保存して、同期が有効なら少し待ってから書き込む
  function changed() {
    persist();
    scheduleSync();
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
      for (const [isbn, act] of Object.entries(state.decisions)) {
        if (act === 'skip') { delete state.decisions[isbn]; touch(isbn); }
      }
      state.last = null;
      changed();
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
    touch(book.isbn);
    changed();
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
    touch(isbn);
    changed();
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
        touch(b.isbn);
        changed();
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


  // ------------------------------------------------------------ sync (GitHub 非公開リポジトリの records.json)
  // 設定が無ければ何もしない（今まで通りこの端末だけで動く）。
  // 記録は本ごとに { t: 変更時刻ms, d: 'save'|'skip'（無ければ未判定）, s: 保存一覧の項目（無ければ一覧に無い） }。
  // d も s も無い記録は「取り消した／一覧から消した」印（他端末で復活しないように残す）。
  const SAVED_FIELDS = ['title', 'author', 'publisher', 'pubdate', 'cover', 'source', 'source_url', 'savedAt'];
  const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;

  const sync = {
    cfg: null,          // { repo: 'owner/name', token }
    sha: null,          // 最後に読み書きした records.json の SHA
    remoteCanon: null,  // その時のリモートの中身（比較用）
    timer: 0,
    running: false,
    want: null,         // 'pull' | 'push'
    error: null,
    lastOk: 0,
    lastPull: 0,
  };

  class SyncError extends Error {
    constructor(message, kind) { super(message); this.kind = kind; }
  }

  function cleanSaved(src, isbn) {
    const o = { isbn };
    for (const k of SAVED_FIELDS) if (src[k] != null && src[k] !== '') o[k] = String(src[k]);
    return o;
  }
  function normRecord(r, isbn) {
    if (!r || typeof r !== 'object') return null;
    const t = Number(r.t);
    const out = { t: Number.isFinite(t) && t > 0 ? Math.floor(t) : 0 };
    if (r.d === 'save' || r.d === 'skip') out.d = r.d;
    if (r.s && typeof r.s === 'object') out.s = cleanSaved(r.s, isbn);
    return out;
  }
  function localRecords() {
    const recs = {};
    const savedBy = new Map(state.saved.map((s) => [s.isbn, s]));
    const keys = new Set([...Object.keys(state.decisions), ...savedBy.keys(), ...Object.keys(state.stamps)]);
    for (const isbn of keys) {
      const s = savedBy.get(isbn);
      // 同期機能より前の記録には時刻が無いので、保存日時（無ければ 0＝いちばん古い）を使う
      const t = state.stamps[isbn] != null ? state.stamps[isbn] : (s && Date.parse(s.savedAt)) || 0;
      recs[isbn] = normRecord({ t, d: state.decisions[isbn], s }, isbn);
    }
    return recs;
  }
  function sortedObj(o) {
    const out = {};
    for (const k of Object.keys(o).sort()) out[k] = o[k];
    return out;
  }
  function canon(recs) { return JSON.stringify(sortedObj(recs)); }
  function strength(r) { return r.s ? 2 : r.d === 'save' ? 1 : 0; }
  // 本ごとに新しい方を採る。時刻が同じなら「保存」を残す側に倒し、最後は中身で決める（どの端末でも同じ結果になる）
  function newer(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.t !== b.t) return a.t > b.t ? a : b;
    if (strength(a) !== strength(b)) return strength(a) > strength(b) ? a : b;
    return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
  }
  function mergeRecords(local, remote) {
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) out[k] = newer(local[k], remote[k]);
    return out;
  }
  // マージ結果を画面の状態に反映。ローカルが変わったら true
  function applyRecords(recs) {
    const before = localRecords();
    if (canon(before) === canon(recs)) return false;
    const decisions = {};
    const stamps = {};
    const saved = [];
    for (const [isbn, r] of Object.entries(recs)) {
      stamps[isbn] = r.t;
      if (r.d) decisions[isbn] = r.d;
      if (r.s) saved.push(r.s);
    }
    saved.sort((x, y) => String(x.savedAt || '').localeCompare(String(y.savedAt || '')));
    if (state.last && JSON.stringify(before[state.last.isbn]) !== JSON.stringify(recs[state.last.isbn])) {
      state.last = null; // 他の端末で変わった本は「取り消し」の対象から外す
    }
    state.decisions = decisions;
    state.stamps = stamps;
    state.saved = saved;
    persist();
    return true;
  }
  function onRemoteApplied() {
    if (document.body.dataset.ready === '1' && !state.busy) render();
    else el.savedCount.textContent = String(state.saved.length);
    if (el.dialog.open) renderSaved();
    toast('ほかの端末の記録を反映しました');
  }

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(cfg, method, body) {
    const [owner, name] = cfg.repo.split('/');
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${SYNC_FILE}`;
    const headers = {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body) headers['Content-Type'] = 'application/json';
    try {
      return await fetch(url, { method, headers, cache: 'no-store', body: body ? JSON.stringify(body) : undefined });
    } catch (_) {
      throw new SyncError('通信できませんでした（オフラインかもしれません）', 'network');
    }
  }
  function httpError(res) {
    if (res.status === 401) return new SyncError('トークンが無効か、期限切れです', 'auth');
    if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
      return new SyncError('GitHub の利用回数の上限に達しました。しばらくしてから「今すぐ同期」を押してください', 'rate');
    }
    if (res.status === 403) return new SyncError('トークンに書き込みの権限がありません（Contents の書き込みが必要です）', 'perm');
    if (res.status === 404) return new SyncError('リポジトリが見つかりません（リポジトリ名と、トークンの対象リポジトリを確認してください）', 'notfound');
    return new SyncError(`GitHub の応答エラー（HTTP ${res.status}）`, 'http');
  }
  async function pullRemote(cfg) {
    const res = await api(cfg, 'GET');
    if (res.status === 404) {
      // ファイルが無い（またはリポジトリに届かない）。書き込みの応答で判定する
      sync.sha = null;
      sync.remoteCanon = null;
      return {};
    }
    if (!res.ok) throw httpError(res);
    const meta = await res.json();
    const recs = {};
    try {
      const data = JSON.parse(b64decode(meta.content || ''));
      const books = data && data.books && typeof data.books === 'object' ? data.books : {};
      for (const [isbn, r] of Object.entries(books)) {
        const n = normRecord(r, isbn);
        if (n) recs[isbn] = n;
      }
    } catch (_) {
      throw new SyncError('リポジトリの記録ファイルを読めませんでした（中身が壊れているかもしれません）', 'parse');
    }
    sync.sha = meta.sha || null;
    sync.remoteCanon = canon(recs);
    return recs;
  }
  // 書けたら true、SHA 不一致（他の端末が先に書いた）なら false
  async function pushRemote(cfg, recs) {
    const text = JSON.stringify({
      app: 'tsundoku-swipe', version: 1, updatedAt: new Date().toISOString(), books: sortedObj(recs),
    }, null, 1);
    const body = { message: 'update records', content: b64encode(text + '\n') };
    if (sync.sha) body.sha = sync.sha;
    const res = await api(cfg, 'PUT', body);
    if (res.status === 409 || res.status === 422) return false;
    if (!res.ok) throw httpError(res);
    const out = await res.json();
    sync.sha = (out.content && out.content.sha) || null;
    sync.remoteCanon = canon(recs);
    return true;
  }
  async function syncOnce(cfg, mode) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(500 * attempt);
      if (mode === 'pull' || attempt > 0 || sync.remoteCanon === null) {
        const remote = await pullRemote(cfg);
        if (mode === 'pull') sync.lastPull = Date.now();
        if (applyRecords(mergeRecords(localRecords(), remote))) onRemoteApplied();
      }
      const local = localRecords();
      if (canon(local) === sync.remoteCanon) return;
      if (await pushRemote(cfg, local)) return;
      // SHA 不一致：次の周回で取り直して再マージ
    }
    throw new SyncError('ほかの端末の書き込みと重なり、書き込めませんでした。少しあとで「今すぐ同期」を押してください', 'conflict');
  }

  function requestSync(mode) {
    if (!sync.cfg) return;
    if (mode === 'pull' || !sync.want) sync.want = mode;
    clearTimeout(sync.timer);
    sync.timer = 0;
    if (!sync.running) runSync();
    else renderSyncStatus();
  }
  async function runSync() {
    sync.running = true;
    renderSyncStatus();
    while (sync.want && sync.cfg) {
      const mode = sync.want;
      const cfg = sync.cfg;
      sync.want = null;
      try {
        await syncOnce(cfg, mode);
        sync.error = null;
        sync.lastOk = Date.now();
      } catch (err) {
        sync.error = err instanceof SyncError ? err : new SyncError(`同期できませんでした（${err && err.message}）`, 'unknown');
        break; // 記録はローカルに残っている。次の変更・画面の再表示・「今すぐ同期」で再試行
      }
    }
    sync.running = false;
    renderSyncStatus();
  }
  function scheduleSync() {
    if (!sync.cfg) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(() => requestSync('push'), SYNC_DEBOUNCE_MS);
    renderSyncStatus();
  }

  // ---- 設定の保存（localStorage のこのキーだけ。コードやリポジトリには入れない）
  function loadSyncCfg() {
    try {
      const c = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
      if (c && typeof c.repo === 'string' && typeof c.token === 'string' && c.repo && c.token) {
        return { repo: c.repo, token: c.token };
      }
    } catch (_) { /* 壊れていたら未設定扱い */ }
    return null;
  }
  function setSyncCfg(cfg) {
    if (cfg) localStorage.setItem(SYNC_KEY, JSON.stringify({ v: 1, repo: cfg.repo, token: cfg.token }));
    else localStorage.removeItem(SYNC_KEY);
    sync.cfg = cfg;
    sync.sha = null;
    sync.remoteCanon = null;
    sync.error = null;
    sync.lastOk = 0;
    sync.want = null;
    clearTimeout(sync.timer);
    sync.timer = 0;
  }
  function normalizeRepo(v) {
    const r = String(v || '').trim()
      .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
    return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(r) ? r : '';
  }

  // ---- 表示
  function fmtClock(ms) {
    const d = new Date(ms);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function syncStatusText() {
    if (!sync.cfg) return '';
    if (sync.running) return '同期中…';
    if (sync.timer) return '同期待ち…';
    if (sync.error) return `同期できませんでした：${sync.error.message}。記録はこの端末に残っています`;
    if (sync.lastOk) return `同期済み ${fmtClock(sync.lastOk)}`;
    return '同期の準備中…';
  }
  function renderSyncStatus() {
    const on = !!sync.cfg;
    const isErr = on && !sync.running && !sync.timer && !!sync.error;
    el.btnSync.dataset.state = !on ? 'off' : (sync.running || sync.timer) ? 'busy' : isErr ? 'error' : sync.lastOk ? 'ok' : 'busy';
    el.btnSync.setAttribute('aria-label', on ? `端末間の同期：${syncStatusText()}` : '端末間の同期：未設定');
    el.syncLine.hidden = !on;
    el.syncLine.textContent = syncStatusText();
    el.syncLine.classList.toggle('is-error', isErr);
    if (el.syncDialog.open) renderSyncDialog();
  }
  const syncUi = { editing: false, qrTimer: 0, scanSession: 0, stream: null, scanTimer: 0, scanCanvas: null };
  function renderSyncDialog() {
    const cfg = sync.cfg;
    el.syncState.textContent = '';
    if (!cfg) {
      el.syncState.append('この端末では未設定です。記録はこの端末だけに保存されます。');
    } else {
      el.syncState.append(`設定済み：${cfg.repo}（トークン末尾 …${cfg.token.slice(-4)}）`, document.createElement('br'), syncStatusText());
    }
    el.syncState.classList.toggle('is-error', !!cfg && !sync.running && !sync.timer && !!sync.error);
    el.syncOnActions.hidden = !cfg;
    el.syncForm.hidden = !!cfg && !syncUi.editing;
    el.btnShowQr.disabled = !cfg;
  }
  function openSync() {
    syncUi.editing = false;
    el.syncFormMsg.textContent = '';
    el.syncToken.value = '';
    el.syncRepo.value = sync.cfg ? sync.cfg.repo : '';
    renderSyncDialog();
    if (typeof el.syncDialog.showModal === 'function') el.syncDialog.showModal();
    else el.syncDialog.setAttribute('open', '');
  }
  function closeSync() {
    if (typeof el.syncDialog.close === 'function') el.syncDialog.close();
    else el.syncDialog.removeAttribute('open');
  }
  function onSyncDialogClosed() {
    stopScan();
    hideQr();
    el.syncToken.value = '';
    syncUi.editing = false;
  }
  function applySyncCfg(cfg) {
    setSyncCfg(cfg);
    el.syncToken.value = '';
    el.syncFormMsg.textContent = '';
    syncUi.editing = false;
    requestSync('pull');
    renderSyncStatus();
    renderSyncDialog();
  }
  function onSyncSave() {
    const repo = normalizeRepo(el.syncRepo.value);
    const token = el.syncToken.value.trim() || (sync.cfg ? sync.cfg.token : '');
    if (!repo) { el.syncFormMsg.textContent = 'リポジトリは「持ち主/名前」の形で入れてください（例：alpino/xxxx）'; return; }
    if (!TOKEN_RE.test(token)) { el.syncFormMsg.textContent = 'トークンの形が正しくありません。コピーし直して貼り付けてください'; return; }
    applySyncCfg({ repo, token });
  }
  function onSyncOff() {
    if (!window.confirm('この端末の同期を解除し、トークンをこのブラウザから消します。記録はこの端末に残ります。よろしいですか？')) return;
    hideQr();
    setSyncCfg(null);
    renderSyncStatus();
    renderSyncDialog();
    toast('この端末の同期を解除しました');
  }

  // ---- QR（同梱の vendor/qrcode.js・vendor/jsQR.js を必要な時だけ読み込む）
  function loadScript(src, ready) {
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => (ready() ? resolve() : reject(new Error(`${src} を読み込めませんでした`)));
      s.onerror = () => reject(new Error(`${src} を読み込めませんでした`));
      document.head.append(s);
    });
  }
  async function showQr() {
    if (!sync.cfg) return;
    try {
      await loadScript('vendor/qrcode.js', () => typeof window.qrcode === 'function');
    } catch (err) {
      toast(err.message);
      return;
    }
    const qr = window.qrcode(0, 'M');
    qr.addData(`${QR_PREFIX}${sync.cfg.repo}:${sync.cfg.token}`, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    const scale = 8;
    const size = (n + quiet * 2) * scale;
    const c = el.qrCanvas;
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) {
      for (let col = 0; col < n; col++) {
        if (qr.isDark(r, col)) ctx.fillRect((col + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    el.qrBox.hidden = false;
    el.qrBox.scrollIntoView({ block: 'nearest' });
    clearTimeout(syncUi.qrTimer);
    syncUi.qrTimer = setTimeout(hideQr, 120000);
  }
  function hideQr() {
    clearTimeout(syncUi.qrTimer);
    const c = el.qrCanvas;
    if (c.width) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    c.width = 0;
    c.height = 0;
    el.qrBox.hidden = true;
  }
  function parseQr(text) {
    if (typeof text !== 'string' || !text.startsWith(QR_PREFIX)) return null;
    const rest = text.slice(QR_PREFIX.length);
    const i = rest.lastIndexOf(':');
    if (i < 0) return null;
    const repo = normalizeRepo(rest.slice(0, i));
    const token = rest.slice(i + 1);
    return repo && TOKEN_RE.test(token) ? { repo, token } : null;
  }
  async function startScan() {
    stopScan();
    const session = ++syncUi.scanSession;
    el.scanBox.hidden = false;
    el.scanMsg.textContent = 'カメラを起動しています…';
    el.scanBox.scrollIntoView({ block: 'nearest' });
    let stream;
    try {
      await loadScript('vendor/jsQR.js', () => typeof window.jsQR === 'function');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no camera');
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (_) {
      if (session === syncUi.scanSession) {
        el.scanMsg.textContent = 'カメラを使えませんでした。カメラの許可を確認するか、トークンを貼り付けてください';
      }
      return;
    }
    if (session !== syncUi.scanSession) { stream.getTracks().forEach((t) => t.stop()); return; }
    syncUi.stream = stream;
    el.scanVideo.srcObject = stream;
    const playing = el.scanVideo.play();
    if (playing) playing.catch(() => { /* autoplay 属性で再生される */ });
    el.scanMsg.textContent = 'QRをカメラに映してください';
    syncUi.scanCanvas = syncUi.scanCanvas || document.createElement('canvas');
    const tick = () => {
      if (session !== syncUi.scanSession || !syncUi.stream) return;
      const v = el.scanVideo;
      if (v.readyState >= 2 && v.videoWidth) {
        const k = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
        const w = Math.round(v.videoWidth * k);
        const h = Math.round(v.videoHeight * k);
        const cv = syncUi.scanCanvas;
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(v, 0, 0, w, h);
        const code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
        if (code && code.data) {
          const cfg = parseQr(code.data);
          if (cfg) {
            stopScan();
            applySyncCfg(cfg);
            toast('QRを読み取り、同期を設定しました');
            return;
          }
          el.scanMsg.textContent = 'このサイトの同期用のQRではありません';
        }
      }
      syncUi.scanTimer = setTimeout(tick, 200);
    };
    tick();
  }
  function stopScan() {
    syncUi.scanSession++;
    clearTimeout(syncUi.scanTimer);
    if (syncUi.stream) syncUi.stream.getTracks().forEach((t) => t.stop());
    syncUi.stream = null;
    el.scanVideo.srcObject = null;
    el.scanBox.hidden = true;
  }

  el.btnSync.addEventListener('click', openSync);
  el.btnCloseSync.addEventListener('click', closeSync);
  el.syncDialog.addEventListener('close', onSyncDialogClosed);
  el.syncDialog.addEventListener('click', (e) => { if (e.target === el.syncDialog) closeSync(); });
  el.btnSyncSave.addEventListener('click', onSyncSave);
  for (const inp of [el.syncRepo, el.syncToken]) {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onSyncSave(); } });
  }
  el.btnSyncNow.addEventListener('click', () => requestSync('pull'));
  el.btnShowQr.addEventListener('click', showQr);
  el.btnHideQr.addEventListener('click', hideQr);
  el.btnSyncEdit.addEventListener('click', () => {
    syncUi.editing = true;
    el.syncRepo.value = sync.cfg ? sync.cfg.repo : '';
    el.syncToken.value = '';
    el.syncToken.placeholder = sync.cfg ? '変えない時は空欄のまま' : 'github_pat_…';
    renderSyncDialog();
  });
  el.btnSyncOff.addEventListener('click', onSyncOff);
  el.btnScan.addEventListener('click', startScan);
  el.btnScanStop.addEventListener('click', stopScan);

  // 画面に戻った時に取り直す／離れる時は待たずに書き込む／回線が戻ったら再試行
  document.addEventListener('visibilitychange', () => {
    if (!sync.cfg) return;
    if (document.visibilityState === 'hidden') {
      if (sync.timer) requestSync('push');
    } else if (Date.now() - sync.lastPull > 5000) {
      requestSync('pull');
    }
  });
  window.addEventListener('online', () => requestSync('pull'));

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
    if (el.dialog.open || el.syncDialog.open || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); decide('save'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); decide('skip'); }
    else if (e.key === 'z' || e.key === 'Z' || e.key === 'Backspace') { e.preventDefault(); undo(); }
  });

  // ------------------------------------------------------------ boot
  async function boot() {
    loadStore();
    sync.cfg = loadSyncCfg();
    renderSyncStatus();
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
    if (sync.cfg) requestSync('pull');
  }
  boot();
})();
