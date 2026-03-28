import { extname, parse, posix } from 'node:path';
import type { ResolvedConfig } from 'vite';

import { joinUrlSegments } from './url';

export const normalizePath = (id: string): string => {
  return posix.normalize(id.replace(/\\/g, '/'));
};

export const isSameFilepath = (src: string, dest: string): boolean => {
  if (!src || !dest) {
    return false;
  }
  src = normalizePath(src);
  dest = normalizePath(dest);
  const srcExt = parse(src).ext;
  const destExt = parse(dest).ext;
  if (srcExt && destExt && srcExt !== destExt) {
    return false;
  }
  if (srcExt) {
    src = src.slice(0, -srcExt.length);
  }
  if (destExt) {
    dest = dest.slice(0, -destExt.length);
  }
  return src === dest;
};

export const getFileExtname = (url: string): string => {
  const fileNameAndParamArr = normalizePath(url).split('/');
  const fileNameAndParam = fileNameAndParamArr[fileNameAndParamArr.length - 1];
  const fileName = fileNameAndParam.split('?')[0];
  return extname(fileName);
};

export const toOutputFilePathWithoutRuntime = (
  filename: string,
  type: 'asset' | 'public',
  hostId: string,
  hostType: 'js' | 'css' | 'html',
  config: ResolvedConfig,
  toRelative: (filename: string, hostId: string) => string
): string => {
  const { renderBuiltUrl } = config.experimental;
  let relative = config.base === '' || config.base === './';
  if (renderBuiltUrl) {
    const result = renderBuiltUrl(filename, {
      hostId,
      hostType,
      type,
      ssr: !!config.build.ssr
    });
    if (typeof result === 'object') {
      if (result.runtime) {
        throw new Error(
          `{ runtime: "${result.runtime}" } is not supported for assets in ${hostType} files: ${filename}`
        );
      }
      if (typeof result.relative === 'boolean') {
        relative = result.relative;
      }
    } else if (result) {
      return result;
    }
  }
  if (relative && !config.build.ssr) {
    return toRelative(filename, hostId);
  } else {
    return joinUrlSegments(config.base, filename);
  }
};
