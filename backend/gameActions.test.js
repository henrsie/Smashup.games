const test = require('node:test');
const assert = require('node:assert/strict');
const { factionsData } = require('./factions.js');
const { CHOICE_TYPE_IDS } = require('./gameEntityIds.js');
const { initializeSeededRandom, nextSeededRandom } = require('./random.js');
const {
    MAX_HAND_SIZE,
    chooseDefaultBotAction,
    chooseDefaultBotActionIndex,
    createBotTurnController,
    createInitialTurnState,
    executeDraftFactionAction,
    executeGameAction,
    exportRoomTrajectoryJson,
    finishGameIfNeeded,
    finalizeRoomTrajectory,
    getBotDecisionActorId,
    getCompletedGameResult,
    getLegalActionEncodingKey,
    getLegalActions,
    getPlayerObservation,
    getRoomTrajectory,
    recordStructuredEvent,
    recordTrajectoryDecision,
    scoreBase,
    validatePlayCardAction
} = require('./server.js');

const cardTemplates = Object.values(factionsData).flatMap(faction => faction.cards);

function createCard(cardId, ownerId, instanceId = `${cardId}-instance`) {
    const template = cardTemplates.find(card => card.id === cardId);
    return {
        ...template,
        cardId: template.id,
        instanceId,
        ownerId,
        ownerName: ownerId,
        printedPower: template.power,
        attachedCards: []
    };
}

function createRoom(actorId = 'bot-1') {
    const room = {
        activeBases: [
            {
                id: 'test-base',
                name: 'Test Base',
                breakpoint: 20,
                vp: [3, 2, 1],
                abilities: [],
                playedCards: []
            }
        ],
        baseDeck: [],
        baseDiscardPile: [],
        battleLog: [],
        currentTurnPlayerId: actorId,
        gamePhase: 'playing',
        pendingAbility: null,
        players: [
            {
                id: actorId,
                name: 'Bot One',
                hand: [],
                deck: [],
                discardPile: [],
                vp: 0
            },
            {
                id: 'human-1',
                name: 'Human One',
                hand: [],
                deck: [],
                discardPile: [],
                vp: 0
            }
        ],
        temporaryEffects: [],
        triggerQueue: [],
        turnState: createInitialTurnState()
    };
    initializeSeededRandom(room, 123456);
    return room;
}

function createScheduledBotController(room) {
    const scheduledCallbacks = [];
    const controller = createBotTurnController({
        getRoom: roomId => roomId === 'ROOM1' ? room : null,
        executeAction: ({ room: currentRoom, roomId, actorId, action }) => executeGameAction({
            room: currentRoom,
            roomId,
            actorId,
            action
        }),
        schedule: callback => {
            scheduledCallbacks.push(callback);
            return callback;
        },
        clearSchedule: callback => {
            const index = scheduledCallbacks.indexOf(callback);
            if (index >= 0) scheduledCallbacks.splice(index, 1);
        }
    });

    return { controller, scheduledCallbacks };
}

test('a bot-style caller plays a card through the shared game action dispatcher', () => {
    const room = createRoom();
    const kingRex = createCard('dino_king_1', 'bot-1');
    room.players[0].hand.push(kingRex);
    let emittedState = false;

    const result = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: {
            type: 'play-card',
            cardInstanceId: kingRex.instanceId,
            baseIndex: 0
        },
        emitState: () => { emittedState = true; }
    });

    assert.equal(result.ok, true);
    assert.equal(result.playedCard.instanceId, kingRex.instanceId);
    assert.equal(room.players[0].hand.length, 0);
    assert.equal(room.activeBases[0].playedCards[0].instanceId, kingRex.instanceId);
    assert.equal(room.activeBases[0].playedCards[0].ownerId, 'bot-1');
    assert.equal(room.turnState.minionPlayed, true);
    assert.equal(room.turnState.minionsPlayed, 1);
    assert.equal(emittedState, true);
});

test('shared card validation rejects an out-of-turn actor without mutating the room', () => {
    const room = createRoom('human-1');
    const kingRex = createCard('dino_king_1', 'bot-1');
    room.players[0].hand.push(kingRex);

    const validation = validatePlayCardAction(room, 'bot-1', {
        type: 'play-card',
        cardInstanceId: kingRex.instanceId,
        baseIndex: 0
    });
    const result = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: {
            type: 'play-card',
            cardInstanceId: kingRex.instanceId,
            baseIndex: 0
        }
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.code, 'not_your_turn');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_your_turn');
    assert.equal(room.players[0].hand.length, 1);
    assert.equal(room.activeBases[0].playedCards.length, 0);
});

test('shared card validation blocks a second normal minion play', () => {
    const room = createRoom();
    const kingRex = createCard('dino_king_1', 'bot-1');
    room.players[0].hand.push(kingRex);
    room.turnState.minionPlayed = true;

    const result = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: {
            type: 'play-card',
            cardInstanceId: kingRex.instanceId,
            baseIndex: 0
        }
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'minion_limit_reached');
    assert.equal(room.players[0].hand.length, 1);
    assert.equal(room.activeBases[0].playedCards.length, 0);
});

test('a bot-style actor receives on-play choice events without a Socket.IO socket', () => {
    const room = createRoom();
    const laseratops = createCard('dino_bro_1', 'bot-1');
    const target = createCard('robot_zapbot_1', 'human-1', 'target-minion');
    room.players[0].hand.push(laseratops);
    room.activeBases[0].playedCards.push(target);

    const result = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: {
            type: 'play-card',
            cardInstanceId: laseratops.instanceId,
            baseIndex: 0
        }
    });

    assert.equal(result.ok, true);
    assert.equal(result.pendingAbility?.playerId, 'bot-1');
    assert.equal(result.actorEvents.length, 1);
    assert.equal(result.actorEvents[0].event, 'ability-choice-required');
    assert.equal(result.actorEvents[0].payload.choices[0].minionInstanceId, target.instanceId);
});

test('a bot-style actor resolves its on-play choice through the shared dispatcher', () => {
    const room = createRoom();
    const laseratops = createCard('dino_bro_1', 'bot-1');
    const target = createCard('robot_zapbot_1', 'human-1', 'target-minion');
    room.players[0].hand.push(laseratops);
    room.activeBases[0].playedCards.push(target);

    const playResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: {
            type: 'play-card',
            cardInstanceId: laseratops.instanceId,
            baseIndex: 0
        }
    });
    const targetChoice = playResult.actorEvents[0].payload.choices.find(choice => (
        choice.minionInstanceId === target.instanceId
    ));
    let emittedState = false;

    const choiceResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: {
            type: 'resolve-ability-choice',
            choice: targetChoice
        },
        emitState: () => { emittedState = true; }
    });

    assert.equal(choiceResult.ok, true);
    assert.equal(choiceResult.pendingAbility, null);
    assert.equal(room.activeBases[0].playedCards.some(card => card.instanceId === target.instanceId), false);
    assert.equal(room.players[1].discardPile[0].instanceId, target.instanceId);
    assert.equal(emittedState, true);
});

test('ability choices can only be resolved by the player who controls them', () => {
    const room = createRoom();
    room.pendingAbility = {
        type: 'confirmation',
        playerId: 'bot-1',
        effect: { type: 'gainVictoryPoints', target: 'controller', amount: 1 }
    };

    const result = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'human-1',
        action: {
            type: 'resolve-ability-choice',
            choice: { choiceId: 'skip' }
        }
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_ability_controller');
    assert.equal(room.pendingAbility.playerId, 'bot-1');
});

