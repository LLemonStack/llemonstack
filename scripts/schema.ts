import { Config } from '@/core/config/config.ts'
import { createServiceSchema, removeServiceSchema } from '@/lib/postgres.ts'
import { confirm, showAction, showError, showInfo, showWarning } from '@/relayer/ui/show.ts'
import { ServiceType } from '@/types'
import { startService } from './start.ts'

async function isSupabaseStarted(config: Config) {
  const supabase = config.getServiceByName('supabase')
  return await supabase?.isRunning() || false
}

export async function schema(config: Config, action: string, service: string) {
  if (action !== 'create' && action !== 'remove') {
    showError('First argument must be either "create" or "remove"')
    Deno.exit(1)
  }
  if (!service) {
    showError('Service name is required')
    Deno.exit(1)
  }

  // Make sure it's a valid service
  if (!config.getServiceByName(service)) {
    showWarning(`Unknown service name: ${service}`)
    if (!confirm(`Continue anyway?`)) {
      Deno.exit(1)
    }
  }

  const password = Deno.env.get('POSTGRES_PASSWORD') ?? ''

  // Track whether we started supabase and need to stop it at the end
  let supabaseStarted = false
  let supabaseService: ServiceType | null = null

  if (!await isSupabaseStarted(config)) {
    if (confirm(`Supabase is not running. Shall we start it?`, true)) {
      supabaseService = await startService(config, 'supabase')
      supabaseStarted = true
    }
    // Wait a few seconds for supabase to fully initialize
    showAction('Waiting for Supabase to initialize...')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    if (!await isSupabaseStarted(config)) {
      showError('Supabase failed to start, unable to create schema')
      Deno.exit(1)
    }
  }

  if (action === 'create') {
    showAction(`Creating schema for ${service}...`)
    const credentials = await createServiceSchema(service, {
      password,
    })
    showInfo(`Schema created for ${service}`)
    showInfo(`Username: ${credentials.username}`)
    showInfo(`Password: ${credentials.password}`)
    showInfo(`Database: ${credentials.database}`)
    showInfo(`Schema: ${credentials.schema}`)
  } else if (action === 'remove') {
    showAction(`Removing schema for ${service}...`)
    const { schema, username } = await removeServiceSchema(service, {
      password,
    })
    showInfo(`Schema ${schema} removed for ${service}`)
    showInfo(`Username: ${username}`)
  }

  if (supabaseStarted && supabaseService) {
    if (confirm(`Supabase was started for this operation. Shall we stop it?`)) {
      await supabaseService.stop()
    }
  }
}
