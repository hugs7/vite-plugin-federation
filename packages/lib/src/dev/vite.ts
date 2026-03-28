import type { ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';

import { sendJs } from '../utils';
import { patchViteClientCode } from './hmr';

/**
 * Convert an absolute filesystem path to a URL that
 * Vite's dev server can serve. If the path is inside
 * the project root, return a root-relative path;
 * otherwise use /@fs/ prefix.
 */
export const toViteUrl = (filePath: string, root: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalized.startsWith(normalizedRoot + '/')) {
    return normalized.slice(normalizedRoot.length);
  }

  return `/@fs${normalized}`;
};

/**
 * Patch @vite/client so HMR module re-imports use the absolute remote
 * origin instead of the HOST page origin.
 */
export const handleViteClient = async (
  server: ViteDevServer,
  res: ServerResponse,
  next: () => void
): Promise<boolean> => {
  try {
    const clientResult = await server.transformRequest('/@vite/client');
    if (!clientResult) {
      next();
      return true;
    }
    const port = server.config.server.port ?? 5173;
    const host = typeof server.config.server.host === 'string'
      ? server.config.server.host
      : 'localhost';
    const protocol = server.config.server.https ? 'https' : 'http';
    const remoteOrigin = `${protocol}://${host}:${port}`;
    const code = patchViteClientCode(clientResult.code, remoteOrigin);
    sendJs(res, code);
  } catch (error) {
    next();
  }
  return true;
};
