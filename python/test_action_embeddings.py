"""Tests for the PyTorch legal-action embedding module."""

from __future__ import annotations

import unittest

try:
    import torch

    from action_embeddings import create_entity_embeddings, load_entity_registry
except ModuleNotFoundError:
    torch = None


@unittest.skipIf(torch is None, "PyTorch is not installed in this environment.")
class ActionEmbeddingTests(unittest.TestCase):
    def test_registry_and_embedding_shapes(self) -> None:
        registry = load_entity_registry()
        embeddings = create_entity_embeddings()
        legal_actions = [
            {
                "type": "play-card",
                "actionTypeId": registry["actionTypes"]["play-card"],
                "choiceTypeId": registry["choiceTypes"]["none"],
                "entityIds": {
                    "cardEntityId": registry["cards"]["ninja_acolyte_1"],
                    "targetCardEntityId": 0,
                    "baseEntityId": registry["bases"]["base_tortuga"],
                    "factionEntityId": registry["factions"]["Ninjas"],
                    "selectedCardEntityIds": [],
                },
                "choiceFeatures": {
                    "sourceZoneId": registry["cardZones"]["hand"],
                    "sourceOwnerSeat": 1,
                    "sourceCardPosition": 2,
                    "chosenBasePosition": 1,
                },
            },
            {
                "type": "use-talent",
                "actionTypeId": registry["actionTypes"]["use-talent"],
                "choiceTypeId": registry["choiceTypes"]["none"],
                "entityIds": {
                    "cardEntityId": registry["cards"]["ninja_acolyte_1"],
                    "targetCardEntityId": 0,
                    "baseEntityId": 0,
                    "factionEntityId": 0,
                    "selectedCardEntityIds": [
                        registry["cards"]["robot_microbot_guard_1"],
                        registry["cards"]["robot_zapbot_1"],
                    ],
                },
                "choiceFeatures": {
                    "sourceZoneId": registry["cardZones"]["board"],
                    "sourceOwnerSeat": 1,
                    "sourceBasePosition": 1,
                    "sourceCardPosition": 1,
                },
            },
        ]

        encoded = embeddings(legal_actions)

        self.assertEqual(tuple(encoded.shape), (2, embeddings.action_embedding_size))
        self.assertFalse(torch.equal(encoded[0], encoded[1]))
        encoded.sum().backward()
        self.assertIsNotNone(embeddings.action_types.weight.grad)
        self.assertIsNotNone(embeddings.choice_types.weight.grad)
        self.assertIsNotNone(embeddings.card_zones.weight.grad)
        self.assertIsNotNone(embeddings.cards.weight.grad)

    def test_semantically_distinct_choices_have_distinct_vectors(self) -> None:
        registry = load_entity_registry()
        embeddings = create_entity_embeddings()
        shared_action = {
            "actionTypeId": registry["actionTypes"]["resolve-ability-choice"],
            "entityIds": {
                "cardEntityId": registry["cards"]["robot_zapbot_1"],
                "targetCardEntityId": 0,
                "baseEntityId": 0,
                "factionEntityId": 0,
                "selectedCardEntityIds": [],
            },
        }
        actions = [
            {
                **shared_action,
                "choiceTypeId": registry["choiceTypes"]["accept"],
                "choiceFeatures": {},
            },
            {
                **shared_action,
                "choiceTypeId": registry["choiceTypes"]["skip"],
                "choiceFeatures": {},
            },
            {
                **shared_action,
                "choiceTypeId": registry["choiceTypes"]["card"],
                "choiceFeatures": {
                    "sourceZoneId": registry["cardZones"]["hand"],
                    "sourceOwnerSeat": 1,
                    "sourceCardPosition": 1,
                },
            },
            {
                **shared_action,
                "choiceTypeId": registry["choiceTypes"]["card"],
                "choiceFeatures": {
                    "sourceZoneId": registry["cardZones"]["hand"],
                    "sourceOwnerSeat": 1,
                    "sourceCardPosition": 2,
                },
            },
            {
                **shared_action,
                "choiceTypeId": registry["choiceTypes"]["card"],
                "choiceFeatures": {"candidateOrdinal": 1},
            },
        ]

        encoded = embeddings(actions)

        for left_index, left in enumerate(encoded):
            for right in encoded[left_index + 1:]:
                self.assertFalse(torch.equal(left, right))

    def test_unknown_ids_use_the_padding_rows(self) -> None:
        embeddings = create_entity_embeddings()
        encoded = embeddings([{
            "actionTypeId": 9999,
            "entityIds": {
                "cardEntityId": 9999,
                "targetCardEntityId": None,
                "baseEntityId": -1,
                "factionEntityId": "invalid",
                "selectedCardEntityIds": [],
            },
        }])

        self.assertTrue(torch.equal(encoded, torch.zeros_like(encoded)))

    def test_empty_legal_action_list_has_a_stable_width(self) -> None:
        embeddings = create_entity_embeddings()

        encoded = embeddings([])

        self.assertEqual(tuple(encoded.shape), (0, embeddings.action_embedding_size))


if __name__ == "__main__":
    unittest.main()
