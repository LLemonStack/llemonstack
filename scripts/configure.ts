/**
 * Configure the services
 */
import { Config } from '@/core/config/config.ts'
import { ServicesMapType, ServiceType } from '@/types'
import { colors } from '@cliffy/ansi/colors'
import { Select } from '@cliffy/prompt'

// ⚫  🟢 ⚪  🟡  🔴  🔵
const STATUS_EMOJIS = {
  enabled: '🟢',
  disabled: '⚪',
  disabledRequired: '🔴', // Required by other services and disabled
  auto: '🔵', // Auto enabled and not required by other services
  autoRequired: '🟡', // Auto enabled and required by other services
}

function getServiceOption(
  service: ServiceType,
  config: Config,
  // dependencies: Record<string, string[]>,
): { name: string; value: string; disabled?: boolean } | null {
  if (!service) {
    return null
  }

  // Get all dependents of the service
  const dependents = config.getServiceDependents(service)

  // Check if the service has any enabled dependents
  const required = dependents.getEnabled()?.size > 0

  // Check if the service is enabled
  const isEnabled = service.isEnabled()

  // Check if the service is auto enabled
  const isAutoEnabled = config.isServiceAutoEnabled(service)

  const statusEmoji = isAutoEnabled
    ? required ? STATUS_EMOJIS.autoRequired : STATUS_EMOJIS.auto
    : isEnabled
    ? STATUS_EMOJIS.enabled
    : required
    ? STATUS_EMOJIS.disabledRequired
    : STATUS_EMOJIS.disabled

  return {
    name: `${statusEmoji} ${colors.bold.green(service.name)} - ${service.description} ${
      dependents.size > 0
        ? `=> required by ${
          dependents
            .map((s) => s?.name || '')
            .join(', ')
        }`
        : ''
    }`,
    value: service.servicesMapKey,
    // disabled: required,
  }
}

export async function configure(
  config: Config, // An initialized config instance
  options: { all: boolean } = { all: false },
): Promise<void> {
  const show = config.relayer.show

  show.action(`Configuring services for ${config.projectName}...`)

  // Display a key for the status emojis to help users understand the symbols
  show.info('Status Key:')
  show.info(`  ${STATUS_EMOJIS.enabled} = Enabled`)
  show.info(`  ${STATUS_EMOJIS.disabled} = Disabled`)
  show.info(`  ${STATUS_EMOJIS.auto} = Auto-enabled and not required by other services`)
  show.info(`  ${STATUS_EMOJIS.autoRequired} = Auto-enabled and required by other services`)
  show.info(`  ${STATUS_EMOJIS.disabledRequired} = Disabled but required by enabled services`)
  show.info('')

  // Convert groups Map to array for iteration
  // Reverse order to start with group with fewest dependencies (apps)
  const serviceGroups = options.all
    ? [['All Services', config.getAllServices()]]
    : Array.from(config.getServicesGroups().entries()).reverse()

  // Prompt user for each group, starting with apps
  for (let groupNum = 0; groupNum < serviceGroups.length; groupNum++) {
    const [groupName, groupServices] = serviceGroups[groupNum] as [string, ServicesMapType]

    // Skip if group has no services
    if (groupServices.size === 0) continue

    // Prompt user for each service in group until they continue to next group
    while (true) {
      const getServiceOptions = () =>
        Array.from(groupServices.values())
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((service) => getServiceOption(service, config))
          .filter(Boolean) as {
            name: string
            value: string
            disabled?: boolean
          }[]

      const serviceOptions = getServiceOptions()

      const navigationOptions = []
      if (groupNum < serviceGroups.length - 1) {
        navigationOptions.push({
          name: 'Continue to next group',
          value: 'continue',
        })
      }
      if (groupNum === serviceGroups.length - 1) {
        navigationOptions.push({
          name: 'Finish configuration',
          value: 'continue',
        })
      }
      if (groupNum > 0) {
        navigationOptions.push({
          name: 'Back to previous group',
          value: 'back',
        })
      }

      // Prompt user for service selection
      const selection = await Select.prompt({
        message: `Select ${groupName} service to configure:`,
        maxRows: options.all ? 40 : 10,
        options: [...serviceOptions, ...navigationOptions],
      })

      if (selection === 'continue') {
        break // Breaks out of the while loop
      }

      if (selection === 'back') {
        groupNum = groupNum - 2 // Move back a group, for loop increments by 1
        break // Breaks out of the while loop
      }

      // User selected a service to configure

      // Get the service
      const service = config.getServiceByName(selection)
      if (!service) continue

      // Prompt user for service action
      const action = await Select.prompt({
        message: `Configure ${service.name}:`,
        options: [
          { name: 'Enable', value: 'enable' },
          { name: 'Disable', value: 'disable' },
          { name: 'Auto (based on dependencies)', value: 'auto' },
          { name: 'Back to service list', value: 'back' },
        ],
      })

      if (action === 'back') {
        continue
      }

      const enabled = action === 'enable' ? true : action === 'disable' ? false : 'auto'

      // Update service state with config
      // This updates the config._autoEnabledServices map
      config.updateServiceEnabledState(service, enabled)

      // Save the state changes before configuring, save config.json file
      const saveResult = await config.save()
      if (!saveResult.success) {
        show.warn(`Failed to save state changes: ${saveResult.error?.message}`)
        continue
      }

      // If service has it's own configure method, call it
      await service.configure({ silent: false, config, show })
    }
  }

  // Save the configuration
  const saveResult = await config.save()
  if (!saveResult.success) {
    show.warn(`Failed to save configuration: ${saveResult.error?.message}`)
  } else {
    show.info('Configuration saved successfully.')
    show.userAction('Start services with `llmn start`')
    // Show the list of enabled services
    const enabledServices = config.getEnabledServices().toArray().sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    if (enabledServices.length > 0) {
      show.info('The following services will be started:')
      for (const service of enabledServices.values()) {
        show.info(`  - ${service.name}`)
      }
    } else {
      show.info('No services are currently enabled.')
    }
  }
}
