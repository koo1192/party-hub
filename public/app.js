// 画面と通信のつなぎ込み。ホストもゲストも同じ画面コードで、ホストだけが host.js を動かす。
import { connect, isOnlineConfigured } from './transport.js';
import { createHost, MIN_PLAYERS, MAX_PLAYERS, TIME_LIMIT_MS } from './host.js';

const COLORS = ['#e4572e', '#2a9d8f', '#7b4fd6', '#e9a213', '#2f7fd8', '#d6457c'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const store = {
  get(area, k) {
    try { return window[area].getItem(k); } catch { return null; }
  },
  set(area, k, v) {
    try { v == null ? window[area].removeItem(k) : window[area].setItem(k, v); } catch { /* 保存できない環境では無視 */ }
  },
};

const randomId = () => Math.random().toString(36).slice(2, 10);
const myId = store.get('sessionStorage', 'kq_id') || randomId();
store.set('sessionStorage', 'kq_id', myId);

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);

let ui = {
  screen: 'home', // home | connecting | game
  name: store.get('sessionStorage', 'kq_name') || store.get('localStorage', 'kq_name') || '',
  code: (params.get('room') || '').toUpperCase(),
  error: '',
  info: '',
};
let tx = null;
let host = null;
let isHost = false;
let state = null;
let localDeadline = 0;
let lastStateAt = 0;
let pingTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const colorOf = (id) => {
  const i = state ? state.players.findIndex((p) => p.id === id) : -1;
  return COLORS[(i < 0 ? 0 : i) % COLORS.length];
};
const nameOf = (id) => state?.players.find((p) => p.id === id)?.name || '？';
const chip = (id, cls = '') => {
  const p = state.players.find((x) => x.id === id);
  return `<span class="chip ${cls} ${p && !p.online ? 'off' : ''}" style="background:${colorOf(id)}">${esc(nameOf(id))}</span>`;
};

function joinUrl(code) {
  const u = new URL(location.href);
  u.search = `?room=${code}`;
  u.hash = '';
  return u.toString();
}

function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return '';
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
}

// ---------- 通信 ----------

function onState(s) {
  state = s;
  localDeadline = Date.now() + s.remain;
  lastStateAt = Date.now();
  if (ui.screen !== 'game' && s.players.some((p) => p.id === myId)) ui.screen = 'game';
  render();
}

function send(msg) {
  const m = { ...msg, id: myId };
  if (isHost) {
    const r = host.handle(m);
    return r;
  }
  tx?.send(m);
  return null;
}

async function createRoom() {
  if (!readName()) return;
  ui.screen = 'connecting';
  ui.info = '部屋を作っています…';
  render();
  try {
    let code;
    for (let tries = 0; tries < 5; tries++) {
      code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
      const taken = await probeRoom(code);
      if (!taken) break;
    }
    await becomeHost(code, null);
  } catch (e) {
    fail(e);
  }
}

// 同じコードの部屋がすでにあるか確かめる
async function probeRoom(code) {
  let found = false;
  const probe = await connect(code, (m) => {
    if (m.t === 'state') found = true;
  });
  probe.send({ t: 'ping', id: 'probe' });
  await new Promise((r) => setTimeout(r, 1500));
  probe.close();
  return found;
}

async function becomeHost(code, saved) {
  isHost = true;
  tx = await connect(code, (m) => {
    if (m.t === 'state' || m.t === 'reject') return;
    if (!host) return;
    const r = host.handle(m);
    if (r && r.reject) tx.send({ t: 'reject', to: m.id, reason: r.reject });
  });
  host = createHost(code, myId, (pub, full) => {
    tx.send({ t: 'state', s: pub });
    store.set('sessionStorage', `kq_host_${code}`, JSON.stringify(full));
    onState(pub);
  }, saved);
  if (!saved) host.handle({ t: 'join', id: myId, name: ui.name });
  else host.publish();
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
  ui.code = code;
  ui.screen = 'connecting';
  ui.info = `部屋 ${code} に入っています…`;
  ui.error = '';
  render();
  try {
    let rejected = null;
    tx = await connect(code, (m) => {
      if (m.t === 'state') onState(m.s);
      else if (m.t === 'reject' && m.to === myId) rejected = m.reason;
    });
    history.replaceState(null, '', `?room=${code}`);
    const started = Date.now();
    while (ui.screen !== 'game') {
      if (rejected) throw new Error(rejected);
      if (Date.now() - started > 8000) throw new Error(`部屋 ${code} が見つかりませんでした。コードを確かめてね。`);
      tx.send({ t: 'join', id: myId, name: ui.name });
      await new Promise((r) => setTimeout(r, 1200));
    }
    store.set('sessionStorage', 'kq_joined', code);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => tx.send({ t: 'ping', id: myId }), 3000);
  } catch (e) {
    fail(e);
  }
}

