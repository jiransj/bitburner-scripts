/** go.js v5 — 精确复制 Illuminati AI (含全部安全检查) */

import { getConfiguration, instanceCount } from './helpers.js'

const argsSchema = [
    ['cheats', true], ['disable-cheats', false], ['cheat-chance-threshold', 0.9],
    ['logtime', false], ['runOnce', false],
];

export function autocomplete(data, args) { data.flags(argsSchema); return []; }

/** @param {NS} ns */
export async function main(ns) {
    let cheats = false, cheatChanceThreshold = 1.0, logtime = false, runOnce = true;
    let turn = 0, totalGames = 0, totalWins = 0;
    const OPP = ["Netburners","Slum Snakes","The Black Hand","Tetrads","Daedalus","Illuminati"];
    const OPP2 = [...OPP, "????????????"];

    function vm(ns) { // getValidMoves
        const g = ns.go.analysis.getValidMoves(), r = [];
        for (let x = 0; x < g.length; x++) for (let y = 0; y < g[x].length; y++) if (g[x][y]) r.push([x, y]);
        return r;
    }
    function komi(o) { return {Illuminati:7.5,Daedalus:5.5,Tetrads:5.5,'The Black Hand':3.5,'Slum Snakes':3.5,Netburners:1.5}[o]||5.5; }
    function score(b) { let s=0; for(const r of b) for(const c of r) {if(c==='X')s++;else if(c==='O')s--;} return s; }

    /**
     * Illuminati 完整决策链 (去随机, 加安全检查):
     *
     * 每个候选位置的评估:
     *   newLibs = 落子后自己的气数
     *   oldLibs = 相邻对手链中最少的气数
     *   ⚠️ 安全规则: newLibs <= 2 && oldLibs > 2 → 跳过 (会被反提)
     */
    function getBestMove(board, vm) {
        const S = board.length, me = 'X', opp = 'O';
        const inB = (x,y) => x>=0 && x<S && y>=0 && y<S;
        const d4 = [[-1,0],[1,0],[0,-1],[0,1]];
        const neighbLibs = (x,y,c) => { let n=0; for(const [dx,dy] of d4) {const nx=x+dx,ny=y+dy; if(inB(nx,ny)&&board[nx][ny]===c) n++;} return n; };

        // --- 工具: 计算在(x,y)落子后自己的气数 ---
        const afterLibs = (x,y) => {
            let n = 0;
            for (const [dx, dy] of d4) { const nx=x+dx, ny=y+dy; if (inB(nx,ny) && board[nx][ny] === '.') n++; }
            return n;
        };
        // 找相邻对手链中最少的气
        const minOppChainLibs = (x,y) => {
            let min = 99;
            for (const [dx, dy] of d4) {
                const nx=x+dx, ny=y+dy;
                if (!inB(nx,ny) || board[nx][ny] !== opp) continue;
                let libs = 0;
                for (const [dx2, dy2] of d4) { const nn=nx+dx2, ny2=ny+dy2; if (inB(nn,ny2) && board[nn][ny2] === '.') libs++; }
                if (libs < min) min = libs;
            }
            return min;
        };

        // 为每个合法位置计算评估数据
        const evals = [];
        for (const [x, y] of vm) {
            const nl = afterLibs(x, y);
            const ol = minOppChainLibs(x, y);
            const capturable = ol <= 0;   // 能提子
            const safe = nl >= 3 || capturable; // 安全: 3气以上或能提
            const atari = ol === 1;       // 打吃
            const canSave = neighbLibs(x,y,me) > 0; // 有自己子相邻
            evals.push({x, y, nl, ol, capturable, safe, atari, canSave});
        }

        // 1. capture 提子
        for (const e of evals) if (e.capturable) return {x:e.x, y:e.y, src:'c'};

        // 2. defendCapture 救子 (1气→>1气)
        for (const e of evals) {
            if (!e.safe || e.nl < 2) continue;
            // 检查周围有没有自己1气的子
            for (const [dx, dy] of d4) {
                const nx = e.x+dx, ny = e.y+dy;
                if (!inB(nx,ny) || board[nx][ny] !== me) continue;
                let own = 0;
                for (const [dx2, dy2] of d4) { const nn=nx+dx2, ny2=ny+dy2; if (inB(nn,ny2) && board[nn][ny2] === '.') own++; }
                if (own === 1) return {x:e.x, y:e.y, src:'d'};
            }
        }

        // 3. eyeMove 做眼
        for (const e of evals) {
            if (!e.safe) continue;
            let ok = true;
            for (const [dx, dy] of d4) {
                const nx = e.x+dx, ny = e.y+dy;
                if (!inB(nx,ny) || board[nx][ny]==='#') continue;
                if (board[nx][ny] !== me) { ok = false; break; }
            }
            if (ok) return {x:e.x, y:e.y, src:'e'};
        }

        // 4. surround 打吃 — 使用游戏AI的安全规则:
        //    newLibs <= 2 && oldLibs > 2 → 跳过 (会被反提)
        //    newLibs >= 2 → 安全可下
        //    oldLibs = 1 → capture (已在步骤1处理)
        //    oldLibs = 2 && (newLibs >= 2 || 对手只有1个气群) → atari
        for (const e of evals) {
            if (e.nl <= 2 && e.ol > 2) continue; // ⚠️ 核心安全规则: 会被反提!
            if (e.ol === 2 && e.nl >= 2) return {x:e.x, y:e.y, src:'a'};
        }
        // 还能紧2气的(不违反安全规则)
        for (const e of evals) {
            if (e.nl <= 2 && e.ol > 2) continue;
            if (e.ol <= 3 && e.nl >= 2) return {x:e.x, y:e.y, src:'s'};
        }

        // 5. eyeBlock 破眼
        for (const e of evals) {
            if (!e.safe) continue;
            let ok = true;
            for (const [dx, dy] of d4) {
                const nx = e.x+dx, ny = e.y+dy;
                if (!inB(nx,ny) || board[nx][ny]==='#') continue;
                if (board[nx][ny] !== opp) { ok = false; break; }
            }
            if (ok) return {x:e.x, y:e.y, src:'b'};
        }

        // 6. corner 占角
        const cp = [[2,2],[2,S-3],[S-3,2],[S-3,S-3]];
        for (const [cx, cy] of cp) {
            if (!vm.some(([x,y]) => x===cx && y===cy)) continue;
            let open = true;
            for (let dx=-2; dx<=2 && open; dx++) for (let dy=-2; dy<=2 && open; dy++) {
                if (dx===0&&dy===0) continue;
                const nx=cx+dx, ny=cy+dy;
                if (inB(nx,ny) && board[nx][ny]!=='.') open=false;
            }
            if (open) return {x:cx, y:cy, src:'r'};
        }

        // 7. jump 跳/桂马
        let bj=null, bjS=0;
        for (const e of evals) {
            if (!e.safe) continue;
            let s=0;
            for (const [dx,dy] of [[2,0],[-2,0],[0,2],[0,-2],[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]]) {
                const nx=e.x+dx, ny=e.y+dy;
                if (inB(nx,ny) && board[nx][ny]===me) s += (Math.abs(dx)===2&&Math.abs(dy)===2)?7:5;
            }
            if (s>bjS) { bjS=s; bj={x:e.x,y:e.y,src:'j'}; }
        }
        if (bjS>=6) return bj;

        // 8. growth 安全扩张 (至少3气+连接数)
        let bg=null, bgS=-1;
        for (const e of evals) {
            if (e.nl < 3) continue;
            const conn = neighbLibs(e.x,e.y,me);
            const s = e.nl + conn*3;
            if (s>bgS) { bgS=s; bg={x:e.x,y:e.y,src:'g'}; }
        }
        if (bg) return bg;

        // 9. expansion 拆边
        let be=null, beS=-1;
        for (const e of evals) {
            if (e.nl < 2) continue;
            let dw = Math.min(e.x, e.y, S-1-e.x, S-1-e.y);
            for (let dx=-2; dx<=2; dx++) for (let dy=-2; dy<=2; dy++) {
                const nx=e.x+dx, ny=e.y+dy;
                if (inB(nx,ny) && board[nx][ny]==='#') dw = Math.min(dw, Math.abs(dx)+Math.abs(dy));
            }
            if (dw < 2) continue;
            let open = 0;
            for (let dx=-2; dx<=2; dx++) for (let dy=-2; dy<=2; dy++) {
                if (dx===0&&dy===0) continue;
                const nx=e.x+dx, ny=e.y+dy;
                if (inB(nx,ny) && board[nx][ny]==='.') open++;
            }
            const s = open + (dw===2?10:dw===3?6:1);
            if (s>beS) { beS=s; be={x:e.x,y:e.y,src:'x'}; }
        }
        if (be) return be;

        // 10. fallback 安全位置
        for (const e of evals) if (e.nl >= 1) return {x:e.x, y:e.y, src:'f'};
        return null;
    }

    await start();
    async function start() {
        const ro = getConfiguration(ns, argsSchema);
        if (!ro || (await instanceCount(ns)) > 1) return;
        logtime = ro.logtime; runOnce = ro.runOnce;
        cheats = ro.cheats && !ro['disable-cheats']; cheatChanceThreshold = ro['cheat-chance-threshold'];
        ns.disableLog("go.makeMove"); ns.disableLog("go.passTurn"); ns.disableLog("sleep");
        while (true) {
            turn = 0; const opp = ns.go.getOpponent(); ns.print(`INFO: vs ${opp}`);
            const st = performance.now();
            while (true) {
                if (ns.go.getGameState().currentPlayer === 'None') { await end(ns, opp, st); break; }
                turn++; const board = ns.go.getBoardState(); const moves = vm(ns);
                if (cheats && turn%5===0) {
                    try { const cc = ns.go.cheat.getCheatSuccessChance();
                        if (cc>cheatChanceThreshold) {
                            if (ns.go.cheat.getCheatCount()>0 && score(board)-komi(opp)<-5) { ns.go.cheat.removeRouter(); continue; }
                            if (cc>0.95) { ns.go.cheat.playTwoMoves(); continue; }
                        }
                    } catch(e) {}
                }
                const move = getBestMove(board, moves);
                let r;
                if (move) {
                    if (logtime) ns.print(`[${turn}] (${move.x},${move.y}) ${move.src}`);
                    r = await ns.go.makeMove(move.x, move.y);
                } else {
                    if (logtime) ns.print(`[${turn}] pass`);
                    try { r = await ns.go.passTurn(); } catch { await end(ns, opp, st); break; }
                }
                if (r && r.type === "gameOver") { await end(ns, opp, st); break; }
            }
        }
    }
    async function end(ns, opp, st) {
        totalGames++; const s = score(ns.go.getBoardState())-komi(opp); const w=s>0; if(w) totalWins++;
        ns.tprint(`[${totalGames}] ${opp} ${w?'✅':'❌'} ${s.toFixed(1)}目 ${((performance.now()-st)/1000).toFixed(1)}s 胜率:${(totalWins/totalGames*100).toFixed(0)}%`);
        if (runOnce) ns.exit();
        try { ns.go.resetBoardState(OPP2[Math.floor(Math.random()*OPP2.length)],13); } catch { ns.go.resetBoardState(OPP[Math.floor(Math.random()*OPP.length)],13); }
    }
}
