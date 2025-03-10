#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run --allow-write
/**
 * Setup required env variables
 *
 * Usage:
 *
 * ```bash
 * deno run setup
 * ```
 */
import { Input, Secret, Select } from '@cliffy/prompt'
import {
  generateJWT,
  generateSecretKey,
  supabaseAnonJWTPayload,
  supabaseServiceJWTPayload,
} from './lib/jwt.ts'
import { reset } from './reset.ts'
import {
  confirm,
  DEFAULT_PROJECT_NAME,
  ENVFILE,
  getOS,
  isInitialized,
  LLEMONSTACK_CONFIG_DIR,
  LLEMONSTACK_CONFIG_FILE,
  loadEnv,
  showAction,
  showError,
  showHeader,
  showInfo,
  showService,
  showUserAction,
  showWarning,
  start,
  VERSION,
} from './start.ts' // Adjust the path as necessary

async function envFileExists(): Promise<boolean> {
  try {
    await Deno.stat(ENVFILE)
    return true
  } catch (_error) {
    return false
  }
}

async function createConfigFile(): Promise<void> {
  // Check if the config directory exists
  try {
    await Deno.stat(LLEMONSTACK_CONFIG_DIR)
  } catch (_error) {
    // Create the config directory if it doesn't exist
    await Deno.mkdir(LLEMONSTACK_CONFIG_DIR, { recursive: true })
  }
  try {
    // Create the config file with initial configuration
    const config = {
      initialized: true,
      timestamp: new Date().toISOString(),
      version: VERSION,
    }
    await Deno.writeTextFile(
      LLEMONSTACK_CONFIG_FILE,
      JSON.stringify(config, null, 2),
    )
  } catch (error) {
    showError(`Error creating config file: ${LLEMONSTACK_CONFIG_FILE}`, error)
  }
}

async function clearConfigFile(): Promise<void> {
  try {
    await Deno.stat(LLEMONSTACK_CONFIG_FILE)
    await Deno.remove(LLEMONSTACK_CONFIG_FILE)
  } catch (_error) {
    // File doesn't exist, do nothing
  }
}

async function createEnvFile(): Promise<void> {
  if (await envFileExists()) {
    throw new Error('Environment file already exists')
  }
  try {
    await Deno.copyFile('.env.example', ENVFILE)
  } catch (error) {
    throw new Error(`Failed to create .env file: ${error}`)
  }
}

async function clearEnvFile(): Promise<void> {
  if (await envFileExists()) {
    await Deno.remove(ENVFILE)
  }
}

// Check if the value is a valid Docker project name
function projectNameValidator(value?: string): boolean | string {
  if (!/^[a-zA-Z0-9]/.test(value || '')) {
    return 'Name must start with a letter or number'
  }
  if ((value?.length || 0) < 3) {
    return 'Name must be at least 3 characters long'
  }
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]+$/.test(value || '') ||
    'Name can only use letters, numbers, hyphens and underscores'
}

async function updateEnvFile(envVars: Record<string, string>): Promise<void> {
  const envFileContent = await Deno.readTextFile(ENVFILE)
  const updatedEnvFileContent = Object.entries(envVars).reduce((acc, [key, value]) => {
    if (!value) return acc // Keep existing value in .env if key value not set
    return acc.replace(new RegExp(`${key}=.*`, 'g'), `${key}=${value}`)
  }, envFileContent)
  await Deno.writeTextFile(ENVFILE, updatedEnvFileContent)
}

