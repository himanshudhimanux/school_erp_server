/**
 * Converts a partial nested object into dot-notation for `$set`, so a PATCH of
 * { address: { city: 'Pune' } } updates only address.city instead of replacing address.
 */
export function toDotPaths(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !value._bsontype) {
      toDotPaths(value, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}
