#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run --allow-write
/**
 * Start docker services
 */

import { colors } from '@cliffy/ansi/colors'
import { runCommand } from './lib/command.ts'
import { getImagesFromComposeYaml } from './lib/compose.ts'
import { Config } from './lib/config/config.ts'
import { isServiceRunning, prepareDockerNetwork, runDockerComposeCommand } from './lib/docker.ts'
import { getFlowiseApiKey } from './lib/flowise.ts'
import { escapePath, fs, path } from './lib/fs.ts'
import {
  showAction,
  showCredentials,
  showDebug,
  showError,
  showHeader,
  showInfo,
  showService,
  showUserAction,
  showWarning,
} from './lib/logger.ts'
import { EnvVars, OllamaProfile, RepoService } from './lib/types.d.ts'

const config = Config.getInstance()
await config.initialize()

/*******************************************************************************
 * CONFIG
 *******************************************************************************/

// Project name for docker compose
export const DEFAULT_PROJECT_NAME = 'llemonstack'

// Enable extra debug logging
const DEBUG = config.DEBUG

// All services with a docker-compose.yaml file
// Includes services with a custom Dockerfile
// [service name, compose file, auto run]
// When auto run is true, the service is started automatically if enabled.
// When auto run is false, the service needs to be started manually.
export type ComposeService = [string, string, boolean]
export const ALL_COMPOSE_SERVICES: ComposeService[] = [
  ['supabase', path.join('supabase', 'docker-compose.yaml'), true],
  ['n8n', path.join('n8n', 'docker-compose.yaml'), true],
  ['flowise', path.join('flowise', 'docker-compose.yaml'), true],
  ['neo4j', path.join('neo4j', 'docker-compose.yaml'), true],
  ['zep', path.join('zep', 'docker-compose.yaml'), true],
  ['browser-use', path.join('browser-use', 'docker-compose.yaml'), true], // Uses a custom start function
  ['qdrant', path.join('qdrant', 'docker-compose.yaml'), true],
  ['openwebui', path.join('openwebui', 'docker-compose.yaml'), true],
  ['ollama', path.join('ollama', 'docker-compose.yaml'), false], // Uses a custom start function
  ['prometheus', path.join('prometheus', 'docker-compose.yaml'), true],
  ['redis', path.join('redis', 'docker-compose.yaml'), true],
  ['clickhouse', path.join('clickhouse', 'docker-compose.yaml'), true],
  ['minio', path.join('minio', 'docker-compose.yaml'), true],
  ['langfuse', path.join('langfuse', 'docker-compose.yaml'), true],
  ['litellm', path.join('litellm', 'docker-compose.yaml'), true],
  ['dozzle', path.join('dozzle', 'docker-compose.yaml'), true],
]

// Groups of services, dependencies first
export const SERVICE_GROUPS: [string, string[]][] = [
  ['databases', [
    'supabase',
    'redis',
    'clickhouse',
    'neo4j',
    'qdrant',
    'prometheus',
    'minio',
  ]],
  ['middleware', ['dozzle', 'langfuse', 'litellm', 'zep']],
  ['apps', ['n8n', 'flowise', 'browser-use', 'openwebui', 'ollama']],
]

// All Docker compose files: absolute paths
export const ALL_COMPOSE_FILES = ALL_COMPOSE_SERVICES.map(
  ([_service, file]) => path.join(config.servicesDir, file),
) as string[]

// Docker compose files for enabled services, includes build files
export const COMPOSE_FILES = ALL_COMPOSE_SERVICES.map(([service, file]) => {
  return isEnabled(service) ? file : null
})
  // Remove false values and duplicates
  .filter((value, index, self) => value && self.indexOf(value) === index) as string[]

// Services that require cloning a repo
const REPO_SERVICES: Record<string, RepoService> = {
  supabase: {
    url: 'https://github.com/supabase/supabase.git',
    dir: 'supabase',
    sparseDir: 'docker',
    checkFile: 'docker/docker-compose.yml',
  },
  zep: {
    url: 'https://github.com/getzep/zep.git',
    dir: 'zep',
    checkFile: 'docker-compose.ce.yaml',
  },
  'browser-use': {
    url: 'https://github.com/browser-use/web-ui.git',
    dir: 'browser-use-web-ui',
    sparse: false,
    checkFile: 'docker-compose.yml',
  },
  // 'signoz': {
  //   url: 'https://github.com/SigNoz/signoz.git',
  //   dir: 'signoz',
  //   sparseDir: 'deploy',
  //   checkFile: 'docker-compose.yml',
  // },
}

