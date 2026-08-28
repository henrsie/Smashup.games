"""Migrate exported Smash Up trajectories to the structured-event schema."""

from __future__ import annotations

import argparse
import copy
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Optional


REGISTRY_PATH = Path(__file__).resolve().parents[1] / "shared" / "gameEntityIds.json"
TARGET_TRAJECTORY_SCHEMA_VERSION = 5
TARGET_OBSERVATION_SCHEMA_VERSION = 5
TARGET_EVENT_SCHEMA_VERSION = 1
RECENT_EVENT_LIMIT = 32
SUPPORTED_SOURCE_TRAJECTORY_VERSION = 4
SUPPORTED_CURRENT_ENTITY_SCHEMA_VERSION = 3


def _load_registry(path: Path | str = REGISTRY_PATH) -> dict[str, Any]:
    with Path(path).open(encoding="utf-8") as registry_file:
        return json.load(registry_file)


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _stable_id(registry: Mapping[str, Any], namespace: str, value: Any) -> int:
    unknown_id = int(registry["unknownId"])
    if isinstance(value, int) and not isinstance(value, bool):
        return value if value in registry[namespace].values() else unknown_id
    if isinstance(value, str):
        return int(registry[namespace].get(value, unknown_id))
    if isinstance(value, Mapping):
        explicit_fields = {
            "cards": ("cardEntityId", "entityId"),
            "bases": ("baseEntityId", "entityId"),
            "factions": ("factionEntityId", "entityId"),
        }[namespace]
        for field in explicit_fields:
            if field in value:
                resolved = _stable_id(registry, namespace, value[field])
                if resolved != unknown_id:
                    return resolved
        identity_fields = {
            "cards": ("cardId", "id"),
            "bases": ("baseId", "id"),
            "factions": ("name",),
        }[namespace]
        for field in identity_fields:
            if field in value:
                resolved = _stable_id(registry, namespace, value[field])
                if resolved != unknown_id:
                    return resolved
    return unknown_id