test('triggered ability follow-up choices are returned to a bot-style actor', () => {
    const room = createRoom();
    const hiddenNinja = createCard('ninja_hidden_ninja_1', 'bot-1');
    const kingRex = createCard('dino_king_1', 'bot-1');
    room.players[0].hand.push(hiddenNinja, kingRex);
    room.pendingAbility = {
        type: 'triggeredBeforeScoreHiddenNinja',
        playerId: 'bot-1',
        cardInstanceId: hiddenNinja.instanceId,
        scoringBaseId: 'test-base',
        scoringBaseName: 'Test Base'
    };

    const acceptResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: {
            type: 'resolve-ability-choice',
            choice: { choiceId: 'accept' }
        }
    });

    assert.equal(acceptResult.ok, true);
    assert.equal(acceptResult.pendingAbility.type, 'triggeredBeforeScoreHiddenNinjaMinion');
    assert.equal(acceptResult.actorEvents[0].event, 'ability-choice-required');
    assert.equal(acceptResult.actorEvents[0].payload.choices[0].cardInstanceId, kingRex.instanceId);

    const minionResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: {
            type: 'resolve-ability-choice',
            choice: { cardInstanceId: kingRex.instanceId }
        }
    });

    assert.equal(minionResult.ok, true);
    assert.equal(room.pendingAbility, null);
    assert.equal(room.players[0].discardPile[0].instanceId, hiddenNinja.instanceId);
    assert.equal(room.activeBases[0].playedCards[0].instanceId, kingRex.instanceId);
});

test('a bot-style actor uses a Talent through the shared dispatcher', () => {
    const room = createRoom();
    const acolyte = createCard('ninja_acolyte_1', 'bot-1');
    room.activeBases[0].playedCards.push(acolyte);
    let emittedState = false;

    const result = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: {
            type: 'use-talent',
            cardInstanceId: acolyte.instanceId
        },
        emitState: () => { emittedState = true; }
    });

    assert.equal(result.ok, true);
    assert.equal(room.activeBases[0].playedCards.length, 0);
    assert.equal(room.players[0].hand[0].instanceId, acolyte.instanceId);
    assert.equal(room.turnState.extraMinionPlays.length, 1);
    assert.equal(room.turnState.extraMinionPlays[0].required, true);
    assert.equal(emittedState, true);
});

test('a bot-style actor ends a normal turn through the shared dispatcher', () => {
    const room = createRoom();
    room.players[0].deck.push(
        createCard('dino_king_1', 'bot-1', 'draw-1'),
        createCard('dino_armor_1', 'bot-1', 'draw-2')
    );
    let stateEmissions = 0;

    const result = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: { type: 'end-turn' },
        emitState: () => { stateEmissions += 1; }
    });

    assert.equal(result.ok, true);
    assert.equal(result.turnCompleted, true);
    assert.equal(result.nextPlayerId, 'human-1');
    assert.equal(room.players[0].hand.length, 2);
    assert.equal(room.players[0].deck.length, 0);
    assert.equal(room.currentTurnPlayerId, 'human-1');
    assert.equal(room.battleLog[0], "**Human One**'s turn");
    assert.equal(room.battleLog[1], '**Bot One** has ended their turn');
    assert.equal(stateEmissions, 1);
});

test('end-turn draws recycle an empty deck from the discard pile', () => {
    const room = createRoom();
    const bot = room.players[0];
    bot.discardPile.push(
        createCard('dino_king_1', 'bot-1', 'recycled-1'),
        createCard('dino_armor_1', 'bot-1', 'recycled-2')
    );

    const result = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: { type: 'end-turn' }
    });

    assert.equal(result.ok, true);
    assert.equal(bot.deck.length, 0);
    assert.equal(bot.discardPile.length, 0);
    assert.deepEqual(
        new Set(bot.hand.map(card => card.instanceId)),
        new Set(['recycled-1', 'recycled-2'])
    );
    assert.ok(room.battleLog.some(entry => (
        entry === '**Bot One** shuffles their discard pile to form a new deck.'
    )));
});

test('a bot must discard down to the ten-card hand limit before the next turn', () => {
    const room = createRoom();
    const bot = room.players[0];
    bot.isBot = true;
    bot.hand = Array.from({ length: MAX_HAND_SIZE }, (_, index) => (
        createCard('dino_king_1', 'bot-1', `hand-${index}`)
    ));
    bot.deck = [
        createCard('dino_armor_1', 'bot-1', 'draw-1'),
        createCard('dino_bro_1', 'bot-1', 'draw-2')
    ];

    const endTurnResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: { type: 'end-turn' }
    });

    assert.equal(endTurnResult.ok, true);
    assert.equal(endTurnResult.turnCompleted, false);
    assert.equal(room.currentTurnPlayerId, 'bot-1');
    assert.equal(room.pendingAbility.type, 'handLimitDiscard');
    assert.equal(room.pendingAbility.cardsRemaining, 2);
    assert.equal(bot.hand.length, 12);
    assert.equal(getLegalActions(room, 'bot-1').length, 12);

    const firstDiscard = getLegalActions(room, 'bot-1')[0];
    const firstDiscardResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: firstDiscard
    });

    assert.equal(firstDiscardResult.ok, true);
    assert.equal(bot.hand.length, 11);
    assert.equal(bot.discardPile.length, 1);
    assert.equal(room.pendingAbility.cardsRemaining, 1);
    assert.equal(room.currentTurnPlayerId, 'bot-1');

    const secondDiscard = getLegalActions(room, 'bot-1')[0];
    const secondDiscardResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: secondDiscard
    });

    assert.equal(secondDiscardResult.ok, true);
    assert.equal(bot.hand.length, MAX_HAND_SIZE);
    assert.equal(bot.discardPile.length, 2);
    assert.equal(room.pendingAbility, null);
    assert.equal(room.currentTurnPlayerId, 'human-1');
    assert.match(room.battleLog[1], /discards.*to meet the hand limit/);
});

test('human players may temporarily exceed the hand limit for playtesting', () => {
    const room = createRoom('human-player');
    const human = room.players[0];
    human.hand = Array.from({ length: MAX_HAND_SIZE }, (_, index) => (
        createCard('dino_king_1', human.id, `human-hand-${index}`)
    ));
    human.deck = [
        createCard('dino_armor_1', human.id, 'human-draw-1'),
        createCard('dino_bro_1', human.id, 'human-draw-2')
    ];

    const result = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: human.id,
        action: { type: 'end-turn' }
    });

    assert.equal(result.ok, true);
    assert.equal(result.turnCompleted, true);
    assert.equal(human.hand.length, 12);
    assert.equal(room.pendingAbility, null);
    assert.equal(room.currentTurnPlayerId, 'human-1');
});

