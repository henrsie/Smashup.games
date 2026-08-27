const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { getBotPolicy } = require('./botPolicies.js');

const MIN_BOT_MATCH_PLAYERS = 2;
const MAX_BOT_MATCH_PLAYERS = 3;
const BOT_MATCH_MAX_DECISIONS = 5_000;
const BOT_MATCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CONCURRENT_BOT_MATCHES = 2;

class BotMatchError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BotMatchError';
        this.code = code;
    }
}

function validateBotMatchRequest(payload = {}) {
    const policyVersions = payload?.policyVersions;
    if (!Array.isArray(policyVersions)
        || policyVersions.length < MIN_BOT_MATCH_PLAYERS
        || policyVersions.length > MAX_BOT_MATCH_PLAYERS) {
        throw new BotMatchError(
            'invalid_bot_count',
            `Bot Mode requires ${MIN_BOT_MATCH_PLAYERS} or ${MAX_BOT_MATCH_PLAYERS} bots.`
        );
    }
    if (policyVersions.some(policyVersion => !getBotPolicy(policyVersion))) {
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
        timeoutMs = BOT_MATCH_TIMEOUT_MS,
        WorkerClass = Worker,
        workerPath = path.resolve(__dirname, 'botMatchWorker.js')
    } = {}
) {
    const options = validateBotMatchRequest(payload);

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
        }, timeoutMs);
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
    BOT_MATCH_TIMEOUT_MS,
    BotMatchError,
    createBotMatchJobManager,
    runBotMatchInWorker,
    validateBotMatchRequest
};
