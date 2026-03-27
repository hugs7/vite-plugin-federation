/**
 * Structured debug logging for the federation plugin.
 *
 * Uses the `debug` npm package under the hood.  Enable at runtime with
 * the `DEBUG` environment variable:
 *
 * ```sh
 * DEBUG=federation:*            # all federation logs
 * DEBUG=federation:*:debug      # only debug level
 * DEBUG=federation:expose:*     # only expose-development logs
 * ```
 */

import debug from 'debug'

const LOG_LEVELS = ['trace', 'debug', 'log', 'info', 'warn', 'error'] as const

type LogLevel = (typeof LOG_LEVELS)[number]

export type Logger = Record<LogLevel, debug.Debugger>

const LOG_LEVEL_CONSOLE_MAP: Record<LogLevel, (...args: unknown[]) => void> = {
  trace: console.debug,
  debug: console.debug,
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = Object.fromEntries(
  LOG_LEVELS.map((level, index) => [level, index])
) as Record<LogLevel, number>

const DEFAULT_LOG_LEVEL: LogLevel = 'info'

const NAMESPACE_ROOT = 'federation'

/**
 * Create a scoped logger with levelled output.
 *
 * Each log level gets its own `debug` namespace so consumers can
 * filter granularly via `DEBUG=federation:expose:warn`.
 *
 * @example
 * ```ts
 * const logger = createLogger('expose');
 * logger.debug('Pre-bundling shared modules:', names);
 * logger.warn('Missing pre-bundle for', name);
 * ```
 */
export const createLogger = (...namespaces: string[]): Logger => {
  const minPriority = LOG_LEVEL_PRIORITY[DEFAULT_LOG_LEVEL]

  return LOG_LEVELS.reduce((logger, level) => {
    const namespace = [NAMESPACE_ROOT, ...namespaces, level].join(':')
    const instance = debug(namespace)

    const logEnabled = LOG_LEVEL_PRIORITY[level] >= minPriority
    if (logEnabled) {
      instance.log = LOG_LEVEL_CONSOLE_MAP[level].bind(console)
    }

    instance.enabled = logEnabled

    logger[level] = instance
    return logger
  }, {} as Logger)
}
