const { factionsData } = require('./factions.js');
const {
    MAX_PLAYERS,
    executeGameAction,
    finalizeRoomTrajectory,
    getBotDecisionActorId,
    getLegalActions,
    getNormalizedVictoryPointReward,
    getPlayerObservation,
    getRoomTrajectory,
    recordTrajectoryDecision
} = require('./server.js');
const {
    BOT_POLICY_VERSIONS,
    getBotPolicy
} = require('./botPolicies.js');
const {
    generateRandomSeed,
    initializeSeededRandom,
    nextSeededRandom
} = require('./random.js');

const FACTIONS_PER_PLAYER = 2;
const MAX_HEADLESS_PLAYER_COUNT = Math.min(
    MAX_PLAYERS,
    Math.floor(Object.keys(factionsData).length / FACTIONS_PER_PLAYER)
);
const DEFAULT_HEADLESS_PLAYER_COUNT = MAX_HEADLESS_PLAYER_COUNT;
const DEFAULT_MAX_DECISIONS = 10_000;
const DEFAULT_HEADLESS_POLICY_VERSION = BOT_POLICY_VERSIONS.RANDOM;

function validatePolicyVersions(policyVersions, playerCount) {
    if (policyVersions === undefined) return;
    if (!Array.isArray(policyVersions) || policyVersions.length !== playerCount) {
        throw new RangeError('policyVersions must contain exactly one entry per headless player.');
    }
    if (policyVersions.some(version => typeof version !== 'string' || version.trim().length === 0)) {
        throw new TypeError('Every policyVersions entry must be a non-empty string.');
    }
}

function createHeadlessRoom({
    policyVersions,
    playerCount = policyVersions?.length ?? DEFAULT_HEADLESS_PLAYER_COUNT,
    randomSeed = generateRandomSeed(),
    policyVersion = DEFAULT_HEADLESS_POLICY_VERSION
} = {}) {
    if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > MAX_HEADLESS_PLAYER_COUNT) {
        throw new RangeError(
            `Headless simulations currently require between 1 and ${MAX_HEADLESS_PLAYER_COUNT} bots `
            + `because ${Object.keys(factionsData).length} factions are available.`
        );
    }
    validatePolicyVersions(policyVersions, playerCount);

    const players = Array.from({ length: playerCount }, (_, index) => ({
        id: `headless-bot-${index + 1}`,
        name: `bot${index + 1}`,
        hand: [],
        deck: [],
        discardPile: [],
        factions: [],
        isBot: true,
        online: true,
        policyVersion: policyVersions?.[index] || policyVersion,
        vp: 0
    }));
    const draftOrder = [...players, ...[...players].reverse()].map(player => player.id);
    const timestamp = new Date().toISOString();
    const room = {
        headless: true,
        host: players[0].id,
        createdAt: timestamp,
        gameStartedAt: timestamp,
        botPolicyVersion: policyVersion,
        players,
        spectators: [],
        gamePhase: 'drafting',
        draftState: {
            availableFactions: Object.keys(factionsData),
            draftOrder,
            currentTurnIndex: 0,
            picks: Object.fromEntries(players.map(player => [player.id, []]))
        },
        activeBases: [],
        baseDeck: [],
        baseDiscardPile: [],
        battleLog: [],
        structuredEvents: [],
        nextStructuredEventNumber: 0,
        chatMessages: [],
        pendingAbility: null,
        temporaryEffects: [],
        triggerQueue: []
    };
    initializeSeededRandom(room, randomSeed);
    return room;
}

function getHeadlessPolicy(policy, policies, actorId, room) {
    if (policies?.[actorId]) return policies[actorId];
    if (policy) return policy;
    const player = room.players.find(candidate => candidate.id === actorId);
    return getBotPolicy(player?.policyVersion || room.botPolicyVersion);
}

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function validateHeadlessRoom(room) {
    if (!Array.isArray(room?.players) || room.players.length === 0
        || room.players.some(player => player.isBot !== true)) {
        throw new Error('A headless simulation room must contain only bot players.');
    }
}

