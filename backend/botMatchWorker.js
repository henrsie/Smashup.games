const { parentPort, workerData } = require('node:worker_threads');
const { runHeadlessSimulation } = require('./headlessSimulation.js');
const {
    createRlPolicyClient,
    getRlBotRuntimeConfig,
    isRlBotPolicy
} = require('./rlBotPolicy.js');

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
    const rlPolicyVersions = workerData.policyVersions.filter(isRlBotPolicy);
    let rlPolicyClient = null;
    let result;
    try {
        const policies = {};
        if (rlPolicyVersions.length > 0) {
            const runtime = getRlBotRuntimeConfig();
            if (!runtime.available) {
                throw new Error(`RL bot runtime is unavailable: missing ${runtime.missing.join(', ')}.`);
            }
            rlPolicyClient = createRlPolicyClient({
                checkpointPath: runtime.checkpointPath,
                pythonPath: runtime.pythonPath,
                randomSeed: workerData.randomSeed,
                workerPath: runtime.workerPath
            });
            workerData.policyVersions.forEach((policyVersion, index) => {
                if (!isRlBotPolicy(policyVersion)) return;
                policies[`headless-bot-${index + 1}`] = ({ observation, legalActions }) => (
                    rlPolicyClient.chooseAction({
                        observation,
                        legalActions,
                        policyVersion
                    })
                );
            });
        }
        result = await runHeadlessSimulation({
            policyVersions: workerData.policyVersions,
            policies,
            randomSeed: workerData.randomSeed,
            maxDecisions: workerData.maxDecisions,
            recordTrajectory: false
        });
    } finally {
        if (rlPolicyClient) await rlPolicyClient.close();
    }
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
