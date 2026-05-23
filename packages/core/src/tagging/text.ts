/**
 * Prompt construction + response parsing for the auto-tag pipeline.
 *
 * Provider-agnostic on purpose: the same comma-separated text protocol
 * works on OpenAI / Anthropic / Ollama / openai-compatible without any of
 * them needing JSON mode (Anthropic doesn't have one and Ollama's varies
 * by model). Robustness lives in the parser, not in the prompt.
 */
import type { StarredRepo } from '../schema.js';

/**
 * System prompt — held constant across every per-repo call so providers can
 * cache it where supported. Asks for 3-5 tags, short (1-3 words), comma-
 * separated, no explanation.
 */
export const TAG_SYSTEM_PROMPT = [
  'You are a senior developer tagging GitHub repositories.',
  'For the repo described below, output 3 to 5 short tags (1-3 words each).',
  'Tags should describe the repo\'s purpose / domain / tech stack — not generic',
  'terms like "code" or "open source".',
  'Respond with ONLY the tags, comma-separated. No bullets, no explanations,',
  'no markdown.',
  'Example output:  async runtime, rust, concurrency',
].join('\n');

/**
 * Compose the per-repo user prompt. Mirrors `buildStarEmbeddingInput` (text.ts
 * in the embedding module) but explicit about field labels — the chat model
 * sees field roles, the embedding model just sees pooled tokens.
 */
export function buildTagUserPrompt(star: StarredRepo): string {
  const lines: string[] = [`Repo: ${star.fullName}`];
  if (star.language !== null && star.language.length > 0) {
    lines.push(`Language: ${star.language}`);
  }
  if (star.description !== null && star.description.length > 0) {
    lines.push(`Description: ${star.description}`);
  }
  if (star.topics.length > 0) {
    lines.push(`GitHub topics: ${star.topics.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Max tags to keep per repo — anything beyond is dropped. 5 is the upper
 * end the prompt asks for; tolerate one extra in case the model overshot.
 */
const MAX_TAGS = 5;

/**
 * Reject "tags" longer than this — almost certainly the model returned a
 * sentence ("This is a Rust async runtime") instead of a tag. 40 chars is
 * generous: "machine learning" is 16, "kubernetes operator" is 19,
 * "infrastructure-as-code" is 22.
 */
const MAX_TAG_LENGTH = 40;

/**
 * Parse a model's free-text response into a list of tag strings.
 *
 * Robustness rules — chat models hallucinate format:
 *   1. Split on commas OR newlines (some models return one tag per line
 *      despite the prompt).
 *   2. Strip a leading "Tags:" / "Output:" / numbered bullet — sometimes
 *      the model ignores "no explanation" and prefixes anyway.
 *   3. Trim whitespace, surrounding quotes, trailing punctuation.
 *   4. Drop empties.
 *   5. Drop tags longer than MAX_TAG_LENGTH (suspect sentences).
 *   6. Drop case-folded duplicates, preserving first occurrence's casing.
 *   7. Cap at MAX_TAGS.
 *
 * Returns an empty array if no tags parse cleanly — caller decides whether
 * "0 tags" is a failure or a "this repo has nothing useful to say" signal.
 */
export function parseTagResponse(raw: string): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];

  // Strip a "Tags:" / "Output:" prefix on the first line, then collapse to
  // a single string for splitting.
  const cleaned = raw
    .replace(/^(?:Tags|Output|Result)\s*:\s*/i, '')
    .trim();

  // Split on commas OR newlines.
  const parts = cleaned.split(/[,\n]/);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    if (out.length >= MAX_TAGS) break;
    // Order matters: trim leading/trailing whitespace FIRST so the quote-
    // stripping regex anchors (`^["'`]+` and `["'`]+$`) actually see the
    // quote chars at their respective ends. Without the leading trim, an
    // input like ` "async"` would leave the leading `"` behind because
    // the regex's `^` was glued to the space.
    const trimmed = raw
      .trim()
      // Strip numbered/bulleted prefixes: "1. tag", "- tag", "* tag", "1) tag"
      .replace(/^(?:[-*•]|\d+[\.\)])\s*/, '')
      // Strip surrounding quotes / backticks
      .replace(/^["'`]+|["'`]+$/g, '')
      // Trailing sentence punctuation
      .replace(/[.!?;:]+$/, '')
      .trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_TAG_LENGTH) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
