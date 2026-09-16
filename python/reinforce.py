"""Masked REINFORCE baseline for the Node Smash Up headless environment."""

from __future__ import annotations

import argparse
import json
import math
import random
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

import torch
from torch import Tensor, nn
from torch.nn.utils.rnn import pad_sequence

import modal

from action_embeddings import (
    DEFAULT_REGISTRY_PATH,
    EntityEmbeddingTables,
    create_entity_embeddings,
    load_entity_registry,
)
from node_env import (
    BUILT_IN_POLICY_VERSIONS,
    EXTERNAL_PYTHON_POLICY_VERSION,
    NodeSmashUpEnv,
)
from observation_encoder import ObservationEncoder, create_observation_encoder


DEFAULT_CHECKPOINT_PATH = (
    Path(__file__).resolve().parents[1]
    / "training-data"
    / "checkpoints"
    / "reinforce.pt"
)
CHECKPOINT_SCHEMA_VERSION = 1
DEFAULT_TRAINING_OPPONENT_POLICIES = (
    "random-v1",
    "greedy_heuristic_1",
    "greedy_heuristic_2",
)


@dataclass
class ReinforceTransition:
    """One policy decision and the reward earned before that player's next decision."""

    player_id: str
    observation: Mapping[str, Any]
    legal_actions: list[Mapping[str, Any]]
    action_index: int
    reward: float = 0.0
    discounted_return: float = 0.0


@dataclass
class EpisodeRollout:
    """The policy decisions and outcome from one complete headless game."""

    transitions: list[ReinforceTransition]
    rewards_by_player: dict[str, float]
    terminated: bool
    truncated: bool
    decision_count: int
    game_result: Optional[Mapping[str, Any]] = None
    policy_versions: list[str] = field(default_factory=list)
    learned_player_ids: list[str] = field(default_factory=list)


class MaskedActionPolicy(nn.Module):
    """Score each legal action using shared observation and entity encoders."""

    def __init__(
        self,
        entity_embeddings: EntityEmbeddingTables,
        observation_encoder: ObservationEncoder,
        *,
        hidden_size: int = 256,
    ) -> None:
        super().__init__()
        if isinstance(hidden_size, bool) or not isinstance(hidden_size, int) or hidden_size < 1:
            raise ValueError("hidden_size must be a positive integer.")
        if observation_encoder.entity_embeddings is not entity_embeddings:
            raise ValueError("The observation and action encoders must share entity embeddings.")

        self.entity_embeddings = entity_embeddings
        self.observation_encoder = observation_encoder
        self.hidden_size = hidden_size
        self.state_projection = nn.Linear(observation_encoder.state_size, hidden_size)
        self.action_projection = nn.Linear(
            entity_embeddings.action_embedding_size,
            hidden_size,
        )
        self.action_scorer = nn.Sequential(
            nn.LayerNorm(hidden_size),
            nn.GELU(),
            nn.Linear(hidden_size, hidden_size),
            nn.GELU(),
            nn.Linear(hidden_size, 1),
        )

    @property
    def device(self) -> torch.device:
        return self.state_projection.weight.device

    def forward_batch(
        self,
        observations: Sequence[Mapping[str, Any]],
        legal_action_groups: Sequence[Sequence[Mapping[str, Any]]],
    ) -> tuple[Tensor, Tensor]:
        """Return padded logits and a mask for variable-length legal-action lists."""
        if len(observations) != len(legal_action_groups):
            raise ValueError("observations and legal_action_groups must have equal lengths.")
        if not observations:
            raise ValueError("Cannot score an empty policy batch.")
        if any(not actions for actions in legal_action_groups):
            raise ValueError("Every observation must have at least one legal action.")

        action_counts = torch.tensor(
            [len(actions) for actions in legal_action_groups],
            dtype=torch.long,
            device=self.device,
        )
        flat_actions = [action for actions in legal_action_groups for action in actions]
        state_vectors = self.observation_encoder(observations)
        action_vectors = self.entity_embeddings(flat_actions)
        repeated_states = self.state_projection(state_vectors).repeat_interleave(
            action_counts,
            dim=0,
        )
        flat_logits = self.action_scorer(
            repeated_states + self.action_projection(action_vectors)
        ).squeeze(-1)
        logit_groups = flat_logits.split(action_counts.tolist(), dim=0)
        logits = pad_sequence(logit_groups, batch_first=True, padding_value=float("-inf"))
        action_mask = (
            torch.arange(logits.shape[1], device=self.device).unsqueeze(0)
            < action_counts.unsqueeze(1)
        )
        return logits, action_mask

    def forward(
        self,
        observation: Mapping[str, Any],
        legal_actions: Sequence[Mapping[str, Any]],
    ) -> Tensor:
        """Return one logit for every action in the supplied ordered legal-action list."""
        logits, _ = self.forward_batch([observation], [legal_actions])
        return logits[0, :len(legal_actions)]

    @torch.no_grad()
    def sample_action(
        self,
        observation: Mapping[str, Any],
        legal_actions: Sequence[Mapping[str, Any]],
        *,
        generator: Optional[torch.Generator] = None,
    ) -> int:
        """Sample a valid action index from the masked policy distribution."""
        logits = self(observation, legal_actions)
        probabilities = torch.softmax(logits, dim=-1)
        selected = torch.multinomial(probabilities, 1, generator=generator)
        return int(selected.item())