test('a scoring bot turn also waits for hand-limit discards', () => {
    const room = createRoom();
    const bot = room.players[0];
    bot.isBot = true;
    bot.hand = Array.from({ length: MAX_HAND_SIZE }, (_, index) => (
        createCard('dino_king_1', bot.id, `scoring-hand-${index}`)
    ));
    bot.deck = [
        createCard('dino_armor_1', bot.id, 'scoring-draw-1'),
        createCard('dino_bro_1', bot.id, 'scoring-draw-2')
    ];
    room.activeBases[0].breakpoint = 1;
    room.activeBases[0].playedCards.push(createCard('dino_king_1', bot.id, 'scoring-minion'));
    room.baseDeck = [];
    let finishScoring;

    executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: bot.id,
        action: { type: 'end-turn' },
        scheduleAction: callback => { finishScoring = callback; }
    });
    finishScoring();

    assert.equal(room.gamePhase, 'scoring');
    assert.equal(room.currentTurnPlayerId, bot.id);
    assert.equal(room.pendingAbility.type, 'handLimitDiscard');
    assert.equal(room.pendingAbility.cardsRemaining, 2);
    assert.equal(bot.hand.length, 12);
});

test('ending a turn finishes the game for a unique leader with at least 15 VP', () => {
    const room = createRoom();
    room.players[0].vp = 15;

    const result = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: { type: 'end-turn' }
    });

    assert.equal(result.ok, true);
    assert.equal(result.gameFinished, true);
    assert.equal(room.gamePhase, 'finished');
    assert.equal(room.currentTurnPlayerId, null);
    assert.equal(room.gameResult.winnerId, 'bot-1');
    assert.equal(room.gameResult.standings[0].vp, 15);
    assert.match(room.battleLog[0], /Bot One.*wins the game/);
});

test('leaders tied at 15 or more VP continue playing', () => {
    const room = createRoom();
    room.players[0].vp = 15;
    room.players[1].vp = 15;
    let stopped = false;

    assert.equal(getCompletedGameResult(room), null);
    assert.equal(finishGameIfNeeded(room, 'ROOM1', {
        stopBotController: () => { stopped = true; }
    }), null);
    assert.equal(room.gamePhase, 'playing');
    assert.equal(stopped, false);
});

test('finishing a game applies win and loss rewards to pending trajectories', () => {
    const room = createRoom();
    room.players[0].vp = 14;
    room.players[1].vp = 9;
    const legalActions = [{ type: 'end-turn' }];
    recordTrajectoryDecision({
        room,
        roomId: 'ROOM1',
        playerId: 'bot-1',
        observation: getPlayerObservation(room, 'bot-1'),
        legalActions,
        chosenAction: legalActions[0]
    });
    recordTrajectoryDecision({
        room,
        roomId: 'ROOM1',
        playerId: 'human-1',
        observation: getPlayerObservation(room, 'human-1'),
        legalActions,
        chosenAction: legalActions[0]
    });
    room.players[0].vp = 15;
    let stoppedRoomId = null;

    const result = finishGameIfNeeded(room, 'ROOM1', {
        stopBotController: roomId => { stoppedRoomId = roomId; }
    });
    const trajectory = getRoomTrajectory(room);
    const winnerEntry = trajectory.entries.find(entry => entry.playerId === 'bot-1');
    const loserEntry = trajectory.entries.find(entry => entry.playerId === 'human-1');

    assert.equal(result.winnerId, 'bot-1');
    assert.equal(stoppedRoomId, 'ROOM1');
    assert.equal(winnerEntry.vpReward, 1 / 15);
    assert.equal(winnerEntry.terminalReward, 1);
    assert.equal(winnerEntry.reward, 1 + (1 / 15));
    assert.equal(winnerEntry.terminated, true);
    assert.equal(loserEntry.vpReward, 0);
    assert.equal(loserEntry.terminalReward, -1);
    assert.equal(loserEntry.reward, -1);
    assert.equal(loserEntry.done, true);
    assert.equal(trajectory.metadata.terminationReason, 'victory');
    assert.equal(trajectory.metadata.terminated, true);
    assert.equal(trajectory.metadata.gameResult.winnerId, 'bot-1');
});

test('a synchronously recorded final action receives the terminal reward exactly once', () => {
    const room = createRoom();
    room.players[0].vp = 14;
    const legalActions = [{ type: 'end-turn' }];
    recordTrajectoryDecision({
        room,
        roomId: 'ROOM1',
        playerId: 'bot-1',
        observation: getPlayerObservation(room, 'bot-1'),
        legalActions,
        chosenAction: legalActions[0]
    });
    room.players[0].vp = 15;
    const finalActionObservation = getPlayerObservation(room, 'bot-1');

    finishGameIfNeeded(room, 'ROOM1', { stopBotController: () => {} });
    recordTrajectoryDecision({
        room,
        roomId: 'ROOM1',
        playerId: 'bot-1',
        observation: finalActionObservation,
        legalActions,
        chosenAction: legalActions[0]
    });

    const trajectory = getRoomTrajectory(room);
    assert.equal(trajectory.entries[0].terminalReward, 0);
    assert.equal(trajectory.entries[0].terminated, false);
    assert.equal(trajectory.entries[0].nextObservation.gamePhase, 'playing');
    assert.equal(trajectory.entries[1].terminalReward, 1);
    assert.equal(trajectory.entries[1].terminated, true);
    assert.equal(trajectory.entries.reduce((sum, entry) => sum + entry.terminalReward, 0), 1);
});

test('a scoring end-turn returns its room event and completes through an injected scheduler', () => {
    const room = createRoom();
    const kingRex = createCard('dino_king_1', 'bot-1');
    room.activeBases[0].breakpoint = 1;
    room.activeBases[0].playedCards.push(kingRex);
    room.baseDeck = [{
        id: 'replacement-base',
        name: 'Replacement Base',
        breakpoint: 20,
        vp: [3, 2, 1],
        abilities: []
    }];
    let scheduledResolution = null;
    let scheduledDelay = null;
    let stateEmissions = 0;
    const roomEvents = [];

    const result = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: { type: 'end-turn' },
        emitState: () => { stateEmissions += 1; },
        emitRoomEvent: (roomId, event, payload) => roomEvents.push({ roomId, event, payload }),
        scheduleAction: (callback, delay) => {
            scheduledResolution = callback;
            scheduledDelay = delay;
        }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.scoringBases, [0]);
    assert.equal(room.gamePhase, 'scoring');
    assert.equal(roomEvents[0].event, 'game-state-update');
    assert.deepEqual(roomEvents[0].payload.scoringBases, [0]);
    assert.equal(scheduledDelay, 5000);
    assert.equal(stateEmissions, 0);

    scheduledResolution();

    assert.equal(room.players[0].vp, 3);
    assert.equal(room.activeBases[0].id, 'replacement-base');
    assert.equal(room.currentTurnPlayerId, 'human-1');
    assert.equal(room.gamePhase, 'playing');
    assert.equal(stateEmissions, 1);
});

test('a scoring turn finishes after all scoring awards produce a unique 15 VP leader', () => {
    const room = createRoom();
    room.players[0].vp = 12;
    const kingRex = createCard('dino_king_1', 'bot-1');
    room.activeBases[0].breakpoint = 1;
    room.activeBases[0].playedCards.push(kingRex);
    room.baseDeck = [];
    let scheduledResolution = null;

    const result = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: { type: 'end-turn' },
        scheduleAction: callback => { scheduledResolution = callback; }
    });
    assert.equal(result.ok, true);
    assert.equal(room.gamePhase, 'scoring');

    scheduledResolution();

    assert.equal(room.players[0].vp, 15);
    assert.equal(room.gamePhase, 'finished');
    assert.equal(room.currentTurnPlayerId, null);
    assert.equal(room.gameResult.winnerId, 'bot-1');
});

