/**
 * dark-stockspread.js — 最快刷 XP
 *
 * 一次性把所有空闲内存给一个助手实例（多线程），
 * promoteStock XP 与线程数线性正比，等待时间不变。
 * 跑完立即下一轮，零浪费。
 *
 * 用法:
 *   run dark-stockspread.js AAPL GOOGL
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const HOST = ns.getHostname();
  const HELPER = "/Temp/_promote.js";

  const symbols = ns.args.filter(a => typeof a === "string" && !a.startsWith("--"));
  if (symbols.length === 0) { ns.print(`用法: run dark-stockspread.js AAPL`); return; }

  // 写助手脚本（一次性）
  if (!ns.fileExists(HELPER)) {
    ns.write(HELPER,
      `export async function main(ns) { await ns.dnet.promoteStock(ns.args[0]); }`, "w");
  }
  await ns.sleep(20); // 等文件写入

  const ramPerThread = ns.getScriptRam(HELPER, HOST);
  ns.print(`[${HOST}] 助手 ${ramPerThread}GB/线程 | 推广 ${symbols.join(",")}`);

  let idx = 0;
  while (true) {
    const free = ns.getServerMaxRam(HOST) - ns.getServerUsedRam(HOST);
    const threads = Math.max(1, Math.floor(free / ramPerThread));
    const sym = symbols[idx++ % symbols.length];

    const pid = ns.run(HELPER, threads, sym);
    if (pid === 0) { await ns.sleep(50); continue; }

    // 等这个实例跑完（包含 promoteStock 内部延迟）
    while (ns.isRunning(pid)) await ns.sleep(50);
    // 立刻下一轮，零间隙
  }
}
