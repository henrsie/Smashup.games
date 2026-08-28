const test = require('node:test');
const assert = require('node:assert/strict');
const { basesData } = require('./bases.js');
const { factionsData } = require('./factions.js');
const {
    activateTalent,
    appendChatMessage,
    baseAbilitiesAreCancelled,
    createInitialTurnState,
    getLegalActions,
    getOngoingDiscardPlayBaseIndices,
    isMinionPlayPrevented,
    isMinionProtectedFromCard,
    isMovementPrevented,
    playerIgnoresBaseAbility,
    queueSelectedPlayerBoardEffect,
    processNextTriggeredAbility,
    queueAfterMinionPlayedBaseAbilities,
    queueBeforeBaseScoringSpecials,
    queueRevealedDeckSelection,
    recalculateOngoingEffects,
    resolveEndTurnActions,
    resolveDeckReorder,
    resolveMultiZoneSelection,
    resolveSelectedPlayerBoardEffect,
    resolveSelectedPlayerBoardEffectBase,
    resolveTriggeredAbilityChoice,
    resolveStartTurnActions,
    scoreBase
} = require('./server.js');

const cardTemplates = Object.values(factionsData).flatMap(faction => faction.cards);

function createCard(cardId, ownerId = 'player-1') {
    const template = cardTemplates.find(card => card.id === cardId);
    return {
        ...template,
        cardId: template.id,
        instanceId: `${cardId}-${ownerId}-${Math.random()}`,
        ownerId,
        ownerName: ownerId,
        printedPower: template.power,
        attachedCards: []
    };
}

function createBase(baseId, playedCards = []) {
    const template = basesData.find(base => base.id === baseId);
    return { ...template, playedCards };
}

function createRoom(activeBases) {
    return {
        activeBases,
        battleLog: [],
        currentResolutionContext: null,
        pendingAbility: null,
        players: [
            { id: 'player-1', name: 'One', hand: [], deck: [], discardPile: [], vp: 0 },
            { id: 'player-2', name: 'Two', hand: [], deck: [], discardPile: [], vp: 0 }
        ],
        temporaryEffects: [],
        turnState: createInitialTurnState()
    };
}

test('room chat validates messages and retains the latest 100 entries', () => {
    const room = createRoom([createBase('base_the_homeworld')]);
    const sender = room.players[0];

    const firstResult = appendChatMessage(room, sender, '  Hello everyone!  ');
    assert.equal(firstResult.ok, true);
    assert.equal(firstResult.message.text, 'Hello everyone!');
    assert.equal(appendChatMessage(room, sender, '   ').ok, false);
    assert.equal(appendChatMessage(room, sender, 'x'.repeat(501)).ok, false);

    for (let index = 0; index < 105; index += 1) {
        appendChatMessage(room, sender, `Message ${index}`);
    }
    assert.equal(room.chatMessages.length, 100);
    assert.equal(room.chatMessages.at(-1).text, 'Message 104');
    assert.equal(room.chatMessages[0].text, 'Message 5');
});

test('every declared continuous ongoing effect has a resolver archetype', () => {
    const supportedEffectTypes = new Set([
        'addTrait',
        'cancelBaseAbilities',
        'grantDiscardPlayPermission',
        'grantProtection',
        'ignoreBaseAbility',
        'modifyPower',
        'preventMove',
        'preventPlay'
    ]);
    const cardsAndBases = [...cardTemplates, ...basesData];
    const declaredTypes = cardsAndBases
        .flatMap(card => card.abilities || [])
        .filter(ability => ability.trigger === 'ongoing')
        .flatMap(ability => ability.effects || [])
        .map(effect => effect.type);

    assert.deepEqual([...new Set(declaredTypes)].filter(type => !supportedEffectTypes.has(type)), []);
});

test('Armor Stego ongoing power applies only during other players turns', () => {
    const armorStego = createCard('dino_armor_1', 'player-1');
    const room = createRoom([createBase('base_the_homeworld', [armorStego])]);

    room.currentTurnPlayerId = 'player-1';
    recalculateOngoingEffects(room);
    assert.equal(armorStego.power, 3);

    room.currentTurnPlayerId = 'player-2';
    recalculateOngoingEffects(room);
    assert.equal(armorStego.power, 5);

    room.currentTurnPlayerId = 'player-1';
    recalculateOngoingEffects(room);
    assert.equal(armorStego.power, 3);
});

