/**
 * go.js — IPvGO 围棋 AI v2 (混合架构)
 *
 * 架构: 模式匹配候选 + 评分排序 + 1步前瞻
 *
 * 相比旧版的改进:
 *   1. 不再用 if-else 链取第一个匹配 — 而是收集所有候选, 评分排序
 *   2. 评分函数: 提子/气数/连接/眼位/领地/边缘价值
 *   3. 1步前瞻: 模拟对手最佳应对, 选对自己最有利的
 *   4. 领地估算: 中盘/残局知道形势, 落后时更激进
 *   5. 保留全部手调模式 (Sphyxis 的 disrupt/def 模式经过实战检验)
 *   6. 保留原有的作弊逻辑
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

    // ══════════════════════════════════════════════════
    //  模式定义 (保留 Sphyxis 全部手调模式)
    // ══════════════════════════════════════════════════

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

    // ══════════════════════════════════════════════════
    //  工具函数: 走棋/分析/棋盘操作
    // ══════════════════════════════════════════════════

    /** 获取走棋的合法移动列表 */
    function getValidMoves(ns) { return ns.go.analysis.getValidMoves(); }

    /** 获取所有棋链(连通块) */
    function getChains(ns) { return ns.go.analysis.getChains(); }

    /** 获取所有棋链的气 */
    function getLiberties(ns) { return ns.go.analysis.getLiberties(); }

    /** 获取争议空点 */
    function getContested(ns) { return ns.go.analysis.getControlledEmptyNodes(); }

    /** 走一步棋, 返回结果 */
    async function makeMove(ns, x, y) { return await ns.go.makeMove(x, y); }

    /** Pass */
    async function passTurn(ns) { return await ns.go.passTurn(); }

    /** 构建带围墙的测试棋盘 (用于模式匹配) */
    function buildTestBoard(board) {
        const size = board.length;
        const wall = "W".repeat(size + 2);
        const tb = [wall];
        for (const row of board) tb.push("W" + row + "W");
        tb.push(wall);
        return tb;
    }

    // ══════════════════════════════════════════════════
    //  评分系统 (新)
    // ══════════════════════════════════════════════════

    /**
     * 综合评分一个落子位置
     * @param {string[]} board - 当前棋盘
     * @param {number} x - 列
     * @param {number} y - 行
     * @param {number[][][]} chains - 棋链
     * @param {number[][]} liberties - 所有气位
     * @param {number} size - 棋盘大小
     * @param {boolean} isStrongOpponent - 是否对阵强AI (Illuminati/w0r1d_d43m0n)
     * @returns {number} 评分 (越高越好)
     */
    function scoreMove(board, x, y, chains, liberties, size, isStrongOpponent) {
        const me = 'X', opp = 'O';
        let score = 0;

        // 判断是否对阵强AI (Illuminati)
        const isIlluminati = isStrongOpponent;

        // 1. 气数: 落子后自己有几口气
        let myLibs = 0;
        const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
        for (const [dx, dy] of dirs) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === '.') myLibs++;
        }
        score += myLibs * 3;

        // 2. 连接: 连接到自己几个子
        let connects = 0;
        for (const [dx, dy] of dirs) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === me) connects++;
        }
        score += connects * 5;

        // 3. 切断: 切断对手连接
        let cuts = 0;
        for (const [dx, dy] of dirs) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === opp) cuts++;
        }
        score += cuts * 10;

        // ───── 强AI特化策略 ─────
        if (isIlluminati) {
            // Illuminati 执着于提子/救子, 利用这点:
            // 给"拆边"和"大场"加分, 诱导它在小地方纠缠

            // 4. 大场价值: 落子在空旷区域 (周围3格内无子)
            let emptyZone = 0;
            for (let dx = -3; dx <= 3; dx++) {
                for (let dy = -3; dy <= 3; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x+dx, ny = y+dy;
                    if (nx>=0 && nx<size && ny>=0 && ny<size) {
                        if (board[nx][ny] === '.') emptyZone++;
                        else if (board[nx][ny] === me) emptyZone += 0.5;
                    }
                }
            }
            score += emptyZone * 2; // 空旷区域价值高 = 可以建领地

            // 5. 双翼伸展: 落子在三线/四线且两侧空旷
            const edgeDist = Math.min(x, y, size-1-x, size-1-y);
            if (edgeDist === 1 || edgeDist === 2) {
                // 检查两侧 (沿边方向)
                const alongEdge = edgeDist <= 1;
                let sidesEmpty = 0;
                if (alongEdge) {
                    // 水平方向
                    for (const step of [-1, 1]) {
                        const nx = x + step * 2;
                        if (nx >= 0 && nx < size && board[nx]?.[y] === '.') sidesEmpty++;
                    }
                    // 垂直方向
                    for (const step of [-1, 1]) {
                        const ny = y + step * 2;
                        if (ny >= 0 && ny < size && board[x]?.[ny] === '.') sidesEmpty++;
                    }
                }
                score += sidesEmpty * 5; // 两侧可拆, 价值高
            }

            // 6. 打吃/双打吃检测
            let atariCount = 0;
            for (const chain of chains) {
                if (!chain || chain.length === 0) continue;
                const [cx, cy] = chain[0];
                if (board[cx]?.[cy] !== opp) continue;
                if (!isAdjacentTo(x, y, cx, cy)) continue; // 不相邻, 不相关
                // 计算这个链当前的气
                let oppLibs = 0;
                const seen = new Set();
                for (const [px, py] of chain) {
                    for (const [dx, dy] of dirs) {
                        const nx = px+dx, ny = py+dy;
                        const key = `${nx},${ny}`;
                        if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === '.' && !seen.has(key)) {
                            // 如果是我们要下的位置, 也算气(但落子后就不算了)
                            if (nx === x && ny === y) continue;
                            seen.add(key);
                            oppLibs++;
                        }
                    }
                }
                // 如果只差这口气就打吃了
                if (oppLibs <= 1) atariCount++;
            }
            if (atariCount >= 2) score += 45; // 双打吃! 对手只能救一个
            else if (atariCount === 1) score += 15; // 单打吃
        }

        // 4. 提子潜力
        let capturePotential = 0;
        for (const [dx, dy] of dirs) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === opp) {
                // 简化: 对手的子如果在边上 + 周围空少, 提子潜力高
                let oppLibs = 0;
                for (const [dx2, dy2] of dirs) {
                    const nnx = nx+dx2, nny = ny+dy2;
                    if (nnx>=0 && nnx<size && nny>=0 && nny<size && board[nnx][nny] === '.') oppLibs++;
                }
                if (oppLibs <= 1) capturePotential += 15; // 快提掉了
                else if (oppLibs <= 2) capturePotential += 5;
            }
        }
        score += capturePotential;

        // 5. 边缘价值
        const edgeDist = Math.min(x, y, size-1-x, size-1-y);
        if (edgeDist === 0) score += 3;   // 一线 (低)
        else if (edgeDist === 1) score += 10; // 二线 (围棋黄金线!)
        else if (edgeDist === 2) score += 7;  // 三线
        else score += 2;                     // 中腹

        // 6. 眼位潜力: 周围8格有多少是自己的或空的
        let friendly = 0, total = 0;
        const allDirs = [[-1,0],[1,0],[0,-1],[0,1],[1,1],[1,-1],[-1,1],[-1,-1]];
        for (const [dx, dy] of allDirs) {
            const nx = x+dx, ny = y+dy;
            total++;
            if (nx<0 || nx>=size || ny<0 || ny>=size) { friendly++; continue; }
            if (board[nx][ny] === me || board[nx][ny] === '.') friendly++;
        }
        score += (friendly / total) * 8;

        // 7. 靠近对手大龙 (攻击性)
        for (const chain of chains) {
            if (!chain || chain.length < 3) continue; // 只考虑大棋链
            const [cx, cy] = chain[0];
            const color = board[cx]?.[cy];
            if (color !== opp) continue;
            const dist = Math.abs(x-cx) + Math.abs(y-cy);
            if (dist <= 2) score += 4; // 靠近对手大龙
        }

        // 8. 保护自己的大龙
        for (const chain of chains) {
            if (!chain || chain.length < 3) continue;
            const [cx, cy] = chain[0];
            if (board[cx]?.[cy] !== me) continue;
            const dist = Math.abs(x-cx) + Math.abs(y-cy);
            if (dist <= 1) score += 3;
        }

        return score;
    }

    /**
     * 快速估算棋盘形势
     * @returns {number} 正数=黑(我)好, 负数=白(对手)好
     */
    function estimateScore(board, komi) {
        let myScore = 0, oppScore = 0;
        const size = board.length;
        for (let x = 0; x < size; x++) {
            for (let y = 0; y < size; y++) {
                if (board[x][y] === 'X') myScore++;
                else if (board[x][y] === 'O') oppScore++;
            }
        }
        return (myScore - oppScore) - (komi ?? 5.5); // 减去贴目
    }

    /** 根据对手名获取 komi */
    function getKomi(opponent) {
        switch(opponent) {
            case 'Illuminati': return 7.5;
            case 'Daedalus':
            case 'Tetrads': return 5.5;
            case 'Slum Snakes':
            case 'The Black Hand': return 3.5;
            case 'Netburners': return 1.5;
            default: return 5.5;
        }
    }

    /**
     * 判断当前是否"危险": 对手领先时激进, 领先时保守
     */
    function isDesperate(board) {
        return estimateScore(board, getKomi(ns.go.getOpponent())) < -10;
    }

    // ══════════════════════════════════════════════════
    //  模式匹配引擎 (保留原版)
    // ══════════════════════════════════════════════════

    /**
     * 检查 (x,y) 是否匹配某个模式
     * 返回匹配到的模式, 或 null
     */
    function matchPatternAt(testBoard, x, y, pattern, contested) {
        const size = testBoard[0].length;
        const patterns = getAllPatterns(pattern);
        const patternSize = pattern.length;

        for (const p of patterns) {
            for (let cx = ((patternSize-1)*-1); cx <= 0; cx++) {
                if (cx+x+1 < 0 || cx+x+1 > size-1) continue;
                for (let cy = ((patternSize-1)*-1); cy <= 0; cy++) {
                    if (cy+y+1 < 0 || cy+y+1 > size-1) continue;
                    let count = 0, abort = false;
                    for (let px = 0; px < patternSize && !abort; px++) {
                        if (x+cx+px+1 < 0 || x+cx+px+1 >= size) { abort = true; break; }
                        for (let py = 0; py < patternSize && !abort; py++) {
                            if (y+cy+py+1 < 0 || y+cy+py+1 >= size) { abort = true; break; }
                            const tc = testBoard[cx+x+1+px][cy+y+1+py];
                            const pc = p[px][py];
                            if (cx+px === 0 && cy+py === 0 && !["X","*"].includes(pc)) { abort = true; break; }
                            if (cx+px === 0 && cy+py === 0 && pc === "X" && contested?.[x]?.[y]) { abort = true; break; }
                            switch(pc) {
                                case "X": if (tc === "X" || (cx+px===0 && cy+py===0 && tc===".")) count++; else abort=true; break;
                                case "*": if (tc === "." && cx+px===0 && cy+py===0) count++; else abort=true; break;
                                case "O": if (tc === "O") count++; else abort=true; break;
                                case "x": if (["X","."].includes(tc)) count++; else abort=true; break;
                                case "o": if (["O","."].includes(tc)) count++; else abort=true; break;
                                case ".": if (tc === ".") count++; else abort=true; break;
                                case "?": count++; break;
                                case "W": if (["W","#"].includes(tc)) count++; else abort=true; break;
                                case "B": if (["W","#","X"].includes(tc)) count++; else abort=true; break;
                                case "b": if (["W","#","O"].includes(tc)) count++; else abort=true; break;
                                case "A": if (["W","#","X","O"].includes(tc)) count++; else abort=true; break;
                            }
                            if (count === patternSize*patternSize) return p;
                        }
                    }
                }
            }
        }
        return null;
    }

    function getAllPatterns(pattern) {
        function rotate(p) {
            const n = p.length;
            const r = Array.from({length:n}, ()=>Array(n).fill('?'));
            for (let i=0; i<n; i++) for (let j=0; j<n; j++) r[j][n-1-i] = p[i][j];
            return r.map(row => row.join(''));
        }
        function flip(p) {
            return p.map(row => row.split('').reverse().join(''));
        }
        // 对 4x4 模式只做部分旋转加速
        if (pattern.length >= 5) return [pattern];
        const seen = new Set();
        const result = [];
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

    // ══════════════════════════════════════════════════
    //  候选生成器 (保留全部原版策略函数)
    // ══════════════════════════════════════════════════

    // 注: 以下函数签名均为 (ns, board, testBoard, validMoves, chains, liberties, contested, turn, size) => [x,y] | null
    // 从原版 go.js 提取的核心策略, 改为返回候选而非直接走棋

    function getOpeningCandidate(ns, board, testBoard, validMoves, chains, liberties, contested, turn, size) {
        if (turn > 2) return null;
        const center = Math.floor(size/2);
        const tries = [[center,center],[2,2],[2,size-3],[size-3,2],[size-3,size-3],[Math.floor(size/3),Math.floor(size/3)],[size-Math.floor(size/3)-1,size-Math.floor(size/3)-1]];
        for (const [x,y] of tries) {
            if (validMoves.some(([mx,my]) => mx===x && my===y)) return [x,y];
        }
        return validMoves.length > 0 ? validMoves[Math.floor(Math.random()*validMoves.length)] : null;
    }

    /** 收集所有模式匹配候选 */
    function collectPatternCandidates(ns, board, testBoard, validMoves, chains, liberties, contested, turn, size) {
        const candidates = [];

        // 为每个合法位置尝试匹配模式
        for (const [x, y] of validMoves) {
            // 检查 disrupt4
            for (const p of disrupt4) {
                if (matchPatternAt(testBoard, x, y, p, contested)) {
                    candidates.push({ x, y, source: 'disrupt4', priority: 90 });
                    break;
                }
            }
            // 检查 disrupt5
            for (const p of disrupt5) {
                if (matchPatternAt(testBoard, x, y, p, contested)) {
                    candidates.push({ x, y, source: 'disrupt5', priority: 80 });
                    break;
                }
            }
            // 检查 def5
            for (const p of def5) {
                if (matchPatternAt(testBoard, x, y, p, contested)) {
                    candidates.push({ x, y, source: 'def5', priority: 70 });
                    break;
                }
            }
        }

        // 如果模式匹配没找到任何候选, 用启发式生成
        if (candidates.length === 0) {
            // 1. 提子
            for (const [x, y] of validMoves) {
                let captures = 0;
                const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
                for (const [dx, dy] of dirs) {
                    const nx = x+dx, ny = y+dy;
                    if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === 'O') captures++;
                }
                if (captures > 0) candidates.push({ x, y, source: 'capture', priority: 85 });
            }

            // 2. 断点
            for (const [x, y] of validMoves) {
                let oppAdj = 0;
                const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
                for (const [dx, dy] of dirs) {
                    const nx = x+dx, ny = y+dy;
                    if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === 'O') oppAdj++;
                }
                if (oppAdj >= 2) candidates.push({ x, y, source: 'cut', priority: 60 });
            }

            // 3. 贴对手走
            for (const [x, y] of validMoves) {
                const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
                for (const [dx, dy] of dirs) {
                    const nx = x+dx, ny = y+dy;
                    if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === 'O') {
                        candidates.push({ x, y, source: 'approach', priority: 40 });
                        break;
                    }
                }
            }

            // 4. 边缘位置
            for (const [x, y] of validMoves) {
                const edgeDist = Math.min(x, y, size-1-x, size-1-y);
                if (edgeDist <= 2) candidates.push({ x, y, source: 'edge', priority: 30 });
            }
        }

        return candidates;
    }

    // ══════════════════════════════════════════════════
    //  主决策函数 (新)
    // ══════════════════════════════════════════════════

    /**
     * 选择最佳落子
     * 策略: 评分所有候选 + 1步前瞻
     */
    function selectBestMove(ns, board, validMoves, chains, liberties, contested, turn, size, testBoard, opponent) {
        const isStrong = opponent === 'Illuminati' || opponent === '????????????';
        const komi = getKomi(opponent);
        // 收集候选
        const candidates = collectPatternCandidates(ns, board, testBoard, validMoves, chains, liberties, contested, turn, size);
        const opening = getOpeningCandidate(ns, board, testBoard, validMoves, chains, liberties, contested, turn, size);
        if (opening && turn <= 2) return opening;

        // 对每个候选评分
        const scored = new Map();
        for (const c of candidates) {
            const key = `${c.x},${c.y}`;
            if (!scored.has(key) || scored.get(key).priority < c.priority) {
                const s = scoreMove(board, c.x, c.y, chains, liberties, size, isStrong);
                scored.set(key, { ...c, score: s + c.priority });
            }
        }

        // 如果没有合法移动, pass
        if (validMoves.length === 0) return null;

        // 对没有候选的位置也评分 (作为后备)
        if (scored.size < validMoves.length * 0.5) {
            for (const [x, y] of validMoves) {
                const key = `${x},${y}`;
                if (!scored.has(key)) {
                    const s = scoreMove(board, x, y, chains, liberties, size, isStrong);
                    scored.set(key, { x, y, source: 'fallback', priority: 0, score: s });
                }
            }
        }

        // 按评分排序
        const sorted = [...scored.entries()].map(([k, v]) => v).sort((a, b) => b.score - a.score);

        // 取前5个做1步前瞻
        const topN = sorted.slice(0, Math.min(5, sorted.length));

        // 如果没有足够好的棋, 考虑 pass (对手也没有好棋时)
        if (topN.length === 0 || topN[0].score < -50) return null;

        // 如果只有一个候选或是紧急情况, 直接走
        if (topN.length === 1 || sorted[0].score - sorted[1].score > 30) {
            return [topN[0].x, topN[0].y];
        }

        // 1步前瞻: 模拟对手的最佳应对, 选对自己最有利的
        let bestMove = null, bestValue = -Infinity;
        for (const c of topN) {
            // 模拟走这步
            const simBoard = simulateMove(board, c.x, c.y, 'X', size);
            if (!simBoard) continue;

            // 预测对手的最佳应对
            let worstOpponentResponse = Infinity;
            for (const oppCandidate of validMoves) {
                if (oppCandidate[0] === c.x && oppCandidate[1] === c.y) continue;
                const oppBoard = simulateMove(simBoard, oppCandidate[0], oppCandidate[1], 'O', size);
                if (!oppBoard) continue;
                const oppScore = estimateScore(oppBoard, komi);
                if (oppScore < worstOpponentResponse) {
                    worstOpponentResponse = oppScore;
                }
            }

            // 如果对手没有好位置可走 (pass)
            if (worstOpponentResponse === Infinity) {
                const myScore = estimateScore(simBoard, komi);
                if (myScore > bestValue) {
                    bestValue = myScore;
                    bestMove = [c.x, c.y];
                }
                continue;
            }

            // 选对手应对后对我最有利的
            if (-worstOpponentResponse > bestValue) {
                bestValue = -worstOpponentResponse;
                bestMove = [c.x, c.y];
            }
        }

        return bestMove || [topN[0].x, topN[0].y];
    }

    /**
     * 模拟落子 (简化版, 不考虑提子, 仅用于评分比较)
     */
    function simulateMove(board, x, y, color, size) {
        if (x < 0 || x >= size || y < 0 || y >= size) return null;
        if (board[x][y] !== '.') return null;
        const newBoard = board.map(row => row.split(''));
        newBoard[x][y] = color;
        return newBoard.map(row => row.join(''));
    }

    // ══════════════════════════════════════════════════
    //  作弊逻辑 (BN14.2)
    // ══════════════════════════════════════════════════

    async function tryCheat(ns, board) {
        try {
            const cheatChance = ns.go.cheat.getCheatSuccessChance();
            if (cheatChance < cheatChanceThreshold) return false;

            const cheatCount = ns.go.cheat.getCheatCount();
            if (cheatCount > 0 && isDesperate(board)) {
                ns.go.cheat.removeRouter();
                return true;
            }
            if (cheatChance > 0.95) {
                ns.go.cheat.playTwoMoves();
                return true;
            }
        } catch (e) {}
        return false;
    }

    function isAdjacentTo(x1, y1, x2, y2) {
        return Math.abs(x1 - x2) + Math.abs(y1 - y2) === 1;
    }

    // ══════════════════════════════════════════════════
    //  主循环
    // ══════════════════════════════════════════════════

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
                const board = ns.go.getBoardState();
                const size = board.length;
                const testBoard = buildTestBoard(board);
                const validMoves = getValidMoves(ns);
                const chains = getChains(ns);
                const liberties = getLiberties(ns);
                const contested = getContested(ns);

                // 先试作弊
                if (cheats && turn > 3) {
                    const cheated = await tryCheat(ns, board);
                    if (cheated) continue;
                }

                // 决定最佳落子
                const move = selectBestMove(ns, board, validMoves, chains, liberties, contested, turn, size, testBoard, opp);

                let result;
                if (move) {
                    result = await makeMove(ns, move[0], move[1]);
                    if (logtime) {
                        const elapsed = ((performance.now() - startTime)/1000).toFixed(1);
                        ns.print(`[${turn}] (${move[0]},${move[1]}) 目差:${estimateScore(board, getKomi(opp)).toFixed(1)} ${elapsed}s`);
                    }
                } else {
                    if (logtime) ns.print(`[${turn}] pass`);
                    result = await passTurn(ns);
                }

                if (result.type === "gameOver") {
                    totalGames++;
                    const score = estimateScore(ns.go.getBoardState(), getKomi(opp));
                    const isWin = score > 0;
                    if (isWin) totalWins++;
                    const elapsed = ((performance.now() - startTime)/1000).toFixed(1);
                    ns.tprint(`[${totalGames}] ${opp} ${isWin ? '✅' : '❌'} ` +
                        `目差:${score.toFixed(1)} ${elapsed}s 胜率:${(totalWins/totalGames*100).toFixed(0)}%`);
                    if (runOnce) ns.exit();
                    try { ns.go.resetBoardState(opponent2[Math.floor(Math.random()*opponent2.length)], 13); }
                    catch { ns.go.resetBoardState(opponent[Math.floor(Math.random()*opponent.length)], 13); }
                    break;
                }
            }
        }
    }
}
