const { randomUUID } = require('node:crypto');
const express = require('express');
const {
    DEFAULT_HEADLESS_PLAYER_COUNT,
    DEFAULT_MAX_DECISIONS,
    HeadlessSimulationEnvironment
} = require('./headlessSimulation.js');

const DEFAULT_ENVIRONMENT_PORT = 3001;
const DEFAULT_ENVIRONMENT_HOST = '127.0.0.1';
const EXTERNAL_PYTHON_POLICY_VERSION = 'external-python-v1';

function createHeadlessEnvironmentManager({ idFactory = randomUUID } = {}) {
    const environments = new Map();

    return {
        create(options = {}) {
            const environmentId = idFactory();
            const environment = new HeadlessSimulationEnvironment({
                playerCount: options.playerCount ?? options.policyVersions?.length ?? DEFAULT_HEADLESS_PLAYER_COUNT,
                policyVersions: options.policyVersions,
                randomSeed: options.randomSeed,
                policyVersion: options.policyVersion || EXTERNAL_PYTHON_POLICY_VERSION,
                maxDecisions: options.maxDecisions ?? DEFAULT_MAX_DECISIONS,
                recordTrajectory: options.recordTrajectory === true
            });
            const state = environment.reset();
            environments.set(environmentId, environment);
            return { environmentId, state };
        },

        delete(environmentId) {
            return environments.delete(environmentId);
        },

        get(environmentId) {
            return environments.get(environmentId) || null;
        },

        reset(environmentId, options = {}) {
            const environment = environments.get(environmentId);
            if (!environment) return null;
            return environment.reset({
                playerCount: options.playerCount,
                policyVersions: options.policyVersions,
                randomSeed: options.randomSeed ?? options.seed,
                policyVersion: options.policyVersion,
                maxDecisions: options.maxDecisions,
                recordTrajectory: options.recordTrajectory
            });
        },

        size() {
            return environments.size;
        }
    };
}

function getEnvironmentSummary(environment) {
    const result = environment.getResult();
    return {
        roomId: result.roomId,
        randomSeed: result.room.randomSeed,
        decisionCount: result.decisionCount,
        terminated: result.terminated,
        truncated: result.truncated,
        terminationReason: result.terminationReason,
        gameResult: result.gameResult
    };
}

function createHeadlessEnvironmentApp({ manager = createHeadlessEnvironmentManager() } = {}) {
    const app = express();
    app.use(express.json({ limit: '2mb' }));

    app.get('/health', (request, response) => {
        response.status(200).json({
            status: 'ok',
            activeEnvironments: manager.size(),
            protocolVersion: 1
        });
    });

    app.post('/environments', (request, response, next) => {
        try {
            const { environmentId, state } = manager.create(request.body || {});
            response.status(201).json({ environmentId, ...state });
        } catch (error) {
            next(error);
        }
    });

    app.post('/environments/:environmentId/reset', (request, response, next) => {
        try {
            const state = manager.reset(request.params.environmentId, request.body || {});
            if (!state) {
                return response.status(404).json({
                    code: 'environment_not_found',
                    error: 'Headless environment not found.'
                });
            }
            return response.status(200).json({ environmentId: request.params.environmentId, ...state });
        } catch (error) {
            return next(error);
        }
    });

    app.post('/environments/:environmentId/step', (request, response, next) => {
        try {
            const environment = manager.get(request.params.environmentId);
            if (!environment) {
                return response.status(404).json({
                    code: 'environment_not_found',
                    error: 'Headless environment not found.'
                });
            }
            const transition = environment.step(request.body?.actionIndex);
            return response.status(200).json({
                environmentId: request.params.environmentId,
                ...transition
            });
        } catch (error) {
            return next(error);
        }
    });

    app.get('/environments/:environmentId/result', (request, response) => {
        const environment = manager.get(request.params.environmentId);
        if (!environment) {
            return response.status(404).json({
                code: 'environment_not_found',
                error: 'Headless environment not found.'
            });
        }
        return response.status(200).json({
            environmentId: request.params.environmentId,
            ...getEnvironmentSummary(environment)
        });
    });

    app.delete('/environments/:environmentId', (request, response) => {
        if (!manager.delete(request.params.environmentId)) {
            return response.status(404).json({
                code: 'environment_not_found',
                error: 'Headless environment not found.'
            });
        }
        return response.status(204).end();
    });

    app.use((error, request, response, next) => {
        if (response.headersSent) return next(error);
        const isInputError = error instanceof RangeError || error instanceof TypeError;
        return response.status(isInputError ? 400 : 409).json({
            code: isInputError ? 'invalid_request' : 'environment_error',
            error: error.message
        });
    });

    return app;
}

function startHeadlessEnvironmentServer({
    host = process.env.HEADLESS_ENV_HOST || DEFAULT_ENVIRONMENT_HOST,
    port = Number.parseInt(process.env.HEADLESS_ENV_PORT || DEFAULT_ENVIRONMENT_PORT, 10)
} = {}) {
    const app = createHeadlessEnvironmentApp();
    return app.listen(port, host, () => {
        console.log(`Headless environment server listening at http://${host}:${port}`);
    });
}

if (require.main === module) startHeadlessEnvironmentServer();

module.exports = {
    DEFAULT_ENVIRONMENT_HOST,
    DEFAULT_ENVIRONMENT_PORT,
    EXTERNAL_PYTHON_POLICY_VERSION,
    createHeadlessEnvironmentApp,
    createHeadlessEnvironmentManager,
    getEnvironmentSummary,
    startHeadlessEnvironmentServer
};
