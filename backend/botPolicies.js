const { systemRandom } = require('./random.js');

const BOT_POLICY_VERSIONS = Object.freeze({
    RANDOM: 'random-v1',
    GREEDY_HEURISTIC_1: 'greedy_heuristic_1',
    GREEDY_HEURISTIC_2: 'greedy_heuristic_2'
});

function chooseRandomCandidateIndex(candidateIndices, random = systemRandom) {
    if (!candidateIndices.length) return null;
    const randomIndex = Math.min(
        Math.floor(random() * candidateIndices.length),
        candidateIndices.length - 1
    );
    return candidateIndices[randomIndex];
}

function chooseRandomActionIndex({ legalActions, random = systemRandom }) {
    return chooseRandomCandidateIndex(
        legalActions.map((action, actionIndex) => actionIndex),
        random
    );
}

function getObserver(observation) {
    return observation?.players?.find(player => player.id === observation.observerPlayerId) || null;
}

function getPlayableCardByInstanceId(observation, cardInstanceId) {
    const observer = getObserver(observation);
    return [...(observer?.hand || []), ...(observer?.discardPile || [])]
        .find(card => card.instanceId === cardInstanceId) || null;
}

function getCardPower(card) {
    if (Number.isFinite(card?.power)) return card.power;
    if (Number.isFinite(card?.printedPower)) return card.printedPower;
    return 0;
}

function getBaseTotalPower(base) {
    return (base?.playedCards || [])
        .filter(card => card.type === 'minion')
        .reduce((total, minion) => total + getCardPower(minion), 0);
}

function getMaximumSelectionCount(node) {
    if (Array.isArray(node)) {
        return Math.max(0, ...node.map(getMaximumSelectionCount));
    }
    if (!node || typeof node !== 'object') return 0;
    const ownMaximum = Number.isFinite(node.quantity?.max) ? node.quantity.max : 0;
    return Math.max(ownMaximum, ...Object.values(node).map(getMaximumSelectionCount));
}

function getExtraPlayAmount(amount, ability) {
    if (Number.isFinite(amount)) return Math.max(0, amount);
    if (amount?.type === 'selectedCount') return getMaximumSelectionCount(ability);
    return 1;
}

function countExtraPlays(node, ability) {
    if (Array.isArray(node)) {
        return node.reduce((total, item) => total + countExtraPlays(item, ability), 0);
    }
    if (!node || typeof node !== 'object') return 0;

    const grantsExtraPlay = node.type === 'grantExtraPlay'
        || node.type === 'grantExtraPlayFromDiscard';
    const playsSomethingExtra = node.extra === true
        && typeof node.type === 'string'
        && node.type.toLowerCase().includes('play');
    const ownExtraPlays = grantsExtraPlay || playsSomethingExtra
        ? getExtraPlayAmount(node.amount, ability)
        : 0;
    return ownExtraPlays + Object.values(node).reduce((total, child) => (
        total + countExtraPlays(child, ability)
    ), 0);
}

function getExtraPlayCount(card) {
    return (card?.abilities || [])
        .filter(ability => ability.trigger === 'onPlay')
        .reduce((total, ability) => total + countExtraPlays(ability.effects || [], ability), 0);
}

function chooseHighestScoringActionIndex(actionIndices, getScore, random) {
    if (!actionIndices.length) return null;
    const scores = actionIndices.map(actionIndex => getScore(actionIndex));
    const highestScore = Math.max(...scores);
    const tiedIndices = actionIndices.filter((actionIndex, index) => scores[index] === highestScore);
    return chooseRandomCandidateIndex(tiedIndices, random);
}

function chooseLowestScoringActionIndex(actionIndices, getScore, random) {
    if (!actionIndices.length) return null;
    const scores = actionIndices.map(actionIndex => getScore(actionIndex));
    const lowestScore = Math.min(...scores);
    const tiedIndices = actionIndices.filter((actionIndex, index) => scores[index] === lowestScore);
    return chooseRandomCandidateIndex(tiedIndices, random);
}

function chooseGreedyHeuristicActionIndex({
    legalActions,
    observation,
    random = systemRandom,
    preferLeastFullBase = false
}) {
    if (!legalActions.length) return null;

    const allActionIndices = legalActions.map((action, actionIndex) => actionIndex);
    if (observation?.pendingDecision || observation?.gamePhase === 'drafting') {
        return chooseRandomCandidateIndex(allActionIndices, random);
    }

    const talentIndices = allActionIndices.filter(actionIndex => (
        legalActions[actionIndex].type === 'use-talent'
    ));
    if (talentIndices.length > 0) {
        return chooseRandomCandidateIndex(talentIndices, random);
    }

    const cardsByActionIndex = new Map(allActionIndices.map(actionIndex => [
        actionIndex,
        legalActions[actionIndex].type === 'play-card'
            ? getPlayableCardByInstanceId(observation, legalActions[actionIndex].cardInstanceId)
            : null
    ]));
    const minionIndices = allActionIndices.filter(actionIndex => (
        cardsByActionIndex.get(actionIndex)?.type === 'minion'
    ));
    if (minionIndices.length > 0) {
        const strongestPower = Math.max(...minionIndices.map(actionIndex => (
            getCardPower(cardsByActionIndex.get(actionIndex))
        )));
        const strongestMinionIndices = minionIndices.filter(actionIndex => (
            getCardPower(cardsByActionIndex.get(actionIndex)) === strongestPower
        ));
        const chooseBaseIndex = preferLeastFullBase
            ? chooseLowestScoringActionIndex
            : chooseHighestScoringActionIndex;
        return chooseBaseIndex(
            strongestMinionIndices,
            actionIndex => {
                const action = legalActions[actionIndex];
                const base = observation?.activeBases?.[action.baseIndex];
                return getBaseTotalPower(base) + getCardPower(cardsByActionIndex.get(actionIndex));
            },
            random
        );
    }

    const actionCardIndices = allActionIndices.filter(actionIndex => (
        cardsByActionIndex.get(actionIndex)?.type === 'action'
    ));
    if (actionCardIndices.length > 0) {
        const extraPlayIndices = actionCardIndices.filter(actionIndex => (
            getExtraPlayCount(cardsByActionIndex.get(actionIndex)) > 0
        ));
        if (extraPlayIndices.length > 0) {
            return chooseHighestScoringActionIndex(
                extraPlayIndices,
                actionIndex => getExtraPlayCount(cardsByActionIndex.get(actionIndex)),
                random
            );
        }
        return chooseRandomCandidateIndex(actionCardIndices, random);
    }

    return chooseRandomCandidateIndex(allActionIndices, random);
}

function chooseGreedyHeuristic1ActionIndex(context) {
    return chooseGreedyHeuristicActionIndex(context);
}

function chooseGreedyHeuristic2ActionIndex(context) {
    return chooseGreedyHeuristicActionIndex({
        ...context,
        preferLeastFullBase: true
    });
}

function getBotPolicy(policyVersion) {
    if (policyVersion === BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_1) {
        return chooseGreedyHeuristic1ActionIndex;
    }
    if (policyVersion === BOT_POLICY_VERSIONS.GREEDY_HEURISTIC_2) {
        return chooseGreedyHeuristic2ActionIndex;
    }
    if (policyVersion === BOT_POLICY_VERSIONS.RANDOM) return chooseRandomActionIndex;
    return null;
}

module.exports = {
    BOT_POLICY_VERSIONS,
    chooseGreedyHeuristic1ActionIndex,
    chooseGreedyHeuristic2ActionIndex,
    chooseRandomActionIndex,
    getBotPolicy,
    getExtraPlayCount
};
