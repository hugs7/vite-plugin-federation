export const toJsArrayLiteral = (items: string[]): string =>
  `[${items.map((s) => JSON.stringify(s)).join(',')}]`;
