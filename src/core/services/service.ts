import { tryDockerCompose, tryDockerComposePs } from '@/lib/docker.ts'
import { path } from '@/lib/fs.ts'
import { generateRandomBase64, generateSecretKey, generateUUID } from '@/lib/jwt.ts'
import { createServiceSchema, isPostgresConnectionValid } from '@/lib/postgres.ts'
import { failure, success, TryCatchResult } from '@/lib/try-catch.ts'
import { ObservableStruct } from '@/lib/utils/observable.ts'
import {
  ExposeHost,
  IRepoConfig,
  IServiceActionOptions,
  IServiceOptions,
  IServiceStartOptions,
  IServiceState,
  ServiceStatusType,
  ServiceYaml,
} from '@/types'
import { Config } from '../config/config.ts'
import { getEndpoints, prepareServiceVolumes, setupServiceRepo } from './utils/mod.ts'

/**
 * Service
 *
 * Represents a service in the LLemonStack configuration.
 * Extends ObservableStruct to provide a state object that can be observed for changes.
 */
export class Service {
  protected namespace: string = 'llemonstack'
  protected _id: string // namespace/service
  protected _service: string // service name in llemonstack.yaml
  protected _name: string // Human readable name
  protected _description: string // Service description

  protected _state: ObservableStruct<IServiceState> = new ObservableStruct<IServiceState>({
    enabled: false,
    started: false,
    healthy: false,
    ready: false,
    last_checked: null,
    state: null,
  })

  // Reference back to the active config object
  // This is here so services don't need to get the global config instance
  protected _configInstance: Config

  protected _dir: string

  protected _composeFile: string
  protected _profiles: string[] = []

  // Service's llemonstack.yaml config, once loaded it's frozen to prevent
  // accidental changes that are not saved
  readonly _config: ServiceYaml

  constructor(
    { serviceYaml, serviceDir, config, configSettings, enabled }: IServiceOptions,
  ) {
    this._name = serviceYaml.name
    this._service = serviceYaml.service
    this._description = serviceYaml.description

    // Set id to 'namespace/service' if not set in llemonstack.yaml
    this._id = serviceYaml.id ?? `${this.namespace}/${this._service}`

    this._configInstance = config // TODO: check for circular reference issues

    // Freeze the original config state to prevent accidental changes
    this._config = Object.freeze({ ...serviceYaml })

    this._dir = serviceDir
    this._composeFile = path.join(this._dir, serviceYaml.compose_file)

    this.setState('enabled', enabled)

    this.setProfiles(configSettings.profiles || [])
  }

  public toString(): string {
    return this.name
  }

  /**
   * Get the key used to store the service in a ServicesMap
   *
   * @returns {string} The key used to store the service in a ServicesMap
   */
  public get servicesMapKey(): string {
    return this._id
  }

  public get id(): string {
    return this._id
  }

  public get name(): string {
    return this._name || this._service || this.id
  }

  public get description(): string {
    return this._description || ''
  }

  public get service(): string {
    return this._service
  }

  public get composeFile(): string {
    return this._composeFile
  }

  public get config(): ServiceYaml {
    return this._config
  }

  public get repoConfig(): IRepoConfig | null {
    return this._config.repo ?? null
  }

  public get repoDir(): string | null {
    return this._config.repo?.dir
      ? path.join(this._configInstance.reposDir, this._config.repo?.dir)
      : null
  }

  public get repoBaseDir(): string {
    return this._configInstance.reposDir
  }

  public get serviceGroup(): string {
    return this._config.service_group ?? ''
  }

  public get volumes(): string[] {
    return this._config.volumes ?? []
  }

  public get volumesSeeds(): { source: string; destination: string; from_repo?: true }[] {
    return this._config.volumes_seeds ?? []
  }

  public get appVersionCmd(): string[] | null {
    return this._config.app_version_cmd ?? null
  }

  public get depends_on(): string[] {
    return Object.keys(this._config.depends_on || {}) ?? []
  }

  /**
   * Get the services that this service provides
   *
   * Returns ['postgres', 'db'] where postgres is provided by the db container.
   *
   * @returns {[string, string][]} The service name and container name for each service provided
   */
  public get provides(): [string, string][] {
    return Object.entries(this._config.provides || {}) ?? []
  }

  /**
   * Get the names for the docker containers provided by the service
   *
   * @returns {string[]} The container names
   */
  public get containerNames(): string[] {
    return Object.values(this._config.provides || {}) ?? []
  }

  //
  // Public Methods
  //

