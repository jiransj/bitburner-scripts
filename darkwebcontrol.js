/**
 * darkwebcontrol.js — 暗网控制中枢 v1.0
 *
 * 运行在 home 上，负责暗网全自动控制：
 *   1. 部署 dnet-worm.js 到 darkweb 并启动
 *   2. 收集所有蠕虫副本回报的破解报告
 *   3. 向指定节点下发指令（connectToSession + scp）
 *
 * 用法:
 *   run darkwebcontrol.js
 *   run darkwebcontrol.js --worm dnet-worm.js
 *
 * @param {NS} ns
 */
import { formatNumber } from './helpers.js';

export async function main(ns) {
  const WORM_SCRIPT = ns.args.includes("--worm")
    ? ns.args[ns.args.indexOf("--worm") + 1]
    : "dnet-worm.js";
  const REPORT_BASE = "/Temp/dnet-worm-";

  ns.disableLog('ALL');
  ns.clearLog();

  // ── 统计数据 ──
  const stats = {
    totalCracked: 0,
    totalNodes: 0,
    dispatched: 0,
    failed: 0,
    startTime: Date.now(),
  };
  const recentLog = []; // 最近 8 条活动

  /** 添加一条活动记录 */
  function addLog(msg) {
    recentLog.push(msg);
    if (recentLog.length > 8) recentLog.shift();
  }

  /** 绘制仪表盘 */
  function drawDashboard() {
    ns.clearLog();
    const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(0);
    ns.print("╔══════════════════════════════════════════════════╗");
    ns.print("║       暗网控制中枢 v1.0                         ║");
    ns.print("╠══════════════════════════════════════════════════╣");
    ns.print(`║  运行时间: ${formatNumber(elapsed)}s              `);
    ns.print(`║  已破解:   ${formatNumber(stats.totalCracked)} 台服务器`);
    ns.print(`║  已发现:   ${formatNumber(stats.totalNodes)} 个节点`);
    ns.print(`║  已调度:   ${formatNumber(stats.dispatched)} 次`);
    ns.print(`║  失败:     ${formatNumber(stats.failed)} 次`);
    ns.print("╠══════════════════════════════════════════════════╣");
    ns.print("║  最近活动:                                       ");
    for (const msg of recentLog) {
      ns.print(`║  ${msg}`);
    }
    ns.print("╚══════════════════════════════════════════════════╝");
  }

  // ── 阶段一：部署 ──
  ns.print("🚀 部署蠕虫到 darkweb...");
  if (!ns.fileExists(WORM_SCRIPT, "home")) {
    ns.tprint(`❌ ${WORM_SCRIPT} 不存在`);
    return;
  }
  await ns.scp(WORM_SCRIPT, "darkweb");
  const wormPid = ns.exec(WORM_SCRIPT, "darkweb", 1, "--controller", "home");
  if (wormPid > 0) {
    addLog(`蠕虫启动 PID=${wormPid}`);
  } else {
    addLog("⚠️ 蠕虫启动失败");
  }
  drawDashboard();

  // ── 阶段二：收集回报 ──
  function collectReports() {
    const byReporter = {};
    const files = ns.ls("home").filter((f) => f.startsWith(REPORT_BASE + "crack-"));
    for (const f of files) {
      try {
        const r = JSON.parse(ns.read(f));
        const rep = r.reporter || "unknown";
        if (!byReporter[rep]) byReporter[rep] = [];
        byReporter[rep].push(r);
        stats.totalCracked++;
        // 记录新节点
        if (r.host && r.host !== rep) stats.totalNodes++;
        ns.rm(f);
      } catch (e) { ns.rm(f); }
    }
    return byReporter;
  }

  // ── 阶段三：生成任务 + 下发 ──
  function buildTasks(cracks) {
    const tasks = [];
    for (const c of cracks) {
      if (c.password || c.type === "BufferOverflow") {
        tasks.push({ op: "authenticate", host: c.host, password: c.password || "" });
        tasks.push({ op: "freeMemory", host: c.host });
      }
    }
    return tasks;
  }

  async function dispatchTasks(reporter, cracks) {
    const tasks = buildTasks(cracks);
    if (tasks.length === 0) return;

    try {
      // 建立会话
      const selfCrack = cracks.find((c) => c.host === reporter);
      if (selfCrack && selfCrack.password) {
        await ns.dnet.connectToSession(reporter, selfCrack.password);
      } else if (cracks.length > 0) {
        await ns.dnet.connectToSession(reporter, cracks[0].password);
      }

      // scp 指令文件
      const safeName = reporter.replace(/[^a-zA-Z0-9]/g, "_");
      const cmdFile = REPORT_BASE + "cmd-" + safeName + ".txt";
      ns.write(cmdFile, JSON.stringify({ tasks }), "w");
      await ns.scp(cmdFile, reporter);
      ns.rm(cmdFile);

      stats.dispatched++;
      const summary = tasks.map(t => t.op + ":" + t.host).join(" ");
      addLog(`→ ${reporter} ${summary}`);
    } catch (e) {
      stats.failed++;
      addLog(`⚠️ ${reporter} 下发失败`);
    }
  }

  // ── 主循环 ──
  let tick = 0;
  while (true) {
    const byReporter = collectReports();

    for (const [reporter, cracks] of Object.entries(byReporter)) {
      await dispatchTasks(reporter, cracks);
    }

    // 每 30 秒重绘一次面板
    tick++;
    if (tick % 3 === 0) drawDashboard();

    await ns.sleep(10000);
  }
}
