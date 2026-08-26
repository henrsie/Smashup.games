const test = require('node:test');
const assert = require('node:assert/strict');
const {
    MAX_PLAYERS,
    addLobbyBot,
    addLobbyParticipant,
    roomHasHumanPlayers
} = require('./server.js');

function createLobby(playerCount) {
    return {
        host: 'player-1',
        players: Array.from({ length: playerCount }, (_, index) => ({
            id: `player-${index + 1}`,
            name: `Player ${index + 1}`
        })),
        spectators: [],
        gamePhase: 'lobby'
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

test('the host can add numbered bots as normal player seats in creation order', () => {
    const room = createLobby(1);

    const firstResult = addLobbyBot(room, 'player-1', 'ROOM1');
    const secondResult = addLobbyBot(room, 'player-1', 'ROOM1');

    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.deepEqual(room.players.map(player => player.name), ['Player 1', 'bot1', 'bot2']);
    assert.deepEqual(room.players.slice(1), [
        {
            id: 'bot-ROOM1-1',
            name: 'bot1',
            hand: [],
            deck: [],
            discardPile: [],
            online: true,
            isBot: true
        },
        {
            id: 'bot-ROOM1-2',
            name: 'bot2',
            hand: [],
            deck: [],
            discardPile: [],
            online: true,
            isBot: true
        }
    ]);
});

test('only the host can add a bot', () => {
    const room = createLobby(1);

    const result = addLobbyBot(room, 'not-the-host', 'ROOM1');

    assert.equal(result.ok, false);
    assert.equal(result.code, 'host_required');
    assert.equal(room.players.length, 1);
});

test('bots cannot increase the number of player seats beyond four', () => {
    const room = createLobby(MAX_PLAYERS);

    const result = addLobbyBot(room, 'player-1', 'ROOM1');

    assert.equal(result.ok, false);
    assert.equal(result.code, 'lobby_full');
    assert.equal(room.players.length, MAX_PLAYERS);
});

test('a room with only bot seats has no human players', () => {
    const room = createLobby(1);
    addLobbyBot(room, 'player-1', 'ROOM1');

    assert.equal(roomHasHumanPlayers(room), true);

    room.players = room.players.filter(player => player.isBot === true);

    assert.equal(roomHasHumanPlayers(room), false);
});
