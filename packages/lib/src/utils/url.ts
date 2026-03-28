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

export const matchesUrl = (url: string | undefined, path: string): boolean =>
  url === path || !!url?.startsWith(`${path}?`);
