"""Evaluate a REINFORCE checkpoint in parallel on Modal CPU workers."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Mapping

import modal


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PYTHON_DIRECTORY = PROJECT_ROOT / "python"
REMOTE_PROJECT_ROOT = Path("/app")
REMOTE_CHECKPOINT_ROOT = Path("/training-data/checkpoints")
VOLUME_NAME = "smashup-rl-data"
DEFAULT_OUTPUT_PATH = (
    PROJECT_ROOT / "training-data" / "evaluations" / "reinforce-modal.json"
)
DEFAULT_LOCAL_CHECKPOINT_PATH = (
    PROJECT_ROOT / "training-data" / "checkpoints" / "reinforce.pt"
)
DEFAULT_OPPONENTS_TEXT = ",".join((
    "random-v1",
    "first-legal-v1",
    "greedy_heuristic_1",
    "greedy_heuristic_2",
))

app = modal.App("smashup-reinforce-evaluation")
checkpoint_volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

evaluation_image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.11")
    .entrypoint([])
    .apt_install("ca-certificates")
    .uv_pip_install("numpy==2.0.2")
    .uv_pip_install(
        "torch==2.8.0",
        index_url="https://download.pytorch.org/whl/cpu",
    )
    .add_local_dir(
        PROJECT_ROOT / "backend",
        "/app/backend",
        copy=True,
        ignore=["node_modules", "*.log"],
    )
    .run_commands("cd /app/backend && npm ci --omit=dev")
    .add_local_dir(
        PROJECT_ROOT / "python",
        "/app/python",
        copy=True,
        ignore=["__pycache__", "*.pyc"],
    )
    .add_local_dir(PROJECT_ROOT / "shared", "/app/shared", copy=True)
    .workdir("/app")
)


def _checkpoint_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as checkpoint_file:
        for chunk in iter(lambda: checkpoint_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()[:16]


def _write_json_atomically(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(f"{path.suffix}.tmp")
    temporary_path.write_text(f"{json.dumps(value, indent=2)}\n", encoding="utf-8")
    temporary_path.replace(path)


@app.cls(
    image=evaluation_image,
    volumes={REMOTE_CHECKPOINT_ROOT: checkpoint_volume},
    cpu=2,
    memory=4096,
    timeout=1800,
    startup_timeout=600,
    retries=1,
    max_containers=20,
    scaledown_window=60,
)
class EvaluationWorker:
    """Keep one Node server and one loaded checkpoint alive per Modal container."""

    @modal.enter()
    def start_worker(self) -> None:
        sys.path.insert(0, str(REMOTE_PROJECT_ROOT / "python"))
        self.base_url = "http://127.0.0.1:3001"
        self.loaded_checkpoint_path: str | None = None
        self.policy = None
        self.checkpoint_metadata: Mapping[str, Any] | None = None
        self.node_log = open(
            "/tmp/smashup-headless-environment.log",
            "a+",
            encoding="utf-8",
        )
        environment = os.environ.copy()
        environment.update({
            "HEADLESS_ENV_HOST": "127.0.0.1",
            "HEADLESS_ENV_PORT": "3001",
            "NODE_ENV": "production",
        })
        self.node_process = subprocess.Popen(
            ["node", "headlessEnvironmentServer.js"],
            cwd=REMOTE_PROJECT_ROOT / "backend",
            env=environment,
            stdout=self.node_log,
            stderr=subprocess.STDOUT,
        )
        for _ in range(120):
            if self.node_process.poll() is not None:
                break
            try:
                with urllib.request.urlopen(
                    f"{self.base_url}/health",
                    timeout=1,
                ) as response:
                    if response.status == 200:
                        return
            except OSError:
                time.sleep(0.25)
        self.node_log.seek(0)
        logs = self.node_log.read()[-4000:]
        raise RuntimeError(f"Node environment server did not become healthy.\n{logs}")

    def _load_policy(self, checkpoint_path: str):
        if self.loaded_checkpoint_path == checkpoint_path and self.policy is not None:
            return self.policy, self.checkpoint_metadata
        from reinforce import load_reinforce_checkpoint

        resolved_path = REMOTE_CHECKPOINT_ROOT / checkpoint_path
        if not resolved_path.is_file():
            raise FileNotFoundError(
                f"Checkpoint is missing from the Modal Volume: {checkpoint_path}"
            )
        policy, checkpoint = load_reinforce_checkpoint(resolved_path, device="cpu")
        policy.eval()
        self.loaded_checkpoint_path = checkpoint_path
        self.policy = policy
        self.checkpoint_metadata = {
            "episodesCompleted": checkpoint.get("episodesCompleted", 0),
            "updatesCompleted": checkpoint.get("updatesCompleted", 0),
        }
        return policy, self.checkpoint_metadata

    @modal.method()
    def evaluate(self, job: Mapping[str, Any]) -> dict[str, Any]:
        import torch
        from evaluate_reinforce import run_evaluation_game
        from node_env import NodeSmashUpEnv

        policy, checkpoint_metadata = self._load_policy(str(job["checkpointPath"]))
        torch.manual_seed(int(job["policySeed"]))
        with NodeSmashUpEnv(self.base_url) as environment:
            record = run_evaluation_game(
                environment,
                policy,
                opponent_policy=str(job["opponentPolicy"]),
                learned_seat=int(job["learnedSeat"]),
                player_count=int(job["playerCount"]),
                seed=int(job["seed"]),
                max_decisions=int(job["maxDecisions"]),
                sample_actions=bool(job["sampleActions"]),
            )
        return {
            "evaluationGame": int(job["evaluationGame"]),
            "checkpointMetadata": checkpoint_metadata,
            "record": record,
        }

    @modal.exit()
    def stop_worker(self) -> None:
        if getattr(self, "node_process", None) is not None:
            self.node_process.terminate()
            try:
                self.node_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.node_process.kill()
                self.node_process.wait(timeout=5)
        if getattr(self, "node_log", None) is not None:
            self.node_log.close()


@app.local_entrypoint()
def main(
    checkpoint: str = str(DEFAULT_LOCAL_CHECKPOINT_PATH),
    output: str = str(DEFAULT_OUTPUT_PATH),
    games_per_seat: int = 5,
    player_count: int = 3,
    max_decisions: int = 10_000,
    seed: int = 10_000,
    opponents: str = DEFAULT_OPPONENTS_TEXT,
    sample_actions: bool = False,
    max_workers: int = 20,
) -> None:
    """Upload a checkpoint, evaluate games in parallel, and save a local report."""
    sys.path.insert(0, str(PYTHON_DIRECTORY))
    from evaluate_reinforce import build_evaluation_jobs, summarize_evaluation

    checkpoint_path = Path(checkpoint).expanduser().resolve()
    if not checkpoint_path.is_file():
        raise FileNotFoundError(f"Checkpoint does not exist: {checkpoint_path}")
    if max_workers < 1:
        raise ValueError("max_workers must be positive.")
    opponent_versions = tuple(
        opponent.strip() for opponent in opponents.split(",") if opponent.strip()
    )
    if not opponent_versions:
        raise ValueError("opponents must contain at least one built-in policy version.")

    jobs = build_evaluation_jobs(
        opponents=opponent_versions,
        games_per_seat=games_per_seat,
        player_count=player_count,
        seed=seed,
        max_decisions=max_decisions,
        sample_actions=sample_actions,
    )
    remote_checkpoint_path = (
        f"{checkpoint_path.stem}-{_checkpoint_digest(checkpoint_path)}"
        f"{checkpoint_path.suffix}"
    )
    with checkpoint_volume.batch_upload(force=True) as upload:
        upload.put_file(checkpoint_path, f"/{remote_checkpoint_path}")

    remote_jobs = [
        {**job, "checkpointPath": remote_checkpoint_path}
        for job in jobs
    ]
    worker = EvaluationWorker.with_options(max_containers=max_workers)()
    completed = []
    for result in worker.evaluate.map(remote_jobs, order_outputs=False):
        completed.append(result)
        print(json.dumps({
            "completedGames": len(completed),
            "totalGames": len(remote_jobs),
            "evaluationGame": result["evaluationGame"],
            **result["record"],
        }))
    completed.sort(key=lambda result: result["evaluationGame"])
    records = [result["record"] for result in completed]
    checkpoint_metadata = completed[0]["checkpointMetadata"] if completed else {}
    report = {
        "evaluationSchemaVersion": 1,
        "executionBackend": "modal",
        "checkpoint": str(checkpoint_path),
        "modalVolume": VOLUME_NAME,
        "modalCheckpointPath": remote_checkpoint_path,
        "checkpointEpisodesCompleted": checkpoint_metadata.get("episodesCompleted", 0),
        "checkpointUpdatesCompleted": checkpoint_metadata.get("updatesCompleted", 0),
        "playerCount": player_count,
        "gamesPerSeat": games_per_seat,
        "sampleActions": sample_actions,
        "opponents": list(opponent_versions),
        "maxWorkers": max_workers,
        "summary": summarize_evaluation(records),
        "games": records,
    }
    output_path = Path(output).expanduser().resolve()
    _write_json_atomically(output_path, report)
    print(json.dumps(report["summary"], indent=2))
    print(f"Saved Modal evaluation report to {output_path}")