function fail(e) {
  tx?.close();
  tx = null;
  ui.screen = 'home';
  ui.error = e.message || String(e);
  render();
}

function readName() {
  const el = document.getElementById('name');
  ui.name = (el ? el.value : ui.name).trim().slice(0, 10);
  if (!ui.name) {
    ui.error = '名前を入れてね';
    render();
    return false;
  }
  store.set('localStorage', 'kq_name', ui.name);
  store.set('sessionStorage', 'kq_name', ui.name);
  return true;
}

function leave() {
  if (!isHost) send({ t: 'leave' });
  host?.stop();
  tx?.close();
  store.set('sessionStorage', 'kq_joined', null);
  if (isHost && state) store.set('sessionStorage', `kq_host_${state.code}`, null);
  location.href = location.pathname;
}

// ---------- 画面 ----------

function render() {
  if (ui.screen === 'home') return renderHome();
  if (ui.screen === 'connecting' || !state) {
    app.innerHTML = `<h1>🧩 かけらクイズ</h1><div class="card center"><p>${esc(ui.info)}</p></div>`;
    return;
  }
  const views = { lobby: renderLobby, question: renderQuestion, reveal: renderReveal, result: renderResult };
  app.innerHTML = (views[state.phase] || renderLobby)() + footer();
  tick();
}

function modeBanner() {
  return isOnlineConfigured()
    ? ''
    : `<div class="banner">ローカルモード：同じブラウザのタブ同士でだけ遊べます。スマホで遊ぶには config.js に Supabase を設定してください。</div>`;
}

function renderHome() {
  const fromLink = Boolean(params.get('room'));
  app.innerHTML = `
    <h1>🧩 かけらクイズ</h1>
    <p class="muted">ヒントのかけらを持ち寄って、みんなで答える協力クイズ（${MIN_PLAYERS}〜${MAX_PLAYERS}人）</p>
    ${modeBanner()}
    ${ui.error ? `<div class="banner err">${esc(ui.error)}</div>` : ''}
    <div class="card">
      <label for="name">あなたの名前</label>
      <input id="name" maxlength="10" autocomplete="nickname" placeholder="例：たろう" value="${esc(ui.name)}" />
    </div>
    <div class="card">
      <h2>部屋に入る</h2>
      <input id="code" class="code" maxlength="4" inputmode="text" autocapitalize="characters" placeholder="ABCD" value="${esc(ui.code)}" />
      <button class="${fromLink ? 'primary' : ''}" data-act="join">参加する</button>
    </div>
    <div class="card">
      <h2>部屋を作る</h2>
      <p class="muted">あなたがホストになります。ほかの人はQRコードかルームコードで参加します。</p>
      <button class="${fromLink ? '' : 'primary'}" data-act="create">部屋を作る</button>
    </div>
    <div class="card">
      <h2>遊び方</h2>
      <ol class="rules">
        <li>1問ごとに6つのヒントが、全員のスマホにバラバラに配られます。</li>
        <li>自分のヒントを声に出して伝え合い、6つの選択肢から答えを1つに絞ります。</li>
        <li>全員が同じ選択肢をタップすると回答が確定します。</li>
        <li>制限時間は${TIME_LIMIT_MS / 1000}秒。時間切れなら多数決（同数ならハズレ）。</li>
        <li>10問中、何問正解できるかがチームのスコアです。</li>
      </ol>
    </div>`;
}