def create_masked_action_policy(
    *,
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
    state_size: int = 256,
    component_size: int = 64,
    hidden_size: int = 256,
) -> MaskedActionPolicy:
    """Create a policy whose observation and action encoders share embeddings."""
    entity_embeddings = create_entity_embeddings(registry_path)
    observation_encoder = create_observation_encoder(
        entity_embeddings=entity_embeddings,
        registry_path=registry_path,
        state_size=state_size,
        component_size=component_size,
    )
    return MaskedActionPolicy(
        entity_embeddings,
        observation_encoder,
        hidden_size=hidden_size,
    )


def calculate_discounted_returns(
    transitions: Sequence[ReinforceTransition],
    *,
    gamma: float = 1.0,
) -> list[float]:
    """Calculate Monte Carlo returns along each player's own decision sequence."""
    if isinstance(gamma, bool) or not isinstance(gamma, (int, float)):
        raise TypeError("gamma must be a finite number between 0 and 1.")
    gamma = float(gamma)
    if not math.isfinite(gamma) or not 0.0 <= gamma <= 1.0:
        raise ValueError("gamma must be a finite number between 0 and 1.")

    running_returns: dict[str, float] = defaultdict(float)
    returns = [0.0] * len(transitions)
    for index in range(len(transitions) - 1, -1, -1):
        transition = transitions[index]
        running_return = transition.reward + gamma * running_returns[transition.player_id]
        running_returns[transition.player_id] = running_return
        transition.discounted_return = running_return
        returns[index] = running_return
    return returns


def _finite_reward(value: Any, *, player_id: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"Node returned a non-numeric reward for {player_id}.")
    reward = float(value)
    if not math.isfinite(reward):
        raise ValueError(f"Node returned a non-finite reward for {player_id}.")
    return reward


