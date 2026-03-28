import type {
  ConfigTypeSet,
  Exposes,
  Remotes,
  Shared,
  VitePluginFederationOptions
} from '../../types';

export const parseOptions = (
  options: Exposes | Remotes | Shared | undefined,
  normalizeSimple: (value: any, key: any) => ConfigTypeSet,
  normalizeOptions: (value: any, key: any) => ConfigTypeSet
): (string | ConfigTypeSet)[] => {
  if (!options) {
    return [];
  }
  const list: {
    [index: number]: string | ConfigTypeSet;
  }[] = [];
  const array = (items: (string | ConfigTypeSet)[]) => {
    for (const item of items) {
      if (typeof item === 'string') {
        list.push([item, normalizeSimple(item, item)]);
      } else if (item && typeof item === 'object') {
        object(item);
      } else {
        throw new Error('Unexpected options format');
      }
    }
  };

  const object = (obj: object) => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' || Array.isArray(value)) {
        list.push([key, normalizeSimple(value, key)]);
      } else {
        list.push([key, normalizeOptions(value, key)]);
      }
    }
  };

  if (Array.isArray(options)) {
    array(options);
  } else if (typeof options === 'object') {
    object(options);
  } else {
    throw new Error('Unexpected options format');
  }

  return list;
};

export const parseSharedOptions = (
  options: VitePluginFederationOptions
): (string | ConfigTypeSet)[] => {
  return parseOptions(
    options.shared || {},
    (_value, key) => ({
      import: true,
      shareScope: 'default',
      packagePath: key,
      // Whether the path is set manually
      manuallyPackagePathSetting: false,
      generate: true,
      modulePreload: false
    }),
    (value, key) => {
      value.import = value.import ?? true;
      value.shareScope = value.shareScope || 'default';
      value.packagePath = value.packagePath || key;
      value.manuallyPackagePathSetting = value.packagePath !== key;
      value.generate = value.generate ?? true;
      value.modulePreload = value.modulePreload ?? false;
      return value;
    }
  );
};

export const parseExposeOptions = (
  options: VitePluginFederationOptions
): (string | ConfigTypeSet)[] => {
  return parseOptions(
    options.exposes,
    (item) => {
      return {
        import: item,
        name: undefined,
        dontAppendStylesToHead: false
      };
    },
    (item) => ({
      import: item.import,
      name: item.name || undefined,
      dontAppendStylesToHead: item.dontAppendStylesToHead || false
    })
  );
};
