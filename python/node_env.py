"""Small dependency-free Python client for the Node headless environment API."""

from __future__ import annotations

import json
from typing import Any, Optional, Union
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class NodeEnvironmentError(RuntimeError):
    """Raised when the Node environment rejects a request or is unavailable."""


class NodeSmashUpEnv:
    """Drive one server-authoritative Smash Up environment from Python."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:3001",
        timeout_seconds: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.environment_id: Optional[str] = None

    def _request(
        self,
        method: str,
        path: str,
        payload: Optional[dict[str, Any]] = None,
    ) -> Optional[dict[str, Any]]:
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read()
        except HTTPError as error:
            body = error.read()
            try:
                details = json.loads(body.decode("utf-8"))
                message = details.get("error", str(error))
            except (UnicodeDecodeError, json.JSONDecodeError):
                message = str(error)
            raise NodeEnvironmentError(message) from error
        except URLError as error:
            raise NodeEnvironmentError(
                f"Could not reach the Node environment at {self.base_url}: {error.reason}"
            ) from error

        if not body:
            return None
        return json.loads(body.decode("utf-8"))

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/health") or {}

    def reset(
        self,
        *,
        seed: Optional[Union[int, str]] = None,
        player_count: int = 3,
        max_decisions: int = 10_000,
        record_trajectory: bool = False,
    ) -> dict[str, Any]:
        payload = {
            "randomSeed": seed,
            "playerCount": player_count,
            "maxDecisions": max_decisions,
            "recordTrajectory": record_trajectory,
            "policyVersion": "external-python-v1",
        }
        if self.environment_id is None:
            state = self._request("POST", "/environments", payload) or {}
            self.environment_id = state.get("environmentId")
        else:
            state = self._request(
                "POST",
                f"/environments/{self.environment_id}/reset",
                payload,
            ) or {}
        if not self.environment_id:
            raise NodeEnvironmentError("Node did not return an environment ID.")
        return state

    def step(self, action_index: int) -> dict[str, Any]:
        if self.environment_id is None:
            raise NodeEnvironmentError("Call reset() before step().")
        if isinstance(action_index, bool) or not isinstance(action_index, int):
            raise TypeError("action_index must be an integer.")
        return self._request(
            "POST",
            f"/environments/{self.environment_id}/step",
            {"actionIndex": action_index},
        ) or {}

    def result(self) -> dict[str, Any]:
        if self.environment_id is None:
            raise NodeEnvironmentError("Call reset() before result().")
        return self._request(
            "GET",
            f"/environments/{self.environment_id}/result",
        ) or {}

    def close(self) -> None:
        if self.environment_id is None:
            return
        self._request("DELETE", f"/environments/{self.environment_id}")
        self.environment_id = None

    def __enter__(self) -> "NodeSmashUpEnv":
        return self

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        self.close()
