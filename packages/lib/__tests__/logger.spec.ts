import debug from 'debug';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger';

const originalDebugNamespaces = process.env.DEBUG;

const getEnabledLevels = (namespace = 'expose') =>
  Object.entries(createLogger(namespace))
    .filter(([, logger]) => logger.enabled)
    .map(([level]) => level);

afterEach(() => {
  debug.enable(originalDebugNamespaces ?? '');
});

describe('createLogger', () => {
  it('disables all levels without a DEBUG namespace', () => {
    debug.disable();

    expect(getEnabledLevels()).toEqual([]);
  });

  it('enables all levels with the plugin wildcard', () => {
    debug.enable('federation:*');

    expect(getEnabledLevels()).toEqual([
      'trace',
      'debug',
      'log',
      'info',
      'warn',
      'error'
    ]);
  });

  it('treats a level suffix as the minimum severity', () => {
    debug.enable('federation:*:info');

    expect(getEnabledLevels()).toEqual(['info', 'warn', 'error']);
  });

  it('applies level thresholds only to the selected scope', () => {
    debug.enable('federation:expose:warn');

    expect(getEnabledLevels('expose')).toEqual(['warn', 'error']);
    expect(getEnabledLevels('remote')).toEqual([]);
  });
});
