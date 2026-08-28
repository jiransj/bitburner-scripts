/** @param {NS} ns
 * the purpose of the program-manager is to buy all the programs
 * from the darkweb we can afford so we don't have to do it manually
 * or write them ourselves. Like tor-manager, this script dies a natural death
 * once all programs are bought.
 *
 * 包含非端口破解程序：DeepscanV1/V2、AutoLink、ServerProfiler、Formulas、DarkscapeNavigator.exe（解锁 DarkNet）。
 *
 * ==== RAM 说明（重要） ====
 * Bitburner 的 singularity API 在 SF4 等级 <= 1 时有 ×16 惩罚、等级 2 时 ×4
 * （见游戏源码 src/Netscript/RamCostGenerator.ts 的 SF4Cost()）：
 *   - purchaseProgram:        2GB  × 16 = 32GB   (SF4 1 级)
 *   - getDarkwebPrograms:     0.5GB× 16 =  8GB
 *   - getDarkwebProgramCost:  0.5GB× 16 =  8GB
 * 本脚本因此不再调用 getDarkwebPrograms()/getDarkwebProgramCost()（各自 8GB），
 * 程序列表与价格顺序改用内置常量；只保留唯一必要的 purchaseProgram 调用。
 * 注意：SF4 1 级时 purchaseProgram 仍占 32GB，需要 home 有足够空闲 RAM；
 *       最省事的方式是把 SF4 提升到 3 级（Dev Menu → Source Files）或处于 BN4 内。 **/
export async function main(ns) {
    // 与 daemon.js 的 darkwebProgramNames 一致，且严格按价格升序（便宜的优先买）
    const programNames = ["DeepscanV1.exe", "ServerProfiler.exe", "BruteSSH.exe", "AutoLink.exe", "FTPCrack.exe",
        "relaySMTP.exe", "DeepscanV2.exe", "HTTPWorm.exe", "DarkscapeNavigator.exe", "SQLInject.exe", "Formulas.exe"];

    const interval = 2000;

    const keepRunning = ns.args.length > 0 && ns.args[0] == "-c";
    if (!keepRunning)
        ns.print(`program-manager will run once. Run with argument "-c" to run continuously.`)

    do {
        let foundMissingProgram = false;
        for (const prog of programNames) {
            if (ns.fileExists(prog, "home")) continue; // Already owned (purchased or created)
            let purchased = false;
            try {
                purchased = ns.singularity.purchaseProgram(prog);
            } catch (e) {
                const msg = String(e);
                if (msg.includes("Source-File 4")) {
                    ns.print("无 singularity 权限：需要 SF4（或处于 BitNode 4）。已退出，等待下次周期重试。");
                } else {
                    ns.print(`purchaseProgram 异常: ${msg}`);
                }
                return; // 无法购买，直接退出（daemon / autopilot 会按周期重新拉起）
            }
            if (purchased) {
                ns.toast(`Purchased ${prog}`, 'success');
                ns.print(`Purchased ${prog}`);
            } else if (keepRunning) {
                foundMissingProgram = true; // 暂时买不起（或缺 TOR），下轮再试
            }
        }
        if (keepRunning && foundMissingProgram)
            await ns.sleep(interval);
    } while (keepRunning && foundMissingProgram);
}