// Volumes relative to LLEMONSTACK_VOLUMES_DIR, required by docker-compose.yml files to start services.
// These directories will be created if they don't exist.
// If seed: Copy these dirs or files into volumes if they don't exist
const REQUIRED_VOLUMES = [
  { volume: 'supabase/db/data' },
  { volume: 'supabase/storage' },
  {
    volume: 'supabase/functions',
    seed: [ // Copy these dirs into functions volumes if they don't exist
      {
        source: path.join(
          config.serviceRepoPath('supabase'),
          'docker',
          'volumes',
          'functions',
          'main',
        ),
        destination: 'main', // Relative to the volume path
      },
      {
        source: path.join(
          config.serviceRepoPath('supabase'),
          'docker',
          'volumes',
          'functions',
          'hello',
        ),
        destination: 'hello',
      },
    ],
  },
  { volume: 'flowise/config' },
  { volume: 'flowise/uploads' },
  { volume: 'minio' },
]

/*******************************************************************************
 * FUNCTIONS
 *******************************************************************************/

/**
 * Check if a service is enabled in .env file
 * @param envVar - The environment variable to check
 * @returns True if the service is enabled, false otherwise
 */
export function isEnabled(envVar: string): boolean {
  const varName = `ENABLE_${envVar.toUpperCase().replace(/-/g, '_')}`
  // Handle ollama special case
  if (envVar === 'ollama') {
    return !['ollama-false', 'ollama-host'].includes(getOllamaProfile())
  }
  const value = Deno.env.get(varName)
  // If no env var is set, default to true
  if (value === undefined || value === null) {
    return true
  }
  return (value && value.trim().toLowerCase() === 'true') as boolean
}

/**
 * Reverse looks up the compose file from the service name
 * @param service
 * @returns
 */
export async function getComposeFileFromService(service: string): Promise<string | null> {
  // Iterate through all compose files to find the service
  for (const composeFile of COMPOSE_FILES) {
    const serviceImages = await getImagesFromComposeYaml(composeFile)
    const serviceImage = serviceImages.find((img) => img.service === service)
    if (serviceImage) {
      return composeFile
    }
  }
  return null
}

export async function getComposeFile(
  service: string,
): Promise<string | null> {
  let file = ALL_COMPOSE_FILES.find((file) => file.includes(service))
  if (!file) {
    // Reverse lookup the compose file from the service name
    // This parses the actual compose files for the service
    file = await getComposeFileFromService(service) || undefined
  }
  return file ? file : null
}

/**
 * Filter out files that don't exist.
 *
 * @param files - The files to filter.
 * @returns The filtered files.
 */
export function filterExistingFiles(files: string[]): string[] {
  return files.filter((file) => {
    const exists = fs.existsSync(file)
    if (!exists) {
      showInfo(`Skipping non-existent file: ${file}`)
    }
    return exists
  })
}

export async function checkPrerequisites(): Promise<void> {
  // Commands will throw an error if the prerequisite is not installed
  await runCommand('docker --version')
  await runCommand('docker compose version')
  await runCommand('git --version')
  showInfo('✔️ All prerequisites are installed')
}

/**
 * Clone a service repo into repo dir
 */
