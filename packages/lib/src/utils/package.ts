import { createRequire } from 'node:module';
import { join } from 'node:path';

export const requirePackage = (packageRoot: string): NodeJS.Require =>
  createRequire(join(packageRoot, 'package.json'));