function renderLobby() {
  const url = joinUrl(state.code);
  const online = state.players.filter((p) => p.online).length;
  const canStart = online >= MIN_PLAYERS;
  return `
    <h1>🧩 かけらクイズ</h1>
    ${modeBanner()}
    <div class="card">
      <p class="muted center">ルームコード</p>
      <p class="roomcode">${esc(state.code)}</p>
      <div class="qr">${qrSvg(url)}</div>
      <p class="url">${esc(url)}</p>
      ${
        isOnlineConfigured() && /^(localhost|127\.|\[::1\])/.test(location.hostname)
          ? '<div class="banner">このURLはこのPCの中でしか開けません。スマホから入るには、サーバーが表示した「同じWi-Fiのスマホから」のURLでこのページを開き直してください。</div>'
          : ''
      }
    </div>
    <div class="card">
      <h2>参加者 ${state.players.length} / ${MAX_PLAYERS}</h2>
      <ul class="players">${state.players.map((p) => `<li>${chip(p.id)}${p.id === state.hostId ? ' 👑' : ''}</li>`).join('')}</ul>
      ${
        isHost
          ? `<button class="primary" data-act="start" ${canStart ? '' : 'disabled'}>ゲームをはじめる</button>
             ${canStart ? '' : `<p class="muted center">あと${MIN_PLAYERS - online}人そろうとはじめられます</p>`}`
          : `<p class="muted center">ホストがはじめるのを待っています…</p>`
      }
    </div>`;
}

function topbar() {
  return `
    <div class="topbar"><span>第${state.qi + 1}問 / ${state.total}</span><span>正解 ${state.score}</span></div>`;
}

function renderQuestion() {
  const cur = state.cur;
  const mine = cur.hints[myId] || [];
  const myVote = state.votes[myId];
  const online = state.players.filter((p) => p.online);
  const votedSame = online.filter((p) => state.votes[p.id] !== undefined);
  const byChoice = {};
  for (const [id, c] of Object.entries(state.votes)) (byChoice[c] ||= []).push(id);
  return `
    ${topbar()}
    <div class="bar"><i id="bar" style="width:100%"></i></div>
    <div class="topbar"><span class="cat">${esc(cur.cat)}</span><span id="timer" class="timer"></span></div>
    <p class="question">${esc(cur.q)}</p>
    <div class="card">
      <h2>あなたのかけら</h2>
      <div class="hints">
        ${mine.length ? mine.map((h) => `<div class="hint">${esc(h)}</div>`).join('') : '<p class="muted">今回はかけらがありません。みんなの話を聞いてね。</p>'}
      </div>
      <p class="muted">声に出してみんなに伝えよう</p>
    </div>
    <div class="choices">
      ${cur.choices
        .map(
          (c, i) => `
        <button class="choice ${myVote === i ? 'mine' : ''}" data-act="vote" data-i="${i}">
          <span>${esc(c)}</span>
          <span class="votes">${(byChoice[i] || []).map((id) => chip(id, 'small')).join('')}</span>
        </button>`,
        )
        .join('')}
    </div>
    <p class="muted center">全員が同じ答えを選ぶと確定（選択 ${votedSame.length} / ${online.length} 人）</p>`;
}

function renderReveal() {
  const cur = state.cur;
  const last = state.last;
  const howText = { unanimous: '全員一致で回答', timeout: '時間切れ → 多数決' }[last.how] || '';
  const allHints = Object.entries(cur.hints).flatMap(([id, hs]) => hs.map((h) => ({ id, h })));
  return `
    ${topbar()}
    <p class="verdict ${last.ok ? 'ok' : 'ng'}">${last.ok ? '正解！' : 'ざんねん…'}</p>
    <p class="center muted">${howText}${last.chosen ? `：「${esc(last.chosen)}」` : '（答えがまとまりませんでした）'}</p>
    <div class="card">
      <p class="center">答えは <b style="font-size:24px">${esc(last.answer)}</b></p>
      <div class="choices">
        ${cur.choices
          .map((c, i) => {
            const cls = i === cur.answer ? 'correct' : c === last.chosen ? 'wrong' : '';
            return `<button class="choice ${cls}" disabled><span>${esc(c)}</span></button>`;
          })
          .join('')}
      </div>
    </div>
    <div class="card">
      <h2>みんなのかけら</h2>
      <div class="hints">${allHints.map(({ id, h }) => `<div class="hint"><span class="who">${esc(nameOf(id))}</span>${esc(h)}</div>`).join('')}</div>
    </div>
    ${
      isHost
        ? `<button class="primary" data-act="next">${state.qi + 1 >= state.total ? '結果を見る' : '次の問題へ'}</button>`
        : '<p class="muted center">ホストが次へ進むのを待っています…</p>'
    }`;
}