async function setupRepo(
  service: string,
  repoUrl: string,
  repoDir: string,
  {
    sparseDir,
    sparse = true,
    pull = false, // Pull latest changes from remote
    checkFile,
    silent = false,
  }: {
    sparseDir?: string | string[]
    sparse?: boolean
    pull?: boolean
    checkFile?: string
    silent?: boolean
  } = {},
): Promise<void> {
  const dir = config.serviceRepoPath(service, repoDir)
  console.log('repo dir', dir)
  if (sparseDir) {
    sparse = true
  }
  if (DEBUG) {
    silent = false
  }

  DEBUG && showDebug(`Cloning ${service} repo: ${repoUrl}${sparse ? ' [sparse]' : ''}`)
  if (!fs.existsSync(dir)) {
    await runCommand('git', {
      args: [
        '-C',
        escapePath(config.repoDir),
        'clone',
        sparse && '--filter=blob:none',
        sparse && '--no-checkout',
        repoUrl,
        repoDir,
      ],
    })

    if (sparse) {
      await runCommand('git', {
        args: [
          '-C',
          dir,
          'sparse-checkout',
          'init',
          '--cone',
        ],
      })
      if (sparseDir) {
        const sparseDirs = Array.isArray(sparseDir) ? sparseDir : [sparseDir]
        await runCommand('git', {
          args: [
            '-C',
            dir,
            'sparse-checkout',
            'set',
            ...sparseDirs,
          ],
        })
      }
      await runCommand('git', {
        args: [
          '-C',
          dir,
          'checkout',
        ],
      })
    }
  } else {
    if (pull) {
      !silent && showInfo(`${service} repo exists, pulling latest code...`)
      await runCommand('git', {
        args: [
          '-C',
          dir,
          'pull',
        ],
      })
    }
    // Check if the required file exists in the repo
    if (checkFile) {
      const checkFilePath = path.join(dir, checkFile)
      if (!await fs.exists(checkFilePath)) {
        const errMsg = `Required file ${checkFile} not found in ${service} directory: ${dir}`
        showWarning(errMsg)
        showUserAction(`Please check the repository structure and try again.`)
        throw new Error(errMsg)
      }
    }
    !silent && showInfo(`✔️ ${service} repo is ready`)
  }
}

/**
 * Setup enabled services that require cloning a repo
 * @param pull - Pull latest changes from remote
 * @param all - Setup all repos
 */
export async function setupRepos({
  pull = false,
  all = false,
  silent = false,
}: {
  pull?: boolean
  all?: boolean
  silent?: boolean
} = {}): Promise<void> {
  // Ensure repos directory exists
  try {
    await fs.ensureDir(config.repoDir)
  } catch (error) {
    showError(`Unable to create repos dir: ${config.repoDir}`, error)
    Deno.exit(1)
  }

  // Setup all repos in parallel
  await Promise.all(
    Object.entries(REPO_SERVICES)
      .map(([service, { url, dir, sparseDir, sparse, checkFile }]) => {
        if (!all && !isEnabled(service)) {
          return false
        }
        return setupRepo(service, url, dir, { sparseDir, sparse, pull, checkFile, silent })
      })
      .filter(Boolean),
  )
  !silent && showInfo(`${all ? 'All repositories' : 'Repositories'} are ready`)
}

/**
 * Copy .env and docker/config.supabase.env contents to .env in the supabase repo
 */
export async function prepareSupabaseEnv(
  { silent = false }: { silent?: boolean } = {},
): Promise<void> {
  // Check if the supabase repo directory exists
  // It contains the root docker-compose.yaml file to start supabase services
  const supabaseRepoDir = config.serviceRepoPath('supabase')
  if (!fs.existsSync(supabaseRepoDir)) {
    // Try to fix the issue by cloning all the repos
    !silent && showInfo(`Supabase repo not found: ${supabaseRepoDir}`)
    !silent && showInfo('Attempting to repair the repos...')
    await setupRepos({ all: true, silent })
    if (!fs.existsSync(supabaseRepoDir)) {
      showError('Supabase repo still not found, unable to continue')
      Deno.exit(1)
    }
  }
}

/**
 * Create volumes dirs required by docker-compose.yaml files
 *
 * Uses LLEMONSTACK_VOLUMES_DIR env var to determine the path to the
 * base volumes directory.
 *
 * If the volumes directory does not exist, it will be created.
 *
 * If the volumes directory exists, but is not a directory, an error will be thrown.
 */
