/**
 * force-pull.js — 强制从 GitHub 拉取最新脚本（绕过 git-pull 的缓存/限流问题）
 *
 * 用法: run force-pull.js
 */
const REPO = "https://raw.githubusercontent.com/jiransj/bitburner-scripts/main/";
const FILES = [
    "helpers.js",
    "darknet-farmer.js",
    "darknet-worker.js",
    "force-pull.js",
];

/** @param {NS} ns */
export async function main(ns) {
    ns.tprint("=".repeat(60));
    ns.tprint("  force-pull: 从 GitHub 强制拉取最新脚本");
    ns.tprint("=".repeat(60));
    let ok = 0, fail = 0;

    for (const f of FILES) {
        ns.print(`下载中: ${f} ...`);
        try {
            // 先删除旧文件（绕过任何本地缓存）
            ns.rm(f, "home");
            // 用 ns.wget 下载，加多层 cache busting
            const url = REPO + f + "?_=" + Date.now() + "&rnd=" + Math.random();
            const saved = await ns.wget(url, f);
            if (saved) {
                const size = ns.read(f).length;
                ns.tprint(`✅ ${f} (${(size/1024).toFixed(1)}KB)`);
                ok++;
            } else {
                // 重试一次
                await ns.sleep(100);
                const saved2 = await ns.wget(url, f);
                if (saved2) {
                    const size = ns.read(f).length;
                    ns.tprint(`✅ ${f} (重试成功, ${(size/1024).toFixed(1)}KB)`);
                    ok++;
                } else {
                    ns.tprint(`❌ ${f} 下载失败`);
                    fail++;
                }
            }
        } catch (e) {
            ns.tprint(`❌ ${f}: ${e}`);
            fail++;
        }
    }

    ns.tprint("-".repeat(60));
    ns.tprint(`  完成: ${ok} 成功, ${fail} 失败`);
    if (ok > 0) ns.tprint("  启动: run darknet-farmer.js --tail");
    ns.tprint("-".repeat(60));
}
