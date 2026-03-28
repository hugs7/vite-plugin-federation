import type { ServerResponse } from 'node:http';

export const sendJs = (res: ServerResponse, code: string): void => {
  res.setHeader('Content-Type', 'application/javascript');
  res.end(code);
};
