// Supabase の接続設定。
// Supabase ダッシュボード > Project Settings > API の「Project URL」と「anon public」キーを貼り付ける。
// anon キーはブラウザに公開される前提のキーなので、ここに書いて公開しても問題ない。
// 空のままだと「ローカルモード」になり、同じブラウザのタブ同士でしか遊べない（動作確認用）。
window.HUB_CONFIG = {
  supabaseUrl: 'https://rihfgxrazltrtejlceau.supabase.co',
  supabaseAnonKey: 'sb_publishable_LJts15c6oTFRTthNBR78RA_sQn_1P9g',
};
