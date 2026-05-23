/**
 * dnet-worm.js — 暗网蠕虫 v1.0
 *
 * 自复制暗网蠕虫脚本。
 * 工作流程:
 *   1. 探测直接相连的暗网服务器 (ns.dnet.probe)
 *   2. 根据密码表/提示特征尝试破解 (ns.dnet.authenticate)
 *   3. 释放目标服务器被占用的内存 (ns.dnet.memoryReallocation)
 *   4. 把自身复制到目标服务器 (ns.scp)
 *   5. 在目标服务器启动自身实例 → 继续扩散 (ns.exec)
 *   6. 打开目标服务器的缓存文件 (ns.dnet.openCache)
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
  const MAX_HOPS = ns.args.includes("--max-hops") ? parseInt(ns.args[ns.args.indexOf("--max-hops") + 1]) : 999;
  const TARGET_ONLY = ns.args.includes("--target-only");
  const TARGET_HOST = TARGET_ONLY ? ns.args[ns.args.indexOf("--target-only") + 1] : null;
  const PROPAGATE = !TARGET_ONLY; // 是否扩散

  // home 控制器主机名（用于回报/指令轮询，--controller home）
  const CONTROLLER = ns.args.includes("--controller") ? ns.args[ns.args.indexOf("--controller") + 1] : null;
  const REPORT_BASE = "/Temp/dnet-worm-";

  // 已知已感染的主机集（通过文件持久化，避免环路扩散）
  const INFECTED_FILE = "/Temp/dnet-worm-infected.txt";
  let infectedSet = new Set();
  try {
    const raw = ns.read(INFECTED_FILE);
    if (raw) JSON.parse(raw).forEach((h) => infectedSet.add(h));
  } catch { /* 首次运行，干净状态 */ }

  // 本机主机名
  const MY_HOST = ns.getHostname();

  // ======================== 密码字典 ========================
  // 通用常见密码（来自游戏源码 commonPasswordDictionary）
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

  /** 根据提示特征为服务器生成密码候选列表 */
  function getCandidates(details) {
    const hint = ((details.passwordHint || details.staticPasswordHint) || "").toLowerCase();

    // --- 模式 1: NoPassword（无密码） ---
    if (hint.includes("no password") || hint.includes("not set") || hint.includes("empty") ||
        hint.includes("did i set") || hint.includes("didn't set") || hint.includes("didn't set a")) {
      return { type: "NoPassword", candidates: [""] };
    }

    // --- 模式 2: DefaultPassword（默认密码，必须在 EchoVuln 前） ---
    // 源码: defaultSettingsDictionary = ["admin", "password", "0000", "12345"]
    // 提示模板含 "The password is the default password" → 会被 EchoVuln 误匹配提取最后一个词 "password"
    // 因此 DefaultPassword 必须在 EchoVuln 前面检查
    if (hint.includes("default") || hint.includes("factory") || hint.includes("never changed") ||
        hint.includes("still the")) {
      return { type: "DefaultPassword", candidates: DEFAULT_PASSWORDS };
    }

    // --- 模式 3: EchoVuln（提示直接包含密码） ---
    // 源码: getPassword(3) → 纯数字密码 → 提示格式 "The password is <数字>"
    // 注意: 最后一个词必须是纯数字（否则可能是 DefaultPassword 或别的类型）
    if (hint.includes("the password is") || hint.includes("the pin is") || hint.includes("the key is") ||
        hint.includes("it's set to") || hint.includes("remember to use") || hint.includes("the secret is")) {
      const words = hint.split(" ");
      const lastWord = words[words.length - 1].replace(/[^a-zA-Z0-9]/g, "");
      // EchoVuln 密码来自 getPassword(3) → 纯数字、长度 1-3 位（Number().toString() 去掉前导零）
      if (lastWord && /^\d+$/.test(lastWord) && lastWord.length <= 3) {
        return { type: "EchoVuln", candidates: [lastWord] };
      }
      // 如果最后一个词不是数字，不匹配 EchoVuln，继续检查后面的模式
    }

    // --- 模式 4: DogNames（狗名） ---
    if (hint.includes("dog") || hint.includes("fido") || hint.includes("spot") || hint.includes("rover")) {
      return { type: "DogNames", candidates: DOG_NAMES };
    }

    // --- 模式 5: Captcha（验证码） ---
    if (hint.includes("captcha") || hint.includes("human") || hint.includes("prove")) {
      // 验证码的密码数据是混入了干扰字符的文本，需要过滤非数字
      const rawData = details.data || "";
      if (rawData) {
        const filtered = rawData.replace(/[^0-9]/g, "");
        if (filtered && filtered.length <= 15) {
          return { type: "Captcha", candidates: [filtered] };
        }
      }
    }

    // --- 模式 6: GuessNumber（猜数字） ---
    // 源码: getGuessNumberConfig → password = Math.floor(random*10*(difficulty+3)/3)
    //       maxNumber = 10^password.length, 提示 "between 0 and ${maxNumber}"
    // 策略: crackServer 中使用二分法（authenticate 返回 data: "Higher"/"Lower"）
    if (hint.includes("number between") || hint.includes("guess")) {
      return { type: "GuessNumber", candidates: [] };
    }

    // --- 模式 7: NIL / Yesn't（逐字符反馈） ---
    // 源码: data 返回 "yes,yesn't,yes,..." 每个位置标记字符是否正确
    // 策略: 用同一字符重复 length 次去试，data 中标 yes 的位置即用该字符
    if (hint.includes("you are one who") || hint.includes("who's'nt") || hint.includes("'s'nt authorized")) {
      return { type: "Yesn't", candidates: [] };
    }

    // --- 模式 8: BufferOverflow（缓冲区溢出） ---
    // 源码: 输入 2N 长度的相同字符可使 receivedBuffer === expectedValueBuffer
    //       提示 "Warning: password buffer is N bytes"
    // 策略: 输入 "■".repeat(2 * N) 直接通过
    if (hint.includes("password buffer") || hint.includes("buffer is")) {
      return { type: "BufferOverflow", candidates: [] };
    }

    // --- 模式 9: LargestPrimeFactor（最大质因数） ---
    if (hint.includes("largest prime factor") || hint.includes("prime factor")) {
      // 这需要计算，先跳过，用通用字典
      return { type: "PrimeFactor", candidates: COMMON_PASSWORDS };
    }

    // --- 模式 8: SortedEchoVuln（排序后的密码字符） ---
    // 源码: getPassword() → 纯数字密码 → split→sort→join 得到排序后的字符串
    // 例如: 密码 "838" 排序后为 "388", 提示 "I accidentally sorted the password: 388"
    // 解法: 对排序后的字符生成所有不重复排列, 逐一尝试
    if (hint.includes("shuffled") || hint.includes("sorted") || hint.includes("accidentally sorted") ||
        hint.includes("made from")) {
      // 优先从 details.data (passwordHintData) 提取排序后的字符串
      let sortedStr = (details.data || "").trim();
      // 如果 data 为空, 尝试从提示文本末尾提取（"I accidentally sorted the password: 388" 取最后一个词）
      if (!sortedStr) {
        const words = hint.split(" ");
        const last = words[words.length - 1].replace(/[^a-zA-Z0-9]/g, "");
        if (last && /^\d+$/.test(last)) sortedStr = last;
      }
      // 纯数字密码: 取有效数字部分（Number().toString() 会去掉前导零）
      if (sortedStr && /^\d+$/.test(sortedStr)) {
        sortedStr = Number(sortedStr).toString();
      }
      if (sortedStr && sortedStr.length >= 1 && sortedStr.length <= 6) {
        const perms = getUniquePermutations(sortedStr);
        ns.print(`[${MY_HOST}] SortedEcho: "${sortedStr}" → ${perms.length} 个排列待尝试`);
        return { type: "SortedEcho", candidates: perms };
      }
      // 降级: 通用字典
      if (sortedStr && sortedStr.length > 6) {
        ns.print(`[${MY_HOST}] SortedEcho: 密码过长(${sortedStr.length}), 降级为字典攻击`);
      }
    }

    // --- 模式 9: 罗马数字 ---
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

    // --- 模式 10: BinaryEncoded（二进制编码） ---
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

    // --- 模式 11: 通用字典模式 ---
    return { type: "Dictionary", candidates: COMMON_PASSWORDS };
  }

  /** 生成字符串的所有不重复排列（用于 SortedEchoVuln 破解） */
  function getUniquePermutations(str) {
    if (str.length <= 1) return [str];
    const result = [];
    const seen = new Set();
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      // 相同字符在同一位置只处理一次（去重）
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
          await reportCrack(host, "", "NoPassword");
          return true;
        }
      } catch (e) { /* 继续 */ }
      ns.print(`[${MY_HOST}] ${host}: 空密码尝试失败`);
      return false;
    }

    // 根据密码格式过滤无效候选，免去无意义的 authenticate 调用
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
    // 同时按密码长度过滤（已知长度时）
    if (pwLen > 0) {
      candidates = candidates.filter((c) => c.length === pwLen);
    }

    ns.print(`[${MY_HOST}] ${host}: 尝试${type}(${candidates.length}/${rawCandidates.length}个候选, format=${format}, len=${pwLen}) hint="${(details.passwordHint || "").slice(0, 40)}"`);

    if (candidates.length === 0) {
      ns.print(`[${MY_HOST}] ${host}: 所有候选被过滤掉，跳过`);
      return false;
    }

    // GuessNumber 使用二分法（authenticate 返回 data: "Higher"/"Lower"）
    if (type === "GuessNumber") {
      // 从 hint 解析范围
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
            await reportCrack(host, guess, "GuessNumber");
            return true;
          }
          // data: "Lower" → 密码比猜的小, "Higher" → 密码比猜的大
          if (result.data === "Lower") {
            high = mid - 1;
          } else {
            low = mid + 1;
          }
        } catch (e) { /* 继续 */ }
        attempts++;
        await ns.sleep(50);
      }
      ns.print(`[${MY_HOST}] ${host}: 二分法失败`);
      return false;
    }

    // Yesn't: 逐字符反馈, 用同一字符重复 length 次去探测
    // data: "yesn't,yes,yesn't,yesn't,yesn't" → 位置1用当前字符
    if (type === "Yesn't") {
      const pwLen = details.passwordLength || 0;
      if (pwLen <= 0) {
        ns.print(`[${MY_HOST}] ${host}: Yesn't 未知密码长度，跳过`);
        return false;
      }
      // 根据格式选择探测字符集
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
            await reportCrack(host, probe, "Yesn't");
            return true;
          }
          // 解析 data: "yesn't,yes,yesn't,..."
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

        // 提前退出: 所有位置都已确定
        if (password.every((c) => c !== null)) break;
      }

      if (password.every((c) => c !== null)) {
        const finalPwd = password.join("");
        try {
          const result = await ns.dnet.authenticate(host, finalPwd);
          if (result.success) {
            ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${finalPwd} (Yesn't)`);
            await reportCrack(host, finalPwd, "Yesn't");
            return true;
          }
        } catch (e) { /* 继续 */ }
      }
      ns.print(`[${MY_HOST}] ${host}: Yesn't 失败, 已确定: ${password.map(c=>c??'?').join('')}`);
      return false;
    }

    // BufferOverflow: 提示 "Warning: password buffer is N bytes"
    // 输入 "■".repeat(2*N) 使 receivedBuffer === expectedValueBuffer
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
            await reportCrack(host, "", "BufferOverflow");
            return true;
          }
        } catch (e) { /* 继续 */ }
      }
      ns.print(`[${MY_HOST}] ${host}: BufferOverflow 失败`);
      return false;
    }

    for (const pwd of candidates) {
      try {
        const result = await ns.dnet.authenticate(host, pwd);
        if (result && result.success) {
          const displayPwd = pwd === "" ? "(空)" : `"${pwd}"`;
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${displayPwd} (模式=${type})`);
          await reportCrack(host, pwd, type);
          return true;
        }
      } catch (e) {
        // 认证过程中服务器可能离线或网络超时，继续
      }
      // 轻微的延时避免 API 限速
      await ns.sleep(50);
    }

    ns.print(`[${MY_HOST}] ${host}: 所有密码尝试失败`);
    return false;
  }

  /** 释放目标服务器的被占用内存 */
  async function freeMemory(host) {
    try {
      const details = ns.dnet.getServerDetails(host);
      if (!details.isOnline) return false;
      if (details.blockedRam <= 0) {
        ns.print(`[${MY_HOST}] ${host}: 无被占用内存`);
        return true; // 没有阻塞内存也算成功
      }

      ns.print(`[${MY_HOST}] ${host}: 释放 ${ns.formatRam(details.blockedRam)} 阻塞内存...`);

      // 可能需要多次释放，因为每次只能释放一部分
      let attempts = 0;
      while (attempts < 20) {
        const r = await ns.dnet.memoryReallocation(host);
        if (r && r.success) {
          // 重新检查是否还有剩余阻塞内存
          await ns.sleep(100);
          const newDetails = ns.dnet.getServerDetails(host);
          if (newDetails.blockedRam <= 0) {
            ns.tprint(`✅ [${MY_HOST}] ${host}: 内存全部释放完毕`);
            return true;
          }
          ns.print(`[${MY_HOST}] ${host}: 剩余阻塞 ${ns.formatRam(newDetails.blockedRam)}`);
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

  /** 打开目标服务器上的缓存文件 */
  async function openCaches(host) {
    // openCache 必须在目标服务器本身上调用
    // ns.getServer() 不暴露 caches 属性，需用 ns.ls() 过滤出 .cache 文件
    if (host !== MY_HOST) {
      ns.print(`[${MY_HOST}] ${host}: openCache 需要在目标服务器上执行，传播后会由副本处理`);
      return true;
    }

    // 通过 ns.ls() 获取所有文件，过滤出缓存文件
    let cacheFiles = [];
    try {
      const allFiles = ns.ls(host);
      cacheFiles = allFiles.filter((f) => f.endsWith(".cache") || f.endsWith(".d.cache"));
      if (cacheFiles.length === 0) {
        ns.print(`[${MY_HOST}] 本机无缓存文件`);
        return true;
      }
      ns.print(`[${MY_HOST}] 发现 ${cacheFiles.length} 个缓存文件: ${cacheFiles.join(", ")}`);
    } catch (e) {
      ns.print(`[${MY_HOST}] 读取文件列表失败: ${e}`);
      return false;
    }

    let opened = 0;
    for (const cacheFile of cacheFiles) {
      try {
        const r = await ns.dnet.openCache(cacheFile, true); // suppressToast=true
        if (r && r.success) {
          ns.tprint(`🎁 [${MY_HOST}] 打开缓存 ${cacheFile}: ${r.message}`);
          opened++;
        } else {
          ns.print(`[${MY_HOST}] 打开缓存 ${cacheFile} 失败: ${r?.message}`);
        }
      } catch (e) {
        ns.print(`[${MY_HOST}] 打开缓存 ${cacheFile} 异常: ${e}`);
      }
      await ns.sleep(100);
    }
    ns.print(`[${MY_HOST}] 共打开 ${opened} 个缓存文件`);
    return true;
  }

  /** 将自身复制到目标服务器并启动副本 */
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

    // 复制脚本
    try {
      // 获取目标服务器的可用 RAM
      const serverMaxRam = ns.getServerMaxRam(host);
      const serverUsedRam = ns.getServerUsedRam(host);
      const scriptRam = ns.getScriptRam(SCRIPT_NAME, host);
      const availableRam = serverMaxRam - serverUsedRam;

      if (availableRam < scriptRam) {
        ns.print(`[${MY_HOST}] ${host} RAM不足(可用${ns.formatRam(availableRam)} < 需要${ns.formatRam(scriptRam)})，跳过传播`);
        return false;
      }

      const copied = await ns.scp(SCRIPT_NAME, host);
      if (!copied) {
        ns.print(`[${MY_HOST}] ${host}: SCP复制失败`);
        return false;
      }
      ns.print(`[${MY_HOST}] ${host}: 脚本已复制`);
    } catch (e) {
      ns.print(`[${MY_HOST}] ${host}: 复制异常 - ${e}`);
      return false;
    }

    // 启动副本
    try {
      const maxThreads = Math.floor(
        (ns.getServerMaxRam(host) - ns.getServerUsedRam(host)) / ns.getScriptRam(SCRIPT_NAME, host)
      );
      if (maxThreads <= 0) {
        ns.print(`[${MY_HOST}] ${host}: 没有足够RAM启动副本`);
        return false;
      }

      const pid = ns.exec(SCRIPT_NAME, host, maxThreads, "--max-hops", (hopCount + 1).toString());
      if (pid > 0) {
        markInfected(host);
        ns.tprint(`🚀 [${MY_HOST}] → ${host}: 副本已启动(PID=${pid})，深度=${hopCount + 1}`);
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

    // 步骤 3: 复制自身到目标并启动（传播）
    await propagateTo(host, hopCount);
  }

  /** 回报 home: 将破解信息写入文件并 scp 到控制器 */
  async function reportCrack(host, password, crackType) {
    if (!CONTROLLER) return;
    try {
      const details = ns.dnet.getServerDetails(host);
      const report = {
        host,
        password,
        type: crackType,
        depth: details.depth,
        difficulty: details.difficulty,
        format: details.passwordFormat,
        length: details.passwordLength,
        timestamp: Date.now(),
        reporter: MY_HOST,
      };
      const file = REPORT_BASE + "crack-" + host.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
      ns.write(file, JSON.stringify(report), "w");
      await ns.scp(file, CONTROLLER);
      ns.rm(file);
    } catch (e) { /* 回报非关键 */ }
  }

  /** 检查 home 下发的指令文件 */
  async function checkCommand() {
    if (!CONTROLLER) return;
    const cmdFile = REPORT_BASE + "cmd-" + MY_HOST.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
    try {
      if (!ns.fileExists(cmdFile)) return;
      const cmd = JSON.parse(ns.read(cmdFile));
      ns.rm(cmdFile);
      ns.print(`[${MY_HOST}] 执行指令: ${cmd.op || "批量"}`);
      for (const task of cmd.tasks || []) {
        if (task.op === "authenticate" && task.host && task.password) {
          const r = await ns.dnet.authenticate(task.host, task.password);
          if (r.success) { await reportCrack(task.host, task.password, "remote"); }
        }
        if (task.op === "freeMemory" && task.host) await freeMemory(task.host);
        if (task.op === "openCaches") await openCaches(MY_HOST);
        if (task.op === "migrate" && task.host) {
          await ns.dnet.induceServerMigration(task.host);
        }
      }
    } catch (e) { ns.print(`[${MY_HOST}] 指令异常: ${e}`); }
  }

  /** 所有邻居已攻破时，诱导其中一个向下迁移 */
  async function tryMigration() {
    if (!CONTROLLER) return;
    try {
      for (const n of ns.dnet.probe() || []) {
        if (infectedSet.has(n)) {
          const d = ns.dnet.getServerDetails(n);
          if (d.isOnline && !d.isStationary && d.depth < 35) {
            ns.print(`[${MY_HOST}] 迁移 ${n} 寻找新目标...`);
            for (let i = 0; i < 25; i++) {
              const r = await ns.dnet.induceServerMigration(n);
              if (r.success) { ns.print(`[${MY_HOST}] ${n} 迁移成功`); return; }
              await ns.sleep(100);
            }
            return;
          }
        }
      }
    } catch (e) { /* 迁移非关键 */ }
  }

  // ======================== 主循环 ========================

  // 如果是目标处理模式，只处理指定目标
  if (TARGET_ONLY && TARGET_HOST) {
    ns.tprint(`🎯 目标模式: 处理 ${TARGET_HOST}`);
    await processTarget(TARGET_HOST, 0);
    return;
  }

  // 获取当前跳数（从参数传递）
  const hopCount = ns.args.includes("--max-hops")
    ? (parseInt(ns.args[ns.args.indexOf("--max-hops") + 1]) - 1)
    : 0;

  ns.tprint(`="= [${MY_HOST}] 暗网蠕虫 v1.0 启动 (深度=${hopCount}/${MAX_HOPS}, 控制器=${CONTROLLER || "无"})`);

  while (true) {
    // 步骤 0: 打开本机缓存 + 检查指令
    await openCaches(MY_HOST);
    await checkCommand();

    // 步骤 1: 探测直接相连的暗网服务器
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
      // 无邻居时尝试迁移自己（由邻居触发）或等待
      await ns.sleep(10000);
      continue;
    }

    ns.print(`[${MY_HOST}] 邻居: ${neighbors.join(", ")}`);

    // 步骤 2-5: 处理每个邻居
    for (const host of neighbors) {
      await processTarget(host, hopCount);
    }

    // 所有邻居已攻破 → 诱导迁移
    if (neighbors.length > 0 && neighbors.every((h) => infectedSet.has(h))) {
      ns.print(`[${MY_HOST}] 全部已攻破，尝试迁移...`);
      await tryMigration();
    }

    await ns.sleep(15000);
  }
}

export function autocomplete(data, args) {
  return ["--max-hops", "--target-only", ...data.servers];
}
