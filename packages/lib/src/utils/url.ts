export const joinUrlSegments = (a: string, b: string): string => {
  if (!a || !b) {
    return a || b || '';
  }

  if (a[a.length - 1] === '/') {
    a = a.substring(0, a.length - 1);
  }

  if (b[0] !== '/') {
    b = '/' + b;
  }

  return a + b;
};

/**
 * Check whether a request URL matches a path (with or
 * without query string).
 *
 * @param url - URL to match.
 * @param path - Corresponding file path to compare.
 * @returns True if url matches path, false otherwise.
 */
export const matchesUrl = (url: string | undefined, path: string): boolean =>
  url === path || !!url?.startsWith(`${path}?`);
