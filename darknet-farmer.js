/**
 * darknet-farmer.js — 暗网自动收益最大化脚本
 *
 * 【架构】
 *   主进程(darknet-farmer.js) — 运行在 home 上，负责:
 *     1. 探测暗网拓扑，管理服务器状态
 *     2. 向暗网服务器部署 worker 子进程
 *     3. 收集 worker 的收益报告
 *     4. 自动打开发现的缓存文件
 *
 *   子进程(darknet-worker.js) — 运行在暗网服务器上，负责:
 *     1. 执行钓鱼攻击(phishingAttack) → 主要收益来源
 *     2. 执行内存释放(memoryReallocation) → 完全清除时产生缓存
 *     3. 执行股票宣传(promoteStock) → 配合股票交易
 *     4. 通过文件向主进程汇报结果
 *
 * 【暗网访问方式】
 *   ns.dnet API 使用玩家的终端位置，而非脚本运行位置。
 *   因此脚本留在 home 上运行，玩家需通过以下方式进入暗网:
 *   方案A: 有 SF4 → 脚本自动 connect darkweb
 *   方案B: 无 SF4 → 手动在终端执行 connect darkweb
 *   darkweb 只有 16GB RAM 不能跑脚本，worker 部署到目标服务器上运行。
 *
 * @author jiransj
 */

import { getNsDataThroughFile, getConfiguration, disableLogs } from "./helpers.js";

const argsSchema = [
    ['loop-delay', 5000],
    ['phishing', true],
    ['memory-realloc', true],
    ['stock-promotion', false],
    ['labyrinth', true],
    ['verbose', false],
    ['phishing-only', false],
    ['memory-only', false],
    ['max-workers', 5],
    ['worker-threads', 1],
    ['reserve', 0],
];

