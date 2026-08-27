const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { buildBaseDeck } = require('./bases.js');
const { factionsData, buildFactionDeck } = require('./factions.js');
const { getTriggeredEffects } = require('./abilityQueue.js');
const { createBotMatchJobManager } = require('./botMatchRunner.js');
const {
    ENTITY_ID_SCHEMA_VERSION,
    UNKNOWN_ENTITY_ID,
    getBaseEntityId,
    getCardEntityId,
    getFactionEntityId
} = require('./gameEntityIds.js');
const {
    BOT_POLICY_VERSIONS,
    chooseGreedyHeuristic1ActionIndex,
    chooseGreedyHeuristic2ActionIndex,
    getBotPolicy
} = require('./botPolicies.js');
const {
    RANDOM_ALGORITHM,
    generateRandomSeed,
    initializeSeededRandom,
    nextSeededRandom,
    systemRandom
} = require('./random.js');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const allowedOrigins = (
    process.env.CLIENT_ORIGIN || 'http://localhost:5173'
)
    .split(',')
    .map(origin => origin.trim());

const SOCKET_CORS_OPTIONS = {
    origin: allowedOrigins
};
const MAX_PLAYERS = 4;
const MAX_HAND_SIZE = 10;
const MAX_CHAT_HISTORY = 100;
const MAX_CHAT_MESSAGE_LENGTH = 500;
const BOT_ACTION_DELAY_MS = 600;
const MAX_CONSECUTIVE_BOT_ACTIONS = 100;
const DISCONNECT_GRACE_PERIOD_MS = 10_000;
const TRAJECTORY_SCHEMA_VERSION = 4;
const OBSERVATION_SCHEMA_VERSION = 4;
const DEFAULT_BOT_POLICY_VERSION = BOT_POLICY_VERSIONS.RANDOM;
const WINNING_VICTORY_POINTS = 15;
const WIN_REWARD = 1;
const LOSS_REWARD = -1;
const createInitialTurnState = () => ({
    actionPlayed: false,
    minionPlayed: false,
    actionsPlayed: 0,
    minionsPlayed: 0,
    extraActionPlays: 0,
    extraMinionPlays: [],
    ongoingDiscardMinionPlayed: false,
    ongoingAbilityUses: {},
    talentUses: {}
});

const app = express();

app.get('/health', (request, response) => {
    response.status(200).json({ status: 'ok' });
});

if (process.env.NODE_ENV === 'production') {
    const frontendDistPath = path.resolve(__dirname, '../frontend/dist');

    app.use(express.static(frontendDistPath));

    app.get(/^(?!\/socket\.io\/).*/, (request, response) => {
        response.sendFile(path.join(frontendDistPath, 'index.html'));
    });
}

const server = http.createServer(app);
const io = new Server(server, {
    cors: SOCKET_CORS_OPTIONS
});

// Store active rooms in memory
const rooms = {};
// Keep track of active disconnection timers: playerId -> NodeJS.Timeout
const disconnectTimers = {};
const botMatchJobManager = createBotMatchJobManager();
const botTurnController = createBotTurnController({
    getRoom: roomId => rooms[roomId],
    executeAction: ({ room, roomId, actorId, action }) => executeGameAction({
        room,
        roomId,
        actorId,
        action,
        emitState: emitGameState,
        emitRoomEvent: (targetRoomId, event, payload) => {
            io.to(targetRoomId).emit(event, payload);
        },
        roomStillExists: () => rooms[roomId] === room
    }),
    onError: ({ roomId, actorId, error }) => {
        console.error(`Bot controller error in ${roomId} for ${actorId}: ${error.message}`);
    }
});

function addLobbyParticipant(room, participant) {
    if (!room.spectators) room.spectators = [];

    if (room.players.length >= MAX_PLAYERS) {
        const spectator = { id: participant.id, name: participant.name };
        room.spectators.push(spectator);
        return { role: 'spectator', participant: spectator };
    }

    const player = {
        id: participant.id,
        name: participant.name,
        hand: [],
        deck: [],
        discardPile: [],
        online: true
    };
    room.players.push(player);
    return { role: 'player', participant: player };
}

function addLobbyBot(
    room,
    requesterId,
    roomId = 'ROOM',
    policyVersion = DEFAULT_BOT_POLICY_VERSION
) {
    if (!room) return failGameAction('room_not_found', 'Room not found.');
    if (room.gamePhase !== 'lobby') {
        return failGameAction('invalid_phase', 'Bots can only be added while the game is in the lobby.');
    }
    if (room.host !== requesterId) {
        return failGameAction('host_required', 'Only the host can add bots.');
    }
    if (room.players.length >= MAX_PLAYERS) {
        return failGameAction('lobby_full', `A game can have at most ${MAX_PLAYERS} players.`);
    }
    if (!getBotPolicy(policyVersion)) {
        return failGameAction('invalid_bot_policy', 'That bot strategy is not supported.');
    }

    const botNumber = room.players.filter(player => player.isBot === true).length + 1;
    let botIdNumber = Number.isInteger(room.nextBotIdNumber)
        ? room.nextBotIdNumber
        : Number.isInteger(room.nextBotNumber)
            ? room.nextBotNumber
            : 1;
    while (room.players.some(player => player.id === `bot-${roomId}-${botIdNumber}`)) {
        botIdNumber += 1;
    }

    const bot = {
        id: `bot-${roomId}-${botIdNumber}`,
        name: `bot${botNumber}`,
        hand: [],
        deck: [],
        discardPile: [],
        online: true,
        isBot: true,
        policyVersion
    };

    room.nextBotIdNumber = botIdNumber + 1;
    room.players.push(bot);
    return { ok: true, role: 'player', participant: bot };
}

function renumberLobbyBots(room) {
    room.players
        .filter(player => player.isBot === true)
        .forEach((bot, index) => {
            bot.name = `bot${index + 1}`;
        });
}

function removeLobbyBot(room, requesterId, botId) {
    if (!room) return failGameAction('room_not_found', 'Room not found.');
    if (room.gamePhase !== 'lobby') {
        return failGameAction('invalid_phase', 'Bots can only be removed while the game is in the lobby.');
    }
    if (room.host !== requesterId) {
        return failGameAction('host_required', 'Only the host can remove bots.');
    }

    const botIndex = room.players.findIndex(player => player.id === botId && player.isBot === true);
    if (botIndex === -1) {
        return failGameAction('bot_not_found', 'That bot is not in this lobby.');
    }

    const [bot] = room.players.splice(botIndex, 1);
    renumberLobbyBots(room);
    return { ok: true, participant: bot };
}

function getNextHumanHostId(room) {
    return room.players.find(player => player.isBot !== true)?.id || null;
}

function roomHasHumanPlayers(room) {
    return room.players.some(player => player.isBot !== true);
}

function destroyRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return false;

    finalizeRoomTrajectory(room, {
        truncated: true,
        terminationReason: 'room_closed',
        cloneResult: false
    });
    room.players.forEach(player => {
        if (!disconnectTimers[player.id]) return;
        clearTimeout(disconnectTimers[player.id]);
        delete disconnectTimers[player.id];
    });
    botTurnController.stop(roomId);
    delete rooms[roomId];
    return true;
}

function removeFinishedGamePlayer(roomId, playerId) {
    const room = rooms[roomId];
    if (!room) return false;
    room.players = room.players.filter(player => player.id !== playerId);
    if (disconnectTimers[playerId]) {
        clearTimeout(disconnectTimers[playerId]);
        delete disconnectTimers[playerId];
    }

    if (!roomHasHumanPlayers(room)) {
        destroyRoom(roomId);
        return true;
    }
    if (room.host === playerId) room.host = getNextHumanHostId(room);
    io.to(roomId).emit('update-players', {
        players: room.players,
        spectators: room.spectators || [],
        host: room.host
    });
    return true;
}

function generateRoomId() {
    let roomId;
    do {
        roomId = Math.floor(systemRandom() * (36 ** 5))
            .toString(36)
            .padStart(5, '0')
            .toUpperCase();
    } while (rooms[roomId]);
    return roomId;
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('run-bot-match', async (payload = {}) => {
        try {
            const result = await botMatchJobManager.run(socket.id, payload);
            if (socket.connected) socket.emit('bot-match-completed', result);
        } catch (error) {
            if (socket.connected) {
                socket.emit('bot-match-failed', {
                    code: error.code || 'bot_match_failed',
                    error: error.message || 'The bot match could not be completed.'
                });
            }
        }
    });

    socket.on('create-room', ({ playerName, randomSeed } = {}) => {
        const roomId = generateRoomId();
        const room = {
            host: socket.id,
            createdAt: new Date().toISOString(),
            botPolicyVersion: DEFAULT_BOT_POLICY_VERSION,
            players: [{ id: socket.id, name: playerName, hand: [], deck: [], discardPile: [], online: true }],
            spectators: [],
            nextBotIdNumber: 1,
            gamePhase: 'lobby',
            baseDiscardPile: [],
            pendingAbility: null,
            temporaryEffects: [],
            chatMessages: []
        };
        initializeSeededRandom(room, randomSeed ?? generateRandomSeed());
        rooms[roomId] = room;

        socket.join(roomId);
        socket.emit('room-created', {
            roomId,
            players: rooms[roomId].players,
            spectators: rooms[roomId].spectators,
            host: rooms[roomId].host,
            role: 'player'
        });
        socket.emit('chat-history', { messages: [] });
    });
    socket.on('join-room', ({ roomId, playerName }) => {
        const formattedRoomId = roomId.trim().toUpperCase();
        const room = rooms[formattedRoomId];

        if (room) {
            const exactName = playerName.trim();

            // 1. Check if an existing ACTIVE or OFFLINE player is reconnecting with the exact same name
            const existingPlayer = room.players.find(p => p.isBot !== true && p.name === exactName);

            if (room.gamePhase && room.gamePhase !== 'lobby' && existingPlayer) {
                // Clear any active kick timer since they returned!
                if (disconnectTimers[existingPlayer.id]) {
                    clearTimeout(disconnectTimers[existingPlayer.id]);
                    delete disconnectTimers[existingPlayer.id];
                }

                existingPlayer.id = socket.id;
                existingPlayer.online = true;
                socket.join(formattedRoomId);
                socket.emit('chat-history', { messages: room.chatMessages || [] });

                if (room.gamePhase === 'drafting') {
                    socket.emit('draft-started', {
                        roomId: formattedRoomId,
                        draftState: sanitizeDraftState(room.draftState),
                        players: room.players,
                        spectators: room.spectators || []
                    });
                } else {
                    socket.emit('game-started', {
                        roomId: formattedRoomId,
                        players: room.players,
                        activeBases: room.activeBases,
                        spectators: room.spectators || [],
                        currentTurnPlayerId: room.currentTurnPlayerId,
                        turnState: room.turnState,
                        gamePhase: room.gamePhase,
                        battleLog: room.battleLog,
                        gameResult: room.gameResult || null
                    });
                }

                io.to(formattedRoomId).emit('update-players', { players: room.players, spectators: room.spectators || [], host: room.host });
                return;
            }

            // 2. If the game has already started and they are NOT an active player -> Spectator
            if (room.gamePhase && room.gamePhase !== 'lobby') {
                socket.join(formattedRoomId);
                socket.emit('chat-history', { messages: room.chatMessages || [] });

                if (!room.spectators) room.spectators = [];
                room.spectators.push({ id: socket.id, name: exactName });

                socket.emit('spectate-started', {
                    roomId: formattedRoomId,
                    players: room.players,
                    activeBases: room.activeBases,
                    spectators: room.spectators,
                    gamePhase: room.gamePhase,
                    draftState: room.gamePhase === 'drafting' ? sanitizeDraftState(room.draftState) : null,
                    currentTurnPlayerId: room.currentTurnPlayerId,
                    turnState: room.turnState,
                    battleLog: room.battleLog,
                    gameResult: room.gameResult || null
                });

                io.to(formattedRoomId).emit('update-players', { players: room.players, spectators: room.spectators, host: room.host });
                return;
            }

            // 3. Standard Lobby Join (Game hasn't started yet)
            socket.join(formattedRoomId);
            socket.emit('chat-history', { messages: room.chatMessages || [] });
            const { role } = addLobbyParticipant(room, { id: socket.id, name: exactName });

            socket.emit('room-joined', {
                roomId: formattedRoomId,
                players: room.players,
                spectators: room.spectators || [],
                host: room.host,
                role
            });
            io.to(formattedRoomId).emit('update-players', { players: room.players, spectators: room.spectators || [], host: room.host });

        } else {
            socket.emit('error', 'Room not found! Check your code.');
        }
    });

    socket.on('add-bot', ({ roomId, policyVersion } = {}) => {
        const room = rooms[roomId];
        const result = addLobbyBot(room, socket.id, roomId, policyVersion);
        if (!result.ok) return socket.emit('error', result.error);

        io.to(roomId).emit('update-players', {
            players: room.players,
            spectators: room.spectators || [],
            host: room.host
        });
    });

    socket.on('remove-bot', ({ roomId, botId } = {}) => {
        const room = rooms[roomId];
        const result = removeLobbyBot(room, socket.id, botId);
        if (!result.ok) return socket.emit('error', result.error);

        io.to(roomId).emit('update-players', {
            players: room.players,
            spectators: room.spectators || [],
            host: room.host
        });
    });

    socket.on('send-chat-message', ({ roomId, message }) => {
        const room = rooms[roomId];
        if (!room || !socket.rooms.has(roomId)) return;
        const sender = room.players.find(player => player.id === socket.id);
        if (!sender) return socket.emit('error', 'Only players in this room can send chat messages.');

        const result = appendChatMessage(room, sender, message);
        if (!result.ok) return socket.emit('error', result.error);
        io.to(roomId).emit('chat-message', result.message);
    });

    socket.on('play-card', (payload = {}) => {
        const { roomId, ...command } = payload || {};
        const result = executeGameAction({
            room: rooms[roomId],
            roomId,
            actorId: socket.id,
            action: { ...command, type: 'play-card' },
            actorTransport: socket,
            emitState: emitGameState
        });

        if (!result.ok) socket.emit('error', result.error);
    });

    socket.on('use-talent', (payload = {}) => {
        const { roomId, ...command } = payload || {};
        const result = executeGameAction({
            room: rooms[roomId],
            roomId,
            actorId: socket.id,
            action: { ...command, type: 'use-talent' },
            emitState: emitGameState
        });

        if (!result.ok) socket.emit('error', result.error);
    });

    socket.on('end-turn', (payload = {}) => {
        const { roomId } = payload || {};
        const room = rooms[roomId];
        const result = executeGameAction({
            room,
            roomId,
            actorId: socket.id,
            action: { type: 'end-turn' },
            emitState: emitGameState,
            emitRoomEvent: (targetRoomId, event, eventPayload) => {
                io.to(targetRoomId).emit(event, eventPayload);
            },
            roomStillExists: () => rooms[roomId] === room
        });

        if (!result.ok) socket.emit('error', result.error);
    });

    socket.on('leave-room', ({ roomId }) => {
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const isSpectator = (room.spectators || []).some(spectator => spectator.id === socket.id);

            if (isSpectator) {
                room.spectators = room.spectators.filter(spectator => spectator.id !== socket.id);
                socket.leave(roomId);
                io.to(roomId).emit('update-players', {
                    players: room.players,
                    spectators: room.spectators,
                    host: room.host
                });
                return;
            }

            if (room.gamePhase === 'lobby') {
                room.players = room.players.filter(p => p.id !== socket.id);
                socket.leave(roomId);

                const nextHumanHostId = getNextHumanHostId(room);
                if (!nextHumanHostId) {
                    io.to(roomId).emit('room-reset', { message: 'All human players have left. The room has been closed.' });
                    destroyRoom(roomId);
                } else {
                    if (room.host === socket.id) {
                        room.host = nextHumanHostId;
                    }
                    io.to(roomId).emit('update-players', { players: room.players, spectators: room.spectators || [], host: room.host });
                }
            } else if (room.gamePhase === 'drafting') {
                io.to(roomId).emit('room-reset', { message: 'A player left during the faction draft. The room has been closed.' });
                destroyRoom(roomId);
            } else if (room.gamePhase === 'playing' || room.gamePhase === 'scoring') {
                const player = room.players.find(p => p.id === socket.id);
                if (player) {
                    player.online = false;
                    disconnectTimers[player.id] = setTimeout(() => {
                        handlePlayerKick(roomId, player.id);
                    }, DISCONNECT_GRACE_PERIOD_MS);
                }

                if (room.spectators) {
                    room.spectators = room.spectators.filter(s => s.id !== socket.id);
                }

                socket.leave(roomId);
                io.to(roomId).emit('update-players', { players: room.players, spectators: room.spectators || [] });
            } else if (room.gamePhase === 'finished') {
                socket.leave(roomId);
                removeFinishedGamePlayer(roomId, socket.id);
            }
        }
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];

            if (room.spectators) {
                room.spectators = room.spectators.filter(s => s.id !== socket.id);
                io.to(roomId).emit('update-players', { players: room.players, spectators: room.spectators });
            }

            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                if (room.gamePhase === 'lobby') {
                    room.players = room.players.filter(p => p.id !== socket.id);
                    const nextHumanHostId = getNextHumanHostId(room);
                    if (!nextHumanHostId) {
                        io.to(roomId).emit('room-reset', { message: 'All human players have left. The room has been closed.' });
                        destroyRoom(roomId);
                    } else {
                        if (room.host === socket.id) {
                            room.host = nextHumanHostId;
                        }
                        io.to(roomId).emit('update-players', { players: room.players, spectators: room.spectators || [], host: room.host });
                    }
                } else if (room.gamePhase === 'drafting') {
                    io.to(roomId).emit('room-reset', { message: 'A player disconnected during the faction draft. The room has been closed.' });
                    destroyRoom(roomId);
                } else if (room.gamePhase === 'playing' || room.gamePhase === 'scoring') {
                    player.online = false;
                    io.to(roomId).emit('update-players', { players: room.players, spectators: room.spectators || [], host: room.host });

                    disconnectTimers[player.id] = setTimeout(() => {
                        handlePlayerKick(roomId, player.id);
                    }, DISCONNECT_GRACE_PERIOD_MS);
                } else if (room.gamePhase === 'finished') {
                    removeFinishedGamePlayer(roomId, socket.id);
                }
                break;
            }
        }
    });

    socket.on('start-game', ({ roomId }) => {
        const room = rooms[roomId];
        if (room && room.host === socket.id) {
            if (room.players.length < 1) {
                return socket.emit('error', 'Not enough players to start!');
            }

            room.draftState = {
                availableFactions: Object.keys(factionsData),
                draftOrder: generateDraftOrder(room.players),
                currentTurnIndex: 0,
                picks: {}
            };

            room.players.forEach(player => {
                room.draftState.picks[player.id] = [];
                player.vp = 0;
            });

            room.gameStartedAt = new Date().toISOString();
            room.gamePhase = 'drafting';

            io.to(roomId).emit('draft-started', {
                draftState: sanitizeDraftState(room.draftState),
                players: room.players,
                spectators: room.spectators || []
            });
            botTurnController.wake(roomId);
        } else {
            socket.emit('error', 'Only the host can start the game!');
        }
    });

    socket.on('draft-faction', (payload = {}) => {
        const { roomId, ...command } = payload || {};
        const result = executeGameAction({
            room: rooms[roomId],
            roomId,
            actorId: socket.id,
            action: { ...command, type: 'draft-faction' },
            emitRoomEvent: (targetRoomId, event, eventPayload) => {
                io.to(targetRoomId).emit(event, eventPayload);
            }
        });

        if (!result.ok) socket.emit('error', result.error);
        else botTurnController.wake(roomId);
    });

    socket.on('resolve-ability-choice', (payload = {}) => {
        const { roomId, choice } = payload || {};
        const result = executeGameAction({
            room: rooms[roomId],
            roomId,
            actorId: socket.id,
            action: { type: 'resolve-ability-choice', choice },
            actorTransport: socket,
            emitState: emitGameState
        });

        if (!result.ok) socket.emit('error', result.error);
    });
});

function failGameAction(code, error) {
    return { ok: false, code, error };
}

function createActionActor(actorId, actorTransport) {
    const actorEvents = [];
    const actor = {
        id: actorId,
        emit(event, payload) {
            actorEvents.push({ event, payload });
            if (actorTransport?.emit) actorTransport.emit(event, payload);
        }
    };

    return { actor, actorEvents };
}

function emitActorEvent(actor, event, payload) {
    if (typeof actor?.emit === 'function') actor.emit(event, payload);
    else if (actor?.id) io.to(actor.id).emit(event, payload);
}

function emitTriggeredChoice(room, playerId, payload) {
    if (room?.headless === true) return;
    io.to(playerId).emit('ability-choice-required', payload);
}

function validatePlayCardAction(room, actorId, action) {
    if (!room) return failGameAction('room_not_found', 'Room not found.');
    if (room.gamePhase !== 'playing') {
        return failGameAction('invalid_phase', 'Cards can only be played during the playing phase.');
    }
    if (room.pendingAbility) {
        return failGameAction('pending_ability', 'Resolve the pending ability before playing another card.');
    }
    if (room.currentTurnPlayerId !== actorId) {
        return failGameAction('not_your_turn', "It's not your turn!");
    }

    const player = room.players.find(candidate => candidate.id === actorId);
    if (!player) return failGameAction('player_not_found', 'Player not found in this room.');

    const fromDiscard = Boolean(action.fromDiscard);
    const sourcePile = fromDiscard ? player.discardPile : player.hand;
    const cardIndex = sourcePile.findIndex(card => card.instanceId === action.cardInstanceId);
    if (cardIndex === -1) {
        return failGameAction(
            'card_not_found',
            `Card not found in your ${fromDiscard ? 'discard pile' : 'hand'}!`
        );
    }

    const card = sourcePile[cardIndex];
    const baseIndex = action.baseIndex;
    const requiredExtraMinionPlayIndex = room.turnState.extraMinionPlays
        .findIndex(permission => permission.required);
    const requiredExtraMinionPlay = room.turnState.extraMinionPlays[requiredExtraMinionPlayIndex];
    if (requiredExtraMinionPlay
        && (card.type !== 'minion'
            || fromDiscard
            || !minionPlayPermissionMatches(room, actorId, card, baseIndex, requiredExtraMinionPlay))) {
        return failGameAction(
            'required_extra_minion',
            `You must play the Talent's extra minion at ${room.activeBases[requiredExtraMinionPlay.allowedBaseIndex]?.name || 'the required base'} first.`
        );
    }

    if (fromDiscard) {
        const allowedBaseIndices = getOngoingDiscardPlayBaseIndices(room, actorId);
        if (card.type !== 'minion'
            || room.turnState.ongoingDiscardMinionPlayed
            || !allowedBaseIndices.includes(baseIndex)) {
            return failGameAction('discard_play_not_allowed', 'No ongoing ability allows that discard-pile play.');
        }
    }

    let extraMinionPlayIndex = requiredExtraMinionPlayIndex;
    if (card.type === 'minion') {
        if (room.turnState.minionPlayed && extraMinionPlayIndex === -1) {
            extraMinionPlayIndex = room.turnState.extraMinionPlays.findIndex(permission => (
                minionPlayPermissionMatches(room, actorId, card, baseIndex, permission)
            ));
        }
        if (room.turnState.minionPlayed && extraMinionPlayIndex === -1) {
            return failGameAction('minion_limit_reached', 'You have already played a minion this turn!');
        }
    } else if (card.type === 'action') {
        if (room.turnState.actionPlayed && room.turnState.extraActionPlays <= 0) {
            return failGameAction('action_limit_reached', 'You have already played an action this turn!');
        }
    } else {
        return failGameAction('invalid_card_type', 'That card type cannot be played.');
    }

    let targetMinion = null;
    let targetBase = null;
    if (card.subtype === 'base') {
        if (baseIndex === null || baseIndex === undefined || !room.activeBases[baseIndex]) {
            return failGameAction('invalid_base_target', 'Target base does not exist');
        }
        targetBase = room.activeBases[baseIndex];
    } else if (['ally-minion', 'enemy-minion', 'neutral-minion'].includes(card.subtype)) {
        if (baseIndex !== null && baseIndex !== undefined && room.activeBases[baseIndex]) {
            targetBase = room.activeBases[baseIndex];
            targetMinion = (targetBase.playedCards || []).find(candidate => (
                candidate.type === 'minion'
                && candidate.instanceId === action.targetMinionInstanceId
            ));
        } else {
            for (const candidateBase of room.activeBases) {
                const found = (candidateBase.playedCards || []).find(candidate => (
                    candidate.type === 'minion'
                    && candidate.instanceId === action.targetMinionInstanceId
                ));
                if (found) {
                    targetMinion = found;
                    targetBase = candidateBase;
                    break;
                }
            }
        }

        if (!targetMinion) {
            return failGameAction('invalid_minion_target', 'Target minion does not exist');
        }

        const isAlly = targetMinion.ownerId === actorId;
        if (card.subtype === 'ally-minion' && !isAlly) {
            return failGameAction('target_not_ally', 'Target must be your own minion');
        }
        if (card.subtype === 'enemy-minion' && isAlly) {
            return failGameAction('target_not_enemy', 'Target must be an enemy minion');
        }
        if (isMinionProtectedFromCard(room, targetBase, targetMinion, actorId, card.type)) {
            return failGameAction(
                'target_protected',
                `${targetMinion.name} is protected from this card.`
            );
        }
    }

    if (card.type === 'minion' && targetBase && isMinionPlayPrevented(targetBase, actorId)) {
        return failGameAction('minion_play_prevented', `You cannot play a minion on ${targetBase.name}.`);
    }

    return {
        ok: true,
        card,
        cardIndex,
        extraMinionPlayIndex,
        fromDiscard,
        player,
        sourcePile,
        targetBase,
        targetMinion
    };
}

function executePlayCardAction({ room, roomId, actorId, action, actorTransport }) {
    const validation = validatePlayCardAction(room, actorId, action);
    if (!validation.ok) return validation;

    const { actor, actorEvents } = createActionActor(actorId, actorTransport);
    const {
        card,
        cardIndex,
        extraMinionPlayIndex,
        fromDiscard,
        player,
        sourcePile,
        targetBase,
        targetMinion
    } = validation;

    sourcePile.splice(cardIndex, 1);
    const playedCard = { ...card, ownerName: player.name, ownerId: player.id };
    let logMessage = '';
    let targetName = null;

    if (card.discard === 'yes' && card.subtype === 'neither') {
        player.discardPile.push(playedCard);
        logMessage = `**${player.name}** plays **${card.name}**`;
    } else if (card.subtype === 'base') {
        if (!targetBase.playedCards) targetBase.playedCards = [];
        targetBase.playedCards.push(playedCard);
        targetName = targetBase.name;
        logMessage = `**${player.name}** plays **${card.name}** on **${targetBase.name}**`;
    } else if (['ally-minion', 'enemy-minion', 'neutral-minion'].includes(card.subtype)) {
        if (!targetMinion.attachedCards) targetMinion.attachedCards = [];
        targetMinion.attachedCards.push(playedCard);
        targetName = targetMinion.name;
        logMessage = `**${player.name}** plays **${card.name}** on **${targetMinion.name}**`;
    } else {
        player.discardPile.push(playedCard);
        logMessage = `**${player.name}** plays **${card.name}**`;
    }

    if (card.type === 'minion') {
        if (extraMinionPlayIndex >= 0) room.turnState.extraMinionPlays.splice(extraMinionPlayIndex, 1);
        else room.turnState.minionPlayed = true;
        room.turnState.minionsPlayed += 1;
        if (fromDiscard) room.turnState.ongoingDiscardMinionPlayed = true;
    } else {
        if (room.turnState.actionPlayed) room.turnState.extraActionPlays -= 1;
        room.turnState.actionPlayed = true;
        room.turnState.actionsPlayed += 1;
    }

    addBattleLog(room, {
        message: logMessage,
        card: playedCard,
        playerName: player.name,
        targetName,
        targetCard: targetMinion
    });

    recalculateOngoingEffects(room);
    resolveOnPlayBoardEffects({
        room,
        roomId,
        socket: actor,
        playedCard,
        targetBase,
        targetMinion
    });
    recalculateOngoingEffects(room);
    if (card.type === 'minion' && targetBase) {
        queueAfterMinionPlayedBaseAbilities(room, targetBase, playedCard);
    }

    return {
        ok: true,
        actorEvents,
        pendingAbility: room.pendingAbility || null,
        playedCard
    };
}

