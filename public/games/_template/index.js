// ===========================================================
// テンプレートゲーム「せーので色合わせ」
// 新しいゲームを作るときは、このフォルダを丸ごとコピーして始める。
// 詳しい説明は docs/ADD_GAME.md にある。
//
// ルール: 全員がこっそり色を1つ選ぶ。全員そろったら一斉に公開し、
//         全員が同じ色ならチームの得点。相談は禁止、空気を読もう。
// ===========================================================
import { esc, chip } from '../../hub/util.js';

const COLORS = [
  { id: 'red', label: 'あか', css: '#e4572e' },
  { id: 'blue', label: 'あお', css: '#2f7fd8' },
  { id: 'yellow', label: 'きいろ', css: '#e9a213' },
];

export default {
  // ---------- 1. ゲームの情報（一覧に出る） ----------
  meta: {
    id: 'template', // ほかと重ならない英小文字の名前。ふつうはフォルダ名と同じにする
    title: 'せーので色合わせ',
    emoji: '🎨',
    description: '全員がこっそり色を選び、そろったらチームの得点。ゲームを作るときのお手本。',
    minPlayers: 2,
    maxPlayers: 8,
    tags: ['協力', 'お手本'],
    author: 'パーティーハブ',
  },

  // ---------- 2. ホスト側のルール（部屋を作った人の端末だけで動く） ----------
  // state は JSON にできる値だけで作る（ホストが再読み込みしても復元できるように）。
  host: {
    /** ゲーム開始時に呼ばれ、最初の状態を返す */
    setup(api) {
      return { phase: 'pick', picks: {}, round: 1, score: 0 };
    },

    /**
     * プレイヤーの操作（ctx.send で送ったもの）を処理する。
     * state を直接書き換えればよい。何も変わらなかったときは false を返す。
     * @param state いまの状態
     * @param from 操作した人のID（ホストかどうかは from === api.hostId で判定）
     * @param action ctx.send に渡したオブジェクト
     */
    action(state, from, action, api) {
      if (action.type === 'pick' && state.phase === 'pick') {
        state.picks[from] = action.color;
        const everyone = api.onlinePlayers.every((p) => state.picks[p.id]);
        if (everyone) {
          state.phase = 'reveal';
          const colors = new Set(api.onlinePlayers.map((p) => state.picks[p.id]));
          state.matched = colors.size === 1;
          if (state.matched) state.score++;
        }
        return true;
      }
      if (action.type === 'next' && state.phase === 'reveal' && from === api.hostId) {
        Object.assign(state, { phase: 'pick', picks: {}, round: state.round + 1, matched: false });
        return true;
      }
      return false;
    },

    /** （任意）0.5秒ごとに呼ばれる。時間切れなどを判定し、変えたら true を返す */
    tick(state, api) {
      return false;
    },

    /**
     * （任意）全員に送る形に変える。答えなど、まだ見せたくない情報はここで隠す。
     * 送ったデータは技術的には全員の端末に届くので、本当の秘密は置かないこと。
     */
    view(state, api) {
      if (state.phase === 'pick') {
        // 選んだ色は隠して、誰が選び終わったかだけ送る
        return { ...state, picks: Object.fromEntries(Object.keys(state.picks).map((id) => [id, true])) };
      }
      return state;
    },
  },

  // ---------- 3. 画面（全員の端末で動く） ----------
  client: {
    /**
     * ゲームが始まったときに1回呼ばれる。root に画面を描き、update を持つオブジェクトを返す。
     * ctx: { me:{id,name}, isHost, hostId, players, code, now(), send(action) }
     */
    mount(root, ctx) {
      let current = ctx;
      root.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-color], button[data-next]');
        if (!b) return;
        if (b.dataset.color) current.send({ type: 'pick', color: b.dataset.color });
        else current.send({ type: 'next' });
      });

      return {
        /** 状態が変わるたびに呼ばれる。view は host.view が返したもの */
        update(view, c) {
          current = c;
          const me = c.me.id;
          const players = c.players;
          if (view.phase === 'pick') {
            const done = players.filter((p) => view.picks[p.id]);
            root.innerHTML = `
              <div class="topbar"><span>第${view.round}回</span><span>そろった回数 ${view.score}</span></div>
              <div class="card">
                <h2>みんなと同じ色を選ぼう（相談なし）</h2>
                <div class="choices">
                  ${COLORS.map(
                    (col) => `<button data-color="${col.id}" style="background:${col.css};color:#fff;min-height:72px">${col.label}</button>`,
                  ).join('')}
                </div>
                <p class="muted center">${view.picks[me] ? '選びました。みんなを待っています…' : 'まだ選んでいません'}</p>
                <p class="muted center">選び終わった人: ${done.map((p) => chip(players, p.id, 'small')).join(' ') || 'まだいません'}</p>
              </div>`;
          } else {
            root.innerHTML = `
              <div class="topbar"><span>第${view.round}回</span><span>そろった回数 ${view.score}</span></div>
              <p class="verdict ${view.matched ? 'ok' : 'ng'}">${view.matched ? 'そろった！' : 'バラバラ…'}</p>
              <div class="card">
                ${players
                  .filter((p) => view.picks[p.id])
                  .map((p) => {
                    const col = COLORS.find((x) => x.id === view.picks[p.id]);
                    return `<p>${chip(players, p.id)} → <b style="color:${col.css}">${esc(col.label)}</b></p>`;
                  })
                  .join('')}
              </div>
              ${c.isHost ? '<button class="primary" data-next="1">もう1回</button>' : '<p class="muted center">ホストを待っています…</p>'}`;
          }
        },
        /** （任意）ゲームが終わって画面を離れるときに呼ばれる */
        unmount() {},
      };
    },
  },
};
