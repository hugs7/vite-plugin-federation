/**
 * Serialize an array of strings into a JS array literal (e.g. `['a','b']`).
 *
 * @param items - Items to format to array literal.
 * @returns Array string literal.
 */
export const toJsArrayLiteral = (items: string[]): string =>
  `[${items.map((s) => JSON.stringify(s)).join(',')}]`;
