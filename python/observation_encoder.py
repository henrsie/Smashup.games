"""Trainable encoder for server-provided Smash Up observations."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Optional

import torch
from torch import Tensor, nn

from action_embeddings import (
    DEFAULT_REGISTRY_PATH,
    EntityEmbeddingTables,
    create_entity_embeddings,
    load_entity_registry,
)


GAME_PHASES = ("unknown", "lobby", "drafting", "playing", "finished")
DECISION_BUCKETS = (
    "none",
    "draft",
    "turn",
    "board",
    "movement",
    "card_selection",
    "scoring",
    "confirmation",
    "other",
)
CARD_ZONES = ("hand", "discard", "board", "attached")
SUPPORTED_EVENT_SCHEMA_VERSION = 1


def _as_list(value: Any) -> list[Any]:
    return list(value) if isinstance(value, list) else []


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _finite_number(value: Any, default: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    numeric_value = float(value)
    return numeric_value if math.isfinite(numeric_value) else default


def _scaled_number(value: Any, scale: float) -> float:
    """Bound an unbounded game scalar while preserving its sign and ordering."""
    return math.tanh(_finite_number(value) / scale)


def _one_hot(value: str, categories: Sequence[str]) -> list[float]:
    resolved_value = value if value in categories else categories[0]
    return [float(category == resolved_value) for category in categories]


def _decision_bucket(decision_type: Any) -> str:
    if not isinstance(decision_type, str) or not decision_type:
        return "none"
    normalized = decision_type.lower()
    if normalized == "draftfaction":
        return "draft"
    if normalized == "turnaction":
        return "turn"
    if "boardeffect" in normalized or "power" in normalized or "breakpoint" in normalized:
        return "board"
    if "move" in normalized or "destination" in normalized:
        return "movement"
    if any(token in normalized for token in (
        "card", "deck", "discard", "hand", "reveal", "selection", "faction"
    )):
        return "card_selection"
    if "score" in normalized or "scoring" in normalized or "triggered" in normalized:
        return "scoring"
    if "confirm" in normalized or "optional" in normalized:
        return "confirmation"
    return "other"


class ObservationEncoder(nn.Module):
    """Encode a variable-size observation into one fixed-size state vector.

    Entity sets are pooled with both a mean and a maximum. This keeps the output
    width fixed while still preserving aggregate and standout features. The same
    card, base, and faction embedding tables can be shared with the legal-action
    encoder by passing its ``EntityEmbeddingTables`` instance to the constructor.
    """

    card_feature_size = 12
    player_scalar_size = 12
    base_scalar_size = 10
    turn_scalar_size = 10
    global_scalar_size = 14
    event_scalar_size = 14

    def __init__(
        self,
        entity_embeddings: EntityEmbeddingTables,
        registry: Mapping[str, Any],
        *,
        state_size: int = 256,
        component_size: int = 64,
    ) -> None:
        super().__init__()
        if isinstance(state_size, bool) or not isinstance(state_size, int) or state_size < 1:
            raise ValueError("state_size must be a positive integer.")
        if (
            isinstance(component_size, bool)
            or not isinstance(component_size, int)
            or component_size < 1
        ):
            raise ValueError("component_size must be a positive integer.")
        if int(registry["schemaVersion"]) != entity_embeddings.schema_version:
            raise ValueError("The observation registry and entity embeddings must use one schema.")

        self.entity_embeddings = entity_embeddings
        self.registry = {
            namespace: dict(registry[namespace])
            for namespace in ("actionTypes", "eventTypes", "cards", "bases", "factions")
        }
        self.state_size = state_size
        self.component_size = component_size

        card_input_size = entity_embeddings.dimensions["cards"] + self.card_feature_size
        self.card_encoder = self._component_network(card_input_size)

        pooled_card_size = 2 * component_size
        player_input_size = (
            entity_embeddings.dimensions["factions"]
            + 2 * pooled_card_size
            + self.player_scalar_size
        )
        self.player_encoder = self._component_network(player_input_size)

        base_input_size = (
            entity_embeddings.dimensions["bases"]
            + pooled_card_size
            + self.base_scalar_size
        )
        self.base_encoder = self._component_network(base_input_size)

        global_input_size = (
            len(GAME_PHASES)
            + len(DECISION_BUCKETS)
            + entity_embeddings.dimensions["factions"]
            + entity_embeddings.dimensions["cards"]
            + 2 * entity_embeddings.dimensions["bases"]
            + self.turn_scalar_size
            + self.global_scalar_size
        )
        self.global_encoder = self._component_network(global_input_size)

        event_input_size = (
            entity_embeddings.dimensions["eventTypes"]
            + 3 * entity_embeddings.dimensions["cards"]
            + 2 * entity_embeddings.dimensions["bases"]
            + entity_embeddings.dimensions["factions"]
            + self.event_scalar_size
        )
        self.event_encoder = self._component_network(event_input_size)
        self.event_history = nn.GRU(
            input_size=component_size,
            hidden_size=component_size,
            batch_first=True,
        )

        combined_size = (
            component_size
            + 2 * component_size
            + 2 * component_size
            + component_size
            + component_size
        )
        self.state_encoder = nn.Sequential(
            nn.Linear(combined_size, state_size),
            nn.LayerNorm(state_size),
            nn.GELU(),
        )

    def _component_network(self, input_size: int) -> nn.Sequential:
        return nn.Sequential(
            nn.Linear(input_size, self.component_size),
            nn.LayerNorm(self.component_size),
            nn.GELU(),
        )

    @property
    def _device(self) -> torch.device:
        return self.entity_embeddings.cards.weight.device

    @property
    def _dtype(self) -> torch.dtype:
        return self.entity_embeddings.cards.weight.dtype

    def _tensor(self, values: Sequence[float]) -> Tensor:
        return torch.tensor(values, dtype=self._dtype, device=self._device)

    def _zeros(self, width: int) -> Tensor:
        return torch.zeros(width, dtype=self._dtype, device=self._device)

    def _resolve_id(self, namespace: str, value: Any) -> int:
        if isinstance(value, Mapping):
            explicit_fields = {
                "eventTypes": ("eventTypeId", "entityId"),
                "cards": ("cardEntityId", "entityId"),
                "bases": ("baseEntityId", "entityId"),
                "factions": ("factionEntityId", "entityId"),
            }[namespace]
            for field in explicit_fields:
                if field in value:
                    resolved = self.entity_embeddings._safe_id(namespace, value[field])
                    if resolved != self.entity_embeddings.unknown_id:
                        return resolved
            identity_fields = {
                "eventTypes": ("eventType", "type"),
                "cards": ("cardId", "id"),
                "bases": ("baseId", "id"),
                "factions": ("name",),
            }[namespace]
            for field in identity_fields:
                if value.get(field) in self.registry[namespace]:
                    return self.registry[namespace][value[field]]
            return self.entity_embeddings.unknown_id
        if isinstance(value, int) and not isinstance(value, bool):
            return self.entity_embeddings._safe_id(namespace, value)
        if isinstance(value, str):
            return self.registry[namespace].get(value, self.entity_embeddings.unknown_id)
        return self.entity_embeddings.unknown_id

    def _embed_one(self, namespace: str, value: Any) -> Tensor:
        table = getattr(self.entity_embeddings, {
            "eventTypes": "event_types",
            "cards": "cards",
            "bases": "bases",
            "factions": "factions",
        }[namespace])
        entity_id = torch.tensor(
            self._resolve_id(namespace, value),
            dtype=torch.long,
            device=self._device,
        )
        return table(entity_id)

    def _mean_entity_embeddings(self, namespace: str, values: Sequence[Any]) -> Tensor:
        dimension = self.entity_embeddings.dimensions[namespace]
        if not values:
            return self._zeros(dimension)
        return torch.stack([self._embed_one(namespace, value) for value in values]).mean(dim=0)

    def _mean_max_pool(self, vectors: Sequence[Tensor], width: int) -> Tensor:
        if not vectors:
            return self._zeros(2 * width)
        stacked = torch.stack(list(vectors))
        return torch.cat((stacked.mean(dim=0), stacked.max(dim=0).values), dim=-1)

    def _encode_card(
        self,
        card: Mapping[str, Any],
        *,
        zone: str,
        observer_id: Any,
        current_player_id: Any,
    ) -> Tensor:
        card_type = card.get("type")
        type_features = _one_hot(
            card_type if card_type in ("minion", "action") else "unknown",
            ("unknown", "minion", "action"),
        )
        zone_features = [float(zone == candidate) for candidate in CARD_ZONES]
        attached_cards = _as_list(card.get("attachedCards"))
        numeric_features = [
            _scaled_number(card.get("power"), 10.0),
            _scaled_number(card.get("printedPower", card.get("power")), 10.0),
            _scaled_number(len(attached_cards), 4.0),
            float(card.get("ownerId") == observer_id),
            float(card.get("ownerId") == current_player_id),
        ]
        raw_features = torch.cat((
            self._embed_one("cards", card),
            self._tensor(type_features + zone_features + numeric_features),
        ))
        return self.card_encoder(raw_features)

    def _encode_player(
        self,
        player: Mapping[str, Any],
        *,
        seat_index: int,
        player_count: int,
        observer_id: Any,
        current_player_id: Any,
        host_id: Any,
    ) -> Tensor:
        faction_values = _as_list(player.get("factionEntityIds")) or _as_list(
            player.get("factions")
        )
        faction_vector = self._mean_entity_embeddings("factions", faction_values)

        hand = _as_list(player.get("hand"))
        hand_vectors = [
            self._encode_card(
                _as_mapping(card),
                zone="hand",
                observer_id=observer_id,
                current_player_id=current_player_id,
            )
            for card in hand
        ]
        discard = _as_list(player.get("discardPile"))
        discard_vectors = [
            self._encode_card(
                _as_mapping(card),
                zone="discard",
                observer_id=observer_id,
                current_player_id=current_player_id,
            )
            for card in discard
        ]
        player_id = player.get("id")
        scalar_features = [
            float(player_id == observer_id),
            float(player_id == current_player_id),
            float(player_id == host_id),
            float(player.get("isBot") is True),
            float(player.get("online") is not False),
            float(isinstance(player.get("hand"), list)),
            _scaled_number(player.get("vp"), 15.0),
            _scaled_number(player.get("handCount", len(hand)), 10.0),
            _scaled_number(player.get("deckCount"), 30.0),
            _scaled_number(len(discard), 20.0),
            _scaled_number(len(faction_values), 2.0),
            _scaled_number(seat_index, max(player_count - 1, 1)),
        ]
        raw_features = torch.cat((
            faction_vector,
            self._mean_max_pool(hand_vectors, self.component_size),
            self._mean_max_pool(discard_vectors, self.component_size),
            self._tensor(scalar_features),
        ))
        return self.player_encoder(raw_features)

    def _flatten_base_cards(self, base: Mapping[str, Any]) -> list[tuple[Mapping[str, Any], str]]:
        cards: list[tuple[Mapping[str, Any], str]] = []
        for raw_card in _as_list(base.get("playedCards")):
            card = _as_mapping(raw_card)
            cards.append((card, "board"))
            cards.extend(
                (_as_mapping(attached_card), "attached")
                for attached_card in _as_list(card.get("attachedCards"))
            )
        return cards

    def _encode_base(
        self,
        base: Mapping[str, Any],
        *,
        observer_id: Any,
        current_player_id: Any,
    ) -> Tensor:
        zoned_cards = self._flatten_base_cards(base)
        card_vectors = [
            self._encode_card(
                card,
                zone=zone,
                observer_id=observer_id,
                current_player_id=current_player_id,
            )
            for card, zone in zoned_cards
        ]
        played_cards = [card for card, zone in zoned_cards if zone == "board"]
        minions = [card for card in played_cards if card.get("type") == "minion"]
        victory_points = _as_list(base.get("vp"))
        padded_victory_points = (victory_points + [0, 0, 0])[:3]
        owner_ids = {card.get("ownerId") for card in minions if card.get("ownerId") is not None}
        scalar_features = [
            _scaled_number(base.get("breakpoint"), 30.0),
            *[_scaled_number(value, 5.0) for value in padded_victory_points],
            _scaled_number(len(played_cards), 10.0),
            _scaled_number(sum(_finite_number(card.get("power")) for card in minions), 30.0),
            _scaled_number(
                sum(_finite_number(card.get("power")) for card in minions if card.get("ownerId") == observer_id),
                20.0,
            ),
            _scaled_number(
                sum(
                    _finite_number(card.get("power"))
                    for card in minions
                    if card.get("ownerId") == current_player_id
                ),
                20.0,
            ),
            _scaled_number(len(owner_ids), 4.0),
            _scaled_number(len(zoned_cards) - len(played_cards), 5.0),
        ]
        raw_features = torch.cat((
            self._embed_one("bases", base),
            self._mean_max_pool(card_vectors, self.component_size),
            self._tensor(scalar_features),
        ))
        return self.base_encoder(raw_features)

    def _entity_aliases(
        self,
        observation: Mapping[str, Any],
    ) -> tuple[dict[Any, int], dict[Any, int]]:
        card_aliases: dict[Any, int] = {}
        base_aliases: dict[Any, int] = {}

        def add_card(card: Mapping[str, Any]) -> None:
            entity_id = self._resolve_id("cards", card)
            for alias in (card.get("instanceId"), card.get("cardId"), card.get("id"), card.get("name")):
                if alias is not None:
                    card_aliases[alias] = entity_id
            for attached_card in _as_list(card.get("attachedCards")):
                add_card(_as_mapping(attached_card))

        for player in _as_list(observation.get("players")):
            player_mapping = _as_mapping(player)
            for card in _as_list(player_mapping.get("hand")) + _as_list(
                player_mapping.get("discardPile")
            ):
                add_card(_as_mapping(card))
        for raw_base in _as_list(observation.get("activeBases")) + _as_list(
            observation.get("baseDiscardPile")
        ):
            base = _as_mapping(raw_base)
            entity_id = self._resolve_id("bases", base)
            for alias in (base.get("instanceId"), base.get("baseId"), base.get("id"), base.get("name")):
                if alias is not None:
                    base_aliases[alias] = entity_id
            for card in _as_list(base.get("playedCards")):
                add_card(_as_mapping(card))
        return card_aliases, base_aliases

    def _pending_option_count(self, pending: Mapping[str, Any]) -> int:
        return sum(
            len(value)
            for key, value in pending.items()
            if isinstance(value, list)
            and (
                key.endswith("Ids")
                or key.startswith("candidate")
                or key.startswith("available")
                or key.startswith("selected")
            )
        )

    def _encode_global(self, observation: Mapping[str, Any]) -> Tensor:
        observer_id = observation.get("observerPlayerId")
        current_player_id = observation.get("currentTurnPlayerId")
        pending = _as_mapping(observation.get("pendingDecision"))
        turn_state = _as_mapping(observation.get("turnState"))
        draft_state = _as_mapping(observation.get("draftState"))
        card_aliases, base_aliases = self._entity_aliases(observation)

        available_factions = _as_list(draft_state.get("availableFactionEntityIds")) or _as_list(
            draft_state.get("availableFactions")
        )
        available_faction_vector = self._mean_entity_embeddings(
            "factions", available_factions
        )
        source_card_value = (
            pending.get("sourceCardEntityId")
            or card_aliases.get(pending.get("sourceCardInstanceId"))
            or card_aliases.get(pending.get("sourceCardName"))
        )
        source_base_value = (
            pending.get("sourceBaseEntityId")
            or base_aliases.get(pending.get("sourceBaseInstanceId"))
            or base_aliases.get(pending.get("sourceBaseName"))
        )
        discarded_base_vector = self._mean_entity_embeddings(
            "bases", _as_list(observation.get("baseDiscardPile"))
        )

        extra_minion_plays = _as_list(turn_state.get("extraMinionPlays"))
        turn_features = [
            float(turn_state.get("actionPlayed") is True),
            float(turn_state.get("minionPlayed") is True),
            _scaled_number(turn_state.get("actionsPlayed"), 5.0),
            _scaled_number(turn_state.get("minionsPlayed"), 5.0),
            _scaled_number(turn_state.get("extraActionPlays"), 4.0),
            _scaled_number(len(extra_minion_plays), 4.0),
            _scaled_number(
                sum(
                    _as_mapping(permission).get("required") is True
                    for permission in extra_minion_plays
                ),
                4.0,
            ),
            float(turn_state.get("ongoingDiscardMinionPlayed") is True),
            _scaled_number(len(_as_mapping(turn_state.get("talentUses"))), 8.0),
            _scaled_number(len(_as_mapping(turn_state.get("ongoingAbilityUses"))), 8.0),
        ]
        players = _as_list(observation.get("players"))
        bases = _as_list(observation.get("activeBases"))
        global_features = [
            float(observation.get("isObserverTurn") is True),
            float(current_player_id is not None),
            float(pending != {}),
            float(pending.get("controlledByObserver") is True),
            float(observation.get("gameResult") is not None),
            float(draft_state.get("currentPickerId") == observer_id),
            _scaled_number(observation.get("baseDeckCount"), 12.0),
            _scaled_number(len(_as_list(observation.get("baseDiscardPile"))), 12.0),
            _scaled_number(len(_as_list(observation.get("temporaryEffects"))), 10.0),
            _scaled_number(observation.get("stepIndex"), 10.0),
            _scaled_number(len(bases), 5.0),
            _scaled_number(len(players), 4.0),
            _scaled_number(len(_as_list(observation.get("recentEvents"))), 32.0),
            _scaled_number(self._pending_option_count(pending), 10.0),
        ]
        game_phase = observation.get("gamePhase")
        phase_features = _one_hot(
            game_phase if isinstance(game_phase, str) else "unknown",
            GAME_PHASES,
        )
        decision_features = _one_hot(
            _decision_bucket(observation.get("decisionType")),
            DECISION_BUCKETS,
        )
        raw_features = torch.cat((
            self._tensor(phase_features + decision_features),
            available_faction_vector,
            self._embed_one("cards", source_card_value),
            self._embed_one("bases", source_base_value),
            discarded_base_vector,
            self._tensor(turn_features + global_features),
        ))
        return self.global_encoder(raw_features)

    def _encode_event_history(self, observation: Mapping[str, Any]) -> Tensor:
        events = [_as_mapping(event) for event in _as_list(observation.get("recentEvents"))]
        if not events:
            return self._zeros(self.component_size)

        players = [_as_mapping(player) for player in _as_list(observation.get("players"))]
        observer_id = observation.get("observerPlayerId")
        current_player_id = observation.get("currentTurnPlayerId")
        observer_seat = next(
            (index for index, player in enumerate(players) if player.get("id") == observer_id),
            -1,
        )
        current_seat = next(
            (
                index
                for index, player in enumerate(players)
                if player.get("id") == current_player_id
            ),
            -1,
        )
        latest_sequence = max(
            (_finite_number(event.get("sequenceNumber")) for event in events),
            default=0.0,
        )
        event_vectors = []
        for event in events:
            selected_card_vector = self._mean_entity_embeddings(
                "cards", _as_list(event.get("selectedCardEntityIds"))
            )
            actor_seat = event.get("actorSeatIndex")
            target_seat = event.get("targetSeatIndex")
            scalar_features = [
                float(actor_seat == observer_seat and observer_seat >= 0),
                float(actor_seat == current_seat and current_seat >= 0),
                float(target_seat == observer_seat and observer_seat >= 0),
                float(target_seat == current_seat and current_seat >= 0),
                _scaled_number(actor_seat, 3.0),
                _scaled_number(target_seat, 3.0),
                _scaled_number(event.get("amount"), 10.0),
                _scaled_number(event.get("count"), 10.0),
                _scaled_number(
                    latest_sequence - _finite_number(event.get("sequenceNumber")),
                    32.0,
                ),
                _scaled_number(event.get("stepIndex"), 10.0),
                float(event.get("resolutionId") is not None),
                float(event.get("actorPlayerId") is not None),
                float(event.get("targetPlayerId") is not None),
                _scaled_number(len(_as_list(event.get("selectedCardEntityIds"))), 5.0),
            ]
            raw_features = torch.cat((
                self._embed_one("eventTypes", event),
                self._embed_one("cards", event.get("cardEntityId")),
                self._embed_one("cards", event.get("targetCardEntityId")),
                selected_card_vector,
                self._embed_one("bases", event.get("baseEntityId")),
                self._embed_one("bases", event.get("destinationBaseEntityId")),
                self._embed_one("factions", event.get("factionEntityId")),
                self._tensor(scalar_features),
            ))
            event_vectors.append(self.event_encoder(raw_features))

        sequence = torch.stack(event_vectors).unsqueeze(0)
        _, final_hidden = self.event_history(sequence)
        return final_hidden[-1, 0]

    def _encode_one(self, observation: Mapping[str, Any]) -> Tensor:
        schema_version = observation.get("entityIdSchemaVersion")
        if schema_version is not None and schema_version != self.entity_embeddings.schema_version:
            raise ValueError(
                "Observation entityIdSchemaVersion does not match the embedding registry."
            )
        event_schema_version = observation.get("eventSchemaVersion")
        if (
            event_schema_version is not None
            and event_schema_version != SUPPORTED_EVENT_SCHEMA_VERSION
        ):
            raise ValueError("Observation eventSchemaVersion is not supported.")

        observer_id = observation.get("observerPlayerId")
        current_player_id = observation.get("currentTurnPlayerId")
        host_id = observation.get("hostId")
        players = [_as_mapping(player) for player in _as_list(observation.get("players"))]
        player_vectors = [
            self._encode_player(
                player,
                seat_index=seat_index,
                player_count=len(players),
                observer_id=observer_id,
                current_player_id=current_player_id,
                host_id=host_id,
            )
            for seat_index, player in enumerate(players)
        ]
        observer_vector = next(
            (
                vector
                for player, vector in zip(players, player_vectors)
                if player.get("id") == observer_id
            ),
            self._zeros(self.component_size),
        )
        opponent_vectors = [
            vector
            for player, vector in zip(players, player_vectors)
            if player.get("id") != observer_id
        ]

        bases = [_as_mapping(base) for base in _as_list(observation.get("activeBases"))]
        base_vectors = [
            self._encode_base(
                base,
                observer_id=observer_id,
                current_player_id=current_player_id,
            )
            for base in bases
        ]
        combined = torch.cat((
            observer_vector,
            self._mean_max_pool(opponent_vectors, self.component_size),
            self._mean_max_pool(base_vectors, self.component_size),
            self._encode_global(observation),
            self._encode_event_history(observation),
        ))
        return self.state_encoder(combined)

    def forward(
        self,
        observations: Mapping[str, Any] | Sequence[Mapping[str, Any]],
    ) -> Tensor:
        """Return ``[state_size]`` for one observation or ``[batch, state_size]``."""
        if isinstance(observations, Mapping):
            return self._encode_one(observations)
        if isinstance(observations, Sequence) and not isinstance(observations, (str, bytes)):
            if not observations:
                return self._zeros(0).reshape(0, self.state_size)
            if not all(isinstance(observation, Mapping) for observation in observations):
                raise TypeError("Every batched observation must be a mapping.")
            return torch.stack([self._encode_one(observation) for observation in observations])
        raise TypeError("observations must be an observation mapping or a sequence of mappings.")


def create_observation_encoder(
    *,
    entity_embeddings: Optional[EntityEmbeddingTables] = None,
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
    state_size: int = 256,
    component_size: int = 64,
) -> ObservationEncoder:
    """Create an observation encoder, optionally sharing legal-action embeddings."""
    registry = load_entity_registry(registry_path)
    shared_embeddings = entity_embeddings or create_entity_embeddings(registry_path)
    return ObservationEncoder(
        entity_embeddings=shared_embeddings,
        registry=registry,
        state_size=state_size,
        component_size=component_size,
    )
