const test = require('node:test');
const assert = require('node:assert/strict');
const {
    BOT_POLICY_VERSIONS,
    chooseGreedyHeuristic1ActionIndex,
    chooseGreedyHeuristic2ActionIndex,
    getBotPolicy,
    getExtraPlayCount
} = require('./botPolicies.js');

function createObservation({ hand = [], activeBases = [], pendingDecision = null } = {}) {
    return {
        observerPlayerId: 'bot-1',
        gamePhase: 'playing',
        pendingDecision,
        players: [{ id: 'bot-1', hand, discardPile: [] }],
        activeBases
    };
}

function createCard(instanceId, type, options = {}) {
    return {
        instanceId,
        type,
        power: options.power,
        printedPower: options.power,
        abilities: options.abilities || []
    };
}

test('greedy heuristic chooses talents before card plays', () => {
    const legalActions = [
        { type: 'play-card', cardInstanceId: 'minion-1', baseIndex: 0 },
        { type: 'use-talent', cardInstanceId: 'talent-1' },
        { type: 'use-talent', cardInstanceId: 'talent-2' },
        { type: 'end-turn' }
    ];
    const observation = createObservation({
        hand: [createCard('minion-1', 'minion', { power: 5 })],
        activeBases: [{ playedCards: [] }]
    });

    assert.equal(chooseGreedyHeuristic1ActionIndex({
        legalActions,
        observation,
        random: () => 0.99
    }), 2);
});

test('greedy heuristic resolves prompted choices randomly', () => {
    const legalActions = [0, 1, 2].map(choiceId => ({
        type: 'resolve-ability-choice',
        choice: { choiceId }
    }));
    const observation = createObservation({ pendingDecision: { type: 'confirmation' } });

    assert.equal(chooseGreedyHeuristic1ActionIndex({
        legalActions,
        observation,
        random: () => 0.5
    }), 1);
});

test('greedy heuristic plays the strongest minion at the base with most total power', () => {
    const legalActions = [
        { type: 'play-card', cardInstanceId: 'weak', baseIndex: 0 },
        { type: 'play-card', cardInstanceId: 'weak', baseIndex: 1 },
        { type: 'play-card', cardInstanceId: 'strong', baseIndex: 0 },
        { type: 'play-card', cardInstanceId: 'strong', baseIndex: 1 },
        { type: 'end-turn' }
    ];
    const observation = createObservation({
        hand: [
            createCard('weak', 'minion', { power: 2 }),
            createCard('strong', 'minion', { power: 5 })
        ],
        activeBases: [
            { playedCards: [createCard('board-1', 'minion', { power: 3 })] },
            { playedCards: [createCard('board-2', 'minion', { power: 8 })] }
        ]
    });

    assert.equal(chooseGreedyHeuristic1ActionIndex({
        legalActions,
        observation,
        random: () => 0
    }), 3);
});

test('greedy heuristic 2 plays the strongest minion at the least-full base', () => {
    const legalActions = [
        { type: 'play-card', cardInstanceId: 'weak', baseIndex: 0 },
        { type: 'play-card', cardInstanceId: 'weak', baseIndex: 1 },
        { type: 'play-card', cardInstanceId: 'strong', baseIndex: 0 },
        { type: 'play-card', cardInstanceId: 'strong', baseIndex: 1 },
        { type: 'end-turn' }
    ];
    const observation = createObservation({
        hand: [
            createCard('weak', 'minion', { power: 2 }),
            createCard('strong', 'minion', { power: 5 })
        ],
        activeBases: [
            { playedCards: [createCard('board-1', 'minion', { power: 3 })] },
            { playedCards: [createCard('board-2', 'minion', { power: 8 })] }
        ]
    });

    assert.equal(chooseGreedyHeuristic2ActionIndex({
        legalActions,
        observation,
        random: () => 0
    }), 2);
});

test('greedy heuristic 2 breaks equally empty base ties randomly', () => {
    const legalActions = [
        { type: 'play-card', cardInstanceId: 'strong', baseIndex: 0 },
        { type: 'play-card', cardInstanceId: 'strong', baseIndex: 1 },
        { type: 'end-turn' }
    ];
    const observation = createObservation({
        hand: [createCard('strong', 'minion', { power: 5 })],
        activeBases: [
            { playedCards: [] },
            { playedCards: [] }
        ]
    });

    assert.equal(chooseGreedyHeuristic2ActionIndex({
        legalActions,
        observation,
        random: () => 0.99
    }), 1);
    assert.equal(
        getBotPolicy(BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_2),
        chooseGreedyHeuristic2ActionIndex
    );
});

test('greedy heuristic prioritizes the action card granting the most extra plays', () => {
    const extraPlays = amount => [{
        trigger: 'onPlay',
        effects: [{ type: 'grantExtraPlay', cardType: 'action', amount }]
    }];
    const legalActions = [
        { type: 'play-card', cardInstanceId: 'ordinary' },
        { type: 'play-card', cardInstanceId: 'one-extra' },
        { type: 'play-card', cardInstanceId: 'two-extra' },
        { type: 'end-turn' }
    ];
    const observation = createObservation({
        hand: [
            createCard('ordinary', 'action'),
            createCard('one-extra', 'action', { abilities: extraPlays(1) }),
            createCard('two-extra', 'action', { abilities: extraPlays(2) })
        ]
    });

    assert.equal(chooseGreedyHeuristic1ActionIndex({
        legalActions,
        observation,
        random: () => 0
    }), 2);
});

test('extra-play ranking understands declarative repeated and nested plays', () => {
    const repeatedPlayCard = createCard('repeated', 'action', {
        abilities: [{
            trigger: 'onPlay',
            effects: [
                {
                    type: 'grantExtraPlay',
                    amount: { type: 'selectedCount' },
                    cardType: 'minion'
                },
                {
                    type: 'returnToHand',
                    target: { kind: 'minion', quantity: { min: 1, max: 2 } }
                }
            ]
        }]
    });
    const nestedPlayCard = createCard('nested', 'action', {
        abilities: [{
            trigger: 'onPlay',
            effects: [{
                type: 'revealTopDeckCard',
                resolve: { type: 'playRevealedCard', extra: true }
            }]
        }]
    });

    assert.equal(getExtraPlayCount(repeatedPlayCard), 2);
    assert.equal(getExtraPlayCount(nestedPlayCard), 1);
});

test('greedy heuristic plays a random action card before ending its turn', () => {
    const legalActions = [
        { type: 'play-card', cardInstanceId: 'action-1' },
        { type: 'play-card', cardInstanceId: 'action-2' },
        { type: 'end-turn' }
    ];
    const observation = createObservation({
        hand: [
            createCard('action-1', 'action'),
            createCard('action-2', 'action')
        ]
    });

    assert.equal(chooseGreedyHeuristic1ActionIndex({
        legalActions,
        observation,
        random: () => 0.99
    }), 1);
    assert.equal(
        getBotPolicy(BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_1),
        chooseGreedyHeuristic1ActionIndex
    );
});
