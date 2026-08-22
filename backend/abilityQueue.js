function createResolution({ playerId, effects, context }) {
  return {
    playerId,
    context,
    current: null,
    effects: effects.map(({ ability, effect }) => ({ ability, effect }))
  };
}

function getTriggeredEffects(card, trigger, effectType = null) {
  return (card?.abilities || [])
    .filter(ability => ability.trigger === trigger)
    .flatMap(ability => ability.effects || [])
    .filter(effect => !effectType || effect.type === effectType);
}

function createChoiceRequest({ type, message, choices, minSelections = 1, maxSelections = 1, canSkip = false }) {
  return {
    type,
    message,
    choices: choices.map(choice => ({ ...choice, choiceId: choice.choiceId || `${type}:${choice.id}` })),
    minSelections,
    maxSelections,
    canSkip,
    selectedChoiceIds: []
  };
}

function isChoiceIdValid(choiceRequest, choiceId) {
  return Boolean(choiceRequest?.choices.some(choice => choice.choiceId === choiceId));
}

function addSelection(choiceRequest, choiceId) {
  if (!isChoiceIdValid(choiceRequest, choiceId) || choiceRequest.selectedChoiceIds.includes(choiceId)) return false;
  if (choiceRequest.selectedChoiceIds.length >= choiceRequest.maxSelections) return false;
  choiceRequest.selectedChoiceIds.push(choiceId);
  return true;
}

function selectionIsComplete(choiceRequest, choiceId) {
  return choiceId === 'done'
    ? choiceRequest.canSkip && choiceRequest.selectedChoiceIds.length >= choiceRequest.minSelections
    : choiceRequest.selectedChoiceIds.length >= choiceRequest.maxSelections;
}

function nextEffect(resolution) {
  resolution.current = resolution.effects.shift() || null;
  return resolution.current;
}

function setChoice(resolution, choice) {
  resolution.choice = {
    choices: choice.choices,
    effect: resolution.current,
    message: choice.message,
    type: choice.type
  };
  return resolution.choice;
}

function clearChoice(resolution) {
  delete resolution.choice;
}

function isChoiceValid(resolution, choice) {
  return Boolean(resolution.choice?.choices.some(candidate => (
    candidate.baseIndex === choice.baseIndex
    && candidate.minionInstanceId === choice.minionInstanceId
  )));
}

module.exports = {
  clearChoice,
  createResolution,
  createChoiceRequest,
  getTriggeredEffects,
  addSelection,
  isChoiceIdValid,
  selectionIsComplete,
  isChoiceValid,
  nextEffect,
  setChoice
};
