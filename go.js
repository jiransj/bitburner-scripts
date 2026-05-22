/**Author:
 * Discord:
 * - Sphyxis
 *
 * Additional Contributers:
 * Discord:
 * - Stoneware
 * - gmcew
 * - eithel
 * - Insight (alainbryden)
 */

import {
    getConfiguration, instanceCount, log, getErrorInfo, getActiveSourceFiles, getNsDataThroughFile, formatTime
} from './helpers.js'

const argsSchema = [
    ['cheats', true], // (Now true by default - but still an option for backwards compatibility) This is only possible if you have BN14.2
    ['disable-cheats', false], // Set to true if you want to *not* use cheats for some reason.
    ['cheat-chance-threshold', 0.9], // Don't cheat if our success chance is less than this
    ['logtime', false], // Logs time time it takes for each player to take their move
    ['runOnce', false], // Will only play one game if enabled
    ['silent', false], // (Obsolete) This script used to automatically tail. Now if you want to do this, call with --tail like normal.
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** Main script entrypoint.
 * Note that to protect against "shared global memory", the entire script is wrapped in the body of the main function.
 * @param {NS} ns */
export async function main(ns) {
    let cheats = false;
    let cheatChanceThreshold = 1.0;
    let logtime = false;
    let runOnce = true;
    let silent = false;
    let currentValidMovesTurn = 0; //The turn count that the currentValidMoves is valid for
    let turn = 0;
    let START = performance.now();
    // Global variables initialized in this way get strong typing throughout
    let board = (/**@returns{string[]}*/() => undefined)(); // The current board state
    let currentValidMoves = (/**@returns{number[][]}*/() => undefined)(); //All valid moves for this turn
    let currentValidContestedMoves = (/**@returns{number[][]}*/() => undefined)(); //All valid moves that occupy a contested space
    let contested = (/**@returns{string[]}*/() => undefined)();
    let validMove = (/**@returns{boolean[][]}*/() => undefined)();
    let validLibMoves = (/**@returns{number[][]}*/() => undefined)();
    let chains = (/**@returns{number[][]}*/() => undefined)();
    let testBoard = (/**@returns{string[]}*/() => [])();

    //X,O = Me, You  x, o = Anything but the other person or a blocking, "W" space is off the board, ? is anything goes
    //B is blocking(Wall or you, not empty or enemy), b is blocking but could be enemy, A is All but . (Wall, Me, You, Blank)
    //* is move here next if you can - no safeties

    const disrupt4 = [
        ["??b?", "?b.b", "b.*b", "?bb?"], //Pattern# Sphyxis - buy a turn #GREAT
        ["?bb?", "b..b", "b*Xb", "?bb?"], //Pattern# Sphyxis - buy a turn #GREAT
        ["?bb?", "b..b", "b.*b", "?bb?"], //Pattern# Sphyxis - buy a turn #GREAT
        ["??b?", "?b.b", "?b*b", "??O?"], //Pattern# Sphyxis - Sacrifice to kill an eye
        ["?bbb", "bb.b", "W.*b", "?oO?"], //Pattern# Sphyxis - 2x2 nook breatk
        ["?bbb", "bb.b", "W.*b", "?Oo?"], //Pattern# Sphyxis - 2x2 nook break
        [".bbb", "o*.b", ".bbb", "????"], //Pattern# Sphyxis - Dangling 2 break
    ];
    const disrupt5 = [
        ["?bbb?", "b.*.b", "?bbb?", "?????", "?????"], //Pattern# Sphyxis - Convert to 1 eye
        ["??OO?", "?b*.b", "?b..b", "??bb?", "?????"], //Pattern# Sphyxis - Buy time
        ["?????", "??bb?", "?b*Xb", "?boob", "??bb?"], //Pattern# Sphyxis - Buy time
        ["WWW??", "WWob?", "Wo*b?", "WWW??", "?????"], //Pattern# Sphyxis - 2x2 attack corner if possible
        ["??b??", "?b.b?", "?b*b?", "?b.A?", "??b??"], //Pattern# Sphyxis - Break two eyes into 1, buy a turn
        ["??b??", "?b.b?", "??*.b", "?b?b?", "?????"], //Pattern# Sphyxis - Break eyes, buy time
        ["?WWW?", "WoOoW", "WOO*W", "W???W", "?????"], //Block 3x3 corner
        ["?WWW?", "Wo*oW", "WOOOW", "W???W", "?????"], //Block 3x3 corner
    ];
    const def5 = [
        ["?WW??", "WW.X?", "W.XX?", "WWW??", "?????"], //Pattern# Sphyxis - Eyes in a nook
        ["WWW??", "WW.X?", "W.*X?", "WWW??", "?????"], //Pattern# Sphyxis - 2x2 corner contain #GREAT
        ["BBB??", "BB.X?", "B..X?", "BBB??", "?????"], //Pattern# Sphyxis - 2x2 corner contain #GREAT
        ["?WWW?", "W.*.W", "WXXXW", "?????", "?????"], //Take the 3x3 back corner
    ];

    // Testing
    //const opponent = ["Slum Snakes", "Tetrads", "Daedalus", "Illuminati"]
    //const opponent2 = ["????????????"]
    // Original
    const opponent = ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati"];
    const opponent2 = ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati", "????????????"];

    await start();

    /** @param {NS} ns */
    async function start() {
        const runOptions = getConfiguration(ns, argsSchema);
        if (!runOptions || (await instanceCount(ns)) > 1) return; // Prevent multiple instances of this script from being started, even with different args.

        logtime = runOptions.logtime;
        runOnce = runOptions.runOnce;

        const sourceFiles = await getActiveSourceFiles(ns, true);
        // Enable cheats if we have SF14.2 or higher (unless the user disabled cheats).
        cheats = !runOptions['disable-cheats'] && (sourceFiles[14] ?? 0) >= 2;
        cheatChanceThreshold = runOptions['cheat-chance-threshold'];

        ns.disableLog("go.makeMove")

        let ranToCompletion = false;
        while (!ranToCompletion) {
            try {
                await playGo(ns);
                ranToCompletion = true;
            }
            catch (err) {
                log(ns, `WARNING: go.js Caught (and suppressed) an unexpected error:\n${getErrorInfo(err)}`, false, 'warning');
                log(ns, `INFO: Will sleep for 10 seconds than try playing again.`, false);
                await ns.sleep(10 * 1000);
            }
        }
    }

    // Ram-dodging helpers (Allows the script to only require as much RAM as its most expensive function)
    /** @param {NS} ns @returns {Promise<string[]>} */
    async function go_getBoardState(ns) {
        return await getNsDataThroughFile(ns, `ns.go.getBoardState()`);
    }
    /** @param {NS} ns @returns {Promise<string[]>} */
    async function go_analysis_getControlledEmptyNodes(ns) {
        return await getNsDataThroughFile(ns, `ns.go.analysis.getControlledEmptyNodes()`);
    }
    /** @param {NS} ns @returns {Promise<boolean[][]>} */
    async function go_analysis_getValidMoves(ns) {
        return await getNsDataThroughFile(ns, `ns.go.analysis.getValidMoves()`);
    }
    /** @param {NS} ns @returns {Promise<number[][]>} */
    async function go_analysis_getLiberties(ns) {
        return await getNsDataThroughFile(ns, `ns.go.analysis.getLiberties()`);
    }
    /** @param {NS} ns @returns {Promise<number[][]>} */
    async function go_analysis_getChains(ns) {
        return await getNsDataThroughFile(ns, `ns.go.analysis.getChains()`);
    }
    /** @param {NS} ns @returns {Promise<number>} */
    async function go_cheat_getCheatSuccessChance(ns) {
        return await getNsDataThroughFile(ns, `ns.go.cheat.getCheatSuccessChance()`);
    }
    /** @param {NS} ns @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
     * @returns {Promise<{type: "move" | "pass" | "gameOver";x: number;y: number;}>} */
    async function go_cheat_playTwoMoves(ns, x1, y1, x2, y2) {
        return await getNsDataThroughFile(ns, `await ns.go.cheat.playTwoMoves(...ns.args)`, null, [x1, y1, x2, y2]);
    }
    /** @param {NS} ns @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
     * @returns {Promise<{type: "move" | "pass" | "gameOver";x: number;y: number;}>} */
    async function go_makeMove(ns, x, y) {
        return await ns.go.makeMove(x, y);
        // Note to self - I decided against ram-dodging this request because the "await" actually blocks for a long time.
        // This program spends 99% of its time waiting for makeMove to complete (which is time-throttled by the game)
        // As such, this script permantly eats 4GB of the "temporary memory reserve" left by Daemon, which
        // throws off other scripts which need to "burst" RAM utilization for only an instant.
        // Better to just consume this 4GB predictably as part of this script.
        //return await getNsDataThroughFile(ns, `await ns.go.makeMove(...ns.args)`, null, [x, y]);
    }

    /** @param {NS} ns */
    async function playGo(ns) {
        const startBoard = await go_getBoardState(ns)
        let inProgress = false
        turn = 0
        START = performance.now()
        //If we have already moved, jump the turn to 3 to get out of Opening Moves
        for (let x = 0; x < startBoard[0].length; x++) {
            for (let y = 0; y < startBoard[0].length; y++) {
                if (startBoard[x][y] === "X") {
                    inProgress = true
                    turn = 3
                    break
                }
            }
            if (inProgress) break
        }
        const currentGame = await ns.go.opponentNextTurn(false)
        checkNewGame(ns, currentGame)
        const playStyle = getStyle(ns);
        while (true) {
            turn++
            board = await go_getBoardState(ns);
            contested = await go_analysis_getControlledEmptyNodes(ns);
            validMove = await go_analysis_getValidMoves(ns);
            validLibMoves = await go_analysis_getLiberties(ns);
            chains = await go_analysis_getChains(ns);
            const size = board[0].length
            //Build a test board with walls
            let testWall = "W".repeat(size + 2);
            testBoard = [];
            testBoard.push(testWall);
            for (const b of board)
                testBoard.push("W" + b + "W");
            testBoard.push(testWall);
            //We have our test board

            let results;
            if (turn < 3)
                results = await movePiece(ns, getOpeningMove(ns))

            if (turn >= 3) {
                switch (playStyle) {
                    case 0:  //Netburners
                        if (results = await movePiece(ns, getCaptureMove())) break
                        if (results = await movePiece(ns, getKillOrReduce())) break
                        if (results = await movePiece(ns, getDoubleAtari())) break
                        if (results = await movePiece(ns, getRandomCounterLib())) break
                        if (results = await movePiece(ns, getRandomLibAttack(88))) break
                        if (results = await movePiece(ns, getRandomLibDefend())) break
                        if (results = await moveSnakeEyes(ns, getSnakeEyes(6))) break
                        if (results = await movePiece(ns, getAggroAttack(2, 2, 2))) break
                        if (results = await movePiece(ns, disruptEyes())) break
                        if (results = await movePiece(ns, getCreateEyeMove())) break
                        if (results = await movePiece(ns, getLiveGroupAttack())) break
                        if (results = await movePiece(ns, getBlockEyeMove())) break
                        if (results = await movePiece(ns, getDefPattern())) break
                        if (results = await movePiece(ns, getAggroAttack(3, 3, 3, 1, 6))) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1))) break
                        if (results = await movePiece(ns, getAggroAttack(4, 7, 3, 1, 6))) break
                        if (results = await movePiece(ns, attackGrowDragon(1))) break
                        if (results = await movePiece(ns, getDefAttack(8, 20, 2))) break
                        if (results = await movePiece(ns, getRandomExpand())) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1, false, 1))) break
                        if (results = await movePiece(ns, getRandomLibAttack())) break
                        if (results = await movePiece(ns, getRandomStrat())) break
                        ns.print("Turn Passed")
                        results = await ns.go.passTurn()
                        break
                    case 1:  //The Black Hand
                        if (results = await movePiece(ns, getCaptureMove())) break
                        if (results = await movePiece(ns, getKillOrReduce())) break
                        if (results = await movePiece(ns, getDoubleAtari())) break
                        if (results = await movePiece(ns, getRandomCounterLib())) break
                        if (results = await movePiece(ns, getRandomLibAttack(88))) break
                        if (results = await movePiece(ns, getRandomLibDefend())) break
                        if (results = await moveSnakeEyes(ns, getSnakeEyes(6))) break
                        if (results = await movePiece(ns, getAggroAttack(2, 2, 2))) break
                        if (results = await movePiece(ns, disruptEyes())) break
                        if (results = await movePiece(ns, getCreateEyeMove())) break
                        if (results = await movePiece(ns, getLiveGroupAttack())) break
                        if (results = await movePiece(ns, getBlockEyeMove())) break
                        if (results = await movePiece(ns, getDefPattern())) break
                        if (results = await movePiece(ns, getAggroAttack(3, 3, 3, 1, 6))) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1))) break
                        if (results = await movePiece(ns, getAggroAttack(4, 7, 3, 1, 6))) break
                        if (results = await movePiece(ns, attackGrowDragon(1))) break
                        if (results = await movePiece(ns, getRandomExpand())) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1, false, 1))) break
                        if (results = await movePiece(ns, getRandomLibAttack())) break
                        if (results = await movePiece(ns, getRandomStrat())) break
                        ns.print("Turn Passed")
                        results = await ns.go.passTurn()
                        break
                    case 2: //Mr. Mustacio - Slum Snakes
                        if (results = await movePiece(ns, getCaptureMove())) break
                        if (results = await movePiece(ns, getKillOrReduce())) break
                        if (results = await movePiece(ns, getDoubleAtari())) break
                        if (results = await movePiece(ns, getRandomCounterLib())) break
                        if (results = await movePiece(ns, getRandomLibAttack(88))) break
                        if (results = await movePiece(ns, getRandomLibDefend())) break
                        if (results = await moveSnakeEyes(ns, getSnakeEyes(6))) break
                        if (results = await movePiece(ns, getAggroAttack(2, 2, 2))) break
                        if (results = await movePiece(ns, disruptEyes())) break
                        if (results = await movePiece(ns, getCreateEyeMove())) break
                        if (results = await movePiece(ns, getLiveGroupAttack())) break
                        if (results = await movePiece(ns, getBlockEyeMove())) break
                        if (results = await movePiece(ns, getDefPattern())) break
                        if (results = await movePiece(ns, getAggroAttack(3, 3, 3, 1, 6))) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1))) break
                        if (results = await movePiece(ns, getDefAttack(4, 7, 3, 1, 6))) break
                        if (results = await movePiece(ns, attackGrowDragon(1))) break
                        if (results = await movePiece(ns, getRandomExpand())) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1, false, 1))) break
                        if (results = await movePiece(ns, getRandomLibAttack())) break
                        if (results = await movePiece(ns, getRandomStrat())) break
                        ns.print("Turn Passed")
                        results = await ns.go.passTurn()
                        break
                    case 3: //Daedalus
                        if (results = await movePiece(ns, getCaptureMove())) break
                        if (results = await movePiece(ns, getKillOrReduce())) break
                        if (results = await movePiece(ns, getDoubleAtari())) break
                        if (results = await movePiece(ns, getRandomCounterLib())) break
                        if (results = await movePiece(ns, getRandomLibAttack(88))) break
                        if (results = await movePiece(ns, getRandomLibDefend())) break
                        if (results = await moveSnakeEyes(ns, getSnakeEyes(6))) break
                        if (results = await movePiece(ns, getAggroAttack(2, 2, 2))) break
                        if (results = await movePiece(ns, disruptEyes())) break
                        if (results = await movePiece(ns, getCreateEyeMove())) break
                        if (results = await movePiece(ns, getLiveGroupAttack())) break
                        if (results = await movePiece(ns, getBlockEyeMove())) break
                        if (results = await movePiece(ns, getDefPattern())) break
                        if (results = await movePiece(ns, getAggroAttack(3, 4, 3, 1, 6))) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1))) break
                        if (results = await movePiece(ns, getDefAttack(5, 7, 3, 2, 6))) break
                        if (results = await movePiece(ns, attackGrowDragon(1))) break
                        if (results = await movePiece(ns, getRandomExpand())) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1, false, 1))) break
                        if (results = await movePiece(ns, getRandomLibAttack())) break
                        if (results = await movePiece(ns, getRandomStrat())) break
                        ns.print("Turn Passed")
                        results = await ns.go.passTurn()
                        break
                    case 4: //Tetrads
                        if (results = await movePiece(ns, getCaptureMove())) break
                        if (results = await movePiece(ns, getKillOrReduce())) break
                        if (results = await movePiece(ns, getDoubleAtari())) break
                        if (results = await movePiece(ns, getRandomCounterLib())) break
                        if (results = await movePiece(ns, getRandomLibAttack(88))) break
                        if (results = await movePiece(ns, getRandomLibDefend())) break
                        if (results = await moveSnakeEyes(ns, getSnakeEyes(6))) break
                        if (results = await movePiece(ns, getAggroAttack(2, 2, 2))) break
                        if (results = await movePiece(ns, disruptEyes())) break
                        if (results = await movePiece(ns, getCreateEyeMove())) break
                        if (results = await movePiece(ns, getLiveGroupAttack())) break
                        if (results = await movePiece(ns, getBlockEyeMove())) break
                        if (results = await movePiece(ns, getDefPattern())) break
                        if (results = await movePiece(ns, getAggroAttack(3, 4, 3))) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1))) break
                        if (results = await movePiece(ns, getAggroAttack(5, 7, 3))) break
                        if (results = await movePiece(ns, attackGrowDragon(1))) break
                        if (results = await movePiece(ns, getRandomExpand())) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1, false))) break
                        if (results = await movePiece(ns, getRandomLibAttack())) break
                        if (results = await movePiece(ns, getRandomStrat(),)) break
                        ns.print("Turn Passed")
                        results = await ns.go.passTurn()
                        break
                    case 5: //Illum
                        if (results = await movePiece(ns, getCaptureMove())) break
                        if (results = await movePiece(ns, getKillOrReduce())) break
                        if (results = await movePiece(ns, getDoubleAtari())) break
                        if (results = await movePiece(ns, getRandomCounterLib())) break
                        if (results = await movePiece(ns, getRandomLibAttack(88))) break
                        if (results = await movePiece(ns, getRandomLibDefend())) break
                        if (results = await moveSnakeEyes(ns, getSnakeEyes(6))) break
                        if (results = await movePiece(ns, getAggroAttack(2, 2, 2))) break
                        if (results = await movePiece(ns, disruptEyes())) break
                        if (results = await movePiece(ns, getCreateEyeMove())) break
                        if (results = await movePiece(ns, getLiveGroupAttack())) break
                        if (results = await movePiece(ns, getBlockEyeMove())) break
                        if (results = await movePiece(ns, getDefPattern())) break
                        if (results = await movePiece(ns, getAggroAttack(3, 4, 3))) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1))) break
                        if (results = await movePiece(ns, attackGrowDragon(1))) break
                        if (results = await movePiece(ns, getRandomExpand())) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1, false))) break
                        if (results = await movePiece(ns, getRandomLibAttack())) break
                        if (results = await movePiece(ns, getRandomStrat())) break
                        ns.print("Turn Passed")
                        results = await ns.go.passTurn()
                        break
                    case 6: //??????
                        if (results = await movePiece(ns, getCaptureMove())) break
                        if (results = await movePiece(ns, getKillOrReduce())) break
                        if (results = await movePiece(ns, getDoubleAtari())) break
                        if (results = await movePiece(ns, getRandomCounterLib())) break
                        if (results = await movePiece(ns, getRandomLibAttack(88))) break
                        if (results = await movePiece(ns, getRandomLibDefend())) break
                        if (results = await moveSnakeEyes(ns, getSnakeEyes(6))) break
                        if (results = await movePiece(ns, getAggroAttack(2, 2, 2))) break
                        if (results = await movePiece(ns, disruptEyes())) break
                        if (results = await movePiece(ns, getCreateEyeMove())) break
                        if (results = await movePiece(ns, getLiveGroupAttack())) break
                        if (results = await movePiece(ns, getBlockEyeMove())) break
                        if (results = await movePiece(ns, getDefPattern())) break
                        if (results = await movePiece(ns, getAggroAttack(3, 4, 3))) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1))) break
                        if (results = await movePiece(ns, getDefAttack(5, 7, 3))) break
                        if (results = await movePiece(ns, attackGrowDragon(1))) break
                        if (results = await movePiece(ns, getRandomExpand())) break
                        if (results = await movePiece(ns, getRandomBolster(2, 1, false))) break
                        if (results = await movePiece(ns, getRandomLibAttack())) break
                        if (results = await movePiece(ns, getRandomStrat())) break
                        ns.print("Turn Passed")
                        results = await ns.go.passTurn()
                        break
                } //End of style switch
            } // end of turn >= 3
            checkNewGame(ns, results)
        }
    }

    /** @param {NS} ns */
    function getStyle(ns) {
        switch (ns.go.getOpponent()) {
            case "Netburners": return 0;
            case "The Black Hand": return 1;
            case "Slum Snakes": return 2;
            case "Daedalus": return 3;
            case "Tetrads": return 4;
            case "Illuminati": return 5;
            default: return 6;
        }
    }

    /** @param {NS} ns
     * @param {{ type:"move"|"pass"|"gameOver"; x:number; y:number;}} gameInfo
     */
    function checkNewGame(ns, gameInfo) {
        if (gameInfo.type === "gameOver") {
            if (runOnce) ns.exit()
            try { ns.go.resetBoardState(opponent2[Math.floor(Math.random() * opponent2.length)], 13) }
            catch { ns.go.resetBoardState(opponent[Math.floor(Math.random() * opponent.length)], 13) }
            turn = 0
            ns.clearLog()
        }
    }
    /** @param {NS} ns
     * @param {number} x
     * @param {number} y
     * @param {string[]} pattern
     * @returns {boolean}
     */
    function isPattern(x, y, pattern) {
        //Move the pattern around with x/y loops, check if pattern matches IF a move is placed
        //We can assume that x and y are valid moves

        const size = testBoard[0].length
        const patterns = getAllPatterns(pattern)
        const patternSize = pattern.length

        for (const patternCheck of patterns) {
            //cx and cy - the spots of the pattern we are checking against the test board
            //For, say a 3x3 pattern, we do a grid of 0,0 -> 2, 2
            for (let cx = ((patternSize - 1) * -1); cx <= 0; cx++) { // We've added a wall around everything, so 0 is a wall
                if (cx + x + 1 < 0 || cx + x + 1 > size - 1) continue
                for (let cy = ((patternSize - 1) * -1); cy <= 0 - 1; cy++) {
                    //We now have a cycle that will check each section of the grid against the pattern
                    //Safety checks: We know 0,0 is safe, we were sent it, but each other section could be bad
                    if (cy + y + 1 < 0 || cy + y + 1 > size - 1) continue
                    let count = 0
                    let abort = false
                    for (let px = 0; px < patternSize && !abort; px++) {
                        if (x + cx + px + 1 < 0 || x + cx + px + 1 >= size) {  //Don't go off grid
                            abort = true
                            break
                        }
                        for (let py = 0; py < patternSize && !abort; py++) {
                            if (y + cy + py + 1 < 0 || y + cy + py + 1 >= size) { //Are we off the map?
                                abort = true
                                break
                            }
                            if (cx + px === 0 && cy + py === 0 && !["X", "*"].includes(patternCheck[px][py])) {
                                abort = true
                                break
                            }
                            if (cx + px === 0 && cy + py === 0 && ["X"].includes(contested[x][y]) && patternCheck[px][py] !== "*") {
                                abort = true
                                break
                            }
                            //We now have a cycles for each spot in the pattern
                            //0,0 -> 2,2 for a 3x3
                            switch (patternCheck[px][py]) {
                                case "X":
                                    if (testBoard[cx + x + 1 + px][cy + y + 1 + py] === "X" || (cx + px === 0 && cy + py === 0 && testBoard[cx + x + 1 + px][cy + y + 1 + py] === ".")) {
                                        count++
                                    }
                                    else if (cx + px === 0 && cy + py === 0) {
                                        count++ // Our placement piece
                                    }
                                    else abort = true
                                    break
                                case "*": // Special case.  We move here next or break the test
                                    if (testBoard[cx + x + 1 + px][cy + y + 1 + py] === "." && cx + px === 0 && cy + py === 0) {
                                        count++
                                    }
                                    else abort = true
                                    break
                                case "O":
                                    if (testBoard[cx + x + 1 + px][cy + y + 1 + py] === "O")
                                        count++
                                    else abort = true
                                    break
                                case "x":
                                    if (["X", "."].includes(testBoard[cx + x + 1 + px][cy + y + 1 + py]))
                                        count++
                                    else abort = true
                                    break
                                case "o":
                                    if (["O", "."].includes(testBoard[cx + x + 1 + px][cy + y + 1 + py]))
                                        count++
                                    else abort = true
                                    break
                                case "?":
                                    count++
                                    break
                                case ".":
                                    if (testBoard[cx + x + 1 + px][cy + y + 1 + py] === ".")
                                        count++
                                    else abort = true
                                    break
                                case "W":
                                    if (["W", "#"].includes(testBoard[cx + x + 1 + px][cy + y + 1 + py]))
                                        count++
                                    else abort = true
                                    break
                                case "B":
                                    if (["W", "#", "X"].includes(testBoard[cx + x + 1 + px][cy + y + 1 + py]))
                                        count++
                                    else abort = true
                                    break
                                case "b":
                                    if (["W", "#", "O"].includes(testBoard[cx + x + 1 + px][cy + y + 1 + py]))
                                        count++
                                    else abort = true
                                    break
                                case "A":
                                    if (["W", "#", "X", "O"].includes(testBoard[cx + x + 1 + px][cy + y + 1 + py]))
                                        count++
                                    else abort = true
                                    break
                            }
                            if (count === patternSize * patternSize) return true
                        }
                    }
                }
            }
        }
        return false
    }
    /** @param {NS} ns
     * @param {string[]} pattern
     * @returns {string[][]} */
    function getAllPatterns(pattern) {
        const rotations = [
            pattern,
            rotate90Degrees(pattern),
            rotate90Degrees(rotate90Degrees(pattern)),
            rotate90Degrees(rotate90Degrees(rotate90Degrees(pattern))),
        ]
        return [...rotations, ...rotations.map(verticalMirror)]
    }

    //Special thanks to @gmcew for the next 2 functions!
    /** @param {NS} ns
     * @param {string[]} pattern
     * @returns {string[]} */
    function rotate90Degrees(pattern) {
        return pattern.map((val, index) => pattern.map(row => row[index]).reverse().join(""))
    }
    /** @param {NS} ns
     * @param {string[]} pattern
     * @returns {string[]} */
    function verticalMirror(pattern) {
        return pattern.toReversed();
    }

    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getSnakeEyes(minKilled = 5) {
        if (!cheats) return []
        const moveOptions = []
        const size = board[0].length
        let highValue = 1

        const checked = new Set

        for (let x = 0; x < size - 1; x++)
            for (let y = 0; y < size - 1; y++) {
                if (contested[x][y] === "X" || board[x][y] !== "O" || validLibMoves[x][y] !== 2 || checked.has(JSON.stringify([x, y]))) continue
                //Is it the enemy, with 2 libs (we can kill) and we have not checked this spot and the chain is large enough
                const chain = getChainValue(x, y, "O")
                if (chain < minKilled) continue
                //We have a winner!  Check all it's spots and find the 2 killing blows.  Add the checked spots to the checked list so we don't recheck
                checked.add(JSON.stringify([x, y]))
                const enemySearch = new Set
                const move1 = []
                const move2 = []
                enemySearch.add(JSON.stringify([x, y]))
                for (const explore of enemySearch) {
                    const [fx, fy] = JSON.parse(explore)
                    //Find your eyes
                    if (board[fx][fy] === ".") {
                        move1.length ? move2.push([fx, fy]) : move1.push([fx, fy])
                        checked.add(JSON.stringify([fx, fy]))
                        continue
                    }

                    //Find more of yourself to search...
                    if (fx < size - 1 && ["O", "."].includes(board[fx + 1][fy])) {
                        enemySearch.add(JSON.stringify([fx + 1, fy]))
                        checked.add(JSON.stringify([fx, fy]))
                    }
                    if (fx > 0 && ["O", "."].includes(board[fx - 1][fy])) {
                        enemySearch.add(JSON.stringify([fx - 1, fy]))
                        checked.add(JSON.stringify([fx, fy]))
                    }
                    if (fy > 0 && ["O", "."].includes(board[fx][fy - 1])) {
                        enemySearch.add(JSON.stringify([fx, fy - 1]))
                        checked.add(JSON.stringify([fx, fy]))
                    }
                    if (fy < size - 1 && ["O", "."].includes(board[fx][fy + 1])) {
                        enemySearch.add(JSON.stringify([fx, fy + 1]))
                        checked.add(JSON.stringify([fx, fy]))
                    }
                } // End of searching the enemy

                if (chain > highValue) {
                    highValue = chain
                    moveOptions.length = 0
                    const mv1 = move1.pop()
                    const mv2 = move2.pop()
                    moveOptions.push([mv1[0], mv1[1], mv2[0], mv2[1]])
                }
                else if (chain === highValue) {
                    const mv1 = move1.pop()
                    const mv2 = move2.pop()
                    moveOptions.push([mv1[0], mv1[1], mv2[0], mv2[1]])
                }
            } // Search whole board

        // Choose one of the found moves at random
        const randomIndex = Math.floor(Math.random() * moveOptions.length)
        return moveOptions[randomIndex] ? {
            coords: moveOptions[randomIndex],
            msg: "SnakeEyes Cheat"
        } : []
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getCaptureMove() {
        //最高优先级：吃掉对方3子以上的棋链
        //围棋中"吃棋"是最直接的收益，大龙必须立刻提
        const size = board[0].length;
        const moves = getAllValidMoves(true);
        for (const [x, y] of moves) {
            if (contested[x][y] === "X" || validLibMoves[x][y] !== -1) continue

            let bestCaptureSize = 0;
            //检查四个方向：是否有1气的对方棋链
            const checks = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
            for (const [nx, ny] of checks) {
                if (nx >= 0 && nx < size && ny >= 0 && ny < size &&
                    board[nx][ny] === 'O' && validLibMoves[nx][ny] === 1) {
                    const chainVal = getChainValue(nx, ny, 'O');
                    if (chainVal > bestCaptureSize) bestCaptureSize = chainVal;
                }
            }

            //能吃3子以上，立刻吃！
            if (bestCaptureSize >= 3) {
                return { coords: [x, y], msg: 'Capture: ' + bestCaptureSize };
            }
        }
        return [];
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getKillOrReduce() {
        //判断对方棋块死活，采取不同策略：
        //  ① 做不出两只眼 → 杀！紧气包围
        //  ② 已经做出两只眼 → 不浪费子力去杀，限制其圈地
        const moveOptions = [];
        const size = board[0].length;
        let highScore = 0;
        let killMode = false; //在外面声明，供return使用
        const moves = getAllValidMoves(true);
        for (const [x, y] of moves) {
            if (!['?', 'O'].includes(contested[x][y]) || createsLib(x, y, 'X')) continue

            let oppEyesNearby = 0;
            let oppChainSize = 0;
            const checks = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
            for (const [nx, ny] of checks) {
                if (nx >= 0 && nx < size && ny >= 0 && ny < size && board[nx][ny] === 'O') {
                    oppChainSize += getChainValue(nx, ny, 'O');
                    oppEyesNearby += getEyeValue(nx, ny, 'O');
                }
            }
            if (oppChainSize === 0) continue;

            let score;
            if (oppEyesNearby < 2) {
                //做不出两只眼→可以杀！紧气包围，优先杀大棋
                score = oppChainSize * oppChainSize * 10;
                if (score > highScore) killMode = true;
            } else {
                //已经活了两只眼→不浪费子力，限制圈地
                score = 1;
            }

            if (score > highScore) {
                highScore = score;
                moveOptions.length = 0;
                moveOptions.push([x, y]);
            } else if (score === highScore) {
                moveOptions.push([x, y]);
            }
        }
        const idx = Math.floor(Math.random() * moveOptions.length);
        const label = killMode ? 'Kill' : 'Reduce';
        return moveOptions[idx] ? { coords: moveOptions[idx], msg: label + ': ' + highScore } : [];
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getDoubleAtari() {
        //双打吃：一手棋同时让两块对方棋链被打吃（变1气）
        //对方只能救一块，另一块必死——这是围棋中最强的战术之一
        const moveOptions = [];
        const size = board[0].length;
        let highScore = 0;
        const moves = getAllValidMoves(true);
        for (const [x, y] of moves) {
            if (!['?', 'O'].includes(contested[x][y]) || createsLib(x, y, 'X')) continue

            //统计四周的对方棋链
            const threatenedChains = []; //{chainId, size, libs}
            const seenChains = new Set();
            const checks = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
            for (const [nx, ny] of checks) {
                if (nx >= 0 && nx < size && ny >= 0 && ny < size && board[nx][ny] === 'O') {
                    const chainId = chains[nx][ny];
                    if (!seenChains.has(chainId)) {
                        seenChains.add(chainId);
                        const cSize = getChainValue(nx, ny, 'O');
                        //落子后这口气被占，对方气数-1
                        const newLibs = validLibMoves[nx][ny] - 1;
                        threatenedChains.push({ size: cSize, newLibs });
                    }
                }
            }

            //双打吃核心条件：同时威胁至少2条对方棋链
            //并且其中至少2条在落子后会变成<=1气（被打吃或提掉）
            if (threatenedChains.length >= 2) {
                const atariCount = threatenedChains.filter(c => c.newLibs <= 1).length;
                if (atariCount >= 2) {
                    //评分：威胁的棋链越多越大越好
                    const totalSize = threatenedChains.reduce((s, c) => s + c.size, 0);
                    const score = atariCount * totalSize * totalSize;
                    if (score > highScore) {
                        highScore = score;
                        moveOptions.length = 0;
                        moveOptions.push([x, y]);
                    } else if (score === highScore) {
                        moveOptions.push([x, y]);
                    }
                }
            }
        }
        const idx = Math.floor(Math.random() * moveOptions.length);
        return moveOptions[idx] ? { coords: moveOptions[idx], msg: 'Double Atari: ' + highScore } : [];
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getRandomLibAttack(minKilled = 1) {
        const moveOptions = []
        const size = board[0].length
        let highValue = 1
        // Look through all the points on the board
        const moves = getAllValidMoves(true)
        for (const [x, y] of moves) {
            if (contested[x][y] === "X" || validLibMoves[x][y] !== -1) continue

            let count = 0
            let chains = 0

            //We are only checking up, down, left and right
            if (x > 0 && board[x - 1][y] === "O" && validLibMoves[x - 1][y] === 1) {
                count++
                chains += getChainValue(x - 1, y, "O")
            }
            if (x < size - 1 && board[x + 1][y] === "O" && validLibMoves[x + 1][y] === 1) {
                count++
                chains += getChainValue(x + 1, y, "O")
            }
            if (y > 0 && board[x][y - 1] === "O" && validLibMoves[x][y - 1] === 1) {
                count++
                chains += getChainValue(x, y - 1, "O")
            }
            if (y < size - 1 && board[x][y + 1] === "O" && validLibMoves[x][y + 1] === 1) {
                count++
                chains += getChainValue(x, y + 1, "O")
            }
            const enemyLibs = getSurroundLibs(x, y, "O")
            if (count === 0 || (chains < minKilled && enemyLibs <= 1)) continue

            //平方权重：优先吃大棋！10子棋链得分100，2子棋链得分4，差距25倍
            const result = count * chains * chains
            if (result > highValue) {
                moveOptions.length = 0
                moveOptions.push([x, y])
                highValue = result
            }
            else if (result === highValue) moveOptions.push([x, y]);
        }
        // Choose one of the found moves at random
        const randomIndex = Math.floor(Math.random() * moveOptions.length)
        return moveOptions[randomIndex] ? {
            coords: moveOptions[randomIndex],
            msg: "Lib Attack"
        } : []
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getRandomLibDefend(savedMin = 1) {
        const moveOptions = []
        const size = board[0].length
        let highValue = 0
        // Look through all the points on the board
        const moves = getAllValidMoves()
        for (const [x, y] of moves) {
            const surround = getSurroundLibs(x, y, "X")
            const myEyes = getEyeValue(x, y, "X")
            if (surround + myEyes < 2) continue //Abort.  Let it go, let it go...

            if (validLibMoves[x][y] === -1) {
                let count = 0
                //We are only checking up, down, left and right
                if (x > 0 && validLibMoves[x - 1][y] === 1 && board[x - 1][y] === "X") count += getChainValue(x - 1, y, "X")
                if (x < size - 1 && validLibMoves[x + 1][y] === 1 && board[x + 1][y] === "X") count += getChainValue(x + 1, y, "X")
                if (y > 0 && validLibMoves[x][y - 1] === 1 && board[x][y - 1] === "X") count += getChainValue(x, y - 1, "X")
                if (y < size - 1 && validLibMoves[x][y + 1] === 1 && board[x][y + 1] === "X") count += getChainValue(x, y + 1, "X")
                if (count === 0 || count < savedMin) continue

                //判断落子后能否获得足够的气：不希望在边上无意义地"爬"
                //如果落子在棋盘边缘（x=0/最大 或 y=0/最大），且surround<3（总气量提升很小）
                //且要救的棋链较小（<5子），说明是在边上爬，放弃
                const onEdge = (x === 0 || x === size - 1 || y === 0 || y === size - 1)
                if (onEdge && surround < 3) {
                    let smallChain = true
                    if (x > 0 && board[x - 1][y] === 'X' && getChainValue(x - 1, y, 'X') >= 5) smallChain = false
                    if (x < size - 1 && board[x + 1][y] === 'X' && getChainValue(x + 1, y, 'X') >= 5) smallChain = false
                    if (y > 0 && board[x][y - 1] === 'X' && getChainValue(x, y - 1, 'X') >= 5) smallChain = false
                    if (y < size - 1 && board[x][y + 1] === 'X' && getChainValue(x, y + 1, 'X') >= 5) smallChain = false
                    if (smallChain) continue //边上的小棋链，爬了也是死，放弃
                }

                //防送死检查：落子后新棋子自身必须有至少1口"独立气"
                //如果四周全是对方棋子+1气己方棋，落子=白送
                let hasOwnLiberty = false
                if (x > 0 && board[x - 1][y] === '.') hasOwnLiberty = true
                if (x < size - 1 && board[x + 1][y] === '.') hasOwnLiberty = true
                if (y > 0 && board[x][y - 1] === '.') hasOwnLiberty = true
                if (y < size - 1 && board[x][y + 1] === '.') hasOwnLiberty = true
                //例外：如果能提掉对方棋子，即使自己没有独立气也是合法好棋
                if (!hasOwnLiberty) {
                    let canCapture = false
                    if (x > 0 && board[x - 1][y] === 'O' && validLibMoves[x - 1][y] === 1) canCapture = true
                    if (x < size - 1 && board[x + 1][y] === 'O' && validLibMoves[x + 1][y] === 1) canCapture = true
                    if (y > 0 && board[x][y - 1] === 'O' && validLibMoves[x][y - 1] === 1) canCapture = true
                    if (y < size - 1 && board[x][y + 1] === 'O' && validLibMoves[x][y + 1] === 1) canCapture = true
                    if (!canCapture) continue //既没有气也提不了子 -> 送死，跳过
                }

                //Just HOW effective will this move be?  Counter attack if we can.
                //平方权重：优先救大棋！大龙价值远高于小链
                count = count * count * surround

                if (count > highValue) {
                    moveOptions.length = 0
                    moveOptions.push([x, y])
                    highValue = count
                }
                else if (count === highValue) moveOptions.push([x, y])
            }
        }
        // Choose one of the found moves at random
        const randomIndex = Math.floor(Math.random() * moveOptions.length)
        return moveOptions[randomIndex] ? {
            coords: moveOptions[randomIndex],
            msg: "Lib Defend"
        } : []
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getRandomCounterLib() {
        //Advanced strategy
        //If we have a chain that's going to die, and a hanging lib attached to it
        //Find that hanging lib and kill it to save the chain
        const size = board[0].length
        // Look through all the points on the board
        const moves = getAllValidMoves()
        const movesAvailable = new Set //Contains the empty squares that we are looking to see if we should take
        const friendlyToCheckForOpp = new Set
        for (const [x, y] of moves) {
            //We are checking up, down, left and right first
            if (x > 0 && validLibMoves[x - 1][y] === 1 && board[x - 1][y] === "X") {
                movesAvailable.add(JSON.stringify([x, y]))
                friendlyToCheckForOpp.add(JSON.stringify([x - 1, y]))
            }
            if (x < size - 1 && validLibMoves[x + 1][y] === 1 && board[x + 1][y] === "X") {
                movesAvailable.add(JSON.stringify([x, y]))
                friendlyToCheckForOpp.add(JSON.stringify([x + 1, y]))
            }
            if (y > 0 && validLibMoves[x][y - 1] === 1 && board[x][y - 1] === "X") {
                movesAvailable.add(JSON.stringify([x, y]))
                friendlyToCheckForOpp.add(JSON.stringify([x, y - 1]))
            }
            if (y < size - 1 && validLibMoves[x][y + 1] === 1 && board[x][y + 1] === "X") {
                movesAvailable.add(JSON.stringify([x, y]))
                friendlyToCheckForOpp.add(JSON.stringify([x, y + 1]))
            }
        }
        //Shortcut.  While there's 1, is it THE one?
        //We know that 1 side of this is a friendly with 1 lib at risk.  Is another side the enemy?
        for (const explore of movesAvailable) {
            const [fx, fy] = JSON.parse(explore)
            if (!validMove[fx][fy]) continue
            if (fx < size - 1 && board[fx + 1][fy] === "O" && validLibMoves[fx + 1][fy] === 1) {
                return {
                    coords: [fx, fy],
                    msg: "Counter Lib Attack - Fist of the east"
                }
            }
            if (fx > 0 && board[fx - 1][fy] === "O" && validLibMoves[fx - 1][fy] === 1) {
                return {
                    coords: [fx, fy],
                    msg: "Counter Lib Attack - Fist of the west"
                }
            }
            if (fy > 0 && board[fx][fy - 1] === "O" && validLibMoves[fx][fy - 1] === 1) {
                return {
                    coords: [fx, fy],
                    msg: "Counter Lib Attack - Fist of the south"
                }
            }
            if (fy < size - 1 && board[fx][fy + 1] === "O" && validLibMoves[fx][fy + 1] === 1) {
                return {
                    coords: [fx, fy],
                    msg: "Counter Lib Attack - Fist of the north"
                }
            }
        }
        const enemiesToSearch = new Set
        //We have our empty chain.  Look through him to find adjoining O's that can be killed and other friendies
        for (const explore of friendlyToCheckForOpp) {
            const [fx, fy] = JSON.parse(explore)
            if (fx < size - 1 && board[fx + 1][fy] === "O" && validLibMoves[fx + 1][fy] === 1) enemiesToSearch.add(JSON.stringify([fx + 1, fy]))
            if (fx > 0 && board[fx - 1][fy] === "O" && validLibMoves[fx - 1][fy] === 1) enemiesToSearch.add(JSON.stringify([fx - 1, fy]))
            if (fy > 0 && board[fx][fy - 1] === "O" && validLibMoves[fx][fy - 1] === 1) enemiesToSearch.add(JSON.stringify([fx, fy - 1]))
            if (fy < size - 1 && board[fx][fy + 1] === "O" && validLibMoves[fx][fy + 1] === 1) enemiesToSearch.add(JSON.stringify([fx, fy + 1]))

            if (fx < size - 1 && ["X"].includes(board[fx + 1][fy])) friendlyToCheckForOpp.add(JSON.stringify([fx + 1, fy]))
            if (fx > 0 && ["X"].includes(board[fx - 1][fy])) friendlyToCheckForOpp.add(JSON.stringify([fx - 1, fy]))
            if (fy > 0 && ["X"].includes(board[fx][fy - 1])) friendlyToCheckForOpp.add(JSON.stringify([fx, fy - 1]))
            if (fy < size - 1 && ["X"].includes(board[fx][fy + 1])) friendlyToCheckForOpp.add(JSON.stringify([fx, fy + 1]))
        }

        for (const explore of enemiesToSearch) {
            const [fx, fy] = JSON.parse(explore)
            if (fx < size - 1 && board[fx + 1][fy] === "O") enemiesToSearch.add(JSON.stringify([fx + 1, fy]))
            if (fx > 0 && board[fx - 1][fy] === "O") enemiesToSearch.add(JSON.stringify([fx - 1, fy]))
            if (fy > 0 && board[fx][fy - 1] === "O") enemiesToSearch.add(JSON.stringify([fx, fy - 1]))
            if (fy < size - 1 && board[fx][fy + 1] === "O") enemiesToSearch.add(JSON.stringify([fx, fy + 1]))

            if (fx < size - 1 && board[fx + 1][fy] === "." && validMove[fx + 1][fy]) {
                return {
                    coords: [fx + 1, fy],
                    msg: "Counter Lib Attack - The wind blows"
                }
            }
            if (fx > 0 && board[fx - 1][fy] === "." && validMove[fx - 1][fy]) {
                return {
                    coords: [fx - 1, fy],
                    msg: "Counter Lib Attack - The earth grows"
                }
            }
            if (fy > 0 && board[fx][fy - 1] === "." && validMove[fx][fy - 1]) {
                return {
                    coords: [fx, fy - 1],
                    msg: "Counter Lib Attack - The fire burns"
                }
            }
            if (fy < size - 1 && board[fx][fy + 1] === "." && validMove[fx][fy + 1]) {
                return {
                    coords: [fx, fy + 1],
                    msg: "Counter Lib Attack - The water flows"
                }
            }
        }
        return []
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getRandomExpand() {
        const moveOptions = []
        const size = board[0].length;
        let highValue = 0
        // Look through all the points on the board
        const moves = getAllValidMoves(true)
        for (const [x, y] of moves) {
            const surroundLibs = getSurroundLibs(x, y, "X")
            const enemySurroundLibs = getSurroundLibs(x, y, "O")
            if (contested[x][y] !== "?" || surroundLibs <= 2 || createsLib(x, y, "X") || enemySurroundLibs <= 1) continue
            //最边上一线几乎总是坏棋，跳过
            if (x === 0 || x === size - 1 || y === 0 || y === size - 1) continue
            let count = 0
            //We are only checking up, down, left and right.  Don't expand if you're surrounded by friendlies
            if (x > 0 && board[x - 1][y] === "X") count++
            if (x < size - 1 && board[x + 1][y] === "X") count++
            if (y > 0 && board[x][y - 1] === "X") count++
            if (y < size - 1 && board[x][y + 1] === "X") count++
            if (count >= 3 || count <= 0) continue

            const surroundSpace = getSurroundSpaceFull(x, y) + 1
            const enemySurroundChains = getChainAttack(x, y) + 1
            const myEyes = getEyeValueFull(x, y, "X") + 1
            const enemies = getSurroundEnemiesFull(x, y) + 1
            const freeSpace = getFreeSpace(x, y)
            //贴边惩罚：最边上一圈(x=0/max,y=0/max)的落子价值极低，评分压到接近0
            const edgePenalty = (x <= 1 || x >= size - 2 || y <= 1 || y >= size - 2) ? 0.05 : 1
            const rank = myEyes * enemySurroundLibs * enemies * enemySurroundChains * freeSpace * surroundSpace * edgePenalty

            if (rank > highValue) {
                moveOptions.length = 0
                moveOptions.push([x, y])
                highValue = rank
            }
            else if (rank === highValue) moveOptions.push([x, y]);
        }
        // Choose one of the found moves at random
        const randomIndex = Math.floor(Math.random() * moveOptions.length)
        return moveOptions[randomIndex] ? {
            coords: moveOptions[randomIndex],
            msg: "Expansion"
        } : []
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getRandomBolster(libRequired, savedNodesMin, onlyContested = true) {
        const moveOptions = [];
        const size = board[0].length;
        let highValue = 1
        // Look through all the points on the board
        const moves = getAllValidMoves()
        for (const [x, y] of moves) {
            if ((onlyContested && contested[x][y] !== "?") || createsLib(x, y, "X")) continue
            let right = 0
            let left = 0
            let up = 0
            let down = 0

            //We are only checking up, down, left and right
            //We are checking for linking chains of friendlies, filtering out those already checked
            let checkedChains = []
            if (x < size - 1 && board[x + 1][y] === "X" && validLibMoves[x + 1][y] === libRequired) {
                right = getChainValue(x + 1, y, "X")
                checkedChains.push(chains[x + 1][y])
            }
            if (x > 0 && board[x - 1][y] === "X" && !checkedChains.includes(chains[x - 1][y]) && validLibMoves[x - 1][y] === libRequired) {
                left = getChainValue(x - 1, y, "X")
                checkedChains.push(chains[x - 1][y])
            }
            if (y < size - 1 && board[x][y + 1] === "X" && !checkedChains.includes(chains[x][y + 1]) && validLibMoves[x][y + 1] === libRequired) {
                up = getChainValue(x, y + 1, "X")
                checkedChains.push(chains[x][y + 1])
            }
            if (y > 0 && board[x][y - 1] === "X" && !checkedChains.includes(chains[x][y - 1]) && validLibMoves[x][y - 1] === libRequired)
                down = getChainValue(x, y - 1, "X")

            let count = 0
            let total = 0
            if (right >= savedNodesMin) {
                count++
                total += right
            }
            if (left >= savedNodesMin) {
                count++
                total += left
            }
            if (up >= savedNodesMin) {
                count++
                total += up
            }
            if (down >= savedNodesMin) {
                count++
                total += down
            }
            if (count <= 0) continue
            //防爬边：在棋盘边缘且连接的棋链小（<5子），延申只会送死
            if ((x === 0 || x === size - 1 || y === 0 || y === size - 1) && total < 5) continue
            const surroundMulti = getSurroundLibSpread(x, y, "X")
            //贴边惩罚：最边两排的落子价值极低，不让AI贴边走
            const edgePenalty = (x <= 1 || x >= size - 2 || y <= 1 || y >= size - 2) ? 0.05 : 1
            const rank = total * count * surroundMulti * edgePenalty
            if (rank > highValue) {
                moveOptions.length = 0
                moveOptions.push([x, y])
                highValue = rank
            }
            else if (rank === highValue) moveOptions.push([x, y]);
        }
        // Choose one of the found moves at random
        const randomIndex = Math.floor(Math.random() * moveOptions.length)
        return moveOptions[randomIndex] ? {
            coords: moveOptions[randomIndex],
            msg: "Bolster - Libs: " + libRequired + "  Nodes: " + savedNodesMin + "  OnlyContested: " + onlyContested
        } : []
    }
    /** @param {NS} ns
     * @returns {number} */
    function getChainValue(checkx, checky, player) {
        const size = board[0].length
        const otherPlayer = player === "X" ? "O" : "X"
        const explored = new Set()
        if (contested[checkx][checky] === "?" || board[checkx][checky] === otherPlayer) return 0
        if (checkx < size - 1) explored.add(JSON.stringify([checkx + 1, checky]))
        if (checkx > 0) explored.add(JSON.stringify([checkx - 1, checky]))
        if (checky > 0) explored.add(JSON.stringify([checkx, checky - 1]))
        if (checky < size - 1) explored.add(JSON.stringify([checkx, checky + 1]))
        let count = 1
        for (const explore of explored) {
            const [x, y] = JSON.parse(explore)
            if (contested[x][y] === "?" || contested[x][y] === "#" || board[x][y] === otherPlayer) continue
            count++
            if (x < size - 1) explored.add(JSON.stringify([x + 1, y]))
            if (x > 0) explored.add(JSON.stringify([x - 1, y]))
            if (y > 0) explored.add(JSON.stringify([x, y - 1]))
            if (y < size - 1) explored.add(JSON.stringify([x, y + 1]))
        }
        return count
    }
    /** @param {NS} ns
     * @returns {number} */
    function getEyeValue(checkx, checky, player) {
        const size = board[0].length
        const otherPlayer = player === "X" ? "O" : "X"
        const explored = new Set()
        if (checkx < size - 1) explored.add(JSON.stringify([checkx + 1, checky]))
        if (checkx > 0) explored.add(JSON.stringify([checkx - 1, checky]))
        if (checky > 0) explored.add(JSON.stringify([checkx, checky - 1]))
        if (checky < size - 1) explored.add(JSON.stringify([checkx, checky + 1]))
        let count = 0
        for (const explore of explored) {
            const [x, y] = JSON.parse(explore)
            if (contested[x][y] === "?" || contested[x][y] === "#" || board[x][y] === otherPlayer) continue
            if (contested[x][y] === player) count++
            if (x < size - 1) explored.add(JSON.stringify([x + 1, y]))
            if (x > 0) explored.add(JSON.stringify([x - 1, y]))
            if (y > 0) explored.add(JSON.stringify([x, y - 1]))
            if (y < size - 1) explored.add(JSON.stringify([x, y + 1]))
        }
        return count
    }
    /** @param {NS} ns
     * @returns {number} */
    function getFreeSpace(checkx, checky) {
        const size = board[0].length
        if (contested[checkx][checky] !== "?") return 0
        const explored = new Set()
        if (checkx < size - 1) explored.add(JSON.stringify([checkx + 1, checky]))
        if (checkx > 0) explored.add(JSON.stringify([checkx - 1, checky]))
        if (checky > 0) explored.add(JSON.stringify([checkx, checky - 1]))
        if (checky < size - 1) explored.add(JSON.stringify([checkx, checky + 1]))
        let count = 1
        for (const explore of explored) {
            const [x, y] = JSON.parse(explore)
            if (["#", "X", "O"].includes(contested[x][y])) continue
            if (contested[x][y] === "?") count++
            if (x < size - 1) explored.add(JSON.stringify([x + 1, y]))
            if (x > 0) explored.add(JSON.stringify([x - 1, y]))
            if (y > 0) explored.add(JSON.stringify([x, y - 1]))
            if (y < size - 1) explored.add(JSON.stringify([x, y + 1]))
        }
        return count
    }
    /** @param {NS} ns
     * @returns {number} */
    function getEyeValueFull(checkx, checky, player) {
        const size = board[0].length
        const otherPlayer = player === "X" ? "O" : "X"
        const explored = new Set()
        if (checkx < size - 1) explored.add(JSON.stringify([checkx + 1, checky]))
        if (checkx > 0) explored.add(JSON.stringify([checkx - 1, checky]))
        if (checky > 0) explored.add(JSON.stringify([checkx, checky - 1]))
        if (checky < size - 1) explored.add(JSON.stringify([checkx, checky + 1]))
        if (checkx < size - 1 && checky < size - 1) explored.add(JSON.stringify([checkx + 1, checky + 1]))
        if (checkx > 0 && checky < size - 1) explored.add(JSON.stringify([checkx - 1, checky + 1]))
        if (checkx < size - 1 && checky > 0) explored.add(JSON.stringify([checkx + 1, checky - 1]))
        if (checkx > 0 && checky > 0) explored.add(JSON.stringify([checkx - 1, checky - 1]))
        let count = 0
        for (const explore of explored) {
            const [x, y] = JSON.parse(explore)
            if (contested[x][y] === "?" || contested[x][y] === "#" || board[x][y] === otherPlayer) continue
            if (contested[x][y] === player) count++
            if (x < size - 1) explored.add(JSON.stringify([x + 1, y]))
            if (x > 0) explored.add(JSON.stringify([x - 1, y]))
            if (y > 0) explored.add(JSON.stringify([x, y - 1]))
            if (y < size - 1) explored.add(JSON.stringify([x, y + 1]))
        }
        return count
    }
    /** @param {NS} ns
     * @returns {number} */
    function getChainAttack(x, y) {
        const size = board[0].length
        let count = 0
        if (x > 0 && board[x - 1][y] === "O") count += getChainValue(x - 1, y, "O")
        if (x < size - 1 && board[x + 1][y] === "O") count += getChainValue(x + 1, y, "O")
        if (y > 0 && board[x][y - 1] === "O") count += getChainValue(x, y - 1, "O")
        if (y < size - 1 && board[x][y + 1] === "O") count += getChainValue(x, y + 1, "O")

        return count
    }
    /** @param {NS} ns
     * @returns {number} */
    function getChainAttackFull(x, y) {
        const size = board[0].length
        let count = 0
        if (x < size - 1) count += getChainValue(x + 1, y, "O")
        if (x > 0) count += getChainValue(x - 1, y, "O")
        if (y > 0) count += getChainValue(x, y - 1, "O")
        if (y < size - 1) count += getChainValue(x, y + 1, "O")
        if (x < size - 1 && y < size - 1) count += getChainValue(x + 1, y + 1, "O")
        if (x > 0 && y < size - 1) count += getChainValue(x - 1, y + 1, "O")
        if (x < size - 1 && y > 0) count += getChainValue(x + 1, y - 1, "O")
        if (x > 0 && y > 0) count += getChainValue(x - 1, y - 1, "O")
        return count
    }
    /** @param {NS} ns
     * @returns {number} */
    function getSurroundSpace(x, y) {
        const size = board[0].length
        let surround = 0
        if (x > 0 && board[x - 1][y] === ".") surround++
        if (x < size - 1 && board[x + 1][y] === ".") surround++
        if (y > 0 && board[x][y - 1] === ".") surround++
        if (y < size - 1 && board[x][y + 1] === ".") surround++
        return surround
    }
    /** @param {NS} ns
     * @returns {number} */
    function getSurroundSpaceFull(startx, starty, player = "X", depth = 1) {
        const size = board[0].length
        let surround = 0
        for (let x = startx - depth; x <= startx + depth; x++)
            for (let y = starty - depth; y <= starty + depth; y++)
                if (x >= 0 && x <= size - 1 && y >= 0 && y <= size - 1 && [".", player].includes(board[x][y])) surround++
        return surround
    }
    /** @param {NS} ns
     * @returns {number} */
    function getHeatMap(startx, starty, player = "X", depth = 2) {
        const size = board[0].length
        let count = 1
        for (let x = startx - depth; x <= startx + depth; x++)
            for (let y = starty - depth; y <= starty + depth; y++)
                if (x >= 0 && x <= size - 1 && y >= 0 && y <= size - 1 && [".", player].includes(board[x][y])) count += board[x][y] === player ? 1.5 : board[x][y] === "." ? 1 : 0
        return count
    }
    /** @param {NS} ns
     * @returns {number} */
    function getSurroundLibs(x, y, player) {
        const size = board[0].length
        let surround = 0
        if (x > 0 && (board[x - 1][y] === "." || board[x - 1][y] === player)) surround += board[x - 1][y] === "." ? 1 : validLibMoves[x - 1][y] - 1
        if (x < size - 1 && (board[x + 1][y] === "." || board[x + 1][y] === player)) surround += board[x + 1][y] === "." ? 1 : validLibMoves[x + 1][y] - 1
        if (y > 0 && (board[x][y - 1] === "." || board[x][y - 1] === player)) surround += board[x][y - 1] === "." ? 1 : validLibMoves[x][y - 1] - 1
        if (y < size - 1 && (board[x][y + 1] === "." || board[x][y + 1] === player)) surround += board[x][y + 1] === "." ? 1 : validLibMoves[x][y + 1] - 1
        return surround
    }
    /** @param {NS} ns
     * @returns {number} */
    function getSurroundLibSpread(x, y, player) {
        const size = board[0].length
        let surround = 0
        const checks = new Set
        if (board[x][y] === ".") checks.add(JSON.stringify([x, y]))
        else return 0
        if (x > 0 && board[x - 1][y] === ".") checks.add(JSON.stringify([x - 1, y]))
        if (x < size - 1 && board[x + 1][y] === ".") checks.add(JSON.stringify([x + 1, y]))
        if (y > 0 && board[x][y - 1] === ".") checks.add(JSON.stringify([x, y - 1]))
        if (y < size - 1 && board[x][y + 1] === ".") checks.add(JSON.stringify([x, y + 1]))
        //Now, check the liberty values of all the checks
        for (const check of checks) {
            const [x, y] = JSON.parse(check)
            surround += getSurroundLibs(x, y, player)
        }
        return surround
    }
    /** @param {NS} ns
     * @returns {number} */
    function getSurroundEnemiesFull(x, y) {
        const size = board[0].length
        let surround = 0
        if (x > 0 && board[x - 1][y] === "O") surround += getChainValue(x - 1, y, "O")
        if (x < size - 1 && board[x + 1][y] === "O") surround += getChainValue(x + 1, y, "O")
        if (y > 0 && board[x][y - 1] === "O") surround += getChainValue(x, y - 1, "O")
        if (y < size - 1 && board[x][y + 1] === "O") surround += getChainValue(x, y + 1, "O")

        if (x > 0 && y > 0 && board[x - 1][y - 1] === "O") surround += getChainValue(x - 1, y - 1, "O")
        if (x < size - 1 && y > 0 && board[x + 1][y - 1] === "O") surround += getChainValue(x + 1, y - 1, "O")
        if (y < size - 1 && x > 0 && board[x - 1][y + 1] === "O") surround += getChainValue(x - 1, y - 1, "O")
        if (y < size - 1 && x < size - 1 && board[x + 1][y + 1] === "O") surround += getChainValue(x + 1, y + 1, "O")

        return surround
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getRandomStrat() {
        const moveOptions = []
        let moveOptions2 = []
        const size = board[0].length

        // Look through all the points on the board
        let bestRank = 0
        const moves = getAllValidMoves(true)
        for (const [x, y] of moves) {
            if (!["?", "O"].includes(contested[x][y]) || createsLib(x, y, "X")) continue
            let isSupport = ((x > 0 && board[x - 1][y] === "X" && validLibMoves[x - 1][y] >= 1) || (x < size - 1 && board[x + 1][y] === "X" && validLibMoves[x + 1][y] >= 1) || (y > 0 && board[x][y - 1] === "X" && validLibMoves[x][y - 1] >= 1) || (y < size - 1 && board[x][y + 1] === "X" && validLibMoves[x][y + 1] >= 1)) ? true : false
            let isAttack = ((x > 0 && board[x - 1][y] === "O" && validLibMoves[x - 1][y] >= 2) || (x < size - 1 && board[x + 1][y] === "O" && validLibMoves[x + 1][y] >= 2) || (y > 0 && board[x][y - 1] === "O" && validLibMoves[x][y - 1] >= 2) || (y < size - 1 && board[x][y + 1] === "O" && validLibMoves[x][y + 1] >= 2)) ? true : false

            //最边上一线的落子几乎总是坏棋，直接跳过
            if (x === 0 || x === size - 1 || y === 0 || y === size - 1) continue
            const surround = getSurroundSpace(x, y)
            if (isSupport || isAttack) {
                if (surround > bestRank) {
                    moveOptions.length = 0
                    bestRank = surround
                    moveOptions.push([x, y]);
                }
                else if (surround === bestRank) {
                    moveOptions.push([x, y])
                }
            }
            else {
                moveOptions2.push([x, y])
            }
        }
        // Choose one of the found moves at random
        const randomIndex = Math.floor(Math.random() * moveOptions.length);
        if (moveOptions[randomIndex]) return {
            coords: moveOptions[randomIndex],
            msg: "Random Safe"
        }
        //"Random Unsafe"路径：必须检查气，不能在角落里无气送死
        //打乱顺序后遍历，找到第一个安全的落子
        moveOptions2 = moveOptions2.sort(() => Math.random() - Math.random())
        for (const [x, y] of moveOptions2) {
            //安全检查：落子点至少有一个空邻位（有自己的气）
            let safe = false
            if (x > 0 && board[x - 1][y] === '.') safe = true
            else if (x < size - 1 && board[x + 1][y] === '.') safe = true
            else if (y > 0 && board[x][y - 1] === '.') safe = true
            else if (y < size - 1 && board[x][y + 1] === '.') safe = true
            //例外：能提子也算安全
            if (!safe) {
                if (x > 0 && board[x - 1][y] === 'O' && validLibMoves[x - 1][y] === 1) safe = true
                else if (x < size - 1 && board[x + 1][y] === 'O' && validLibMoves[x + 1][y] === 1) safe = true
                else if (y > 0 && board[x][y - 1] === 'O' && validLibMoves[x][y - 1] === 1) safe = true
                else if (y < size - 1 && board[x][y + 1] === 'O' && validLibMoves[x][y + 1] === 1) safe = true
            }
            if (safe) return { coords: [x, y], msg: "Random Unsafe (safe checked)" }
        }
        return []
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getAggroAttack(libsMin, libsMax, minSurround = 3, minChain = 1, minFreeSpace = 0) {
        const moveOptions = [];
        const size = board[0].length;
        let highestValue = 0
        // Look through all the points on the board
        const moves = getAllValidMoves(true)
        for (const [x, y] of moves) {
            if (createsLib(x, y, "X")) continue
            const isAttack = (
                (x > 0 && board[x - 1][y] === "O" && validLibMoves[x - 1][y] >= libsMin && validLibMoves[x - 1][y] <= libsMax) ||
                (x < size - 1 && board[x + 1][y] === "O" && validLibMoves[x + 1][y] >= libsMin && validLibMoves[x + 1][y] <= libsMax) ||
                (y > 0 && board[x][y - 1] === "O" && validLibMoves[x][y - 1] >= libsMin && validLibMoves[x][y - 1] <= libsMax) ||
                (y < size - 1 && board[x][y + 1] === "O" && validLibMoves[x][y + 1] >= libsMin && validLibMoves <= libsMax)) ? true : false
            const surround = getSurroundLibs(x, y, "X")
            const freeSpace = getFreeSpace(x, y)
            if (freeSpace < minFreeSpace) continue
            if (!isAttack || surround < minSurround) continue
            const chainAtk = getChainAttack(x, y)
            if (chainAtk < minChain) continue
            let lowestLibs = 999
            if (x > 0 && board[x - 1][y] === "O" && validLibMoves[x - 1][y] < lowestLibs) lowestLibs = validLibMoves[x - 1][y]
            if (x < size - 1 && board[x + 1][y] === "O" && validLibMoves[x + 1][y] < lowestLibs) lowestLibs = validLibMoves[x + 1][y]
            if (y > 0 && board[x][y - 1] === "O" && validLibMoves[x][y - 1] < lowestLibs) lowestLibs = validLibMoves[x][y - 1]
            if (y < size - 1 && board[x][y + 1] === "O" && validLibMoves[x][y + 1] < lowestLibs) lowestLibs = validLibMoves[x][y + 1]

            const enemyLibs = getSurroundLibSpread(x, y, "O")
            const startEyeValue = getEyeValue(x, y, "O")
            const eyeValue = startEyeValue > 1 ? startEyeValue : 1
            const atk = enemyLibs * chainAtk / eyeValue * getHeatMap(x, y, "O") / lowestLibs
            if (atk > highestValue) {
                highestValue = atk
                moveOptions.length = 0
                moveOptions.push([x, y]);
            }
            else if (atk === highestValue) {
                highestValue = atk
                moveOptions.push([x, y]);
            }
        }
        // Choose one of the found moves at random
        const randomIndex = Math.floor(Math.random() * moveOptions.length)
        return moveOptions[randomIndex] ? {
            coords: moveOptions[randomIndex],
            msg: "Aggro Attack: " + libsMin + "/" + libsMax + "  Surround: " + minSurround
        } : []
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getDefAttack(libsMin, libsMax, minSurround = 3, minChain = 1, minFreeSpace = 0) {
        const moveOptions = [];
        const size = board[0].length;
        let highestValue = 0
        // Look through all the points on the board
        const moves = getAllValidMoves(true)
        for (const [x, y] of moves) {
            if (createsLib(x, y, "X")) continue
            const isAttack = (
                (x > 0 && board[x - 1][y] === "O" && validLibMoves[x - 1][y] >= libsMin && validLibMoves[x - 1][y] <= libsMax) ||
                (x < size - 1 && board[x + 1][y] === "O" && validLibMoves[x + 1][y] >= libsMin && validLibMoves[x + 1][y] <= libsMax) ||
                (y > 0 && board[x][y - 1] === "O" && validLibMoves[x][y - 1] >= libsMin && validLibMoves[x][y - 1] <= libsMax) ||
                (y < size - 1 && board[x][y + 1] === "O" && validLibMoves[x][y + 1] >= libsMin && validLibMoves <= libsMax)) ? true : false
            const surround = getSurroundLibs(x, y, "X")
            const freeSpace = getFreeSpace(x, y)
            if (freeSpace < minFreeSpace) continue
            if (!isAttack || surround < minSurround) continue
            const chainAtk = getChainAttack(x, y)
            if (chainAtk < minChain) continue
            let lowestLibs = 999
            if (x > 0 && board[x - 1][y] === "O" && validLibMoves[x - 1][y] < lowestLibs) lowestLibs = validLibMoves[x - 1][y]
            if (x < size - 1 && board[x + 1][y] === "O" && validLibMoves[x + 1][y] < lowestLibs) lowestLibs = validLibMoves[x + 1][y]
            if (y > 0 && board[x][y - 1] === "O" && validLibMoves[x][y - 1] < lowestLibs) lowestLibs = validLibMoves[x][y - 1]
            if (y < size - 1 && board[x][y + 1] === "O" && validLibMoves[x][y + 1] < lowestLibs) lowestLibs = validLibMoves[x][y + 1]

            const friendlyLibs = getSurroundLibs(x, y, "X")
            const startEyeValue = getEyeValue(x, y, "O")
            const eyeValue = startEyeValue > 1 ? startEyeValue : 1

            const atk = friendlyLibs * chainAtk / eyeValue * getHeatMap(x, y, "X") / lowestLibs * (getEyeValue(x, y, "X") + 1)

            if (atk > highestValue) {
                highestValue = atk
                moveOptions.length = 0
                moveOptions.push([x, y]);
            }
            else if (atk === highestValue) {
                highestValue = atk
                moveOptions.push([x, y]);
            }
        }
        // Choose one of the found moves at random
        const randomIndex = Math.floor(Math.random() * moveOptions.length)
        return moveOptions[randomIndex] ? {
            coords: moveOptions[randomIndex],
            msg: "Defensive Attack: " + libsMin + "/" + libsMax + "  Surround: " + minSurround
        } : []
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function attackGrowDragon(requiredEyes, killLib = false) {
        const moveOptions = [];
        let highestValue = 0
        // Look through all the points on the board
        const moves = getAllValidMoves(true)
        for (const [x, y] of moves) {
            if (contested[x][y] !== "?" || createsLib(x, y, "X")) continue
            const surround = getSurroundEnemiesFull(x, y)
            const myLibs = getSurroundLibs(x, y, "X")
            if (surround < 1 || myLibs < 3) continue
            const enemyLibs = getSurroundLibs(x, y, "O")
            if (enemyLibs === 1 && !killLib) continue
            const enemyChains = getChainAttackFull(x, y)
            const myEyes = getEyeValueFull(x, y, "X")
            if (myEyes < requiredEyes) continue // || count === 3) continue
            const result = enemyLibs * enemyChains // surround * enemyLibs * myChains *  /*freeSpace * */ enemyEyes * enemyChains

            if (result > highestValue) {
                highestValue = result
                moveOptions.length = 0
                moveOptions.push([x, y])
            }
            else if (result === highestValue) {
                highestValue = result
                moveOptions.push([x, y])
            }
        }
        // Choose one of the found moves at random
        const randomIndex = Math.floor(Math.random() * moveOptions.length)
        return moveOptions[randomIndex] ? {
            coords: moveOptions[randomIndex],
            msg: "Attack/Grow Dragon: " + requiredEyes
        } : []
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getDefPattern() {
        let def = []
        def.push(...def5)

        const moves = getAllValidMoves()
        for (const [x, y] of moves) {
            for (const pattern of def)
                if (isPattern(x, y, pattern)) {
                    const msg = sprintf("Def Pattern: %s\n%s\n%s", pattern.length, pattern.join("\n"), "---------------")
                    return {
                        coords: [x, y],
                        msg: msg
                    }
                }
        }
        return []
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function disruptEyes() {
        let disrupt = []
        disrupt.push(...disrupt4)
        disrupt.push(...disrupt5)

        const moves = getAllValidMoves()
        for (const [x, y] of moves) {
            for (const pattern of disrupt)
                if (isPattern(x, y, pattern)) {
                    const msg = sprintf("Eye Disruption: %s\n%s\n%s", pattern.length, pattern.join("\n"), "---------------")
                    return {
                        coords: [x, y],
                        msg: msg
                    }
                }
        }
        return []
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getCreateEyeMove() {
        //基于最强的Illuminati AI的getEyeCreationMove逻辑
        //造眼是围棋根本：一块棋拥有两只眼就永远不能被提
        //真眼vs假眼的关键：
        //  中央点：至少3/4面己方包围（棋盘边界不算）
        //  边点：至少2/3面己方包围
        //  角点：至少2/2面己方包围
        //  斜对角不能是对方棋子（对方在斜角会切断连接，使眼变假）
        const moveOptions = [];
        const size = board[0].length;
        let highValue = 0;
        let foundLiveGroup = false;
        const moves = getAllValidMoves();
        for (const [x, y] of moves) {
            if (createsLib(x, y, 'X')) continue
            if (!['?', 'O'].includes(contested[x][y])) continue

            //统计4个正方向：我方棋子和棋盘边界的数量
            let friendlyOrWall = 0;
            let emptyCount = 0;
            let availableDirs = 4; //可用的正方向数量（排除棋盘边界）
            const checks = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
            for (const [nx, ny] of checks) {
                if (nx < 0 || nx >= size || ny < 0 || ny >= size) {
                    friendlyOrWall++; //棋盘边界相当于己方墙壁
                    availableDirs--;  //这个方向不存在
                } else if (board[nx][ny] === 'X') {
                    friendlyOrWall++;
                } else if (board[nx][ny] === '.') {
                    emptyCount++;
                }
            }

            //根据位置类型确定真眼所需的最小围墙数
            let minWallsForEye;
            if (availableDirs === 4) minWallsForEye = 3; //中央：至少3/4
            else if (availableDirs === 3) minWallsForEye = 2; //边：至少2/3
            else minWallsForEye = 2; //角：至少2/2

            //检查4个斜对角：对方棋子超过2个会使眼变假（切断连接）
            let diagOpponents = 0;
            const diagChecks = [[x - 1, y - 1], [x - 1, y + 1], [x + 1, y - 1], [x + 1, y + 1]];
            for (const [nx, ny] of diagChecks) {
                if (nx >= 0 && nx < size && ny >= 0 && ny < size && board[nx][ny] === 'O') {
                    diagOpponents++;
                }
            }

            //真眼判定：围墙够 + 至少有1个空位（眼位本身）+ 斜对角不能太多对方
            if (friendlyOrWall >= minWallsForEye && emptyCount >= 1 && diagOpponents <= 2) {
                let maxChainSize = 0;
                let minChainLibs = 999;
                let totalEyeValue = 0;

                for (const [nx, ny] of checks) {
                    if (nx >= 0 && nx < size && ny >= 0 && ny < size && board[nx][ny] === 'X') {
                        const cSize = getChainValue(nx, ny, 'X');
                        if (cSize > maxChainSize) maxChainSize = cSize;
                        if (validLibMoves[nx][ny] < minChainLibs) minChainLibs = validLibMoves[nx][ny];
                        //检测连接的棋块的"眼值"——已经有眼的棋是活棋，可以作为进攻基地
                        totalEyeValue += getEyeValue(nx, ny, 'X');
                    }
                }

                //判断连接的棋块是否已经是"活棋"（有足够的眼位）
                const hasLiveGroup = totalEyeValue >= 2;
                if (hasLiveGroup) foundLiveGroup = true;
                //活棋周围空位越多，越应该从这个基地向外进攻
                const aggressionBonus = hasLiveGroup ? emptyCount * emptyCount * 10 : 0;

                //评分：围墙越多越好，连接到的棋块气越少越紧迫需要造眼
                const libFactor = minChainLibs <= 2 ? 3 : minChainLibs <= 4 ? 2 : 1;
                //基础造眼分 + 活棋进攻加成
                const score = friendlyOrWall * friendlyOrWall * libFactor * (maxChainSize + 1) + aggressionBonus;

                if (score > highValue) {
                    highValue = score;
                    moveOptions.length = 0;
                    moveOptions.push([x, y]);
                } else if (score === highValue) {
                    moveOptions.push([x, y]);
                }
            }
        }
        const randomIndex = Math.floor(Math.random() * moveOptions.length)
        return moveOptions[randomIndex] ? {
            coords: moveOptions[randomIndex],
            msg: foundLiveGroup ? 'Eye+Attack: ' + highValue : 'Create Eye: ' + highValue
        } : []
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getLiveGroupAttack() {
        //活棋进攻：当己方棋块已有两只眼（活棋），以此为基地激进扩张
        //活棋是安全的进攻基地——对方提不掉，可以放心向外发展
        //支持两种拓展模式：
        //  ① 紧贴(1格)：紧邻活棋落子，稳固
        //  ② 跳(2格)：从活棋跳出2格拓展，中间空位确保可以连回
        const moveOptions = [];
        const size = board[0].length;
        let highValue = 0;
        const moves = getAllValidMoves(true);
        for (const [x, y] of moves) {
            if (!['?', 'O'].includes(contested[x][y]) || createsLib(x, y, 'X')) continue

            let liveGroupEyes = 0;
            let liveGroupSize = 0;
            let attackValue = 0;

            //① 检查紧贴(1格)邻接的活棋
            const checks = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
            for (const [nx, ny] of checks) {
                if (nx >= 0 && nx < size && ny >= 0 && ny < size && board[nx][ny] === 'X') {
                    const eyeVal = getEyeValue(nx, ny, 'X');
                    if (eyeVal >= 2) {
                        liveGroupEyes += eyeVal;
                        liveGroupSize += getChainValue(nx, ny, 'X');
                    }
                }
                if (nx >= 0 && nx < size && ny >= 0 && ny < size && board[nx][ny] === 'O') {
                    attackValue += getChainValue(nx, ny, 'O');
                }
            }

            //② 检查"跳"(2格)：从活棋跳出2格，中间为空
            let jumpBonus = 0;
            const jumpDirs = [[-2, 0, -1, 0], [2, 0, 1, 0], [0, -2, 0, -1], [0, 2, 0, 1]];
            for (const [dx, dy, mx, my] of jumpDirs) {
                const nx = x + dx, ny = y + dy;
                const midX = x + mx, midY = y + my;
                //跳的目标位置有活棋，中间为空（路径畅通）
                if (nx >= 0 && nx < size && ny >= 0 && ny < size &&
                    midX >= 0 && midX < size && midY >= 0 && midY < size &&
                    board[nx][ny] === 'X' && board[midX][midY] === '.') {
                    const eyeVal = getEyeValue(nx, ny, 'X');
                    if (eyeVal >= 2) {
                        liveGroupEyes += eyeVal;
                        liveGroupSize += getChainValue(nx, ny, 'X');
                        jumpBonus = 3; //跳拓得高分，一次占两格
                    }
                }
            }

            //只有从活棋（眼值>=2）出发的扩张才考虑
            if (liveGroupEyes < 2 || liveGroupSize < 2) continue

            //评分：活棋安全系数×攻击价值×跳拓加分
            const baseScore = (attackValue + 1) * 10 * liveGroupSize;
            const score = baseScore * (jumpBonus > 0 ? jumpBonus : 1);
            if (score > highValue) {
                highValue = score;
                moveOptions.length = 0;
                moveOptions.push([x, y]);
            } else if (score === highValue) {
                moveOptions.push([x, y]);
            }
        }
        const randomIndex = Math.floor(Math.random() * moveOptions.length);
        return moveOptions[randomIndex] ? {
            coords: moveOptions[randomIndex],
            msg: 'Live Attack: ' + highValue
        } : [];
    }
    /** @param {NS} ns
     * @returns {{coords: number[]; msg: string;}} */
    function getBlockEyeMove() {
        //基于Illuminati AI的getEyeBlockingMove逻辑
        //如果对方在某个点形成3面己方棋子包围（且该点是对方成眼的关键），必须抢占
        //注意：棋盘边界不算"对方墙壁"，只有实际的对方棋子才算，避免AI走死边
        const blockCandidates = [];
        const size = board[0].length;
        const moves = getAllValidMoves();
        for (const [x, y] of moves) {
            if (!['?', 'O'].includes(contested[x][y])) continue

            //统计四周：只计算实际的对方棋子（棋盘边界不算！）
            let opponentCount = 0;
            let emptyAround = 0;
            let friendlyTouch = 0;
            const checks = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
            for (const [nx, ny] of checks) {
                if (nx < 0 || nx >= size || ny < 0 || ny >= size) {
                    //棋盘边界是中立屏障，不归入任何一方
                } else if (board[nx][ny] === 'O') {
                    opponentCount++;
                } else if (board[nx][ny] === '.') {
                    emptyAround++;
                } else if (board[nx][ny] === 'X') {
                    friendlyTouch++;
                }
            }

            //需要至少2个实际对方棋子+至少1个空位（真正的眼位威胁）
            //并且这个点必须连接到一个对方的棋链（确认不是孤立无援的落子）
            if (opponentCount >= 2 && emptyAround >= 1) {
                //检查连接到的对方棋链是否气很少（有被提风险才可能是真威胁）
                let oppChainSize = 0;
                let oppChainLibs = 999;
                let foundOppChain = false;
                for (const [nx, ny] of checks) {
                    if (nx >= 0 && nx < size && ny >= 0 && ny < size && board[nx][ny] === 'O') {
                        const cSize = getChainValue(nx, ny, 'O');
                        if (cSize > oppChainSize) oppChainSize = cSize;
                        if (validLibMoves[nx][ny] < oppChainLibs) oppChainLibs = validLibMoves[nx][ny];
                        foundOppChain = true;
                    }
                }
                //必须连接到对方棋链+对方气少（即将成眼）才堵
                if (!foundOppChain || oppChainLibs > 6) continue;
                const urgency = oppChainLibs <= 2 ? 100 : oppChainLibs <= 4 ? 50 : 10;
                const score = urgency * (oppChainSize + 1) * (friendlyTouch > 0 ? 2 : 1);
                blockCandidates.push({ x, y, score });
            }
        }
        if (blockCandidates.length === 0) return [];
        blockCandidates.sort((a, b) => b.score - a.score);
        //从最优的前几个中随机选，增加变化
        const topN = Math.min(blockCandidates.length, Math.max(1, Math.floor(blockCandidates.length / 2)));
        const pick = blockCandidates[Math.floor(Math.random() * topN)];
        return {
            coords: [pick.x, pick.y],
            msg: 'Block Eye: ' + pick.score
        };
    }
    /** @param {NS} ns
     * @returns {Promise<false | {type:"move"|"pass"|"gameOver"; x:number; y:number;}} */
    async function movePiece(ns, attack) {
        if (attack.coords === undefined) return false
        const [x, y] = attack.coords
        if (x === undefined) return false
        //全局防贴边：x<=1或x>=size-2或y<=1或y>=size-2不允许落子，除非在进攻（提子）
        //官子阶段（棋盘大部分已填满）放松限制，允许收官
        const size = board[0].length
        if (x <= 1 || x >= size - 2 || y <= 1 || y >= size - 2) {
            let capturing = false
            if (x > 0 && board[x - 1][y] === 'O' && validLibMoves[x - 1][y] === 1) capturing = true
            else if (x < size - 1 && board[x + 1][y] === 'O' && validLibMoves[x + 1][y] === 1) capturing = true
            else if (y > 0 && board[x][y - 1] === 'O' && validLibMoves[x][y - 1] === 1) capturing = true
            else if (y < size - 1 && board[x][y + 1] === 'O' && validLibMoves[x][y + 1] === 1) capturing = true
            if (!capturing) {
                //官子检测：空位少于20%时视为官子阶段，允许贴边走
                const totalCells = size * size
                let emptyCells = 0
                for (let i = 0; i < size; i++)
                    for (let j = 0; j < size; j++)
                        if (board[i][j] === '.') emptyCells++
                if (emptyCells > totalCells * 0.2) return false //中盘：禁止贴边
                //官子：允许贴边收官
            }
        }
        let mid = performance.now()
        ns.printf("%s", attack.msg)
        const results = await go_makeMove(ns, x, y);
        let END = performance.now()
        if (logtime) ns.printf("Time: Me: %s  Them: %s", formatTime(ns, mid - START, true), formatTime(ns, END - mid, true))
        START = performance.now()
        return results
    }
    /** @param {NS} ns
     * @returns {Promise<false | {type:"move"|"pass"|"gameOver"; x:number; y:number;}} */
    async function moveSnakeEyes(ns, attack) {
        if (attack.coords === undefined || !cheats) return false
        const [s1x, s1y, s2x, s2y] = attack.coords
        if (s1x === undefined) return false
        const chance = await go_cheat_getCheatSuccessChance(ns);
        if (chance < cheatChanceThreshold) return false
        try {
            let mid = performance.now()
            const results = await go_cheat_playTwoMoves(ns, s1x, s1y, s2x, s2y)
            ns.printf("%s  Chance: %.2f%%  Result: %s", attack.msg, chance * 100, results.type);
            let END = performance.now()
            if (logtime) ns.printf("Time: Me: %s  Them: %s", formatTime(ns, mid - START, true), formatTime(ns, END - mid, true))
            START = performance.now()
            return results
        }
        catch { return false }
    }
    function getAllValidMoves(notMine = false) {
        if (currentValidMovesTurn === turn) return notMine ? currentValidContestedMoves : currentValidMoves
        let moves = []
        let contestedMoves = []
        for (let x = 0; x < board[0].length; x++)
            for (let y = 0; y < board[0].length; y++) {
                if (validMove[x][y]) {
                    if (["O", "?"].includes(contested[x][y])) contestedMoves.push([x, y])
                    moves.push([x, y])
                }
            }

        //Moves contains a randomized array of x,y
        moves = moves.sort(() => Math.random() - Math.random())
        contestedMoves = contestedMoves.sort(() => Math.random() - Math.random())
        currentValidMoves = moves
        currentValidContestedMoves = contestedMoves
        currentValidMovesTurn = turn
        return notMine ? currentValidContestedMoves : currentValidMoves
    }
    function createsLib(x, y, player) {
        const size = board[0].length

        if (x > 0 && board[x - 1][y] === player && validLibMoves[x - 1][y] > 2) return false
        if (x < size - 1 && board[x + 1][y] === player && validLibMoves[x + 1][y] > 2) return false
        if (y > 0 && board[x][y - 1] === player && validLibMoves[x][y - 1] > 2) return false
        if (y < size - 1 && board[x][y + 1] === player && validLibMoves[x][y + 1] > 2) return false

        if (x > 0 && board[x - 1][y] === player && validLibMoves[x - 1][y] === 2) return true
        if (x < size - 1 && board[x + 1][y] === player && validLibMoves[x + 1][y] === 2) return true
        if (y > 0 && board[x][y - 1] === player && validLibMoves[x][y - 1] === 2) return true
        if (y < size - 1 && board[x][y + 1] === player && validLibMoves[x][y + 1] === 2) return true

        return false
    }
    /** @returns {{coords: number[];msg: string;}} */
    function getOpeningMove() {
        const size = board[0].length
        switch (size) {
            case 13:
                if (getSurroundSpace(2, 2) === 4 && validMove[2][2]) return ({
                    coords: [2, 2],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(2, 10) === 4 && validMove[2][10]) return ({
                    coords: [2, 10],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(10, 10) === 4 && validMove[10][10]) return ({
                    coords: [10, 10],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(10, 2) === 4 && validMove[10][2]) return ({
                    coords: [10, 2],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(3, 3) === 4 && validMove[3][3]) return ({
                    coords: [3, 3],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(3, 9) === 4 && validMove[3][9]) return ({
                    coords: [3, 9],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(9, 9) === 4 && validMove[9][9]) return ({
                    coords: [9, 9],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(9, 3) === 4 && validMove[9][3]) return ({
                    coords: [9, 3],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(4, 4) === 4 && validMove[4][4]) return ({
                    coords: [4, 4],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(4, 8) === 4 && validMove[4][8]) return ({
                    coords: [4, 8],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(8, 8) === 4 && validMove[8][8]) return ({
                    coords: [8, 8],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(8, 4) === 4 && validMove[8][4]) return ({
                    coords: [8, 4],
                    msg: "Opening Move: " + turn
                })
                else return getRandomStrat()
            case 9:
                if (getSurroundSpace(2, 2) === 4 && validMove[2][2]) return ({
                    coords: [2, 2],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(2, 6) === 4 && validMove[2][6]) return ({
                    coords: [2, 6],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(6, 6) === 4 && validMove[6][6]) return ({
                    coords: [6, 6],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(6, 2) === 4 && validMove[6][2]) return ({
                    coords: [6, 2],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(3, 3) === 4 && validMove[3][3]) return ({
                    coords: [3, 3],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(3, 5) === 4 && validMove[3][5]) return ({
                    coords: [3, 5],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(5, 5) === 4 && validMove[5][5]) return ({
                    coords: [5, 5],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(5, 3) === 4 && validMove[5][3]) return ({
                    coords: [5, 3],
                    msg: "Opening Move: " + turn
                })
                else return getRandomStrat()
            case 7:
                if (getSurroundSpace(2, 2) === 4 && validMove[2][2]) return ({
                    coords: [2, 2],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(2, 4) === 4 && validMove[2][4]) return ({
                    coords: [2, 4],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(4, 4) === 4 && validMove[4][4]) return ({
                    coords: [4, 4],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(4, 2) === 4 && validMove[4][2]) return ({
                    coords: [4, 2],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(3, 3) === 4 && validMove[3][3]) return ({
                    coords: [3, 3],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(1, 1) === 4 && validMove[1][1]) return ({
                    coords: [1, 1],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(5, 1) === 4 && validMove[5][1]) return ({
                    coords: [5, 1],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(5, 5) === 4 && validMove[5][5]) return ({
                    coords: [5, 5],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(1, 5) === 4 && validMove[1][5]) return ({
                    coords: [1, 5],
                    msg: "Opening Move: " + turn
                })
                else return getRandomStrat()
            case 5:
                if (getSurroundSpace(2, 2) === 4 && validMove[2][2]) return ({
                    coords: [2, 2],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(3, 3) === 4 && validMove[3][3]) return ({
                    coords: [3, 3],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(3, 1) === 4 && validMove[3][1]) return ({
                    coords: [3, 1],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(1, 3) === 4 && validMove[1][3]) return ({
                    coords: [1, 3],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(1, 1) === 4 && validMove[1][1]) return ({
                    coords: [1, 1],
                    msg: "Opening Move: " + turn
                })
                else return getRandomStrat()
            case 19:
                if (getSurroundSpace(9, 9) === 4 && validMove[9][9]) return ({
                    coords: [9, 9],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(2, 2) === 4 && validMove[2][2]) return ({
                    coords: [2, 2],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(16, 2) === 4 && validMove[16][2]) return ({
                    coords: [16, 2],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(2, 16) === 4 && validMove[2][16]) return ({
                    coords: [2, 16],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(16, 16) === 4 && validMove[16][16]) return ({
                    coords: [16, 16],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(3, 3) === 4 && validMove[3][3]) return ({
                    coords: [3, 3],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(3, 15) === 4 && validMove[3][15]) return ({
                    coords: [3, 15],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(15, 15) === 4 && validMove[15][15]) return ({
                    coords: [15, 15],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(15, 3) === 4 && validMove[15][3]) return ({
                    coords: [15, 3],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(4, 4) === 4 && validMove[4][4]) return ({
                    coords: [4, 4],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(4, 14) === 4 && validMove[4][14]) return ({
                    coords: [4, 14],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(14, 14) === 4 && validMove[14][14]) return ({
                    coords: [14, 14],
                    msg: "Opening Move: " + turn
                })
                else if (getSurroundSpace(14, 4) === 4 && validMove[14][4]) return ({
                    coords: [14, 4],
                    msg: "Opening Move: " + turn
                })
                else return getRandomStrat()
        }
    }
}