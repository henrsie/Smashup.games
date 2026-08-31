const test = require('node:test');
const assert = require('node:assert/strict');
const {
    RL_BOT_POLICY_VERSIONS,
    createRoomRlPolicyClientManager,
    getRlBotRuntimeConfig,
    isRlBotPolicy
} = require('./rlBotPolicy.js');

test('RL bot policy versions distinguish deterministic and stochastic inference', () => {
    assert.equal(isRlBotPolicy(RL_BOT_POLICY_VERSIONS.DETERMINISTIC), true);
    assert.equal(isRlBotPolicy(RL_BOT_POLICY_VERSIONS.STOCHASTIC), true);
    assert.equal(isRlBotPolicy('greedy_heuristic_1'), false);
});

test('live rooms reuse and close one RL inference client', async () => {
    let createCount = 0;
    let closeCount = 0;
    const manager = createRoomRlPolicyClientManager({
        getRuntimeConfig: () => ({
            available: true,
            checkpointPath: '/checkpoint.pt',
            pythonPath: '/python',
            workerPath: '/worker.py',
            missing: []
        }),
        createClient: () => {
            createCount += 1;
            return {
                chooseAction: async () => 2,
                close: async () => {
                    closeCount += 1;
                }
            };
        }
    });

    const request = {
        roomId: 'ROOM1',
        room: { randomSeed: 380 },
        observation: {},
        legalActions: [{}, {}, {}],
        policyVersion: RL_BOT_POLICY_VERSIONS.STOCHASTIC
    };
    assert.equal(await manager.chooseAction(request), 2);
    assert.equal(await manager.chooseAction(request), 2);
    assert.equal(createCount, 1);
    assert.equal(manager.has('ROOM1'), true);
    assert.equal(await manager.close('ROOM1'), true);
    assert.equal(closeCount, 1);
    assert.equal(manager.has('ROOM1'), false);
});

test('RL bot availability requires both the checkpoint and Python runtime', () => {
    const available = getRlBotRuntimeConfig({
        checkpointPath: '/checkpoint.pt',
        pythonPath: '/python',
        existsSync: () => true
    });
    const missingCheckpoint = getRlBotRuntimeConfig({
        checkpointPath: '/checkpoint.pt',
        pythonPath: '/python',
        existsSync: candidatePath => candidatePath !== '/checkpoint.pt'
    });

    assert.equal(available.available, true);
    assert.deepEqual(available.missing, []);
    assert.equal(missingCheckpoint.available, false);
    assert.deepEqual(missingCheckpoint.missing, ['checkpoint']);
});
