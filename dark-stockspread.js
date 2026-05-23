/**
 * dark-stockspread.js — 暗网股票推广器（并行刷经验版）
 *
 * 写入一个临时助手脚本，然后用 ns.run() 并行启动多个实例。
 * 每个实例独立调用 promoteStock，独立获得魅力经验。
 * 不 await，占满内存就跑满。
 *
 * RAM: 主脚本 ~0.1 GB + 每个助手实例 2 GB（临时承担）
 *
 * 用法:
 *   run dark-stockspread.js             自动联动 stockmaster.js
 *   run dark-stockspread.js AAPL GOOGL  手动指定
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const HOST = ns.getHostname();
  const HELPER = "/Temp/_promote.js";
  const STOCK_FILE = "/Temp/stock-probabilities.txt";

  // ---- 获取股票列表 ----
  let symbols = ns.args.filter(a => typeof a === "string" && !a.startsWith("--"));
  if (symbols.length === 0) {
    if (ns.fileExists(STOCK_FILE)) {
      try {
        const raw = JSON.parse(ns.read(STOCK_FILE));
        for (const [sym, d] of Object.entries(raw)) {
          if (d.sharesLong > 0 || d.sharesShort > 0) symbols.push(sym);
        }
      } catch {}
    }
  }
  if (symbols.length === 0) { ns.print(`[${HOST}] ❌ 无股票`); return; }

  // ---- 写入助手脚本（只需写一次） ----
  if (!ns.fileExists(HELPER)) {
    ns.write(HELPER,
      `export async function main(ns) { await ns.dnet.promoteStock(ns.args[0]); }`, "w");
  }

  const helperRam = ns.getScriptRam(HELPER, HOST);
  ns.print(`[${HOST}] 📢 promote ${symbols.join(",")} | 助手 ${helperRam}GB`);

  // ---- 并行喷射循环 ----
  // 每轮启动尽可能多的实例占满空闲内存
  let idx = 0;
  while (true) {
    const free = ns.getServerMaxRam(HOST) - ns.getServerUsedRam(HOST);
    const maxBatch = Math.max(1, Math.floor(free / helperRam));
    let launched = 0;

    for (let i = 0; i < maxBatch; i++) {
      const sym = symbols[idx % symbols.length];
      idx++;
      const pid = ns.run(HELPER, 1, sym);
      if (pid > 0) launched++;
      else break; // 内存满了
    }

    if (launched === 0) {
      // 一个都跑不动 → 等一会再试
      await ns.sleep(100);
    }
    // 不 await 实例，让它们在后台并行跑
    // 每 1s 刷新一轮喷射
    await ns.sleep(1000);
  }
}
