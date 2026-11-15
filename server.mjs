// パーティーハブ用の小さなサーバー。
// - public/ を配信する（同じWi-Fiのスマホからアクセスできる）
// - POST /api/generate でかけらクイズの問題を Claude に作らせる（.env の ANTHROPIC_API_KEY を使う）
// 使い方: npm start   （= node --env-file-if-exists=.env server.mjs）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateQuestion } from './supabase/functions/_shared/quiz-gen.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'public');
const port = Number(process.env.PORT) || 8787;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

let anthropic = null;
async function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    anthropic = new Anthropic();
  }
  return anthropic;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handleGenerate(req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10000) return sendJson(res, 413, { error: 'too large' });
  }
  let client;
  try {
    client = await getAnthropic();
  } catch (e) {
    console.error(e);
    return sendJson(res, 503, { error: '@anthropic-ai/sdk が見つかりません。npm install を実行してください', code: 'no_sdk' });
  }
  if (!client) return sendJson(res, 503, { error: 'ANTHROPIC_API_KEY が設定されていません', code: 'no_api_key' });
  try {
    const input = body ? JSON.parse(body) : {};
    const started = Date.now();
    const q = await generateQuestion(client, input, { model: process.env.ANTHROPIC_MODEL || undefined });
    console.log(`問題を生成: ${q.genre} / ${q.answer}（${((Date.now() - started) / 1000).toFixed(1)}秒）`);
    sendJson(res, 200, q);
  } catch (e) {
    console.error('問題の生成に失敗:', e.message);
    sendJson(res, 502, { error: e.message });
  }
}

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (urlPath === '/api/generate') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
      return handleGenerate(req, res);
    }
    let file = path.normalize(path.join(root, urlPath));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  })
  .listen(port, '0.0.0.0', () => {
    console.log(`パーティーハブ: http://localhost:${port}/`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  同じWi-Fiのスマホから: http://${a.address}:${port}/`);
      }
    }
    console.log(process.env.ANTHROPIC_API_KEY ? 'AI出題: 有効' : 'AI出題: 無効（.env に ANTHROPIC_API_KEY を書くと有効。なければ組み込みの問題を使う）');
  });
