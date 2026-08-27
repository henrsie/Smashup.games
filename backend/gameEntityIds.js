const registry = require('../shared/gameEntityIds.json');

const ENTITY_ID_SCHEMA_VERSION = registry.schemaVersion;
const UNKNOWN_ENTITY_ID = registry.unknownId;
const FACTION_ENTITY_IDS = Object.freeze({ ...registry.factions });
const CARD_ENTITY_IDS = Object.freeze({ ...registry.cards });
const BASE_ENTITY_IDS = Object.freeze({ ...registry.bases });

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
    BASE_ENTITY_IDS,
    CARD_ENTITY_IDS,
    ENTITY_ID_SCHEMA_VERSION,
    FACTION_ENTITY_IDS,
    UNKNOWN_ENTITY_ID,
    getBaseEntityId,
    getCardEntityId,
    getFactionEntityId
};
