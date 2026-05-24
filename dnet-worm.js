/**
 * dnet-worm.js — 暗网蠕虫 v3.1 (全模式破译版)
 *
 * 三层策略引擎：modelId → hint → details
 * 覆盖全部 25 种谜题类型
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
  const DOG_NAMES = ["fido", "spot", "rover", "max"];
  const EU_COUNTRIES = [
    "Austria", "Belgium", "Bulgaria", "Croatia", "Republic of Cyprus",
    "Czech Republic", "Denmark", "Estonia", "Finland", "France", "Germany",
    "Greece", "Hungary", "Ireland", "Italy", "Latvia", "Lithuania",
    "Luxembourg", "Malta", "Netherlands", "Poland", "Portugal", "Romania",
    "Slovakia", "Slovenia", "Spain", "Sweden",
  ];
  const smallPrimes = [
    2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
  ];
  const largePrimes = [
    1069, 1409, 1471, 1567, 1597, 1601, 1697, 1747, 1801, 1889, 1979, 1999, 2063, 2207, 2371,
    2503, 2539, 2693, 2741, 2753, 2801, 2819, 2837, 2909, 2939, 3169, 3389, 3571, 3761, 3881,
    4217, 4289, 4547, 4729, 4789, 4877, 4943, 4951, 4957, 5393, 5417, 5419, 5441, 5519, 5527,
    5647, 5779, 5881, 6007, 6089, 6133, 6389, 6451, 6469, 6547, 6661, 6719, 6841, 7103, 7549,
    7559, 7573, 7691, 7753, 7867, 8053, 8081, 8221, 8329, 8599, 8677, 8761, 8839, 8963, 9103,
    9199, 9343, 9467, 9551, 9601, 9739, 9749, 9859,
  ];
  const ALL_PRIMES = [...smallPrimes, ...largePrimes];

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

  /** 根据 format 获取可用字符集 */
  function getCharset(format) {
    if (format === "alphabetic") return "abcdefghijklmnopqrstuvwxyz";
    if (format === "alphanumeric") return "abcdefghijklmnopqrstuvwxyz0123456789";
    if (format === "ASCII") return "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
    return "0123456789"; // numeric / fallback
  }

  // ======================== 密码破解引擎 ========================

  /** 模型ID常量（与游戏 Darknet/Enums.ts 同步） */
  const ModelIds = {
    EchoVuln: "DeskMemo_3.1",
    SortedEchoVuln: "PHP 5.4",
    NoPassword: "ZeroLogon",
    Captcha: "CloudBlare(tm)",
    DefaultPassword: "FreshInstall_1.0",
    BufferOverflow: "Pr0verFl0",
    MastermindHint: "DeepGreen",
    TimingAttack: "2G_cellular",
    LargestPrimeFactor: "PrimeTime 2",
    RomanNumeral: "BellaCuore",
    DogNames: "Laika4",
    GuessNumber: "AccountsManager_4.2",
    CommonPasswordDictionary: "TopPass",
    EUCountryDictionary: "EuroZone Free",
    Yesn_t: "NIL",
    BinaryEncodedFeedback: "110100100",
    SpiceLevel: "RateMyPix.Auth",
    ConvertToBase10: "OctantVoxel",
    parsedExpression: "MathML",
    divisibilityTest: "Factori-Os",
    tripleModulo: "BigMo%od",
    globalMaxima: "KingOfTheHill",
    packetSniffer: "OpenWebAccessPoint",
    encryptedPassword: "OrdoXenos",
    labyrinth: "(The Labyrinth)",
  };

  /**
   * 三层策略引擎：modelId → hint → details
   *
   * 第1层：modelId（最可靠）— 服务器的确定性标识，直接决定破解策略
   * 第2层：hint 关键词 — 当 modelId 未知时降级使用
   * 第3层：details 细节 — format/length/data 二次过滤候选
   */
  function getCandidates(details) {
    const modelId = (details.modelId || "").trim();
    const hint = ((details.passwordHint || details.staticPasswordHint) || "").toLowerCase();
    const format = details.passwordFormat || "";
    const pwLen = details.passwordLength || -1;

    // ===================== 第1层：modelId 精确匹配 =====================
    switch (modelId) {
      case ModelIds.NoPassword:
        return { type: "NoPassword", candidates: [""] };
      case ModelIds.DefaultPassword:
        return { type: "DefaultPassword", candidates: DEFAULT_PASSWORDS };
      case ModelIds.DogNames:
        return { type: "DogNames", candidates: DOG_NAMES };
      case ModelIds.Captcha: {
        const rawData = details.data || "";
        if (rawData) {
          const filtered = rawData.replace(/[^0-9]/g, "");
          if (filtered && filtered.length <= 15) {
            return { type: "Captcha", candidates: [filtered] };
          }
        }
        break;
      }
      case ModelIds.EchoVuln:
        return crackByEchoVuln(hint);
      case ModelIds.SortedEchoVuln:
        return crackBySortedEcho(details, hint);
      case ModelIds.GuessNumber:
        return { type: "GuessNumber", candidates: [] };
      case ModelIds.Yesn_t:
        return { type: "Yesn't", candidates: [] };
      case ModelIds.BufferOverflow:
        return { type: "BufferOverflow", candidates: [] };
      case ModelIds.LargestPrimeFactor: {
        const data = details.data || "";
        const target = parseInt(data);
        if (!isNaN(target) && target > 1) {
          const result = computeLargestPrimeFactor(target);
          if (result) return { type: "PrimeFactor", candidates: [result] };
        }
        return { type: "PrimeFactor", candidates: COMMON_PASSWORDS };
      }
      case ModelIds.RomanNumeral:
        return crackByRomanNumeral(details);
      case ModelIds.BinaryEncodedFeedback:
        return crackByBinaryEncoded(details);
      case ModelIds.MastermindHint:
        // 难度>16 时 30% 概率为 alphanumeric
        if ((format === "numeric" || format === "alphanumeric") && pwLen > 0) {
          return { type: "MasterMind", candidates: [] };
        }
        break;
      case ModelIds.TimingAttack:
        return { type: "TimingAttack", candidates: [] };
      case ModelIds.CommonPasswordDictionary:
        return { type: "Dictionary", candidates: COMMON_PASSWORDS };
      case ModelIds.EUCountryDictionary:
        return { type: "EUCountry", candidates: EU_COUNTRIES };
      case ModelIds.SpiceLevel:
        return { type: "SpiceLevel", candidates: [] };
      case ModelIds.ConvertToBase10:
        return crackByConvertToBase10(details);
      case ModelIds.parsedExpression:
        return crackByParsedExpression(details);
      case ModelIds.divisibilityTest:
        return { type: "DivisibilityTest", candidates: [] };
      case ModelIds.tripleModulo:
        return { type: "TripleModulo", candidates: [] };
      case ModelIds.globalMaxima:
        return { type: "GlobalMaxima", candidates: [] };
      case ModelIds.packetSniffer:
        return { type: "PacketSniffer", candidates: [] };
      case ModelIds.encryptedPassword:
        return crackByEncryptedPassword(details);
      case ModelIds.labyrinth:
        return { type: "Labyrinth", candidates: [] };
      default:
        break;
    }

    // ===================== 第2层：hint 关键词匹配 =====================
    if (hint.includes("no password") || hint.includes("not set") || hint.includes("empty") ||
        hint.includes("did i set") || hint.includes("didn't set") || hint.includes("didn't set a")) {
      return { type: "NoPassword", candidates: [""] };
    }
    if (hint.includes("default") || hint.includes("factory") || hint.includes("never changed") ||
        hint.includes("still the")) {
      return { type: "DefaultPassword", candidates: DEFAULT_PASSWORDS };
    }
    if (hint.includes("dog") || hint.includes("fido") || hint.includes("spot") || hint.includes("rover")) {
      return { type: "DogNames", candidates: DOG_NAMES };
    }
    if (hint.includes("captcha") || hint.includes("human") || hint.includes("prove")) {
      const rawData = details.data || "";
      if (rawData) {
        const filtered = rawData.replace(/[^0-9]/g, "");
        if (filtered && filtered.length <= 15) {
          return { type: "Captcha", candidates: [filtered] };
        }
      }
    }
    if (hint.includes("number between") || hint.includes("guess")) {
      return { type: "GuessNumber", candidates: [] };
    }
    if (hint.includes("you are one who") || hint.includes("who's'nt") || hint.includes("'s'nt authorized")) {
      return { type: "Yesn't", candidates: [] };
    }
    if (hint.includes("password buffer") || hint.includes("buffer is")) {
      return { type: "BufferOverflow", candidates: [] };
    }
    if (hint.includes("largest prime factor") || hint.includes("prime factor")) {
      const data = details.data || "";
      const target = parseInt(data);
      if (!isNaN(target) && target > 1) {
        const result = computeLargestPrimeFactor(target);
        if (result) return { type: "PrimeFactor", candidates: [result] };
      }
      return { type: "PrimeFactor", candidates: COMMON_PASSWORDS };
    }
    if (hint.includes("shuffled") || hint.includes("sorted") || hint.includes("accidentally sorted") ||
        hint.includes("made from")) {
      const result = crackBySortedEcho(details, hint);
      if (result) return result;
    }
    if (hint.includes("roman") || hint.includes("numeral") || hint.includes("value of the number")) {
      const result = crackByRomanNumeral(details);
      if (result) return result;
    }
    if (hint.includes("beep") || hint.includes("boop") || hint.includes("binary")) {
      const result = crackByBinaryEncoded(details);
      if (result) return result;
    }
    if (hint.includes("base") && hint.includes("in base 10")) {
      const result = crackByConvertToBase10(details);
      if (result) return result;
    }
    if (hint.includes("evaluation of this expression") || hint.includes("expression")) {
      const result = crackByParsedExpression(details);
      if (result) return result;
    }
    if (hint.includes("xor mask")) {
      const result = crackByEncryptedPassword(details);
      if (result) return result;
    }
    // 难度>16 时 30% 概率为 alphanumeric
    if ((format === "numeric" || format === "alphanumeric") && pwLen > 0 &&
        (hint.includes("master") || hint.includes("match exactly") || hint.includes("wrong place"))) {
      return { type: "MasterMind", candidates: [] };
    }
    if (hint.includes("the password is") || hint.includes("the pin is") || hint.includes("the key is") ||
        hint.includes("it's set to") || hint.includes("remember to use") || hint.includes("the secret is")) {
      const words = hint.split(" ");
      const lastWord = words[words.length - 1].replace(/[^a-zA-Z0-9]/g, "");
      if (lastWord && /^\d+$/.test(lastWord) && lastWord.length <= 3) {
        return { type: "EchoVuln", candidates: [lastWord] };
      }
    }

    return { type: "Dictionary", candidates: COMMON_PASSWORDS };
  }

  /** EchoVuln：从 hint 末尾提取短数字密码 */
  function crackByEchoVuln(hint) {
    const words = hint.split(" ");
    const lastWord = words[words.length - 1].replace(/[^a-zA-Z0-9]/g, "");
    if (lastWord && /^\d+$/.test(lastWord) && lastWord.length <= 3) {
      return { type: "EchoVuln", candidates: [lastWord] };
    }
    return null;
  }

  /** SortedEcho：解析出已排序的数字字符串，由 crackSortedEcho 迭代破解 */
  function crackBySortedEcho(details, hint) {
    let sortedStr = (details.data || "").trim();
    if (!sortedStr) {
      const words = hint.split(" ");
      const last = words[words.length - 1].replace(/[^a-zA-Z0-9]/g, "");
      if (last && /^\d+$/.test(last)) sortedStr = last;
    }
    if (sortedStr && /^\d+$/.test(sortedStr)) sortedStr = Number(sortedStr).toString();
    if (sortedStr && sortedStr.length >= 1) {
      // 标记为交互式破解，由 crackSortedEcho 迭代生成排列并实时验证
      return { type: "SortedEcho", candidates: [] };
    }
    return null;
  }

  /** 通过 heartbleed 从服务器日志中提取上次 auth 的 RMSD */
  async function getRMSDviaHeartbleed(host, guess) {
    // 先做一次 auth
    const authResult = await ns.dnet.authenticate(host, guess);
    if (authResult.success) return { success: true, rmsd: 0 };
    // 用 heartbleed 读日志（peek=true 不删除日志）
    try {
      const hb = await ns.dnet.heartbleed(host, { logsToCapture: 1, peek: true });
      if (hb.success && hb.logs && hb.logs.length > 0) {
        const raw = hb.logs[0];
        let data = "";
        // log 是 JSON 字符串化的 PasswordResponse
        if (typeof raw === "string" && raw.startsWith("{")) {
          try {
            const parsed = JSON.parse(raw);
            data = parsed.data || "";
          } catch { data = raw; }
        } else {
          data = String(raw);
        }
        const m = data.match(/RMS Deviation:([\d.]+)/);
        if (m) return { success: false, rmsd: parseFloat(m[1]) };
      }
    } catch { /* heartbleed 不可用（魅力不足等） */ }
    return { success: false, rmsd: null };
  }

  /** SortedEcho RMSD 梯度下降（通过 heartbleed 获取反馈） */
  async function crackSortedEcho(host, details) {
    let sortedStr = (details.data || "").trim();
    if (!sortedStr) {
      const hint = ((details.passwordHint || details.staticPasswordHint) || "").toLowerCase();
      const words = hint.split(" ");
      const last = words[words.length - 1].replace(/[^a-zA-Z0-9]/g, "");
      if (last && /^\d+$/.test(last)) sortedStr = last;
    }
    if (sortedStr && /^\d+$/.test(sortedStr)) sortedStr = Number(sortedStr).toString();
    if (!sortedStr || sortedStr.length < 2) {
      if (sortedStr && sortedStr.length === 1) {
        const r = await ns.dnet.authenticate(host, sortedStr);
        if (r.success) return { success: true, password: sortedStr, type: "SortedEcho" };
      }
      return { success: false, needAnalysis: true, details };
    }

    // 检测 heartbleed 是否可用
    let hbAvailable = false;
    try {
      const testHb = await ns.dnet.heartbleed(host, { logsToCapture: 1, peek: true });
      hbAvailable = testHb.success;
    } catch { hbAvailable = false; }

    if (!hbAvailable) {
      // heartbleed 不可用 → 降级到 nextPermutation 迭代
      ns.print(`[${MY_HOST}] ${host}: heartbleed 不可用，降级到排列迭代`);
      const arr = sortedStr.split("").sort();
      let attempts = 0;
      const maxAttempts = sortedStr.length <= 7 ? 5040 : 362880;
      do {
        const candidate = arr.join("");
        attempts++;
        try {
          const r = await ns.dnet.authenticate(host, candidate);
          if (r.success) {
            ns.tprint(`✅ 破解成功! 密码=${candidate} (SortedEcho-排列 ${attempts}次)`);
            return { success: true, password: candidate, type: "SortedEcho" };
          }
        } catch { /* 继续 */ }
        await ns.sleep(2);
      } while (nextPermutation(arr) && attempts < maxAttempts);
      return { success: false, needAnalysis: true, details };
    }

    // ===== heartbleed 可用 → RMSD 梯度下降 =====
    const arr = sortedStr.split("");
    let bestRmsd = Infinity;
    let totalCalls = 0;

    // 首次测量 RMSD
    {
      const r = await getRMSDviaHeartbleed(host, arr.join(""));
      totalCalls++;
      if (r.success) {
        ns.tprint(`✅ 破解成功! 密码=${arr.join("")} (SortedEcho-RMSD 起始)`);
        return { success: true, password: arr.join(""), type: "SortedEcho" };
      }
      if (r.rmsd === null) {
        ns.print(`[${MY_HOST}] ${host}: 无法获取 RMSD，heartbleed 日志格式不匹配`);
        return { success: false, needAnalysis: true, details };
      }
      bestRmsd = r.rmsd;
      ns.print(`[${MY_HOST}] ${host}: SortedEcho 起始 RMSD=${bestRmsd.toFixed(3)}, 长度=${arr.length}`);
    }

    // Phase 1: 粗调——相邻交换
    for (let sweep = 0; sweep < 20; sweep++) {
      let improved = false;
      for (let i = 0; i < arr.length - 1; i++) {
        [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
        const r = await getRMSDviaHeartbleed(host, arr.join(""));
        totalCalls++;
        if (r.success) {
          ns.tprint(`✅ 破解成功! 密码=${arr.join("")} (SortedEcho-RMSD 第${totalCalls}次)`);
          return { success: true, password: arr.join(""), type: "SortedEcho" };
        }
        if (r.rmsd !== null && r.rmsd < bestRmsd - 1e-9) {
          bestRmsd = r.rmsd;
          improved = true;
          ns.print(`[${MY_HOST}] ${host}: SortedEcho 交换[${i}↔${i+1}] RMSD↓${bestRmsd.toFixed(3)}`);
        } else {
          [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]; // 撤销
        }
        await ns.sleep(1);
      }
      if (!improved) break;
    }
    ns.print(`[${MY_HOST}] ${host}: SortedEcho 粗调完成, RMSD=${bestRmsd.toFixed(3)}, 共${totalCalls}次`);

    // Phase 2: 精调——任意两位置交换
    if (bestRmsd > 1e-9) {
      for (let sweep = 0; sweep < 10; sweep++) {
        let improved = false;
        for (let i = 0; i < arr.length - 1; i++) {
          for (let j = i + 1; j < arr.length; j++) {
            [arr[i], arr[j]] = [arr[j], arr[i]];
            const r = await getRMSDviaHeartbleed(host, arr.join(""));
            totalCalls++;
            if (r.success) {
              ns.tprint(`✅ 破解成功! 密码=${arr.join("")} (SortedEcho-RMSD 精调 ${totalCalls}次)`);
              return { success: true, password: arr.join(""), type: "SortedEcho" };
            }
            if (r.rmsd !== null && r.rmsd < bestRmsd - 1e-9) {
              bestRmsd = r.rmsd;
              improved = true;
              ns.print(`[${MY_HOST}] ${host}: SortedEcho 精调[${i}↔${j}] RMSD↓${bestRmsd.toFixed(3)}`);
            } else {
              [arr[i], arr[j]] = [arr[j], arr[i]]; // 撤销
            }
            await ns.sleep(1);
          }
        }
        if (!improved) break;
      }
    }

    // 最终验证
    const r = await ns.dnet.authenticate(host, arr.join(""));
    totalCalls++;
    if (r.success) {
      ns.tprint(`✅ 破解成功! 密码=${arr.join("")} (SortedEcho-RMSD 最终 ${totalCalls}次)`);
      return { success: true, password: arr.join(""), type: "SortedEcho" };
    }
    ns.print(`[${MY_HOST}] ${host}: SortedEcho 失败, RMSD=${bestRmsd.toFixed(3)}, 共${totalCalls}次`);
    return { success: false, needAnalysis: true, details };
  }

  /** RomanNumeral：从 data 解析罗马数字并转为十进制。高难度用范围+二分 */
  function crackByRomanNumeral(details) {
    const data = details.data || "";
    if (!data) return null;
    const parts = data.split(",").map((s) => s.trim()).filter(Boolean);

    // 高难度模式：data = "romanMin,romanMax"（两个罗马数字表示范围）
    if (parts.length === 2 && parts.every((p) => /^[IVXLCDMivxlcdm]+$/.test(p))) {
      const minVal = romanToDecimal(parts[0]);
      const maxVal = romanToDecimal(parts[1]);
      if (minVal > 0 && maxVal > minVal) {
        // 返回范围让 crackServer 做二分搜索
        return { type: "RomanNumeralRange", candidates: [], extra: { low: minVal, high: maxVal } };
      }
    }

    // 低难度模式：data = "roman"（单个罗马数字）
    for (const part of parts) {
      if (/^[IVXLCDMivxlcdm]+$/.test(part)) {
        const decoded = romanToDecimal(part);
        if (decoded > 0) return { type: "RomanNumeral", candidates: [decoded.toString()] };
      }
    }
    return null;
  }

  /** BinaryEncoded：二进制转 ASCII */
  function crackByBinaryEncoded(details) {
    const data = details.data || "";
    if (data && data.includes(" ")) {
      const chars = data.split(" ").map((b) => String.fromCharCode(parseInt(b, 2))).join("");
      if (chars && chars.length <= 15) return { type: "BinaryEncoded", candidates: [chars] };
    }
    return null;
  }

  /** ConvertToBase10：N 进制转十进制 */
  function crackByConvertToBase10(details) {
    const data = details.data || "";
    if (!data) return null;
    const commaIdx = data.indexOf(",");
    if (commaIdx === -1) return null;
    const baseStr = data.substring(0, commaIdx).trim();
    const encodedNum = data.substring(commaIdx + 1).trim();
    const base = parseFloat(baseStr);
    if (isNaN(base) || base < 2 || !encodedNum) return null;
    const characters = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let result = 0;
    let pointIdx = encodedNum.indexOf(".");
    if (pointIdx === -1) pointIdx = encodedNum.length;
    for (let i = 0; i < encodedNum.length; i++) {
      const ch = encodedNum[i];
      if (ch === ".") continue;
      const val = characters.indexOf(ch.toUpperCase());
      if (val === -1 || val >= base) return null;
      const pos = i < pointIdx ? pointIdx - 1 - i : -(i - pointIdx);
      result += val * Math.pow(base, pos);
    }
    if (!isFinite(result) || isNaN(result)) return null;
    return { type: "ConvertToBase10", candidates: [String(result)] };
  }

  /** ParsedExpression：清理并计算算术表达式 */
  function crackByParsedExpression(details) {
    let expr = (details.data || "").trim();
    if (!expr) return null;
    // 1) 替换特殊符号
    expr = expr.replace(/ҳ/g, "*").replace(/÷/g, "/").replace(/➕/g, "+").replace(/➖/g, "-");
    // 2) 清理代码注入：按逗号分割取第一部分，移除 ns.exit()
    expr = expr.split(",")[0].replace(/ns\.exit\(\)/g, "");
    // 3) 计算
    try {
      const result = evaluateArithmetic(expr);
      if (result !== null && isFinite(result)) {
        return { type: "ParsedExpression", candidates: [result.toString()] };
      }
    } catch { /* ignore */ }
    return null;
  }

  /** EncryptedPassword：XOR 解密 */
  function crackByEncryptedPassword(details) {
    const data = details.data || "";
    if (!data) return null;
    const semiIdx = data.indexOf(";");
    if (semiIdx === -1) return null;
    const encrypted = data.substring(0, semiIdx);
    const masksStr = data.substring(semiIdx + 1).trim();
    const masks = masksStr.split(/\s+/);
    if (encrypted.length !== masks.length) return null;
    let result = "";
    for (let i = 0; i < encrypted.length; i++) {
      const xorMask = parseInt(masks[i], 2);
      if (isNaN(xorMask)) return null;
      result += String.fromCharCode(encrypted.charCodeAt(i) ^ xorMask);
    }
    return { type: "EncryptedPassword", candidates: [result] };
  }

  /** 计算最大质因数 */
  function computeLargestPrimeFactor(n) {
    let num = n;
    let largest = 1;
    // 试除 smallPrimes
    for (const p of smallPrimes) {
      while (num % p === 0) {
        largest = p;
        num = num / p;
      }
    }
    // 如果剩余 > 1，要么是剩余的大质数，要么 > smallPrimes 最大值的平方
    if (num > 1) {
      // 试除 largePrimes
      let found = false;
      for (const p of largePrimes) {
        if (p * p > num) break;
        while (num % p === 0) {
          largest = p;
          num = num / p;
          found = true;
        }
      }
      if (num > 1) largest = num;
    }
    return largest > 1 ? String(largest) : null;
  }

  /** 算术表达式求值（递归下降） */
  function evaluateArithmetic(expr) {
    const tokens = tokenize(expr);
    if (!tokens || tokens.length === 0) return null;
    let pos = 0;
    function parseAddSub() {
      let left = parseMulDiv();
      while (pos < tokens.length && (tokens[pos] === "+" || tokens[pos] === "-")) {
        const op = tokens[pos++];
        const right = parseMulDiv();
        if (right === null) return null;
        left = op === "+" ? left + right : left - right;
      }
      return left;
    }
    function parseMulDiv() {
      let left = parseAtom();
      while (pos < tokens.length && (tokens[pos] === "*" || tokens[pos] === "/")) {
        const op = tokens[pos++];
        const right = parseAtom();
        if (right === null) return null;
        left = op === "*" ? left * right : left / right;
      }
      return left;
    }
    function parseAtom() {
      if (pos >= tokens.length) return null;
      if (tokens[pos] === "(") {
        pos++; // skip (
        const val = parseAddSub();
        if (pos >= tokens.length || tokens[pos] !== ")") return null;
        pos++; // skip )
        return val;
      }
      const num = parseFloat(tokens[pos]);
      if (isNaN(num)) return null;
      pos++;
      return num;
    }
    const result = parseAddSub();
    if (pos !== tokens.length || result === null) return null;
    return result;
  }

  /** 分词：将表达式拆分为数字、运算符、括号 */
  function tokenize(expr) {
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
      const ch = expr[i];
      if (/\s/.test(ch)) { i++; continue; }
      if ("+-*/()".includes(ch)) { tokens.push(ch); i++; continue; }
      if (/[\d.]/.test(ch)) {
        let num = "";
        while (i < expr.length && /[\d.eE+\-]/.test(expr[i])) {
          // 处理科学计数法
          num += expr[i];
          i++;
        }
        tokens.push(num);
        continue;
      }
      // 非法字符
      return null;
    }
    return tokens;
  }

  /** 生成字符串的所有不重复排列（小规模用，≤5040） */
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

  /** 阶乘计算 */
  function factorial(n) {
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }

  /** nextPermutation：原地生成字典序下一个排列，无内存分配 */
  function nextPermutation(arr) {
    let i = arr.length - 2;
    while (i >= 0 && arr[i] >= arr[i + 1]) i--;
    if (i < 0) return false;
    let j = arr.length - 1;
    while (arr[j] <= arr[i]) j--;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    for (let l = i + 1, r = arr.length - 1; l < r; l++, r--) {
      [arr[l], arr[r]] = [arr[r], arr[l]];
    }
    return true;
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

  // ======================== 破解调度 ========================

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

    const { type, candidates: rawCandidates, extra } = getCandidates(details);

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

    // ---- 交互式破解类型优先调度 ----
    // 这些类型 candidates=[]，需要特殊交互逻辑，必须在 candidates 过滤之前处理

    const format = details.passwordFormat || "";
    const pwLen = details.passwordLength || -1;

    if (type === "GuessNumber") {
      return await crackGuessNumber(host, details);
    }
    if (type === "Yesn't") {
      return await crackYesnt(host, details, format);
    }
    if (type === "BufferOverflow") {
      return await crackBufferOverflow(host, details);
    }
    if (type === "MasterMind") {
      return await crackMasterMind(host, details, pwLen);
    }
    if (type === "TimingAttack") {
      return await crackTimingAttack(host, details, format, pwLen);
    }
    if (type === "SpiceLevel") {
      return await crackSpiceLevel(host, details, format, pwLen);
    }
    if (type === "DivisibilityTest") {
      return await crackDivisibilityTest(host, details, pwLen);
    }
    if (type === "TripleModulo") {
      return await crackTripleModulo(host, details, pwLen);
    }
    if (type === "GlobalMaxima") {
      return await crackGlobalMaxima(host, details, pwLen);
    }
    if (type === "PacketSniffer") {
      return await crackPacketSniffer(host, details);
    }
    if (type === "Labyrinth") {
      return await crackLabyrinth(host, details);
    }
    if (type === "RomanNumeralRange" && extra && extra.low !== undefined && extra.high !== undefined) {
      return await crackRomanNumeralRange(host, extra.low, extra.high);
    }
    if (type === "SortedEcho") {
      return await crackSortedEcho(host, details);
    }

    // ---- 候选列表过滤 + 遍历 ----
    // 仅对非交互式类型（有实际候选列表的）执行格式和长度过滤
    let candidates = rawCandidates;
    if (format === "numeric") candidates = rawCandidates.filter((c) => /^\d+$/.test(c));
    else if (format === "alphabetic") candidates = rawCandidates.filter((c) => /^[a-zA-Z]+$/.test(c));
    else if (format === "alphanumeric") candidates = rawCandidates.filter((c) => /^[a-zA-Z0-9]+$/.test(c));
    if (pwLen > 0) candidates = candidates.filter((c) => c.length === pwLen);

    if (candidates.length === 0) {
      return { success: false, needAnalysis: true, details };
    }

    for (const pwd of candidates) {
      try {
        const result = await ns.dnet.authenticate(host, pwd);
        if (result && result.success) {
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码="${pwd}" (${type})`);
          return { success: true, password: pwd, type };
        }
      } catch { /* 继续 */ }
    }

    return { success: false, needAnalysis: true, details };
  }

  // ======================== 各类型破解实现 ========================

  /** GuessNumber 二分法 */
  async function crackGuessNumber(host, details) {
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
      await ns.sleep(5);
    }
    return { success: false, needAnalysis: true, details };
  }

  /** Yesn't 逐字符探测 */
  async function crackYesnt(host, details, format) {
    const pwl = details.passwordLength || 0;
    if (pwl <= 0) return { success: false, needAnalysis: true, details };
    const charset = getCharset(format);
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
      await ns.sleep(5);
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

  /** BufferOverflow 缓冲区溢出 */
  async function crackBufferOverflow(host, details) {
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

  /** 计算 MasterMind 反馈：exact=位置正确数量，misplaced=存在但位置错误数量 */
  function computeMasterMindFeedback(password, guess) {
    // exact: 位置和字符完全匹配
    let exact = 0;
    const remainingPwd = [];
    const remainingGuess = [];
    for (let i = 0; i < password.length; i++) {
      if (password[i] === guess[i]) {
        exact++;
      } else {
        remainingPwd.push(password[i]);
        remainingGuess.push(guess[i]);
      }
    }
    // misplaced: 存在但位置不对（考虑重复，每个密码字符只匹配一次）
    let misplaced = 0;
    for (let i = 0; i < remainingGuess.length; i++) {
      const idx = remainingPwd.indexOf(remainingGuess[i]);
      if (idx !== -1) {
        misplaced++;
        remainingPwd.splice(idx, 1); // 移除已匹配的密码字符
      }
    }
    return [exact, misplaced];
  }

  /** MasterMind（Bulls and Cows）带反馈剪枝 */
  async function crackMasterMind(host, details, pwLen) {
    const format = details.passwordFormat || "";
    ns.print(`[${MY_HOST}] ${host}: MasterMind pwLen=${pwLen} format=${format}`);
    const pwLenNum = pwLen > 0 ? pwLen : 3;
    // 根据格式选择探测字符集
    const probeChars = format === "alphanumeric"
      ? "0123456789abcdefghijklmnopqrstuvwxyz"
      : "0123456789";
    // Phase 1: 探测每个字符在密码中的出现次数
    const charCounts = {};
    let foundTotal = 0;
    for (const ch of probeChars) {
      const probe = ch.repeat(pwLenNum);
      try {
        const result = await ns.dnet.authenticate(host, probe);
        if (result.success) {
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${probe} (MasterMind)`);
          return { success: true, password: probe, type: "MasterMind" };
        }
        if (result.data && typeof result.data === "string") {
          const parts = result.data.split(",");
          const exact = parseInt(parts[0]) || 0;
          const wrong = parseInt(parts[1]) || 0;
          const count = exact + wrong;
          if (count > 0) {
            charCounts[ch] = count;
            foundTotal += count;
          }
        }
      } catch { /* 继续 */ }
      await ns.sleep(5);
    }
    if (foundTotal !== pwLenNum) {
      ns.print(`[${MY_HOST}] ${host}: MasterMind 探测结果异常 (found=${foundTotal}, expected=${pwLenNum})`);
      return { success: false, needAnalysis: true, details };
    }
    // Phase 2+3: 迭代生成排列 + 实时验证 + 一致性剪枝
    // 不预生成全部排列（避免 n! 内存爆炸），改用 nextPermutation 逐个生成
    let charPool = "";
    for (const [ch, count] of Object.entries(charCounts)) {
      charPool += ch.repeat(count);
    }
    const arr = charPool.split("").sort();
    const totalPerms = factorial(arr.length);
    // 只在小规模时计算确切的排列数供日志使用
    ns.print(`[${MY_HOST}] ${host}: MasterMind 字符池="${charPool}" 理论排列数=${totalPerms}`);

    const feedbackHistory = []; // { guess, exact, misplaced }
    let attempts = 0;
    // 最多尝试 min(理论排列数, 200) 次，避免死循环
    const maxAttempts = Math.min(totalPerms > 0 ? totalPerms : 999999, 200);
    do {
      const candidate = arr.join("");

      // 一致性检查：跳过与任何历史反馈不一致的候选
      let consistent = true;
      for (const fb of feedbackHistory) {
        const [e, m] = computeMasterMindFeedback(candidate, fb.guess);
        if (e !== fb.exact || m !== fb.misplaced) {
          consistent = false;
          break;
        }
      }
      if (!consistent) continue;

      // 提交候选
      attempts++;
      try {
        const result = await ns.dnet.authenticate(host, candidate);
        if (result.success) {
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${candidate} (MasterMind 第${attempts}次)`);
          return { success: true, password: candidate, type: "MasterMind" };
        }
        if (result.data && typeof result.data === "string") {
          const parts = result.data.split(",");
          const actualExact = parseInt(parts[0]) || 0;
          const actualMisplaced = parseInt(parts[1]) || 0;
          if (actualExact === pwLenNum) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${candidate} (MasterMind)`);
            return { success: true, password: candidate, type: "MasterMind" };
          }
          // 记录反馈供后续候选剪枝
          feedbackHistory.push({ guess: candidate, exact: actualExact, misplaced: actualMisplaced });
          ns.print(`[${MY_HOST}] ${host}: MasterMind 第${attempts}次 (exact=${actualExact}, misplaced=${actualMisplaced}) 历史=${feedbackHistory.length}条`);
        }
      } catch { /* 继续 */ }
      await ns.sleep(3); // 降低 sleep 减少总耗时
    } while (nextPermutation(arr) && attempts < maxAttempts);
    ns.print(`[${MY_HOST}] ${host}: MasterMind ${attempts}次尝试后失败`);
    return { success: false, needAnalysis: true, details };
  }

  /** TimingAttack：利用索引反馈和响应时间逐位破解 */
  async function crackTimingAttack(host, details, format, pwLen) {
    const pwl = pwLen > 0 ? pwLen : 8;
    const charset = getCharset(format);
    // 用第一个字符填充初始 probe
    let known = charset[0].repeat(pwl);
    // 逐步替换每位的字符
    for (let pos = 0; pos < pwl; pos++) {
      let found = false;
      for (const ch of charset) {
        const probe = known.substring(0, pos) + ch + known.substring(pos + 1);
        try {
          const result = await ns.dnet.authenticate(host, probe);
          if (result.success) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${probe} (TimingAttack)`);
            return { success: true, password: probe, type: "TimingAttack" };
          }
          // message 格式: "Found a mismatch while checking each character (N)"
          // N 是第一个不匹配的索引。如果 N > pos，说明位置 pos 已正确
          if (result.message && typeof result.message === "string") {
            const idxMatch = result.message.match(/\((\d+)\)/);
            if (idxMatch) {
              const mismatchIdx = parseInt(idxMatch[1]);
              if (mismatchIdx > pos) {
                // 当前位置正确，将该字符固定到 known
                known = known.substring(0, pos) + ch + known.substring(pos + 1);
                found = true;
                break;
              }
            }
          }
          // 后备策略：检查响应时间
          if (result.data && typeof result.data === "string") {
            const timeMatch = result.data.match(/Response time:\s*(\d+)/);
            if (timeMatch) {
              // 响应时间可用于校验，但我们主要依赖 hint 中的索引
            }
          }
        } catch { /* 继续 */ }
        await ns.sleep(5);
      }
      if (!found) {
        // 如果当前位置没找到，保留原字符继续
      }
    }
    // 最终尝试完整的 known
    try {
      const result = await ns.dnet.authenticate(host, known);
      if (result.success) {
        ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${known} (TimingAttack)`);
        return { success: true, password: known, type: "TimingAttack" };
      }
    } catch { /* 继续 */ }
    return { success: false, needAnalysis: true, details };
  }

  /** SpiceLevel：利用 🌶️ 计数推断正确字符（优化版） */
  async function crackSpiceLevel(host, details, format, pwLen) {
    const pwl = pwLen > 0 ? pwLen : 8;
    const fullCharset = getCharset(format);
    // Phase 1: 快速过滤 charset——找出密码中实际出现的字符
    // 对每个 ch 测试 ch.repeat(pwl)，如果 🌶️>0 则 ch 在密码中
    const activeChars = [fullCharset[0]]; // charset[0] 始终在候选集中
    try {
      const baseResult = await ns.dnet.authenticate(host, fullCharset[0].repeat(pwl));
      if (baseResult.success) {
        ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${fullCharset[0].repeat(pwl)} (SpiceLevel)`);
        return { success: true, password: fullCharset[0].repeat(pwl), type: "SpiceLevel" };
      }
    } catch { /* 继续 */ }
    for (const ch of fullCharset) {
      if (ch === fullCharset[0]) continue;
      try {
        const probe = ch.repeat(pwl);
        const result = await ns.dnet.authenticate(host, probe);
        if (result.success) {
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${probe} (SpiceLevel)`);
          return { success: true, password: probe, type: "SpiceLevel" };
        }
        const count = countPeppers(result.data);
        if (count > 0) activeChars.push(ch);
      } catch { /* 继续 */ }
      await ns.sleep(3);
    }
    ns.print(`[${MY_HOST}] ${host}: SpiceLevel 有效字符集=[${activeChars.join(",")}] (原始=${fullCharset.length}→${activeChars.length})`);

    // Phase 2: 逐位确定——用 activeChars（缩减后的字符集）做线性扫描
    let known = fullCharset[0].repeat(pwl);
    let baseCount = 0;
    try {
      const baseResult = await ns.dnet.authenticate(host, known);
      if (baseResult.success) {
        ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${known} (SpiceLevel)`);
        return { success: true, password: known, type: "SpiceLevel" };
      }
      baseCount = countPeppers(baseResult.data);
    } catch { /* 继续 */ }
    const usedCharCounts = {}; // 跟踪每个字符已被放置的次数
    for (let pos = 0; pos < pwl; pos++) {
      let bestCh = known[pos];
      let bestCount = baseCount;
      for (const ch of activeChars) {
        if (ch === fullCharset[0]) continue;
        // 如果该字符已经用完了"出现的总次数"，跳过（防止无效重复尝试）
        const probe = known.substring(0, pos) + ch + known.substring(pos + 1);
        try {
          const result = await ns.dnet.authenticate(host, probe);
          if (result.success) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${probe} (SpiceLevel)`);
            return { success: true, password: probe, type: "SpiceLevel" };
          }
          const count = countPeppers(result.data);
          if (count > bestCount) {
            bestCount = count;
            bestCh = ch;
          }
        } catch { /* 继续 */ }
        await ns.sleep(3);
      }
      // 如果找到更好的字符，更新 known 和基准
      if (bestCh !== known[pos]) {
        known = known.substring(0, pos) + bestCh + known.substring(pos + 1);
        baseCount = bestCount;
        usedCharCounts[bestCh] = (usedCharCounts[bestCh] || 0) + 1;
      }
    }
    try {
      const result = await ns.dnet.authenticate(host, known);
      if (result.success) {
        ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${known} (SpiceLevel)`);
        return { success: true, password: known, type: "SpiceLevel" };
      }
    } catch { /* 继续 */ }
    return { success: false, needAnalysis: true, details };
  }

  /** 从 SpiceLevel 反馈 data 中提取 🌶️ 数量 */
  function countPeppers(data) {
    if (!data || typeof data !== "string") return 0;
    // 🌶 是 U+1F336，️ 是变体选择器 U+FE0F，每个 🌶️ 占 2 个 JS 字符
    // 用 match 计数时只统计 🌶 基字符数量
    const peppers = data.match(/\u{1F336}/gu);
    return peppers ? peppers.length : 0;
  }

  /**
   * 判断 auth 结果是否为「是因数」
   * 兼容 result.data / result.message / heartbleed 日志 三种反馈途径
   */
  function isDivisible(result) {
    if (result.data === "true") return true;
    if (result.data === "false") return false;
    const msg = (result.message || "").toString();
    if (msg.includes("IS divisible")) return true;
    if (msg.includes("is not divisible")) return false;
    return null;
  }

  /** 从 heartbleed 日志中提取最后一次 auth 的 data 字段 */
  async function getLastAuthData(ns, host) {
    try {
      const hb = await ns.dnet.heartbleed(host, { logsToCapture: 1, peek: true });
      const logStr = hb.logs?.[0] || "";
      const dataMatch = logStr.match(/"data":"([^"]+)"/);
      return dataMatch ? dataMatch[1] : null;
    } catch { return null; }
  }

  /** 尝试提交一个值作为密码（如果成功直接返回结果） */
  async function trySubmit(host, value) {
    try {
      const r = await ns.dnet.authenticate(host, value.toString());
      if (r.success) return { ok: true, pwd: value.toString() };
      return { ok: false, result: r };
    } catch { return { ok: false, result: null }; }
  }

  /** DivisibilityTest 强化版：质因数分解 + 即时提交 + 快速路径 */
  async function crackDivisibilityTest(host, details, pwLen) {
    const maxPwdVal = pwLen > 0 ? BigInt(10) ** BigInt(pwLen) : 0n;

    // === 快速路径：直接测试 2~min(99,10^pwLen) 的每个整数 ===
    // 对于短密码（pwLen≤2），测试全部整数比逐个测质数再试幂更快
    const quickMax = pwLen <= 2 ? Number(maxPwdVal) - 1 : 20;
    let accumulated = 1n;
    for (let n = 2; n <= quickMax; n++) {
      if (maxPwdVal > 0n && accumulated * BigInt(n) > maxPwdVal) break;
      // 如果 n 能被已有的 accumulated 整除，跳过（它的因子已被覆盖）
      if (accumulated > 1n && BigInt(n) % accumulated === 0n) continue;

      const { ok, result } = await trySubmit(host, n);
      if (ok) {
        ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${n} (DivisibilityTest-快速)`);
        return { success: true, password: String(n), type: "DivisibilityTest" };
      }
      const div = result ? isDivisible(result) : null;
      if (div === true) {
        // n 是密码的因数 → 累乘
        accumulated *= BigInt(n);
        // 提交 accumulated 看是否就是密码
        if (accumulated > 1n) {
          const { ok: ok2 } = await trySubmit(host, accumulated.toString());
          if (ok2) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${accumulated} (DivisibilityTest-累乘)`);
            return { success: true, password: accumulated.toString(), type: "DivisibilityTest" };
          }
        }
        if (maxPwdVal > 0n && accumulated >= maxPwdVal) break;
      } else if (div === null) {
        // 无法判断 → 读日志
        const data = await getLastAuthData(ns, host);
        if (data === "true") {
          accumulated *= BigInt(n);
          if (accumulated > 1n) {
            const { ok: ok2 } = await trySubmit(host, accumulated.toString());
            if (ok2) {
              ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${accumulated} (DivisibilityTest)`);
              return { success: true, password: accumulated.toString(), type: "DivisibilityTest" };
            }
          }
          if (maxPwdVal > 0n && accumulated >= maxPwdVal) break;
        }
      }
      await ns.sleep(5);
    }

    // === 质数路径：继续测试剩余大质数（pwLen>2 时的真正主力）===
    // 跳过已经在快速路径中测过的
    const testedSet = new Set();
    for (let n = 2; n <= quickMax; n++) {
      for (let m = n; m <= Number(maxPwdVal); m += n) testedSet.add(m);
    }
    const relevantPrimes = [];
    for (const p of [...smallPrimes, ...largePrimes]) {
      if (maxPwdVal > 0n && BigInt(p) >= maxPwdVal) break;
      if (p <= quickMax) continue; // 已在快速路径中测过
      relevantPrimes.push(p);
    }

    for (const p of relevantPrimes) {
      if (maxPwdVal > 0n && accumulated * BigInt(p) > maxPwdVal) break;
      // ★ 高效幂测试：用二分法找最大指数
      // 先快速确定上界：反复平方直到 false
      let low = BigInt(p);
      let high = low;
      while (true) {
        if (maxPwdVal > 0n && high > maxPwdVal) { high = maxPwdVal; break; }
        const { ok, result } = await trySubmit(host, high.toString());
        if (ok) {
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${high} (DivisibilityTest)`);
          return { success: true, password: high.toString(), type: "DivisibilityTest" };
        }
        const div = result ? isDivisible(result) : null;
        if (div === true || (div === null && await getLastAuthData(ns, host) === "true")) {
          accumulated *= BigInt(p);
          // 每找到一个因子就提交累积值（极大概率提前找到密码）
          if (accumulated > 1n) {
            const { ok: ok2 } = await trySubmit(host, accumulated.toString());
            if (ok2) {
              ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${accumulated} (DivisibilityTest-质数)`);
              return { success: true, password: accumulated.toString(), type: "DivisibilityTest" };
            }
          }
          if (maxPwdVal > 0n && accumulated >= maxPwdVal) break;
          low = high;
          high = high * BigInt(p);
        } else {
          high = low; // 回退到上一个已知 true
          break;
        }
        await ns.sleep(5);
      }
    }

    // === 兜底：累积值或单个质数 ===
    if (accumulated > 1n) {
      const { ok } = await trySubmit(host, accumulated.toString());
      if (ok) {
        ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${accumulated} (DivisibilityTest)`);
        return { success: true, password: accumulated.toString(), type: "DivisibilityTest" };
      }
    }
    // 最后的努力：如果什么因子都没找到，密码可能是 1
    if (accumulated === 1n && pwLen > 0) {
      for (const guess of ["1", "0"]) {
        const { ok } = await trySubmit(host, guess);
        if (ok) {
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${guess} (DivisibilityTest-兜底)`);
          return { success: true, password: guess, type: "DivisibilityTest" };
        }
      }
    }
    return { success: false, needAnalysis: true, details };
  }

  /** TripleModulo：同余方程组 + 中国剩余定理 */
  async function crackTripleModulo(host, details, pwLen) {
    const maxPwd = BigInt(10) ** BigInt(Math.max(pwLen, 3));
    const remainders = new Map(); // d -> r   (password % d == r)
    // 选择 n 值使 d = ((n-1) % 32) + 1 覆盖尽可能多的模数
    for (let n = 2; n <= 100; n++) {
      const d = ((n - 1) % 32) + 1;
      if (remainders.has(d)) continue;
      try {
        const result = await ns.dnet.authenticate(host, String(n));
        if (result.success) {
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${n} (TripleModulo)`);
          return { success: true, password: String(n), type: "TripleModulo" };
        }
        const r = parseInt(result.data);
        if (!isNaN(r)) {
          remainders.set(d, r);
        }
      } catch { /* 继续 */ }
      await ns.sleep(5);
      // 收集到足够信息就尝试求解
      if (remainders.size >= 5) {
        const pwd = solveCRT(remainders, maxPwd);
        if (pwd !== null) {
          try {
            const check = await ns.dnet.authenticate(host, pwd);
            if (check.success) {
              ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${pwd} (TripleModulo)`);
              return { success: true, password: pwd, type: "TripleModulo" };
            }
          } catch { /* 继续 */ }
        }
      }
    }
    // 暴力搜索最后的可能性
    const pwd = solveCRT(remainders, maxPwd);
    if (pwd !== null) {
      try {
        const check = await ns.dnet.authenticate(host, pwd);
        if (check.success) {
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${pwd} (TripleModulo)`);
          return { success: true, password: pwd, type: "TripleModulo" };
        }
      } catch { /* 继续 */ }
    }
    return { success: false, needAnalysis: true, details };
  }

  /** CRT 求解：从同余式集合中找到最小的正整数解（≤ maxVal） */
  function solveCRT(remainders, maxVal) {
    const entries = [...remainders.entries()].filter(([d]) => d > 1);
    if (entries.length === 0) return null;
    // 中国剩余定理：找 x 满足 x ≡ r_i (mod d_i) 对所有 i
    // 用增量法：x = r1, M = d1, 然后 x = x + k*M 直到满足下一个同余式
    let x = BigInt(entries[0][1] % entries[0][0]);
    let M = BigInt(entries[0][0]);
    for (let i = 1; i < entries.length; i++) {
      const d = BigInt(entries[i][0]);
      const r = BigInt(entries[i][1] % entries[i][0]);
      // 找 k 使 (x + k*M) % d == r
      let found = false;
      for (let k = 0n; k < d; k++) {
        if ((x + k * M) % d === r) {
          x = x + k * M;
          M *= d;
          found = true;
          break;
        }
      }
      if (!found) return null; // 无解
    }
    if (x > maxVal) return null;
    return x.toString();
  }

  /** GlobalMaxima（King of the Hill）：登山算法（优化版） */
  async function crackGlobalMaxima(host, details, pwLen) {
    const maxVal = BigInt(10) ** BigInt(Math.max(pwLen, 3));
    // Phase 1: 自适应粗扫——按指数级步长扫描，找到候选山峰
    const peaks = []; // { x, altitude }
    let step = 1n;
    // 第一阶段步长：先粗后细，步长 = 1, 2, 4, 8, ... 直到覆盖全范围
    while (step < maxVal / 10n) step *= 2n; // 起始步长约为 maxVal/10
    for (let x = 0n; x < maxVal; ) {
      try {
        const result = await ns.dnet.authenticate(host, x.toString());
        if (result.success) {
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${x} (GlobalMaxima)`);
          return { success: true, password: x.toString(), type: "GlobalMaxima" };
        }
        const alt = parseAltitude(result.data);
        peaks.push({ x, alt });
      } catch { /* 继续 */ }
      // 自适应：如果海拔上升，放慢步长精细扫描；下降则加快
      if (peaks.length >= 2) {
        const prev = peaks[peaks.length - 2].alt;
        const curr = peaks[peaks.length - 1].alt;
        if (curr > prev && step > 1n) step /= 2n; // 上坡→细化
        else if (curr < prev) step *= 2n; // 下坡→加速
      }
      await ns.sleep(3);
      x += step;
      if (x >= maxVal) break;
      // 确保步长不越界
      if (x + step > maxVal) step = maxVal - x;
    }

    // 对 peaks 按海拔排序，取 top 3 候选山峰
    peaks.sort((a, b) => b.alt - a.alt);
    const topPeaks = peaks.slice(0, Math.min(3, peaks.length));
    ns.print(`[${MY_HOST}] ${host}: GlobalMaxima top ${topPeaks.length} peaks`);

    // Phase 2: 对每个候选山峰做黄金分割局部搜索
    for (const peak of topPeaks) {
      const searchRange = step > 1n ? step * 2n : maxVal / 100n > 1n ? maxVal / 100n : 10n;
      let lo = peak.x - searchRange > 0n ? peak.x - searchRange : 0n;
      let hi = peak.x + searchRange < maxVal ? peak.x + searchRange : maxVal - 1n;
      // 黄金分割搜索（适用于单峰函数）
      const phi = 0.618;
      let a = lo, b = hi;
      let x1 = a + (b - a) * (1 - phi);
      let x2 = a + (b - a) * phi;
      let f1 = -Infinity, f2 = -Infinity;
      const goldenMaxAttempts = 60;
      for (let iter = 0; iter < goldenMaxAttempts; iter++) {
        if (b - a <= 1n) {
          // 最终验证
          for (let test = a; test <= b; test++) {
            const r = await ns.dnet.authenticate(host, test.toString());
            if (r.success) {
              ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${test} (GlobalMaxima-黄金分割)`);
              return { success: true, password: test.toString(), type: "GlobalMaxima" };
            }
          }
          break;
        }
        // 获取 f(x1) 和 f(x2)
        if (f1 === -Infinity) {
          const r1 = await ns.dnet.authenticate(host, x1.toString());
          if (r1.success) { ns.tprint(`✅ 密码=${x1} (GlobalMaxima)`); return { success: true, password: x1.toString(), type: "GlobalMaxima" }; }
          f1 = parseAltitude(r1.data);
        }
        if (f2 === -Infinity) {
          const r2 = await ns.dnet.authenticate(host, x2.toString());
          if (r2.success) { ns.tprint(`✅ 密码=${x2} (GlobalMaxima)`); return { success: true, password: x2.toString(), type: "GlobalMaxima" }; }
          f2 = parseAltitude(r2.data);
        }
        if (f1 > f2) {
          b = x2;
          x2 = x1;
          f2 = f1;
          x1 = a + (b - a) * (1 - phi);
          f1 = -Infinity;
        } else {
          a = x1;
          x1 = x2;
          f1 = f2;
          x2 = a + (b - a) * phi;
          f2 = -Infinity;
        }
        await ns.sleep(3);
      }
    }
    return { success: false, needAnalysis: true, details };
  }

  /** 从 GlobalMaxima 反馈中提取海拔 */
  function parseAltitude(data) {
    if (!data || typeof data !== "string") return -Infinity;
    const match = data.match(/(-?\d+\.?\d*)/);
    return match ? parseFloat(match[1]) : -Infinity;
  }

  /** PacketSniffer：读取服务器日志 + auth data 提取密码 */
  async function crackPacketSniffer(host, details) {
    // 策略1：通过 heartbleed 读取服务器日志，查找密码泄露
    try {
      const hbResult = await ns.dnet.heartbleed(host, { logsToCapture: 200, peek: true });
      const logs = hbResult.logs || [];
      for (const msg of logs) {
        if (typeof msg !== "string") continue;
          // 模式: "Logging in with passcode: {password} ..."
          let pwMatch = msg.match(/passcode:\s*(\S+)/);
          if (pwMatch) {
            const pwd = pwMatch[1].replace(/[^a-zA-Z0-9]/g, "");
            if (pwd) {
              const result = await ns.dnet.authenticate(host, pwd);
              if (result.success) {
                ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${pwd} (PacketSniffer-日志)`);
                return { success: true, password: pwd, type: "PacketSniffer" };
              }
            }
          }
          // 模式: "Connecting to {host}:{password} ..."
          pwMatch = msg.match(/:(\w+)\s*\.\.\./);
          if (pwMatch) {
            const pwd = pwMatch[1];
            if (pwd && pwd.length >= 1) {
              const result = await ns.dnet.authenticate(host, pwd);
              if (result.success) {
                ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${pwd} (PacketSniffer-日志)`);
                return { success: true, password: pwd, type: "PacketSniffer" };
              }
            }
          }
          // 模式: "--{password}--"
          pwMatch = msg.match(/--(\w+)--/);
          if (pwMatch) {
            const pwd = pwMatch[1];
            if (pwd) {
              const result = await ns.dnet.authenticate(host, pwd);
              if (result.success) {
                ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${pwd} (PacketSniffer-日志)`);
                return { success: true, password: pwd, type: "PacketSniffer" };
              }
            }
          }
        }
      }
    } catch { /* heartbleed 可能不可用 */ }

    // 策略2：从 auth data 中提取密码
    const data = details.data || "";
    if (data) {
      // 低难度格式: " {hostname}:{password} "
      const hostname = details.hostname || host;
      const hostPwMatch = data.match(new RegExp(hostname + ":(\\w+)"));
      if (hostPwMatch) {
        const pwd = hostPwMatch[1];
        if (pwd) {
          const result = await ns.dnet.authenticate(host, pwd);
          if (result.success) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${pwd} (PacketSniffer-data)`);
            return { success: true, password: pwd, type: "PacketSniffer" };
          }
        }
      }
      // 通用模式：尝试从文本中提取数字/字母组合
      const words = data.match(/\b(\w{3,15})\b/g);
      if (words) {
        const unique = [...new Set(words)];
        for (const w of unique) {
          if (w.length >= 1 && w.length <= 15) {
            try {
              const result = await ns.dnet.authenticate(host, w);
              if (result.success) {
                ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${w} (PacketSniffer-data)`);
                return { success: true, password: w, type: "PacketSniffer" };
              }
            } catch { /* 继续 */ }
            await ns.sleep(2);
          }
        }
      }
    }

    return { success: false, needAnalysis: true, details };
  }

  /** Labyrinth：迷宫寻路 */
  async function crackLabyrinth(host, details) {
    // 尝试方向指令: N, S, E, W
    const directions = [
      { cmd: "N", dx: 0, dy: -2 },
      { cmd: "S", dx: 0, dy: 2 },
      { cmd: "E", dx: 2, dy: 0 },
      { cmd: "W", dx: -2, dy: 0 },
      { cmd: "go north", dx: 0, dy: -2 },
      { cmd: "go south", dx: 0, dy: 2 },
      { cmd: "go east", dx: 2, dy: 0 },
      { cmd: "go west", dx: -2, dy: 0 },
    ];
    // DFS 探索迷宫
    const visited = new Set();
    const stack = [{ x: 1, y: 1, path: [] }];
    let maxAttempts = 500;
    while (stack.length > 0 && maxAttempts > 0) {
      maxAttempts--;
      const { x, y, path } = stack.pop();
      const key = `${x},${y}`;
      if (visited.has(key)) continue;
      visited.add(key);
      // 对每个方向，提交移动指令
      for (const dir of directions) {
        const newX = x + dir.dx;
        const newY = y + dir.dy;
        const newKey = `${newX},${newY}`;
        if (visited.has(newKey)) continue;
        try {
          const result = await ns.dnet.authenticate(host, dir.cmd);
          if (result.success) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 迷宫破解成功!`);
            // 返回成功路径
            const fullPath = [...path, dir.cmd];
            return { success: true, password: fullPath.join(";"), type: "Labyrinth" };
          }
          if (result.message && typeof result.message === "string") {
            if (result.message.includes("cannot go that way")) {
              continue; // 墙，跳过
            }
            if (result.message.includes("moved to")) {
              // 移动成功，将新位置入栈
              stack.push({ x: newX, y: newY, path: [...path, dir.cmd] });
            }
          }
        } catch { /* 继续 */ }
        await ns.sleep(10);
      }
    }
    return { success: false, needAnalysis: true, details };
  }

  /** RomanNumeralRange：高难度罗马数字范围+二分搜索 */
  async function crackRomanNumeralRange(host, low, high) {
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const guess = String(mid);
      try {
        const result = await ns.dnet.authenticate(host, guess);
        if (result.success) {
          ns.tprint(`✅ 破解成功! 密码=${guess} (RomanNumeralRange)`);
          return { success: true, password: guess, type: "RomanNumeralRange" };
        }
        // 反馈: "ALTUS NIMIS" = 太高, "PARUM BREVIS" = 太低
        if (result.data === "ALTUS NIMIS" || (typeof result.data === "string" && result.data.includes("ALTUS"))) {
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      } catch { /* 继续 */ }
      await ns.sleep(5);
    }
    return { success: false, needAnalysis: true };
  }

  // ======================== 主逻辑 ========================

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

  ns.tprint(`🔓 [${MY_HOST}] dnet-worm v3.1 (全模式破译) 启动`);
  while (true) {
    let neighbors = [];
    try {
      neighbors = ns.dnet.probe() || [];
    } catch (e) {
      if (String(e).includes("not a darknet server")) {
        ns.tprint(`❌ [${MY_HOST}] 本机不是暗网服务器`);
        return;
      }
      await ns.sleep(2000);
      continue;
    }
    if (neighbors.length === 0) {
      await ns.sleep(3000);
      continue;
    }
    for (const host of neighbors) {
      const result = await crackServer(host);
      writeResult(host, result.success, result.password, result.type, result.needAnalysis, result.details || null);
    }
    await ns.sleep(5000);
  }
}

export function autocomplete(data, args) {
  return ["--target-only", ...data.servers];
}