def build_training_lineup(
    *,
    player_count: int,
    episode_number: int,
    seed: int | str,
    heuristic_game_probability: float,
    opponent_policies: Sequence[str],
) -> list[str]:
    """Create a reproducible self-play or one-learner mixed-policy lineup."""
    if player_count not in (2, 3, 4):
        raise ValueError("player_count must be 2, 3, or 4.")
    if (
        isinstance(episode_number, bool)
        or not isinstance(episode_number, int)
        or episode_number < 1
    ):
        raise ValueError("episode_number must be a positive integer.")
    if (
        isinstance(heuristic_game_probability, bool)
        or not isinstance(heuristic_game_probability, (int, float))
        or not math.isfinite(float(heuristic_game_probability))
        or not 0.0 <= float(heuristic_game_probability) <= 1.0
    ):
        raise ValueError("heuristic_game_probability must be between 0 and 1.")
    unsupported = [
        policy_version for policy_version in opponent_policies
        if policy_version not in BUILT_IN_POLICY_VERSIONS
    ]
    if unsupported:
        raise ValueError(f"Unsupported built-in opponent policy: {unsupported[0]}")

    lineup_random = random.Random(f"{seed!r}:training-lineup:{episode_number}")
    if lineup_random.random() >= float(heuristic_game_probability):
        return [EXTERNAL_PYTHON_POLICY_VERSION] * player_count
    if not opponent_policies:
        raise ValueError("opponent_policies cannot be empty for heuristic games.")

    learned_seat = (episode_number - 1) % player_count
    return [
        EXTERNAL_PYTHON_POLICY_VERSION
        if seat == learned_seat
        else lineup_random.choice(opponent_policies)
        for seat in range(player_count)
    ]


def collect_episode(
    environment: NodeSmashUpEnv,
    policy: MaskedActionPolicy,
    *,
    seed: Optional[int | str] = None,
    player_count: int = 3,
    max_decisions: int = 10_000,
    gamma: float = 1.0,
    generator: Optional[torch.Generator] = None,
    policy_versions: Optional[Sequence[str]] = None,
) -> EpisodeRollout:
    """Run a game and retain on-policy decisions from neural-policy seats only."""
    if policy_versions is not None and len(policy_versions) != player_count:
        raise ValueError("policy_versions must contain one entry per player seat.")
    resolved_policy_versions = list(
        policy_versions
        or [EXTERNAL_PYTHON_POLICY_VERSION] * player_count
    )
    unsupported = [
        policy_version for policy_version in resolved_policy_versions
        if policy_version != EXTERNAL_PYTHON_POLICY_VERSION
        and policy_version not in BUILT_IN_POLICY_VERSIONS
    ]
    if unsupported:
        raise ValueError(f"Unsupported training policy version: {unsupported[0]}")
    if EXTERNAL_PYTHON_POLICY_VERSION not in resolved_policy_versions:
        raise ValueError("At least one player seat must use the trainable policy.")
    state = environment.reset(
        seed=seed,
        player_count=player_count,
        max_decisions=max_decisions,
        record_trajectory=False,
        policy_versions=resolved_policy_versions,
    )
    initial_observation = state.get("observation")
    players = initial_observation.get("players") if isinstance(initial_observation, Mapping) else None
    if policy_versions is None and not isinstance(players, list):
        player_policy_versions: dict[str, str] = {}
        learned_player_ids: list[str] = []
    else:
        if not isinstance(players, list) or len(players) != player_count:
            raise ValueError("Node did not return the players for the configured lineup.")
        player_policy_versions = {
            str(player.get("id")): policy_version
            for player, policy_version in zip(players, resolved_policy_versions)
            if isinstance(player, Mapping) and isinstance(player.get("id"), str)
        }
        if len(player_policy_versions) != player_count:
            raise ValueError("Node returned an invalid player order for the configured lineup.")
        learned_player_ids = [
            player_id for player_id, policy_version in player_policy_versions.items()
            if policy_version == EXTERNAL_PYTHON_POLICY_VERSION
        ]
    transitions: list[ReinforceTransition] = []
    pending_transition_by_player: dict[str, int] = {}
    accrued_rewards: dict[str, float] = defaultdict(float)
    total_rewards: dict[str, float] = defaultdict(float)
    decision_count = 0

    while True:
        observation = state.get("observation")
        legal_actions = state.get("legalActions")
        info = state.get("info")
        if not isinstance(observation, Mapping):
            raise ValueError("Node did not return a decision observation.")
        if not isinstance(legal_actions, list) or not legal_actions:
            raise ValueError("Node did not return a non-empty legal-action list.")
        if not isinstance(info, Mapping):
            raise ValueError("Node did not return decision metadata.")
        # After step(), info.actorId describes the action that just finished while
        # the returned observation belongs to the next decision maker.
        actor_id = observation.get("observerPlayerId")
        if not isinstance(actor_id, str):
            raise ValueError("Node did not identify the observation's acting player.")
        actor_policy_version = player_policy_versions.get(
            actor_id,
            EXTERNAL_PYTHON_POLICY_VERSION,
        )

        if actor_policy_version == EXTERNAL_PYTHON_POLICY_VERSION:
            if actor_id not in learned_player_ids:
                learned_player_ids.append(actor_id)
            previous_index = pending_transition_by_player.get(actor_id)
            if previous_index is not None:
                transitions[previous_index].reward = accrued_rewards.pop(actor_id, 0.0)

            action_index = policy.sample_action(
                observation,
                legal_actions,
                generator=generator,
            )
            transitions.append(ReinforceTransition(
                player_id=actor_id,
                observation=observation,
                legal_actions=legal_actions,
                action_index=action_index,
            ))
            pending_transition_by_player[actor_id] = len(transitions) - 1
        else:
            action_index = environment.choose_builtin_action(actor_policy_version)

        state = environment.step(action_index)
        decision_count += 1
        next_info = state.get("info")
        rewards_by_player = next_info.get("rewardsByPlayer") if isinstance(next_info, Mapping) else None
        if not isinstance(rewards_by_player, Mapping):
            raise ValueError("Node did not return rewardsByPlayer transition metadata.")
        for player_id, raw_reward in rewards_by_player.items():
            reward = _finite_reward(raw_reward, player_id=str(player_id))
            accrued_rewards[str(player_id)] += reward
            total_rewards[str(player_id)] += reward

        terminated = state.get("terminated") is True
        truncated = state.get("truncated") is True
        if terminated or truncated:
            for player_id, transition_index in pending_transition_by_player.items():
                transitions[transition_index].reward = accrued_rewards.get(player_id, 0.0)
            calculate_discounted_returns(transitions, gamma=gamma)
            result = environment.result()
            return EpisodeRollout(
                transitions=transitions,
                rewards_by_player=dict(total_rewards),
                terminated=terminated,
                truncated=truncated,
                decision_count=int(result.get("decisionCount", decision_count)),
                game_result=result.get("gameResult") if isinstance(result, Mapping) else None,
                policy_versions=resolved_policy_versions,
                learned_player_ids=learned_player_ids,
            )


