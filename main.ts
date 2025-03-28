#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run --allow-write --allow-net

/**
 * LLemonStack command line tool
 *
 * CLI interface for managing the LLemonStack local AI agent stack
 */

import { Command, EnumType } from '@cliffy/command'
import { CompletionsCommand } from '@cliffy/command/completions'
import { Config } from './scripts/lib/config.ts'
import {
  showAction,
  showDebug,
  showError,
  showInfo,
  showLogMessages,
} from './scripts/lib/logger.ts'
import { isTruthy } from './scripts/lib/utils.ts'
/**
 * Initialize the LLemonStack config
 *
 * This function must be called first before loading other scripts in the below commands.
 * @param configFile - The path to the config file
 * @param debug - Whether to enable debug mode
 * @returns The LLemonStack config
 */
async function initConfig({ config: configFile, debug }: { config: string; debug?: boolean }) {
  debug = isTruthy(debug)

  const config = Config.getInstance()
  const result = await config.initialize(configFile, { debug })

  if (debug) {
    showDebug('DEBUG enabled in CLI option')
  }

  if (!result.success && result.error instanceof Deno.errors.NotFound) {
    // Show a friendly message if the config file is not found
    showInfo(`Config file not found: ${config.configFile}`)
    showAction('Please run `llmn init` to create a new project')
    Deno.exit(1)
  }

  // Show log messages
  showLogMessages(result.messages, { debug: config.DEBUG })

  if (!result.success) {
    showError('Error initializing config', result.error)
    Deno.exit(1)
  }

  return config
}

// Keep this for later use, log level could be used to auto configure services log levels
// const logLevelType = new EnumType(['debug', 'info', 'warn', 'error'])
// .globalType('log-level', logLevelType)
// .globalOption('-l, --log-level <level:log-level>', 'Set log level.', {
//   default: 'info',
// })

// Base command options
const main = new Command()
  .name('llmn')
  .version(Config.llemonstackVersion)
  .description('Command line for LLemonStack local AI agent stack')
  .versionOption('-v, --version', 'Get LLemonStack app version')
  .globalEnv('DEBUG=<boolean>', 'Enable debugging output.')
  .globalOption('-d, --debug', 'Enable debugging output.')
  .globalOption(
    '-c --config <configFile:string>',
    'Path to a project config file.',
    {
      default: Config.defaultConfigFilePath,
    },
  )
  .action(function (_options) {
    // Show help as the default action
    this.showHelp()
  })

// Initialize the LLemonStack environment
main
  .command('config')
  .description('Configure the stack services')
  .action(async (options) => {
    const config = await initConfig(options)
    const { configure } = await import('./scripts/configure.ts')
    await configure(config.projectName)
  })

// Initialize the LLemonStack environment
main
  .command('init')
  .description('Initialize the LLemonStack environment')
  .action(async (options) => {
    const config = await initConfig(options)
    const { init } = await import('./scripts/init.ts')
    await init(config.projectName)
  })

// Start the LLemonStack services
main
  .command('start')
  .description('Start the LLemonStack services')
  .arguments('[service:string]')
  .option('-n, --nokeys', 'Hide credentials', { default: false })
  .action(async (options, service?: string) => {
    const config = await initConfig(options)
    const { start } = await import('./scripts/start.ts')
    await start(config.projectName, {
      service,
      skipOutput: !!service,
      hideCredentials: options.nokeys,
    })
  })

// Stop the LLemonStack services
main
  .command('stop')
  .description('Stop the LLemonStack services')
  .option('--all', 'Stop all services', { default: true })
  .arguments('[service:string]')
  .action(async (options, service?: string) => {
    const config = await initConfig(options)
    const { stop } = await import('./scripts/stop.ts')
    await stop(config.projectName, { all: options.all, service })
  })