test('each Talent can only be used once per turn', () => {
    const archmage = createCard('wizard_archmage_1', 'player-1');
    const room = createRoom([createBase('base_the_homeworld', [archmage])]);

    assert.deepEqual(activateTalent(room, 'player-1', archmage.instanceId), { ok: true });
    assert.equal(room.turnState.extraActionPlays, 1);
    assert.equal(activateTalent(room, 'player-1', archmage.instanceId).ok, false);
    assert.equal(room.turnState.extraActionPlays, 1);
});

test('Ninja Acolyte returns itself and requires an immediate extra minion at its base', () => {
    const acolyte = createCard('ninja_acolyte_1', 'player-1');
    const room = createRoom([createBase('base_the_homeworld', [acolyte])]);
    room.gamePhase = 'playing';
    room.currentTurnPlayerId = 'player-1';

    assert.deepEqual(activateTalent(room, 'player-1', acolyte.instanceId), { ok: true });
    assert.equal(room.activeBases[0].playedCards.length, 0);
    assert.equal(room.players[0].hand[0].instanceId, acolyte.instanceId);
    assert.deepEqual(room.turnState.extraMinionPlays, [{
        allowedBaseIndex: 0,
        required: true,
        sourceZone: 'hand',
        sourceTalentCardInstanceId: acolyte.instanceId
    }]);
    assert.equal(room.turnState.minionPlayed, false);
});

test('Ninja Acolyte Talent is unavailable after the normal minion play', () => {
    const acolyte = createCard('ninja_acolyte_1', 'player-1');
    const room = createRoom([createBase('base_the_homeworld', [acolyte])]);
    room.turnState.minionPlayed = true;

    assert.equal(activateTalent(room, 'player-1', acolyte.instanceId).ok, false);
    assert.equal(room.activeBases[0].playedCards[0].instanceId, acolyte.instanceId);
});

test('Ninja Acolyte Talent is unavailable when no minion can be played at its base', () => {
    const acolyte = createCard('ninja_acolyte_1', 'player-1');
    const overrun = createCard('zombie_overrun_1', 'player-2');
    const room = createRoom([createBase('base_the_homeworld', [acolyte, overrun])]);
    room.gamePhase = 'playing';
    room.currentTurnPlayerId = 'player-1';
    room.players[0].hand.push(createCard('robot_microbot_guard_1', 'player-1'));

    const legalActions = getLegalActions(room, 'player-1');

    assert.equal(legalActions.some(action => (
        action.type === 'use-talent' && action.cardInstanceId === acolyte.instanceId
    )), false);
    assert.equal(legalActions.some(action => action.type === 'end-turn'), true);
    assert.equal(activateTalent(room, 'player-1', acolyte.instanceId).ok, false);
    assert.equal(room.activeBases[0].playedCards.some(card => card.instanceId === acolyte.instanceId), true);
    assert.equal(room.turnState.extraMinionPlays.length, 0);
});

test('ongoing power effects are recalculated from printed power', () => {
    const raptorOne = createCard('dino_war_raptor_1');
    const raptorTwo = createCard('dino_war_raptor_1');
    const upgrade = createCard('dino_upgrade_1');
    raptorOne.attachedCards.push(upgrade);
    const room = createRoom([createBase('base_temple_of_lie', [raptorOne, raptorTwo])]);

    recalculateOngoingEffects(room);
    assert.equal(raptorOne.power, 5);
    assert.equal(raptorTwo.power, 3);

    recalculateOngoingEffects(room);
    assert.equal(raptorOne.power, 5, 'recalculation must not stack an ongoing modifier twice');
});

