/**
 * dnet-worm.js — 暗网蠕虫 v2.2（轻量版）
 *
 * RAM 优化: 移除 openCache(2G) + induceServerMigration(4G)，通过回报让 home 处理。
 * 仅保留: probe(0.2G) + authenticate(0.4G) + memoryReallocation(1G) + 基础函数。
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const SCRIPT_NAME = ns.getScriptName();
  const CONTROLLER = ns.args.includes("--controller") ? ns.args[ns.args.indexOf("--controller") + 1] : null;
  const REPORT_BASE = "/Temp/dnet-worm-";
  const MY_HOST = ns.getHostname();

  // ── 感染清单 ──
  const INFECTED = REPORT_BASE + "infected.txt";
  let infected = new Set();
  try { JSON.parse(ns.read(INFECTED)).forEach(h => infected.add(h)); } catch {}
  function save() { ns.write(INFECTED, JSON.stringify([...infected]), "w"); }
  if (!infected.has(MY_HOST)) { infected.add(MY_HOST); save(); }

  // ── 密码字典（数组不占 RAM，仅 API 调用数影响内存）──
  const COMMON = [
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
  const DEFAULTS = ["admin","password","0000","12345"];
  const DOGS = ["fido","spot","rover","max","buddy","bella","charlie","luna"];

  /** 回报 home */
  async function report(host, pwd, type) {
    if (!CONTROLLER) return;
    try {
      const d = ns.dnet.getServerDetails(host);
      const msg = { host, password: pwd, type,
        modelId: d.modelId, hint: d.passwordHint, data: d.data,
        format: d.passwordFormat, length: d.passwordLength,
        depth: d.depth, difficulty: d.difficulty,
        reporter: MY_HOST, blockedRam: d.blockedRam, timestamp: Date.now() };
      const f = REPORT_BASE + "crack-" + host.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
      ns.write(f, JSON.stringify(msg), "w");
      await ns.scp(f, CONTROLLER);
      ns.rm(f);
    } catch {}
  }

  async function reportNeed(host) {
    if (!CONTROLLER) return false;
    try {
      const d = ns.dnet.getServerDetails(host);
      const msg = { host, password: null, type: "need_analysis",
        modelId: d.modelId, hint: d.passwordHint, data: d.data,
        format: d.passwordFormat, length: d.passwordLength,
        depth: d.depth, difficulty: d.difficulty, reporter: MY_HOST, timestamp: Date.now() };
      const f = REPORT_BASE + "need-" + host.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
      ns.write(f, JSON.stringify(msg), "w");
      await ns.scp(f, CONTROLLER);
      ns.rm(f);
      return true;
    } catch { return false; }
  }

  /** 快速破解 */
  async function quickCrack(host, det) {
    const fmt = det.passwordFormat || "";
    const len = det.passwordLength || -1;
    const hint = ((det.passwordHint||"") + " " + (det.data||"")).toLowerCase();

    if (len === 0) {
      if ((await ns.dnet.authenticate(host, "")).success) { await report(host, "", "NoPassword"); return true; }
    }
    if (hint.includes("buffer is") && len > 0) {
      if ((await ns.dnet.authenticate(host, "■".repeat(2*len))).success) { await report(host, "", "BufferOverflow"); return true; }
    }
    if (hint.includes("default") || hint.includes("factory")) {
      for (const p of DEFAULTS) {
        if (fmt==="numeric" && !/^\d+$/.test(p)) continue;
        if (len>0 && p.length!==len) continue;
        if ((await ns.dnet.authenticate(host, p)).success) { await report(host, p, "DefaultPassword"); return true; }
      }
    }
    if (hint.includes("dog")) {
      for (const p of DOGS) {
        if (len>0 && p.length!==len) continue;
        if ((await ns.dnet.authenticate(host, p)).success) { await report(host, p, "DogNames"); return true; }
      }
    }
    if ((hint.includes("the password is")||hint.includes("the pin is")||hint.includes("the key is")) && fmt==="numeric") {
      const last = hint.split(" ").pop().replace(/[^0-9]/g,"");
      if (last && /^\d+$/.test(last) && last.length<=3) {
        if ((await ns.dnet.authenticate(host, last)).success) { await report(host, last, "EchoVuln"); return true; }
      }
    }
    for (const p of COMMON) {
      if (p==="") continue;
      if (fmt==="numeric" && !/^\d+$/.test(p)) continue;
      if (fmt==="alphabetic" && !/^[a-zA-Z]+$/.test(p)) continue;
      if (len>0 && p.length!==len) continue;
      if ((await ns.dnet.authenticate(host, p)).success) { await report(host, p, "QuickDict"); return true; }
    }
    return false;
  }

  /** 释放内存 */
  async function freeMem(host) {
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

  /** 传播 */
  async function propagate(host) {
    if (!CONTROLLER || infected.has(host)) return true;
    const need = ns.getScriptRam(SCRIPT_NAME, MY_HOST);
    for (let r = 0; r < 3; r++) {
      try {
        const avail = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
        if (avail < need) return false;
        if (!(await ns.scp(SCRIPT_NAME, host))) { await ns.sleep(500); continue; }
        const t = Math.max(1, Math.floor(avail / need));
        if (ns.exec(SCRIPT_NAME, host, t, "--controller", CONTROLLER) > 0) { infected.add(host); save(); return true; }
      } catch {}
      await ns.sleep(1000);
    }
    return false;
  }

  /** 检查 home 指令 */
  async function checkCmd() {
    if (!CONTROLLER) return;
    const f = REPORT_BASE + "cmd-" + MY_HOST.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
    try {
      if (!ns.fileExists(f)) return;
      const cmd = JSON.parse(ns.read(f));
      ns.rm(f);
      for (const t of cmd.tasks || []) {
        if (t.op === "authenticate" && t.host && t.password !== undefined) {
          const r = await ns.dnet.authenticate(t.host, t.password);
          if (r.success) {
            await report(t.host, t.password, "remote");
            await freeMem(t.host);
            await propagate(t.host);
          }
        }
        if (t.op === "freeMemory" && t.host) await freeMem(t.host);
        if (t.op === "exec" && t.script && t.target) {
          const ok = await ns.scp(t.script, t.target);
          if (ok) ns.exec(t.script, t.target, 1);
        }
      }
    } catch {}
  }

  // ── 主循环 ──
  while (true) {
    await checkCmd();

    let neighbors = [];
    try { neighbors = ns.dnet.probe() || []; } catch { await ns.sleep(3000); continue; }
    if (neighbors.length === 0) { await ns.sleep(5000); continue; }

    let allDone = true;
    for (const h of neighbors) {
      if (infected.has(h)) continue;
      allDone = false;
      let d;
      try { d = ns.dnet.getServerDetails(h); } catch { continue; }
      if (!d.isOnline || d.hasSession) continue;

      if (await quickCrack(h, d)) {
        await freeMem(h);
        await propagate(h);
      } else {
        await reportNeed(h);
      }
    }

    await ns.sleep(5000);
  }
}
