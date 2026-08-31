"""Evaluate a REINFORCE checkpoint against Node's built-in bot policies."""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import fmean
from typing import Any, Mapping, Optional, Sequence

import torch

from node_env import (
    BUILT_IN_POLICY_VERSIONS,
    EXTERNAL_PYTHON_POLICY_VERSION,
    NodeSmashUpEnv,
)
from reinforce import (
    DEFAULT_CHECKPOINT_PATH,
    MaskedActionPolicy,
    load_reinforce_checkpoint,
)


DEFAULT_OPPONENTS = (
    "random-v1",
    "first-legal-v1",
    "greedy_heuristic_1",
    "greedy_heuristic_2",
)
LEARNED_POLICY_VERSION = EXTERNAL_PYTHON_POLICY_VERSION


def build_evaluation_jobs(
    *,
    opponents: Sequence[str],
    games_per_seat: int,
    player_count: int,
    seed: int,
    max_decisions: int = 1000,
    sample_actions: bool = False,
) -> list[dict[str, Any]]:
    """Create independent, reproducible game jobs for local or parallel evaluation."""
    if games_per_seat < 1:
        raise ValueError("games_per_seat must be positive.")
    if player_count not in (2, 3, 4):
        raise ValueError("player_count must be 2, 3, or 4.")
    if max_decisions < 1:
        raise ValueError("max_decisions must be positive.")
    unsupported = [
        opponent for opponent in opponents
        if opponent not in BUILT_IN_POLICY_VERSIONS
    ]
    if unsupported:
        raise ValueError(f"Unsupported built-in opponent policy: {unsupported[0]}")

    jobs: list[dict[str, Any]] = []
    for opponent_policy in opponents:
        for game_index in range(games_per_seat):
            game_seed = seed + game_index
            for learned_seat in range(player_count):
                evaluation_game = len(jobs) + 1
                jobs.append({
                    "evaluationGame": evaluation_game,
                    "opponentPolicy": opponent_policy,
                    "learnedSeat": learned_seat,
                    "playerCount": player_count,
                    "seed": game_seed,
                    "policySeed": seed + evaluation_game - 1,
                    "maxDecisions": max_decisions,
                    "sampleActions": sample_actions,
                })
    return jobs


@torch.no_grad()
def choose_checkpoint_action(
    policy: MaskedActionPolicy,
    observation: Mapping[str, Any],
    legal_actions: Sequence[Mapping[str, Any]],
    *,
    sample_actions: bool = False,
) -> int:
    """Choose an argmax action by default, or sample from the learned distribution."""
    if sample_actions:
        return policy.sample_action(observation, legal_actions)
    return int(policy(observation, legal_actions).argmax().item())


def run_evaluation_game(
    environment: NodeSmashUpEnv,
    policy: MaskedActionPolicy,
    *,
    opponent_policy: str,
    learned_seat: int,
    player_count: int,
    seed: int,
    max_decisions: int = 1000,
    sample_actions: bool = False,
) -> dict[str, Any]:
    """Run one game with the checkpoint in one seat and built-in bots elsewhere."""
    if opponent_policy not in BUILT_IN_POLICY_VERSIONS:
        raise ValueError(f"Unsupported built-in opponent policy: {opponent_policy}")
    if not 0 <= learned_seat < player_count:
        raise ValueError("learned_seat must identify one of the player seats.")
    policy_versions = [opponent_policy] * player_count
    policy_versions[learned_seat] = LEARNED_POLICY_VERSION
    state = environment.reset(
        seed=seed,
        player_count=player_count,
        max_decisions=max_decisions,
        record_trajectory=False,
        policy_versions=policy_versions,
    )
    players = state.get("observation", {}).get("players", [])
    if len(players) != player_count:
        raise ValueError("Node returned an unexpected number of evaluation players.")
    learned_player_id = players[learned_seat].get("id")
    if not isinstance(learned_player_id, str):
        raise ValueError("Node did not identify the learned player's seat.")

    while True:
        observation = state.get("observation")
        legal_actions = state.get("legalActions")
        if not isinstance(observation, Mapping):
            raise ValueError("Node did not return an evaluation observation.")
        if not isinstance(legal_actions, list) or not legal_actions:
            raise ValueError("Node did not return evaluation legal actions.")
        actor_id = observation.get("observerPlayerId")
        if actor_id == learned_player_id:
            action_index = choose_checkpoint_action(
                policy,
                observation,
                legal_actions,
                sample_actions=sample_actions,
            )
        else:
            action_index = environment.choose_builtin_action(opponent_policy)

        state = environment.step(action_index)
        if state.get("terminated") is True or state.get("truncated") is True:
            break

    result = environment.result()
    game_result = result.get("gameResult") if isinstance(result, Mapping) else None
    standings = game_result.get("standings", []) if isinstance(game_result, Mapping) else []
    learned_standing = next((
        standing for standing in standings
        if standing.get("playerId") == learned_player_id
    ), None)
    terminated = state.get("terminated") is True
    truncated = state.get("truncated") is True
    return {
        "seed": seed,
        "opponentPolicy": opponent_policy,
        "learnedSeat": learned_seat,
        "learnedPlayerId": learned_player_id,
        "terminated": terminated,
        "truncated": truncated,
        "decisionCount": result.get("decisionCount", 0),
        "winnerId": game_result.get("winnerId") if isinstance(game_result, Mapping) else None,
        "won": bool(
            terminated
            and isinstance(game_result, Mapping)
            and game_result.get("winnerId") == learned_player_id
        ),
        "rank": learned_standing.get("rank") if learned_standing else None,
        "victoryPoints": learned_standing.get("vp") if learned_standing else None,
        "factions": learned_standing.get("factions", []) if learned_standing else [],
    }