class HeadlessSimulationEnvironment {
    constructor({
        policyVersions,
        playerCount = policyVersions?.length ?? DEFAULT_HEADLESS_PLAYER_COUNT,
        randomSeed,
        policyVersion = DEFAULT_HEADLESS_POLICY_VERSION,
        maxDecisions = DEFAULT_MAX_DECISIONS,
        recordTrajectory = true
    } = {}) {
        this.defaultOptions = {
            playerCount,
            policyVersions,
            randomSeed,
            policyVersion,
            maxDecisions,
            recordTrajectory
        };
        this.room = null;
        this.roomId = null;
        this.currentDecision = null;
        this.lastActionResult = null;
        this.decisionCount = 0;
        this.terminated = false;
        this.truncated = false;
        this.recordTrajectory = recordTrajectory;
        this.maxDecisions = maxDecisions;
        this.savedTrajectoryExport = null;
    }

    reset({
        room: suppliedRoom,
        roomId,
        playerCount = this.defaultOptions.playerCount,
        policyVersions = this.defaultOptions.policyVersions,
        seed,
        randomSeed = seed ?? this.defaultOptions.randomSeed,
        policyVersion = this.defaultOptions.policyVersion,
        maxDecisions = this.defaultOptions.maxDecisions,
        recordTrajectory = this.defaultOptions.recordTrajectory
    } = {}) {
        if (!Number.isInteger(maxDecisions) || maxDecisions < 1) {
            throw new RangeError('maxDecisions must be a positive integer.');
        }

        const room = suppliedRoom || createHeadlessRoom({
            playerCount,
            policyVersions,
            randomSeed,
            policyVersion
        });
        validateHeadlessRoom(room);
        if (suppliedRoom && policyVersions !== undefined) {
            validatePolicyVersions(policyVersions, room.players.length);
            room.players.forEach((player, index) => {
                player.policyVersion = policyVersions[index];
            });
        }
        room.headless = true;
        room.botPolicyVersion ||= policyVersion;
        if (suppliedRoom) {
            delete room.rlTrajectory;
            delete room.decisionTracker;
        }
        if (!Number.isInteger(room.randomState) || randomSeed !== undefined) {
            initializeSeededRandom(room, randomSeed ?? room.randomSeed ?? generateRandomSeed());
        }

        this.room = room;
        this.roomId = roomId || `headless-${room.randomSeed}`;
        this.currentDecision = null;
        this.lastActionResult = null;
        this.decisionCount = 0;
        this.terminated = room.gamePhase === 'finished';
        this.truncated = false;
        this.recordTrajectory = recordTrajectory;
        this.maxDecisions = maxDecisions;
        this.savedTrajectoryExport = null;

        if (this.terminated) {
            return {
                observation: null,
                legalActions: [],
                info: this.createInfo({ actorId: null })
            };
        }

        this.currentDecision = this.buildCurrentDecision();
        return this.exposeCurrentDecision();
    }

    buildCurrentDecision() {
        const actorId = getBotDecisionActorId(this.room);
        if (!actorId) {
            throw new Error(`Headless simulation stalled during the ${this.room.gamePhase} phase.`);
        }
        const legalActions = getLegalActions(this.room, actorId);
        if (legalActions.length === 0) {
            throw new Error(`No legal actions are available for ${actorId}.`);
        }
        return {
            actorId,
            observation: getPlayerObservation(this.room, actorId),
            legalActions
        };
    }

    exposeCurrentDecision() {
        return {
            observation: cloneJson(this.currentDecision.observation),
            legalActions: cloneJson(this.currentDecision.legalActions),
            info: this.createInfo({ actorId: this.currentDecision.actorId })
        };
    }

    createInfo({ actorId, ...extra } = {}) {
        return {
            roomId: this.roomId,
            randomSeed: this.room?.randomSeed ?? null,
            decisionCount: this.decisionCount,
            actorId: actorId ?? null,
            resolutionId: this.currentDecision?.observation?.resolutionId || null,
            decisionType: this.currentDecision?.observation?.decisionType || null,
            stepIndex: this.currentDecision?.observation?.stepIndex ?? null,
            ...extra
        };
    }

