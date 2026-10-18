"""Thin wrapper around the Google Gemini API with manual function calling.

The API key lives only in the backend environment. The client returns the
model's function calls and text; the orchestrator executes tools and feeds the
structured results back.

A transient failure (a 503 while the model is overloaded, or a 429 whose retry
hint is short) is retried with backoff. Anything else, including a daily quota
that will not reset for hours, is raised as ``GeminiUnavailable`` so the
orchestrator can move on to the next model.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

# A 429 is retried only when the service asks for at most this long a wait.
RETRY_429_MAX_S = 15.0


class GeminiUnavailable(RuntimeError):
    """The model could not serve the request: quota, outage, retired model or a rejected key."""

    def __init__(self, model: str, code: Optional[int], reason: str):
        super().__init__(f"{model}: {reason}")
        self.model = model
        self.code = code
        self.reason = reason


def retry_delay_s(exc: BaseException) -> Optional[float]:
    """The wait the API asked for (``RetryInfo.retryDelay`` such as ``"3s"``), if any."""
    details = getattr(exc, "details", None)
    err = details.get("error", {}) if isinstance(details, dict) else {}
    for d in (err.get("details") if isinstance(err, dict) else None) or []:
        if isinstance(d, dict) and str(d.get("@type", "")).endswith("RetryInfo"):
            m = re.fullmatch(r"([0-9.]+)s", str(d.get("retryDelay", "")))
            if m:
                return float(m.group(1))
    return None


def short_reason(exc: BaseException) -> str:
    """``"429 RESOURCE_EXHAUSTED: You exceeded your current quota…"``, without the API's boilerplate."""
    code = getattr(exc, "code", None)
    status = getattr(exc, "status", None) or type(exc).__name__
    message = getattr(exc, "message", None) or str(exc)
    head = f"{code} {status}" if code else str(status)
    return f"{head}: {str(message)[:140]}"


@dataclass
class ModelTurn:
    text: Optional[str]
    function_calls: List[Dict[str, Any]]  # [{"name": ..., "args": {...}}]
    raw_content: Any = None  # provider content object to append to the history


class GeminiClient:
    def __init__(self, api_key: str, model: str, system_instruction: str, declarations: List[Dict[str, Any]],
                 temperature: float = 0.2, attempts: int = 2, base_delay_s: float = 2.0,
                 sleep: Callable[[float], None] = time.sleep):
        from google import genai
        from google.genai import types

        self._types = types
        self._client = genai.Client(api_key=api_key)
        self.model = model
        self._tools = [types.Tool(function_declarations=[types.FunctionDeclaration(**d) for d in declarations])]
        self._config = types.GenerateContentConfig(system_instruction=system_instruction, tools=self._tools,
                                                   temperature=temperature)
        self.history: List[Any] = []
        self.attempts = max(0, int(attempts))
        self.base_delay_s = float(base_delay_s)
        self._sleep = sleep

    def start(self, user_prompt: str) -> ModelTurn:
        types = self._types
        self.history = [types.Content(role="user", parts=[types.Part.from_text(text=user_prompt)])]
        return self._generate()

    def send_tool_results(self, results: List[Dict[str, Any]]) -> ModelTurn:
        """results: [{"name": tool_name, "response": {...}}]"""
        types = self._types
        parts = [types.Part.from_function_response(name=r["name"], response=r["response"]) for r in results]
        self.history.append(types.Content(role="user", parts=parts))
        return self._generate()

    def _generate(self) -> ModelTurn:
        response = self._call()
        calls: List[Dict[str, Any]] = []
        text_parts: List[str] = []
        content = None
        if response.candidates:
            content = response.candidates[0].content
            for part in (content.parts or []):
                if getattr(part, "function_call", None) is not None and part.function_call.name:
                    calls.append({"name": part.function_call.name, "args": dict(part.function_call.args or {})})
                elif getattr(part, "text", None):
                    text_parts.append(part.text)
        if content is not None:
            self.history.append(content)
        return ModelTurn(text="\n".join(text_parts) if text_parts else None, function_calls=calls, raw_content=content)

    def _call(self) -> Any:
        """One model turn, retried while a wait could help; ``GeminiUnavailable`` otherwise."""
        for attempt in range(self.attempts + 1):
            try:
                return self._client.models.generate_content(model=self.model, contents=self.history, config=self._config)
            except Exception as exc:
                delay = self._delay_before_retry(exc, attempt)
                if delay is None or attempt >= self.attempts:
                    raise GeminiUnavailable(self.model, getattr(exc, "code", None), short_reason(exc)) from exc
                self._sleep(delay)
        raise AssertionError("unreachable")

    def _delay_before_retry(self, exc: BaseException, attempt: int) -> Optional[float]:
        """Seconds to wait before trying again, or None when a retry would not help."""
        code = getattr(exc, "code", None)
        backoff = self.base_delay_s * (2 ** attempt)
        if code == 503:
            return backoff
        if code == 429:
            hinted = retry_delay_s(exc)
            return hinted if hinted is not None and hinted <= RETRY_429_MAX_S else None
        if code is None:  # no HTTP verdict at all: a network hiccup
            return backoff
        return None
