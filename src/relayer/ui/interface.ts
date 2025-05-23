import { CommandError } from '@/lib/command.ts'
import { colors } from '@cliffy/ansi/colors'
import { AppLogRecord, RelayerBase } from '../base.ts'
import { LogMessageType, Sink } from '../logger.ts'
import { RowType, showTable, Table, TableOptions } from './tables.ts'

interface UserLogRecord extends AppLogRecord {
  properties: Record<string, unknown> & {
    _meta?: AppLogRecord['properties']['_meta'] & {
      type: 'user_action' | 'action'
      emoji?: string
    }
  }
}

/**
 * Relayer for user interaction messages
 *
 * Log message flow:
 * show.debug -> logger.debug -> this.filter -> this.log -> console
 */
export class InterfaceRelayer extends RelayerBase {
  public static override getSink(): Sink {
    return this.log.bind(this) as Sink
  }

  /**
   * Console log sink for user interaction messages
   *
   * @param record The log record
   */
  public static log(record: UserLogRecord): void {
    const data = record.properties
    const meta = data._meta
    const message = record.message.join('')
    const level = record.level
    const emoji: string = meta?.emoji ? meta.emoji : ''

    if (meta?.type === 'user_action') {
      console.log(`${colors.magenta(message)}`)
    } else if (meta?.type === 'action') {
      console.log(`${colors.green(message)}`)
    } else if (level === 'fatal') {
      console.error(`‼️ ${colors.red('ERROR: unable to continue, exiting...')}`)
      showError(message, meta?.error)
      Deno.exit(1)
    } else if (level === 'error') {
      showError(message, meta?.error)
    } else if (level === 'warning') {
      console.warn(`${emoji ? `${emoji} ` : '❗ '}${colors.yellow.bold(message)}`)
    } else if (level === 'info') {
      showInfo(message)
    } else if (level === 'debug') {
      showInfo(`[DEBUG] ${message}`)
      data?._meta?.debug?.forEach((arg) => {
        showInfo(`${typeof arg === 'object' ? Deno.inspect(arg, { colors: true }) : arg}`)
      })
    }
  }

  //
  // Interaction Methods
  //
  // These methods output to UI without logging or filtering the message.
  //

  /**
   * Prompt the user to confirm an action
   * @param message - The message to display to the user
   * @returns True if the user confirms, false otherwise
   */
  public confirm(message: string, defaultAnswer: boolean = false): boolean {
    const input = prompt(`${colors.yellow(message)} ${defaultAnswer ? '[Y/n]' : '[y/N]'}`)
    return input?.toLowerCase() === 'y' || (!input && defaultAnswer)
  }

  public table(
    header: RowType | null,
    rows: RowType[],
    options: TableOptions = {},
  ): Table {
    return showTable(header, rows, options)
  }

  public header(message: string, len = 50): void {
    const padding = '-'.repeat((len - message.length - 2) / 2)
    let header = `${padding} ${message} ${padding}`
    if (header.length < len) {
      header += '-' // handle odd number of characters
    }
    console.log(`\n${colors.cyan.bold(header)}`)
  }

  public credentials(credentials: Record<string, string | null | undefined>): void {
    for (const [key, value] of Object.entries(credentials)) {
      value && showInfo(`  ${key}: ${value}`)
    }
  }

  public serviceHost(service: string, url: string): void {
    console.log(`${service}: ${colors.yellow(url)}`)
  }

  //
  // Log Methods
  //
  // These add context and route to the log method above.
  // This allows for multiple sinks or context aware filters to process
  // the user log messages.
  //

  public action(message: LogMessageType, data?: Record<string, unknown>): void {
    this.logger.info(message as string, { ...this._context, ...data, _meta: { type: 'action' } })
  }

  public userAction(message: LogMessageType, data?: Record<string, unknown>): void {
    this.logger.info(message as string, {
      ...this._context,
      ...data,
      _meta: { type: 'user_action' },
    })
  }

  //
  // Override base logger methods
  // debug, info, warn, and error are inherited from RelayerBase
  //

  /**
   * Logs and exits the process
   *
   * @param message
   * @param dataOrError
   * @param error
   */
  public override fatal(
    message: LogMessageType,
    dataOrError: Record<string, unknown> = {},
    error?: Error,
  ): void {
    super.fatal(message, dataOrError, error)
    Deno.exit(1)
  }
}

//
// Helper functions
//

function showInfo(message: string): void {
  console.log(`${colors.gray(message)}`)
}

function showError(msgOrError: string | unknown, err?: unknown): void {
  const message = (typeof msgOrError === 'string') ? msgOrError : null
  const error = err || msgOrError
  const logError = (message: string, ...args: unknown[]) => {
    if (args.length > 0 && args[0] === message) {
      args.shift()
    }
    console.error(colors.red(message), ...args)
  }
  if (error instanceof CommandError) {
    message && logError(message)
    logError(`Command failed: "${error.cmd}" \n${error.stderr}`)
  } else {
    let errorMessage: string | undefined
    if (error && typeof error === 'object') {
      errorMessage = 'message' in error
        ? error.message as string
        : 'stderr' in error
        ? error.stderr as string
        : String(error)
    } else {
      errorMessage = String(error)
    }
    if (message) {
      logError(message, errorMessage)
    } else {
      logError(errorMessage)
    }
  }
}
