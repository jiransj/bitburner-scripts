/**
 * force-pull.js — 全量强制更新（不信任任何缓存）
 *
 * 流程：1) killall 所有服务器（含 darkweb 上的残留旧脚本）
 *       2) 删除所有服务器上的 .js/.txt/.script/.lit/.ns 文件（含 /Temp 缓存、darkweb 上的旧版 dnet-watch/dnet-worm）
 *       3) 递归遍历 GitHub 仓库，逐一 ns.wget 最新版本（多层 cache-busting，失败自动重试一次）
 *       4) 完成后提示重启 autopilot / daemon
 *
 * 用法（从旧版本升级时，先在游戏终端执行）:
 *   wget https://raw.githubusercontent.com/jiransj/bitburner-scripts/main/force-pull.js force-pull.js
 *   run force-pull.js
 *
 * 注意：运行中的脚本无法被覆盖，所以 force-pull.js 自身第一次不会更新；
 *       拉取完成后请再 run force-pull.js 一次以更新它自己。
 */
const GITHUB_USER = "jiransj";
const GITHUB_REPO = "bitburner-scripts";
const BRANCH = "main";
const API = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents`;
const RAW = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${BRANCH}`;
const EXTENSIONS = [".js", ".txt", ".script", ".lit", ".ns"];

function isTargetFile(name) {
  return EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** 深度优先收集普通服务器列表（ns.scan 不返回 darkweb，需单独处理） */
function collectHosts(ns) {
  const hosts = [];
  const walk = (server, parent) => {
    for (const s of ns.scan(server)) {
      if (s !== parent) {
        hosts.push(s);
        walk(s, server);
      }
    }
  };
  walk("home", "");
  return [...new Set(["home", ...hosts])];
}

/** GitHub 仓库递归文件列表（API 限流 60 次/小时，失败时用本地 ls 兜底） */
async function repositoryListing(ns, folder = "") {
  const listUrl = `${API}/${folder}?ref=${BRANCH}`;
  try {
    const resp = await fetch(listUrl);
    const data = await resp.json();
    if (!Array.isArray(data)) throw new Error(`非预期响应: ${JSON.stringify(data).slice(0, 200)}`);
    let files = [];
    for (const item of data) {
      if (item.type === "dir") {
        files = files.concat(await repositoryListing(ns, item.path));
      } else if (item.type === "file" && isTargetFile(item.name)) {
        files.push(item.path);
      }
    }
    ns.print(`GitHub 目录 ${folder || "/"} 列出 ${files.length} 个文件`);
    return files;
  } catch (e) {
    if (folder !== "") throw e;
    ns.tprint(`WARN: GitHub API 列出失败（可能触发 60 次/小时限流），改用本地文件列表兜底: ${e}`);
    return ns.ls("home").filter((f) => isTargetFile(f) && !f.includes("/Remote/") && !f.includes("/Tasks/"));
  }
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const SELF = ns.getScriptName();
  ns.tprint("=".repeat(64));
  ns.tprint("  force-pull 全量强制更新：杀脚本 → 删文件 → 拉取最新");
  ns.tprint("=".repeat(64));

  // ---- 1. 杀光所有服务器上的脚本（含 darkweb 残留） ----
  const hosts = collectHosts(ns);
  try { if (!hosts.includes("darkweb")) hosts.push("darkweb"); } catch {}
  let killed = 0, killedHosts = 0;
  for (const host of hosts) {
    try {
      const n = ns.killall(host);
      if (n > 0) { killed += n; killedHosts++; }
    } catch { /* 无权限/离线等，跳过 */ }
  }
  ns.tprint(`[1/4] 已终止 ${killed} 个脚本（${killedHosts} 台服务器）`);

  // ---- 2. 删光所有服务器上的脚本/文本文件（含 /Temp 缓存、darkweb 上的旧版 dnet 脚本） ----
  let deleted = 0;
  for (const host of hosts) {
    let files = [];
    try { files = ns.ls(host); } catch { continue; }
    for (const f of files) {
      if (!isTargetFile(f)) continue;
      if (host === "home" && f === SELF) continue; // 运行中的自己不能删
      try { if (ns.rm(f, host)) deleted++; } catch {}
    }
  }
  try {
    for (const f of ns.ls("home", "/Temp/")) { try { if (ns.rm(f, "home")) deleted++; } catch {} }
  } catch {}
  ns.tprint(`[2/4] 已删除 ${deleted} 个文件（含 darkweb 缓存）`);

  // ---- 3. 从 GitHub 拉取全部文件（cache-busting + 失败重试） ----
  let ok = 0, fail = 0, skipped = 0;
  let filesToDownload = [];
  try {
    filesToDownload = await repositoryListing(ns);
  } catch (e) {
    ns.tprint(`WARN: 递归列出失败: ${e}`);
  }
  ns.tprint(`[3/4] 待拉取 ${filesToDownload.length} 个文件...`);
  for (const f of filesToDownload) {
    if (f === SELF || f.endsWith("/" + SELF)) { skipped++; continue; } // 运行中的自身跳过，下次更新
    const url = `${RAW}/${f}?ts=${Date.now()}&rnd=${Math.random()}`;
    let saved = false;
    try { saved = await ns.wget(url, f); } catch {}
    if (!saved) {
      await ns.sleep(150);
      try { saved = await ns.wget(url, f); } catch {}
    }
    if (saved) { ok++; ns.print(`✅ ${f}`); }
    else { fail++; ns.tprint(`❌ ${f} 下载失败`); }
  }

  ns.tprint("-".repeat(64));
  ns.tprint(`[4/4] 完成: 成功 ${ok} / 失败 ${fail} / 跳过(自身) ${skipped}`);
  if (fail > 0) ns.tprint("WARN: 存在失败项，请检查网络或稍后重跑。");
  ns.tprint("提示: 请再执行一次 run force-pull.js（更新本文件自身），然后 run autopilot.js --tail 重启整套脚本。");
  ns.tprint("      （daemon.js 已变更：需要重启 autopilot 使其以新代码重新拉起 daemon）");
  ns.tprint("=".repeat(64));
}