def normalize_return_tensor(returns: Tensor, epsilon: float = 1e-8) -> Tensor:
    """Apply a batch baseline and scale without producing NaNs for tiny batches."""
    if returns.ndim != 1:
        raise ValueError("returns must be a one-dimensional tensor.")
    if returns.numel() < 2:
        return returns
    standard_deviation = returns.std(unbiased=False)
    if standard_deviation <= epsilon:
        return returns - returns.mean()
    return (returns - returns.mean()) / (standard_deviation + epsilon)


def reinforce_update(
    policy: MaskedActionPolicy,
    optimizer: torch.optim.Optimizer,
    transitions: Sequence[ReinforceTransition],
    *,
    batch_size: int = 128,
    entropy_coefficient: float = 0.01,
    normalize_returns: bool = True,
    max_gradient_norm: float = 1.0,
    generator: Optional[torch.Generator] = None,
) -> dict[str, float]:
    """Perform one REINFORCE update over a fresh on-policy rollout batch."""
    if not transitions:
        raise ValueError("Cannot train REINFORCE without transitions.")
    if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size < 1:
        raise ValueError("batch_size must be a positive integer.")
    if entropy_coefficient < 0:
        raise ValueError("entropy_coefficient must be non-negative.")
    if max_gradient_norm <= 0:
        raise ValueError("max_gradient_norm must be positive.")

    raw_returns = torch.tensor(
        [transition.discounted_return for transition in transitions],
        dtype=policy.state_projection.weight.dtype,
        device=policy.device,
    )
    advantages = normalize_return_tensor(raw_returns) if normalize_returns else raw_returns
    order = torch.randperm(len(transitions), generator=generator).tolist()
    optimizer.zero_grad(set_to_none=True)
    policy_loss_total = 0.0
    entropy_total = 0.0

    for start in range(0, len(order), batch_size):
        batch_indices = order[start:start + batch_size]
        batch = [transitions[index] for index in batch_indices]
        logits, action_mask = policy.forward_batch(
            [transition.observation for transition in batch],
            [transition.legal_actions for transition in batch],
        )
        chosen_indices = torch.tensor(
            [transition.action_index for transition in batch],
            dtype=torch.long,
            device=policy.device,
        )
        log_probabilities = torch.log_softmax(logits, dim=-1)
        selected_log_probabilities = log_probabilities.gather(
            1,
            chosen_indices.unsqueeze(1),
        ).squeeze(1)
        probabilities = torch.softmax(logits, dim=-1)
        safe_log_probabilities = torch.where(
            action_mask,
            log_probabilities,
            torch.zeros_like(log_probabilities),
        )
        entropy = -(probabilities * safe_log_probabilities).sum(dim=1).mean()
        batch_advantages = advantages[batch_indices]
        policy_loss = -(selected_log_probabilities * batch_advantages.detach()).mean()
        loss = policy_loss - entropy_coefficient * entropy
        batch_weight = len(batch) / len(transitions)
        (loss * batch_weight).backward()
        policy_loss_total += float(policy_loss.detach()) * batch_weight
        entropy_total += float(entropy.detach()) * batch_weight

    gradient_norm = nn.utils.clip_grad_norm_(policy.parameters(), max_gradient_norm)
    optimizer.step()
    return {
        "loss": policy_loss_total - entropy_coefficient * entropy_total,
        "policyLoss": policy_loss_total,
        "entropy": entropy_total,
        "meanReturn": float(raw_returns.mean()),
        "returnStd": float(raw_returns.std(unbiased=False)),
        "gradientNorm": float(gradient_norm),
        "transitionCount": float(len(transitions)),
    }


