/**
 * darknet-farmer.js — 暗网自动收益最大化脚本
 *
 * 【架构】
 *   home (40GB+) ←→ darkweb (16GB) ←→ 暗网服务器 (有RAM)
 *   主脚本          探针(2.5GB)        worker
 *
 *   ns.dnet API 只在暗网内有效，但暗网服务器 RAM 很小。
 *   因此用极轻量探针 dnet-probe.js 在 darkweb 上执行 dnet 调用，
 *   结果写文件传回 home 上的主脚本。
 *   Worker 直接部署到已认证的暗网服务器上运行。
 *
 * @author jiransj
 */

import { getNsDataThroughFile, getConfiguration, disableLogs } from "./helpers.js";

const argsSchema = [
    ['loop-delay', 5000], ['phishing', true], ['memory-realloc', true],
    ['stock-promotion', false], ['labyrinth', true], ['verbose', false],
    ['phishing-only', false], ['memory-only', false],
    ['max-workers', 5], ['worker-threads', 1], ['reserve', 0],
];

const WORKER = "darknet-worker.js";
const PROBE = "dnet-probe.js";
const REPORT_PREFIX = "/Temp/darknet_report_";
const CACHE_LOG = "/Temp/darknet_caches_found.txt";

export function autocomplete(data, args) { data.flags(argsSchema); return []; }

/** 在 darkweb 上执行探针，返回结果 */
async function probe(ns, ...args) {
    const out = "/Temp/dnetp.txt";
    ns.rm(out);
    // 确保探针在 darkweb 上
    if (!ns.fileExists(PROBE, "darkweb")) await ns.scp(PROBE, "darkweb", "home");
    const pid = ns.exec(PROBE, "darkweb", { temporary: true }, ...args);
    if (!pid) throw new Error("探针启动失败(darkweb 不支持 exec?)");
    // 等待结果（最长 15 秒）
    for (let i = 0; i < 75; i++) {
        await ns.sleep(200);
        if (ns.fileExists(out)) {
            const raw = ns.read(out);
            if (raw) return JSON.parse(raw);
        }
    }
    throw new Error("探针超时");
}

/** @param {NS} ns */
export async function main(ns) {
    const opt = getConfiguration(ns, argsSchema);
    if (!opt) { ns.tprint("ERROR: 配置解析失败"); ns.exit(); return; }
    disableLogs(ns, ['sleep', 'exec', 'scp', 'ls', 'read', 'write', 'rm']);

    if (ns.getHostname() !== "home") {
        ns.tprint(`ERROR: 请在 home 上运行(当前: ${ns.getHostname()})`); ns.exit(); return;
    }
    // 检查 worker 存在
    if (!ns.fileExists(WORKER, "home")) { ns.tprint(`ERROR: 缺少 ${WORKER}`); ns.exit(); return; }

    // 测试 darkweb 和探针
    let dwOk = false;
    try {
        if (await ns.scp(PROBE, "darkweb", "home")) {
            const r = await probe(ns, "probe");
            dwOk = r.ok;
            ns.print(`INFO: ✓ darkweb 探针就绪, 发现 ${r.data?.length || 0} 个服务器`);
        }
    } catch (e) { ns.print(`WARN: darkweb 不可达: ${e}`); }

    if (!dwOk) {
        ns.tprint("WARNING: 请先购买 Tor 路由器(终端: buy Tor → connect darkweb)");
        ns.tprint("INFO: 脚本将继续尝试连接...");
    }

    ns.tprint("=".repeat(60));
    ns.tprint("  暗网自动收益脚本 v1.0 [探针模式]");
    ns.tprint("=".repeat(60));

    // 状态
    const st = { all: new Map(), authed: new Set(), workerPids: new Map() };
    const stats = { money: 0, caches: 0, phish: 0, memory: 0, stock: 0, explored: 0 };
    const knownCaches = new Set();
    try { const log = ns.read(CACHE_LOG); if (log) for (const l of log.split('\n').filter(s => s.trim())) { try { const e = JSON.parse(l); if (e.fileName) knownCaches.add(e.fileName); } catch (e) {} } } catch (e) {}

    let lastReport = Date.now(), cycle = 0;

    while (true) {
        cycle++;
        const t0 = Date.now();
        try {
            await explore(ns, st);
            await authenticate(ns, st);
            await deploy(ns, st, opt, stats);
            await collect(ns, st, knownCaches, stats, opt);
            await healthCheck(ns, st);
            if (knownCaches.size > 0) await openCaches(ns, knownCaches, stats, opt);
            if (opt['labyrinth']) await labyrinth(ns, opt);

            if (Date.now() - lastReport > 30000) { lastReport = Date.now(); report(ns, st, stats, cycle); }
            if (st.all.size === 0 && cycle % 12 === 0)
                ns.print("WARN: 未发现暗网服务器。请确认: ①已买Tor ②终端connect darkweb");
        } catch (e) { ns.print(`WARN: ${e}`); }

        await ns.sleep(Math.max(500, opt['loop-delay'] - (Date.now() - t0)));
    }
}

