// 自由入力の答え合わせ。表記ゆれをならしてから照合する。

/**
 * 比較用に文字列をならす。
 * - 全角英数→半角、半角カナ→全角（NFKC）
 * - 英字は小文字、カタカナはひらがなに
 * - 空白・記号・長音（ー）は取り除く
 */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　・･、。,.!！?？「」『』()（）［］\[\]{}〜~\-‐－―ーｰ'"`]/g, '');
}

/** 正解（answer と aliases）のどれかと一致するか */
export function isCorrect(text, answer, aliases = []) {
  const t = normalize(text);
  if (!t) return false;
  return [answer, ...aliases].some((a) => normalize(a) === t);
}