test('Microbot Alpha and Fixer apply their declarative trait and power effects', () => {
    const alpha = createCard('robot_microbot_alpha_1');
    const fixer = createCard('robot_microbot_fixer_1');
    const warbot = createCard('robot_warbot_1');
    const room = createRoom([createBase('base_the_homeworld', [alpha, fixer, warbot])]);

    recalculateOngoingEffects(room);
    assert.equal(alpha.power, 4);
    assert.equal(fixer.power, 2);
    assert.equal(warbot.power, 5);
});

test('Jammed Signal cancels base restrictions and Infiltrate lets only its owner ignore them', () => {
    const greatTree = createBase('base_jungle');
    assert.equal(isMovementPrevented(greatTree, 'player-1'), true);

    greatTree.playedCards.push(createCard('ninja_infiltrate_1', 'player-1'));
    assert.equal(playerIgnoresBaseAbility(greatTree, 'player-1'), true);
    assert.equal(isMovementPrevented(greatTree, 'player-1'), false);
    assert.equal(isMovementPrevented(greatTree, 'player-2'), true);

    greatTree.playedCards.push(createCard('alien_jammed_signal_1', 'player-2'));
    assert.equal(baseAbilitiesAreCancelled(greatTree), true);
    assert.equal(isMovementPrevented(greatTree, 'player-2'), false);
});

test('protection and minion-play prevention are enforced from ongoing effects', () => {
    const protectedMinion = createCard('dino_king_1', 'player-1');
    protectedMinion.attachedCards.push(createCard('dino_tooth_1', 'player-1'));
    const base = createBase('base_the_homeworld', [
        protectedMinion,
        createCard('zombie_overrun_1', 'player-1')
    ]);
    const room = createRoom([base]);

    assert.equal(isMinionProtectedFromCard(room, base, protectedMinion, 'player-2', 'action'), true);
    assert.equal(isMinionProtectedFromCard(room, base, protectedMinion, 'player-1', 'action'), false);
    assert.equal(isMinionPlayPrevented(base, 'player-2'), true);
    assert.equal(isMinionPlayPrevented(base, 'player-1'), false);
});

test("They're Coming to Get You grants one discard play on its attached base", () => {
    const permission = createCard('zombie_they_re_coming_to_get_you_1', 'player-1');
    const room = createRoom([
        createBase('base_the_homeworld', [permission]),
        createBase('base_jungle')
    ]);

    assert.deepEqual(getOngoingDiscardPlayBaseIndices(room, 'player-1'), [0]);
    room.turnState.ongoingDiscardMinionPlayed = true;
    assert.deepEqual(getOngoingDiscardPlayBaseIndices(room, 'player-1'), []);
});

test('start-turn self-destruction removes Overrun and Infiltrate', () => {
    const overrun = createCard('zombie_overrun_1', 'player-1');
    const infiltrate = createCard('ninja_infiltrate_1', 'player-1');
    const room = createRoom([createBase('base_jungle', [overrun, infiltrate])]);

    resolveStartTurnActions(room, 'player-1');
    assert.equal(room.activeBases[0].playedCards.length, 0);
    assert.deepEqual(room.players[0].discardPile.map(card => card.cardId).sort(), [
        'ninja_infiltrate_1',
        'zombie_overrun_1'
    ]);
});

test('end-turn attached destruction and Nukebot reactions resolve', () => {
    const nukebot = createCard('robot_nukebot_1', 'player-1');
    nukebot.attachedCards.push(createCard('ninja_assassination_1', 'player-2'));
    const ally = createCard('robot_microbot_guard_1', 'player-1');
    const enemy = createCard('dino_king_1', 'player-2');
    const room = createRoom([createBase('base_the_homeworld', [nukebot, ally, enemy])]);

    resolveEndTurnActions(room);
    assert.deepEqual(room.activeBases[0].playedCards.map(card => card.cardId), [
        'robot_microbot_guard_1'
    ]);
    assert.deepEqual(room.players[0].discardPile.map(card => card.cardId), ['robot_nukebot_1']);
    assert.deepEqual(room.players[1].discardPile.map(card => card.cardId).sort(), [
        'dino_king_1',
        'ninja_assassination_1'
    ]);
});

