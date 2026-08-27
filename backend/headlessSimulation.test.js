const test = require('node:test');
const assert = require('node:assert/strict');
const {
    HeadlessSimulationEnvironment,
    MAX_HEADLESS_PLAYER_COUNT,
    createHeadlessRoom,
    runHeadlessSimulation
} = require('./headlessSimulation.js');
const { BOT_POLICY_VERSIONS } = require('./botPolicies.js');
const { normalizeRandomSeed } = require('./random.js');

test('headless rooms contain only seeded bot players', () => {
    const room = createHeadlessRoom({ playerCount: 3, randomSeed: 'simulation-test' });

    assert.equal(room.headless, true);
    assert.equal(room.gamePhase, 'drafting');
    assert.equal(room.players.length, 3);
    assert.ok(room.players.every(player => player.isBot === true));
    assert.equal(room.draftState.draftOrder.length, 6);
    assert.deepEqual(room.baseDiscardPile, []);
    assert.equal(room.randomSeed, normalizeRandomSeed('simulation-test'));
    assert.throws(
        () => createHeadlessRoom({ playerCount: MAX_HEADLESS_PLAYER_COUNT + 1 }),
        /factions are available/
    );
});

test('headless rooms assign a different policy version to each player', () => {
    const policyVersions = [
        BOT_POLICY_VERSIONS.RANDOM,
        BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_1,
        BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_2
    ];
    const room = createHeadlessRoom({ policyVersions, randomSeed: 17 });

    assert.equal(room.players.length, policyVersions.length);
    assert.deepEqual(
        room.players.map(player => player.policyVersion),
        policyVersions
    );
    assert.throws(
        () => createHeadlessRoom({ playerCount: 2, policyVersions }),
        /exactly one entry per headless player/
    );
    assert.throws(
        () => createHeadlessRoom({ policyVersions: [BOT_POLICY_VERSIONS.RANDOM, ''] }),
        /non-empty string/
    );
});

test('headless simulation dispatches each player through their configured policy', async () => {
    const policyVersions = [
        BOT_POLICY_VERSIONS.RANDOM,
        BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_1,
        BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_2
    ];
    const result = await runHeadlessSimulation({
        policyVersions,
        randomSeed: 23,
        maxDecisions: 3
    });

    assert.equal(result.truncated, true);
    assert.deepEqual(
        result.room.players.map(player => player.policyVersion),
        policyVersions
    );
    assert.deepEqual(
        result.trajectory.metadata.players.map(player => player.policyVersion),
        policyVersions
    );
});

test('reset exposes the first decision and step advances by legal action index', () => {
    const environment = new HeadlessSimulationEnvironment({
        playerCount: 3,
        maxDecisions: 100,
        recordTrajectory: true
    });
    const initial = environment.reset({ seed: 31 });

    assert.equal(initial.info.actorId, 'headless-bot-1');
    assert.equal(initial.info.randomSeed, 31);
    assert.equal(initial.info.decisionCount, 0);
    assert.equal(initial.observation.decisionType, 'draftFaction');
    assert.equal(initial.observation.stepIndex, 0);
    assert.equal(initial.legalActions.length, 7);
    assert.throws(() => environment.step(-1), /actionIndex/);
    assert.throws(() => environment.step(initial.legalActions.length), /actionIndex/);

    const chosenAction = initial.legalActions[2];
    const transition = environment.step(2);

    assert.equal(transition.reward, 0);
    assert.equal(transition.terminated, false);
    assert.equal(transition.truncated, false);
    assert.equal(transition.info.actorId, 'headless-bot-1');
    assert.equal(transition.info.nextActorId, 'headless-bot-2');
    assert.deepEqual(transition.info.action, chosenAction);
    assert.equal(transition.info.actionIndex, 2);
    assert.equal(transition.info.decisionCount, 1);
    assert.equal(transition.observation.observerPlayerId, 'headless-bot-2');
    assert.equal(transition.legalActions.length, 6);
    assert.deepEqual(environment.room.draftState.picks['headless-bot-1'], [chosenAction.factionName]);
    assert.deepEqual(environment.getResult().trajectory.entries[0].chosenAction, chosenAction);
});

