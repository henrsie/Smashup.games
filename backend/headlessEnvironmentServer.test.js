const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createHeadlessEnvironmentManager,
    getEnvironmentSummary
} = require('./headlessEnvironmentServer.js');
const { BOT_POLICY_VERSIONS } = require('./botPolicies.js');

test('Python bridge manager exposes reset, validated index steps, results, and cleanup', () => {
    const manager = createHeadlessEnvironmentManager({ idFactory: () => 'test-environment' });
    const created = manager.create({
        playerCount: 3,
        randomSeed: 123,
        maxDecisions: 10,
        recordTrajectory: false
    });

    assert.equal(created.environmentId, 'test-environment');
    assert.equal(created.state.observation.decisionType, 'draftFaction');
    assert.equal(created.state.legalActions.length, 7);

    const environment = manager.get(created.environmentId);
    assert.throws(
        () => environment.step(created.state.legalActions.length),
        /actionIndex/
    );

    const transition = environment.step(0);
    assert.equal(transition.info.actionIndex, 0);
    assert.equal(transition.info.decisionCount, 1);

    const result = getEnvironmentSummary(environment);
    assert.equal(result.decisionCount, 1);
    assert.equal(result.randomSeed, 123);

    const reset = manager.reset(created.environmentId, { randomSeed: 456 });
    assert.equal(reset.info.randomSeed, 456);
    assert.equal(reset.info.decisionCount, 0);

    assert.equal(manager.delete(created.environmentId), true);
    assert.equal(manager.get(created.environmentId), null);
});

test('Python bridge manager accepts per-player policy versions', () => {
    const policyVersions = [
        BOT_POLICY_VERSIONS.RANDOM,
        BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_1
    ];
    const manager = createHeadlessEnvironmentManager({ idFactory: () => 'mixed-policy-environment' });
    const created = manager.create({ policyVersions, randomSeed: 321 });
    const environment = manager.get(created.environmentId);

    assert.equal(environment.room.players.length, 2);
    assert.deepEqual(
        environment.room.players.map(player => player.policyVersion),
        policyVersions
    );
});
