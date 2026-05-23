/**
 * dark-stockspread.js — 暗网股票推广器
 *
 * 只做一件事：反复调用暗网推广股票 API (ns.dnet.stockSpread)
 * 不买入不卖出，仅推广用户持有的股票。
 *
 * 用法:
 *   run dark-stockspread.js <symbol1> <symbol2> ...
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const HOST = ns.getHostname();
  const TICK_MS = 60000;

  // 从参数获取要推广的股票
  const symbols = ns.args.filter(a => typeof a === "string" && !a.startsWith("--"));

  if (symbols.length === 0) {
    ns.print(`[${HOST}] ❌ 未指定股票符号`);
    return;
  }

  ns.print(`[${HOST}] 📢 dark-stockspread 启动，推广 ${symbols.join(", ")}`);

  while (true) {
    for (const sym of symbols) {
      try {
        const r = await ns.dnet.stockSpread(sym);
        ns.print(`[${HOST}] ${sym}: ${r.success ? "✅" : "❌"} ${r.message || ""}`);
      } catch (e) {
        ns.print(`[${HOST}] ${sym}: ⚠️ ${e}`);
      }
      await ns.sleep(100);
    }
    await ns.sleep(TICK_MS - symbols.length * 100);
  }
}
