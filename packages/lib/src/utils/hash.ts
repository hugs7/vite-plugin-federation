import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const createContentHash = (path: string): string => {
  const content = readFileSync(path, { encoding: 'utf-8' });
  return createHash('md5').update(content).digest('hex').toString().slice(0, 8);
};
