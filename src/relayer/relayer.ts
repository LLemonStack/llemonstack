import { RelayerBase } from './base.ts'
import { Logger, LogLevel } from './logger.ts'
import { InterfaceRelayer } from './ui/interface.ts'
export type { LogLevel }

/**
 * Relayer handles relaying log and user interaction messages.
 */
export class Relayer extends RelayerBase {
  private static initialized: boolean = false

  protected _interface: InterfaceRelayer | null = null

  /**
   * Initialize the Relayer system
   *
   * This needs to be called once before getInstance()
   */
  public static async initialize(
    { logLevel = this.logLevel, reset = false, verbose = false }: {
      logLevel?: LogLevel
      reset?: boolean
      verbose?: boolean
    } = {},
  ): Promise<boolean> {
    if (this.initialized && !reset) {
      return true
    }

    Logger.appName = this.rootAppName

    this.logLevel = logLevel
    this.verbose = verbose

    // Create and configure Logtape logger
    await Logger.initLogger(
      Relayer, // Pass the Relayer class to get the sink and filter
      InterfaceRelayer, // Pass the InterfaceRelayer class to get the sink and filter
      {
        appName: this.rootAppName,
        defaultLevel: logLevel as LogLevel,
        reset,
      },
    )

    this.initialized = true

    return true
  }

  // Get the interface instance
  public get show() {
    if (!this._interface) {
      this._interface = new InterfaceRelayer({
        name: 'ui',
        context: this._context,
        defaultLevel: this._logLevel,
      })
      InterfaceRelayer.verbose = this.verbose
    }
    return this._interface
  }
}
