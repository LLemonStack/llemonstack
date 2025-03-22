import { DEBUG, loadEnv, showDebug, showError, showInfo } from '../start.ts'
import { dockerEnv } from './docker.ts' // TODO: remove this
import type { CommandOutput, RunCommandOptions } from './types.d.ts'

export class RunCommandOutput {
  private _output: CommandOutput
  constructor(output: CommandOutput) {
    this._output = output
  }
  get stdout(): string {
    return this._output.stdout
  }
  get stderr(): string {
    return this._output.stderr
  }
  get code(): number {
    return this._output.code
  }
  get success(): boolean {
    return this._output.success
  }
  get signal(): Deno.Signal | null | undefined {
    return this._output.signal
  }
  toString(): string {
    return this._output.stdout
  }
  toList(): string[] {
    return this._output.stdout.split('\n').filter(Boolean).map((line) => line.trim())
  }
  toJsonList(): Array<Record<string, unknown>> {
    const output = this._output.stdout.trim()
    return !output ? [] : output.split('\n').map((output) => JSON.parse(output)).filter(
      Boolean,
    )
  }
}

// Custom error class for runCommand
export class CommandError extends Error {
  code: number
  stdout: string
  stderr: string
  cmd: string // the command that was run

  constructor(
    message: string,
    {
      code,
      stdout,
      stderr,
      cmd,
    }: {
      code: number
      stdout: string
      stderr: string
      cmd: string
    },
  ) {
    super(message)
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
    this.cmd = cmd
  }
  override toString(): string {
    let str = this.message
    str += this.cmd ? `\nCmd: '${this.cmd}'` : ''
    str += this.stderr ? `\nError:${this.stderr}` : ''
    return str
  }
}

/**
 * Run a command and return the output
 * @param cmd - The command to run
 * @param args - The arguments to pass to the command
 * @param silent - If true, don't show any output
 * @param captureOutput - If true, capture the output
 * @param env - The environment variables to set
 * @param autoLoadEnv - If true, load env from .env file
 * @param debug - If true, show debug output, defaults to global debug setting
 * @returns {RunCommandOutput} The output of the command
 */
export async function runCommand(
  cmd: string,
  {
    args,
    silent = false,
    captureOutput = false,
    env = {},
    autoLoadEnv = true, // If true, load env from .env file
    debug = DEBUG ?? false, // TODO: replace with config.debug
  }: RunCommandOptions = {},
): Promise<RunCommandOutput> {
  // If silent is true, pipe output so streamStdout receives output below
  const stdout = captureOutput ? 'piped' : (silent || debug) ? 'piped' : 'inherit'
  const stderr = stdout

  // Auto load env from .env file
  // For security, don't use all Deno.env values, only use .env file values
  const envVars = !autoLoadEnv ? {} : await loadEnv({ reload: false, silent: true })

  let cmdCmd = cmd
  let cmdArgs = (args?.filter(Boolean) || []) as string[]
  const cmdEnv: Record<string, string> = {
    // TODO: remove this after finishing migration to docker.ts lib
    ...(cmd.includes('docker') ? dockerEnv() : {}), // Add docker specific env vars
    ...envVars,
    ...Object.fromEntries( // Convert all env values to strings
      Object.entries(env).map(([k, v]) => [k, String(v)]),
    ),
  }

  // If args not provided, split out the command and args
  if (!args) {
    const parts = cmd.match(/[^\s"']+|"([^"]*)"|'([^']*)'/g) || []
    const commandParts = parts.map((part) => part.replace(/^["']|["']$/g, ''))
    cmdCmd = commandParts[0]
    cmdArgs = commandParts.slice(1)
  }

  // Remove any surrounding quotes from arguments
  cmdArgs = cmdArgs.map((arg) => {
    if (
      (arg.startsWith('"') && arg.endsWith('"')) ||
      (arg.startsWith("'") && arg.endsWith("'"))
    ) {
      return arg.slice(1, -1)
    }
    return arg
  })

  // Save cmd for debugging & error messages
  const fullCmd = [
    cmdCmd,
    cmdArgs.join(' '),
  ].filter(Boolean).join(' ')

  if (debug) {
    // Show full command with escaped quotes
    const bashFullCmd = [
      Object.entries(env)
        .map(([key, value]) => {
          // Escape quotes
          const escapedValue = String(value).replaceAll('"', '\\"').replaceAll("'", "\\'")
          return `${key}="${escapedValue}"`
        })
        .join(' '),
      cmdCmd,
      cmdArgs.map((arg) => {
        const escapedArg = String(arg).replaceAll('"', '\\"').replaceAll("'", "\\'")
        return `"${escapedArg}"`
      }).join(' '),
    ].filter(Boolean).join(' ')
    showDebug(
      `Running command: ${fullCmd}\n` +
        `  > ${bashFullCmd}`,
    )
    // Extra debugging info, comment out when not needed
    // showDebug(`Deno.Command: ${cmdCmd}`)
    // showDebug('[args]:', cmdArgs)
    // showDebug('[env]:', cmdEnv)
  }

  const command = new Deno.Command(cmdCmd, {
    args: (cmdArgs.length && cmdArgs?.map((arg) => arg.toString())) || undefined,
    stdout,
    stderr,
    env: cmdEnv,
  })

  // Spawn the command
  let process: Deno.ChildProcess | null = null
  try {
    process = command.spawn()
  } catch (error) {
    const message = `Unable to run '${cmdCmd}'`
    if (debug) {
      showError(message, error)
      if (error instanceof Deno.errors.NotFound) {
        showInfo(
          `  ${cmdCmd} is either not installed or not in your PATH.\n  Please install it and try again.`,
        )
      }
    }
    throw new CommandError(message, {
      code: 1,
      cmd: fullCmd,
      stdout: '',
      stderr: String(error),
    })
  }

  // Initialize collectors for captured output if needed
  let stdoutCollector = ''
  let stderrCollector = ''
  const decoder = new TextDecoder()

  // Set up streaming for stdout
  const streamStdout = async () => {
    for await (const chunk of process.stdout) {
      const text = decoder.decode(chunk)
      stdoutCollector += text
      if (!silent) {
        // Stream to console in real-time
        Deno.stdout.writeSync(chunk)
      }
    }
  }

  // Set up streaming for stderr
  const streamStderr = async () => {
    for await (const chunk of process.stderr) {
      const text = decoder.decode(chunk)
      stderrCollector += text
      if (!silent) {
        // Stream to console in real-time
        Deno.stderr.writeSync(chunk)
      }
    }
  }

  // // Handle both streams and wait for process to complete
  const [status] = await Promise.all([
    process.status,
    stdout === 'piped' ? streamStdout() : Promise.resolve(),
    stderr === 'piped' ? streamStderr() : Promise.resolve(),
  ])

  if (debug) {
    showDebug(`Command ${status.success ? 'completed' : 'failed'}:\n  ${fullCmd}`, status)
    if (!status.success) {
      stdout === 'piped' && showDebug(`STDOUT: ${stdoutCollector}`)
      stderr === 'piped' && showDebug(`STDERR: ${stderrCollector}`)
    }
  } else if (!silent) {
    stdoutCollector && console.log(stdoutCollector)
    stderrCollector && console.error(stderrCollector)
  }

  if (!status.success) {
    throw new CommandError(`Command failed`, {
      code: status.code,
      cmd: fullCmd,
      stdout: '',
      stderr: '',
    })
  }

  return new RunCommandOutput({
    stdout: stdoutCollector,
    stderr: stderrCollector,
    code: status.code,
    success: status.success,
    signal: status.signal,
  })
}