def save_reinforce_checkpoint(
    path: Path | str,
    *,
    policy: MaskedActionPolicy,
    optimizer: torch.optim.Optimizer,
    episodes_completed: int,
    updates_completed: int,
    training_config: Mapping[str, Any],
) -> Path:
    """Atomically save enough state to resume or deploy the learned policy."""
    checkpoint_path = Path(path)
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = checkpoint_path.with_suffix(f"{checkpoint_path.suffix}.tmp")
    registry = load_entity_registry()
    checkpoint_config = dict(training_config)
    checkpoint_config.update({
        "stateSize": policy.observation_encoder.state_size,
        "componentSize": policy.observation_encoder.component_size,
        "hiddenSize": policy.hidden_size,
    })
    torch.save({
        "checkpointSchemaVersion": CHECKPOINT_SCHEMA_VERSION,
        "entityIdSchemaVersion": registry["schemaVersion"],
        "episodesCompleted": episodes_completed,
        "updatesCompleted": updates_completed,
        "trainingConfig": checkpoint_config,
        "modelState": policy.state_dict(),
        "optimizerState": optimizer.state_dict(),
    }, temporary_path)
    temporary_path.replace(checkpoint_path)
    return checkpoint_path


def load_reinforce_checkpoint(
    path: Path | str,
    *,
    device: torch.device | str = "cpu",
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
) -> tuple[MaskedActionPolicy, dict[str, Any]]:
    """Validate a checkpoint and reconstruct the exact policy architecture."""
    checkpoint_path = Path(path)
    if not checkpoint_path.is_file():
        raise FileNotFoundError(f"REINFORCE checkpoint does not exist: {checkpoint_path}")
    resolved_device = torch.device(device)
    try:
        raw_checkpoint = torch.load(
            checkpoint_path,
            map_location=resolved_device,
            weights_only=True,
        )
    except TypeError:  # PyTorch versions before weights_only was introduced.
        raw_checkpoint = torch.load(checkpoint_path, map_location=resolved_device)
    if not isinstance(raw_checkpoint, Mapping):
        raise ValueError("The REINFORCE checkpoint must contain a mapping.")
    checkpoint = dict(raw_checkpoint)
    if checkpoint.get("checkpointSchemaVersion") != CHECKPOINT_SCHEMA_VERSION:
        raise ValueError(
            f"Unsupported REINFORCE checkpoint schema: "
            f"{checkpoint.get('checkpointSchemaVersion')!r}."
        )

    registry = load_entity_registry(registry_path)
    if checkpoint.get("entityIdSchemaVersion") != registry["schemaVersion"]:
        raise ValueError("The checkpoint entity IDs do not match the current registry.")
    training_config = checkpoint.get("trainingConfig")
    model_state = checkpoint.get("modelState")
    if not isinstance(training_config, Mapping):
        raise ValueError("The checkpoint is missing trainingConfig.")
    if training_config.get("algorithm") != "reinforce":
        raise ValueError("The checkpoint was not created by the REINFORCE trainer.")
    if not isinstance(model_state, Mapping):
        raise ValueError("The checkpoint is missing modelState.")

    architecture = {
        "state_size": training_config.get("stateSize", 256),
        "component_size": training_config.get("componentSize", 64),
        "hidden_size": training_config.get("hiddenSize", 256),
    }
    if any(
        isinstance(value, bool) or not isinstance(value, int) or value < 1
        for value in architecture.values()
    ):
        raise ValueError("The checkpoint contains invalid policy dimensions.")
    policy = create_masked_action_policy(
        registry_path=registry_path,
        **architecture,
    ).to(resolved_device)
    policy.load_state_dict(model_state)
    return policy, checkpoint