test('Buccaneer offers a validated move instead of destruction', () => {
    const buccaneer = createCard('pirate_buccaneer_1', 'player-1');
    buccaneer.attachedCards.push(createCard('ninja_assassination_1', 'player-2'));
    const room = createRoom([
        createBase('base_the_homeworld', [buccaneer]),
        createBase('base_jungle')
    ]);

    resolveEndTurnActions(room);
    assert.equal(processNextTriggeredAbility(room, 'ROOM'), true);
    assert.equal(room.pendingAbility.type, 'triggeredBuccaneer');
    assert.equal(resolveTriggeredAbilityChoice(room, 'ROOM', { id: 'player-1' }, { baseIndex: 1 }), true);
    assert.equal(room.activeBases[0].playedCards.length, 0);
    assert.equal(room.activeBases[1].playedCards[0].cardId, 'pirate_buccaneer_1');
});

test('Microbot Archive queues its optional draw after a Microbot is destroyed', () => {
    const archive = createCard('robot_microbot_archive_1', 'player-1');
    const fixer = createCard('robot_microbot_fixer_1', 'player-1');
    fixer.attachedCards.push(createCard('ninja_assassination_1', 'player-2'));
    const room = createRoom([createBase('base_the_homeworld', [archive, fixer])]);
    room.players[0].deck.push(createCard('dino_king_1', 'player-1'));

    resolveEndTurnActions(room);
    assert.equal(processNextTriggeredAbility(room, 'ROOM'), true);
    assert.equal(room.pendingAbility.type, 'triggeredOptionalDraw');
    assert.equal(resolveTriggeredAbilityChoice(room, 'ROOM', { id: 'player-1' }, { choiceId: 'accept' }), true);
    assert.equal(room.players[0].hand.length, 1);
});

test('Broadside selects a player before selecting among eligible bases', () => {
    const broadside = createCard('pirate_broadside_1', 'player-1');
    const effect = broadside.abilities[0].effects[0];
    const firstTarget = createCard('alien_collector_1', 'player-2');
    const secondTarget = createCard('alien_collector_1', 'player-2');
    const room = createRoom([
        createBase('base_the_homeworld', [createCard('dino_king_1', 'player-1'), firstTarget]),
        createBase('base_jungle', [createCard('dino_king_1', 'player-1'), secondTarget])
    ]);
    room.currentResolutionContext = { sourceCardType: 'action' };
    const prompts = [];
    const socket = { id: 'player-1', emit: (_event, payload) => prompts.push(payload) };

    assert.equal(queueSelectedPlayerBoardEffect(room, 'ROOM', socket, effect), true);
    assert.equal(prompts[0].choices.some(choice => choice.playerId === 'player-2'), true);
    assert.equal(resolveSelectedPlayerBoardEffect(room, 'ROOM', socket, { playerId: 'player-2' }), true);
    assert.equal(room.pendingAbility.type, 'selectedPlayerBoardEffectBase');
    assert.equal(resolveSelectedPlayerBoardEffectBase(room, socket, { baseIndex: 1 }), true);
    assert.equal(room.activeBases[0].playedCards.some(card => card.instanceId === firstTarget.instanceId), true);
    assert.equal(room.activeBases[1].playedCards.some(card => card.instanceId === secondTarget.instanceId), false);
});

test('The Central Brain draws after a minion is played', () => {
    const minion = createCard('alien_collector_1', 'player-1');
    const base = createBase('base_the_plant', [minion]);
    const room = createRoom([base]);
    room.players[0].deck.push(createCard('dino_king_1', 'player-1'));

    queueAfterMinionPlayedBaseAbilities(room, base, minion);
    assert.equal(processNextTriggeredAbility(room, 'ROOM'), false);
    assert.equal(room.players[0].hand.length, 1);
});

