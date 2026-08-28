"""Validated PyTorch dataset for completed Smash Up trajectory JSON files."""

from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from torch.utils.data import Dataset

from action_embeddings import DEFAULT_REGISTRY_PATH, load_entity_registry


DEFAULT_TRAJECTORY_DIRECTORY = (
    Path(__file__).resolve().parents[1] / "training-data" / "trajectories"
)
TRAJECTORY_SCHEMA_VERSION = 5
OBSERVATION_SCHEMA_VERSION = 5
EVENT_SCHEMA_VERSION = 1
SUPPORTED_EVENT_HISTORY_SOURCES = frozenset({
    "native-v1",
    "decision-backfill-v1",
})
REQUIRED_ENTITY_ID_FIELDS = {
    "cardEntityId": "cards",
    "targetCardEntityId": "cards",
    "baseEntityId": "bases",
    "factionEntityId": "factions",
}
REQUIRED_CHOICE_INTEGER_FEATURES = (
    "sourceZoneId",
    "sourceOwnerSeat",
    "sourceBasePosition",
    "sourceCardPosition",
    "sourceParentCardPosition",
    "targetZoneId",
    "targetOwnerSeat",
    "targetBasePosition",
    "targetCardPosition",
    "targetParentCardPosition",
    "selectedPlayerSeat",
    "chosenBasePosition",
    "baseDeckPosition",
    "selectionCount",
    "fromDiscard",
    "candidateOrdinal",
)


class TrajectoryValidationError(ValueError):
    """A trajectory file does not satisfy the training-data contract."""

    def __init__(self, source: Path, json_path: str, message: str) -> None:
        self.source = source
        self.json_path = json_path
        self.message = message
        super().__init__(f"{source}:{json_path}: {message}")


def _is_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