function validateResolveAbilityChoiceAction(room, actorId) {
    if (!room) return failGameAction('room_not_found', 'Room not found.');
    if (!room.pendingAbility) {
        return failGameAction('no_pending_ability', 'There is no ability choice to resolve.');
    }
    if (room.pendingAbility.playerId !== actorId) {
        return failGameAction('not_ability_controller', 'This ability choice belongs to another player.');
    }
    if (typeof room.pendingAbility.type !== 'string') {
        return failGameAction('invalid_pending_ability', 'The pending ability cannot be resolved.');
    }

    return { ok: true, pendingAbility: room.pendingAbility };
}

function executeResolveAbilityChoiceAction({ room, roomId, actorId, action, actorTransport }) {
    const validation = validateResolveAbilityChoiceAction(room, actorId);
    if (!validation.ok) return validation;

    const { actor, actorEvents } = createActionActor(actorId, actorTransport);
    const { choice } = action;
    const { continuation, type } = validation.pendingAbility;
    const success = () => ({
        ok: true,
        actorEvents,
        pendingAbility: room.pendingAbility || null
    });
    const resumeAndSucceed = () => {
        resumeOnPlayContinuation(room, roomId, actor, continuation);
        return success();
    };

    if (type.startsWith('triggered')) {
        if (!resolveTriggeredAbilityChoice(room, roomId, actor, choice)) {
            return failGameAction(
                'invalid_triggered_ability_choice',
                'That is no longer a valid triggered ability choice.'
            );
        }
        return success();
    }

    if (type === 'confirmation') {
        if (choice?.choiceId === 'accept') {
            resolveBoardEffect({ room, roomId, socket: actor, effect: room.pendingAbility.effect, optional: false });
        } else if (choice?.choiceId !== 'skip') {
            return failGameAction('invalid_ability_choice', 'That is no longer a valid ability choice.');
        }

        room.pendingAbility = null;
        return resumeAndSucceed();
    }

    const choiceHandlers = {
        moveDestination: {
            resolve: () => resolveMoveDestination(room, actor, choice),
            code: 'invalid_move_destination',
            error: 'That base is no longer a valid destination.'
        },
        moveTarget: {
            resolve: () => resolveMoveTarget(room, roomId, actor, choice),
            code: 'invalid_move_target',
            error: 'That minion is no longer a valid move target.'
        },
        moveTargetBatch: {
            resolve: () => resolveMoveTargetBatch(room, roomId, actor, choice),
            code: 'invalid_move_target_batch',
            error: 'One or more selected minions are no longer valid move targets.'
        },
        discardToHand: {
            resolve: () => resolveDiscardToHand(room, actor, choice),
            code: 'invalid_discard_target',
            error: 'That card is no longer a valid discard-pile target.'
        },
        topDeckReveal: {
            resolve: () => resolveTopDeckReveal(room, actor, choice),
            code: 'invalid_reveal_choice',
            error: 'That is no longer a valid reveal choice.'
        },
        multiZoneSelection: {
            resolve: () => resolveMultiZoneSelection(room, roomId, actor, choice),
            code: 'invalid_multi_zone_selection',
            error: 'That card is no longer a valid selection.'
        },
        deckReorder: {
            resolve: () => resolveDeckReorder(room, actor, choice),
            code: 'invalid_deck_order',
            error: 'That card order is no longer valid.'
        },
        discardPlayCard: {
            resolve: () => resolveDiscardPlayCard(room, roomId, actor, choice),
            code: 'invalid_discard_play',
            error: 'That minion is no longer a valid discard-pile play.'
        },
        discardPlayEach: {
            resolve: () => resolveDiscardPlayCard(room, roomId, actor, choice),
            code: 'invalid_discard_play',
            error: 'That minion is no longer a valid discard-pile play.'
        },
        discardPlayBase: {
            resolve: () => resolveDiscardPlayBase(room, actor, choice),
            code: 'invalid_discard_play_base',
            error: 'That base is no longer a valid destination.'
        },
        playerHandReveal: {
            resolve: () => resolvePlayerHandReveal(room, actor, choice, continuation),
            code: 'invalid_player_target',
            error: 'That player is no longer a valid target.'
        },
        handDiscard: {
            resolve: () => resolveHandDiscard(room, actor, choice),
            code: 'invalid_hand_card',
            error: 'That hand card is no longer a valid target.'
        },
        handLimitDiscard: {
            resolve: () => resolveBotHandLimitDiscard(room, actor, choice),
            code: 'invalid_hand_limit_discard',
            error: 'That card is no longer a valid hand-limit discard.',
            resume: false
        },
        baseDeckSwap: {
            resolve: () => resolveBaseDeckSwap(room, choice, continuation),
            code: 'invalid_base_replacement',
            error: 'That base is no longer a valid replacement.'
        },
        massEnchantment: {
            resolve: () => resolveMassEnchantment(room, actor, choice),
            code: 'invalid_revealed_action',
            error: 'That revealed action is no longer available.'
        },
        deckNameSelection: {
            resolve: () => resolveDeckNameSelection(room, roomId, actor, choice),
            code: 'invalid_card_name',
            error: 'That card name is no longer available.'
        },
        attachedActionSelection: {
            resolve: () => resolveAttachedActionSelection(room, roomId, actor, choice),
            code: 'invalid_attached_action',
            error: 'That attached action is no longer available.'
        },
        seaDogsFaction: {
            resolve: () => resolveSeaDogsFaction(room, roomId, actor, choice),
            code: 'invalid_faction_target',
            error: 'That faction is no longer a valid target.'
        },
        seaDogsDestination: {
            resolve: () => resolveSeaDogsDestination(room, actor, choice),
            code: 'invalid_sea_dogs_destination',
            error: 'That destination is no longer valid.'
        },
        disguiseSelection: {
            resolve: () => resolveDisguiseSelection(room, roomId, actor, choice),
            code: 'invalid_disguise_target',
            error: 'That minion is no longer a valid Disguise target.',
            resume: false
        },
        selectedPlayerBoardEffect: {
            resolve: () => resolveSelectedPlayerBoardEffect(room, roomId, actor, choice),
            code: 'invalid_player_ability_target',
            error: 'That player is no longer a valid ability target.'
        },
        selectedPlayerBoardEffectBase: {
            resolve: () => resolveSelectedPlayerBoardEffectBase(room, actor, choice),
            code: 'invalid_base_ability_target',
            error: 'That base is no longer a valid ability target.'
        },
        boardEffect: {
            resolve: () => resolvePendingBoardEffect(room, actor, choice),
            code: 'invalid_ability_target',
            error: 'That is no longer a valid ability target.'
        },
        boardEffectBatch: {
            resolve: () => resolveBoardEffectBatch(room, actor, choice),
            code: 'invalid_ability_target_batch',
            error: 'One or more selected minions are no longer valid targets.'
        }
    };
    const handler = choiceHandlers[type];

    if (handler) {
        if (!handler.resolve()) return failGameAction(handler.code, handler.error);
        return handler.resume === false ? success() : resumeAndSucceed();
    }

    if (!resolvePendingDinosaurAbility(room, roomId, actor, choice)) {
        return failGameAction('invalid_ability_target', 'That is no longer a valid ability target.');
    }

    return resumeAndSucceed();
}

function validateUseTalentAction(room, actorId) {
    if (!room) return failGameAction('room_not_found', 'Room not found.');
    if (room.gamePhase !== 'playing') {
        return failGameAction('invalid_phase', 'Talents can only be used during the playing phase.');
    }
    if (room.currentTurnPlayerId !== actorId) {
        return failGameAction('not_your_turn', "It's not your turn!");
    }
    if (room.pendingAbility) {
        return failGameAction('pending_ability', 'Resolve the pending ability before using a Talent.');
    }
    if (room.turnState.extraMinionPlays.some(permission => permission.required)) {
        return failGameAction('required_extra_minion', "Play the Talent's required extra minion first.");
    }
    if (!room.players.some(player => player.id === actorId)) {
        return failGameAction('player_not_found', 'Player not found in this room.');
    }

    return { ok: true };
}

function executeUseTalentAction({ room, actorId, action }) {
    const validation = validateUseTalentAction(room, actorId);
    if (!validation.ok) return validation;

    const result = activateTalent(room, actorId, action.cardInstanceId);
    if (!result.ok) return failGameAction('talent_unavailable', result.error);

    return { ok: true, cardInstanceId: action.cardInstanceId };
}

function validateDraftFactionAction(room, actorId, action) {
    if (!room) return failGameAction('room_not_found', 'Room not found.');
    if (room.gamePhase !== 'drafting') {
        return failGameAction('invalid_phase', 'Factions can only be selected during the draft.');
    }

    const draft = room.draftState;
    if (!draft || !Array.isArray(draft.draftOrder) || !Array.isArray(draft.availableFactions)) {
        return failGameAction('invalid_draft_state', 'The faction draft is not available.');
    }

    const currentPickerId = draft.draftOrder[draft.currentTurnIndex];
    if (actorId !== currentPickerId) {
        return failGameAction('not_your_draft_turn', 'It is not your turn to draft!');
    }
    if (!draft.availableFactions.includes(action.factionName)) {
        return failGameAction('faction_unavailable', 'That faction is already taken!');
    }
    if (!Array.isArray(draft.picks?.[actorId])) {
        return failGameAction('invalid_draft_state', 'The faction draft is not available.');
    }

    return { ok: true, draft };
}

function finishFactionDraft(room, draft) {
    room.gamePhase = 'playing';
    const random = () => nextSeededRandom(room);

    const baseDeck = buildBaseDeck(random);
    room.activeBases = baseDeck.splice(0, 3).map(base => ({
        ...base,
        playedCards: []
    }));
    room.baseDeck = baseDeck;
    room.baseDiscardPile = [];

    room.players.forEach(player => {
        const playerFactions = draft.picks[player.id] || ['Aliens', 'Dinosaurs'];
        const combinedDeck = [
            ...buildFactionDeck(playerFactions[0], random),
            ...buildFactionDeck(playerFactions[1], random)
        ];
        shuffleDeck(combinedDeck, random);

        player.factions = playerFactions;
        player.hand = combinedDeck.splice(0, 5);
        player.deck = combinedDeck;
        player.discardPile = [];
        player.vp = 0;
    });

    const firstPlayer = room.players[0];
    room.currentTurnPlayerId = firstPlayer.id;
    room.turnState = createInitialTurnState();
    room.pendingAbility = null;
    room.temporaryEffects = [];
    addBattleLog(room, `**${firstPlayer.name}**'s turn`);
}

function executeDraftFactionAction({ room, actorId, action }) {
    const validation = validateDraftFactionAction(room, actorId, action);
    if (!validation.ok) return validation;

    const { draft } = validation;
    draft.availableFactions = draft.availableFactions
        .filter(factionName => factionName !== action.factionName);
    draft.picks[actorId].push(action.factionName);
    draft.currentTurnIndex += 1;

    if (draft.currentTurnIndex < draft.draftOrder.length) {
        return {
            ok: true,
            draftComplete: false,
            roomEvents: [{
                event: 'draft-update',
                payload: { draftState: sanitizeDraftState(draft) }
            }],
            suppressDefaultStateEmission: true
        };
    }

    finishFactionDraft(room, draft);
    return {
        ok: true,
        draftComplete: true,
        roomEvents: [{
            event: 'game-started',
            payload: {
                players: room.players,
                activeBases: room.activeBases,
                spectators: room.spectators || [],
                currentTurnPlayerId: room.currentTurnPlayerId,
                turnState: room.turnState,
                gamePhase: room.gamePhase,
                battleLog: room.battleLog
            }
        }],
        suppressDefaultStateEmission: true
    };
}

function validateEndTurnAction(room, actorId) {
    if (!room) return failGameAction('room_not_found', 'Room not found.');
    if (room.gamePhase !== 'playing') {
        return failGameAction('invalid_phase', 'Turns can only end during the playing phase.');
    }
    if (room.pendingAbility) {
        return failGameAction('pending_ability', 'Resolve the pending ability before ending your turn.');
    }
    if (room.turnState.extraMinionPlays.some(permission => permission.required)) {
        return failGameAction(
            'required_extra_minion',
            "Play the Talent's required extra minion before ending your turn."
        );
    }
    if (room.currentTurnPlayerId !== actorId) {
        return failGameAction('not_your_turn', "It's not your turn!");
    }

    const player = room.players.find(candidate => candidate.id === actorId);
    if (!player) return failGameAction('player_not_found', 'Player not found in this room.');
    return { ok: true, player };
}

function cleanupDelayedDiscardCards(room) {
    room.activeBases.forEach(base => {
        base.playedCards = (base.playedCards || []).filter(card => {
            if (card.type !== 'action' || card.discard !== 'yes') return true;
            const owner = room.players.find(player => player.id === card.ownerId);
            if (owner) {
                if (!owner.discardPile) owner.discardPile = [];
                owner.discardPile.push(card);
            }
            return false;
        });

        base.playedCards.forEach(card => {
            if (card.type !== 'minion' || !card.attachedCards) return;
            card.attachedCards = card.attachedCards.filter(attached => {
                if (attached.type !== 'action' || attached.discard !== 'yes') return true;
                const owner = room.players.find(player => player.id === attached.ownerId);
                if (owner) {
                    if (!owner.discardPile) owner.discardPile = [];
                    owner.discardPile.push(attached);
                }
                return false;
            });
        });
    });
}

function getCurrentSourceCardInstanceId(room) {
    return room.currentResolutionContext?.sourceCardInstanceId
        || room.pendingAbility?.continuation?.context?.sourceCardInstanceId
        || null;
}

function ensurePlayerDeckCards(room, player, requiredCount = 1) {
    if (!player || player.deck.length >= requiredCount || player.discardPile.length === 0) return false;

    const excludedInstanceId = getCurrentSourceCardInstanceId(room);
    const recyclableCards = player.discardPile.filter(card => card.instanceId !== excludedInstanceId);
    if (recyclableCards.length === 0) return false;

    const recyclableIds = new Set(recyclableCards.map(card => card.instanceId));
    player.discardPile = player.discardPile.filter(card => !recyclableIds.has(card.instanceId));
    shuffleDeck(recyclableCards, () => nextSeededRandom(room));
    player.deck.push(...recyclableCards);
    addBattleLog(room, `**${player.name}** shuffles their discard pile to form a new deck.`);
    return true;
}

function drawPlayerCard(room, player) {
    ensurePlayerDeckCards(room, player, 1);
    return player?.deck.shift() || null;
}

function drawEndTurnCards(room, player) {
    for (let index = 0; index < 2; index += 1) {
        const card = drawPlayerCard(room, player);
        if (card) player.hand.push(card);
    }
}

function queueBotHandLimitDiscard(room, player) {
    if (player?.isBot !== true || player.hand.length <= MAX_HAND_SIZE) return false;

    room.pendingAbility = {
        type: 'handLimitDiscard',
        playerId: player.id,
        endingPlayerId: player.id,
        candidateIds: player.hand.map(card => card.instanceId),
        cardsRemaining: player.hand.length - MAX_HAND_SIZE
    };
    return true;
}

function resolveBotHandLimitDiscard(room, actor, choice) {
    const pendingAbility = room.pendingAbility;
    const player = room.players.find(candidate => candidate.id === actor.id);
    if (pendingAbility?.type !== 'handLimitDiscard'
        || player?.isBot !== true
        || player.hand.length <= MAX_HAND_SIZE
        || !pendingAbility.candidateIds.includes(choice?.cardInstanceId)) return false;

    const cardIndex = player.hand.findIndex(card => card.instanceId === choice.cardInstanceId);
    if (cardIndex < 0) return false;

    const [discardedCard] = player.hand.splice(cardIndex, 1);
    player.discardPile.push(discardedCard);
    addBattleLog(room, `**${player.name}** discards **${discardedCard.name}** to meet the hand limit.`);

    if (player.hand.length > MAX_HAND_SIZE) {
        pendingAbility.candidateIds = player.hand.map(card => card.instanceId);
        pendingAbility.cardsRemaining = player.hand.length - MAX_HAND_SIZE;
    } else {
        const endingPlayerId = pendingAbility.endingPlayerId;
        room.pendingAbility = null;
        advanceToNextTurn(room, endingPlayerId);
    }
    return true;
}

function advanceToNextTurn(room, actorId) {
    const currentPlayerIndex = room.players.findIndex(player => player.id === actorId);
    const nextPlayerIndex = (currentPlayerIndex + 1) % room.players.length;
    const nextPlayer = room.players[nextPlayerIndex];

    room.currentTurnPlayerId = nextPlayer.id;
    room.turnState = createInitialTurnState();
    room.gamePhase = 'playing';
    addBattleLog(room, `**${nextPlayer.name}**'s turn`);
    resolveStartTurnActions(room, nextPlayer.id);
    return nextPlayer;
}

function executeEndTurnAction({
    room,
    roomId,
    actorId,
    emitState,
    scheduleAction = setTimeout,
    roomStillExists = () => true
}) {
    const validation = validateEndTurnAction(room, actorId);
    if (!validation.ok) return validation;
    const { player } = validation;

    resolveEndTurnActions(room);
    if (processNextTriggeredAbility(room, roomId)) {
        return {
            ok: true,
            pendingAbility: room.pendingAbility,
            turnCompleted: false
        };
    }

    const scoringBases = getScoringBases(room);
    if (scoringBases.length > 0) {
        const scoringBaseIds = scoringBases
            .map(baseIndex => room.activeBases[baseIndex]?.id)
            .filter(Boolean);
        scoringBases.forEach(baseIndex => {
            addBattleLog(room, `**${room.activeBases[baseIndex].name}** is scoring!`);
        });
        addBattleLog(room, `**${player.name}** has ended their turn`);
        room.gamePhase = 'scoring';

        const roomEvents = [{
            event: 'game-state-update',
            payload: {
                players: room.players,
                activeBases: room.activeBases,
                currentTurnPlayerId: room.currentTurnPlayerId,
                turnState: room.turnState,
                gamePhase: room.gamePhase,
                scoringBases,
                battleLog: room.battleLog
            }
        }];

        scheduleAction(() => {
            if (!roomStillExists()) return;

            const finishScoringTurn = () => {
                drawEndTurnCards(room, player);
                cleanupDelayedDiscardCards(room);
                clearTemporaryEffects(room);
                if (finishGameIfNeeded(room, roomId)) return;
                if (queueBotHandLimitDiscard(room, player)) return;
                advanceToNextTurn(room, actorId);
            };
            const scoreEligibleBases = () => {
                scoringBaseIds.forEach(baseId => {
                    const currentBaseIndex = room.activeBases.findIndex(base => base.id === baseId);
                    if (currentBaseIndex >= 0) scoreBase(room, currentBaseIndex);
                });
                room.afterTriggeredAbilitiesResolved = finishScoringTurn;
                if (!processNextTriggeredAbility(room, roomId)) finishAfterTriggeredAbilities(room);
            };

            room.afterTriggeredAbilitiesResolved = scoreEligibleBases;
            queueBeforeBaseScoringSpecials(room, scoringBases);
            if (!processNextTriggeredAbility(room, roomId)) finishAfterTriggeredAbilities(room);
            if (emitState) emitState(roomId, room);
        }, 5000);

        return {
            ok: true,
            roomEvents,
            scoringBases,
            suppressDefaultStateEmission: true,
            turnCompleted: false
        };
    }

    drawEndTurnCards(room, player);
    addBattleLog(room, `**${player.name}** has ended their turn`);
    cleanupDelayedDiscardCards(room);
    clearTemporaryEffects(room);
    const gameResult = finishGameIfNeeded(room, roomId);
    if (gameResult) {
        return {
            ok: true,
            gameFinished: true,
            gameResult,
            turnCompleted: true
        };
    }
    if (queueBotHandLimitDiscard(room, player)) {
        return {
            ok: true,
            pendingAbility: room.pendingAbility,
            turnCompleted: false
        };
    }
    const nextPlayer = advanceToNextTurn(room, actorId);

    return {
        ok: true,
        nextPlayerId: nextPlayer.id,
        turnCompleted: true
    };
}

function executeGameAction({
    room,
    roomId,
    actorId,
    action,
    actorTransport,
    emitState,
    emitRoomEvent,
    scheduleAction,
    roomStillExists
}) {
    if (!action || typeof action.type !== 'string') {
        return failGameAction('invalid_action', 'A game action type is required.');
    }
    const decisionMetadata = getOrCreateDecisionMetadata(room, actorId);

    let result;
    if (action.type === 'play-card') {
        result = executePlayCardAction({ room, roomId, actorId, action, actorTransport });
    } else if (action.type === 'resolve-ability-choice') {
        result = executeResolveAbilityChoiceAction({ room, roomId, actorId, action, actorTransport });
    } else if (action.type === 'use-talent') {
        result = executeUseTalentAction({ room, actorId, action });
    } else if (action.type === 'draft-faction') {
        result = executeDraftFactionAction({ room, actorId, action });
    } else if (action.type === 'end-turn') {
        result = executeEndTurnAction({
            room,
            roomId,
            actorId,
            emitState,
            scheduleAction,
            roomStillExists
        });
    } else {
        result = failGameAction('unsupported_action', `Unsupported game action: ${action.type}`);
    }

    if (result.ok) {
        completeDecisionStep(room, actorId, decisionMetadata);
        (result.roomEvents || []).forEach(({ event, payload }) => {
            if (emitRoomEvent) emitRoomEvent(roomId, event, payload);
        });
        if (!result.suppressDefaultStateEmission && emitState) emitState(roomId, room);
    }
    return result;
}

