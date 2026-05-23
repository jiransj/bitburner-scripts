/**
 * dark-stockspread.js — 极限刷 XP（全股票并行版）
 *
 * 一次向助手传入全部股票，Promise.all 并行推广。
 * N 支股票 = N 倍 XP/轮，等待时间不变。
 *
 * 用法:
 *   run dark-stockspread.js              推广全部 33 支
 *   run dark-stockspread.js AAPL GOOGL   指定部分
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const HOST = ns.getHostname();
  const HELPER = "/Temp/_promote.js";
  const ALL_STOCKS = [
    "ECP","MGCP","BLD","CLRK","OMTK","FSIG","KGI","FLCM","STM",
    "DCOMM","HLS","VITA","ICRS","UNV","AERO","OMN","SLRS","GPH",
    "NVMD","WDS","LXO","RHOC","APHE","SYSC","CTK","NTLK","OMGA",
    "FNS","JGN","SGC","CTYS","MDYN","TITN",
  ];

  const symbols = ns.args.filter(a => typeof a === "string" && !a.startsWith("--"));
  if (symbols.length === 0) symbols.push(...ALL_STOCKS);

  // 助手脚本 — Promise.all 并行
  if (!ns.fileExists(HELPER)) {
    ns.write(HELPER,
      `export async function main(ns) { await Promise.all(ns.args.map(s=>ns.dnet.promoteStock(s))); }`, "w");
  }
  await ns.sleep(20);

  const ramPer = ns.getScriptRam(HELPER, HOST);
  ns.print(`[${HOST}] 助手 ${ramPer}GB/线程 | ${symbols.length} 支并行 | 目标 X${symbols.length}/轮`);

  while (true) {
    const free = ns.getServerMaxRam(HOST) - ns.getServerUsedRam(HOST);
    const threads = Math.max(1, Math.floor(free / ramPer));

    const pid = ns.run(HELPER, threads, ...symbols);
    if (pid === 0) { await ns.sleep(50); continue; }
    while (ns.isRunning(pid)) await ns.sleep(50);
  }
}
