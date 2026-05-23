/** darknet-unlock.js — 暗网全自动解锁脚本（运行在 darkweb 上，~3GB RAM）*/
export async function main(ns) {
    ns.tprint("=".repeat(60));
    ns.tprint("  暗网全自动解锁 v1.0");
    ns.tprint("=".repeat(60));

    // 尝试连接到 darkweb（首次运行时可能需要手动 connect darkweb）
    try { if (ns.singularity) ns.singularity.connect("darkweb"); } catch (e) {}

    // 通用密码字典（来自游戏源码 commonPasswordDictionary）
    const commonPasswords = ["123456","password","12345678","qwerty","123456789","12345","1234","111111",
        "1234567","dragon","123123","baseball","abc123","football","monkey","letmein","696969","shadow",
        "master","666666","qwertyuiop","123321","mustang","1234567890","michael","654321","superman",
        "1qaz2wsx","7777777","121212","0","qazwsx","123qwe","trustno1","jordan","jennifer","zxcvbnm",
        "asdfgh","hunter","buster","soccer","harley","batman","andrew","tigger","sunshine","iloveyou",
        "2000","charlie","robert","thomas","hockey","ranger","daniel","starwars","112233","george",
        "computer","michelle","jessica","pepper","1111","zxcvbn","555555","11111111","131313","freedom",
        "777777","pass","maggie","159753","aaaaaa","ginger","princess","joshua","cheese","amanda",
        "summer","love","ashley","6969","nicole","chelsea","biteme","matthew","access","yankees",
        "987654321","dallas","austin","thunder","taylor","matrix"];

    const defaultPasswords = ["admin", "password", "0000", "12345"];
    const dogNames = ["fido", "spot", "rover", "max"];

    let total = 0, authed = 0;

    // 持续探测并解锁
    while (true) {
        let hosts = [];
        try { hosts = ns.dnet.probe() || []; } catch (e) { await ns.sleep(3000); continue; }

        if (hosts.length === 0) {
            ns.print("未发现服务器，等待暗网生成...");
            await ns.sleep(5000);
            continue;
        }

        for (const host of hosts) {
            total++;
            try {
                const d = ns.dnet.getServerDetails(host);
                if (!d || !d.isOnline) continue;
                // 检查是否已认证
                if (d.hasSession) { authed++; continue; }

                const hint = (d.passwordHint || "").toLowerCase();
                const pwdLen = d.passwordLength || 0;
                ns.print(`🔓 ${host} (难度${d.difficulty}, 长度${pwdLen}, 提示:${d.passwordHint || "无"})`);

                let candidates = [];

                // 根据提示特征选择密码列表
                if (hint.includes("no password") || hint.includes("not set") || hint.includes("empty") || hint.includes("did i set")) {
                    candidates = [""]; // NoPassword 类型
                }
                else if (hint.includes("default") || hint.includes("factory") || hint.includes("never changed")) {
                    candidates = defaultPasswords; // DefaultPassword 类型
                }
                else if (hint.includes("dog") || hint.includes("fido") || hint.includes("spot") || hint.includes("rover")) {
                    candidates = dogNames; // DogNames 类型
                }
                else if (hint.includes("the password is") || hint.includes("the pin is") || hint.includes("the key is") || hint.includes("the secret is") || hint.includes("it's set to") || hint.includes("remember to use")) {
                    // EchoVuln: 提示直接包含密码！提取出来
                    const words = (d.passwordHint || "").split(" ");
                    const lastWord = words[words.length - 1].replace(/[^a-zA-Z0-9]/g, "");
                    if (lastWord) candidates = [lastWord];
                }
                else if (hint.includes("shuffled") || hint.includes("sorted") || hint.includes("accidentally sorted")) {
                    // SortedEchoVuln: 提示给出排序后的密码
                    // 需要尝试所有排列 - 对于短密码可行
                    candidates = commonPasswords;
                }
                else {
                    candidates = commonPasswords; // 通用字典
                }

                // 尝试每个密码
                for (const pwd of candidates) {
                    try {
                        const r = ns.dnet.authenticate(host, pwd);
                        if (r.success) {
                            authed++;
                            ns.tprint(`✅ ${host} 已解锁! 密码: "${pwd}"`);
                            break;
                        }
                    } catch (e) { /* 继续 */ }
                    await ns.sleep(100);
                }
            } catch (e) {
                ns.print(`WARN: ${host} 处理失败: ${e}`);
            }
        }
        ns.tprint(`📊 总计: ${total} 服务器, 已解锁: ${authed}`);
        await ns.sleep(10000);
    }
}