test('multiple bases score by stable identity while empty base decks recycle', () => {
    const room = createRoom();
    room.activeBases = [
        {
            id: 'scoring-base-one',
            name: 'Scoring Base One',
            breakpoint: 1,
            vp: [3, 2, 1],
            abilities: [],
            playedCards: [createCard('dino_king_1', 'bot-1', 'base-one-minion')]
        },
        {
            id: 'scoring-base-two',
            name: 'Scoring Base Two',
            breakpoint: 1,
            vp: [3, 2, 1],
            abilities: [],
            playedCards: [createCard('dino_armor_1', 'bot-1', 'base-two-minion')]
        }
    ];
    room.baseDeck = [];
    let finishScoring;

    const result = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: { type: 'end-turn' },
        scheduleAction: callback => { finishScoring = callback; }
    });

    assert.deepEqual(result.scoringBases, [0, 1]);
    assert.doesNotThrow(() => finishScoring());
    assert.equal(room.players[0].vp, 6);
    assert.equal(room.players[0].discardPile.length, 0);
    assert.deepEqual(
        new Set(room.players[0].hand.map(card => card.instanceId)),
        new Set(['base-one-minion', 'base-two-minion'])
    );
    assert.equal(room.activeBases.length, 2);
    assert.deepEqual(
        room.activeBases.map(base => base.id),
        ['scoring-base-one', 'scoring-base-two']
    );
    assert.equal(room.baseDeck.length, 0);
    assert.equal(room.baseDiscardPile.length, 0);
    assert.equal(room.currentTurnPlayerId, 'human-1');
});

test('base discard reshuffles are reproducible from the room seed', () => {
    const runRecycle = () => {
        const room = createRoom();
        initializeSeededRandom(room, 98765);
        room.activeBases[0] = {
            id: 'scored-base',
            name: 'Scored Base',
            breakpoint: 1,
            vp: [3, 2, 1],
            abilities: [],
            playedCards: [createCard('dino_king_1', 'bot-1', 'scoring-minion')]
        };
        room.baseDiscardPile = [
            { id: 'discarded-base-1', name: 'Discarded Base 1', breakpoint: 20, vp: [3, 2, 1], abilities: [], playedCards: [] },
            { id: 'discarded-base-2', name: 'Discarded Base 2', breakpoint: 20, vp: [3, 2, 1], abilities: [], playedCards: [] }
        ];

        scoreBase(room, 0);
        return {
            activeBaseIds: room.activeBases.map(base => base.id),
            baseDeckIds: room.baseDeck.map(base => base.id),
            baseDiscardIds: room.baseDiscardPile.map(base => base.id),
            randomState: room.randomState
        };
    };

    const first = runRecycle();
    const second = runRecycle();

    assert.deepEqual(first, second);
    assert.equal(first.activeBaseIds.length, 1);
    assert.equal(first.baseDeckIds.length, 2);
    assert.equal(first.baseDiscardIds.length, 0);
    assert.deepEqual(
        new Set([...first.activeBaseIds, ...first.baseDeckIds]),
        new Set(['scored-base', 'discarded-base-1', 'discarded-base-2'])
    );
});

test('base scoring uses competition ranking when players tie', async t => {
    const scorePlayers = powers => {
        const room = createRoom('player-1');
        room.players = powers.map((power, index) => ({
            id: `player-${index + 1}`,
            name: `Player ${index + 1}`,
            hand: [],
            deck: [],
            discardPile: [],
            vp: 0
        }));
        room.activeBases[0] = {
            id: 'tie-base',
            name: 'Tie Base',
            breakpoint: 1,
            vp: [5, 3, 1],
            abilities: [],
            playedCards: powers.map((power, index) => {
                const minion = createCard(
                    'dino_king_1',
                    `player-${index + 1}`,
                    `tie-minion-${index + 1}`
                );
                minion.printedPower = power;
                minion.power = power;
                return minion;
            })
        };

        scoreBase(room, 0);

        const places = Object.fromEntries(
            room.structuredEvents
                .filter(event => event.eventType === 'victory-points-awarded')
                .map(event => [event.actorPlayerId, event.count])
        );
        return {
            victoryPoints: room.players.map(player => player.vp),
            places: room.players.map(player => places[player.id])
        };
    };

    await t.test('two players tied for first leave third place next', () => {
        assert.deepEqual(scorePlayers([5, 5, 3]), {
            victoryPoints: [5, 5, 1],
            places: [1, 1, 3]
        });
    });

    await t.test('three players tied for first all receive first-place VP', () => {
        assert.deepEqual(scorePlayers([5, 5, 5]), {
            victoryPoints: [5, 5, 5],
            places: [1, 1, 1]
        });
    });

    await t.test('two players tied for second both receive second-place VP', () => {
        assert.deepEqual(scorePlayers([6, 4, 4]), {
            victoryPoints: [5, 3, 3],
            places: [1, 2, 2]
        });
    });
});

test('a bot-style actor completes its faction draft through the shared dispatcher', () => {
    const room = {
        battleLog: [],
        draftState: {
            availableFactions: Object.keys(factionsData),
            currentTurnIndex: 0,
            draftOrder: ['bot-1', 'bot-1'],
            picks: { 'bot-1': [] }
        },
        gamePhase: 'drafting',
        pendingAbility: null,
        players: [{
            id: 'bot-1',
            name: 'Bot One',
            hand: [],
            deck: [],
            discardPile: [],
            vp: 0
        }],
        spectators: [],
        temporaryEffects: []
    };
    initializeSeededRandom(room, 8675309);

    const firstPick = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: { type: 'draft-faction', factionName: 'Aliens' }
    });

    assert.equal(firstPick.ok, true);
    assert.equal(firstPick.draftComplete, false);
    assert.equal(firstPick.roomEvents[0].event, 'draft-update');
    assert.deepEqual(room.draftState.picks['bot-1'], ['Aliens']);

    const secondPick = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: { type: 'draft-faction', factionName: 'Dinosaurs' }
    });

    assert.equal(secondPick.ok, true);
    assert.equal(secondPick.draftComplete, true);
    assert.equal(secondPick.roomEvents[0].event, 'game-started');
    assert.equal(room.gamePhase, 'playing');
    assert.equal(room.currentTurnPlayerId, 'bot-1');
    assert.deepEqual(room.players[0].factions, ['Aliens', 'Dinosaurs']);
    assert.equal(room.players[0].hand.length, 5);
    assert.equal(room.activeBases.length, 3);
});

