/**
 * Tool/resource/prompt name mapping.
 * Uses `mcpSlug__originalName` format to namespace names across backends.
 */

const SEPARATOR = '__';

export function prefixName(mcpSlug: string, name: string): string {
  return `${mcpSlug}${SEPARATOR}${name}`;
}

export function parsePrefixedName(prefixed: string): { mcpSlug: string; name: string } {
  const idx = prefixed.indexOf(SEPARATOR);
  if (idx === -1) {
    throw new Error(`Invalid prefixed name (missing "${SEPARATOR}" separator): ${prefixed}`);
  }
  return {
    mcpSlug: prefixed.slice(0, idx),
    name: prefixed.slice(idx + SEPARATOR.length),
  };
}
