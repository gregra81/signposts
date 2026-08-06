// Per-leaf merge for the config layers: a repo file that sets only
// `retrieval.k` must leave every other key at whatever the lower layers
// resolved to. A shallow object spread would instead replace the whole
// `retrieval` block, dropping the layers below it.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Merges `override` onto `base`, recursing into nested plain objects and
 * overwriting everything else (primitives, arrays, `null`) leaf-by-leaf.
 */
export function mergeLeaves(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const baseValue = result[key];
    const overrideValue = override[key];
    result[key] =
      isPlainObject(baseValue) && isPlainObject(overrideValue)
        ? mergeLeaves(baseValue, overrideValue)
        : overrideValue;
  }
  return result;
}
