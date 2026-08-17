const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { buildBaseDeck } = require('./bases.js');
const { factionsData, buildFactionDeck } = require('./factions.js');

const PORT = 3000;
const SOCKET_CORS_OPTIONS = { origin: '*' };
const INITIAL_TURN_STATE = { actionPlayed: false, minionPlayed: false };

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: SOCKET_CORS_OPTIONS
});

// Store active rooms in memory
const rooms = {};
// Keep track of active disconnection timers: playerId -> NodeJS.Timeout
const disconnectTimers = {};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('create-room', ({ playerName }) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomId] = {
            host: socket.id,
            players: [{ id: socket.id, name: playerName, hand: [], deck: [], discardPile: [], online: true }],
            gamePhase: 'lobby'
        };

        socket.join(roomId);
        socket.emit('room-created', { roomId, players: rooms[roomId].players, host: rooms[roomId].host });
    });
    socket.on('join-room', ({ roomId, playerName }) => {
        const formattedRoomId = roomId.trim().toUpperCase();
        const room = rooms[formattedRoomId];

        if (room) {
            const exactName = playerName.trim();

            // 1. Check if an existing ACTIVE or OFFLINE player is reconnecting with the exact same name
            const existingPlayer = room.players.find(p => p.name === exactName);

            if (room.gamePhase && room.gamePhase !== 'lobby' && existingPlayer) {
                // Clear any active kick timer since they returned!
                if (disconnectTimers[existingPlayer.id]) {
                    clearTimeout(disconnectTimers[existingPlayer.id]);
                    delete disconnectTimers[existingPlayer.id];
                }

                existingPlayer.id = socket.id;
                existingPlayer.online = true;
                socket.join(formattedRoomId);

                if (room.gamePhase === 'drafting') {
                    socket.emit('draft-started', { draftState: sanitizeDraftState(room.draftState), players: room.players, spectators: room.spectators || [] });
                } else {
                    socket.emit('game-started', { players: room.players, activeBases: room.activeBases, spectators: room.spectators || [], gamePhase: room.gamePhase });
                }

                io.to(formattedRoomId).emit('update-players', { players: room.players, spectators: room.spectators || [], host: room.host });
                return;
            }

            // 2. If the game has already started and they are NOT an active player -> Spectator
            if (room.gamePhase && room.gamePhase !== 'lobby') {
                socket.join(formattedRoomId);

                if (!room.spectators) room.spectators = [];
                room.spectators.push({ id: socket.id, name: exactName });

                socket.emit('spectate-started', {
                    roomId: formattedRoomId,
                    players: room.players,
                    activeBases: room.activeBases,
                    spectators: room.spectators
                });

                io.to(formattedRoomId).emit('update-players', { players: room.players, spectators: room.spectators, host: socket.id });
                return;
            }

            // 3. Standard Lobby Join (Game hasn't started yet)
            socket.join(formattedRoomId);
            const newPlayer = { id: socket.id, name: exactName, hand: [], deck: [], discardPile: [], online: true };
            room.players.push(newPlayer);

            socket.emit('room-joined', { roomId: formattedRoomId, players: room.players, spectators: room.spectators || [], host: room.host });
            io.to(formattedRoomId).emit('update-players', { players: room.players, spectators: room.spectators || [], host: room.host });

        } else {
            socket.emit('error', 'Room not found! Check your code.');
        }
    });
    socket.on('play-card', ({ roomId, cardInstanceId, baseIndex, targetMinionInstanceId }) => {
        const room = rooms[roomId];
        if (!room || room.gamePhase !== 'playing') return;

        if (room.currentTurnPlayerId !== socket.id) {
            return socket.emit('error', "It's not your turn!");
        }

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const cardIndex = player.hand.findIndex(c => c.instanceId === cardInstanceId);
        if (cardIndex === -1) return socket.emit('error', 'Card not found in your hand!');

        const card = player.hand[cardIndex];

        // 🛑 TURN LIMIT VALIDATION (Enforce 1 Minion & 1 Action per turn)
        if (card.type === 'minion') {
            if (room.turnState.minionPlayed) {
                return socket.emit('error', 'You have already played a minion this turn!');
            }
        } else if (card.type === 'action') {
            if (room.turnState.actionPlayed) {
                return socket.emit('error', 'You have already played an action this turn!');
            }
        }

        // HANDLING SUBTYPES & TARGET VALIDATION
        let targetMinion = null;
        let targetBase = null;

        if (card.subtype === 'base') {
            if (baseIndex === null || baseIndex === undefined || !room.activeBases[baseIndex]) {
                return socket.emit('error', 'Target base does not exist');
            }
        } else if (card.subtype === 'ally-minion' || card.subtype === 'enemy-minion' || card.subtype === 'neutral-minion') {
            if (baseIndex !== null && baseIndex !== undefined && room.activeBases[baseIndex]) {
                targetBase = room.activeBases[baseIndex];
                targetMinion = (targetBase.playedCards || []).find(c => c.type === 'minion' && c.instanceId === targetMinionInstanceId);
            } else {
                for (const b of room.activeBases) {
                    const found = (b.playedCards || []).find(c => c.type === 'minion' && c.instanceId === targetMinionInstanceId);
                    if (found) {
                        targetMinion = found;
                        targetBase = b;
                        break;
                    }
                }
            }

            if (!targetMinion) {
                return socket.emit('error', 'Target minion does not exist');
            }

            const isAlly = targetMinion.ownerId === socket.id;
            if (card.subtype === 'ally-minion' && !isAlly) {
                return socket.emit('error', 'Target must be your own minion');
            }
            if (card.subtype === 'enemy-minion' && isAlly) {
                return socket.emit('error', 'Target must be an enemy minion');
            }
        }

        // Remove card from hand now that validation passed
        player.hand.splice(cardIndex, 1);
        const playedCard = { ...card, ownerName: player.name, ownerId: player.id };

        // Route card based on discard flag and subtype destination & Build Battle Log Entry
        let logMessage = '';
        let targetName = null;

        if (card.discard === 'yes' && card.subtype === 'neither') {
            // Standard action with no target that discards immediately
            if (!player.discardPile) player.discardPile = [];
            player.discardPile.push(playedCard);
            logMessage = `**${player.name}** plays **${card.name}**`;
        } else {
            // Cards that target a base or minion (whether permanent or delayed-discard)
            if (card.subtype === 'base') {
                const base = room.activeBases[baseIndex];
                if (!base.playedCards) base.playedCards = [];
                base.playedCards.push(playedCard);
                targetName = base.name;
                logMessage = `**${player.name}** plays **${card.name}** on **${base.name}**`;
            } else if (card.subtype === 'ally-minion' || card.subtype === 'enemy-minion' || card.subtype === 'neutral-minion') {
                if (!targetMinion.attachedCards) {
                    targetMinion.attachedCards = [];
                }
                targetMinion.attachedCards.push(playedCard);
                targetName = targetMinion.name;
                logMessage = `**${player.name}** plays **${card.name}** on **${targetMinion ? targetMinion.name : 'Target Minion'}**`;
            } else {
                // Fallback for any other 'yes' discard action
                if (!player.discardPile) player.discardPile = [];
                player.discardPile.push(playedCard);
                logMessage = `**${player.name}** plays **${card.name}**`;
            }
        }

        // 🔒 UPDATE TURN STATE FLAGS (Mark minion or action as used)
        if (card.type === 'minion') {
            room.turnState.minionPlayed = true;
        } else if (card.type === 'action') {
            room.turnState.actionPlayed = true;
        }

        // Initialize battleLog if missing and push new entry
        if (!room.battleLog) room.battleLog = [];
        room.battleLog.unshift({
            message: logMessage,
            card: playedCard,
            playerName: player.name,
            targetName,
            targetCard: targetMinion
        }); // Newest entries at the top

        // Broadcast updated game state
        io.to(roomId).emit('game-state-update', {
            players: room.players,
            activeBases: room.activeBases,
            currentTurnPlayerId: room.currentTurnPlayerId,
            turnState: room.turnState,
            gamePhase: room.gamePhase,
            battleLog: room.battleLog
        });
    });

    socket.on('end-turn', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.gamePhase !== 'playing') return;

        if (room.currentTurnPlayerId !== socket.id) {
            return socket.emit('error', "It's not your turn!");
        }

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // 🧹 SHARED CLEANUP FUNCTION: Move temporary/delayed-discard action cards from bases/minions to discard piles
        const cleanupDelayedDiscardCards = () => {
            room.activeBases.forEach(base => {
                if (base.playedCards) {
                    // Filter out base-action cards that have discard === 'yes'
                    base.playedCards = base.playedCards.filter(card => {
                        if (card.type === 'action' && card.discard === 'yes') {
                            const owner = room.players.find(p => p.id === card.ownerId);
                            if (owner) {
                                if (!owner.discardPile) owner.discardPile = [];
                                owner.discardPile.push(card);
                            }
                            return false; // Remove from base
                        }
                        return true; // Keep on base
                    });

                    // Also check attached cards on minions at this base
                    base.playedCards.forEach(card => {
                        if (card.type === 'minion' && card.attachedCards) {
                            card.attachedCards = card.attachedCards.filter(attached => {
                                if (attached.type === 'action' && attached.discard === 'yes') {
                                    const owner = room.players.find(p => p.id === attached.ownerId);
                                    if (owner) {
                                        if (!owner.discardPile) owner.discardPile = [];
                                        owner.discardPile.push(attached);
                                    }
                                    return false; // Remove from minion attachment
                                }
                                return true; // Keep attached
                            });
                        }
                    });
                }
            });
        };

        // 1. Check for bases ready to score
        const scoringBases = getScoringBases(room);

        if (scoringBases.length > 0) {
            if (!room.battleLog) room.battleLog = [];
            scoringBases.forEach(baseIndex => {
                const base = room.activeBases[baseIndex];
                room.battleLog.unshift(`**${base.name}** is scoring!`);
            });

            const activePlayer = room.players.find(p => p.id === room.currentTurnPlayerId);
            if (activePlayer) {
                room.battleLog.unshift(`**${activePlayer.name}** has ended their turn`);
            }

            room.gamePhase = 'scoring';

            io.to(roomId).emit('game-state-update', {
                players: room.players,
                activeBases: room.activeBases,
                currentTurnPlayerId: room.currentTurnPlayerId,
                turnState: room.turnState,
                gamePhase: room.gamePhase,
                scoringBases,
                battleLog: room.battleLog
            });

            // 5-Second Timer before resolving base scoring and passing turn
            setTimeout(() => {
                // Ensure room still exists
                if (!rooms[roomId]) return;

                // Resolve scoring for the eligible bases
                scoringBases.forEach(baseIndex => {
                    scoreBase(room, baseIndex);
                });

                // Draw 2 cards at end of turn (if deck has cards available)
                for (let i = 0; i < 2; i++) {
                    if (player.deck.length > 0) {
                        player.hand.push(player.deck.shift());
                    }
                }

                const currentPlayerIndex = room.players.findIndex(p => p.id === socket.id);
                // 🧹 Run cleanup sweep here too!
                cleanupDelayedDiscardCards();

                // Rotate turn to the next player
                const nextPlayerIndex = (currentPlayerIndex + 1) % room.players.length;
                room.currentTurnPlayerId = room.players[nextPlayerIndex].id;

                // Reset turn play flags for the next player
                room.turnState = {
                    actionPlayed: false,
                    minionPlayed: false
                };

                // Return phase to playing and update all clients
                room.gamePhase = 'playing';
                const nextPlayer = room.players.find(p => p.id === room.currentTurnPlayerId);

                // 🏆 ADD TURN START LOG ENTRY
                if (nextPlayer) {
                    if (!room.battleLog) room.battleLog = [];
                    room.battleLog.unshift(`**${nextPlayer.name}**'s turn`);
                }

                io.to(roomId).emit('game-state-update', {
                    players: room.players,
                    activeBases: room.activeBases,
                    currentTurnPlayerId: room.currentTurnPlayerId,
                    turnState: room.turnState,
                    gamePhase: room.gamePhase,
                    battleLog: room.battleLog
                });
            }, 5000); // 5 seconds delay

        } else {
            // If no bases are scoring, proceed normally right away
            for (let i = 0; i < 2; i++) {
                if (player.deck.length > 0) {
                    player.hand.push(player.deck.shift());
                }
            }

            const currentPlayerIndex = room.players.findIndex(p => p.id === socket.id);
            const activePlayer = room.players.find(p => p.id === room.currentTurnPlayerId);

            // 🏆 END TURN LOG ENTRY
            if (activePlayer) {
                if (!room.battleLog) room.battleLog = [];
                room.battleLog.unshift(`**${activePlayer.name}** has ended their turn`);
            }

            // 🧹 Run cleanup sweep for normal turns where no base scored!
            cleanupDelayedDiscardCards();

            // rotate to the next player 
            const nextPlayerIndex = (currentPlayerIndex + 1) % room.players.length;
            room.currentTurnPlayerId = room.players[nextPlayerIndex].id;

            room.turnState = {
                actionPlayed: false,
                minionPlayed: false
            };

            // Return phase to playing and update all clients
            room.gamePhase = 'playing';
            const nextPlayer = room.players.find(p => p.id === room.currentTurnPlayerId);

            // 🏆 ADD TURN START LOG ENTRY
            if (nextPlayer) {
                if (!room.battleLog) room.battleLog = [];
                room.battleLog.unshift(`**${nextPlayer.name}**'s turn`);
            }

            io.to(roomId).emit('game-state-update', {
                players: room.players,
                activeBases: room.activeBases,
                currentTurnPlayerId: room.currentTurnPlayerId,
                turnState: room.turnState,
                gamePhase: room.gamePhase,
                battleLog: room.battleLog
            });
        }
    });

    socket.on('leave-room', ({ roomId }) => {
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];

            if (room.gamePhase === 'lobby') {
                room.players = room.players.filter(p => p.id !== socket.id);
                socket.leave(roomId);

                if (room.players.length === 0) {
                    delete rooms[roomId];
                } else {
                    if (room.host === socket.id) {
                        room.host = room.players[0].id;
                    }
                    io.to(roomId).emit('update-players', { players: room.players, spectators: room.spectators || [], host: room.host });
                }
            } else if (room.gamePhase === 'drafting') {
                io.to(roomId).emit('room-reset', { message: 'A player left during the faction draft. The room has been closed.' });
                delete rooms[roomId];
            } else if (room.gamePhase === 'playing' || room.gamePhase === 'scoring') {
                const player = room.players.find(p => p.id === socket.id);
                if (player) {
                    player.online = false;
                    disconnectTimers[player.id] = setTimeout(() => {
                        handlePlayerKick(roomId, player.id);
                    }, 3000);
                }

                if (room.spectators) {
                    room.spectators = room.spectators.filter(s => s.id !== socket.id);
                }

                socket.leave(roomId);
                io.to(roomId).emit('update-players', { players: room.players, spectators: room.spectators || [] });
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
                    if (room.players.length === 0) {
                        delete rooms[roomId];
                    } else {
                        if (room.host === socket.id) {
                            room.host = room.players[0].id;
                        }
                        io.to(roomId).emit('update-players', { players: room.players, spectators: room.spectators || [], host: room.host });
                    }
                } else if (room.gamePhase === 'drafting') {
                    io.to(roomId).emit('room-reset', { message: 'A player disconnected during the faction draft. The room has been closed.' });
                    delete rooms[roomId];
                } else if (room.gamePhase === 'playing' || room.gamePhase === 'scoring') {
                    player.online = false;
                    io.to(roomId).emit('update-players', { players: room.players, spectators: room.spectators || [], host: room.host });

                    disconnectTimers[player.id] = setTimeout(() => {
                        handlePlayerKick(roomId, player.id);
                    }, 3000);
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

            room.gamePhase = 'drafting';

            io.to(roomId).emit('draft-started', {
                draftState: sanitizeDraftState(room.draftState),
                players: room.players
            });
        } else {
            socket.emit('error', 'Only the host can start the game!');
        }
    });

    socket.on('draft-faction', ({ roomId, factionName }) => {
        const room = rooms[roomId];
        if (!room || room.gamePhase !== 'drafting') return;

        const draft = room.draftState;
        const currentPickerId = draft.draftOrder[draft.currentTurnIndex];

        if (socket.id !== currentPickerId) {
            return socket.emit('error', 'It is not your turn to draft!');
        }

        if (!draft.availableFactions.includes(factionName)) {
            return socket.emit('error', 'That faction is already taken!');
        }

        draft.availableFactions = draft.availableFactions.filter(f => f !== factionName);
        draft.picks[socket.id].push(factionName);
        draft.currentTurnIndex++;

        if (draft.currentTurnIndex >= draft.draftOrder.length) {
            room.gamePhase = 'playing';

            // Build and shuffle base deck, then draw 3 active bases
            const baseDeck = buildBaseDeck();
            room.activeBases = baseDeck.splice(0, 3).map(base => ({
                ...base,
                playedCards: []
            }));
            room.baseDeck = baseDeck;

            room.players.forEach(player => {
                const playerFactions = draft.picks[player.id] || ['Aliens', 'Dinosaurs'];
                const deck1 = buildFactionDeck(playerFactions[0]);
                const deck2 = buildFactionDeck(playerFactions[1]);

                const combinedDeck = [...deck1, ...deck2];
                shuffleDeck(combinedDeck);

                player.factions = playerFactions;
                player.hand = combinedDeck.splice(0, 5);
                player.deck = combinedDeck;
                player.discardPile = [];
                player.vp = 0;
            });

            const firstPlayer = room.players[0];
            room.currentTurnPlayerId = firstPlayer.id;
            room.turnState = { ...INITIAL_TURN_STATE };

            // Add turn start log entry for the first player
            if (!room.battleLog) room.battleLog = [];
            room.battleLog.unshift(`**${firstPlayer.name}**'s turn`);

            io.to(roomId).emit('game-started', {
                players: room.players,
                activeBases: room.activeBases,
                currentTurnPlayerId: room.currentTurnPlayerId,
                turnState: room.turnState,
                gamePhase: room.gamePhase,
                battleLog: room.battleLog
            });

        } else {
            io.to(roomId).emit('draft-update', { draftState: sanitizeDraftState(draft) });
        }
    });
});