def get_periodic_checkpoint_path(
    checkpoint_path: Path | str,
    episodes_completed: int,
) -> Path:
    """Return a stable milestone filename beside the latest checkpoint."""
    if (
        isinstance(episodes_completed, bool)
        or not isinstance(episodes_completed, int)
        or episodes_completed < 1
    ):
        raise ValueError("episodes_completed must be a positive integer.")
    path = Path(checkpoint_path)
    return path.with_name(
        f"{path.stem}-episodes-{episodes_completed:06d}{path.suffix}"
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:3001")
    parser.add_argument("--episodes", type=int, default=100)
    parser.add_argument("--episodes-per-update", type=int, default=4)
    parser.add_argument(
        "--checkpoint-every",
        type=int,
        default=10,
        help="Save latest and numbered checkpoints after this many completed games; 0 disables.",
    )
    parser.add_argument("--player-count", type=int, choices=(2, 3, 4), default=3)
    parser.add_argument("--max-decisions", type=int, default=10_000)
    parser.add_argument("--seed", type=int, default=380)
    parser.add_argument("--gamma", type=float, default=1.0)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--entropy-coefficient", type=float, default=0.01)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--hidden-size", type=int, default=256)
    parser.add_argument("--device", default="cpu")
    parser.add_argument(
        "--heuristic-game-probability",
        type=float,
        default=0.5,
        help=(
            "Probability that an episode uses one learned seat and built-in opponents; "
            "the remaining episodes use full self-play."
        ),
    )
    parser.add_argument(
        "--opponent-policies",
        nargs="+",
        choices=BUILT_IN_POLICY_VERSIONS,
        default=DEFAULT_TRAINING_OPPONENT_POLICIES,
        help="Built-in policies sampled independently for non-learned seats.",
    )
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument(
        "--resume",
        type=Path,
        help="Resume model and optimizer state from an existing checkpoint.",
    )
    parser.add_argument("--no-normalize-returns", action="store_true")
    return parser.parse_args()


