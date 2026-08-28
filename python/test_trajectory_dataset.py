"""Tests for loading and validating completed trajectory JSON files."""

from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from action_embeddings import load_entity_registry
from trajectory_dataset import TrajectoryDataset, TrajectoryValidationError


def make_observation(player_id: str, *, phase: str = "playing") -> dict:
    registry = load_entity_registry()
    return {
        "schemaVersion": 5,
        "entityIdSchemaVersion": registry["schemaVersion"],
        "eventSchemaVersion": 1,
        "observerPlayerId": player_id,
        "gamePhase": phase,
        "players": [{
            "id": player_id,
            "name": "bot1",
            "hand": [],
            "discardPile": [],
        }],
        "activeBases": [],
        "recentEvents": [],
    }


def make_action() -> dict:
    registry = load_entity_registry()
    return {
        "type": "end-turn",
        "actionTypeId": registry["actionTypes"]["end-turn"],
        "choiceTypeId": registry["choiceTypes"]["none"],
        "entityIds": {
            "cardEntityId": 0,
            "targetCardEntityId": 0,
            "baseEntityId": 0,
            "factionEntityId": 0,
            "selectedCardEntityIds": [],
        },
        "choiceFeatures": {
            "sourceZoneId": 0,
            "sourceOwnerSeat": 0,
            "sourceBasePosition": 0,
            "sourceCardPosition": 0,
            "sourceParentCardPosition": 0,
            "targetZoneId": 0,
            "targetOwnerSeat": 0,
            "targetBasePosition": 0,
            "targetCardPosition": 0,
            "targetParentCardPosition": 0,
            "selectedPlayerSeat": 0,
            "chosenBasePosition": 0,
            "baseDeckPosition": 0,
            "selectionCount": 0,
            "amount": 0,
            "fromDiscard": 0,
            "candidateOrdinal": 0,
        },
    }


def make_trajectory(game_id: str, *, decision_count: int = 1) -> dict:
    registry = load_entity_registry()
    entries = []
    for decision_index in range(decision_count):
        action = make_action()
        is_last = decision_index == decision_count - 1
        entries.append({
            "decisionIndex": decision_index,
            "playerId": "bot-1",
            "resolutionId": f"resolution-{decision_index + 1}",
            "decisionType": "turnAction",
            "stepIndex": 0,
            "observation": make_observation("bot-1"),
            "legalActions": [action],
            "chosenActionIndex": 0,
            "chosenAction": copy.deepcopy(action),
            "reward": 1 if is_last else 0,
            "vpReward": 0,
            "terminalReward": 1 if is_last else 0,
            "nextObservation": make_observation(
                "bot-1",
                phase="finished" if is_last else "playing",
            ),
            "terminated": is_last,
            "truncated": False,
            "done": is_last,
        })
    return {
        "schemaVersion": 5,
        "gameId": game_id,
        "metadata": {
            "trajectorySchemaVersion": 5,
            "observationSchemaVersion": 5,
            "entityIdSchemaVersion": registry["schemaVersion"],
            "eventSchemaVersion": 1,
            "eventHistorySource": "native-v1",
            "gameId": game_id,
            "completedAt": "2026-08-28T12:00:00.000Z",
            "terminated": True,
            "truncated": False,
            "decisionCount": decision_count,
            "players": [{
                "seatIndex": 0,
                "playerId": "bot-1",
                "name": "bot1",
                "isBot": True,
                "policyVersion": "random-v1",
                "factions": [],
                "factionEntityIds": [],
                "finalVictoryPoints": 1,
            }],
        },
        "entries": entries,
    }


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


class TrajectoryDatasetTests(unittest.TestCase):
    def test_directory_is_sorted_and_flattened_into_transitions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            write_json(directory / "b.json", make_trajectory("game-b", decision_count=1))
            write_json(directory / "a.json", make_trajectory("game-a", decision_count=2))

            dataset = TrajectoryDataset(directory)

            self.assertEqual(len(dataset), 3)
            self.assertEqual([path.name for path in dataset.source_paths], ["a.json", "b.json"])
            self.assertEqual(dataset[0]["gameId"], "game-a")
            self.assertEqual(dataset[0]["chosenActionIndex"], 0)
            self.assertEqual(dataset[0]["reward"], 0.0)
            self.assertFalse(dataset[0]["done"])
            self.assertTrue(dataset[1]["terminated"])
            self.assertEqual(dataset[2]["trajectoryIndex"], 1)

    def test_file_lists_are_deduplicated_and_empty_directories_are_valid(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            trajectory_path = directory / "trajectory.json"
            empty_directory = directory / "empty"
            empty_directory.mkdir()
            write_json(trajectory_path, make_trajectory("game-1"))

            dataset = TrajectoryDataset([trajectory_path, trajectory_path])
            empty_dataset = TrajectoryDataset(empty_directory)

            self.assertEqual(len(dataset), 1)
            self.assertEqual(len(dataset.source_paths), 1)
            self.assertEqual(len(empty_dataset), 0)

    def test_invalid_json_reports_the_source_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "broken.json"
            path.write_text("{broken", encoding="utf-8")

            with self.assertRaisesRegex(TrajectoryValidationError, r"broken\.json:\$"):
                TrajectoryDataset(path)

    def test_schema_mismatch_reports_the_json_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "old.json"
            trajectory = make_trajectory("old-game")
            trajectory["metadata"]["entityIdSchemaVersion"] = 3
            write_json(path, trajectory)

            with self.assertRaisesRegex(
                TrajectoryValidationError,
                r"\$\.metadata\.entityIdSchemaVersion",
            ):
                TrajectoryDataset(path)

    def test_chosen_action_must_match_a_valid_legal_action_index(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "bad-choice.json"
            trajectory = make_trajectory("bad-choice")
            trajectory["entries"][0]["chosenActionIndex"] = 1
            write_json(path, trajectory)

            with self.assertRaisesRegex(
                TrajectoryValidationError,
                r"\$\.entries\[0\]\.chosenActionIndex",
            ):
                TrajectoryDataset(path)

    def test_unfinalized_and_duplicate_action_entries_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            unfinalized_path = directory / "unfinalized.json"
            unfinalized = make_trajectory("unfinalized")
            unfinalized["entries"][0]["reward"] = None
            write_json(unfinalized_path, unfinalized)
            with self.assertRaisesRegex(TrajectoryValidationError, r"\.reward"):
                TrajectoryDataset(unfinalized_path)

            duplicate_path = directory / "duplicate.json"
            duplicate = make_trajectory("duplicate")
            duplicate_action = copy.deepcopy(duplicate["entries"][0]["legalActions"][0])
            duplicate["entries"][0]["legalActions"].append(duplicate_action)
            write_json(duplicate_path, duplicate)
            with self.assertRaisesRegex(
                TrajectoryValidationError,
                "duplicate model encodings",
            ):
                TrajectoryDataset(duplicate_path)

    def test_event_history_source_can_be_filtered(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "migrated.json"
            trajectory = make_trajectory("migrated")
            trajectory["metadata"]["eventHistorySource"] = "decision-backfill-v1"
            write_json(path, trajectory)

            self.assertEqual(len(TrajectoryDataset(path)), 1)
            with self.assertRaisesRegex(TrajectoryValidationError, "not enabled"):
                TrajectoryDataset(path, event_history_sources=["native-v1"])


if __name__ == "__main__":
    unittest.main()
