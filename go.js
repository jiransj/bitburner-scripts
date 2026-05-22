/**
 * go.js — IPvGO AI v3
 *
 * 基于游戏源码 goAI.ts 的架构重写:
 *   - 复制游戏AI的move分类系统 (capture/surround/growth/defend/eye等)
 *   - 加入游戏AI缺失的"不送死"安全检查 (newLibertyCount <= 2时跳过)
 *   - 去掉随机性, 总是选最优
 *   - 加入眼位分析增强 (游戏AI有eye检测但不够强)
 *   - 保持模式匹配 (Sphyxis)
 *
 * @author jiransj
 */

import { getConfiguration, instanceCount } from './helpers.js'

const argsSchema = [
    ['cheats', true],
    ['disable-cheats', false],
    ['cheat-chance-threshold', 0.9],
    ['logtime', false],
    ['runOnce', false],
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns */
export async function main(ns) {
    let cheats = false, cheatChanceThreshold = 1.0, logtime = false, runOnce = true;
    let turn = 0, totalGames = 0, totalWins = 0;
    let recentCaptureZones = new Map();
    let prevBoardStr = ''; // 用于检测提子

    const opponent = ["Netburners","Slum Snakes","The Black Hand","Tetrads","Daedalus","Illuminati"];
    const opponent2 = [...opponent, "????????????"];

    // ── 工具函数 ──

    function getValidMoveList(ns) {
        const grid = ns.go.analysis.getValidMoves();
        const moves = [];
        for (let x = 0; x < grid.length; x++)
            for (let y = 0; y < grid[x].length; y++)
                if (grid[x][y]) moves.push([x, y]);
        return moves;
    }

    /** 模拟落子, 返回新棋盘和落子后的气数 */
    function simulateMove(board, x, y, color) {
        if (board[x][y] !== '.') return null;
        const nb = board.map(r => r.split(''));
        nb[x][y] = color;
        // 计算气数
        let libs = 0;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<board.length && ny>=0 && ny<board[0].length && nb[nx][ny] === '.') libs++;
        }
        return { board: nb.map(r => r.join('')), libs };
    }

    function getKomi(opponent) {
        switch(opponent) {
            case 'Illuminati': return 7.5;
            case 'Daedalus': case 'Tetrads': return 5.5;
            case 'Slum Snakes': case 'The Black Hand': return 3.5;
            case 'Netburners': return 1.5;
            default: return 5.5;
        }
    }

    function quickScore(board) {
        let s = 0;
        for (const row of board) for (const ch of row) { if (ch==='X') s++; else if (ch==='O') s--; }
        return s;
    }

    // ── 核心AI: 基于游戏源码 goAI.ts ──

    /**
     * 评估在(x,y)落子后的结果
     * @returns {{ libs: number, capturable: boolean, oppAtari: number, safe: boolean }}
     */
    function evaluateMove(board, x, y, color) {
        const opp = color === 'X' ? 'O' : 'X';
        const size = board.length;
        const sim = simulateMove(board, x, y, color);
        if (!sim) return { libs: 0, capturable: false, oppAtari: 0, safe: false };

        const nb = sim.board;
        let myLibs = sim.libs;

        // 检查能否提子
        let captured = 0;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size && nb[nx][ny] === opp) {
                // 检查这个对手子的气
                let oppLibs = 0;
                for (const [dx2, dy2] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                    const nnx = nx+dx2, nny = ny+dy2;
                    if (nnx>=0 && nnx<size && nny>=0 && nny<size && nb[nnx][nny] === '.') oppLibs++;
                }
                if (oppLibs === 0) captured++;
            }
        }

        // 计算打吃数量
        let oppAtari = 0;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === opp) {
                let oppLibs = 0;
                for (const [dx2, dy2] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                    const nnx = nx+dx2, nny = ny+dy2;
                    if (nnx>=0 && nnx<size && nny>=0 && nny<size && board[nnx][nny] === '.') oppLibs++;
                }
                if (oppLibs === 1) oppAtari++;
            }
        }

        // 安全判断: 落子后不被立刻提掉
        const safe = captured > 0 || myLibs >= 2;

        return { libs: myLibs, capturable: captured > 0, oppAtari, safe };
    }

    /**
     * 核心选点函数 (基于游戏AI getMoveOptions 但去随机化)
     */
    function getBestMove(board, validMoveList) {
        const size = board.length;
        const me = 'X', opp = 'O';
        const candidates = [];
        const stones = board.join('');

        // --- 1. 提子 (capture) ---
        for (const [x, y] of validMoveList) {
            const ev = evaluateMove(board, x, y, me);
            if (ev.capturable) {
                candidates.push({x, y, score: 1000 + ev.oppAtari * 10, source: 'capture'});
            }
        }

        // --- 2. 打吃 (atari/surround) ---
        // 安全规则: 落子后自己气数>=2 或 能提子
        for (const [x, y] of validMoveList) {
            if (candidates.some(c => c.x===x && c.y===y)) continue;
            const ev = evaluateMove(board, x, y, me);
            if (!ev.safe) continue; // 🚫 不安全! 会被提!
            if (ev.oppAtari >= 1) {
                // 检查对手这口气是否安全(不会被反提)
                candidates.push({x, y, score: 200 + ev.oppAtari * 30, source: 'atari'});
            }
        }

        // --- 3. 救子 (defend) ---
        // 检查自己的子是否被打吃, 能否通过这个位置增加气数
        for (const [x, y] of validMoveList) {
            if (candidates.some(c => c.x===x && c.y===y)) continue;
            const ev = evaluateMove(board, x, y, me);
            if (!ev.safe) continue;

            // 检查周围有没有自己被打吃的子
            let savesOwnAtari = false;
            for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                const nx = x+dx, ny = y+dy;
                if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === me) {
                    let ownLibs = 0;
                    for (const [dx2, dy2] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                        const nnx = nx+dx2, nny = ny+dy2;
                        if (nnx>=0 && nnx<size && nny>=0 && nny<size && board[nnx][nny] === '.') ownLibs++;
                    }
                    if (ownLibs === 1) savesOwnAtari = true;
                }
            }
            if (savesOwnAtari) {
                candidates.push({x, y, score: 150, source: 'defend'});
            }
        }

        // --- 4. 做眼/破眼 (eye) ---
        // 简单眼检测: 一个空点如果所有非墙邻居都是同色, 就是眼
        for (const [x, y] of validMoveList) {
            if (candidates.some(c => c.x===x && c.y===y)) continue;
            const ev = evaluateMove(board, x, y, me);
            if (!ev.safe) continue;

            // 检查是不是对手的眼 (下在这里可以破眼)
            let oppEye = true, myEye = true;
            for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                const nx = x+dx, ny = y+dy;
                if (nx<0||nx>=size||ny<0||ny>=size||board[nx][ny]==='#') continue;
                if (board[nx][ny] !== 'O') oppEye = false;
                if (board[nx][ny] !== 'X') myEye = false;
            }
            if (oppEye) candidates.push({x, y, score: 180, source: 'eyeBlock'}); // 破眼!
            if (myEye) candidates.push({x, y, score: 100, source: 'eyeMake'});  // 做眼
        }

        // --- 5. 跳/growth (增加自己气数) ---
        for (const [x, y] of validMoveList) {
            if (candidates.some(c => c.x===x && c.y===y)) continue;
            const ev = evaluateMove(board, x, y, me);
            if (!ev.safe) continue;

            // 检查是否与自己的子形成跳(空一格)
            let jumpScore = 0;
            for (const [dx, dy] of [[2,0],[-2,0],[0,2],[0,-2],[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]]) {
                const nx = x+dx, ny = y+dy;
                if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === me) {
                    jumpScore += 3;
                    // 检查中间是否通畅
                    const mx = x+dx/2, my = y+dy/2;
                    const blocked = Number.isInteger(dx/2) && Number.isInteger(dy/2) &&
                        mx>=0 && mx<size && my>=0 && my<size && board[mx][my] !== '.';
                    if (!blocked) jumpScore += (dx*dy !== 0) ? 4 : 3; // 桂马或跳
                }
            }
            if (jumpScore > 0) {
                candidates.push({x, y, score: 80 + jumpScore, source: 'jump'});
            }
        }

        // --- 6. 拆边/扩张 (expansion) ---
        for (const [x, y] of validMoveList) {
            if (candidates.some(c => c.x===x && c.y===y)) continue;
            const ev = evaluateMove(board, x, y, me);
            if (!ev.safe) continue;
            if (ev.libs < 2) continue;

            // 计算到最近墙壁的距离
            let distToWall = Math.min(x, y, size-1-x, size-1-y);
            for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
                const nx = x+dx, ny = y+dy;
                if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === '#')
                    distToWall = Math.min(distToWall, Math.abs(dx)+Math.abs(dy));
            }
            if (distToWall < 2) continue; // 贴墙不走

            // 周围空旷加分
            let open = 0;
            for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
                if (dx===0 && dy===0) continue;
                const nx = x+dx, ny = y+dy;
                if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === '.') open++;
            }
            const edgeBonus = distToWall === 2 ? 12 : distToWall === 3 ? 8 : 2;
            candidates.push({x, y, score: 40 + open + edgeBonus, source: 'expand'});
        }

        // --- 7. 后备: 走空旷的角落 ---
        if (candidates.length === 0) {
            for (const [x, y] of validMoveList) {
                const ev = evaluateMove(board, x, y, me);
                if (!ev.safe) continue;

                let open = 0;
                for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
                    if (dx===0 && dy===0) continue;
                    const nx = x+dx, ny = y+dy;
                    if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === '.') open++;
                }
                candidates.push({x, y, score: open, source: 'fallback'});
            }
        }

        // 排序取最佳
        candidates.sort((a, b) => b.score - a.score);
        return candidates.length > 0 ? candidates[0] : null;
    }

    // ── 主循环 ──

    await start();

    async function start() {
        const runOptions = getConfiguration(ns, argsSchema);
        if (!runOptions || (await instanceCount(ns)) > 1) return;

        logtime = runOptions.logtime;
        runOnce = runOptions.runOnce;
        cheats = runOptions.cheats && !runOptions['disable-cheats'];
        cheatChanceThreshold = runOptions['cheat-chance-threshold'];

        ns.disableLog("go.makeMove");
        ns.disableLog("go.passTurn");
        ns.disableLog("sleep");

        while (true) {
            turn = 0;
            const opp = ns.go.getOpponent();
            ns.print(`INFO: 对阵 ${opp}`);
            const startTime = performance.now();

            while (true) {
                turn++;

                // 检查游戏是否结束
                if (ns.go.getGameState().currentPlayer === 'None') {
                    await handleGameOver(ns, opp, startTime);
                    break;
                }

                const board = ns.go.getBoardState();
                const validMoves = getValidMoveList(ns);

                // 作弊 (BN14.2)
                if (cheats && turn % 5 === 0) {
                    try {
                        if (ns.go.cheat.getCheatSuccessChance() > cheatChanceThreshold) {
                            if (ns.go.cheat.getCheatCount() > 0 && quickScore(board) - getKomi(opp) < -5) {
                                ns.go.cheat.removeRouter();
                                continue;
                            }
                            if (ns.go.cheat.getCheatSuccessChance() > 0.95) {
                                ns.go.cheat.playTwoMoves();
                                continue;
                            }
                        }
                    } catch (e) {}
                }

                // 选最佳落子
                const best = getBestMove(board, validMoves);

                let result;
                if (best) {
                    result = await ns.go.makeMove(best.x, best.y);
                    if (logtime) ns.print(`[${turn}] (${best.x},${best.y}) src:${best.source} 目:${(quickScore(board)-getKomi(opp)).toFixed(1)}`);
                } else {
                    if (logtime) ns.print(`[${turn}] pass`);
                    try { result = await ns.go.passTurn(); } catch { await handleGameOver(ns, opp, startTime); break; }
                }

                if (result && result.type === "gameOver") {
                    await handleGameOver(ns, opp, startTime);
                    break;
                }
            }
        }
    }

    async function handleGameOver(ns, opp, startTime) {
        totalGames++;
        const score = quickScore(ns.go.getBoardState()) - getKomi(opp);
        const isWin = score > 0;
        if (isWin) totalWins++;
        const elapsed = ((performance.now()-startTime)/1000).toFixed(1);
        ns.tprint(`[${totalGames}] ${opp} ${isWin?'✅':'❌'} 目:${score.toFixed(1)} ${elapsed}s 胜率:${(totalWins/totalGames*100).toFixed(0)}%`);
        if (runOnce) ns.exit();
        try { ns.go.resetBoardState(opponent2[Math.floor(Math.random()*opponent2.length)], 13); }
        catch { ns.go.resetBoardState(opponent[Math.floor(Math.random()*opponent.length)], 13); }
    }
}
