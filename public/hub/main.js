// ハブの画面と通信。ゲーム一覧 → 部屋の作成/参加 → ロビー → ゲーム画面、の流れを受け持つ。
import { connect, isOnlineConfigured } from './transport.js';
import { createRoomHost, HUB_MAX_PLAYERS } from './room.js';
import { esc, chip, qrSvg, store } from './util.js';
import { GAME_MODULES, EXTERNAL_GAMES } from '../games/registry.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const app = document.getElementById('app');
const params = new URLSearchParams(location.search);

const myId = store.get('sessionStorage', 'hub_id') || Math.random().toString(36).slice(2, 10);
store.set('sessionStorage', 'hub_id', myId);

/** 読み込めたゲーム（id → プラグイン） */
const games = new Map();
const loadErrors = [];

let ui = {
  screen: 'home', // home | connecting | room
  name: store.get('sessionStorage', 'hub_name') || store.get('localStorage', 'hub_name') || '',
  code: (params.get('room') || '').toUpperCase(),
  error: '',
  info: '',
};
let tx = null;
let host = null;
let isHost = false;
let state = null;
let clockOffset = 0;
let lastStateAt = 0;
let pingTimer = null;
let mounted = null; // { gameId, instance, root, sig }

// ---------- ゲームの読み込み ----------

async function loadGames() {
  for (const path of GAME_MODULES) {
    try {
      const mod = await import(`../games/${path.replace(/^\.\//, '')}`);
      const g = mod.default;
      if (!g?.meta?.id || !g.host?.setup || !g.host?.action || !g.client?.mount) throw new Error('meta / host.setup / host.action / client.mount が必要です');
      games.set(g.meta.id, g);
    } catch (e) {
      console.error(`ゲーム ${path} を読み込めませんでした`, e);
      loadErrors.push(`${path}: ${e.message}`);
    }
  }
}

// ---------- 通信 ----------

let lastSig = '';
function onState(s, hostNow) {
  clockOffset = (hostNow ?? Date.now()) - Date.now();
  lastStateAt = Date.now();
  const sig = JSON.stringify(s);
  // 変化のない定期送信では描き直さない
  if (sig === lastSig && ui.screen === 'room') return;
  lastSig = sig;
  state = s;
  if (ui.screen !== 'room' && s.players.some((p) => p.id === myId)) ui.screen = 'room';
  render();
}

function sendRaw(msg) {
  const m = { ...msg, id: myId };
  if (isHost) return host.handle(m);
  tx?.send(m);
  return null;
}

const ctxFor = () => ({
  me: { id: myId, name: ui.name },
  isHost,
  hostId: state.hostId,
  players: state.players,
  code: state.code,
  now: () => Date.now() + clockOffset,
  send: (a) => sendRaw({ t: 'act', a }),
});

function newCode() {
  return Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}

// 同じコードの部屋がすでにあるか確かめる
async function roomExists(code) {
  let found = false;
  const probe = await connect(code, (m) => {
    if (m.t === 'state') found = true;
  });
  probe.send({ t: 'ping', id: 'probe' });
  await new Promise((r) => setTimeout(r, 1500));
  probe.close();
  return found;
}

async function createRoom(gameId) {
  if (!readName()) return;
  ui.screen = 'connecting';
  ui.info = '部屋を作っています…';
  render();
  try {
    let code = newCode();
    for (let i = 0; i < 4 && (await roomExists(code)); i++) code = newCode();
    await becomeHost(code, null, gameId);
  } catch (e) {
    fail(e);
  }
}