// Restart the LLemonStack services
main
  .command('restart')
  .description('Restart the LLemonStack services')
  .arguments('[service:string]')
  .action(async (options, service?: string) => {
    const config = await initConfig(options)
    const { restart } = await import('./scripts/restart.ts')
    await restart(config.projectName, { service, skipOutput: !!service })
  })

// Reset the LLemonStack environment
main
  .command('reset')
  .description('Reset the LLemonStack environment')
  .action(async (options) => {
    const config = await initConfig(options)
    const { reset } = await import('./scripts/reset.ts')
    await reset(config.projectName)
  })

// Update the LLemonStack services
main
  .command('update')
  .description('Update the LLemonStack environment')
  .action(async (options) => {
    const config = await initConfig(options)
    const { update } = await import('./scripts/update.ts')
    await update(config.projectName)
  })

// Show all versions of all services in the stack
main
  .command('versions')
  .description('Show all versions of all services in the stack')
  .action(async (options) => {
    const config = await initConfig(options)
    const { versions } = await import('./scripts/versions.ts')
    await versions(config.projectName)
  })

// Import data into services that support it
const importServices = new EnumType(['n8n', 'flowise'])
main
  .command('import')
  .description('Import data from ./import dir into supported services: n8n, flowise')
  .type('service', importServices)
  .arguments('[...service:service[]]')
  .option('--skip-start', 'Skip starting services after import', { default: false })
  .option('--skip-prompt', 'Skip confirmation prompts', { default: false })
  .option('--archive', 'Archive after import', { default: true })
  .action(async (options, ...services) => {
    const config = await initConfig(options)
    if (!services || services.length === 0) {
      services = importServices.values().map((svc) => [svc])
      showInfo(`Importing all supported services: ${services.join(', ')}`)
    }
    if (!options.skipStart) {
      showAction('Starting the stack to import data...')
      const { start } = await import('./scripts/start.ts')
      await start(config.projectName, { skipOutput: true })
    }
    for (const svc of services) {
      const service = svc[0]
      showAction(`Importing ${service} data...`)
      const { runImport } = await import(`./scripts/${service}_import.ts`)
      await runImport(config.projectName, {
        skipPrompt: options.skipPrompt,
        archive: options.archive,
      })
    }
  })

// Export data from services that support it
const exportServices = new EnumType(['n8n'])
main
  .command('export')
  .description('Export data to ./shared dir for supported services: n8n')
  .type('service', exportServices)
  .arguments('[...service:service[]]')
  .action(async (options, ...services) => {
    const config = await initConfig(options)
    if (!services || services.length === 0) {
      services = exportServices.values().map((svc) => [svc])
      showInfo(`Exporting all supported services: ${services.join(', ')}`)
    }
    for (const svc of services) {
      const service = svc[0]
      const { runExport } = await import(`./scripts/${service}_export.ts`)
      await runExport(config.projectName)
    }
  })

// Schema management commands
main.command('schema')
  .description('Postgres schema management commands')
  .type('actions', new EnumType(['create', 'remove']))
  .arguments('<action:actions> <service:string>')
  .example(
    'Create schema:',
    'llmn schema create service_name',
  )
  .example(
    'Remove schema:',
    'llmn schema remove service_name',
  )
  .action(async (options, action: string, service: string) => {
    const config = await initConfig(options)
    const { schema } = await import('./scripts/schema.ts')
    await schema(config.projectName, action, service)
  })

// LiteLLM management commands
main.command('litellm')
  .description('LiteLLM management commands')
  .type('actions', new EnumType(['seed']))
  .arguments('<action:actions>')
  .example(
    'Seed LiteLLM models:',
    'llmn litellm seed',
  )
  .action(async (options, action: string) => {
    const _config = await initConfig(options)
    if (action === 'seed') {
      const { loadModels } = await import('./scripts/litellm.ts')
      await loadModels()
    }
  })

main
  .command('completions', new CompletionsCommand())

// Run the command
await main.parse(Deno.args)
