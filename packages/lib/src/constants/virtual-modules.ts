export const VIRTUAL_FEDERATION = 'virtual:__federation__';
export const VIRTUAL_FEDERATION_RESOLVED = `\0${VIRTUAL_FEDERATION}`;
export const VIRTUAL_FN_IMPORT = '__federation_fn_import';
export const VIRTUAL_FN_IMPORT_RESOLVED = `\0virtual:${VIRTUAL_FN_IMPORT}`;
export const VIRTUAL_FN_SATISFY = '__federation_fn_satisfy';
export const REMOTE_ENTRY_HELPER_PREFIX = '__remoteEntryHelper__';

export const SHARED_VIRTUAL_PREFIX = 'virtual:__federation_shared__:';
export const RESOLVED_SHARED_PREFIX = '\0' + SHARED_VIRTUAL_PREFIX;

/**
 * Prod-only: CJS `require('<shared>')` calls in a remote build are redirected
 * to `<prefix><sharedName>\0<realId>` so they read the host-provided instance.
 */
export const SHARED_CJS_PREFIX = '\0virtual:__federation_shared_cjs__:';
