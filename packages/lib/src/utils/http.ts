import type { ServerResponse } from 'node:http';

/**
 * Builds localhost origin given a port number.
 *
 * @param port - Port number.
 * @returns Localhost origin.
 */
export const buildLocalhostOrigin = (port: number) =>
  `http://localhost:${port}`;

/**
 * Send a JavaScript response.
 *
 * @param res - Server response.
 * @param code - Javascript code as string to send to client.
 */
export const sendJs = (res: ServerResponse, code: string): void => {
  res.setHeader('Content-Type', 'application/javascript');
  res.end(code);
};