test('The Homeworld offers its extra minion at the correct base', () => {
    const minion = createCard('alien_collector_1', 'player-1');
    const base = createBase('base_the_homeworld', [minion]);
    const room = createRoom([base]);
    room.players[0].hand.push(createCard('alien_collector_1', 'player-1'));
    const socket = { id: 'player-1' };

    queueAfterMinionPlayedBaseAbilities(room, base, minion);
    assert.equal(processNextTriggeredAbility(room, 'ROOM'), true);
    assert.equal(room.pendingAbility.type, 'triggeredBaseExtraPlay');
    assert.equal(resolveTriggeredAbilityChoice(room, 'ROOM', socket, { choiceId: 'accept' }), true);
    assert.deepEqual(room.turnState.extraMinionPlays, [{ maxPower: 2, allowedBaseIndex: 0 }]);
});

test('Tar Pits destroys a qualifying played minion after its play resolves', () => {
    const minion = createCard('alien_collector_1', 'player-1');
    const base = createBase('base_tar_pits', [minion]);
    const room = createRoom([base]);

    queueAfterMinionPlayedBaseAbilities(room, base, minion);
    assert.equal(processNextTriggeredAbility(room, 'ROOM'), false);
    assert.equal(base.playedCards.length, 0);
    assert.equal(room.players[0].discardPile[0].cardId, 'alien_collector_1');
});

test('Jammed Signal cancels triggered base abilities', () => {
    const minion = createCard('alien_collector_1', 'player-1');
    const base = createBase('base_tar_pits', [minion, createCard('alien_jammed_signal_1', 'player-2')]);
    const room = createRoom([base]);

    queueAfterMinionPlayedBaseAbilities(room, base, minion);
    assert.equal(room.triggerQueue?.length || 0, 0);
    assert.equal(base.playedCards.some(card => card.instanceId === minion.instanceId), true);
});

test('Tortuga holds the winner’s minions for an optional post-scoring move', () => {
    const winner = createCard('dino_king_1', 'player-1');
    winner.power = 23;
    const losingMinion = createCard('alien_collector_1', 'player-2');
    const room = createRoom([
        createBase('base_tortuga', [winner, losingMinion]),
        createBase('base_jungle'),
        createBase('base_the_homeworld')
    ]);
    room.baseDeck = [createBase('base_temple_of_lie')];

    scoreBase(room, 0);
    assert.equal(room.players[0].discardPile.length, 0);
    assert.equal(room.players[1].discardPile[0].instanceId, losingMinion.instanceId);
    let scoringCompleted = false;
    room.afterTriggeredAbilitiesResolved = () => { scoringCompleted = true; };
    assert.equal(processNextTriggeredAbility(room, 'ROOM'), true);
    assert.equal(room.pendingAbility.type, 'triggeredBaseWinnerMoveMinion');
    assert.equal(resolveTriggeredAbilityChoice(
        room,
        'ROOM',
        { id: 'player-1' },
        { minionInstanceId: winner.instanceId }
    ), true);
    assert.equal(resolveTriggeredAbilityChoice(room, 'ROOM', { id: 'player-1' }, { baseIndex: 1 }), true);
    assert.equal(room.activeBases[1].playedCards[0].instanceId, winner.instanceId);
    assert.equal(scoringCompleted, true);
});

test('before-scoring Specials are queued in player order starting with the active player', () => {
    const room = createRoom([createBase('base_the_homeworld')]);
    room.players.push({ id: 'player-3', name: 'Three', hand: [], deck: [], discardPile: [], vp: 0 });
    room.players.forEach(player => {
        player.hand.push(createCard('pirate_full_sail_1', player.id));
    });
    room.currentTurnPlayerId = 'player-2';

    queueBeforeBaseScoringSpecials(room, [0]);
    assert.deepEqual(room.triggerQueue.map(trigger => trigger.playerId), [
        'player-2',
        'player-3',
        'player-1'
    ]);
});

test('Shinobi can be played from hand before a base scores', () => {
    const room = createRoom([createBase('base_the_homeworld')]);
    const shinobi = createCard('ninja_shinobi_1', 'player-1');
    room.players[0].hand.push(shinobi);
    room.currentTurnPlayerId = 'player-1';

    queueBeforeBaseScoringSpecials(room, [0]);
    assert.equal(processNextTriggeredAbility(room, 'ROOM'), true);
    assert.equal(room.pendingAbility.type, 'triggeredBeforeScoreShinobi');
    assert.equal(resolveTriggeredAbilityChoice(room, 'ROOM', { id: 'player-1' }, { choiceId: 'accept' }), true);
    assert.equal(room.players[0].hand.length, 0);
    assert.equal(room.activeBases[0].playedCards[0].instanceId, shinobi.instanceId);
});

