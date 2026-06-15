"""
Thinking effort / reasoning intensity parser and provider mapper.

Supports two input methods:
1. Model name suffix: "o3(high)", "claude-sonnet(medium)", "gemini-2.5-pro(low)"
2. Request body parameter: reasoning_effort or thinking_effort

Normalizes to a unified ``thinking_effort`` field on the body, then each provider
maps it to the upstream-specific format:
- OpenAI Chat      → reasoning_effort: "high"
- OpenAI Responses → reasoning: { effort: "high" }
- Anthropic        → thinking: { type: "enabled", budget_tokens: N }
- Google Gemini    → generationConfig.thinkingConfig.thinkingBudget: N
"""

from __future__ import annotations

import re
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

ThinkingLevel = str  # "high" | "medium" | "low"

_VALID_LEVELS = {"high", "medium", "low"}


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Regex for model suffix: model_name(level) — allows optional whitespace
_MODEL_SUFFIX_RE = re.compile(
    r"^(.+?)\s*\(\s*(high|medium|low)\s*\)\s*$", re.IGNORECASE
)

# Anthropic thinking budget_tokens for each level.
# Anthropic requires max_tokens > budget_tokens.
ANTHROPIC_THINKING_BUDGET: dict[str, int] = {
    "high": 32048,
    "medium": 16000,
    "low": 5000,
}

# Google Gemini thinkingBudget for each level.
# 0 means "dynamic" (model decides) — Gemini-specific behavior.
GOOGLE_THINKING_BUDGET: dict[str, int] = {
    "high": 24576,
    "medium": 12288,
    "low": 0,
}


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_model_thinking_suffix(model: str) -> tuple[str, Optional[ThinkingLevel]]:
    """Parse a model name that may contain a thinking-level suffix.

    Examples:
        ``"o3(high)"``              → ``("o3", "high")``
        ``"claude-sonnet(medium)"`` → ``("claude-sonnet", "medium")``
        ``"gemini-2.5-pro( low )"`` → ``("gemini-2.5-pro", "low")``
        ``"gpt-4o"``                → ``("gpt-4o", None)``

    Returns ``(real_model_name, thinking_level_or_None)``.
    """
    match = _MODEL_SUFFIX_RE.match(model)
    if match:
        return match.group(1).strip(), match.group(2).lower()
    return model, None


def extract_thinking_level(body: dict[str, Any]) -> Optional[ThinkingLevel]:
    """Extract thinking level from a request body (without model suffix parsing).

    Priority:
        1. ``reasoning_effort`` (OpenAI standard field)
        2. ``thinking_effort``  (custom unified field)
        3. ``thinking.budget_tokens`` (Anthropic format — reverse-map to level)

    Returns ``None`` if no thinking level is specified.
    """
    # 1. reasoning_effort (OpenAI standard)
    reasoning_effort = body.get("reasoning_effort")
    if isinstance(reasoning_effort, str):
        lvl = reasoning_effort.lower()
        if lvl in _VALID_LEVELS:
            return lvl

    # 2. Custom thinking_effort (our unified field)
    thinking_effort = body.get("thinking_effort")
    if isinstance(thinking_effort, str):
        lvl = thinking_effort.lower()
        if lvl in _VALID_LEVELS:
            return lvl

    # 3. Anthropic thinking format — reverse-map budget_tokens to level
    thinking = body.get("thinking")
    if isinstance(thinking, dict):
        if thinking.get("type") == "enabled":
            budget = thinking.get("budget_tokens")
            if isinstance(budget, (int, float)):
                if budget >= 24000:
                    return "high"
                if budget >= 10000:
                    return "medium"
                return "low"

    return None


# ---------------------------------------------------------------------------
# Unified preprocessing — call at every endpoint entry point
# ---------------------------------------------------------------------------

def preprocess_thinking(body: dict[str, Any]) -> None:
    """Process a request body at the server entry point.

    1. Parse model suffix (e.g. ``"o3(high)"`` → model=``"o3"`` + thinking_effort=``"high"``)
    2. If no suffix, try to extract thinking level from body params
    3. Set ``body["model"]`` to the real model name (suffix stripped)
    4. Set ``body["thinking_effort"]`` to the resolved level (if any)

    This MUST be called BEFORE model DB lookup / dispatch / permission checks,
    because those use ``body["model"]`` for DB lookup.

    Mutates ``body`` in-place.
    """
    raw_model = body.get("model")
    if not isinstance(raw_model, str) or not raw_model:
        return

    # Step 1: Parse model suffix
    real_model, suffix_level = parse_model_thinking_suffix(raw_model)

    if suffix_level:
        body["model"] = real_model

    # Step 2: Resolve thinking level — suffix takes priority over body params
    level = suffix_level if suffix_level else extract_thinking_level(body)

    if level:
        body["thinking_effort"] = level


# ---------------------------------------------------------------------------
# Provider-specific injection
# ---------------------------------------------------------------------------

def inject_for_anthropic(body: dict[str, Any], level: ThinkingLevel) -> None:
    """Inject thinking params into an Anthropic (Claude) request body.

    Maps thinking_effort → ``thinking: { type: "enabled", budget_tokens: N }``
    Ensures ``max_tokens > budget_tokens`` (Anthropic requirement).
    """
    budget_tokens = ANTHROPIC_THINKING_BUDGET[level]
    body["thinking"] = {"type": "enabled", "budget_tokens": budget_tokens}

    # Anthropic requires max_tokens > budget_tokens
    current_max = body.get("max_tokens")
    if not isinstance(current_max, (int, float)):
        current_max = 4096
    if current_max <= budget_tokens:
        body["max_tokens"] = budget_tokens + 8192


def inject_for_openai_chat(body: dict[str, Any], level: ThinkingLevel) -> None:
    """Inject thinking params into an OpenAI Chat Completions request body.

    Maps thinking_effort → ``reasoning_effort: "high"``
    """
    body["reasoning_effort"] = level


def inject_for_openai_response(body: dict[str, Any], level: ThinkingLevel) -> None:
    """Inject thinking params into an OpenAI Responses API request body.

    Maps thinking_effort → ``reasoning: { effort: "high" }``
    """
    body["reasoning"] = {"effort": level}


def inject_for_google(body: dict[str, Any], level: ThinkingLevel) -> None:
    """Inject thinking params into a Google Gemini request body.

    Maps thinking_effort → ``generationConfig.thinkingConfig.thinkingBudget``
    """
    if "generationConfig" not in body:
        body["generationConfig"] = {}
    if "thinkingConfig" not in body["generationConfig"]:
        body["generationConfig"]["thinkingConfig"] = {}
    body["generationConfig"]["thinkingConfig"]["thinkingBudget"] = (
        GOOGLE_THINKING_BUDGET[level]
    )
