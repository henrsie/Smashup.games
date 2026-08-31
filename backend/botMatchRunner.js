const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { BOT_POLICY_VERSIONS } = require('./botPolicies.js');
const {
    RL_BOT_POLICY_VERSIONS,
    getRlBotRuntimeConfig,
    isRlBotPolicy
} = require('./rlBotPolicy.js');

const MIN_BOT_MATCH_PLAYERS = 2;
const MAX_BOT_MATCH_PLAYERS = 3;
const BOT_MATCH_MAX_DECISIONS = 5_000;
const BOT_MATCH_TIMEOUT_MS = 20_000;
const BOT_MATCH_RL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONCURRENT_BOT_MATCHES = 2;
const BUILT_IN_BOT_MATCH_POLICY_VERSIONS = Object.freeze(Object.values(BOT_POLICY_VERSIONS));

class BotMatchError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BotMatchError';
        this.code = code;
    }
}

function getAvailableBotMatchPolicyVersions() {
    const policyVersions = [...BUILT_IN_BOT_MATCH_POLICY_VERSIONS];
    if (getRlBotRuntimeConfig().available) {
        policyVersions.push(...Object.values(RL_BOT_POLICY_VERSIONS));
    }
    return policyVersions;
}

function validateBotMatchRequest(payload = {}, {
    availablePolicyVersions = getAvailableBotMatchPolicyVersions()
} = {}) {
    const policyVersions = payload?.policyVersions;
    if (!Array.isArray(policyVersions)
        || policyVersions.length < MIN_BOT_MATCH_PLAYERS
        || policyVersions.length > MAX_BOT_MATCH_PLAYERS) {
        throw new BotMatchError(
            'invalid_bot_count',
            `Bot Mode requires ${MIN_BOT_MATCH_PLAYERS} or ${MAX_BOT_MATCH_PLAYERS} bots.`
        );
    }
    const availablePolicyVersionSet = new Set(availablePolicyVersions);
    if (policyVersions.some(policyVersion => !availablePolicyVersionSet.has(policyVersion))) {
        throw new BotMatchError('invalid_bot_policy', 'One or more bot strategies are not supported.');
    }
    if (payload.randomSeed !== undefined
        && typeof payload.randomSeed !== 'string'
        && typeof payload.randomSeed !== 'number') {
        throw new BotMatchError('invalid_random_seed', 'The random seed must be text or a number.');
    }

    return {
        policyVersions: [...policyVersions],
        randomSeed: payload.randomSeed
    };
}

function runBotMatchInWorker(
    payload,
    {
        timeoutMs,
        WorkerClass = Worker,
        workerPath = path.resolve(__dirname, 'botMatchWorker.js')
    } = {}
) {
    const options = validateBotMatchRequest(payload);
    const effectiveTimeoutMs = timeoutMs ?? (
        options.policyVersions.some(isRlBotPolicy)
            ? BOT_MATCH_RL_TIMEOUT_MS
            : BOT_MATCH_TIMEOUT_MS
    );

    return new Promise((resolve, reject) => {
        const worker = new WorkerClass(workerPath, {
            workerData: {
                ...options,
                maxDecisions: BOT_MATCH_MAX_DECISIONS
            }
        });
        let settled = false;

        const cleanup = () => {
            clearTimeout(timeout);
            worker.removeAllListeners();
        };
        const settle = (callback, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(value);
        };
        const timeout = setTimeout(() => {
            worker.terminate();
            settle(
                reject,
                new BotMatchError('bot_match_timeout', 'The bot match took too long and was stopped.')
            );
        }, effectiveTimeoutMs);
        timeout.unref?.();

        worker.once('message', message => {
            if (message?.ok) {
                settle(resolve, message.result);
                return;
            }
            settle(
                reject,
                new BotMatchError(
                    message?.code || 'bot_match_failed',
                    message?.error || 'The bot match could not be completed.'
                )
            );
        });
        worker.once('error', error => {
            settle(reject, new BotMatchError('bot_match_failed', error.message));
        });
        worker.once('exit', exitCode => {
            if (exitCode !== 0) {
                settle(
                    reject,
                    new BotMatchError('bot_match_failed', 'The bot match worker stopped unexpectedly.')
                );
            }
        });
    });
}

function createBotMatchJobManager({
    runMatch = runBotMatchInWorker,
    maxConcurrent = DEFAULT_MAX_CONCURRENT_BOT_MATCHES
} = {}) {
    const activeClients = new Set();

    return {
        async run(clientId, payload) {
            const options = validateBotMatchRequest(payload);
            if (activeClients.has(clientId)) {
                throw new BotMatchError(
                    'bot_match_already_running',
                    'You already have a bot match running.'
                );
            }
            if (activeClients.size >= maxConcurrent) {
                throw new BotMatchError(
                    'bot_match_capacity',
                    'The simulation server is busy. Please try again shortly.'
                );
            }

            activeClients.add(clientId);
            try {
                return await runMatch(options);
            } finally {
                activeClients.delete(clientId);
            }
        },

        get activeCount() {
            return activeClients.size;
        }
    };
}

module.exports = {
    BOT_MATCH_MAX_DECISIONS,
    BOT_MATCH_RL_TIMEOUT_MS,
    BOT_MATCH_TIMEOUT_MS,
    BotMatchError,
    createBotMatchJobManager,
    getAvailableBotMatchPolicyVersions,
    runBotMatchInWorker,
    validateBotMatchRequest
};
