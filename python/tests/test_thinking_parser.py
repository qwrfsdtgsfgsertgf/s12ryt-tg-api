"""
Unit tests for thinking_parser.py — thinking effort / reasoning intensity feature.

Tests cover:
1. Model suffix parsing: "o3(high)" → ("o3", "high")
2. Extract thinking level from body params (reasoning_effort / thinking_effort / anthropic reverse-map)
3. Full preprocess_thinking pipeline (suffix + param resolution)
4. Provider-specific injection: Anthropic, OpenAI Chat, OpenAI Response, Google
5. Edge cases: no level, invalid level, max_tokens enforcement
"""

import os

# Set env vars before any project import (same pattern as other test files)
os.environ.setdefault("BOT_TOKEN", "test-bot-token")
os.environ.setdefault("ADMIN_ID", "123456")
os.environ.setdefault("API_PORT", "8000")
os.environ.setdefault("DATABASE_PATH", "./data/test_bot.db")
os.environ.setdefault("DEFAULT_API_URL", "http://localhost:8000")

import pytest

from api.thinking_parser import (
    parse_model_thinking_suffix,
    extract_thinking_level,
    preprocess_thinking,
    inject_for_anthropic,
    inject_for_openai_chat,
    inject_for_openai_response,
    inject_for_google,
    ANTHROPIC_THINKING_BUDGET,
    GOOGLE_THINKING_BUDGET,
)


# ---------------------------------------------------------------------------
# parse_model_thinking_suffix
# ---------------------------------------------------------------------------

class TestParseModelSuffix:
    def test_basic_suffix(self):
        assert parse_model_thinking_suffix("o3(high)") == ("o3", "high")

    def test_medium_suffix(self):
        assert parse_model_thinking_suffix("claude-sonnet(medium)") == ("claude-sonnet", "medium")

    def test_low_suffix(self):
        assert parse_model_thinking_suffix("gemini-2.5-pro(low)") == ("gemini-2.5-pro", "low")

    def test_case_insensitive(self):
        assert parse_model_thinking_suffix("o3(HIGH)") == ("o3", "high")
        assert parse_model_thinking_suffix("o3(High)") == ("o3", "high")

    def test_whitespace_in_parens(self):
        assert parse_model_thinking_suffix("o3( high )") == ("o3", "high")
        assert parse_model_thinking_suffix("o3(  low  )") == ("o3", "low")

    def test_no_suffix(self):
        assert parse_model_thinking_suffix("gpt-4o") == ("gpt-4o", None)

    def test_empty_string(self):
        assert parse_model_thinking_suffix("") == ("", None)

    def test_model_with_parens_but_no_level(self):
        """Parens without a valid level should not be stripped."""
        assert parse_model_thinking_suffix("model(custom)") == ("model(custom)", None)

    def test_model_with_special_chars(self):
        assert parse_model_thinking_suffix("deepseek-r1(high)") == ("deepseek-r1", "high")

    def test_trailing_space_after_parens(self):
        assert parse_model_thinking_suffix("o3(high)  ") == ("o3", "high")


# ---------------------------------------------------------------------------
# extract_thinking_level
# ---------------------------------------------------------------------------

class TestExtractThinkingLevel:
    def test_from_reasoning_effort(self):
        assert extract_thinking_level({"reasoning_effort": "high"}) == "high"
        assert extract_thinking_level({"reasoning_effort": "low"}) == "low"

    def test_from_thinking_effort(self):
        assert extract_thinking_level({"thinking_effort": "medium"}) == "medium"

    def test_reasoning_effort_takes_priority(self):
        """reasoning_effort should win over thinking_effort."""
        body = {"reasoning_effort": "high", "thinking_effort": "low"}
        assert extract_thinking_level(body) == "high"

    def test_case_insensitive(self):
        assert extract_thinking_level({"reasoning_effort": "HIGH"}) == "high"

    def test_invalid_level_ignored(self):
        assert extract_thinking_level({"reasoning_effort": "ultra"}) is None
        assert extract_thinking_level({"thinking_effort": "extreme"}) is None

    def test_no_level_present(self):
        assert extract_thinking_level({"model": "gpt-4o"}) is None
        assert extract_thinking_level({}) is None

    def test_anthropic_reverse_map_high(self):
        """Anthropic thinking.budget_tokens ≥ 24000 → high."""
        body = {"thinking": {"type": "enabled", "budget_tokens": 32048}}
        assert extract_thinking_level(body) == "high"

    def test_anthropic_reverse_map_medium(self):
        """Anthropic thinking.budget_tokens ≥ 10000 → medium."""
        body = {"thinking": {"type": "enabled", "budget_tokens": 16000}}
        assert extract_thinking_level(body) == "medium"

    def test_anthropic_reverse_map_low(self):
        """Anthropic thinking.budget_tokens < 10000 → low."""
        body = {"thinking": {"type": "enabled", "budget_tokens": 5000}}
        assert extract_thinking_level(body) == "low"

    def test_anthropic_disabled_ignored(self):
        body = {"thinking": {"type": "disabled", "budget_tokens": 32048}}
        assert extract_thinking_level(body) is None

    def test_non_string_reasoning_effort(self):
        assert extract_thinking_level({"reasoning_effort": 123}) is None
        assert extract_thinking_level({"reasoning_effort": None}) is None


# ---------------------------------------------------------------------------
# preprocess_thinking
# ---------------------------------------------------------------------------