  /**
   * Get the state for a key in the service state object
   *
   * If no key is specified, the status is returned.
   *
   * @param {keyof IServiceState} key - The key to get
   * @returns The value of the key
   */
  public getState(key: keyof IServiceState): IServiceState[keyof IServiceState] {
    return this._state.get(key)
  }

  /**
   * Set the state for a key in the service state object
   *
   * @param {keyof IServiceState} key - The key to set
   * @param {IServiceState[K]} value - The value to set
   * @returns {boolean} Returns true if the state was set, false if value was invalid
   */
  public setState<K extends keyof IServiceState>(key: K, value: IServiceState[K]): boolean {
    this._state.set(key, value)
    return true
  }

  public async getStatus(): Promise<ServiceStatusType> {
    await this.checkState()
    if (!this.isEnabled()) {
      return 'disabled'
    }
    if (this._state.get('started')) {
      const health = this._state.get('healthy')
      if (health === true) {
        return 'running'
      } else if (health === false) {
        return 'unhealthy'
      } else {
        return 'started'
      }
    }
    if (this._state.get('ready')) {
      return 'ready'
    }
    // TODO: add other states
    // Default status: 'loaded'
    // Service is enabled but prepareEnv has not yet successfully completed
    return 'loaded'
  }

  public isEnabled(): boolean {
    return this._state.get('enabled')
  }

  public isStarted(): boolean {
    return this._state.get('started') || false
  }

  public async isRunning(): Promise<boolean> {
    await this.checkState()
    return this._state.get('started') || false
  }

  /**
   * Check the state of the service with Docker Compose and update the state object
   *
   * @returns {TryCatchResult<IServiceState>} - The result of the check
   */
  protected async checkState(): Promise<TryCatchResult<IServiceState>> {
    const results = success<IServiceState>(this._state as unknown as IServiceState)

    const serviceNames = this.containerNames

    const psResults = await tryDockerComposePs(
      this._configInstance.projectName,
      { services: serviceNames },
    )
    if (!psResults.success || !psResults.data) {
      this.setState('state', 'unknown')
      return failure(
        `Failed to update service state: ${this.name}`,
        results, // Return the current state
      )
    }

    // Use the ps results for the first service listed in provides key in llemonstack.yaml.
    // This first container is considered primary. e.g. supabase will check the db container.
    const data = psResults.data.find((c) => c.Service === serviceNames[0])
    // TODO: combine the status of all the matching services in the ps results?

    const state = data?.State ?? null
    this.setState('state', state)
    this.setState('started', state === 'running')
    this.setState('last_checked', new Date())
    this.setState('enabled', this.isEnabled())
    // TODO add more states checks here

    return results
  }

  /**
   * Get the first host matching the context
   *
   * By default, gets the first 'host' entry in the exposes config in llemonstack.yaml.
   * i.e. Returns the info for the main url exposed by the service on the host.
   *
   * @param {string} context - Dot object path for exposes in the service llemonstack.yaml config
   * @returns The container DNS host name and port, e.g. 'ollama:11434'
   */
  public getHostEndpoint(context: string = 'host.*'): ExposeHost {
    return this.getEndpoints(context)[0]
  }

  /**
   * Get all the endpoints matching the context
   *
   * Used by UI scripts and other services to discover the hosts and ports
   * this service is exposing to the host and internal to the stack.
   *
   * @example
   * ```ts
   * // Get all the endpoints exposed to the host
   * const endpoints = service.getEndpoints('host.*')
   * console.log(endpoints)
   *
   * // Get all the endpoints
   * const endpoints = service.getEndpoints('*.*')
   * console.log(endpoints)
   * ```
   *
   * @param {string} context - Dot object path for exposes in the service llemonstack.yaml config
   * @returns The container DNS host name and port, e.g. 'ollama:11434'
   */
  public getEndpoints(context: string = '*.*'): ExposeHost[] {
    return getEndpoints(this, context, this._configInstance.env)
  }

  /**
   * Get Docker Compose profiles for the service
   *
   * @returns Array of profiles, e.g. ['ollama-cpu']
   */
  public getProfiles(): string[] {
    // Override in subclasses to return the profiles for the service
    return this._profiles
  }

  public setProfiles(profiles: string[]) {
    this._profiles = profiles
  }

  /**
   * Load the environment variables for the service
   *
   * @param {Record<string, string>} envVars - The environment variables to load
   * @param {Config} config - The config instance
   * @returns {Promise<Record<string, string>>} - The environment variables
   */
  // deno-lint-ignore require-await
  public async loadEnv(
    envVars: Record<string, string>,
    { config: _config }: { config: Config },
  ): Promise<Record<string, string>> {
    // Override in subclasses to set environment variables for the service
    return envVars
  }

