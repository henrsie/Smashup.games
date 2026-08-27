const test = require('node:test');
const assert = require('node:assert/strict');
const {
    RANDOM_ALGORITHM,
    createSeededRandom,
    initializeSeededRandom,
    nextSeededRandom,
    normalizeRandomSeed
} = require('./random.js');

test('seeded random generators reproduce the same sequence', () => {
    const first = createSeededRandom('training-game-42');
    const second = createSeededRandom('training-game-42');
    const different = createSeededRandom('training-game-43');
    const firstSequence = Array.from({ length: 20 }, () => first());
    const secondSequence = Array.from({ length: 20 }, () => second());
    const differentSequence = Array.from({ length: 20 }, () => different());

    assert.deepEqual(firstSequence, secondSequence);
    assert.notDeepEqual(firstSequence, differentSequence);
    assert.ok(firstSequence.every(value => value >= 0 && value < 1));
});

test('room random state is explicit, deterministic, and advances', () => {
    const firstRoom = {};
    const secondRoom = {};
    const seed = initializeSeededRandom(firstRoom, 42);
    initializeSeededRandom(secondRoom, 42);

    assert.equal(seed, 42);
    assert.equal(firstRoom.randomAlgorithm, RANDOM_ALGORITHM);
    assert.equal(firstRoom.randomSeed, 42);
    assert.equal(firstRoom.randomState, 42);
    assert.equal(nextSeededRandom(firstRoom), nextSeededRandom(secondRoom));
    assert.notEqual(firstRoom.randomState, 42);
});

test('numeric and text seeds normalize consistently', () => {
    assert.equal(normalizeRandomSeed(123), 123);
    assert.equal(normalizeRandomSeed('123'), 123);
    assert.equal(normalizeRandomSeed(-1), 0xffffffff);
    assert.equal(normalizeRandomSeed('named-seed'), normalizeRandomSeed('named-seed'));
    assert.notEqual(normalizeRandomSeed('named-seed'), normalizeRandomSeed('other-seed'));
});
