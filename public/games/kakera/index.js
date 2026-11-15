// ===========================================================
// かけらクイズ（協力）
// 毎問、1人が回答者になる。ほかの人には答えから連想する「かけら」がこっそり配られる。
// かけらは口に出さず、そこからさらに連想した言葉を書いて送る。
// 回答者はみんなの言葉だけを見て、元の答えを1回で当てる。回答者は毎問交代。
// ===========================================================
import { esc, chip, shuffle } from '../../hub/util.js';
import { normalize, isCorrect } from './judge.js';
import { makeQuestion, aiEnabled } from './ai.js';
import { BUILTIN_GENRES, BUILTIN_ERRORS } from './builtin.js';

const GENRES = ['おまかせ', ...BUILTIN_GENRES];
const TIMES = [30, 60, 90, 120, 0]; // 書く時間。0 は無制限
const LEVELS = [0, 1, 2, 3]; // 0 はバラバラ
const MIN_WORDS = 3; // 回答者に届く言葉の最低数（人数が少ないときは1人が複数のかけらを持つ）
const stars = (n) => (n ? '★'.repeat(n) + '☆'.repeat(3 - n) : 'バラバラ');

/** 連想した言葉が、元のかけらをそのまま使っていないか */
export function usesKakera(word, kakera) {
  const w = normalize(word);
  const k = normalize(kakera);
  return k.length >= 2 && w.includes(k);
}

// 問題を用意する処理がこの端末で動いているか（ホストが再読み込みすると false に戻る）
let inflight = false;

function nextAnswerer(state, api) {
  const online = api.onlinePlayers;
  if (!online.length) return null;
  const order = api.players.map((p) => p.id);
  const start = order.indexOf(state.lastAnswererId);
  for (let i = 1; i <= order.length; i++) {
    const id = order[(start + i) % order.length];
    if (online.some((p) => p.id === id)) return id;
  }
  return online[0].id;
}

function startGeneration(state, api) {
  inflight = true;
  const seq = state.genSeq;
  const genre = state.settings.custom.trim() || state.settings.genre;
  makeQuestion(genre, state.used, state.settings.level || 0)
    .then((q) => {
      if (state.phase !== 'generating' || state.genSeq !== seq) return;
      beginQuestion(state, api, q);
      api.publish();
    })
    .finally(() => {
      inflight = false;
    });
}

function beginQuestion(state, api, q) {
  const answerer = state.answererId;
  const givers = shuffle(api.onlinePlayers.filter((p) => p.id !== answerer));
  const each = Math.max(1, Math.ceil(MIN_WORDS / Math.max(1, givers.length)));
  const pool = shuffle(q.hints);
  state.q = q;
  state.hintOf = {};
  givers.forEach((p, i) => {
    state.hintOf[p.id] = Array.from({ length: each }, (_, k) => pool[(i * each + k) % pool.length]);
  });
  state.words = {};
  state.guess = '';
  state.result = null;
  state.deadline = state.settings.time ? api.now() + state.settings.time * 1000 : 0;
  state.phase = 'writing';
}

function toAnswering(state) {
  state.phase = 'answering';
  state.deadline = 0;
}

function resolve(state, how) {
  const ok = how === 'guess' && isCorrect(state.guess, state.q.answer, state.q.aliases);
  state.result = { ok, how, overridden: false, streakBefore: state.streak };
  state.played++;
  if (ok) {
    state.cleared++;
    state.streak++;
    state.best = Math.max(state.best, state.streak);
  } else state.streak = 0;
  state.used.push(state.q.answer);
  state.phase = 'reveal';
}

function allWritten(state, api) {
  const givers = Object.keys(state.hintOf).filter((id) => api.onlinePlayers.some((p) => p.id === id));
  return givers.length > 0 && givers.every((id) => state.words[id]);
}