function cloneObservationValue(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function getDecisionActorId(room) {
    if (!room) return null;
    if (room.pendingAbility?.playerId) return room.pendingAbility.playerId;
    if (room.gamePhase === 'drafting') {
        return room.draftState?.draftOrder?.[room.draftState.currentTurnIndex] || null;
    }
    if (room.gamePhase === 'playing') return room.currentTurnPlayerId || null;
    return null;
}

function getDecisionType(room) {
    if (room.pendingAbility?.type) return room.pendingAbility.type;
    if (room.gamePhase === 'drafting') return 'draftFaction';
    if (room.gamePhase === 'playing') return 'turnAction';
    return null;
}

function getDecisionTracker(room) {
    if (!room.decisionTracker) {
        room.decisionTracker = {
            nextResolutionNumber: 1,
            current: null
        };
    }
    return room.decisionTracker;
}

function getOrCreateDecisionMetadata(room, playerId) {
    if (!room || getDecisionActorId(room) !== playerId) return null;
    const tracker = getDecisionTracker(room);
    if (tracker.current?.playerId === playerId) return tracker.current;

    tracker.current = {
        resolutionId: `resolution-${tracker.nextResolutionNumber}`,
        decisionType: getDecisionType(room),
        stepIndex: 0,
        playerId
    };
    tracker.nextResolutionNumber += 1;
    return tracker.current;
}

function completeDecisionStep(room, actorId, decisionMetadata) {
    if (!room?.decisionTracker || !decisionMetadata) return;
    const nextActorId = getDecisionActorId(room);
    if (room.pendingAbility && nextActorId === actorId) {
        room.decisionTracker.current = {
            resolutionId: decisionMetadata.resolutionId,
            decisionType: getDecisionType(room),
            stepIndex: decisionMetadata.stepIndex + 1,
            playerId: actorId
        };
        return;
    }
    room.decisionTracker.current = null;
}

function getPlayerObservation(room, playerId) {
    const observer = room?.players?.find(player => player.id === playerId);
    if (!room || !observer) return null;

    const pendingAbility = room.pendingAbility;
    let pendingDecision = null;
    if (pendingAbility) {
        const publicDecision = {
            type: pendingAbility.type,
            playerId: pendingAbility.playerId,
            sourceCardName: pendingAbility.sourceCardName || null,
            sourceBaseName: pendingAbility.sourceBaseName || null,
            controlledByObserver: pendingAbility.playerId === playerId
        };

        if (pendingAbility.playerId === playerId) {
            const { continuation, ...visibleDecision } = pendingAbility;
            pendingDecision = {
                ...cloneObservationValue(visibleDecision),
                controlledByObserver: true
            };
        } else {
            pendingDecision = publicDecision;
        }
    }

    const decisionMetadata = getOrCreateDecisionMetadata(room, playerId);
    return {
        schemaVersion: OBSERVATION_SCHEMA_VERSION,
        entityIdSchemaVersion: ENTITY_ID_SCHEMA_VERSION,
        observerPlayerId: playerId,
        resolutionId: decisionMetadata?.resolutionId || null,
        decisionType: decisionMetadata?.decisionType || null,
        stepIndex: decisionMetadata?.stepIndex ?? null,
        gamePhase: room.gamePhase || 'lobby',
        hostId: room.host || null,
        currentTurnPlayerId: room.currentTurnPlayerId || null,
        isObserverTurn: room.currentTurnPlayerId === playerId,
        players: room.players.map(player => ({
            id: player.id,
            name: player.name,
            isBot: player.isBot === true,
            online: player.online !== false,
            vp: Number.isFinite(player.vp) ? player.vp : 0,
            factions: cloneObservationValue(player.factions || []),
            factionEntityIds: (player.factions || []).map(getFactionEntityId),
            hand: player.id === playerId ? cloneObservationValue(player.hand || []) : null,
            handCount: player.hand?.length || 0,
            deckCount: player.deck?.length || 0,
            discardPile: cloneObservationValue(player.discardPile || [])
        })),
        activeBases: cloneObservationValue(room.activeBases || []),
        baseDeckCount: room.baseDeck?.length || 0,
        baseDiscardPile: cloneObservationValue(room.baseDiscardPile || []),
        turnState: cloneObservationValue(room.turnState || null),
        temporaryEffects: cloneObservationValue(room.temporaryEffects || []),
        pendingDecision,
        gameResult: cloneObservationValue(room.gameResult || null),
        draftState: room.draftState
            ? cloneObservationValue(sanitizeDraftState(room.draftState))
            : null,
        recentBattleLog: cloneObservationValue((room.battleLog || []).slice(0, 10))
    };
}

function ensureRoomTrajectory(room, roomId) {
    if (!room.rlTrajectory) {
        const startedAt = room.gameStartedAt || new Date().toISOString();
        room.rlTrajectory = {
            schemaVersion: TRAJECTORY_SCHEMA_VERSION,
            gameId: roomId,
            metadata: {
                trajectorySchemaVersion: TRAJECTORY_SCHEMA_VERSION,
                observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
                entityIdSchemaVersion: ENTITY_ID_SCHEMA_VERSION,
                gameId: roomId,
                policyVersion: room.botPolicyVersion || DEFAULT_BOT_POLICY_VERSION,
                randomSeed: room.randomSeed ?? null,
                randomAlgorithm: room.randomAlgorithm || RANDOM_ALGORITHM,
                startedAt,
                completedAt: null,
                terminationReason: null,
                terminated: false,
                truncated: false,
                decisionCount: 0,
                players: [],
                gameResult: null
            },
            nextDecisionIndex: 0,
            entries: [],
            pendingEntryIndexByPlayer: {}
        };
    }
    return room.rlTrajectory;
}

function syncTrajectoryMetadata(room, trajectory) {
    trajectory.metadata.players = room.players.map((player, seatIndex) => ({
        seatIndex,
        playerId: player.id,
        name: player.name,
        isBot: player.isBot === true,
        policyVersion: player.isBot === true
            ? player.policyVersion || trajectory.metadata.policyVersion
            : null,
        factions: cloneObservationValue(
            player.factions
            || room.draftState?.picks?.[player.id]
            || []
        ),
        factionEntityIds: (
            player.factions
            || room.draftState?.picks?.[player.id]
            || []
        ).map(getFactionEntityId),
        finalVictoryPoints: Number.isFinite(player.vp) ? player.vp : 0
    }));
    trajectory.metadata.decisionCount = trajectory.entries.length;
    trajectory.metadata.gameResult = cloneObservationValue(room.gameResult || null);
}

function getObservationVictoryPoints(observation, playerId) {
    const player = observation?.players?.find(candidate => candidate.id === playerId);
    return Number.isFinite(player?.vp) ? player.vp : 0;
}

function finalizePendingTrajectoryEntry(
    trajectory,
    playerId,
    nextObservation,
    { terminated = false, truncated = false, terminalRewards = {} } = {}
) {
    const entryIndex = trajectory.pendingEntryIndexByPlayer[playerId];
    if (!Number.isInteger(entryIndex)) return false;

    const entry = trajectory.entries[entryIndex];
    entry.nextObservation = cloneObservationValue(nextObservation);
    entry.vpReward = getObservationVictoryPoints(nextObservation, playerId)
        - getObservationVictoryPoints(entry.observation, playerId);
    entry.terminalReward = Number(terminalRewards[playerId]) || 0;
    entry.reward = entry.vpReward + entry.terminalReward;
    entry.terminated = terminated;
    entry.truncated = truncated;
    entry.done = terminated || truncated;
    delete trajectory.pendingEntryIndexByPlayer[playerId];
    return true;
}

function recordTrajectoryDecision({
    room,
    roomId,
    playerId,
    observation,
    legalActions,
    chosenAction,
    chosenActionIndex
}) {
    if (!room || !observation) return null;
    const trajectory = ensureRoomTrajectory(room, roomId);
    const pendingEntryIndex = trajectory.pendingEntryIndexByPlayer[playerId];
    if (room.gamePhase === 'finished' && !Number.isInteger(pendingEntryIndex)) {
        const previousEntry = [...trajectory.entries]
            .reverse()
            .find(entry => entry.playerId === playerId && entry.terminated);
        if (previousEntry) {
            previousEntry.nextObservation = cloneObservationValue(observation);
            previousEntry.vpReward = getObservationVictoryPoints(observation, playerId)
                - getObservationVictoryPoints(previousEntry.observation, playerId);
            previousEntry.terminalReward = 0;
            previousEntry.reward = previousEntry.vpReward;
            previousEntry.terminated = false;
            previousEntry.truncated = false;
            previousEntry.done = false;
        }
    }
    finalizePendingTrajectoryEntry(trajectory, playerId, observation);

    const resolvedActionIndex = Number.isInteger(chosenActionIndex)
        && chosenActionIndex >= 0
        && chosenActionIndex < legalActions.length
        && JSON.stringify(legalActions[chosenActionIndex]) === JSON.stringify(chosenAction)
        ? chosenActionIndex
        : legalActions.findIndex(action => JSON.stringify(action) === JSON.stringify(chosenAction));
    const entry = {
        decisionIndex: trajectory.nextDecisionIndex,
        playerId,
        resolutionId: observation.resolutionId || null,
        decisionType: observation.decisionType || null,
        stepIndex: observation.stepIndex ?? null,
        observation: cloneObservationValue(observation),
        legalActions: cloneObservationValue(legalActions),
        chosenActionIndex: resolvedActionIndex >= 0 ? resolvedActionIndex : null,
        chosenAction: cloneObservationValue(chosenAction),
        reward: null,
        vpReward: null,
        terminalReward: 0,
        nextObservation: null,
        terminated: false,
        truncated: false,
        done: false
    };
    trajectory.nextDecisionIndex += 1;
    trajectory.entries.push(entry);
    trajectory.pendingEntryIndexByPlayer[playerId] = trajectory.entries.length - 1;
    if (room.gamePhase === 'finished') {
        finalizePendingTrajectoryEntry(
            trajectory,
            playerId,
            getPlayerObservation(room, playerId),
            {
                terminated: true,
                terminalRewards: room.terminalRewards || {}
            }
        );
    }
    return cloneObservationValue(entry);
}

function finalizeRoomTrajectory(
    room,
    {
        terminated = false,
        truncated = false,
        terminalRewards = {},
        terminationReason = null,
        cloneResult = true
    } = {}
) {
    if (!room?.rlTrajectory) return null;
    const trajectory = room.rlTrajectory;
    Object.keys(trajectory.pendingEntryIndexByPlayer).forEach(playerId => {
        finalizePendingTrajectoryEntry(
            trajectory,
            playerId,
            getPlayerObservation(room, playerId),
            { terminated, truncated, terminalRewards }
        );
    });
    if ((terminated || truncated) && !trajectory.metadata.completedAt) {
        trajectory.metadata.completedAt = new Date().toISOString();
        trajectory.metadata.terminationReason = terminationReason
            || (terminated ? 'terminated' : 'truncated');
        trajectory.metadata.terminated = terminated;
        trajectory.metadata.truncated = truncated;
    }
    syncTrajectoryMetadata(room, trajectory);
    return getRoomTrajectory(room, { clone: cloneResult });
}

function getRoomTrajectory(room, { clone = true } = {}) {
    if (!room?.rlTrajectory) return null;
    syncTrajectoryMetadata(room, room.rlTrajectory);
    const {
        pendingEntryIndexByPlayer,
        nextDecisionIndex,
        ...trajectory
    } = room.rlTrajectory;
    return clone ? cloneObservationValue(trajectory) : trajectory;
}

function exportRoomTrajectoryJson(room, { pretty = false } = {}) {
    const trajectory = getRoomTrajectory(room, { clone: false });
    if (!trajectory) return null;
    return JSON.stringify(trajectory, null, pretty ? 2 : undefined);
}

function buildFinalStandings(room) {
    const seatOrder = new Map(room.players.map((player, index) => [player.id, index]));
    const sortedPlayers = [...room.players].sort((left, right) => (
        (right.vp || 0) - (left.vp || 0)
        || seatOrder.get(left.id) - seatOrder.get(right.id)
    ));
    let previousVictoryPoints = null;
    let previousRank = 0;

    return sortedPlayers.map((player, index) => {
        const victoryPoints = Number.isFinite(player.vp) ? player.vp : 0;
        const rank = victoryPoints === previousVictoryPoints ? previousRank : index + 1;
        previousVictoryPoints = victoryPoints;
        previousRank = rank;
        return {
            rank,
            playerId: player.id,
            name: player.name,
            vp: victoryPoints,
            isBot: player.isBot === true,
            factions: cloneObservationValue(player.factions || []),
            factionEntityIds: (player.factions || []).map(getFactionEntityId)
        };
    });
}

function getCompletedGameResult(room) {
    if (!room?.players?.length) return null;
    const standings = buildFinalStandings(room);
    const leadingVictoryPoints = standings[0]?.vp || 0;
    const leaders = standings.filter(standing => standing.vp === leadingVictoryPoints);
    if (leadingVictoryPoints < WINNING_VICTORY_POINTS || leaders.length !== 1) return null;

    return {
        winnerId: leaders[0].playerId,
        winnerName: leaders[0].name,
        winningVictoryPoints: leadingVictoryPoints,
        standings
    };
}

function finishGameIfNeeded(
    room,
    roomId,
    { stopBotController = targetRoomId => botTurnController.stop(targetRoomId) } = {}
) {
    if (!room || room.gamePhase === 'finished') return room?.gameResult || null;
    const gameResult = getCompletedGameResult(room);
    if (!gameResult) return null;

    room.gamePhase = 'finished';
    room.currentTurnPlayerId = null;
    room.gameResult = gameResult;
    room.terminalRewards = Object.fromEntries(room.players.map(player => [
        player.id,
        player.id === gameResult.winnerId ? WIN_REWARD : LOSS_REWARD
    ]));
    addBattleLog(
        room,
        `**${gameResult.winnerName}** wins the game with **${gameResult.winningVictoryPoints} victory points**!`
    );
    finalizeRoomTrajectory(room, {
        terminated: true,
        terminalRewards: room.terminalRewards,
        terminationReason: 'victory',
        cloneResult: false
    });
    stopBotController(roomId);
    return gameResult;
}

function getActionCardEntityId(room, instanceId) {
    if (!instanceId) return UNKNOWN_ENTITY_ID;
    return getCardEntityId(findCardByInstanceId(room, instanceId));
}

function annotateLegalActionEntityIds(room, action) {
    const choice = action.choice || {};
    const baseIndex = Number.isInteger(action.baseIndex)
        ? action.baseIndex
        : Number.isInteger(choice.baseIndex)
            ? choice.baseIndex
            : null;
    const base = choice.baseInstanceId
        || (baseIndex === null ? null : room.activeBases?.[baseIndex]);
    const selectedInstanceIds = [
        ...(Array.isArray(choice.cardInstanceIds) ? choice.cardInstanceIds : []),
        ...(Array.isArray(choice.minionInstanceIds) ? choice.minionInstanceIds : [])
    ];

    return {
        ...action,
        entityIds: {
            cardEntityId: getActionCardEntityId(
                room,
                action.cardInstanceId || choice.cardInstanceId
            ),
            targetCardEntityId: getActionCardEntityId(
                room,
                action.targetMinionInstanceId || choice.minionInstanceId
            ),
            baseEntityId: getBaseEntityId(base),
            factionEntityId: getFactionEntityId(action.factionName || choice.faction),
            selectedCardEntityIds: selectedInstanceIds.map(instanceId => (
                getActionCardEntityId(room, instanceId)
            ))
        }
    };
}

function annotateLegalActionEntityIdsList(room, legalActions) {
    return legalActions.map(action => annotateLegalActionEntityIds(room, action));
}

function getLegalActions(room, actorId) {
    const player = room?.players?.find(candidate => candidate.id === actorId);
    if (!room || !player) return [];

    if (room.pendingAbility) {
        if (room.pendingAbility.playerId !== actorId) return [];
        return annotateLegalActionEntityIdsList(room, getLegalAbilityChoiceActions(room, actorId));
    }

    if (room.gamePhase === 'drafting') {
        const legalActions = (room.draftState?.availableFactions || [])
            .map(factionName => ({ type: 'draft-faction', factionName }))
            .filter(action => validateDraftFactionAction(room, actorId, action).ok);
        return annotateLegalActionEntityIdsList(room, legalActions);
    }

    if (room.gamePhase !== 'playing') return [];

    const legalActions = [
        ...getLegalCardPlayActions(room, actorId, player.hand, false),
        ...getLegalCardPlayActions(room, actorId, player.discardPile, true)
    ];

    if (validateUseTalentAction(room, actorId).ok) {
        room.activeBases
            .flatMap(getBaseMinions)
            .filter(minion => minion.ownerId === actorId)
            .forEach(minion => {
                if (validateTalentActivation(room, actorId, minion.instanceId).ok) {
                    legalActions.push({
                        type: 'use-talent',
                        cardInstanceId: minion.instanceId
                    });
                }
            });
    }

    if (validateEndTurnAction(room, actorId).ok) legalActions.push({ type: 'end-turn' });
    return annotateLegalActionEntityIdsList(room, legalActions);
}

function getLegalCardPlayActions(room, actorId, cards, fromDiscard) {
    return (cards || []).flatMap(card => {
        let candidates;
        if (card.subtype === 'base') {
            candidates = room.activeBases.map((base, baseIndex) => ({
                type: 'play-card',
                cardInstanceId: card.instanceId,
                baseIndex,
                fromDiscard
            }));
        } else if (['ally-minion', 'enemy-minion', 'neutral-minion'].includes(card.subtype)) {
            candidates = room.activeBases.flatMap((base, baseIndex) => (
                getBaseMinions(base).map(minion => ({
                    type: 'play-card',
                    cardInstanceId: card.instanceId,
                    baseIndex,
                    targetMinionInstanceId: minion.instanceId,
                    fromDiscard
                }))
            ));
        } else {
            candidates = [{
                type: 'play-card',
                cardInstanceId: card.instanceId,
                fromDiscard
            }];
        }

        return candidates.filter(action => validatePlayCardAction(room, actorId, action).ok);
    });
}

function createAbilityChoiceAction(choice) {
    return { type: 'resolve-ability-choice', choice };
}

function getLegalAbilityChoiceActions(room, actorId) {
    const pending = room.pendingAbility;
    const player = room.players.find(candidate => candidate.id === actorId);
    const fromChoices = choices => choices.map(createAbilityChoiceAction);
    const existingMinionIds = candidateIds => (candidateIds || []).filter(instanceId => (
        Boolean(findMinionOnBoard(room, instanceId))
    ));
    const existingCardIds = (cards, candidateIds) => {
        const allowedIds = new Set(candidateIds || []);
        return (cards || []).filter(card => allowedIds.has(card.instanceId)).map(card => card.instanceId);
    };

    switch (pending.type) {
        case 'confirmation':
            return fromChoices([{ choiceId: 'accept' }, { choiceId: 'skip' }]);
        case 'discardToHand': {
            const actions = fromChoices(existingCardIds(player.discardPile, pending.candidateIds)
                .map(cardInstanceId => ({ cardInstanceId })));
            if (pending.canSkip) actions.push(createAbilityChoiceAction({ skip: true }));
            return actions;
        }
        case 'playerHandReveal':
            return fromChoices((pending.candidatePlayerIds || [])
                .filter(playerId => room.players.some(candidate => candidate.id === playerId))
                .map(playerId => ({ playerId })));
        case 'handDiscard': {
            const selectedPlayer = room.players.find(candidate => candidate.id === pending.selectedPlayerId);
            return fromChoices(existingCardIds(selectedPlayer?.hand, pending.candidateIds)
                .map(cardInstanceId => ({ cardInstanceId })));
        }
        case 'handLimitDiscard':
            if (player.isBot !== true || player.hand.length <= MAX_HAND_SIZE) return [];
            return fromChoices(existingCardIds(player.hand, pending.candidateIds)
                .map(cardInstanceId => ({ cardInstanceId })));
        case 'baseDeckSwap':
            return fromChoices((pending.candidateBaseIds || [])
                .filter(baseId => room.baseDeck?.some(base => base.id === baseId))
                .map(baseInstanceId => ({ baseInstanceId })));
        case 'attachedActionSelection': {
            const minion = findMinionOnBoard(room, pending.targetMinionInstanceId);
            return [
                ...fromChoices(existingCardIds(minion?.attachedCards, pending.candidateIds)
                    .map(cardInstanceId => ({ cardInstanceId }))),
                createAbilityChoiceAction({ skip: true })
            ];
        }
        case 'seaDogsFaction':
            return fromChoices((pending.factions || []).map(faction => ({ faction })));
        case 'seaDogsDestination': {
            const sourceBase = room.activeBases[pending.sourceBaseIndex];
            if (!sourceBase || isMovementPrevented(sourceBase, actorId)) return [];
            return fromChoices((pending.candidateBaseIndices || [])
                .filter(baseIndex => room.activeBases[baseIndex] && room.activeBases[baseIndex] !== sourceBase)
                .map(baseIndex => ({ baseIndex })));
        }
        case 'disguiseSelection':
            return [
                ...fromChoices(existingMinionIds(pending.candidateIds)
                    .map(minionInstanceId => ({ minionInstanceId }))),
                createAbilityChoiceAction({ skip: true })
            ];
        case 'multiZoneSelection': {
            const zoneCards = player[pending.zone] || [];
            const candidateIds = existingCardIds(zoneCards, pending.candidateIds);
            const actions = fromChoices(candidateIds.map(cardInstanceId => ({ cardInstanceId })));
            if (pending.canSkip) actions.push(createAbilityChoiceAction({ skip: true }));
            return actions;
        }
        case 'deckReorder': {
            const cardIds = existingCardIds(player.deck, pending.cardIds);
            if (cardIds.length !== pending.cardIds.length) return [];
            const orderedIds = pending.orderedIds || [];
            if (new Set(orderedIds).size !== orderedIds.length
                || orderedIds.some(instanceId => !cardIds.includes(instanceId))) return [];
            return fromChoices(cardIds
                .filter(instanceId => !orderedIds.includes(instanceId))
                .map(cardInstanceId => ({ cardInstanceId })));
        }
        case 'discardPlayCard':
        case 'discardPlayEach': {
            const actions = fromChoices(existingCardIds(player.discardPile, pending.candidateIds)
                .map(cardInstanceId => ({ cardInstanceId })));
            if (pending.canSkip || pending.type === 'discardPlayEach') {
                actions.push(createAbilityChoiceAction({ skip: true }));
            }
            return actions;
        }
        case 'discardPlayBase':
            return fromChoices((pending.candidateBaseIndices || [])
                .filter(baseIndex => Boolean(room.activeBases[baseIndex]))
                .map(baseIndex => ({ baseIndex })));
        case 'topDeckReveal': {
            const choiceIds = pending.mode === 'discardOrReturn'
                ? ['discard', 'return']
                : pending.mode === 'actionToHandOrExtra'
                    ? ['hand', 'playExtra']
                    : ['playExtra', 'return'];
            if (player.deck?.[0]?.instanceId !== pending.cardInstanceId) return [];
            return fromChoices(choiceIds.map(choiceId => ({ choiceId })));
        }
        case 'massEnchantment': {
            const actions = (pending.candidates || [])
                .filter(candidate => room.players.find(owner => owner.id === candidate.playerId)
                    ?.deck?.[0]?.instanceId === candidate.cardInstanceId)
                .map(candidate => createAbilityChoiceAction({ cardInstanceId: candidate.cardInstanceId }));
            actions.push(createAbilityChoiceAction({ skip: true }));
            return actions;
        }
        case 'deckNameSelection':
            return fromChoices(existingCardIds(player.deck, pending.candidateIds)
                .map(cardInstanceId => ({ cardInstanceId })));
        case 'selectedPlayerBoardEffect':
            return fromChoices((pending.candidatePlayerIds || [])
                .filter(playerId => room.players.some(candidate => candidate.id === playerId))
                .map(playerId => ({ playerId })));
        case 'selectedPlayerBoardEffectBase':
            return fromChoices((pending.candidateBaseIndices || [])
                .filter(baseIndex => Boolean(room.activeBases[baseIndex]))
                .map(baseIndex => ({ baseIndex })));
        case 'moveDestination': {
            const sourceBase = room.activeBases[pending.sourceBaseIndex];
            const minion = sourceBase && getBaseMinions(sourceBase)
                .find(candidate => candidate.instanceId === pending.minionInstanceId);
            if (!sourceBase || !minion || isMovementPrevented(sourceBase, actorId)) return [];
            return fromChoices(room.activeBases
                .map((base, baseIndex) => ({ base, baseIndex }))
                .filter(({ base }) => base !== sourceBase)
                .map(({ baseIndex }) => ({ baseIndex })));
        }
        case 'moveTarget': {
            const actions = existingMinionIds(pending.candidateIds)
                .filter(instanceId => {
                    const sourceBase = getBaseForMinion(room, instanceId);
                    return sourceBase && room.activeBases.length > 1
                        && !isMovementPrevented(sourceBase, actorId);
                })
                .map(minionInstanceId => createAbilityChoiceAction({ minionInstanceId }));
            actions.push(createAbilityChoiceAction({ skip: true }));
            return actions;
        }
        case 'moveTargetBatch': {
            const candidateIds = existingMinionIds(pending.candidateIds).filter(instanceId => (
                !isMovementPrevented(getBaseForMinion(room, instanceId), actorId)
            ));
            const actions = fromChoices(candidateIds.map(minionInstanceId => ({ minionInstanceId })));
            if ((pending.selectedIds || []).length > 0) {
                actions.push(createAbilityChoiceAction({ finishSelection: true }));
            } else {
                actions.push(createAbilityChoiceAction({ cancel: true }));
            }
            return actions;
        }
        case 'boardEffect': {
            const actions = fromChoices(existingMinionIds(pending.candidateIds)
                .map(minionInstanceId => ({ minionInstanceId })));
            if (pending.canSkip && pending.remainingSelections > 0) {
                actions.push(createAbilityChoiceAction({ skip: true }));
            }
            return actions;
        }
        case 'boardEffectBatch': {
            const actions = fromChoices(existingMinionIds(pending.candidateIds)
                .map(minionInstanceId => ({ minionInstanceId })));
            if ((pending.selectedIds || []).length > 0) {
                actions.push(createAbilityChoiceAction({ finishSelection: true }));
            } else {
                actions.push(createAbilityChoiceAction({ cancel: true }));
            }
            return actions;
        }
        case 'naturalSelection': {
            const base = room.activeBases[pending.baseIndex];
            const sourceMinion = base && getBaseMinions(base)
                .find(minion => minion.instanceId === pending.sourceMinionInstanceId);
            if (!base || !sourceMinion) return [];
            return fromChoices(getBaseMinions(base)
                .filter(minion => pending.candidateIds.includes(minion.instanceId)
                    && getCardPower(minion) < getCardPower(sourceMinion))
                .map(minion => ({
                    baseIndex: pending.baseIndex,
                    minionInstanceId: minion.instanceId
                })));
        }
        case 'survivalOfTheFittest': {
            const nextChoice = pending.pendingChoices?.[0];
            const base = room.activeBases[nextChoice?.baseIndex];
            if (!base) return [];
            return fromChoices(getBaseMinions(base)
                .filter(minion => nextChoice.candidateIds.includes(minion.instanceId))
                .map(minion => ({
                    baseIndex: nextChoice.baseIndex,
                    minionInstanceId: minion.instanceId
                })));
        }
        case 'triggeredBeforeScoreShinobi':
        case 'triggeredBeforeScoreHiddenNinja':
        case 'triggeredBeforeScoreFullSail':
        case 'triggeredBeforeScorePirateKing':
        case 'triggeredBaseExtraPlay':
        case 'triggeredAfterScoreScout':
        case 'triggeredAfterScoreFirstMate':
        case 'triggeredOptionalDraw':
            return fromChoices([{ choiceId: 'accept' }, { choiceId: 'skip' }]);
        case 'triggeredBeforeScoreHiddenNinjaMinion':
            return fromChoices(existingCardIds(player.hand, pending.candidateIds)
                .map(cardInstanceId => ({ cardInstanceId })));
        case 'triggeredAfterScoreFirstMateDestination':
        case 'triggeredBaseWinnerMoveDestination':
            return fromChoices(room.activeBases
                .map((base, baseIndex) => ({ base, baseIndex }))
                .filter(({ base }) => pending.destinationBaseIds?.includes(base.id))
                .map(({ baseIndex }) => ({ baseIndex })));
        case 'triggeredBaseWinnerMoveMinion':
            return [
                ...fromChoices((pending.candidateMinions || [])
                    .filter(minion => Boolean(getHeldScoredMinion(room, minion.instanceId)))
                    .map(minion => ({ minionInstanceId: minion.instanceId }))),
                createAbilityChoiceAction({ choiceId: 'skip' })
            ];
        case 'triggeredBuccaneer':
            return [
                ...fromChoices((pending.candidateBaseIndices || [])
                    .filter(baseIndex => Boolean(room.activeBases[baseIndex]))
                    .map(baseIndex => ({ baseIndex }))),
                createAbilityChoiceAction({ choiceId: 'skip' })
            ];
        default:
            return [];
    }
}

function getBotDecisionActorId(room) {
    if (!room) return null;

    const pendingPlayerId = room.pendingAbility?.playerId;
    if (pendingPlayerId) {
        return room.players.some(player => player.id === pendingPlayerId && player.isBot === true)
            ? pendingPlayerId
            : null;
    }

    if (room.gamePhase === 'drafting') {
        const currentPickerId = room.draftState?.draftOrder?.[room.draftState.currentTurnIndex];
        return room.players.some(player => player.id === currentPickerId && player.isBot === true)
            ? currentPickerId
            : null;
    }

    if (room.gamePhase === 'playing') {
        return room.players.some(player => (
            player.id === room.currentTurnPlayerId && player.isBot === true
        )) ? room.currentTurnPlayerId : null;
    }

    return null;
}

function chooseDefaultBotAction({ legalActions, random = systemRandom }) {
    if (!legalActions.length) return null;
    return legalActions[chooseDefaultBotActionIndex({ legalActions, random })];
}

function chooseDefaultBotActionIndex({ legalActions, random = systemRandom }) {
    if (!legalActions.length) return null;
    return Math.min(
        Math.floor(random() * legalActions.length),
        legalActions.length - 1
    );
}

function chooseConfiguredBotActionIndex(context) {
    const player = context.room?.players?.find(candidate => candidate.id === context.actorId);
    const policyVersion = player?.policyVersion
        || context.room?.botPolicyVersion
        || DEFAULT_BOT_POLICY_VERSION;
    const policy = getBotPolicy(policyVersion);
    if (!policy) throw new Error(`Unsupported bot policy: ${policyVersion}`);
    return policy(context);
}

function createBotTurnController({
    getRoom,
    getActions = getLegalActions,
    getObservation = getPlayerObservation,
    executeAction,
    chooseAction = chooseConfiguredBotActionIndex,
    recordDecision = recordTrajectoryDecision,
    getRandom = nextSeededRandom,
    delayMs = BOT_ACTION_DELAY_MS,
    maxConsecutiveActions = MAX_CONSECUTIVE_BOT_ACTIONS,
    schedule = (callback, delay) => {
        const timer = setTimeout(callback, delay);
        timer.unref?.();
        return timer;
    },
    clearSchedule = clearTimeout,
    onAction = () => {},
    onError = () => {}
}) {
    const roomStates = new Map();

    const getControllerState = roomId => {
        if (!roomStates.has(roomId)) {
            roomStates.set(roomId, {
                consecutiveActions: 0,
                isScheduled: false,
                lastActorId: null,
                running: false,
                timerHandle: null,
                wakeRequested: false
            });
        }
        return roomStates.get(roomId);
    };

    const reportError = (roomId, actorId, error) => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        onError({ roomId, actorId, error: normalizedError });
    };

    const actionsMatch = (left, right) => JSON.stringify(left) === JSON.stringify(right);

    const wake = roomId => {
        const room = getRoom(roomId);
        const actorId = getBotDecisionActorId(room);
        const state = getControllerState(roomId);

        if (!actorId) {
            if (!state.running && !state.isScheduled) {
                state.consecutiveActions = 0;
                state.lastActorId = null;
            }
            return false;
        }

        if (state.running || state.isScheduled) {
            state.wakeRequested = true;
            return true;
        }

        state.isScheduled = true;
        state.timerHandle = schedule(() => {
            state.isScheduled = false;
            state.timerHandle = null;
            return runRoom(roomId);
        }, delayMs);
        return true;
    };

    const runRoom = async roomId => {
        const state = getControllerState(roomId);
        if (state.running) {
            state.wakeRequested = true;
            return { ok: false, reason: 'already_running' };
        }

        const room = getRoom(roomId);
        const actorId = getBotDecisionActorId(room);
        if (!room || !actorId) return { ok: false, reason: 'no_bot_decision' };

        state.running = true;
        state.wakeRequested = false;
        let actionSucceeded = false;

        try {
            const legalActions = getActions(room, actorId);
            if (legalActions.length === 0) {
                throw new Error('No legal actions are available for this bot decision.');
            }

            const observation = getObservation(room, actorId);
            const actionIndex = await chooseAction({
                actorId,
                legalActions,
                observation,
                random: () => getRandom(room),
                room,
                roomId
            });
            if (!Number.isInteger(actionIndex)
                || actionIndex < 0
                || actionIndex >= legalActions.length) {
                throw new Error('The bot policy did not select a valid legal-action index.');
            }
            const selectedAction = legalActions[actionIndex];

            const currentRoom = getRoom(roomId);
            const currentActorId = getBotDecisionActorId(currentRoom);
            const currentLegalActions = currentActorId === actorId
                ? getActions(currentRoom, actorId)
                : [];
            const currentActionIndex = currentLegalActions.findIndex(legalAction => (
                actionsMatch(legalAction, selectedAction)
            ));
            if (currentActionIndex < 0) {
                throw new Error('The bot policy selected an action that is no longer legal.');
            }
            const action = currentLegalActions[currentActionIndex];
            const currentObservation = getObservation(currentRoom, actorId);

            const result = await executeAction({
                action,
                actorId,
                room: currentRoom,
                roomId
            });
            if (!result?.ok) throw new Error(result?.error || 'The bot action was rejected.');

            recordDecision({
                chosenAction: action,
                chosenActionIndex: currentActionIndex,
                legalActions: currentLegalActions,
                observation: currentObservation,
                playerId: actorId,
                room: currentRoom,
                roomId
            });

            if (state.lastActorId !== actorId) state.consecutiveActions = 0;
            state.lastActorId = actorId;
            state.consecutiveActions += 1;
            actionSucceeded = true;
            onAction({ action, actionIndex: currentActionIndex, actorId, result, roomId });
            return { ok: true, action, actionIndex: currentActionIndex, actorId, result };
        } catch (error) {
            reportError(roomId, actorId, error);
            return { ok: false, error, reason: 'action_failed' };
        } finally {
            state.running = false;
            const shouldRecheck = actionSucceeded || state.wakeRequested;
            state.wakeRequested = false;
            if (shouldRecheck) {
                const nextActorId = getBotDecisionActorId(getRoom(roomId));
                if (!nextActorId) {
                    state.consecutiveActions = 0;
                    state.lastActorId = null;
                } else {
                    if (nextActorId !== state.lastActorId) state.consecutiveActions = 0;
                    if (state.consecutiveActions < maxConsecutiveActions) {
                        wake(roomId);
                    } else {
                        reportError(
                            roomId,
                            nextActorId,
                            new Error(`Bot exceeded ${maxConsecutiveActions} consecutive actions.`)
                        );
                    }
                }
            }
        }
    };

    const runNow = roomId => {
        const state = getControllerState(roomId);
        if (state.isScheduled) {
            clearSchedule(state.timerHandle);
            state.isScheduled = false;
            state.timerHandle = null;
        }
        return runRoom(roomId);
    };

    const stop = roomId => {
        const state = roomStates.get(roomId);
        if (!state) return false;
        if (state.isScheduled) clearSchedule(state.timerHandle);
        roomStates.delete(roomId);
        return true;
    };

    return {
        getStatus: roomId => ({ ...(roomStates.get(roomId) || {}) }),
        runNow,
        stop,
        wake
    };
}

