/** miniboot.js — 极简引导脚本，用 fetch 绕开 CDN 缓存 */
const RAW = "https://raw.githubusercontent.com/jiransj/bitburner-scripts/main/";
/** @param {NS} ns */
export async function main(ns) {
    const files = ["helpers.js", "darknet-farmer.js", "darknet-worker.js"];
    for (const f of files) {
        ns.print(`下载 ${f} ...`);
        const r = await fetch(RAW + f + "?t=" + Date.now());
        if (r && r.ok) { ns.write(f, await r.text(), "w"); ns.tprint(`✅ ${f}`); }
        else { ns.tprint(`❌ ${f}`); }
    }
    ns.tprint("完成! 运行: connect darkweb → home → run darknet-farmer.js --tail");
}
