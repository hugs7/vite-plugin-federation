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

const currentImports = {};

// eslint-disable-next-line no-undef
const moduleMap = __rf_var__moduleMap;
const moduleCache = Object.create(null);

function importShared(name, shareScope = 'default') {
  return moduleCache[name] ?? (moduleCache[name] = loadShared(name, shareScope));
}

async function loadShared(name, shareScope) {
  const module =
    (await getSharedFromRuntime(name, shareScope)) ||
    (await getSharedFromLocal(name));
  moduleCache[name] = module;
  return module;
}

async function __federation_import(name) {
  currentImports[name] ??= import(name);
  return currentImports[name];
}

async function getSharedFromRuntime(name, shareScope) {
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
}

async function getSharedFromLocal(name) {
  if (moduleMap[name]?.import) {
    let module = await (await moduleMap[name].get())();
    return flattenModule(module, name);
  } else {
    console.error(
      `consumer config import=false,so cant use callback shared module`
    );
  }
}

function flattenModule(module, name) {
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
}

export {
  importShared,
  getSharedFromRuntime as importSharedRuntime,
  getSharedFromLocal as importSharedLocal
};
