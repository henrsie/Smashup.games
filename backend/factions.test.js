const test = require('node:test');
const assert = require('node:assert/strict');
const { factionsData, buildFactionDeck } = require('./factions.js');

test('every faction template has a unique non-empty string ID', () => {
    const templates = Object.values(factionsData).flatMap(faction => faction.cards);
    const cardIds = templates.map(card => card.id);

    assert.ok(cardIds.every(cardId => typeof cardId === 'string' && cardId.length > 0));
    assert.equal(new Set(cardIds).size, cardIds.length);
});

test('Tricksters contains the original 10 minions and 10 actions', () => {
    const tricksters = factionsData.Tricksters;
    const countCards = cardType => tricksters.cards
        .filter(card => card.type === cardType)
        .reduce((total, card) => total + card.count, 0);

    assert.deepEqual(
        Object.fromEntries(tricksters.cards.map(card => [card.name, card.count])),
        {
            Leprechaun: 1,
            Brownie: 2,
            Gnome: 3,
            Gremlin: 4,
            'Block the Path': 1,
            Disenchant: 2,
            'Enshrouding Mist': 2,
            'Flame Trap': 1,
            Hideout: 1,
            'Mark of Sleep': 1,
            'Pay the Piper': 1,
            'Take the Shinies': 1
        }
    );
    assert.equal(countCards('minion'), 10);
    assert.equal(countCards('action'), 10);
    assert.equal(buildFactionDeck('Tricksters', () => 0.5).length, 20);
});