test('Hidden Ninja plays a selected minion before a base scores', () => {
    const room = createRoom([createBase('base_the_homeworld')]);
    const hiddenNinja = createCard('ninja_hidden_ninja_1', 'player-1');
    const kingRex = createCard('dino_king_1', 'player-1');
    room.players[0].hand.push(hiddenNinja, kingRex);
    room.currentTurnPlayerId = 'player-1';

    queueBeforeBaseScoringSpecials(room, [0]);
    assert.equal(processNextTriggeredAbility(room, 'ROOM'), true);
    assert.equal(room.pendingAbility.type, 'triggeredBeforeScoreHiddenNinja');
    assert.equal(resolveTriggeredAbilityChoice(room, 'ROOM', { id: 'player-1' }, { choiceId: 'accept' }), true);
    assert.equal(room.pendingAbility.type, 'triggeredBeforeScoreHiddenNinjaMinion');
    assert.equal(resolveTriggeredAbilityChoice(
        room,
        'ROOM',
        { id: 'player-1' },
        { cardInstanceId: kingRex.instanceId }
    ), true);
    assert.equal(room.players[0].discardPile[0].instanceId, hiddenNinja.instanceId);
    assert.equal(room.activeBases[0].playedCards[0].instanceId, kingRex.instanceId);
});

test('Pirate King can move to a scoring base before it scores', () => {
    const pirateKing = createCard('pirate_king_1', 'player-1');
    const room = createRoom([
        createBase('base_the_homeworld'),
        createBase('base_temple_of_lie', [pirateKing])
    ]);
    room.currentTurnPlayerId = 'player-1';

    queueBeforeBaseScoringSpecials(room, [0]);
    assert.equal(processNextTriggeredAbility(room, 'ROOM'), true);
    assert.equal(room.pendingAbility.type, 'triggeredBeforeScorePirateKing');
    assert.equal(resolveTriggeredAbilityChoice(room, 'ROOM', { id: 'player-1' }, { choiceId: 'accept' }), true);
    assert.equal(room.activeBases[0].playedCards[0].instanceId, pirateKing.instanceId);
    assert.equal(room.activeBases[1].playedCards.length, 0);
});

test('Full Sail can be played through the before-scoring window', () => {
    const room = createRoom([createBase('base_the_homeworld')]);
    const fullSail = createCard('pirate_full_sail_1', 'player-1');
    room.players[0].hand.push(fullSail);
    room.currentTurnPlayerId = 'player-1';

    queueBeforeBaseScoringSpecials(room, [0]);
    assert.equal(processNextTriggeredAbility(room, 'ROOM'), true);
    assert.equal(room.pendingAbility.type, 'triggeredBeforeScoreFullSail');
    assert.equal(resolveTriggeredAbilityChoice(room, 'ROOM', { id: 'player-1' }, { choiceId: 'accept' }), true);
    assert.equal(room.players[0].hand.length, 0);
    assert.equal(room.players[0].discardPile[0].instanceId, fullSail.instanceId);
});

test('Scout can return to hand after its base scores', () => {
    const scout = createCard('alien_scout_1', 'player-1');
    const room = createRoom([
        createBase('base_the_homeworld', [scout]),
        createBase('base_jungle')
    ]);
    room.baseDeck = [createBase('base_temple_of_lie')];
    room.currentTurnPlayerId = 'player-1';

    scoreBase(room, 0);
    assert.equal(processNextTriggeredAbility(room, 'ROOM'), true);
    assert.equal(room.pendingAbility.type, 'triggeredAfterScoreScout');
    assert.equal(resolveTriggeredAbilityChoice(room, 'ROOM', { id: 'player-1' }, { choiceId: 'accept' }), true);
    assert.equal(room.players[0].hand[0].instanceId, scout.instanceId);
    assert.equal(room.players[0].discardPile.length, 0);
});

