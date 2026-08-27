const { parentPort, workerData } = require('node:worker_threads');
const { runHeadlessSimulation } = require('./headlessSimulation.js');

function buildStandings(result) {
    const playersById = new Map(result.room.players.map(player => [player.id, player]));
    const sortedPlayers = [...result.room.players]
        .sort((left, right) => (right.vp || 0) - (left.vp || 0));
    let previousVictoryPoints = null;
    let previousRank = 0;
    const fallbackStandings = sortedPlayers.map((player, index) => {
        const victoryPoints = Number.isFinite(player.vp) ? player.vp : 0;
        const rank = victoryPoints === previousVictoryPoints ? previousRank : index + 1;
        previousVictoryPoints = victoryPoints;
        previousRank = rank;
        return {
            rank,
            playerId: player.id,
            name: player.name,
            vp: victoryPoints,
            isBot: true,
            factions: player.factions || []
        };
    });
    const sourceStandings = result.gameResult?.standings || fallbackStandings;

    return sourceStandings.map(standing => ({
        ...standing,
        policyVersion: playersById.get(standing.playerId)?.policyVersion || null
    }));
}

async function runWorker() {
    const result = await runHeadlessSimulation({
        policyVersions: workerData.policyVersions,
        randomSeed: workerData.randomSeed,
        maxDecisions: workerData.maxDecisions,
        recordTrajectory: false
    });
    const standings = buildStandings(result);

    parentPort.postMessage({
        ok: true,
        result: {
            randomSeed: result.room.randomSeed,
            decisionCount: result.decisionCount,
            terminated: result.terminated,
            truncated: result.truncated,
            terminationReason: result.terminationReason,
            policyVersions: result.room.players.map(player => player.policyVersion),
            standings,
            gameResult: result.gameResult
                ? { ...result.gameResult, standings }
                : null
        }
    });
}

runWorker().catch(error => {
    parentPort.postMessage({
        ok: false,
        code: 'bot_match_failed',
        error: error.message
    });
});