function shuffleDeck(deck) {
    for (let index = deck.length - 1; index > 0; index--) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [deck[index], deck[randomIndex]] = [deck[randomIndex], deck[index]];
    }

    return deck;
}

function generateDraftOrder(players) {
    return [...players, ...[...players].reverse()].map(player => player.id);
}

function sanitizeDraftState(draft) {
    return {
        availableFactions: draft.availableFactions,
        currentPickerId: draft.draftOrder[draft.currentTurnIndex],
        picks: draft.picks
    };
}

function getScoringBases(room) {
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
    const base = room.activeBases[baseIndex];

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
                    // Send the minion itself to discard
                    owner.discardPile.push(card);

                    // Send any cards attached to this minion to discard as well!
                    if (card.attachedCards && card.attachedCards.length > 0) {
                        card.attachedCards.forEach(attached => {
                            const attachedOwner = room.players.find(p => p.id === attached.ownerId) || owner;
                            attachedOwner.discardPile.push(attached);
                        });
                    }
                } else {
                    // Non-minion cards played on base go to discard
                    owner.discardPile.push(card);
                }
            }
        });
    }

    // 4. Replace scored base with a new one from the base deck (if available)
    if (room.baseDeck && room.baseDeck.length > 0) {
        const newBase = room.baseDeck.shift();
        room.activeBases[baseIndex] = {
            ...newBase,
            playedCards: []
        };
    } else {
        room.activeBases.splice(baseIndex, 1);
    }
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

    if (room.players.length === 0) {
        delete rooms[roomId];
    } else {
        if (room.host === playerId) {
            room.host = room.players[0].id;
        }
        io.to(roomId).emit('update-players', { players: room.players, spectators: room.spectators || [] });
    }
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
