"""Tests for the PyTorch Smash Up observation encoder."""

from __future__ import annotations

import unittest

try:
    import torch

    from action_embeddings import create_entity_embeddings, load_entity_registry
    from observation_encoder import create_observation_encoder
except ModuleNotFoundError:
    torch = None


def make_observation() -> dict:
    registry = load_entity_registry()
    return {
        "schemaVersion": 5,
        "entityIdSchemaVersion": registry["schemaVersion"],
        "observerPlayerId": "bot-1",
        "resolutionId": "resolution-8",
        "decisionType": "turnAction",
        "stepIndex": 0,
        "gamePhase": "playing",
        "hostId": "bot-1",
        "currentTurnPlayerId": "bot-1",
        "isObserverTurn": True,
        "players": [
            {
                "id": "bot-1",
                "name": "bot1",
                "isBot": True,
                "online": True,
                "vp": 4,
                "factions": ["Dinosaurs", "Robots"],
                "factionEntityIds": [
                    registry["factions"]["Dinosaurs"],
                    registry["factions"]["Robots"],
                ],
                "hand": [{
                    "id": "dino_king_1",
                    "cardId": "dino_king_1",
                    "instanceId": "king-rex-hand",
                    "name": "King Rex",
                    "type": "minion",
                    "power": 7,
                    "printedPower": 7,
                    "ownerId": "bot-1",
                    "attachedCards": [],
                }],
                "handCount": 1,
                "deckCount": 25,
                "discardPile": [],
            },
            {
                "id": "bot-2",
                "name": "bot2",
                "isBot": True,
                "online": True,
                "vp": 2,
                "factions": ["Aliens", "Wizards"],
                "factionEntityIds": [
                    registry["factions"]["Aliens"],
                    registry["factions"]["Wizards"],
                ],
                "hand": None,
                "handCount": 5,
                "deckCount": 24,
                "discardPile": [{
                    "id": "wizard_summon_1",
                    "cardId": "wizard_summon_1",
                    "instanceId": "summon-discard",
                    "name": "Summon",
                    "type": "action",
                    "ownerId": "bot-2",
                    "attachedCards": [],
                }],
            },
        ],
        "activeBases": [{
            "id": "base_tortuga",
            "name": "Tortuga",
            "breakpoint": 21,
            "vp": [3, 2, 1],
            "playedCards": [{
                "id": "robot_zapbot_1",
                "cardId": "robot_zapbot_1",
                "instanceId": "zapbot-board",
                "name": "Zapbot",
                "type": "minion",
                "power": 2,
                "printedPower": 2,
                "ownerId": "bot-1",
                "attachedCards": [],
            }],
        }],
        "baseDeckCount": 5,
        "baseDiscardPile": [],
        "turnState": {
            "actionPlayed": False,
            "minionPlayed": False,
            "actionsPlayed": 0,
            "minionsPlayed": 0,
            "extraActionPlays": 0,
            "extraMinionPlays": [],
            "ongoingDiscardMinionPlayed": False,
            "ongoingAbilityUses": {},
            "talentUses": {},
        },
        "temporaryEffects": [],
        "pendingDecision": None,
        "gameResult": None,
        "draftState": None,
        "eventSchemaVersion": 1,
        "recentEvents": [
            {
                "schemaVersion": 1,
                "sequenceNumber": 0,
                "eventType": "card-played",
                "eventTypeId": registry["eventTypes"]["card-played"],
                "actorPlayerId": "bot-1",
                "actorSeatIndex": 0,
                "targetPlayerId": None,
                "targetSeatIndex": None,
                "cardEntityId": registry["cards"]["robot_zapbot_1"],
                "targetCardEntityId": 0,
                "selectedCardEntityIds": [],
                "baseEntityId": registry["bases"]["base_tortuga"],
                "destinationBaseEntityId": 0,
                "factionEntityId": 0,
                "amount": 0,
                "count": 1,
                "resolutionId": "resolution-7",
                "stepIndex": 0,
            },
            {
                "schemaVersion": 1,
                "sequenceNumber": 1,
                "eventType": "turn-started",
                "eventTypeId": registry["eventTypes"]["turn-started"],
                "actorPlayerId": "bot-1",
                "actorSeatIndex": 0,
                "targetPlayerId": None,
                "targetSeatIndex": None,
                "cardEntityId": 0,
                "targetCardEntityId": 0,
                "selectedCardEntityIds": [],
                "baseEntityId": 0,
                "destinationBaseEntityId": 0,
                "factionEntityId": 0,
                "amount": 0,
                "count": 0,
                "resolutionId": None,
                "stepIndex": None,
            },
        ],
        "recentBattleLog": ["bot1's turn"],
    }