function resolveOnPlayBoardEffects({ room, roomId, socket, playedCard, targetBase, targetMinion }) {
    if (playedCard.cardId === 'ninja_disguise_1') {
        queueDisguiseSelection(room, roomId, socket, targetBase, targetMinion);
        return;
    }

    const effects = (playedCard.abilities || [])
        .filter(ability => (
            ability.trigger === 'onPlay'
            && isAbilityConditionMet(ability, room.turnState)
            && ability.effects.every(isOnPlayEffectSupported)
        ))
        .flatMap(ability => ability.effects.map(effect => ({ effect, optional: Boolean(ability.optional) })));

    continueOnPlayEffects(room, roomId, socket, effects, {
        sourceMinionInstanceId: playedCard.type === 'minion' ? playedCard.instanceId : null,
        sourceCardInstanceId: playedCard.instanceId,
        sourceCardType: playedCard.type,
        selectedPlayerId: null,
        replacementBaseIndex: null,
        targetBaseIndex: room.activeBases.indexOf(targetBase),
        targetMinionInstanceId: targetMinion?.instanceId || null
    });
}

function continueOnPlayEffects(room, roomId, socket, effects, context) {
    room.currentResolutionContext = context;
    for (let effectIndex = 0; effectIndex < effects.length; effectIndex += 1) {
        const { effect, optional } = effects[effectIndex];
        const targetBase = room.activeBases[context.targetBaseIndex];
        const targetMinion = findMinionOnBoard(room, context.targetMinionInstanceId)
            || findCardByInstanceId(room, context.targetMinionInstanceId);
        const isWaitingForChoice = resolveBoardEffect({
            room,
            roomId,
            socket,
            effect,
            optional,
            sourceMinionInstanceId: context.sourceMinionInstanceId,
            sourceCardInstanceId: context.sourceCardInstanceId,
            selectedPlayerId: context.selectedPlayerId,
            replacementBaseIndex: context.replacementBaseIndex,
            targetBase,
            targetMinion
        });
        if (isWaitingForChoice && room.pendingAbility) {
            room.pendingAbility.continuation = { effects: effects.slice(effectIndex + 1), context };
            room.currentResolutionContext = null;
            return;
        }
        if (isWaitingForChoice === 'unsupported') {
            room.currentResolutionContext = null;
            return;
        }
    }
    room.currentResolutionContext = null;
    finishOnPlayResolution(room);
}

function resumeOnPlayContinuation(room, roomId, socket, continuation) {
    if (!continuation?.effects?.length) {
        finishOnPlayResolution(room);
        return;
    }
    if (room.pendingAbility) {
        room.pendingAbility.continuation = continuation;
        return;
    }
    continueOnPlayEffects(room, roomId, socket, continuation.effects, continuation.context);
}

function finishOnPlayResolution(room) {
    if (room.pendingAbility || typeof room.afterOnPlayResolution !== 'function') return;
    const callback = room.afterOnPlayResolution;
    room.afterOnPlayResolution = null;
    callback();
}

function isOnPlayEffectSupported(effect) {
    const supportedTypes = new Set([
        'modifyPower',
        'modifyBreakpoint',
        'gainVictoryPoints',
        'drawCards',
        'grantExtraPlay',
        'moveMinion',
        'moveToDeck',
        'moveFromDiscardToHand',
        'revealTopDeckCard',
        'revealDeckCards',
        'searchDeck',
        'shuffleDiscardIntoDeck',
        'shuffleHandIntoDeck',
        'playFromDiscard',
        'grantExtraPlayFromDiscard',
        'revealHand',
        'discardFromHand',
        'swapBaseFromDeck',
        'destroyAction',
        'destroyLowestPowerMinion',
        'destroyMinion',
        'returnToHand'
    ]);

    if (!supportedTypes.has(effect.type)) return false;
    if (effect.type === 'grantExtraPlay') return !effect.destination
        || effect.destination === 'replacementBase'
        || effect.destination?.filter === 'controllerHasNoMinions';
    if (effect.type === 'moveMinion') return effect.target === 'selectedMinion'
        || effect.target?.kind === 'minion';
    if (effect.type === 'revealTopDeckCard') return effect.target === 'controller'
        || effect.target?.quantity === 'all';
    if (effect.type === 'searchDeck') return effect.cardType === 'action'
        || effect.resolve?.type === 'moveCardsWithSelectedNameToDiscard';
    return true;
}

function resolveBoardEffect({ room, roomId, socket, effect, optional, sourceMinionInstanceId, sourceCardInstanceId, selectedPlayerId, replacementBaseIndex, targetBase, targetMinion }) {
    if (targetBase
        && effect.condition?.controllerHasMinionAt === 'selectedBase'
        && !getBaseMinions(targetBase).some(minion => minion.ownerId === socket.id)) {
        return false;
    }

    switch (effect.type) {
        case 'modifyPower':
            if (effect.target === 'selectedMinion' && targetMinion) {
                applyTemporaryPowerModifier(room, [targetMinion], effect.amount);
            } else if (effect.target?.location === 'inPlay' && effect.target?.owner === 'controller') {
                applyTemporaryPowerModifier(
                    room,
                    room.activeBases.flatMap(getBaseMinions).filter(minion => minion.ownerId === socket.id),
                    effect.amount
                );
            } else if (effect.target?.kind === 'minion') {
                const targets = getEligibleMinions(room, socket.id, effect.target, targetBase, targetMinion);
                applyTemporaryPowerModifier(room, targets, effect.amount);
            }
            return false;
        case 'modifyBreakpoint':
            if (targetBase && targetMinion) {
                applyTemporaryBreakpointModifier(room, targetBase, getCardPower(targetMinion));
            }
            return false;
        case 'gainVictoryPoints': {
            const player = room.players.find(candidate => candidate.id === socket.id);
            if (player) player.vp += effect.amount;
            return false;
        }
        case 'drawCards':
            drawCards(room, socket.id, getEffectAmount(effect.amount, room, socket.id, targetBase, targetMinion));
            return false;
        case 'grantExtraPlay':
            if (optional) {
                queueConfirmation(socket, room, roomId, effect, `Use this ability to play ${formatExtraPlay(effect)}?`);
                return true;
            }
            grantExtraPlay(room, effect, replacementBaseIndex);
            return false;
        case 'moveMinion':
            if (effect.target?.faction === 'namedFaction') {
                return queueSeaDogsFaction(room, roomId, socket, targetBase);
            }
            return beginMoveMinionEffect(room, roomId, socket, effect, targetMinion, targetBase);
        case 'moveToDeck':
            if (targetMinion && targetBase && getCardPower(targetMinion) <= effect.target?.power?.max) {
                moveMinionToOwnersDeck(room, targetBase, targetMinion, effect.position);
            }
            return false;
        case 'moveFromDiscardToHand':
            return queueDiscardToHand(room, roomId, socket, effect, optional);
        case 'revealTopDeckCard':
            if (effect.target?.quantity === 'all') return queueMassEnchantment(room, roomId, socket);
            return queueTopDeckReveal(room, roomId, socket, effect, optional);
        case 'revealDeckCards':
            return queueRevealedDeckSelection(room, roomId, socket, effect);
        case 'searchDeck':
            if (effect.resolve?.type === 'moveCardsWithSelectedNameToDiscard') {
                return queueDeckNameSelection(room, roomId, socket);
            }
            return queueDeckSearch(room, roomId, socket, effect);
        case 'shuffleDiscardIntoDeck':
            return queueDiscardShuffle(room, roomId, socket, effect);
        case 'shuffleHandIntoDeck':
            shuffleHandIntoDeck(room, socket.id);
            return false;
        case 'playFromDiscard':
        case 'grantExtraPlayFromDiscard':
            return queueDiscardPlay(room, roomId, socket, effect, optional);
        case 'revealHand':
            return queuePlayerHandReveal(room, roomId, socket);
        case 'discardFromHand':
            return queueHandDiscard(room, roomId, socket, selectedPlayerId, effect);
        case 'swapBaseFromDeck':
            return queueBaseDeckSwap(room, roomId, socket, targetBase);
        case 'destroyAction':
            return queueAttachedActionDestruction(room, roomId, socket, targetMinion, sourceCardInstanceId);
        case 'destroyLowestPowerMinion':
            beginSurvivalOfTheFittest(room, roomId, socket);
            return Boolean(room.pendingAbility);
        case 'destroyMinion':
        case 'returnToHand':
            if (effect.target?.owner === 'selectedPlayer' && effect.target?.quantity === 'all') {
                return queueSelectedPlayerBoardEffect(room, roomId, socket, effect, targetBase);
            }
            return resolveMinionBoardEffect({ room, roomId, socket, effect, optional, sourceMinionInstanceId, targetBase, targetMinion });
        default:
            return 'unsupported';
    }
}

function queueDiscardToHand(room, roomId, socket, effect, optional) {
    const player = room.players.find(candidate => candidate.id === socket.id);
    const candidates = (player?.discardPile || []).filter(card => (
        effect.target?.kind !== 'minion' || card.type === 'minion'
    ));
    if (candidates.length === 0) return false;

    room.pendingAbility = {
        type: 'discardToHand',
        playerId: socket.id,
        candidateIds: candidates.map(card => card.instanceId),
        canSkip: optional,
        quantityAny: effect.target?.quantity === 'any',
        selectedName: null
    };
    socket.emit('ability-choice-required', {
        roomId,
        message: 'Choose a card from your discard pile to return to your hand.',
        canSkip: optional,
        choices: candidates.map(card => ({
            choiceId: `discard:${card.instanceId}`,
            cardInstanceId: card.instanceId,
            label: `${card.name}${card.type === 'minion' ? ` (Power: ${getCardPower(card)})` : ''}`
        }))
    });
    return true;
}

function queuePlayerHandReveal(room, roomId, socket) {
    const candidates = room.players.filter(player => player.id !== socket.id);
    if (candidates.length === 0) return false;

    room.pendingAbility = {
        type: 'playerHandReveal',
        playerId: socket.id,
        candidatePlayerIds: candidates.map(player => player.id)
    };
    socket.emit('ability-choice-required', {
        roomId,
        message: 'Choose a player whose hand to reveal.',
        choices: candidates.map(player => ({
            choiceId: `player:${player.id}`,
            playerId: player.id,
            label: player.name
        }))
    });
    return true;
}

function resolvePlayerHandReveal(room, socket, choice, continuation) {
    const pendingAbility = room.pendingAbility;
    if (!pendingAbility.candidatePlayerIds.includes(choice?.playerId)) return false;
    const selectedPlayer = room.players.find(player => player.id === choice.playerId);
    if (!selectedPlayer) return false;

    selectedPlayer.hand.forEach(card => addBattleLog(room, {
        playerName: selectedPlayer.name,
        card,
        revealed: true
    }));
    if (continuation?.context) continuation.context.selectedPlayerId = selectedPlayer.id;
    room.pendingAbility = null;
    return true;
}

function queueHandDiscard(room, roomId, socket, selectedPlayerId, effect) {
    const selectedPlayer = room.players.find(player => player.id === selectedPlayerId);
    const candidates = (selectedPlayer?.hand || []).filter(card => (
        effect.target?.kind !== 'minion' || card.type === 'minion'
    ));
    if (candidates.length === 0) return false;

    room.pendingAbility = {
        type: 'handDiscard',
        playerId: socket.id,
        selectedPlayerId,
        candidateIds: candidates.map(card => card.instanceId)
    };
    emitCardChoices(socket, roomId, `Choose a card for ${selectedPlayer.name} to discard.`, candidates, false);
    return true;
}

function resolveHandDiscard(room, socket, choice) {
    const pendingAbility = room.pendingAbility;
    const selectedPlayer = room.players.find(player => player.id === pendingAbility.selectedPlayerId);
    const cardIndex = selectedPlayer?.hand.findIndex(card => card.instanceId === choice?.cardInstanceId);
    if (cardIndex === undefined || cardIndex < 0 || !pendingAbility.candidateIds.includes(choice.cardInstanceId)) return false;

    const [discardedCard] = selectedPlayer.hand.splice(cardIndex, 1);
    selectedPlayer.discardPile.push(discardedCard);
    room.pendingAbility = null;
    addBattleLog(room, `**${selectedPlayer.name}** discards **${discardedCard.name}**.`);
    return true;
}

function queueBaseDeckSwap(room, roomId, socket, targetBase) {
    const targetBaseIndex = room.activeBases.indexOf(targetBase);
    if (targetBaseIndex < 0) return false;
    replenishBaseDeck(room);
    if (room.baseDeck.length === 0) return false;

    room.pendingAbility = {
        type: 'baseDeckSwap',
        playerId: socket.id,
        targetBaseIndex,
        candidateBaseIds: room.baseDeck.map(base => base.id)
    };
    socket.emit('ability-choice-required', {
        roomId,
        message: `Choose a base to replace ${targetBase.name}.`,
        choices: room.baseDeck.map(base => ({
            choiceId: `base-card:${base.id}`,
            baseInstanceId: base.id,
            label: `${base.name} (Breakpoint: ${base.breakpoint})`
        }))
    });
    return true;
}

function resolveBaseDeckSwap(room, choice, continuation) {
    const pendingAbility = room.pendingAbility;
    if (!pendingAbility.candidateBaseIds.includes(choice?.baseInstanceId)) return false;
    const deckIndex = room.baseDeck.findIndex(base => base.id === choice.baseInstanceId);
    const oldBase = room.activeBases[pendingAbility.targetBaseIndex];
    if (deckIndex < 0 || !oldBase) return false;

    const [replacementBase] = room.baseDeck.splice(deckIndex, 1);
    room.activeBases[pendingAbility.targetBaseIndex] = {
        ...replacementBase,
        playedCards: oldBase.playedCards || []
    };
    room.baseDeck.push({ ...oldBase, playedCards: undefined });
    if (continuation?.context) continuation.context.replacementBaseIndex = pendingAbility.targetBaseIndex;
    room.pendingAbility = null;
    addBattleLog(room, `**${oldBase.name}** is replaced by **${replacementBase.name}**.`);
    return true;
}

function queueAttachedActionDestruction(room, roomId, socket, targetMinion, sourceCardInstanceId) {
    const candidates = (targetMinion?.attachedCards || []).filter(card => (
        card.type === 'action' && card.instanceId !== sourceCardInstanceId
    ));
    if (candidates.length === 0) return false;

    room.pendingAbility = {
        type: 'attachedActionSelection',
        playerId: socket.id,
        targetMinionInstanceId: targetMinion.instanceId,
        candidateIds: candidates.map(card => card.instanceId)
    };
    emitCardChoices(socket, roomId, 'Choose attached actions to destroy, or finish.', candidates, true);
    return true;
}

function resolveAttachedActionSelection(room, roomId, socket, choice) {
    const pendingAbility = room.pendingAbility;
    if (choice?.skip) {
        room.pendingAbility = null;
        return true;
    }

    const minion = findMinionOnBoard(room, pendingAbility.targetMinionInstanceId);
    const actionIndex = minion?.attachedCards?.findIndex(card => card.instanceId === choice?.cardInstanceId);
    if (actionIndex === undefined || actionIndex < 0 || !pendingAbility.candidateIds.includes(choice.cardInstanceId)) return false;

    const [destroyedAction] = minion.attachedCards.splice(actionIndex, 1);
    const owner = room.players.find(player => player.id === destroyedAction.ownerId);
    owner?.discardPile.push(destroyedAction);
    const remaining = minion.attachedCards.filter(card => (
        card.type === 'action' && pendingAbility.candidateIds.includes(card.instanceId)
    ));
    if (remaining.length === 0) {
        room.pendingAbility = null;
        return true;
    }

    pendingAbility.candidateIds = remaining.map(card => card.instanceId);
    room.pendingAbility = pendingAbility;
    emitCardChoices(socket, roomId, 'Choose another attached action to destroy, or finish.', remaining, true);
    return true;
}

function queueSeaDogsFaction(room, roomId, socket, base) {
    if (room.activeBases.length < 2 || isMovementPrevented(base, socket.id)) return false;
    const baseIndex = room.activeBases.indexOf(base);
    const factions = [...new Set(getBaseMinions(base)
        .filter(minion => minion.ownerId !== socket.id
            && !isMinionProtectedFromCurrentEffect(room, base, minion, socket.id))
        .map(minion => minion.faction))];
    if (baseIndex < 0 || factions.length === 0) return false;

    room.pendingAbility = {
        type: 'seaDogsFaction',
        playerId: socket.id,
        sourceBaseIndex: baseIndex,
        factions
    };
    socket.emit('ability-choice-required', {
        roomId,
        message: `Choose a faction to move from ${base.name}.`,
        choices: factions.map(faction => ({ choiceId: `faction:${faction}`, faction, label: faction }))
    });
    return true;
}

function resolveSeaDogsFaction(room, roomId, socket, choice) {
    const pendingAbility = room.pendingAbility;
    if (!pendingAbility.factions.includes(choice?.faction)) return false;
    const sourceBase = room.activeBases[pendingAbility.sourceBaseIndex];
    const minionIds = getBaseMinions(sourceBase)
        .filter(minion => minion.ownerId !== socket.id
            && minion.faction === choice.faction
            && !isMinionProtectedFromCurrentEffect(room, sourceBase, minion, socket.id))
        .map(minion => minion.instanceId);
    if (minionIds.length === 0) return false;

    const destinations = room.activeBases
        .map((base, index) => ({ base, index }))
        .filter(({ index }) => index !== pendingAbility.sourceBaseIndex);
    room.pendingAbility = {
        type: 'seaDogsDestination',
        playerId: socket.id,
        sourceBaseIndex: pendingAbility.sourceBaseIndex,
        minionIds,
        candidateBaseIndices: destinations.map(item => item.index)
    };
    socket.emit('ability-choice-required', {
        roomId,
        message: `Choose a destination for the ${choice.faction} minions.`,
        choices: destinations.map(({ base, index }) => ({ choiceId: `base:${index}`, baseIndex: index, label: base.name }))
    });
    return true;
}

function resolveSeaDogsDestination(room, socket, choice) {
    const pendingAbility = room.pendingAbility;
    if (!pendingAbility.candidateBaseIndices.includes(choice?.baseIndex)) return false;
    const sourceBase = room.activeBases[pendingAbility.sourceBaseIndex];
    const destinationBase = room.activeBases[choice.baseIndex];
    if (isMovementPrevented(sourceBase, socket.id)) return false;
    const moved = sourceBase.playedCards.filter(card => pendingAbility.minionIds.includes(card.instanceId));
    sourceBase.playedCards = sourceBase.playedCards.filter(card => !pendingAbility.minionIds.includes(card.instanceId));
    destinationBase.playedCards.push(...moved);
    room.pendingAbility = null;
    addBattleLog(room, `**${moved.length} minion${moved.length === 1 ? '' : 's'}** move from **${sourceBase.name}** to **${destinationBase.name}**.`);
    return true;
}

function queueDisguiseSelection(room, roomId, socket, base, firstMinion) {
    if (!base || !firstMinion || firstMinion.ownerId !== socket.id) return false;
    const candidates = getBaseMinions(base).filter(minion => (
        minion.ownerId === socket.id && minion.instanceId !== firstMinion.instanceId
    ));
    if (candidates.length === 0) {
        executeDisguise(room, socket.id, room.activeBases.indexOf(base), [firstMinion.instanceId]);
        return false;
    }

    room.pendingAbility = {
        type: 'disguiseSelection',
        playerId: socket.id,
        baseIndex: room.activeBases.indexOf(base),
        selectedIds: [firstMinion.instanceId],
        candidateIds: candidates.map(minion => minion.instanceId)
    };
    socket.emit('ability-choice-required', {
        roomId,
        message: 'Choose one more minion for Disguise, or continue with one.',
        canSkip: true,
        choices: candidates.map(minion => ({
            choiceId: `minion:${minion.instanceId}`,
            baseIndex: room.activeBases.indexOf(base),
            minionInstanceId: minion.instanceId,
            label: `${minion.name} (Power: ${getCardPower(minion)})`
        }))
    });
    return true;
}

function resolveDisguiseSelection(room, roomId, socket, choice) {
    const pendingAbility = room.pendingAbility;
    if (!choice?.skip) {
        if (!pendingAbility.candidateIds.includes(choice?.minionInstanceId)) return false;
        pendingAbility.selectedIds.push(choice.minionInstanceId);
    }
    executeDisguise(room, socket.id, pendingAbility.baseIndex, pendingAbility.selectedIds);
    room.pendingAbility = null;
    return true;
}

function executeDisguise(room, playerId, baseIndex, minionIds) {
    const base = room.activeBases[baseIndex];
    const player = room.players.find(candidate => candidate.id === playerId);
    const selected = getBaseMinions(base).filter(minion => minionIds.includes(minion.instanceId));
    selected.forEach(minion => returnMinionToHand(room, base, minion));
    selected.forEach(() => room.turnState.extraMinionPlays.push({ allowedBaseIndex: baseIndex }));
    addBattleLog(room, `**${player.name}** returns ${selected.map(minion => `**${minion.name}**`).join(', ')} to their hand with Disguise.`);
}

function resolveDiscardToHand(room, socket, choice) {
    const pendingAbility = room.pendingAbility;
    if (choice?.skip && pendingAbility.canSkip) {
        room.pendingAbility = null;
        return true;
    }

    const player = room.players.find(candidate => candidate.id === socket.id);
    const cardIndex = player?.discardPile.findIndex(card => card.instanceId === choice?.cardInstanceId);
    if (cardIndex === undefined || cardIndex < 0 || !pendingAbility.candidateIds.includes(choice.cardInstanceId)) return false;

    const [card] = player.discardPile.splice(cardIndex, 1);
    player.hand.push(card);
    addBattleLog(room, `**${player.name}** returns **${card.name}** from their discard pile to their hand.`);

    if (pendingAbility.quantityAny) {
        pendingAbility.selectedName ||= card.name;
        const remaining = player.discardPile.filter(candidate => (
            candidate.type === 'minion' && candidate.name === pendingAbility.selectedName
        ));
        if (remaining.length > 0) {
            pendingAbility.candidateIds = remaining.map(candidate => candidate.instanceId);
            pendingAbility.canSkip = true;
            room.pendingAbility = pendingAbility;
            emitCardChoices(socket, null, `Choose another ${pendingAbility.selectedName}, or finish.`, remaining, true);
            return true;
        }
    }

    room.pendingAbility = null;
    return true;
}

function queueDiscardShuffle(room, roomId, socket, effect) {
    const player = room.players.find(candidate => candidate.id === socket.id);
    const candidates = (player?.discardPile || []).filter(card => (
        !effect.target?.trait || card.name.includes(effect.target.trait)
    ));
    if (candidates.length === 0) return false;

    return queueMultiZoneSelection(room, roomId, socket, {
        action: 'shuffleDiscardIntoDeck',
        candidates,
        message: 'Choose cards to shuffle from your discard pile into your deck.',
        zone: 'discardPile'
    });
}

function queueRevealedDeckSelection(room, roomId, socket, effect) {
    const player = room.players.find(candidate => candidate.id === socket.id);
    ensurePlayerDeckCards(room, player, effect.amount);
    const revealedCards = (player?.deck || []).slice(0, effect.amount);
    if (revealedCards.length === 0) return false;
    revealedCards.forEach(card => addBattleLog(room, { playerName: player.name, card, revealed: true }));
    const candidates = revealedCards.filter(card => !effect.resolve?.cardType || card.type === effect.resolve.cardType);
    if (candidates.length === 0) {
        return queueDeckReorder(room, roomId, socket, revealedCards, 'Order the revealed cards from top to bottom.');
    }

    return queueMultiZoneSelection(room, roomId, socket, {
        action: 'moveRevealedCardsToHand',
        candidates,
        message: 'Choose revealed cards to place in your hand.',
        zone: 'deck',
        revealedIds: revealedCards.map(card => card.instanceId)
    });
}

function queueDeckSearch(room, roomId, socket, effect) {
    const player = room.players.find(candidate => candidate.id === socket.id);
    const candidates = (player?.deck || []).filter(card => !effect.cardType || card.type === effect.cardType);
    if (candidates.length === 0) return false;

    room.pendingAbility = {
        type: 'multiZoneSelection',
        playerId: socket.id,
        action: 'moveDeckCardToHand',
        zone: 'deck',
        candidateIds: candidates.map(card => card.instanceId),
        selectedIds: [],
        minSelections: 1,
        maxSelections: 1,
        canSkip: false
    };
    emitCardChoices(socket, roomId, 'Choose a card from your deck.', candidates, false);
    return true;
}

function queueDeckNameSelection(room, roomId, socket) {
    const player = room.players.find(candidate => candidate.id === socket.id);
    const representatives = [...new Map(player.deck.map(card => [card.name, card])).values()];
    if (representatives.length === 0) return false;

    room.pendingAbility = {
        type: 'deckNameSelection',
        playerId: socket.id,
        candidateIds: representatives.map(card => card.instanceId)
    };
    emitCardChoices(socket, roomId, 'Choose a card name to search for.', representatives, false);
    return true;
}

function resolveDeckNameSelection(room, roomId, socket, choice) {
    const player = room.players.find(candidate => candidate.id === socket.id);
    const representative = player.deck.find(card => card.instanceId === choice?.cardInstanceId);
    if (!representative || !room.pendingAbility.candidateIds.includes(representative.instanceId)) return false;
    const candidates = player.deck.filter(card => card.name === representative.name);
    return queueMultiZoneSelection(room, roomId, socket, {
        action: 'moveDeckCardsToDiscard',
        candidates,
        message: `Choose copies of ${representative.name} to place in your discard pile.`,
        zone: 'deck'
    });
}

function queueMultiZoneSelection(room, roomId, socket, { action, candidates, message, zone, revealedIds = [] }) {
    room.pendingAbility = {
        type: 'multiZoneSelection',
        playerId: socket.id,
        action,
        zone,
        candidateIds: candidates.map(card => card.instanceId),
        selectedIds: [],
        minSelections: 0,
        maxSelections: candidates.length,
        canSkip: true,
        message,
        revealedIds
    };
    emitCardChoices(socket, roomId, message, candidates, true, {
        selectionMode: 'multiple',
        minSelections: 0,
        maxSelections: candidates.length
    });
    return true;
}