class _TrajectoryValidator:
    def __init__(
        self,
        source: Path,
        registry: Mapping[str, Any],
        allowed_event_history_sources: frozenset[str],
    ) -> None:
        self.source = source
        self.registry = registry
        self.allowed_event_history_sources = allowed_event_history_sources
        self.unknown_id = int(registry["unknownId"])
        self.valid_ids = {
            namespace: frozenset(mapping.values()) | {self.unknown_id}
            for namespace, mapping in registry.items()
            if isinstance(mapping, Mapping)
        }

    def fail(self, json_path: str, message: str) -> None:
        raise TrajectoryValidationError(self.source, json_path, message)

    def require_mapping(self, value: Any, json_path: str) -> Mapping[str, Any]:
        if not isinstance(value, Mapping):
            self.fail(json_path, "must be a JSON object")
        return value

    def require_list(self, value: Any, json_path: str) -> list[Any]:
        if not isinstance(value, list):
            self.fail(json_path, "must be a JSON array")
        return value

    def require_version(
        self,
        value: Any,
        expected: int,
        json_path: str,
    ) -> None:
        if value != expected:
            self.fail(json_path, f"must equal supported schema version {expected}")

    def validate_observation(
        self,
        value: Any,
        json_path: str,
        player_id: str,
    ) -> None:
        observation = self.require_mapping(value, json_path)
        self.require_version(
            observation.get("schemaVersion"),
            OBSERVATION_SCHEMA_VERSION,
            f"{json_path}.schemaVersion",
        )
        self.require_version(
            observation.get("entityIdSchemaVersion"),
            int(self.registry["schemaVersion"]),
            f"{json_path}.entityIdSchemaVersion",
        )
        self.require_version(
            observation.get("eventSchemaVersion"),
            EVENT_SCHEMA_VERSION,
            f"{json_path}.eventSchemaVersion",
        )
        if observation.get("observerPlayerId") != player_id:
            self.fail(
                f"{json_path}.observerPlayerId",
                "must match the transition playerId",
            )
        if not isinstance(observation.get("gamePhase"), str):
            self.fail(f"{json_path}.gamePhase", "must be a string")
        players = self.require_list(observation.get("players"), f"{json_path}.players")
        if not players:
            self.fail(f"{json_path}.players", "must contain at least one player")
        if not any(
            isinstance(player, Mapping) and player.get("id") == player_id
            for player in players
        ):
            self.fail(f"{json_path}.players", "must contain the transition player")
        self.require_list(observation.get("activeBases"), f"{json_path}.activeBases")
        recent_events = self.require_list(
            observation.get("recentEvents"),
            f"{json_path}.recentEvents",
        )
        previous_sequence_number = -1
        for event_index, raw_event in enumerate(recent_events):
            event_path = f"{json_path}.recentEvents[{event_index}]"
            event = self.require_mapping(raw_event, event_path)
            self.require_version(
                event.get("schemaVersion"),
                EVENT_SCHEMA_VERSION,
                f"{event_path}.schemaVersion",
            )
            sequence_number = event.get("sequenceNumber")
            if not _is_integer(sequence_number) or sequence_number <= previous_sequence_number:
                self.fail(
                    f"{event_path}.sequenceNumber",
                    "must be a strictly increasing non-negative integer",
                )
            previous_sequence_number = sequence_number
            event_type = event.get("eventType")
            if not isinstance(event_type, str) or event_type not in self.registry["eventTypes"]:
                self.fail(f"{event_path}.eventType", "must be a registered event type")
            if event.get("eventTypeId") != self.registry["eventTypes"][event_type]:
                self.fail(
                    f"{event_path}.eventTypeId",
                    f"must match the registered ID for {event_type!r}",
                )
            for field, namespace in {
                "cardEntityId": "cards",
                "targetCardEntityId": "cards",
                "baseEntityId": "bases",
                "destinationBaseEntityId": "bases",
                "factionEntityId": "factions",
            }.items():
                self.validate_entity_id(
                    event.get(field),
                    namespace,
                    f"{event_path}.{field}",
                )
            selected_ids = self.require_list(
                event.get("selectedCardEntityIds"),
                f"{event_path}.selectedCardEntityIds",
            )
            for selected_index, entity_id in enumerate(selected_ids):
                self.validate_entity_id(
                    entity_id,
                    "cards",
                    f"{event_path}.selectedCardEntityIds[{selected_index}]",
                )
            for numeric_field in ("amount", "count"):
                if not _is_finite_number(event.get(numeric_field)):
                    self.fail(
                        f"{event_path}.{numeric_field}",
                        "must be a finite number",
                    )

    def validate_entity_id(
        self,
        value: Any,
        namespace: str,
        json_path: str,
    ) -> None:
        if not _is_integer(value) or value not in self.valid_ids[namespace]:
            self.fail(json_path, f"must be a registered {namespace} ID")

    @staticmethod
    def expected_choice_type(action: Mapping[str, Any]) -> str:
        choice_value = action.get("choice")
        choice = choice_value if isinstance(choice_value, Mapping) else {}
        if choice.get("cancel") is True:
            return "cancel"
        if choice.get("finishSelection") is True:
            return "finish-selection"
        if choice.get("skip") is True or choice.get("choiceId") == "skip":
            return "skip"
        choice_ids = {
            "accept": "accept",
            "discard": "discard",
            "return": "return",
            "hand": "hand",
            "playExtra": "play-extra",
        }
        if choice.get("choiceId") in choice_ids:
            return choice_ids[choice["choiceId"]]
        if choice.get("minionInstanceId") or action.get("targetMinionInstanceId"):
            return "minion"
        if choice.get("cardInstanceId"):
            return "card"
        if _is_integer(choice.get("baseIndex")) or choice.get("baseInstanceId"):
            return "base"
        if choice.get("playerId"):
            return "player"
        if choice.get("faction"):
            return "faction"
        if _is_finite_number(choice.get("amount")):
            return "amount"
        return "none"

    def validate_action(self, value: Any, json_path: str) -> Mapping[str, Any]:
        action = self.require_mapping(value, json_path)
        action_type = action.get("type")
        if not isinstance(action_type, str) or action_type not in self.registry["actionTypes"]:
            self.fail(f"{json_path}.type", "must be a registered action type")
        expected_action_type_id = self.registry["actionTypes"][action_type]
        if action.get("actionTypeId") != expected_action_type_id:
            self.fail(
                f"{json_path}.actionTypeId",
                f"must equal {expected_action_type_id} for {action_type!r}",
            )
        self.validate_entity_id(
            action.get("choiceTypeId"),
            "choiceTypes",
            f"{json_path}.choiceTypeId",
        )
        if action.get("choiceTypeId") == self.unknown_id:
            self.fail(f"{json_path}.choiceTypeId", "cannot use the unknown ID")
        expected_choice_type = self.expected_choice_type(action)
        expected_choice_type_id = self.registry["choiceTypes"][expected_choice_type]
        if action.get("choiceTypeId") != expected_choice_type_id:
            self.fail(
                f"{json_path}.choiceTypeId",
                f"must equal {expected_choice_type_id} for choice type {expected_choice_type!r}",
            )

        entity_ids = self.require_mapping(
            action.get("entityIds"),
            f"{json_path}.entityIds",
        )
        for field, namespace in REQUIRED_ENTITY_ID_FIELDS.items():
            self.validate_entity_id(
                entity_ids.get(field),
                namespace,
                f"{json_path}.entityIds.{field}",
            )
        selected_ids = self.require_list(
            entity_ids.get("selectedCardEntityIds"),
            f"{json_path}.entityIds.selectedCardEntityIds",
        )
        for selected_index, entity_id in enumerate(selected_ids):
            self.validate_entity_id(
                entity_id,
                "cards",
                f"{json_path}.entityIds.selectedCardEntityIds[{selected_index}]",
            )

        features = self.require_mapping(
            action.get("choiceFeatures"),
            f"{json_path}.choiceFeatures",
        )
        for field in REQUIRED_CHOICE_INTEGER_FEATURES:
            feature = features.get(field)
            if not _is_integer(feature) or feature < 0:
                self.fail(
                    f"{json_path}.choiceFeatures.{field}",
                    "must be a non-negative integer",
                )
        if features["fromDiscard"] not in (0, 1):
            self.fail(
                f"{json_path}.choiceFeatures.fromDiscard",
                "must be either 0 or 1",
            )
        self.validate_entity_id(
            features["sourceZoneId"],
            "cardZones",
            f"{json_path}.choiceFeatures.sourceZoneId",
        )
        self.validate_entity_id(
            features["targetZoneId"],
            "cardZones",
            f"{json_path}.choiceFeatures.targetZoneId",
        )
        if not _is_finite_number(features.get("amount")):
            self.fail(
                f"{json_path}.choiceFeatures.amount",
                "must be a finite number",
            )
        return action

    def validate_entry(
        self,
        value: Any,
        entry_index: int,
    ) -> dict[str, Any]:
        json_path = f"$.entries[{entry_index}]"
        entry = self.require_mapping(value, json_path)
        if entry.get("decisionIndex") != entry_index:
            self.fail(
                f"{json_path}.decisionIndex",
                f"must equal its zero-based entry position {entry_index}",
            )
        player_id = entry.get("playerId")
        if not isinstance(player_id, str) or not player_id:
            self.fail(f"{json_path}.playerId", "must be a non-empty string")
        self.validate_observation(
            entry.get("observation"),
            f"{json_path}.observation",
            player_id,
        )
        self.validate_observation(
            entry.get("nextObservation"),
            f"{json_path}.nextObservation",
            player_id,
        )

        legal_actions = self.require_list(
            entry.get("legalActions"),
            f"{json_path}.legalActions",
        )
        if not legal_actions:
            self.fail(f"{json_path}.legalActions", "must not be empty")
        encoding_keys = []
        for action_index, action in enumerate(legal_actions):
            validated_action = self.validate_action(
                action,
                f"{json_path}.legalActions[{action_index}]",
            )
            encoding_keys.append(json.dumps({
                "actionTypeId": validated_action["actionTypeId"],
                "choiceTypeId": validated_action["choiceTypeId"],
                "entityIds": validated_action["entityIds"],
                "choiceFeatures": validated_action["choiceFeatures"],
            }, sort_keys=True, separators=(",", ":")))
        if len(encoding_keys) != len(set(encoding_keys)):
            self.fail(
                f"{json_path}.legalActions",
                "contains actions with duplicate model encodings",
            )

        chosen_action_index = entry.get("chosenActionIndex")
        if (
            not _is_integer(chosen_action_index)
            or not 0 <= chosen_action_index < len(legal_actions)
        ):
            self.fail(
                f"{json_path}.chosenActionIndex",
                "must index an entry in legalActions",
            )
        self.validate_action(entry.get("chosenAction"), f"{json_path}.chosenAction")
        if entry.get("chosenAction") != legal_actions[chosen_action_index]:
            self.fail(
                f"{json_path}.chosenAction",
                "must exactly match legalActions[chosenActionIndex]",
            )

        for reward_field in ("reward", "vpReward", "terminalReward"):
            if not _is_finite_number(entry.get(reward_field)):
                self.fail(
                    f"{json_path}.{reward_field}",
                    "must be a finite number",
                )
        for flag in ("terminated", "truncated", "done"):
            if not isinstance(entry.get(flag), bool):
                self.fail(f"{json_path}.{flag}", "must be a boolean")
        if entry["terminated"] and entry["truncated"]:
            self.fail(json_path, "cannot be both terminated and truncated")
        if entry["done"] != (entry["terminated"] or entry["truncated"]):
            self.fail(
                f"{json_path}.done",
                "must equal terminated OR truncated",
            )
        return dict(entry)

    def validate(self, value: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        trajectory = self.require_mapping(value, "$")
        metadata = self.require_mapping(trajectory.get("metadata"), "$.metadata")
        self.require_version(
            trajectory.get("schemaVersion"),
            TRAJECTORY_SCHEMA_VERSION,
            "$.schemaVersion",
        )
        self.require_version(
            metadata.get("trajectorySchemaVersion"),
            TRAJECTORY_SCHEMA_VERSION,
            "$.metadata.trajectorySchemaVersion",
        )
        self.require_version(
            metadata.get("observationSchemaVersion"),
            OBSERVATION_SCHEMA_VERSION,
            "$.metadata.observationSchemaVersion",
        )
        self.require_version(
            metadata.get("entityIdSchemaVersion"),
            int(self.registry["schemaVersion"]),
            "$.metadata.entityIdSchemaVersion",
        )
        self.require_version(
            metadata.get("eventSchemaVersion"),
            EVENT_SCHEMA_VERSION,
            "$.metadata.eventSchemaVersion",
        )
        event_history_source = metadata.get("eventHistorySource")
        if event_history_source not in self.allowed_event_history_sources:
            self.fail(
                "$.metadata.eventHistorySource",
                "is not enabled for this dataset",
            )

        game_id = trajectory.get("gameId")
        if not isinstance(game_id, str) or not game_id:
            self.fail("$.gameId", "must be a non-empty string")
        if metadata.get("gameId") != game_id:
            self.fail("$.metadata.gameId", "must match $.gameId")
        metadata_players = self.require_list(
            metadata.get("players"),
            "$.metadata.players",
        )
        if not metadata_players:
            self.fail("$.metadata.players", "must contain at least one player")
        seen_player_ids: set[str] = set()
        seen_seats: set[int] = set()
        for player_index, raw_player in enumerate(metadata_players):
            player_path = f"$.metadata.players[{player_index}]"
            player = self.require_mapping(raw_player, player_path)
            player_id = player.get("playerId")
            if not isinstance(player_id, str) or not player_id:
                self.fail(f"{player_path}.playerId", "must be a non-empty string")
            if player_id in seen_player_ids:
                self.fail(f"{player_path}.playerId", "must be unique")
            seen_player_ids.add(player_id)
            seat_index = player.get("seatIndex")
            if not _is_integer(seat_index) or seat_index < 0:
                self.fail(f"{player_path}.seatIndex", "must be a non-negative integer")
            if seat_index in seen_seats:
                self.fail(f"{player_path}.seatIndex", "must be unique")
            seen_seats.add(seat_index)
            factions = self.require_list(player.get("factions"), f"{player_path}.factions")
            faction_ids = self.require_list(
                player.get("factionEntityIds"),
                f"{player_path}.factionEntityIds",
            )
            if len(factions) != len(faction_ids):
                self.fail(
                    f"{player_path}.factionEntityIds",
                    "must have one ID for every faction name",
                )
            for faction_index, (faction, faction_id) in enumerate(zip(factions, faction_ids)):
                expected_faction_id = self.registry["factions"].get(faction)
                if faction_id != expected_faction_id:
                    self.fail(
                        f"{player_path}.factionEntityIds[{faction_index}]",
                        "must match the corresponding registered faction",
                    )
            if not _is_finite_number(player.get("finalVictoryPoints")):
                self.fail(
                    f"{player_path}.finalVictoryPoints",
                    "must be a finite number",
                )
        entries = self.require_list(trajectory.get("entries"), "$.entries")
        if not entries:
            self.fail("$.entries", "must contain at least one transition")
        if metadata.get("decisionCount") != len(entries):
            self.fail(
                "$.metadata.decisionCount",
                "must equal the number of trajectory entries",
            )

        for flag in ("terminated", "truncated"):
            if not isinstance(metadata.get(flag), bool):
                self.fail(f"$.metadata.{flag}", "must be a boolean")
        if metadata["terminated"] == metadata["truncated"]:
            self.fail(
                "$.metadata",
                "must describe exactly one completed outcome: terminated or truncated",
            )
        if not isinstance(metadata.get("completedAt"), str) or not metadata["completedAt"]:
            self.fail("$.metadata.completedAt", "must identify a completed episode")

        validated_entries = [
            self.validate_entry(entry, entry_index)
            for entry_index, entry in enumerate(entries)
        ]
        terminal_field = "terminated" if metadata["terminated"] else "truncated"
        if not any(entry[terminal_field] for entry in validated_entries):
            self.fail(
                "$.entries",
                f"must contain at least one {terminal_field} transition",
            )
        return dict(trajectory), validated_entries


class TrajectoryDataset(Dataset):
    """Flatten completed trajectory files into validated decision transitions.

    Each item contains the raw observation and variable-length legal-action list,
    the selected legal-action index, scalar rewards, terminal flags, and source
    provenance. Encoding and padding are deliberately deferred to a later collator.
    """

    def __init__(
        self,
        sources: Path | str | Sequence[Path | str] = DEFAULT_TRAJECTORY_DIRECTORY,
        *,
        registry_path: Path | str = DEFAULT_REGISTRY_PATH,
        recursive: bool = False,
        event_history_sources: Sequence[str] = tuple(SUPPORTED_EVENT_HISTORY_SOURCES),
    ) -> None:
        super().__init__()
        self.registry = load_entity_registry(registry_path)
        self.event_history_sources = frozenset(event_history_sources)
        if not self.event_history_sources:
            raise ValueError("event_history_sources must not be empty.")
        unsupported_sources = (
            self.event_history_sources - SUPPORTED_EVENT_HISTORY_SOURCES
        )
        if unsupported_sources:
            raise ValueError(
                f"Unsupported event history sources: {sorted(unsupported_sources)}"
            )

        self.source_paths = self._resolve_source_paths(sources, recursive=recursive)
        self.trajectories: list[dict[str, Any]] = []
        self.samples: list[dict[str, Any]] = []
        for trajectory_index, source_path in enumerate(self.source_paths):
            trajectory, entries = self._load_trajectory(source_path)
            self.trajectories.append(trajectory)
            for entry in entries:
                self.samples.append({
                    "observation": entry["observation"],
                    "legalActions": entry["legalActions"],
                    "chosenActionIndex": entry["chosenActionIndex"],
                    "chosenAction": entry["chosenAction"],
                    "reward": float(entry["reward"]),
                    "vpReward": float(entry["vpReward"]),
                    "terminalReward": float(entry["terminalReward"]),
                    "nextObservation": entry["nextObservation"],
                    "terminated": entry["terminated"],
                    "truncated": entry["truncated"],
                    "done": entry["done"],
                    "playerId": entry["playerId"],
                    "decisionIndex": entry["decisionIndex"],
                    "resolutionId": entry.get("resolutionId"),
                    "decisionType": entry.get("decisionType"),
                    "stepIndex": entry.get("stepIndex"),
                    "gameId": trajectory["gameId"],
                    "trajectoryIndex": trajectory_index,
                    "sourcePath": str(source_path),
                    "trajectoryMetadata": trajectory["metadata"],
                })

    @staticmethod
    def _resolve_source_paths(
        sources: Path | str | Sequence[Path | str],
        *,
        recursive: bool,
    ) -> list[Path]:
        raw_sources: Sequence[Path | str]
        if isinstance(sources, (str, Path)):
            raw_sources = [sources]
        elif isinstance(sources, Sequence):
            raw_sources = sources
        else:
            raise TypeError("sources must be a path or a sequence of paths.")

        resolved_paths: set[Path] = set()
        for raw_source in raw_sources:
            source = Path(raw_source).expanduser()
            if not source.exists():
                raise FileNotFoundError(f"Trajectory source does not exist: {source}")
            if source.is_file():
                if source.suffix.lower() != ".json":
                    raise ValueError(f"Trajectory files must use the .json extension: {source}")
                resolved_paths.add(source.resolve())
                continue
            pattern = "**/*.json" if recursive else "*.json"
            resolved_paths.update(path.resolve() for path in source.glob(pattern) if path.is_file())
        return sorted(resolved_paths, key=lambda path: str(path))

    def _load_trajectory(
        self,
        source_path: Path,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        try:
            with source_path.open(encoding="utf-8") as trajectory_file:
                raw_trajectory = json.load(trajectory_file)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise TrajectoryValidationError(
                source_path,
                "$",
                f"is not valid UTF-8 JSON: {error}",
            ) from error
        validator = _TrajectoryValidator(
            source_path,
            self.registry,
            self.event_history_sources,
        )
        return validator.validate(raw_trajectory)

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, index: int) -> dict[str, Any]:
        return self.samples[index]