@unittest.skipIf(torch is None, "PyTorch is not installed in this environment.")
class ObservationEncoderTests(unittest.TestCase):
    def test_single_and_batched_observation_shapes(self) -> None:
        embeddings = create_entity_embeddings()
        encoder = create_observation_encoder(entity_embeddings=embeddings)
        observation = make_observation()

        single = encoder(observation)
        batch = encoder([observation, observation])
        empty_batch = encoder([])

        self.assertEqual(tuple(single.shape), (encoder.state_size,))
        self.assertEqual(tuple(batch.shape), (2, encoder.state_size))
        self.assertEqual(tuple(empty_batch.shape), (0, encoder.state_size))

    def test_state_changes_when_public_game_state_changes(self) -> None:
        encoder = create_observation_encoder()
        first_observation = make_observation()
        second_observation = make_observation()
        second_observation["players"][0]["vp"] = 12
        second_observation["activeBases"][0]["playedCards"][0]["power"] = 8
        second_observation["baseDiscardPile"] = [{"id": "base_the_plant"}]

        first_state = encoder(first_observation)
        second_state = encoder(second_observation)

        self.assertFalse(torch.equal(first_state, second_state))

    def test_card_base_and_faction_embeddings_are_shared_and_trainable(self) -> None:
        embeddings = create_entity_embeddings()
        encoder = create_observation_encoder(entity_embeddings=embeddings)

        encoder(make_observation()).sum().backward()

        self.assertIsNotNone(embeddings.cards.weight.grad)
        self.assertIsNotNone(embeddings.bases.weight.grad)
        self.assertIsNotNone(embeddings.event_types.weight.grad)
        self.assertIsNotNone(embeddings.factions.weight.grad)
        self.assertGreater(embeddings.cards.weight.grad.abs().sum().item(), 0)
        self.assertGreater(embeddings.bases.weight.grad.abs().sum().item(), 0)
        self.assertGreater(embeddings.event_types.weight.grad.abs().sum().item(), 0)
        self.assertGreater(embeddings.factions.weight.grad.abs().sum().item(), 0)

    def test_event_history_preserves_sequence_order(self) -> None:
        encoder = create_observation_encoder()
        chronological = make_observation()
        reversed_history = make_observation()
        reversed_history["recentEvents"] = list(reversed(reversed_history["recentEvents"]))

        chronological_state = encoder(chronological)
        reversed_state = encoder(reversed_history)

        self.assertFalse(torch.equal(chronological_state, reversed_state))

    def test_draft_and_empty_board_observations_are_supported(self) -> None:
        registry = load_entity_registry()
        encoder = create_observation_encoder()
        observation = {
            "entityIdSchemaVersion": registry["schemaVersion"],
            "observerPlayerId": "bot-1",
            "decisionType": "draftFaction",
            "gamePhase": "drafting",
            "players": [{
                "id": "bot-1",
                "factions": [],
                "factionEntityIds": [],
                "hand": [],
                "handCount": 0,
                "deckCount": 0,
                "discardPile": [],
            }],
            "activeBases": [],
            "draftState": {
                "currentPickerId": "bot-1",
                "availableFactions": ["Dinosaurs", "Aliens"],
                "availableFactionEntityIds": [
                    registry["factions"]["Dinosaurs"],
                    registry["factions"]["Aliens"],
                ],
            },
            "recentEvents": [],
        }

        encoded = encoder(observation)

        self.assertEqual(tuple(encoded.shape), (encoder.state_size,))
        self.assertTrue(torch.isfinite(encoded).all())

    def test_mismatched_entity_registry_is_rejected(self) -> None:
        encoder = create_observation_encoder()
        observation = make_observation()
        observation["entityIdSchemaVersion"] += 1

        with self.assertRaisesRegex(ValueError, "entityIdSchemaVersion"):
            encoder(observation)

    def test_mismatched_event_schema_is_rejected(self) -> None:
        encoder = create_observation_encoder()
        observation = make_observation()
        observation["eventSchemaVersion"] += 1

        with self.assertRaisesRegex(ValueError, "eventSchemaVersion"):
            encoder(observation)


if __name__ == "__main__":
    unittest.main()