def _validate_training_args(args: argparse.Namespace) -> None:
    for field in ("episodes", "episodes_per_update", "max_decisions", "batch_size"):
        if getattr(args, field) < 1:
            raise ValueError(f"--{field.replace('_', '-')} must be positive.")
    if args.checkpoint_every < 0:
        raise ValueError("--checkpoint-every must be non-negative.")
    if not 0.0 <= args.gamma <= 1.0:
        raise ValueError("--gamma must be between 0 and 1.")
    if args.learning_rate <= 0:
        raise ValueError("--learning-rate must be positive.")
    if not 0.0 <= args.heuristic_game_probability <= 1.0:
        raise ValueError("--heuristic-game-probability must be between 0 and 1.")


def train_reinforce(args: argparse.Namespace) -> dict[str, Any]:
    """Collect fresh games, update the shared policy, and save its checkpoint."""
    _validate_training_args(args)
    torch.manual_seed(args.seed)
    device = torch.device(args.device)
    starting_episodes = 0
    starting_updates = 0
    if args.resume:
        policy, resumed_checkpoint = load_reinforce_checkpoint(args.resume, device=device)
        optimizer_state = resumed_checkpoint.get("optimizerState")
        if not isinstance(optimizer_state, Mapping):
            raise ValueError("The resume checkpoint is missing optimizerState.")
        optimizer = torch.optim.Adam(policy.parameters(), lr=args.learning_rate)
        optimizer.load_state_dict(optimizer_state)
        for parameter_group in optimizer.param_groups:
            parameter_group["lr"] = args.learning_rate
        starting_episodes = int(resumed_checkpoint.get("episodesCompleted", 0))
        starting_updates = int(resumed_checkpoint.get("updatesCompleted", 0))
    else:
        policy = create_masked_action_policy(hidden_size=args.hidden_size).to(device)
        optimizer = torch.optim.Adam(policy.parameters(), lr=args.learning_rate)
    policy.train()
    checkpoint_path = Path(args.checkpoint or args.resume or DEFAULT_CHECKPOINT_PATH)
    training_config = {
        "algorithm": "reinforce",
        "playerCount": args.player_count,
        "maxDecisions": args.max_decisions,
        "gamma": args.gamma,
        "learningRate": args.learning_rate,
        "entropyCoefficient": args.entropy_coefficient,
        "batchSize": args.batch_size,
        "episodesPerUpdate": args.episodes_per_update,
        "checkpointEvery": args.checkpoint_every,
        "heuristicGameProbability": args.heuristic_game_probability,
        "opponentPolicies": list(args.opponent_policies),
        "normalizeReturns": not args.no_normalize_returns,
        "stateSize": policy.observation_encoder.state_size,
        "componentSize": policy.observation_encoder.component_size,
        "hiddenSize": policy.hidden_size,
    }
    rollout_batch: list[ReinforceTransition] = []
    episodes_in_batch = 0
    updates_completed = starting_updates
    trained_episodes = 0
    truncated_episodes = 0
    heuristic_episodes = 0
    self_play_episodes = 0
    last_metrics: dict[str, float] = {}
    periodic_checkpoints: list[str] = []

    def update_policy(episode_number: int) -> None:
        nonlocal episodes_in_batch, last_metrics, rollout_batch, updates_completed
        updates_completed += 1
        last_metrics = reinforce_update(
            policy,
            optimizer,
            rollout_batch,
            batch_size=args.batch_size,
            entropy_coefficient=args.entropy_coefficient,
            normalize_returns=not args.no_normalize_returns,
        )
        print(json.dumps({
            "episode": episode_number,
            "update": updates_completed,
            "episodesInUpdate": episodes_in_batch,
            **last_metrics,
        }))
        rollout_batch = []
        episodes_in_batch = 0

    with NodeSmashUpEnv(args.base_url) as environment:
        for episode_index in range(args.episodes):
            episode_number = starting_episodes + episode_index + 1
            episode_seed = args.seed + starting_episodes + episode_index
            policy_versions = build_training_lineup(
                player_count=args.player_count,
                episode_number=episode_number,
                seed=episode_seed,
                heuristic_game_probability=args.heuristic_game_probability,
                opponent_policies=args.opponent_policies,
            )
            is_heuristic_episode = any(
                policy_version != EXTERNAL_PYTHON_POLICY_VERSION
                for policy_version in policy_versions
            )
            if is_heuristic_episode:
                heuristic_episodes += 1
            else:
                self_play_episodes += 1
            rollout = collect_episode(
                environment,
                policy,
                seed=episode_seed,
                player_count=args.player_count,
                max_decisions=args.max_decisions,
                gamma=args.gamma,
                policy_versions=policy_versions,
            )
            if rollout.truncated:
                truncated_episodes += 1
                print(json.dumps({
                    "episode": episode_index + 1,
                    "status": "truncated-skipped",
                    "decisionCount": rollout.decision_count,
                    "lineup": rollout.policy_versions,
                    "learnedPlayerIds": rollout.learned_player_ids,
                }))
                continue

            rollout_batch.extend(rollout.transitions)
            episodes_in_batch += 1
            trained_episodes += 1
            print(json.dumps({
                "episode": episode_index + 1,
                "status": "rollout-completed",
                "mode": "heuristic-opponents" if is_heuristic_episode else "self-play",
                "lineup": rollout.policy_versions,
                "learnedPlayerIds": rollout.learned_player_ids,
                "policyTransitions": len(rollout.transitions),
                "decisionCount": rollout.decision_count,
            }))
            total_trained_episodes = starting_episodes + trained_episodes
            checkpoint_due = (
                args.checkpoint_every > 0
                and total_trained_episodes % args.checkpoint_every == 0
            )
            if episodes_in_batch < args.episodes_per_update and not checkpoint_due:
                continue

            update_policy(episode_index + 1)
            if checkpoint_due:
                save_reinforce_checkpoint(
                    checkpoint_path,
                    policy=policy,
                    optimizer=optimizer,
                    episodes_completed=total_trained_episodes,
                    updates_completed=updates_completed,
                    training_config=training_config,
                )
                milestone_path = get_periodic_checkpoint_path(
                    checkpoint_path,
                    total_trained_episodes,
                )
                save_reinforce_checkpoint(
                    milestone_path,
                    policy=policy,
                    optimizer=optimizer,
                    episodes_completed=total_trained_episodes,
                    updates_completed=updates_completed,
                    training_config=training_config,
                )
                periodic_checkpoints.append(str(milestone_path))
                print(json.dumps({
                    "episode": episode_index + 1,
                    "status": "periodic-checkpoint-saved",
                    "checkpoint": str(checkpoint_path),
                    "milestoneCheckpoint": str(milestone_path),
                    "totalTrainedEpisodes": total_trained_episodes,
                }))

        if rollout_batch:
            update_policy(args.episodes)

    checkpoint_path = save_reinforce_checkpoint(
        checkpoint_path,
        policy=policy,
        optimizer=optimizer,
        episodes_completed=starting_episodes + trained_episodes,
        updates_completed=updates_completed,
        training_config=training_config,
    )
    summary = {
        "algorithm": "reinforce",
        "attemptedEpisodes": args.episodes,
        "trainedEpisodes": trained_episodes,
        "totalTrainedEpisodes": starting_episodes + trained_episodes,
        "truncatedEpisodes": truncated_episodes,
        "heuristicEpisodes": heuristic_episodes,
        "selfPlayEpisodes": self_play_episodes,
        "updatesCompleted": updates_completed,
        "checkpoint": str(checkpoint_path),
        "periodicCheckpoints": periodic_checkpoints,
        "lastMetrics": last_metrics,
    }
    print(json.dumps(summary, indent=2))
    return summary


if __name__ == "__main__":
    train_reinforce(_parse_args())