class TestPreprocessThinking:
    def test_suffix_strips_and_sets_level(self):
        body = {"model": "o3(high)", "messages": []}
        preprocess_thinking(body)
        assert body["model"] == "o3"
        assert body["thinking_effort"] == "high"

    def test_suffix_priority_over_param(self):
        """Model suffix should override body params."""
        body = {"model": "o3(high)", "reasoning_effort": "low"}
        preprocess_thinking(body)
        assert body["model"] == "o3"
        assert body["thinking_effort"] == "high"

    def test_no_suffix_uses_param(self):
        body = {"model": "gpt-4o", "reasoning_effort": "medium"}
        preprocess_thinking(body)
        assert body["model"] == "gpt-4o"
        assert body["thinking_effort"] == "medium"

    def test_no_suffix_no_param(self):
        body = {"model": "gpt-4o"}
        preprocess_thinking(body)
        assert body["model"] == "gpt-4o"
        assert "thinking_effort" not in body

    def test_empty_model(self):
        body = {"model": ""}
        preprocess_thinking(body)
        assert "thinking_effort" not in body

    def test_missing_model(self):
        body = {"messages": []}
        preprocess_thinking(body)
        assert "thinking_effort" not in body

    def test_non_string_model(self):
        body = {"model": 12345}
        preprocess_thinking(body)
        assert "thinking_effort" not in body


# ---------------------------------------------------------------------------
# inject_for_anthropic
# ---------------------------------------------------------------------------

class TestInjectAnthropic:
    def test_high_level(self):
        body = {"max_tokens": 4096}
        inject_for_anthropic(body, "high")
        assert body["thinking"] == {"type": "enabled", "budget_tokens": ANTHROPIC_THINKING_BUDGET["high"]}

    def test_medium_level(self):
        body = {}
        inject_for_anthropic(body, "medium")
        assert body["thinking"]["budget_tokens"] == ANTHROPIC_THINKING_BUDGET["medium"]

    def test_low_level(self):
        body = {}
        inject_for_anthropic(body, "low")
        assert body["thinking"]["budget_tokens"] == ANTHROPIC_THINKING_BUDGET["low"]

    def test_max_tokens_raised_if_too_small(self):
        """If max_tokens ≤ budget_tokens, it should be raised."""
        body = {"max_tokens": 100}
        inject_for_anthropic(body, "high")
        budget = ANTHROPIC_THINKING_BUDGET["high"]
        assert body["max_tokens"] > budget

    def test_max_tokens_not_raised_if_sufficient(self):
        """If max_tokens > budget_tokens, it should be unchanged."""
        body = {"max_tokens": 65536}
        inject_for_anthropic(body, "low")
        assert body["max_tokens"] == 65536

    def test_max_tokens_set_if_missing(self):
        """If max_tokens is missing, it should be set."""
        body = {}
        inject_for_anthropic(body, "high")
        assert "max_tokens" in body
        assert body["max_tokens"] > ANTHROPIC_THINKING_BUDGET["high"]


# ---------------------------------------------------------------------------
# inject_for_openai_chat
# ---------------------------------------------------------------------------

class TestInjectOpenAIChat:
    def test_sets_reasoning_effort(self):
        body = {"model": "o3"}
        inject_for_openai_chat(body, "high")
        assert body["reasoning_effort"] == "high"

    def test_medium(self):
        body = {}
        inject_for_openai_chat(body, "medium")
        assert body["reasoning_effort"] == "medium"


# ---------------------------------------------------------------------------
# inject_for_openai_response
# ---------------------------------------------------------------------------

class TestInjectOpenAIResponse:
    def test_sets_reasoning_object(self):
        body = {"model": "o3"}
        inject_for_openai_response(body, "high")
        assert body["reasoning"] == {"effort": "high"}

    def test_low(self):
        body = {}
        inject_for_openai_response(body, "low")
        assert body["reasoning"]["effort"] == "low"


# ---------------------------------------------------------------------------
# inject_for_google
# ---------------------------------------------------------------------------

class TestInjectGoogle:
    def test_creates_nested_config(self):
        body = {}
        inject_for_google(body, "high")
        assert body["generationConfig"]["thinkingConfig"]["thinkingBudget"] == GOOGLE_THINKING_BUDGET["high"]

    def test_preserves_existing_config(self):
        body = {"generationConfig": {"temperature": 0.7}}
        inject_for_google(body, "medium")
        assert body["generationConfig"]["temperature"] == 0.7
        assert body["generationConfig"]["thinkingConfig"]["thinkingBudget"] == GOOGLE_THINKING_BUDGET["medium"]

    def test_preserves_existing_thinking_config(self):
        body = {"generationConfig": {"thinkingConfig": {"includeThoughts": True}}}
        inject_for_google(body, "high")
        assert body["generationConfig"]["thinkingConfig"]["includeThoughts"] is True
        assert body["generationConfig"]["thinkingConfig"]["thinkingBudget"] == GOOGLE_THINKING_BUDGET["high"]

    def test_low_is_zero(self):
        """Google low level = 0 (dynamic)."""
        body = {}
        inject_for_google(body, "low")
        assert body["generationConfig"]["thinkingConfig"]["thinkingBudget"] == 0


# ---------------------------------------------------------------------------
# Budget value sanity checks
# ---------------------------------------------------------------------------

class TestBudgetValues:
    def test_anthropic_budget_ordering(self):
        assert ANTHROPIC_THINKING_BUDGET["high"] > ANTHROPIC_THINKING_BUDGET["medium"]
        assert ANTHROPIC_THINKING_BUDGET["medium"] > ANTHROPIC_THINKING_BUDGET["low"]

    def test_google_budget_ordering(self):
        assert GOOGLE_THINKING_BUDGET["high"] > GOOGLE_THINKING_BUDGET["medium"]
        assert GOOGLE_THINKING_BUDGET["medium"] > GOOGLE_THINKING_BUDGET["low"]
