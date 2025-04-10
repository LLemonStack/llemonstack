import { Service } from '@/core/services/mod.ts'
import { TryCatchResult } from '@/lib/try-catch.ts'
import { IServiceActionOptions } from '@/types'
import { Select } from '@cliffy/prompt'

export class N8nService extends Service {
  /**
   * Configure the service
   * @param {boolean} [silent] - Whether to run the configuration in silent or interactive mode
   * @returns {TryCatchResult<boolean>} - The result of the configuration
   */
  override async configure(
    options: IServiceActionOptions,
  ): Promise<TryCatchResult<boolean>> {
    // If the service is disabled, skip the configuration
    if (!this.isEnabled()) {
      return super.configure(options)
    }

    let n8nProfile = 'n8n' // Default profile

    if (!options.silent) {
      const show = this._configInstance.show

      show.header('n8n Configuration Options')
      show.info('Select the n8n profile you want to use')

      n8nProfile = await Select.prompt({
        message: 'Which version of n8n do you want to use?',
        options: [
          {
            name: 'n8n with no customizations',
            value: 'n8n',
          },
          {
            name: 'n8n with custom tracing and ffmpeg support',
            value: 'n8n-custom',
          },
        ],
      })
    }

    this.setProfiles([n8nProfile])

    return super.configure(options)
  }
}

export default N8nService
