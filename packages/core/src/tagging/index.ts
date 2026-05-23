/**
 * @starkit/core/tagging — pipeline that runs starred repos through a chat
 * LLM to generate 3-5 short auto-tags per repo.
 *
 * Same callback-based decoupling as @starkit/core/embedding — caller wires
 * `provider.chat` and the persistence write-back, keeping @starkit/core
 * free of @starkit/ai workspace dependency. See orchestrator.ts for the
 * full prompt / parser / concurrency contract.
 */
export {
  buildTagUserPrompt,
  parseTagResponse,
  TAG_SYSTEM_PROMPT,
} from './text.js';
export {
  tagStars,
  type ChatBatchFn,
  type TagStarsOptions,
  type TagStarsResult,
  type UpdateStarTagsFn,
} from './orchestrator.js';
