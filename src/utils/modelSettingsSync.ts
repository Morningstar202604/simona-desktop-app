// 与 api.ts 保持一致的 base URL 解析。之前这里用了相对路径 '/api/settings'，
// 在 Electron 打包版（file:// 页面）下会被解析成 file:///D:/api/settings 而必然失败
// （net::ERR_FILE_NOT_FOUND），导致设置同步始终不生效。改用绝对 API 地址。
const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI?.isElectron;
const API_BASE = isElectron
  ? 'http://127.0.0.1:30080/api'
  : (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1'
    ? '/api'
    : 'http://127.0.0.1:30080/api');

export async function syncSettingsFromServer(): Promise<void> {
    try {
        const res = await fetch(`${API_BASE}/settings`);
        if (!res.ok) return;
        const settings = await res.json();
        if (settings.chat_models) {
            localStorage.setItem('chat_models', JSON.stringify(settings.chat_models));
        }
        if (settings.default_model) {
            localStorage.setItem('default_model', settings.default_model);
        }
        if (settings.user_mode) {
            localStorage.setItem('user_mode', settings.user_mode);
        }
    } catch {
    }
}
export async function saveSettingsToServer(): Promise<void> {
    try {
        const chat_models = JSON.parse(localStorage.getItem('chat_models') || '[]');
        const default_model = localStorage.getItem('default_model') || '';
        const user_mode = localStorage.getItem('user_mode') || '';
        await fetch(`${API_BASE}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_models, default_model, user_mode }),
        });
    } catch {
    }
}
