"""Tests for migrating pre-event trajectories."""

from __future__ import annotations

import copy
import unittest

from trajectory_migration import migrate_trajectory


def old_observation(observer_id: str, current_player_id: str) -> dict:
    return {
        "schemaVersion": 4,
        "entityIdSchemaVersion": 2,
        "observerPlayerId": observer_id,
        "gamePhase": "playing",
        "currentTurnPlayerId": current_player_id,
        "players": [
            {"id": "player-1", "hand": [], "discardPile": []},
            {"id": "player-2", "hand": None, "discardPile": []},
        ],
        "activeBases": [{"id": "base_tortuga", "playedCards": []}],
        "recentBattleLog": [],
    }


def old_trajectory() -> dict:
    return {
        "schemaVersion": 4,
        "gameId": "old-game",
        "metadata": {
            "trajectorySchemaVersion": 4,
            "observationSchemaVersion": 4,
            "entityIdSchemaVersion": 2,
            "players": [
                {"seatIndex": 0, "playerId": "player-1"},
                {"seatIndex": 1, "playerId": "player-2"},
            ],
        },
        "entries": [
            {
                "decisionIndex": 0,
                "playerId": "player-1",
                "resolutionId": "resolution-1",
                "decisionType": "turnAction",
                "stepIndex": 0,
                "observation": old_observation("player-1", "player-1"),
                "chosenAction": {
                    "type": "play-card",
                    "entityIds": {
                        "cardEntityId": 3,
                        "targetCardEntityId": 0,
                        "baseEntityId": 3,
                        "factionEntityId": 0,
                        "selectedCardEntityIds": [],
                    },
                },
                "nextObservation": old_observation("player-1", "player-1"),
            },
            {
                "decisionIndex": 1,
                "playerId": "player-1",
                "resolutionId": "resolution-1",
                "decisionType": "boardEffect",
                "stepIndex": 1,
                "observation": old_observation("player-1", "player-1"),
                "chosenAction": {
                    "type": "resolve-ability-choice",
                    "choice": {"minionInstanceId": "private-target"},
                    "entityIds": {
                        "cardEntityId": 0,
                        "targetCardEntityId": 52,
                        "baseEntityId": 3,
                        "factionEntityId": 0,
                        "selectedCardEntityIds": [],
                    },
                },
                "nextObservation": old_observation("player-1", "player-2"),
            },
            {
                "decisionIndex": 2,
                "playerId": "player-2",
                "resolutionId": "resolution-2",
                "decisionType": "turnAction",
                "stepIndex": 0,
                "observation": old_observation("player-2", "player-2"),
                "chosenAction": {"type": "end-turn", "entityIds": {}},
                "nextObservation": old_observation("player-2", "player-1"),
            },
        ],
    }


class TrajectoryMigrationTests(unittest.TestCase):
    def test_v4_trajectory_is_backfilled_without_mutating_source(self) -> None:
        source = old_trajectory()
        original = copy.deepcopy(source)

        migrated = migrate_trajectory(source)

        self.assertEqual(source, original)
        self.assertEqual(migrated["schemaVersion"], 5)
        self.assertEqual(migrated["metadata"]["trajectorySchemaVersion"], 5)
        self.assertEqual(migrated["metadata"]["observationSchemaVersion"], 5)
        self.assertEqual(migrated["metadata"]["entityIdSchemaVersion"], 4)
        self.assertEqual(migrated["metadata"]["eventSchemaVersion"], 1)
        self.assertEqual(
            migrated["metadata"]["eventHistorySource"],
            "decision-backfill-v1",
        )
        self.assertFalse(
            migrated["metadata"]["migration"]["automaticOutcomeEventsReconstructed"]
        )

        first_observation = migrated["entries"][0]["observation"]
        second_observation = migrated["entries"][1]["observation"]
        opponent_observation = migrated["entries"][2]["observation"]
        self.assertEqual(first_observation["recentEvents"], [])
        self.assertEqual(second_observation["recentEvents"][0]["eventType"], "card-played")
        self.assertEqual(second_observation["recentEvents"][0]["cardEntityId"], 3)
        private_event = next(
            event
            for event in opponent_observation["recentEvents"]
            if event["eventType"] == "ability-choice-made"
        )
        self.assertEqual(private_event["targetCardEntityId"], 0)
        self.assertNotIn("privateEntityPlayerId", private_event)
        self.assertTrue(all(
            observation["schemaVersion"] == 5
            and observation["entityIdSchemaVersion"] == 4
            and observation["eventSchemaVersion"] == 1
            for observation in (
                entry["observation"]
                for entry in migrated["entries"]
            )
        ))

    def test_current_native_trajectory_is_left_unchanged(self) -> None:
        current = old_trajectory()
        current["schemaVersion"] = 5
        current["metadata"].update({
            "trajectorySchemaVersion": 5,
            "observationSchemaVersion": 5,
            "entityIdSchemaVersion": 4,
            "eventSchemaVersion": 1,
            "eventHistorySource": "native-v1",
        })

        self.assertEqual(migrate_trajectory(current), current)

    def test_v5_entity_schema_three_actions_receive_choice_features(self) -> None:
        current = old_trajectory()
        current["schemaVersion"] = 5
        current["metadata"].update({
            "trajectorySchemaVersion": 5,
            "observationSchemaVersion": 5,
            "entityIdSchemaVersion": 3,
            "eventSchemaVersion": 1,
            "eventHistorySource": "native-v1",
        })

        migrated = migrate_trajectory(current)

        self.assertEqual(migrated["metadata"]["entityIdSchemaVersion"], 4)
        self.assertEqual(
            migrated["metadata"]["actionEncodingSource"],
            "choice-features-backfill-v1",
        )
        chosen_action = migrated["entries"][1]["chosenAction"]
        self.assertEqual(chosen_action["choiceTypeId"], 3)
        self.assertIn("targetCardPosition", chosen_action["choiceFeatures"])

    def test_unsupported_older_schema_is_rejected(self) -> None:
        unsupported = old_trajectory()
        unsupported["schemaVersion"] = 3

        with self.assertRaisesRegex(ValueError, "Only trajectory schema v4"):
            migrate_trajectory(unsupported)


if __name__ == "__main__":
    unittest.main()
