/** @param {NS} ns
 * the purpose of the program-manager is to buy all the programs
 * from the darkweb we can afford so we don't have to do it manually
 * or write them ourselves. Like tor-manager, this script dies a natural death
 * once all programs are bought.
 *
 * Note: this includes non-port-cracker programs such as DeepscanV1/V2, AutoLink,
 * ServerProfiler, Formulas and DarkscapeNavigator.exe (which unlocks the DarkNet).
 * Items are purchased in ascending price order so we always make progress even
 * on a tight budget. **/
export async function main(ns) {
    const interval = 2000;

    const keepRunning = ns.args.length > 0 && ns.args[0] == "-c";
    if (!keepRunning)
        ns.print(`program-manager will run once. Run with argument "-c" to run continuously.`)

    do {
        // Ask the game for the complete list of current dark web programs rather than
        // hard-coding them, so newly added programs (e.g. DarkscapeNavigator.exe) are
        // picked up automatically. (Requires TOR router; returns [] before it is bought.)
        let programNames = [];
        try {
            programNames = ns.singularity.getDarkwebPrograms();
        } catch (e) {
            const msg = String(e);
            if (msg.includes("Source-File 4")) {
                ns.print("无法访问 singularity API：需要开启 Source-File 4（或处于 BitNode 4）。已退出，等待下次周期重试。");
            } else {
                ns.print(`getDarkwebPrograms 异常: ${msg}`);
            }
            return; // 无法购买，直接退出（daemon 会按周期重新拉起）
        }

        // Buy the cheapest program we can afford first so we always make progress.
        programNames.sort((a, b) => {
            try {
                return ns.singularity.getDarkwebProgramCost(a) - ns.singularity.getDarkwebProgramCost(b);
            } catch (e) {
                return 0; // 个别程序查不到价格时保持原顺序
            }
        });

        let foundMissingProgram = false;
        for (const prog of programNames) {
            if (ns.fileExists(prog, "home")) continue; // Already owned (purchased or created)
            if (ns.singularity.purchaseProgram(prog)) {
                ns.toast(`Purchased ${prog}`, 'success');
                ns.print(`Purchased ${prog}`);
            } else if (keepRunning) {
                foundMissingProgram = true; // Couldn't afford it (yet), will retry next cycle
            }
        }
        if (keepRunning && foundMissingProgram)
            await ns.sleep(interval);
    } while (keepRunning && foundMissingProgram);
}