    chooseBuiltInPolicyAction(policyVersion) {
        if (!this.room) throw new Error('Call reset() before choosing an action.');
        if (this.terminated || this.truncated || !this.currentDecision) {
            throw new Error('Cannot choose an action after the episode has ended.');
        }
        const policy = getBotPolicy(policyVersion);
        if (!policy) throw new RangeError(`Unsupported built-in bot policy: ${policyVersion}`);

        const { actorId, observation, legalActions } = this.currentDecision;
        const actionIndex = policy({
            actorId,
            legalActions,
            observation,
            random: () => nextSeededRandom(this.room),
            room: this.room,
            roomId: this.roomId
        });
        if (!Number.isInteger(actionIndex)
            || actionIndex < 0
            || actionIndex >= legalActions.length) {
            throw new Error(`Built-in policy ${policyVersion} selected an invalid action index.`);
        }
        return {
            actionIndex,
            actorId,
            policyVersion
        };
    }

    step(actionIndex) {
        if (!this.room) throw new Error('Call reset() before step().');
        if (this.terminated || this.truncated) {
            throw new Error('Cannot call step() after the episode has ended. Call reset() first.');
        }
        if (!Number.isInteger(actionIndex)
            || actionIndex < 0
            || actionIndex >= this.currentDecision.legalActions.length) {
            throw new RangeError(`actionIndex must be between 0 and ${this.currentDecision.legalActions.length - 1}.`);
        }

        const { actorId, observation, legalActions } = this.currentDecision;
        const chosenAction = legalActions[actionIndex];
        const victoryPointsBefore = Object.fromEntries(this.room.players.map(player => [
            player.id,
            Number.isFinite(player.vp) ? player.vp : 0
        ]));
        const actionResult = executeGameAction({
            room: this.room,
            roomId: this.roomId,
            actorId,
            action: chosenAction,
            scheduleAction: callback => {
                callback();
                return null;
            },
            roomStillExists: () => true
        });
        if (!actionResult.ok) {
            throw new Error(`Action ${this.decisionCount} failed for ${actorId}: ${actionResult.error}`);
        }
        this.lastActionResult = actionResult;

        if (this.recordTrajectory) {
            recordTrajectoryDecision({
                room: this.room,
                roomId: this.roomId,
                playerId: actorId,
                observation,
                legalActions,
                chosenAction,
                chosenActionIndex: actionIndex
            });
        }
        this.decisionCount += 1;
        this.terminated = this.room.gamePhase === 'finished';
        this.truncated = !this.terminated && this.decisionCount >= this.maxDecisions;
        if (this.recordTrajectory && this.truncated) {
            finalizeRoomTrajectory(this.room, {
                truncated: true,
                terminationReason: 'decision_limit',
                cloneResult: false
            });
        }

        const victoryPointChangesByPlayer = Object.fromEntries(this.room.players.map(player => [
            player.id,
            (Number.isFinite(player.vp) ? player.vp : 0) - (victoryPointsBefore[player.id] || 0)
        ]));
        const vpRewardsByPlayer = Object.fromEntries(this.room.players.map(player => [
            player.id,
            getNormalizedVictoryPointReward(0, victoryPointChangesByPlayer[player.id])
        ]));
        const terminalRewardsByPlayer = this.terminated
            ? cloneJson(this.room.terminalRewards || {})
            : Object.fromEntries(this.room.players.map(player => [player.id, 0]));
        const rewardsByPlayer = Object.fromEntries(this.room.players.map(player => [
            player.id,
            vpRewardsByPlayer[player.id] + (terminalRewardsByPlayer[player.id] || 0)
        ]));

        let nextObservation;
        let nextLegalActions;
        let nextActorId = null;
        if (this.terminated) {
            this.currentDecision = null;
            nextObservation = getPlayerObservation(this.room, actorId);
            nextLegalActions = [];
        } else if (this.truncated) {
            nextActorId = getBotDecisionActorId(this.room);
            this.currentDecision = null;
            nextObservation = nextActorId
                ? getPlayerObservation(this.room, nextActorId)
                : getPlayerObservation(this.room, actorId);
            nextLegalActions = [];
        } else {
            this.currentDecision = this.buildCurrentDecision();
            nextActorId = this.currentDecision.actorId;
            nextObservation = cloneJson(this.currentDecision.observation);
            nextLegalActions = cloneJson(this.currentDecision.legalActions);
        }

        return {
            observation: nextObservation,
            legalActions: nextLegalActions,
            reward: rewardsByPlayer[actorId] || 0,
            terminated: this.terminated,
            truncated: this.truncated,
            info: this.createInfo({
                action: cloneJson(chosenAction),
                actionIndex,
                actorId,
                decisionType: observation.decisionType,
                nextActorId,
                nextDecisionType: nextObservation?.decisionType || null,
                nextResolutionId: nextObservation?.resolutionId || null,
                nextStepIndex: nextObservation?.stepIndex ?? null,
                resolutionId: observation.resolutionId,
                rewardsByPlayer,
                stepIndex: observation.stepIndex,
                terminalRewardsByPlayer,
                victoryPointChangesByPlayer,
                vpRewardsByPlayer
            })
        };
    }

