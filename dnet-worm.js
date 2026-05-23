/**
 * dnet-worm.js — 暗网蠕虫 v2.1
 *
 * 轻量自复制暗网扩散脚本，复杂密码分析委托 darkwebcontrol.js。
 *
 * 用法: run dnet-worm.js --controller home
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const SCRIPT_NAME = ns.getScriptName();
  const CONTROLLER = ns.args.includes("--controller") ? ns.args[ns.args.indexOf("--controller") + 1] : null;
  const REPORT_BASE = "/Temp/dnet-worm-";
  const MY_HOST = ns.getHostname();

  // ── 感染清单 ──
  const INFECTED_FILE = REPORT_BASE + "infected.txt";
  let infectedSet = new Set();
  try { JSON.parse(ns.read(INFECTED_FILE)).forEach(h => infectedSet.add(h)); } catch {}
  function saveInfected() { ns.write(INFECTED_FILE, JSON.stringify([...infectedSet]), "w"); }
  function markInfected(host) { infectedSet.add(host); saveInfected(); }
  if (!infectedSet.has(MY_HOST)) markInfected(MY_HOST);

  // ── 快速字典（覆盖常见长度，减少回 home 分析的次数）──
  const QUICK_DICT = [
    "", "0", "1", "00", "01", "10", "11", "000", "001", "111", "123",
    "0000", "1111", "1234", "2222", "3333", "5555", "7777", "9999",
    "00000", "11111", "12345", "22222", "33333", "55555",
    "000000", "111111", "123456", "222222", "666666", "888888",
    "0000000", "1111111", "1234567", "7777777",
    "admin", "password", "pass", "root",
  ];

  /** 回报 home（已破解） */
  async function report(host, password, crackType) {
    if (!CONTROLLER) return;
    try {
      const d = ns.dnet.getServerDetails(host);
      const msg = { host, password, type: crackType,
        modelId: d.modelId, hint: d.passwordHint, data: d.data,
        format: d.passwordFormat, length: d.passwordLength,
        depth: d.depth, difficulty: d.difficulty,
        reporter: MY_HOST, timestamp: Date.now() };
      const path = REPORT_BASE + "crack-" + host.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
      ns.write(path, JSON.stringify(msg), "w");
      await ns.scp(path, CONTROLLER);
      ns.rm(path);
    } catch {}
  }

  /** 回报需要分析的服务器 */
  async function reportForAnalysis(host) {
    if (!CONTROLLER) return false;
    try {
      const d = ns.dnet.getServerDetails(host);
      const msg = { host, password: null, type: "need_analysis",
        modelId: d.modelId, hint: d.passwordHint, data: d.data,
        format: d.passwordFormat, length: d.passwordLength,
        depth: d.depth, difficulty: d.difficulty,
        reporter: MY_HOST, timestamp: Date.now() };
      const path = REPORT_BASE + "need-" + host.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
      ns.write(path, JSON.stringify(msg), "w");
      await ns.scp(path, CONTROLLER);
      ns.rm(path);
      return true;
    } catch { return false; }
  }

  /** 快速破解 */
  async function quickCrack(host, details) {
    const fmt = details.passwordFormat || "";
    const len = details.passwordLength || -1;
    const hint = ((details.passwordHint || "") + " " + (details.data || "")).toLowerCase();

    // 空密码
    if (len === 0) {
      const r = await ns.dnet.authenticate(host, "");
      if (r.success) { await report(host, "", "NoPassword"); return true; }
    }

    // BufferOverflow: 直接通过
    if (hint.includes("buffer is") && len > 0) {
      const r = await ns.dnet.authenticate(host, "■".repeat(2 * len));
      if (r.success) { await report(host, "", "BufferOverflow"); return true; }
    }

    // 默认密码
    if (hint.includes("default") || hint.includes("factory")) {
      for (const p of ["admin", "password", "0000", "12345"]) {
        if (fmt === "numeric" && !/^\d+$/.test(p)) continue;
        if (len > 0 && p.length !== len) continue;
        const r = await ns.dnet.authenticate(host, p);
        if (r.success) { await report(host, p, "DefaultPassword"); return true; }
      }
    }

    // 狗名
    if (hint.includes("dog")) {
      for (const p of ["fido", "spot", "rover", "max"]) {
        if (len > 0 && p.length !== len) continue;
        const r = await ns.dnet.authenticate(host, p);
        if (r.success) { await report(host, p, "DogNames"); return true; }
      }
    }

    // EchoVuln: hint 末尾数字
    if ((hint.includes("the password is") || hint.includes("the pin is") || hint.includes("the key is")) && fmt === "numeric") {
      const words = hint.split(" ");
      const last = words[words.length - 1].replace(/[^0-9]/g, "");
      if (last && /^\d+$/.test(last) && last.length <= 3) {
        const r = await ns.dnet.authenticate(host, last);
        if (r.success) { await report(host, last, "EchoVuln"); return true; }
      }
    }

    // 通用字典（按格式+长度过滤后尝试）
    for (const pwd of QUICK_DICT) {
      if (pwd === "") continue;
      if (fmt === "numeric" && !/^\d+$/.test(pwd)) continue;
      if (fmt === "alphabetic" && !/^[a-zA-Z]+$/.test(pwd)) continue;
      if (len > 0 && pwd.length !== len) continue;
      const r = await ns.dnet.authenticate(host, pwd);
      if (r.success) { await report(host, pwd, "QuickDict"); return true; }
    }

    return false;
  }

  /** 释放内存 */
  async function freeMemory(host) {
    try {
      const d = ns.dnet.getServerDetails(host);
      if (!d.isOnline || d.blockedRam <= 0) return true;
      for (let i = 0; i < 30; i++) {
        const r = await ns.dnet.memoryReallocation(host);
        if (r.success || r.code === 454) {
          if (ns.dnet.getServerDetails(host).blockedRam <= 0) return true;
        } else return false;
      }
      return true;
    } catch { return false; }
  }

  /** 打开缓存 */
  async function openCaches() {
    try {
      for (const f of ns.ls(MY_HOST).filter(f => f.endsWith(".cache") || f.endsWith(".d.cache"))) {
        try { await ns.dnet.openCache(f, true); } catch {}
      }
    } catch {}
  }

  /** 传播到目标（含重试） */
  async function propagateTo(host) {
    if (!CONTROLLER || infectedSet.has(host)) return true;
    const need = ns.getScriptRam(SCRIPT_NAME, MY_HOST);
    for (let retry = 0; retry < 3; retry++) {
      try {
        const avail = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
        if (avail < need) { ns.print(`[${MY_HOST}] ${host} RAM不足 ${ns.formatRam(avail)}<${ns.formatRam(need)}`); return false; }
        if (!(await ns.scp(SCRIPT_NAME, host))) { await ns.sleep(500); continue; }
        const threads = Math.floor(avail / need);
        const pid = ns.exec(SCRIPT_NAME, host, Math.max(1, threads), "--controller", CONTROLLER);
        if (pid > 0) { markInfected(host); ns.tprint(`🔄 [${MY_HOST}] → ${host} (${threads}t)`); return true; }
      } catch (e) { ns.print(`[${MY_HOST}] ${host} 传播失败: ${e}`); }
      await ns.sleep(1000);
    }
    return false;
  }

  /** 检查 home 指令 */
  async function checkCommand() {
    if (!CONTROLLER) return;
    const cmdFile = REPORT_BASE + "cmd-" + MY_HOST.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
    try {
      if (!ns.fileExists(cmdFile)) return;
      const cmd = JSON.parse(ns.read(cmdFile));
      ns.rm(cmdFile);
      for (const t of cmd.tasks || []) {
        if (t.op === "authenticate" && t.host && t.password !== undefined) {
          const r = await ns.dnet.authenticate(t.host, t.password);
          if (r.success) {
            ns.tprint(`✅ [${MY_HOST}] 远程破解 ${t.host} 成功`);
            await report(t.host, t.password, "remote");
            await freeMemory(t.host);
            await propagateTo(t.host);
          }
        }
        if (t.op === "freeMemory" && t.host) await freeMemory(t.host);
        if (t.op === "openCaches") await openCaches();
        if (t.op === "migrate" && t.host) await ns.dnet.induceServerMigration(t.host);
      }
    } catch {}
  }

  // ── 主循环 ──
  ns.tprint(`🐛 [${MY_HOST}] 蠕虫启动, 控制器=${CONTROLLER || "无"}`);

  while (true) {
    await openCaches();
    await checkCommand();

    let neighbors = [];
    try { neighbors = ns.dnet.probe() || []; } catch { await ns.sleep(3000); continue; }
    if (neighbors.length === 0) { await ns.sleep(5000); continue; }

    let allInfected = true;
    for (const host of neighbors) {
      if (infectedSet.has(host)) continue;
      allInfected = false;

      let details;
      try { details = ns.dnet.getServerDetails(host); } catch { continue; }
      if (!details.isOnline || details.hasSession) continue;

      ns.print(`[${MY_HOST}] 🔍 ${host} (${details.modelId})`);

      if (await quickCrack(host, details)) {
        await freeMemory(host);
        await propagateTo(host);
      } else {
        ns.print(`[${MY_HOST}] ${host}: → home 分析`);
        await reportForAnalysis(host);
      }
    }

    // 全部攻破 → 尝试迁移
    if (allInfected && neighbors.length > 0) {
      for (const n of neighbors) {
        if (infectedSet.has(n)) {
          try {
            const d = ns.dnet.getServerDetails(n);
            if (d.isOnline && !d.isStationary) {
              for (let i = 0; i < 25; i++) {
                const r = await ns.dnet.induceServerMigration(n);
                if (r.success) { ns.print(`[${MY_HOST}] ${n} 迁移成功`); break; }
                await ns.sleep(100);
              }
              break;
            }
          } catch {}
        }
      }
    }

    await ns.sleep(5000);
  }
}