function renderResult() {
  const sc = state.score;
  const msg = sc === state.total ? '完璧！最強のチーム！' : sc >= 8 ? 'すばらしい連携！' : sc >= 5 ? 'いいチームワーク！' : 'もう一回挑戦してみよう！';
  return `
    <h1>🧩 結果発表</h1>
    <div class="card">
      <p class="score">${sc}<small> / ${state.total}</small></p>
      <p class="center" style="font-weight:800;font-size:20px">${msg}</p>
      <ul class="players" style="justify-content:center">${state.players.map((p) => `<li>${chip(p.id)}</li>`).join('')}</ul>
    </div>
    <div class="card">
      <h2>ふりかえり</h2>
      <ul class="history">
        ${state.history
          .map(
            (h) => `<li><span class="mark ${h.ok ? 'ok' : 'ng'}">${h.ok ? '○' : '×'}</span>
            <span>第${h.n}問 ${esc(h.cat)}：<b>${esc(h.answer)}</b>${h.ok ? `<span class="muted">（${h.timeUsed}秒）</span>` : `<span class="muted">（回答：${esc(h.chosen || 'なし')}）</span>`}</span></li>`,
          )
          .join('')}
      </ul>
    </div>
    ${isHost ? '<button class="primary" data-act="restart">同じメンバーでもう一度</button>' : '<p class="muted center">ホストがもう一度はじめるのを待っています…</p>'}`;
}

function footer() {
  const lost = !isHost && Date.now() - lastStateAt > 8000;
  return `
    ${lost ? '<div class="banner err">ホストとの接続が切れているようです…</div>' : ''}
    <div class="spacer"></div>
    <button data-act="leave" style="font-size:14px;padding:10px">部屋を抜ける</button>`;
}

// タイマー表示だけを軽く更新する
function tick() {
  if (!state || state.phase !== 'question') return;
  const remain = Math.max(0, localDeadline - Date.now());
  const t = document.getElementById('timer');
  const bar = document.getElementById('bar');
  if (t) {
    t.textContent = `${Math.ceil(remain / 1000)}秒`;
    t.classList.toggle('low', remain < 15000);
  }
  if (bar) bar.style.width = `${(remain / TIME_LIMIT_MS) * 100}%`;
}
setInterval(() => {
  tick();
  if (!isHost && ui.screen === 'game' && Date.now() - lastStateAt > 8000 && !document.querySelector('.banner.err')) render();
}, 250);

// ---------- 操作 ----------

app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  if (act === 'create') createRoom();
  else if (act === 'join') {
    ui.code = document.getElementById('code').value;
    joinRoom();
  } else if (act === 'vote') send({ t: 'vote', choice: Number(b.dataset.i) });
  else if (act === 'start' || act === 'next' || act === 'restart') send({ t: act });
  else if (act === 'leave') {
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
  const code = ui.code;
  const saved = code && store.get('sessionStorage', `kq_host_${code}`);
  if (saved) {
    // ホストが再読み込みした場合は状態を復元してホストを続ける
    ui.screen = 'connecting';
    ui.info = '部屋に戻っています…';
    render();
    try {
      await becomeHost(code, JSON.parse(saved));
    } catch (e) {
      fail(e);
    }
    return;
  }
  if (code && ui.name && store.get('sessionStorage', 'kq_joined') === code) {
    joinRoom();
    return;
  }
  render();
})();