function emitCardChoices(socket, roomId, message, cards, canSkip, selectionOptions = {}) {
    socket.emit('ability-choice-required', {
        roomId,
        message,
        canSkip,
        ...selectionOptions,
        choices: cards.map(card => ({
            choiceId: `card:${card.instanceId}`,
            cardInstanceId: card.instanceId,
            label: `${card.name}${card.type === 'minion' ? ` (Power: ${getCardPower(card)})` : ''}`
        }))
    });
}

function resolveMultiZoneSelection(room, roomId, socket, choice) {
    const pendingAbility = room.pendingAbility;
    const player = room.players.find(candidate => candidate.id === socket.id);

    if (choice?.skip || choice?.cancel) {
        if (!pendingAbility.canSkip) return false;
        return executeMultiZoneSelection(room, roomId, socket, player, pendingAbility);
    }

    if (Array.isArray(choice?.cardInstanceIds)) {
        const selectedIds = [...new Set(choice.cardInstanceIds)];
        const allValid = selectedIds.every(instanceId => pendingAbility.candidateIds.includes(instanceId));
        if (!allValid
            || selectedIds.length < (pendingAbility.minSelections || 0)
            || selectedIds.length > pendingAbility.maxSelections) return false;
        pendingAbility.selectedIds = selectedIds;
        return executeMultiZoneSelection(room, roomId, socket, player, pendingAbility);
    }

    if (!pendingAbility.candidateIds.includes(choice?.cardInstanceId)) return false;
    pendingAbility.selectedIds.push(choice.cardInstanceId);
    pendingAbility.candidateIds = pendingAbility.candidateIds.filter(id => id !== choice.cardInstanceId);

    if (pendingAbility.selectedIds.length >= pendingAbility.maxSelections || pendingAbility.candidateIds.length === 0) {
        return executeMultiZoneSelection(room, roomId, socket, player, pendingAbility);
    }

    const zoneCards = player[pendingAbility.zone] || [];
    const remainingCards = zoneCards.filter(card => pendingAbility.candidateIds.includes(card.instanceId));
    emitCardChoices(socket, roomId, pendingAbility.message, remainingCards, true, {
        selectionMode: 'multiple',
        minSelections: 0,
        maxSelections: pendingAbility.maxSelections - pendingAbility.selectedIds.length
    });
    return true;
}

function executeMultiZoneSelection(room, roomId, socket, player, pendingAbility) {
    if (pendingAbility.action === 'shuffleDiscardIntoDeck') {
        const selected = player.discardPile.filter(card => pendingAbility.selectedIds.includes(card.instanceId));
        player.discardPile = player.discardPile.filter(card => !pendingAbility.selectedIds.includes(card.instanceId));
        player.deck.push(...selected);
        shuffleDeck(player.deck, () => nextSeededRandom(room));
    }

    if (pendingAbility.action === 'moveRevealedCardsToHand') {
        const revealedCards = pendingAbility.revealedIds
            .map(instanceId => player.deck.find(card => card.instanceId === instanceId))
            .filter(Boolean);
        const selected = revealedCards.filter(card => pendingAbility.selectedIds.includes(card.instanceId));
        const unselected = revealedCards.filter(card => !pendingAbility.selectedIds.includes(card.instanceId));
        player.deck = player.deck.filter(card => !pendingAbility.selectedIds.includes(card.instanceId));
        player.hand.push(...selected);
        if (unselected.length > 1) {
            return queueDeckReorder(
                room,
                roomId,
                socket,
                unselected,
                'Order the cards returning to the top of your deck from top to bottom.'
            );
        }
    }

    if (pendingAbility.action === 'moveDeckCardToHand') {
        const selectedId = pendingAbility.selectedIds[0];
        const cardIndex = player.deck.findIndex(card => card.instanceId === selectedId);
        if (cardIndex >= 0) player.hand.push(player.deck.splice(cardIndex, 1)[0]);
        shuffleDeck(player.deck, () => nextSeededRandom(room));
    }

    if (pendingAbility.action === 'moveDeckCardsToDiscard') {
        const selected = player.deck.filter(card => pendingAbility.selectedIds.includes(card.instanceId));
        player.deck = player.deck.filter(card => !pendingAbility.selectedIds.includes(card.instanceId));
        player.discardPile.push(...selected);
        shuffleDeck(player.deck, () => nextSeededRandom(room));
    }

    room.pendingAbility = null;
    return true;
}

function queueDeckReorder(room, roomId, socket, cards, message) {
    const orderedCards = cards.filter(Boolean);
    if (orderedCards.length <= 1) {
        room.pendingAbility = null;
        return false;
    }

    room.pendingAbility = {
        type: 'deckReorder',
        playerId: socket.id,
        cardIds: orderedCards.map(card => card.instanceId),
        orderedIds: []
    };
    emitCardChoices(socket, roomId, message, orderedCards, false, {
        selectionMode: 'ordered',
        minSelections: orderedCards.length,
        maxSelections: orderedCards.length
    });
    return true;
}

function resolveDeckReorder(room, socket, choice) {
    const pendingAbility = room.pendingAbility;
    let orderedIds;
    if (Array.isArray(choice?.cardInstanceIds)) {
        orderedIds = choice.cardInstanceIds;
        if (orderedIds.length !== pendingAbility.cardIds.length
            || new Set(orderedIds).size !== orderedIds.length
            || orderedIds.some(instanceId => !pendingAbility.cardIds.includes(instanceId))) {
            return false;
        }
    } else {
        const cardInstanceId = choice?.cardInstanceId;
        const stagedOrder = pendingAbility.orderedIds ||= [];
        if (!pendingAbility.cardIds.includes(cardInstanceId)
            || stagedOrder.includes(cardInstanceId)) return false;
        stagedOrder.push(cardInstanceId);
        if (stagedOrder.length < pendingAbility.cardIds.length) return true;
        orderedIds = stagedOrder;
    }

    const player = room.players.find(candidate => candidate.id === socket.id);
    const cardsById = new Map(player?.deck.map(card => [card.instanceId, card]));
    if (!player || orderedIds.some(instanceId => !cardsById.has(instanceId))) return false;
    const reorderedCards = orderedIds.map(instanceId => cardsById.get(instanceId));
    player.deck = [
        ...reorderedCards,
        ...player.deck.filter(card => !pendingAbility.cardIds.includes(card.instanceId))
    ];
    room.pendingAbility = null;
    return true;
}

function shuffleHandIntoDeck(room, playerId) {
    const player = room.players.find(candidate => candidate.id === playerId);
    if (!player) return;
    player.deck.push(...player.hand);
    player.hand = [];
    shuffleDeck(player.deck, () => nextSeededRandom(room));
}

function queueDiscardPlay(room, roomId, socket, effect, optional) {
    const player = room.players.find(candidate => candidate.id === socket.id);
    const candidates = (player?.discardPile || []).filter(card => (
        card.type === 'minion' && (effect.maxPower === undefined || getCardPower(card) <= effect.maxPower)
    ));
    if (candidates.length === 0) return false;

    if (effect.destination?.quantity === 'each') {
        const baseIndices = room.activeBases
            .map((base, index) => ({ base, index }))
            .filter(({ base }) => !getBaseMinions(base).some(minion => minion.ownerId === socket.id))
            .map(({ index }) => index);
        if (baseIndices.length === 0) return false;

        room.pendingAbility = {
            type: 'discardPlayEach',
            playerId: socket.id,
            effect,
            baseIndices,
            candidateIds: candidates.map(card => card.instanceId),
            canSkip: true
        };
        emitCardChoices(socket, roomId, `Choose a minion to play on ${room.activeBases[baseIndices[0]].name}, or skip this base.`, candidates, true);
        return true;
    }

    room.pendingAbility = {
        type: 'discardPlayCard',
        playerId: socket.id,
        effect,
        candidateIds: candidates.map(card => card.instanceId),
        canSkip: optional
    };
    emitCardChoices(socket, roomId, 'Choose a minion to play from your discard pile.', candidates, optional);
    return true;
}

function resolveDiscardPlayCard(room, roomId, socket, choice) {
    const pendingAbility = room.pendingAbility;
    const player = room.players.find(candidate => candidate.id === socket.id);

    if (pendingAbility.type === 'discardPlayEach' && choice?.skip) {
        pendingAbility.baseIndices.shift();
        return continueDiscardPlayEach(room, roomId, socket, pendingAbility);
    }
    if (choice?.skip && pendingAbility.canSkip) {
        room.pendingAbility = null;
        return true;
    }

    const card = player.discardPile.find(candidate => candidate.instanceId === choice?.cardInstanceId);
    if (!card || !pendingAbility.candidateIds.includes(card.instanceId)) return false;

    if (pendingAbility.type === 'discardPlayEach') {
        playMinionFromDiscard(room, player, card, pendingAbility.baseIndices[0]);
        pendingAbility.baseIndices.shift();
        return continueDiscardPlayEach(room, roomId, socket, pendingAbility);
    }

    room.pendingAbility = {
        type: 'discardPlayBase',
        playerId: socket.id,
        cardInstanceId: card.instanceId,
        candidateBaseIndices: room.activeBases
            .map((base, index) => ({ base, index }))
            .filter(({ base }) => !isMinionPlayPrevented(base, socket.id))
            .map(({ index }) => index)
    };
    if (room.pendingAbility.candidateBaseIndices.length === 0) {
        room.pendingAbility = null;
        return true;
    }
    socket.emit('ability-choice-required', {
        roomId,
        message: `Choose a base for ${card.name}.`,
        choices: room.pendingAbility.candidateBaseIndices.map(index => ({
            choiceId: `base:${index}`,
            baseIndex: index,
            label: room.activeBases[index].name
        }))
    });
    return true;
}

function continueDiscardPlayEach(room, roomId, socket, pendingAbility) {
    const player = room.players.find(candidate => candidate.id === socket.id);
    if (pendingAbility.baseIndices.length === 0) {
        room.pendingAbility = null;
        return true;
    }

    const candidates = player.discardPile.filter(card => (
        card.type === 'minion'
        && (pendingAbility.effect.maxPower === undefined || getCardPower(card) <= pendingAbility.effect.maxPower)
    ));
    if (candidates.length === 0) {
        room.pendingAbility = null;
        return true;
    }

    pendingAbility.candidateIds = candidates.map(card => card.instanceId);
    room.pendingAbility = pendingAbility;
    emitCardChoices(socket, roomId, `Choose a minion to play on ${room.activeBases[pendingAbility.baseIndices[0]].name}, or skip this base.`, candidates, true);
    return true;
}

function resolveDiscardPlayBase(room, socket, choice) {
    const pendingAbility = room.pendingAbility;
    if (!pendingAbility.candidateBaseIndices.includes(choice?.baseIndex)) return false;
    const player = room.players.find(candidate => candidate.id === socket.id);
    const card = player.discardPile.find(candidate => candidate.instanceId === pendingAbility.cardInstanceId);
    if (!card) return false;

    playMinionFromDiscard(room, player, card, choice.baseIndex);
    room.pendingAbility = null;
    return true;
}

function playMinionFromDiscard(room, player, card, baseIndex) {
    const cardIndex = player.discardPile.findIndex(candidate => candidate.instanceId === card.instanceId);
    const base = room.activeBases[baseIndex];
    if (cardIndex === -1 || !base || isMinionPlayPrevented(base, player.id)) return false;
    const [playedCard] = player.discardPile.splice(cardIndex, 1);
    playedCard.ownerId = player.id;
    playedCard.ownerName = player.name;
    base.playedCards.push(playedCard);
    addBattleLog(room, `**${player.name}** plays **${playedCard.name}** from their discard pile on **${base.name}**.`);
    recalculateOngoingEffects(room);
    queueAfterMinionPlayedBaseAbilities(room, base, playedCard);
    return true;
}

function queueTopDeckReveal(room, roomId, socket, effect, optional) {
    const player = room.players.find(candidate => candidate.id === socket.id);
    ensurePlayerDeckCards(room, player, 1);
    const card = player?.deck?.[0];
    if (!card) return false;

    addBattleLog(room, { playerName: player.name, card, revealed: true });
    const requiredType = effect.resolve?.if?.cardType;
    if (requiredType && card.type !== requiredType) return false;

    let choices = [
        { choiceId: 'discard', label: 'Discard it' },
        { choiceId: 'return', label: 'Return it to the top of your deck' }
    ];
    let mode = 'discardOrReturn';

    if (requiredType === 'minion') {
        mode = 'playExtraOrReturn';
        choices = [
            { choiceId: 'playExtra', label: 'Play it as an extra minion' },
            { choiceId: 'return', label: 'Return it to the top of your deck' }
        ];
    }

    if (requiredType === 'action') {
        mode = 'actionToHandOrExtra';
        choices = [
            { choiceId: 'hand', label: 'Place it in your hand' },
            { choiceId: 'playExtra', label: 'Play it as an extra action' }
        ];
    }

    room.pendingAbility = {
        type: 'topDeckReveal',
        playerId: socket.id,
        cardInstanceId: card.instanceId,
        canSkip: optional,
        mode
    };
    socket.emit('ability-choice-required', {
        roomId,
        message: `You revealed ${card.name}. Choose what to do with it.`,
        choices
    });
    return true;
}

function resolveTopDeckReveal(room, socket, choice) {
    const pendingAbility = room.pendingAbility;
    const player = room.players.find(candidate => candidate.id === socket.id);
    const card = player?.deck?.[0];
    const validChoices = pendingAbility.mode === 'discardOrReturn'
        ? ['discard', 'return']
        : pendingAbility.mode === 'actionToHandOrExtra'
            ? ['hand', 'playExtra']
            : ['playExtra', 'return'];
    if (!card || card.instanceId !== pendingAbility.cardInstanceId || !validChoices.includes(choice?.choiceId)) return false;

    if (choice.choiceId === 'discard') player.discardPile.push(player.deck.shift());
    if (choice.choiceId === 'hand') player.hand.push(player.deck.shift());
    if (choice.choiceId === 'playExtra') {
        const revealedCard = player.deck.shift();
        player.hand.push(revealedCard);
        if (revealedCard.type === 'minion') room.turnState.extraMinionPlays.push({});
        if (revealedCard.type === 'action') room.turnState.extraActionPlays += 1;
    }
    room.pendingAbility = null;
    return true;
}

function queueMassEnchantment(room, roomId, socket) {
    room.players
        .filter(player => player.id !== socket.id)
        .forEach(player => ensurePlayerDeckCards(room, player, 1));
    const revealed = room.players
        .filter(player => player.id !== socket.id && player.deck.length > 0)
        .map(player => ({ player, card: player.deck[0] }));
    revealed.forEach(({ player, card }) => addBattleLog(room, { playerName: player.name, card, revealed: true }));
    const actions = revealed.filter(({ card }) => card.type === 'action');
    if (actions.length === 0) return false;

    room.pendingAbility = {
        type: 'massEnchantment',
        playerId: socket.id,
        candidates: actions.map(({ player, card }) => ({ playerId: player.id, cardInstanceId: card.instanceId }))
    };
    socket.emit('ability-choice-required', {
        roomId,
        message: 'Choose one revealed action to play as an extra action, or decline.',
        canSkip: true,
        choices: actions.map(({ player, card }) => ({
            choiceId: `revealed:${card.instanceId}`,
            cardInstanceId: card.instanceId,
            label: `${card.name} (${player.name}'s deck)`
        }))
    });
    return true;
}

function resolveMassEnchantment(room, socket, choice) {
    if (choice?.skip) {
        room.pendingAbility = null;
        return true;
    }
    const candidate = room.pendingAbility.candidates.find(item => item.cardInstanceId === choice?.cardInstanceId);
    const owner = room.players.find(player => player.id === candidate?.playerId);
    if (!candidate || owner?.deck?.[0]?.instanceId !== candidate.cardInstanceId) return false;

    const player = room.players.find(item => item.id === socket.id);
    player.hand.push(owner.deck.shift());
    room.turnState.extraActionPlays += 1;
    room.pendingAbility = null;
    return true;
}

function moveMinionToOwnersDeck(room, base, minion, position = 'bottom') {
    const minionIndex = base.playedCards.findIndex(card => card.instanceId === minion.instanceId);
    if (minionIndex === -1) return;

    const [movedMinion] = base.playedCards.splice(minionIndex, 1);
    removeTemporaryPowerEffectsForCard(room, movedMinion.instanceId);
    const owner = room.players.find(player => player.id === movedMinion.ownerId);
    if (!owner) return;

    if (position === 'bottom') owner.deck.push(movedMinion);
    else owner.deck.unshift(movedMinion);
    (movedMinion.attachedCards || []).forEach(card => {
        const attachedOwner = room.players.find(player => player.id === card.ownerId) || owner;
        attachedOwner.discardPile.push(card);
    });
    movedMinion.attachedCards = [];
    movedMinion.power = getPrintedCardPower(movedMinion);
    addBattleLog(room, `**${movedMinion.name}** is placed on the ${position} of its owner's deck.`);
}

function queueSelectedPlayerBoardEffect(room, roomId, socket, effect, base) {
    const candidateBases = (base ? [base] : room.activeBases).filter(candidateBase => (
        (!effect.condition?.controllerHasMinionAt
            || getBaseMinions(candidateBase).some(minion => minion.ownerId === socket.id))
        && getEligibleMinions(room, socket.id, { ...effect.target, owner: 'any' }, candidateBase).length > 0
    ));
    const candidatePlayerIds = [...new Set(
        candidateBases
            .flatMap(candidateBase => getEligibleMinions(
                room,
                socket.id,
                { ...effect.target, owner: 'any' },
                candidateBase
            ))
            .map(minion => minion.ownerId)
    )];
    if (candidatePlayerIds.length === 0) return false;

    room.pendingAbility = {
        type: 'selectedPlayerBoardEffect',
        playerId: socket.id,
        effect,
        candidateBaseIndices: candidateBases.map(candidateBase => room.activeBases.indexOf(candidateBase)),
        candidatePlayerIds
    };
    socket.emit('ability-choice-required', {
        roomId,
        message: 'Choose whose minions Broadside will affect.',
        choices: candidatePlayerIds.map(playerId => ({
            choiceId: `player:${playerId}`,
            playerId,
            label: room.players.find(player => player.id === playerId)?.name || 'Player'
        }))
    });
    return true;
}

function resolveSelectedPlayerBoardEffect(room, roomId, socket, choice) {
    const pendingAbility = room.pendingAbility;
    if (!pendingAbility.candidatePlayerIds.includes(choice?.playerId)) return false;

    const eligibleBaseIndices = pendingAbility.candidateBaseIndices.filter(baseIndex => {
        const base = room.activeBases[baseIndex];
        return getEligibleMinions(room, socket.id, { ...pendingAbility.effect.target, owner: 'any' }, base)
            .some(minion => minion.ownerId === choice.playerId);
    });
    if (eligibleBaseIndices.length === 0) return false;

    if (eligibleBaseIndices.length > 1) {
        room.pendingAbility = {
            type: 'selectedPlayerBoardEffectBase',
            playerId: socket.id,
            effect: pendingAbility.effect,
            selectedPlayerId: choice.playerId,
            candidateBaseIndices: eligibleBaseIndices
        };
        emitActorEvent(socket, 'ability-choice-required', {
            roomId,
            message: `Choose the base where Broadside will affect ${room.players.find(player => player.id === choice.playerId)?.name || 'that player'}.`,
            choices: eligibleBaseIndices.map(baseIndex => ({
                choiceId: `base:${baseIndex}`,
                baseIndex,
                label: room.activeBases[baseIndex].name
            }))
        });
        return true;
    }

    applySelectedPlayerBoardEffect(room, socket.id, pendingAbility.effect, choice.playerId, eligibleBaseIndices[0]);
    room.pendingAbility = null;
    return true;
}

function resolveSelectedPlayerBoardEffectBase(room, socket, choice) {
    const pendingAbility = room.pendingAbility;
    if (!pendingAbility.candidateBaseIndices.includes(choice?.baseIndex)) return false;

    applySelectedPlayerBoardEffect(
        room,
        socket.id,
        pendingAbility.effect,
        pendingAbility.selectedPlayerId,
        choice.baseIndex
    );
    room.pendingAbility = null;
    return true;
}

function applySelectedPlayerBoardEffect(room, actorId, effect, selectedPlayerId, baseIndex) {
    const base = room.activeBases[baseIndex];
    if (!base) return;

    const targets = getEligibleMinions(room, actorId, { ...effect.target, owner: 'any' }, base)
        .filter(minion => minion.ownerId === selectedPlayerId);
    targets.forEach(minion => applyMinionBoardEffect(room, effect, base, minion, actorId));
}

function beginMoveMinionEffect(room, roomId, socket, effect, minion, selectedBase) {
    if (effect.target !== 'selectedMinion'
        && (!minion || !getEligibleMinions(room, socket.id, effect.target, selectedBase, minion)
            .some(candidate => candidate.instanceId === minion.instanceId))) {
        return queueMoveTargetBatch(room, roomId, socket, effect);
    }

    const sourceBase = minion && getBaseForMinion(room, minion.instanceId);
    if (!minion || !sourceBase || isMovementPrevented(sourceBase, socket.id)) return false;

    const destinations = room.activeBases.filter(base => base !== sourceBase);
    if (destinations.length === 0) return false;

    room.pendingAbility = {
        type: 'moveDestination',
        playerId: socket.id,
        minionInstanceId: minion.instanceId,
        sourceBaseIndex: room.activeBases.indexOf(sourceBase),
        effect,
        movedMinionIds: [],
        remainingMoves: getMoveLimit(effect)
    };
    socket.emit('ability-choice-required', {
        roomId,
        message: `Move ${minion.name} from ${sourceBase.name} to another base.`,
        choices: destinations.map(base => ({
            choiceId: `base:${room.activeBases.indexOf(base)}`,
            baseIndex: room.activeBases.indexOf(base),
            label: base.name
        }))
    });
    return true;
}

function resolveMoveDestination(room, socket, choice) {
    const pendingAbility = room.pendingAbility;
    const sourceBase = room.activeBases[pendingAbility.sourceBaseIndex];
    const destinationBase = room.activeBases[choice?.baseIndex];
    const minion = sourceBase && getBaseMinions(sourceBase)
        .find(candidate => candidate.instanceId === pendingAbility.minionInstanceId);

    if (!sourceBase || !destinationBase || sourceBase === destinationBase || !minion
        || isMovementPrevented(sourceBase, socket.id)) return false;

    const minionIndex = sourceBase.playedCards.findIndex(card => card.instanceId === minion.instanceId);
    sourceBase.playedCards.splice(minionIndex, 1);
    destinationBase.playedCards.push(minion);
    addBattleLog(room, `**${minion.name}** moves from **${sourceBase.name}** to **${destinationBase.name}**.`);

    pendingAbility.movedMinionIds.push(minion.instanceId);
    pendingAbility.remainingMoves -= 1;
    if (pendingAbility.batchMoveIds?.length > 0) {
        const nextMinionId = pendingAbility.batchMoveIds[0];
        const remainingBatchIds = pendingAbility.batchMoveIds.slice(1);
        return queueBatchMoveDestination(room, socket, nextMinionId, remainingBatchIds, pendingAbility.continuation);
    }
    if (pendingAbility.remainingMoves > 0 && pendingAbility.effect.target !== 'selectedMinion') {
        if (queueMoveTarget(room, null, socket, pendingAbility.effect, pendingAbility.movedMinionIds, pendingAbility.remainingMoves)) {
            return true;
        }
    }

    room.pendingAbility = null;
    return true;
}

function queueMoveTargetBatch(room, roomId, socket, effect) {
    if (room.activeBases.length < 2) return false;
    const candidates = getEligibleMinions(room, socket.id, effect.target)
        .filter(minion => !isMovementPrevented(getBaseForMinion(room, minion.instanceId), socket.id));
    if (candidates.length === 0) return false;
    const maximum = Math.min(getMoveLimit(effect), candidates.length);

    room.pendingAbility = {
        type: 'moveTargetBatch',
        playerId: socket.id,
        effect,
        candidateIds: candidates.map(minion => minion.instanceId),
        selectedIds: [],
        maxSelections: maximum
    };
    promptForMinionChoices(
        socket,
        room,
        roomId,
        'Choose the minions to move.',
        candidates,
        true,
        { selectionMode: 'multiple', minSelections: 0, maxSelections: maximum }
    );
    return true;
}

function resolveMoveTargetBatch(room, roomId, socket, choice) {
    const pendingAbility = room.pendingAbility;
    if (choice?.cancel) {
        room.pendingAbility = null;
        return true;
    }

    if (choice?.minionInstanceId) {
        if (!pendingAbility.candidateIds.includes(choice.minionInstanceId)
            || (pendingAbility.selectedIds || []).includes(choice.minionInstanceId)) {
            return false;
        }
        if (!pendingAbility.selectedIds) pendingAbility.selectedIds = [];
        pendingAbility.selectedIds.push(choice.minionInstanceId);
        pendingAbility.candidateIds = pendingAbility.candidateIds
            .filter(instanceId => instanceId !== choice.minionInstanceId);

        if (pendingAbility.selectedIds.length < pendingAbility.maxSelections
            && pendingAbility.candidateIds.length > 0) {
            const remaining = pendingAbility.candidateIds
                .map(findMinionOnBoard.bind(null, room))
                .filter(Boolean);
            promptForMinionChoices(
                socket,
                room,
                roomId,
                'Choose another minion to move, or finish selecting.',
                remaining,
                true
            );
            return true;
        }
    }

    const selectedIds = choice?.finishSelection || choice?.skip
        ? [...(pendingAbility.selectedIds || [])]
        : choice?.minionInstanceId
            ? [...(pendingAbility.selectedIds || [])]
            : [...new Set(choice?.minionInstanceIds || [])];
    if (selectedIds.length > pendingAbility.maxSelections
        || selectedIds.some(instanceId => (
            !(pendingAbility.selectedIds || []).includes(instanceId)
            && !pendingAbility.candidateIds.includes(instanceId)
        ))) {
        return false;
    }
    if (selectedIds.length === 0) {
        room.pendingAbility = null;
        return true;
    }

    return queueBatchMoveDestination(room, socket, selectedIds[0], selectedIds.slice(1), pendingAbility.continuation, roomId);
}

function queueBatchMoveDestination(room, socket, minionInstanceId, remainingIds, continuation, roomId = null) {
    const minion = findMinionOnBoard(room, minionInstanceId);
    const sourceBase = getBaseForMinion(room, minionInstanceId);
    if (!minion || !sourceBase || isMovementPrevented(sourceBase, socket.id)) return false;
    const destinations = room.activeBases
        .map((base, index) => ({ base, index }))
        .filter(({ base }) => base !== sourceBase);
    if (destinations.length === 0) {
        room.pendingAbility = null;
        return true;
    }
    room.pendingAbility = {
        type: 'moveDestination',
        playerId: socket.id,
        minionInstanceId,
        sourceBaseIndex: room.activeBases.indexOf(sourceBase),
        effect: { target: 'selectedMinion' },
        movedMinionIds: [],
        remainingMoves: 1,
        batchMoveIds: remainingIds,
        continuation
    };
    socket.emit('ability-choice-required', {
        roomId,
        message: `Move ${minion.name} from ${sourceBase.name} to another base.`,
        choices: destinations.map(({ base, index }) => ({ choiceId: `base:${index}`, baseIndex: index, label: base.name }))
    });
    return true;
}

function getMoveLimit(effect) {
    if (effect.target?.quantity === 'any') return Number.MAX_SAFE_INTEGER;
    return effect.target?.quantity?.max || 1;
}

