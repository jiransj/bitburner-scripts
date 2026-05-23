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
  const WATCH_SCRIPT = ns.args.includes("--watch")
    ? ns.args[ns.args.indexOf("--watch") + 1]
    : "dnet-watch.js";
  const WORM_SCRIPT = "dnet-worm.js";
  const REPORT_BASE = "/Temp/dnet-worm-";
  const OPENCACHE_SCRIPT = "openCache.js";
  const STOCKMASTER_SCRIPT = "stockmaster.js";

  ns.disableLog('ALL');
  ns.ui.openTail();
  ns.clearLog();
  ns.ui.resizeTail(580, 460);

  const stats = { totalCracked: 0, totalNodes: 0, dispatched: 0, failed: 0, analyzed: 0, startTime: Date.now() };
  const cacheStats = { opened: 0, totalFiles: 0, activeNodes: 0 };
  const wormStatus = {}; // host → { hopCount, infectedCount, allInfected, openCacheRunning, lastSeen }
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

    // --- MasterMind（Bulls and Cows）---
    if (format === "numeric" && pwLen > 0 && pwLen <= 6 &&
        (hint.includes("master") || hint.includes("match exactly") || hint.includes("wrong place"))) {
      return { type: "MasterMind", candidates: [] };
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
      const guessHint = ((details.hint || "") + " " + (details.data || "")).toLowerCase();
      const maxMatch = guessHint.match(/between\s+\d+\s+and\s+(\d+)/i);
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
      const bufHint = ((details.hint || "") + " " + (details.data || "")).toLowerCase();
      const bufMatch = bufHint.match(/buffer is (\d+)/i);
      if (bufMatch) {
        const bufLen = parseInt(bufMatch[1]);
        return { password: "■".repeat(2 * bufLen), type: "BufferOverflow" };
      }
      return null;
    }

    // MasterMind: 需要逐位探测+排列，指示 worm 做
    if (type === "MasterMind") {
      return { password: null, needMasterMind: true, type: "MasterMind" };
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

  // 缓存已知密码（reporter → password），避免重复读文件
  const knownPasswords = {};

  async function dispatchTo(reporter, tasks, reporterPassword) {
    if (tasks.length === 0) return;
    try {
      // 建立会话
      const pwd = reporterPassword || knownPasswords[reporter];
      if (pwd) {
        try { await ns.dnet.connectToSession(reporter, pwd); } catch {}
      }

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

    // 有候选列表 → 合并为一条指令发给 worm（worm 会顺序尝试）
    if (analysis.candidates && analysis.candidates.length > 0) {
      addLog(`🔑 ${need.host}: ${analysis.type} (${analysis.candidates.length}候选)`);
      await dispatchTo(need.reporter,
        analysis.candidates.map(pwd => ({ op: "authenticate", host: need.host, password: pwd }))
      );
      return;
    }

    // MasterMind 类型 → worm 已有算法，发个信号让它重试
    if (analysis.needMasterMind) {
      addLog(`🔑 ${need.host}: MasterMind 需要逐位探测，指示 worm 处理`);
      // worm 的 --target-only 模式内置 MasterMind 算法，它会在下轮重试时处理
      return;
    }

    // Yesn't 类型 → 逐字符探测
    if (analysis.needYesn) {
      const pwLen = need.length || 0;
      if (pwLen <= 0) { addLog(`⚠️ ${need.host}: Yesn't 未知长度`); return; }
      addLog(`🔑 ${need.host}: Yesn't 逐字符探测 len=${pwLen}`);
      const charset = "0123456789";
      await dispatchTo(need.reporter,
        [...charset].map(ch => ({ op: "authenticate", host: need.host, password: ch.repeat(pwLen) }))
      );
      return;
    }
  }

  // ========== 部署 + 主循环 ==========

  let watchPid = 0;
  async function ensureWatch() {
    if (!ns.fileExists(WATCH_SCRIPT, "home")) return false;
    // 检查 watch 是否存活
    const running = ns.isRunning(watchPid);
    if (running) return true;
    // 先杀掉 darkweb 上残留的旧版 dnet-worm.js（避免 REMOVED FUNCTION 错误）
    try {
      for (const p of ns.ps("darkweb")) {
        if (p.filename === WORM_SCRIPT) ns.kill(p.pid);
      }
    } catch {}
    // 重新部署：把所有脚本都复制到 darkweb
    const scripts = [WATCH_SCRIPT, WORM_SCRIPT, OPENCACHE_SCRIPT, STOCKMASTER_SCRIPT];
    for (const script of scripts) {
      if (ns.fileExists(script, "home")) {
        try { await ns.scp(script, "darkweb"); } catch (e) {
          addLog(`⚠️ SCP ${script} 失败: ${e}`);
        }
      }
    }
    // 启动 dnet-watch.js（而非 worm）
    watchPid = ns.exec(WATCH_SCRIPT, "darkweb", 1);
    addLog(watchPid > 0 ? `🟢 监视器启动 PID=${watchPid}` : "⚠️ 监视器启动失败");
    return watchPid > 0;
  }
  await ensureWatch();
  drawDashboard();

  function drawDashboard() {
    ns.clearLog();
    const s = Math.floor((Date.now() - stats.startTime) / 1000);
    // 计算活跃蠕虫数
    const now = Date.now();
    const activeWorms = Object.entries(wormStatus).filter(([, st]) => (now - st.lastSeen) < 60000).length;
    const primaryHost = Object.entries(wormStatus).find(([, st]) => st.allInfected)?.[0] || (wormStatus ? Object.keys(wormStatus)[0] : "等待中...");

    ns.print("╔══════════════════════════════════════════════════╗");
    ns.print("║       暗网控制中枢 v2.0                         ║");
    ns.print("╠══════════════════════════════════════════════════╣");
    ns.print(`║  运行: ${formatNumber(s)}s  破解: ${stats.totalCracked}  分析: ${stats.analyzed}`);
    ns.print(`║  节点: ${stats.totalNodes}  调度: ${stats.dispatched}  失败: ${stats.failed}`);
    ns.print(`║  🎁缓存: ${cacheStats.opened}/${cacheStats.totalFiles}  活跃蠕虫: ${activeWorms}`);
    ns.print(`║  主监视: ${primaryHost}`);
    ns.print("╠══════════════════════════════════════════════════╣");
    ns.print("║  最近活动:                                       ");
    for (const m of recentLog) ns.print(`║  ${m}`);
    ns.print("╚══════════════════════════════════════════════════╝");
  }

  let tick = 0;
  while (true) {
    // 0. 确保监视器存活（darkweb 重建时会杀死旧进程）
    await ensureWatch();

    // 1. 采集并处理蠕虫状态报告
    for (const f of ns.ls("home").filter(f => f.startsWith(REPORT_BASE + "status-"))) {
      try {
        const r = JSON.parse(ns.read(f));
        ns.rm(f);
        if (r.host) {
          wormStatus[r.host] = {
            hopCount: r.hopCount ?? 0,
            infectedCount: r.infectedCount ?? 0,
            allInfected: r.allInfected ?? false,
            openCacheRunning: r.openCacheRunning ?? false,
            lastSeen: r.timestamp || Date.now(),
          };
        }
      } catch (e) { ns.rm(f); }
    }

    // 2. 处理缓存报告
    for (const f of ns.ls("home").filter(f => f.startsWith(REPORT_BASE + "cache-"))) {
      try {
        const r = JSON.parse(ns.read(f));
        ns.rm(f);
        cacheStats.opened += r.opened || 0;
        cacheStats.totalFiles += r.total || 0;
        if (r.host) cacheStats.activeNodes++;
        addLog(`🎁 ${r.host}: 打开 ${r.opened}/${r.total} 缓存`);
      } catch (e) { ns.rm(f); }
    }

    // 3. 清理 openCache 状态文件
    for (const f of ns.ls("home").filter(f =>
      f.startsWith(REPORT_BASE + "openCache-") || f.startsWith(REPORT_BASE + "cache-idle-")
    )) {
      try { ns.rm(f); } catch {}
    }

    // 4. 处理来自 dnet-watch.js 的"需要破解"请求（新流程：watch 不直接调 worm）
    for (const f of ns.ls("home").filter(f => f.startsWith(REPORT_BASE + "need-crack-"))) {
      try {
        const need = JSON.parse(ns.read(f));
        ns.rm(f);
        const target = need.host;
        if (!target) continue;
        addLog(`🔧 ${need.reporter} 请求破解 ${target}`);

        // 确保 worm 脚本在 darkweb 上存在
        if (!ns.fileExists(WORM_SCRIPT, "darkweb")) {
          if (ns.fileExists(WORM_SCRIPT, "home")) {
            await ns.scp(WORM_SCRIPT, "darkweb");
          } else {
            addLog(`⚠️ ${WORM_SCRIPT} 不存在，跳过`);
            continue;
          }
        }

        // 在 darkweb 上执行 worm 破解目标
        const safeTarget = target.replace(/[^a-zA-Z0-9]/g, "_");
        const resultFileOnDarkweb = "/Temp/dnet-worm-crack-result-" + safeTarget + ".txt";
        const resultFileOnHome = "/Temp/dnet-worm-crack-result-" + safeTarget + ".txt";

        // 清除旧结果文件
        if (ns.fileExists(resultFileOnHome)) ns.rm(resultFileOnHome);

        const pid = ns.exec(WORM_SCRIPT, "darkweb", 1, "--target-only", target);
        if (pid <= 0) { addLog(`⚠️ worm 启动失败 ${target}`); continue; }

        // 等待 worm 完成（最多 2 分钟）
        let waited = 0;
        while (waited < 120000) {
          await ns.sleep(200);
          waited += 200;
          if (!ns.isRunning(pid)) break;
        }
        if (ns.isRunning(pid)) { ns.kill(pid); addLog(`⏰ worm 超时 ${target}`); continue; }

        // SCP 结果文件从 darkweb 到 home
        try {
          await ns.scp(resultFileOnDarkweb, "home", "darkweb");
        } catch (e) {
          addLog(`⚠️ 结果文件 SCP 失败 ${target}: ${e}`);
          continue;
        }

        if (!ns.fileExists(resultFileOnHome)) { addLog(`⚠️ 无结果文件 ${target}`); continue; }

        const result = JSON.parse(ns.read(resultFileOnHome));
        ns.rm(resultFileOnHome);

        if (!result.success) {
          addLog(`❌ ${target}: 破解失败`);
          if (result.needAnalysis && result.details) {
            // 转发给分析引擎
            const needFile = REPORT_BASE + "need-" + safeTarget + ".txt";
            ns.write(needFile, JSON.stringify({
              reporter: need.reporter, host: target,
              hint: result.details.passwordHint || "",
              data: result.details.data || "",
              format: result.details.passwordFormat || "",
              length: result.details.passwordLength || -1,
            }), "w");
          }
          continue;
        }

        // 破解成功！
        addLog(`✅ ${target}: 破解成功! 密码=${result.password} (${result.type})`);
        stats.totalCracked++;
        if (target) stats.totalNodes++;

        // 通知 watch 释放内存 + 部署 dnet-watch.js
        // 先让 watch 执行 freeMemory + exec watch
        const watchTasks = [
          { op: "freeMemory", host: target },
          { op: "exec", script: "dnet-watch.js", target: target },
        ];
        // 获取 watch 所在服务器的密码（从之前缓存的或 need 中）
        const reporterPwd = knownPasswords[need.reporter];
        await dispatchTo(need.reporter, watchTasks, reporterPwd);

        // 写入 crack 报告以便统计
        const crackFile = REPORT_BASE + "crack-controller-" + safeTarget + ".txt";
        try { ns.write(crackFile, JSON.stringify({
          reporter: "controller", host: target,
          password: result.password, type: result.type,
        }), "w"); } catch {}
      } catch (e) {
        addLog(`⚠️ need-crack 处理异常: ${e}`);
      }
    }

    // 5. 处理需要分析的报告
    for (const need of collectNeedReports()) await handleAnalysis(need);

    // 6. 处理普通破解回报，同时收集密码缓存
    for (const f of ns.ls("home").filter(f => f.startsWith(REPORT_BASE + "crack-"))) {
      try {
        const r = JSON.parse(ns.read(f));
        ns.rm(f);
        // 缓存 reporter 的密码
        if (r.reporter && r.password) knownPasswords[r.reporter] = r.password;
        if (r.host && r.host !== r.reporter) {
          // 非自身回报 → 让 reporter 执行后续操作
          const tasks = [
            { op: "authenticate", host: r.host, password: r.password || "" },
            { op: "freeMemory", host: r.host },
          ];
          await dispatchTo(r.reporter, tasks, knownPasswords[r.reporter]);
        }
        stats.totalCracked++;
        if (r.host) stats.totalNodes++;
        addLog(`✅ ${r.reporter||'?'} 破解 ${r.host} (${r.type||'?'})`);
      } catch (e) { ns.rm(f); }
    }

    tick++;
    if (tick % 6 === 0) drawDashboard();
    await ns.sleep(5000);
  }
}
