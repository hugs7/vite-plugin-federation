import { createRequire } from 'node:module';
import { join } from 'node:path';

export const requirePackage = (packageRoot: string): NodeJS.Require =>
  createRequire(join(packageRoot, 'package.json'));

/**
 * Returns the shared package name whose installed directory contains `id`
 * (matching `/node_modules/<name>/`, which also covers `@scope/pkg`), or
 * undefined when the file does not belong to any shared package.
 */
export const findOwningSharedPackage = (
  id: string,
  sharedNames: string[]
): string | undefined => {
  const normalizedId = id.replace(/\\/g, '/');
  return sharedNames.find((name) =>
    normalizedId.includes(`/node_modules/${name}/`)
  );
};
