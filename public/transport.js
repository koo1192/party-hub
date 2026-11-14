// 通信層。Supabase Realtime の broadcast を使う。
// 設定が空なら BroadcastChannel（同じブラウザ内のタブ同士だけ）で代用する。

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export function isOnlineConfigured() {
  const c = window.KAKERA_CONFIG || {};
  return Boolean(c.supabaseUrl && c.supabaseAnonKey);
}

let clientPromise = null;
async function getClient() {
  if (!clientPromise) {
    const c = window.KAKERA_CONFIG;
    clientPromise = import(SUPABASE_ESM).then(({ createClient }) =>
      createClient(c.supabaseUrl, c.supabaseAnonKey, {
        realtime: { params: { eventsPerSecond: 20 } },
      }),
    );
  }
  return clientPromise;
}

/**
 * 部屋のチャンネルに接続する。
 * @returns {Promise<{mode: 'online'|'local', send: (msg:any)=>void, close: ()=>void}>}
 */
export async function connect(room, onMessage) {
  const name = `kakera-${room}`;
  if (isOnlineConfigured()) {
    const sb = await getClient();
    const ch = sb.channel(name, { config: { broadcast: { self: false } } });
    ch.on('broadcast', { event: 'm' }, ({ payload }) => onMessage(payload));
    await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) reject(new Error('接続がタイムアウトしました'));
      }, 10000);
      ch.subscribe((status) => {
        if (done) return;
        if (status === 'SUBSCRIBED') {
          done = true;
          clearTimeout(timer);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          done = true;
          clearTimeout(timer);
          reject(new Error(`接続できませんでした (${status})`));
        }
      });
    });
    return {
      mode: 'online',
      send: (msg) => ch.send({ type: 'broadcast', event: 'm', payload: msg }),
      close: () => sb.removeChannel(ch),
    };
  }
  const bc = new BroadcastChannel(name);
  bc.onmessage = (e) => onMessage(e.data);
  return {
    mode: 'local',
    send: (msg) => bc.postMessage(msg),
    close: () => bc.close(),
  };
}