  /**
   * Prepare the service environment
   *
   * @returns {TryCatchResult<boolean>} - The result of the preparation
   */
  public async prepareEnv(
    { silent = true }: { silent?: boolean } = {},
  ): Promise<TryCatchResult<boolean>> {
    const results = success<boolean>(true)

    results.collect([
      await this.prepareRepo({ silent }),
      await this.prepareVolumes({ silent }),
    ])

    if (!results.success) {
      return failure<boolean>(`Failed to prepare service environment: ${this.name}`, results, false)
    }

    this.setState('ready', true)
    results.addMessage('info', `✔️ ${this.name} environment prepared, ready to start`)
    return results
  }

  /**
   * Prepare the service repository
   *
   * @param {boolean} [pull=false] - Whether to update the repository to get the latest changes
   * @returns {TryCatchResult<boolean>} - The result of the preparation
   */
  public async prepareRepo(
    { pull = false, silent = true }: { pull?: boolean; silent?: boolean } = {},
  ): Promise<TryCatchResult<boolean>> {
    // If no repo config, skip
    if (!this.repoConfig) {
      return success<boolean>(true)
    }

    return await setupServiceRepo(this, {
      pull,
      silent,
      createBaseDir: false, // Base dir is ensured in config
    })
  }

  /**
   * Prepare the service volumes
   *
   * @returns {TryCatchResult<boolean>} - The result of the preparation
   */
  protected async prepareVolumes(
    { silent: _ = true }: { silent?: boolean } = {},
  ): Promise<TryCatchResult<boolean>> {
    return await prepareServiceVolumes(this, this._configInstance.volumesDir)
  }

  //
  // Service Actions
  //
  // These methods are called by the CLI and can be overridden by subclasses.
  //

  /**
   * Initialize the service
   *
   * @returns {Promise<void>}
   */
  public async init(envVars: Record<string, string> = {}): Promise<TryCatchResult<boolean>> {
    const results = success<boolean>(true)

    const env = await this._configInstance.env

    // Create postgres schema if needed
    if (this.config.init?.postgres_schema) {
      const dbEnvKeys = this.config.init.postgres_schema || {}

      // Check if postgres user and password are already set
      if (env[dbEnvKeys.user] && env[dbEnvKeys.pass]) {
        results.addMessage('debug', 'Postgres schema already exists, skipping')
      } else {
        // Get postgres service
        const postgresService = this._configInstance.getServiceByProvides('postgres')
        if (!postgresService) {
          results.addMessage('error', `Postgres service not found, required by ${this.name}`)
          return failure<boolean>(`Unable to initialize ${this.name}`, results, false)
        }

        // Start postgres service if not running
        if (!await postgresService!.isRunning()) {
          const postgresResults = await postgresService.start()
          if (!postgresResults.success) {
            results.collect([postgresResults])
            return failure<boolean>(`Unable to initialize ${this.name}`, results, false)
          }
          // Wait 3 seconds for postgres to start
          await new Promise((resolve) => setTimeout(resolve, 3000))
        }

        if (!env.POSTGRES_PASSWORD) {
          results.addMessage('error', 'Postgres password not set, required by service')
          return failure<boolean>(`Unable to initialize ${this.name}`, results, false)
        }

        // Try to connect up to 3 times to postgres
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (await isPostgresConnectionValid({ password: env.POSTGRES_PASSWORD })) {
            results.addMessage('debug', `Successfully connected to Postgres`)
            break
          }

          if (attempt === 3) {
            results.addMessage('error', 'Failed to connect to Postgres after 3 attempts')
            return failure<boolean>(`Unable to initialize ${this.name}`, results, false)
          }

          // Wait longer on each attempt
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
        }

        // Postgres is connected, create the schema
        const credentials = await createServiceSchema(this.service, {
          password: env.POSTGRES_PASSWORD,
        })

        // Update env vars with new schema credentials
        envVars[dbEnvKeys.user] = credentials.username
        envVars[dbEnvKeys.pass] = credentials.password
        if (dbEnvKeys.schema) {
          envVars[dbEnvKeys.schema] = credentials.schema
        }

        results.addMessage('info', `Created postgres schema for ${this.name}`)
      }
    }

