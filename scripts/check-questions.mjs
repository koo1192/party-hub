// questions.txt の書き方をチェックする。使い方: npm run check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuestions } from '../public/games/kakera/parse.js';
import { normalize } from '../public/games/kakera/judge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'public', 'games', 'kakera', 'questions.txt');
const { questions, errors } = parseQuestions(fs.readFileSync(file, 'utf8'));
const problems = [...errors];
const warnings = [];
const seen = new Map();

for (const q of questions) {
  const where = `${q.line}行目「${q.answer}」`;
  if (q.hints.length < 6) problems.push(`${where}: ヒントが${q.hints.length}個しかありません（6個以上必要。6人で遊ぶと1人1個ずつ配るため）`);
  const key = normalize(q.answer);
  if (seen.has(key)) problems.push(`${where}: ${seen.get(key)}行目と同じ答えです`);
  seen.set(key, q.line);
  const names = [q.answer, ...q.aliases].map(normalize).filter((s) => s.length >= 2);
  for (const h of q.hints) {
    if (names.some((nm) => normalize(h).includes(nm))) warnings.push(`${where}: ヒント「${h}」に答えが入っています`);
  }
  // 漢字の答えには、ひらがな（かカタカナ）の読みが別解に必要。自動では漢字を読めないため
  const isKana = (s) => /^[ぁ-ゟ゠-ヿー\s・]+$/.test(s);
  if (/[㐀-鿿]/.test(q.answer) && ![q.answer, ...q.aliases].some(isKana)) {
    problems.push(`${where}: 漢字の答えには、ひらがなの読みを別解に書いてください（例：${q.answer} / よみかた）`);
  }
  if (!q.hasLevel) warnings.push(`${where}: 難易度（行末の★）がないので★★として扱います`);
  if (new Set(q.hints.map(normalize)).size !== q.hints.length) warnings.push(`${where}: 同じヒントが2回あります`);
}

const byGenre = {};
for (const q of questions) byGenre[q.genre] = (byGenre[q.genre] || 0) + 1;
console.log(`問題数: ${questions.length}問`);
for (const [g, n] of Object.entries(byGenre)) {
  const lv = [1, 2, 3].map((l) => questions.filter((q) => q.genre === g && q.level === l).length);
  console.log(`  ${g}: ${n}問（★${lv[0]} ★★${lv[1]} ★★★${lv[2]}）`);
}
for (const w of warnings) console.log(`注意: ${w}`);
for (const p of problems) console.log(`エラー: ${p}`);
if (problems.length) {
  console.log(`\nエラーが${problems.length}件あります。直してからもう一度実行してください。`);
  process.exit(1);
}
console.log(warnings.length ? '\nエラーはありません（注意だけあります）。' : '\nOK! 問題はありません。');