function queueMoveTarget(room, roomId, socket, effect, movedMinionIds, remainingMoves) {
    if (room.activeBases.length < 2) return false;
    const candidates = getEligibleMinions(room, socket.id, effect.target)
        .filter(minion => !movedMinionIds.includes(minion.instanceId)
            && !isMovementPrevented(getBaseForMinion(room, minion.instanceId), socket.id));
    if (candidates.length === 0) return false;

    room.pendingAbility = {
        type: 'moveTarget',
        playerId: socket.id,
        effect,
        candidateIds: candidates.map(candidate => candidate.instanceId),
        movedMinionIds,
        remainingMoves
    };
    promptForMinionChoices(socket, room, roomId, 'Choose a minion to move, or finish resolving this ability.', candidates, true);
    return true;
}

function resolveMoveTarget(room, roomId, socket, choice) {
    const pendingAbility = room.pendingAbility;
    if (choice?.skip) {
        room.pendingAbility = null;
        return true;
    }

    const minion = findMinionOnBoard(room, choice?.minionInstanceId);
    if (!minion || !pendingAbility.candidateIds.includes(minion.instanceId)) return false;

    const sourceBase = getBaseForMinion(room, minion.instanceId);
    const destinations = room.activeBases.filter(base => base !== sourceBase);
    if (!sourceBase || destinations.length === 0 || isMovementPrevented(sourceBase, socket.id)) return false;

    room.pendingAbility = {
        type: 'moveDestination',
        playerId: socket.id,
        minionInstanceId: minion.instanceId,
        sourceBaseIndex: room.activeBases.indexOf(sourceBase),
        effect: pendingAbility.effect,
        movedMinionIds: pendingAbility.movedMinionIds,
        remainingMoves: pendingAbility.remainingMoves
    };
    socket.emit('ability-choice-required', {
        roomId,
        message: `Move ${minion.name} from ${sourceBase.name} to another base.`,
        choices: destinations.map(base => ({
            choiceId: `base:${room.activeBases.indexOf(base)}`,
            baseIndex: room.activeBases.indexOf(base),
            label: base.name
        }))
    });
    return true;
}

function validateTalentActivation(room, playerId, cardInstanceId) {
    const minion = findMinionOnBoard(room, cardInstanceId);
    const base = getBaseForMinion(room, cardInstanceId);
    const talent = (minion?.abilities || []).find(ability => ability.trigger === 'talent');

    if (!minion || !base || minion.ownerId !== playerId || !talent) {
        return { ok: false, error: 'That Talent is no longer available.' };
    }

    const useKey = `${minion.instanceId}:talent`;
    if (room.turnState.talentUses?.[useKey]) {
        return { ok: false, error: `${minion.name}'s Talent has already been used this turn.` };
    }
    if (!isAbilityConditionMet(talent, room.turnState)) {
        return { ok: false, error: `${minion.name}'s Talent conditions are not met.` };
    }

    const effects = talent.effects || [];
    const supported = effects.every(effect => (
        (effect.type === 'modifyPower' && effect.target === 'self')
        || (effect.type === 'returnToHand' && effect.target === 'self')
        || (effect.type === 'grantExtraPlay'
            && (effect.cardType === 'action'
                || (effect.cardType === 'minion' && effect.destination === 'sameBase')))
    ));
    if (!supported) return { ok: false, error: `${minion.name}'s Talent is not supported yet.` };

    return { ok: true, base, effects, minion, talent, useKey };
}

function activateTalent(room, playerId, cardInstanceId) {
    const validation = validateTalentActivation(room, playerId, cardInstanceId);
    if (!validation.ok) return validation;
    const { base, effects, minion, useKey } = validation;

    const baseIndex = room.activeBases.indexOf(base);
    effects.forEach(effect => {
        if (effect.type === 'modifyPower') {
            applyTemporaryPowerModifier(room, [minion], effect.amount, {
                expiresAt: effect.duration === 'untilStartOfOwnersNextTurn'
                    ? 'startOfOwnersNextTurn'
                    : 'endOfTurn',
                activatesAt: effect.duration === 'untilStartOfOwnersNextTurn' ? 'nextTurn' : 'immediately',
                ownerId: playerId,
                sourceCardInstanceId: minion.instanceId
            });
        } else if (effect.type === 'returnToHand') {
            returnMinionToHand(room, base, minion);
        } else if (effect.type === 'grantExtraPlay' && effect.cardType === 'action') {
            room.turnState.extraActionPlays += Number(effect.amount) || 0;
        } else if (effect.type === 'grantExtraPlay' && effect.cardType === 'minion') {
            const amount = Number(effect.amount) || 0;
            for (let index = 0; index < amount; index += 1) {
                room.turnState.extraMinionPlays.push({
                    allowedBaseIndex: baseIndex,
                    required: true,
                    sourceZone: 'hand',
                    sourceTalentCardInstanceId: minion.instanceId
                });
            }
        }
    });

    if (!room.turnState.talentUses) room.turnState.talentUses = {};
    room.turnState.talentUses[useKey] = true;
    const player = room.players.find(candidate => candidate.id === playerId);
    addBattleLog(room, `**${player?.name || 'A player'}** uses **${minion.name}**'s Talent.`);
    recalculateOngoingEffects(room);
    return { ok: true };
}

function isAbilityConditionMet(ability, turnState) {
    const expectedTurnState = ability.condition?.turnState;
    if (!expectedTurnState) return true;
    return Object.entries(expectedTurnState).every(([key, expectedValue]) => turnState[key] === expectedValue);
}

function queueConfirmation(socket, room, roomId, effect, message) {
    room.pendingAbility = { type: 'confirmation', playerId: socket.id, effect };
    socket.emit('ability-choice-required', {
        roomId,
        message,
        choices: [
            { choiceId: 'accept', label: 'Use ability' },
            { choiceId: 'skip', label: 'Skip ability' }
        ]
    });
}

function drawCards(room, playerId, amount) {
    const player = room.players.find(candidate => candidate.id === playerId);
    if (!player || amount <= 0) return;

    for (let index = 0; index < amount; index += 1) {
        const card = drawPlayerCard(room, player);
        if (!card) break;
        player.hand.push(card);
    }
}

function grantExtraPlay(room, effect, replacementBaseIndex) {
    const amount = typeof effect.amount === 'number' ? effect.amount : 0;
    if (effect.cardType === 'minion') {
        for (let index = 0; index < amount; index += 1) {
            room.turnState.extraMinionPlays.push({
                maxPower: effect.maxPower,
                baseFilter: effect.destination?.filter,
                allowedBaseIndex: effect.destination === 'replacementBase' ? replacementBaseIndex : undefined
            });
        }
    }
    if (effect.cardType === 'action') room.turnState.extraActionPlays += amount;
}

function minionPlayPermissionMatches(room, playerId, card, baseIndex, permission) {
    return (permission.maxPower === undefined || getPrintedCardPower(card) <= permission.maxPower)
        && (permission.allowedBaseIndex === undefined || permission.allowedBaseIndex === baseIndex)
        && (!permission.baseFilter
            || (permission.baseFilter === 'controllerHasNoMinions'
                && !getBaseMinions(room.activeBases[baseIndex]).some(minion => minion.ownerId === playerId)));
}

function formatExtraPlay(effect) {
    const amount = typeof effect.amount === 'number' ? effect.amount : 1;
    const noun = effect.cardType === 'action' ? 'action' : 'minion';
    return `${amount} extra ${noun}${amount === 1 ? '' : 's'}`;
}

function getEffectAmount(amount, room, playerId, targetBase, targetMinion) {
    if (typeof amount === 'number') return amount;
    if (amount?.type === 'powerOf' && amount.target === 'selectedMinion') return getCardPower(targetMinion);
    if (amount?.type === 'countMinions' && amount.location === 'selectedBase') {
        return getBaseMinions(targetBase).filter(minion => minion.ownerId === playerId).length;
    }
    return 0;
}

function resolveMinionBoardEffect({ room, roomId, socket, effect, optional, sourceMinionInstanceId, targetBase, targetMinion }) {
    const target = effect.target;
    if (target === 'selectedMinion' && targetMinion) {
        if (optional) {
            room.pendingAbility = {
                type: 'boardEffect',
                playerId: socket.id,
                effect,
                candidateIds: [targetMinion.instanceId],
                remainingSelections: 1,
                canSkip: true
            };
            promptForMinionChoices(socket, room, roomId, `${effect.type === 'destroyMinion' ? 'Destroy' : 'Return'} ${targetMinion.name}, or decline this ability.`, [targetMinion], true);
            return true;
        }
        applyMinionBoardEffect(room, effect, targetBase, targetMinion, socket.id);
        return false;
    }

    if (target?.location === 'sameBaseAsSelectedMinion' && target?.power?.lessThan === 'selectedMinion' && targetBase && targetMinion) {
        beginNaturalSelection(room, roomId, socket, targetBase, targetMinion);
        return Boolean(room.pendingAbility);
    }

    const eligibleTargets = getEligibleMinions(room, socket.id, target, targetBase, targetMinion)
        .filter(minion => !(optional && effect.type === 'returnToHand' && minion.instanceId === sourceMinionInstanceId));
    if (eligibleTargets.length === 0) return false;

    // "You may" effects always require an explicit player decision. Do this before
    // any automatic single-target or preselected-target resolution.
    if (optional) {
        room.pendingAbility = {
            type: 'boardEffect',
            playerId: socket.id,
            effect,
            candidateIds: eligibleTargets.map(candidate => candidate.instanceId),
            remainingSelections: 1,
            canSkip: true
        };
        promptForMinionChoices(socket, room, roomId, `${effect.type === 'destroyMinion' ? 'Destroy' : 'Return'} a minion, or decline this ability.`, eligibleTargets, true);
        return true;
    }


    if (target?.quantity?.max > 1 && !targetMinion) {
        room.pendingAbility = {
            type: 'boardEffectBatch',
            playerId: socket.id,
            effect,
            candidateIds: eligibleTargets.map(candidate => candidate.instanceId),
            selectedIds: [],
            maxSelections: target.quantity.max
        };
        promptForMinionChoices(
            socket,
            room,
            roomId,
            `${effect.type === 'destroyMinion' ? 'Choose minions to destroy.' : 'Choose minions.'}`,
            eligibleTargets,
            true,
            { selectionMode: 'multiple', minSelections: 0, maxSelections: target.quantity.max }
        );
        return true;
    }

    if (target?.quantity === 'all') {
        eligibleTargets.forEach(candidate => {
            const base = getBaseForMinion(room, candidate.instanceId);
            applyMinionBoardEffect(room, effect, base, candidate, socket.id);
        });
        return false;
    }

    if (targetMinion && eligibleTargets.some(candidate => candidate.instanceId === targetMinion.instanceId)) {
        applyMinionBoardEffect(room, effect, targetBase, targetMinion, socket.id);
        return beginAdditionalBoardChoices(room, roomId, socket, effect);
    }

    if (eligibleTargets.length === 1) {
        const candidate = eligibleTargets[0];
        applyMinionBoardEffect(room, effect, getBaseForMinion(room, candidate.instanceId), candidate, socket.id);
        return false;
    }

    room.pendingAbility = {
        type: 'boardEffect',
        playerId: socket.id,
        effect,
        candidateIds: eligibleTargets.map(candidate => candidate.instanceId),
        remainingSelections: target?.quantity?.max || 1,
        canSkip: false
    };
    promptForMinionChoices(socket, room, roomId, `${effect.type === 'destroyMinion' ? 'Destroy' : 'Return'} a minion.`, eligibleTargets, target?.quantity?.max > 1);
    return true;
}

function resolveBoardEffectBatch(room, socket, choice) {
    const pendingAbility = room.pendingAbility;
    if (choice?.cancel) {
        room.pendingAbility = null;
        return true;
    }

    if (choice?.minionInstanceId) {
        if (!pendingAbility.candidateIds.includes(choice.minionInstanceId)
            || (pendingAbility.selectedIds || []).includes(choice.minionInstanceId)) {
            return false;
        }
        if (!pendingAbility.selectedIds) pendingAbility.selectedIds = [];
        pendingAbility.selectedIds.push(choice.minionInstanceId);
        pendingAbility.candidateIds = pendingAbility.candidateIds
            .filter(instanceId => instanceId !== choice.minionInstanceId);

        if (pendingAbility.selectedIds.length < pendingAbility.maxSelections
            && pendingAbility.candidateIds.length > 0) {
            const remaining = pendingAbility.candidateIds
                .map(findMinionOnBoard.bind(null, room))
                .filter(Boolean);
            promptForMinionChoices(
                socket,
                room,
                null,
                'Choose another minion, or finish selecting.',
                remaining,
                true
            );
            return true;
        }
    }

    const selectedIds = choice?.finishSelection || choice?.skip
        ? [...(pendingAbility.selectedIds || [])]
        : choice?.minionInstanceId
            ? [...(pendingAbility.selectedIds || [])]
            : [...new Set(choice?.minionInstanceIds || [])];
    if (selectedIds.length > pendingAbility.maxSelections
        || selectedIds.some(instanceId => (
            !(pendingAbility.selectedIds || []).includes(instanceId)
            && !pendingAbility.candidateIds.includes(instanceId)
        ))) {
        return false;
    }

    selectedIds.forEach(instanceId => {
        const minion = findMinionOnBoard(room, instanceId);
        const base = getBaseForMinion(room, instanceId);
        if (minion && base) applyMinionBoardEffect(room, pendingAbility.effect, base, minion, socket.id);
    });
    room.pendingAbility = null;
    return true;
}

function beginAdditionalBoardChoices(room, roomId, socket, effect) {
    const maximumTargets = effect.target?.quantity?.max;
    if (!maximumTargets || maximumTargets <= 1) return false;

    const eligibleTargets = getEligibleMinions(room, socket.id, effect.target);
    if (eligibleTargets.length === 0) return false;

    room.pendingAbility = {
        type: 'boardEffect',
        playerId: socket.id,
        effect,
        candidateIds: eligibleTargets.map(candidate => candidate.instanceId),
        remainingSelections: maximumTargets - 1,
        canSkip: true
    };
    promptForMinionChoices(socket, room, roomId, 'Destroy another minion, or finish resolving this ability.', eligibleTargets, true);
    return true;
}

function resolvePendingBoardEffect(room, socket, choice) {
    const pendingAbility = room.pendingAbility;
    if (choice?.skip && pendingAbility.canSkip && pendingAbility.remainingSelections > 0) {
        room.pendingAbility = null;
        return true;
    }
    const minion = findMinionOnBoard(room, choice?.minionInstanceId);
    if (!minion || !pendingAbility.candidateIds.includes(minion.instanceId)) return false;

    const base = getBaseForMinion(room, minion.instanceId);
    if (!base) return false;

    applyMinionBoardEffect(room, pendingAbility.effect, base, minion, socket.id);
    pendingAbility.remainingSelections -= 1;

    if (pendingAbility.remainingSelections <= 0) {
        room.pendingAbility = null;
        return true;
    }

    const eligibleTargets = getEligibleMinions(room, socket.id, pendingAbility.effect.target);
    if (eligibleTargets.length === 0) {
        room.pendingAbility = null;
        return true;
    }

    pendingAbility.candidateIds = eligibleTargets.map(candidate => candidate.instanceId);
    promptForMinionChoices(
        socket,
        room,
        null,
        `${pendingAbility.effect.type === 'destroyMinion' ? 'Destroy' : 'Return'} another minion, or finish resolving this ability.`,
        eligibleTargets,
        true
    );
    return true;
}

function applyMinionBoardEffect(room, effect, base, minion, actorId) {
    if (!base || !minion) return;
    if (effect.type === 'destroyMinion') destroyMinion(room, base, minion, actorId);
    if (effect.type === 'returnToHand' && !isMinionProtectedFromCurrentEffect(room, base, minion, actorId)) {
        returnMinionToHand(room, base, minion);
    }
}

function getEligibleMinions(room, playerId, target = {}, selectedBase, selectedMinion) {
    const locationBase = target.location === 'sameBase' || target.location === 'selectedBase' || target.location === 'sameBaseAsSelectedMinion'
        ? selectedBase
        : null;
    const candidates = locationBase ? getBaseMinions(locationBase) : room.activeBases.flatMap(getBaseMinions);

    return candidates.filter(minion => {
        if (isMinionProtectedFromCurrentEffect(room, getBaseForMinion(room, minion.instanceId), minion, playerId)) return false;
        if (target.excludeCardId && (target.excludeCardId === minion.cardId || target.excludeCardId === minion.id)) return false;
        if (target.owner === 'controller' && minion.ownerId !== playerId) return false;
        if ((target.owner === 'otherPlayer' || target.owner === 'otherPlayers') && minion.ownerId === playerId) return false;
        if (target.owner === 'selectedPlayer' && minion.ownerId !== selectedMinion?.ownerId) return false;

        const power = getCardPower(minion);
        if (typeof target.power?.max === 'number' && power > target.power.max) return false;
        if (target.power?.lessThan === 'selectedMinion' && power >= getCardPower(selectedMinion)) return false;
        if (target.power?.max === 'selectedMinion' && power > getCardPower(selectedMinion)) return false;
        if (target.power?.lessThan?.type === 'countMinions') {
            const comparisonBase = target.power.lessThan.location === 'sameBase' ? selectedBase : null;
            const ownedMinions = (comparisonBase ? getBaseMinions(comparisonBase) : room.activeBases.flatMap(getBaseMinions))
                .filter(card => card.ownerId === playerId);
            if (power >= ownedMinions.length) return false;
        }

        return true;
    });
}

function findMinionOnBoard(room, instanceId) {
    return room.activeBases.flatMap(getBaseMinions).find(minion => minion.instanceId === instanceId);
}

function getBaseForMinion(room, instanceId) {
    return room.activeBases.find(base => getBaseMinions(base).some(minion => minion.instanceId === instanceId));
}

function returnMinionToHand(room, base, minion) {
    const minionIndex = base.playedCards.findIndex(card => card.instanceId === minion.instanceId);
    if (minionIndex === -1) return;

    const [returnedMinion] = base.playedCards.splice(minionIndex, 1);
    const owner = room.players.find(player => player.id === returnedMinion.ownerId);
    if (owner) {
        (returnedMinion.attachedCards || []).forEach(card => {
            const attachedOwner = room.players.find(player => player.id === card.ownerId) || owner;
            attachedOwner.discardPile.push(card);
        });
        returnedMinion.attachedCards = [];
        returnedMinion.power = getPrintedCardPower(returnedMinion);
        owner.hand.push(returnedMinion);
    }
    removeTemporaryPowerEffectsForCard(room, returnedMinion.instanceId);
    recalculateOngoingEffects(room);
}

function beginNaturalSelection(room, roomId, socket, base, sourceMinion) {
    const eligibleTargets = getBaseMinions(base).filter(minion => minion.instanceId !== sourceMinion.instanceId && getCardPower(minion) < getCardPower(sourceMinion));

    if (eligibleTargets.length === 0) {
        addBattleLog(room, `No minion at **${base.name}** has less power than **${sourceMinion.name}**.`);
        return;
    }

    if (eligibleTargets.length === 1) {
        destroyMinion(room, base, eligibleTargets[0], socket.id);
        return;
    }

    room.pendingAbility = {
        type: 'naturalSelection',
        playerId: socket.id,
        baseIndex: room.activeBases.indexOf(base),
        sourceMinionInstanceId: sourceMinion.instanceId,
        candidateIds: eligibleTargets.map(minion => minion.instanceId)
    };
    promptForMinionChoice(socket, room, roomId, 'Natural Selection: choose a weaker minion to destroy.', room.pendingAbility.baseIndex, eligibleTargets);
}

function beginSurvivalOfTheFittest(room, roomId, socket) {
    const pendingChoices = [];

    room.activeBases.forEach((base, baseIndex) => {
        const minions = getBaseMinions(base);
        if (minions.length < 2) return;

        const powers = minions.map(getCardPower);
        const lowestPower = Math.min(...powers);
        const highestPower = Math.max(...powers);
        if (lowestPower === highestPower) return;

        const lowestMinions = minions.filter(minion => getCardPower(minion) === lowestPower);
        if (lowestMinions.length === 1) {
            destroyMinion(room, base, lowestMinions[0], socket.id);
        } else {
            pendingChoices.push({ baseIndex, candidateIds: lowestMinions.map(minion => minion.instanceId) });
        }
    });

    if (pendingChoices.length === 0) return;

    room.pendingAbility = { type: 'survivalOfTheFittest', playerId: socket.id, pendingChoices };
    promptForNextSurvivalChoice(room, roomId, socket);
}

function resolvePendingDinosaurAbility(room, roomId, socket, choice) {
    const pendingAbility = room.pendingAbility;
    const base = room.activeBases[choice?.baseIndex];
    const minion = getBaseMinions(base).find(card => card.instanceId === choice?.minionInstanceId);

    if (!base || !minion) return false;

    if (pendingAbility.type === 'naturalSelection') {
        const sourceMinion = getBaseMinions(base).find(card => card.instanceId === pendingAbility.sourceMinionInstanceId);
        const isEligible = pendingAbility.baseIndex === choice.baseIndex
            && pendingAbility.candidateIds.includes(minion.instanceId)
            && sourceMinion
            && getCardPower(minion) < getCardPower(sourceMinion);

        if (!isEligible) return false;

        destroyMinion(room, base, minion, socket.id);
        room.pendingAbility = null;
        return true;
    }

    if (pendingAbility.type === 'survivalOfTheFittest') {
        const nextChoice = pendingAbility.pendingChoices[0];
        const isEligible = nextChoice.baseIndex === choice.baseIndex && nextChoice.candidateIds.includes(minion.instanceId);
        if (!isEligible) return false;

        destroyMinion(room, base, minion, socket.id);
        pendingAbility.pendingChoices.shift();

        if (pendingAbility.pendingChoices.length === 0) {
            room.pendingAbility = null;
        } else {
            promptForNextSurvivalChoice(room, roomId, socket);
        }
        return true;
    }

    return false;
}

function promptForNextSurvivalChoice(room, roomId, socket) {
    const nextChoice = room.pendingAbility.pendingChoices[0];
    const base = room.activeBases[nextChoice.baseIndex];
    const candidates = getBaseMinions(base).filter(minion => nextChoice.candidateIds.includes(minion.instanceId));
    promptForMinionChoice(socket, room, roomId, 'Survival of the Fittest: choose the lowest-power minion to destroy.', nextChoice.baseIndex, candidates);
}

function promptForMinionChoice(socket, room, roomId, message, baseIndex, minions) {
    socket.emit('ability-choice-required', {
        roomId,
        message,
        choices: minions.map(minion => ({
            baseIndex,
            minionInstanceId: minion.instanceId,
            label: `${minion.name} (Power: ${getCardPower(minion)}) at ${room.activeBases[baseIndex].name}`
        }))
    });
}

function promptForMinionChoices(socket, room, roomId, message, minions, canSkip = false, selectionOptions = {}) {
    socket.emit('ability-choice-required', {
        roomId,
        message,
        canSkip,
        ...selectionOptions,
        choices: minions.map(minion => {
            const base = getBaseForMinion(room, minion.instanceId);
            return {
                choiceId: `minion:${minion.instanceId}`,
                baseIndex: room.activeBases.indexOf(base),
                minionInstanceId: minion.instanceId,
                label: `${minion.name} (Power: ${getCardPower(minion)}) at ${base.name}`
            };
        })
    });
}

function applyTemporaryPowerModifier(room, minions, amount, options = {}) {
    const targets = minions.filter(Boolean);
    if (targets.length === 0) return;

    if (!room.temporaryEffects) room.temporaryEffects = [];
    room.temporaryEffects.push({
        type: 'powerModifier',
        targetIds: targets.map(minion => minion.instanceId),
        amount,
        expiresAt: options.expiresAt || 'endOfTurn',
        activatesAt: options.activatesAt || 'immediately',
        active: options.activatesAt !== 'nextTurn',
        ownerId: options.ownerId,
        sourceCardInstanceId: options.sourceCardInstanceId
    });
    recalculateOngoingEffects(room);
}

function applyTemporaryBreakpointModifier(room, base, amount) {
    if (!base || amount === 0) return;

    base.breakpoint -= amount;
    room.temporaryEffects.push({ type: 'breakpointModifier', base, amount });
}

function clearTemporaryEffects(room) {
    room.temporaryEffects = (room.temporaryEffects || []).filter(effect => {
        if (effect.type === 'breakpointModifier') {
            effect.base.breakpoint += effect.amount;
            return false;
        }
        return effect.expiresAt === 'startOfOwnersNextTurn';
    });
    recalculateOngoingEffects(room);
}

function clearStartTurnEffects(room, playerId) {
    room.temporaryEffects = (room.temporaryEffects || []).filter(effect => (
        effect.expiresAt !== 'startOfOwnersNextTurn' || effect.ownerId !== playerId
    ));
    recalculateOngoingEffects(room);
}

function activateNextTurnEffects(room) {
    (room.temporaryEffects || []).forEach(effect => {
        if (effect.activatesAt === 'nextTurn' && !effect.active) effect.active = true;
    });
    recalculateOngoingEffects(room);
}

function removeTemporaryPowerEffectsForCard(room, cardInstanceId) {
    room.temporaryEffects = (room.temporaryEffects || []).filter(effect => (
        effect.type !== 'powerModifier' || !effect.targetIds.includes(cardInstanceId)
    ));
}

function destroyMinion(
    room,
    base,
    minion,
    actorId,
    sourceCardType = getCurrentSourceCardType(room),
    allowReplacement = true,
    actorLabel = null
) {
    if (isMinionProtectedFromCard(room, base, minion, actorId, sourceCardType, 'destroy')) {
        addBattleLog(room, `**${minion.name}** cannot be destroyed.`);
        return false;
    }

    const replacementEffect = getTriggeredEffects(minion, 'wouldBeDestroyed', 'moveMinion')[0];
    const replacementUseKey = `${minion.instanceId}:wouldBeDestroyed`;
    if (!room.turnState.ongoingAbilityUses) room.turnState.ongoingAbilityUses = {};
    if (allowReplacement
        && replacementEffect?.replacementFor === 'destroy'
        && !room.turnState.ongoingAbilityUses[replacementUseKey]) {
        if (!room.triggerQueue) room.triggerQueue = [];
        if (!room.triggerQueue.some(trigger => (
            trigger.type === 'wouldBeDestroyedMove'
            && trigger.minionInstanceId === minion.instanceId
        ))) {
            room.triggerQueue.push({
                type: 'wouldBeDestroyedMove',
                playerId: minion.ownerId,
                minionInstanceId: minion.instanceId,
                sourceBaseIndex: room.activeBases.indexOf(base),
                actorId,
                sourceCardType,
                useKey: replacementUseKey
            });
        }
        return false;
    }

    const minionIndex = base.playedCards.findIndex(card => card.instanceId === minion.instanceId);
    if (minionIndex === -1) return false;

    const ownerHasMicrobotAlpha = room.activeBases.flatMap(getBaseMinions)
        .some(card => card.ownerId === minion.ownerId
            && getTriggeredEffects(card, 'ongoing', 'addTrait').some(effect => effect.trait === 'Microbot'));
    const wasMicrobot = minion.name.includes('Microbot') || ownerHasMicrobotAlpha;
    const archiveTriggers = wasMicrobot
        ? room.activeBases.flatMap(getBaseMinions).filter(card => (
            card.ownerId === minion.ownerId
            && getTriggeredEffects(card, 'afterDestroyed', 'drawCards').length > 0
        ))
        : [];

    const [destroyedMinion] = base.playedCards.splice(minionIndex, 1);
    removeTemporaryPowerEffectsForCard(room, destroyedMinion.instanceId);
    const owner = room.players.find(player => player.id === destroyedMinion.ownerId);
    if (owner) {
        owner.discardPile.push(destroyedMinion);
        (destroyedMinion.attachedCards || []).forEach(attachedCard => {
            const attachedOwner = room.players.find(player => player.id === attachedCard.ownerId) || owner;
            attachedOwner.discardPile.push(attachedCard);
        });
        destroyedMinion.attachedCards = [];
        destroyedMinion.power = getPrintedCardPower(destroyedMinion);
    }

    const actor = room.players.find(player => player.id === actorId);
    addBattleLog(room, `**${actor?.name || actorLabel || 'A player'}** destroys **${destroyedMinion.name}**.`);
    recalculateOngoingEffects(room);

    getTriggeredEffects(destroyedMinion, 'afterDestroyed', 'destroyMinion').forEach(effect => {
        if (effect.target?.owner !== 'otherPlayers' || effect.target.location !== 'formerBase') return;
        [...getBaseMinions(base)]
            .filter(target => target.ownerId !== destroyedMinion.ownerId)
            .forEach(target => destroyMinion(room, base, target, destroyedMinion.ownerId, 'minion'));
    });

    if (archiveTriggers.length > 0 && owner?.deck.length > 0) {
        if (!room.triggerQueue) room.triggerQueue = [];
        archiveTriggers.forEach(archive => {
            room.triggerQueue.push({
                type: 'optionalDraw',
                playerId: archive.ownerId,
                sourceCardName: archive.name
            });
        });
    }
    return true;
}

