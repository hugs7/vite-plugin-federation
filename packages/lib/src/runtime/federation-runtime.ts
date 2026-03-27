/**
 * Shared federation runtime template for the __federation__ virtual module.
 *
 * Both dev and prod remote plugins generate a __federation__ virtual module
 * with the same core runtime functions. This builder deduplicates that code.
 */

interface FederationRuntimeOptions {
  remotesMapCode: string;
  shareScopeWrapperCode: string;
  getFunctionCode: string;
  extraPreludeCode?: string;
}

export const buildFederationRuntimeCode = (
  opts: FederationRuntimeOptions
): string => `
${opts.remotesMapCode}
${opts.extraPreludeCode ?? ''}
const loadJS = async (url, fn) => {
  const resolvedUrl = typeof url === 'function' ? await url() : url;
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.onload = fn;
  script.src = resolvedUrl;
  document.getElementsByTagName('head')[0].appendChild(script);
};
${opts.getFunctionCode}
${opts.shareScopeWrapperCode}
const __federation_initRemote = (remote, lib) => {
  if (!remote.inited) {
    remote.lib = lib;
    remote.lib.init(wrapShareScope(remote.from));
    remote.inited = true;
  }
  return remote.lib;
};

const __federation_method_ensure = async (remoteId) => {
  const remote = remotesMap[remoteId];
  if (remote.inited) return remote.lib;

  if ('var' === remote.format) {
    return new Promise((resolve) => {
      loadJS(remote.url, () => resolve(__federation_initRemote(remote, window[remoteId])));
    });
  } else if (['esm', 'systemjs'].includes(remote.format)) {
    const getUrl = typeof remote.url === 'function' ? remote.url : () => Promise.resolve(remote.url);
    const url = await getUrl();
    const lib = await import(/* @vite-ignore */ url);
    return __federation_initRemote(remote, lib);
  }
};

const __federation_method_unwrapDefault = (module) =>
  (module?.__esModule || module?.[Symbol.toStringTag] === 'Module') ? module.default : module;

const __federation_method_wrapDefault = (module, need) => {
  if (!module?.default && need) {
    const obj = Object.create(null);
    obj.default = module;
    obj.__esModule = true;
    return obj;
  }
  return module;
};

const __federation_method_getRemote = (remoteName, componentName) =>
  __federation_method_ensure(remoteName).then((remote) => remote.get(componentName).then(factory => factory()));

const __federation_method_setRemote = (remoteName, remoteConfig) => {
  remotesMap[remoteName] = remoteConfig;
};
export { __federation_method_ensure, __federation_method_getRemote, __federation_method_setRemote, __federation_method_unwrapDefault, __federation_method_wrapDefault };
`;
