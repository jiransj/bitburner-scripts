/**
 * dnet-watch.js — 暗网监视器 v1.0
 *
 * 暗网服务器上每个服务器只开 1 份。
 * 负责：
 *   1. 探测邻居，管理 dnet-worm.js 生命周期
 *   2. 将 dnet-worm.js + openCache.js + stockmaster.js SCP 到目标
 *   3. 在目标被破解后执行 ns.dnet.memoryReallocation()
 *   4. 管理 openCache.js 生命周期
 *   5. 全部邻居被感染时杀死所有 dnet-worm.js
 *   6. 发现新未感染邻居时复活 dnet-worm.js
 *   7. 文件清理 (rm) 
 *   8. 向 darkwebcontrol.js 报告状态
 *
 * 由 darkwebcontrol.js 部署到 darkweb 并启动。
 * dnet-watch.js 启动后，会按需启动/停止 dnet-worm.js。
 *
 * RAM: ~3.5 GB
 *
 * 用法:
 *   run dnet-watch.js
 *
 * @param {NS} ns
 */
export async function main(ns) {
  // ======================== 配置 ========================
  const MY_HOST = ns.getHostname();
  const WORM_SCRIPT = "dnet-worm.js";
  const OPENCACHE_SCRIPT = "openCache.js";
  const STOCKMASTER_SCRIPT = "stockmaster.js";
  const DARK_STOCK_SCRIPT = "dark-stockspread.js";
  const REPORT_BASE = "/Temp/dnet-worm-";
  const INFECTED_FILE = "/Temp/dnet-worm-infected.txt";
  const CHECK_INTERVAL_MS = 2000;
  const MAX_CONCURRENT_CRACKS = 3; // 最多同时破解 3 个

  // ======================== 持久化状态 ========================
  let infectedSet = new Set();
  try {
    const raw = ns.read(INFECTED_FILE);
    if (raw) JSON.parse(raw).forEach((h) => infectedSet.add(h));
  } catch { /* 首次 */ }

  function saveInfected() {
    ns.write(INFECTED_FILE, JSON.stringify([...infectedSet]), "w");
  }

  // 本机标记
  if (!infectedSet.has(MY_HOST)) {
    infectedSet.add(MY_HOST);
    saveInfected();
    ns.print(`[${MY_HOST}] 本机标记为已感染`);
  }

  // 启动时清理本服务器上所有残留的旧版 dnet-worm.js（v2.0 含有已废弃的 API）
  (function cleanupOldWorms() {
    let killed = 0;
    for (const p of ns.ps(MY_HOST)) {
      if (p.filename === WORM_SCRIPT) {
        if (ns.kill(p.pid)) killed++;
      }
    }
    if (killed > 0) {
      ns.tprint(`🧹 [${MY_HOST}] 启动清理: 已杀掉 ${killed} 个旧版 worm 进程`);
    }
  })();

  // ======================== 报告机制 ========================

  /** 向控制中枢发送各类报告（写本地 + SCP 到 home，中枢才能读到） */
  async function reportToController(type, data) {
    try {
      const safeName = MY_HOST.replace(/[^a-zA-Z0-9]/g, "_");
      const reportFile = REPORT_BASE + type + "-" + safeName + ".txt";
      ns.write(reportFile, JSON.stringify(data), "w");
      // ⚠️ SCP 到 home！否则中枢在 home 上读不到
      await ns.scp(reportFile, "home");
    } catch (e) {
      ns.print(`[${MY_HOST}] 报告失败: ${e}`);
    }
  }

  /** 报告状态（心跳） */
  async function reportStatus(neighbors, allInfected) {
    const wormRunning = ns.ps(MY_HOST).some((p) => p.filename === WORM_SCRIPT);
    await reportToController("status", {
      host: MY_HOST,
      infectedCount: infectedSet.size,
      neighborCount: neighbors.length,
      allInfected,
      wormRunning,
      openCacheRunning: ns.isRunning(OPENCACHE_SCRIPT, MY_HOST),
      timestamp: Date.now(),
    });
  }

  // ======================== 控制中枢指令 ========================

  async function checkControllerCommands() {
    const safeName = MY_HOST.replace(/[^a-zA-Z0-9]/g, "_");
    const cmdFile = REPORT_BASE + "cmd-" + safeName + ".txt";
    if (!ns.fileExists(cmdFile)) return false;
    try {
      const raw = ns.read(cmdFile);
      ns.rm(cmdFile); // ← 放在 watch 中
      const cmd = JSON.parse(raw);
      if (!cmd.tasks || !Array.isArray(cmd.tasks)) return false;
      ns.print(`[${MY_HOST}] 收到 ${cmd.tasks.length} 条控制指令`);
      for (const task of cmd.tasks) {
        switch (task.op) {
          case "authenticate":
            if (task.password !== undefined && task.password !== null) {
              try {
                const r = await ns.dnet.authenticate(task.host, task.password);
                if (r && r.success) {
                  ns.tprint(`✅ [${MY_HOST}] 指令破解 ${task.host}`);
                  infectedSet.add(task.host);
                  saveInfected();
                  await reportToController("crack", {
                    reporter: MY_HOST, host: task.host,
                    password: task.password, type: "controller",
                  });
                }
              } catch (e) { ns.print(`[${MY_HOST}] 指令 authenticate 失败: ${e}`); }
            }
            break;
          case "freeMemory":
            // memoryReallocation 现在由 watch 负责
            try {
              await ns.dnet.memoryReallocation(task.host);
              ns.print(`[${MY_HOST}] 指令 freeMemory ${task.host} 完成`);
            } catch (e) { ns.print(`[${MY_HOST}] 指令 freeMemory 失败: ${e}`); }
            break;
          case "exec":
            if (task.script && ns.fileExists(task.script, MY_HOST)) {
              const target = task.target || MY_HOST;
              if (target !== MY_HOST) {
                try { await ns.scp(task.script, target); } catch {}
              }
              const pid = ns.exec(task.script, target, 1);
              if (pid > 0) ns.print(`[${MY_HOST}] 已执行 ${task.script} (PID=${pid})`);
            }
            break;
        }
        await ns.sleep(100);
      }
      return true;
    } catch (e) {
      ns.print(`[${MY_HOST}] 指令解析失败: ${e}`);
      return false;
    }
  }

  // ======================== SCP 传播（移入 watch） ========================

  /** 将 worm + 辅助脚本复制到目标服务器 */
  async function copyScriptsTo(host) {
    const scripts = [ns.getScriptName(), WORM_SCRIPT, OPENCACHE_SCRIPT, STOCKMASTER_SCRIPT, DARK_STOCK_SCRIPT];
    let allOk = true;
    for (const script of scripts) {
      try {
        if (ns.fileExists(script, MY_HOST)) {
          const ok = await ns.scp(script, host);
          if (ok) ns.print(`[${MY_HOST}] ${host}: ${script} 已复制`);
          else { ns.print(`[${MY_HOST}] ${host}: ${script} 复制失败`); allOk = false; }
        }
      } catch (e) {
        ns.print(`[${MY_HOST}] ${host}: 复制 ${script} 异常: ${e}`);
        allOk = false;
      }
    }
    return allOk;
  }

  // ======================== memoryReallocation（移入 watch） ========================

  /** 释放目标服务器的被占用内存 */
  async function freeMemory(host) {
    try {
      const details = ns.dnet.getServerDetails(host);
      if (!details.isOnline) return false;
      if (details.blockedRam <= 0) {
        ns.print(`[${MY_HOST}] ${host}: 无被占用内存`);
        return true;
      }
      ns.print(`[${MY_HOST}] ${host}: 释放 ${ns.format.ram(details.blockedRam)} 阻塞内存...`);
      let attempts = 0;
      while (attempts < 20) {
        const r = await ns.dnet.memoryReallocation(host);
        if (r && r.success) {
          await ns.sleep(100);
          const nd = ns.dnet.getServerDetails(host);
          if (nd.blockedRam <= 0) {
            ns.tprint(`✅ [${MY_HOST}] ${host}: 内存全部释放完毕`);
            return true;
          }
          ns.print(`[${MY_HOST}] ${host}: 剩余阻塞 ${ns.format.ram(nd.blockedRam)}`);
        } else {
          ns.print(`[${MY_HOST}] ${host}: 释放失败: ${r?.message || "未知"}`);
          return false;
        }
        attempts++;
      }
      return true;
    } catch (e) {
      ns.print(`[${MY_HOST}] ${host}: 释放异常 - ${e}`);
      return false;
    }
  }

  // ======================== 缓存管理器（移入 watch） ========================

  async function manageCacheWatcher() {
    let cacheFiles = [];
    try {
      cacheFiles = ns.ls(MY_HOST).filter((f) => f.endsWith(".cache") || f.endsWith(".d.cache"));
    } catch { return; }
    const has = cacheFiles.length > 0;
    const running = ns.isRunning(OPENCACHE_SCRIPT, MY_HOST);
    if (has && !running) {
      const pid = ns.exec(OPENCACHE_SCRIPT, MY_HOST, 1, "--watch");
      if (pid > 0) ns.tprint(`🎯 [${MY_HOST}] openCache.js 已启动 (PID=${pid})`);
    } else if (!has && running) {
      const killed = ns.kill(OPENCACHE_SCRIPT, MY_HOST);
      if (killed) ns.tprint(`🛑 [${MY_HOST}] openCache.js 已杀掉`);
    }
  }

  // ======================== Worm 生命周期管理 ========================

  /** 检测目标服务器上是否已运行 dnet-watch.js */
  function isWatchRunningOn(host) {
    try {
      return ns.ps(host).some((p) => p.filename === ns.getScriptName());
    } catch {
      return false; // 无法获取进程列表（无会话），视为未运行
    }
  }

  /** 检测是否有 dnet-worm.js 正在运行 */
  function isWormRunning() {
    return ns.ps(MY_HOST).some((p) => p.filename === WORM_SCRIPT);
  }

  /** 杀死本服务器上的所有 dnet-worm.js */
  function killAllWorms() {
    let count = 0;
    for (const p of ns.ps(MY_HOST)) {
      if (p.filename === WORM_SCRIPT) {
        if (ns.kill(p.pid)) count++;
      }
    }
    if (count > 0) ns.print(`[${MY_HOST}] 已杀死 ${count} 个 worm 进程`);
    return count;
  }

  /**
   * 向 darkwebcontrol.js 报告"需要破解"某个邻居
   * dnet-watch.js 不再直接唤起 dnet-worm.js，改由中枢统一调度
   */
  async function reportCrackNeed(host, details) {
    const safeTarget = host.replace(/[^a-zA-Z0-9]/g, "_");
    const reportFile = REPORT_BASE + "need-crack-" + safeTarget + ".txt";
    try {
      ns.write(reportFile, JSON.stringify({
        reporter: MY_HOST,
        host: host,
        isOnline: details.isOnline,
        hasSession: details.hasSession,
        maxRam: ns.getServerMaxRam(host),
        usedRam: ns.getServerUsedRam(host),
        passwordHint: details.passwordHint || details.staticPasswordHint || "",
        passwordFormat: details.passwordFormat || "",
        passwordLength: details.passwordLength || -1,
        data: details.data || "",
        timestamp: Date.now(),
      }), "w");
      // ⚠️ SCP 到 home！否则中枢读不到 need-crack 请求
      await ns.scp(reportFile, "home");
      ns.print(`[${MY_HOST}] → home: 请求破解 ${host}`);
    } catch (e) {
      ns.print(`[${MY_HOST}] 发送破解请求失败: ${e}`);
    }
  }

  /** 在目标服务器上部署并启动 dnet-watch.js */
  async function deployWatchTo(host, password) {
    const watchScript = ns.getScriptName();

    // 暗网操作前必须建立会话连接
    // ⚠️ worm 退出后其 PID 的会话已销毁，connectToSession 不可靠
    //    直接用 authenticate 重新认证，给当前脚本(PID)建立新会话
    if (password && password !== "已存在会话") {
      try {
        await ns.dnet.authenticate(host, password);
        ns.print(`[${MY_HOST}] ${host}: 认证成功`);
      } catch (e) {
        ns.print(`[${MY_HOST}] ${host}: 认证失败: ${e}，尝试 connectToSession`);
        try { await ns.dnet.connectToSession(host, password); } catch {}
      }
    }

    // 复制脚本到目标（尽量复制，即使部分失败也尝试启动 watch）
    const copyOk = await copyScriptsTo(host);
    if (!copyOk) {
      ns.print(`[${MY_HOST}] ${host}: 部分脚本复制失败，仍尝试启动 watch`);
      // 不 return false — 主脚本（watch自身）可能已存在
    }

    // 检查目标上是否有 watch 文件 + 足够 RAM
    let watchRam = 0;
    try { watchRam = ns.getScriptRam(watchScript, host); } catch {}
    const hostAvail = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);

    if (watchRam <= 0) {
      ns.print(`[${MY_HOST}] ${host}: watch 脚本未成功复制到目标，无法启动`);
      return false;
    }
    if (hostAvail < watchRam) {
      ns.print(`[${MY_HOST}] ${host}: RAM不足(${ns.format.ram(hostAvail)} < ${ns.format.ram(watchRam)})，无法部署 watch`);
      return false;
    }

    // 启动 watch
    const pid = ns.exec(watchScript, host, 1);
    if (pid > 0) {
      ns.tprint(`🚀 [${MY_HOST}] → ${host}: dnet-watch.js 已启动 (PID=${pid})`);
      infectedSet.add(host);
      saveInfected();
      return true;
    } else {
      ns.print(`[${MY_HOST}] ${host}: dnet-watch.js 启动失败`);
      return false;
    }
  }

  // ======================== 密码分析引擎（从 darkwebcontrol.js 移植） ========================

  const CRACK_COMMON_PASSWORDS = [
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
    "dallas","austin","thunder","taylor","matrix","admin","0000","fido","spot","rover","max",
  ];
  const CRACK_DEFAULT = ["admin","password","0000","12345"];
  const CRACK_DOGS = ["fido","spot","rover","max","buddy","bella","charlie","luna"];

  function crackGetPermutations(str) {
    if (str.length <= 1) return [str];
    const r = []; const seen = new Set();
    for (let i = 0; i < str.length; i++) {
      const ch = str[i]; if (seen.has(ch)) continue; seen.add(ch);
      const rest = str.slice(0, i) + str.slice(i + 1);
      for (const sub of crackGetPermutations(rest)) r.push(ch + sub);
    }
    return r;
  }
  function crackRoman(s) {
    const m = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let t = 0, p = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      const c = m[s[i].toUpperCase()] || 0;
      if (c < p) t -= c; else t += c; p = c;
    }
    return t;
  }
  function crackGetCandidates(details) {
    const hint = ((details.hint || details.passwordHint) || "").toLowerCase();
    const format = details.format || details.passwordFormat || "";
    const pwLen = details.length || details.passwordLength || -1;
    if (hint.includes("no password") || hint.includes("not set") || hint.includes("empty") ||
        hint.includes("did i set") || hint.includes("didn't set"))
      return { type: "NoPassword", candidates: [""] };
    if (hint.includes("default") || hint.includes("factory") || hint.includes("never changed") || hint.includes("still the"))
      return { type: "DefaultPassword", candidates: CRACK_DEFAULT };
    if ((hint.includes("the password is") || hint.includes("the pin is") || hint.includes("the key is") ||
         hint.includes("it's set to") || hint.includes("remember to use") || hint.includes("the secret is")) && format === "numeric") {
      const words = hint.split(" "); const last = words[words.length-1].replace(/[^0-9]/g,"");
      if (last && /^\d+$/.test(last) && last.length <= 3) return { type: "EchoVuln", candidates: [] };
    }
    if (hint.includes("dog") || hint.includes("fido") || hint.includes("spot") || hint.includes("rover"))
      return { type: "DogNames", candidates: CRACK_DOGS };
    if (hint.includes("captcha") || hint.includes("human")) {
      const raw = (details.data || "").replace(/[^0-9]/g,"");
      if (raw && raw.length <= 15) return { type: "Captcha", candidates: [raw] };
    }
    if (hint.includes("number between") || hint.includes("guess")) return { type: "GuessNumber", candidates: [] };
    if (hint.includes("shuffled") || hint.includes("sorted") || hint.includes("accidentally sorted") || hint.includes("made from")) {
      let s = (details.data || "").trim();
      if (!s) { const w = hint.split(" "); const l = w[w.length-1].replace(/[^a-zA-Z0-9]/g,""); if (l && /^\d+$/.test(l)) s = l; }
      if (s && /^\d+$/.test(s)) s = Number(s).toString();
      if (s && s.length >= 1 && s.length <= 6) return { type: "SortedEcho", candidates: crackGetPermutations(s) };
    }
    if (hint.includes("you are one who") || hint.includes("who's'nt")) return { type: "Yesn't", candidates: [] };
    if (hint.includes("buffer is") || hint.includes("password buffer")) return { type: "BufferOverflow", candidates: [] };
    if (hint.includes("roman") || hint.includes("numeral") || hint.includes("value of the number")) {
      const data = details.data || "";
      if (data) for (const part of data.split(",")) {
        const t = part.trim(); if (/^[IVXLCDMivxlcdm]+$/.test(t)) { const d = crackRoman(t); if (d > 0) return { type: "RomanNumeral", candidates: [d.toString()] }; }
      }
    }
    if (hint.includes("beep") || hint.includes("boop") || hint.includes("binary")) {
      const data = details.data || "";
      if (data && data.includes(" ")) { const c = data.split(" ").map(b => String.fromCharCode(parseInt(b,2))).join(""); if (c && c.length <= 15) return { type: "BinaryEncoded", candidates: [c] }; }
    }
    if (format === "numeric" && pwLen > 0 && pwLen <= 6 && (hint.includes("master") || hint.includes("match exactly") || hint.includes("wrong place")))
      return { type: "MasterMind", candidates: [] };
    return { type: "Dictionary", candidates: CRACK_COMMON_PASSWORDS };
  }
  function crackFilterCandidates(candidates, format, pwLen) {
    if (format === "numeric") candidates = candidates.filter(c => /^\d+$/.test(c));
    else if (format === "alphabetic") candidates = candidates.filter(c => /^[a-zA-Z]+$/.test(c));
    else if (format === "alphanumeric") candidates = candidates.filter(c => /^[a-zA-Z0-9]+$/.test(c));
    if (pwLen > 0) candidates = candidates.filter(c => c.length === pwLen);
    return candidates;
  }
  function crackAnalyzeTarget(details) {
    const { type, candidates: raw } = crackGetCandidates(details);
    const format = details.format || details.passwordFormat || "";
    const pwLen = details.length || details.passwordLength || -1;
    if (type === "EchoVuln") {
      const hint = ((details.hint || "") + " " + (details.data || "")).toLowerCase();
      const last = hint.split(" ").pop().replace(/[^0-9]/g,"");
      if (last && /^\d+$/.test(last) && last.length <= 3) return { password: last, type: "EchoVuln" };
      return null;
    }
    if (type === "GuessNumber") {
      const guessHint = ((details.hint || "") + " " + (details.data || "")).toLowerCase();
      const mm = guessHint.match(/between\s+\d+\s+and\s+(\d+)/i);
      if (mm) { const mv = parseInt(mm[1]); if (mv <= 1000) { const c = []; for (let i=0;i<mv;i++) c.push(String(i)); return { password: null, candidates: crackFilterCandidates(c,format,pwLen), type: "GuessNumber_binary" }; } }
      return null;
    }
    if (type === "Yesn't") return { password: null, needYesn: true, type: "Yesn't" };
    if (type === "BufferOverflow") {
      const bufHint = ((details.hint || "") + " " + (details.data || "")).toLowerCase();
      const bm = bufHint.match(/buffer is (\d+)/i);
      if (bm) return { password: "■".repeat(2*parseInt(bm[1])), type: "BufferOverflow" };
      return null;
    }
    if (type === "MasterMind") return { password: null, needMasterMind: true, type: "MasterMind" };
    let candidates = raw; if (candidates.length === 0) return null;
    candidates = crackFilterCandidates(candidates, format, pwLen);
    if (candidates.length === 0) return null;
    return { password: null, candidates, type };
  }

  // ======================== 指令下发（向其它 watch 发命令） ========================

  const knownPasswords = {};

  async function dispatchTo(reporter, tasks) {
    if (tasks.length === 0) return;
    try {
      const pwd = knownPasswords[reporter];
      if (pwd) { try { await ns.dnet.connectToSession(reporter, pwd); } catch {} }
      const safeName = reporter.replace(/[^a-zA-Z0-9]/g, "_");
      const cmdFile = REPORT_BASE + "cmd-" + safeName + ".txt";
      ns.write(cmdFile, JSON.stringify({ tasks }), "w");
      await ns.scp(cmdFile, reporter);
      ns.rm(cmdFile);
      ns.print(`[${MY_HOST}] → ${reporter}: 指令已下发`);
    } catch (e) {
      ns.print(`[${MY_HOST}] 下发指令失败 ${reporter}: ${e}`);
    }
  }

  // ======================== 异步破译队列 ========================

  const pendingCracks = new Map(); // target → { pid, safeTarget }

  /** 检查已完成的后台 worm，处理结果 */
  async function processCompletedCracks() {
    const done = [];
    for (const [target, info] of pendingCracks) {
      if (!ns.isRunning(info.pid)) done.push([target, info]);
    }
    for (const [target, info] of done) {
      pendingCracks.delete(target);
      const { safeTarget } = info;
      const resultFile = "/Temp/dnet-worm-crack-result-" + safeTarget + ".txt";
      if (!ns.fileExists(resultFile)) {
        ns.print(`[${MY_HOST}] ${target}: worm 无结果文件`);
        continue;
      }
      try {
        const result = JSON.parse(ns.read(resultFile));
        ns.rm(resultFile);
        if (!result.success) {
          ns.print(`[${MY_HOST}] ${target}: 破解失败`);
          if (result.needAnalysis && result.details) {
            // 本地分析
            const analysis = crackAnalyzeTarget(result.details);
            if (analysis && analysis.password !== null) {
              ns.print(`[${MY_HOST}] ${target}: 本地分析出密码 ${analysis.password}`);
              await dispatchTo(MY_HOST, [
                { op: "authenticate", host: target, password: analysis.password },
                { op: "freeMemory", host: target },
              ]);
            } else if (analysis && analysis.candidates && analysis.candidates.length > 0) {
              ns.print(`[${MY_HOST}] ${target}: 本地分析 ${analysis.candidates.length} 候选`);
              await dispatchTo(MY_HOST,
                analysis.candidates.map(p => ({ op: "authenticate", host: target, password: p }))
              );
            }
          }
          continue;
        }
        ns.tprint(`✅ [${MY_HOST}] ${target} 破解成功! 密码=${result.password} (${result.type})`);
        // 缓存密码
        knownPasswords[target] = result.password;
        // 释放内存 + 部署 watch
        await freeMemory(target);
        await deployWatchTo(target, result.password);
      } catch (e) {
        ns.print(`[${MY_HOST}] ${target}: 结果处理异常: ${e}`);
      }
    }
  }

  /** 启动新的破译任务（exec worm on MY_HOST） */
  function startNewCrack(host) {
    if (pendingCracks.has(host)) return;
    if (pendingCracks.size >= MAX_CONCURRENT_CRACKS) return; // 并发限制
    const safeTarget = host.replace(/[^a-zA-Z0-9]/g, "_");
    const resultFile = "/Temp/dnet-worm-crack-result-" + safeTarget + ".txt";
    if (ns.fileExists(resultFile)) ns.rm(resultFile);
    const scriptRam = ns.getScriptRam(WORM_SCRIPT, MY_HOST);
    const availRam = ns.getServerMaxRam(MY_HOST) - ns.getServerUsedRam(MY_HOST);
    const threads = Math.max(1, Math.floor(availRam / scriptRam));
    if (threads < 1) { ns.print(`[${MY_HOST}] ${host}: RAM 不足`); return; }
    const pid = ns.exec(WORM_SCRIPT, MY_HOST, threads, "--target-only", host);
    if (pid > 0) {
      pendingCracks.set(host, { pid, safeTarget, startTime: Date.now() });
      ns.print(`[${MY_HOST}] 🔧 worm ${host} (PID=${pid})`);
    } else {
      ns.print(`[${MY_HOST}] ${host}: worm 启动失败`);
    }
  }

  // ======================== 主循环 ========================

  ns.tprint(`🔭 [${MY_HOST}] dnet-watch.js v2.0 启动，每 ${CHECK_INTERVAL_MS / 1000}s 扫描一次`);

  let allInfectedCount = 0;

  while (true) {
    try {
      // 阶段 0: 处理控制中枢指令
      await checkControllerCommands();

      // 阶段 1: 管理 openCache.js
      await manageCacheWatcher();

      // 阶段 2: 探测邻居
      let neighbors = [];
      try {
        neighbors = ns.dnet.probe() || [];
      } catch (e) {
        if (String(e).includes("not a darknet server")) {
          ns.tprint(`❌ [${MY_HOST}] 本机不是暗网服务器`);
          return;
        }
        await ns.sleep(5000);
        continue;
      }

      ns.print(`[${MY_HOST}] 探测到 ${neighbors.length} 个邻居`);

      // 阶段 3: 对每个邻居执行检测 + 部署三步流程
      // API 说明：在暗网服务器上，ns.dnet.* 系列可用，ns.ps(host) 不可用，
      // ns.isRunning(script,host) 在有会话时可用，无会话时抛异常。
      // 因此三步流程使用 try-catch 逐层降级：
      let deployedCount = 0;
      for (const host of neighbors) {
        if (host === MY_HOST) continue;

        // ---- 第 1 步：获取服务器详情 ----
        let d;
        try {
          d = ns.dnet.getServerDetails(host);
        } catch (e) {
          ns.print(`[${MY_HOST}] ${host}: getServerDetails 失败: ${e}`);
          continue;
        }
        if (!d.isOnline) {
          ns.print(`[${MY_HOST}] ${host}: 离线，跳过`);
          continue;
        }

        // ---- 第 2 步：尝试检测 watch（有会话时才能成功） ----
        let watchAlive = false;
        if (d.hasSession) {
          try {
            watchAlive = ns.isRunning(ns.getScriptName(), host);
          } catch {
            // ns.isRunning 在有会话时不应该抛异常，如果抛了降级
            watchAlive = false;
          }
        }

        if (watchAlive) {
          if (!infectedSet.has(host)) { infectedSet.add(host); saveInfected(); }
          ns.print(`[${MY_HOST}] ${host}: watch ✓`);
          continue;
        }

        // ---- 第 3 步：无 watch，根据会话状态决策 ----
        if (d.hasSession) {
          // 有会话 → 直接部署
          ns.print(`[${MY_HOST}] ${host}: 有会话，部署 watch`);
          try { if (await deployWatchTo(host, "已存在会话")) deployedCount++; }
          catch (e) { ns.print(`[${MY_HOST}] ${host}: 部署异常: ${e}`); }
        } else {
          // 无会话 → 加入本地异步破译队列
          ns.print(`[${MY_HOST}] ${host}: 无会话，加入破译队列`);
          startNewCrack(host);
        }
      }

      // 阶段 3b: 处理已完成的破译任务
      await processCompletedCracks();

      // 阶段 4: 检测全部邻居是否均已部署 watch
      const allHaveWatch = neighbors.every((h) => {
        if (h === MY_HOST) return true;
        try {
          const dd = ns.dnet.getServerDetails(h);
          if (!dd.isOnline || !dd.hasSession) return false;
          return ns.isRunning(ns.getScriptName(), h);
        } catch { return false; }
      });

      if (allHaveWatch) {
        allInfectedCount++;
        ns.print(`[${MY_HOST}] 所有邻居均有 watch (连续 ${allInfectedCount} 次)`);

        // 连续确认后，才杀掉 worm（未全部攻克前保留 worm 用于继续破解）
        if (allInfectedCount >= 2) {
          const killed = killAllWorms();
          if (killed > 0) {
            ns.tprint(`🏁 [${MY_HOST}] 全部攻克，worm 已休眠`);
          }
        }
      } else {
        allInfectedCount = 0;
      }

      // 阶段 4b: 管理 dark-stockspread.js（全部攻克→启动，新目标出现→杀掉）
      const stockRunning = ns.isRunning(DARK_STOCK_SCRIPT, MY_HOST);
      if (allHaveWatch && allInfectedCount >= 2 && !stockRunning) {
        // 全部攻克 + 连续确认 → 启动股票推广器，占满空闲内存
        const stockRam = ns.getScriptRam(DARK_STOCK_SCRIPT, MY_HOST);
        const freeRam = ns.getServerMaxRam(MY_HOST) - ns.getServerUsedRam(MY_HOST);
        const threads = Math.max(1, Math.floor(freeRam / stockRam));
        const pid = ns.exec(DARK_STOCK_SCRIPT, MY_HOST, threads);
        if (pid > 0) ns.tprint(`📈 [${MY_HOST}] dark-stockspread.js 已启动 (PID=${pid}, ${threads}线程)`);
      } else if (!allHaveWatch && stockRunning) {
        // 出现新未攻克目标 → 杀掉推广器，释放内存给破解
        ns.kill(DARK_STOCK_SCRIPT, MY_HOST);
        ns.tprint(`🛑 [${MY_HOST}] dark-stockspread.js 已杀掉，释放内存用于破解`);
      }

      // 阶段 5: 报告状态
      await reportStatus(neighbors, allHaveWatch);
    } catch (e) {
      ns.print(`[${MY_HOST}] ⚠️ 主循环异常: ${e}`);
      // 不崩溃，继续下一轮
    }

    await ns.sleep(CHECK_INTERVAL_MS);
  }
}

export function autocomplete(data, args) {
  return data.servers;
}
