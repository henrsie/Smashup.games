const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createBotMatchJobManager,
    runBotMatchInWorker,
    validateBotMatchRequest
} = require('./botMatchRunner.js');
const { BOT_POLICY_VERSIONS } = require('./botPolicies.js');
const { RL_BOT_POLICY_VERSIONS } = require('./rlBotPolicy.js');

const MIXED_POLICIES = [
    BOT_POLICY_VERSIONS.RANDOM,
    BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_1,
    BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_2
];
const FOUR_BOT_POLICIES = [
    ...MIXED_POLICIES,
    BOT_POLICY_VERSIONS.FIRST_LEGAL
];

test('bot-match requests require two to four supported strategies', () => {
    assert.deepEqual(
        validateBotMatchRequest({ policyVersions: FOUR_BOT_POLICIES, randomSeed: 380 }),
        { policyVersions: FOUR_BOT_POLICIES, randomSeed: 380 }
    );
    assert.throws(
        () => validateBotMatchRequest({ policyVersions: [BOT_POLICY_VERSIONS.RANDOM] }),
        /requires between 2 and 4 bots/
    );
    assert.throws(
        () => validateBotMatchRequest({
            policyVersions: [...FOUR_BOT_POLICIES, BOT_POLICY_VERSIONS.RANDOM]
        }),
        /requires between 2 and 4 bots/
    );
    assert.throws(
        () => validateBotMatchRequest({ policyVersions: ['unknown', BOT_POLICY_VERSIONS.RANDOM] }),
        /not supported/
    );
    assert.doesNotThrow(() => validateBotMatchRequest({
        policyVersions: [BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_1, BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_1]
    }));
});

test('bot-match validation exposes RL policies only when the runtime is available', () => {
    const lineup = [
        RL_BOT_POLICY_VERSIONS.DETERMINISTIC,
        BOT_POLICY_VERSIONS.RANDOM
    ];

    assert.throws(
        () => validateBotMatchRequest(
            { policyVersions: lineup },
            { availablePolicyVersions: [BOT_POLICY_VERSIONS.RANDOM] }
        ),
        /not supported/
    );
    assert.deepEqual(
        validateBotMatchRequest(
            { policyVersions: lineup },
            { availablePolicyVersions: lineup }
        ).policyVersions,
        lineup
    );
});

test('bot-match worker returns a compact result for mixed strategies', async () => {
    const result = await runBotMatchInWorker({
        policyVersions: MIXED_POLICIES,
        randomSeed: 380
    });

    assert.equal(result.terminated, true);
    assert.equal(result.truncated, false);
    assert.ok(['bot1', 'bot2', 'bot3'].includes(result.gameResult.winnerName));
    assert.equal(
        result.standings.find(standing => standing.rank === 1)?.name,
        result.gameResult.winnerName
    );
    assert.deepEqual(result.policyVersions, MIXED_POLICIES);
    assert.deepEqual(
        result.standings.map(standing => standing.policyVersion).sort(),
        [...MIXED_POLICIES].sort()
    );
    assert.equal('room' in result, false);
    assert.equal('trajectory' in result, false);
});

test('bot-match worker supports a four-bot game', async () => {
    const result = await runBotMatchInWorker({
        policyVersions: FOUR_BOT_POLICIES,
        randomSeed: 380
    });

    assert.equal(result.terminated, true);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.policyVersions, FOUR_BOT_POLICIES);
    assert.equal(result.standings.length, 4);
    assert.deepEqual(
        result.standings.map(standing => standing.name).sort(),
        ['bot1', 'bot2', 'bot3', 'bot4']
    );
});

test('bot-match job manager limits concurrent and repeated client jobs', async () => {
    let finishFirstMatch;
    const firstMatch = new Promise(resolve => {
        finishFirstMatch = resolve;
    });
    const manager = createBotMatchJobManager({
        maxConcurrent: 1,
        runMatch: () => firstMatch
    });
    const firstRun = manager.run('client-1', { policyVersions: MIXED_POLICIES.slice(0, 2) });

    await assert.rejects(
        manager.run('client-1', { policyVersions: MIXED_POLICIES.slice(0, 2) }),
        error => error.code === 'bot_match_already_running'
    );
    await assert.rejects(
        manager.run('client-2', { policyVersions: MIXED_POLICIES.slice(0, 2) }),
        error => error.code === 'bot_match_capacity'
    );

    finishFirstMatch({ terminated: true });
    await firstRun;
    assert.equal(manager.activeCount, 0);
});
