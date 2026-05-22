/** go.js v6 — 基于棋链(chain)的完整攻杀分析 */

import { getConfiguration, instanceCount } from './helpers.js'
const A = [['cheats',true],['disable-cheats',false],['cheat-chance-threshold',0.9],['logtime',false],['runOnce',false]];
export function autocomplete(d,a){d.flags(A);return[]}

/** @param {NS} ns */
export async function main(ns) {
    let c=false,cct=1,l=false,ro=true,tn=0,tg=0,tw=0;
    const OP=["Netburners","Slum Snakes","The Black Hand","Tetrads","Daedalus","Illuminati"];
    const OP2=[...OP,"????????????"];

    const vm=n=>{const g=n.go.analysis.getValidMoves(),r=[];for(let x=0;x<g.length;x++)for(let y=0;y<g[x].length;y++)if(g[x][y])r.push([x,y]);return r};
    const ko=o=>({Illuminati:7.5,Daedalus:5.5,Tetrads:5.5,'The Black Hand':3.5,'Slum Snakes':3.5,Netburners:1.5})[o]??5.5;
    const sc=b=>{let s=0;for(const r of b)for(const ch of r){if(ch==='X')s++;else if(ch==='O')s--;}return s};

    // 棋链分析: 把棋盘上的子分组为链
    function getChains(board) {
        const S=board.length, visited=Array.from({length:S},()=>Array(S).fill(false));
        const chains=[], d4=[[-1,0],[1,0],[0,-1],[0,1]];
        const inB=(x,y)=>x>=0&&x<S&&y>=0&&y<S;
        for(let x=0;x<S;x++) for(let y=0;y<S;y++) {
            if(visited[x][y]||board[x][y]==='.'||board[x][y]==='#') continue;
            const color=board[x][y], stones=[], libs=new Set();
            const stack=[[x,y]]; visited[x][y]=true;
            while(stack.length>0) {
                const [cx,cy]=stack.pop(); stones.push([cx,cy]);
                for(const [dx,dy] of d4) {
                    const nx=cx+dx, ny=cy+dy;
                    if(!inB(nx,ny)) continue;
                    if(board[nx][ny]==='.') libs.add(`${nx},${ny}`);
                    else if(board[nx][ny]===color&&!visited[nx][ny]) { visited[nx][ny]=true; stack.push([nx,ny]); }
                }
            }
            chains.push({color,stones,libs:[...libs].map(k=>k.split(',').map(Number))});
        }
        return chains;
    }

    // 评估在(x,y)落子 — 基于游戏AI的getSurroundMove逻辑
    function evaluateMove(board, x, y, chains) {
        const me='X', opp='O', S=board.length;
        const inB=(x,y)=>x>=0&&x<S&&y>=0&&y<S;
        const d4=[[-1,0],[1,0],[0,-1],[0,1]];

        // 我的新气数
        let myNewLibs=0;
        for(const [dx,dy] of d4) {const nx=x+dx,ny=y+dy; if(inB(nx,ny)&&board[nx][ny]==='.') myNewLibs++;}

        // 找相邻的对手链中最弱的一个(气最少)
        let weakestOppChain=null, weakestOppLibs=99;
        for(const chain of chains) {
            if(chain.color!==opp) continue;
            const isAdj=chain.stones.some(([sx,sy])=>Math.abs(sx-x)+Math.abs(sy-y)===1);
            if(!isAdj) continue;
            if(chain.libs.length<weakestOppLibs) { weakestOppLibs=chain.libs.length; weakestOppChain=chain; }
        }

        // 检查这手棋是否在对手棋链的气上
        const isOnOppLib = weakestOppChain && weakestOppChain.libs.some(([lx,ly])=>lx===x&&ly===y);

        // ⚠️ 安全规则 (来自游戏源码goAI.ts第648行):
        // "Do not suggest moves that do not capture anything and let your opponent immediately capture"
        const unsafe = myNewLibs<=2 && weakestOppLibs>2;

        // 检查落子后能不能提掉对手的链
        let captured=false;
        if(isOnOppLib && weakestOppLibs<=1) captured=true;

        // 检查落子后自己的子会不会被立刻提掉(我的链只剩1气)
        // 简单检查: 落子后只有1气且不处于对杀状态
        const atariSelf = myNewLibs<=1 && !captured;

        return {
            myLibs: myNewLibs,
            oppLibs: weakestOppLibs,          // 对手相邻最弱链的气数
            isOnOppLib,                        // 是否在对手的气上
            captured,                          // 能否提子
            unsafe,                            // 是否安全
            atariSelf,                         // 自己被打吃
            weakestChainLen: weakestOppChain?.stones.length??0
        };
    }

    // 过滤掉对手牢牢控制区域内的点 (抄自 gameAI findDisputedTerritory)
    // 但保留: 能提子的位置 + 能打吃的位置
    function filterDisputed(board, moves, chains) {
        const S=board.length, me='X', opp='O';
        const inB=(x,y)=>x>=0&&x<S&&y>=0&&y<S;
        const d4=[[-1,0],[1,0],[0,-1],[0,1]];

        // 1. 找对手棋链
        const chains=[];
        const visited=Array.from({length:S},()=>Array(S).fill(false));
        for(let x=0;x<S;x++) for(let y=0;y<S;y++) {
            if(visited[x][y]||board[x][y]!==opp) continue;
            const stones=[],stack=[[x,y]]; visited[x][y]=true;
            while(stack.length>0) {
                const [cx,cy]=stack.pop(); stones.push([cx,cy]);
                for(const [dx,dy] of d4) {
                    const nx=cx+dx, ny=cy+dy;
                    if(inB(nx,ny)&&board[nx][ny]===opp&&!visited[nx][ny]){visited[nx][ny]=true;stack.push([nx,ny]);}
                }
            }
            // 计算气
            const libs=new Set();
            for(const [sx,sy] of stones) for(const [dx,dy] of d4) {
                const nx=sx+dx, ny=sy+dy;
                if(inB(nx,ny)&&board[nx][ny]==='.') libs.add(`${nx},${ny}`);
            }
            chains.push({stones,libs:[...libs].map(k=>k.split(',').map(Number))});
        }

        // 2. 对手的潜在眼位: 被对手围住的空区域
        const oppTerritory=new Set(); // 对手牢牢控制的空点
        for(const chain of chains) {
            if(chain.libs.length>8) continue; // 气太多, 不是眼位
            // 检查这个棋链的每一口气是否都在"内部"(周围大部分是对手子)
            for(const [lx,ly] of chain.libs) {
                let oppAround=0, total=0;
                for(const [dx,dy] of d4) {
                    const nx=lx+dx, ny=ly+dy;
                    if(!inB(nx,ny)) {total++;oppAround++;continue;}
                    if(board[nx][ny]===opp||board[nx][ny]==='#') oppAround++;
                    total++;
                }
                // 如果气点周围全是/几乎全是对手子 → 这是对手控制区域
                if(oppAround>=total-1) oppTerritory.add(`${lx},${ly}`);
            }
        }

        // 3. 保留: 能提子或打吃的位置 (即使在对手控制区内)
        const keepSet=new Set();
        for(const [x,y] of moves) {
            for(const chain of chains) {
                if(chain.color!==opp) continue;
                const isAdj=chain.stones.some(([sx,sy])=>Math.abs(sx-x)+Math.abs(sy-y)===1);
                if(!isAdj) continue;
                // 能提子(对手气=0)或打吃(对手气=1) → 保留
                if(chain.libs.length<=1) keepSet.add(`${x},${y}`);
                // 对手气=2且我落子后安全 → 保留
                if(chain.libs.length===2) {
                    let myLibs=0;
                    for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                        const nx=x+dx, ny=y+dy;
                        if(nx>=0&&nx<S&&ny>=0&&ny<S&&board[nx][ny]==='.') myLibs++;
                    }
                    if(myLibs>=2) keepSet.add(`${x},${y}`);
                }
            }
        }

        // 4. 过滤: 在对手控制区域内且不能提子/打吃的点 → 删除
        return moves.filter(([x,y])=>!oppTerritory.has(`${x},${y}`)||keepSet.has(`${x},${y}`));
    }

    // Illuminati 完整决策
    function getBestMove(board, allMoves) {
        // ⭐ 先用 findDisputedTerritory 逻辑过滤: 不去对手控制区送死
        const chains2=getChains(board);
        const moves = filterDisputed(board, allMoves, chains2);
        if (moves.length === 0) return null; // 没有可争议的位置 → pass
        const chains=getChains(board), S=board.length, me='X', opp='O';
        const inB=(x,y)=>x>=0&&x<S&&y>=0&&y<S;

        // 预评估所有合法位置
        const scored=[];
        for(const [x,y] of moves) {
            const ev=evaluateMove(board,x,y,chains);

            // ❌ 不安全: 自己气≤2且对手气>2 → 跳过 (核心防送死)
            if(ev.unsafe && !ev.captured) continue;

            let score=0, src='';

            // 1. capture 提子
            if(ev.captured) {
                // 提掉的子越多越好
                let capCount=0;
                for(const chain of chains) {
                    if(chain.color!==opp) continue;
                    const isAdj=chain.stones.some(([sx,sy])=>Math.abs(sx-x)+Math.abs(sy-y)===1);
                    if(isAdj && chain.libs.length<=1) capCount+=chain.stones.length;
                }
                score=10000+capCount*100; src='c';
            }
            // 2. defendCapture 救子 (自己1气的链救到>1气)
            else if(ev.myLibs>=2) {
                for(const chain of chains) {
                    if(chain.color!==me) continue;
                    const isAdj=chain.stones.some(([sx,sy])=>Math.abs(sx-x)+Math.abs(sy-y)===1);
                    if(isAdj && chain.libs.length===1) { score=5000; src='d'; break; }
                }
            }
            // 3. eyeMove 做眼
            if(score<5000 && ev.myLibs>=2) {
                let allMe=true, hasMe=false;
                for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                    const nx=x+dx, ny=y+dy;
                    if(!inB(nx,ny)||board[nx][ny]==='#') continue;
                    if(board[nx][ny]!==me) allMe=false;
                    if(board[nx][ny]===me) hasMe=true;
                }
                if(allMe&&hasMe) { score=4000; src='e'; }
            }
            // 4. surround 打吃 (对手气=2, 安全)
            if(score<4000 && ev.isOnOppLib && ev.oppLibs===2 && !ev.unsafe) {
                score=3000; src='a';
            }
            // 5. 紧气 (对手气=3, 安全)
            if(score<3000 && ev.isOnOppLib && ev.oppLibs===3 && !ev.unsafe) {
                score=2000; src='s';
            }
            // 6. eyeBlock 破眼
            if(score<2000 && ev.myLibs>=2) {
                let allOpp=true, hasOpp=false;
                for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                    const nx=x+dx, ny=y+dy;
                    if(!inB(nx,ny)||board[nx][ny]==='#') continue;
                    if(board[nx][ny]!==opp) allOpp=false;
                    if(board[nx][ny]===opp) hasOpp=true;
                }
                if(allOpp&&hasOpp) { score=1500; src='b'; }
            }
            // 7. corner 占角
            if(score<1000) {
                const dw=Math.min(x,y,S-1-x,S-1-y);
                if(dw>=2&&dw<=3) {
                    let open=true;
                    for(let dx=-2;dx<=2&&open;dx++) for(let dy=-2;dy<=2&&open;dy++) {
                        if(dx===0&&dy===0) continue;
                        const nx=x+dx, ny=y+dy;
                        if(inB(nx,ny)&&board[nx][ny]!=='.') open=false;
                    }
                    if(open) { score=900; src='r'; }
                }
            }
            // 8. jump 跳/桂马
            if(score<800 && ev.myLibs>=2) {
                let js=0;
                for(const [dx,dy] of [[2,0],[-2,0],[0,2],[0,-2],[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]]) {
                    const nx=x+dx, ny=y+dy;
                    if(inB(nx,ny)&&board[nx][ny]===me) js+=(Math.abs(dx)===2&&Math.abs(dy)===2)?7:5;
                }
                if(js>0) { score=700+js; src='j'; }
            }
            // 9. growth 扩张
            if(score<600 && ev.myLibs>=3) {
                let conn=0;
                for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                    const nx=x+dx, ny=y+dy;
                    if(inB(nx,ny)&&board[nx][ny]===me) conn++;
                }
                score=500+ev.myLibs*10+conn*20; src='g';
            }
            // 10. expansion 拆边
            if(score<400 && ev.myLibs>=2) {
                let dw=Math.min(x,y,S-1-x,S-1-y);
                for(let dx=-2;dx<=2;dx++) for(let dy=-2;dy<=2;dy++) {
                    const nx=x+dx, ny=y+dy;
                    if(inB(nx,ny)&&board[nx][ny]==='#') dw=Math.min(dw,Math.abs(dx)+Math.abs(dy));
                }
                if(dw>=2) {
                    let open=0;
                    for(let dx=-2;dx<=2;dx++) for(let dy=-2;dy<=2;dy++) {
                        if(dx===0&&dy===0) continue;
                        const nx=x+dx, ny=y+dy;
                        if(inB(nx,ny)&&board[nx][ny]==='.') open++;
                    }
                    score=300+open+(dw===2?10:dw===3?6:0); src='x';
                }
            }
            // 11. fallback 随便走走
            if(score<1 && ev.myLibs>=1) { score=1; src='f'; }

            if(score>0) scored.push({x,y,score,src});
        }

        scored.sort((a,b)=>b.score-a.score);
        return scored.length>0?scored[0]:null;
    }

    // ── 主循环 ──
    await start();
    async function start() {
        const cfg=getConfiguration(ns,A); if(!cfg||(await instanceCount(ns))>1) return;
        l=cfg.logtime; ro=cfg.runOnce; c=cfg.cheats&&!cfg['disable-cheats']; cct=cfg['cheat-chance-threshold'];
        ns.disableLog("go.makeMove"); ns.disableLog("go.passTurn"); ns.disableLog("sleep");
        while(true) {
            tn=0; const opp=ns.go.getOpponent(); ns.print(`INFO: vs ${opp}`);
            const st=performance.now();
            while(true) {
                if(ns.go.getGameState().currentPlayer==='None'){await end(ns,opp,st);break;}
                tn++; const board=ns.go.getBoardState(); const moves=vm(ns);
                if(c&&tn%5===0){try{const cc=ns.go.cheat.getCheatSuccessChance();
                    if(cc>cct){if(ns.go.cheat.getCheatCount()>0&&sc(board)-ko(opp)<-5){ns.go.cheat.removeRouter();continue;}
                    if(cc>0.95){ns.go.cheat.playTwoMoves();continue;}}}catch(e){}}
                const mv=getBestMove(board,moves);
                let r;
                if(mv){if(l)ns.print(`[${tn}] (${mv.x},${mv.y}) ${mv.src}`);r=await ns.go.makeMove(mv.x,mv.y);}
                else{if(l)ns.print(`[${tn}] pass`);try{r=await ns.go.passTurn();}catch{await end(ns,opp,st);break;}}
                if(r&&r.type==="gameOver"){await end(ns,opp,st);break;}
            }
        }
    }
    async function end(ns,opp,st){
        tg++;const s=sc(ns.go.getBoardState())-ko(opp);const w=s>0;if(w)tw++;
        ns.tprint(`[${tg}] ${opp} ${w?'✅':'❌'} ${s.toFixed(1)}目 ${((performance.now()-st)/1000).toFixed(1)}s 胜率:${(tw/tg*100).toFixed(0)}%`);
        if(ro)ns.exit();
        try{ns.go.resetBoardState(OP2[Math.floor(Math.random()*OP2.length)],13);}catch{ns.go.resetBoardState(OP[Math.floor(Math.random()*OP.length)],13);}
    }
}
