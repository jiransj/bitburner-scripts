/**
 * darknet-proxy.js — 暗网探测代理（运行在 darkweb 上）
 *
 * 由于 darkweb 只有 16GB RAM，主脚本 darknet-farmer.js 无法在上面运行。
 * 此代理脚本极小（~1.6GB RAM），负责在 darkweb 上执行 dnet API 调用，
 * 将结果写入临时文件供主脚本读取。
 *
 * 用法（由 darknet-farmer.js 自动部署）:
 *   darknet-farmer.js → scp 到 darkweb → exec → 读取 /Temp/darknet-proxy-result.txt
 *
 * @param {NS} ns
 * @param {string} args[0] — 操作类型: probe | auth | lab
 * @param {string} args[1] — 操作参数(JSON)
 */
export async function main(ns) {
    const operation = ns.args[0] || 'probe';
    const params = JSON.parse(ns.args[1] || '{}');
    const result = { ok: false, data: null, error: null };

    try {
        switch (operation) {
            case 'probe': {
                // 探测相邻暗网服务器
                const hosts = ns.dnet.probe();
                const servers = [];
                for (const host of hosts) {
                    try {
                        const d = ns.dnet.getServerDetails(host);
                        servers.push({
                            host,
                            isOnline: d.isOnline,
                            depth: d.depth,
                            difficulty: d.difficulty,
                            requiredCharisma: d.requiredCharismaSkill,
                            passwordHint: d.passwordHint,
                            passwordLength: d.passwordLength,
                            hasSession: d.hasSession,
                            blockedRam: d.blockedRam,
                        });
                    } catch (e) {
                        servers.push({ host, error: String(e) });
                    }
                }
                result.ok = true;
                result.data = servers;
                break;
            }
            case 'auth': {
                // 认证到指定服务器（支持单个密码或密码列表）
                const passwords = Array.isArray(params.password) ? params.password : [params.password];
                let lastResult = null;
                for (const pwd of passwords) {
                    try {
                        lastResult = ns.dnet.authenticate(params.host, pwd);
                        if (lastResult.success) {
                            result.ok = true;
                            result.data = { host: params.host, password: pwd, success: true, message: lastResult.message };
                            break;
                        }
                    } catch (e) { /* 继续尝试下一个 */ }
                }
                if (!result.ok) {
                    result.data = { host: params.host, success: false, message: lastResult?.message || '所有密码均失败' };
                }
                break;
            }
            case 'labreport': {
                // 获取实验室位置报告
                const r = ns.dnet.labreport();
                result.ok = r.success;
                result.data = { success: r.success, message: r.message };
                break;
            }
            case 'labradar': {
                // 获取实验室雷达
                const r = ns.dnet.labradar();
                result.ok = r.success;
                result.data = { success: r.success, message: r.message };
                break;
            }
            case 'openCache': {
                // 打开缓存文件
                const r2 = ns.dnet.openCache(params.fileName, true);
                result.ok = r2.success;
                result.data = { success: r2.success, message: r2.message };
                break;
            }
            default:
                result.error = `未知操作: ${operation}`;
        }
    } catch (e) {
        result.error = String(e);
    }

    // 写入结果文件
    const outFile = `/Temp/dnet-proxy-${operation}.txt`;
    ns.write(outFile, JSON.stringify(result), 'w');
}
