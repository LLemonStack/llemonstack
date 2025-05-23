import { dockerEnv } from '@/lib/docker.ts'
import { path } from '@/lib/fs.ts'
import { expandEnvVars } from '@/lib/utils/envvars.ts'
import { showDebug, showWarning } from '@/relayer/ui/show.ts'
import { ComposeYaml, IServiceImage } from '@/types'
import * as yaml from 'jsr:@std/yaml'

export const COMPOSE_IMAGES_CACHE = {} as Record<string, IServiceImage[]>
// const ROOT_DIR = Deno.cwd()

/**
 * Get the images from the compose file
 *
 * @param {string} composeFile - The path to the compose file
 * @param {Set<string>} [processedFiles] - Set of already processed files to avoid circular references
 * @returns {Array<ServiceImage>} An array of objects with the service name and image
 */
export async function getImagesFromComposeYaml(
  composeFile: string,
  processedFiles: Set<string> = new Set(),
  { debug = false, rootDir = '' }: { debug?: boolean; rootDir?: string } = {},
): Promise<Array<IServiceImage>> { // TODO: migrate to TryCatchResult
  // Return the cached images if they exist
  if (COMPOSE_IMAGES_CACHE[composeFile]) {
    return COMPOSE_IMAGES_CACHE[composeFile]
  }

  // Prevent circular references
  if (processedFiles.has(composeFile)) {
    // TODO: log this instead of showing warning
    showWarning(`Circular reference detected for ${composeFile}, skipping`)
    return []
  }
  processedFiles.add(composeFile)

  // Expand any variables in the compose file path
  if (composeFile.includes('${')) {
    composeFile = expandEnvVars(composeFile, await dockerEnv())
  }

  try {
    // Read the compose file
    const fileContents = await Deno.readTextFile(composeFile)
    const composeConfig = yaml.parse(fileContents) as ComposeYaml
    const serviceImages: IServiceImage[] = []

    // Check for include directive in the compose file
    if (composeConfig.include) {
      // Handle both array and single include formats
      const includes = Array.isArray(composeConfig.include)
        ? composeConfig.include
        : [composeConfig.include]

      for (const include of includes) {
        if (typeof include === 'string') {
          // If include is a string, use it directly as the path
          const includePath = path.resolve(path.dirname(composeFile), include)
          const includedImages = await getImagesFromComposeYaml(
            includePath,
            new Set(processedFiles),
          )
          serviceImages.push(...includedImages)
        } else if (include && typeof include === 'object' && include.path) {
          // If include is an object with a path property
          const includePath = path.resolve(path.dirname(composeFile), include.path)
          const includedImages = await getImagesFromComposeYaml(
            includePath,
            new Set(processedFiles),
          )
          serviceImages.push(...includedImages)
        }
      }
    }

    // Extract service names and their image values
    if (composeConfig.services) {
      for (const serviceName in composeConfig.services) {
        const service = composeConfig.services[serviceName]
        const containerName = service?.container_name

        // Check if the service has an image directly
        if (service && service.image && !service.build) {
          serviceImages.push({
            service: serviceName,
            image: service.image,
            containerName: containerName || serviceName,
          })
        } else if (service && service.build) {
          if (!service.build.dockerfile) {
            service.build.dockerfile = 'Dockerfile'
          }
          serviceImages.push({
            service: serviceName,
            image: '',
            build: service.build.dockerfile
              ? path.relative(
                rootDir,
                path.resolve(
                  path.dirname(composeFile),
                  service.build.context || '.',
                  service.build.dockerfile,
                ),
              )
              : (service.build.dockerfile_inline && `Inline Dockerfile`) ||
                service.build.toString(),
            containerName: containerName || serviceName,
          })
        }

        // Check if the service extends another service
        if (service && service.extends && service.extends.file) {
          // Resolve the path to the extended file
          const extendedFilePath = service.extends.file.startsWith('.')
            ? path.resolve(
              path.dirname(composeFile),
              service.extends.file,
            )
            : service.extends.file

          // Recursively get images from the extended file
          const extendedImages = await getImagesFromComposeYaml(
            extendedFilePath,
            new Set(processedFiles),
          )

          // Find the specific service being extended
          if (service.extends.service) {
            const extendedServiceImage = extendedImages.find(
              (img) => img.service === service?.extends?.service,
            )

            if (extendedServiceImage) {
              // Only add if we don't already have an image for this service
              if (!serviceImages.some((img) => img.service === serviceName)) {
                serviceImages.push({
                  service: serviceName,
                  image: extendedServiceImage.image,
                  build: extendedServiceImage.build,
                  containerName: containerName || extendedServiceImage.containerName,
                })
              }
            }
          } else {
            // Add all images from the extended file
            serviceImages.push(...extendedImages)
          }
        }
      }
    }

    COMPOSE_IMAGES_CACHE[composeFile] = serviceImages
    return serviceImages
  } catch (error) {
    if (debug) {
      showDebug(
        `Error reading compose file (${composeFile})`,
        error,
      )
    }
    throw error
  }
}

export async function getImageFromCompose(
  composeFile: string,
  serviceName: string,
): Promise<IServiceImage | null> {
  const serviceImages = await getImagesFromComposeYaml(composeFile)
  return serviceImages.find((img) => img.service === serviceName) || null
}
