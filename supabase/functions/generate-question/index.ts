// Supabase Edge Function: かけらクイズの問題を作る。
// デプロイ: npx supabase functions deploy generate-question --no-verify-jwt
// キー:     npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
import Anthropic from 'npm:@anthropic-ai/sdk@1.3.0';
import { generateQuestion } from '../_shared/quiz-gen.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY が設定されていません', code: 'no_api_key' }, 503);

  try {
    const input = await req.json().catch(() => ({}));
    const client = new Anthropic({ apiKey });
    const q = await generateQuestion(client, input, { model: Deno.env.get('ANTHROPIC_MODEL') || undefined });
    return json(q);
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