const WORKER_SCRIPT = "darknet-worker.js";
const REPORT_PREFIX = "/Temp/darknet_report_";
const CACHE_LOG_FILE = "/Temp/darknet_caches_found.txt";

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns */
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    disableLogs(ns, ['sleep', 'scan', 'exec', 'scp', 'ls', 'read', 'write', 'rm']);

    // ── 前置检查 ──
    if (!ns.dnet) {
        ns.tprint("ERROR: 需要 Bitburner v3.0+，未检测到 ns.dnet API");
        ns.exit();
        return;
    }

    // 尝试自动连接 darkweb（需要 SF4）
    try {
        if (ns.singularity && ns.getHostname() !== "darkweb") {
            ns.singularity.connect("darkweb");
            ns.print("INFO: ✓ 已通过 Singularity 连接到 darkweb");
        }
    } catch (e) {
        ns.print("INFO: 请确保已在终端执行 connect darkweb (或安装 SF4 自动连接)");
    }

    // 测试 dnet API
    try {
        const test = ns.dnet.probe();
        ns.print(`INFO: ✓ dnet API 可用, probe 返回 ${test.length} 个结果`);
    } catch (e) {
        ns.tprint("WARNING: dnet API 不可用，请先连接 darkweb (终端: connect darkweb)");
        ns.print("INFO: 脚本将继续运行，每轮循环会重试探测");
    }

    // 检查 WORKER_SCRIPT 是否存在
    if (!ns.fileExists(WORKER_SCRIPT, "home")) {
        ns.tprint(`ERROR: 找不到工作脚本 ${WORKER_SCRIPT}`);
        ns.exit();
        return;
    }

    ns.tprint("=".repeat(60));
    ns.tprint(`  暗网自动收益脚本 v1.0 已启动 [运行于: ${ns.getHostname()}]`);
    ns.tprint(`  模式: ${options['phishing'] ? '钓鱼 ' : ''}${options['memory-realloc'] ? '内存 ' : ''}${options['stock-promotion'] ? '股票 ' : ''}${options['labyrinth'] ? '迷宫' : ''}`);
    ns.tprint("=".repeat(60));

    // ── 状态变量 ──
    const serverState = {
        all: new Map(),
        authed: new Set(),
        workerPids: new Map(),
    };

    let totalStats = {
        moneyEarned: 0,
        cachesOpened: 0,
        phishAttempts: 0,
        memoryFreed: 0,
        stockPromotions: 0,
        serversExplored: 0,
    };

    const knownCaches = new Set();
    try {
        const cacheLog = ns.read(CACHE_LOG_FILE);
        if (cacheLog) {
            for (const line of cacheLog.split('\n').filter(l => l.trim())) {
                try { const entry = JSON.parse(line); if (entry.fileName) knownCaches.add(entry.fileName); } catch (e) {}
            }
        }
    } catch (e) {}

    let lastReport = Date.now();
    let cycleCount = 0;

    // ── 主循环 ──
    while (true) {
        cycleCount++;
        const cycleStart = Date.now();

        try {
            await exploreAndMap(ns, serverState);
            await attemptAuthentication(ns, serverState);
            await deployWorkers(ns, serverState, options, totalStats);
            await collectWorkerReports(ns, serverState, knownCaches, totalStats, options);
            await healthCheckWorkers(ns, serverState);

            if (knownCaches.size > 0) {
                await openKnownCaches(ns, knownCaches, serverState, totalStats, options);
            }

            if (options['labyrinth']) {
                await attemptLabyrinth(ns, serverState, options);
            }

            if (Date.now() - lastReport > 30000) {
                lastReport = Date.now();
                printReport(ns, serverState, totalStats, cycleCount);
            }

            if (serverState.all.size === 0 && cycleCount % 12 === 0) {
                ns.print("WARN: 尚未发现任何暗网服务器。请确认已在终端执行 connect darkweb");
            }

        } catch (e) {
            ns.print(`WARN: 主循环异常: ${e}`);
        }

        const elapsed = Date.now() - cycleStart;
        const delay = Math.max(500, options['loop-delay'] - elapsed);
        await ns.sleep(delay);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  阶段1: 探索
// ═══════════════════════════════════════════════════════════════════

async function exploreAndMap(ns, serverState) {
    let newFound = 0;
    const toExplore = new Set();

    try {
        const neighbors = ns.dnet.probe();
        if (Array.isArray(neighbors) && neighbors.length > 0) {
            ns.print(`INFO: dnet.probe() 发现 ${neighbors.length} 个服务器: ${neighbors.join(', ')}`);
            for (const host of neighbors) {
                if (!serverState.all.has(host)) toExplore.add(host);
            }
        } else {
            ns.print("WARN: dnet.probe() 未返回任何服务器");
            return;
        }
    } catch (e) {
        ns.print(`WARN: dnet.probe() 失败(${e})，请确认已连接 darkweb`);
        return;
    }

    // 获取服务器详情
    for (const host of toExplore) {
        try {
            const d = ns.dnet.getServerDetails(host);
            if (d && d.isOnline) {
                serverState.all.set(host, {
                    host,
                    isOnline: true,
                    depth: d.depth || 0,
                    difficulty: d.difficulty || 0,
                    requiredCharisma: d.requiredCharismaSkill || 0,
                    passwordHint: d.passwordHint || '',
                    passwordLength: d.passwordLength || 0,
                    hasSession: d.hasSession || false,
                    blockedRam: d.blockedRam || 0,
                    discoveredAt: Date.now(),
                });
                if (d.hasSession) serverState.authed.add(host);
                newFound++;
            }
        } catch (e) {
            serverState.all.set(host, { host, isOnline: false, discoveredAt: Date.now() });
            newFound++;
        }
    }

    if (newFound > 0) {
        ns.print(`INFO: 发现 ${newFound} 个新暗网服务器(共 ${serverState.all.size} 个)`);
    }

    // 从 worker 报告收集邻居信息
    for (const [host, pid] of serverState.workerPids) {
        if (pid && ns.isRunning(pid)) {
            try {
                const reportFile = `${REPORT_PREFIX}${host.replace(/[^a-zA-Z0-9]/g, '_')}.txt`;
                if (ns.fileExists(reportFile)) {
                    const data = JSON.parse(ns.read(reportFile));
                    if (data.neighbors && Array.isArray(data.neighbors)) {
                        for (const n of data.neighbors) {
                            if (!serverState.all.has(n)) {
                                serverState.all.set(n, { host: n, discoveredAt: Date.now() });
                            }
                        }
                    }
                }
            } catch (e) {}
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
//  阶段2: 认证
// ═══════════════════════════════════════════════════════════════════

async function attemptAuthentication(ns, serverState) {
    const unauthed = [];
    for (const [host, info] of serverState.all) {
        if (serverState.authed.has(host) || !info.isOnline) continue;
        unauthed.push(info);
    }
    if (unauthed.length === 0) return;

    unauthed.sort((a, b) => a.difficulty - b.difficulty);

    for (const info of unauthed) {
        if (serverState.authed.has(info.host)) continue;
        const passwords = generatePasswords(info.passwordHint, info.passwordLength);
        for (const pwd of passwords) {
            try {
                const r = ns.dnet.authenticate(info.host, pwd);
                if (r.success) {
                    serverState.authed.add(info.host);
                    const stored = serverState.all.get(info.host);
                    if (stored) stored.hasSession = true;
                    ns.print(`SUCCESS: 认证成功! ${info.host} (密码: ${pwd})`);
                    break;
                }
            } catch (e) {}
            await ns.sleep(50);
        }
        await ns.sleep(100);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  阶段3: 部署 Worker
// ═══════════════════════════════════════════════════════════════════

async function deployWorkers(ns, serverState, options, totalStats) {
    const activeWorkers = serverState.workerPids.size;
    const maxWorkers = options['max-workers'];

    for (const [host, info] of serverState.all) {
        if (!serverState.authed.has(host) || serverState.workerPids.has(host)) continue;
        if (activeWorkers >= maxWorkers) break;
        if (!info.isOnline) continue;

        try {
            await ns.scp(WORKER_SCRIPT, host, "home");

            let mode = 'all';
            if (options['phishing-only']) mode = 'phishing';
            else if (options['memory-only']) mode = 'memory';
            else {
                const modes = [];
                if (options['phishing']) modes.push('phishing');
                if (options['memory-realloc']) modes.push('memory');
                if (options['stock-promotion']) modes.push('stock');
                mode = modes.join(',') || 'all';
            }

            const pid = ns.exec(WORKER_SCRIPT, host, { threads: options['worker-threads'] },
                '--parent-pid', ns.pid,
                '--mode', mode,
                '--loop-delay', Math.max(2000, options['loop-delay'] - 1000),
                '--verbose', options['verbose'],
            );

            if (pid > 0) {
                serverState.workerPids.set(host, pid);
                totalStats.serversExplored++;
                ns.print(`SUCCESS: Worker 已部署到 ${host} (PID: ${pid}, 模式: ${mode})`);
            }
        } catch (e) {
            ns.print(`WARN: 部署到 ${host} 失败: ${e}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
//  阶段4: 收集 Worker 报告
// ═══════════════════════════════════════════════════════════════════

async function collectWorkerReports(ns, serverState, knownCaches, totalStats, options) {
    for (const [host, pid] of serverState.workerPids) {
        const reportFile = `${REPORT_PREFIX}${host.replace(/[^a-zA-Z0-9]/g, '_')}.txt`;
        if (!ns.fileExists(reportFile)) continue;
        try {
            const data = JSON.parse(ns.read(reportFile));
            totalStats.moneyEarned += data.money || 0;
            totalStats.phishAttempts += data.phishing || 0;
            totalStats.memoryFreed += data.memory || 0;
            totalStats.stockPromotions += data.stock || 0;

            if (data.newCaches && Array.isArray(data.newCaches)) {
                for (const cache of data.newCaches) {
                    if (!knownCaches.has(cache)) {
                        knownCaches.add(cache);
                        ns.write(CACHE_LOG_FILE,
                            JSON.stringify({ fileName: cache, source: host, time: Date.now() }) + '\n', 'a');
                    }
                }
            }
            ns.rm(reportFile);
        } catch (e) {
            if (options['verbose']) ns.print(`WARN: 读取 ${host} 报告失败: ${e}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
//  阶段5: Worker 健康检查
// ═══════════════════════════════════════════════════════════════════

async function healthCheckWorkers(ns, serverState) {
    for (const [host, pid] of serverState.workerPids) {
        if (!ns.isRunning(pid)) {
            ns.print(`WARN: ${host} 上的 Worker 已停止，准备重启`);
            serverState.workerPids.delete(host);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
//  阶段6: 打开缓存文件
// ═══════════════════════════════════════════════════════════════════

async function openKnownCaches(ns, knownCaches, serverState, totalStats, options) {
    if (knownCaches.size === 0) return;
    const toOpen = [...knownCaches];
    let opened = 0;

    for (const cacheName of toOpen) {
        try {
            const result = ns.dnet.openCache(cacheName, false);
            if (result.success) {
                opened++;
                knownCaches.delete(cacheName);
                ns.write(CACHE_LOG_FILE,
                    JSON.stringify({ fileName: cacheName, opened: true, time: Date.now() }) + '\n', 'a');
                const msg = result.message || '';
                if (msg) {
                    ns.print(`SUCCESS: 🎁 缓存收益: ${msg}`);
                    if (msg.includes('$')) totalStats.cachesOpened++;
                    if (msg.match(/augmentation|Augmentation/i)) ns.tprint(`🎉 重大发现! ${msg}`);
                    if (msg.match(/program|Program/i)) ns.tprint(`🎉 缓存发现程序: ${msg}`);
                    if (msg.match(/WSE|TIX|4S/i)) ns.tprint(`🎉 缓存发现股票账户/数据: ${msg}`);
                }
            } else {
                knownCaches.delete(cacheName);
                if (options['verbose']) ns.print(`WARN: 打开缓存 ${cacheName} 失败: ${result.message}`);
            }
        } catch (e) {
            if (options['verbose']) ns.print(`WARN: 打开缓存 ${cacheName} 异常: ${e}`);
        }
        totalStats.cachesOpened = opened;
        await ns.sleep(200);
    }
    if (opened > 0) ns.print(`INFO: 本轮打开 ${opened} 个缓存文件`);
}

// ═══════════════════════════════════════════════════════════════════
//  阶段7: 迷宫实验室
// ═══════════════════════════════════════════════════════════════════

async function attemptLabyrinth(ns, serverState, options) {
    try {
        const playerInfo = JSON.parse(
            await getNsDataThroughFile(ns, 'JSON.stringify((() => { const p = ns.getPlayer(); return { cha: p.skills.charisma, city: p.city }; })())', '/Temp/dnet-player-cha-city.txt')
        );
        if (!playerInfo || playerInfo.cha < 300) return;
    } catch (e) { return; }

    try {
        const report = ns.dnet.labreport();
        if (report && report.success) {
            ns.print(`INFO: 🧪 实验室位置报告: ${report.message}`);
            try {
                const radar = ns.dnet.labradar();
                if (radar && radar.success && options['verbose']) {
                    ns.print(`INFO: 🧪 实验室雷达:\n${radar.message}`);
                }
            } catch (e) {}
        }
    } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════
//  辅助函数
// ═══════════════════════════════════════════════════════════════════

function generatePasswords(hint, length) {
    const candidates = new Set();
    if (!hint) {
        for (const pwd of ['admin', 'root', 'password', '123456', 'bitburner', 'darknet', 'darkweb', 'guest',
            'letmein', 'welcome', 'qwerty', 'passw0rd', 'p@ssword', 'admin123', 'toor', 'secret']) {
            candidates.add(pwd);
        }
        return [...candidates];
    }

    const cleaned = hint.replace(/[.,!?;:"]/g, '');
    const words = cleaned.split(/\s+/).filter(w => w.length > 0);

    for (const word of words) {
        if (word.length <= length) {
            candidates.add(word.toLowerCase());
            candidates.add(word.toUpperCase());
            candidates.add(word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
        }
        const reversed = word.split('').reverse().join('');
        if (reversed.length <= length) candidates.add(reversed.toLowerCase());
        for (let i = 0; i <= 9; i++) { const withNum = word.toLowerCase() + i; if (withNum.length <= length) candidates.add(withNum); }
        for (let i = 10; i <= 99; i++) { const withNum = word.toLowerCase() + i; if (withNum.length <= length) candidates.add(withNum); }
        candidates.add(word.toLowerCase().replace(/a/g, '@').replace(/s/g, '$').replace(/o/g, '0').replace(/e/g, '3'));
    }

    if (words.length >= 2) {
        const combined = words.join('').toLowerCase();
        if (combined.length <= length) candidates.add(combined);
        const underscore = words.join('_').toLowerCase();
        if (underscore.length <= length) candidates.add(underscore);
    }

    return [...candidates].slice(0, 30);
}

function printReport(ns, serverState, totalStats, cycleCount) {
    ns.tprint("-".repeat(60));
    ns.tprint(`  📊 暗网收益报告 [#${cycleCount}]`);
    ns.tprint(`  🌐 服务器: ${serverState.all.size} 已知, ${serverState.authed.size} 已认证, ${serverState.workerPids.size} 活跃Worker`);
    ns.tprint(`  🎣 钓鱼: ${totalStats.phishAttempts} 次`);
    ns.tprint(`  🧠 内存释放: ${totalStats.memoryFreed} 次`);
    ns.tprint(`  📦 缓存打开: ${totalStats.cachesOpened} 个`);
    ns.tprint(`  📈 股票宣传: ${totalStats.stockPromotions} 次`);
    ns.tprint("-".repeat(60));
}