def _observation_cards(observation: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    cards: list[Mapping[str, Any]] = []

    def add_card(raw_card: Any) -> None:
        card = _mapping(raw_card)
        if not card:
            return
        cards.append(card)
        for attached_card in _list(card.get("attachedCards")):
            add_card(attached_card)

    for raw_player in _list(observation.get("players")):
        player = _mapping(raw_player)
        for raw_card in _list(player.get("hand")) + _list(player.get("discardPile")):
            add_card(raw_card)
    for raw_base in _list(observation.get("activeBases")):
        for raw_card in _list(_mapping(raw_base).get("playedCards")):
            add_card(raw_card)
    cards.extend(_pending_observation_cards(observation))
    return cards


def _pending_observation_cards(
    observation: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    cards: list[Mapping[str, Any]] = []
    instance_ids: set[str] = set()
    visited: set[int] = set()

    def visit(value: Any) -> None:
        if not isinstance(value, (Mapping, list)) or id(value) in visited:
            return
        visited.add(id(value))
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        instance_id = value.get("instanceId")
        if isinstance(instance_id, str) and instance_id not in instance_ids:
            instance_ids.add(instance_id)
            cards.append(value)
        for key, nested_value in value.items():
            if key != "continuation":
                visit(nested_value)

    visit(observation.get("pendingDecision"))
    return cards


def _card_id_for_instance(
    observation: Mapping[str, Any],
    instance_id: Any,
    registry: Mapping[str, Any],
) -> int:
    if not instance_id:
        return int(registry["unknownId"])
    card = next(
        (
            candidate
            for candidate in _observation_cards(observation)
            if candidate.get("instanceId") == instance_id
        ),
        None,
    )
    return _stable_id(registry, "cards", card)


def _base_id_for_action(
    action: Mapping[str, Any],
    observation: Mapping[str, Any],
    registry: Mapping[str, Any],
) -> int:
    choice = _mapping(action.get("choice"))
    base_identity = choice.get("baseInstanceId")
    if base_identity:
        resolved = _stable_id(registry, "bases", base_identity)
        if resolved != registry["unknownId"]:
            return resolved
    base_index = action.get("baseIndex")
    if not isinstance(base_index, int) or isinstance(base_index, bool):
        base_index = choice.get("baseIndex")
    active_bases = _list(observation.get("activeBases"))
    if isinstance(base_index, int) and not isinstance(base_index, bool):
        if 0 <= base_index < len(active_bases):
            return _stable_id(registry, "bases", _mapping(active_bases[base_index]))
    return int(registry["unknownId"])


def _action_entity_ids(
    action: Mapping[str, Any],
    observation: Mapping[str, Any],
    registry: Mapping[str, Any],
) -> dict[str, Any]:
    unknown_id = int(registry["unknownId"])
    choice = _mapping(action.get("choice"))
    existing = _mapping(action.get("entityIds"))

    card_id = _stable_id(registry, "cards", existing.get("cardEntityId"))
    if card_id == unknown_id:
        card_id = _card_id_for_instance(
            observation,
            action.get("cardInstanceId") or choice.get("cardInstanceId"),
            registry,
        )
    target_card_id = _stable_id(registry, "cards", existing.get("targetCardEntityId"))
    if target_card_id == unknown_id:
        target_card_id = _card_id_for_instance(
            observation,
            action.get("targetMinionInstanceId") or choice.get("minionInstanceId"),
            registry,
        )

    selected_card_ids = [
        _stable_id(registry, "cards", entity_id)
        for entity_id in _list(existing.get("selectedCardEntityIds"))
    ]
    if not selected_card_ids:
        selected_instance_ids = (
            _list(choice.get("cardInstanceIds"))
            + _list(choice.get("minionInstanceIds"))
        )
        selected_card_ids = [
            _card_id_for_instance(observation, instance_id, registry)
            for instance_id in selected_instance_ids
        ]

    base_id = _stable_id(registry, "bases", existing.get("baseEntityId"))
    if base_id == unknown_id:
        base_id = _base_id_for_action(action, observation, registry)
    faction_id = _stable_id(registry, "factions", existing.get("factionEntityId"))
    if faction_id == unknown_id:
        faction_id = _stable_id(
            registry,
            "factions",
            action.get("factionName") or choice.get("faction"),
        )

    return {
        "cardEntityId": card_id,
        "targetCardEntityId": target_card_id,
        "selectedCardEntityIds": selected_card_ids,
        "baseEntityId": base_id,
        "destinationBaseEntityId": unknown_id,
        "factionEntityId": faction_id,
    }


def _choice_type(action: Mapping[str, Any]) -> str:
    choice = _mapping(action.get("choice"))
    if choice.get("cancel") is True:
        return "cancel"
    if choice.get("finishSelection") is True:
        return "finish-selection"
    if choice.get("skip") is True or choice.get("choiceId") == "skip":
        return "skip"
    choice_values = {
        "accept": "accept",
        "discard": "discard",
        "return": "return",
        "hand": "hand",
        "playExtra": "play-extra",
    }
    if choice.get("choiceId") in choice_values:
        return choice_values[choice["choiceId"]]
    if choice.get("minionInstanceId") or action.get("targetMinionInstanceId"):
        return "minion"
    if choice.get("cardInstanceId"):
        return "card"
    if isinstance(choice.get("baseIndex"), int) or choice.get("baseInstanceId"):
        return "base"
    if choice.get("playerId"):
        return "player"
    if choice.get("faction"):
        return "faction"
    if isinstance(choice.get("amount"), (int, float)):
        return "amount"
    return "none"


def _card_location(
    observation: Mapping[str, Any],
    instance_id: Any,
    registry: Mapping[str, Any],
) -> dict[str, int]:
    empty = {
        "zoneId": int(registry["unknownId"]),
        "ownerSeat": 0,
        "basePosition": 0,
        "cardPosition": 0,
        "parentCardPosition": 0,
    }
    if not instance_id:
        return empty
    for player_index, raw_player in enumerate(_list(observation.get("players"))):
        player = _mapping(raw_player)
        for zone_name, field in (("hand", "hand"), ("discard", "discardPile")):
            for card_index, raw_card in enumerate(_list(player.get(field))):
                if _mapping(raw_card).get("instanceId") == instance_id:
                    return {
                        **empty,
                        "zoneId": registry["cardZones"][zone_name],
                        "ownerSeat": player_index + 1,
                        "cardPosition": card_index + 1,
                    }
    for base_index, raw_base in enumerate(_list(observation.get("activeBases"))):
        cards = _list(_mapping(raw_base).get("playedCards"))
        for card_index, raw_card in enumerate(cards):
            card = _mapping(raw_card)
            owner_index = next((
                index
                for index, raw_player in enumerate(_list(observation.get("players")))
                if _mapping(raw_player).get("id") == card.get("ownerId")
            ), -1)
            if card.get("instanceId") == instance_id:
                return {
                    **empty,
                    "zoneId": registry["cardZones"]["board"],
                    "ownerSeat": owner_index + 1,
                    "basePosition": base_index + 1,
                    "cardPosition": card_index + 1,
                }
            for attached_index, raw_attached in enumerate(_list(card.get("attachedCards"))):
                attached = _mapping(raw_attached)
                if attached.get("instanceId") == instance_id:
                    attached_owner_index = next((
                        index
                        for index, raw_player in enumerate(_list(observation.get("players")))
                        if _mapping(raw_player).get("id") == attached.get("ownerId")
                    ), -1)
                    return {
                        **empty,
                        "zoneId": registry["cardZones"]["attached"],
                        "ownerSeat": attached_owner_index + 1,
                        "basePosition": base_index + 1,
                        "cardPosition": attached_index + 1,
                        "parentCardPosition": card_index + 1,
                    }
    for card_index, card in enumerate(_pending_observation_cards(observation)):
        if card.get("instanceId") != instance_id:
            continue
        owner_index = next((
            index
            for index, raw_player in enumerate(_list(observation.get("players")))
            if _mapping(raw_player).get("id") == card.get("ownerId")
        ), -1)
        return {
            **empty,
            "zoneId": registry["cardZones"]["pending-choice"],
            "ownerSeat": owner_index + 1,
            "cardPosition": card_index + 1,
        }
    return empty


def _annotate_action(
    action: Mapping[str, Any],
    observation: Mapping[str, Any],
    registry: Mapping[str, Any],
) -> dict[str, Any]:
    annotated = copy.deepcopy(dict(action))
    choice = _mapping(action.get("choice"))
    source_location = _card_location(
        observation,
        action.get("cardInstanceId") or choice.get("cardInstanceId"),
        registry,
    )
    target_location = _card_location(
        observation,
        action.get("targetMinionInstanceId") or choice.get("minionInstanceId"),
        registry,
    )
    players = _list(observation.get("players"))
    selected_player_index = next((
        index
        for index, raw_player in enumerate(players)
        if _mapping(raw_player).get("id") == choice.get("playerId")
    ), -1)
    base_index = action.get("baseIndex")
    if not isinstance(base_index, int) or isinstance(base_index, bool):
        base_index = choice.get("baseIndex")
    existing_features = dict(_mapping(action.get("choiceFeatures")))
    defaults = {
        "sourceZoneId": source_location["zoneId"],
        "sourceOwnerSeat": source_location["ownerSeat"],
        "sourceBasePosition": source_location["basePosition"],
        "sourceCardPosition": source_location["cardPosition"],
        "sourceParentCardPosition": source_location["parentCardPosition"],
        "targetZoneId": target_location["zoneId"],
        "targetOwnerSeat": target_location["ownerSeat"],
        "targetBasePosition": target_location["basePosition"],
        "targetCardPosition": target_location["cardPosition"],
        "targetParentCardPosition": target_location["parentCardPosition"],
        "selectedPlayerSeat": selected_player_index + 1,
        "chosenBasePosition": base_index + 1 if isinstance(base_index, int) else 0,
        "baseDeckPosition": 0,
        "selectionCount": len(_list(choice.get("cardInstanceIds")))
        + len(_list(choice.get("minionInstanceIds"))),
        "amount": choice.get("amount") if isinstance(choice.get("amount"), (int, float)) else 0,
        "fromDiscard": int(action.get("fromDiscard") is True),
        "candidateOrdinal": 0,
    }
    annotated["actionTypeId"] = registry["actionTypes"].get(
        action.get("type"), registry["unknownId"]
    )
    annotated["choiceTypeId"] = registry["choiceTypes"][_choice_type(action)]
    annotated["entityIds"] = _action_entity_ids(action, observation, registry)
    annotated["choiceFeatures"] = {**defaults, **existing_features}
    return annotated


def _annotate_action_list(
    actions: list[Any],
    observation: Mapping[str, Any],
    registry: Mapping[str, Any],
) -> list[Any]:
    occurrences: dict[str, int] = {}
    annotated_actions = []
    for raw_action in actions:
        if not isinstance(raw_action, Mapping):
            annotated_actions.append(raw_action)
            continue
        action = _annotate_action(raw_action, observation, registry)
        key = json.dumps({
            "actionTypeId": action["actionTypeId"],
            "choiceTypeId": action["choiceTypeId"],
            "entityIds": action["entityIds"],
            "choiceFeatures": action["choiceFeatures"],
        }, sort_keys=True)
        ordinal = occurrences.get(key, 0)
        occurrences[key] = ordinal + 1
        action["choiceFeatures"]["candidateOrdinal"] = ordinal
        annotated_actions.append(action)
    return annotated_actions


def _player_seats(trajectory: Mapping[str, Any]) -> dict[str, int]:
    seats: dict[str, int] = {}
    for fallback_index, raw_player in enumerate(
        _list(_mapping(trajectory.get("metadata")).get("players"))
    ):
        player = _mapping(raw_player)
        player_id = player.get("playerId") or player.get("id")
        if isinstance(player_id, str):
            seat_index = player.get("seatIndex")
            seats[player_id] = seat_index if isinstance(seat_index, int) else fallback_index
    if seats:
        return seats
    first_observation = _mapping(
        _mapping(_list(trajectory.get("entries"))[0]).get("observation")
    ) if _list(trajectory.get("entries")) else {}
    for seat_index, raw_player in enumerate(_list(first_observation.get("players"))):
        player_id = _mapping(raw_player).get("id")
        if isinstance(player_id, str):
            seats[player_id] = seat_index
    return seats


def _decision_event(
    entry: Mapping[str, Any],
    sequence_number: int,
    seats: Mapping[str, int],
    registry: Mapping[str, Any],
) -> Optional[dict[str, Any]]:
    action = _mapping(entry.get("chosenAction"))
    action_type = action.get("type")
    event_type = {
        "play-card": "card-played",
        "resolve-ability-choice": "ability-choice-made",
        "use-talent": "talent-used",
        "draft-faction": "faction-drafted",
        "end-turn": "turn-ended",
    }.get(action_type)
    if event_type is None:
        return None

    observation = _mapping(entry.get("observation"))
    actor_id = entry.get("playerId") or observation.get("observerPlayerId")
    choice = _mapping(action.get("choice"))
    target_player_id = choice.get("playerId") or action.get("targetPlayerId")
    entity_ids = _action_entity_ids(action, observation, registry)
    return {
        "schemaVersion": TARGET_EVENT_SCHEMA_VERSION,
        "sequenceNumber": sequence_number,
        "eventType": event_type,
        "eventTypeId": registry["eventTypes"][event_type],
        "actorPlayerId": actor_id,
        "actorSeatIndex": seats.get(actor_id),
        "targetPlayerId": target_player_id,
        "targetSeatIndex": seats.get(target_player_id),
        **entity_ids,
        "amount": choice.get("amount") if isinstance(choice.get("amount"), (int, float)) else 0,
        "count": len(entity_ids["selectedCardEntityIds"]),
        "resolutionId": entry.get("resolutionId"),
        "stepIndex": entry.get("stepIndex") if isinstance(entry.get("stepIndex"), int) else None,
        "privateEntityPlayerId": actor_id if action_type == "resolve-ability-choice" else None,
    }


def _boundary_events(
    entry: Mapping[str, Any],
    next_observation: Mapping[str, Any],
    sequence_number: int,
    seats: Mapping[str, int],
    registry: Mapping[str, Any],
) -> list[dict[str, Any]]:
    previous_observation = _mapping(entry.get("observation"))
    events: list[dict[str, Any]] = []
    previous_turn_player = previous_observation.get("currentTurnPlayerId")
    next_turn_player = next_observation.get("currentTurnPlayerId")
    if next_turn_player and next_turn_player != previous_turn_player:
        event_type = "turn-started"
        events.append({
            "schemaVersion": TARGET_EVENT_SCHEMA_VERSION,
            "sequenceNumber": sequence_number,
            "eventType": event_type,
            "eventTypeId": registry["eventTypes"][event_type],
            "actorPlayerId": next_turn_player,
            "actorSeatIndex": seats.get(next_turn_player),
            "targetPlayerId": None,
            "targetSeatIndex": None,
            "cardEntityId": registry["unknownId"],
            "targetCardEntityId": registry["unknownId"],
            "selectedCardEntityIds": [],
            "baseEntityId": registry["unknownId"],
            "destinationBaseEntityId": registry["unknownId"],
            "factionEntityId": registry["unknownId"],
            "amount": 0,
            "count": 0,
            "resolutionId": None,
            "stepIndex": None,
            "privateEntityPlayerId": None,
        })
    if (
        previous_observation.get("gamePhase") != "finished"
        and next_observation.get("gamePhase") == "finished"
    ):
        game_result = _mapping(next_observation.get("gameResult"))
        winner_id = game_result.get("winnerId")
        event_type = "game-finished"
        events.append({
            "schemaVersion": TARGET_EVENT_SCHEMA_VERSION,
            "sequenceNumber": sequence_number + len(events),
            "eventType": event_type,
            "eventTypeId": registry["eventTypes"][event_type],
            "actorPlayerId": winner_id,
            "actorSeatIndex": seats.get(winner_id),
            "targetPlayerId": None,
            "targetSeatIndex": None,
            "cardEntityId": registry["unknownId"],
            "targetCardEntityId": registry["unknownId"],
            "selectedCardEntityIds": [],
            "baseEntityId": registry["unknownId"],
            "destinationBaseEntityId": registry["unknownId"],
            "factionEntityId": registry["unknownId"],
            "amount": game_result.get("winningVictoryPoints", 0),
            "count": 0,
            "resolutionId": None,
            "stepIndex": None,
            "privateEntityPlayerId": None,
        })
    return events


def _visible_events(events: list[dict[str, Any]], observer_id: Any) -> list[dict[str, Any]]:
    visible_events = []
    for event in events[-RECENT_EVENT_LIMIT:]:
        visible_event = {
            key: copy.deepcopy(value)
            for key, value in event.items()
            if key != "privateEntityPlayerId"
        }
        private_player_id = event.get("privateEntityPlayerId")
        if private_player_id and private_player_id != observer_id:
            visible_event.update({
                "cardEntityId": 0,
                "targetCardEntityId": 0,
                "selectedCardEntityIds": [],
                "baseEntityId": 0,
                "destinationBaseEntityId": 0,
                "factionEntityId": 0,
                "amount": 0,
                "count": 0,
            })
        visible_events.append(visible_event)
    return visible_events


def _migrate_observation(
    observation: Any,
    events: list[dict[str, Any]],
    observer_id: Any,
    entity_schema_version: int,
) -> Any:
    if not isinstance(observation, Mapping):
        return observation
    migrated = copy.deepcopy(dict(observation))
    migrated["schemaVersion"] = TARGET_OBSERVATION_SCHEMA_VERSION
    migrated["entityIdSchemaVersion"] = entity_schema_version
    migrated["eventSchemaVersion"] = TARGET_EVENT_SCHEMA_VERSION
    migrated["recentEvents"] = _visible_events(events, observer_id)
    return migrated


def _upgrade_entry_actions(
    entry: dict[str, Any],
    registry: Mapping[str, Any],
) -> dict[str, Any]:
    observation = _mapping(entry.get("observation"))
    legal_actions = _annotate_action_list(
        _list(entry.get("legalActions")),
        observation,
        registry,
    )
    if "legalActions" in entry:
        entry["legalActions"] = legal_actions
    chosen_index = entry.get("chosenActionIndex")
    if (
        isinstance(chosen_index, int)
        and not isinstance(chosen_index, bool)
        and 0 <= chosen_index < len(legal_actions)
    ):
        entry["chosenAction"] = copy.deepcopy(legal_actions[chosen_index])
    elif isinstance(entry.get("chosenAction"), Mapping):
        entry["chosenAction"] = _annotate_action(
            _mapping(entry["chosenAction"]),
            observation,
            registry,
        )
    return entry


def _set_observation_entity_schema(value: Any, schema_version: int) -> Any:
    if not isinstance(value, Mapping):
        return value
    observation = copy.deepcopy(dict(value))
    observation["entityIdSchemaVersion"] = schema_version
    return observation


def migrate_trajectory(
    trajectory: Mapping[str, Any],
    *,
    registry_path: Path | str = REGISTRY_PATH,
) -> dict[str, Any]:
    """Return a migrated copy of one v4 trajectory.

    Old prose cannot recreate automatic outcomes exactly, so the structured event
    history is backfilled from chosen decisions and inferred turn boundaries. The
    metadata explicitly identifies this limitation for downstream filtering.
    """
    if not isinstance(trajectory, Mapping):
        raise TypeError("trajectory must be a mapping.")
    registry = _load_registry(registry_path)
    migrated = copy.deepcopy(dict(trajectory))
    metadata = dict(_mapping(migrated.get("metadata")))
    source_version = migrated.get("schemaVersion", metadata.get("trajectorySchemaVersion"))

    if source_version == TARGET_TRAJECTORY_SCHEMA_VERSION:
        source_entity_version = metadata.get("entityIdSchemaVersion")
        if source_entity_version == registry["schemaVersion"]:
            return migrated
        if source_entity_version != SUPPORTED_CURRENT_ENTITY_SCHEMA_VERSION:
            raise ValueError("The v5 trajectory uses an incompatible entity registry.")
        upgraded_entries = []
        for raw_entry in _list(migrated.get("entries")):
            if not isinstance(raw_entry, Mapping):
                raise ValueError("trajectory entries must be mappings.")
            entry = copy.deepcopy(dict(raw_entry))
            entry["observation"] = _set_observation_entity_schema(
                entry.get("observation"), registry["schemaVersion"]
            )
            entry["nextObservation"] = _set_observation_entity_schema(
                entry.get("nextObservation"), registry["schemaVersion"]
            )
            upgraded_entries.append(_upgrade_entry_actions(entry, registry))
        migrated["entries"] = upgraded_entries
        metadata["entityIdSchemaVersion"] = registry["schemaVersion"]
        metadata["actionEncodingSource"] = "choice-features-backfill-v1"
        metadata["entityMigration"] = {
            "sourceEntityIdSchemaVersion": source_entity_version,
            "targetEntityIdSchemaVersion": registry["schemaVersion"],
        }
        migrated["metadata"] = metadata
        return migrated
    if source_version != SUPPORTED_SOURCE_TRAJECTORY_VERSION:
        raise ValueError(
            f"Only trajectory schema v{SUPPORTED_SOURCE_TRAJECTORY_VERSION} can be "
            f"migrated to v{TARGET_TRAJECTORY_SCHEMA_VERSION}; received {source_version!r}."
        )

    entries = _list(migrated.get("entries"))
    if not all(isinstance(entry, Mapping) for entry in entries):
        raise ValueError("trajectory entries must be mappings.")
    seats = _player_seats(migrated)
    events_before_entry: list[list[dict[str, Any]]] = []
    accumulated_events: list[dict[str, Any]] = []
    sequence_number = 0

    for entry_index, raw_entry in enumerate(entries):
        entry = _mapping(raw_entry)
        events_before_entry.append(copy.deepcopy(accumulated_events))
        event = _decision_event(entry, sequence_number, seats, registry)
        if event is not None:
            accumulated_events.append(event)
            sequence_number += 1
        if entry_index + 1 < len(entries):
            next_observation = _mapping(_mapping(entries[entry_index + 1]).get("observation"))
        else:
            next_observation = _mapping(entry.get("nextObservation"))
        if next_observation:
            boundary_events = _boundary_events(
                entry,
                next_observation,
                sequence_number,
                seats,
                registry,
            )
            accumulated_events.extend(boundary_events)
            sequence_number += len(boundary_events)

    next_entry_for_player: dict[str, int] = {}
    next_same_player_indices: list[Optional[int]] = [None] * len(entries)
    for entry_index in range(len(entries) - 1, -1, -1):
        player_id = _mapping(entries[entry_index]).get("playerId")
        if isinstance(player_id, str):
            next_same_player_indices[entry_index] = next_entry_for_player.get(player_id)
            next_entry_for_player[player_id] = entry_index

    migrated_entries = []
    for entry_index, raw_entry in enumerate(entries):
        entry = copy.deepcopy(dict(_mapping(raw_entry)))
        player_id = entry.get("playerId")
        observation = _mapping(entry.get("observation"))
        observer_id = observation.get("observerPlayerId") or player_id
        entry["observation"] = _migrate_observation(
            entry.get("observation"),
            events_before_entry[entry_index],
            observer_id,
            registry["schemaVersion"],
        )

        next_observation = _mapping(entry.get("nextObservation"))
        if next_observation:
            next_index = next_same_player_indices[entry_index]
            next_events = (
                events_before_entry[next_index]
                if next_index is not None
                else accumulated_events
            )
            next_observer_id = next_observation.get("observerPlayerId") or player_id
            entry["nextObservation"] = _migrate_observation(
                entry.get("nextObservation"),
                next_events,
                next_observer_id,
                registry["schemaVersion"],
            )
        migrated_entries.append(_upgrade_entry_actions(entry, registry))

    migrated["schemaVersion"] = TARGET_TRAJECTORY_SCHEMA_VERSION
    migrated["entries"] = migrated_entries
    metadata.update({
        "trajectorySchemaVersion": TARGET_TRAJECTORY_SCHEMA_VERSION,
        "observationSchemaVersion": TARGET_OBSERVATION_SCHEMA_VERSION,
        "entityIdSchemaVersion": registry["schemaVersion"],
        "eventSchemaVersion": TARGET_EVENT_SCHEMA_VERSION,
        "eventHistorySource": "decision-backfill-v1",
        "migration": {
            "sourceTrajectorySchemaVersion": source_version,
            "sourceObservationSchemaVersion": metadata.get("observationSchemaVersion"),
            "sourceEntityIdSchemaVersion": metadata.get("entityIdSchemaVersion"),
            "strategy": "decision-backfill-v1",
            "automaticOutcomeEventsReconstructed": False,
        },
    })
    migrated["metadata"] = metadata
    return migrated


def migrate_trajectory_file(
    input_path: Path | str,
    output_path: Path | str,
    *,
    force: bool = False,
) -> Path:
    """Migrate one JSON file without overwriting an output unless explicitly allowed."""
    source = Path(input_path)
    destination = Path(output_path)
    if destination.exists() and not force:
        raise FileExistsError(f"Refusing to overwrite existing file: {destination}")
    with source.open(encoding="utf-8") as input_file:
        trajectory = json.load(input_file)
    migrated = migrate_trajectory(trajectory)
    temporary_path = destination.with_name(f".{destination.name}.tmp")
    try:
        with temporary_path.open("w", encoding="utf-8") as output_file:
            json.dump(migrated, output_file, indent=2)
            output_file.write("\n")
        temporary_path.replace(destination)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate one Smash Up trajectory from schema v4 to v5."
    )
    parser.add_argument("input", type=Path, help="Existing trajectory JSON file")
    parser.add_argument("output", type=Path, help="Destination for migrated JSON")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Allow replacing an existing destination file",
    )
    args = parser.parse_args()
    destination = migrate_trajectory_file(args.input, args.output, force=args.force)
    print(destination)


if __name__ == "__main__":
    main()
