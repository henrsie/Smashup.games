"""Trainable embeddings for server-provided Smash Up legal actions."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

import torch
from torch import Tensor, nn


DEFAULT_REGISTRY_PATH = (
    Path(__file__).resolve().parents[1] / "shared" / "gameEntityIds.json"
)
DEFAULT_EMBEDDING_DIMENSIONS = {
    "actionTypes": 8,
    "choiceTypes": 8,
    "cardZones": 4,
    "eventTypes": 8,
    "cards": 32,
    "bases": 8,
    "factions": 8,
}

ACTION_NUMERIC_FEATURES = (
    ("sourceOwnerSeat", 4.0),
    ("sourceBasePosition", 5.0),
    ("sourceCardPosition", 40.0),
    ("sourceParentCardPosition", 20.0),
    ("targetOwnerSeat", 4.0),
    ("targetBasePosition", 5.0),
    ("targetCardPosition", 40.0),
    ("targetParentCardPosition", 20.0),
    ("selectedPlayerSeat", 4.0),
    ("chosenBasePosition", 5.0),
    ("baseDeckPosition", 20.0),
    ("selectionCount", 10.0),
    ("amount", 10.0),
    ("fromDiscard", 1.0),
    ("candidateOrdinal", 10.0),
)


def load_entity_registry(
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
) -> dict[str, Any]:
    """Load and minimally validate the committed Node/Python entity registry."""
    with Path(registry_path).open(encoding="utf-8") as registry_file:
        registry = json.load(registry_file)

    if registry.get("unknownId") != 0:
        raise ValueError("The entity registry must reserve ID 0 for unknown/padding.")
    for namespace in DEFAULT_EMBEDDING_DIMENSIONS:
        mapping = registry.get(namespace)
        if not isinstance(mapping, dict) or not mapping:
            raise ValueError(f"The entity registry is missing the {namespace!r} namespace.")
        ids = list(mapping.values())
        if any(isinstance(entity_id, bool) or not isinstance(entity_id, int) for entity_id in ids):
            raise ValueError(f"Every ID in {namespace!r} must be an integer.")
        if any(entity_id <= registry["unknownId"] for entity_id in ids):
            raise ValueError(f"Every registered ID in {namespace!r} must be greater than 0.")
        if len(ids) != len(set(ids)):
            raise ValueError(f"IDs in {namespace!r} must be unique.")
    return registry


class EntityEmbeddingTables(nn.Module):
    """Embed the categorical fields attached to an ordered legal-action list."""

    def __init__(
        self,
        registry: Mapping[str, Any],
        dimensions: Optional[Mapping[str, int]] = None,
    ) -> None:
        super().__init__()
        configured_dimensions = {
            **DEFAULT_EMBEDDING_DIMENSIONS,
            **(dimensions or {}),
        }
        invalid_dimensions = {
            namespace: dimension
            for namespace, dimension in configured_dimensions.items()
            if namespace not in DEFAULT_EMBEDDING_DIMENSIONS
            or isinstance(dimension, bool)
            or not isinstance(dimension, int)
            or dimension < 1
        }
        if invalid_dimensions:
            raise ValueError(f"Invalid embedding dimensions: {invalid_dimensions}")

        self.unknown_id = int(registry["unknownId"])
        self.schema_version = int(registry["schemaVersion"])
        self.namespace_max_ids = {
            namespace: max(mapping.values())
            for namespace, mapping in (
                (namespace, registry[namespace])
                for namespace in DEFAULT_EMBEDDING_DIMENSIONS
            )
        }
        self.namespace_valid_ids = {
            namespace: frozenset(registry[namespace].values())
            for namespace in DEFAULT_EMBEDDING_DIMENSIONS
        }
        self.dimensions = configured_dimensions

        self.action_types = self._create_table("actionTypes")
        self.choice_types = self._create_table("choiceTypes")
        self.card_zones = self._create_table("cardZones")
        self.event_types = self._create_table("eventTypes")
        self.cards = self._create_table("cards")
        self.bases = self._create_table("bases")
        self.factions = self._create_table("factions")

    def _create_table(self, namespace: str) -> nn.Embedding:
        return nn.Embedding(
            num_embeddings=self.namespace_max_ids[namespace] + 1,
            embedding_dim=self.dimensions[namespace],
            padding_idx=self.unknown_id,
        )

    @property
    def action_embedding_size(self) -> int:
        """Width of each vector returned by ``forward``."""
        return (
            self.dimensions["actionTypes"]
            + self.dimensions["choiceTypes"]
            + 2 * self.dimensions["cardZones"]
            + 3 * self.dimensions["cards"]
            + self.dimensions["bases"]
            + self.dimensions["factions"]
            + len(ACTION_NUMERIC_FEATURES)
        )

    def _safe_id(self, namespace: str, value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            return self.unknown_id
        if value != self.unknown_id and value not in self.namespace_valid_ids[namespace]:
            return self.unknown_id
        return value

    def _id_tensor(self, namespace: str, values: Sequence[Any]) -> Tensor:
        device = self.action_types.weight.device
        return torch.tensor(
            [self._safe_id(namespace, value) for value in values],
            dtype=torch.long,
            device=device,
        )

    def _embed_selected_cards(self, legal_actions: Sequence[Mapping[str, Any]]) -> Tensor:
        device = self.cards.weight.device
        pooled_embeddings = []
        for action in legal_actions:
            selected_ids = action.get("entityIds", {}).get("selectedCardEntityIds", [])
            if not isinstance(selected_ids, list) or not selected_ids:
                pooled_embeddings.append(
                    torch.zeros(self.dimensions["cards"], device=device)
                )
                continue
            selected_tensor = self._id_tensor("cards", selected_ids)
            pooled_embeddings.append(self.cards(selected_tensor).mean(dim=0))
        return torch.stack(pooled_embeddings)

    def _numeric_feature_vectors(
        self,
        legal_actions: Sequence[Mapping[str, Any]],
    ) -> Tensor:
        rows = []
        for action in legal_actions:
            choice_features = action.get("choiceFeatures", {})
            if not isinstance(choice_features, Mapping):
                choice_features = {}
            row = []
            for field, scale in ACTION_NUMERIC_FEATURES:
                value = choice_features.get(field, 0)
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    numeric_value = 0.0
                else:
                    numeric_value = float(value)
                    if not math.isfinite(numeric_value):
                        numeric_value = 0.0
                row.append(math.tanh(numeric_value / scale))
            rows.append(row)
        return torch.tensor(
            rows,
            dtype=self.action_types.weight.dtype,
            device=self.action_types.weight.device,
        )

    def forward(self, legal_actions: Sequence[Mapping[str, Any]]) -> Tensor:
        """Convert legal-action JSON objects into one trainable vector per action."""
        if not legal_actions:
            return self.action_types.weight.new_empty((0, self.action_embedding_size))

        entity_ids = [action.get("entityIds", {}) for action in legal_actions]
        action_type_vectors = self.action_types(self._id_tensor(
            "actionTypes",
            [action.get("actionTypeId") for action in legal_actions],
        ))
        choice_type_vectors = self.choice_types(self._id_tensor(
            "choiceTypes",
            [action.get("choiceTypeId") for action in legal_actions],
        ))
        choice_features = [
            features if isinstance(features, Mapping) else {}
            for features in (
                action.get("choiceFeatures", {}) for action in legal_actions
            )
        ]
        source_zone_vectors = self.card_zones(self._id_tensor(
            "cardZones",
            [features.get("sourceZoneId") for features in choice_features],
        ))
        target_zone_vectors = self.card_zones(self._id_tensor(
            "cardZones",
            [features.get("targetZoneId") for features in choice_features],
        ))
        card_vectors = self.cards(self._id_tensor(
            "cards",
            [ids.get("cardEntityId") for ids in entity_ids],
        ))
        target_card_vectors = self.cards(self._id_tensor(
            "cards",
            [ids.get("targetCardEntityId") for ids in entity_ids],
        ))
        selected_card_vectors = self._embed_selected_cards(legal_actions)
        base_vectors = self.bases(self._id_tensor(
            "bases",
            [ids.get("baseEntityId") for ids in entity_ids],
        ))
        faction_vectors = self.factions(self._id_tensor(
            "factions",
            [ids.get("factionEntityId") for ids in entity_ids],
        ))
        numeric_feature_vectors = self._numeric_feature_vectors(legal_actions)

        return torch.cat(
            [
                action_type_vectors,
                choice_type_vectors,
                source_zone_vectors,
                target_zone_vectors,
                card_vectors,
                target_card_vectors,
                selected_card_vectors,
                base_vectors,
                faction_vectors,
                numeric_feature_vectors,
            ],
            dim=-1,
        )


def create_entity_embeddings(
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
    dimensions: Optional[Mapping[str, int]] = None,
) -> EntityEmbeddingTables:
    """Create trainable embedding tables from the shared entity-ID registry."""
    return EntityEmbeddingTables(
        registry=load_entity_registry(registry_path),
        dimensions=dimensions,
    )
