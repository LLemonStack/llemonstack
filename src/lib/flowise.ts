import { showDebug, showError } from '@/relayer/ui/show.ts'
import { Config } from '../core/config/config.ts'
import { path } from './fs.ts'

/**
 * Get the Flowise API key from the config file
 *
 * @returns The Flowise API key or empty string if not found
 */
export async function getFlowiseApiKey(
  config?: Config,
): Promise<{ apiKey: string; keyName: string } | null> {
  if (!config) {
    config = Config.getInstance()
    await config.initialize()
  }

  const configPath = path.join(
    config.volumesDir,
    'flowise',
    'config',
    'api.json',
  )
  try {
    // Read and parse the config file
    const fileContent = await Deno.readTextFile(configPath)
    const config = JSON.parse(fileContent)
    // Extract the API key
    return {
      apiKey: config[0]?.apiKey || '',
      keyName: config[0]?.keyName || '',
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      config.DEBUG && showDebug(`Flowise config file not found: ${configPath}`)
      return null
    }
    showError('Error reading Flowise API key:', error)
    return null
  }
}
