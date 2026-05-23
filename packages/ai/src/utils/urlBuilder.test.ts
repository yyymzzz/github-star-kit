/**
 * Unit tests for the AI provider URL builder.
 *
 * `urlBuilder.ts` is security-critical (the `isSafeBaseUrl` guard is what
 * stops a typo'd `openai-compatible` baseUrl from sending the BYOK key to
 * an arbitrary http host in cleartext). It was previously only covered
 * transitively through `openai-compatible.test.ts`; this file pins down
 * the pure functions directly so the whole surface — every provider, every
 * version-dedup edge case, every URL scheme — has a regression net.
 */
import { describe, expect, it } from 'vitest';
import {
  buildApiUrl,
  buildChatEndpoint,
  buildEmbedEndpoint,
  defaultBaseUrl,
  isSafeBaseUrl,
} from './urlBuilder.js';

describe('buildApiUrl', () => {
  it('appends path when base has no version segment', () => {
    expect(buildApiUrl('https://api.openai.com', 'v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions'
    );
  });

  it('strips duplicate v1 when base ends with /v1', () => {
    expect(buildApiUrl('https://api.openai.com/v1', 'v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions'
    );
  });

  it('handles trailing slash on base', () => {
    expect(buildApiUrl('https://api.openai.com/', 'v1/embeddings')).toBe(
      'https://api.openai.com/v1/embeddings'
    );
    expect(buildApiUrl('https://api.openai.com/v1/', 'v1/embeddings')).toBe(
      'https://api.openai.com/v1/embeddings'
    );
  });

  it('strips multiple trailing slashes on base', () => {
    expect(buildApiUrl('https://api.openai.com///', 'v1/chat')).toBe(
      'https://api.openai.com/v1/chat'
    );
  });

  it('strips leading slashes on path', () => {
    expect(buildApiUrl('https://api.openai.com', '/v1/chat')).toBe(
      'https://api.openai.com/v1/chat'
    );
    expect(buildApiUrl('https://api.openai.com', '///v1/chat')).toBe(
      'https://api.openai.com/v1/chat'
    );
  });

  it('honors version dedup for v2 / v3 (not hardcoded to v1)', () => {
    expect(buildApiUrl('https://proxy.example.com/v2', 'v2/foo')).toBe(
      'https://proxy.example.com/v2/foo'
    );
    expect(buildApiUrl('https://proxy.example.com/v3', 'v3/bar')).toBe(
      'https://proxy.example.com/v3/bar'
    );
  });

  it('passes the path through unchanged when base lacks a version', () => {
    expect(buildApiUrl('https://api.example.com', 'v1/foo')).toBe(
      'https://api.example.com/v1/foo'
    );
  });

  it('appends non-versioned paths to a versioned base', () => {
    expect(buildApiUrl('https://api.example.com/v1', 'foo/bar')).toBe(
      'https://api.example.com/v1/foo/bar'
    );
  });

  /**
   * Documents a known permissive-regex behavior, NOT desired behavior:
   *   base `/v1` + path `v2/foo` collapses to `/v1/foo` — the path's `v2/`
   *   prefix is stripped even though it does not match the base version.
   *
   * No caller exercises this in v1 (every callsite passes a path whose
   * version digit matches its baseUrl). Pinning the behavior here so a
   * future tightening of the regex (require digit equality) is a visible
   * test diff rather than a silent behavior change.
   */
  it('[known quirk] strips any leading vN/ from path when base has /vM (versions need not match)', () => {
    expect(buildApiUrl('https://api.example.com/v1', 'v2/foo')).toBe(
      'https://api.example.com/v1/foo'
    );
  });
});

describe('buildChatEndpoint', () => {
  it('returns OpenAI v1/chat/completions for openai', () => {
    expect(buildChatEndpoint('openai', 'https://api.openai.com')).toBe(
      'https://api.openai.com/v1/chat/completions'
    );
  });

  it('returns Anthropic v1/messages for anthropic', () => {
    expect(buildChatEndpoint('anthropic', 'https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1/messages'
    );
  });

  it('returns Ollama api/chat for ollama', () => {
    expect(buildChatEndpoint('ollama', 'http://localhost:11434')).toBe(
      'http://localhost:11434/api/chat'
    );
  });

  it('returns baseUrl as-is for openai-compatible (proxy routing varies)', () => {
    // openai-compatible proxies do their own request routing; we hand the
    // caller's URL through untouched so they can target whichever path their
    // proxy expects (e.g. SiliconFlow vs DeepSeek vs Moonshot may differ).
    expect(
      buildChatEndpoint('openai-compatible', 'https://api.deepseek.com/v1/chat/completions')
    ).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('throws for voyage (embedding-only provider — chat is undefined)', () => {
    expect(() => buildChatEndpoint('voyage', 'https://api.voyageai.com')).toThrow(
      /Voyage AI does not support chat/
    );
  });
});

describe('buildEmbedEndpoint', () => {
  it('returns v1/embeddings for openai', () => {
    expect(buildEmbedEndpoint('openai', 'https://api.openai.com')).toBe(
      'https://api.openai.com/v1/embeddings'
    );
  });

  it('honors /v1 dedup for openai-compatible base ending in /v1', () => {
    expect(buildEmbedEndpoint('openai-compatible', 'https://api.siliconflow.cn/v1')).toBe(
      'https://api.siliconflow.cn/v1/embeddings'
    );
  });

  it('returns v1/embeddings for voyage', () => {
    expect(buildEmbedEndpoint('voyage', 'https://api.voyageai.com')).toBe(
      'https://api.voyageai.com/v1/embeddings'
    );
  });

  it('returns api/embed for ollama', () => {
    expect(buildEmbedEndpoint('ollama', 'http://localhost:11434')).toBe(
      'http://localhost:11434/api/embed'
    );
  });

  it('throws for anthropic (no first-party embeddings API in 2026)', () => {
    expect(() => buildEmbedEndpoint('anthropic', 'https://api.anthropic.com')).toThrow(
      /Anthropic does not provide an embeddings API/
    );
  });
});

describe('isSafeBaseUrl', () => {
  it('accepts https on any host', () => {
    expect(isSafeBaseUrl('https://api.openai.com')).toBe(true);
    expect(isSafeBaseUrl('https://api.siliconflow.cn/v1')).toBe(true);
    expect(isSafeBaseUrl('https://localhost')).toBe(true);
    expect(isSafeBaseUrl('https://10.0.0.1')).toBe(true);
    expect(isSafeBaseUrl('https://api.example.com/v1/')).toBe(true);
  });

  it('accepts http on IPv4 loopback (localhost / 127.0.0.1)', () => {
    expect(isSafeBaseUrl('http://localhost')).toBe(true);
    expect(isSafeBaseUrl('http://localhost:11434')).toBe(true);
    expect(isSafeBaseUrl('http://127.0.0.1')).toBe(true);
    expect(isSafeBaseUrl('http://127.0.0.1:1234')).toBe(true);
  });

  it('accepts http on IPv6 loopback ([::1])', () => {
    expect(isSafeBaseUrl('http://[::1]')).toBe(true);
    expect(isSafeBaseUrl('http://[::1]:8080')).toBe(true);
  });

  it('rejects http on non-loopback hosts (the cleartext-key-leak vector)', () => {
    expect(isSafeBaseUrl('http://api.openai.com')).toBe(false);
    expect(isSafeBaseUrl('http://evil.example.com')).toBe(false);
    expect(isSafeBaseUrl('http://10.0.0.1')).toBe(false);
    expect(isSafeBaseUrl('http://192.168.1.1')).toBe(false);
  });

  it('rejects http on non-127.0.0.1 loopback addresses (conservative whitelist)', () => {
    // 127.0.0.0/8 is *technically* all loopback in IPv4, but we whitelist
    // only the canonical 127.0.0.1 to keep the attack surface minimal.
    // A user with a non-canonical loopback Ollama setup must use https or
    // 127.0.0.1 directly.
    expect(isSafeBaseUrl('http://127.0.0.5')).toBe(false);
    expect(isSafeBaseUrl('http://127.0.0.100')).toBe(false);
  });

  it('rejects non-http(s) schemes (ftp / ws / javascript / data / file)', () => {
    expect(isSafeBaseUrl('ftp://example.com')).toBe(false);
    expect(isSafeBaseUrl('ws://example.com')).toBe(false);
    expect(isSafeBaseUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeBaseUrl('data:text/plain,foo')).toBe(false);
    expect(isSafeBaseUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects unparseable inputs without throwing', () => {
    expect(isSafeBaseUrl('')).toBe(false);
    expect(isSafeBaseUrl('not-a-url')).toBe(false);
    expect(isSafeBaseUrl('https://')).toBe(false); // URL constructor rejects missing host
    expect(isSafeBaseUrl('http://')).toBe(false);
  });
});

describe('defaultBaseUrl', () => {
  it('returns canonical hosts for first-party providers', () => {
    expect(defaultBaseUrl('openai')).toBe('https://api.openai.com');
    expect(defaultBaseUrl('anthropic')).toBe('https://api.anthropic.com');
    expect(defaultBaseUrl('voyage')).toBe('https://api.voyageai.com');
    expect(defaultBaseUrl('ollama')).toBe('http://localhost:11434');
  });

  it('throws for openai-compatible (no sensible default; user must provide)', () => {
    expect(() => defaultBaseUrl('openai-compatible')).toThrow(
      /openai-compatible requires explicit baseUrl/
    );
  });
});
