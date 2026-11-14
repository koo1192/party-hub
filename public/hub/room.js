// 部屋の進行（ホスト端末だけで動く）。
// 参加者の管理・オンライン判定・ゲームの開始と終了をハブが受け持ち、
// ゲーム中のルールは各ゲームの host.* に任せる。状態は JSON にできる形だけで持つ。
import { shuffle } from './util.js';

export const HUB_MAX_PLAYERS = 8;
const OFFLINE_AFTER_MS = 10 * 1000;
const LOBBY_DROP_AFTER_MS = 15 * 1000;

/**
 * @param {object} o
 * @param {string} o.code ルームコード
 * @param {string} o.hostId ホストのプレイヤーID
 * @param {Map<string, any>} o.games 読み込み済みのゲーム（id → プラグイン）
 * @param {(pub:any, full:any)=>void} o.emit 状態を配信する関数
 * @param {any} [o.saved] 再読み込み時に復元する状態
 */
export function createRoomHost({ code, hostId, games, emit, saved }) {
  const s = saved || { code, hostId, players: [], phase: 'lobby', gameId: games.keys().next().value, game: null, v: 0 };
  const seen = {};
  const now = () => Date.now();
  s.players.forEach((p) => (seen[p.id] = now()));

  const isOnline = (id) => id === hostId || now() - (seen[id] || 0) < OFFLINE_AFTER_MS;
  const playersPub = () => s.players.map((p) => ({ id: p.id, name: p.name, online: isOnline(p.id) }));
  const plugin = () => games.get(s.gameId);

  // ゲームに渡す道具
  const api = {
    hostId,
    /** 参加者全員（online でオフライン判定） */
    get players() {
      return playersPub();
    },
    /** いまオンラインの参加者 */
    get onlinePlayers() {
      return playersPub().filter((p) => p.online);
    },
    now,
    shuffle,
    /** 非同期処理のあとで状態を変えたときに呼ぶ */
    publish: () => publish(),
    /** ゲームを終えてロビーに戻る */
    endGame() {
      s.phase = 'lobby';
      s.game = null;
    },
  };

  let lastSig = '';
  function publicState() {
    let view = null;
    if (s.phase === 'game' && s.game) {
      const p = plugin();
      view = p?.host.view ? p.host.view(s.game, api) : s.game;
    }
    return { code: s.code, hostId, players: playersPub(), phase: s.phase, gameId: s.gameId, view, v: s.v };
  }
  function publish() {
    s.v++;
    emitNow();
  }
  function emitNow() {
    const pub = publicState();
    lastSig = pub.players.map((p) => p.id + p.online).join();
    emit(pub, s);
  }

  function addOrUpdatePlayer(id, name) {
    seen[id] = now();
    const existing = s.players.find((p) => p.id === id);
    const clean = String(name || 'ななし').trim().slice(0, 10) || 'ななし';
    if (existing) {
      existing.name = clean;
      return true;
    }
    const max = s.phase === 'game' ? Math.min(HUB_MAX_PLAYERS, plugin()?.meta.maxPlayers ?? HUB_MAX_PLAYERS) : HUB_MAX_PLAYERS;
    if (s.players.length >= max) return { reject: `満員です（最大${max}人）` };
    s.players.push({ id, name: clean });
    return true;
  }

  const hubOps = {
    select({ gameId }) {
      if (s.phase !== 'lobby' || !games.has(gameId)) return false;
      s.gameId = gameId;
      return true;
    },
    start() {
      const p = plugin();
      if (s.phase !== 'lobby' || !p) return false;
      const online = api.onlinePlayers;
      if (online.length < p.meta.minPlayers || online.length > p.meta.maxPlayers) return false;
      s.players = s.players.filter((x) => isOnline(x.id));
      s.game = p.host.setup(api);
      s.phase = 'game';
      return true;
    },
    lobby() {
      if (s.phase !== 'game') return false;
      api.endGame();
      return true;
    },
  };

  function handle(msg) {
    const id = msg.id;
    if (!id) return null;
    let r = false;
    switch (msg.t) {
      case 'join':
        r = addOrUpdatePlayer(id, msg.name);
        break;
      case 'leave':
        if (id !== hostId) {
          if (s.phase === 'lobby') s.players = s.players.filter((p) => p.id !== id);
          seen[id] = 0;
          r = true;
        }
        break;
      case 'ping': {
        const wasOffline = !isOnline(id);
        seen[id] = now();
        r = wasOffline && s.players.some((p) => p.id === id);
        break;
      }
      case 'hub':
        if (id === hostId && hubOps[msg.op]) r = hubOps[msg.op](msg);
        break;
      case 'act':
        if (s.phase === 'game' && s.game && s.players.some((p) => p.id === id)) {
          seen[id] = now();
          const res = plugin().host.action(s.game, id, msg.a || {}, api);
          r = res !== false;
        }
        break;
      default:
        return null;
    }
    if (r) publish();
    return r;
  }

  let lastBeat = 0;
  const timer = setInterval(() => {
    let changed = false;
    if (s.phase === 'game' && s.game) {
      const p = plugin();
      if (p?.host.tick && p.host.tick(s.game, api)) changed = true;
    }
    if (s.phase === 'lobby') {
      const keep = s.players.filter((p) => p.id === hostId || now() - (seen[p.id] || 0) < LOBBY_DROP_AFTER_MS);
      if (keep.length !== s.players.length) {
        s.players = keep;
        changed = true;
      }
    }
    const sig = playersPub().map((p) => p.id + p.online).join();
    if (sig !== lastSig) changed = true;
    if (changed) publish();
    else if (now() - lastBeat > 2000) {
      lastBeat = now();
      emitNow();
    }
  }, 500);

  return { handle, publish, stop: () => clearInterval(timer) };
}
