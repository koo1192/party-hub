# 🎲 パーティーハブ

みんなのスマホで遊ぶミニゲームの「箱」です。インストールは要らず、スマホのブラウザで遊べます。
1人が部屋を作り、ほかの人はQRコードかルームコードで参加します。ゲームはプラグインとして足していけます。

いま入っているゲーム:

| ゲーム | 人数 | 内容 |
| --- | --- | --- |
| 🧩 かけらクイズ | 2〜6人 | 1人1つずつ配られるヒントを声に出して持ち寄り、全員で同じ答えを入力する協力クイズ。1問ずつ何度でも。AIがジャンルに合わせて出題する |
| 🎨 せーので色合わせ | 2〜8人 | ゲームを作るときのお手本（テンプレート） |

ゲームの追加方法は [docs/ADD_GAME.md](docs/ADD_GAME.md) を見てください。

## 構成

| 役割 | 使うもの | 費用 |
| --- | --- | --- |
| 画面 | 素の HTML / CSS / JavaScript（ビルド不要、`public/`） | 無料 |
| 公開場所 | GitHub Pages / Netlify / Cloudflare Pages など静的ホスティング | 無料 |
| リアルタイム同期 | Supabase Realtime（broadcast だけ。DBは使わない） | 無料枠 |
| AI出題 | Claude API を Supabase Edge Function から呼ぶ（キーはサーバー側だけ） | API利用料 |

ホスト（部屋を作った人）の端末がゲームの進行を受け持ち、状態を全員に配ります。
`public/config.js` が空なら「ローカルモード」になり、同じブラウザのタブ同士だけで遊べます（開発用）。

```
public/
  index.html, config.js
  hub/        ハブ本体（main.js 画面と通信 / room.js 部屋の進行 / transport.js 通信 / util.js / style.css）
  games/
    registry.js     ゲームの一覧（ここに1行足すと載る）
    kakera/         かけらクイズ
    _template/      お手本のゲーム
supabase/functions/
  generate-question/  AI出題の Edge Function
  _shared/quiz-gen.js 出題の共通処理（server.mjs と共用）
server.mjs        ローカル用サーバー（配信 + /api/generate）
docs/ADD_GAME.md  ゲームの追加方法
```

## ローカルで動かす

```bash
npm install
npm start
```

http://localhost:8787 をタブ3つで開き、1つで部屋を作り、ほかで参加します。

AI出題も試すときは、`.env.example` を `.env` にコピーして `ANTHROPIC_API_KEY` を書きます。キーがなければ組み込みの問題（9ジャンル×3問）が出ます。

## スマホで遊ぶ

### 1. Supabase を用意する（スマホ同士をつなぐのに必要）

1. https://supabase.com で無料のプロジェクトを作る。
2. Project Settings > API Keys の「Project URL」と「anon」キー（新しいプロジェクトでは「Publishable key」）を `public/config.js` に貼る。このキーは公開する前提のキーなので、GitHub に載せても問題ない。
3. Realtime の設定は初期のままでよい。

無料プランのプロジェクトは、1週間使わないと一時停止する。その場合はダッシュボードから再開する。

### 2-A. 同じWi-Fiで遊ぶ

`npm start` で表示された `同じWi-Fiのスマホから: http://192.168.x.x:8787/` を、**ホストもそのURLで**開いて部屋を作る（QRコードがそのURLになる）。
初回は Windows のファイアウォールの確認が出るので「プライベートネットワーク」を許可する。この方法なら `.env` のキーでAI出題も使える。

### 2-B. ネットに公開して遊ぶ

`public/` フォルダを静的ホスティングに置く。

- **GitHub Pages**: リポジトリの Settings > Pages で公開する（`public/` を公開用に設定するか、Actions で `public/` を配信する）。
- **Netlify Drop**: https://app.netlify.com/drop に `public` フォルダをドラッグ＆ドロップする。

## AI出題を設定する（任意）

かけらクイズは、Claude API でジャンルに合わせた問題を作ります。設定しなくても組み込みの問題で遊べます。

1. https://platform.claude.com で API キーを発行する（利用料がかかる。上限額を設定しておくと安心）。
2. ローカル（2-A）で遊ぶなら、`.env` に `ANTHROPIC_API_KEY=...` を書いて `npm start` し直すだけ。
3. 公開（2-B）して遊ぶなら、Supabase の Edge Function に置く:

   ```bash
   npx supabase login
   npx supabase link --project-ref <プロジェクトID>
   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   npx supabase functions deploy generate-question --no-verify-jwt
   ```

   画面は `config.js` の Supabase 設定を見て、自動でこの関数を呼ぶ。

- モデルは `claude-opus-5-5`。変えたいときは `ANTHROPIC_MODEL` を設定する。
- 1問ごとに API を1回呼ぶ。`--no-verify-jwt` の関数は URL を知っていれば誰でも呼べるので、API キー側で利用上限を決めておくこと。
- APIキーは画面側のファイル（`public/`）には絶対に書かない。

## かけらクイズのルール

- ホストがジャンル（おまかせ・9ジャンル・好きなジャンルの自由入力）と制限時間（30/60/90/120秒・なし）を選んで出題する。
- 1人に1つずつヒントが配られる。人数が少ないほどヒントが減って難しくなる。
- 声に出してヒントを伝え合い、全員が自分のスマホで答えを入力する。
- 全員の答えが正解ならクリア。ひらがな/カタカナ、全角/半角、空白、長音の違いは同じとみなし、別名（例：おむすび）も正解にする。
- 判定が厳しすぎたときは、ホストが「正解にする」を押せる。
- 1問ずつ続け、連続正解・最高記録・クリア数を表示する。
