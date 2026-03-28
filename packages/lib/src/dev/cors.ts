// ---------------------------------------------------------------------------
// CORS middleware
// ---------------------------------------------------------------------------

import { IncomingMessage, ServerResponse } from 'http';

/**
 * dd CORS headers so the HOST browser can load files
 * from this remote.
 */
export const corsMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
): void => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  next();
};
