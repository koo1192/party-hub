// ホスト端末で動くゲーム進行ロジック。状態の正はホストだけが持ち、全員に配信する。
import { QUESTIONS } from './questions.js';

export const TOTAL_Q = 10;
export const TIME_LIMIT_MS = 90 * 1000;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
const OFFLINE_AFTER_MS = 10 * 1000;
const LOBBY_DROP_AFTER_MS = 15 * 1000;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function freshGame() {
  return { phase: 'lobby', qi: 0, order: [], cur: null, votes: {}, deadline: 0, history: [], score: 0 };
}

/**
 * @param {string} code ルームコード
 * @param {string} hostId ホスト自身のプレイヤーID
 * @param {(publicState:any)=>void} emit 状態が変わるたびに呼ばれる
 * @param {any} saved 再読み込み時に復元する状態
 */
export function createHost(code, hostId, emit, saved) {
  const s = saved || { code, hostId, players: [], ...freshGame() };
  const seen = {};
  const now = () => Date.now();
  s.players.forEach((p) => (seen[p.id] = now()));

  const isOnline = (id) => id === hostId || now() - (seen[id] || 0) < OFFLINE_AFTER_MS;
  const onlinePlayers = () => s.players.filter((p) => isOnline(p.id));

  function publicState() {
    const cur = s.cur && {
      cat: s.cur.cat,
      q: s.cur.q,
      choices: s.cur.choices,
      hints: s.cur.hints,
      answer: s.phase === 'question' ? null : s.cur.answer,
    };
    return {
      code: s.code,
      hostId,
      phase: s.phase,
      players: s.players.map((p) => ({ id: p.id, name: p.name, online: isOnline(p.id) })),
      qi: s.qi,
      total: TOTAL_Q,
      cur,
      votes: s.votes,
      remain: s.phase === 'question' ? Math.max(0, s.deadline - now()) : 0,
      last: s.history[s.history.length - 1] || null,
      history: s.phase === 'result' ? s.history : [],
      score: s.score,
    };
  }

  const publish = () => emit(publicState(), s);

  function startQuestion() {
    const src = QUESTIONS[s.order[s.qi]];
    const choices = shuffle(src.choices);
    const ids = onlinePlayers().map((p) => p.id);
    const hints = Object.fromEntries(ids.map((id) => [id, []]));
    shuffle(src.hints).forEach((h, i) => hints[ids[i % ids.length]].push(h));
    s.cur = { cat: src.cat, q: src.q, choices, answer: choices.indexOf(src.answer), hints };
    s.votes = {};
    s.deadline = now() + TIME_LIMIT_MS;
    s.phase = 'question';
  }

  function resolve(how, unanimousChoice) {
    let chosen = null;
    if (how === 'unanimous') {
      chosen = unanimousChoice;
    } else {
      const tally = {};
      for (const [id, c] of Object.entries(s.votes)) {
        if (isOnline(id)) tally[c] = (tally[c] || 0) + 1;
      }
      const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) chosen = Number(ranked[0][0]);
    }
    const ok = chosen === s.cur.answer;
    if (ok) s.score++;
    s.history.push({
      n: s.qi + 1,
      cat: s.cur.cat,
      q: s.cur.q,
      answer: s.cur.choices[s.cur.answer],
      chosen: chosen === null ? null : s.cur.choices[chosen],
      ok,
      how,
      timeUsed: Math.round((TIME_LIMIT_MS - Math.max(0, s.deadline - now())) / 1000),
    });
    s.phase = 'reveal';
  }

  function checkUnanimous() {
    const online = onlinePlayers();
    if (online.length === 0) return;
    const picks = online.map((p) => s.votes[p.id]);
    if (picks.every((c) => c !== undefined && c === picks[0])) resolve('unanimous', picks[0]);
  }

  const actions = {
    join({ id, name }) {
      seen[id] = now();
      const existing = s.players.find((p) => p.id === id);
      if (existing) {
        existing.name = name || existing.name;
        return true;
      }
      if (s.phase !== 'lobby') return { reject: 'ゲームがすでに始まっています。終わるまで待ってね。' };
      if (s.players.length >= MAX_PLAYERS) return { reject: `満員です（最大${MAX_PLAYERS}人）` };
      s.players.push({ id, name: String(name || 'ななし').slice(0, 10) });
      return true;
    },
    leave({ id }) {
      if (id === hostId) return false;
      if (s.phase === 'lobby') s.players = s.players.filter((p) => p.id !== id);
      else seen[id] = 0;
      return true;
    },
    ping({ id }) {
      const wasOffline = !isOnline(id);
      seen[id] = now();
      return wasOffline;
    },
    vote({ id, choice }) {
      if (s.phase !== 'question' || !s.players.some((p) => p.id === id)) return false;
      if (s.votes[id] === choice) delete s.votes[id];
      else s.votes[id] = choice;
      checkUnanimous();
      return true;
    },
    start({ id }) {
      if (id !== hostId || s.phase !== 'lobby') return false;
      if (onlinePlayers().length < MIN_PLAYERS) return false;
      s.players = onlinePlayers();
      s.order = shuffle([...QUESTIONS.keys()]).slice(0, TOTAL_Q);
      s.qi = 0;
      s.history = [];
      s.score = 0;
      startQuestion();
      return true;
    },
    next({ id }) {
      if (id !== hostId || s.phase !== 'reveal') return false;
      s.qi++;
      if (s.qi >= TOTAL_Q) s.phase = 'result';
      else startQuestion();
      return true;
    },
    restart({ id }) {
      if (id !== hostId || s.phase !== 'result') return false;
      Object.assign(s, freshGame());
      return true;
    },
  };

  let lastBeat = 0;
  const timer = setInterval(() => {
    let changed = false;
    if (s.phase === 'question' && now() >= s.deadline) {
      resolve('timeout');
      changed = true;
    }
    if (s.phase === 'question') {
      // オフラインの人を除いた全員一致も判定する
      const before = s.phase;
      checkUnanimous();
      if (s.phase !== before) changed = true;
    }
    if (s.phase === 'lobby') {
      const keep = s.players.filter((p) => p.id === hostId || now() - (seen[p.id] || 0) < LOBBY_DROP_AFTER_MS);
      if (keep.length !== s.players.length) {
        s.players = keep;
        changed = true;
      }
    }
    if (changed || now() - lastBeat > 2000) {
      lastBeat = now();
      publish();
    }
  }, 500);

  return {
    /** メッセージ（自分自身の操作も含む）を処理する。拒否時は {reject} を返す */
    handle(msg) {
      const fn = actions[msg.t];
      if (!fn) return null;
      const r = fn(msg);
      if (r) publish();
      return r;
    },
    publish,
    stop: () => clearInterval(timer),
  };
}
