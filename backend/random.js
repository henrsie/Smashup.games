const { randomBytes } = require('node:crypto');

const RANDOM_ALGORITHM = 'mulberry32-v1';

function systemRandom() {
    return randomBytes(4).readUInt32LE(0) / 0x1_0000_0000;
}

function generateRandomSeed() {
    return randomBytes(4).readUInt32LE(0);
}

function normalizeRandomSeed(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) return Math.trunc(seed) >>> 0;
    if (typeof seed === 'string' && /^\d+$/.test(seed.trim())) {
        return Number.parseInt(seed.trim(), 10) >>> 0;
    }

    const text = String(seed ?? '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function initializeSeededRandom(target, seed = generateRandomSeed()) {
    const normalizedSeed = normalizeRandomSeed(seed);
    target.randomAlgorithm = RANDOM_ALGORITHM;
    target.randomSeed = normalizedSeed;
    target.randomState = normalizedSeed;
    return normalizedSeed;
}

function nextSeededRandom(target) {
    if (!Number.isInteger(target?.randomState)) {
        initializeSeededRandom(target, target?.randomSeed ?? generateRandomSeed());
    }

    let value = target.randomState = (target.randomState + 0x6d2b79f5) >>> 0;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
}

function createSeededRandom(seed) {
    const state = {};
    initializeSeededRandom(state, seed);
    return () => nextSeededRandom(state);
}

module.exports = {
    RANDOM_ALGORITHM,
    createSeededRandom,
    generateRandomSeed,
    initializeSeededRandom,
    nextSeededRandom,
    normalizeRandomSeed,
    systemRandom
};
