import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCompletion } from "../src/api/providers/anthropic.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Anthropic provider conversion", () => {
  it("preserves tool_use blocks as OpenAI tool calls", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "text", text: "I will call a tool." },
        {
          type: "tool_use",
          id: "toolu_123",
          name: "lookup_weather",
          input: { city: "Taipei" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 7, output_tokens: 11 },
    }), { status: 200 })) as typeof fetch;

    const result = await chatCompletion(
      {
        model: "claude-test",
        messages: [{ role: "user", content: "weather?" }],
        stream: false,
      },
      { apiKey: "test-key" },
    );

    expect(result.choices[0].finish_reason).toBe("tool_calls");
    expect(result.choices[0].message).toMatchObject({
      role: "assistant",
      content: "I will call a tool.",
      tool_calls: [
        {
          id: "toolu_123",
          type: "function",
          function: {
            name: "lookup_weather",
            arguments: JSON.stringify({ city: "Taipei" }),
          },
        },
      ],
    });
    expect(result.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 11,
      total_tokens: 18,
    });
  });
});
