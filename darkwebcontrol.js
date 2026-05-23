/**
 * darkwebcontrol.js — 暗网控制中枢 v2.0
 *
 * 运行在 home 上，负责：
 *   1. 部署 dnet-worm.js 到 darkweb 并启动
 *   2. 收集蠕虫回报，对需要分析的服务器进行密码破解分析
 *   3. 向指定节点下发指令（connectToSession + scp）
 *
 * 密码分析算法集中在此，蠕虫保持轻量。
 *
 * @param {NS} ns
 */
import { formatNumber } from './helpers.js';

export async function main(ns) {
  const WORM_SCRIPT = ns.args.includes("--worm")
    ? ns.args[ns.args.indexOf("--worm") + 1]
    : "dnet-worm.js";
  const REPORT_BASE = "/Temp/dnet-worm-";

  ns.disableLog('ALL');
  ns.ui.openTail();
  ns.clearLog();
  ns.ui.resizeTail(580, 460);

  const stats = { totalCracked: 0, totalNodes: 0, dispatched: 0, failed: 0, analyzed: 0, startTime: Date.now() };
  const recentLog = [];
  function addLog(msg) { recentLog.push(msg); if (recentLog.length > 8) recentLog.shift(); }

  // ========== 密码分析引擎 ==========

  const COMMON_PASSWORDS = [
    "123456","password","12345678","qwerty","123456789","12345","1234","111111",
    "1234567","dragon","123123","baseball","abc123","football","monkey","letmein",
    "696969","shadow","master","666666","qwertyuiop","123321","mustang","1234567890",
    "michael","654321","superman","1qaz2wsx","7777777","121212","0","qazwsx",
    "123qwe","trustno1","jordan","jennifer","zxcvbnm","asdfgh","hunter","buster",
    "soccer","harley","batman","andrew","tigger","sunshine","iloveyou","2000",
    "charlie","robert","thomas","hockey","ranger","daniel","starwars","112233",
    "george","computer","michelle","jessica","pepper","1111","zxcvbn","555555",
    "11111111","131313","freedom","777777","pass","maggie","159753","aaaaaa",
    "ginger","princess","joshua","cheese","amanda","summer","love","ashley",
    "6969","nicole","chelsea","biteme","matthew","access","yankees","987654321",
    "dallas","austin","thunder","taylor","matrix","admin","0000","fido","spot",
    "rover","max",
  ];

  const DEFAULT_PASSWORDS = ["admin","password","0000","12345"];
  const DOG_NAMES = ["fido","spot","rover","max","buddy","bella","charlie","luna"];

  /** 生成字符串的所有不重复排列 */
  function getUniquePermutations(str) {
    if (str.length <= 1) return [str];
    const result = [];
    const seen = new Set();
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (seen.has(ch)) continue;
      seen.add(ch);
      const rest = str.slice(0, i) + str.slice(i + 1);
      for (const sub of getUniquePermutations(rest)) result.push(ch + sub);
    }
    return result;
  }

  /** 罗马数字转十进制 */
  function romanToDecimal(roman) {
    const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let total = 0, prev = 0;
    for (let i = roman.length - 1; i >= 0; i--) {
      const cur = map[roman[i].toUpperCase()] || 0;
      if (cur < prev) total -= cur; else total += cur;
      prev = cur;
    }
    return total;
  }

  /** 根据服务器信息生成密码候选列表 */
  function getCandidates(details) {
    const hint = ((details.hint || details.passwordHint) || "").toLowerCase();
    const format = details.format || details.passwordFormat || "";
    const pwLen = details.length || details.passwordLength || -1;

    // --- NoPassword ---
    if (hint.includes("no password") || hint.includes("not set") || hint.includes("empty") ||
        hint.includes("did i set") || hint.includes("didn't set")) {
      return { type: "NoPassword", candidates: [""] };
    }

    // --- DefaultPassword ---
    if (hint.includes("default") || hint.includes("factory") || hint.includes("never changed") ||
        hint.includes("still the")) {
      return { type: "DefaultPassword", candidates: DEFAULT_PASSWORDS };
    }

    // --- EchoVuln ---
    if ((hint.includes("the password is") || hint.includes("the pin is") || hint.includes("the key is") ||
         hint.includes("it's set to") || hint.includes("remember to use") || hint.includes("the secret is")) &&
        format === "numeric") {
      // EchoVuln 密码是纯数字 1-3 位
      return { type: "EchoVuln", candidates: [] }; // 不需要候选, 下面直接处理
    }

    // --- DogNames ---
    if (hint.includes("dog") || hint.includes("fido") || hint.includes("spot") || hint.includes("rover")) {
      return { type: "DogNames", candidates: DOG_NAMES };
    }

    // --- Captcha ---
    if (hint.includes("captcha") || hint.includes("human")) {
      const raw = details.data || "";
      if (raw) {
        const filtered = raw.replace(/[^0-9]/g, "");
        if (filtered && filtered.length <= 15) return { type: "Captcha", candidates: [filtered] };
      }
    }

    // --- GuessNumber ---
    if (hint.includes("number between") || hint.includes("guess")) {
      return { type: "GuessNumber", candidates: [] };
    }

    // --- SortedEchoVuln ---
    if (hint.includes("shuffled") || hint.includes("sorted") || hint.includes("accidentally sorted") ||
        hint.includes("made from")) {
      let sortedStr = (details.data || "").trim();
      if (!sortedStr) {
        const words = hint.split(" ");
        const last = words[words.length - 1].replace(/[^a-zA-Z0-9]/g, "");
        if (last && /^\d+$/.test(last)) sortedStr = last;
      }
      if (sortedStr && /^\d+$/.test(sortedStr)) sortedStr = Number(sortedStr).toString();
      if (sortedStr && sortedStr.length >= 1 && sortedStr.length <= 6) {
        return { type: "SortedEcho", candidates: getUniquePermutations(sortedStr) };
      }
    }

    // --- Yesn't ---
    if (hint.includes("you are one who") || hint.includes("who's'nt")) {
      return { type: "Yesn't", candidates: [] };
    }

    // --- BufferOverflow ---
    if (hint.includes("buffer is") || hint.includes("password buffer")) {
      return { type: "BufferOverflow", candidates: [] };
    }

    // --- RomanNumeral ---
    if (hint.includes("roman") || hint.includes("numeral") || hint.includes("value of the number")) {
      const data = details.data || "";
      if (data) {
        for (const part of data.split(",")) {
          const trimmed = part.trim();
          if (/^[IVXLCDMivxlcdm]+$/.test(trimmed)) {
            const decoded = romanToDecimal(trimmed);
            if (decoded > 0) return { type: "RomanNumeral", candidates: [decoded.toString()] };
          }
        }
      }
    }

    // --- BinaryEncoded ---
    if (hint.includes("beep") || hint.includes("boop") || hint.includes("binary")) {
      const data = details.data || "";
      if (data && data.includes(" ")) {
        const chars = data.split(" ").map(b => String.fromCharCode(parseInt(b, 2))).join("");
        if (chars && chars.length <= 15) return { type: "BinaryEncoded", candidates: [chars] };
      }
    }

    // --- 通用字典 ---
    return { type: "Dictionary", candidates: COMMON_PASSWORDS };
  }

  /** 筛选候选: 按格式 + 长度 */
  function filterCandidates(candidates, format, pwLen) {
    if (format === "numeric") candidates = candidates.filter(c => /^\d+$/.test(c));
    else if (format === "alphabetic") candidates = candidates.filter(c => /^[a-zA-Z]+$/.test(c));
    else if (format === "alphanumeric") candidates = candidates.filter(c => /^[a-zA-Z0-9]+$/.test(c));
    if (pwLen > 0) candidates = candidates.filter(c => c.length === pwLen);
    return candidates;
  }

  // ========== 指令生成 ==========

  function buildTasks(cracks) {
    const tasks = [];
    for (const c of cracks) {
      if (c.password !== undefined && c.password !== null) {
        tasks.push({ op: "authenticate", host: c.host, password: c.password });
        tasks.push({ op: "freeMemory", host: c.host });
      }
    }
    return tasks;
  }

  /** 分析一个需要破解的服务器, 返回 { password, type } 或 null */
  function analyzeTarget(details) {
    const { type, candidates: rawCandidates } = getCandidates(details);
    const format = details.format || details.passwordFormat || "";
    const pwLen = details.length || details.passwordLength || -1;

    // 特殊处理: EchoVuln 从 hint 提取最后一个数字
    if (type === "EchoVuln") {
      const hint = ((details.hint || "") + " " + (details.data || "")).toLowerCase();
      const words = hint.split(" ");
      const last = words[words.length - 1].replace(/[^0-9]/g, "");
      if (last && /^\d+$/.test(last) && last.length <= 3) {
        return { password: last, type: "EchoVuln" };
      }
      return null;
    }

    // GuessNumber: 二分法需要远程执行, 返回范围让 worm 做
    // 但我们直接生成范围候选
    if (type === "GuessNumber") {
      const maxMatch = hint.match(/between\s+\d+\s+and\s+(\d+)/i);
      if (maxMatch) {
        const maxVal = parseInt(maxMatch[1]);
        if (maxVal <= 1000) {
          const candidates = [];
          for (let i = 0; i < maxVal; i++) candidates.push(String(i));
          const filtered = filterCandidates(candidates, format, pwLen);
          return { password: null, candidates: filtered, type: "GuessNumber_binary" };
        }
      }
      return null;
    }

    // Yesn't: 需要逐字符试探, 无法单次返回
    if (type === "Yesn't") {
      return { password: null, needYesn: true, type: "Yesn't" };
    }

    // BufferOverflow: 直接计算密码
    if (type === "BufferOverflow") {
      const bufMatch = hint.match(/buffer is (\d+)/i);
      if (bufMatch) {
        const bufLen = parseInt(bufMatch[1]);
        return { password: "■".repeat(2 * bufLen), type: "BufferOverflow" };
      }
      return null;
    }

    // 其他类型: 在候选列表中逐个尝试 (通过 worm)
    let candidates = rawCandidates;
    if (candidates.length === 0) return null;
    candidates = filterCandidates(candidates, format, pwLen);
    if (candidates.length === 0) return null;

    return { password: null, candidates, type };
  }

  // ========== 收集 + 下发 ==========

  function collectCrackReports() {
    const byReporter = {};
    for (const f of ns.ls("home").filter(f => f.startsWith(REPORT_BASE + "crack-"))) {
      try {
        const r = JSON.parse(ns.read(f));
        const rep = r.reporter || "unknown";
        if (!byReporter[rep]) byReporter[rep] = [];
        byReporter[rep].push(r);
        stats.totalCracked++;
        if (r.host && r.host !== rep) stats.totalNodes++;
        ns.rm(f);
      } catch (e) { ns.rm(f); }
    }
    return byReporter;
  }

  function collectNeedReports() {
    const needs = [];
    for (const f of ns.ls("home").filter(f => f.startsWith(REPORT_BASE + "need-"))) {
      try {
        needs.push(JSON.parse(ns.read(f)));
        ns.rm(f);
      } catch (e) { ns.rm(f); }
    }
    return needs;
  }

  async function dispatchTo(reporter, tasks) {
    if (tasks.length === 0) return;
    try {
      // 尝试用已知密码建立会话
      // 从之前收到的 crack 回报中找 reporter 的密码
      const knownReports = collectCrackReports();
      const cracksForReporter = knownReports[reporter] || [];
      const selfPwd = cracksForReporter.find(c => c.host === reporter)?.password;
      if (selfPwd) await ns.dnet.connectToSession(reporter, selfPwd);

      const safeName = reporter.replace(/[^a-zA-Z0-9]/g, "_");
      const cmdFile = REPORT_BASE + "cmd-" + safeName + ".txt";
      ns.write(cmdFile, JSON.stringify({ tasks }), "w");
      await ns.scp(cmdFile, reporter);
      ns.rm(cmdFile);
      stats.dispatched++;
      addLog(`→ ${reporter}: ${tasks.map(t => t.op + ":" + t.host).join(" ")}`);
    } catch (e) {
      stats.failed++;
      addLog(`⚠️ ${reporter} 下发失败`);
    }
  }

  async function handleAnalysis(need) {
    const analysis = analyzeTarget(need);
    if (!analysis) {
      addLog(`⚠️ ${need.host}: 无法分析`);
      return;
    }

    stats.analyzed++;

    // 有直接密码
    if (analysis.password !== null) {
      addLog(`🔑 ${need.host}: ${analysis.type} = "${analysis.password}"`);
      await dispatchTo(need.reporter, [
        { op: "authenticate", host: need.host, password: analysis.password },
        { op: "freeMemory", host: need.host },
      ]);
      return;
    }

    // 有候选列表 → 逐一发给 worm 尝试
    if (analysis.candidates && analysis.candidates.length > 0) {
      addLog(`🔑 ${need.host}: ${analysis.type} (${analysis.candidates.length}候选)`);
      // 分批发送, 每批最多 10 个
      for (let i = 0; i < analysis.candidates.length; i += 10) {
        const batch = analysis.candidates.slice(i, i + 10);
        await dispatchTo(need.reporter, batch.map(pwd => ({
          op: "authenticate", host: need.host, password: pwd,
        })));
      }
      return;
    }

    // Yesn't 类型 → 需要逐字符探测
    if (analysis.needYesn) {
      const pwLen = need.length || 0;
      if (pwLen <= 0) { addLog(`⚠️ ${need.host}: Yesn't 未知长度`); return; }
      addLog(`🔑 ${need.host}: Yesn't 逐字符探测 len=${pwLen}`);
      const charset = "0123456789";
      for (const ch of charset) {
        await dispatchTo(need.reporter, [{ op: "authenticate", host: need.host, password: ch.repeat(pwLen) }]);
      }
      return;
    }
  }

  // ========== 部署 + 主循环 ==========

  ns.print("🚀 部署蠕虫到 darkweb...");
  if (!ns.fileExists(WORM_SCRIPT, "home")) { ns.tprint(`❌ ${WORM_SCRIPT} 不存在`); return; }
  await ns.scp(WORM_SCRIPT, "darkweb");
  const wormPid = ns.exec(WORM_SCRIPT, "darkweb", 1, "--controller", "home");
  addLog(wormPid > 0 ? `蠕虫启动 PID=${wormPid}` : "⚠️ 蠕虫启动失败");
  drawDashboard();

  function drawDashboard() {
    ns.clearLog();
    const s = Math.floor((Date.now() - stats.startTime) / 1000);
    ns.print("╔══════════════════════════════════════════════════╗");
    ns.print("║       暗网控制中枢 v2.0                         ║");
    ns.print("╠══════════════════════════════════════════════════╣");
    ns.print(`║  运行: ${formatNumber(s)}s  破解: ${stats.totalCracked}  分析: ${stats.analyzed}`);
    ns.print(`║  节点: ${stats.totalNodes}  调度: ${stats.dispatched}  失败: ${stats.failed}`);
    ns.print("╠══════════════════════════════════════════════════╣");
    ns.print("║  最近活动:                                       ");
    for (const m of recentLog) ns.print(`║  ${m}`);
    ns.print("╚══════════════════════════════════════════════════╝");
  }

  let tick = 0;
  while (true) {
    // 1. 处理需要分析的报告
    const needs = collectNeedReports();
    for (const need of needs) await handleAnalysis(need);

    // 2. 处理普通破解回报
    const crackReports = collectCrackReports();
    for (const [reporter, cracks] of Object.entries(crackReports)) {
      const tasks = buildTasks(cracks);
      if (tasks.length > 0) await dispatchTo(reporter, tasks);
    }

    tick++;
    if (tick % 3 === 0) drawDashboard();
    await ns.sleep(5000);
  }
}
