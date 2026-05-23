import { describe, expect, it } from 'vitest';
import {
  computeInterestProfile,
  digestCosine,
  recencyBoost,
} from './profile.js';

describe('computeInterestProfile', () => {
  it('returns the mean vector over its inputs', () => {
    expect(computeInterestProfile([[1, 2], [3, 4]])).toEqual([2, 3]);
  });

  it('returns the input vector unchanged when there is only one', () => {
    expect(computeInterestProfile([[1, 0, -1]])).toEqual([1, 0, -1]);
  });

  it('returns [] for an empty input list', () => {
    expect(computeInterestProfile([])).toEqual([]);
  });

  it('returns [] when all input vectors are zero-dim', () => {
    expect(computeInterestProfile([[], []])).toEqual([]);
  });

  it('throws on dim mismatch (defensive — mixing models is silent bug bait)', () => {
    expect(() => computeInterestProfile([[1, 2], [3, 4, 5]])).toThrow(
      /dim mismatch/
    );
  });

  it('handles a longer real-world-ish input set', () => {
    const inputs = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    expect(computeInterestProfile(inputs)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
});

describe('digestCosine', () => {
  it('returns 1.0 for parallel vectors', () => {
    expect(digestCosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(digestCosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns -1 for anti-parallel vectors', () => {
    expect(digestCosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('returns 0 when either operand is the zero vector', () => {
    expect(digestCosine([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(digestCosine([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it('returns 0 for empty vectors (degenerate empty profile case)', () => {
    expect(digestCosine([], [])).toBe(0);
  });

  it('throws on dim mismatch', () => {
    expect(() => digestCosine([1, 2], [1, 2, 3])).toThrow(/dim mismatch/);
  });
});

describe('recencyBoost', () => {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  it('returns 1.0 when pushedAt == now', () => {
    expect(recencyBoost(1000, 1000, WEEK_MS)).toBe(1);
  });

  it('returns 0.5 at half the window', () => {
    expect(recencyBoost(1000, 1000 + WEEK_MS / 2, WEEK_MS)).toBeCloseTo(0.5);
  });

  it('returns 0 at the window edge', () => {
    expect(recencyBoost(1000, 1000 + WEEK_MS, WEEK_MS)).toBe(0);
  });

  it('returns 0 past the window (defensive — orchestrator already filters)', () => {
    expect(recencyBoost(1000, 1000 + WEEK_MS * 10, WEEK_MS)).toBe(0);
  });

  it('returns 1.0 for future push (clock skew tolerance)', () => {
    expect(recencyBoost(2000, 1000, WEEK_MS)).toBe(1);
  });

  it('returns 0 when windowMs is non-positive (defensive)', () => {
    expect(recencyBoost(1000, 1000, 0)).toBe(0);
    expect(recencyBoost(1000, 1000, -1000)).toBe(0);
  });
});
