const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const RL_BOT_POLICY_VERSIONS = Object.freeze({
    DETERMINISTIC: 'rl_v1_deterministic',
    STOCHASTIC: 'rl_v1_stochastic'
});
const RL_BOT_POLICY_VERSION_SET = new Set(Object.values(RL_BOT_POLICY_VERSIONS));
const DEFAULT_RL_CHECKPOINT_PATH = path.resolve(
    __dirname,
    '../training-data/checkpoints/reinforce.pt'
);
const DEFAULT_RL_PYTHON_PATH = path.resolve(__dirname, '../.venv/bin/python');
const RL_POLICY_WORKER_PATH = path.resolve(__dirname, '../python/rl_policy_worker.py');

function isRlBotPolicy(policyVersion) {
    return RL_BOT_POLICY_VERSION_SET.has(policyVersion);
}

function getRlBotRuntimeConfig({
    checkpointPath = process.env.SMASHUP_RL_CHECKPOINT || DEFAULT_RL_CHECKPOINT_PATH,
    pythonPath = process.env.SMASHUP_PYTHON_BIN || process.env.PYTHON_BIN || DEFAULT_RL_PYTHON_PATH,
    existsSync = fs.existsSync
} = {}) {
    const missing = [];
    if (!existsSync(checkpointPath)) missing.push('checkpoint');
    if (!existsSync(pythonPath)) missing.push('python');
    if (!existsSync(RL_POLICY_WORKER_PATH)) missing.push('worker');
    return {
        available: missing.length === 0,
        checkpointPath,
        pythonPath,
        workerPath: RL_POLICY_WORKER_PATH,
        missing
    };
}

class RlPolicyClient {
    constructor({
        checkpointPath,
        pythonPath,
        randomSeed,
        workerPath = RL_POLICY_WORKER_PATH,
        spawnProcess = spawn
    }) {
        this.nextRequestId = 1;
        this.pendingRequests = new Map();
        this.stderr = '';
        this.closed = false;
        this.process = spawnProcess(pythonPath, [
            workerPath,
            '--checkpoint',
            checkpointPath,
            '--seed',
            String(randomSeed ?? 0)
        ], {
            cwd: path.resolve(__dirname, '..'),
            stdio: ['pipe', 'pipe', 'pipe']
        });
        this.ready = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        this.lines = readline.createInterface({ input: this.process.stdout });
        this.lines.on('line', line => this.handleLine(line));
        this.process.stdin.on('error', error => this.handleFailure(error));
        this.process.stderr.on('data', chunk => {
            this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
        });
        this.process.once('error', error => this.handleFailure(error));
        this.process.once('exit', exitCode => {
            if (!this.closed) {
                this.handleFailure(new Error(
                    `RL policy worker exited with code ${exitCode}.${this.stderr ? `\n${this.stderr}` : ''}`
                ));
            }
        });
    }

    handleLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch (error) {
            this.handleFailure(new Error(`RL policy worker returned invalid JSON: ${line}`));
            return;
        }
        if (message.ready === true) {
            this.checkpointMetadata = message;
            this.resolveReady(message);
            return;
        }
        const pending = this.pendingRequests.get(message.id);
        if (!pending) return;
        this.pendingRequests.delete(message.id);
        if (message.error) {
            pending.reject(new Error(message.error));
            return;
        }
        pending.resolve(message.actionIndex);
    }

    handleFailure(error) {
        this.rejectReady(error);
        for (const pending of this.pendingRequests.values()) pending.reject(error);
        this.pendingRequests.clear();
    }

    async chooseAction({ observation, legalActions, policyVersion }) {
        if (this.closed) throw new Error('RL policy worker is closed.');
        if (!isRlBotPolicy(policyVersion)) {
            throw new RangeError(`Unsupported RL policy version: ${policyVersion}`);
        }
        await this.ready;
        const id = this.nextRequestId;
        this.nextRequestId += 1;
        const response = new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
        });
        this.process.stdin.write(`${JSON.stringify({
            id,
            observation,
            legalActions,
            policyVersion
        })}\n`);
        return response;
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        const closedError = new Error('RL policy worker closed before inference completed.');
        for (const pending of this.pendingRequests.values()) pending.reject(closedError);
        this.pendingRequests.clear();
        this.lines.close();
        this.process.stdin.end();
        if (this.process.exitCode !== null) return;
        await new Promise(resolve => {
            const timeout = setTimeout(() => {
                this.process.kill();
                resolve();
            }, 2_000);
            timeout.unref?.();
            this.process.once('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }
}

function createRlPolicyClient(options) {
    return new RlPolicyClient(options);
}

function createRoomRlPolicyClientManager({
    getRuntimeConfig = getRlBotRuntimeConfig,
    createClient = createRlPolicyClient
} = {}) {
    const clients = new Map();

    return {
        async chooseAction({ roomId, room, observation, legalActions, policyVersion }) {
            if (!isRlBotPolicy(policyVersion)) {
                throw new RangeError(`Unsupported RL policy version: ${policyVersion}`);
            }
            let client = clients.get(roomId);
            if (!client) {
                const runtime = getRuntimeConfig();
                if (!runtime.available) {
                    throw new Error(
                        `RL bot runtime is unavailable: missing ${runtime.missing.join(', ')}.`
                    );
                }
                client = createClient({
                    checkpointPath: runtime.checkpointPath,
                    pythonPath: runtime.pythonPath,
                    randomSeed: room?.randomSeed,
                    workerPath: runtime.workerPath
                });
                clients.set(roomId, client);
            }
            return client.chooseAction({ observation, legalActions, policyVersion });
        },

        async close(roomId) {
            const client = clients.get(roomId);
            if (!client) return false;
            clients.delete(roomId);
            await client.close();
            return true;
        },

        async closeAll() {
            const openClients = [...clients.values()];
            clients.clear();
            await Promise.all(openClients.map(client => client.close()));
        },

        has(roomId) {
            return clients.has(roomId);
        }
    };
}

module.exports = {
    DEFAULT_RL_CHECKPOINT_PATH,
    DEFAULT_RL_PYTHON_PATH,
    RL_BOT_POLICY_VERSIONS,
    RL_POLICY_WORKER_PATH,
    RlPolicyClient,
    createRlPolicyClient,
    createRoomRlPolicyClientManager,
    getRlBotRuntimeConfig,
    isRlBotPolicy
};
