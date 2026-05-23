/** dnet-probe.js — 暗网探针（~2.5GB，可在 darkweb 16GB 上运行）*/
export async function main(ns) {
    const op = ns.args[0] || "probe";
    const out = "/Temp/dnetp.txt";
    try {
        if (op === "probe") {
            const hosts = ns.dnet.probe();
            const list = [];
            for (const h of hosts) {
                try { const d = ns.dnet.getServerDetails(h); list.push({ host: h, online: d.isOnline, depth: d.depth, diff: d.difficulty, cha: d.requiredCharismaSkill, hint: d.passwordHint, len: d.passwordLength, authed: d.hasSession }); }
                catch (e) { list.push({ host: h, online: false }); }
            }
            ns.write(out, JSON.stringify({ ok: true, data: list }), "w");
        } else if (op === "auth") {
            const r = ns.dnet.authenticate(ns.args[1], ns.args[2]);
            ns.write(out, JSON.stringify({ ok: r.success, pwd: ns.args[2] }), "w");
        } else if (op === "lab") {
            const r = ns.dnet.labreport();
            ns.write(out, JSON.stringify({ ok: r.success, msg: r.message }), "w");
        } else if (op === "cache") {
            const r = ns.dnet.openCache(ns.args[1]);
            ns.write(out, JSON.stringify({ ok: r.success, msg: r.message }), "w");
        }
    } catch (e) { ns.write(out, JSON.stringify({ ok: false, err: String(e) }), "w"); }
}
