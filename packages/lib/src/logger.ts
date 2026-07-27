/**
 * Structured debug logging for the federation plugin.
 *
 * Uses the `debug` npm package under the hood.  Enable at runtime with
 * the `DEBUG` environment variable:
 *
 * ```sh
 * DEBUG=federation:*            # all plugin logs
 * DEBUG=federation:*:info       # info, warn, and error logs
 * DEBUG=federation:expose:warn  # expose warn and error logs
 * ```
 */

import debug from 'debug';

import { NAMESPACE_ROOT } from './constants';

const LOG_LEVELS = ['trace', 'debug', 'log', 'info', 'warn', 'error'] as const;

type LogLevel = (typeof LOG_LEVELS)[number];

export type Logger = Record<LogLevel, debug.Debugger>;

const LOG_LEVEL_CONSOLE_MAP: Record<LogLevel, (...args: unknown[]) => void> = {
  trace: console.debug,
  debug: console.debug,
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error
};

const isLevelEnabled = (namespaces: string[], level: LogLevel): boolean => {
  const levelIndex = LOG_LEVELS.indexOf(level);

  return LOG_LEVELS.slice(0, levelIndex + 1).some((minimumLevel) =>
    debug.enabled([NAMESPACE_ROOT, ...namespaces, minimumLevel].join(':'))
  );
};

/**
 * Create a scoped logger with levelled output.
 *
 * Each log level gets its own `debug` namespace. A level suffix acts as
 * a minimum severity, so `DEBUG=federation:expose:warn` enables warn and error.
 *
 * @example
 * ```ts
 * const logger = createLogger('expose');
 * logger.debug('Pre-bundling shared modules:', names);
 * logger.warn('Missing pre-bundle for', name);
 * ```
 */
export const createLogger = (...namespaces: string[]): Logger => {
  return LOG_LEVELS.reduce((logger, level) => {
    const namespace = [NAMESPACE_ROOT, ...namespaces, level].join(':');
    const instance = debug(namespace);

    instance.log = LOG_LEVEL_CONSOLE_MAP[level].bind(console);
    instance.enabled = isLevelEnabled(namespaces, level);

    logger[level] = instance;
    return logger;
  }, {} as Logger);
};
