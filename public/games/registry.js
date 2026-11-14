// ハブに載せるゲームの一覧。新しいゲームを作ったらここに1行足す。
// 追加のしかたは docs/ADD_GAME.md を参照。

/** このリポジトリの中にあるゲーム（games/<id>/index.js） */
export const GAME_MODULES = [
  './kakera/index.js',
  './_template/index.js',
];

/**
 * 別の技術（Unity など）で作られ、別の場所で公開されているゲーム。
 * 一覧にカードが出て、タップするとそのURLを開く。部屋の仕組みは使わない。
 * 例:
 * { id: 'tank', title: 'スクラップタンク', emoji: '🛡️', description: '…', minPlayers: 2, maxPlayers: 4, url: 'https://example.com/tank/', author: 'ともだち' }
 */
export const EXTERNAL_GAMES = [];
