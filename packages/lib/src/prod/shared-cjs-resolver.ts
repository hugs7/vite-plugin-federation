/**
 * Prod remote builds: redirect CJS `require('<shared>')` calls to the
 * host-provided shared instance.
 *
 * The transform in remote-production.ts rewrites ESM `import ... from
 * '<shared>'` to `await importShared()`, but CJS dependencies (e.g.
 * use-sync-external-store, pulled in by zustand) `require('react')`
 * synchronously and would otherwise bind to the remote's bundled copy of
 * React, producing a second React instance and broken hooks.
 *
 * This enforce:'pre' plugin runs before Vite's resolver and, for
 * `kind === 'require-call'` of a shared module name, resolves to a small CJS
 * shim that returns the already-loaded shared instance (see importSharedSync
 * and the preload in the remote entry's init()). The shim falls back to the
 * local copy so that standalone execution (no host, init() never called)
 * keeps working.
 */

import type { Plugin } from 'vite';

import {
  builderInfo,
  parsedOptions,
  PLUGIN_PREFIX,
  SHARED_CJS_PREFIX,
  VIRTUAL_FN_IMPORT_RESOLVED
} from '../public';
import { findOwningSharedPackage } from '../utils';

const isRemoteWithShared = () =>
  builderInfo.isRemote && parsedOptions.prodShared.length > 0;

const sharedNames = () => parsedOptions.prodShared.map((info) => info[0]);

export const prodSharedCjsResolverPlugin: Plugin = {
  name: [PLUGIN_PREFIX, 'shared-cjs-resolve-production'].join(':'),
  enforce: 'pre',
  apply: 'build',

  async resolveId(source, importer, options) {
    if (
      options.kind !== 'require-call' ||
      !importer ||
      !isRemoteWithShared() ||
      !sharedNames().includes(source)
    ) {
      return null;
    }
    // A package requiring itself (or our own shim requiring the real file)
    // must keep resolving to the local copy.
    if (
      importer.startsWith(SHARED_CJS_PREFIX) ||
      findOwningSharedPackage(importer, sharedNames()) === source
    ) {
      return null;
    }

    const resolved = await this.resolve(source, importer, {
      ...options,
      skipSelf: true
    });
    if (!resolved || resolved.external) {
      return null;
    }

    return {
      id: `${SHARED_CJS_PREFIX}${source}\0${resolved.id}`,
      moduleSideEffects: true
    };
  },

  load(id) {
    if (!id.startsWith(SHARED_CJS_PREFIX)) {
      return null;
    }
    const [sharedName, realId] = id.slice(SHARED_CJS_PREFIX.length).split('\0');
    return {
      code: [
        `const { importSharedSync } = require(${JSON.stringify(
          VIRTUAL_FN_IMPORT_RESOLVED
        )});`,
        `module.exports = importSharedSync(${JSON.stringify(
          sharedName
        )}) ?? require(${JSON.stringify(realId)});`
      ].join('\n'),
      moduleType: 'js'
    };
  }
};
