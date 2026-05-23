/**
 * dark-stockspread.js — 最快刷 XP（多股并行版）
 *
 * 助手脚本用 Promise.all 同时推广多支股票。
 * 每一轮等待时间 = max(8000×600/(600+cha), 200)ms，
 * 但 N 支股票同时等，一轮拿 N 份 XP。
 *
 * 用法:
 *   run dark-stockspread.js AAPL GOOGL MSFT
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const HOST = ns.getHostname();
  const HELPER = "/Temp/_promote.js";

  const symbols = ns.args.filter(a => typeof a === "string" && !a.startsWith("--"));
  if (symbols.length === 0) { ns.print(`用法: run dark-stockspread.js AAPL GOOGL`); return; }

  // 写助手脚本 — Promise.all 并行推广所有传入的股票
  if (!ns.fileExists(HELPER)) {
    ns.write(HELPER,
      `export async function main(ns) { await Promise.all(ns.args.map(s=>ns.dnet.promoteStock(s))); }`, "w");
  }
  await ns.sleep(20);

  const ramPerThread = ns.getScriptRam(HELPER, HOST);
  ns.print(`[${HOST}] 助手 ${ramPerThread}GB/线程 | 批量推广 ${symbols.join(",")}`);

  while (true) {
    const free = ns.getServerMaxRam(HOST) - ns.getServerUsedRam(HOST);
    const threads = Math.max(1, Math.floor(free / ramPerThread));

    // 把所有股票符号一次传给助手，内部 Promise.all 并行
    const pid = ns.run(HELPER, threads, ...symbols);
    if (pid === 0) { await ns.sleep(50); continue; }

    while (ns.isRunning(pid)) await ns.sleep(50);
    // 一轮跑完，立即下一轮
  }
}
