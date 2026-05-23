/** dnet-probe.js — 暗网探针 v2（~3GB，可在 darkweb 16GB 上运行）*/
export async function main(ns) {
    const op = ns.args[0] || "probe";
    const out = "/Temp/dnetp.txt";
    try {
        if (op === "probe") {
            const hosts = ns.dnet.probe();
            const list = [];
            for (const h of hosts) {
                try {
                    const d = ns.dnet.getServerDetails(h);
                    list.push({ host: h, online: d.isOnline, depth: d.depth, diff: d.difficulty, cha: d.requiredCharismaSkill, hint: d.staticPasswordHint || d.passwordHint || '', len: d.passwordLength || 0, authed: d.hasSession });
                } catch (e) { list.push({ host: h, online: false }); }
            }
            ns.write(out, JSON.stringify({ ok: true, data: list }), "w");
        } else if (op === "auth") {
            const r = ns.dnet.authenticate(ns.args[1], ns.args.slice(2).join(" "));
            ns.write(out, JSON.stringify({ ok: r.success, host: ns.args[1], pwd: ns.args.slice(2).join(" ") }), "w");
        } else if (op === "unlock") {
            // 自动解锁模式: 探测所有服务器并用字典尝试认证
            const commonPwd = ["123456","password","12345678","qwerty","123456789","12345","1234","111111",
                "1234567","dragon","123123","baseball","abc123","football","monkey","letmein","696969",
                "shadow","master","666666","qwertyuiop","123321","mustang","1234567890","michael","654321",
                "superman","1qaz2wsx","7777777","121212","0","qazwsx","123qwe","trustno1","jordan",
                "jennifer","zxcvbnm","asdfgh","hunter","buster","soccer","harley","batman","andrew",
                "tigger","sunshine","iloveyou","2000","charlie","robert","thomas","hockey","ranger",
                "daniel","starwars","112233","george","computer","michelle","jessica","pepper","1111",
                "zxcvbn","555555","11111111","131313","freedom","777777","pass","maggie","159753",
                "aaaaaa","ginger","princess","joshua","cheese","amanda","summer","love","ashley","6969",
                "nicole","chelsea","biteme","matthew","access","yankees","987654321","dallas","austin",
                "thunder","taylor","matrix","admin","0000","fido","spot","rover","max",""];
            const hosts = ns.dnet.probe();
            const results = [];
            for (const h of hosts) {
                try {
                    const d = ns.dnet.getServerDetails(h);
                    if (!d || !d.isOnline || d.hasSession) { results.push({ host: h, ok: d?.hasSession, msg: d?.hasSession ? "已认证" : "离线" }); continue; }
                    const hint = (d.staticPasswordHint || d.passwordHint || "").toLowerCase();
                    let found = false;
                    // EchoVuln: 提示直接包含密码
                    if (hint.includes("the password is") || hint.includes("the pin is") || hint.includes("the key is") || hint.includes("it's set to") || hint.includes("remember to use")) {
                        const w = (d.staticPasswordHint || d.passwordHint || "").split(" ");
                        const last = w[w.length-1].replace(/[^a-zA-Z0-9]/g,"");
                        if (last) { const r2 = ns.dnet.authenticate(h, last); if (r2.success) { found = true; results.push({ host: h, ok: true, msg: `EchoVuln:${last}` }); } }
                    }
                    if (!found && (hint.includes("default") || hint.includes("factory") || hint.includes("never changed"))) {
                        for (const p of ["admin","password","0000","12345"]) { const r2 = ns.dnet.authenticate(h, p); if (r2.success) { found = true; results.push({ host: h, ok: true, msg: `Default:${p}` }); break; } }
                    }
                    if (!found && (hint.includes("dog") || hint.includes("fido") || hint.includes("spot") || hint.includes("rover"))) {
                        for (const p of ["fido","spot","rover","max"]) { const r2 = ns.dnet.authenticate(h, p); if (r2.success) { found = true; results.push({ host: h, ok: true, msg: `DogName:${p}` }); break; } }
                    }
                    if (!found && (hint.includes("no password") || hint.includes("not set") || hint.includes("empty") || hint.includes("did i set"))) {
                        const r2 = ns.dnet.authenticate(h, ""); if (r2.success) { found = true; results.push({ host: h, ok: true, msg: "NoPwd" }); }
                    }
                    if (!found) {
                        for (const p of commonPwd) { try { const r2 = ns.dnet.authenticate(h, p); if (r2.success) { found = true; results.push({ host: h, ok: true, msg: `Dict:${p}` }); break; } } catch(e){} }
                    }
                    if (!found) results.push({ host: h, ok: false, msg: "未破解" });
                } catch (e) { results.push({ host: h, ok: false, msg: String(e) }); }
            }
            ns.write(out, JSON.stringify({ ok: true, data: results }), "w");
        } else if (op === "lab") {
            const r = ns.dnet.labreport();
            ns.write(out, JSON.stringify({ ok: r.success, msg: r.message }), "w");
        } else if (op === "cache") {
            const r = ns.dnet.openCache(ns.args[1]);
            ns.write(out, JSON.stringify({ ok: r.success, msg: r.message }), "w");
        }
    } catch (e) { ns.write(out, JSON.stringify({ ok: false, err: String(e) }), "w"); }
}