async function createRequiredVolumes({ silent = false }: { silent?: boolean } = {}): Promise<void> {
  if (DEBUG) {
    silent = false
  }

  const volumesPath = config.volumesDir

  !silent && showInfo('Checking for required volumes...')
  DEBUG && showDebug(`Volumes base path: ${volumesPath}`)

  for (const volume of REQUIRED_VOLUMES) {
    const volumePath = path.join(volumesPath, volume.volume)
    try {
      const fileInfo = await Deno.stat(volumePath)
      if (fileInfo.isDirectory) {
        DEBUG && showDebug(`✔️ ${volume.volume}`)
      } else {
        throw new Error(`Volume is not a directory: ${volumePath}`)
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        await Deno.mkdir(volumePath, { recursive: true })
        !silent && showInfo(`Created missing volume dir: ${volumePath}`)
      } else {
        throw error
      }
    }
    if (volume.seed) {
      for (const seed of volume.seed) {
        const seedPath = path.join(volumePath, seed.destination)
        try {
          // Check if seedPath already exists before copying
          const seedPathExists = await fs.exists(seedPath)
          if (seedPathExists) {
            DEBUG && showDebug(`Volume seed already exists: ${getRelativePath(seedPath)}`)
            continue
          }
          await fs.copy(seed.source, seedPath, { overwrite: false })
          !silent &&
            showInfo(`Copied ${getRelativePath(seed.source)} to ${getRelativePath(seedPath)}`)
        } catch (error) {
          showError(
            `Error copying seed: ${getRelativePath(seed.source)} to ${getRelativePath(seedPath)}`,
            error,
          )
        }
      }
    }
  }
  !silent && showInfo(`All required volumes exist`)
}

function getRelativePath(pathStr: string): string {
  return path.relative(Deno.cwd(), pathStr)
}

/**
 * Call this function before running any other scripts
 */
export async function prepareEnv({ silent = false }: { silent?: boolean } = {}): Promise<void> {
  !silent && showInfo('Preparing environment...')

  if (!fs.existsSync(config.envFile)) {
    showError('Error: .env file not found')
    showUserAction(
      'Please create a .env file in the root directory and try again.',
    )
    Deno.exit(1)
  }

  // Prepare the custom supabase .env file needed for the supabase docker-compose.yaml file
  await prepareSupabaseEnv({ silent })

  // Create volumes dirs required by docker-compose.yaml files
  await createRequiredVolumes({ silent })

  !silent && showInfo('✔️ Supabase environment successfully setup')
}

/**
 * Get the profiles command for docker compose as array to pass to runCommand
 * @param all - Whether to use all profiles
 * @returns The profiles command
 */
export function getProfilesArgs({
  all = false,
  profiles,
}: {
  all?: boolean
  profiles?: string[]
} = {}): string[] {
  const profilesList = all ? [`"*"`] : profiles || []
  return profilesList.map((profile) => ['--profile', profile]).flat()
}

export function getOllamaProfile(): OllamaProfile {
  return `ollama-${Deno.env.get('ENABLE_OLLAMA')?.trim() || 'false'}` as OllamaProfile
}

export function getOllamaHost(): string {
  // Use the OLLAMA_HOST env var if it is set, otherwise check Ollama profile settings
  const host = Deno.env.get('OLLAMA_HOST') || (getOllamaProfile() === 'ollama-host')
    ? 'host.docker.internal:11434'
    : 'ollama:11434'
  return host
}

/**
 * Check if supabase was started by any of the services that depend on it
 * @param projectName
 */
export async function isSupabaseStarted(projectName: string): Promise<boolean> {
  return await isServiceRunning('supabase', { projectName, match: 'partial' })
}

export async function startService(
  projectName: string,
  service: string,
  { envVars = {}, profiles, createNetwork = true }: {
    envVars?: EnvVars
    profiles?: string[]
    createNetwork?: boolean
  } = {},
) {
  if (createNetwork) {
    await prepareDockerNetwork()
  }

  const composeFile = await getComposeFile(service)
  if (!composeFile) {
    throw new Error(`Docker compose file not found for ${service}: ${composeFile}`)
  }
  await runDockerComposeCommand('up', {
    projectName,
    composeFile,
    profiles,
    ansi: 'never',
    args: ['-d'],
    env: envVars,
    silent: false,
  })
}

/**
 * Start multiple services at the same time
 *
 * @param projectName - The project name
 * @param services - The services to start
 * @param envVars - The environment variables
 * @param composeFiles - The compose files to use
 */
export async function startServices(
  projectName: string,
  services: string[],
  { envVars = {} }: { envVars?: EnvVars } = {},
) {
  // Create the network if it doesn't exist
  await prepareDockerNetwork()

  // Start all services in parallel
  await Promise.all(services.map(async (service) => {
    try {
      await startService(projectName, service, { envVars, createNetwork: false })
    } catch (error) {
      showError(`Failed to start service ${service}:`, error)
      throw error
    }
  }))
}