    getResult() {
        if (!this.room) return null;
        return {
            room: this.room,
            roomId: this.roomId,
            decisionCount: this.decisionCount,
            terminated: this.terminated,
            truncated: this.truncated,
            terminationReason: this.terminated ? 'victory' : this.truncated ? 'decision_limit' : null,
            gameResult: this.room.gameResult || null,
            trajectory: this.recordTrajectory
                ? getRoomTrajectory(this.room, { clone: false })
                : null
        };
    }
}

async function runHeadlessSimulation({
    room: suppliedRoom,
    roomId,
    policyVersions,
    playerCount = policyVersions?.length ?? DEFAULT_HEADLESS_PLAYER_COUNT,
    randomSeed,
    policy,
    policies,
    policyVersion = DEFAULT_HEADLESS_POLICY_VERSION,
    maxDecisions = DEFAULT_MAX_DECISIONS,
    recordTrajectory = true,
    onDecision
} = {}) {
    const environment = new HeadlessSimulationEnvironment({
        playerCount,
        policyVersions,
        randomSeed,
        policyVersion,
        maxDecisions,
        recordTrajectory
    });
    let decisionState = environment.reset({ room: suppliedRoom, roomId });

    while (!environment.terminated && !environment.truncated) {
        const actorId = decisionState.info.actorId;
        const { legalActions, observation } = decisionState;
        const selectedPolicy = getHeadlessPolicy(policy, policies, actorId, environment.room);
        if (typeof selectedPolicy !== 'function') {
            throw new Error(`Unsupported headless bot policy: ${environment.room.botPolicyVersion}`);
        }
        const actionIndex = await selectedPolicy({
            actorId,
            legalActions,
            observation,
            random: () => nextSeededRandom(environment.room),
            room: environment.room,
            roomId: environment.roomId
        });
        if (!Number.isInteger(actionIndex)
            || actionIndex < 0
            || actionIndex >= legalActions.length) {
            throw new Error(`The policy for ${actorId} selected an invalid legal-action index.`);
        }
        const chosenAction = legalActions[actionIndex];
        const transition = environment.step(actionIndex);
        if (onDecision) {
            await onDecision({
                action: chosenAction,
                actorId,
                decisionCount: environment.decisionCount,
                result: environment.lastActionResult,
                room: environment.room,
                transition
            });
        }
        decisionState = transition;
    }
    return environment.getResult();
}

async function runFromCommandLine() {
    const seed = process.argv[2] ?? generateRandomSeed();
    const policyVersion = process.argv[3] || DEFAULT_HEADLESS_POLICY_VERSION;
    const result = await runHeadlessSimulation({
        policyVersion,
        randomSeed: seed,
        recordTrajectory: false
    });
    const summary = {
        roomId: result.roomId,
        randomSeed: result.room.randomSeed,
        policyVersion,
        decisionCount: result.decisionCount,
        terminated: result.terminated,
        truncated: result.truncated,
        terminationReason: result.terminationReason,
        winner: result.gameResult?.winnerName || null,
        standings: result.gameResult?.standings || []
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
    runFromCommandLine().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    DEFAULT_HEADLESS_PLAYER_COUNT,
    DEFAULT_MAX_DECISIONS,
    MAX_HEADLESS_PLAYER_COUNT,
    HeadlessSimulationEnvironment,
    createHeadlessRoom,
    runHeadlessSimulation
};
