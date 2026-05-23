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
  const REPORT_BASE = "/Temp/dnet-worm-";
  const INFECTED_FILE = "/Temp/dnet-worm-infected.txt";
  const CHECK_INTERVAL_MS = 15000;

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

  /** 向控制中枢发送各类报告 */
  function reportToController(type, data) {
    try {
      const safeName = MY_HOST.replace(/[^a-zA-Z0-9]/g, "_");
      const reportFile = REPORT_BASE + type + "-" + safeName + ".txt";
      ns.write(reportFile, JSON.stringify(data), "w");
    } catch (e) {
      ns.print(`[${MY_HOST}] 报告失败: ${e}`);
    }
  }

  /** 报告状态（心跳） */
  function reportStatus(neighbors, allInfected) {
    const wormRunning = ns.ps(MY_HOST).some((p) => p.filename === WORM_SCRIPT);
    reportToController("status", {
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
                  reportToController("crack", {
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
    const scripts = [ns.getScriptName(), WORM_SCRIPT, OPENCACHE_SCRIPT, STOCKMASTER_SCRIPT];
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

  /** 对一个目标执行破解：SCP + 启动 worm + 等待结果 + memoryReallocation */
  async function crackTarget(host) {
    if (infectedSet.has(host)) return true;

    ns.print(`\n[${MY_HOST}] 🔍 开始攻克目标: ${host}`);

    // 1. 检查是否已有会话
    try {
      const details = ns.dnet.getServerDetails(host);
      if (!details.isOnline) { ns.print(`[${MY_HOST}] ${host}: 离线`); return false; }
      if (details.hasSession) {
        ns.print(`[${MY_HOST}] ${host}: 已有有效会话`);
        infectedSet.add(host);
        saveInfected();
        return true;
      }
    } catch (e) {
      ns.print(`[${MY_HOST}] ${host}: 无法获取详情 - ${e}`);
      return false;
    }

    // 2. SCP 脚本到目标
    ns.print(`[${MY_HOST}] ${host}: 复制脚本...`);
    await copyScriptsTo(host);

    // 3. 在本机启动 dnet-worm.js 以 --target-only 模式破解目标
    const scriptRam = ns.getScriptRam(WORM_SCRIPT, MY_HOST);
    const availRam = ns.getServerMaxRam(MY_HOST) - ns.getServerUsedRam(MY_HOST);
    const threads = Math.max(1, Math.floor(availRam / scriptRam));

    if (threads < 1) {
      ns.print(`[${MY_HOST}] ${host}: 本机 RAM 不足，无法启动 worm`);
      return false;
    }

    // 清除旧的临时结果文件
    const resultFile = REPORT_BASE + "crack-result-" + host.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
    if (ns.fileExists(resultFile)) ns.rm(resultFile);

    const pid = ns.exec(WORM_SCRIPT, MY_HOST, threads, "--target-only", host);
    if (pid <= 0) {
      ns.print(`[${MY_HOST}] ${host}: worm 启动失败`);
      return false;
    }
    ns.print(`[${MY_HOST}] ${host}: worm 已启动 (PID=${pid})，等待结果...`);

    // 4. 等待 worm 完成
    let waited = 0;
    const maxWait = 120000; // 最多等 2 分钟
    while (waited < maxWait) {
      await ns.sleep(500);
      waited += 500;
      if (!ns.isRunning(pid)) break;
    }
    // 如果超时，强制杀掉
    if (ns.isRunning(pid)) {
      ns.kill(pid);
      ns.print(`[${MY_HOST}] ${host}: worm 超时（${maxWait / 1000}秒），强制终止`);
    }

    // 5. 读取结果
    let cracked = false;
    if (ns.fileExists(resultFile)) {
      try {
        const result = JSON.parse(ns.read(resultFile));
        ns.rm(resultFile); // ← 文件清理在 watch 中
        if (result.success) {
          cracked = true;
          ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${result.password} (${result.type})`);
          // 向控制中枢报告
          reportToController("crack", {
            reporter: MY_HOST,
            host: result.host,
            password: result.password,
            type: result.type,
            timestamp: Date.now(),
          });
        } else {
          ns.print(`[${MY_HOST}] ${host}: 破解失败`);
          // 如果需要分析
          if (result.needAnalysis && result.details) {
            reportToController("need", {
              reporter: MY_HOST,
              host: result.host,
              hint: result.details.passwordHint || "",
              data: result.details.data || "",
              format: result.details.passwordFormat || "",
              length: result.details.passwordLength || -1,
              timestamp: Date.now(),
            });
          }
        }
      } catch (e) {
        ns.print(`[${MY_HOST}] ${host}: 结果解析失败 - ${e}`);
      }
    } else {
      ns.print(`[${MY_HOST}] ${host}: 未找到结果文件`);
    }

    // 6. 如果破解成功，释放内存、标记感染、在新服务器上启动 watch 副本
    if (cracked) {
      await freeMemory(host);
      infectedSet.add(host);
      saveInfected();

      // 7. 在新服务器上启动 dnet-watch.js 副本（自我复制）
      const watchScript = ns.getScriptName();
      const watchRam = ns.getScriptRam(watchScript, host);
      const hostMaxRam = ns.getServerMaxRam(host);
      const hostUsedRam = ns.getServerUsedRam(host);
      const hostAvail = hostMaxRam - hostUsedRam;
      if (hostAvail >= watchRam) {
        const watchPid = ns.exec(watchScript, host, 1);
        if (watchPid > 0) {
          ns.tprint(`🚀 [${MY_HOST}] → ${host}: dnet-watch.js 已启动 (PID=${watchPid})`);
        } else {
          ns.print(`[${MY_HOST}] ${host}: dnet-watch.js 启动失败`);
        }
      } else {
        ns.print(`[${MY_HOST}] ${host}: RAM不足(${ns.format.ram(hostAvail)} < ${ns.format.ram(watchRam)})，无法启动 watch 副本`);
      }
    }

    return cracked;
  }

  // ======================== 主循环 ========================

  ns.tprint(`🔭 [${MY_HOST}] dnet-watch.js v1.0 启动，每 ${CHECK_INTERVAL_MS / 1000}s 扫描一次`);

  let allInfectedCount = 0;

  while (true) {
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

    // 阶段 3: 针对未感染邻居执行破解
    const uninfected = neighbors.filter((h) => !infectedSet.has(h));
    let anyNewInfection = false;

    if (uninfected.length > 0) {
      ns.print(`[${MY_HOST}] ${uninfected.length} 个邻居未感染: ${uninfected.join(", ")}`);
      for (const host of uninfected) {
        const ok = await crackTarget(host);
        if (ok) anyNewInfection = true;
      }
    }

    // 阶段 4: 全感染检测
    const allInfected = neighbors.every((h) => infectedSet.has(h));

    if (allInfected) {
      allInfectedCount++;
      ns.print(`[${MY_HOST}] 所有邻居已感染 (连续 ${allInfectedCount} 次)`);

      // 连续确认后，杀死本服务器上所有 worm（只留 watch）
      if (allInfectedCount >= 2) {
        const killed = killAllWorms();
        if (killed > 0) {
          ns.tprint(`🏁 [${MY_HOST}] 全感染，worm 已休眠`);
        }
      }
    } else {
      allInfectedCount = 0;
      // 如果有未感染的邻居，确保 worm 可以启动（当需要时，crackTarget 会自动启动 worm）
      // 不在这里自动启动 worm，由 crackTarget 按需启动
    }

    // 阶段 5: 报告状态
    reportStatus(neighbors, allInfected);

    await ns.sleep(CHECK_INTERVAL_MS);
  }
}

export function autocomplete(data, args) {
  return data.servers;
}
