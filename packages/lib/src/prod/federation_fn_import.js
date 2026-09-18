import { satisfy } from '__federation_fn_satisfy';

const __fed_debug = (() => {
  let pattern;
  try {
    // eslint-disable-next-line no-undef
    pattern = (typeof localStorage !== 'undefined' && localStorage.debug) || '';
  } catch (e) {
    pattern = '';
  }

  return (ns) => {
    if (!pattern) return () => {};

    const re = new RegExp('^' + pattern.replace(/\*/g, '.*?') + '$');
    if (!re.test(ns)) return () => {};

    return (...args) => console.debug('%c' + ns, 'color: #d97706', ...args);
  };
})();

const _log = __fed_debug('federation:shared');

// __federation_import and currentImports are prepended by the shared
// plugin at build time via FEDERATION_IMPORT_SNIPPET (see shared-production.ts).

// eslint-disable-next-line no-undef
const moduleMap = __rf_var__moduleMap;
const moduleCache = Object.create(null);
// Shared modules that have finished loading, for synchronous CJS consumers.
const resolvedModules = Object.create(null);

const importShared = (name, shareScope = 'default') => {
  return (
    moduleCache[name] ?? (moduleCache[name] = loadShared(name, shareScope))
  );
};

/**
 * Synchronous lookup used by the `require('<shared>')` shim that the remote
 * build injects into bundled CJS dependencies. Returns undefined until the
 * shared module has been resolved via importShared()/preloadShared().
 */
const importSharedSync = (name) => resolvedModules[name];

/**
 * Resolve every shared module up front so that bundled CJS dependencies
 * (which cannot await) see the host-provided instance. Failures are logged,
 * not thrown: a missing provider surfaces where the module is actually used.
 */
const preloadShared = (shareScope = 'default') =>
  Promise.all(
    Object.keys(moduleMap).map((name) =>
      importShared(name, shareScope).catch((err) =>
        _log(`preload of shared module "${name}" failed`, err)
      )
    )
  );

const loadShared = async (name, shareScope) => {
  const module =
    (await getSharedFromRuntime(name, shareScope)) ||
    (await getSharedFromLocal(name));
  moduleCache[name] = module;
  resolvedModules[name] = module;
  return module;
};

const getSharedFromRuntime = async (name, shareScope) => {
  let module = null;
  if (globalThis?.__federation_shared__?.[shareScope]?.[name]) {
    const versionObj = globalThis.__federation_shared__[shareScope][name];
    const requiredVersion = moduleMap[name]?.requiredVersion;
    const hasRequiredVersion = !!requiredVersion;

    if (hasRequiredVersion) {
      const versionKey = Object.keys(versionObj).find((version) =>
        satisfy(version, requiredVersion)
      );

      if (versionKey) {
        const versionValue = versionObj[versionKey];
        module = await (await versionValue.get())();
      } else {
        _log(
          `provider support ${name} is not satisfied requiredVersion(${moduleMap[name].requiredVersion}).`,
          moduleMap
        );
      }
    } else {
      const versionKey = Object.keys(versionObj)[0];
      const versionValue = versionObj[versionKey];
      module = await (await versionValue.get())();
    }
  }
  if (module) {
    return flattenModule(module, name);
  }
};

const getSharedFromLocal = async (name) => {
  if (moduleMap[name]?.import) {
    let module = await (await moduleMap[name].get())();
    return flattenModule(module, name);
  } else {
    console.error(
      `consumer config import=false,so cant use callback shared module`
    );
  }
};

const flattenModule = (module, name) => {
  // use a shared module which export default a function will getting error 'TypeError: xxx is not a function'
  if (typeof module.default === 'function') {
    Object.keys(module).forEach((key) => {
      if (key !== 'default') {
        module.default[key] = module[key];
      }
    });

    moduleCache[name] = module.default;
    return module.default;
  }

  if (module.default) module = Object.assign({}, module.default, module);
  moduleCache[name] = module;
  return module;
};

export {
  importShared,
  importSharedSync,
  preloadShared,
  getSharedFromRuntime as importSharedRuntime,
  getSharedFromLocal as importSharedLocal
};
