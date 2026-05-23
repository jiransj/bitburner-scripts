/**
 * dark-stockspread.js — 暗网股票推广器
 *
 * 在暗网服务器空闲时运行，反复"推广"用户持有的股票。
 * 不买入不卖出，仅占用空闲内存执行推广循环。
 * 当需要破解新目标时，dnet-watch.js 会直接 kill 本脚本释放内存。
 *
 * 用法:
 *   run dark-stockspread.js <symbol1> <symbol2> ...
 *   run dark-stockspread.js --all   自动检测持仓股票
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const HOST = ns.getHostname();
  const TICK_MS = 60000; // 每 60 秒一个推广周期

  // 获取要推广的股票列表
  let symbols = [];
  if (ns.args.includes("--all")) {
    // 自动检测持仓（需要 TIX API）
    try {
      const allSyms = ns.stock.getSymbols();
      for (const sym of allSyms) {
        const pos = ns.stock.getPosition(sym);
        const shares = pos[0] + pos[2]; // long shares + short shares
        if (shares > 0) symbols.push(sym);
      }
    } catch {
      ns.print(`[${HOST}] ⚠️ 无法获取持仓信息`);
      return;
    }
  } else {
    // 从参数获取
    for (const arg of ns.args) {
      if (typeof arg === "string" && !arg.startsWith("--")) {
        symbols.push(arg);
      }
    }
  }

  if (symbols.length === 0) {
    ns.print(`[${HOST}] ❌ 没有指定要推广的股票`);
    return;
  }

  ns.print(`[${HOST}] 📢 dark-stockspread.js 启动，推广 ${symbols.length} 支股票`);
  for (const sym of symbols) {
    let price = "?";
    try { price = ns.stock.getPrice(sym); } catch {}
    ns.print(`[${HOST}]    ${sym} 当前 ${price}`);
  }

  // 推广循环：每秒执行一次推广操作
  // 可在此处插入自定义推广逻辑
  let cycle = 0;
  while (true) {
    cycle++;
    ns.print(`[${HOST}] 📢 推广周期 #${cycle} | ${symbols.join(", ")}`);

    // ==== 在此处添加推广逻辑 ====
    // 例如：发送推广交易、计算指标、上报状态等
    // 本脚本只负责循环，被杀掉时无副作用
    // ===========================

    await ns.sleep(TICK_MS);
  }
}
