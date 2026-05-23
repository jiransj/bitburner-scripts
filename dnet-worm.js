/**
 * dnet-worm.js — 暗网蠕虫 v2.0
 *
 * 工作流程:
 *   1. 探测直接相连的暗网服务器 (ns.dnet.probe)
 *   2. 根据密码表/提示特征尝试破解 (ns.dnet.authenticate)
 *   3. 释放目标服务器被占用的内存 (ns.dnet.memoryReallocation)
 *   4. 把自身 + openCache.js + stockmaster.js 复制到目标服务器
 *   5. 在目标服务器启动自身实例 → 继续扩散
 *   6. 管理 openCache.js：有缓存时启动，无缓存时杀掉
 *   7. 向 darkwebcontrol.js 反馈破解报告和需要分析的服务器
 *   8. 所有邻居均被感染时，只保留1份全局进程
 *
 * 约束: darkweb 只有 16GB RAM, 此脚本精简至 ~2.8GB
 *
 * 用法（手动部署到任意暗网服务器后执行）:
 *   run dnet-worm.js
 *   run dnet-worm.js --max-hops 5    (限制扩散深度)
 *   run dnet-worm.js --target-only   (只处理指定目标, 不扩散)
 *
 * @param {NS} ns
 */
export async function main(ns) {
  // ======================== 配置 ========================
  const SCRIPT_NAME = ns.getScriptName();
  const MAX_HOPS = ns.args.includes("--max-hops")
    ? parseInt(ns.args[ns.args.indexOf("--max-hops") + 1])
    : 999;
  const TARGET_ONLY = ns.args.includes("--target-only");
  const TARGET_HOST = TARGET_ONLY
    ? ns.args[ns.args.indexOf("--target-only") + 1]
    : null;
  const PROPAGATE = !TARGET_ONLY; // 是否扩散

  // 辅助脚本
  const OPENCACHE_SCRIPT = "openCache.js";
  const STOCKMASTER_SCRIPT = "stockmaster.js";

  // 已知已感染的主机集（通过文件持久化，避免环路扩散）
  const INFECTED_FILE = "/Temp/dnet-worm-infected.txt";
  let infectedSet = new Set();
  try {
    const raw = ns.read(INFECTED_FILE);
    if (raw) JSON.parse(raw).forEach((h) => infectedSet.add(h));
  } catch { /* 首次运行，干净状态 */ }

  // 本机主机名
  const MY_HOST = ns.getHostname();

  // 报告文件前缀（与 darkwebcontrol.js 保持一致）
  const REPORT_BASE = "/Temp/dnet-worm-";

  // openCache.js 进程管理
  let openCachePid = 0;

  // 记录"本轮是否发现新感染"（用于判断全局感染状态）
  let foundNewInfection = false;

  // ======================== 密码字典 ========================
  const COMMON_PASSWORDS = [
    "123456", "password", "12345678", "qwerty", "123456789", "12345", "1234", "111111",
    "1234567", "dragon", "123123", "baseball", "abc123", "football", "monkey", "letmein",
    "696969", "shadow", "master", "666666", "qwertyuiop", "123321", "mustang", "1234567890",
    "michael", "654321", "superman", "1qaz2wsx", "7777777", "121212", "0", "qazwsx",
    "123qwe", "trustno1", "jordan", "jennifer", "zxcvbnm", "asdfgh", "hunter", "buster",
    "soccer", "harley", "batman", "andrew", "tigger", "sunshine", "iloveyou", "2000",
    "charlie", "robert", "thomas", "hockey", "ranger", "daniel", "starwars", "112233",
    "george", "computer", "michelle", "jessica", "pepper", "1111", "zxcvbn", "555555",
    "11111111", "131313", "freedom", "777777", "pass", "maggie", "159753", "aaaaaa",
    "ginger", "princess", "joshua", "cheese", "amanda", "summer", "love", "ashley",
    "6969", "nicole", "chelsea", "biteme", "matthew", "access", "yankees", "987654321",
    "dallas", "austin", "thunder", "taylor", "matrix", "admin", "0000", "fido", "spot",
    "rover", "max",
  ];

  const DEFAULT_PASSWORDS = ["admin", "password", "0000", "12345"];
  const DOG_NAMES = ["fido", "spot", "rover", "max", "buddy", "bella", "charlie", "luna"];

  // ======================== 工具函数 ========================

  /** 持久化已感染列表 */
  function saveInfected() {
    ns.write(INFECTED_FILE, JSON.stringify([...infectedSet]), "w");
  }

  /** 标记已感染 */
  function markInfected(host) {
    infectedSet.add(host);
    saveInfected();
  }

  // 本机标记为已感染（在第一步完成）
  if (!infectedSet.has(MY_HOST)) {
    markInfected(MY_HOST);
    ns.print(`[${MY_HOST}] 本机标记为已感染`);
  }

  // ======================== 反馈报告机制 ========================

  /** 向控制中枢报告破解成功 */
  function reportCrack(host, password, type) {
    try {
      const reportFile =
        REPORT_BASE + "crack-" + MY_HOST.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
      ns.write(
        reportFile,
        JSON.stringify({
          reporter: MY_HOST,
          host: host,
          password: password,
          type: type,
          timestamp: Date.now(),
        }),
        "w"
      );
      ns.print(`[${MY_HOST}] 已报告破解成果: ${host}`);
    } catch (e) {
      ns.print(`[${MY_HOST}] 报告失败: ${e}`);
    }
  }

  /** 向控制中枢请求密码分析 */
  function requestAnalysis(host, details) {
    try {
      const reportFile =
        REPORT_BASE + "need-" + host.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
      ns.write(
        reportFile,
        JSON.stringify({
          reporter: MY_HOST,
          host: host,
          hint: details.passwordHint || details.staticPasswordHint || "",
          data: details.data || "",
          format: details.passwordFormat || "",
          length: details.passwordLength || -1,
          timestamp: Date.now(),
        }),
        "w"
      );
      ns.print(`[${MY_HOST}] 已请求分析: ${host}`);
    } catch (e) {
      ns.print(`[${MY_HOST}] 请求分析失败: ${e}`);
    }
  }

  /** 检查控制中枢下发的指令并执行 */
  async function checkControllerCommands() {
    const safeName = MY_HOST.replace(/[^a-zA-Z0-9]/g, "_");
    const cmdFile = REPORT_BASE + "cmd-" + safeName + ".txt";

    if (!ns.fileExists(cmdFile)) return false;

    try {
      const raw = ns.read(cmdFile);
      const cmd = JSON.parse(raw);

      // 删除指令文件（防止重复执行）
      ns.rm(cmdFile);

      if (!cmd.tasks || !Array.isArray(cmd.tasks)) return false;

      ns.print(`[${MY_HOST}] 收到 ${cmd.tasks.length} 条控制指令`);

      for (const task of cmd.tasks) {
        switch (task.op) {
          case "authenticate":
            ns.print(`[${MY_HOST}] 执行指令: authenticate ${task.host} password=***`);
            if (task.password !== undefined && task.password !== null) {
              try {
                const r = await ns.dnet.authenticate(task.host, task.password);
                if (r && r.success) {
                  ns.tprint(`✅ [${MY_HOST}] 指令破解成功! ${task.host} (密码=${task.password})`);
                  markInfected(task.host);
                  reportCrack(task.host, task.password, "controller");
                }
              } catch (e) {
                ns.print(`[${MY_HOST}] 指令 authenticate 失败: ${e}`);
              }
            }
            break;

          case "freeMemory":
            ns.print(`[${MY_HOST}] 执行指令: freeMemory ${task.host}`);
            try {
              const r = await ns.dnet.memoryReallocation(task.host);
              if (r && r.success) {
                ns.print(`[${MY_HOST}] 指令 freeMemory 成功: ${task.host}`);
              }
            } catch (e) {
              ns.print(`[${MY_HOST}] 指令 freeMemory 失败: ${e}`);
            }
            break;

          case "exec":
            ns.print(`[${MY_HOST}] 执行指令: exec ${task.script} on ${task.target || MY_HOST}`);
            if (task.script && ns.fileExists(task.script, MY_HOST)) {
              const target = task.target || MY_HOST;
              // 尝试 scp 到目标
              if (target !== MY_HOST) {
                try {
                  await ns.scp(task.script, target);
                } catch (e) {
                  ns.print(`[${MY_HOST}] SCP ${task.script} 到 ${target} 失败: ${e}`);
                  break;
                }
              }
              const pid = ns.exec(task.script, target, 1);
              if (pid > 0) {
                ns.print(`[${MY_HOST}] 已执行 ${task.script} (PID=${pid})`);
              }
            }
            break;

          default:
            ns.print(`[${MY_HOST}] 未知指令: ${task.op}`);
        }
        await ns.sleep(100);
      }
      return true;
    } catch (e) {
      ns.print(`[${MY_HOST}] 指令解析失败: ${e}`);
      return false;
    }
  }

  // ======================== 密码破解引擎 ========================

  /** 根据提示特征为服务器生成密码候选列表 */
  function getCandidates(details) {
    const hint = ((details.passwordHint || details.staticPasswordHint) || "").toLowerCase();

    // --- 模式 1: NoPassword（无密码） ---
    if (hint.includes("no password") || hint.includes("not set") || hint.includes("empty") ||
        hint.includes("did i set") || hint.includes("didn't set") || hint.includes("didn't set a")) {
      return { type: "NoPassword", candidates: [""] };
    }

    // --- 模式 2: DefaultPassword（默认密码） ---
    if (hint.includes("default") || hint.includes("factory") || hint.includes("never changed") ||
        hint.includes("still the")) {
      return { type: "DefaultPassword", candidates: DEFAULT_PASSWORDS };
    }

    // --- 模式 3: EchoVuln（提示直接包含密码） ---
    if (hint.includes("the password is") || hint.includes("the pin is") || hint.includes("the key is") ||
        hint.includes("it's set to") || hint.includes("remember to use") || hint.includes("the secret is")) {
      const words = hint.split(" ");
      const lastWord = words[words.length - 1].replace(/[^a-zA-Z0-9]/g, "");
      if (lastWord && /^\d+$/.test(lastWord) && lastWord.length <= 3) {
        return { type: "EchoVuln", candidates: [lastWord] };
      }
    }

    // --- 模式 4: DogNames（狗名） ---
    if (hint.includes("dog") || hint.includes("fido") || hint.includes("spot") || hint.includes("rover")) {
      return { type: "DogNames", candidates: DOG_NAMES };
    }

    // --- 模式 5: Captcha（验证码） ---
    if (hint.includes("captcha") || hint.includes("human") || hint.includes("prove")) {
      const rawData = details.data || "";
      if (rawData) {
        const filtered = rawData.replace(/[^0-9]/g, "");
        if (filtered && filtered.length <= 15) {
          return { type: "Captcha", candidates: [filtered] };
        }
      }
    }

    // --- 模式 6: GuessNumber（猜数字） ---
    if (hint.includes("number between") || hint.includes("guess")) {
      return { type: "GuessNumber", candidates: [] };
    }

    // --- 模式 7: NIL / Yesn't（逐字符反馈） ---
    if (hint.includes("you are one who") || hint.includes("who's'nt") || hint.includes("'s'nt authorized")) {
      return { type: "Yesn't", candidates: [] };
    }

    // --- 模式 8: BufferOverflow（缓冲区溢出） ---
    if (hint.includes("password buffer") || hint.includes("buffer is")) {
      return { type: "BufferOverflow", candidates: [] };
    }

    // --- 模式 9: LargestPrimeFactor（最大质因数） ---
    if (hint.includes("largest prime factor") || hint.includes("prime factor")) {
      return { type: "PrimeFactor", candidates: COMMON_PASSWORDS };
    }

    // --- 模式 10: SortedEchoVuln（排序后的密码字符） ---
    if (hint.includes("shuffled") || hint.includes("sorted") || hint.includes("accidentally sorted") ||
        hint.includes("made from")) {
      let sortedStr = (details.data || "").trim();
      if (!sortedStr) {
        const words = hint.split(" ");
        const last = words[words.length - 1].replace(/[^a-zA-Z0-9]/g, "");
        if (last && /^\d+$/.test(last)) sortedStr = last;
      }
      if (sortedStr && /^\d+$/.test(sortedStr)) {
        sortedStr = Number(sortedStr).toString();
      }
      if (sortedStr && sortedStr.length >= 1 && sortedStr.length <= 6) {
        const perms = getUniquePermutations(sortedStr);
        ns.print(`[${MY_HOST}] SortedEcho: "${sortedStr}" → ${perms.length} 个排列待尝试`);
        return { type: "SortedEcho", candidates: perms };
      }
    }

    // --- 模式 11: 罗马数字 ---
    if (hint.includes("roman") || hint.includes("numeral") || hint.includes("value of the number")) {
      const data = details.data || "";
      if (data) {
        const parts = data.split(",");
        for (const part of parts) {
          const trimmed = part.trim();
          if (/^[IVXLCDMivxlcdm]+$/.test(trimmed)) {
            const decoded = romanToDecimal(trimmed);
            if (decoded > 0) {
              return { type: "RomanNumeral", candidates: [decoded.toString()] };
            }
          }
        }
      }
    }

    // --- 模式 12: BinaryEncoded（二进制编码） ---
    if (hint.includes("beep") || hint.includes("boop") || hint.includes("binary")) {
      const data = details.data || "";
      if (data && data.includes(" ")) {
        const parts = data.split(" ");
        const chars = parts.map((b) => String.fromCharCode(parseInt(b, 2))).join("");
        if (chars && chars.length <= 15) {
          return { type: "BinaryEncoded", candidates: [chars] };
        }
      }
    }

    // --- 通用字典模式 ---
    return { type: "Dictionary", candidates: COMMON_PASSWORDS };
  }

  /** 生成字符串的所有不重复排列（用于 SortedEchoVuln 破解） */
  function getUniquePermutations(str) {
    if (str.length <= 1) return [str];
    const result = [];
    const seen = new Set();
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (seen.has(ch)) continue;
      seen.add(ch);
      const rest = str.slice(0, i) + str.slice(i + 1);
      const subPerms = getUniquePermutations(rest);
      for (const sub of subPerms) {
        result.push(ch + sub);
      }
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

  /** 破解并解锁单个服务器 */
  async function crackServer(host) {
    let details;
    try {
      details = ns.dnet.getServerDetails(host);
    } catch (e) {
      ns.print(`[${MY_HOST}] ${host}: 无法获取详情 - ${e}`);
      return false;
    }

    if (!details.isOnline) {
      ns.print(`[${MY_HOST}] ${host}: 离线`);
      return false;
    }

    if (details.hasSession) {
      ns.print(`[${MY_HOST}] ${host}: 已有有效会话，跳过认证`);
      return true;
    }

    const { type, candidates: rawCandidates } = getCandidates(details);

    // 密码长度为0 → 空密码，直接尝试
    if (details.passwordLength === 0) {
      try {
        const r = await ns.dnet.authenticate(host, "");
        if (r.success) {
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=(空)`);
          reportCrack(host, "", "NoPassword");
          return true;
        }
      } catch (e) { /* 继续 */ }
      ns.print(`[${MY_HOST}] ${host}: 空密码尝试失败`);
      return false;
    }

    // 根据密码格式过滤无效候选
    const format = details.passwordFormat || "";
    const pwLen = details.passwordLength || -1;
    let candidates = rawCandidates;
    if (format === "numeric") {
      candidates = rawCandidates.filter((c) => /^\d+$/.test(c));
    } else if (format === "alphabetic") {
      candidates = rawCandidates.filter((c) => /^[a-zA-Z]+$/.test(c));
    } else if (format === "alphanumeric") {
      candidates = rawCandidates.filter((c) => /^[a-zA-Z0-9]+$/.test(c));
    }
    // 同时按密码长度过滤
    if (pwLen > 0) {
      candidates = candidates.filter((c) => c.length === pwLen);
    }

    ns.print(`[${MY_HOST}] ${host}: 尝试${type}(${candidates.length}/${rawCandidates.length}个候选, format=${format}, len=${pwLen}) hint="${(details.passwordHint || "").slice(0, 40)}"`);

    if (candidates.length === 0) {
      ns.print(`[${MY_HOST}] ${host}: 所有候选被过滤掉，请求控制中枢分析`);
      requestAnalysis(host, details);
      return false;
    }

    // GuessNumber 使用二分法
    if (type === "GuessNumber") {
      const hint = ((details.passwordHint || details.staticPasswordHint) || "").toLowerCase();
      const maxMatch = hint.match(/between\s+\d+\s+and\s+(\d+)/);
      let low = 0;
      let high = maxMatch ? parseInt(maxMatch[1]) - 1 : candidates.length - 1;
      if (high < 0) high = 0;
      ns.print(`[${MY_HOST}] ${host}: GuessNumber 二分法 [${low}, ${high}]`);

      let attempts = 0;
      const maxAttempts = Math.ceil(Math.log2(high - low + 1)) + 2;
      while (low <= high && attempts < maxAttempts) {
        const mid = Math.floor((low + high) / 2);
        const guess = String(mid);
        try {
          const result = await ns.dnet.authenticate(host, guess);
          if (result.success) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${guess} (二分法)`);
            reportCrack(host, guess, "GuessNumber");
            return true;
          }
          if (result.data === "Lower") {
            high = mid - 1;
          } else {
            low = mid + 1;
          }
        } catch (e) { /* 继续 */ }
        attempts++;
        await ns.sleep(50);
      }
      ns.print(`[${MY_HOST}] ${host}: 二分法失败，请求控制中枢分析`);
      requestAnalysis(host, details);
      return false;
    }

    // Yesn't: 逐字符反馈
    if (type === "Yesn't") {
      const pwLen = details.passwordLength || 0;
      if (pwLen <= 0) {
        ns.print(`[${MY_HOST}] ${host}: Yesn't 未知密码长度，请求控制中枢分析`);
        requestAnalysis(host, details);
        return false;
      }
      const charset = format === "alphabetic"
        ? "abcdefghijklmnopqrstuvwxyz"
        : format === "alphanumeric"
          ? "abcdefghijklmnopqrstuvwxyz0123456789"
          : "0123456789";
      ns.print(`[${MY_HOST}] ${host}: Yesn't 逐字符探测 len=${pwLen} charset_size=${charset.length}`);

      const password = new Array(pwLen).fill(null);
      for (const ch of charset) {
        const probe = ch.repeat(pwLen);
        try {
          const result = await ns.dnet.authenticate(host, probe);
          if (result.success) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${probe} (Yesn't)`);
            reportCrack(host, probe, "Yesn't");
            return true;
          }
          if (result.data && typeof result.data === "string") {
            const feedback = result.data.split(",");
            for (let i = 0; i < feedback.length && i < pwLen; i++) {
              if (feedback[i] === "yes" && password[i] === null) {
                password[i] = ch;
              }
            }
          }
        } catch (e) { /* 继续 */ }
        await ns.sleep(50);
        if (password.every((c) => c !== null)) break;
      }

      if (password.every((c) => c !== null)) {
        const finalPwd = password.join("");
        try {
          const result = await ns.dnet.authenticate(host, finalPwd);
          if (result.success) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${finalPwd} (Yesn't)`);
            reportCrack(host, finalPwd, "Yesn't");
            return true;
          }
        } catch (e) { /* 继续 */ }
      }
      ns.print(`[${MY_HOST}] ${host}: Yesn't 失败, 已确定: ${password.map(c=>c??'?').join('')}`);
      return false;
    }

    // BufferOverflow
    if (type === "BufferOverflow") {
      const hint = ((details.passwordHint || details.staticPasswordHint) || "").toLowerCase();
      const bufMatch = hint.match(/buffer is (\d+)/);
      if (bufMatch) {
        const bufLen = parseInt(bufMatch[1]);
        const overflow = "■".repeat(2 * bufLen);
        ns.print(`[${MY_HOST}] ${host}: BufferOverflow 发送 "${"■".repeat(2 * bufLen)}" (length=${2 * bufLen})`);
        try {
          const result = await ns.dnet.authenticate(host, overflow);
          if (result.success) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! (BufferOverflow)`);
            reportCrack(host, overflow, "BufferOverflow");
            return true;
          }
        } catch (e) { /* 继续 */ }
      }
      ns.print(`[${MY_HOST}] ${host}: BufferOverflow 失败`);
      return false;
    }

    // 通用字典遍历
    for (const pwd of candidates) {
      try {
        const result = await ns.dnet.authenticate(host, pwd);
        if (result && result.success) {
          const displayPwd = pwd === "" ? "(空)" : `"${pwd}"`;
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${displayPwd} (模式=${type})`);
          reportCrack(host, pwd, type);
          return true;
        }
      } catch (e) { /* 继续 */ }
      await ns.sleep(50);
    }

    ns.print(`[${MY_HOST}] ${host}: 所有密码尝试失败，请求控制中枢分析`);
    requestAnalysis(host, details);
    return false;
  }

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
          const newDetails = ns.dnet.getServerDetails(host);
          if (newDetails.blockedRam <= 0) {
            ns.tprint(`✅ [${MY_HOST}] ${host}: 内存全部释放完毕`);
            return true;
          }
          ns.print(`[${MY_HOST}] ${host}: 剩余阻塞 ${ns.format.ram(newDetails.blockedRam)}`);
        } else {
          ns.print(`[${MY_HOST}] ${host}: 内存释放失败: ${r?.message || "未知错误"}`);
          return false;
        }
        attempts++;
      }
      return true;
    } catch (e) {
      ns.print(`[${MY_HOST}] ${host}: 内存释放异常 - ${e}`);
      return false;
    }
  }

  // ======================== 缓存管理器 ========================

  /**
   * 管理 openCache.js 生命周期：
   * - 本机存在 .cache 文件且 openCache.js 未运行 → 启动
   * - 本机无 .cache 文件且 openCache.js 正在运行 → 杀掉
   * 
   * 实际打开缓存的 API 调用已移植到 openCache.js 中
   */
  async function manageCacheWatcher() {
    // 扫描本机缓存文件
    let cacheFiles = [];
    try {
      cacheFiles = ns.ls(MY_HOST).filter(
        (f) => f.endsWith(".cache") || f.endsWith(".d.cache")
      );
    } catch (e) {
      ns.print(`[${MY_HOST}] 扫描缓存文件失败: ${e}`);
      return;
    }

    const hasCaches = cacheFiles.length > 0;
    const isOpenCacheRunning = ns.isRunning(OPENCACHE_SCRIPT, MY_HOST);

    if (hasCaches && !isOpenCacheRunning) {
      // 有缓存且 openCache 未运行 → 启动（使用 --watch 模式持续监视）
      ns.print(`[${MY_HOST}] 发现 ${cacheFiles.length} 个缓存文件，启动 openCache.js`);
      openCachePid = ns.exec(OPENCACHE_SCRIPT, MY_HOST, 1, "--watch");
      if (openCachePid > 0) {
        ns.tprint(`🎯 [${MY_HOST}] openCache.js 已启动 (PID=${openCachePid})`);
      } else {
        ns.print(`[${MY_HOST}] openCache.js 启动失败`);
      }
    } else if (!hasCaches && isOpenCacheRunning) {
      // 无缓存且 openCache 正在运行 → 杀掉
      ns.print(`[${MY_HOST}] 缓存文件已消失，杀掉 openCache.js`);
      const killed = ns.kill(OPENCACHE_SCRIPT, MY_HOST);
      if (killed) {
        ns.tprint(`🛑 [${MY_HOST}] openCache.js 已杀掉`);
        openCachePid = 0;
      } else {
        ns.print(`[${MY_HOST}] 杀掉 openCache.js 失败（可能已自行退出）`);
        openCachePid = 0;
      }
    } else if (hasCaches && isOpenCacheRunning) {
      // 有缓存且已在运行 → 正常
      ns.print(`[${MY_HOST}] openCache.js 正在运行，缓存 ${cacheFiles.length} 个`);
    }
  }

  // ======================== 传播引擎 ========================

  /** 将自身及辅助脚本复制到目标服务器并启动副本 */
  async function propagateTo(host, hopCount) {
    if (!PROPAGATE) return false;
    if (hopCount >= MAX_HOPS) {
      ns.print(`[${MY_HOST}] 已达到最大扩散深度(${MAX_HOPS})，停止向 ${host} 扩散`);
      return false;
    }
    if (infectedSet.has(host)) {
      ns.print(`[${MY_HOST}] ${host} 已被感染，跳过传播`);
      return true;
    }

    // 获取目标服务器的可用 RAM
    const serverMaxRam = ns.getServerMaxRam(host);
    const serverUsedRam = ns.getServerUsedRam(host);
    const scriptRam = ns.getScriptRam(SCRIPT_NAME, host);
    const openCacheRam = ns.getScriptRam(OPENCACHE_SCRIPT, host);
    const stockMasterRam = ns.getScriptRam(STOCKMASTER_SCRIPT, host);
    const availableRam = serverMaxRam - serverUsedRam;

    // 主脚本 RAM 必须满足
    if (availableRam < scriptRam) {
      ns.print(`[${MY_HOST}] ${host} RAM不足(可用${ns.format.ram(availableRam)} < 需要${ns.format.ram(scriptRam)})，跳过传播`);
      return false;
    }

    // ===== 复制脚本到目标服务器 =====

    // 先复制主脚本
    try {
      const copied = await ns.scp(SCRIPT_NAME, host);
      if (!copied) {
        ns.print(`[${MY_HOST}] ${host}: SCP ${SCRIPT_NAME} 失败`);
        return false;
      }
      ns.print(`[${MY_HOST}] ${host}: ${SCRIPT_NAME} 已复制`);
    } catch (e) {
      ns.print(`[${MY_HOST}] ${host}: 复制异常 - ${e}`);
      return false;
    }

    // 复制辅助脚本（尽量复制，失败不阻断传播）
    for (const script of [OPENCACHE_SCRIPT, STOCKMASTER_SCRIPT]) {
      try {
        if (ns.fileExists(script, MY_HOST)) {
          const copied = await ns.scp(script, host);
          if (copied) {
            ns.print(`[${MY_HOST}] ${host}: ${script} 已顺带复制`);
          } else {
            ns.print(`[${MY_HOST}] ${host}: ${script} 复制失败（继续传播）`);
          }
        } else {
          ns.print(`[${MY_HOST}] ${host}: ${script} 在本地不存在，跳过复制`);
        }
      } catch (e) {
        ns.print(`[${MY_HOST}] ${host}: 复制 ${script} 异常: ${e}`);
      }
    }

    // ===== 启动副本 =====
    try {
      // 计算运行自身后剩余的 RAM（为辅助脚本预留一点空间）
      const remainingAfterSelf = availableRam - scriptRam;

      const maxThreads = Math.floor(
        (serverMaxRam - ns.getServerUsedRam(host)) / ns.getScriptRam(SCRIPT_NAME, host)
      );
      if (maxThreads <= 0) {
        ns.print(`[${MY_HOST}] ${host}: 没有足够RAM启动副本`);
        return false;
      }

      // 启动时传递 hops 参数；同时附带 --controller 参数告诉副本控制中枢位置（当前 hardcoded 为 home）
      const pid = ns.exec(SCRIPT_NAME, host, maxThreads, "--max-hops", (hopCount + 1).toString());
      if (pid > 0) {
        markInfected(host);
        foundNewInfection = true;
        ns.tprint(`🚀 [${MY_HOST}] → ${host}: 副本已启动(PID=${pid})，深度=${hopCount + 1}`);

        // 如果剩余 RAM 较多，提前启动 openCache.js
        if (remainingAfterSelf >= openCacheRam) {
          // 检查目标是否有缓存文件
          try {
            const targetCaches = ns.ls(host).filter(
              (f) => f.endsWith(".cache") || f.endsWith(".d.cache")
            );
            if (targetCaches.length > 0) {
              ns.print(`[${MY_HOST}] ${host} 有 ${targetCaches.length} 个缓存，提前部署 openCache.js`);
              // 副本启动后会自己管理 openCache，但可以先帮它启动
            }
          } catch { /* 忽略 */ }
        }

        return true;
      } else {
        ns.print(`[${MY_HOST}] ${host}: exec启动失败`);
        return false;
      }
    } catch (e) {
      ns.print(`[${MY_HOST}] ${host}: 启动异常 - ${e}`);
      return false;
    }
  }

  // ======================== 单实例维护 ========================

  /** 
   * 当周边所有服务器均已被攻陷时，只保留全局 1 份 worm 进程。
   * 通过分布式选举：第一个检测到全感染的 worm 成为主实例，
   * 其他 worm 检测到主实例存在后自动退出。
   */
  function ensureSingleInstance() {
    const ELECT_FILE = "/Temp/dnet-worm-primary.txt";

    try {
      const raw = ns.read(ELECT_FILE);
      if (raw === MY_HOST) {
        // 我们已经是主实例
        ns.write(ELECT_FILE, MY_HOST, "w");
        ns.print(`[${MY_HOST}] 主实例存活确认`);
        return true;
      } else if (raw && raw.length > 0) {
        // 已有其他主实例，我们退出
        ns.tprint(`🏁 [${MY_HOST}] 全局感染完成！${raw} 为主实例，本实例退出`);
        ns.exit();
        return false;
      }
    } catch { /* 首次选举 */ }

    // 尝试成为主实例（原子性通过 ns.write 的 w 模式保证最后写入者胜出）
    try {
      ns.write(ELECT_FILE, MY_HOST, "w");
      ns.tprint(`👑 [${MY_HOST}] 成为全局主实例（所有邻居已感染）`);
    } catch (e) {
      ns.print(`[${MY_HOST}] 选举失败: ${e}`);
    }
    return true;
  }

  // ======================== 处理目标 ========================

  /** 处理单个目标服务器 */
  async function processTarget(host, hopCount) {
    ns.print(`\n[${MY_HOST}] 🔍 处理目标: ${host}`);

    // 步骤 1: 尝试破解
    const cracked = await crackServer(host);
    if (!cracked) {
      ns.print(`[${MY_HOST}] ${host}: ❌ 破解失败，跳过`);
      return;
    }

    // 步骤 2: 释放内存
    await freeMemory(host);

    // 步骤 3: 复制自身 + 辅助脚本到目标并启动（传播）
    await propagateTo(host, hopCount);
  }

  // ======================== 主循环 ========================

  // 如果是目标处理模式，只处理指定目标
  if (TARGET_ONLY && TARGET_HOST) {
    ns.tprint(`🎯 目标模式: 处理 ${TARGET_HOST}`);
    await processTarget(TARGET_HOST, 0);
    return;
  }

  // 获取当前跳数
  const hopCount = ns.args.includes("--max-hops")
    ? (parseInt(ns.args[ns.args.indexOf("--max-hops") + 1]) - 1)
    : 0;

  ns.tprint(`="= [${MY_HOST}] 暗网蠕虫 v2.0 启动 (深度=${hopCount}/${MAX_HOPS})`);

  let allInfectedCount = 0; // 连续检测到全感染的次数（防误判）

  while (true) {
    foundNewInfection = false;

    // ===== 阶段 0: 检查控制中枢指令 =====
    await checkControllerCommands();

    // ===== 阶段 1: 管理 openCache.js =====
    await manageCacheWatcher();

    // ===== 阶段 2: 探测直接相连的暗网服务器 =====
    let neighbors = [];
    try {
      neighbors = ns.dnet.probe() || [];
    } catch (e) {
      if (String(e).includes("not a darknet server")) {
        ns.tprint(`❌ [${MY_HOST}] 本机不是暗网服务器，脚本终止`);
        return;
      }
      ns.print(`[${MY_HOST}] 探测失败: ${e}`);
      await ns.sleep(5000);
      continue;
    }

    if (neighbors.length === 0) {
      ns.print(`[${MY_HOST}] 未探测到邻居服务器，等待 10 秒...`);
      await ns.sleep(10000);
      continue;
    }

    ns.print(`[${MY_HOST}] 探测到 ${neighbors.length} 个邻居: ${neighbors.join(", ")}`);

    // ===== 阶段 3: 处理每个邻居 =====
    for (const host of neighbors) {
      await processTarget(host, hopCount);
    }

    // ===== 阶段 4: 全感染检测 =====
    const allInfected = neighbors.every((h) => infectedSet.has(h));
    if (allInfected) {
      allInfectedCount++;
      ns.print(`[${MY_HOST}] 所有邻居已感染 (连续检测 ${allInfectedCount} 次)`);

      // 连续 3 次确认全感染后执行单实例化
      if (allInfectedCount >= 3) {
        ensureSingleInstance();
      }
    } else {
      allInfectedCount = 0; // 重置计数器
      ns.print(`[${MY_HOST}] 尚有未感染的邻居，继续扩散`);
    }

    // ===== 阶段 5: 向控制中枢报告状态 =====
    try {
      const statusFile = REPORT_BASE + "status-" + MY_HOST.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
      ns.write(
        statusFile,
        JSON.stringify({
          host: MY_HOST,
          hopCount: hopCount,
          infectedCount: infectedSet.size,
          neighborCount: neighbors.length,
          allInfected: allInfectedCount >= 3,
          openCacheRunning: ns.isRunning(OPENCACHE_SCRIPT, MY_HOST),
          timestamp: Date.now(),
        }),
        "w"
      );
    } catch (e) {
      ns.print(`[${MY_HOST}] 状态报告失败: ${e}`);
    }

    // ===== 等待一段时间后重新探测 =====
    ns.print(`[${MY_HOST}] 本轮完成，等待 15 秒后重新探测...`);
    await ns.sleep(15000);
  }
}

export function autocomplete(data, args) {
  return ["--max-hops", "--target-only", ...data.servers];
}
