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
 * 【收益策略 - 基于源码分析】
 *
 *   📦 缓存文件收益 (cacheFiles.ts)
 *     - 金钱: 1.2^难度 * 1e7 * ((200+cha)/200) * 乘数 → 随难度指数增长
 *     - 股票: 免费获得 1+难度*5+随机(10) 股随机股票
 *     - 程序: 自动获得 BruteSSH/FTPCrack/DeepScan 等(无需等待创建)
 *     - 账户: 免费 WSE/4S Data/TIX API(价值数百万!)
 *     - 实验室: 免费 NeuroFlux Governor 或专属 Augmentation
 *
 *   🎣 钓鱼攻击 (phishing.ts)
 *     - 冷却: 3分钟产生缓存文件
 *     - 金钱: 500 * 乘数 * depth因子 * 线程 * ((400+cha)/400)
 *     - 缓存概率: 0.5% * success_mult * 线程 * ((400+cha)/400)
 *     - 金钱概率: 5% * success_mult * ((200+cha)/200)
 *     - 收益最大化: 高线程 + 深度大的服务器 + 高 Charisma
 *
 *   🧠 内存释放 (ramblock.ts)
 *     - 每次释放: 0.02 * 2*0.92^难度 * 线程 * (1+cha/100) GB
 *     - 完全清除时 ⇒ 产生一个缓存文件 + 30%线索 + 15% StormSeed
 *
 *   📈 股票宣传 (Darknet.ts promoteStock)
 *     - 宣传量 = 线程 * ((500+cha)/500)
 *     - 配合 stockmaster.js 提高股价波动性
 *
 *   迷宫实验室 (labyrinth.ts)
 *     - NormalLab: 深度7, 需300cha, 20x14迷宫
 *     - CruelLab: 深度12, 需600cha, 30x20迷宫
 *     - MercilessLab: 深度19, 需1500cha, 40x30迷宫
 *     - 实验室缓存 ⇒ 免费 Augmentation !!
 *
 * 【使用方法】
 *   run darknet-farmer.js --tail                      # 默认模式(全部开启)
 *   run darknet-farmer.js --stock-promotion --tail     # 开启股票宣传
 *   run darknet-farmer.js --phishing-only --tail       # 仅钓鱼模式
 *   run darknet-farmer.js --memory-only --tail         # 仅内存释放模式
 *
 * 【依赖】
 *   需要 Bitburner v3.0+ (VersionNumber >= 44)
 *   需要已接入暗网(通过 darkweb 或 Tor 路由)
 *   可选: TIX API 访问(用于股票宣传)
 *
 * @author jiransj
 */

import { getNsDataThroughFile, getConfiguration, disableLogs, formatMoney, formatNumberShort } from "./helpers.js";