async function becomeHost(code, saved, gameId) {
  isHost = true;
  tx = await connect(code, (m) => {
    if (!host || m.t === 'state' || m.t === 'reject') return;
    const r = host.handle(m);
    if (r && r.reject) tx.send({ t: 'reject', to: m.id, reason: r.reject });
  });
  host = createRoomHost({
    code,
    hostId: myId,
    games,
    saved,
    emit: (pub, full) => {
      const n = Date.now();
      tx.send({ t: 'state', s: pub, now: n });
      store.set('sessionStorage', `hub_host_${code}`, JSON.stringify(full));
      onState(pub, n);
    },
  });
  if (!saved) {
    if (gameId) host.handle({ t: 'hub', op: 'select', id: myId, gameId });
    host.handle({ t: 'join', id: myId, name: ui.name });
  } else host.publish();
  ui.code = code;
  history.replaceState(null, '', `?room=${code}`);
}

async function joinRoom() {
  if (!readName()) return;
  const code = ui.code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    ui.error = 'ルームコードは4文字です';
    render();
    return;
  }
  Object.assign(ui, { code, screen: 'connecting', info: `部屋 ${code} に入っています…`, error: '' });
  render();
  try {
    let rejected = null;
    tx = await connect(code, (m) => {
      if (m.t === 'state') onState(m.s, m.now);
      else if (m.t === 'reject' && m.to === myId) rejected = m.reason;
    });
    history.replaceState(null, '', `?room=${code}`);
    const started = Date.now();
    while (ui.screen !== 'room') {
      if (rejected) throw new Error(rejected);
      if (Date.now() - started > 8000) throw new Error(`部屋 ${code} が見つかりませんでした。コードを確かめてね。`);
      tx.send({ t: 'join', id: myId, name: ui.name });
      await new Promise((r) => setTimeout(r, 1200));
    }
    store.set('sessionStorage', 'hub_joined', code);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => tx.send({ t: 'ping', id: myId }), 3000);
  } catch (e) {
    fail(e);
  }
}

function fail(e) {
  tx?.close();
  tx = null;
  isHost = false;
  ui.screen = 'home';
  ui.error = e.message || String(e);
  render();
}

function readName() {
  const el = document.getElementById('name');
  ui.name = (el ? el.value : ui.name).trim().slice(0, 10);
  if (!ui.name) {
    ui.error = '先に名前を入れてね';
    render();
    document.getElementById('name')?.focus();
    return false;
  }
  store.set('localStorage', 'hub_name', ui.name);
  store.set('sessionStorage', 'hub_name', ui.name);
  return true;
}

function leave() {
  if (!isHost) sendRaw({ t: 'leave' });
  host?.stop();
  tx?.close();
  store.set('sessionStorage', 'hub_joined', null);
  if (isHost && state) store.set('sessionStorage', `hub_host_${state.code}`, null);
  location.href = location.pathname;
}

// ---------- 画面 ----------

const playerRange = (m) => (m.minPlayers === m.maxPlayers ? `${m.minPlayers}人` : `${m.minPlayers}〜${m.maxPlayers}人`);

function render() {
  if (ui.screen === 'home') return renderHome();
  if (ui.screen === 'connecting' || !state) {
    unmountGame();
    app.innerHTML = `<header class="brand">🎲 パーティーハブ</header><div class="card center"><p>${esc(ui.info)}</p></div>`;
    return;
  }
  if (state.phase === 'game') return renderGame();
  unmountGame();
  renderLobby();
}

function modeBanner() {
  return isOnlineConfigured()
    ? ''
    : '<div class="banner">ローカルモード：同じブラウザのタブ同士でだけ遊べます。スマホで遊ぶには config.js に Supabase を設定してください。</div>';
}

function gameCard(m, { selectable = false, selected = false, external = false, noAction = false } = {}) {
  const action = noAction
    ? ''
    : external
    ? `<a class="button" href="${esc(m.url)}" target="_blank" rel="noopener">開く ↗</a>`
    : selectable
      ? `<button data-act="select" data-game="${esc(m.id)}" ${selected ? 'class="primary" disabled' : ''}>${selected ? '選択中' : 'これにする'}</button>`
      : `<button class="primary" data-act="create" data-game="${esc(m.id)}">この遊びで部屋を作る</button>`;
  return `
    <article class="game ${selected ? 'selected' : ''}">
      <div class="game-emoji">${esc(m.emoji || '🎮')}</div>
      <div class="game-body">
        <h3>${esc(m.title)}</h3>
        <p class="muted">${esc(m.description || '')}</p>
        <p class="tags"><span>${playerRange(m)}</span>${(m.tags || []).map((t) => `<span>${esc(t)}</span>`).join('')}${
          m.author ? `<span>作：${esc(m.author)}</span>` : ''
        }${external ? '<span>外部</span>' : ''}</p>
      </div>
      <div class="game-action">${action}</div>
    </article>`;
}

