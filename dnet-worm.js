/**
 * dnet-worm.js — 暗网蠕虫 v3.0 (纯净破译版)
 *
 * 仅负责密码破译，所有环境功能已移入 dnet-watch.js：
 *   - SCP 复制文件              → dnet-watch.js
 *   - ns.dnet.memoryReallocation → dnet-watch.js
 *   - 文件清理 (rm)             → dnet-watch.js
 *   - 日志监测                   → dnet-watch.js
 *   - openCache.js 生命周期管理  → dnet-watch.js
 *   - 全感染单实例化             → dnet-watch.js
 *
 * 两种运行模式：
 *   1. --target-only <host>：针对单个目标破译，完成后写入结果文件并退出
 *   2. 无参数：独立循环模式（供手动使用），破译所有邻居
 *
 * 结果文件：/Temp/dnet-worm-crack-result-<host>.txt
 *   dnet-watch.js 读取此文件获取破译结果
 *
 * @param {NS} ns
 */
export async function main(ns) {
  // ======================== 配置 ========================
  const MY_HOST = ns.getHostname();
  const TARGET_ONLY = ns.args.includes("--target-only");
  const TARGET_HOST = TARGET_ONLY
    ? ns.args[ns.args.indexOf("--target-only") + 1]
    : null;
  const RESULT_BASE = "/Temp/dnet-worm-crack-result-";

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

  /** 写入破译结果文件（供 dnet-watch.js 读取） */
  function writeResult(host, success, password, type, needAnalysis, details) {
    try {
      const file = RESULT_BASE + host.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
      ns.write(file, JSON.stringify({
        host,
        success,
        password: password || null,
        type: type || null,
        needAnalysis: !!needAnalysis,
        details: details || null,
        reporter: MY_HOST,
        timestamp: Date.now(),
      }), "w");
    } catch (e) {
      ns.print(`[${MY_HOST}] 写入结果失败: ${e}`);
    }
  }

  // ======================== 密码破解引擎 ========================

  /** 根据提示特征为服务器生成密码候选列表 */
  function getCandidates(details) {
    const hint = ((details.passwordHint || details.staticPasswordHint) || "").toLowerCase();

    // --- 模式 1: NoPassword ---
    if (hint.includes("no password") || hint.includes("not set") || hint.includes("empty") ||
        hint.includes("did i set") || hint.includes("didn't set") || hint.includes("didn't set a")) {
      return { type: "NoPassword", candidates: [""] };
    }

    // --- 模式 2: DefaultPassword ---
    if (hint.includes("default") || hint.includes("factory") || hint.includes("never changed") ||
        hint.includes("still the")) {
      return { type: "DefaultPassword", candidates: DEFAULT_PASSWORDS };
    }

    // --- 模式 3: EchoVuln ---
    if (hint.includes("the password is") || hint.includes("the pin is") || hint.includes("the key is") ||
        hint.includes("it's set to") || hint.includes("remember to use") || hint.includes("the secret is")) {
      const words = hint.split(" ");
      const lastWord = words[words.length - 1].replace(/[^a-zA-Z0-9]/g, "");
      if (lastWord && /^\d+$/.test(lastWord) && lastWord.length <= 3) {
        return { type: "EchoVuln", candidates: [lastWord] };
      }
    }

    // --- 模式 4: DogNames ---
    if (hint.includes("dog") || hint.includes("fido") || hint.includes("spot") || hint.includes("rover")) {
      return { type: "DogNames", candidates: DOG_NAMES };
    }

    // --- 模式 5: Captcha ---
    if (hint.includes("captcha") || hint.includes("human") || hint.includes("prove")) {
      const rawData = details.data || "";
      if (rawData) {
        const filtered = rawData.replace(/[^0-9]/g, "");
        if (filtered && filtered.length <= 15) {
          return { type: "Captcha", candidates: [filtered] };
        }
      }
    }

    // --- 模式 6: GuessNumber ---
    if (hint.includes("number between") || hint.includes("guess")) {
      return { type: "GuessNumber", candidates: [] };
    }

    // --- 模式 7: Yesn't ---
    if (hint.includes("you are one who") || hint.includes("who's'nt") || hint.includes("'s'nt authorized")) {
      return { type: "Yesn't", candidates: [] };
    }

    // --- 模式 8: BufferOverflow ---
    if (hint.includes("password buffer") || hint.includes("buffer is")) {
      return { type: "BufferOverflow", candidates: [] };
    }

    // --- 模式 9: LargestPrimeFactor ---
    if (hint.includes("largest prime factor") || hint.includes("prime factor")) {
      return { type: "PrimeFactor", candidates: COMMON_PASSWORDS };
    }

    // --- 模式 10: SortedEchoVuln ---
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
        const perms = getUniquePermutations(sortedStr);
        return { type: "SortedEcho", candidates: perms };
      }
    }

    // --- 模式 11: 罗马数字 ---
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

    // --- 模式 12: BinaryEncoded ---
    if (hint.includes("beep") || hint.includes("boop") || hint.includes("binary")) {
      const data = details.data || "";
      if (data && data.includes(" ")) {
        const chars = data.split(" ").map((b) => String.fromCharCode(parseInt(b, 2))).join("");
        if (chars && chars.length <= 15) return { type: "BinaryEncoded", candidates: [chars] };
      }
    }

    // --- 通用字典 ---
    return { type: "Dictionary", candidates: COMMON_PASSWORDS };
  }

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

  /** 破解单个服务器 — 纯破译，返回 { success, password, type } */
  async function crackServer(host) {
    let details;
    try {
      details = ns.dnet.getServerDetails(host);
    } catch (e) {
      ns.print(`[${MY_HOST}] ${host}: 无法获取详情 - ${e}`);
      return { success: false, needAnalysis: false };
    }

    if (!details.isOnline) {
      ns.print(`[${MY_HOST}] ${host}: 离线`);
      return { success: false, needAnalysis: false };
    }

    if (details.hasSession) {
      ns.print(`[${MY_HOST}] ${host}: 已有有效会话`);
      return { success: true, password: null, type: "SessionExists" };
    }

    const { type, candidates: rawCandidates } = getCandidates(details);

    // 空密码
    if (details.passwordLength === 0) {
      try {
        const r = await ns.dnet.authenticate(host, "");
        if (r.success) {
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=(空)`);
          return { success: true, password: "", type: "NoPassword" };
        }
      } catch { /* 继续 */ }
      return { success: false, needAnalysis: true, details };
    }

    // 过滤候选
    const format = details.passwordFormat || "";
    const pwLen = details.passwordLength || -1;
    let candidates = rawCandidates;
    if (format === "numeric") candidates = rawCandidates.filter((c) => /^\d+$/.test(c));
    else if (format === "alphabetic") candidates = rawCandidates.filter((c) => /^[a-zA-Z]+$/.test(c));
    else if (format === "alphanumeric") candidates = rawCandidates.filter((c) => /^[a-zA-Z0-9]+$/.test(c));
    if (pwLen > 0) candidates = candidates.filter((c) => c.length === pwLen);

    if (candidates.length === 0) {
      return { success: false, needAnalysis: true, details };
    }

    // GuessNumber 二分法
    if (type === "GuessNumber") {
      const hint = ((details.passwordHint || details.staticPasswordHint) || "").toLowerCase();
      const maxMatch = hint.match(/between\s+\d+\s+and\s+(\d+)/);
      let low = 0;
      let high = maxMatch ? parseInt(maxMatch[1]) - 1 : 999;
      if (high < 0) high = 0;
      let attempts = 0;
      const maxAttempts = Math.ceil(Math.log2(high - low + 1)) + 2;
      while (low <= high && attempts < maxAttempts) {
        const mid = Math.floor((low + high) / 2);
        const guess = String(mid);
        try {
          const result = await ns.dnet.authenticate(host, guess);
          if (result.success) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${guess} (二分法)`);
            return { success: true, password: guess, type: "GuessNumber" };
          }
          if (result.data === "Lower") high = mid - 1;
          else low = mid + 1;
        } catch { /* 继续 */ }
        attempts++;
        await ns.sleep(50);
      }
      return { success: false, needAnalysis: true, details };
    }

    // Yesn't 逐字符
    if (type === "Yesn't") {
      const pwl = details.passwordLength || 0;
      if (pwl <= 0) return { success: false, needAnalysis: true, details };
      const charset = format === "alphabetic"
        ? "abcdefghijklmnopqrstuvwxyz"
        : format === "alphanumeric"
          ? "abcdefghijklmnopqrstuvwxyz0123456789"
          : "0123456789";
      const password = new Array(pwl).fill(null);
      for (const ch of charset) {
        const probe = ch.repeat(pwl);
        try {
          const result = await ns.dnet.authenticate(host, probe);
          if (result.success) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${probe} (Yesn't)`);
            return { success: true, password: probe, type: "Yesn't" };
          }
          if (result.data && typeof result.data === "string") {
            const feedback = result.data.split(",");
            for (let i = 0; i < feedback.length && i < pwl; i++) {
              if (feedback[i] === "yes" && password[i] === null) password[i] = ch;
            }
          }
        } catch { /* 继续 */ }
        await ns.sleep(50);
        if (password.every((c) => c !== null)) break;
      }
      if (password.every((c) => c !== null)) {
        const finalPwd = password.join("");
        try {
          const result = await ns.dnet.authenticate(host, finalPwd);
          if (result.success) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${finalPwd} (Yesn't)`);
            return { success: true, password: finalPwd, type: "Yesn't" };
          }
        } catch { /* 继续 */ }
      }
      return { success: false, needAnalysis: false };
    }

    // BufferOverflow
    if (type === "BufferOverflow") {
      const hint = ((details.passwordHint || details.staticPasswordHint) || "").toLowerCase();
      const bufMatch = hint.match(/buffer is (\d+)/);
      if (bufMatch) {
        const bufLen = parseInt(bufMatch[1]);
        const overflow = "■".repeat(2 * bufLen);
        try {
          const result = await ns.dnet.authenticate(host, overflow);
          if (result.success) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! (BufferOverflow)`);
            return { success: true, password: overflow, type: "BufferOverflow" };
          }
        } catch { /* 继续 */ }
      }
      return { success: false, needAnalysis: false };
    }

    // 通用字典
    for (const pwd of candidates) {
      try {
        const result = await ns.dnet.authenticate(host, pwd);
        if (result && result.success) {
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码="${pwd}" (${type})`);
          return { success: true, password: pwd, type };
        }
      } catch { /* 继续 */ }
      await ns.sleep(50);
    }

    return { success: false, needAnalysis: true, details };
  }

  // ======================== 主逻辑 ========================

  // ----- 模式 1: --target-only 单目标模式（由 dnet-watch.js 调用） -----
  if (TARGET_ONLY && TARGET_HOST) {
    const result = await crackServer(TARGET_HOST);
    writeResult(TARGET_HOST, result.success, result.password, result.type, result.needAnalysis, result.details || null);
    if (result.success) {
      ns.tprint(`✅ [${MY_HOST}] ${TARGET_HOST} 破译完成`);
    } else {
      ns.print(`[${MY_HOST}] ${TARGET_HOST} 破译失败`);
    }
    return;
  }

  // ----- 模式 2: 独立循环（手动使用） -----
  ns.tprint(`🔓 [${MY_HOST}] dnet-worm v3.0 (纯净破译) 启动`);
  while (true) {
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
    if (neighbors.length === 0) {
      await ns.sleep(10000);
      continue;
    }
    for (const host of neighbors) {
      const result = await crackServer(host);
      writeResult(host, result.success, result.password, result.type, result.needAnalysis, result.details || null);
      await ns.sleep(100);
    }
    await ns.sleep(15000);
  }
}

export function autocomplete(data, args) {
  return ["--target-only", ...data.servers];
}
