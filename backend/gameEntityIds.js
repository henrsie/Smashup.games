const registry = require('../shared/gameEntityIds.json');

const ENTITY_ID_SCHEMA_VERSION = registry.schemaVersion;
const UNKNOWN_ENTITY_ID = registry.unknownId;
const ACTION_TYPE_IDS = Object.freeze({ ...registry.actionTypes });
const CHOICE_TYPE_IDS = Object.freeze({ ...registry.choiceTypes });
const CARD_ZONE_IDS = Object.freeze({ ...registry.cardZones });
const EVENT_TYPE_IDS = Object.freeze({ ...registry.eventTypes });
const FACTION_ENTITY_IDS = Object.freeze({ ...registry.factions });
const CARD_ENTITY_IDS = Object.freeze({ ...registry.cards });
const BASE_ENTITY_IDS = Object.freeze({ ...registry.bases });

function getActionTypeId(actionType) {
    return ACTION_TYPE_IDS[actionType] ?? UNKNOWN_ENTITY_ID;
}

function getChoiceTypeId(choiceType) {
    return CHOICE_TYPE_IDS[choiceType] ?? UNKNOWN_ENTITY_ID;
}

function getCardZoneId(cardZone) {
    return CARD_ZONE_IDS[cardZone] ?? UNKNOWN_ENTITY_ID;
}

function getEventTypeId(eventType) {
    return EVENT_TYPE_IDS[eventType] ?? UNKNOWN_ENTITY_ID;
}

function getFactionEntityId(faction) {
    const factionName = typeof faction === 'string' ? faction : faction?.name;
    return FACTION_ENTITY_IDS[factionName] ?? UNKNOWN_ENTITY_ID;
}

function getCardEntityId(card) {
    const cardId = typeof card === 'string' ? card : card?.cardId || card?.id;
    return CARD_ENTITY_IDS[cardId] ?? UNKNOWN_ENTITY_ID;
}

function getBaseEntityId(base) {
    const baseId = typeof base === 'string' ? base : base?.id;
    return BASE_ENTITY_IDS[baseId] ?? UNKNOWN_ENTITY_ID;
}

module.exports = {
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
};