const argsSchema = [
    ['loop-delay', 5000],            // 主循环间隔(ms)
    ['phishing', true],              // 启用钓鱼攻击
    ['memory-realloc', true],        // 启用内存重分配
    ['stock-promotion', false],      // 启用股票宣传(需TIX API)
    ['labyrinth', true],             // 探索迷宫实验室
    ['verbose', false],              // 详细日志
    ['phishing-only', false],        // 仅钓鱼模式(快捷)
    ['memory-only', false],          // 仅内存模式(快捷)
    ['max-workers', 5],              // 同时运行的worker最大数量
    ['worker-threads', 1],           // worker线程数
    ['reserve', 0],                  // 保留资金
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

    // 快捷模式
    if (options['phishing-only']) {
        options['phishing'] = true;
        options['memory-realloc'] = false;
        options['stock-promotion'] = false;
    }
    if (options['memory-only']) {
        options['phishing'] = false;
        options['memory-realloc'] = true;
        options['stock-promotion'] = false;
    }

    // ── 前置检查 ──
    if (!ns.dnet) {
        ns.tprint("ERROR: 需要 Bitburner v3.0+，未检测到 ns.dnet API");
        ns.exit();
        return;
    }

    // 检查 WORKER_SCRIPT 是否存在
    if (!ns.fileExists(WORKER_SCRIPT, "home")) {
        ns.tprint(`ERROR: 找不到工作脚本 ${WORKER_SCRIPT}，请确保它与 darknet-farmer.js 在同一目录`);
        ns.exit();
        return;
    }

    ns.tprint("=".repeat(60));
    ns.tprint("  暗网自动收益脚本 v1.0 已启动");
    ns.tprint(`  模式: ${options['phishing'] ? '钓鱼 ' : ''}${options['memory-realloc'] ? '内存 ' : ''}${options['stock-promotion'] ? '股票 ' : ''}${options['labyrinth'] ? '迷宫' : ''}`);
    ns.tprint("=".repeat(60));

    // ── 状态变量 ──
    const serverState = {
        /** @type {Map<string, ServerInfo>} */
        all: new Map(),          // hostname → ServerInfo
        authed: new Set(),       // 已认证的服务器
        workerPids: new Map(),   // hostname → PID
    };

    let totalStats = {
        moneyEarned: 0,
        cachesOpened: 0,
        phishAttempts: 0,
        memoryFreed: 0,
        stockPromotions: 0,
        serversExplored: 0,
    };

    // 读取历史缓存记录
    const knownCaches = new Set();
    try {
        const cacheLog = ns.read(CACHE_LOG_FILE);
        if (cacheLog) {
            for (const line of cacheLog.split('\n').filter(l => l.trim())) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.fileName) knownCaches.add(entry.fileName);
                } catch (e) {}
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
            // ── 阶段1: 探索暗网拓扑 ──
            await exploreAndMap(ns, serverState);

            // ── 阶段2: 认证新服务器 ──
            await attemptAuthentication(ns, serverState);

            // ── 阶段3: 部署 Worker 到已认证的暗网服务器 ──
            await deployWorkers(ns, serverState, options, totalStats);

            // ── 阶段4: 收集 Worker 报告 ──
            await collectWorkerReports(ns, serverState, knownCaches, totalStats, options);

            // ── 阶段5: Worker 健康检查(重启宕掉的) ──
            await healthCheckWorkers(ns, serverState, options);

            // ── 阶段6: 尝试打开缓存文件 ──
            if (knownCaches.size > 0) {
                await openKnownCaches(ns, knownCaches, serverState, totalStats, options);
            }

            // ── 阶段7: 探索迷宫实验室 ──
            if (options['labyrinth']) {
                await attemptLabyrinth(ns, serverState, options);
            }

            // ── 定期状态报告 ──
            if (Date.now() - lastReport > 30000) { // 每30秒
                lastReport = Date.now();
                printReport(ns, serverState, totalStats, cycleCount);
            }

        } catch (e) {
            ns.print(`WARN: 主循环异常: ${e}`);
            if (options['verbose']) ns.print(`堆栈: ${e.stack}`);
        }

        const elapsed = Date.now() - cycleStart;
        const delay = Math.max(500, options['loop-delay'] - elapsed);
        await ns.sleep(delay);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  阶段1: 探索
// ═══════════════════════════════════════════════════════════════════

/**
 * 从当前服务器向外探测，发现新的暗网服务器
 */