    // Generate secure env vars
    // These are typically API keys and secrets
    if (this.config.init?.generate) {
      Object.entries(this.config.init.generate).forEach(([key, settings]) => {
        if (env[key]) {
          results.addMessage('debug', `Env var ${key} already set, skipping`)
          return
        }
        if (settings.method === 'generateSecretKey') {
          envVars[key] = generateSecretKey(settings.length || 32)
        } else if (settings.method === 'generateRandomBase64') {
          envVars[key] = generateRandomBase64(settings.length || 32)
        } else if (settings.method === 'generateUUID') {
          envVars[key] = generateUUID()
        }
        if (settings.prefix) {
          envVars[key] = `${settings.prefix}${envVars[key]}`
        }
        results.addMessage('info', `Set env var ${key} to ${envVars[key]}`)
      })
    }

    // Update env file if any of the env vars were generated
    if (Object.keys(envVars).length > 0) {
      results.collect([await this._configInstance.setEnvFileVars(envVars)])
    }

    results.addMessage('info', `✔️ ${this.name} initialized`)
    return results
  }

  /**
   * Configure the service
   * @param {boolean} [silent] - Whether to run the configuration in silent or interactive mode
   * @returns {TryCatchResult<boolean>} - The result of the configuration
   */
  // deno-lint-ignore require-await
  public async configure(
    _options: IServiceActionOptions = {},
  ): Promise<TryCatchResult<boolean>> {
    return success<boolean>(true)
  }

  /**
   * Start the service
   * @param {EnvVars} [envVars] - Environment variables to pass to the service
   * @param {boolean} [silent] - Whether to run the command in silent mode
   * @returns {TryCatchResult<boolean>} - The result of the command
   */
  public async start(
    options: IServiceStartOptions = {},
  ): Promise<TryCatchResult<boolean>> {
    const config = this._configInstance

    // Prepare environment if not already prepared
    const prepareEnvResult = await config.prepareEnv()
    if (!prepareEnvResult.success) {
      return failure<boolean>(
        `Failed to prepare environment: ${this.name}`,
        prepareEnvResult,
        false,
      )
    }

    const results = await tryDockerCompose('up', {
      projectName: this._configInstance.projectName,
      composeFile: this.composeFile,
      profiles: this.getProfiles(),
      ansi: 'never',
      args: [
        '-d',
        options.build ? '--build' : false,
      ],
      env: options.envVars,
      silent: options.silent,
      captureOutput: false,
    })
    if (results.success) {
      return success<boolean>(true, `${this.name} successfully started!`)
    }
    return failure<boolean>(`Failed to start service: ${this.name}`, results, false)
  }

  public async stop(_options: IServiceActionOptions = {}): Promise<TryCatchResult<boolean>> {
    const config = this._configInstance
    // Prepare environment if not already prepared
    const prepareEnvResult = await config.prepareEnv()
    if (!prepareEnvResult.success) {
      return failure<boolean>(
        `Failed to prepare environment: ${this.name}`,
        prepareEnvResult,
        false,
      )
    }

    const results = await tryDockerCompose('down', {
      projectName: this._configInstance.projectName,
      composeFile: this.composeFile,
      profiles: this.getProfiles(),
      silent: true,
      captureOutput: true,
    })
    if (results.success) {
      return success<boolean>(true, `${this.name} successfully stopped!`)
    }

    // If the service is disabled and the error is about a missing file, return success
    if (
      !this.isEnabled() &&
      results.error?.stderr?.toString().toLowerCase().includes('no such file')
    ) {
      return success<boolean>(true, `${this.name} already stopped`)
    }

    return failure<boolean>(`Failed to stop service: ${this.name}`, results, false)
  }

  /**
   * Update the service
   * @param {IServiceUpdateOptions} [options] - The update options
   * @returns {TryCatchResult<boolean>} - The result of the update
   */
  public async update(
    options: IServiceActionOptions = {},
  ): Promise<TryCatchResult<boolean>> {
    const result = success<boolean>(true)
    result.collect([
      await tryDockerCompose('pull', {
        projectName: this._configInstance.projectName,
        composeFile: this.composeFile,
        profiles: this.getProfiles(),
        silent: options.silent,
        ansi: 'never',
      }),
      await tryDockerCompose('build', {
        projectName: this._configInstance.projectName,
        composeFile: this.composeFile,
        profiles: this.getProfiles(),
        silent: options.silent,
        ansi: 'never',
        args: ['--pull', '--no-cache'],
      }),
    ])
    return result
  }

  /**
   * Show additional info for the service after it's started
   *
   * @returns {Promise<void>}
   */
  public async showStartInfo(_options: IServiceActionOptions = {}): Promise<void> {
    // Override in subclasses to show additional info
  }
}
