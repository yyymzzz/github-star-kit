/**
 * AI provider error taxonomy.
 *
 * Distinct from generic Error so calling code can branch on `kind` without
 * string-matching messages. Preserves underlying cause via `cause` for stack
 * traces in dev.
 */

export type AIErrorKind =
  | 'auth'        // 401, 403 — invalid/expired API key, no permission
  | 'rate_limit'  // 429 — rate limited or quota exceeded
  | 'timeout'     // 408, 504, AbortError — request exceeded deadline
  | 'network'     // fetch threw before response (DNS, connection refused, etc.)
  | 'server'      // 5xx — provider-side fault
  | 'bad_request' // 400, 404, 422 — client-side issue (bad model name, malformed payload)
  | 'parse'       // 2xx but response shape unexpected (provider broke contract)
  | 'unknown';

export interface AIErrorContext {
  readonly provider: string;
  readonly model?: string;
  readonly statusCode?: number;
  readonly retryAfterSeconds?: number;
}

export class AIError extends Error {
  readonly kind: AIErrorKind;
  readonly context: AIErrorContext;

  constructor(kind: AIErrorKind, message: string, context: AIErrorContext, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'AIError';
    this.kind = kind;
    this.context = context;
    // Maintain prototype chain across transpilation targets.
    Object.setPrototypeOf(this, AIError.prototype);
  }

  /** Convenience: derive AIError from an HTTP Response. Reads no body. */
  static fromHttpResponse(
    response: Response,
    context: Omit<AIErrorContext, 'statusCode' | 'retryAfterSeconds'>
  ): AIError {
    const status = response.status;
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;
    const kind = mapStatusToKind(status);
    const message = `HTTP ${status} ${response.statusText || ''}`.trim();
    return new AIError(kind, message, {
      ...context,
      statusCode: status,
      ...(retryAfter !== undefined && !Number.isNaN(retryAfter) ? { retryAfterSeconds: retryAfter } : {}),
    });
  }

  /** Convenience: derive AIError from a thrown fetch error (network/abort). */
  static fromFetchError(err: unknown, context: AIErrorContext): AIError {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return new AIError('timeout', 'Request aborted', context, err);
    }
    if (err instanceof TypeError) {
      return new AIError('network', err.message || 'Network error', context, err);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return new AIError('unknown', msg, context, err);
  }
}

function mapStatusToKind(status: number): AIErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  // R52: 413 (Payload Too Large) added to bad_request. Surfaced by
  // SiliconFlow / DashScope embedding endpoints when an embed batch's
  // total JSON body exceeds their per-request size cap. embedStars uses
  // this kind to trigger the adaptive batch-split retry path.
  if (status === 400 || status === 404 || status === 413 || status === 422) return 'bad_request';
  if (status >= 500) return 'server';
  return 'unknown';
}