async function setSecurityKeys(envVars: typeof ENVVARS): Promise<Record<string, string>> {
  // Supabase
  const supabaseKey = await generateSecretKey(32)
  envVars.SUPABASE_JWT_SECRET = supabaseKey
  envVars.SUPABASE_ANON_KEY = await generateJWT(supabaseAnonJWTPayload, supabaseKey)
  envVars.SUPABASE_SERVICE_ROLE_KEY = await generateJWT(supabaseServiceJWTPayload, supabaseKey)
  envVars.SUPABASE_VAULT_ENC_KEY = await generateSecretKey(32)
  envVars.POSTGRES_PASSWORD = await generateSecretKey(32)

  // n8n
  envVars.N8N_ENCRYPTION_KEY = await generateSecretKey(32)
  envVars.N8N_USER_MANAGEMENT_JWT_SECRET = await generateSecretKey(32)

  // Zep
  envVars.ZEP_API_SECRET = await generateSecretKey(20)

  // Flowise
  envVars.FLOWISE_PASSWORD = await generateSecretKey(22)

  // Neo4j
  envVars.NEO4J_PASSWORD = await generateSecretKey(32)

  // LiteLLM
  envVars.LITELLM_MASTER_KEY = `sk-${await generateSecretKey(32)}`
  envVars.LITELLM_UI_PASSWORD = await generateSecretKey(16)

  // Langfuse
  envVars.LANGFUSE_SALT = await generateSecretKey(32)
  envVars.LANGFUSE_ENCRYPTION_KEY = await generateSecretKey(64)
  envVars.LANGFUSE_NEXTAUTH_SECRET = await generateSecretKey(32)
  envVars.LANGFUSE_INIT_PROJECT_PUBLIC_KEY = await generateSecretKey(32)
  envVars.LANGFUSE_INIT_PROJECT_SECRET_KEY = await generateSecretKey(32)
  envVars.LANGFUSE_INIT_USER_PASSWORD = await generateSecretKey(22)
  // Minio
  envVars.MINIO_ROOT_PASSWORD = await generateSecretKey(22)
  // Clickhouse
  envVars.CLICKHOUSE_PASSWORD = await generateSecretKey(22)
  // Redis
  envVars.REDIS_PASSWORD = await generateSecretKey(22)

  return envVars
}

/**
 * Prompt user for ollama configuration options
 * @returns The selected ollama profile
 */
async function configOllama(): Promise<string> {
  const gpuDisabled = getOS() === 'macos'
  if (gpuDisabled) {
    showWarning('GPU options are not currently available on macOS due to Docker limitations.\n')
  }

  const gpuIcon = gpuDisabled ? '🚫' : '🐳'
  const ollamaProfile: string = await Select.prompt({
    message: 'How do you want to run Ollama?',
    options: [
      { name: '❌ [Disable] turn off ollama service', value: 'false' },
      Select.separator('----- Run on Host -----'),
      {
        name: '🖥️ [Host] creates a network bridge',
        value: 'host',
      },
      Select.separator('----- Run in Docker Container -----'),
      { name: '🐳 [CPU] slow but compatible, no GPU requirements', value: 'cpu' },
      {
        name: `${gpuIcon} [AMD GPU] requires AMD GPU on the host`,
        value: 'gpu-amd',
        disabled: gpuDisabled,
      },
      {
        name: `${gpuIcon} [NVIDIA GPU] requires NVIDIA GPU on the host`,
        value: 'gpu-nvidia',
        disabled: gpuDisabled,
      },
    ],
  })
  return ollamaProfile
}

const ENVVARS = {
  DOCKER_PROJECT_NAME: '',
  // Supabase
  SUPABASE_DASHBOARD_USERNAME: 'supabase',
  SUPABASE_DASHBOARD_PASSWORD: 'supabase',
  POSTGRES_PASSWORD: '',
  SUPABASE_JWT_SECRET: '',
  SUPABASE_ANON_KEY: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  SUPABASE_VAULT_ENC_KEY: '',
  // N8N
  N8N_ENCRYPTION_KEY: '',
  N8N_USER_MANAGEMENT_JWT_SECRET: '',
  // Flowise
  FLOWISE_PASSWORD: '',
  // Zep
  ZEP_API_SECRET: '',
  // Neo4j
  NEO4J_USER: 'neo4j',
  NEO4J_PASSWORD: '',
  // Browser
  BROWSER_USE_VNC_PASSWORD: '',
  // OpenAI
  OPENAI_API_KEY: '',
  // Ollama
  ENABLE_OLLAMA: 'cpu',
  // LiteLLM
  LITELLM_MASTER_KEY: '',
  LITELLM_UI_PASSWORD: '',
  // Langfuse
  LANGFUSE_SALT: '', // 32
  LANGFUSE_ENCRYPTION_KEY: '', // 64
  LANGFUSE_NEXTAUTH_SECRET: '', // 32
  LANGFUSE_INIT_PROJECT_PUBLIC_KEY: '',
  LANGFUSE_INIT_PROJECT_SECRET_KEY: '',
  LANGFUSE_INIT_USER_PASSWORD: '',
  // Minio
  MINIO_ROOT_PASSWORD: '',
  // Clickhouse
  CLICKHOUSE_PASSWORD: '',
  // Redis
  REDIS_PASSWORD: '',
}

