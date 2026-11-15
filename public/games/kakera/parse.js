// questions.txt を読み取る（ブラウザと Node の両方で使う）。
//
// 書き方:
//   # で始まる行はメモ（無視される）
//   ## ジャンル名          … ここから下はこのジャンルの問題
//   答え / 別解 / 別解      … 問題の1行目。別解はなくてもよい
//   - ヒント               … 6個以上。多いときは毎回ランダムに選ばれる
//   （空行で次の問題）

/**
 * @param {string} text
 * @returns {{questions: {genre:string, answer:string, aliases:string[], hints:string[], line:number}[], errors: string[]}}
 */
export function parseQuestions(text) {
  const questions = [];
  const errors = [];
  let genre = 'その他';
  let cur = null;
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const n = i + 1;
    if (!line) {
      cur = null;
      return;
    }
    if (/^##(?!#)/.test(line)) {
      genre = line.replace(/^##\s*/, '').trim() || 'その他';
      cur = null;
      return;
    }
    if (line.startsWith('#')) return;
    const hint = line.match(/^[-－ー・*＊]\s*(.+)$/);
    if (hint) {
      if (!cur) errors.push(`${n}行目: ヒントの前に答えの行がありません`);
      else cur.hints.push(hint[1].trim());
      return;
    }
    if (cur) {
      errors.push(`${n}行目: 「${line}」は前の問題の続きになっています。ヒントなら先頭に「- 」をつけ、新しい問題なら前に空行を入れてください`);
      return;
    }
    const parts = line.split(/[\/／]/).map((s) => s.trim()).filter(Boolean);
    cur = { genre, answer: parts[0], aliases: parts.slice(1), hints: [], line: n };
    questions.push(cur);
  });
  return { questions, errors };
}
