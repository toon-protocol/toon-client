/**
 * The value, or a thrown error naming what was missing — for tests, where a
 * non-null assertion would turn an absent value into a confusing TypeError
 * three lines later, and an optional chain would let `toBeUndefined()` pass
 * on the wrong grounds.
 */
export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) {
    throw new Error(`expected a ${what}, got ${String(value)}`);
  }
  return value;
}