export async function init(
  projectName: string,
): Promise<void> {
  try {
    if (await isInitialized()) {
      showError(`Project already initialized: ${projectName}`)
      const resetOption: string = await Select.prompt({
        message: 'How do you want to proceed?',
        options: [
          {
            name: '💣 [Hard Reset] delete all data, containers and start over',
            value: 'hard-reset',
          },
          {
            name: '⌫ [Config Reset] start with a fresh .env file',
            value: 'config-reset',
          },
          {
            name: '↩ [Reinitialize] keep existing .env file and rerun the config setup',
            value: 'reinitialize',
          },
          {
            name: '↩ [Cancel]',
            value: 'none',
          },
        ],
      })
      if (resetOption === 'hard-reset') {
        if (confirm('Are you sure you want to delete all data and start over?')) {
          showAction('Resetting project...')
          await reset(projectName, { skipPrompt: true, skipCache: true })
          await clearEnvFile()
          await clearConfigFile()
        } else {
          Deno.exit(1)
        }
      } else if (resetOption === 'config-reset') {
        await clearEnvFile()
        await clearConfigFile()
      } else if (resetOption === 'reinitialize') {
        await clearConfigFile()
      }
    }

    showHeader('Initializing project...')

    if (await envFileExists()) {
      showInfo('.env file already exists')
      if (confirm('Do you want to delete .env and start fresh?', false)) {
        await clearEnvFile()
        await createEnvFile()
        showInfo('.env recreated from .env.example')
      } else {
        showInfo('OK, using existing .env file')
      }
    } else {
      showInfo('.env does not exist, copying from .env.example')
      await createEnvFile()
    }

    // Reload .env into Deno.env and show
    await loadEnv({ reload: true, silent: true })

    showInfo('.env file is ready to configure\n')

    const name = await Input.prompt(
      {
        message: 'What is the project name?',
        default: Deno.env.get('DOCKER_PROJECT_NAME') || DEFAULT_PROJECT_NAME,
        hint: 'Used by docker, only letters, numbers, hyphens and underscores',
        transform: (value?: string) => value?.toLowerCase(),
        validate: projectNameValidator,
      },
    )
    projectName = name
    ENVVARS.DOCKER_PROJECT_NAME = name

    // Generate random security keys
    await setSecurityKeys(ENVVARS)

    showAction('\nSetting up passwords...')
    showInfo('Passwords are stored in the .env file and shown to you when you start the stack\n')

    // Prompt user for passwords
    // Supabase
    ENVVARS.SUPABASE_DASHBOARD_PASSWORD = await Secret.prompt({
      message: 'Enter a password for the Supabase dashboard',
      hint: 'This should be a strong password, it grants access to Supabase admin features',
      minLength: 8,
    })
    ENVVARS.BROWSER_USE_VNC_PASSWORD = await Secret.prompt({
      message: 'Enter a password for browser-use VNC',
      hint: 'Used to access the VNC server to watch browser-use automation',
      minLength: 6,
    })

    showAction('\nSetting up required API keys...')
    showInfo(
      'Zep needs a valid OpenAI API key to work properly.\nYou can configure it later if you prefer.\n',
    )

    // Prompt for OpenAI API key
    ENVVARS.OPENAI_API_KEY = await Secret.prompt({
      message: 'Enter the OpenAI API key',
      hint: 'Leave blank to configure later',
    })

    if (!ENVVARS.OPENAI_API_KEY) {
      showInfo(
        '\n❗ Zep will not work properly without an OpenAI key. ' +
          'You can set it in .env or disable Zep later on.',
      )
    }

    showHeader('Ollama Configuration Options')
    showInfo('Ollama can run on your host machine or inside a Docker container.')
    showInfo('The host option requires manually starting ollama on your host machine.')
    showInfo('If running in Docker, you can choose to run it on the CPU (slow) or a GPU (fast).')
    showInfo("GPU options require a compatible GPU on the host... because it's not magic.\n")

    const ollamaProfile = await configOllama()
    ENVVARS.ENABLE_OLLAMA = ollamaProfile

    if (ollamaProfile === 'host') {
      showInfo('\nHost option requires Ollama running on your host machine.')
      showService('Download Ollama', 'https://ollama.com/docs/installation')
      showUserAction('Run `ollama run` on your host machine to start the service\n')
    }

    // Update .env file with new keys
    await updateEnvFile(ENVVARS)

    showAction('\nProject successfully initialized!\n')

    // Create config file to indicate project is initialized
    await createConfigFile()

    if (confirm('Do you want to start the stack?', true)) {
      await start(projectName)
    } else {
      showInfo('You can start the stack later with `deno run start`')
    }
    showUserAction('\nSee .env file to enable/disable services in the stack')
  } catch (error) {
    showError(error)
    Deno.exit(1)
  }
}

// Run script if this file is executed directly
if (import.meta.main) {
  init(Deno.env.get('DOCKER_PROJECT_NAME') || DEFAULT_PROJECT_NAME)
}
