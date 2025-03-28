/**
 * Stop and restart the services
 */
import { showError } from './lib/logger.ts'
import { start } from './start.ts' // Adjust the path as necessary
import { stop } from './stop.ts' // Adjust the path as necessary

export async function restart(
  projectName: string,
  { service, skipOutput }: { service?: string; skipOutput?: boolean } = {},
): Promise<void> {
  try {
    await stop(projectName, { all: true, service }) // Stop all services
    await start(projectName, { service, skipOutput }) // Restart services
  } catch (error) {
    showError(error)
    Deno.exit(1)
  }
}
