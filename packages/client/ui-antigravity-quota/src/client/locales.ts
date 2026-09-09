/** Localized Antigravity quota copy. */
export const en = {
  'title': 'Antigravity quota', 'remaining': '{percent}% left', 'primary': 'Primary', 'secondary': 'Secondary',
  'window': '{duration} window', 'unknown': 'Unavailable', 'resets': 'Resets {time}',
  'refresh': 'Refresh', 'running': 'Refreshing…', 'failed': 'Refresh failed. Last reading may be stale. Open Antigravity and sign in.',
  'empty': 'No quota windows available. Open Antigravity and sign in, then refresh.',
  'captured': 'Updated {time}', 'never': 'No reading yet', 'note': 'Models within each group share quota. Refresh runs no model turn.',
}
/** Translation key vocabulary. */
export type QuotaKey = keyof typeof en
/** Locale namespace. */
export const NS = 'antigravity-quota'
/** Chinese dictionary. */
export const zh: Record<QuotaKey, string> = {
  'title': 'Antigravity 配额', 'remaining': '剩余 {percent}%', 'primary': '主要', 'secondary': '次要',
  'window': '{duration} 窗口', 'unknown': '不可用', 'resets': '{time} 重置',
  'refresh': '刷新', 'running': '正在刷新…', 'failed': '刷新失败。上次数据可能已过期，请检查 Antigravity 登录。',
  'empty': '暂无配额窗口。请打开 Antigravity 并登录后刷新。',
  'captured': '{time} 更新', 'never': '尚无数据', 'note': '所有 Antigravity 任务共用账户配额。刷新不会运行模型。',
}
