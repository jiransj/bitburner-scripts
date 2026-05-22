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
    /** @type {Map<string, number>} 记录最近被提子的区域 (key=区域坐标, value=死亡数) */
    const recentCaptureZones = new Map();

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
    // 基于围棋基本战术原则:
    //
    // 【布局】金角 → 银边 → 草肚皮
    //   开局优先占角(3-3,4-4,3-4点), 然后拆边, 最后中腹
    //
    // 【好形】跳(ikken tobi) > 桂马(knight move) > 大跳 > 贴
    //   跳空一格是最有效率的棋形,兼顾速度和安全
    //   桂马(日字)灵活, 适合攻击和防守
    //   直接贴(紧挨)效率低, 只在需要切断或紧气时才用
    //
    // 【坏形】空三角 > 团子 > 愚形
    //   叠棋(4个以上自己的子挤在一起)是效率最低的棋形
    //   直线长条也是低效形
    //
    // 【攻防】攻从厚势, 不追弱棋
    //   贴近对手只有在能提子或救子时才是有利的
    //   空旷地带发展潜力 > 局部纠缠
    //
    function scoreMove(board, x, y, chainList, libMap, size, isStrongOpponent, gamePhase = 'midgame', captureZones = new Map(), eyeMap = new Map(), eyeCountPerChain = new Map()) {
        const me = 'X', opp = 'O';
        let score = 0;

        // ════════════════════════════════════════════
        //  1. 死活优先 (围棋第一原则)
        // ════════════════════════════════════════════

        // 1a. ⭐ 打吃提子 (能提子就是好棋)
        for (const chain of chainList) {
            if (chain.color !== opp) continue;
            const libs = libMap.get(chain.id) ?? 99;
            if (libs > 1) continue;
            const canAtari = chain.stones.some(([sx, sy]) => Math.abs(x-sx)+Math.abs(y-sy) === 1);
            if (canAtari) {
                if (libs === 1) return 200; // 直接提子!
                score += 40;
            }
        }

        // 1b. ⭐ 救子 (自己的子被打吃)
        //   但要判断是否真的能救: 如果对手有充足的气来继续打吃, 救了也是白救
        for (const chain of chainList) {
            if (chain.color !== me) continue;
            const libs = libMap.get(chain.id) ?? 99;
            if (libs > 1) continue;
            const canSave = chain.stones.some(([sx, sy]) => Math.abs(x-sx)+Math.abs(y-sy) === 1);
            if (canSave) {
                // 检查这个被打吃的子是否已经深入敌阵(周围对手子太多)
                let enemyAround = 0;
                for (const [sx, sy] of chain.stones) {
                    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                        const nx = sx+dx, ny = sy+dy;
                        if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === 'O') enemyAround++;
                    }
                }
                // 如果周围对手子太多, 救了也活不了, 放弃
                if (enemyAround > chain.stones.length * 2) score += 10;  // 希望不大
                else score += 35;  // 值得救
            }
        }

        // 1c. 🚫 送死检测: 落子后自己没气了且不能提子 = 绝对不走
        let libsAfter = 0;
        let canCapture = false;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size) {
                if (board[nx][ny] === '.') libsAfter++;
                if (board[nx][ny] === opp) {
                    for (const chain of chainList) {
                        if (chain.color !== opp) continue;
                        if ((libMap.get(chain.id)??99) === 1 &&
                            chain.stones.some(([sx,sy]) => sx===nx && sy===ny))
                            canCapture = true;
                    }
                }
            }
        }
        if (libsAfter === 0 && !canCapture) return -999;

        // 1d. 🚫 "打完吃就走" 检测: 落子后只剩1气 (atari)
        //     除非能提掉对手, 否则对手下回合就提你
        if (libsAfter <= 1 && !canCapture) {
            // 检查周围对手子的气数: 如果对手也只剩1气, 这是对杀
            let oppInAtari = false;
            for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                const nx = x+dx, ny = y+dy;
                if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === opp) {
                    for (const chain of chainList) {
                        if (chain.color !== opp) continue;
                        if ((libMap.get(chain.id)??99) === 1 &&
                            chain.stones.some(([sx,sy]) => sx===nx && sy===ny))
                            oppInAtari = true;
                    }
                }
            }
            if (!oppInAtari) score -= 25;  // 不是对杀, 就是送死
            else score += 10;  // 对杀! 有机会
        }

        // 1e. 🚫 深入敌阵: 落子在对手包围圈中, 附近全是对手子
        let hostileCount = 0;
        for (let dx = -2; dx <= 2; dx++)
            for (let dy = -2; dy <= 2; dy++) {
                if (dx===0 && dy===0) continue;
                const nx = x+dx, ny = y+dy;
                if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === opp) hostileCount++;
            }
        if (hostileCount >= 10) score -= 20;       // 被包围了! 别进去
        else if (hostileCount >= 6) score -= 10;   // 危险区域

        // 1f. 🚫 避免重复送死: 检查上几回合在这里死了多少子
        const areaKey = `${Math.floor(x/3)},${Math.floor(y/3)}`;
        const recentDeaths = captureZones.get(areaKey) ?? 0;
        if (recentDeaths > 0) score -= recentDeaths * 8;  // 这里刚死过子, 别去了

        // ════════════════════════════════════════════
        //  1g. 🎯 攻杀判断: 眼位分析
        // ════════════════════════════════════════════

        for (const chain of chainList) {
            const chainKey = `${chain.stones[0][0]},${chain.stones[0][1]}`;
            const eyes = eyeCountPerChain.get(chainKey) ?? 0;
            const libs = libMap.get(chain.id) ?? 0;

            if (chain.color === opp) {
                // ---- 攻击对手 ----
                if (eyes === 0) {
                    // 0眼: 可杀之! 紧气攻击
                    const isAdj = chain.stones.some(([sx, sy]) => Math.abs(x-sx)+Math.abs(y-sy) === 1);
                    if (isAdj) {
                        if (libs <= 1) score += 50;   // 最后一气! 提掉!
                        else if (libs <= 2) score += 35; // 紧气
                        else if (libs <= 3) score += 20; // 包围
                    }
                    // 攻击眼位: 下在对手眼位上
                    for (const eye of eyeMap.values()) {
                        if (eye.owner !== opp) continue;
                        // 检查这个眼是否属于这个chain
                        const belongs = eye.chainIds.size > 0;
                        if (belongs && x === eye.x && y === eye.y) {
                            score += 30; // 破眼! 不让对手做眼
                        }
                    }
                } else if (eyes === 1) {
                    // 1眼: 破掉唯一的眼就杀了
                    for (const eye of eyeMap.values()) {
                        if (eye.owner !== opp) continue;
                        const belongs = eye.chainIds.size > 0;
                        if (belongs && x === eye.x && y === eye.y) {
                            score += 40; // 破掉最后一个眼! 杀!
                        }
                    }
                    // 同时紧气
                    const isAdj = chain.stones.some(([sx, sy]) => Math.abs(x-sx)+Math.abs(y-sy) === 1);
                    if (isAdj && libs <= 2) score += 20;
                }
            } else if (chain.color === me) {
                // ---- 防守自己做眼 ----
                if (eyes === 0 && libs <= 3) {
                    // 没眼且气少, 需要做眼或逃跑
                    const isAdj = chain.stones.some(([sx, sy]) => Math.abs(x-sx)+Math.abs(y-sy) === 1);
                    if (isAdj) score += 15; // 接应
                    // 做眼: 在眼位上落子
                    for (const eye of eyeMap.values()) {
                        if (eye.owner !== me) continue;
                        if (x === eye.x && y === eye.y) score += 25; // 做眼!
                    }
                } else if (eyes === 1 && libs <= 2) {
                    // 只有一个眼且气少, 做第二个眼
                    for (const eye of eyeMap.values()) {
                        if (eye.owner !== me) continue;
                        if (x === eye.x && y === eye.y) score += 30;
                    }
                }
                // 🚫 绝对不要填自己的眼 (除非所有眼都做完了)
                if (eyes >= 1) {
                    for (const eye of eyeMap.values()) {
                        if (eye.owner === me && x === eye.x && y === eye.y) {
                            // 如果这个棋链还有别的眼, 填一个没关系
                            // 简单策略: 只有1个眼时绝对不能填
                            if (eyes <= 1) score -= 40;
                            else score -= 15;
                        }
                    }
                }
            }
        }

        // ════════════════════════════════════════════
        //  2. 棋形效率 (好形加分, 坏形减分)
        // ════════════════════════════════════════════

        // 2a. 👍 跳 (一格空): 最有效率的棋形, 兼顾速度和安全
        let shapeScore = 0;
        for (const chain of chainList) {
            if (chain.color !== me) continue;
            for (const [sx, sy] of chain.stones) {
                const dx = Math.abs(x-sx), dy = Math.abs(y-sy);
                if (dx+dy === 2 && dx !== 0 && dy !== 0) shapeScore += 7;  // ✓ 跳 (对角空一格)
                else if ((dx===2 && dy===1) || (dx===1 && dy===2)) shapeScore += 6; // ✓ 桂马
                else if (dx+dy === 2) shapeScore += 4;  // 直线跳一格 (还行)
                else if (dx+dy === 3 && dx !== 0 && dy !== 0) shapeScore += 3; // 大跳
            }
        }
        score += Math.min(shapeScore, 14);

        // 2b. 👎 叠棋惩罚: 挤成一团是效率最低的愚形
        let crowded = 0;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === me) crowded++;
        }
        if (crowded >= 5) score -= 18;   // 团成一团! 极差
        else if (crowded >= 4) score -= 10;
        else if (crowded >= 3) score -= 4;

        // 2c. 👎 空三角/直线: 检查是否形成低效直线形
        // 检查水平/垂直方向是否有2个以上自己的子排成线
        for (const [dx, dy] of [[1,0],[0,1]]) {
            let inline = 0;
            for (let step = 1; step <= 3; step++) {
                const nx = x + dx*step, ny = y + dy*step;
                if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === me) inline++;
                else break;
            }
            for (let step = 1; step <= 3; step++) {
                const nx = x - dx*step, ny = y - dy*step;
                if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === me) inline++;
                else break;
            }
            if (inline >= 3) score -= 8;  // 三子直线 = 效率低
            else if (inline >= 4) score -= 14; // 四子直线 = 极差
        }

        // ════════════════════════════════════════════
        //  3. 布局原则 (金角 → 银边 → 草肚皮)
        // ════════════════════════════════════════════

        // 3a. 📐 修正边缘计算: 考虑 # 墙壁和棋盘外边界
        //   distToWall = 到最近边界/#墙壁的曼哈顿距离
        let distToWall = Math.min(x, y, size-1-x, size-1-y);
        // 检查 `#` 墙壁
        for (let dx = -3; dx <= 3; dx++) {
            for (let dy = -3; dy <= 3; dy++) {
                const nx = x+dx, ny = y+dy;
                if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === '#') {
                    const d = Math.abs(dx) + Math.abs(dy);
                    if (d < distToWall) distToWall = d;
                }
            }
        }
        // 附近有墙壁 = 不是好位置 (发展空间被限制)
        if (distToWall <= 1) score -= 8;    // 紧贴墙壁或边界 = 坏棋
        else if (distToWall === 2) score += 3;  // 离墙2格 = 还行
        else if (distToWall === 3) score += 6;  // 离墙3格 = 好位置
        else if (distToWall === 4) score += 4;  // 离墙4格
        // distToWall >= 5 = 中腹, 不加分

        // 3b. 拆边: 沿空旷方向发展 (不贴墙)
        if (distToWall >= 2 && distToWall <= 4) {
            let openSides = 0;
            for (const step of [-2, 2, -3, 3]) {
                const sx = x+step, sy = y+step;
                if (sx>=0 && sx<size && board[sx][y]==='.') openSides += Math.abs(step) === 2 ? 1.5 : 0.5;
                if (sy>=0 && sy<size && board[x][sy]==='.') openSides += Math.abs(step) === 2 ? 1.5 : 0.5;
            }
            score += Math.min(openSides, 8);
        }

        // 3c. 开局占角 (3-3, 4-4 附近)
        if (gamePhase === 'opening' && distToWall >= 2 && distToWall <= 4) {
            // 检查是否开阔角落
            let cornerOpen = true;
            for (let dx = -2; dx <= 2 && cornerOpen; dx++)
                for (let dy = -2; dy <= 2 && cornerOpen; dy++) {
                    if (dx===0 && dy===0) continue;
                    const nx = x+dx, ny = y+dy;
                    if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] !== '.') cornerOpen = false;
                }
            if (cornerOpen) score += 10;
        }

        // ════════════════════════════════════════════
        //  4. 攻防判断
        // ════════════════════════════════════════════

        // 4a. 🔪 切断 (切断对手联络)
        let cuts = 0;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === opp) cuts++;
        }
        if (cuts >= 2) score += 6;  // 切断两子
        else if (cuts === 1) score += 2;

        // 4b. 👎 贴近对手太多是恶手 (紧贴不抢空)
        let oppAdj = 0;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === opp) oppAdj++;
        }
        if (oppAdj >= 3) score -= 15;
        else if (oppAdj >= 2) {
            // 如果对手的子气多(安全), 贴着是浪费
            const oppSafe = chainList.some(c => c.color===opp && (libMap.get(c.id)??99)>=3);
            if (oppSafe) score -= 8;
        }

        // ════════════════════════════════════════════
        //  5. 全局判断
        // ════════════════════════════════════════════

        // 5a. 空旷地带: 周围棋子少=发展潜力大
        let stonesInRadius = 0;
        for (let dx = -3; dx <= 3; dx++)
            for (let dy = -3; dy <= 3; dy++) {
                if (dx===0 && dy===0) continue;
                const nx = x+dx, ny = y+dy;
                if (nx>=0 && nx<size && ny>=0 && ny<size) {
                    if (board[nx][ny] === 'O') stonesInRadius += 2;
                    else if (board[nx][ny] === 'X') stonesInRadius += 1.5;
                }
            }
        score += Math.max(0, 22 - stonesInRadius) * 0.6;

        // 5b. 靠近自己大龙 (协同作战, 但不是贴)
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

    // ── 眼位分析 ──
    // 检测棋盘上每个颜色的"眼"——被单一颜色完全包围的空点
    function analyzeEyes(board) {
        const size = board.length;
        /** @type {Map<string, {x:number, y:number, owner:'X'|'O', chainIds:Set<string>}>} */
        const eyes = new Map();

        // 遍历所有空点, 检查是否被同色包围
        for (let x = 0; x < size; x++) {
            for (let y = 0; y < size; y++) {
                if (board[x][y] !== '.') continue;

                // 收集周围4个邻居的颜色, 排除 # 墙壁
                const neighbors = new Set();
                let wallContact = false;
                for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                    const nx = x+dx, ny = y+dy;
                    if (nx<0 || nx>=size || ny<0 || ny>=size) { wallContact = true; continue; }
                    const c = board[nx][ny];
                    if (c === '#') wallContact = true;
                    else if (c === 'X' || c === 'O') neighbors.add(c);
                }

                // 如果所有非墙邻居都是同色, 这是一个潜在的眼
                if (neighbors.size === 1 && !wallContact) {
                    const owner = [...neighbors][0];
                    // 检查更大的范围: 周围2格内是否都是同色
                    let solid = true;
                    for (let dx = -2; dx <= 2 && solid; dx++) {
                        for (let dy = -2; dy <= 2 && solid; dy++) {
                            if (dx===0 && dy===0) continue;
                            const nx = x+dx, ny = y+dy;
                            if (nx<0 || nx>=size || ny<0 || ny>=size) continue;
                            const c = board[nx][ny];
                            if (c !== owner && c !== '.' && c !== '#') solid = false;
                        }
                    }
                    if (solid) {
                        // 找到这个眼关联的棋链
                        const chainIds = new Set();
                        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                            const nx = x+dx, ny = y+dy;
                            if (nx>=0 && nx<size && ny>=0 && ny<size && board[nx][ny] === owner) {
                                chainIds.add(`${nx},${ny}`);
                            }
                        }
                        eyes.set(`${x},${y}`, {x, y, owner, chainIds});
                    }
                }
            }
        }
        return eyes;
    }

    // 计算每个棋链有几个眼
    function countEyesPerChain(chainList, eyeMap) {
        /** @type {Map<string, number>} key=chainId(用第一颗子坐标), value=眼数 */
        const result = new Map();
        for (const chain of chainList) {
            if (!chain || chain.stones.length === 0) continue;
            const chainKey = `${chain.stones[0][0]},${chain.stones[0][1]}`;
            let eyeCount = 0;
            for (const eye of eyeMap.values()) {
                for (const cid of eye.chainIds) {
                    // 检查这个眼是否属于这个chain
                    if (chain.stones.some(([sx,sy]) => `${sx},${sy}` === cid)) {
                        eyeCount++;
                        break;
                    }
                }
            }
            result.set(chainKey, eyeCount);
        }
        return result;
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
            // 计算到最近墙壁/边界的距离
            const wallDist = (x,y) => {
                let d = Math.min(x, y, size-1-x, size-1-y);
                for (let dx=-3; dx<=3; dx++)
                    for (let dy=-3; dy<=3; dy++) {
                        const nx=x+dx, ny=y+dy;
                        if (nx>=0&&nx<size&&ny>=0&&ny<size&&board[nx][ny]==='#')
                            d = Math.min(d, Math.abs(dx)+Math.abs(dy));
                    }
                return d;
            };

            // 空点: 离墙3-4格, 周围开阔
            const goodPoints = [];
            for (const [x, y] of validMoves) {
                const wd = wallDist(x,y);
                if (wd < 2) continue; // 贴墙不走
                // 检查周围开阔
                let open = 0, oppNear = false;
                for (let dx=-3; dx<=3; dx++)
                    for (let dy=-3; dy<=3; dy++) {
                        if (dx===0&&dy===0) continue;
                        const nx=x+dx, ny=y+dy;
                        if (nx>=0&&nx<size&&ny>=0&&ny<size) {
                            if (board[nx][ny]==='.') open++;
                            if (board[nx][ny]==='O') oppNear = true;
                        }
                    }
                if (!oppNear && open >= 15) goodPoints.push({x,y,wd,open});
            }
            goodPoints.sort((a,b) => b.open - a.open);
            for (const p of goodPoints.slice(0,5))
                candidates.push({x:p.x, y:p.y, source:'open', pri:50});

            // 没找到好点: 走空旷的地方
            if (candidates.length === 0) {
                for (const [x, y] of validMoves) {
                    let open = 0;
                    for (let dx=-2; dx<=2; dx++)
                        for (let dy=-2; dy<=2; dy++) {
                            if (dx===0&&dy===0) continue;
                            const nx=x+dx, ny=y+dy;
                            if (nx>=0&&nx<size&&ny>=0&&ny<size&&board[nx][ny]==='.') open++;
                        }
                    if (open >= 8) candidates.push({x,y,source:'open2',pri:30});
                }
            }

            // 最后的最后: 走中间附近
            if (candidates.length === 0) {
                const center = Math.floor(size/2);
                validMoves
                    .map(([x,y]) => ({x,y,d:Math.abs(x-center)+Math.abs(y-center)}))
                    .sort((a,b) => a.d - b.d)
                    .slice(0, 3)
                    .forEach(p => candidates.push({x:p.x, y:p.y, source:'center',pri:15}));
            }
        }

        return candidates;
    }

    // ── 主决策 ──
    function getGamePhase(board) {
        let stones = 0;
        for (const row of board) for (const ch of row) if (ch === 'X' || ch === 'O') stones++;
        const total = board.length * board[0].length;
        if (stones <= total * 0.1) return 'opening';
        if (stones >= total * 0.5) return 'endgame';
        return 'midgame';
    }

    function selectBestMove(ns, board, validMoves, chainList, libMap, size, testBoard, contested, opponent) {
        const isStrong = opponent === 'Illuminati' || opponent === '????????????';
        const komi = getKomi(opponent);
        const gamePhase = getGamePhase(board);

        // 开局紧急占角
        if (validMoves.length > 0 && validMoves.length >= size*size-5) {
            const opening = getOpeningMove(validMoves, size);
            if (opening) return opening;
        }

        const candidates = collectCandidates(board, testBoard, validMoves, chainList, libMap, size, contested);

        // 眼位分析 (用于攻杀判断)
        const eyeMap = analyzeEyes(board);
        const eyeCountPerChain = countEyesPerChain(chainList, eyeMap);

        const scored = [];

        // 只对候选位置评分 (不遍历所有合法位置, 避免乱走)
        for (const c of candidates) {
            const s = scoreMove(board, c.x, c.y, chainList, libMap, size, isStrong, gamePhase, recentCaptureZones, eyeMap, eyeCountPerChain);
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

                // 检测提子: 比较走棋前后的棋盘, 记录我方被提的位置
                const newBoard = ns.go.getBoardState();
                for (let cx = 0; cx < size; cx++) {
                    for (let cy = 0; cy < size; cy++) {
                        if (board[cx][cy] === 'X' && newBoard[cx][cy] !== 'X') {
                            // 这位置的我方棋子被提了
                            const areaKey = `${Math.floor(cx/3)},${Math.floor(cy/3)}`;
                            recentCaptureZones.set(areaKey, (recentCaptureZones.get(areaKey) ?? 0) + 1);
                        }
                        if (board[cx][cy] === 'O' && newBoard[cx][cy] !== 'O') {
                            // 提了对手的子 - 清空这个区域的死亡记忆 (翻盘了)
                            const areaKey = `${Math.floor(cx/3)},${Math.floor(cy/3)}`;
                            recentCaptureZones.delete(areaKey);
                        }
                    }
                }
                // 衰减旧记忆 (每回合衰减20%)
                for (const [key, val] of recentCaptureZones) {
                    if (val <= 0) recentCaptureZones.delete(key);
                    else recentCaptureZones.set(key, val * 0.8);
                }
            }
        }
    }
}
