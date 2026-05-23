/**
 * darkwebcontrol.js — 暗网控制中枢 v3.0
 *
 * 精简版：仅负责部署 dnet-watch.js 到 darkweb + 日志面板。
 * 所有智能控制（扫描、分析、破译队列、部署）已移入 dnet-watch.js。
 *
 * @param {NS} ns
 */
import { formatNumber } from './helpers.js';

export async function main(ns) {
  const WATCH_SCRIPT = ns.args.includes("--watch")
    ? ns.args[ns.args.indexOf("--watch") + 1]
    : "dnet-watch.js";
  const WORM_SCRIPT = "dnet-worm.js";
  const OPENCACHE_SCRIPT = "openCache.js";
  const STOCKMASTER_SCRIPT = "stockmaster.js";
  const REPORT_BASE = "/Temp/dnet-worm-";

  ns.disableLog('ALL');
  ns.ui.openTail();
  ns.clearLog();
  ns.ui.resizeTail(580, 320);

  const stats = { startTime: Date.now() };
  const recentLog = [];
  function addLog(msg) { recentLog.push(msg); if (recentLog.length > 12) recentLog.shift(); }

  // ========== 读取报告（仅供展示） ==========

  let wormStatus = {};
  let cacheStats = { opened: 0, totalFiles: 0 };

  function collectReports() {
    // 状态报告
    for (const f of ns.ls("home").filter(f => f.startsWith(REPORT_BASE + "status-"))) {
      try {
        const r = JSON.parse(ns.read(f));
        if (r.host) wormStatus[r.host] = { ...r, lastSeen: r.timestamp || Date.now() };
        ns.rm(f);
      } catch { ns.rm(f); }
    }
    // 缓存报告
    for (const f of ns.ls("home").filter(f => f.startsWith(REPORT_BASE + "cache-"))) {
      try {
        const r = JSON.parse(ns.read(f));
        cacheStats.opened += r.opened || 0;
        cacheStats.totalFiles += r.total || 0;
        addLog(`🎁 ${r.host}: 打开 ${r.opened}/${r.total} 缓存`);
        ns.rm(f);
      } catch { ns.rm(f); }
    }
    // 破解报告
    for (const f of ns.ls("home").filter(f => f.startsWith(REPORT_BASE + "crack-"))) {
      try {
        const r = JSON.parse(ns.read(f));
        addLog(`✅ ${r.host} 破解 (${r.type || '?'})`);
        ns.rm(f);
      } catch { ns.rm(f); }
    }
    // 清理杂文件
    for (const f of ns.ls("home").filter(f =>
      f.startsWith(REPORT_BASE + "openCache-") ||
      f.startsWith(REPORT_BASE + "cache-idle-") ||
      f.startsWith(REPORT_BASE + "need-crack-") ||
      f.startsWith(REPORT_BASE + "need-") ||
      f.startsWith(REPORT_BASE + "cmd-")
    )) { try { ns.rm(f); } catch {} }
  }

  // ========== 部署 dnet-watch.js ==========

  let watchPid = 0;
  async function ensureWatch() {
    if (!ns.fileExists(WATCH_SCRIPT, "home")) return false;
    const running = ns.isRunning(watchPid);
    if (running) return true;
    // 先清理旧 worm
    try { for (const p of ns.ps("darkweb")) { if (p.filename === WORM_SCRIPT) ns.kill(p.pid); } } catch {}
    // 部署全部脚本
    for (const script of [WATCH_SCRIPT, WORM_SCRIPT, OPENCACHE_SCRIPT, STOCKMASTER_SCRIPT]) {
      if (ns.fileExists(script, "home")) {
        try { await ns.scp(script, "darkweb"); } catch {}
      }
    }
    watchPid = ns.exec(WATCH_SCRIPT, "darkweb", 1);
    addLog(watchPid > 0 ? `🟢 watch 已部署 PID=${watchPid}` : "⚠️ watch 部署失败");
    return watchPid > 0;
  }

  // ========== 仪表盘 ==========

  function drawDashboard() {
    ns.clearLog();
    const s = Math.floor((Date.now() - stats.startTime) / 1000);
    const now = Date.now();
    const active = Object.entries(wormStatus).filter(([, st]) => (now - st.lastSeen) < 60000).length;
    const watchRunning = ns.isRunning(watchPid);

    ns.print("╔══════════════════════════════════════════════════╗");
    ns.print("║      暗网控制中枢 v3.0 (监视器模式)             ║");
    ns.print("╠══════════════════════════════════════════════════╣");
    ns.print(`║  运行: ${formatNumber(s)}s`);
    ns.print(`║  watch: ${watchRunning ? '🟢 存活' : '🔴 离线'}  活跃监视器: ${active}`);
    ns.print(`║  🎁缓存: ${cacheStats.opened}/${cacheStats.totalFiles}`);
    ns.print("╠══════════════════════════════════════════════════╣");
    ns.print("║  最近活动:");
    for (const m of recentLog) ns.print(`║  ${m}`);
    ns.print("╚══════════════════════════════════════════════════╝");
  }

  // ========== 主循环 ==========

  await ensureWatch();
  drawDashboard();

  while (true) {
    await ensureWatch();
    collectReports();
    drawDashboard();
    await ns.sleep(5000);
  }
}
