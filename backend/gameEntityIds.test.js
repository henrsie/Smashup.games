const test = require('node:test');
const assert = require('node:assert/strict');
const { basesData } = require('./bases.js');
const { factionsData } = require('./factions.js');
const {
    ACTION_TYPE_IDS,
    BASE_ENTITY_IDS,
    CARD_ZONE_IDS,
    CARD_ENTITY_IDS,
    CHOICE_TYPE_IDS,
    ENTITY_ID_SCHEMA_VERSION,
    EVENT_TYPE_IDS,
    FACTION_ENTITY_IDS,
    UNKNOWN_ENTITY_ID,
    getActionTypeId,
    getBaseEntityId,
    getCardZoneId,
    getCardEntityId,
    getChoiceTypeId,
    getEventTypeId,
    getFactionEntityId
} = require('./gameEntityIds.js');
const { HeadlessSimulationEnvironment } = require('./headlessSimulation.js');

function assertStableNamespace(mapping, expectedKeys) {
    assert.deepEqual(Object.keys(mapping).sort(), [...expectedKeys].sort());
    const ids = Object.values(mapping);
    assert.ok(ids.every(id => Number.isInteger(id) && id > UNKNOWN_ENTITY_ID));
    assert.equal(new Set(ids).size, ids.length);
}

test('the explicit entity registry covers every action type, faction, card, and base', () => {
    const actionTypes = [
        'play-card',
        'resolve-ability-choice',
        'use-talent',
        'draft-faction',
        'end-turn'
    ];
    const factionNames = Object.keys(factionsData);
    const eventTypes = [
        'card-played',
        'ability-choice-made',
        'talent-used',
        'faction-drafted',
        'turn-ended',
        'turn-started',
        'card-revealed',
        'card-destroyed',
        'card-moved',
        'card-returned-to-hand',
        'card-discarded',
        'card-moved-to-deck',
        'deck-shuffled',
        'base-scoring-started',
        'victory-points-awarded',
        'base-replaced',
        'base-deck-shuffled',
        'game-finished',
        'card-drawn',
        'base-ability-used',
        'base-scored'
    ];
    const cardIds = Object.values(factionsData).flatMap(faction => (
        faction.cards.map(card => card.id)
    ));
    const baseIds = basesData.map(base => base.id);

    assert.equal(ENTITY_ID_SCHEMA_VERSION, 4);
    assert.equal(UNKNOWN_ENTITY_ID, 0);
    assertStableNamespace(ACTION_TYPE_IDS, actionTypes);
    assertStableNamespace(CHOICE_TYPE_IDS, [
        'none',
        'card',
        'minion',
        'base',
        'player',
        'faction',
        'accept',
        'skip',
        'cancel',
        'finish-selection',
        'discard',
        'return',
        'hand',
        'play-extra',
        'amount'
    ]);
    assertStableNamespace(CARD_ZONE_IDS, [
        'hand',
        'deck',
        'discard',
        'board',
        'attached',
        'scoring-held',
        'pending-choice'
    ]);
    assertStableNamespace(EVENT_TYPE_IDS, eventTypes);
    assertStableNamespace(FACTION_ENTITY_IDS, factionNames);
    assertStableNamespace(CARD_ENTITY_IDS, cardIds);
    assertStableNamespace(BASE_ENTITY_IDS, baseIds);
    assert.equal(getActionTypeId('not-an-action'), UNKNOWN_ENTITY_ID);
    assert.equal(getChoiceTypeId('not-a-choice'), UNKNOWN_ENTITY_ID);
    assert.equal(getCardZoneId('not-a-zone'), UNKNOWN_ENTITY_ID);
    assert.equal(getEventTypeId('not-an-event'), UNKNOWN_ENTITY_ID);
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

    assert.equal(decision.observation.schemaVersion, 5);
    assert.equal(decision.observation.entityIdSchemaVersion, ENTITY_ID_SCHEMA_VERSION);
    assert.ok(decision.legalActions.every(action => (
        action.actionTypeId === getActionTypeId(action.type)
        && action.actionTypeId > UNKNOWN_ENTITY_ID
    )));
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
    assert.ok(cardPlayActions.every(action => action.actionTypeId === ACTION_TYPE_IDS['play-card']));
    assert.ok(cardPlayActions.every(action => action.entityIds.cardEntityId > 0));
    assert.ok(cardPlayActions
        .filter(action => Number.isInteger(action.baseIndex))
        .every(action => action.entityIds.baseEntityId > 0));
});
