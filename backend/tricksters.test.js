const test = require('node:test');
const assert = require('node:assert/strict');
const { basesData } = require('./bases.js');
const { factionsData } = require('./factions.js');
const {
    createInitialTurnState,
    executeGameAction,
    getLegalActions,
    resolveStartTurnActions,
    validatePlayCardAction
} = require('./server.js');

const cardTemplates = Object.entries(factionsData).flatMap(([faction, data]) => (
    data.cards.map(card => ({ ...card, faction }))
));
let nextInstanceNumber = 1;

function createCard(cardId, ownerId) {
    const template = cardTemplates.find(card => card.id === cardId);
    assert.ok(template, `Missing card template: ${cardId}`);
    return {
        ...template,
        cardId: template.id,
        instanceId: `${cardId}-${nextInstanceNumber++}`,
        ownerId,
        ownerName: ownerId,
        printedPower: template.power,
        attachedCards: []
    };
}

function createBase(playedCards = []) {
    return {
        ...basesData.find(base => base.id === 'base_the_homeworld'),
        playedCards
    };
}

function createPlayer(id) {
    return { id, name: id, hand: [], deck: [], discardPile: [], vp: 0 };
}

function createRoom(activeBases, playerCount = 2) {
    return {
        activeBases,
        battleLog: [],
        currentResolutionContext: null,
        currentTurnPlayerId: 'player-1',
        gamePhase: 'playing',
        pendingAbility: null,
        players: Array.from({ length: playerCount }, (_, index) => createPlayer(`player-${index + 1}`)),
        temporaryEffects: [],
        triggerQueue: [],
        turnState: createInitialTurnState()
    };
}

function playCard(room, playerId, card, { baseIndex, targetMinionInstanceId } = {}) {
    const player = room.players.find(candidate => candidate.id === playerId);
    player.hand.push(card);
    room.currentTurnPlayerId = playerId;
    return executeGameAction({
        room,
        roomId: 'ROOM',
        actorId: playerId,
        action: {
            type: 'play-card',
            cardInstanceId: card.instanceId,
            baseIndex,
            targetMinionInstanceId
        }
    });
}

function resolveChoice(room, playerId, choice) {
    return executeGameAction({
        room,
        roomId: 'ROOM',
        actorId: playerId,
        action: { type: 'resolve-ability-choice', choice }
    });
}

test('Leprechaun destroys a weaker opposing minion after its on-play ability resolves', () => {
    const leprechaun = createCard('trickster_leprechaun_1', 'player-1');
    const room = createRoom([createBase([leprechaun])]);
    const enchantress = createCard('wizard_enchantress_1', 'player-2');
    const drawnCard = createCard('wizard_summon_1', 'player-2');
    room.players[1].deck.push(drawnCard);

    assert.equal(playCard(room, 'player-2', enchantress, { baseIndex: 0 }).ok, true);
    assert.equal(room.players[1].hand.some(card => card.instanceId === drawnCard.instanceId), true);
    assert.equal(room.activeBases[0].playedCards.includes(enchantress), false);
    assert.equal(room.players[1].discardPile.some(card => card.cardId === 'wizard_enchantress_1'), true);
});

test('Brownie makes the controller of an affecting card discard two random cards', () => {
    const brownie = createCard('trickster_brownie_1', 'player-1');
    const room = createRoom([createBase([brownie])]);
    const beamUp = createCard('alien_beam_up_1', 'player-2');
    room.players[1].hand.push(
        createCard('alien_scout_1', 'player-2'),
        createCard('alien_invader_1', 'player-2')
    );

    assert.equal(playCard(room, 'player-2', beamUp, {
        baseIndex: 0,
        targetMinionInstanceId: brownie.instanceId
    }).ok, true);
    assert.equal(room.players[0].hand.some(card => card.instanceId === brownie.instanceId), true);
    assert.equal(room.players[1].hand.length, 0);
    assert.equal(room.players[1].discardPile.length, 3);
});