// 阶段1: 探索
async function explore(ns, st) {
    let found = 0;
    try {
        const r = await probe(ns, "probe");
        if (!r.ok || !r.data?.length) { ns.print("WARN: 探针未发现服务器"); return; }
        ns.print(`INFO: 发现 ${r.data.length} 个暗网服务器`);
        for (const s of r.data) {
            if (!st.all.has(s.host)) {
                st.all.set(s.host, { host: s.host, online: s.online, depth: s.depth || 0, diff: s.diff || 0,
                    cha: s.cha || 0, hint: s.hint || '', len: s.len || 0, authed: s.authed || false, ram: 0, found: Date.now() });
                if (s.authed) st.authed.add(s.host);
                found++;
            }
        }
    } catch (e) { ns.print(`WARN: 探索失败: ${e}`); }
    if (found > 0) ns.print(`INFO: 新增 ${found} 个, 共 ${st.all.size} 个`);

    // 从 worker 收集邻居
    for (const [host, pid] of st.workerPids) {
        if (pid && ns.isRunning(pid)) {
            try {
                const f = `${REPORT_PREFIX}${host.replace(/[^a-zA-Z0-9]/g, '_')}.txt`;
                if (ns.fileExists(f)) {
                    const d = JSON.parse(ns.read(f));
                    if (d.neighbors?.length) for (const n of d.neighbors)
                        if (!st.all.has(n)) st.all.set(n, { host: n, found: Date.now() });
                }
            } catch (e) {}
        }
    }
}

// 阶段2: 认证
async function authenticate(ns, st) {
    const list = [];
    for (const [h, info] of st.all) { if (!st.authed.has(h) && info.online) list.push(info); }
    if (!list.length) return;
    list.sort((a, b) => a.diff - b.diff);

    for (const info of list) {
        if (st.authed.has(info.host)) continue;
        const pwds = genPasswords(info.hint, info.len);
        for (const pwd of pwds) {
            try {
                const r = await probe(ns, "auth", info.host, pwd);
                if (r.ok) { st.authed.add(info.host); ns.print(`SUCCESS: ${info.host} (密码: ${pwd})`); break; }
            } catch (e) {}
        }
    }
}

// 阶段3: 部署 Worker
async function deploy(ns, st, opt, stats) {
    if (st.workerPids.size >= opt['max-workers']) return;
    for (const [host, info] of st.all) {
        if (!st.authed.has(host) || st.workerPids.has(host) || !info.online) continue;
        if (st.workerPids.size >= opt['max-workers']) break;
        try {
            await ns.scp(WORKER, host, "home");
            let mode = 'all';
            if (opt['phishing-only']) mode = 'phishing';
            else if (opt['memory-only']) mode = 'memory';
            else { const m = []; if (opt['phishing']) m.push('phishing'); if (opt['memory-realloc']) m.push('memory'); if (opt['stock-promotion']) m.push('stock'); mode = m.join(',') || 'all'; }
            const pid = ns.exec(WORKER, host, { threads: opt['worker-threads'] },
                '--parent-pid', ns.pid, '--mode', mode, '--loop-delay', Math.max(2000, opt['loop-delay'] - 1000), '--verbose', opt['verbose']);
            if (pid > 0) { st.workerPids.set(host, pid); stats.explored++; ns.print(`SUCCESS: Worker 已部署到 ${host} (PID: ${pid})`); }
        } catch (e) { ns.print(`WARN: 部署到 ${host} 失败: ${e}`); }
    }
}