export default {
  meta: {
    id: 'kakera',
    title: 'かけらクイズ',
    emoji: '🧩',
    description: 'こっそり配られた「かけら」から連想した言葉を書いて、回答者に元の答えを当ててもらう協力ゲーム。しゃべるのは禁止！',
    minPlayers: 2,
    maxPlayers: 6,
    tags: ['協力', '連想', 'クイズ'],
  },

  host: {
    setup() {
      return {
        phase: 'setup', // setup → generating → writing → answering → reveal → (setup | generating)
        settings: { genre: 'おまかせ', custom: '', time: 90, level: 0 },
        answererId: null,
        lastAnswererId: null,
        q: null,
        hintOf: {}, // 回答者以外の人ごとのかけら（配列）
        words: {}, // 人ごとの連想した言葉（かけらと同じ並び）
        guess: '',
        deadline: 0,
        result: null,
        streak: 0,
        best: 0,
        cleared: 0,
        played: 0,
        used: [],
        genSeq: 0,
        genStartedAt: 0,
      };
    },

    action(state, from, a, api) {
      const isHost = from === api.hostId;
      switch (a.type) {
        case 'settings':
          if (!isHost || state.phase !== 'setup') return false;
          if (GENRES.includes(a.genre)) state.settings.genre = a.genre;
          if (typeof a.custom === 'string') state.settings.custom = a.custom.slice(0, 20);
          if (TIMES.includes(a.time)) state.settings.time = a.time;
          if (LEVELS.includes(a.level)) state.settings.level = a.level;
          return true;
        case 'start':
          if (!isHost || (state.phase !== 'setup' && state.phase !== 'reveal')) return false;
          if (api.onlinePlayers.length < 2) return false;
          state.answererId = nextAnswerer(state, api);
          state.lastAnswererId = state.answererId;
          state.phase = 'generating';
          state.genSeq++;
          state.genStartedAt = api.now();
          startGeneration(state, api);
          return true;
        case 'toSetup':
          if (!isHost || state.phase !== 'reveal') return false;
          state.phase = 'setup';
          return true;
        case 'write': {
          const mine = state.hintOf[from];
          if (state.phase !== 'writing' || !mine || !Array.isArray(a.words)) return false;
          const words = mine.map((k, i) => String(a.words[i] || '').trim().slice(0, 20));
          if (words.some((w) => !w)) return false;
          if (words.some((w, i) => usesKakera(w, mine[i]))) return false;
          state.words[from] = words;
          if (allWritten(state, api)) toAnswering(state);
          return true;
        }
        case 'unwrite':
          if (state.phase !== 'writing' || !state.words[from]) return false;
          delete state.words[from];
          return true;
        case 'guess': {
          if (state.phase !== 'answering' || from !== state.answererId) return false;
          const g = String(a.text || '').trim().slice(0, 30);
          if (!g) return false;
          state.guess = g;
          resolve(state, 'guess');
          return true;
        }
        case 'skip':
          // 回答者が抜けたときなどに、ホストが問題を飛ばす
          if (!isHost || !['writing', 'answering'].includes(state.phase)) return false;
          resolve(state, 'skip');
          return true;
        case 'override':
          // 判定が厳しすぎたときにホストが正解にする
          if (!isHost || state.phase !== 'reveal' || !state.result || state.result.ok || state.result.how !== 'guess') return false;
          state.result.ok = true;
          state.result.overridden = true;
          state.cleared++;
          state.streak = state.result.streakBefore + 1;
          state.best = Math.max(state.best, state.streak);
          return true;
        default:
          return false;
      }
    },

    tick(state, api) {
      if (state.phase === 'writing') {
        if (allWritten(state, api) || (state.deadline && api.now() >= state.deadline)) {
          toAnswering(state);
          return true;
        }
      }
      if (state.phase === 'generating' && !inflight) {
        // ホストの再読み込みなどで準備が止まっていたらやり直す
        startGeneration(state, api);
      }
      return false;
    },

    view(state) {
      const v = { ...state, used: undefined };
      if (state.phase !== 'reveal') {
        // 答えは公開まで隠す
        v.q = state.q && { genre: state.q.genre, level: state.q.level, source: state.q.source };
      }
      if (state.phase === 'writing') {
        // 書いた言葉は、全員がそろうまで隠す（書いたかどうかだけ送る）
        v.words = Object.fromEntries(Object.keys(state.words).map((id) => [id, true]));
      }
      return v;
    },
  },

  client: {
    mount(root, ctx0) {
      let ctx = ctx0;
      let view = null;
      let drafts = {}; // 入力中の言葉（入力欄の id → 文字）
      let mySent = null; // 自分が送った言葉
      let error = '';

      const timer = setInterval(drawTimer, 250);

      function drawTimer() {
        const el = root.querySelector('#kk-timer');
        if (!el || !view || view.phase !== 'writing') return;
        if (!view.deadline) {
          el.textContent = '時間無制限';
          return;
        }
        const remain = Math.max(0, view.deadline - ctx.now());
        el.textContent = `のこり ${Math.ceil(remain / 1000)}秒`;
        el.classList.toggle('low', remain < 10000);
        const bar = root.querySelector('#kk-bar');
        if (bar) bar.style.width = `${(remain / (view.settings.time * 1000)) * 100}%`;
      }

      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-kk]');
        if (!b || b.disabled) return;
        const k = b.dataset.kk;
        if (k === 'genre') ctx.send({ type: 'settings', genre: b.dataset.v, custom: '' });
        else if (k === 'time') ctx.send({ type: 'settings', time: Number(b.dataset.v) });
        else if (k === 'level') ctx.send({ type: 'settings', level: Number(b.dataset.v) });
        else if (k === 'start') {
          const custom = root.querySelector('#kk-custom');
          if (custom) ctx.send({ type: 'settings', custom: custom.value });
          ctx.send({ type: 'start' });
        } else if (k === 'write') sendWords();
        else if (k === 'unwrite') ctx.send({ type: 'unwrite' });
        else if (k === 'guess') sendGuess();
        else if (k === 'skip') {
          if (confirm('この問題を飛ばしますか？（不正解になります）')) ctx.send({ type: 'skip' });
        } else if (k === 'override') ctx.send({ type: 'override' });
        else if (k === 'toSetup') ctx.send({ type: 'toSetup' });
      });
      root.addEventListener('input', (e) => {
        if (e.target.id?.startsWith('kk-')) drafts[e.target.id] = e.target.value;
      });
      root.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        if (e.target.id === 'kk-guess') sendGuess();
        else if (e.target.id?.startsWith('kk-word-')) {
          const next = root.querySelector(`#kk-word-${Number(e.target.id.slice(8)) + 1}`);
          if (next) next.focus();
          else sendWords();
        }
      });
      root.addEventListener('change', (e) => {
        if (e.target.id === 'kk-custom') ctx.send({ type: 'settings', custom: e.target.value });
      });

      function sendWords() {
        const mine = view?.hintOf[ctx.me.id] || [];
        const words = mine.map((_, i) => (root.querySelector(`#kk-word-${i}`)?.value || drafts[`kk-word-${i}`] || '').trim());
        if (words.some((w) => !w)) return showError('全部のかけらに言葉を書いてね');
        const bad = words.findIndex((w, i) => usesKakera(w, mine[i]));
        if (bad >= 0) return showError(`「${mine[bad]}」をそのまま使うのはダメ！別の言葉で`);
        error = '';
        mySent = words;
        ctx.send({ type: 'write', words });
      }

      function sendGuess() {
        const text = (root.querySelector('#kk-guess')?.value || drafts['kk-guess'] || '').trim();
        if (!text) return;
        ctx.send({ type: 'guess', text });
      }

      function showError(msg) {
        error = msg;
        const el = root.querySelector('#kk-error');
        if (el) {
          el.textContent = msg;
          el.hidden = false;
        }
      }

      function stats(v) {
        return `<div class="topbar"><span>🔥 連続 ${v.streak}問</span><span class="muted">最高 ${v.best} ／ 正解 ${v.cleared}/${v.played}</span></div>`;
      }

      function rules() {
        return `<details class="card"><summary>遊び方</summary>
          <ol class="rules">
            <li>毎問、1人が<b>回答者</b>になります（順番に交代）。</li>
            <li>ほかの人のスマホには、答えから連想する言葉<b>「かけら」</b>がこっそり配られます。</li>
            <li>かけらは<b>口に出さず</b>、そこからさらに連想した言葉を書いて送ります。かけらと同じ言葉は使えません。</li>
            <li>回答者は、みんなが書いた言葉だけを見て、元の答えを<b>1回で</b>当てます。</li>
            <li>当たればチームの得点。ヒントを出す人どうしの相談もなし！</li>
          </ol></details>`;
      }

      function renderSetup(v) {
        const s = v.settings;
        const next = ctx.players.find((p) => p.id === upcomingAnswerer(v));
        const nextLine = next ? `<p class="center">次の回答者：${chip(ctx.players, next.id)}</p>` : '';
        if (!ctx.isHost) {
          return `${stats(v)}
            <div class="card center">
              <h2>ホストが次の問題を準備中…</h2>
              ${nextLine}
              <p class="muted">ジャンル：${esc(s.custom || s.genre)} ／ むずかしさ：${stars(s.level || 0)} ／ 書く時間：${s.time ? `${s.time}秒` : 'なし'}</p>
            </div>
            ${rules()}`;
        }
        return `${stats(v)}
          ${nextLine}
          <div class="card">
            <h2>ジャンル</h2>
            <div class="pills">${GENRES.map(
              (g) => `<button class="pill ${!s.custom && s.genre === g ? 'on' : ''}" data-kk="genre" data-v="${esc(g)}">${esc(g)}</button>`,
            ).join('')}</div>
            ${
              aiEnabled()
                ? `<label for="kk-custom">好きなジャンルを書く（AIが問題を作ります）</label>
                   <input id="kk-custom" maxlength="20" placeholder="例：ポケモン、文房具、80年代の歌" value="${esc(s.custom)}" />`
                : ''
            }
            ${BUILTIN_ERRORS.length ? `<div class="banner err">問題ファイルの読み込みで問題があります: ${esc(BUILTIN_ERRORS[0])}</div>` : ''}
          </div>
          <div class="card">
            <h2>むずかしさ</h2>
            <div class="pills">${LEVELS.map(
              (l) => `<button class="pill ${(s.level || 0) === l ? 'on' : ''}" data-kk="level" data-v="${l}">${stars(l)}</button>`,
            ).join('')}</div>
          </div>
          <div class="card">
            <h2>言葉を書く時間</h2>
            <div class="pills">${TIMES.map(
              (t) => `<button class="pill ${s.time === t ? 'on' : ''}" data-kk="time" data-v="${t}">${t ? `${t}秒` : 'なし'}</button>`,
            ).join('')}</div>
          </div>
          <button class="primary big" data-kk="start">出題する</button>
          ${rules()}`;
      }

      // 次に回答者になる人（画面表示用。実際の決定はホスト側）
      function upcomingAnswerer(v) {
        const online = ctx.players.filter((p) => p.online);
        if (!online.length) return null;
        const order = ctx.players.map((p) => p.id);
        const start = order.indexOf(v.lastAnswererId);
        for (let i = 1; i <= order.length; i++) {
          const id = order[(start + i) % order.length];
          if (online.some((p) => p.id === id)) return id;
        }
        return null;
      }

      function header(v) {
        return `${stats(v)}
          <div class="topbar"><span class="cat">${esc(v.q?.genre || '')}${v.q?.level ? ` <span class="stars">${stars(v.q.level)}</span>` : ''}</span>
          <span>回答者 ${chip(ctx.players, v.answererId)}</span></div>`;
      }

      function hostSkip() {
        return ctx.isHost ? '<button class="small ghost" data-kk="skip">この問題を飛ばす</button>' : '';
      }

      function renderWriting(v) {
        const me = ctx.me.id;
        const givers = Object.keys(v.hintOf);
        const done = givers.filter((id) => v.words[id]);
        const waiting = givers.filter((id) => !v.words[id] && ctx.players.find((p) => p.id === id)?.online);
        const progress = `<p class="muted">書き終わった人：${done.map((id) => chip(ctx.players, id, 'small')).join(' ') || 'まだいません'}${
          waiting.length ? `<br>まだ：${waiting.map((id) => chip(ctx.players, id, 'small')).join(' ')}` : ''
        }</p>`;
        const bar = v.deadline ? '<div class="bar"><i id="kk-bar" style="width:100%"></i></div>' : '';

        if (me === v.answererId) {
          return `${header(v)}${bar}
            <div class="card center">
              <p style="font-size:40px;margin:0">🎯</p>
              <h2>あなたが回答者です</h2>
              <p class="muted">みんながこっそり言葉を書いています。そろったら、その言葉から答えを当ててね。</p>
              <p id="kk-timer" class="timer"></p>
              ${progress}
            </div>${hostSkip()}`;
        }
        const mine = v.hintOf[me];
        if (!mine) {
          return `${header(v)}${bar}
            <div class="card center"><h2>途中参加なので、この問題は見学です</h2><p id="kk-timer" class="timer"></p>${progress}</div>${hostSkip()}`;
        }
        if (v.words[me]) {
          const sent = mySent || [];
          return `${header(v)}${bar}
            <div class="card">
              <h2>送信しました</h2>
              ${mine.map((k, i) => `<p>「${esc(k)}」→ <b>${esc(sent[i] || '（送信ずみ）')}</b></p>`).join('')}
              <button data-kk="unwrite">書き直す</button>
              <p id="kk-timer" class="timer"></p>
              ${progress}
            </div>${hostSkip()}`;
        }
        return `${header(v)}${bar}
          <div class="card">
            <h2>あなたのかけら <span class="muted" style="font-size:13px">（声に出さないで！）</span></h2>
            ${mine
              .map(
                (k, i) => `
              <div class="hint big-hint">${esc(k)}</div>
              <label for="kk-word-${i}">「${esc(k)}」から連想する言葉</label>
              <input id="kk-word-${i}" maxlength="20" autocomplete="off" enterkeyhint="${i === mine.length - 1 ? 'send' : 'next'}" value="${esc(drafts[`kk-word-${i}`] || '')}" />`,
              )
              .join('')}
            <p id="kk-error" class="banner err" ${error ? '' : 'hidden'}>${esc(error)}</p>
            <button class="primary" data-kk="write">送信</button>
            <p class="muted">回答者は、あなたの書いた言葉だけを見て答えを考えます。かけらと同じ言葉は使えません。</p>
            <p id="kk-timer" class="timer"></p>
            ${progress}
          </div>${hostSkip()}`;
      }

      function wordList(v, withKakera) {
        const rows = Object.keys(v.hintOf).flatMap((id) =>
          (v.hintOf[id] || []).map((k, i) => ({ id, k, w: (Array.isArray(v.words[id]) && v.words[id][i]) || '' })),
        );
        return `<ul class="answers">${rows
          .map(
            (r) => `<li>
              <div class="ans">${r.w ? esc(r.w) : '<span class="muted">（書かれなかった）</span>'}</div>
              <div>${chip(ctx.players, r.id, 'small')}${withKakera ? ` <span class="muted">かけら：${esc(r.k)}</span>` : ''}</div>
            </li>`,
          )
          .join('')}</ul>`;
      }

      function renderAnswering(v) {
        const me = ctx.me.id;
        if (me === v.answererId) {
          return `${header(v)}
            <div class="card">
              <h2>みんなの連想</h2>
              ${wordList(v, false)}
            </div>
            <div class="card">
              <label for="kk-guess">元の答えは？（チャンスは1回）</label>
              <div class="row"><input id="kk-guess" maxlength="30" autocomplete="off" enterkeyhint="send" value="${esc(drafts['kk-guess'] || '')}" placeholder="ひらがな・カタカナどちらでもOK" />
              <button class="primary" data-kk="guess" style="flex:0 0 auto">回答</button></div>
            </div>${hostSkip()}`;
        }
        return `${header(v)}
          <div class="card center">
            <h2>${chip(ctx.players, v.answererId)} が考え中…</h2>
            <p class="muted">口に出したらアウト！ だまって見守ろう</p>
          </div>
          <div class="card">
            <h2>みんなの連想</h2>
            ${wordList(v, true)}
          </div>${hostSkip()}`;
      }

      function renderReveal(v) {
        const r = v.result;
        const verdict = r.how === 'skip' ? 'スキップ' : r.ok ? '正解！' : 'ざんねん…';
        return `${stats(v)}
          <p class="verdict ${r.ok ? 'ok' : 'ng'}">${verdict}</p>
          ${
            r.how === 'guess'
              ? `<p class="center">${chip(ctx.players, v.answererId)} の答え：<b>${esc(v.guess)}</b>${r.overridden ? '<span class="muted">（ホストが正解にしました）</span>' : ''}</p>`
              : ''
          }
          <div class="card center">
            <p class="muted">正解</p>
            <p style="font-size:30px;font-weight:900;margin:0">${esc(v.q.answer)}</p>
            ${v.q.aliases?.length ? `<p class="muted">（${esc(v.q.aliases.slice(0, 5).join('、'))} なども正解）</p>` : ''}
          </div>
          <div class="card">
            <h2>連想のつながり</h2>
            <ul class="answers">
              ${Object.keys(v.hintOf)
                .flatMap((id) =>
                  v.hintOf[id].map(
                    (k, i) => `<li><div>${chip(ctx.players, id, 'small')}</div>
                      <div class="chain"><b>${esc(v.q.answer)}</b> → ${esc(k)} → <b>${esc((Array.isArray(v.words[id]) && v.words[id][i]) || '（なし）')}</b></div></li>`,
                  ),
                )
                .join('')}
            </ul>
            ${v.q.source === 'builtin' && aiEnabled() ? '<p class="muted">※ 組み込みの問題です（AIにつながらなかったため）</p>' : ''}
          </div>
          ${
            ctx.isHost
              ? `${!r.ok && r.how === 'guess' ? '<button data-kk="override">判定ミス？ 正解にする</button>' : ''}
                 <button class="primary big" data-kk="start">次の問題（回答者交代）</button>
                 <button data-kk="toSetup">ジャンル・むずかしさを変える</button>`
              : '<p class="muted center">ホストが次へ進むのを待っています…</p>'
          }`;
      }

      return {
        update(v, c) {
          ctx = c;
          const prevPhase = view?.phase;
          const prevSeq = view?.genSeq;
          view = v;
          if (v.genSeq !== prevSeq || (v.phase === 'writing' && prevPhase !== 'writing')) {
            if (v.phase === 'writing' || v.phase === 'generating') {
              drafts = {};
              mySent = null;
              error = '';
            }
          }
          // 入力中の欄を描き直しても内容とフォーカスを保つ
          const active = document.activeElement;
          const focusId = active && root.contains(active) && active.id ? active.id : null;
          const sel = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
          root.querySelectorAll('input[id^="kk-"]').forEach((el) => (drafts[el.id] = el.value));

          if (v.phase === 'setup') root.innerHTML = renderSetup(v);
          else if (v.phase === 'generating')
            root.innerHTML = `${stats(v)}<div class="card center"><p class="spinner">🧩</p><h2>問題を準備しています…</h2></div>`;
          else if (v.phase === 'writing') root.innerHTML = renderWriting(v);
          else if (v.phase === 'answering') root.innerHTML = renderAnswering(v);
          else root.innerHTML = renderReveal(v);

          if (focusId) {
            const again = root.querySelector(`#${focusId}`);
            if (again) {
              again.focus();
              if (sel && again.setSelectionRange) again.setSelectionRange(sel[0], sel[1]);
            }
          }
          drawTimer();
        },
        unmount() {
          clearInterval(timer);
        },
      };
    },
  },
};