test('Gnome offers and resolves its optional low-power destruction', () => {
    const weakMinion = createCard('robot_microbot_guard_1', 'player-2');
    const ally = createCard('robot_microbot_alpha_1', 'player-1');
    const room = createRoom([createBase([weakMinion, ally])]);
    const gnome = createCard('trickster_gnome_1', 'player-1');

    assert.equal(playCard(room, 'player-1', gnome, { baseIndex: 0 }).ok, true);
    assert.equal(room.pendingAbility?.type, 'boardEffect');
    assert.equal(resolveChoice(room, 'player-1', { minionInstanceId: weakMinion.instanceId }).ok, true);
    assert.equal(room.players[1].discardPile.some(card => card.instanceId === weakMinion.instanceId), true);
});

test('Gremlin draws a card and makes every other player discard at random when destroyed', () => {
    const gremlin = createCard('trickster_gremlin_1', 'player-1');
    const room = createRoom([createBase([gremlin])]);
    room.players[0].deck.push(createCard('trickster_gnome_1', 'player-1'));
    room.players[1].hand.push(createCard('alien_scout_1', 'player-2'));
    const seeingStars = createCard('ninja_seeing_stars_1', 'player-2');

    assert.equal(playCard(room, 'player-2', seeingStars, {
        baseIndex: 0,
        targetMinionInstanceId: gremlin.instanceId
    }).ok, true);
    assert.equal(room.players[0].hand.length, 1);
    assert.equal(room.players[1].hand.length, 0);
    assert.equal(room.players[0].discardPile.some(card => card.instanceId === gremlin.instanceId), true);
});

test('Block the Path names a faction and prevents that faction from playing minions there', () => {
    const room = createRoom([createBase()]);
    const block = createCard('trickster_block_the_path_1', 'player-1');
    assert.equal(playCard(room, 'player-1', block, { baseIndex: 0 }).ok, true);
    assert.equal(room.pendingAbility?.type, 'factionSelection');
    assert.equal(resolveChoice(room, 'player-1', { faction: 'Robots' }).ok, true);

    room.turnState = createInitialTurnState();
    room.currentTurnPlayerId = 'player-2';
    const zapbot = createCard('robot_zapbot_1', 'player-2');
    room.players[1].hand.push(zapbot);
    assert.equal(validatePlayCardAction(room, 'player-2', {
        type: 'play-card',
        cardInstanceId: zapbot.instanceId,
        baseIndex: 0
    }).code, 'minion_play_prevented');
});

test('Disenchant destroys a selected action played on a base', () => {
    const preserve = createCard('dino_wildlife_preserve_1', 'player-2');
    const room = createRoom([createBase([preserve])]);
    const disenchant = createCard('trickster_disenchant_1', 'player-1');

    assert.equal(playCard(room, 'player-1', disenchant).ok, true);
    assert.equal(room.pendingAbility?.type, 'actionSelection');
    assert.equal(resolveChoice(room, 'player-1', { cardInstanceId: preserve.instanceId }).ok, true);
    assert.equal(room.activeBases[0].playedCards.includes(preserve), false);
    assert.equal(room.players[1].discardPile.some(card => card.instanceId === preserve.instanceId), true);
});

test('Enshrouding Mist grants exactly one extra minion play at its base each turn', () => {
    const mist = createCard('trickster_enshrouding_mist_1', 'player-1');
    const room = createRoom([createBase([mist])]);
    const first = createCard('trickster_gremlin_1', 'player-1');
    const second = createCard('trickster_gnome_1', 'player-1');
    const third = createCard('trickster_brownie_1', 'player-1');

    assert.equal(playCard(room, 'player-1', first, { baseIndex: 0 }).ok, true);
    room.players[0].hand.push(second, third);
    assert.equal(executeGameAction({
        room,
        roomId: 'ROOM',
        actorId: 'player-1',
        action: { type: 'play-card', cardInstanceId: second.instanceId, baseIndex: 0 }
    }).ok, true);
    assert.equal(validatePlayCardAction(room, 'player-1', {
        type: 'play-card',
        cardInstanceId: third.instanceId,
        baseIndex: 0
    }).code, 'minion_limit_reached');
});

