/**
 * Localized error formatter for the extension UI surface.
 *
 * R29 蓝军 (R26 round-3 MINOR #5 + audit round-4 MINOR #5 close-out):
 * `setError(formatError(err))` was called from 12+ sites in popup + manage.
 * `formatError` returns English-only strings sourced from
 * `packages/core/src/format.ts:githubErrorMessage()` — so Chinese users
 * saw localized progress notices but English error banners. Same UX
 * inconsistency class that R20 → R28 chipped away at, just one layer
 * deeper (the formatError seam was pre-existing across all surfaces).
 *
 * Design: keep `formatError` in @starkit/core as the English-fallback
 * (it's also used by obsidian for now, and shouldn't depend on
 * extension's i18n layer). Add this thin wrapper at the extension
 * boundary that branches on err.name + err.kind via duck-typing and
 * looks up the right `error.github.<kind>` / `error.ai.<kind>` key.
 *
 * Duck-typing rationale: GithubError and AIError live in different
 * packages (@starkit/core and @starkit/ai). Importing both classes
 * for `instanceof` would be fine here, but using `err.name` strings
 * means we don't take a hard dep on the AI package's exported types —
 * acceptable since both Error classes set name via constructor.
 */
import { formatError } from '@starkit/core';

type Translator = (key: string, vars?: Record<string, unknown>) => string;

/**
 * Convert any thrown value to a user-facing string in the active UI
 * locale. Falls back to {@link formatError}'s English string when:
 *   - err is not Error-shaped
 *   - err.kind is missing or non-string (defensive against future
 *     error classes that don't carry the discriminator)
 *
 * For GithubError 'rate_limit' with a rateLimitResetSeconds context
 * field, uses the more specific `rate_limit_with_reset` key that
 * interpolates the wait time. Mirrors the conditional in the legacy
 * `githubErrorMessage()` function so behavior matches v0.x exactly
 * — only the LANGUAGE changes.
 */
export function localizeError(err: unknown, t: Translator): string {
  if (!(err instanceof Error)) {
    return formatError(err);
  }
  const kindRaw = (err as { kind?: unknown }).kind;
  if (typeof kindRaw !== 'string') {
    return formatError(err);
  }
  if (err.name === 'GithubError') {
    if (kindRaw === 'rate_limit') {
      const ctx = (err as { context?: { rateLimitResetSeconds?: unknown } })
        .context;
      const resetSec = ctx?.rateLimitResetSeconds;
      if (typeof resetSec === 'number' && Number.isFinite(resetSec)) {
        return t('error.github.rate_limit_with_reset', {
          mins: Math.ceil(resetSec / 60),
        });
      }
    }
    return t(`error.github.${kindRaw}`, { message: err.message });
  }
  if (err.name === 'AIError') {
    return t(`error.ai.${kindRaw}`, { message: err.message });
  }
  // Unknown error class — fall back to raw English. Could be a third-
  // party SDK error class we don't recognize; better visible than
  // silenced.
  return formatError(err);
}
