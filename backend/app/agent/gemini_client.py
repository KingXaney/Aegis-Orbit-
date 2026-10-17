"""Thin wrapper around the Google Gemini API with manual function calling.

The API key lives only in the backend environment. The client returns the
model's function calls and text; the orchestrator executes tools and feeds the
structured results back.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ModelTurn:
    text: Optional[str]
    function_calls: List[Dict[str, Any]]  # [{"name": ..., "args": {...}}]
    raw_content: Any = None  # provider content object to append to the history


class GeminiClient:
    def __init__(self, api_key: str, model: str, system_instruction: str, declarations: List[Dict[str, Any]],
                 temperature: float = 0.2):
        from google import genai
        from google.genai import types

        self._types = types
        self._client = genai.Client(api_key=api_key)
        self.model = model
        self._tools = [types.Tool(function_declarations=[types.FunctionDeclaration(**d) for d in declarations])]
        self._config = types.GenerateContentConfig(system_instruction=system_instruction, tools=self._tools,
                                                   temperature=temperature)
        self.history: List[Any] = []

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
        response = self._client.models.generate_content(model=self.model, contents=self.history, config=self._config)
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