test('Flame Trap waits for the opposing minion ability, then destroys the minion and itself', () => {
    const trap = createCard('trickster_flame_trap_1', 'player-1');
    const room = createRoom([createBase([trap])]);
    const enchantress = createCard('wizard_enchantress_1', 'player-2');
    room.players[1].deck.push(createCard('wizard_summon_1', 'player-2'));

    assert.equal(playCard(room, 'player-2', enchantress, { baseIndex: 0 }).ok, true);
    assert.equal(room.players[1].hand.length, 1);
    assert.equal(room.players[1].discardPile.some(card => card.instanceId === enchantress.instanceId), true);
    assert.equal(room.players[0].discardPile.some(card => card.instanceId === trap.instanceId), true);
});

test('Hideout sacrifices itself and cancels an opposing action affecting its owner minion', () => {
    const hideout = createCard('trickster_hideout_1', 'player-1');
    const brownie = createCard('trickster_brownie_1', 'player-1');
    const room = createRoom([createBase([hideout, brownie])]);
    const abduction = createCard('alien_abduction_1', 'player-2');

    assert.equal(playCard(room, 'player-2', abduction, {
        baseIndex: 0,
        targetMinionInstanceId: brownie.instanceId
    }).ok, true);
    assert.equal(room.activeBases[0].playedCards.some(card => card.instanceId === brownie.instanceId), true);
    assert.equal(room.players[0].discardPile.some(card => card.instanceId === hideout.instanceId), true);
    const cancelledAction = brownie.attachedCards.find(card => card.instanceId === abduction.instanceId);
    assert.ok(cancelledAction);
    assert.deepEqual(cancelledAction.cancelledForPlayerIds, ['player-1']);
    assert.equal(room.turnState.extraMinionPlays.length, 1);
});

test('Mark of Sleep prevents the selected player from playing actions on their next turn', () => {
    const room = createRoom([createBase()]);
    const mark = createCard('trickster_mark_of_sleep_1', 'player-1');
    assert.equal(playCard(room, 'player-1', mark).ok, true);
    assert.equal(room.pendingAbility?.type, 'playerEffect');
    assert.equal(resolveChoice(room, 'player-1', { playerId: 'player-2' }).ok, true);

    room.currentTurnPlayerId = 'player-2';
    room.turnState = createInitialTurnState();
    resolveStartTurnActions(room, 'player-2');
    const action = createCard('wizard_summon_1', 'player-2');
    room.players[1].hand.push(action);
    assert.equal(validatePlayCardAction(room, 'player-2', {
        type: 'play-card',
        cardInstanceId: action.instanceId
    }).code, 'action_play_prevented');
});

test('Pay the Piper makes the opposing minion owner choose a card to discard', () => {
    const piper = createCard('trickster_pay_the_piper_1', 'player-1');
    const room = createRoom([createBase([piper])]);
    const kingRex = createCard('dino_king_1', 'player-2');
    const discardChoice = createCard('dino_howl_1', 'player-2');
    room.players[1].hand.push(discardChoice);

    assert.equal(playCard(room, 'player-2', kingRex, { baseIndex: 0 }).ok, true);
    assert.equal(room.pendingAbility?.type, 'triggeredDiscardFromHand');
    assert.equal(resolveChoice(room, 'player-2', { cardInstanceId: discardChoice.instanceId }).ok, true);
    assert.equal(room.players[1].discardPile.some(card => card.instanceId === discardChoice.instanceId), true);
});

test('Take the Shinies makes every other player discard two random cards', () => {
    const room = createRoom([createBase()], 3);
    for (const player of room.players.slice(1)) {
        player.hand.push(
            createCard('alien_scout_1', player.id),
            createCard('alien_invader_1', player.id)
        );
    }
    const shinies = createCard('trickster_take_the_shinies_1', 'player-1');

    assert.equal(playCard(room, 'player-1', shinies).ok, true);
    assert.equal(room.players[0].discardPile.some(card => card.instanceId === shinies.instanceId), true);
    assert.deepEqual(room.players.slice(1).map(player => player.hand.length), [0, 0]);
    assert.deepEqual(room.players.slice(1).map(player => player.discardPile.length), [2, 2]);
});
