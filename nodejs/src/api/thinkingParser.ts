/**
 * Thinking effort / reasoning intensity parser and provider mapper.
 *
 * Supports two input methods:
 * 1. Model name suffix: "o3(high)", "claude-sonnet(medium)", "gemini-2.5-pro(low)"
 * 2. Request body parameter: reasoning_effort or thinking_effort
 *
 * Normalizes to a unified `thinking_effort` field on the body, then each provider
 * maps it to the upstream-specific format:
 * - OpenAI Chat      → reasoning_effort: "high"
 * - OpenAI Responses → reasoning: { effort: "high" }
 * - Anthropic        → thinking: { type: "enabled", budget_tokens: N }
 * - Google Gemini    → generationConfig.thinkingConfig.thinkingBudget: N
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThinkingLevel = "high" | "medium" | "low";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex for model suffix: model_name(level) — allows optional whitespace */
const MODEL_SUFFIX_RE = /^(.+?)\s*\(\s*(high|medium|low)\s*\)\s*$/i;

/**
 * Anthropic thinking budget_tokens for each level.
 * Anthropic requires max_tokens > budget_tokens.
 */
export const ANTHROPIC_THINKING_BUDGET: Record<ThinkingLevel, number> = {
  high: 32048,
  medium: 16000,
  low: 5000,
};

/**
 * Google Gemini thinkingBudget for each level.
 * 0 means "dynamic" (model decides) — Gemini-specific behavior.
 */
export const GOOGLE_THINKING_BUDGET: Record<ThinkingLevel, number> = {
  high: 24576,
  medium: 12288,
  low: 0,
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a model name that may contain a thinking-level suffix.
 *
 * Examples:
 *   "o3(high)"            → { model: "o3", thinkingLevel: "high" }
 *   "claude-sonnet(medium)" → { model: "claude-sonnet", thinkingLevel: "medium" }
 *   "gemini-2.5-pro( low )" → { model: "gemini-2.5-pro", thinkingLevel: "low" }
 *   "gpt-4o"              → { model: "gpt-4o", thinkingLevel: undefined }
 */
export function parseModelThinkingSuffix(model: string): {
  model: string;
  thinkingLevel?: ThinkingLevel;
} {
  const match = model.match(MODEL_SUFFIX_RE);
  if (match) {
    return {
      model: match[1].trim(),
      thinkingLevel: match[2].toLowerCase() as ThinkingLevel,
    };
  }
  return { model };
}

/**
 * Extract thinking level from a request body (without model suffix parsing).
 *
 * Priority:
 *   1. reasoning_effort (OpenAI standard field)
 *   2. thinking_effort  (custom unified field)
 *   3. thinking.budget_tokens (Anthropic format — reverse-map to level)
 *
 * Returns undefined if no thinking level is specified.
 */
export function extractThinkingLevel(
  body: Record<string, any>,
): ThinkingLevel | undefined {
  // 1. reasoning_effort (OpenAI standard)
  if (typeof body.reasoning_effort === "string") {
    const lvl = body.reasoning_effort.toLowerCase();
    if (lvl === "high" || lvl === "medium" || lvl === "low") return lvl;
  }

  // 2. Custom thinking_effort (our unified field)
  if (typeof body.thinking_effort === "string") {
    const lvl = body.thinking_effort.toLowerCase();
    if (lvl === "high" || lvl === "medium" || lvl === "low") return lvl;
  }

  // 3. Anthropic thinking format — reverse-map budget_tokens to level
  if (body.thinking && typeof body.thinking === "object") {
    if (
      body.thinking.type === "enabled" &&
      typeof body.thinking.budget_tokens === "number"
    ) {
      const b = body.thinking.budget_tokens;
      if (b >= 24000) return "high";
      if (b >= 10000) return "medium";
      return "low";
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Unified preprocessing — call at every endpoint entry point
// ---------------------------------------------------------------------------

/**
 * Process a request body at the server entry point:
 *
 * 1. Parse model suffix (e.g. "o3(high)" → model="o3" + thinking_effort="high")
 * 2. If no suffix, try to extract thinking level from body params
 * 3. Set body.model to the real model name (suffix stripped)
 * 4. Set body.thinking_effort to the resolved level (if any)
 *
 * This MUST be called BEFORE lookupModelDb / dispatchWithFallback /
 * isModelAllowedForRequest, because those use body.model for DB lookup.
 *
 * Mutates `body` in-place.
 */
export function preprocessThinking(body: Record<string, any>): void {
  const rawModel = body.model;
  if (typeof rawModel !== "string" || !rawModel) return;

  // Step 1: Parse model suffix
  const { model: realModel, thinkingLevel: suffixLevel } =
    parseModelThinkingSuffix(rawModel);

  if (suffixLevel) {
    body.model = realModel;
  }

  // Step 2: Resolve thinking level — suffix takes priority over body params
  const level: ThinkingLevel | undefined =
    suffixLevel ?? extractThinkingLevel(body);

  if (level) {
    body.thinking_effort = level;
  }
}

// ---------------------------------------------------------------------------
// Provider-specific injection
// ---------------------------------------------------------------------------

/**
 * Inject thinking params into an Anthropic (Claude) request body.
 * Maps thinking_effort → thinking: { type: "enabled", budget_tokens: N }
 * Ensures max_tokens > budget_tokens (Anthropic requirement).
 */
export function injectForAnthropic(
  body: Record<string, any>,
  level: ThinkingLevel,
): void {
  const budgetTokens = ANTHROPIC_THINKING_BUDGET[level];
  body.thinking = { type: "enabled", budget_tokens: budgetTokens };

  // Anthropic requires max_tokens > budget_tokens
  const currentMax =
    typeof body.max_tokens === "number" ? body.max_tokens : 4096;
  if (currentMax <= budgetTokens) {
    body.max_tokens = budgetTokens + 8192;
  }
}

/**
 * Inject thinking params into an OpenAI Chat Completions request body.
 * Maps thinking_effort → reasoning_effort: "high"
 */
export function injectForOpenAIChat(
  body: Record<string, any>,
  level: ThinkingLevel,
): void {
  body.reasoning_effort = level;
}

/**
 * Inject thinking params into an OpenAI Responses API request body.
 * Maps thinking_effort → reasoning: { effort: "high" }
 */
export function injectForOpenAIResponse(
  body: Record<string, any>,
  level: ThinkingLevel,
): void {
  body.reasoning = { effort: level };
}

/**
 * Inject thinking params into a Google Gemini request body.
 * Maps thinking_effort → generationConfig.thinkingConfig.thinkingBudget
 */
export function injectForGoogle(
  body: Record<string, any>,
  level: ThinkingLevel,
): void {
  if (!body.generationConfig) body.generationConfig = {};
  if (!body.generationConfig.thinkingConfig) {
    body.generationConfig.thinkingConfig = {};
  }
  body.generationConfig.thinkingConfig.thinkingBudget =
    GOOGLE_THINKING_BUDGET[level];
}
