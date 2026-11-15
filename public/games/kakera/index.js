// ===========================================================
// かけらクイズ（協力）
// 1人1つずつヒント（かけら）が配られる。口頭で伝え合い、全員が自分のスマホで答えを入力。
// 全員の答えが正解でそろえばクリア。1問ずつ何度でも続け、連続正解をめざす。
// ===========================================================
import { esc, chip, shuffle } from '../../hub/util.js';
import { normalize, isCorrect } from './judge.js';
import { makeQuestion, aiEnabled } from './ai.js';
import { BUILTIN_GENRES, BUILTIN_ERRORS } from './builtin.js';

const GENRES = ['おまかせ', ...BUILTIN_GENRES];
const TIMES = [30, 60, 90, 120, 0]; // 0 は無制限

// 生成中の処理がこの端末で動いているか（ホストが再読み込みすると false に戻る）
let inflight = false;

function startGeneration(state, api) {
  inflight = true;
  const seq = state.genSeq;
  const genre = state.settings.custom.trim() || state.settings.genre;
  makeQuestion(genre, state.used)
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
  const players = shuffle(api.onlinePlayers);
  const hints = shuffle(q.hints);
  state.q = q;
  state.hintOf = Object.fromEntries(players.map((p, i) => [p.id, hints[i % hints.length]]));
  state.answers = {};
  state.result = null;
  state.deadline = state.settings.time ? api.now() + state.settings.time * 1000 : 0;
  state.phase = 'question';
}

function resolve(state, api, how) {
  const online = api.onlinePlayers;
  const rows = online.map((p) => ({ id: p.id, text: state.answers[p.id] || '', ok: isCorrect(state.answers[p.id], state.q.answer, state.q.aliases) }));
  const answered = rows.filter((r) => r.text);
  const allSame = answered.length === rows.length && new Set(rows.map((r) => normalize(r.text))).size === 1;
  const ok = rows.length > 0 && rows.every((r) => r.ok);
  state.result = { ok, how, allSame, overridden: false, okIds: rows.filter((r) => r.ok).map((r) => r.id), streakBefore: state.streak };
  state.played++;
  if (ok) {
    state.cleared++;
    state.streak++;
    state.best = Math.max(state.best, state.streak);
  } else state.streak = 0;
  state.used.push(state.q.answer);
  state.phase = 'reveal';
}

