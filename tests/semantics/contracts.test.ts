import { describe, expect, it } from 'vitest';
import {
  and,
  ATTRIBUTIONS,
  CONTROL_STATUSES,
  countsAsPassBasis,
  EFFECT_CLASSES,
  EFFECT_STATUSES,
  EVIDENCE_LEVELS,
  isUnknown,
  not,
  or,
  REASONS,
  SOURCES,
  triToEffect,
  unknown,
  type Tri,
} from '@mc-agent/contracts';

const U = undefined;
const T = true;
const F = false;
const ALL: Tri[] = [T, F, U];

describe('Kleene three-valued logic', () => {
  it('and: false dominates, unknown if any unknown and none false', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        const expected: Tri = a === F || b === F ? F : a === T && b === T ? T : U;
        expect(and([a, b])).toBe(expected);
      }
    }
  });

  it('or: true dominates, unknown only when no true and some unknown', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        const expected: Tri = a === T || b === T ? T : a === F && b === F ? F : U;
        expect(or([a, b])).toBe(expected);
      }
    }
  });

  it('not preserves unknown', () => {
    expect(not(T)).toBe(F);
    expect(not(F)).toBe(T);
    expect(not(U)).toBe(U);
  });

  it('and/or of empty are the identity', () => {
    expect(and([])).toBe(T);
    expect(or([])).toBe(F);
  });

  it('unknown never collapses to false', () => {
    expect(and([T, U])).toBe(U);
    expect(or([F, U])).toBe(U);
    expect(and([U, U])).not.toBe(F);
  });
});

describe('triToEffect', () => {
  it('maps all-true→pass, false→fail, unknown→unobservable', () => {
    expect(triToEffect(T)).toBe('pass');
    expect(triToEffect(F)).toBe('fail');
    expect(triToEffect(U)).toBe('unobservable');
  });
});

describe('facts', () => {
  it('isUnknown detects the explicit unknown marker', () => {
    const u = unknown('unloaded chunk');
    expect(isUnknown(u)).toBe(true);
    expect(isUnknown({ value: 1 })).toBe(false);
    expect(isUnknown(null)).toBe(false);
  });

  it('only observed/attributed evidence may back a pass', () => {
    expect(countsAsPassBasis('sent')).toBe(false);
    expect(countsAsPassBasis('predicted')).toBe(false);
    expect(countsAsPassBasis('observed')).toBe(true);
    expect(countsAsPassBasis('attributed')).toBe(true);
  });
});

describe('frozen vocabularies', () => {
  it('are frozen and non-empty', () => {
    expect(EFFECT_STATUSES).toEqual(['pass', 'fail', 'ambiguous', 'unobservable']);
    expect(CONTROL_STATUSES.length).toBe(6);
    expect(REASONS).toContain('policy_blocked');
    expect(ATTRIBUTIONS).toContain('self_temporal');
    expect(EFFECT_CLASSES).toEqual(['read', 'idempotent', 'consumable', 'irreversible']);
    expect(SOURCES).toEqual(['authoritative', 'observed', 'predicted', 'inferred']);
    expect(EVIDENCE_LEVELS).toEqual(['sent', 'predicted', 'observed', 'attributed']);
  });
});