function getBaseMinions(base) {
    return base?.playedCards?.filter(card => card.type === 'minion') || [];
}

function getCardPower(card) {
    return typeof card?.power === 'number' ? card.power : 0;
}

function getPrintedCardPower(card) {
    return typeof card?.printedPower === 'number' ? card.printedPower : getCardPower(card);
}

function baseAbilitiesAreCancelled(base) {
    return (base?.playedCards || []).some(card => (
        card.type === 'action'
        && getTriggeredEffects(card, 'ongoing', 'cancelBaseAbilities').length > 0
    ));
}

function playerIgnoresBaseAbility(base, playerId) {
    return (base?.playedCards || []).some(card => (
        card.type === 'action'
        && card.ownerId === playerId
        && getTriggeredEffects(card, 'ongoing', 'ignoreBaseAbility').length > 0
    ));
}

function isMovementPrevented(base, playerId) {
    if (!base || baseAbilitiesAreCancelled(base) || playerIgnoresBaseAbility(base, playerId)) return false;
    return getTriggeredEffects(base, 'ongoing', 'preventMove').length > 0;
}

function isMinionPlayPrevented(base, playerId) {
    return (base?.playedCards || []).some(card => (
        card.type === 'action'
        && card.ownerId !== playerId
        && getTriggeredEffects(card, 'ongoing', 'preventPlay').some(effect => (
            effect.target?.kind === 'minion'
            && (effect.target.owner === 'otherPlayer' || effect.target.owner === 'otherPlayers')
        ))
    ));
}

function getOngoingDiscardPlayBaseIndices(room, playerId) {
    if (room.turnState?.ongoingDiscardMinionPlayed) return [];
    return room.activeBases
        .map((base, baseIndex) => ({ base, baseIndex }))
        .filter(({ base }) => (base.playedCards || []).some(card => (
            card.type === 'action'
            && card.ownerId === playerId
            && getTriggeredEffects(card, 'ongoing', 'grantDiscardPlayPermission')
                .some(effect => effect.cardType === 'minion' && effect.destination === 'attachedBase')
        )))
        .map(({ baseIndex }) => baseIndex);
}

function getCurrentSourceCardType(room) {
    return room.currentResolutionContext?.sourceCardType
        || room.pendingAbility?.continuation?.context?.sourceCardType
        || null;
}

function protectionApplies(protection, sourceCardType, operation) {
    if (protection?.from === 'destroy') return operation === 'destroy';
    if (protection?.from === 'otherPlayersCards') return Boolean(sourceCardType);
    if (protection?.from === 'otherPlayersActions') return sourceCardType === 'action';
    return false;
}

function isMinionProtectedFromCard(room, base, minion, actorId, sourceCardType, operation = 'affect') {
    if (!minion) return false;

    const selfProtected = getTriggeredEffects(minion, 'ongoing', 'grantProtection')
        .some(effect => effect.target === 'self'
            && protectionApplies(effect.protection, sourceCardType, operation));
    if (selfProtected) return true;

    const protectedByAttachment = (minion.attachedCards || []).some(card => (
        card.ownerId !== actorId
        && getTriggeredEffects(card, 'ongoing', 'grantProtection').some(effect => (
            effect.target === 'attachedTo'
            && protectionApplies(effect.protection, sourceCardType, operation)
        ))
    ));
    if (protectedByAttachment) return true;

    return (base?.playedCards || []).some(card => (
        card.type === 'action'
        && card.ownerId === minion.ownerId
        && card.ownerId !== actorId
        && getTriggeredEffects(card, 'ongoing', 'grantProtection').some(effect => (
            effect.target?.kind === 'minion'
            && effect.target.owner === 'controller'
            && effect.target.location === 'attachedBase'
            && protectionApplies(effect.protection, sourceCardType, operation)
        ))
    ));
}

function isMinionProtectedFromCurrentEffect(room, base, minion, actorId, operation = 'affect') {
    return isMinionProtectedFromCard(
        room,
        base,
        minion,
        actorId,
        getCurrentSourceCardType(room),
        operation
    );
}

function recalculateOngoingEffects(room) {
    if (!room?.activeBases) return;
    const allMinions = room.activeBases.flatMap(getBaseMinions);
    const hasMicrobotAlpha = new Set(
        allMinions
            .filter(minion => getTriggeredEffects(minion, 'ongoing', 'addTrait')
                .some(effect => effect.trait === 'Microbot' && effect.target?.owner === 'controller'))
            .map(minion => minion.ownerId)
    );

    room.activeBases.forEach(base => {
        const baseMinions = getBaseMinions(base);
        const baseAbilitiesCancelled = baseAbilitiesAreCancelled(base);

        baseMinions.forEach(minion => {
            if (typeof minion.printedPower !== 'number') minion.printedPower = getCardPower(minion);
            let power = minion.printedPower;

            if (!baseAbilitiesCancelled && !playerIgnoresBaseAbility(base, minion.ownerId)) {
                getTriggeredEffects(base, 'ongoing', 'modifyPower')
                    .filter(effect => effect.target?.kind === 'minion' && effect.target.location === 'thisBase')
                    .forEach(effect => { power += Number(effect.amount) || 0; });
            }

            getTriggeredEffects(minion, 'ongoing', 'modifyPower')
                .filter(effect => (
                    effect.target === 'self'
                    && (effect.activeDuring !== 'otherPlayersTurns'
                        || (room.currentTurnPlayerId && room.currentTurnPlayerId !== minion.ownerId))
                ))
                .forEach(effect => {
                    if (typeof effect.amount === 'number') power += effect.amount;
                    if (effect.amount?.type === 'countMinions') {
                        power += baseMinions.filter(card => card.cardId === effect.amount.cardId).length;
                    }
                    if (effect.amount?.type === 'countMinionsWithTrait') {
                        power += allMinions.filter(card => (
                            card.ownerId === minion.ownerId
                            && (!effect.amount.excludeSelf || card.instanceId !== minion.instanceId)
                            && (card.name.includes(effect.amount.trait) || hasMicrobotAlpha.has(card.ownerId))
                        )).length;
                    }
                });

            const isMicrobot = minion.name.includes('Microbot') || hasMicrobotAlpha.has(minion.ownerId);
            allMinions
                .filter(source => source.ownerId === minion.ownerId)
                .flatMap(source => getTriggeredEffects(source, 'ongoing', 'modifyPower'))
                .filter(effect => effect.target?.kind === 'minion'
                    && effect.target.owner === 'controller'
                    && (!effect.target.trait || (effect.target.trait === 'Microbot' && isMicrobot)))
                .forEach(effect => { power += Number(effect.amount) || 0; });

            (minion.attachedCards || []).forEach(card => {
                (card.abilities || [])
                    .filter(ability => ability.trigger === 'ongoing')
                    .flatMap(ability => ability.effects)
                    .filter(effect => effect.type === 'modifyPower' && effect.target === 'attachedTo' && typeof effect.amount === 'number')
                    .forEach(effect => { power += effect.amount; });
            });

            (room.temporaryEffects || [])
                .filter(effect => (
                    effect.type === 'powerModifier'
                    && effect.active !== false
                    && effect.targetIds.includes(minion.instanceId)
                ))
                .forEach(effect => { power += effect.amount; });

            minion.power = Math.max(0, power);
        });
    });
}

function findCardByInstanceId(room, instanceId) {
    const playerCards = room.players.flatMap(player => [...player.hand, ...player.deck, ...player.discardPile]);
    const boardCards = room.activeBases.flatMap(base => base.playedCards.flatMap(card => [card, ...(card.attachedCards || [])]));
    return [...playerCards, ...boardCards].find(card => card.instanceId === instanceId);
}

function addBattleLog(room, message) {
    if (!room.battleLog) room.battleLog = [];
    room.battleLog.unshift(message);
}

function appendChatMessage(room, sender, rawMessage) {
    if (typeof rawMessage !== 'string') {
        return { ok: false, error: 'Chat message must be text.' };
    }
    const text = rawMessage.trim();
    if (!text) return { ok: false, error: 'Chat message cannot be empty.' };
    if (text.length > MAX_CHAT_MESSAGE_LENGTH) {
        return { ok: false, error: `Chat messages must be ${MAX_CHAT_MESSAGE_LENGTH} characters or fewer.` };
    }

    const message = {
        id: `${Date.now()}-${systemRandom().toString(36).slice(2, 10)}`,
        senderId: sender.id,
        senderName: sender.name,
        text,
        timestamp: Date.now()
    };
    if (!room.chatMessages) room.chatMessages = [];
    room.chatMessages.push(message);
    if (room.chatMessages.length > MAX_CHAT_HISTORY) {
        room.chatMessages.splice(0, room.chatMessages.length - MAX_CHAT_HISTORY);
    }
    return { ok: true, message };
}

function resolveStartTurnActions(room, playerId) {
    clearStartTurnEffects(room, playerId);
    activateNextTurnEffects(room);
    room.activeBases.forEach(base => {
        base.playedCards = (base.playedCards || []).filter(card => {
            const destroysSelfAtStartOfTurn = card.type === 'action'
                && card.ownerId === playerId
                && (card.abilities || []).some(ability => (
                    ability.trigger === 'startTurn'
                    && (ability.effects || []).some(effect => effect.type === 'destroyAction' && effect.target === 'self')
                ));
            if (!destroysSelfAtStartOfTurn) return true;

            const owner = room.players.find(player => player.id === card.ownerId);
            owner?.discardPile.push(card);
            addBattleLog(room, `**${card.name}** is destroyed at the start of **${owner?.name || 'its owner'}**'s turn.`);
            return false;
        });
    });
    recalculateOngoingEffects(room);
}

function resolveEndTurnActions(room) {
    room.activeBases.forEach(base => {
        [...getBaseMinions(base)].forEach(minion => {
            const destroyingAction = (minion.attachedCards || []).find(card => (
                card.type === 'action'
                && getTriggeredEffects(card, 'endTurn', 'destroyMinion')
                    .some(effect => effect.target === 'attachedTo')
            ));
            if (destroyingAction) destroyMinion(room, base, minion, destroyingAction.ownerId, 'action');
        });
    });
    recalculateOngoingEffects(room);
}

function queueAfterMinionPlayedBaseAbilities(room, base, playedMinion) {
    if (!base || !playedMinion || baseAbilitiesAreCancelled(base)) return;

    const baseIndex = room.activeBases.indexOf(base);
    if (baseIndex < 0) return;
    if (!room.triggerQueue) room.triggerQueue = [];
    const ignoresHarmfulBaseEffect = playerIgnoresBaseAbility(base, playedMinion.ownerId);

    (base.abilities || [])
        .filter(ability => ability.trigger === 'afterMinionPlayed')
        .forEach(ability => {
            (ability.effects || []).forEach(effect => {
                if (effect.type === 'drawCards' && effect.target === 'playedMinionOwner') {
                    room.triggerQueue.push({
                        type: 'baseDrawAfterMinionPlayed',
                        playerId: playedMinion.ownerId,
                        amount: effect.amount,
                        sourceBaseName: base.name
                    });
                }
                if (effect.type === 'grantExtraPlay' && effect.cardType === 'minion') {
                    room.triggerQueue.push({
                        type: 'baseOptionalExtraPlay',
                        playerId: playedMinion.ownerId,
                        baseIndex,
                        maxPower: effect.maxPower,
                        amount: effect.amount,
                        sourceBaseName: base.name
                    });
                }
                if (effect.type === 'destroyMinion' && effect.target === 'playedMinion') {
                    if (ignoresHarmfulBaseEffect) return;
                    room.triggerQueue.push({
                        type: 'baseDestroyPlayedMinion',
                        playerId: playedMinion.ownerId,
                        baseIndex,
                        minionInstanceId: playedMinion.instanceId,
                        maxPower: ability.condition?.playedMinion?.power?.max,
                        sourceBaseName: base.name
                    });
                }
            });
        });
}

function getPlayersInTurnOrder(room, startingPlayerId = room.currentTurnPlayerId) {
    const startingIndex = room.players.findIndex(player => player.id === startingPlayerId);
    if (startingIndex < 0) return [...room.players];
    return [...room.players.slice(startingIndex), ...room.players.slice(0, startingIndex)];
}

function queueBeforeBaseScoringSpecials(room, scoringBaseIndices) {
    if (!room.triggerQueue) room.triggerQueue = [];
    room.scoringSpecialUses = {};
    const playerOrder = getPlayersInTurnOrder(room);

    scoringBaseIndices.forEach(baseIndex => {
        const scoringBase = room.activeBases[baseIndex];
        if (!scoringBase) return;

        playerOrder.forEach(player => {
            if (player.hand.some(card => getTriggeredEffects(card, 'beforeBaseScoring', 'playFromHand').length > 0)) {
                room.triggerQueue.push({
                    type: 'beforeScoreShinobi',
                    playerId: player.id,
                    scoringBaseId: scoringBase.id,
                    scoringBaseName: scoringBase.name
                });
            }
            if (player.hand.some(card => getTriggeredEffects(card, 'beforeBaseScoring', 'playMinionFromHand').length > 0)) {
                room.triggerQueue.push({
                    type: 'beforeScoreHiddenNinja',
                    playerId: player.id,
                    scoringBaseId: scoringBase.id,
                    scoringBaseName: scoringBase.name
                });
            }
            if (player.hand.some(card => (
                card.type === 'action'
                && getTriggeredEffects(card, 'beforeBaseScoring', 'moveMinion').length > 0
            ))) {
                room.triggerQueue.push({
                    type: 'beforeScoreFullSail',
                    playerId: player.id,
                    scoringBaseId: scoringBase.id,
                    scoringBaseName: scoringBase.name
                });
            }

            room.activeBases.flatMap(getBaseMinions)
                .filter(minion => (
                    minion.ownerId === player.id
                    && getTriggeredEffects(minion, 'beforeBaseScoring', 'moveMinion')
                        .some(effect => effect.target === 'self' && effect.destination === 'scoringBase')
                ))
                .forEach(minion => {
                    room.triggerQueue.push({
                        type: 'beforeScorePirateKing',
                        playerId: player.id,
                        minionInstanceId: minion.instanceId,
                        scoringBaseId: scoringBase.id,
                        scoringBaseName: scoringBase.name
                    });
                });
        });
    });
}

function findActiveBaseById(room, baseId) {
    return room.activeBases.find(base => base.id === baseId);
}

function processNextTriggeredAbility(room, roomId) {
    if (room.pendingAbility || !room.triggerQueue?.length) return false;
    const trigger = room.triggerQueue.shift();

    if (trigger.type === 'beforeScoreShinobi') {
        const player = room.players.find(candidate => candidate.id === trigger.playerId);
        const base = findActiveBaseById(room, trigger.scoringBaseId);
        const useKey = `${trigger.scoringBaseId}:ninja_shinobi`;
        const shinobi = player?.hand.find(card => getTriggeredEffects(card, 'beforeBaseScoring', 'playFromHand').length > 0);
        if (!base || !shinobi || room.scoringSpecialUses?.[useKey]
            || isMinionPlayPrevented(base, trigger.playerId)) {
            return processNextTriggeredAbility(room, roomId);
        }
        room.pendingAbility = {
            type: 'triggeredBeforeScoreShinobi',
            playerId: trigger.playerId,
            cardInstanceId: shinobi.instanceId,
            scoringBaseId: trigger.scoringBaseId,
            scoringBaseName: trigger.scoringBaseName,
            useKey
        };
        emitTriggeredChoice(room, trigger.playerId, {
            roomId,
            message: `Play ${shinobi.name} on ${trigger.scoringBaseName} before it scores?`,
            choices: [
                { choiceId: 'accept', label: `Play ${shinobi.name}` },
                { choiceId: 'skip', label: 'Skip ability' }
            ]
        });
        return true;
    }

    if (trigger.type === 'beforeScoreHiddenNinja') {
        const player = room.players.find(candidate => candidate.id === trigger.playerId);
        const base = findActiveBaseById(room, trigger.scoringBaseId);
        const action = player?.hand.find(card => getTriggeredEffects(card, 'beforeBaseScoring', 'playMinionFromHand').length > 0);
        const hasMinion = player?.hand.some(card => card.type === 'minion');
        if (!base || !action || !hasMinion || isMinionPlayPrevented(base, trigger.playerId)) {
            return processNextTriggeredAbility(room, roomId);
        }
        room.pendingAbility = {
            type: 'triggeredBeforeScoreHiddenNinja',
            playerId: trigger.playerId,
            cardInstanceId: action.instanceId,
            scoringBaseId: trigger.scoringBaseId,
            scoringBaseName: trigger.scoringBaseName
        };
        emitTriggeredChoice(room, trigger.playerId, {
            roomId,
            message: `Play ${action.name} before ${trigger.scoringBaseName} scores?`,
            choices: [
                { choiceId: 'accept', label: `Play ${action.name}` },
                { choiceId: 'skip', label: 'Skip ability' }
            ]
        });
        return true;
    }

    if (trigger.type === 'beforeScoreFullSail') {
        const player = room.players.find(candidate => candidate.id === trigger.playerId);
        const base = findActiveBaseById(room, trigger.scoringBaseId);
        const action = player?.hand.find(card => (
            card.type === 'action'
            && getTriggeredEffects(card, 'beforeBaseScoring', 'moveMinion').length > 0
        ));
        if (!base || !action) return processNextTriggeredAbility(room, roomId);
        room.pendingAbility = {
            type: 'triggeredBeforeScoreFullSail',
            playerId: trigger.playerId,
            cardInstanceId: action.instanceId,
            scoringBaseId: trigger.scoringBaseId,
            scoringBaseName: trigger.scoringBaseName
        };
        emitTriggeredChoice(room, trigger.playerId, {
            roomId,
            message: `Play ${action.name} before ${trigger.scoringBaseName} scores?`,
            choices: [
                { choiceId: 'accept', label: `Play ${action.name}` },
                { choiceId: 'skip', label: 'Skip ability' }
            ]
        });
        return true;
    }

    if (trigger.type === 'beforeScorePirateKing') {
        const minion = findMinionOnBoard(room, trigger.minionInstanceId);
        const sourceBase = getBaseForMinion(room, trigger.minionInstanceId);
        const scoringBase = findActiveBaseById(room, trigger.scoringBaseId);
        if (!minion || !sourceBase || !scoringBase || sourceBase === scoringBase
            || isMovementPrevented(sourceBase, trigger.playerId)) {
            return processNextTriggeredAbility(room, roomId);
        }
        room.pendingAbility = {
            type: 'triggeredBeforeScorePirateKing',
            playerId: trigger.playerId,
            minionInstanceId: trigger.minionInstanceId,
            sourceBaseId: sourceBase.id,
            scoringBaseId: trigger.scoringBaseId,
            scoringBaseName: trigger.scoringBaseName
        };
        emitTriggeredChoice(room, trigger.playerId, {
            roomId,
            message: `Move ${minion.name} to ${trigger.scoringBaseName} before it scores?`,
            choices: [
                { choiceId: 'accept', label: `Move ${minion.name}` },
                { choiceId: 'skip', label: 'Skip ability' }
            ]
        });
        return true;
    }

    if (trigger.type === 'baseDrawAfterMinionPlayed') {
        const player = room.players.find(candidate => candidate.id === trigger.playerId);
        const cardsBeforeDraw = player?.hand.length || 0;
        drawCards(room, trigger.playerId, trigger.amount);
        if ((player?.hand.length || 0) > cardsBeforeDraw) {
            addBattleLog(room, `**${player.name}** draws a card from **${trigger.sourceBaseName}**.`);
        }
        return processNextTriggeredAbility(room, roomId);
    }

    if (trigger.type === 'baseDestroyPlayedMinion') {
        const base = room.activeBases[trigger.baseIndex];
        const minion = base && getBaseMinions(base)
            .find(card => card.instanceId === trigger.minionInstanceId);
        if (minion && (typeof trigger.maxPower !== 'number' || getCardPower(minion) <= trigger.maxPower)) {
            destroyMinion(room, base, minion, null, null, true, trigger.sourceBaseName);
        }
        return processNextTriggeredAbility(room, roomId);
    }

    if (trigger.type === 'baseOptionalExtraPlay') {
        const base = room.activeBases[trigger.baseIndex];
        const player = room.players.find(candidate => candidate.id === trigger.playerId);
        const hasEligibleMinion = player?.hand.some(card => (
            card.type === 'minion'
            && (typeof trigger.maxPower !== 'number' || getPrintedCardPower(card) <= trigger.maxPower)
        ));
        if (!base || !hasEligibleMinion) return processNextTriggeredAbility(room, roomId);
        room.pendingAbility = {
            type: 'triggeredBaseExtraPlay',
            playerId: trigger.playerId,
            baseIndex: trigger.baseIndex,
            maxPower: trigger.maxPower,
            amount: trigger.amount,
            sourceBaseName: trigger.sourceBaseName
        };
        emitTriggeredChoice(room, trigger.playerId, {
            roomId,
            message: `${trigger.sourceBaseName}: play an extra minion of power ${trigger.maxPower} or less here?`,
            choices: [
                { choiceId: 'accept', label: 'Use ability' },
                { choiceId: 'skip', label: 'Skip ability' }
            ]
        });
        return true;
    }

    if (trigger.type === 'afterScoreScout') {
        const minion = getHeldScoredMinion(room, trigger.minionInstanceId);
        if (!minion) return processNextTriggeredAbility(room, roomId);
        room.pendingAbility = {
            type: 'triggeredAfterScoreScout',
            playerId: trigger.playerId,
            minionInstanceId: trigger.minionInstanceId,
            sourceBaseName: trigger.sourceBaseName
        };
        emitTriggeredChoice(room, trigger.playerId, {
            roomId,
            message: `Return ${minion.name} to your hand after ${trigger.sourceBaseName} scores?`,
            choices: [
                { choiceId: 'accept', label: `Return ${minion.name}` },
                { choiceId: 'skip', label: 'Discard it normally' }
            ]
        });
        return true;
    }

    if (trigger.type === 'afterScoreFirstMate') {
        const minion = getHeldScoredMinion(room, trigger.minionInstanceId);
        const destinations = room.activeBases
            .map((base, baseIndex) => ({ base, baseIndex }))
            .filter(({ base }) => trigger.destinationBaseIds.includes(base.id));
        if (!minion || destinations.length === 0) {
            if (minion) discardHeldScoredMinion(room, minion.instanceId);
            return processNextTriggeredAbility(room, roomId);
        }
        room.pendingAbility = {
            type: 'triggeredAfterScoreFirstMate',
            playerId: trigger.playerId,
            minionInstanceId: trigger.minionInstanceId,
            destinationBaseIds: trigger.destinationBaseIds,
            sourceBaseName: trigger.sourceBaseName
        };
        emitTriggeredChoice(room, trigger.playerId, {
            roomId,
            message: `Move ${minion.name} to another base after ${trigger.sourceBaseName} scores?`,
            choices: [
                { choiceId: 'accept', label: `Move ${minion.name}` },
                { choiceId: 'skip', label: 'Discard it normally' }
            ]
        });
        return true;
    }

    if (trigger.type === 'baseWinnerMoveAfterScoring') {
        const candidateMinions = trigger.candidateMinions
            .map(minion => getHeldScoredMinion(room, minion.instanceId))
            .filter(Boolean);
        const destinations = room.activeBases
            .map((base, baseIndex) => ({ base, baseIndex }))
            .filter(({ base }) => trigger.destinationBaseIds.includes(base.id));
        if (candidateMinions.length === 0 || destinations.length === 0) {
            candidateMinions.forEach(minion => discardHeldScoredMinion(room, minion.instanceId));
            return processNextTriggeredAbility(room, roomId);
        }

        room.pendingAbility = {
            type: 'triggeredBaseWinnerMoveMinion',
            playerId: trigger.playerId,
            candidateMinions,
            destinationBaseIds: trigger.destinationBaseIds,
            sourceBaseName: trigger.sourceBaseName
        };
        emitTriggeredChoice(room, trigger.playerId, {
            roomId,
            message: `${trigger.sourceBaseName}: move one of your minions to another base?`,
            choices: [
                ...trigger.candidateMinions.map(minion => ({
                    choiceId: `minion:${minion.instanceId}`,
                    minionInstanceId: minion.instanceId,
                    label: `${minion.name} (Power: ${getCardPower(minion)})`
                })),
                { choiceId: 'skip', label: 'Do not move a minion' }
            ]
        });
        return true;
    }

    if (trigger.type === 'wouldBeDestroyedMove') {
        const minion = findMinionOnBoard(room, trigger.minionInstanceId);
        const sourceBase = room.activeBases[trigger.sourceBaseIndex];
        if (!minion || !sourceBase || !getBaseMinions(sourceBase)
            .some(card => card.instanceId === minion.instanceId)) {
            return processNextTriggeredAbility(room, roomId);
        }
        const candidateBaseIndices = room.activeBases
            .map((base, baseIndex) => ({ base, baseIndex }))
            .filter(({ base }) => base !== sourceBase)
            .map(({ baseIndex }) => baseIndex);
        if (candidateBaseIndices.length === 0) {
            destroyMinion(room, sourceBase, minion, trigger.actorId, trigger.sourceCardType, false);
            return processNextTriggeredAbility(room, roomId);
        }

        room.pendingAbility = {
            type: 'triggeredBuccaneer',
            playerId: trigger.playerId,
            minionInstanceId: trigger.minionInstanceId,
            sourceBaseIndex: trigger.sourceBaseIndex,
            candidateBaseIndices,
            actorId: trigger.actorId,
            sourceCardType: trigger.sourceCardType,
            useKey: trigger.useKey
        };
        emitTriggeredChoice(room, trigger.playerId, {
            roomId,
            message: `Move ${minion.name} instead of destroying it?`,
            choices: [
                ...candidateBaseIndices.map(baseIndex => ({
                    choiceId: `base:${baseIndex}`,
                    baseIndex,
                    label: room.activeBases[baseIndex].name
                })),
                { choiceId: 'skip', label: 'Allow it to be destroyed' }
            ]
        });
        return true;
    }

    if (trigger.type === 'optionalDraw') {
        const player = room.players.find(candidate => candidate.id === trigger.playerId);
        if (!player?.deck.length) return processNextTriggeredAbility(room, roomId);
        room.pendingAbility = {
            type: 'triggeredOptionalDraw',
            playerId: trigger.playerId,
            sourceCardName: trigger.sourceCardName
        };
        emitTriggeredChoice(room, trigger.playerId, {
            roomId,
            message: `${trigger.sourceCardName}: draw a card?`,
            choices: [
                { choiceId: 'accept', label: 'Draw a card' },
                { choiceId: 'skip', label: 'Do not draw' }
            ]
        });
        return true;
    }

    return processNextTriggeredAbility(room, roomId);
}