async function exploreAndMap(ns, serverState) {
    let newFound = 0;
    const toExplore = new Set();

    // 尝试探测当前所在服务器
    try {
        const neighbors = ns.dnet.probe();
        for (const host of neighbors) {
            if (!serverState.all.has(host)) {
                toExplore.add(host);
            }
        }
    } catch (e) {
        // 当前不在暗网服务器上
    }

    // 获取已知服务器的详细信息
    for (const host of toExplore) {
        try {
            const details = ns.dnet.getServerDetails(host);
            if (details.isOnline) {
                serverState.all.set(host, {
                    host,
                    isOnline: true,
                    depth: details.depth || 0,
                    difficulty: details.difficulty || 0,
                    requiredCharisma: details.requiredCharismaSkill || 0,
                    passwordHint: details.passwordHint || '',
                    passwordLength: details.passwordLength || 0,
                    isStationary: details.isStationary || false,
                    hasSession: details.hasSession || false,
                    isConnected: details.isConnectedToCurrentServer || false,
                    blockedRam: details.blockedRam || 0,
                    discoveredAt: Date.now(),
                });
                if (details.hasSession) {
                    serverState.authed.add(host);
                }
                newFound++;
            }
        } catch (e) {
            // 无法获取细节，但仍记录
            serverState.all.set(host, {
                host,
                isOnline: false,
                discoveredAt: Date.now(),
            });
            newFound++;
        }
    }

    if (newFound > 0) {
        ns.print(`INFO: 发现 ${newFound} 个新暗网服务器(共 ${serverState.all.size} 个)`);
    }

    // 从 worker 运行的服务器也收集邻居信息
    for (const [host, pid] of serverState.workerPids) {
        if (pid && ns.isRunning(pid)) {
            try {
                // 通过读取 worker 报告中的邻居信息
                const reportFile = `${REPORT_PREFIX}${sanitizeHost(host)}.txt`;
                if (ns.fileExists(reportFile)) {
                    const content = ns.read(reportFile);
                    if (content) {
                        try {
                            const data = JSON.parse(content);
                            if (data.neighbors && Array.isArray(data.neighbors)) {
                                for (const n of data.neighbors) {
                                    if (!serverState.all.has(n)) {
                                        ns.print(`INFO: 通过 worker 发现新服务器: ${n}`);
                                        // 标记为已知但不探索详情(下一轮会处理)
                                        serverState.all.set(n, { host: n, discoveredAt: Date.now() });
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                }
            } catch (e) {}
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
//  阶段2: 认证
// ═══════════════════════════════════════════════════════════════════

/**
 * 尝试对发现的服务器进行密码认证
 */
async function attemptAuthentication(ns, serverState) {
    // 收集未认证的在线服务器
    const unauthed = [];
    for (const [host, info] of serverState.all) {
        if (serverState.authed.has(host)) continue;
        if (!info.isOnline) continue;
        unauthed.push(info);
    }

    if (unauthed.length === 0) return;

    // 按难度排序(优先低难度)
    unauthed.sort((a, b) => a.difficulty - b.difficulty);

    for (const info of unauthed) {
        if (serverState.authed.has(info.host)) continue;

        // 根据密码提示生成尝试密码
        const passwords = generatePasswords(info.passwordHint, info.passwordLength);

        for (const pwd of passwords) {
            try {
                const result = ns.dnet.authenticate(info.host, pwd);
                if (result.success) {
                    serverState.authed.add(info.host);
                    // 更新服务器信息中的会话状态
                    const stored = serverState.all.get(info.host);
                    if (stored) stored.hasSession = true;
                    ns.print(`SUCCESS: 认证成功! ${info.host} (密码: ${pwd})`);
                    break;
                }
            } catch (e) {
                // 认证失败继续
            }
            await ns.sleep(50);
        }

        await ns.sleep(100);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  阶段3: 部署 Worker
// ═══════════════════════════════════════════════════════════════════

/**
 * 向已认证的暗网服务器部署 Worker 脚本
 */
async function deployWorkers(ns, serverState, options, totalStats) {
    const activeWorkers = serverState.workerPids.size;
    const maxWorkers = options['max-workers'];

    for (const [host, info] of serverState.all) {
        if (!serverState.authed.has(host)) continue;
        if (serverState.workerPids.has(host)) continue; // 已有worker
        if (activeWorkers >= maxWorkers) break; // 达到上限

        // 检查服务器在线状态
        if (!info.isOnline) continue;

        try {
            // 计算工作模式
            let mode = 'all';
            if (options['phishing-only']) mode = 'phishing';
            else if (options['memory-only']) mode = 'memory';
            else {
                const modes = [];
                if (options['phishing']) modes.push('phishing');
                if (options['memory-realloc']) modes.push('memory');
                if (options['stock-promotion']) modes.push('stock');
                mode = modes.join(',');
                if (mode === '') mode = 'all';
            }

            // 复制 worker 脚本到目标服务器
            await ns.scp(WORKER_SCRIPT, host, "home");

            // 启动 worker
            const pid = ns.exec(
                WORKER_SCRIPT,
                host,
                { threads: options['worker-threads'] },
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

/**
 * 读取所有 Worker 写入的报告文件，汇总收益
 */
async function collectWorkerReports(ns, serverState, knownCaches, totalStats, options) {
    for (const [host, pid] of serverState.workerPids) {
        const reportFile = `${REPORT_PREFIX}${sanitizeHost(host)}.txt`;
        if (!ns.fileExists(reportFile)) continue;

        try {
            const content = ns.read(reportFile);
            if (!content) continue;

            const data = JSON.parse(content);
            // 累加统计
            totalStats.moneyEarned += data.money || 0;
            totalStats.phishAttempts += data.phishing || 0;
            totalStats.memoryFreed += data.memory || 0;
            totalStats.stockPromotions += data.stock || 0;

            // 记录新发现的缓存
            if (data.newCaches && Array.isArray(data.newCaches)) {
                for (const cache of data.newCaches) {
                    if (!knownCaches.has(cache)) {
                        knownCaches.add(cache);
                        ns.print(`INFO: 发现新缓存文件: ${cache} (on ${host})`);
                        // 写入持久化日志
                        ns.write(CACHE_LOG_FILE,
                            JSON.stringify({ fileName: cache, source: host, time: Date.now() }) + '\n', 'a');
                    }
                }
            }

            // 记录新发现的邻居(用于探索)
            if (data.neighbors && Array.isArray(data.neighbors)) {
                for (const n of data.neighbors) {
                    if (!serverState.all.has(n)) {
                        serverState.all.set(n, { host: n, discoveredAt: Date.now() });
                    }
                }
            }

            // 清除报告文件(避免重复读取)
            // 保留以让 worker 持续写入，通过时间戳判断新数据
            ns.rm(reportFile);

        } catch (e) {
            if (options['verbose']) {
                ns.print(`WARN: 读取 ${host} 报告失败: ${e}`);
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
//  阶段5: Worker 健康检查
// ═══════════════════════════════════════════════════════════════════

/**
 * 检查 Worker 进程是否存活，对已停止的重启
 */
async function healthCheckWorkers(ns, serverState, options) {
    const deadWorkers = [];
    for (const [host, pid] of serverState.workerPids) {
        if (!ns.isRunning(pid)) {
            deadWorkers.push(host);
        }
    }

    for (const host of deadWorkers) {
        ns.print(`WARN: ${host} 上的 Worker 已停止，准备重启`);
        serverState.workerPids.delete(host);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  阶段6: 打开缓存文件
// ═══════════════════════════════════════════════════════════════════

/**
 * 尝试打开已知的缓存文件获取收益
 *
 * 【收益优先级排序】
 * 1. 程序奖励 (BruteSSH/FTPCrack等) - 价值最高且不可替代
 * 2. WSE/TIX/4S 账户 - 免费解锁股票功能
 * 3. 金钱奖励 - 直接收益
 * 4. 股票奖励 - 长期持有
 * 5. 数据文件/线索 - 推进实验室进度
 */
async function openKnownCaches(ns, knownCaches, serverState, totalStats, options) {
    if (knownCaches.size === 0) return;

    const toOpen = [...knownCaches];
    let opened = 0;
    let moneyReport = 0;

    for (const cacheName of toOpen) {
        try {
            const result = ns.dnet.openCache(cacheName, false); // 不静默(显示Toast)
            if (result.success) {
                opened++;
                knownCaches.delete(cacheName);
                // 从日志文件中标记为已打开(通过在文件末尾追加标记)
                ns.write(CACHE_LOG_FILE,
                    JSON.stringify({ fileName: cacheName, opened: true, time: Date.now() }) + '\n', 'a');

                // 尝试从消息中提取收益信息
                if (result.message) {
                    ns.print(`SUCCESS: 🎁 缓存收益: ${result.message}`);
                    if (result.message.includes('$')) {
                        // 粗略提取金额... 实际上难以精确获取
                        moneyReport += 1; // 标记为有金钱收益
                    }
                    if (result.message.includes('augmentation') || result.message.includes('Augmentation')) {
                        ns.tprint(`🎉 重大发现! 缓存开出了 Augmentation: ${result.message}`);
                    }
                    if (result.message.includes('program') || result.message.includes('Program')) {
                        ns.tprint(`🎉 缓存发现程序: ${result.message}`);
                    }
                    if (result.message.includes('WSE') || result.message.includes('TIX') || result.message.includes('4S')) {
                        ns.tprint(`🎉 缓存发现股票账户/数据: ${result.message}`);
                    }
                }
            } else {
                // 打开失败，可能是服务器离线或文件已不存在
                knownCaches.delete(cacheName);
                if (options['verbose']) {
                    ns.print(`WARN: 打开缓存 ${cacheName} 失败: ${result.message}`);
                }
            }
        } catch (e) {
            // 可能无法从当前服务器打开该缓存
            if (options['verbose']) {
                ns.print(`WARN: 打开缓存 ${cacheName} 异常: ${e}`);
            }
        }

        totalStats.cachesOpened = opened;

        // 短暂间隔避免操作过快
        await ns.sleep(200);
    }

    if (opened > 0) {
        ns.print(`INFO: 本轮打开 ${opened} 个缓存文件`);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  阶段7: 迷宫实验室
// ═══════════════════════════════════════════════════════════════════

/**
 * 探索迷宫实验室
 *
 * 实验室是暗网中的特殊服务器，缓存可开出免费 Augmentation!
 */
async function attemptLabyrinth(ns, serverState, options) {
    // 检查是否有足够的 Charisma
    try {
        const playerInfo = JSON.parse(
            await getNsDataThroughFile(ns, 'JSON.stringify((() => { const p = ns.getPlayer(); return { cha: p.skills.charisma, city: p.city }; })())', '/Temp/dnet-player-cha-city.txt')
        );

        if (!playerInfo || playerInfo.cha < 300) {
            return; // Charisma 不够
        }
    } catch (e) {
        return;
    }

    // 尝试获取实验室位置
    try {
        const report = ns.dnet.labreport();
        if (report && report.success) {
            ns.print(`INFO: 🧪 实验室位置报告: ${report.message}`);
            // 成功连接实验室! 尝试雷达
            try {
                const radar = ns.dnet.labradar();
                if (radar && radar.success && options['verbose']) {
                    ns.print(`INFO: 🧪 实验室雷达:\n${radar.message}`);
                }
            } catch (e) {}
        }
    } catch (e) {
        // 不在实验室范围，正常
    }
}

// ═══════════════════════════════════════════════════════════════════
//  辅助函数
// ═══════════════════════════════════════════════════════════════════

/**
 * 根据密码提示生成候选密码列表
 */
function generatePasswords(hint, length) {
    const candidates = new Set();

    if (!hint) {
        // 无提示时的常用密码
        for (const pwd of ['admin', 'root', 'password', '123456', 'bitburner', 'darknet', 'darkweb', 'guest',
            'letmein', 'welcome', 'qwerty', 'passw0rd', 'p@ssword', 'admin123', 'toor', 'secret']) {
            candidates.add(pwd);
        }
        return [...candidates];
    }

    // 清理提示
    const cleaned = hint.replace(/[.,!?;:"]/g, '');
    const words = cleaned.split(/\s+/).filter(w => w.length > 0);

    for (const word of words) {
        if (word.length <= length) {
            candidates.add(word.toLowerCase());
            candidates.add(word.toUpperCase());
            candidates.add(word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
        }
        // 倒序
        const reversed = word.split('').reverse().join('');
        if (reversed.length <= length) {
            candidates.add(reversed.toLowerCase());
        }
        // 加数字后缀
        for (let i = 0; i <= 9; i++) {
            const withNum = word.toLowerCase() + i;
            if (withNum.length <= length) candidates.add(withNum);
        }
        for (let i = 10; i <= 99; i++) {
            const withNum = word.toLowerCase() + i;
            if (withNum.length <= length) candidates.add(withNum);
        }
        // Leet 替换
        candidates.add(word.toLowerCase().replace(/a/g, '@').replace(/s/g, '$').replace(/o/g, '0').replace(/e/g, '3'));
    }

    // 双词拼接
    if (words.length >= 2) {
        const combined = words.join('').toLowerCase();
        if (combined.length <= length) candidates.add(combined);
        const underscore = words.join('_').toLowerCase();
        if (underscore.length <= length) candidates.add(underscore);
    }

    return [...candidates].slice(0, 30); // 限制30个
}

/**
 * 将主机名转为安全的文件名
 */
function sanitizeHost(host) {
    return host.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

/**
 * 打印状态报告到终端
 */
function printReport(ns, serverState, totalStats, cycleCount) {
    const totalServers = serverState.all.size;
    const authedServers = serverState.authed.size;
    const activeWorkers = serverState.workerPids.size;

    ns.tprint("-".repeat(60));
    ns.tprint(`  📊 暗网收益报告 [#${cycleCount}]`);
    ns.tprint(`  🌐 服务器: ${totalServers} 已知, ${authedServers} 已认证, ${activeWorkers} 活跃Worker`);
    ns.tprint(`  🎣 钓鱼: ${totalStats.phishAttempts} 次`);
    ns.tprint(`  🧠 内存释放: ${totalStats.memoryFreed} 次`);
    ns.tprint(`  📦 缓存打开: ${totalStats.cachesOpened} 个`);
    ns.tprint(`  📈 股票宣传: ${totalStats.stockPromotions} 次`);
    ns.tprint("-".repeat(60));
}
