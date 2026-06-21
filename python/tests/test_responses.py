import json
import os

os.environ.setdefault("BOT_TOKEN", "test-token")
os.environ.setdefault("ADMIN_ID", "123456")
os.environ.setdefault("API_PORT", "8000")
os.environ.setdefault("DATABASE_PATH", ":memory:")
os.environ.setdefault("DEFAULT_API_URL", "http://localhost:8000")

import pytest

from api.responses import (
    convert_responses_to_chat_completion,
    stream_chat_from_responses,
    stream_responses_api,
)


async def _response_events(chunks: list[str]):
    for chunk in chunks:
        yield chunk.encode("utf-8")


async def _collect_chat_chunks(chunks: list[str]) -> list[dict]:
    parsed_chunks: list[dict] = []
    async for chunk in stream_chat_from_responses(_response_events(chunks), "gpt-test"):
        text = chunk.decode("utf-8")
        for line in text.split("\n"):
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            parsed_chunks.append(json.loads(line[6:]))
    return parsed_chunks


async def _collect_response_events(chunks: list[str]) -> list[dict]:
    parsed_events: list[dict] = []
    async for chunk in stream_responses_api(_response_events(chunks), "gpt-test"):
        text = chunk.decode("utf-8")
        for line in text.split("\n"):
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            parsed_events.append(json.loads(line[6:]))
    return parsed_events


def _reasoning_deltas(chunks: list[dict]) -> list[str]:
    return [
        value
        for chunk in chunks
        if isinstance(value := chunk["choices"][0]["delta"].get("reasoning_content"), str)
    ]


def test_preserves_summary_text_reasoning_in_non_streaming_conversion():
    result = convert_responses_to_chat_completion(
        {
            "id": "resp_1",
            "output": [
                {
                    "type": "reasoning",
                    "summary": [{"type": "summary_text", "text": "summary reasoning"}],
                },
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "final answer"}],
                },
            ],
        },
        "gpt-test",
    )

    assert result["choices"][0]["message"]["content"] == "final answer"
    assert result["choices"][0]["message"]["reasoning_content"] == "summary reasoning"


def test_extracts_reasoning_text_content_and_item_text_in_non_streaming_conversion():
    result = convert_responses_to_chat_completion(
        {
            "id": "resp_2",
            "output": [
                {
                    "type": "reasoning",
                    "content": [{"type": "reasoning_text", "text": "content reasoning "}],
                    "text": "item reasoning",
                },
                {
                    "type": "message",
                    "content": [{"type": "text", "text": "answer"}],
                },
            ],
        },
        "gpt-test",
    )

    assert result["choices"][0]["message"]["content"] == "answer"
    assert (
        result["choices"][0]["message"]["reasoning_content"]
        == "content reasoning item reasoning"
    )


@pytest.mark.asyncio
async def test_maps_reasoning_text_deltas_to_chat_reasoning_content_chunks():
    chunks = await _collect_chat_chunks([
        'event: response.reasoning_text.delta\n',
        'data: {"delta":"step 1"}\n\n',
        'event: response.completed\ndata: {"response":{"output":[],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
    ])

    assert _reasoning_deltas(chunks) == ["step 1"]
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"


@pytest.mark.asyncio
async def test_backfills_final_reasoning_from_completed_output_without_reasoning_delta():
    chunks = await _collect_chat_chunks([
        'event: response.completed\ndata: {"response":{"output":[{"type":"reasoning","content":[{"type":"reasoning_text","text":"final reasoning"}]}],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
    ])

    assert _reasoning_deltas(chunks) == ["final reasoning"]
    assert chunks[-1]["usage"] == {
        "prompt_tokens": 1,
        "completion_tokens": 2,
        "total_tokens": 3,
    }


@pytest.mark.asyncio
async def test_does_not_duplicate_completed_reasoning_already_streamed():
    chunks = await _collect_chat_chunks([
        'event: response.reasoning_summary_text.delta\ndata: {"delta":"full reasoning"}\n\n',
        'event: response.completed\ndata: {"response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"full reasoning"}]}],"usage":{}}}\n\n',
    ])

    assert _reasoning_deltas(chunks) == ["full reasoning"]


@pytest.mark.asyncio
async def test_flushes_completed_responses_event_without_trailing_newline():
    chunks = await _collect_chat_chunks([
        'event: response.completed\ndata: {"response":{"output":[{"type":"reasoning","content":[{"type":"reasoning_text","text":"tail reasoning"}]}],"usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}}',
    ])

    assert _reasoning_deltas(chunks) == ["tail reasoning"]
    assert chunks[-1]["usage"] == {
        "prompt_tokens": 3,
        "completion_tokens": 4,
        "total_tokens": 7,
    }


@pytest.mark.asyncio
async def test_flushes_trailing_chat_reasoning_content_into_responses_events():
    events = await _collect_response_events([
        'data: {"choices":[{"delta":{"reasoning_content":"tail step"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":5}}',
    ])

    completed = next(event for event in events if event["type"] == "response.completed")
    reasoning_item = next(
        item for item in completed["response"]["output"] if item["type"] == "reasoning"
    )
    assert reasoning_item["summary"][0]["text"] == "tail step"
    assert completed["response"]["usage"] | {"total_tokens": 7} == {
        "input_tokens": 2,
        "output_tokens": 5,
        "total_tokens": 7,
        "input_tokens_details": {"cached_tokens": 0},
        "output_tokens_details": {"reasoning_tokens": 0},
    }
