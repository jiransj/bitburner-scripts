/**
 * dnet-worm.js — 暗网蠕虫 v2.0（精简版）
 *
 * 轻量级暗网扩散脚本，复杂密码分析委托给 darkwebcontrol.js。
 * 工作流程:
 *   1. 探测邻居 (ns.dnet.probe)
 *   2. 对每个邻居: 快速尝试常见密码; 失败则回报 home 分析
 *   3. 执行 home 下发的指令 (authenticate / freeMemory / openCaches)
 *   4. 自复制到新攻破的服务器并启动副本
 *
 * 用法（由 darkwebcontrol.js 自动部署）:
 *   run dnet-worm.js --controller home
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const SCRIPT_NAME = ns.getScriptName();
  const CONTROLLER = ns.args.includes("--controller") ? ns.args[ns.args.indexOf("--controller") + 1] : null;
  const MAX_HOPS = 999;
  const REPORT_BASE = "/Temp/dnet-worm-";
  const MY_HOST = ns.getHostname();

  // ── 感染清单 ──
  const INFECTED_FILE = REPORT_BASE + "infected.txt";
  let infectedSet = new Set();
  try { JSON.parse(ns.read(INFECTED_FILE)).forEach(h => infectedSet.add(h)); } catch {}
  function saveInfected() { ns.write(INFECTED_FILE, JSON.stringify([...infectedSet]), "w"); }
  function markInfected(host) { infectedSet.add(host); saveInfected(); }
  if (!infectedSet.has(MY_HOST)) markInfected(MY_HOST);

  // ── 迷你字典（仅供快速尝试，复杂分析走 home）──
  const QUICK_PASSWORDS = ["", "admin", "password", "123456", "12345", "0000", "1234", "0", "1"];

  // ── 回报 home ──
  async function report(host, password, crackType) {
    if (!CONTROLLER) return;
    try {
      const d = ns.dnet.getServerDetails(host);
      const msg = {
        host, password, type: crackType,
        modelId: d.modelId, hint: d.passwordHint, data: d.data,
        format: d.passwordFormat, length: d.passwordLength,
        depth: d.depth, difficulty: d.difficulty,
        reporter: MY_HOST, timestamp: Date.now(),
      };
      const path = REPORT_BASE + "crack-" + host.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
      ns.write(path, JSON.stringify(msg), "w");
      await ns.scp(path, CONTROLLER);
      ns.rm(path);
    } catch {}
  }

  /** 回报需要分析的服务器信息 */
  async function reportForAnalysis(host) {
    if (!CONTROLLER) return false;
    try {
      const d = ns.dnet.getServerDetails(host);
      const msg = {
        host, password: null, type: "need_analysis",
        modelId: d.modelId, hint: d.passwordHint, data: d.data,
        format: d.passwordFormat, length: d.passwordLength,
        depth: d.depth, difficulty: d.difficulty,
        reporter: MY_HOST, timestamp: Date.now(),
      };
      const path = REPORT_BASE + "need-" + host.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
      ns.write(path, JSON.stringify(msg), "w");
      await ns.scp(path, CONTROLLER);
      ns.rm(path);
      return true;
    } catch { return false; }
  }

  /** 尝试快速破解 */
  async function quickCrack(host, details) {
    // 长度0 → 空密码
    if (details.passwordLength === 0) {
      const r = await ns.dnet.authenticate(host, "");
      if (r.success) { await report(host, "", "NoPassword"); return true; }
    }

    // 提示包含密码关键词 → 快速尝试几个常见值
    const hint = ((details.passwordHint || "") + " " + (details.data || "")).toLowerCase();

    // 默认密码
    if (hint.includes("default") || hint.includes("factory")) {
      for (const pwd of ["admin", "password", "0000", "12345"]) {
        const r = await ns.dnet.authenticate(host, pwd);
        if (r.success) { await report(host, pwd, "DefaultPassword"); return true; }
        await ns.sleep(50);
      }
    }

    // NoPassword
    if (hint.includes("no password") || hint.includes("not set")) {
      const r = await ns.dnet.authenticate(host, "");
      if (r.success) { await report(host, "", "NoPassword"); return true; }
    }

    // 狗名
    if (hint.includes("dog")) {
      for (const pwd of ["fido", "spot", "rover", "max"]) {
        const r = await ns.dnet.authenticate(host, pwd);
        if (r.success) { await report(host, pwd, "DogNames"); return true; }
        await ns.sleep(50);
      }
    }

    // BufferOverflow: "■".repeat(2 * length) 直接通过
    if (hint.includes("buffer is") && details.passwordLength > 0) {
      const probe = "■".repeat(2 * details.passwordLength);
      const r = await ns.dnet.authenticate(host, probe);
      if (r.success) { await report(host, "", "BufferOverflow"); return true; }
    }

    // 通用常见密码
    for (const pwd of QUICK_PASSWORDS) {
      if (pwd === "") continue;
      // 格式过滤
      if (details.passwordFormat === "numeric" && !/^\d+$/.test(pwd)) continue;
      if (details.passwordLength > 0 && pwd.length !== details.passwordLength) continue;
      const r = await ns.dnet.authenticate(host, pwd);
      if (r.success) { await report(host, pwd, "QuickDict"); return true; }
      await ns.sleep(50);
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
        if (r.success || r.code === 454 || (r.message && r.message.includes("No Host"))) {
          const nd = ns.dnet.getServerDetails(host);
          if (nd.blockedRam <= 0) return true;
        } else { return false; }
      }
      return true;
    } catch { return false; }
  }

  /** 打开缓存 */
  async function openCaches() {
    try {
      const allFiles = ns.ls(MY_HOST).filter(f => f.endsWith(".cache") || f.endsWith(".d.cache"));
      for (const f of allFiles) {
        try { await ns.dnet.openCache(f, true); } catch {}
        await ns.sleep(50);
      }
    } catch {}
  }

  /** 传播到目标 */
  async function propagateTo(host) {
    if (!CONTROLLER || infectedSet.has(host)) return true;
    try {
      const avail = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
      const need = ns.getScriptRam(SCRIPT_NAME, host);
      if (avail < need) return false;
      if (!(await ns.scp(SCRIPT_NAME, host))) return false;
      const threads = Math.floor(avail / need);
      const pid = ns.exec(SCRIPT_NAME, host, threads, "--controller", CONTROLLER);
      if (pid > 0) { markInfected(host); return true; }
    } catch {}
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
        if (t.op === "authenticate" && t.host && t.password) {
          const r = await ns.dnet.authenticate(t.host, t.password);
          if (r.success) {
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

  // ── 启动 ──
  ns.tprint(`🐛 [${MY_HOST}] 蠕虫启动, 控制器=${CONTROLLER || "无"}`);

  while (true) {
    // 开缓存 + 检查指令
    await openCaches();
    await checkCommand();

    // 探测邻居
    let neighbors = [];
    try { neighbors = ns.dnet.probe() || []; } catch { await ns.sleep(5000); continue; }
    if (neighbors.length === 0) { await ns.sleep(10000); continue; }

    for (const host of neighbors) {
      if (infectedSet.has(host)) continue;

      // 获取详情
      let details;
      try { details = ns.dnet.getServerDetails(host); } catch { continue; }
      if (!details.isOnline || details.hasSession) continue;

      ns.print(`[${MY_HOST}] 🔍 ${host} (diff=${details.difficulty}, ${details.modelId})`);

      // 尝试快速破解
      const ok = await quickCrack(host, details);
      if (ok) {
        await freeMemory(host);
        await propagateTo(host);
        continue;
      }

      // 快速破解失败 → 回报 home 分析
      ns.print(`[${MY_HOST}] ${host}: 快速破解失败, 请求 home 分析`);
      await reportForAnalysis(host);
    }

    // 全部攻破 → 尝试迁移
    if (neighbors.every(h => infectedSet.has(h))) {
      for (const n of neighbors) {
        if (infectedSet.has(n)) {
          try {
            const d = ns.dnet.getServerDetails(n);
            if (d.isOnline && !d.isStationary) {
              for (let i = 0; i < 25; i++) {
                const r = await ns.dnet.induceServerMigration(n);
                if (r.success) break;
                await ns.sleep(100);
              }
              break;
            }
          } catch {}
        }
      }
    }

    await ns.sleep(15000);
  }
}