test('First Mate can move to another base after scoring', () => {
    const firstMate = createCard('pirate_first_mate_1', 'player-1');
    const destination = createBase('base_jungle');
    const room = createRoom([
        createBase('base_the_homeworld', [firstMate]),
        destination
    ]);
    room.baseDeck = [createBase('base_temple_of_lie')];
    room.currentTurnPlayerId = 'player-1';

    scoreBase(room, 0);
    assert.equal(processNextTriggeredAbility(room, 'ROOM'), true);
    assert.equal(room.pendingAbility.type, 'triggeredAfterScoreFirstMate');
    assert.equal(resolveTriggeredAbilityChoice(room, 'ROOM', { id: 'player-1' }, { choiceId: 'accept' }), true);
    assert.equal(room.pendingAbility.type, 'triggeredAfterScoreFirstMateDestination');
    assert.equal(resolveTriggeredAbilityChoice(room, 'ROOM', { id: 'player-1' }, { baseIndex: 1 }), true);
    assert.equal(destination.playedCards[0].instanceId, firstMate.instanceId);
    assert.equal(room.players[0].discardPile.length, 0);
});

test('Portal moves selected minions to hand and reorders every unselected revealed card', () => {
    const room = createRoom([createBase('base_the_homeworld')]);
    const selectedMinion = createCard('dino_king_1', 'player-1');
    const firstAction = createCard('dino_howl_1', 'player-1');
    const unselectedMinion = createCard('alien_collector_1', 'player-1');
    const secondAction = createCard('wizard_summon_1', 'player-1');
    const thirdAction = createCard('pirate_cannon_1', 'player-1');
    const tailCard = createCard('zombie_walker_1', 'player-1');
    room.players[0].deck.push(
        selectedMinion,
        firstAction,
        unselectedMinion,
        secondAction,
        thirdAction,
        tailCard
    );
    const prompts = [];
    const socket = { id: 'player-1', emit: (_event, payload) => prompts.push(payload) };
    const effect = {
        amount: 5,
        resolve: { cardType: 'minion' }
    };

    assert.equal(queueRevealedDeckSelection(room, 'ROOM', socket, effect), true);
    assert.equal(room.pendingAbility.type, 'multiZoneSelection');
    assert.equal(resolveMultiZoneSelection(
        room,
        'ROOM',
        socket,
        { cardInstanceIds: [selectedMinion.instanceId] }
    ), true);
    assert.equal(room.players[0].hand[0].instanceId, selectedMinion.instanceId);
    assert.equal(room.pendingAbility.type, 'deckReorder');

    const requestedOrder = [
        thirdAction.instanceId,
        unselectedMinion.instanceId,
        firstAction.instanceId,
        secondAction.instanceId
    ];
    assert.equal(resolveDeckReorder(room, socket, {
        cardInstanceIds: [thirdAction.instanceId, thirdAction.instanceId]
    }), false);
    assert.equal(resolveDeckReorder(room, socket, { cardInstanceIds: requestedOrder }), true);
    assert.deepEqual(
        room.players[0].deck.map(card => card.instanceId),
        [...requestedOrder, tailCard.instanceId]
    );
    assert.equal(prompts.at(-1).selectionMode, 'ordered');
});

test('Portal still asks for an order when none of the revealed cards are minions', () => {
    const room = createRoom([createBase('base_the_homeworld')]);
    const actions = [
        createCard('dino_howl_1', 'player-1'),
        createCard('wizard_summon_1', 'player-1'),
        createCard('pirate_cannon_1', 'player-1')
    ];
    room.players[0].deck.push(...actions);
    const prompts = [];
    const socket = { id: 'player-1', emit: (_event, payload) => prompts.push(payload) };

    assert.equal(queueRevealedDeckSelection(room, 'ROOM', socket, {
        amount: 5,
        resolve: { cardType: 'minion' }
    }), true);
    assert.equal(room.pendingAbility.type, 'deckReorder');
    assert.deepEqual(room.pendingAbility.cardIds, actions.map(card => card.instanceId));
    assert.equal(prompts[0].selectionMode, 'ordered');
});