function beginSpecialMinionPlay(room, roomId, socket, cardInstanceId, scoringBaseId) {
    const player = room.players.find(candidate => candidate.id === socket.id);
    const cardIndex = player?.hand.findIndex(card => card.instanceId === cardInstanceId);
    const base = findActiveBaseById(room, scoringBaseId);
    if (!player || cardIndex === undefined || cardIndex < 0 || !base) return false;

    const [card] = player.hand.splice(cardIndex, 1);
    if (card.type !== 'minion' || isMinionPlayPrevented(base, socket.id)) {
        player.hand.splice(cardIndex, 0, card);
        return false;
    }

    const playedCard = { ...card, ownerId: player.id, ownerName: player.name };
    base.playedCards.push(playedCard);
    room.turnState.minionPlayed = true;
    room.turnState.minionsPlayed += 1;
    addBattleLog(room, {
        message: `**${player.name}** plays **${playedCard.name}** on **${base.name}**`,
        card: playedCard,
        playerName: player.name,
        targetName: base.name
    });

    const deferredTriggerCount = room.triggerQueue?.length || 0;
    room.afterOnPlayResolution = () => {
        queueAfterMinionPlayedBaseAbilities(room, base, playedCard);
        const immediateTriggers = room.triggerQueue.splice(deferredTriggerCount);
        room.triggerQueue.unshift(...immediateTriggers);
        continueAfterTriggeredAbility(room, roomId);
    };
    recalculateOngoingEffects(room);
    resolveOnPlayBoardEffects({ room, roomId, socket, playedCard, targetBase: base, targetMinion: null });
    return true;
}

function beginSpecialActionPlay(room, roomId, socket, cardInstanceId) {
    const player = room.players.find(candidate => candidate.id === socket.id);
    const cardIndex = player?.hand.findIndex(card => card.instanceId === cardInstanceId);
    if (!player || cardIndex === undefined || cardIndex < 0) return false;

    const [card] = player.hand.splice(cardIndex, 1);
    if (card.type !== 'action') {
        player.hand.splice(cardIndex, 0, card);
        return false;
    }
    const playedCard = { ...card, ownerId: player.id, ownerName: player.name };
    player.discardPile.push(playedCard);
    addBattleLog(room, {
        message: `**${player.name}** plays **${playedCard.name}**`,
        card: playedCard,
        playerName: player.name,
        targetName: null
    });
    const deferredTriggerCount = room.triggerQueue?.length || 0;
    room.afterOnPlayResolution = () => {
        const immediateTriggers = room.triggerQueue.splice(deferredTriggerCount);
        room.triggerQueue.unshift(...immediateTriggers);
        continueAfterTriggeredAbility(room, roomId);
    };
    resolveOnPlayBoardEffects({ room, roomId, socket, playedCard, targetBase: null, targetMinion: null });
    return true;
}

function resolveTriggeredAbilityChoice(room, roomId, socket, choice) {
    const pendingAbility = room.pendingAbility;
    if (pendingAbility.type === 'triggeredBeforeScoreShinobi') {
        if (choice?.choiceId !== 'accept' && choice?.choiceId !== 'skip') return false;
        if (choice.choiceId === 'skip') {
            room.pendingAbility = null;
            continueAfterTriggeredAbility(room, roomId);
            return true;
        }
        const player = room.players.find(candidate => candidate.id === socket.id);
        const card = player?.hand.find(candidate => candidate.instanceId === pendingAbility.cardInstanceId);
        if (!card || room.scoringSpecialUses?.[pendingAbility.useKey]) return false;
        room.pendingAbility = null;
        room.scoringSpecialUses[pendingAbility.useKey] = true;
        if (!beginSpecialMinionPlay(room, roomId, socket, card.instanceId, pendingAbility.scoringBaseId)) {
            delete room.scoringSpecialUses[pendingAbility.useKey];
            return false;
        }
        return true;
    }

    if (pendingAbility.type === 'triggeredBeforeScoreHiddenNinja') {
        if (choice?.choiceId !== 'accept' && choice?.choiceId !== 'skip') return false;
        if (choice.choiceId === 'skip') {
            room.pendingAbility = null;
            continueAfterTriggeredAbility(room, roomId);
            return true;
        }
        const player = room.players.find(candidate => candidate.id === socket.id);
        const actionIndex = player?.hand.findIndex(card => card.instanceId === pendingAbility.cardInstanceId);
        const minions = player?.hand.filter(card => card.type === 'minion') || [];
        if (actionIndex === undefined || actionIndex < 0 || minions.length === 0) return false;
        const [action] = player.hand.splice(actionIndex, 1);
        const playedAction = { ...action, ownerId: player.id, ownerName: player.name };
        player.discardPile.push(playedAction);
        addBattleLog(room, `**${player.name}** plays **${playedAction.name}** before **${pendingAbility.scoringBaseName}** scores.`);
        room.pendingAbility = {
            type: 'triggeredBeforeScoreHiddenNinjaMinion',
            playerId: socket.id,
            scoringBaseId: pendingAbility.scoringBaseId,
            scoringBaseName: pendingAbility.scoringBaseName,
            candidateIds: minions.map(card => card.instanceId)
        };
        emitActorEvent(socket, 'ability-choice-required', {
            roomId,
            message: `Choose a minion to play on ${pendingAbility.scoringBaseName}.`,
            choices: minions.map(card => ({
                choiceId: `card:${card.instanceId}`,
                cardInstanceId: card.instanceId,
                label: `${card.name} (Power: ${getPrintedCardPower(card)})`
            }))
        });
        return true;
    }

    if (pendingAbility.type === 'triggeredBeforeScoreHiddenNinjaMinion') {
        if (!pendingAbility.candidateIds.includes(choice?.cardInstanceId)) return false;
        const scoringBaseId = pendingAbility.scoringBaseId;
        room.pendingAbility = null;
        return beginSpecialMinionPlay(room, roomId, socket, choice.cardInstanceId, scoringBaseId);
    }

    if (pendingAbility.type === 'triggeredBeforeScoreFullSail') {
        if (choice?.choiceId !== 'accept' && choice?.choiceId !== 'skip') return false;
        if (choice.choiceId === 'skip') {
            room.pendingAbility = null;
            continueAfterTriggeredAbility(room, roomId);
            return true;
        }
        const cardInstanceId = pendingAbility.cardInstanceId;
        room.pendingAbility = null;
        return beginSpecialActionPlay(room, roomId, socket, cardInstanceId);
    }

    if (pendingAbility.type === 'triggeredBeforeScorePirateKing') {
        if (choice?.choiceId !== 'accept' && choice?.choiceId !== 'skip') return false;
        if (choice.choiceId === 'skip') {
            room.pendingAbility = null;
            continueAfterTriggeredAbility(room, roomId);
            return true;
        }
        const minion = findMinionOnBoard(room, pendingAbility.minionInstanceId);
        const sourceBase = getBaseForMinion(room, pendingAbility.minionInstanceId);
        const destinationBase = findActiveBaseById(room, pendingAbility.scoringBaseId);
        if (!minion || !sourceBase || !destinationBase || sourceBase === destinationBase
            || isMovementPrevented(sourceBase, socket.id)) return false;
        sourceBase.playedCards = sourceBase.playedCards.filter(card => card.instanceId !== minion.instanceId);
        destinationBase.playedCards.push(minion);
        room.pendingAbility = null;
        addBattleLog(room, `**${minion.name}** moves from **${sourceBase.name}** to **${destinationBase.name}** before scoring.`);
        recalculateOngoingEffects(room);
        continueAfterTriggeredAbility(room, roomId);
        return true;
    }

    if (pendingAbility.type === 'triggeredAfterScoreScout') {
        if (choice?.choiceId !== 'accept' && choice?.choiceId !== 'skip') return false;
        const minion = getHeldScoredMinion(room, pendingAbility.minionInstanceId);
        if (!minion) return false;
        const player = room.players.find(candidate => candidate.id === socket.id);
        if (choice.choiceId === 'accept') {
            returnHeldScoredMinionToHand(room, minion.instanceId);
            addBattleLog(room, `**${player?.name || 'A player'}** returns **${minion.name}** to their hand after scoring.`);
        } else {
            discardHeldScoredMinion(room, minion.instanceId);
        }
        room.pendingAbility = null;
        recalculateOngoingEffects(room);
        continueAfterTriggeredAbility(room, roomId);
        return true;
    }

    if (pendingAbility.type === 'triggeredAfterScoreFirstMate') {
        if (choice?.choiceId !== 'accept' && choice?.choiceId !== 'skip') return false;
        const minion = getHeldScoredMinion(room, pendingAbility.minionInstanceId);
        if (!minion) return false;
        if (choice.choiceId === 'skip') {
            discardHeldScoredMinion(room, minion.instanceId);
            room.pendingAbility = null;
            continueAfterTriggeredAbility(room, roomId);
            return true;
        }
        const destinations = room.activeBases
            .map((base, baseIndex) => ({ base, baseIndex }))
            .filter(({ base }) => pendingAbility.destinationBaseIds.includes(base.id));
        if (destinations.length === 0) return false;
        room.pendingAbility = {
            ...pendingAbility,
            type: 'triggeredAfterScoreFirstMateDestination'
        };
        emitActorEvent(socket, 'ability-choice-required', {
            roomId,
            message: `Choose where to move ${minion.name}.`,
            choices: destinations.map(({ base, baseIndex }) => ({
                choiceId: `base:${baseIndex}`,
                baseIndex,
                label: base.name
            }))
        });
        return true;
    }

    if (pendingAbility.type === 'triggeredAfterScoreFirstMateDestination') {
        const destinationBase = room.activeBases[choice?.baseIndex];
        if (!destinationBase || !pendingAbility.destinationBaseIds.includes(destinationBase.id)) return false;
        const minion = releaseHeldScoredMinion(room, pendingAbility.minionInstanceId);
        if (!minion) return false;
        destinationBase.playedCards.push(minion);
        addBattleLog(room, `**${minion.name}** moves from **${pendingAbility.sourceBaseName}** to **${destinationBase.name}** after scoring.`);
        room.pendingAbility = null;
        recalculateOngoingEffects(room);
        continueAfterTriggeredAbility(room, roomId);
        return true;
    }

    if (pendingAbility.type === 'triggeredBaseWinnerMoveMinion') {
        if (choice?.choiceId === 'skip') {
            pendingAbility.candidateMinions.forEach(minion => discardHeldScoredMinion(room, minion.instanceId));
            room.pendingAbility = null;
            continueAfterTriggeredAbility(room, roomId);
            return true;
        }

        const selectedMinion = pendingAbility.candidateMinions
            .find(minion => minion.instanceId === choice?.minionInstanceId);
        if (!selectedMinion) return false;
        const destinations = room.activeBases
            .map((base, baseIndex) => ({ base, baseIndex }))
            .filter(({ base }) => pendingAbility.destinationBaseIds.includes(base.id));
        if (destinations.length === 0) return false;

        room.pendingAbility = {
            type: 'triggeredBaseWinnerMoveDestination',
            playerId: socket.id,
            candidateMinions: pendingAbility.candidateMinions,
            selectedMinionInstanceId: selectedMinion.instanceId,
            destinationBaseIds: pendingAbility.destinationBaseIds,
            sourceBaseName: pendingAbility.sourceBaseName
        };
        emitActorEvent(socket, 'ability-choice-required', {
            roomId,
            message: `Choose where to move ${selectedMinion.name}.`,
            choices: destinations.map(({ base, baseIndex }) => ({
                choiceId: `base:${baseIndex}`,
                baseIndex,
                label: base.name
            }))
        });
        return true;
    }

    if (pendingAbility.type === 'triggeredBaseWinnerMoveDestination') {
        const destinationBase = room.activeBases[choice?.baseIndex];
        if (!destinationBase || !pendingAbility.destinationBaseIds.includes(destinationBase.id)) return false;
        const selectedMinion = pendingAbility.candidateMinions
            .find(minion => minion.instanceId === pendingAbility.selectedMinionInstanceId);
        if (!selectedMinion) return false;

        const movedMinion = releaseHeldScoredMinion(room, selectedMinion.instanceId);
        if (!movedMinion) return false;
        destinationBase.playedCards.push(movedMinion);
        pendingAbility.candidateMinions
            .filter(minion => minion.instanceId !== selectedMinion.instanceId)
            .forEach(minion => discardHeldScoredMinion(room, minion.instanceId));
        addBattleLog(room, `**${selectedMinion.name}** moves from **${pendingAbility.sourceBaseName}** to **${destinationBase.name}**.`);
        room.pendingAbility = null;
        recalculateOngoingEffects(room);
        continueAfterTriggeredAbility(room, roomId);
        return true;
    }

    if (pendingAbility.type === 'triggeredBaseExtraPlay') {
        if (choice?.choiceId !== 'accept' && choice?.choiceId !== 'skip') return false;
        if (choice.choiceId === 'accept') {
            const amount = typeof pendingAbility.amount === 'number' ? pendingAbility.amount : 1;
            for (let index = 0; index < amount; index += 1) {
                room.turnState.extraMinionPlays.push({
                    maxPower: pendingAbility.maxPower,
                    allowedBaseIndex: pendingAbility.baseIndex
                });
            }
            const player = room.players.find(candidate => candidate.id === socket.id);
            addBattleLog(room, `**${player?.name || 'A player'}** uses **${pendingAbility.sourceBaseName}**.`);
        }
        room.pendingAbility = null;
        continueAfterTriggeredAbility(room, roomId);
        return true;
    }

    if (pendingAbility.type === 'triggeredOptionalDraw') {
        if (choice?.choiceId !== 'accept' && choice?.choiceId !== 'skip') return false;
        if (choice.choiceId === 'accept') {
            const player = room.players.find(candidate => candidate.id === socket.id);
            const card = drawPlayerCard(room, player);
            if (card) {
                player.hand.push(card);
                addBattleLog(room, `**${player.name}** draws a card with **${pendingAbility.sourceCardName}**.`);
            }
        }
        room.pendingAbility = null;
        continueAfterTriggeredAbility(room, roomId);
        return true;
    }

    if (pendingAbility.type !== 'triggeredBuccaneer') return false;
    const sourceBase = room.activeBases[pendingAbility.sourceBaseIndex];
    const minion = sourceBase && getBaseMinions(sourceBase)
        .find(card => card.instanceId === pendingAbility.minionInstanceId);
    if (!sourceBase || !minion) return false;

    if (choice?.choiceId === 'skip') {
        room.pendingAbility = null;
        destroyMinion(
            room,
            sourceBase,
            minion,
            pendingAbility.actorId,
            pendingAbility.sourceCardType,
            false
        );
    } else if (pendingAbility.candidateBaseIndices.includes(choice?.baseIndex)) {
        const destinationBase = room.activeBases[choice.baseIndex];
        sourceBase.playedCards = sourceBase.playedCards
            .filter(card => card.instanceId !== minion.instanceId);
        destinationBase.playedCards.push(minion);
        room.turnState.ongoingAbilityUses[pendingAbility.useKey] = true;
        room.pendingAbility = null;
        addBattleLog(room, `**${minion.name}** moves from **${sourceBase.name}** to **${destinationBase.name}** instead of being destroyed.`);
        recalculateOngoingEffects(room);
    } else {
        return false;
    }

    continueAfterTriggeredAbility(room, roomId);
    return true;
}

function continueAfterTriggeredAbility(room, roomId) {
    if (!processNextTriggeredAbility(room, roomId)) finishAfterTriggeredAbilities(room);
}

function finishAfterTriggeredAbilities(room) {
    if (room.pendingAbility || room.triggerQueue?.length > 0
        || typeof room.afterTriggeredAbilitiesResolved !== 'function') return false;
    const callback = room.afterTriggeredAbilitiesResolved;
    room.afterTriggeredAbilitiesResolved = null;
    callback();
    return true;
}

function emitGameState(roomId, room) {
    recalculateOngoingEffects(room);
    processNextTriggeredAbility(room, roomId);
    io.to(roomId).emit('game-state-update', {
        players: room.players,
        activeBases: room.activeBases,
        spectators: room.spectators || [],
        currentTurnPlayerId: room.currentTurnPlayerId,
        turnState: room.turnState,
        gamePhase: room.gamePhase,
        battleLog: room.battleLog,
        gameResult: room.gameResult || null
    });
    if (room.gamePhase === 'finished') botTurnController.stop(roomId);
    else botTurnController.wake(roomId);
}

function shuffleDeck(deck, random = systemRandom) {
    for (let index = deck.length - 1; index > 0; index--) {
        const randomIndex = Math.floor(random() * (index + 1));
        [deck[index], deck[randomIndex]] = [deck[randomIndex], deck[index]];
    }

    return deck;
}

function replenishBaseDeck(room) {
    if (!room || room.baseDeck?.length > 0 || !room.baseDiscardPile?.length) return false;

    room.baseDeck = room.baseDiscardPile.splice(0);
    shuffleDeck(room.baseDeck, () => nextSeededRandom(room));
    addBattleLog(room, '**The base discard pile** is shuffled to form a new base deck.');
    return true;
}

function drawReplacementBase(room) {
    if (!room.baseDeck) room.baseDeck = [];
    if (!room.baseDiscardPile) room.baseDiscardPile = [];
    replenishBaseDeck(room);
    return room.baseDeck.shift() || null;
}

function generateDraftOrder(players) {
    return [...players, ...[...players].reverse()].map(player => player.id);
}

function sanitizeDraftState(draft) {
    return {
        availableFactions: draft.availableFactions,
        availableFactionEntityIds: draft.availableFactions.map(getFactionEntityId),
        currentPickerId: draft.draftOrder[draft.currentTurnIndex],
        picks: draft.picks,
        pickFactionEntityIds: Object.fromEntries(Object.entries(draft.picks).map(([playerId, factions]) => [
            playerId,
            factions.map(getFactionEntityId)
        ]))
    };
}

function getScoringBases(room) {
    recalculateOngoingEffects(room);
    const scoringIndices = [];
    room.activeBases.forEach((base, index) => {
        let totalPower = 0;
        if (base.playedCards) {
            base.playedCards.forEach(card => {
                if (card.type === 'minion' && typeof card.power === 'number') {
                    totalPower += card.power;
                }
            });
        }

        if (totalPower >= base.breakpoint) {
            scoringIndices.push(index);
        }
    });
    return scoringIndices;
}

// Score base logic (helper function)
function scoreBase(room, baseIndex) {
    recalculateOngoingEffects(room);
    const base = room.activeBases[baseIndex];
    if (!base) return false;

    // 1. Calculate power per player on this base
    const powerPerPlayer = {}; // playerId -> totalPower
    room.players.forEach(p => { powerPerPlayer[p.id] = 0; });

    if (base.playedCards) {
        base.playedCards.forEach(card => {
            if (card.type === 'minion' && typeof card.power === 'number' && powerPerPlayer[card.ownerId] !== undefined) {
                powerPerPlayer[card.ownerId] += card.power;
            }
        });
    }

    // Sort players by power descending
    const rankedPlayers = Object.entries(powerPerPlayer)
        .filter(([id, power]) => power > 0)
        .sort((a, b) => b[1] - a[1]);

    const winnerId = rankedPlayers[0]?.[0] || null;
    const baseWinnerMoveEffect = !baseAbilitiesAreCancelled(base)
        ? getTriggeredEffects(base, 'afterBaseScoring', 'moveMinion')
            .find(effect => effect.target?.owner === 'baseWinner' && effect.target.location === 'thisBase')
        : null;
    const heldWinnerMinions = baseWinnerMoveEffect && winnerId
        ? getBaseMinions(base).filter(minion => minion.ownerId === winnerId)
        : [];
    const specialAfterScoringMinions = getBaseMinions(base).filter(minion => (
        getTriggeredEffects(minion, 'afterBaseScoring').some(effect => (
            effect.target === 'self'
            && (effect.type === 'returnToHand' || effect.type === 'moveMinion')
        ))
    ));
    const heldMinionIds = new Set(
        [...heldWinnerMinions, ...specialAfterScoringMinions].map(minion => minion.instanceId)
    );
    const destinationBaseIds = room.activeBases
        .filter(candidate => candidate !== base)
        .map(candidate => candidate.id);

    const vpAwards = [];

    // Award VP based on base.vp array [1st place, 2nd place, 3rd place].
    rankedPlayers.forEach(([playerId], rank) => {
        if (base.vp[rank] !== undefined) {
            const targetPlayer = room.players.find(p => p.id === playerId);
            if (targetPlayer) {
                const victoryPoints = base.vp[rank];
                targetPlayer.vp += victoryPoints;
                vpAwards.push(formatVictoryPointAward(targetPlayer.name, victoryPoints));
            }
        }
    });

    if (vpAwards.length > 0) {
        if (!room.battleLog) room.battleLog = [];
        room.battleLog.unshift(vpAwards.join(', '));
    }

    // 3. Move all cards played on this base to their owners' discard piles
    if (base.playedCards) {
        // Inside your base scoring / resolution function:
        base.playedCards.forEach(card => {
            const owner = room.players.find(p => p.id === card.ownerId);
            if (owner) {
                if (card.type === 'minion') {
                    if (heldMinionIds.has(card.instanceId)) {
                        holdScoredMinion(room, card);
                        return;
                    }
                    // Send the minion itself to discard
                    discardScoredMinion(room, card);
                } else {
                    // Non-minion cards played on base go to discard
                    owner.discardPile.push(card);
                }
            }
        });
    }

    // 4. Discard the scored base, reshuffling the base discard pile if needed,
    // then immediately replace it so the number of active bases stays constant.
    base.playedCards = [];
    if (!room.baseDiscardPile) room.baseDiscardPile = [];
    room.baseDiscardPile.push(base);
    const newBase = drawReplacementBase(room);
    if (newBase) {
        room.activeBases[baseIndex] = {
            ...newBase,
            playedCards: []
        };
    } else {
        room.activeBases.splice(baseIndex, 1);
    }

    if (!room.triggerQueue) room.triggerQueue = [];
    const triggersByPlayer = new Map(room.players.map(player => [player.id, []]));
    specialAfterScoringMinions.forEach(minion => {
        const playerTriggers = triggersByPlayer.get(minion.ownerId);
        if (!playerTriggers) return;
        const effects = getTriggeredEffects(minion, 'afterBaseScoring');
        if (effects.some(effect => effect.type === 'returnToHand' && effect.target === 'self')) {
            playerTriggers.push({
                type: 'afterScoreScout',
                playerId: minion.ownerId,
                minionInstanceId: minion.instanceId,
                sourceBaseName: base.name
            });
        }
        if (effects.some(effect => effect.type === 'moveMinion' && effect.target === 'self')) {
            playerTriggers.push({
                type: 'afterScoreFirstMate',
                playerId: minion.ownerId,
                minionInstanceId: minion.instanceId,
                destinationBaseIds,
                sourceBaseName: base.name
            });
        }
    });
    if (heldWinnerMinions.length > 0) {
        triggersByPlayer.get(winnerId)?.push({
            type: 'baseWinnerMoveAfterScoring',
            playerId: winnerId,
            candidateMinions: heldWinnerMinions,
            destinationBaseIds,
            sourceBaseName: base.name
        });
    }
    getPlayersInTurnOrder(room).forEach(player => {
        room.triggerQueue.push(...(triggersByPlayer.get(player.id) || []));
    });
    return true;
}

function holdScoredMinion(room, minion) {
    if (!room.scoringHeldMinions) room.scoringHeldMinions = [];
    if (!room.scoringHeldMinions.some(card => card.instanceId === minion.instanceId)) {
        room.scoringHeldMinions.push(minion);
    }
}

function getHeldScoredMinion(room, instanceId) {
    return (room.scoringHeldMinions || []).find(minion => minion.instanceId === instanceId);
}

function releaseHeldScoredMinion(room, instanceId) {
    const index = (room.scoringHeldMinions || []).findIndex(minion => minion.instanceId === instanceId);
    if (index < 0) return null;
    return room.scoringHeldMinions.splice(index, 1)[0];
}

function discardHeldScoredMinion(room, instanceId) {
    const minion = releaseHeldScoredMinion(room, instanceId);
    if (minion) discardScoredMinion(room, minion);
    return minion;
}

function returnHeldScoredMinionToHand(room, instanceId) {
    const minion = releaseHeldScoredMinion(room, instanceId);
    const owner = room.players.find(player => player.id === minion?.ownerId);
    if (!minion || !owner) return false;
    (minion.attachedCards || []).forEach(attached => {
        const attachedOwner = room.players.find(player => player.id === attached.ownerId) || owner;
        attachedOwner.discardPile.push(attached);
    });
    minion.attachedCards = [];
    removeTemporaryPowerEffectsForCard(room, minion.instanceId);
    minion.power = getPrintedCardPower(minion);
    owner.hand.push(minion);
    return true;
}

function discardScoredMinion(room, minion) {
    const owner = room.players.find(player => player.id === minion.ownerId);
    if (!owner) return;
    owner.discardPile.push(minion);
    (minion.attachedCards || []).forEach(attached => {
        const attachedOwner = room.players.find(player => player.id === attached.ownerId) || owner;
        attachedOwner.discardPile.push(attached);
    });
    minion.attachedCards = [];
    removeTemporaryPowerEffectsForCard(room, minion.instanceId);
    minion.power = getPrintedCardPower(minion);
}

function formatVictoryPointAward(playerName, victoryPoints) {
    const pointLabel = victoryPoints === 1 ? 'victory point' : 'victory points';
    return `**${playerName}** gets **${victoryPoints} ${pointLabel}**`;
}

// Fully Purge Player on Kick (Helper Function)
function handlePlayerKick(roomId, playerId) {
    const room = rooms[roomId];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== playerId);
    delete disconnectTimers[playerId];

    if (!roomHasHumanPlayers(room)) {
        io.to(roomId).emit('room-reset', { message: 'All human players have left. The room has been closed.' });
        destroyRoom(roomId);
    } else {
        if (room.host === playerId) {
            room.host = getNextHumanHostId(room) || room.players[0].id;
        }
        io.to(roomId).emit('update-players', {
            players: room.players,
            spectators: room.spectators || [],
            host: room.host
        });
    }
}

if (require.main === module) {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
    });

    const shutDown = () => {
        console.log('Server shutting down');

        io.emit('server-restarting');

        io.close(() => {
            process.exit(0);
        });

        setTimeout(() => {
            process.exit(1);
        }, 25_000).unref();
    };

    process.once('SIGTERM', shutDown);
    process.once('SIGINT', shutDown);
}

module.exports = {
    BOT_POLICY_VERSIONS,
    DEFAULT_BOT_POLICY_VERSION,
    MAX_HAND_SIZE,
    MAX_PLAYERS,
    activateTalent,
    addLobbyBot,
    addLobbyParticipant,
    appendChatMessage,
    baseAbilitiesAreCancelled,
    clearTemporaryEffects,
    chooseDefaultBotAction,
    chooseDefaultBotActionIndex,
    chooseConfiguredBotActionIndex,
    chooseGreedyHeuristic1ActionIndex,
    chooseGreedyHeuristic2ActionIndex,
    createBotTurnController,
    createInitialTurnState,
    executeDraftFactionAction,
    executeEndTurnAction,
    executeGameAction,
    executePlayCardAction,
    executeResolveAbilityChoiceAction,
    executeUseTalentAction,
    exportRoomTrajectoryJson,
    finishGameIfNeeded,
    finalizeRoomTrajectory,
    getCompletedGameResult,
    getLegalActions,
    getBotDecisionActorId,
    getPlayerObservation,
    getRoomTrajectory,
    getOngoingDiscardPlayBaseIndices,
    isMinionPlayPrevented,
    isMinionProtectedFromCard,
    isMovementPrevented,
    playerIgnoresBaseAbility,
    processNextTriggeredAbility,
    queueAfterMinionPlayedBaseAbilities,
    queueBeforeBaseScoringSpecials,
    queueRevealedDeckSelection,
    queueSelectedPlayerBoardEffect,
    recordTrajectoryDecision,
    recalculateOngoingEffects,
    resolveEndTurnActions,
    resolveDeckReorder,
    removeLobbyBot,
    resolveMultiZoneSelection,
    resolveSelectedPlayerBoardEffect,
    resolveSelectedPlayerBoardEffectBase,
    resolveStartTurnActions,
    resolveTriggeredAbilityChoice,
    roomHasHumanPlayers,
    scoreBase,
    validateDraftFactionAction,
    validateEndTurnAction,
    validatePlayCardAction,
    validateResolveAbilityChoiceAction,
    validateTalentActivation,
    validateUseTalentAction
};
