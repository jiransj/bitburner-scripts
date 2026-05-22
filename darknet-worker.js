/**
 * darknet-worker.js — 暗网工作子进程
 *
 * 由 darknet-farmer.js 通过 ns.exec 部署到暗网服务器上运行。
 * 负责执行实际的暗网操作并通过报告文件向主进程汇报。
 *
 * 【操作类型】
 *   1. phishingAttack — 钓鱼攻击 (主要收益)
 *   2. memoryReallocation — 内存释放 (完全清除⇒缓存)
 *   3. promoteStock — 股票宣传 (提高波动性)
 *   4. probe — 探测邻居 (扩展探索范围)
 *
 * 【汇报方式】
 *   写入 /Temp/darknet_report_<host>.txt JSON 文件
 *   主进程定期读取并汇总
 *
 * @param {NS} ns
 * @param {string} --mode phishing|memory|stock|all|probe
 * @param {number} --parent-pid 主进程 PID
 * @param {boolean} --verbose 详细日志
 */
const argsSchema = [
    ['parent-pid', 0],
    ['mode', 'all'],
    ['loop-delay', 5000],
    ['verbose', false],
];

/** @param {NS} ns */
export async function main(ns) {
    const flags = ns.flags(argsSchema);
    const parentPid = flags['parent-pid'];
    const mode = flags['mode'];
    const isVerbose = flags['verbose'];
    const currentHost = ns.getHostname();

    // ── 确认在暗网服务器上 ──
    let isDarknet = false;
    try {
        isDarknet = ns.dnet.isDarknetServer();
    } catch (e) {
        // ignore
    }
    if (!isDarknet) {
        ns.tprint(`ERROR: ${currentHost} 不是暗网服务器，无法运行`);
        ns.exit();
        return;
    }

    ns.print(`INFO: Worker 已启动 on ${currentHost}, 模式: ${mode}`);

    // ── 首次启动: 尝试建立会话 ──
    try {
        const details = ns.dnet.getServerDetails();
        if (!details.hasSession && details.isOnline) {
            // 尝试常见密码自动认证
            for (const pwd of ['admin', 'root', 'password', '123456', 'darknet', 'bitburner', 'guest', 'qwerty']) {
                try {
                    const result = ns.dnet.authenticate(currentHost, pwd);
                    if (result.success) {
                        ns.print(`SUCCESS: 自动认证成功 on ${currentHost}`);
                        break;
                    }
                } catch (e) {}
                await ns.sleep(100);
            }
        }
    } catch (e) {}

    // ── 主循环 ──
    while (true) {
        const startTime = Date.now();
        const report = {
            host: currentHost,
            timestamp: startTime,
            phishing: 0,
            memory: 0,
            stock: 0,
            newCaches: [],
            neighbors: [],
            money: 0,
        };

        try {
            // ── 探测邻居(每次循环都执行) ──
            try {
                const neighbors = ns.dnet.probe();
                report.neighbors = neighbors;
            } catch (e) {}

            // ── 钓鱼攻击 ──
            if (mode === 'all' || mode.includes('phishing')) {
                try {
                    const result = ns.dnet.phishingAttack();
                    report.phishing++;
                    if (result.success && result.message) {
                        if (result.message.includes('cache') || result.message.includes('Cache')) {
                            // 钓鱼产生了缓存 - 我们无法直接得知文件名，需要主进程扫描
                            report.newCaches.push('__phishing_cache_generated__');
                        }
                        if (isVerbose) ns.print(`INFO: 钓鱼结果: ${result.message}`);
                    }
                } catch (e) {
                    if (isVerbose) ns.print(`WARN: 钓鱼失败: ${e}`);
                }
            }

            // ── 内存释放 ──
            if (mode === 'all' || mode.includes('memory')) {
                try {
                    const details = ns.dnet.getServerDetails();
                    if (details.isOnline && details.blockedRam > 0) {
                        const result = ns.dnet.memoryReallocation();
                        if (result.success) {
                            report.memory++;
                            if (isVerbose) ns.print(`INFO: 内存释放: ${result.message}`);
                        }
                    }
                } catch (e) {
                    if (isVerbose && !e.toString().includes('direct')) {
                        ns.print(`WARN: 内存释放失败: ${e}`);
                    }
                }
            }

            // ── 尝试打开本服务器的缓存 ──
            // (仅限已知缓存文件 - 但worker无法知道文件名)
            // 这部分由主进程统一处理

            // ── 股票宣传 ──
            if (mode === 'all' || mode.includes('stock')) {
                try {
                    const symbols = ns.stock?.getSymbols();
                    if (symbols && symbols.length > 0) {
                        // 随机选一支宣传
                        const symbol = symbols[Math.floor(Math.random() * symbols.length)];
                        const result = ns.dnet.promoteStock(symbol);
                        if (result.success) {
                            report.stock++;
                            if (isVerbose) ns.print(`INFO: 股票宣传: ${symbol}`);
                        }
                    }
                } catch (e) {
                    // 没有股票API访问权限
                }
            }

        } catch (e) {
            ns.print(`ERROR: Worker 循环异常: ${e}`);
        }

        // ── 写入报告文件 ──
        try {
            const reportFile = `/Temp/darknet_report_${currentHost.replace(/[^a-zA-Z0-9]/g, '_')}.txt`;
            await ns.write(reportFile, JSON.stringify(report), 'w');
        } catch (e) {
            ns.print(`WARN: 写入报告失败: ${e}`);
        }

        // ── 循环间隔 ──
        const elapsed = Date.now() - startTime;
        const delay = Math.max(1000, flags['loop-delay'] - elapsed);
        await ns.sleep(delay);
    }
}
