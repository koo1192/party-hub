// ハブとゲームの両方から使える小物。

export const COLORS = ['#e4572e', '#2a9d8f', '#7b4fd6', '#e9a213', '#2f7fd8', '#d6457c', '#5c8d2f', '#8a5a44'];

/** HTML に埋め込む文字列のエスケープ */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 配列をシャッフルした新しい配列を返す */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** プレイヤーの名前チップ（色はプレイヤーの並び順で決まる） */
export function chip(players, id, extraClass = '') {
  const i = players.findIndex((p) => p.id === id);
  const p = players[i];
  const color = COLORS[(i < 0 ? 0 : i) % COLORS.length];
  return `<span class="chip ${extraClass} ${p && !p.online ? 'off' : ''}" style="background:${color}">${esc(p ? p.name : '？')}</span>`;
}

export function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return '';
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
}

/** localStorage / sessionStorage を例外なしで読み書きする */
export const store = {
  get(area, k) {
    try {
      return window[area].getItem(k);
    } catch {
      return null;
    }
  },
  set(area, k, v) {
    try {
      if (v == null) window[area].removeItem(k);
      else window[area].setItem(k, v);
    } catch {
      /* 保存できない環境では無視 */
    }
  },
};
