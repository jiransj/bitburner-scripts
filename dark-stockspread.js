/**
 * dark-stockspread.js — 暗网股票推广器
 *
 * 反复调用 ns.dnet.promoteStock(sym) 增加股票波动率。
 * 不买入不卖出。API 自身根据魅力控制调用节奏（80ms~8s）。
 *
 * 用法:
 *   run dark-stockspread.js AAPL GOOGL
 *   run dark-stockspread.js --all    自动检测持仓
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const HOST = ns.getHostname();
  let symbols = [];

  if (ns.args.includes("--all")) {
    try {
      const all = ns.stock.getSymbols();
      for (const sym of all) {
        const pos = ns.stock.getPosition(sym);
        if (pos[0] + pos[2] > 0) symbols.push(sym);
      }
    } catch {
      ns.print(`[${HOST}] ⚠️ 无法获取持仓`);
      return;
    }
  } else {
    symbols = ns.args.filter(a => typeof a === "string" && !a.startsWith("--"));
  }

  if (symbols.length === 0) {
    ns.print(`[${HOST}] ❌ 未指定股票`);
    return;
  }

  ns.print(`[${HOST}] 📢 promoteStock 启动: ${symbols.join(", ")}`);

  // 最优策略：连续循环调用，API 自身控制等待时间
  while (true) {
    for (const sym of symbols) {
      try {
        const r = await ns.dnet.promoteStock(sym);
        if (r && r.success === false) {
          ns.print(`[${HOST}] ${sym}: ❌ ${r.message || ""}`);
        }
      } catch (e) {
        // API 内部已处理节流，无需额外 sleep
        ns.print(`[${HOST}] ${sym}: ⚠️ ${e}`);
      }
    }
  }
}
