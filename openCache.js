/**
 * openCache.js — 暗网缓存管理器 v2.0
 *
 * 功能：
 *   移植自 dnet-worm.js 的 openCache API 功能
 *   扫描本机的 .cache / .d.cache 文件并逐一打开
 *
 * 两种运行模式：
 *   1. 一次性模式（默认）: 扫描并打开所有缓存文件后自动退出
 *   2. 监视模式（--watch）: 持续循环，发现新缓存立即打开
 *
 * 被 dnet-worm.js 管理生命周期：
 *   - worm 发现存在缓存文件时执行本脚本（--watch 模式）
 *   - worm 发现缓存文件消失时 kill 本进程
 *
 * RAM: ~3 GB (ls 0.2G + openCache 2G + base)
 *
 * 用法:
 *   run openCache.js              ← 一次性打开所有缓存后退出
 *   run openCache.js --watch      ← 持续监视并打开新增缓存
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const HOST = ns.getHostname();
  const WATCH_MODE = ns.args.includes("--watch");

  // ======================== 配置 ========================
  const CHECK_INTERVAL_MS = 30000; // 监视模式下每 30 秒扫描一次
  const REPORT_BASE = "/Temp/dnet-worm-";

  // 已打开的缓存文件集合（避免重复打开）
  const openedSet = new Set();
  const openedLogFile = "/Temp/openCache-opened.txt";

  // 启动时加载已打开记录
  try {
    const raw = ns.read(openedLogFile);
    if (raw) JSON.parse(raw).forEach((f) => openedSet.add(f));
  } catch { /* 首次运行 */ }

  /** 持久化已打开列表 */
  function saveOpened() {
    ns.write(openedLogFile, JSON.stringify([...openedSet]), "w");
  }

  /** 向控制中枢发送报告 */
  function reportToController(type, data) {
    try {
      const reportFile = REPORT_BASE + type + "-" + HOST.replace(/[^a-zA-Z0-9]/g, "_") + ".txt";
      ns.write(reportFile, JSON.stringify(data), "w");
    } catch (e) {
      ns.print(`[${HOST}] 报告失败: ${e}`);
    }
  }

  /** 扫描并打开本机的缓存文件 */
  async function scanAndOpen() {
    let cacheFiles = [];
    try {
      const allFiles = ns.ls(HOST);
      cacheFiles = allFiles.filter(
        (f) => f.endsWith(".cache") || f.endsWith(".d.cache")
      );
    } catch (e) {
      ns.print(`[${HOST}] 读取文件列表失败: ${e}`);
      return { opened: 0, total: 0 };
    }

    if (cacheFiles.length === 0) {
      return { opened: 0, total: 0 };
    }

    // 过滤出未打开的缓存
    const newCaches = cacheFiles.filter((f) => !openedSet.has(f));
    if (newCaches.length === 0) {
      return { opened: 0, total: cacheFiles.length };
    }

    ns.print(`[${HOST}] 发现 ${newCaches.length} 个新缓存文件, 开始打开...`);

    let opened = 0;
    for (const cacheFile of newCaches) {
      try {
        const r = await ns.dnet.openCache(cacheFile, true); // suppressToast=true
        if (r && r.success) {
          ns.tprint(`🎁 [${HOST}] 打开缓存 ${cacheFile}: ${r.message}`);
          openedSet.add(cacheFile);
          opened++;
        } else {
          ns.print(`[${HOST}] 打开缓存 ${cacheFile} 失败: ${r?.message}`);
        }
      } catch (e) {
        ns.print(`[${HOST}] 打开缓存 ${cacheFile} 异常: ${e}`);
      }
      await ns.sleep(100);
    }

    // 持久化已打开记录
    saveOpened();

    // 向控制中枢报告
    if (opened > 0) {
      reportToController("cache", {
        host: HOST,
        opened,
        total: cacheFiles.length,
        files: newCaches,
      });
    }

    return { opened, total: cacheFiles.length };
  }

  // ======================== 主逻辑 ========================

  ns.print(`[${HOST}] openCache.js v2.0 启动, 模式: ${WATCH_MODE ? "监视" : "一次性"}`);

  // 告知 worm 本脚本已启动（用于同步）
  reportToController("openCache-status", {
    host: HOST,
    status: "started",
    mode: WATCH_MODE ? "watch" : "oneshot",
  });

  if (WATCH_MODE) {
    // ----- 监视模式：持续运行 -----
    ns.print(`[${HOST}] 进入监视模式，每 ${CHECK_INTERVAL_MS / 1000} 秒扫描一次缓存`);
    while (true) {
      const result = await scanAndOpen();

      // 如果没有缓存文件且不处于刚启动阶段，可以报告空闲状态
      if (result.total === 0) {
        reportToController("cache-idle", {
          host: HOST,
          timestamp: Date.now(),
        });
      }

      await ns.sleep(CHECK_INTERVAL_MS);
    }
  } else {
    // ----- 一次性模式：打开后退出 -----
    const result = await scanAndOpen();
    ns.print(
      `[${HOST}] 完成: 打开 ${result.opened}/${result.total} 个缓存`
    );
    reportToController("openCache-done", {
      host: HOST,
      opened: result.opened,
      total: result.total,
    });
  }
}
