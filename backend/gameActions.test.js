const test = require('node:test');
const assert = require('node:assert/strict');
const { factionsData } = require('./factions.js');
const {
    chooseDefaultBotAction,
    createBotTurnController,
    createInitialTurnState,
    executeGameAction,
    getBotDecisionActorId,
    getLegalActions,
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
    return {
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

test('getLegalActions stages batch selections and enumerates every deck order', () => {
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

    assert.equal(reorderActions.length, 6);
    assert.ok(reorderActions.every(action => action.choice.cardInstanceIds.length === 3));
    assert.equal(new Set(reorderActions.map(action => action.choice.cardInstanceIds.join(','))).size, 6);
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

    assert.deepEqual(getLegalActions(room, 'bot-1'), [
        { type: 'draft-faction', factionName: 'Aliens' },
        { type: 'draft-faction', factionName: 'Dinosaurs' }
    ]);
    assert.equal(getLegalActions(room, 'human-1').length, 0);
});

test('the default bot policy chooses a random remaining faction during drafting', () => {
    const legalActions = [
        { type: 'draft-faction', factionName: 'Aliens' },
        { type: 'draft-faction', factionName: 'Dinosaurs' },
        { type: 'draft-faction', factionName: 'Pirates' }
    ];

    const action = chooseDefaultBotAction({
        legalActions,
        room: { gamePhase: 'drafting' },
        random: () => 0.8
    });

    assert.deepEqual(action, legalActions[2]);
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
    assert.equal(room.players[0].hand[0].instanceId, drawnCard.instanceId);
    assert.equal(scheduledCallbacks.length, 0);
});