export function isInitialized(): boolean {
  return config.projectInitialized
}

async function outputServicesInfo({
  projectName,
  ollamaProfile,
}: {
  projectName: string
  ollamaProfile: string
}): Promise<void> {
  //
  // SERVICE DASHBOARDS
  //
  showHeader('Service Dashboards')
  showInfo('Access the dashboards in a browser on your host machine.\n')
  isEnabled('n8n') && showService('n8n', 'http://localhost:5678')
  if (isEnabled('flowise')) {
    showService('Flowise', 'http://localhost:3001')
    showCredentials({
      'Username': Deno.env.get('FLOWISE_USERNAME'),
      'Password': Deno.env.get('FLOWISE_PASSWORD'),
    })
  }
  isEnabled('openwebui') && showService('Open WebUI', 'http://localhost:8080')
  if (isEnabled('browser-use')) {
    showService('Browser-Use', 'http://localhost:7788/')
    showService(
      'Browser-Use VNC',
      'http://0.0.0.0:6080/vnc.html?host=0.0.0.0&port=6080',
    )
    showCredentials({
      'Password': Deno.env.get('BROWSER_USE_VNC_PASSWORD'),
    })
  }
  if (isEnabled('supabase')) {
    showService('Supabase', `http://localhost:8000`)
    showCredentials({
      'Username': Deno.env.get('SUPABASE_DASHBOARD_USERNAME'),
      'Password': Deno.env.get('SUPABASE_DASHBOARD_PASSWORD'),
    })
  }
  if (isEnabled('litellm')) {
    showService('LiteLLM', 'http://localhost:3004/ui/')
    showCredentials({
      'Username': Deno.env.get('LITELLM_UI_USERNAME'),
      'Password': Deno.env.get('LITELLM_UI_PASSWORD'),
    })
  }
  if (isEnabled('langfuse')) {
    showService('Langfuse', 'http://localhost:3005/')
    showCredentials({
      'Username': Deno.env.get('LANGFUSE_INIT_USER_EMAIL'),
      'Password': Deno.env.get('LANGFUSE_INIT_USER_PASSWORD'),
    })
  }
  if (isEnabled('neo4j')) {
    showService('Neo4j', 'http://localhost:7474/browser/')
    showCredentials({
      'Username': Deno.env.get('NEO4J_USER'),
      'Password': Deno.env.get('NEO4J_PASSWORD'),
    })
  }
  isEnabled('qdrant') && showService('Qdrant', 'http://localhost:6333/dashboard')
  if (isEnabled('minio')) {
    showService('Minio', 'http://localhost:9091/')
    showCredentials({
      'Username': 'minio',
      'Password': Deno.env.get('MINIO_ROOT_PASSWORD'),
    })
  }
  isEnabled('dozzle') && showService('Dozzle', 'http://localhost:8081/')

  //
  // API ENDPOINTS
  //
  showHeader('API Endpoints')
  showInfo('For connecting services within the stack, use the following endpoints.')
  showInfo('i.e. for n8n credentials, postgres connections, API requests, etc.\n')

  if (isEnabled('supabase')) {
    showService('Supabase Postgres DB Host', 'db')
    showCredentials({
      'Username': 'postgres',
      'Password': Deno.env.get('POSTGRES_PASSWORD'),
    })
    showService('Supabase Postgres Pooler', 'supavisor')
    showCredentials({
      'Username': `postgres.${projectName}`,
      'Password': Deno.env.get('POSTGRES_PASSWORD'),
    })
    showInfo('Use the pooler for postgres connections whenever possible.')
    showInfo(
      `PSQL Connection URL: postgres://postgres.${projectName}:${
        Deno.env.get('POSTGRES_PASSWORD')
      }@supavisor:5432/postgres`,
    )
    console.log('')
    showService('Supabase API', 'http://kong:8000')
    showService(
      'Supabase Edge Functions',
      'http://kong:8000/functions/v1/[function]',
    )
  }
  isEnabled('n8n') && showService('n8n', 'http://n8n:5678')
  if (isEnabled('flowise')) {
    showService('Flowise', 'http://flowise:3000')
    const flowiseApi = await getFlowiseApiKey()
    showCredentials({
      [flowiseApi?.keyName || 'API Key']: flowiseApi?.apiKey || '',
    })
  }
  if (isEnabled('litellm')) {
    showService('LiteLLM', 'http://litellm:4000')
    showCredentials({
      'API Key': Deno.env.get('LITELLM_MASTER_KEY'),
    })
  }
  if (isEnabled('zep')) {
    showService('Zep', 'http://zep:8000')
    showService('Zep Graphiti', 'http://graphiti:8003')
  }
  isEnabled('neo4j') && showService('Neo4j', 'bolt://neo4j:7687')
  isEnabled('qdrant') && showService('Qdrant', 'http://qdrant:6333')
  isEnabled('redis') && showService('Redis', 'http://redis:6379')
  isEnabled('clickhouse') && showService('Clickhouse', 'http://clickhouse:8123')
  isEnabled('langfuse') && showService('Langfuse', 'http://langfuse:3000')
  isEnabled('minio') && showService('Minio', 'http://minio:9000/')

  // Show any user actions
  // Show user action if using host Ollama
  if (ollamaProfile === 'ollama-host') {
    const ollamaUrl = 'http://host.docker.internal:11434'
    showService('Ollama', ollamaUrl)
    showUserAction(`\nUsing host Ollama: ${colors.yellow(ollamaUrl)}`)
    showUserAction('  Start Ollama on your computer: `ollama serve`')
    if (isEnabled('n8n')) {
      showUserAction(`  Set n8n Ollama credential url to: ${ollamaUrl}`)
      showUserAction(
        `  Or connect n8n to LiteLLM http://litellm:4000 to proxy requests to Ollama`,
      )
    }
  } else if (isEnabled('ollama')) {
    showService('Ollama', 'http://ollama:11434')
  }
  console.log('\n')
}