def _mean_numeric(records: Sequence[Mapping[str, Any]], field: str) -> Optional[float]:
    values = [
        float(record[field])
        for record in records
        if isinstance(record.get(field), (int, float))
        and not isinstance(record.get(field), bool)
        and math.isfinite(float(record[field]))
    ]
    return fmean(values) if values else None


def summarize_evaluation(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Aggregate win rate, rank, VP, decisions, truncations, and seat effects."""
    def summarize_group(group: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        group_completed = [record for record in group if record.get("terminated") is True]
        wins = sum(record.get("won") is True for record in group_completed)
        return {
            "games": len(group),
            "completedGames": len(group_completed),
            "truncatedGames": sum(record.get("truncated") is True for record in group),
            "wins": wins,
            "winRate": wins / len(group_completed) if group_completed else None,
            "averageRank": _mean_numeric(group_completed, "rank"),
            "averageVictoryPoints": _mean_numeric(group_completed, "victoryPoints"),
            "averageDecisionCount": _mean_numeric(group, "decisionCount"),
        }

    by_opponent: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    by_seat: dict[int, list[Mapping[str, Any]]] = defaultdict(list)
    for record in records:
        by_opponent[str(record.get("opponentPolicy"))].append(record)
        if isinstance(record.get("learnedSeat"), int):
            by_seat[int(record["learnedSeat"])].append(record)
    return {
        **summarize_group(records),
        "byOpponent": {
            opponent: summarize_group(group)
            for opponent, group in sorted(by_opponent.items())
        },
        "bySeat": {
            str(seat): summarize_group(group)
            for seat, group in sorted(by_seat.items())
        },
    }


def evaluate_checkpoint(args: argparse.Namespace) -> dict[str, Any]:
    """Load a checkpoint and evaluate it over controlled seeds and every seat."""
    jobs = build_evaluation_jobs(
        opponents=args.opponents,
        games_per_seat=args.games_per_seat,
        player_count=args.player_count,
        seed=args.seed,
        max_decisions=args.max_decisions,
        sample_actions=args.sample_actions,
    )
    policy, checkpoint = load_reinforce_checkpoint(args.checkpoint, device=args.device)
    policy.eval()
    records: list[dict[str, Any]] = []

    with NodeSmashUpEnv(args.base_url) as environment:
        for job in jobs:
            torch.manual_seed(job["policySeed"])
            record = run_evaluation_game(
                environment,
                policy,
                opponent_policy=job["opponentPolicy"],
                learned_seat=job["learnedSeat"],
                player_count=job["playerCount"],
                seed=job["seed"],
                max_decisions=job["maxDecisions"],
                sample_actions=job["sampleActions"],
            )
            records.append(record)
            print(json.dumps({
                "evaluationGame": job["evaluationGame"],
                **record,
            }))

    report = {
        "evaluationSchemaVersion": 1,
        "checkpoint": str(Path(args.checkpoint)),
        "checkpointEpisodesCompleted": checkpoint.get("episodesCompleted", 0),
        "checkpointUpdatesCompleted": checkpoint.get("updatesCompleted", 0),
        "playerCount": args.player_count,
        "gamesPerSeat": args.games_per_seat,
        "sampleActions": args.sample_actions,
        "opponents": list(args.opponents),
        "summary": summarize_evaluation(records),
        "games": records,
    }
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = output_path.with_suffix(f"{output_path.suffix}.tmp")
        temporary_path.write_text(f"{json.dumps(report, indent=2)}\n", encoding="utf-8")
        temporary_path.replace(output_path)
    print(json.dumps(report["summary"], indent=2))
    return report


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT_PATH)
    parser.add_argument("--base-url", default="http://127.0.0.1:3001")
    parser.add_argument("--games-per-seat", type=int, default=10)
    parser.add_argument("--player-count", type=int, choices=(2, 3, 4), default=3)
    parser.add_argument("--max-decisions", type=int, default=10_000)
    parser.add_argument("--seed", type=int, default=10_000)
    parser.add_argument("--device", default="cpu")
    parser.add_argument(
        "--opponents",
        nargs="+",
        choices=BUILT_IN_POLICY_VERSIONS,
        default=DEFAULT_OPPONENTS,
    )
    parser.add_argument(
        "--sample-actions",
        action="store_true",
        help="Sample learned actions instead of using deterministic argmax actions.",
    )
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


if __name__ == "__main__":
    evaluate_checkpoint(_parse_args())
