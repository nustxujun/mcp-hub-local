import { SLUG_REGEX, MAX_SLUG_LENGTH } from './constants.js';

export function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

export function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug) && slug.length <= MAX_SLUG_LENGTH;
}
