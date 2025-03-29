/**
 * Stop and restart the services
 */
import { Config } from './lib/core/config/config.ts'
import { showError } from './lib/logger.ts'
import { start } from './start.ts' // Adjust the path as necessary
import { stop } from './stop.ts' // Adjust the path as necessary

export async function restart(
  config: Config,
  { service, skipOutput }: { service?: string; skipOutput?: boolean } = {},
): Promise<void> {
  try {
    await stop(config, { all: true, service }) // Stop all services
    await start(config, { service, skipOutput }) // Restart services
  } catch (error) {
    showError(error)
    Deno.exit(1)
  }
}