// 阶段4: 收集报告
async function collect(ns, st, knownCaches, stats, opt) {
    for (const [host, pid] of st.workerPids) {
        const f = `${REPORT_PREFIX}${host.replace(/[^a-zA-Z0-9]/g, '_')}.txt`;
        if (!ns.fileExists(f)) continue;
        try {
            const d = JSON.parse(ns.read(f));
            stats.money += d.money || 0; stats.phish += d.phishing || 0; stats.memory += d.memory || 0; stats.stock += d.stock || 0;
            if (d.newCaches?.length) for (const c of d.newCaches) { if (!knownCaches.has(c)) { knownCaches.add(c); ns.write(CACHE_LOG, JSON.stringify({ fileName: c, source: host, time: Date.now() }) + '\n', 'a'); } }
            ns.rm(f);
        } catch (e) { if (opt['verbose']) ns.print(`WARN: 读取 ${host} 报告失败`); }
    }
}

// 阶段5: 健康检查
async function healthCheck(ns, st) {
    for (const [host, pid] of st.workerPids) { if (!ns.isRunning(pid)) { ns.print(`WARN: ${host} worker 重启`); st.workerPids.delete(host); } }
}

// 阶段6: 打开缓存
async function openCaches(ns, knownCaches, stats, opt) {
    const list = [...knownCaches]; let opened = 0;
    for (const name of list) {
        try {
            const r = await probe(ns, "cache", name);
            if (r.ok) { opened++; knownCaches.delete(name); ns.write(CACHE_LOG, JSON.stringify({ fileName: name, opened: true, time: Date.now() }) + '\n', 'a'); if (r.msg) ns.print(`🎁 ${r.msg}`); }
            else { knownCaches.delete(name); if (opt['verbose']) ns.print(`WARN: 缓存 ${name} 失败`); }
        } catch (e) { if (opt['verbose']) ns.print(`WARN: 缓存 ${name} 异常: ${e}`); }
        stats.caches = opened;
        await ns.sleep(200);
    }
}

// 阶段7: 迷宫
async function labyrinth(ns, opt) {
    try {
        const p = JSON.parse(await getNsDataThroughFile(ns, 'JSON.stringify((()=>{const p=ns.getPlayer();return {cha:p.skills.charisma,city:p.city};})())', '/Temp/dnet-pchar.txt'));
        if (!p || p.cha < 300) return;
    } catch (e) { return; }
    try { const r = await probe(ns, "lab"); if (r.ok && r.msg) ns.print(`🧪 ${r.msg}`); } catch (e) {}
}

// 密码生成
function genPasswords(hint, len) {
    const s = new Set();
    if (!hint) return ['admin','root','password','123456','bitburner','darknet','guest','letmein','welcome','qwerty','passw0rd','p@ssword','admin123','toor','secret'];
    const words = hint.replace(/[.,!?;:"]/g,'').split(/\s+/).filter(w=>w.length>0);
    for (const w of words) {
        if (w.length<=len) { s.add(w.toLowerCase()); s.add(w.toUpperCase()); s.add(w[0].toUpperCase()+w.slice(1).toLowerCase()); }
        const rev = w.split('').reverse().join(''); if (rev.length<=len) s.add(rev.toLowerCase());
        for (let i=0;i<=9;i++) { const n=w.toLowerCase()+i; if(n.length<=len) s.add(n); }
        for (let i=10;i<=99;i++) { const n=w.toLowerCase()+i; if(n.length<=len) s.add(n); }
        s.add(w.toLowerCase().replace(/a/g,'@').replace(/s/g,'$').replace(/o/g,'0').replace(/e/g,'3'));
    }
    if (words.length>=2) { const c=words.join('').toLowerCase(); if(c.length<=len) s.add(c); const u=words.join('_').toLowerCase(); if(u.length<=len) s.add(u); }
    return [...s].slice(0,30);
}

function report(ns, st, stats, cycle) {
    ns.tprint("-".repeat(60));
    ns.tprint(`  📊 暗网收益报告 [#${cycle}]`);
    ns.tprint(`  🌐 ${st.all.size}已知 ${st.authed.size}已认证 ${st.workerPids.size}活跃Worker`);
    ns.tprint(`  🎣 钓鱼:${stats.phish}  🧠 内存:${stats.memory}  📦 缓存:${stats.caches}  📈 股票:${stats.stock}`);
    ns.tprint("-".repeat(60));
}