export async function start(
  projectName: string,
  { service, skipOutput = false }: { service?: string; skipOutput?: boolean } = {},
): Promise<void> {
  if (service && !isEnabled(service)) {
    showWarning(`${service} is not enabled`)
    showInfo(
      `Set ENABLE_${service.toUpperCase().replaceAll('-', '_')} to true in .env to enable it`,
    )
    return
  }
  try {
    if (!isInitialized()) {
      showWarning('Project not initialized', '❌')
      showUserAction('\nPlease run the init script first: llmn init')
      Deno.exit(1)
    }

    showAction('Checking prerequisites...')
    await checkPrerequisites()
    showAction('Setting up repositories...')
    await setupRepos()
    showAction('Setting up environment...')
    await prepareEnv({ silent: false })

    // Start services
    if (service) {
      // Start a single service
      await startService(projectName, service)
    } else {
      // Start all services by service group
      for (const [groupName, groupServices] of SERVICE_GROUPS) {
        const enabledGroupServices = groupServices.filter((service) =>
          isEnabled(service) &&
          ALL_COMPOSE_SERVICES.find(([s, _, autoRun]) => s === service && autoRun)
        )
        if (enabledGroupServices.length > 0) {
          showAction(`\nStarting ${groupName} services...`)
          await startServices(projectName, enabledGroupServices)
        }
      }
    }

    // Special handling for Ollama
    const ollamaProfile = getOllamaProfile()
    if (ollamaProfile !== 'ollama-false' && !service || service === 'ollama') {
      showAction(`\nStarting Ollama...`)
      if (ollamaProfile === 'ollama-host') {
        showInfo('Using host Ollama, no need to start ollama service')
      } else {
        await startService(projectName, 'ollama', { profiles: [ollamaProfile] })
      }
    }

    if (service) {
      showAction(`\n${service} started successfully!`)
    } else {
      showAction('\nAll services started successfully!')
    }

    if (!skipOutput) {
      await outputServicesInfo({
        projectName,
        ollamaProfile,
      })
    }
  } catch (error) {
    showError(error)
    Deno.exit(1)
  }
}

// Run script if this file is executed directly
if (import.meta.main) {
  // Check if script was called with a service argument
  const service = Deno.args.find((arg) => !arg.startsWith('--'))
  await start(Deno.env.get('LLEMONSTACK_PROJECT_NAME') || DEFAULT_PROJECT_NAME, {
    service,
  })
}
