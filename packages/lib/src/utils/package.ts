import { createRequire } from 'module';
import { join } from 'path';

export const requirePackage = (packageRoot: string): NodeJS.Require =>
  createRequire(join(packageRoot, 'package.json'));
