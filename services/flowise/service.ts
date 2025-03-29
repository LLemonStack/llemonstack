import { Config } from '../../scripts/lib/core/config/config.ts'
import { Service } from '../../scripts/lib/core/services/service.ts'
import { getFlowiseApiKey } from '../../scripts/lib/flowise.ts'

export class FlowiseService extends Service {
  override async loadEnv(
    envVars: Record<string, string>,
    { config }: { config: Config },
  ) {
    const key = await getFlowiseApiKey(config)
    envVars.FLOWISE_API_KEY = key?.apiKey || ''
    envVars.FLOWISE_API_KEY_NAME = key?.keyName || ''
    return envVars
  }
}

export default FlowiseService
