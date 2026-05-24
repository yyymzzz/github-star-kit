/**
 * AI provider presets for the popup's setup UI.
 *
 * v1 ships three first-class providers — each one is an OpenAI-compatible
 * endpoint, so they all flow through `@starkit/ai`'s `OpenAICompatibleProvider`
 * with just a different baseUrl + default model pair. No new provider class
 * needed.
 *
 * SiliconFlow + DashScope cover the China-region use case (the OpenAI host is
 * unreachable behind GFW); OpenAI stays for users who already have a key and
 * want the original embedding model.
 *
 * Custom-baseUrl support (for self-hosted Ollama-style proxies, Moonshot,
 * MiMo, etc.) is intentionally deferred — it requires either 4 UI inputs
 * (baseUrl + key + chatModel + embedModel) or a "Custom" preset that reveals
 * those fields conditionally. v0.2 polish.
 */

export type AiPresetId = 'siliconflow' | 'dashscope' | 'openai';

export interface AiPreset {
  readonly id: AiPresetId;
  /** Display label in the popup dropdown. */
  readonly label: string;
  /** Where the user goes to get an API key — surfaced as a help-text link. */
  readonly signupUrl: string;
  /** OpenAI-compatible base URL, ends without trailing slash. The
   *  `OpenAICompatibleProvider` rejects baseUrls that are http on non-loopback
   *  hosts, so every preset URL here must be https. */
  readonly baseUrl: string;
  /** Default chat model — used for auto-tag + weekly digest summaries. */
  readonly chatModel: string;
  /** Default embed model — used for semantic search + digest centroid +
   *  deep-index. */
  readonly embedModel: string;
  /** Short one-liner shown under the dropdown to explain what the user is
   *  about to pay for. */
  readonly description: string;
  /** Indicative price for indexing 1000 starred repos (embed cost only) +
   *  one weekly-digest run (chat cost only). Surfaced in the description so
   *  the user sees the BYOK number before they click Save. */
  readonly priceHint: string;
}

export const AI_PRESETS: Record<AiPresetId, AiPreset> = {
  siliconflow: {
    id: 'siliconflow',
    label: 'SiliconFlow (硅基流动) — DeepSeek + bge-m3',
    signupUrl: 'https://cloud.siliconflow.cn/account/ak',
    baseUrl: 'https://api.siliconflow.cn/v1',
    // Pro tier of DeepSeek-V3 — best $/quality on SiliconFlow's hosted menu
    // as of 2026-05. Users can override per-call later if v0.2 ships a
    // model picker.
    chatModel: 'Pro/deepseek-ai/DeepSeek-V3',
    // BAAI/bge-m3 — 1024 dim, open-source multilingual. Free tier covers
    // ~1M tokens / day; 1000-star embed is ~150k tokens.
    embedModel: 'BAAI/bge-m3',
    description:
      'China-region friendly. DeepSeek for chat + bge-m3 for search. One key, both jobs.',
    priceHint: '~¥0.5 per 1000 stars indexed (often free during promos)',
  },
  dashscope: {
    id: 'dashscope',
    label: 'Alibaba DashScope (通义千问 Qwen)',
    signupUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatModel: 'qwen-plus',
    embedModel: 'text-embedding-v3',
    description:
      "Aliyun's official Qwen API in OpenAI-compatible mode. Best Chinese-language tagging.",
    priceHint: '~¥0.7 per 1000 stars indexed',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (api.openai.com)',
    signupUrl: 'https://platform.openai.com/api-keys',
    baseUrl: 'https://api.openai.com/v1',
    chatModel: 'gpt-4o-mini',
    embedModel: 'text-embedding-3-small',
    description:
      'Original. Needs a non-China network + a credit card on file with OpenAI.',
    priceHint: '~$0.02 per 1000 stars indexed',
  },
};

/** Default preset on first launch. SiliconFlow is the most-likely-to-work
 *  pick for the China-default audience this repo's STRATEGY.md targets. */
export const DEFAULT_AI_PRESET: AiPresetId = 'siliconflow';

/** Stable ordering for the dropdown. Don't sort alphabetically — preset
 *  order conveys recommended-first. */
export const AI_PRESET_ORDER: ReadonlyArray<AiPresetId> = [
  'siliconflow',
  'dashscope',
  'openai',
];