test('step truncates at the decision limit and reset starts a fresh episode', () => {
    const environment = new HeadlessSimulationEnvironment({
        playerCount: 3,
        maxDecisions: 1
    });
    const firstEpisode = environment.reset({ seed: 99 });
    const transition = environment.step(0);

    assert.equal(transition.terminated, false);
    assert.equal(transition.truncated, true);
    assert.equal(transition.legalActions.length, 0);
    assert.equal(environment.getResult().terminationReason, 'decision_limit');
    assert.throws(() => environment.step(0), /episode has ended/);

    const secondEpisode = environment.reset({ seed: 99 });
    assert.equal(secondEpisode.info.decisionCount, 0);
    assert.equal(secondEpisode.info.randomSeed, firstEpisode.info.randomSeed);
    assert.deepEqual(secondEpisode.legalActions, firstEpisode.legalActions);
    assert.equal(environment.terminated, false);
    assert.equal(environment.truncated, false);
});

test('headless simulations reproduce their draft and opening state', async () => {
    const runDraft = () => runHeadlessSimulation({
        playerCount: 3,
        randomSeed: 12345,
        maxDecisions: 6
    });
    const first = await runDraft();
    const second = await runDraft();

    assert.equal(first.truncated, true);
    assert.equal(first.room.gamePhase, 'playing');
    assert.deepEqual(
        first.room.players.map(player => player.factions),
        second.room.players.map(player => player.factions)
    );
    assert.deepEqual(
        first.room.players.map(player => player.hand.map(card => card.instanceId)),
        second.room.players.map(player => player.hand.map(card => card.instanceId))
    );
    assert.deepEqual(
        first.room.activeBases.map(base => base.id),
        second.room.activeBases.map(base => base.id)
    );
    assert.equal(first.trajectory.metadata.terminationReason, 'decision_limit');
});

test('headless policies return validated indexes into legalActions', async () => {
    const result = await runHeadlessSimulation({
        playerCount: 3,
        randomSeed: 55,
        maxDecisions: 1,
        policy: ({ legalActions }) => legalActions.findIndex(action => (
            action.type === 'draft-faction' && action.factionName === 'Pirates'
        ))
    });

    assert.deepEqual(result.room.draftState.picks['headless-bot-1'], ['Pirates']);
    assert.equal(result.trajectory.entries[0].chosenActionIndex, 3);
    assert.deepEqual(
        result.trajectory.entries[0].chosenAction,
        result.trajectory.entries[0].legalActions[3]
    );

    await assert.rejects(
        runHeadlessSimulation({
            playerCount: 3,
            randomSeed: 55,
            maxDecisions: 1,
            policy: ({ legalActions }) => legalActions.length
        }),
        /invalid legal-action index/
    );
});

test('a headless game completes without socket or scoring timers', async () => {
    const result = await runHeadlessSimulation({
        playerCount: 3,
        randomSeed: 42,
        maxDecisions: 1_000
    });

    assert.equal(result.terminated, true);
    assert.equal(result.truncated, false);
    assert.equal(result.room.gamePhase, 'finished');
    assert.equal(result.gameResult.winnerName, 'bot2');
    assert.ok(result.decisionCount < 1_000);
    assert.equal(result.trajectory.entries.length, result.decisionCount);
    assert.equal(result.trajectory.metadata.randomSeed, 42);
    assert.equal(result.trajectory.metadata.terminated, true);
    assert.equal(result.trajectory.metadata.terminationReason, 'victory');
});

test('empty decks recycle so seed 380 reaches a winner instead of stalling', async () => {
    const result = await runHeadlessSimulation({
        playerCount: 3,
        randomSeed: 380,
        maxDecisions: 1_000,
        recordTrajectory: false
    });

    assert.equal(result.terminated, true);
    assert.equal(result.truncated, false);
    assert.equal(result.gameResult.winnerName, 'bot3');
    assert.ok(result.decisionCount < 1_000);
    assert.equal(result.trajectory, null);
});

test('headless simulations reject rooms containing human players', async () => {
    const room = createHeadlessRoom({ playerCount: 1, randomSeed: 7 });
    room.players[0].isBot = false;

    await assert.rejects(
        runHeadlessSimulation({ room }),
        /only bot players/
    );
});
