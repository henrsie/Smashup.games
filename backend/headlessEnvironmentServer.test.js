const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
    createHeadlessEnvironmentManager,
    getEnvironmentSummary,
    saveCompletedTrajectory
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

test('completed recorded trajectories can be saved by the environment endpoint service', async t => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'smashup-trajectories-'));
    const trajectoryDirectory = path.join(temporaryRoot, 'training-data', 'trajectories');
    const manager = createHeadlessEnvironmentManager({ idFactory: () => 'saved-environment' });
    t.after(async () => {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    });
    const created = manager.create({
        playerCount: 2,
        randomSeed: 812,
        maxDecisions: 1,
        recordTrajectory: true
    });
    const environment = manager.get(created.environmentId);

    const incomplete = await saveCompletedTrajectory(environment, {
        directory: trajectoryDirectory,
        environmentId: created.environmentId
    });
    assert.equal(incomplete.ok, false);
    assert.equal(incomplete.code, 'trajectory_not_complete');

    const transition = environment.step(0);
    assert.equal(transition.truncated, true);

    const saved = await saveCompletedTrajectory(environment, {
        directory: trajectoryDirectory,
        environmentId: created.environmentId
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.alreadySaved, false);
    assert.equal(saved.schemaVersion, 5);
    assert.equal(saved.decisionCount, 1);
    assert.equal(saved.truncated, true);
    assert.match(saved.filename, /^trajectory-.*\.json$/);

    const savedJson = JSON.parse(await fs.readFile(
        path.join(trajectoryDirectory, saved.filename),
        'utf8'
    ));
    assert.equal(savedJson.schemaVersion, 5);
    assert.equal(savedJson.metadata.eventHistorySource, 'native-v1');
    assert.equal(savedJson.entries.length, 1);

    const repeated = await saveCompletedTrajectory(environment, {
        directory: trajectoryDirectory,
        environmentId: created.environmentId
    });
    assert.equal(repeated.ok, true);
    assert.equal(repeated.alreadySaved, true);
    assert.equal(repeated.filename, saved.filename);

    manager.reset(created.environmentId, {
        randomSeed: 813,
        maxDecisions: 1,
        recordTrajectory: false
    });
    environment.step(0);
    const disabled = await saveCompletedTrajectory(environment, {
        directory: trajectoryDirectory,
        environmentId: created.environmentId
    });
    assert.equal(disabled.ok, false);
    assert.equal(disabled.code, 'trajectory_not_recorded');
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