test('the same room seed reproduces drafted decks, opening hands, and bases', () => {
    const createDraftRoom = () => {
        const room = {
            battleLog: [],
            draftState: {
                availableFactions: Object.keys(factionsData),
                currentTurnIndex: 0,
                draftOrder: ['bot-1', 'bot-1'],
                picks: { 'bot-1': [] }
            },
            gamePhase: 'drafting',
            pendingAbility: null,
            players: [{
                id: 'bot-1',
                name: 'Bot One',
                hand: [],
                deck: [],
                discardPile: [],
                vp: 0
            }],
            spectators: [],
            temporaryEffects: []
        };
        initializeSeededRandom(room, 'replayable-game');
        return room;
    };
    const finishDraft = room => {
        executeDraftFactionAction({
            room,
            actorId: 'bot-1',
            action: { type: 'draft-faction', factionName: 'Aliens' }
        });
        executeDraftFactionAction({
            room,
            actorId: 'bot-1',
            action: { type: 'draft-faction', factionName: 'Dinosaurs' }
        });
    };
    const firstRoom = createDraftRoom();
    const secondRoom = createDraftRoom();

    finishDraft(firstRoom);
    finishDraft(secondRoom);

    assert.deepEqual(
        firstRoom.activeBases.map(base => base.id),
        secondRoom.activeBases.map(base => base.id)
    );
    assert.deepEqual(
        firstRoom.players[0].hand.map(card => card.instanceId),
        secondRoom.players[0].hand.map(card => card.instanceId)
    );
    assert.deepEqual(
        firstRoom.players[0].deck.map(card => card.instanceId),
        secondRoom.players[0].deck.map(card => card.instanceId)
    );
    assert.equal(firstRoom.randomState, secondRoom.randomState);
});

test('getLegalActions returns executable card, Talent, and end-turn actions', () => {
    const room = createRoom();
    const kingRex = createCard('dino_king_1', 'bot-1');
    const howl = createCard('dino_howl_1', 'bot-1');
    const acolyte = createCard('ninja_acolyte_1', 'bot-1');
    room.players[0].hand.push(kingRex, howl);
    room.activeBases[0].playedCards.push(acolyte);

    const actions = getLegalActions(room, 'bot-1');

    assert.ok(actions.some(action => (
        action.type === 'play-card'
        && action.cardInstanceId === kingRex.instanceId
        && action.baseIndex === 0
    )));
    assert.ok(actions.some(action => (
        action.type === 'play-card'
        && action.cardInstanceId === howl.instanceId
    )));
    assert.ok(actions.some(action => (
        action.type === 'use-talent'
        && action.cardInstanceId === acolyte.instanceId
    )));
    assert.ok(actions.some(action => action.type === 'end-turn'));
    assert.equal(getLegalActions(room, 'human-1').length, 0);
});

test('legal-action model encodings distinguish duplicate cards and decision outcomes', () => {
    const room = createRoom();
    room.players[0].hand.push(
        createCard('robot_zapbot_1', 'bot-1', 'zapbot-copy-1'),
        createCard('robot_zapbot_1', 'bot-1', 'zapbot-copy-2')
    );

    const cardActions = getLegalActions(room, 'bot-1')
        .filter(action => action.type === 'play-card');
    const cardActionKeys = cardActions.map(getLegalActionEncodingKey);
    assert.equal(new Set(cardActionKeys).size, cardActionKeys.length);
    assert.notEqual(
        cardActions[0].choiceFeatures.sourceCardPosition,
        cardActions[1].choiceFeatures.sourceCardPosition
    );

    room.pendingAbility = {
        type: 'triggeredOptionalDraw',
        playerId: 'bot-1'
    };
    const decisionActions = getLegalActions(room, 'bot-1');
    assert.deepEqual(decisionActions.map(action => action.choiceTypeId), [
        CHOICE_TYPE_IDS.accept,
        CHOICE_TYPE_IDS.skip
    ]);
    assert.equal(
        new Set(decisionActions.map(getLegalActionEncodingKey)).size,
        decisionActions.length
    );
});

test('getLegalActions enforces a required extra minion play', () => {
    const room = createRoom();
    const acolyte = createCard('ninja_acolyte_1', 'bot-1');
    const kingRex = createCard('dino_king_1', 'bot-1');
    const howl = createCard('dino_howl_1', 'bot-1');
    room.activeBases[0].playedCards.push(acolyte);
    room.players[0].hand.push(kingRex, howl);

    const talentResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: { type: 'use-talent', cardInstanceId: acolyte.instanceId }
    });
    const actions = getLegalActions(room, 'bot-1');

    assert.equal(talentResult.ok, true);
    assert.ok(actions.length > 0);
    assert.ok(actions.every(action => action.type === 'play-card'));
    assert.ok(actions.every(action => action.baseIndex === 0));
    assert.ok(actions.every(action => (
        action.cardInstanceId === kingRex.instanceId
        || action.cardInstanceId === acolyte.instanceId
    )));
});

test('getLegalActions returns only pending ability choices while a choice is unresolved', () => {
    const room = createRoom();
    const laseratops = createCard('dino_bro_1', 'bot-1');
    const target = createCard('robot_zapbot_1', 'human-1', 'target-minion');
    room.players[0].hand.push(laseratops);
    room.activeBases[0].playedCards.push(target);

    executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: {
            type: 'play-card',
            cardInstanceId: laseratops.instanceId,
            baseIndex: 0
        }
    });
    const actions = getLegalActions(room, 'bot-1');

    assert.equal(actions.length, 2);
    assert.ok(actions.every(action => action.type === 'resolve-ability-choice'));
    assert.ok(actions.some(action => action.choice.minionInstanceId === target.instanceId));
    assert.ok(actions.some(action => action.choice.skip === true));
    assert.equal(getLegalActions(room, 'human-1').length, 0);
});

test('getLegalActions stages batch selections and deck ordering choices', () => {
    const room = createRoom();
    const minions = [
        createCard('robot_zapbot_1', 'human-1', 'target-1'),
        createCard('robot_microbot_fixer_1', 'human-1', 'target-2'),
        createCard('robot_microbot_guard_1', 'human-1', 'target-3')
    ];
    room.activeBases[0].playedCards.push(...minions);
    room.pendingAbility = {
        type: 'boardEffectBatch',
        playerId: 'bot-1',
        effect: { type: 'destroyMinion' },
        candidateIds: minions.map(minion => minion.instanceId),
        maxSelections: 2
    };

    const batchActions = getLegalActions(room, 'bot-1');

    assert.equal(batchActions.length, 4);
    assert.equal(batchActions.filter(action => action.choice.minionInstanceId).length, 3);
    assert.ok(batchActions.some(action => action.choice.cancel));

    const firstSelection = batchActions.find(action => (
        action.choice.minionInstanceId === minions[0].instanceId
    ));
    const selectionResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: firstSelection
    });
    const remainingBatchActions = getLegalActions(room, 'bot-1');

    assert.equal(selectionResult.ok, true);
    assert.equal(room.pendingAbility.type, 'boardEffectBatch');
    assert.equal(remainingBatchActions.filter(action => action.choice.minionInstanceId).length, 2);
    assert.ok(remainingBatchActions.some(action => action.choice.finishSelection));

    const finishResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: remainingBatchActions.find(action => action.choice.finishSelection)
    });

    assert.equal(finishResult.ok, true);
    assert.equal(room.pendingAbility, null);
    assert.equal(room.activeBases[0].playedCards.some(card => card.instanceId === minions[0].instanceId), false);

    const orderedCards = [
        createCard('dino_king_1', 'bot-1', 'order-1'),
        createCard('dino_armor_1', 'bot-1', 'order-2'),
        createCard('dino_bro_1', 'bot-1', 'order-3')
    ];
    room.players[0].deck = orderedCards;
    room.pendingAbility = {
        type: 'deckReorder',
        playerId: 'bot-1',
        cardIds: orderedCards.map(card => card.instanceId)
    };

    const reorderActions = getLegalActions(room, 'bot-1');

    assert.equal(reorderActions.length, 3);
    assert.deepEqual(
        reorderActions.map(action => action.choice.cardInstanceId),
        orderedCards.map(card => card.instanceId)
    );

    executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: reorderActions[2]
    });
    assert.deepEqual(room.pendingAbility.orderedIds, ['order-3']);
    assert.equal(getLegalActions(room, 'bot-1').length, 2);

    executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: getLegalActions(room, 'bot-1')[0]
    });
    assert.deepEqual(room.pendingAbility.orderedIds, ['order-3', 'order-1']);
    assert.equal(getLegalActions(room, 'bot-1').length, 1);

    executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: getLegalActions(room, 'bot-1')[0]
    });
    assert.equal(room.pendingAbility, null);
    assert.deepEqual(
        room.players[0].deck.map(card => card.instanceId),
        ['order-3', 'order-1', 'order-2']
    );
});

