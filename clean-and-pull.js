/**
 * 清理旧文件并重新拉取最新版本
 * 用法: run clean-and-pull.js
 */
/** @param {NS} ns */
export async function main(ns) {
    const files = [
        "darknet-farmer.js",
        "darknet-worker.js",
        "darknet-farmer.js.og.js",
        "darknet-worker.js.og.js",
    ];

    // 先删除本地旧文件
    for (const f of files) {
        if (ns.fileExists(f, "home")) {
            ns.rm(f, "home");
            ns.tprint(`已删除: ${f}`);
        }
    }

    // 删除 Temp 目录下的缓存
    const tempFiles = ns.ls("home", "/Temp/");
    for (const f of tempFiles) {
        ns.rm(f, "home");
    }
    ns.tprint(`已清理 ${tempFiles.length} 个 Temp 文件`);

    // 运行 git-pull
    ns.tprint("正在拉取最新代码...");
    ns.run("git-pull.js");
}
