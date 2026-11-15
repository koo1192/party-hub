// AIで問題を作る（ホストの端末から呼ぶ）。APIキーはサーバー側にあり、ここには出てこない。
// 1. 同じサーバーの /api/generate（node server.mjs で起動したとき）
// 2. Supabase Edge Function の generate-question
// のどちらかにつながれば AI の問題、どちらもだめなら組み込みの問題を使う。
import { BUILTIN } from './builtin.js';
import { normalize } from './judge.js';
import { shuffle } from '../../hub/util.js';

const deadEndpoints = new Set();

function endpoints() {
  const c = window.HUB_CONFIG || {};
  const list = [];
  if (c.aiEndpoint) list.push({ url: c.aiEndpoint, headers: {} });
  list.push({ url: new URL('api/generate', location.href).toString(), headers: {} });
  if (c.supabaseUrl && c.supabaseAnonKey) {
    list.push({
      url: `${c.supabaseUrl.replace(/\/$/, '')}/functions/v1/generate-question`,
      headers: { apikey: c.supabaseAnonKey, Authorization: `Bearer ${c.supabaseAnonKey}` },
    });
  }
  return list.filter((e) => !deadEndpoints.has(e.url));
}

/** AIの返事が使える形か確かめ、ヒントに答えが入っていたら取り除く */
export function validate(q) {
  if (!q || typeof q.answer !== 'string' || !q.answer.trim() || !Array.isArray(q.hints)) return null;
  const forbidden = [q.answer, ...(q.aliases || [])].map(normalize).filter((x) => x.length >= 2);
  const hints = q.hints
    .map((h) => String(h).trim())
    .filter((h) => h && !forbidden.some((f) => normalize(h).includes(f)));
  if (hints.length < 6) return null;
  return {
    genre: String(q.genre || ''),
    answer: q.answer.trim(),
    aliases: (q.aliases || []).map(String).filter(Boolean).slice(0, 12),
    hints: hints.slice(0, 6),
  };
}

async function fromAI(genre, avoid) {
  for (const ep of endpoints()) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ep.headers },
        body: JSON.stringify({ genre, avoid }),
        signal: ctrl.signal,
      });
      if (res.status === 404 || res.status === 405 || res.status === 501) {
        // この場所には生成の仕組みがない（静的ホスティングなど）。次回から試さない
        deadEndpoints.add(ep.url);
        continue;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        console.warn('問題の生成に失敗', res.status, data);
        if (data && data.code === 'no_api_key') deadEndpoints.add(ep.url);
        continue;
      }
      const q = validate(data);
      if (q) return q;
      console.warn('生成された問題が使えない形でした', data);
    } catch (e) {
      console.warn('問題の生成でエラー', e);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function fromBuiltin(genre, avoid) {
  const avoidSet = new Set(avoid.map(normalize));
  let pool = BUILTIN.filter((q) => q.genre === genre);
  if (!pool.length) pool = BUILTIN;
  const fresh = pool.filter((q) => !avoidSet.has(normalize(q.answer)));
  const pick = shuffle(fresh.length ? fresh : pool)[0];
  return { ...pick, aliases: [...pick.aliases], hints: [...pick.hints] };
}

/**
 * 問題を1つ用意する。
 * @returns {Promise<{genre, answer, aliases, hints, source: 'ai'|'builtin'}>}
 */
export const aiEnabled = () => Boolean((window.HUB_CONFIG || {}).aiQuestions);

export async function makeQuestion(genre, avoid = []) {
  const ai = aiEnabled() ? await fromAI(genre, avoid.slice(-30)) : null;
  if (ai) return { ...ai, genre: ai.genre || genre, source: 'ai' };
  return { ...fromBuiltin(genre, avoid), source: 'builtin' };
}
