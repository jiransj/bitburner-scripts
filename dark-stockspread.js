/**
 * dark-stockspread.js — 极限刷 XP（多实例分片版）
 *
 * Bitburner 不允许单脚本并发 Netscript 调用（Promise.all 不适用）。
 * 改为：将股票分片，每片启动一个独立助手实例，多实例并行跑。
 * 每个助手内部串行 promoteStock，但多实例间真正并行。
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

  let symbols = ns.args.filter(a => typeof a === "string" && !a.startsWith("--"));
  if (symbols.length === 0) symbols = [...ALL_STOCKS];

  // 助手脚本 — 顺序循环（Netscript 禁止并发调用）
  if (!ns.fileExists(HELPER)) {
    ns.write(HELPER,
      `export async function main(ns) { for(const s of ns.args) await ns.dnet.promoteStock(s); }`, "w");
  }
  await ns.sleep(20);

  const ramPer = ns.getScriptRam(HELPER, HOST);
  ns.print(`[${HOST}] 助手 ${ramPer}GB/线程 | ${symbols.length} 支`);

  // 计算最大并行实例数
  while (true) {
    const free = ns.getServerMaxRam(HOST) - ns.getServerUsedRam(HOST);
    const maxInstances = Math.max(1, Math.floor(free / ramPer));

    // 股票分片，每片给一个实例
    const batchSize = Math.ceil(symbols.length / maxInstances);
    const pids = [];
    for (let i = 0; i < maxInstances && i * batchSize < symbols.length; i++) {
      const batch = symbols.slice(i * batchSize, (i + 1) * batchSize);
      const pid = ns.run(HELPER, 1, ...batch);
      if (pid > 0) pids.push(pid);
    }

    // 等所有实例跑完再启动下一轮
    while (pids.some(p => ns.isRunning(p))) await ns.sleep(50);
  }
}
