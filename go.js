/** go.js v4 — 精确复制 Illuminati AI 并去掉随机性 */

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
    const opponent = ["Netburners","Slum Snakes","The Black Hand","Tetrads","Daedalus","Illuminati"];
    const opponent2 = [...opponent, "????????????"];

    function getValidMoves(ns) {
        const g = ns.go.analysis.getValidMoves();
        const r = [];
        for (let x = 0; x < g.length; x++) for (let y = 0; y < g[x].length; y++) if (g[x][y]) r.push([x, y]);
        return r;
    }

    function getKomi(o) {
        return o === 'Illuminati' ? 7.5 : o === 'Daedalus' || o === 'Tetrads' ? 5.5 :
               o === 'Slum Snakes' || o === 'The Black Hand' ? 3.5 : o === 'Netburners' ? 1.5 : 5.5;
    }

    function score(b) { let s = 0; for (const r of b) for (const c of r) { if (c==='X') s++; else if (c==='O') s--; } return s; }

    /**
     * Illuminati AI 决策链 (去随机):
     * 1.capture 2.defendCapture 3.eyeMove 4.surround(1气)
     * 5.eyeBlock 6.corner 7.jump 8.growth 9.expansion
     */
    function getBestMove(board, vm) {
        const S = board.length, me = 'X', opp = 'O';
        const isIn = (x,y) => x>=0 && x<S && y>=0 && y<S;
        const dir4 = [[-1,0],[1,0],[0,-1],[0,1]];

        // 1. capture 提子
        for (const [x, y] of vm) {
            for (const [dx, dy] of dir4) {
                const nx = x+dx, ny = y+dy;
                if (!isIn(nx,ny) || board[nx][ny] !== opp) continue;
                let libs = 0;
                for (const [dx2, dy2] of dir4) {
                    const nn = nx+dx2, ny2 = ny+dy2;
                    if (isIn(nn,ny2) && board[nn][ny2] === '.') libs++;
                }
                if (libs === 0) return {x, y, src:'c'};
            }
        }

        // 2. defendCapture 救子 (1气→>1气)
        for (const [x, y] of vm) {
            let myLibs = 0;
            for (const [dx, dy] of dir4) {
                const nx = x+dx, ny = y+dy;
                if (isIn(nx,ny) && board[nx][ny] === '.') myLibs++;
            }
            if (myLibs < 2) continue;
            for (const [dx, dy] of dir4) {
                const nx = x+dx, ny = y+dy;
                if (!isIn(nx,ny) || board[nx][ny] !== me) continue;
                let own = 0;
                for (const [dx2, dy2] of dir4) {
                    const nn = nx+dx2, ny2 = ny+dy2;
                    if (isIn(nn,ny2) && board[nn][ny2] === '.') own++;
                }
                if (own === 1) return {x, y, src:'d'};
            }
        }

        // 3. eyeMove 做眼
        for (const [x, y] of vm) {
            let ok = true;
            for (const [dx, dy] of dir4) {
                const nx = x+dx, ny = y+dy;
                if (!isIn(nx,ny) || board[nx][ny]==='#') continue;
                if (board[nx][ny] !== me) { ok = false; break; }
            }
            if (ok) return {x, y, src:'e'};
        }

        // 4. surround 打吃 (紧到1气)
        for (const [x, y] of vm) {
            let safe = false, atari = 0;
            for (const [dx, dy] of dir4) {
                const nx = x+dx, ny = y+dy;
                if (!isIn(nx,ny)) continue;
                if (board[nx][ny] === '.') safe = true;
                if (board[nx][ny] === opp) {
                    let libs = 0;
                    for (const [dx2, dy2] of dir4) {
                        const nn = nx+dx2, ny2 = ny+dy2;
                        if (isIn(nn,ny2) && board[nn][ny2] === '.') libs++;
                    }
                    if (libs === 1) atari++;
                }
            }
            if (safe && atari > 0) return {x, y, src:'a'};
        }

        // 5. eyeBlock 破眼
        for (const [x, y] of vm) {
            let ok = true;
            for (const [dx, dy] of dir4) {
                const nx = x+dx, ny = y+dy;
                if (!isIn(nx,ny) || board[nx][ny]==='#') continue;
                if (board[nx][ny] !== opp) { ok = false; break; }
            }
            if (ok) return {x, y, src:'b'};
        }

        // 6. corner 占角
        const corners = [[2,2],[2,S-3],[S-3,2],[S-3,S-3]];
        for (const [cx, cy] of corners) {
            if (!vm.some(([x,y]) => x===cx && y===cy)) continue;
            let open = true;
            for (let dx=-2; dx<=2 && open; dx++)
                for (let dy=-2; dy<=2 && open; dy++) {
                    const nx=cx+dx, ny=cy+dy;
                    if (isIn(nx,ny) && board[nx][ny]!=='.') open=false;
                }
            if (open) return {x: cx, y: cy, src:'r'};
        }

        // 7. jump 跳/桂马
        let bestJ = null, bestJS = 0;
        for (const [x, y] of vm) {
            let s = 0;
            for (const [dx, dy] of [[2,0],[-2,0],[0,2],[0,-2],[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]]) {
                const nx = x+dx, ny = y+dy;
                if (isIn(nx,ny) && board[nx][ny] === me) s += (dx*dy !== 0 && Math.abs(dx)===Math.abs(dy)) ? 7 : 5;
            }
            if (s > bestJS) { bestJS = s; bestJ = {x, y, src:'j'}; }
        }
        if (bestJS >= 6) return bestJ;

        // 8. growth 扩张(安全+连接)
        let bestG = null, bestGS = -1;
        for (const [x, y] of vm) {
            let libs = 0, conn = 0;
            for (const [dx, dy] of dir4) {
                const nx = x+dx, ny = y+dy;
                if (!isIn(nx,ny)) continue;
                if (board[nx][ny] === '.') libs++;
                if (board[nx][ny] === me) conn++;
            }
            if (libs < 2) continue;
            const s = libs + conn * 3;
            if (s > bestGS) { bestGS = s; bestG = {x, y, src:'g'}; }
        }
        if (bestG) return bestG;

        // 9. expansion 拆边
        let bestE = null, bestES = -1;
        for (const [x, y] of vm) {
            let dw = Math.min(x, y, S-1-x, S-1-y);
            for (let dx=-2; dx<=2; dx++) for (let dy=-2; dy<=2; dy++) {
                const nx=x+dx, ny=y+dy;
                if (isIn(nx,ny) && board[nx][ny]==='#') dw = Math.min(dw, Math.abs(dx)+Math.abs(dy));
            }
            if (dw < 2) continue;
            let open = 0;
            for (let dx=-2; dx<=2; dx++) for (let dy=-2; dy<=2; dy++) {
                if (dx===0&&dy===0) continue;
                const nx=x+dx, ny=y+dy;
                if (isIn(nx,ny) && board[nx][ny]==='.') open++;
            }
            const s = open + (dw===2 ? 8 : dw===3 ? 5 : 1);
            if (s > bestES) { bestES = s; bestE = {x, y, src:'x'}; }
        }
        if (bestE) return bestE;

        // 10. fallback: 随便走个安全位置
        for (const [x, y] of vm) {
            for (const [dx, dy] of dir4) {
                if (isIn(x+dx,y+dy) && board[x+dx][y+dy] === '.') return {x, y, src:'f'};
            }
        }
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
                turn++;
                const board = ns.go.getBoardState();
                const vm = getValidMoves(ns);
                if (cheats && turn % 5 === 0) {
                    try { const cc = ns.go.cheat.getCheatSuccessChance();
                        if (cc > cheatChanceThreshold) {
                            if (ns.go.cheat.getCheatCount() > 0 && score(board)-getKomi(opp) < -5) { ns.go.cheat.removeRouter(); continue; }
                            if (cc > 0.95) { ns.go.cheat.playTwoMoves(); continue; }
                        }
                    } catch(e) {}
                }
                const move = getBestMove(board, vm);
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
        totalGames++;
        const s = score(ns.go.getBoardState()) - getKomi(opp);
        const w = s > 0; if (w) totalWins++;
        const t = ((performance.now()-st)/1000).toFixed(1);
        ns.tprint(`[${totalGames}] ${opp} ${w?'✅':'❌'} ${s.toFixed(1)}目 ${t}s 胜率:${(totalWins/totalGames*100).toFixed(0)}%`);
        if (runOnce) ns.exit();
        try { ns.go.resetBoardState(opponent2[Math.floor(Math.random()*opponent2.length)], 13); }
        catch { ns.go.resetBoardState(opponent[Math.floor(Math.random()*opponent.length)], 13); }
    }
}
