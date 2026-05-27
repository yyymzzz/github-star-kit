/**
 * Text composition + content hashing for the embedding pipeline.
 *
 * Lives separately from the orchestrator so the input shape is unit-testable
 * without spinning up provider mocks. The composition order matters — it
 * determines what an OpenAI / Voyage / Ollama embedding "sees" when ranking
 * "rust async runtime" vs "react state management" against a starred repo.
 */
import type { StarredRepo } from '../schema.js';

/**
 * Hard cap on a single embedding input's length.
 *
 * R53 root-cause fix: user reported 2 stars persistently failing 413 even
 * after the R52 adaptive split path had narrowed them down to a single
 * input each. SiliconFlow / DashScope embed endpoints reject single
 * requests whose body exceeds their per-call cap (varies by tier; observed
 * ~4-8KB on free plans). The R52 split is the symptomatic fix; this is
 * the source fix — clamp the assembled input BEFORE it ever leaves the
 * orchestrator.
 *
 * 2000 chars is conservative:
 *   - bge-m3 supports 8192 tokens ≈ 32KB but provider gateway < model.
 *   - text-embedding-3-small handles 8191 tokens fine at this size.
 *   - empirically 99% of GitHub descriptions are < 500 chars; topics +
 *     fullName + language pad ~150 more. Star repos with longer
 *     descriptions (READMEs scraped into description, multi-language
 *     bilingual blurbs, etc.) get safely truncated — semantic search
 *     still works because the high-signal head (fullName + start of desc)
 *     survives intact.
 *
 * Truncation IS hashed (see contentHash() — it calls this function and
 * djb2's the result). Consequence: stars embedded BEFORE this cap was
 * added will have a stale contentHash, and the next embedStars run
 * re-embeds them all. One-time cost (1000 stars × ~$0.01 on
 * text-embedding-3-small, free on SiliconFlow bge-m3). Documented in
 * R53 commit so the rebuild isn't surprising.
 */
const MAX_EMBED_INPUT_CHARS = 2000;

/**
 * Compose a single embedding input string from a StarredRepo.
 *
 * Layout (line-separated so providers that tokenize on whitespace still see
 * field boundaries):
 *   {fullName}                     — canonical identifier; high signal
 *   language: {language}           — strong tech-stack filter
 *   {description}                  — typically the highest semantic content
 *   topics: {topics joined}        — already-curated keywords
 *
 * Missing fields are omitted (no `language: null` noise). Empty `topics` array
 * drops the line entirely. The output is intentionally compact; embedding APIs
 * bill on tokens, and a 1000-star sync at $0.01 / 1M tokens is W3's cost target.
 *
 * R53: clamped to MAX_EMBED_INPUT_CHARS to prevent per-input 413 from China-
 * region embed providers. Truncation participates in the contentHash so a
 * future change to the cap re-embeds rows that grew or shrank past it.
 */
export function buildStarEmbeddingInput(star: StarredRepo): string {
  const lines: string[] = [star.fullName];
  if (star.language !== null && star.language.length > 0) {
    lines.push(`language: ${star.language}`);
  }
  if (star.description !== null && star.description.length > 0) {
    lines.push(star.description);
  }
  if (star.topics.length > 0) {
    lines.push(`topics: ${star.topics.join(', ')}`);
  }
  const full = lines.join('\n');
  return full.length > MAX_EMBED_INPUT_CHARS
    ? full.slice(0, MAX_EMBED_INPUT_CHARS)
    : full;
}

/**
 * Stable content hash over the embedding inputs.
 *
 * Used by the orchestrator to skip re-embedding rows whose composed text
 * hasn't changed since last embed — the cost-saving short-circuit for the
 * common case of "sync brought metadata updates but the description /
 * language / topics weren't touched."
 *
 * djb2 (variant with XOR) chosen over crypto.subtle for two reasons:
 *   1. Sync (no Promise) — keeps the orchestrator hot loop simple.
 *   2. Node and browser/Worker contexts disagree on which crypto APIs are
 *      available (Web Crypto vs node:crypto vs sync hash libs). djb2 is
 *      identical everywhere.
 *
 * Collision resistance is not a security property here — we'd accept a stale
 * embedding if two different texts collided. djb2's distribution at 32 bits
 * gives ~1% collision probability around 9k items (birthday paradox), so the
 * safe window is "low-thousand row counts". W3 KPI targets 1000 stars; W4-W5
 * may push higher and at that point this should widen to 64-bit (two djb2
 * passes with different seeds, concat hex) before the collision curve bites.
 */
export function contentHash(star: StarredRepo): string {
  const s = buildStarEmbeddingInput(star);
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  // >>> 0 forces unsigned 32-bit, then hex for compact serialization.
  return (h >>> 0).toString(16);
}
