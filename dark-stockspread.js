/**
 * dark-stockspread.js — 暗网股票推广器
 *
 * 反复调用 ns.dnet.promoteStock(sym) 增加股票波动率。
 * 不买入不卖出。API 自身根据魅力控制调用节奏。
 * 股票符号通过命令行参数传入，无需 getSymbols/getPosition。
 *
 * 用法:
 *   run dark-stockspread.js AAPL GOOGL MSFT
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const HOST = ns.getHostname();
  const symbols = ns.args.filter(a => typeof a === "string" && !a.startsWith("--"));

  if (symbols.length === 0) {
    ns.print(`[${HOST}] ❌ 用法: run dark-stockspread.js AAPL GOOGL`);
    return;
  }

  ns.print(`[${HOST}] 📢 promoteStock: ${symbols.join(", ")}`);

  while (true) {
    for (const sym of symbols) {
      try {
        await ns.dnet.promoteStock(sym);
      } catch (e) {
        // API 内部处理节流，无需额外 sleep
      }
    }
  }
}
