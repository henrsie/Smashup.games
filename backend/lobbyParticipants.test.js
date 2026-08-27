const test = require('node:test');
const assert = require('node:assert/strict');
const {
    BOT_POLICY_VERSIONS,
    MAX_PLAYERS,
    addLobbyBot,
    addLobbyParticipant,
    removeLobbyBot,
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
            isBot: true,
            policyVersion: BOT_POLICY_VERSIONS.RANDOM
        },
        {
            id: 'bot-ROOM1-2',
            name: 'bot2',
            hand: [],
            deck: [],
            discardPile: [],
            online: true,
            isBot: true,
            policyVersion: BOT_POLICY_VERSIONS.RANDOM
        }
    ]);
});

test('the host can add bots with different supported policies', () => {
    const room = createLobby(1);

    const result = addLobbyBot(
        room,
        'player-1',
        'ROOM1',
        BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_1
    );
    const secondResult = addLobbyBot(
        room,
        'player-1',
        'ROOM1',
        BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_2
    );
    const invalidResult = addLobbyBot(room, 'player-1', 'ROOM1', 'unknown-policy');

    assert.equal(result.ok, true);
    assert.equal(result.participant.policyVersion, BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_1);
    assert.equal(secondResult.ok, true);
    assert.equal(secondResult.participant.policyVersion, BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_2);
    assert.equal(invalidResult.code, 'invalid_bot_policy');
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

test('removing a bot compacts the visible numbering and the next bot continues it', () => {
    const room = createLobby(1);
    addLobbyBot(room, 'player-1', 'ROOM1');
    addLobbyBot(room, 'player-1', 'ROOM1');
    addLobbyBot(room, 'player-1', 'ROOM1');

    const result = removeLobbyBot(room, 'player-1', 'bot-ROOM1-2');

    assert.equal(result.ok, true);
    assert.equal(result.participant.name, 'bot2');
    assert.deepEqual(room.players.map(player => player.name), ['Player 1', 'bot1', 'bot2']);

    const replacement = addLobbyBot(room, 'player-1', 'ROOM1');

    assert.equal(replacement.participant.name, 'bot3');
    assert.deepEqual(room.players.map(player => player.name), ['Player 1', 'bot1', 'bot2', 'bot3']);
    assert.equal(new Set(room.players.map(player => player.id)).size, room.players.length);
});

test('a non-host cannot remove bots or human seats', () => {
    const room = createLobby(1);
    addLobbyBot(room, 'player-1', 'ROOM1');

    const nonHostResult = removeLobbyBot(room, 'player-2', 'bot-ROOM1-1');
    const humanResult = removeLobbyBot(room, 'player-1', 'player-1');

    assert.equal(nonHostResult.code, 'host_required');
    assert.equal(humanResult.code, 'bot_not_found');
    assert.deepEqual(room.players.map(player => player.name), ['Player 1', 'bot1']);
});
