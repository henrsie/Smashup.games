const test = require('node:test');
const assert = require('node:assert/strict');
const { basesData } = require('./bases.js');
const { factionsData } = require('./factions.js');
const {
    BASE_ENTITY_IDS,
    CARD_ENTITY_IDS,
    ENTITY_ID_SCHEMA_VERSION,
    FACTION_ENTITY_IDS,
    UNKNOWN_ENTITY_ID,
    getBaseEntityId,
    getCardEntityId,
    getFactionEntityId
} = require('./gameEntityIds.js');
const { HeadlessSimulationEnvironment } = require('./headlessSimulation.js');

function assertStableNamespace(mapping, expectedKeys) {
    assert.deepEqual(Object.keys(mapping).sort(), [...expectedKeys].sort());
    const ids = Object.values(mapping);
    assert.ok(ids.every(id => Number.isInteger(id) && id > UNKNOWN_ENTITY_ID));
    assert.equal(new Set(ids).size, ids.length);
}

test('the explicit entity registry covers every faction, card, and base', () => {
    const factionNames = Object.keys(factionsData);
    const cardIds = Object.values(factionsData).flatMap(faction => (
        faction.cards.map(card => card.id)
    ));
    const baseIds = basesData.map(base => base.id);

    assert.equal(ENTITY_ID_SCHEMA_VERSION, 1);
    assert.equal(UNKNOWN_ENTITY_ID, 0);
    assertStableNamespace(FACTION_ENTITY_IDS, factionNames);
    assertStableNamespace(CARD_ENTITY_IDS, cardIds);
    assertStableNamespace(BASE_ENTITY_IDS, baseIds);
    assert.equal(getFactionEntityId('not-a-faction'), UNKNOWN_ENTITY_ID);
    assert.equal(getCardEntityId('not-a-card'), UNKNOWN_ENTITY_ID);
    assert.equal(getBaseEntityId('not-a-base'), UNKNOWN_ENTITY_ID);
});

test('game templates carry their registered stable integer IDs', () => {
    Object.values(factionsData).forEach(faction => {
        assert.equal(faction.factionEntityId, getFactionEntityId(faction.name));
        faction.cards.forEach(card => {
            assert.equal(card.cardEntityId, getCardEntityId(card.id));
        });
    });
    basesData.forEach(base => {
        assert.equal(base.baseEntityId, getBaseEntityId(base.id));
    });
});

test('headless observations and legal actions expose stable entity IDs', () => {
    const environment = new HeadlessSimulationEnvironment({
        playerCount: 3,
        randomSeed: 31,
        maxDecisions: 100,
        recordTrajectory: false
    });
    let decision = environment.reset();

    assert.equal(decision.observation.schemaVersion, 4);
    assert.equal(decision.observation.entityIdSchemaVersion, ENTITY_ID_SCHEMA_VERSION);
    assert.ok(decision.legalActions.every(action => action.entityIds.factionEntityId > 0));

    for (let draftDecision = 0; draftDecision < 6; draftDecision += 1) {
        decision = environment.step(0);
    }

    assert.equal(decision.observation.gamePhase, 'playing');
    assert.ok(decision.observation.players.every(player => (
        player.factionEntityIds.length === 2
        && player.factionEntityIds.every(id => id > 0)
    )));
    assert.ok(decision.observation.activeBases.every(base => base.baseEntityId > 0));
    const observer = decision.observation.players.find(player => (
        player.id === decision.observation.observerPlayerId
    ));
    assert.ok(observer.hand.every(card => card.cardEntityId > 0 && card.factionEntityId > 0));

    const cardPlayActions = decision.legalActions.filter(action => action.type === 'play-card');
    assert.ok(cardPlayActions.length > 0);
    assert.ok(cardPlayActions.every(action => action.entityIds.cardEntityId > 0));
    assert.ok(cardPlayActions
        .filter(action => Number.isInteger(action.baseIndex))
        .every(action => action.entityIds.baseEntityId > 0));
});