test('large deck orders expose only linear staged policy choices', () => {
    const room = createRoom();
    const orderedCards = Array.from({ length: 10 }, (_, index) => (
        createCard('dino_king_1', 'bot-1', `large-order-${index}`)
    ));
    room.players[0].deck = orderedCards;
    room.pendingAbility = {
        type: 'deckReorder',
        playerId: 'bot-1',
        cardIds: orderedCards.map(card => card.instanceId),
        orderedIds: []
    };

    const actions = getLegalActions(room, 'bot-1');

    assert.equal(actions.length, 10);
    assert.ok(actions.every(action => typeof action.choice.cardInstanceId === 'string'));
    assert.ok(actions.every(action => action.choice.cardInstanceIds === undefined));
});

test('getLegalActions keeps any-number card selections linear in candidate count', () => {
    const room = createRoom();
    const discardCards = Array.from({ length: 20 }, (_, index) => (
        createCard('robot_microbot_fixer_1', 'bot-1', `discard-${index}`)
    ));
    room.players[0].discardPile.push(...discardCards);
    room.pendingAbility = {
        type: 'multiZoneSelection',
        playerId: 'bot-1',
        action: 'shuffleDiscardIntoDeck',
        zone: 'discardPile',
        candidateIds: discardCards.map(card => card.instanceId),
        selectedIds: [],
        minSelections: 0,
        maxSelections: discardCards.length,
        canSkip: true,
        message: 'Choose cards.'
    };

    const initialActions = getLegalActions(room, 'bot-1');

    assert.equal(initialActions.length, 21);
    assert.equal(initialActions.filter(action => action.choice.cardInstanceId).length, 20);
    assert.ok(initialActions.some(action => action.choice.skip));

    executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: initialActions.find(action => action.choice.cardInstanceId === discardCards[0].instanceId)
    });
    const nextActions = getLegalActions(room, 'bot-1');

    assert.equal(nextActions.length, 20);
    assert.ok(nextActions.some(action => action.choice.skip));

    const finishResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: nextActions.find(action => action.choice.skip)
    });

    assert.equal(finishResult.ok, true);
    assert.equal(room.pendingAbility, null);
    assert.ok(room.players[0].deck.some(card => card.instanceId === discardCards[0].instanceId));
});

test('getLegalActions returns all available factions only for the current drafter', () => {
    const room = createRoom();
    room.gamePhase = 'drafting';
    room.draftState = {
        availableFactions: ['Aliens', 'Dinosaurs'],
        currentTurnIndex: 0,
        draftOrder: ['bot-1'],
        picks: { 'bot-1': [] }
    };

    const legalActions = getLegalActions(room, 'bot-1');
    assert.deepEqual(legalActions.map(action => ({
        type: action.type,
        factionName: action.factionName,
        actionTypeId: action.actionTypeId,
        factionEntityId: action.entityIds.factionEntityId
    })), [
        { type: 'draft-faction', factionName: 'Aliens', actionTypeId: 4, factionEntityId: 2 },
        { type: 'draft-faction', factionName: 'Dinosaurs', actionTypeId: 4, factionEntityId: 1 }
    ]);
    assert.ok(legalActions.every(action => action.choiceTypeId > 0));
    assert.equal(getLegalActions(room, 'human-1').length, 0);
});

test('getPlayerObservation exposes public state and only the observer hand', () => {
    const room = createRoom();
    const observerCard = createCard('dino_king_1', 'bot-1', 'observer-hand');
    const opponentCard = createCard('wizard_summon_1', 'human-1', 'opponent-hand');
    const opponentDeckCard = createCard('wizard_archmage_1', 'human-1', 'opponent-deck');
    const opponentDiscard = createCard('wizard_scry_1', 'human-1', 'opponent-discard');
    room.players[0].hand.push(observerCard);
    room.players[1].hand.push(opponentCard);
    room.players[1].deck.push(opponentDeckCard);
    room.players[1].discardPile.push(opponentDiscard);
    room.battleLog = Array.from({ length: 12 }, (_, index) => `entry-${index}`);

    const observation = getPlayerObservation(room, 'bot-1');
    const observedSelf = observation.players.find(player => player.id === 'bot-1');
    const observedOpponent = observation.players.find(player => player.id === 'human-1');

    assert.equal(observation.observerPlayerId, 'bot-1');
    assert.equal(observation.resolutionId, 'resolution-1');
    assert.equal(observation.decisionType, 'turnAction');
    assert.equal(observation.stepIndex, 0);
    assert.equal(observation.isObserverTurn, true);
    assert.equal(observedSelf.hand[0].instanceId, observerCard.instanceId);
    assert.equal(observedOpponent.hand, null);
    assert.equal(observedOpponent.handCount, 1);
    assert.equal(observedOpponent.deckCount, 1);
    assert.equal(observedOpponent.discardPile[0].instanceId, opponentDiscard.instanceId);
    assert.equal(JSON.stringify(observation).includes(opponentCard.instanceId), false);
    assert.equal(JSON.stringify(observation).includes(opponentDeckCard.instanceId), false);
    assert.deepEqual(
        observation.recentBattleLog,
        Array.from({ length: 10 }, (_, index) => `entry-${index}`)
    );
    assert.equal(observation.battleLog, undefined);
});

test('getPlayerObservation returns an immutable snapshot with private pending choices', () => {
    const room = createRoom();
    room.baseDiscardPile.push({ id: 'discarded-base', name: 'Discarded Base' });
    room.pendingAbility = {
        type: 'boardEffect',
        playerId: 'bot-1',
        sourceCardName: 'Test Card',
        candidateIds: ['target-1'],
        continuation: { hiddenServerControl: true }
    };

    const botObservation = getPlayerObservation(room, 'bot-1');
    const opponentObservation = getPlayerObservation(room, 'human-1');

    assert.deepEqual(botObservation.pendingDecision.candidateIds, ['target-1']);
    assert.equal(botObservation.pendingDecision.continuation, undefined);
    assert.equal(opponentObservation.pendingDecision.candidateIds, undefined);
    assert.equal(opponentObservation.pendingDecision.controlledByObserver, false);

    botObservation.players[0].name = 'Changed';
    botObservation.activeBases[0].name = 'Changed Base';
    botObservation.baseDiscardPile[0].name = 'Changed Discarded Base';
    botObservation.pendingDecision.candidateIds.push('target-2');

    assert.equal(room.players[0].name, 'Bot One');
    assert.equal(room.activeBases[0].name, 'Test Base');
    assert.equal(room.baseDiscardPile[0].name, 'Discarded Base');
    assert.deepEqual(room.pendingAbility.candidateIds, ['target-1']);
    assert.equal(getPlayerObservation(room, 'missing-player'), null);
});

