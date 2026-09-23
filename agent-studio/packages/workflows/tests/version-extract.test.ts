/**
 * version-extract.test.ts — lease epoch / run version stay JSON-safe numbers.
 *
 * Regression for the Wave 4 smoke failure: the workflow scheduled
 * commitRunResult/_releaseRunLease with bigint args, and Temporal's default
 * payload converter rejects bigint — the failure surfaces INSIDE the
 * workflow (scheduleActivityNextHandler → toPayloadsWithContext) as
 * "Unable to convert [object Object] to payload" before the activity runs.
 * These tests pin the extraction contract: numbers in, numbers out.
 */
import { describe, it, expect } from 'vitest';
import { extractVersionNumber, isTemporalJsonSafe } from '../src/version-extract.js';

describe('extractVersionNumber', () => {
  it('extracts a top-level number', () => {
    expect(extractVersionNumber({ leaseEpoch: 7 }, 'leaseEpoch', 'epoch')).toBe(7);
  });

  it('extracts from the nested run object', () => {
    expect(extractVersionNumber({ run: { version: 12 } }, 'version', 'runVersion')).toBe(12);
  });

  it('prefers the primary field over the alt', () => {
    expect(extractVersionNumber({ version: 3, runVersion: 9 }, 'version', 'runVersion')).toBe(3);
  });

  it('falls back to the alt field name', () => {
    expect(extractVersionNumber({ run: { epoch: 4 } }, 'leaseEpoch', 'epoch')).toBe(4);
  });

  it('converts a bigint claim value to a number', () => {
    expect(extractVersionNumber({ run: { leaseEpoch: 5n } }, 'leaseEpoch', 'epoch')).toBe(5);
  });

  it('throws on present-but-invalid values (never silently disables fencing)', () => {
    expect(() => extractVersionNumber({ leaseEpoch: -1 }, 'leaseEpoch', 'epoch')).toThrow(
      /NON_SERIALIZABLE_VERSION/,
    );
    expect(() => extractVersionNumber({ leaseEpoch: -1n }, 'leaseEpoch', 'epoch')).toThrow(
      /NON_SERIALIZABLE_VERSION/,
    );
    expect(() => extractVersionNumber({ leaseEpoch: 1.5 }, 'leaseEpoch', 'epoch')).toThrow(
      /NON_SERIALIZABLE_VERSION/,
    );
    expect(() =>
      extractVersionNumber(
        { leaseEpoch: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
        'leaseEpoch',
        'epoch',
      ),
    ).toThrow(/NON_SERIALIZABLE_VERSION/);
    expect(() => extractVersionNumber({ leaseEpoch: '7' }, 'leaseEpoch', 'epoch')).toThrow(
      /NON_SERIALIZABLE_VERSION/,
    );
  });

  it('throws on an invalid primary even when the alt is valid', () => {
    expect(() => extractVersionNumber({ leaseEpoch: -2, epoch: 4 }, 'leaseEpoch', 'epoch')).toThrow(
      /NON_SERIALIZABLE_VERSION/,
    );
  });

  it('returns 0 for missing, null, or non-object claims', () => {
    expect(extractVersionNumber({}, 'leaseEpoch', 'epoch')).toBe(0);
    expect(extractVersionNumber(null, 'leaseEpoch', 'epoch')).toBe(0);
    expect(extractVersionNumber(undefined, 'leaseEpoch', 'epoch')).toBe(0);
    expect(extractVersionNumber({ leaseEpoch: null }, 'leaseEpoch', 'epoch')).toBe(0);
    expect(extractVersionNumber({ leaseEpoch: undefined, epoch: 6 }, 'leaseEpoch', 'epoch')).toBe(6);
  });
});

describe('isTemporalJsonSafe', () => {
  it('accepts plain JSON values', () => {
    expect(isTemporalJsonSafe({ a: 1, b: 'x', c: [1, { d: null }] })).toBe(true);
    expect(isTemporalJsonSafe(0)).toBe(true);
  });

  it('rejects bigint anywhere in the tree', () => {
    expect(isTemporalJsonSafe({ epoch: 5n })).toBe(false);
    expect(isTemporalJsonSafe({ nested: { v: [1n] } })).toBe(false);
  });

  it('rejects functions and symbols', () => {
    expect(isTemporalJsonSafe({ f: () => 1 })).toBe(false);
    expect(isTemporalJsonSafe(Symbol('s'))).toBe(false);
  });
});
