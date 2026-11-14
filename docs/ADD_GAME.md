# ゲームの追加のしかた

パーティーハブには、2通りの方法でゲームを載せられます。

| 方法 | 向いているもの | 部屋・QR・同期 |
| --- | --- | --- |
| **A. プラグイン**（`public/games/<id>/`） | HTML / JavaScript で作るゲーム | ハブのものをそのまま使える |
| **B. 外部リンク**（`EXTERNAL_GAMES`） | Unity など別の技術で作り、別の場所で公開しているゲーム | 使わない（一覧からそのURLを開くだけ） |

---

## A. プラグインとして作る

### 1. テンプレートをコピーする

```bash
cp -r public/games/_template public/games/mygame
```

`public/games/mygame/index.js` を開き、`meta.id` を `mygame` に、`title` などを自分のゲームに書きかえます。

### 2. 一覧に登録する

`public/games/registry.js` の `GAME_MODULES` に1行足します。

```js
export const GAME_MODULES = [
  './kakera/index.js',
  './_template/index.js',
  './mygame/index.js', // ← 追加
];
```

### 3. 動かしてみる

```bash
npm start
```

http://localhost:8787 を同じブラウザのタブで2〜3個開き、1つで部屋を作り、ほかのタブでルームコードを入れて参加します（`config.js` が空のときは、タブ同士だけで通信する「ローカルモード」になります）。

### しくみ

```
  ホストの端末                                  みんなの端末（ホストも含む）
 ┌──────────────────────┐   状態を配信    ┌──────────────────────┐
 │ host.setup / action /│ ─────────────▶ │ client.mount → update │
 │ tick / view          │ ◀───────────── │ ctx.send(action)      │
 └──────────────────────┘  操作を送る     └──────────────────────┘
```

- **ルールはホストの端末だけで動きます。** 状態（state）の正しい値はホストだけが持ち、変わるたびに全員へ配られます。
- 各端末の画面は、配られた状態を描くだけです。ボタンが押されたら `ctx.send({...})` でホストに操作を送ります。
- 参加者の管理、オンライン判定、再接続、ロビーへの戻りはハブが受け持ちます。

### プラグインの形

```js
export default {
  meta: {
    id: 'mygame',          // ほかと重ならない英小文字
    title: 'ゲーム名',
    emoji: '🎮',
    description: '一覧に出る説明',
    minPlayers: 2,
    maxPlayers: 6,
    tags: ['対戦'],
    author: 'あなたの名前',
  },
  host: {
    setup(api) { return { /* 最初の状態 */ }; },
    action(state, from, action, api) { /* state を書きかえる。変化なしなら false */ },
    tick(state, api) { /* 任意。0.5秒ごと。変えたら true */ },
    view(state, api) { /* 任意。全員に送る形。隠したい値を消す */ },
  },
  client: {
    mount(root, ctx) {
      return {
        update(view, ctx) { /* root に画面を描く */ },
        unmount() { /* 任意。タイマーの停止など */ },
      };
    },
  },
};
```

**ホスト側の `api`**

| 名前 | 内容 |
| --- | --- |
| `api.hostId` | ホストのID。ホストだけの操作は `from === api.hostId` で確かめる |
| `api.players` | 参加者全員 `[{ id, name, online }]` |
| `api.onlinePlayers` | いまつながっている参加者 |
| `api.now()` | ホストの時刻（ミリ秒）。締め切りはこれで決める |
| `api.shuffle(arr)` | シャッフルした配列を返す |
| `api.publish()` | `fetch` などの非同期処理のあとで state を変えたときに呼ぶ |
| `api.endGame()` | ゲームを終えてロビーに戻る |

**画面側の `ctx`**

| 名前 | 内容 |
| --- | --- |
| `ctx.me` | 自分 `{ id, name }` |
| `ctx.isHost` / `ctx.hostId` | 自分がホストか / ホストのID |
| `ctx.players` | 参加者全員 `[{ id, name, online }]` |
| `ctx.now()` | ホストに合わせた時刻。残り時間は `view.deadline - ctx.now()` で出す |
| `ctx.send(action)` | ホストに操作を送る（`host.action` に届く） |

画面づくりには `public/hub/util.js` の `esc`（HTMLエスケープ）と `chip`（名前の色チップ）が使えます。見た目は `public/hub/style.css` の `card`・`primary`・`choices`・`verdict` などのクラスを使うと、ほかのゲームとそろいます。

### 守ること

- **state は JSON にできる値だけ**（数値・文字列・配列・オブジェクト）。ホストがページを再読み込みしても、そこから続きを遊べるようにするためです。関数や `Date`、`Map` は入れない。
- **配信した内容は全員の端末に届きます。** `view` で隠しても、ホストの端末の中には元の state があります。パーティーゲーム向けの「見えにくくする」程度だと考えてください。
- **`update` は状態が変わったときだけ呼ばれます。** 入力欄があるときは、描き直しで文字が消えないように、入力中の値を変数に取っておいて戻します（`games/kakera/index.js` の例を参照）。
- ユーザーが入力した文字を画面に出すときは、必ず `esc()` を通す。
- 他のゲームのファイルや `hub/` は、必要がなければ変えない。ハブの変更が必要なら、別のプルリクエストにする。

---

## B. 外部リンクとして載せる

`public/games/registry.js` の `EXTERNAL_GAMES` に追加します。

```js
export const EXTERNAL_GAMES = [
  {
    id: 'tank',
    title: 'スクラップタンク',
    emoji: '🛡️',
    description: 'Unity で作った戦車バトル',
    minPlayers: 2,
    maxPlayers: 4,
    url: 'https://example.com/tank/',
    author: 'ともだち',
  },
];
```

一覧にカードが出て、「開く ↗」でそのURLが新しいタブで開きます。部屋やQRの仕組みは、そのゲームの側で用意してください。

---

## GitHub で一緒に作る流れ

1. リポジトリのオーナーが、友達を Collaborator に招待する（または友達がフォークする）。
2. 友達はブランチを作り、`public/games/<id>/` と `registry.js` の1行だけを変えてプルリクエストを出す。
3. ローカルで3タブ通しプレイを確認してからマージする。

ゲームごとにフォルダが分かれているので、同時に何本作っても衝突しにくくなっています。