function renderHome() {
  unmountGame();
  const fromLink = Boolean(params.get('room'));
  app.innerHTML = `
    <header class="brand">🎲 パーティーハブ</header>
    <p class="muted">みんなのスマホで遊ぶミニゲーム集。1人が部屋を作り、ほかの人はQRコードかルームコードで入ります。</p>
    ${modeBanner()}
    ${ui.error ? `<div class="banner err">${esc(ui.error)}</div>` : ''}
    ${loadErrors.length ? `<div class="banner err">読み込めなかったゲーム: ${esc(loadErrors.join(' / '))}</div>` : ''}
    <div class="card">
      <label for="name">あなたの名前</label>
      <input id="name" maxlength="10" autocomplete="nickname" placeholder="例：たろう" value="${esc(ui.name)}" />
    </div>
    <div class="card">
      <h2>部屋に入る</h2>
      <div class="row">
        <input id="code" class="code" maxlength="4" autocapitalize="characters" placeholder="ABCD" value="${esc(ui.code)}" />
        <button class="${fromLink ? 'primary' : ''}" data-act="join">参加</button>
      </div>
    </div>
    <h2 class="section">ゲームを選んで部屋を作る</h2>
    <div class="games">
      ${[...games.values()].map((g) => gameCard(g.meta)).join('')}
      ${EXTERNAL_GAMES.map((m) => gameCard(m, { external: true })).join('')}
    </div>`;
}

function renderLobby() {
  const url = (() => {
    const u = new URL(location.href);
    u.search = `?room=${state.code}`;
    u.hash = '';
    return u.toString();
  })();
  const g = games.get(state.gameId);
  const online = state.players.filter((p) => p.online).length;
  const m = g?.meta;
  const okCount = m && online >= m.minPlayers && online <= m.maxPlayers;
  const localUrl = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  app.innerHTML = `
    <header class="brand">🎲 パーティーハブ</header>
    ${modeBanner()}
    <div class="card">
      <p class="muted center">ルームコード</p>
      <p class="roomcode">${esc(state.code)}</p>
      <div class="qr">${qrSvg(url)}</div>
      <p class="url">${esc(url)}</p>
      ${
        isOnlineConfigured() && localUrl
          ? '<div class="banner">このURLはこのPCの中でしか開けません。スマホから入るには、サーバーが表示した「同じWi-Fiのスマホから」のURLでこのページを開き直してください。</div>'
          : ''
      }
    </div>
    <div class="card">
      <h2>参加者 ${state.players.length} / ${HUB_MAX_PLAYERS}</h2>
      <ul class="players">${state.players.map((p) => `<li>${chip(state.players, p.id)}${p.id === state.hostId ? ' 👑' : ''}</li>`).join('')}</ul>
    </div>
    <h2 class="section">遊ぶゲーム</h2>
    ${m ? gameCard(m, { noAction: true }) : ''}
    ${
      isHost
        ? `<button class="primary big" data-act="start" ${okCount ? '' : 'disabled'}>${esc(m?.title || '')} をはじめる</button>
           ${!okCount && m ? `<p class="muted center">このゲームは${playerRange(m)}で遊べます（いま${online}人）</p>` : ''}
           <details class="card">
             <summary>ほかのゲームに変える</summary>
             <div class="games">${[...games.values()].map((x) => gameCard(x.meta, { selectable: true, selected: x.meta.id === state.gameId })).join('')}</div>
           </details>`
        : '<p class="muted center">ホストがはじめるのを待っています…</p>'
    }
    ${footer()}`;
}

