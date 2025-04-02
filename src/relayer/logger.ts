// File: relayer.ts
import {
  compareLogLevel,
  configure,
  getAnsiColorFormatter,
  getConfig,
  getConsoleSink,
  getLevelFilter,
  getLogger,
  Logger as LogtapeLogger,
  LogLevel,
  LogRecord,
  Sink,
} from '@logtape/logtape'
import { AsyncLocalStorage } from 'node:async_hooks'
import { InterfaceRelayer } from './ui/interface.ts'

export { compareLogLevel, getConfig, getLevelFilter }
export type { LogLevel, LogRecord, LogtapeLogger, Sink }

/**
 * Config wrapper to get the configured Logtape logger instance
 */
export class Logger {
  private static initialized = false
  private static rootLogger: LogtapeLogger
  private static defaultLevel: LogLevel = 'debug'
  public static appName: string = 'root'

  // AsyncLocalStorage handles implicit context propagation
  public static loggerStorage: AsyncLocalStorage<Record<string, unknown>>

  /**
   * Initialize the logger
   *
   * This needs to be called before using the logger.
   * Messages sent to loggers before initialization will not be logged.
   *
   * @param options - The options for the logger
   */
  public static async initLogger(
    appName: string,
    { defaultLevel, reset = false }: { defaultLevel?: LogLevel; reset?: boolean } = {},
  ): Promise<void> {
    if (this.initialized && !reset) {
      return
    }

    this.appName = appName || 'app'
    this.loggerStorage = new AsyncLocalStorage<Record<string, unknown>>()

    await this.configureLogger({
      defaultLevel: defaultLevel || this.defaultLevel,
      reset,
    })

    this.initialized = true

    // App logger is the default logger for LLemonStack log messages vs docker, etc.
    this.rootLogger = await this.getLogger(this.appName)
    this.rootLogger.debug('Logger initialized')
  }

  /**
   * Get a logger instance
   *
   * @param name - The name of the logger
   * @returns The logger instance
   */
  public static getLogger(
    name: string | string[],
  ): LogtapeLogger {
    if (!this.initialized) {
      console.error('[Logger] Logger not initialized')
    }

    const logger = Array.isArray(name)
      ? getLogger(name)
      : name && name !== this.appName
      ? getLogger([this.appName, name])
      : getLogger(name || this.appName)

    return logger
  }

  public static getRootLogger() {
    return this.rootLogger
  }

  /**
   * Run an async function with the provided context
   *
   * This method should be called from a Relayer instance.
   * Any logs generated in the provided function will inherit the context
   * via AsyncLocalStorage
   *
   * @param fn
   * @returns
   */
  public static async runWithContext<T>(
    context: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    return await this.loggerStorage.run(context, fn)
  }

  /**
   * Configure Logtape with AsyncLocalStorage support
   *
   * Logtape will throw an error if the configure function is called multiple times.
   * Use the LogtapeLogger class below to get the configured instance.
   *
   * @param options
   */
  private static async configureLogger(
    options: {
      defaultLevel?: LogLevel
      reset?: boolean
    } = {},
  ) {
    // Return the default logger if it's already initialized
    if (this.initialized && !options.reset) {
      this.rootLogger.debug('Logger already initialized')
      return
    }

    if (options.reset) {
      this.initialized
        ? this.rootLogger.debug('Resetting logger')
        : console.debug('Resetting logger')
    }

    // Configure the Logtape logger
    // After configuration, Logtape's getLogger will be ready to use.
    await configure({
      reset: options.reset, // This resets the logger and allow another configuration
      sinks: {
        console: getConsoleSink({
          formatter: getAnsiColorFormatter({
            timestamp: 'time',
            level: 'FULL',
          }),
        }),
        interface: InterfaceRelayer.getUISink(),
        // interface: (record) => {
        //   console.log('interface', record)
        //   // showInfo(String(record.message))
        // },
        // console: getConsoleSink({
        //   formatter: getAnsiColorFormatter({
        //     timestamp: 'date-time-tz',
        //     timestampColor: 'black',
        //     timestampStyle: 'bold',
        //     level: 'ABBR',
        //     levelStyle: 'bold',
        //     levelColors: {
        //       debug: 'blue',
        //       info: 'green',
        //       warning: 'yellow',
        //       error: 'red',
        //       fatal: 'red',
        //     },
        //     category: '.',
        //     categoryColor: 'red',
        //     categoryStyle: 'bold',
        //     value: Deno.inspect, // Function to use to format values
        //     format: (values) => {
        //       // values.level  values.message  values.record  values.timestamp
        //       console.log('values', values)
        //       return values.category + ' ' + values.message
        //     },
        //   }),
        // }),
      },
      filters: {},
      loggers: [
        {
          // This routes ui messages to the interface relayer
          category: ['ui'],
          lowestLevel: options.defaultLevel || this.defaultLevel,
          sinks: ['interface'],
        },
        {
          // This will log all "llmn.*" messages
          category: [this.appName],
          lowestLevel: options.defaultLevel || this.defaultLevel,
          sinks: ['console'],
        },
        {
          // Disable logtape meta info messages by setting lowestLevel to warning or above.
          // If this isn't here, Logtape will show a debug message warning to add this here.
          // Logtape will show warnings or errors if there are any issues with the other log sinks.
          category: ['logtape', 'meta'],
          lowestLevel: 'warning',
          sinks: ['console'],
        },
      ],
      // Enable implicit contexts for context propagation
      contextLocalStorage: this.loggerStorage,
    })
  }
}
