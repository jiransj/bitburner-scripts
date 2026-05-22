/**
 * go.js — IPvGO 围棋 AI v2 (混合架构)
 *
 * 修正: getValidMoves 返回 boolean[][], 不是 [x,y] 数组
 *        getChains 返回 (number|null)[][], 不是链数组
 *        getLiberties 返回 number[][], 不是位置数组
 *        getControlledEmptyNodes 返回 string[], 不是二维数组
 *
 * @author jiransj (基于 Sphyxis 原版增强)
 */

import {
    getConfiguration, instanceCount, log, getErrorInfo, getActiveSourceFiles, getNsDataThroughFile, formatTime
} from './helpers.js'

const argsSchema = [
    ['cheats', true],
    ['disable-cheats', false],
    ['cheat-chance-threshold', 0.9],
    ['logtime', false],
    ['runOnce', false],
    ['silent', false],
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns */
export async function main(ns) {
    let cheats = false;
    let cheatChanceThreshold = 1.0;
    let logtime = false;
    let runOnce = true;
    let turn = 0;
    let totalGames = 0, totalWins = 0;

    // ── 模式定义 (Sphyxis) ──
    const disrupt4 = [
        ["??b?", "?b.b", "b.*b", "?bb?"],
        ["?bb?", "b..b", "b*Xb", "?bb?"],
        ["?bb?", "b..b", "b.*b", "?bb?"],
        ["??b?", "?b.b", "?b*b", "??O?"],
        ["?bbb", "bb.b", "W.*b", "?oO?"],
        ["?bbb", "bb.b", "W.*b", "?Oo?"],
        [".bbb", "o*.b", ".bbb", "????"],
    ];
    const disrupt5 = [
        ["?bbb?", "b.*.b", "?bbb?", "?????", "?????"],
        ["??OO?", "?b*.b", "?b..b", "??bb?", "?????"],
        ["?????", "??bb?", "?b*Xb", "?boob", "??bb?"],
        ["WWW??", "WWob?", "Wo*b?", "WWW??", "?????"],
        ["??b??", "?b.b?", "?b*b?", "?b.A?", "??b??"],
        ["??b??", "?b.b?", "??*.b", "?b?b?", "?????"],
        ["?WWW?", "WoOoW", "WOO*W", "W???W", "?????"],
        ["?WWW?", "Wo*oW", "WOOOW", "W???W", "?????"],
    ];
    const def5 = [
        ["?WW??", "WW.X?", "W.XX?", "WWW??", "?????"],
        ["WWW??", "WW.X?", "W.*X?", "WWW??", "?????"],
        ["BBB??", "BB.X?", "B..X?", "BBB??", "?????"],
        ["?WWW?", "W.*.W", "WXXXW", "?????", "?????"],
    ];

    const opponent = ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati"];
    const opponent2 = ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati", "????????????"];

    // ── API 兼容层 ──
    // getValidMoves 返回 boolean[][], 转为 [x,y] 数组
    function getValidMoveList(ns) {
        const grid = ns.go.analysis.getValidMoves();
        const moves = [];
        for (let x = 0; x < grid.length; x++)
            for (let y = 0; y < grid[x].length; y++)
                if (grid[x][y]) moves.push([x, y]);
        return moves;
    }

    // getChains 返回 (number|null)[][], 转为 { id, color, stones: [x,y][] }
    function getChainList(ns, board) {
        const grid = ns.go.analysis.getChains();
        const chainMap = new Map();
        for (let x = 0; x < grid.length; x++) {
            for (let y = 0; y < grid[x].length; y++) {
                const id = grid[x][y];
                if (id === null || id === undefined) continue;
                if (!chainMap.has(id)) chainMap.set(id, { id, color: board[x][y], stones: [] });
                chainMap.get(id).stones.push([x, y]);
            }
        }
        return [...chainMap.values()];
    }

    // getLiberties 返回 number[][], 转为 Map<chainId, count>
    function getLibertyMap(ns) {
        const grid = ns.go.analysis.getLiberties();
        const chainsGrid = ns.go.analysis.getChains();
        const libMap = new Map();
        for (let x = 0; x < grid.length; x++) {
            for (let y = 0; y < grid[x].length; y++) {
                const chainId = chainsGrid[x][y];
                if (chainId === null || chainId === undefined) continue;
                const count = grid[x][y];
                if (!libMap.has(chainId) || count < libMap.get(chainId))
                    libMap.set(chainId, count);
            }
        }
        return libMap;
    }

    function buildTestBoard(board) {
        const size = board.length;
        const wall = "W".repeat(size + 2);
        const tb = [wall];
        for (const row of board) tb.push("W" + row + "W");
        tb.push(wall);
        return tb;
    }

    // ── 评分系统 ──
    // 注意: 评分只用于在模式匹配候选之间做选择, 以及没有模式匹配时的后备
    // 不鼓励"贴近对手送子"——贴近对手只有在能提子或救子时才加分
    function scoreMove(board, x, y, chainList, libMap, size, isStrongOpponent) {
        const me = 'X', opp = 'O';
        let score = 0;
        const dirs = [[-1,0],[1,0],[0,-1],[0,1]];

        // 1. ⭐ 打吃提子 (最优先)
        for (const chain of chainList) {
            if (chain.color !== opp) continue;
            const libs = libMap.get(chain.id) ?? 99;
            if (libs > 1) continue; // 只有1气才考虑
            const isAdj = chain.stones.some(([sx, sy]) => Math.abs(x-sx)+Math.abs(y-sy) === 1);
            if (isAdj) score += 40;
        }

        // 2. ⭐ 救子 (自己的子被打吃)
        for (const chain of chainList) {
            if (chain.color !== me) continue;
            const libs = libMap.get(chain.id) ?? 99;
            if (libs > 1) continue;
            const isAdj = chain.stones.some(([sx, sy]) => Math.abs(x-sx)+Math.abs(y-sy) === 1);
            if (isAdj) score += 35;
        }

        // 3. 气数: 落子后至少要有气 (不能送死)
        let libsAfter = 0;
        for (const [dx, dy] of dirs) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === '.') libsAfter++;
        }
        if (libsAfter === 0) return -999; // 送死, 绝对不走
        score += libsAfter * 2;

        // 4. 👎 叠棋惩罚: 贴着2个以上自己的子是叠棋 (除了做眼)
        let connects = 0;
        const dirs8 = [[-1,0],[1,0],[0,-1],[0,1],[1,1],[1,-1],[-1,1],[-1,-1]];
        for (const [dx, dy] of dirs8) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === me) connects++;
        }
        if (connects >= 4) score -= 12;  // 叠了4个以上 = 效率低
        else if (connects >= 3) score -= 5;

        // 5. 👍 跳 (2格距离) 和 大跳/桂马 (3格距离): 高效棋形
        let jumpBonus = 0;
        const jumpDirs = [[2,0],[-2,0],[0,2],[0,-2],[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]];
        for (const chain of chainList) {
            if (chain.color !== me) continue;
            for (const [sx, sy] of chain.stones) {
                const dist = Math.abs(x-sx) + Math.abs(y-sy);
                const dx = Math.abs(x-sx), dy = Math.abs(y-sy);
                if (dist === 2 && board[sx][sy] !== '.') jumpBonus += 6;  // 一格跳
                else if ((dx===2 && dy===1) || (dx===1 && dy===2)) jumpBonus += 5; // 桂马
                else if (dist === 3 && dx !== 0 && dy !== 0) jumpBonus += 3; // 大跳
            }
        }
        score += Math.min(jumpBonus, 12); // 上限12

        // 6. 👍 拆边: 沿边线方向有开阔空间
        const edgeDist = Math.min(x, y, size-1-x, size-1-y);
        if (edgeDist <= 2) {
            let openSides = 0;
            for (const step of [-2, 2, -3, 3]) {
                if (Math.abs(step) === 2) {
                    if (x+step>=0 && x+step<size && board[x+step][y]==='.') openSides+=2;
                    if (y+step>=0 && y+step<size && board[x][y+step]==='.') openSides+=2;
                } else {
                    if (x+step>=0 && x+step<size && board[x+step][y]==='.') openSides++;
                    if (y+step>=0 && y+step<size && board[x][y+step]==='.') openSides++;
                }
            }
            score += Math.min(openSides, 10);
        }

        // 7. 📐 边缘价值 (围棋金角银边草肚皮)
        if (edgeDist === 0) score -= 8;   // 一线: 坏棋
        else if (edgeDist === 1) score += 8;  // 二线: 好
        else if (edgeDist === 2) score += 10; // 三线: 最好
        else if (edgeDist === 3) score += 5;  // 四线: 不错
        else score += 1;                     // 中腹

        // 8. 🔪 切断 (只在有明确目标时加分)
        let cuts = 0;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === 'O') cuts++;
        }
        if (cuts >= 2) score += 6;  // 切断两个对手子的连接
        else if (cuts === 1) score += 2;

        // 9. 👎 贴近对手太多是坏棋
        let oppAdj = 0;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === 'O') oppAdj++;
        }
        if (oppAdj >= 3) score -= 12;
        else if (oppAdj >= 2 && !chainList.some(c => c.color==='O' && (libMap.get(c.id)??99)<=1)) score -= 6;

        // 10. 空旷地带加分 (远离双方棋子)
        let stonesInRadius = 0;
        for (let dx = -3; dx <= 3; dx++)
            for (let dy = -3; dy <= 3; dy++) {
                if (dx===0 && dy===0) continue;
                const nx = x+dx, ny = y+dy;
                if (nx>=0 && nx<size && ny>=0 && ny<size) {
                    if (board[nx][ny] === 'O') stonesInRadius += 2;
                    else if (board[nx][ny] === 'X') stonesInRadius += 1;
                }
            }
        score += Math.max(0, 20 - stonesInRadius) * 0.8;

        // 11. 靠近自己大龙 (协作)
        for (const chain of chainList) {
            if (chain.color !== 'X' || chain.stones.length < 3) continue;
            const minDist = Math.min(...chain.stones.map(([sx, sy]) => Math.abs(x-sx)+Math.abs(y-sy)));
            if (minDist === 2) score += 3;
            else if (minDist === 3) score += 2;
        }

        return score;
    }

    function estimateScore(board, komi) {
        let myScore = 0, oppScore = 0;
        const size = board.length;
        for (let x = 0; x < size; x++)
            for (let y = 0; y < size; y++)
                if (board[x][y] === 'X') myScore++;
                else if (board[x][y] === 'O') oppScore++;
        return (myScore - oppScore) - (komi ?? 5.5);
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

    function isDesperate(board, opponent) {
        return estimateScore(board, getKomi(opponent)) < -10;
    }

    // ── 模式匹配 (保留 Sphyxis) ──
    function getAllPatterns(pattern) {
        function rotate(p) {
            const n = p.length, r = Array.from({length:n}, ()=>Array(n).fill('?'));
            for (let i=0; i<n; i++) for (let j=0; j<n; j++) r[j][n-1-i] = p[i][j];
            return r.map(row => row.join(''));
        }
        function flip(p) { return p.map(row => row.split('').reverse().join('')); }
        if (pattern.length >= 5) return [pattern];
        const seen = new Set(), result = [];
        let p = pattern.map(r => typeof r === 'string' ? r : r.join(''));
        for (let i = 0; i < 4; i++) {
            const key = p.join('|');
            if (!seen.has(key)) { seen.add(key); result.push(p); }
            const f = flip(p);
            const fkey = f.join('|');
            if (!seen.has(fkey)) { seen.add(fkey); result.push(f); }
            p = rotate(p);
        }
        return result;
    }

    function matchPatternAt(testBoard, x, y, pattern, contested) {
        const size = testBoard[0].length;
        const patterns = getAllPatterns(pattern);
        const ps = pattern.length;
        for (const p of patterns) {
            for (let cx = ((ps-1)*-1); cx <= 0; cx++) {
                if (cx+x+1<0||cx+x+1>size-1) continue;
                for (let cy = ((ps-1)*-1); cy <= 0; cy++) {
                    if (cy+y+1<0||cy+y+1>size-1) continue;
                    let count=0, abort=false;
                    for (let px=0; px<ps&&!abort; px++) {
                        if (x+cx+px+1<0||x+cx+px+1>=size) {abort=true;break;}
                        for (let py=0; py<ps&&!abort; py++) {
                            if (y+cy+py+1<0||y+cy+py+1>=size) {abort=true;break;}
                            const tc = testBoard[cx+x+1+px][cy+y+1+py];
                            const pc = p[px][py];
                            if (cx+px===0&&cy+py===0&&!["X","*"].includes(pc)){abort=true;break;}
                            if (cx+px===0&&cy+py===0&&pc==="X"&&contested?.[x]?.[y]){abort=true;break;}
                            switch(pc) {
                                case "X": if(tc==="X"||(cx+px===0&&cy+py===0&&tc==="."))count++;else abort=true;break;
                                case "*": if(tc==="."&&cx+px===0&&cy+py===0)count++;else abort=true;break;
                                case "O": if(tc==="O")count++;else abort=true;break;
                                case "x": if(["X","."].includes(tc))count++;else abort=true;break;
                                case "o": if(["O","."].includes(tc))count++;else abort=true;break;
                                case ".": if(tc===".")count++;else abort=true;break;
                                case "?": count++;break;
                                case "W": if(["W","#"].includes(tc))count++;else abort=true;break;
                                case "B": if(["W","#","X"].includes(tc))count++;else abort=true;break;
                                case "b": if(["W","#","O"].includes(tc))count++;else abort=true;break;
                                case "A": if(["W","#","X","O"].includes(tc))count++;else abort=true;break;
                            }
                            if(count===ps*ps) return p;
                        }
                    }
                }
            }
        }
        return null;
    }

    function getOpeningMove(validMoves, size) {
        const center = Math.floor(size/2);
        const tries = [[center,center],[2,2],[2,size-3],[size-3,2],[size-3,size-3]];
        for (const [x,y] of tries)
            if (validMoves.some(([mx,my]) => mx===x && my===y)) return [x,y];
        return validMoves.length > 0 ? validMoves[0] : null;
    }

    // ── 候选生成 ──
    // 策略: 模式匹配优先, 只有没模式时才用保守的启发式
    function collectCandidates(board, testBoard, validMoves, chainList, libMap, size, contested) {
        const candidates = [];

        // 1. 提子检测 (最高优先级)
        for (const [x, y] of validMoves) {
            for (const chain of chainList) {
                if (chain.color !== 'O') continue;
                const libs = libMap.get(chain.id) ?? 99;
                if (libs > 1) continue; // 只有打吃才考虑
                const canCapture = chain.stones.some(([sx, sy]) => Math.abs(x-sx)+Math.abs(y-sy) === 1);
                if (canCapture) {
                    candidates.push({x,y,source:'capture',pri:95});
                    break;
                }
            }
        }

        // 2. 救子检测
        for (const [x, y] of validMoves) {
            for (const chain of chainList) {
                if (chain.color !== 'X') continue;
                const libs = libMap.get(chain.id) ?? 99;
                if (libs > 1) continue;
                const canSave = chain.stones.some(([sx, sy]) => Math.abs(x-sx)+Math.abs(y-sy) === 1);
                if (canSave) {
                    candidates.push({x,y,source:'defend',pri:90});
                    break;
                }
            }
        }

        // 3. 原版模式匹配 (Sphyxis 手调模式, 经过实战检验)
        if (candidates.length === 0) {
            for (const [x, y] of validMoves) {
                for (const p of disrupt4) {
                    if (matchPatternAt(testBoard, x, y, p, contested)) {
                        candidates.push({x,y,source:'disrupt4',pri:85});
                        break;
                    }
                }
            }
        }
        if (candidates.length === 0) {
            for (const [x, y] of validMoves) {
                for (const p of disrupt5) {
                    if (matchPatternAt(testBoard, x, y, p, contested)) {
                        candidates.push({x,y,source:'disrupt5',pri:75});
                        break;
                    }
                }
            }
        }
        if (candidates.length === 0) {
            for (const [x, y] of validMoves) {
                for (const p of def5) {
                    if (matchPatternAt(testBoard, x, y, p, contested)) {
                        candidates.push({x,y,source:'def5',pri:65});
                        break;
                    }
                }
            }
        }

        // 4. 保守后备: 占空角/拆边 (不贴近对手)
        if (candidates.length === 0) {
            const edgeDist = (x,y) => Math.min(x, y, size-1-x, size-1-y);

            // 空角星位
            const starPoints = [];
            for (const [x, y] of validMoves) {
                const ed = edgeDist(x,y);
                if (ed === 2 || ed === 3) {
                    // 检查周围3格内无对手子
                    let oppNear = false;
                    for (let dx=-3; dx<=3 && !oppNear; dx++)
                        for (let dy=-3; dy<=3 && !oppNear; dy++) {
                            const nx=x+dx, ny=y+dy;
                            if (nx>=0&&nx<size&&ny>=0&&ny<size&&board[nx][ny]==='O') oppNear=true;
                        }
                    if (!oppNear) starPoints.push({x,y,source:'star',pri:50});
                }
            }
            candidates.push(...starPoints);

            // 如果还没有候选, 走保守的拆边
            if (candidates.length === 0) {
                for (const [x, y] of validMoves) {
                    const ed = edgeDist(x,y);
                    if (ed !== 1 && ed !== 2) continue; // 只考虑三线四线
                    // 两侧至少一个方向开阔
                    let openSides = 0;
                    for (const step of [-3, 3]) {
                        if (x+step>=0 && x+step<size && board[x+step]?.[y]==='.') openSides++;
                        if (y+step>=0 && y+step<size && board[x]?.[y+step]==='.') openSides++;
                    }
                    if (openSides >= 1) candidates.push({x,y,source:'side',pri:40});
                }
            }

            // 最后一个都没有: 走星位附近
            if (candidates.length === 0) {
                const center = Math.floor(size/2);
                const near = validMoves
                    .map(([x,y]) => ({x,y,d:Math.abs(x-center)+Math.abs(y-center)}))
                    .sort((a,b) => a.d - b.d);
                if (near.length > 0) candidates.push({...near[0],source:'center',pri:20});
            }
        }

        return candidates;
    }

    // ── 主决策 ──
    function selectBestMove(ns, board, validMoves, chainList, libMap, size, testBoard, contested, opponent) {
        const isStrong = opponent === 'Illuminati' || opponent === '????????????';
        const komi = getKomi(opponent);

        // 开局
        if (validMoves.length > 0 && validMoves.length >= size*size-5) {
            const opening = getOpeningMove(validMoves, size);
            if (opening) return opening;
        }

        const candidates = collectCandidates(board, testBoard, validMoves, chainList, libMap, size, contested);
        const scored = [];

        // 只对候选位置评分 (不遍历所有合法位置, 避免乱走)
        for (const c of candidates) {
            const s = scoreMove(board, c.x, c.y, chainList, libMap, size, isStrong);
            scored.push({x: c.x, y: c.y, score: s + c.pri});
        }

        // 如果没有候选, pass
        if (scored.length === 0) return null;

        scored.sort((a, b) => b.score - a.score);
        // 评分太低也 pass
        if (scored[0].score < 10) return null;

        // 1步前瞻 (前3名)
        const topN = scored.slice(0, Math.min(3, scored.length));
        if (topN.length === 1) return [topN[0].x, topN[0].y];

        let bestMove = null, bestValue = -Infinity;
        for (const c of topN) {
            // 模拟走棋
            const simBoard = board.map(row => row.split(''));
            simBoard[c.x][c.y] = 'X';
            const simStrs = simBoard.map(row => row.join(''));

            // 预测对手最佳应对 (只检查候选位置, 节约计算)
            let worstOpp = Infinity;
            for (const oc of candidates) {
                if (oc.x === c.x && oc.y === c.y) continue;
                const oppBoard = simStrs.map(row => row.split(''));
                oppBoard[oc.x][oc.y] = 'O';
                const oppStrs = oppBoard.map(row => row.join(''));
                const oppScore = estimateScore(oppStrs, komi);
                if (oppScore < worstOpp) worstOpp = oppScore;
            }

            if (worstOpp === Infinity) {
                const myScore = estimateScore(simStrs, komi);
                if (myScore > bestValue) { bestValue = myScore; bestMove = [c.x, c.y]; }
            } else {
                if (-worstOpp > bestValue) { bestValue = -worstOpp; bestMove = [c.x, c.y]; }
            }
        }

        return bestMove || [topN[0].x, topN[0].y];
    }

    // ── 作弊 (BN14.2) ──
    async function tryCheat(ns, board, opponent) {
        try {
            const cheatChance = ns.go.cheat.getCheatSuccessChance();
            if (cheatChance < cheatChanceThreshold) return false;
            if (cheatChance > 0.95) { ns.go.cheat.playTwoMoves(); return true; }
            const cheatCount = ns.go.cheat.getCheatCount();
            if (cheatCount > 0 && isDesperate(board, opponent)) {
                ns.go.cheat.removeRouter();
                return true;
            }
        } catch (e) {}
        return false;
    }

    // ── 游戏结束处理 ──
    async function handleGameOver(ns, opp, startTime) {
        totalGames++;
        const score = estimateScore(ns.go.getBoardState(), getKomi(opp));
        const isWin = score > 0;
        if (isWin) totalWins++;
        const elapsed = ((performance.now()-startTime)/1000).toFixed(1);
        ns.tprint(`[${totalGames}] ${opp} ${isWin?'✅':'❌'} 目:${score.toFixed(1)} ${elapsed}s 胜率:${(totalWins/totalGames*100).toFixed(0)}%`);
        if (runOnce) ns.exit();
        try { ns.go.resetBoardState(opponent2[Math.floor(Math.random()*opponent2.length)],13); }
        catch { ns.go.resetBoardState(opponent[Math.floor(Math.random()*opponent.length)],13); }
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

                // 检查游戏是否已经结束 (对手 pass 后可能已结束)
                const gameState = ns.go.getGameState();
                if (gameState.currentPlayer === 'None') {
                    await handleGameOver(ns, opp, startTime);
                    break;
                }

                const board = ns.go.getBoardState();
                const size = board.length;
                const validMoves = getValidMoveList(ns);
                const chainList = getChainList(ns, board);
                const libMap = getLibertyMap(ns);
                const testBoard = buildTestBoard(board);
                const contested = ns.go.analysis.getControlledEmptyNodes();

                // 先试作弊
                if (cheats && turn > 3) {
                    if (await tryCheat(ns, board, opp)) continue;
                }

                const move = selectBestMove(ns, board, validMoves, chainList, libMap, size, testBoard, contested, opp);

                let result;
                if (move) {
                    result = await ns.go.makeMove(move[0], move[1]);
                    if (logtime) {
                        const elapsed = ((performance.now()-startTime)/1000).toFixed(1);
                        ns.print(`[${turn}] (${move[0]},${move[1]}) 目:${estimateScore(board,getKomi(opp)).toFixed(1)} ${elapsed}s`);
                    }
                } else {
                    // 没棋下 → pass
                    if (logtime) ns.print(`[${turn}] pass`);
                    try {
                        result = await ns.go.passTurn();
                    } catch (e) {
                        // pass 时游戏已结束
                        await handleGameOver(ns, opp, startTime);
                        break;
                    }
                }

                if (result && result.type === "gameOver") {
                    await handleGameOver(ns, opp, startTime);
                    break;
                }
            }
        }
    }
}
