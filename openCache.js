/**
 * openCache.js — 暗网缓存开启器 v1.0
 *
 * 一次性脚本：扫描本机的 .cache 文件并全部打开，完成后自动退出。
 * 由 darkwebcontrol.js 自动分发到有缓存的暗网节点执行。
 *
 * RAM: ~3 GB (ls 0.2G + openCache 2G + base)
 *
 * 用法（通常由 darkwebcontrol 自动调用）:
 *   run openCache.js
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const host = ns.getHostname();
  const files = ns.ls(host).filter(f => f.endsWith(".cache") || f.endsWith(".d.cache"));

  if (files.length === 0) {
    ns.print(`[${host}] 无缓存文件`);
    return;
  }

  ns.print(`[${host}] 发现 ${files.length} 个缓存文件, 开始打开...`);
  let opened = 0;
  for (const f of files) {
    try {
      const r = await ns.dnet.openCache(f, true);
      if (r && r.success) {
        ns.print(`🎁 ${f}: ${r.message}`);
        opened++;
      }
    } catch (e) {
      ns.print(`⚠️ ${f}: ${e}`);
    }
  }
  ns.print(`[${host}] 完成: 打开 ${opened}/${files.length} 个缓存`);
}
