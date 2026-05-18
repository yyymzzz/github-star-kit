/**
 * @starkit/ai — Provider-agnostic AI adapter.
 *
 * Day 1 status: type contracts only. Provider implementations land W1 Day 2.
 * BYOK design — no API keys ever live in this package; they're injected per-call.
 */

export const VERSION = '0.0.1';

export type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
} from './types.js';