test('structured events expose ordered entity IDs without leaking private choices', () => {
    const room = createRoom();
    const privateCard = createCard('dino_king_1', 'bot-1', 'private-choice-card');
    room.players[0].hand.push(privateCard);

    recordStructuredEvent(room, {
        eventType: 'ability-choice-made',
        actorPlayerId: 'bot-1',
        card: privateCard,
        privateEntityPlayerId: 'bot-1'
    });
    recordStructuredEvent(room, {
        eventType: 'turn-ended',
        actorPlayerId: 'bot-1'
    });

    const actorEvents = getPlayerObservation(room, 'bot-1').recentEvents;
    const opponentEvents = getPlayerObservation(room, 'human-1').recentEvents;

    assert.equal(actorEvents.length, 2);
    assert.deepEqual(actorEvents.map(event => event.sequenceNumber), [0, 1]);
    assert.equal(actorEvents[0].eventType, 'ability-choice-made');
    assert.ok(actorEvents[0].eventTypeId > 0);
    assert.ok(actorEvents[0].cardEntityId > 0);
    assert.equal(opponentEvents[0].cardEntityId, 0);
    assert.equal(JSON.stringify(opponentEvents).includes('privateEntityPlayerId'), false);
});

test('successful gameplay decisions and public card plays enter structured history', () => {
    const room = createRoom();
    const kingRex = createCard('dino_king_1', 'bot-1', 'structured-king-rex');
    room.players[0].hand.push(kingRex);

    const playResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: {
            type: 'play-card',
            cardInstanceId: kingRex.instanceId,
            baseIndex: 0
        }
    });
    const endTurnResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: { type: 'end-turn' }
    });

    assert.equal(playResult.ok, true);
    assert.equal(endTurnResult.ok, true);
    const observation = getPlayerObservation(room, 'human-1');
    const playEvent = observation.recentEvents.find(event => event.eventType === 'card-played');
    assert.ok(playEvent.cardEntityId > 0);
    assert.equal(playEvent.actorSeatIndex, 0);
    assert.ok(playEvent.baseEntityId >= 0);
    assert.ok(observation.recentEvents.some(event => event.eventType === 'turn-ended'));
    assert.ok(observation.recentEvents.some(event => event.eventType === 'turn-started'));
});

test('decision metadata groups follow-up choices into one resolution', () => {
    const room = createRoom();
    const laseratops = createCard('dino_bro_1', 'bot-1', 'metadata-laseratops');
    const target = createCard('robot_zapbot_1', 'human-1', 'metadata-target');
    room.players[0].hand.push(laseratops);
    room.activeBases[0].playedCards.push(target);

    const playObservation = getPlayerObservation(room, 'bot-1');
    const playResult = executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: {
            type: 'play-card',
            cardInstanceId: laseratops.instanceId,
            baseIndex: 0
        }
    });
    const targetObservation = getPlayerObservation(room, 'bot-1');

    assert.equal(playResult.ok, true);
    assert.equal(playObservation.resolutionId, 'resolution-1');
    assert.equal(playObservation.decisionType, 'turnAction');
    assert.equal(playObservation.stepIndex, 0);
    assert.equal(targetObservation.resolutionId, playObservation.resolutionId);
    assert.equal(targetObservation.decisionType, 'boardEffect');
    assert.equal(targetObservation.stepIndex, 1);

    const targetAction = getLegalActions(room, 'bot-1').find(action => (
        action.choice.minionInstanceId === target.instanceId
    ));
    executeGameAction({
        room,
        roomId: 'ROOM1',
        actorId: 'bot-1',
        action: targetAction
    });
    const nextActionObservation = getPlayerObservation(room, 'bot-1');

    assert.equal(nextActionObservation.resolutionId, 'resolution-2');
    assert.equal(nextActionObservation.decisionType, 'turnAction');
    assert.equal(nextActionObservation.stepIndex, 0);
});

test('the trajectory links consecutive player decisions and records VP rewards', () => {
    const room = createRoom();
    room.gameStartedAt = '2026-08-27T12:00:00.000Z';
    room.botPolicyVersion = 'random-v1';
    room.players[0].factions = ['Dinosaurs', 'Pirates'];
    const firstObservation = getPlayerObservation(room, 'bot-1');
    const firstLegalActions = [{ type: 'end-turn' }];

    recordTrajectoryDecision({
        room,
        roomId: 'ROOM1',
        playerId: 'bot-1',
        observation: firstObservation,
        legalActions: firstLegalActions,
        chosenAction: firstLegalActions[0]
    });

    room.players[0].vp = 3;
    room.currentTurnPlayerId = 'bot-1';
    const secondObservation = getPlayerObservation(room, 'bot-1');
    recordTrajectoryDecision({
        room,
        roomId: 'ROOM1',
        playerId: 'bot-1',
        observation: secondObservation,
        legalActions: firstLegalActions,
        chosenAction: firstLegalActions[0]
    });

    const activeTrajectory = getRoomTrajectory(room);
    assert.equal(activeTrajectory.schemaVersion, 5);
    assert.equal(activeTrajectory.gameId, 'ROOM1');
    assert.equal(activeTrajectory.metadata.trajectorySchemaVersion, 5);
    assert.equal(activeTrajectory.metadata.observationSchemaVersion, 5);
    assert.equal(activeTrajectory.metadata.entityIdSchemaVersion, 4);
    assert.equal(activeTrajectory.metadata.eventSchemaVersion, 1);
    assert.equal(activeTrajectory.metadata.eventHistorySource, 'native-v1');
    assert.equal(activeTrajectory.metadata.rewardSchemaVersion, 2);
    assert.equal(activeTrajectory.metadata.victoryPointRewardScale, 1 / 15);
    assert.equal(activeTrajectory.metadata.winReward, 1);
    assert.equal(activeTrajectory.metadata.lossReward, -1);
    assert.equal(activeTrajectory.metadata.policyVersion, 'random-v1');
    assert.equal(activeTrajectory.metadata.randomSeed, 123456);
    assert.equal(activeTrajectory.metadata.randomAlgorithm, 'mulberry32-v1');
    assert.equal(activeTrajectory.metadata.startedAt, room.gameStartedAt);
    assert.equal(activeTrajectory.metadata.completedAt, null);
    assert.equal(activeTrajectory.metadata.decisionCount, 2);
    assert.deepEqual(activeTrajectory.metadata.players[0].factions, ['Dinosaurs', 'Pirates']);
    assert.equal(activeTrajectory.entries.length, 2);
    assert.equal(activeTrajectory.entries[0].resolutionId, firstObservation.resolutionId);
    assert.equal(activeTrajectory.entries[0].decisionType, 'turnAction');
    assert.equal(activeTrajectory.entries[0].stepIndex, 0);
    assert.equal(activeTrajectory.entries[0].chosenActionIndex, 0);
    assert.equal(activeTrajectory.entries[0].reward, 3 / 15);
    assert.equal(activeTrajectory.entries[0].nextObservation.players[0].vp, 3);
    assert.equal(activeTrajectory.entries[0].done, false);
    assert.equal(activeTrajectory.entries[1].reward, null);

    const completedTrajectory = finalizeRoomTrajectory(room, { terminated: true });
    assert.equal(completedTrajectory.entries[1].reward, 0);
    assert.equal(completedTrajectory.entries[1].terminated, true);
    assert.equal(completedTrajectory.entries[1].done, true);
    assert.equal(completedTrajectory.metadata.terminated, true);
    assert.equal(completedTrajectory.metadata.truncated, false);
    assert.equal(completedTrajectory.metadata.terminationReason, 'terminated');
    assert.match(completedTrajectory.metadata.completedAt, /^\d{4}-\d{2}-\d{2}T/);

    const exportedJson = exportRoomTrajectoryJson(room, { pretty: true });
    const exportedTrajectory = JSON.parse(exportedJson);
    assert.equal(exportedTrajectory.metadata.gameId, 'ROOM1');
    assert.equal(exportedTrajectory.metadata.decisionCount, 2);
    assert.equal(exportedTrajectory.entries[0].chosenAction.type, 'end-turn');
    assert.equal(exportedTrajectory.pendingEntryIndexByPlayer, undefined);
    assert.equal(exportedTrajectory.nextDecisionIndex, undefined);
    assert.equal(exportedTrajectory.randomState, undefined);
    assert.equal(exportedTrajectory.metadata.randomState, undefined);
    assert.match(exportedJson, /\n  "metadata"/);

    completedTrajectory.entries[0].chosenAction.type = 'changed';
    assert.equal(getRoomTrajectory(room).entries[0].chosenAction.type, 'end-turn');
});