function renderGame() {
  const g = games.get(state.gameId);
  if (!g) {
    app.innerHTML = `<div class="banner err">このゲーム（${esc(state.gameId)}）がこの端末で読み込めません。ページを再読み込みしてください。</div>${footer()}`;
    return;
  }
  if (!mounted || mounted.gameId !== state.gameId || !document.body.contains(mounted.root)) {
    unmountGame();
    app.innerHTML = `
      <header class="gamebar">
        <span>${esc(g.meta.emoji || '')} ${esc(g.meta.title)}</span>
        <span class="muted">部屋 ${esc(state.code)}</span>
        ${isHost ? '<button class="small" data-act="lobby">ロビーへ</button>' : ''}
      </header>
      <section id="game-root" class="game-root"></section>
      <div id="hub-footer"></div>`;
    const root = document.getElementById('game-root');
    mounted = { gameId: state.gameId, root, sig: '', instance: g.client.mount(root, ctxFor()) };
  }
  // 中身が変わったときだけゲームに知らせる（入力中の文字が消えないように）
  const sig = JSON.stringify([state.view, state.players]);
  if (sig !== mounted.sig) {
    mounted.sig = sig;
    try {
      mounted.instance.update(state.view, ctxFor());
    } catch (e) {
      console.error(e);
      mounted.root.innerHTML = `<div class="banner err">ゲームの表示でエラー: ${esc(e.message)}</div>`;
    }
  }
  document.getElementById('hub-footer').innerHTML = footer();
}

function unmountGame() {
  if (!mounted) return;
  try {
    mounted.instance.unmount?.();
  } catch (e) {
    console.error(e);
  }
  mounted = null;
}

function footer() {
  const lost = !isHost && Date.now() - lastStateAt > 8000;
  return `
    ${lost ? '<div class="banner err">ホストとの接続が切れているようです…</div>' : ''}
    <div class="spacer"></div>
    <button class="small ghost" data-act="leave">部屋を抜ける</button>`;
}

setInterval(() => {
  if (!isHost && ui.screen === 'room' && state) {
    const lost = Date.now() - lastStateAt > 8000;
    const shown = Boolean(document.querySelector('#hub-footer .banner.err, .banner.err'));
    if (lost !== shown) render();
  }
}, 1000);

// ---------- 操作 ----------

app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled || b.closest('#game-root')) return;
  const act = b.dataset.act;
  if (act === 'create') createRoom(b.dataset.game);
  else if (act === 'join') {
    ui.code = document.getElementById('code').value;
    joinRoom();
  } else if (act === 'select') sendRaw({ t: 'hub', op: 'select', gameId: b.dataset.game });
  else if (act === 'start' || act === 'lobby') {
    if (act === 'lobby' && !confirm('ゲームを終えてロビーに戻りますか？')) return;
    sendRaw({ t: 'hub', op: act });
  } else if (act === 'leave') {
    if (confirm('部屋を抜けますか？')) leave();
  }
});
app.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'code') {
    ui.code = e.target.value;
    joinRoom();
  }
});
window.addEventListener('pagehide', () => {
  if (tx && !isHost) tx.send({ t: 'leave', id: myId });
});

// ---------- 起動 ----------

(async function boot() {
  app.innerHTML = '<header class="brand">🎲 パーティーハブ</header>';
  await loadGames();
  const code = ui.code;
  const saved = code && store.get('sessionStorage', `hub_host_${code}`);
  if (saved) {
    Object.assign(ui, { screen: 'connecting', info: '部屋に戻っています…' });
    render();
    try {
      await becomeHost(code, JSON.parse(saved));
    } catch (e) {
      fail(e);
    }
    return;
  }
  if (code && ui.name && store.get('sessionStorage', 'hub_joined') === code) {
    joinRoom();
    return;
  }
  render();
})();
