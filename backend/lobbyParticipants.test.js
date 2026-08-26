const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_PLAYERS, addLobbyParticipant } = require('./server.js');

function createLobby(playerCount) {
    return {
        players: Array.from({ length: playerCount }, (_, index) => ({
            id: `player-${index + 1}`,
            name: `Player ${index + 1}`
        })),
        spectators: []
    };
}

test('the fourth lobby participant receives the final player seat', () => {
    const room = createLobby(MAX_PLAYERS - 1);

    const result = addLobbyParticipant(room, { id: 'player-4', name: 'Player 4' });

    assert.equal(result.role, 'player');
    assert.equal(room.players.length, MAX_PLAYERS);
    assert.equal(room.spectators.length, 0);
    assert.deepEqual(room.players.at(-1), {
        id: 'player-4',
        name: 'Player 4',
        hand: [],
        deck: [],
        discardPile: [],
        online: true
    });
});

test('participants beyond four players join the lobby as spectators', () => {
    const room = createLobby(MAX_PLAYERS);

    const result = addLobbyParticipant(room, { id: 'spectator-1', name: 'Viewer' });

    assert.equal(result.role, 'spectator');
    assert.equal(room.players.length, MAX_PLAYERS);
    assert.deepEqual(room.spectators, [{ id: 'spectator-1', name: 'Viewer' }]);
});
