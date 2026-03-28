import type { RemotesConfig } from '../../types';
import type { ConfigTypeSet, VitePluginFederationOptions } from '../../types';

import { parseOptions } from './plugin';

export type Remote = { id: string; regexp: RegExp; config: RemotesConfig };

export const createRemotesMap = (remotes: Remote[]): string => {
  const createUrl = (remote: Remote) => {
    const external = remote.config.external[0];
    const externalType = remote.config.externalType;
    if (externalType === 'promise') {
      return `()=>${external}`;
    } else {
      return `'${external}'`;
    }
  };
  return `const remotesMap = {
${remotes
  .map(
    (remote) =>
      `'${remote.id}':{url:${createUrl(remote)},format:'${
        remote.config.format
      }',from:'${remote.config.from}'}`
  )
  .join(',\n  ')}
};`;
};

export const parseRemoteOptions = (
  options: VitePluginFederationOptions
): (string | ConfigTypeSet)[] => {
  return parseOptions(
    options.remotes ? options.remotes : {},
    (item) => ({
      external: Array.isArray(item) ? item : [item],
      shareScope: options.shareScope || 'default',
      format: 'esm',
      from: 'vite',
      externalType: 'url'
    }),
    (item) => ({
      external: Array.isArray(item.external) ? item.external : [item.external],
      shareScope: item.shareScope || options.shareScope || 'default',
      format: item.format || 'esm',
      from: item.from ?? 'vite',
      externalType: item.externalType || 'url'
    })
  );
};