test('the default bot policy chooses randomly from every legal action', () => {
    const legalActions = [
        { type: 'draft-faction', factionName: 'Aliens' },
        { type: 'draft-faction', factionName: 'Dinosaurs' },
        { type: 'draft-faction', factionName: 'Pirates' }
    ];

    const draftAction = chooseDefaultBotAction({
        legalActions,
        room: { gamePhase: 'drafting' },
        random: () => 0.8
    });
    const playingAction = chooseDefaultBotAction({
        legalActions,
        room: { gamePhase: 'playing' },
        random: () => 0.4
    });

    assert.deepEqual(draftAction, legalActions[2]);
    assert.deepEqual(playingAction, legalActions[1]);
    assert.equal(chooseDefaultBotAction({ legalActions: [] }), null);
    assert.equal(chooseDefaultBotActionIndex({ legalActions, random: () => 0.8 }), 2);
    assert.equal(chooseDefaultBotActionIndex({ legalActions: [] }), null);
});

test('default bot decisions are reproducible from the room seed', () => {
    const legalActions = [
        { type: 'end-turn' },
        { type: 'use-talent', cardInstanceId: 'talent-1' },
        { type: 'play-card', cardInstanceId: 'card-1', baseIndex: 0 }
    ];
    const firstRoom = {};
    const secondRoom = {};
    initializeSeededRandom(firstRoom, 'bot-policy-replay');
    initializeSeededRandom(secondRoom, 'bot-policy-replay');
    const chooseSequence = room => Array.from({ length: 12 }, () => (
        chooseDefaultBotAction({
            legalActions,
            random: () => nextSeededRandom(room)
        })
    ));

    assert.deepEqual(chooseSequence(firstRoom), chooseSequence(secondRoom));
    assert.equal(firstRoom.randomState, secondRoom.randomState);
});

test('getBotDecisionActorId prioritizes bot-owned pending abilities over turn ownership', () => {
    const room = createRoom();
    room.players[0].isBot = true;

    assert.equal(getBotDecisionActorId(room), 'bot-1');

    room.currentTurnPlayerId = 'human-1';
    assert.equal(getBotDecisionActorId(room), null);

    room.pendingAbility = {
        type: 'triggeredOptionalDraw',
        playerId: 'bot-1',
        sourceCardName: 'Microbot Archive'
    };
    assert.equal(getBotDecisionActorId(room), 'bot-1');

    room.currentTurnPlayerId = 'bot-1';
    room.pendingAbility.playerId = 'human-1';
    assert.equal(getBotDecisionActorId(room), null);

    room.pendingAbility = null;
    room.gamePhase = 'drafting';
    room.draftState = {
        currentTurnIndex: 0,
        draftOrder: ['bot-1']
    };
    assert.equal(getBotDecisionActorId(room), 'bot-1');
});

test('the bot controller notices and completes a bot faction pick', async () => {
    const room = createRoom();
    room.players[0].isBot = true;
    room.gamePhase = 'drafting';
    room.draftState = {
        availableFactions: ['Aliens', 'Dinosaurs'],
        currentTurnIndex: 0,
        draftOrder: ['bot-1', 'human-1', 'human-1', 'bot-1'],
        picks: { 'bot-1': [], 'human-1': [] }
    };
    const { controller, scheduledCallbacks } = createScheduledBotController(room);

    assert.equal(controller.wake('ROOM1'), true);
    assert.equal(scheduledCallbacks.length, 1);
    await scheduledCallbacks.shift()();

    assert.equal(room.draftState.picks['bot-1'].length, 1);
    assert.ok(['Aliens', 'Dinosaurs'].includes(room.draftState.picks['bot-1'][0]));
    assert.equal(room.draftState.currentTurnIndex, 1);
    assert.equal(scheduledCallbacks.length, 0);
});

test('the bot controller notices and completes a normal bot turn', async () => {
    const room = createRoom();
    room.players[0].isBot = true;
    const { controller, scheduledCallbacks } = createScheduledBotController(room);

    controller.wake('ROOM1');
    await scheduledCallbacks.shift()();

    assert.equal(room.currentTurnPlayerId, 'human-1');
    assert.equal(room.battleLog[0], "**Human One**'s turn");
    assert.equal(scheduledCallbacks.length, 0);
    const trajectory = getRoomTrajectory(room);
    assert.equal(trajectory.entries.length, 1);
    assert.equal(trajectory.entries[0].playerId, 'bot-1');
    assert.equal(trajectory.entries[0].chosenAction.type, 'end-turn');
    assert.equal(trajectory.entries[0].chosenAction.actionTypeId, 5);
    assert.equal(trajectory.entries[0].chosenAction.choiceTypeId, 1);
    assert.deepEqual(trajectory.entries[0].chosenAction.entityIds, {
        cardEntityId: 0,
        targetCardEntityId: 0,
        baseEntityId: 0,
        factionEntityId: 0,
        selectedCardEntityIds: []
    });
    assert.equal(trajectory.entries[0].observation.isObserverTurn, true);
});

test('the bot controller resolves a bot trigger during another player turn', async () => {
    const room = createRoom();
    room.currentTurnPlayerId = 'human-1';
    room.players[0].isBot = true;
    const drawnCard = createCard('dino_king_1', 'bot-1', 'trigger-draw');
    room.players[0].deck.push(drawnCard);
    room.pendingAbility = {
        type: 'triggeredOptionalDraw',
        playerId: 'bot-1',
        sourceCardName: 'Microbot Archive'
    };
    const { controller, scheduledCallbacks } = createScheduledBotController(room);

    controller.wake('ROOM1');
    await scheduledCallbacks.shift()();

    assert.equal(room.pendingAbility, null);
    assert.equal(room.currentTurnPlayerId, 'human-1');
    assert.equal(
        [...room.players[0].hand, ...room.players[0].deck]
            .some(card => card.instanceId === drawnCard.instanceId),
        true
    );
    assert.equal(scheduledCallbacks.length, 0);
});