export default {
  meta: {
    id: 'kakera',
    title: 'かけらクイズ',
    emoji: '🧩',
    description: '1人1つずつ配られるヒントを声に出して持ち寄り、全員で同じ答えを入力する協力クイズ。1問ずつ何度でも。',
    minPlayers: 2,
    maxPlayers: 6,
    tags: ['協力', 'クイズ', '話し合い'],
  },

  host: {
    setup() {
      return {
        phase: 'setup', // setup → generating → question → reveal → (setup | generating)
        settings: { genre: 'おまかせ', custom: '', time: 90 },
        q: null,
        hintOf: {},
        answers: {},
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
          return true;
        case 'start':
          if (!isHost || (state.phase !== 'setup' && state.phase !== 'reveal')) return false;
          state.phase = 'generating';
          state.genSeq++;
          state.genStartedAt = api.now();
          startGeneration(state, api);
          return true;
        case 'toSetup':
          if (!isHost || state.phase !== 'reveal') return false;
          state.phase = 'setup';
          return true;
        case 'submit': {
          if (state.phase !== 'question') return false;
          const text = String(a.text || '').trim().slice(0, 30);
          if (!text) return false;
          state.answers[from] = text;
          if (api.onlinePlayers.every((p) => state.answers[p.id])) resolve(state, api, 'all');
          return true;
        }
        case 'retract':
          if (state.phase !== 'question' || !state.answers[from]) return false;
          delete state.answers[from];
          return true;
        case 'override':
          // 判定が厳しすぎたときにホストが正解にする
          if (!isHost || state.phase !== 'reveal' || !state.result || state.result.ok) return false;
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
      if (state.phase === 'question') {
        if (state.deadline && api.now() >= state.deadline) {
          resolve(state, api, 'timeout');
          return true;
        }
        // 抜けた人を除いて全員が答えていたら締め切る
        const online = api.onlinePlayers;
        if (online.length && online.every((p) => state.answers[p.id])) {
          resolve(state, api, 'all');
          return true;
        }
      }
      if (state.phase === 'generating' && !inflight) {
        // ホストの再読み込みなどで生成が止まっていたらやり直す
        startGeneration(state, api);
      }
      return false;
    },

    view(state) {
      const v = { ...state, used: undefined };
      if (state.phase !== 'reveal') {
        // 答えと、みんなの入力内容は公開まで隠す
        v.q = state.q && { genre: state.q.genre, source: state.q.source };
        v.answers = Object.fromEntries(Object.keys(state.answers).map((id) => [id, true]));
      }
      return v;
    },
  },

  client: {
    mount(root, ctx0) {
      let ctx = ctx0;
      let view = null;
      let draft = '';
      let myLastSubmitted = '';

      const timer = setInterval(drawTimer, 250);

      function drawTimer() {
        const el = root.querySelector('#kk-timer');
        if (!el || !view || view.phase !== 'question') return;
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
        else if (k === 'start') {
          const custom = root.querySelector('#kk-custom');
          if (custom) ctx.send({ type: 'settings', custom: custom.value });
          ctx.send({ type: 'start' });
        } else if (k === 'submit') submit();
        else if (k === 'retract') ctx.send({ type: 'retract' });
        else if (k === 'override') ctx.send({ type: 'override' });
        else if (k === 'toSetup') ctx.send({ type: 'toSetup' });
      });
      root.addEventListener('input', (e) => {
        if (e.target.id === 'kk-answer') draft = e.target.value;
      });
      root.addEventListener('keydown', (e) => {
        if (e.target.id === 'kk-answer' && e.key === 'Enter' && !e.isComposing) submit();
      });
      root.addEventListener('change', (e) => {
        if (e.target.id === 'kk-custom') ctx.send({ type: 'settings', custom: e.target.value });
      });

      function submit() {
        const text = (root.querySelector('#kk-answer')?.value || draft).trim();
        if (!text) return;
        myLastSubmitted = text;
        draft = '';
        ctx.send({ type: 'submit', text });
      }

      function stats(v) {
        return `<div class="topbar"><span>🔥 連続 ${v.streak}問</span><span class="muted">最高 ${v.best} ／ クリア ${v.cleared}/${v.played}</span></div>`;
      }

      function renderSetup(v) {
        const s = v.settings;
        if (!ctx.isHost) {
          return `${stats(v)}
            <div class="card center">
              <h2>ホストが次の問題を準備中…</h2>
              <p class="muted">ジャンル：${esc(s.custom || s.genre)} ／ 制限時間：${s.time ? `${s.time}秒` : 'なし'}</p>
            </div>
            ${rules()}`;
        }
        return `${stats(v)}
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
            <h2>制限時間</h2>
            <div class="pills">${TIMES.map(
              (t) => `<button class="pill ${s.time === t ? 'on' : ''}" data-kk="time" data-v="${t}">${t ? `${t}秒` : 'なし'}</button>`,
            ).join('')}</div>
          </div>
          <button class="primary big" data-kk="start">出題する</button>
          ${rules()}`;
      }

      function rules() {
        return `<details class="card"><summary>遊び方</summary>
          <ol class="rules">
            <li>1人に1つずつ、答えにつながるヒント（かけら）が配られます。</li>
            <li>自分のかけらを声に出してみんなに伝え、答えを相談します。</li>
            <li>全員が自分のスマホで答えを入力して送ります。</li>
            <li>全員の答えが正解ならクリア！ 1人でも違えば失敗です。</li>
            <li>人数が少ないほどヒントが減って難しくなります。</li>
          </ol></details>`;
      }

      function renderQuestion(v) {
        const me = ctx.me.id;
        const mine = v.hintOf[me];
        const sent = v.answers[me];
        const done = ctx.players.filter((p) => v.answers[p.id]);
        const waiting = ctx.players.filter((p) => p.online && !v.answers[p.id]);
        return `${stats(v)}
          ${v.deadline ? '<div class="bar"><i id="kk-bar" style="width:100%"></i></div>' : ''}
          <div class="topbar"><span class="cat">ジャンル：${esc(v.q?.genre || '')}</span><span id="kk-timer" class="timer"></span></div>
          <div class="card">
            <h2>あなたのかけら</h2>
            ${mine ? `<div class="hint big-hint">${esc(mine)}</div>` : '<p class="muted">途中参加のため、今回はかけらがありません。みんなの話を聞いて答えよう。</p>'}
            <p class="muted">声に出してみんなに伝えよう。答えは1つの言葉です。</p>
          </div>
          <div class="card">
            ${
              sent
                ? `<p>送信しました${myLastSubmitted ? `：<b>${esc(myLastSubmitted)}</b>` : ''}</p>
                   <button data-kk="retract">書き直す</button>`
                : `<label for="kk-answer">答えを入力</label>
                   <div class="row"><input id="kk-answer" maxlength="30" autocomplete="off" enterkeyhint="send" value="${esc(draft)}" placeholder="ひらがな・カタカナどちらでもOK" />
                   <button class="primary" data-kk="submit" style="flex:0 0 auto">送信</button></div>`
            }
            <p class="muted">送信ずみ：${done.map((p) => chip(ctx.players, p.id, 'small')).join(' ') || 'まだいません'}</p>
            ${waiting.length ? `<p class="muted">まだ：${waiting.map((p) => chip(ctx.players, p.id, 'small')).join(' ')}</p>` : ''}
          </div>`;
      }

      function renderReveal(v) {
        const r = v.result;
        const howText = r.how === 'timeout' ? '時間切れ' : '全員が回答';
        return `${stats(v)}
          <p class="verdict ${r.ok ? 'ok' : 'ng'}">${r.ok ? 'クリア！' : 'ざんねん…'}</p>
          <p class="center muted">${howText}${r.overridden ? '（ホストが正解にしました）' : ''}${!r.ok && r.allSame ? '（答えはそろっていました）' : ''}</p>
          <div class="card center">
            <p class="muted">正解</p>
            <p style="font-size:30px;font-weight:900;margin:0">${esc(v.q.answer)}</p>
            ${v.q.aliases?.length ? `<p class="muted">（${esc(v.q.aliases.slice(0, 5).join('、'))} なども正解）</p>` : ''}
          </div>
          <div class="card">
            <h2>みんなのかけらと答え</h2>
            <ul class="answers">
              ${ctx.players
                .map((p) => {
                  const text = v.answers[p.id];
                  const good = r.okIds.includes(p.id);
                  return `<li>
                    <div>${chip(ctx.players, p.id)} <span class="muted">${esc(v.hintOf[p.id] || 'かけらなし')}</span></div>
                    <div class="ans ${good ? 'ok' : 'ng'}">${good ? '○' : '×'} ${esc(text || '（未回答）')}</div>
                  </li>`;
                })
                .join('')}
            </ul>
            ${v.q.source === 'builtin' && aiEnabled() ? '<p class="muted">※ 組み込みの問題です（AIにつながらなかったため）</p>' : ''}
          </div>
          ${
            ctx.isHost
              ? `${!r.ok ? '<button data-kk="override">判定ミス？ 正解にする</button>' : ''}
                 <button class="primary big" data-kk="start">同じ設定でもう1問</button>
                 <button data-kk="toSetup">ジャンル・時間を変える</button>`
              : '<p class="muted center">ホストが次へ進むのを待っています…</p>'
          }`;
      }

      return {
        update(v, c) {
          ctx = c;
          const prevPhase = view?.phase;
          view = v;
          if (v.phase === 'question' && prevPhase !== 'question') {
            draft = '';
            myLastSubmitted = '';
          }
          // 入力中の欄を描き直しても内容とフォーカスを保つ
          const input = root.querySelector('#kk-answer');
          const focused = input && document.activeElement === input;
          const sel = focused ? [input.selectionStart, input.selectionEnd] : null;
          if (input) draft = input.value;

          if (v.phase === 'setup') root.innerHTML = renderSetup(v);
          else if (v.phase === 'generating')
            root.innerHTML = `${stats(v)}<div class="card center"><p class="spinner">🧩</p><h2>問題を作っています…</h2><p class="muted">ジャンル：${esc(v.settings.custom || v.settings.genre)}</p></div>`;
          else if (v.phase === 'question') root.innerHTML = renderQuestion(v);
          else root.innerHTML = renderReveal(v);

          const again = root.querySelector('#kk-answer');
          if (again && focused) {
            again.focus();
            if (sel) again.setSelectionRange(sel[0], sel[1]);
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
