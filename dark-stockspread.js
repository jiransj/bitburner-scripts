/**
 * dark-stockspread.js — 暗网股票推广器
 *
 * 通过 RAM-dodging 调用 ns.dnet.promoteStock(sym) 增加波动率。
 * 自动从 stockmaster.js 的输出文件读取持仓股票，也可手动指定。
 *
 * RAM 占用: ~0.1 GB（主脚本），2 GB 由临时脚本临时承担。
 *
 * 用法:
 *   run dark-stockspread.js              自动联动 stockmaster.js
 *   run dark-stockspread.js AAPL GOOGL   手动指定
 *
 * @param {NS} ns
 */
import { getNsDataThroughFile } from './helpers.js';

export async function main(ns) {
  const HOST = ns.getHostname();
  const STOCK_DATA_FILE = "/Temp/stock-probabilities.txt";

  // 获取要推广的股票列表
  let symbols = ns.args.filter(a => typeof a === "string" && !a.startsWith("--"));

  if (symbols.length === 0) {
    // 未指定参数 → 从 stockmaster.js 输出文件读取持仓
    if (ns.fileExists(STOCK_DATA_FILE)) {
      try {
        const raw = JSON.parse(ns.read(STOCK_DATA_FILE));
        for (const [sym, data] of Object.entries(raw)) {
          if (data.sharesLong > 0 || data.sharesShort > 0) {
            symbols.push(sym);
          }
        }
      } catch {}
    }
  }

  if (symbols.length === 0) {
    ns.print(`[${HOST}] ❌ 无持仓股票，退出`);
    return;
  }

  ns.print(`[${HOST}] 📢 promoteStock: ${symbols.join(", ")}`);

  // RAM-dodging: 通过临时脚本调用 promoteStock，主脚本只需 ~0.1 GB
  while (true) {
    for (const sym of symbols) {
      try {
        await getNsDataThroughFile(ns,
          `ns.dnet.promoteStock(ns.args[0])`,
          `/Temp/dark-stockspread-${HOST.replace(/[^a-zA-Z0-9]/g, "_")}.txt`,
          [sym]);
      } catch {
        // promoteStock 内部处理节流，无需额外 sleep
      }
    }
  }
}
