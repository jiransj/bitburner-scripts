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
  const CHECK_INTERVAL_MS = 4000;

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

    // 暗网操作前必须建立/重建会话连接（参考 darkwebcontrol.js dispatchTo 模式）
    if (password && password !== "已存在会话") {
      try {
        await ns.dnet.connectToSession(host, password);
        ns.print(`[${MY_HOST}] ${host}: 会话已连接`);
      } catch (e) {
        ns.print(`[${MY_HOST}] ${host}: connectToSession 失败: ${e}`);
        // 继续尝试，可能已有会话
      }
    }

    // 先复制所有脚本到目标（复制后文件才在目标上存在）
    const copyOk = await copyScriptsTo(host);
    if (!copyOk) {
      ns.print(`[${MY_HOST}] ${host}: 脚本复制失败，无法部署 watch`);
      return false;
    }

    // 文件已在目标上，此时 getScriptRam 才能正确获取
    const watchRam = ns.getScriptRam(watchScript, host);
    const hostAvail = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
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

  // ======================== 主循环 ========================

  ns.tprint(`🔭 [${MY_HOST}] dnet-watch.js v1.0 启动，每 ${CHECK_INTERVAL_MS / 1000}s 扫描一次`);

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
          // 无会话 → 报告中枢，由 darkwebcontrol.js 统一调 worm 破解
          ns.print(`[${MY_HOST}] ${host}: 无会话，报告中枢处理`);
          await reportCrackNeed(host, d);
        }
      }

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
