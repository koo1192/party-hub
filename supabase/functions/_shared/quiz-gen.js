// かけらクイズの問題を Claude に作らせる共通処理。
// ローカルの server.mjs と Supabase Edge Function の両方から使う（Anthropic クライアントは呼び出し側が渡す）。

export const DEFAULT_MODEL = 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  properties: {
    genre: { type: 'string', description: 'ジャンル名' },
    answer: { type: 'string', description: '正解。1つの名詞' },
    aliases: {
      type: 'array',
      items: { type: 'string' },
      description: '正解として認める別の書き方（ひらがな・カタカナ・漢字の読み、よくある別名、略称）',
    },
    hints: {
      type: 'array',
      items: { type: 'string' },
      description: 'ヒントちょうど6個',
    },
  },
  required: ['genre', 'answer', 'aliases', 'hints'],
  additionalProperties: false,
};

const SYSTEM = `あなたは日本のパーティーゲーム「かけらクイズ」の出題者です。
2〜6人が1人1つずつヒントを受け取り、声に出して持ち寄って、全員で同じ答えを自由入力します。

問題の作り方:
- 答えは、日本の小学校高学年から大人までの多くの人が知っている、1つの名詞にする。
- ヒントはちょうど6個。どれも短い日本語の文（30文字以内）にする。
- ヒント1つだけでは答えが決まらないようにする。2〜3個合わせるとかなり絞れ、6個全部で1つに決まるようにする。
- 6個のどの2個を組み合わせても、ある程度は答えに近づけるように、性質の違うヒントを混ぜる（見た目、場所、使い方、歴史、関係のあるもの など）。
- ヒントに答えそのものや、その読み・別名・答えを含む言葉を書かない。
- aliases には、答えのひらがな表記・カタカナ表記・漢字表記のうち answer と違うもの、よく使われる別名や略称を入れる。answer と同じ文字列は入れなくてよい。
- 子どもも遊ぶので、怖すぎる話題や大人向けの話題は避ける。`;

/**
 * @param {any} client Anthropic SDK のクライアント
 * @param {{genre?: string, avoid?: string[]}} input
 * @param {{model?: string}} [opts]
 */
export async function generateQuestion(client, input, opts = {}) {
  const genre = String(input?.genre || 'おまかせ').slice(0, 30);
  const avoid = (Array.isArray(input?.avoid) ? input.avoid : []).map(String).slice(-30);
  const genreText = genre === 'おまかせ' ? 'ジャンルは自由に選んでください。' : `ジャンル: ${genre}`;
  const avoidText = avoid.length ? `\nこれまでに出た答え（使わないこと）: ${avoid.join('、')}` : '';

  const response = await client.beta.messages.create({
    model: opts.model || DEFAULT_MODEL,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    messages: [{ role: 'user', content: `問題を1問作ってください。\n${genreText}${avoidText}` }],
  });

  if (response.stop_reason === 'refusal') throw new Error('この内容では問題を作れませんでした');
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('AIの返事が空でした');
  const q = JSON.parse(text);
  if (!q.genre) q.genre = genre;
  return q;
}
