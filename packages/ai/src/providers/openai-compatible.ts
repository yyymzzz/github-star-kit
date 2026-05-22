/**
 * OpenAI-compatible provider — DeepSeek, SiliconFlow, Moonshot, MiMo, and any
 * other drop-in OpenAI API. Wire format is identical to OpenAIProvider; the
 * only differences are:
 *   1. `baseUrl` is REQUIRED (there is no sensible default host), and
 *   2. the key is refused for any non-https origin (except http on localhost),
 *      so a typo'd or hostile baseUrl can't exfiltrate the user's API key in
 *      cleartext.
 *
 * Unblocks China-region users who can't reach api.openai.com / api.anthropic.com.
 */
import { AIError } from '../errors.js';
import type { ProviderConfig, ProviderName } from '../types.js';
import {
  buildChatEndpoint,
  buildEmbedEndpoint,
  isSafeBaseUrl,
} from '../utils/urlBuilder.js';
import { OpenAIProvider } from './openai.js';

export class OpenAICompatibleProvider extends OpenAIProvider {
  override readonly name: ProviderName = 'openai-compatible';

  constructor(config: ProviderConfig) {
    if (!config.baseUrl) {
      throw new AIError(
        'bad_request',
        'openai-compatible requires an explicit baseUrl (e.g. https://api.deepseek.com)',
        { provider: 'openai-compatible' }
      );
    }
    if (!isSafeBaseUrl(config.baseUrl)) {
      throw new AIError(
        'bad_request',
        `openai-compatible baseUrl must be https (or http on localhost) so the API key is never sent in cleartext: ${config.baseUrl}`,
        { provider: 'openai-compatible' }
      );
    }
    // OpenAIProvider's constructor enforces apiKey + stores baseUrl.
    super(config);
  }

  // Reuse OpenAI's endpoint shape (/v1/chat/completions, /v1/embeddings, with
  // the `/v1` dedup) but against the user-supplied base rather than OpenAI's.
  protected override chatUrl(): string {
    return buildChatEndpoint('openai', this.baseUrl);
  }

  protected override embedUrl(): string {
    return buildEmbedEndpoint('openai', this.baseUrl);
  }
}
