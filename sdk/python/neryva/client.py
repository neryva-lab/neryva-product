"""Neryva public API SDK (FL-3.15) — stdlib-only Python client over the L2
conversation plane (`/v1/*`, authenticated with a `nrv_live_` API key).

The SDK is a consumer of the documented surface only — it holds no business
truth and works against ANY deployment of the Engine. No third-party
dependencies: `urllib.request` for HTTP with a typed surface.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request

__all__ = ["NeryvaClient", "NeryvaApiError", "Conversation", "AcceptMessageResult", "MessagePage"]


class NeryvaApiError(Exception):
    """Stable machine-readable error from the Engine error catalog."""

    def __init__(self, status: int, code: str, message: str, retryable: bool, details: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details = details


@dataclass(frozen=True)
class Conversation:
    id: str
    assistant_id: str
    status: str
    version: int
    title: Optional[str] = None
    created_at: Optional[str] = None


@dataclass(frozen=True)
class AcceptMessageResult:
    message_id: str
    run_id: Optional[str]
    sequence: int
    conversation_version: int
    auto_responder: Optional[str] = None
    replay: bool = False


@dataclass(frozen=True)
class MessagePage:
    messages: List[Dict[str, Any]] = field(default_factory=list)
    next_cursor: Optional[int] = None


@dataclass(frozen=True)
class RunStreamEvent:
    """A replayed durable run event (SSE frame)."""

    event: str
    data: Any
    id: Optional[str] = None


class NeryvaClient:
    def __init__(self, base_url: str, api_key: str, timeout: float = 30.0) -> None:
        if not base_url:
            raise ValueError("base_url is required")
        if not api_key or not api_key.startswith("nrv_live_"):
            raise ValueError("api_key must be a nrv_live_ key issued by the Neryva console")
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout

    # ── Conversations ────────────────────────────────────────────────────

    def create_conversation(self, assistant_id: str) -> Conversation:
        body = self._request("POST", "/v1/conversations", {"assistant_id": assistant_id})
        row = body["conversation"]
        return Conversation(
            id=row.get("id", ""),
            assistant_id=row.get("assistant_id", ""),
            status=row.get("status", ""),
            version=int(row.get("version", 0)),
            title=row.get("title"),
            created_at=row.get("created_at"),
        )

    def send_message(
        self,
        conversation_id: str,
        text: str,
        idempotency_key: Optional[str] = None,
        expected_conversation_version: Optional[int] = None,
    ) -> AcceptMessageResult:
        """Send a user message and start a run. Idempotent under the same key."""
        payload: Dict[str, Any] = {"content": {"text": text}}
        if idempotency_key:
            payload["idempotency_key"] = idempotency_key
        if expected_conversation_version is not None:
            payload["expected_conversation_version"] = expected_conversation_version
        body = self._request(
            "POST",
            f"/v1/conversations/{conversation_id}/messages",
            payload,
            idempotency_key=idempotency_key or _new_idempotency_key(),
        )
        return AcceptMessageResult(
            message_id=body.get("message_id", ""),
            run_id=body.get("run_id"),
            sequence=int(body.get("sequence", 0)),
            conversation_version=int(body.get("conversation_version", 0)),
            auto_responder=body.get("auto_responder"),
            replay=bool(body.get("replay", False)),
        )

    def list_messages(self, conversation_id: str, after: Optional[int] = None, limit: Optional[int] = None) -> MessagePage:
        query: Dict[str, str] = {}
        if after is not None:
            query["after"] = str(after)
        if limit is not None:
            query["limit"] = str(limit)
        qs = "&".join(f"{k}={urllib_request.quote(v)}" for k, v in query.items())
        path = f"/v1/conversations/{conversation_id}/messages" + (f"?{qs}" if qs else "")
        body = self._request("GET", path)
        return MessagePage(
            messages=list(body.get("messages", [])),
            next_cursor=body.get("next_cursor"),
        )

    def stream_run_events(self, conversation_id: str, run_id: str, last_event_id: int = 0) -> Iterator[RunStreamEvent]:
        """Stream a run's durable events (SSE). Reconnect with the last seen
        engine_sequence — replay is identical for a given cursor."""
        path = f"/v1/conversations/{conversation_id}/streams/{run_id}"
        if last_event_id > 0:
            path += f"?last_event_id={last_event_id}"
        request = urllib_request.Request(
            f"{self._base_url}{path}",
            headers={"Authorization": f"Bearer {self._api_key}", "Accept": "text/event-stream"},
        )
        try:
            response = urllib_request.urlopen(request, timeout=self._timeout)
        except urllib_error.HTTPError as e:  # noqa: PERF203 - urllib raises per call
            raise self._to_api_error(e) from None
        with response:
            event_name = "message"
            event_id: Optional[str] = None
            data_lines: List[str] = []
            for raw in response:
                line = raw.decode("utf-8", errors="replace").rstrip("\n").rstrip("\r")
                if line == "":
                    if data_lines:
                        data = "\n".join(data_lines)
                        try:
                            parsed: Any = json.loads(data)
                        except json.JSONDecodeError:
                            parsed = data
                        yield RunStreamEvent(event=event_name, data=parsed, id=event_id)
                    event_name = "message"
                    event_id = None
                    data_lines = []
                    continue
                if line.startswith("event:"):
                    event_name = line[6:].strip()
                elif line.startswith("id:"):
                    event_id = line[3:].strip()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].strip())

    # ── internals ────────────────────────────────────────────────────────

    def _request(self, method: str, path: str, payload: Optional[Dict[str, Any]] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        headers = {"Authorization": f"Bearer {self._api_key}"}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode("utf-8")
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        request = urllib_request.Request(f"{self._base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib_request.urlopen(request, timeout=self._timeout) as response:
                return json.loads(response.read().decode("utf-8"))  # type: ignore[no-any-return]
        except urllib_error.HTTPError as e:  # noqa: PERF203
            raise self._to_api_error(e) from None

    def _to_api_error(self, e: urllib_error.HTTPError) -> NeryvaApiError:
        try:
            body = json.loads(e.read().decode("utf-8"))
            err = body.get("error", {}) or {}
        except Exception:  # noqa: BLE001 — defensive parse of non-JSON error bodies
            err = {}
        return NeryvaApiError(
            status=e.code,
            code=str(err.get("code", "unknown")),
            message=str(err.get("message", f"HTTP {e.code}")),
            retryable=e.code >= 500 or e.code == 429,
            details=err.get("details"),
        )


def _new_idempotency_key() -> str:
    return f"sdk_{uuid.uuid4().hex[:12]}_{int(time.time() * 1000):x}"
