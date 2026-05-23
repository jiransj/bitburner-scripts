/**
 * force-pull.js — 强制从 GitHub 下载最新脚本（绕过 git-pull 缓存问题）
 * 用法: run force-pull.js
 */
/** @param {NS} ns */
export async function main(ns) {
    const files = [
        "darknet-farmer.js",
        "darknet-proxy.js",
        "darknet-worker.js",
    ];
    const base = "https://raw.githubusercontent.com/jiransj/bitburner-scripts/main/";
    let ok = 0, fail = 0;
    for (const f of files) {
        // 先删除旧文件
        if (ns.fileExists(f, "home")) ns.rm(f, "home");
        // 直接 wget 下载
        const url = base + f;
        const success = await ns.wget(url, f);
        if (success) {
            ns.tprint(`✅ ${f}`);
            ok++;
        } else {
            ns.tprint(`❌ ${f} 下载失败`);
            fail++;
        }
    }
    ns.tprint(`完成: ${ok}成功, ${fail}失败`);
    if (ok > 0) ns.tprint("现在可以运行: run darknet-farmer.js --tail");
}
