import type { ServerResponse } from 'node:http';

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
