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
  const CHECK_INTERVAL_MS = 8000;

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

  /** 确保目标上有会话（必要时破解），返回密码供后续 connectToSession 使用 */
  async function ensureSession(host) {
    let details;
    try {
      details = ns.dnet.getServerDetails(host);
      if (!details.isOnline) return null;
      if (details.hasSession) return "已存在会话"; // 已有会话，不需要密码
    } catch (e) {
      ns.print(`[${MY_HOST}] ${host}: 无法获取详情 - ${e}`);
      return null;
    }

    ns.print(`[${MY_HOST}] ${host}: 需要破解以建立会话...`);

    // ⚠️ 不要在认证前 SCP！暗网 SCP 需要会话，会静默失败
    // 直接启动 worm 破解（worm 从本机 authenticate 到目标，不需要目标上有文件）

    const scriptRam = ns.getScriptRam(WORM_SCRIPT, MY_HOST);
    const availRam = ns.getServerMaxRam(MY_HOST) - ns.getServerUsedRam(MY_HOST);
    const threads = Math.max(1, Math.floor(availRam / scriptRam));

    const resultFile = REPORT_BASE + "crack-result-" + host.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
    if (ns.fileExists(resultFile)) ns.rm(resultFile);

    const pid = ns.exec(WORM_SCRIPT, MY_HOST, threads, "--target-only", host);
    if (pid <= 0) { ns.print(`[${MY_HOST}] ${host}: worm 启动失败`); return null; }

    // 等待完成（快速轮询）
    let waited = 0;
    while (waited < 120000) {
      await ns.sleep(100);
      waited += 100;
      if (!ns.isRunning(pid)) break;
    }
    if (ns.isRunning(pid)) { ns.kill(pid); return null; }

    // 读结果
    if (!ns.fileExists(resultFile)) { ns.print(`[${MY_HOST}] ${host}: 无结果文件`); return null; }
    try {
      const result = JSON.parse(ns.read(resultFile));
      ns.rm(resultFile);
      if (!result.success) {
        ns.print(`[${MY_HOST}] ${host}: 破解失败`);
        if (result.needAnalysis && result.details) {
          reportToController("need", {
            reporter: MY_HOST, host: result.host,
            hint: result.details.passwordHint || "",
            data: result.details.data || "",
            format: result.details.passwordFormat || "",
            length: result.details.passwordLength || -1,
          });
        }
        return null;
      }
      const password = result.password;
      ns.tprint(`✅ [${MY_HOST}] ${host} 破解成功! 密码=${password} (${result.type})`);
      reportToController("crack", { reporter: MY_HOST, host: result.host, password, type: result.type });

      // 释放内存
      await freeMemory(host);

      infectedSet.add(host);
      saveInfected();
      return password; // 返回密码供 connectToSession 使用
    } catch (e) {
      ns.print(`[${MY_HOST}] ${host}: 结果解析失败 - ${e}`);
      return null;
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

      // 阶段 3: 对每个邻居检查 dnet-watch，缺失则部署
      let deployedCount = 0;
      for (const host of neighbors) {
        // 跳过本机
        if (host === MY_HOST) continue;

        // 检查 watch 是否已在目标上运行
        if (isWatchRunningOn(host)) {
          ns.print(`[${MY_HOST}] ${host}: watch 已在运行`);
          // 确保在 infectedSet 中
          if (!infectedSet.has(host)) {
            infectedSet.add(host);
            saveInfected();
          }
          continue;
        }

        ns.print(`[${MY_HOST}] ${host}: watch 未运行，开始部署`);

        // 确保有会话（必要时破解），返回密码
        const sessionPwd = await ensureSession(host);
        if (sessionPwd === null) {
          ns.print(`[${MY_HOST}] ${host}: 无法建立会话，跳过`);
          continue;
        }

        // 部署 watch（传入密码用于 connectToSession）
        try {
          const deployed = await deployWatchTo(host, sessionPwd);
          if (deployed) deployedCount++;
        } catch (e) {
          ns.print(`[${MY_HOST}] ${host}: 部署 watch 异常: ${e}`);
        }
      }

      // 阶段 4: 所有邻居是否均已部署 watch（即完全取得管理权限）
      // 注意：infectedSet 仅表示接触过，必须确认 watch 进程在目标上运行才算攻克
      const allHaveWatch = neighbors.every((h) => h === MY_HOST || isWatchRunningOn(h));

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
      reportStatus(neighbors, allHaveWatch);
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
