// 組み込みの問題を questions.txt から読み込む。問題を増やすときは questions.txt だけを編集すればよい。
import { parseQuestions } from './parse.js';

let loaded = { questions: [], errors: [] };
try {
  const res = await fetch(new URL('./questions.txt', import.meta.url), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`questions.txt を読めませんでした (${res.status})`);
  loaded = parseQuestions(await res.text());
  if (loaded.errors.length) console.warn('questions.txt の書き方に問題があります:\n' + loaded.errors.join('\n'));
} catch (e) {
  console.error(e);
  loaded.errors.push(e.message);
}

/** ヒントが2つ以上ある問題だけを使う */
export const BUILTIN = loaded.questions.filter((q) => q.answer && q.hints.length >= 2);
export const BUILTIN_GENRES = [...new Set(BUILTIN.map((q) => q.genre))];
export const BUILTIN_ERRORS = loaded.errors;
