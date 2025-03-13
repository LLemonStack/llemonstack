"use strict"
/**
 * This file is used to instrument the n8n application with OpenTelemetry.
 * It's run by the docker entrypoint.sh script before starting n8n.
 */

const opentelemetry = require("@opentelemetry/sdk-node")
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http")
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http")
const {
  getNodeAutoInstrumentations,
} = require("@opentelemetry/auto-instrumentations-node")
const { registerInstrumentations } = require("@opentelemetry/instrumentation")
const { Resource } = require("@opentelemetry/resources")
const {
  SemanticResourceAttributes,
} = require("@opentelemetry/semantic-conventions")
const winston = require("winston")
const {
  trace,
  context,
  SpanStatusCode,
  SpanKind,
} = require("@opentelemetry/api")
const flatten = require("flat") // flattens objects into a single level
const LOGPREFIX = '[tracing]'
const LOG_LEVEL = process.env.LOG_LEVEL?.toLowerCase() || 'info'
const DEBUG = LOG_LEVEL === 'debug'

console.log(`${LOGPREFIX}: Starting n8n OpenTelemetry instrumentation`)

// Configure OpenTelemetry
// Turn off auto-instrumentation for dns, net, tls, fs
// Enable enhancedDatabaseReporting for pg
const autoInstrumentations = getNodeAutoInstrumentations({
  "@opentelemetry/instrumentation-dns": { enabled: false },
  "@opentelemetry/instrumentation-net": { enabled: false },
  "@opentelemetry/instrumentation-tls": { enabled: false },
  "@opentelemetry/instrumentation-fs": { enabled: false },
  "@opentelemetry/instrumentation-pg": {
    enhancedDatabaseReporting: true,
  },
})

registerInstrumentations({
  instrumentations: [autoInstrumentations],
})

// Setup n8n telemetry
console.log(`${LOGPREFIX}: Setting up n8n telemetry`)
setupN8nOpenTelemetry()

// Configure Winston logger to log to console
console.log(`${LOGPREFIX}: Configuring Winston logger with level: ${LOG_LEVEL}`)
setupWinstonLogger(LOG_LEVEL)

// Configure and start the OpenTelemetry SDK
console.log(`${LOGPREFIX}: Configuring OpenTelemetry SDK with log level: ${process.env.OTEL_LOG_LEVEL}`)
const sdk = setupOpenTelemetryNodeSDK()
sdk.start()


////////////////////////////////////////////////////////////
// HELPER FUNCTIONS
////////////////////////////////////////////////////////////

/**
 * Configure and start the OpenTelemetry SDK
 */
function setupOpenTelemetryNodeSDK() {
  const sdk = new opentelemetry.NodeSDK({
    logRecordProcessors: [
      new opentelemetry.logs.SimpleLogRecordProcessor(
        new OTLPLogExporter({
          // Explicitly set the endpoint to the Honeycomb API endpoint
          url: 'https://api.honeycomb.io:443/v1/logs',
          headers: {
            'x-honeycomb-team': process.env.HONEYCOMB_API_KEY
          },
        }),
      ),
    ],
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]:
        process.env.OTEL_SERVICE_NAME || "n8n",
    }),
    traceExporter: new OTLPTraceExporter({
      // Explicitly set the endpoint to the Honeycomb API endpoint
      url: 'https://api.honeycomb.io:443/v1/traces',
      headers: {
        'x-honeycomb-team': process.env.HONEYCOMB_API_KEY
      },
    }),
  })
  return sdk
}

/**
 * Configure the Winston logger
 *
 * - Logs uncaught exceptions to the console
 * - Logs unhandled promise rejections to the console
 * - Logs errors to the console
 */
function setupWinstonLogger(logLevel = "info") {
  const logger = winston.createLogger({
    level: logLevel,
    format: winston.format.json(),
    transports: [new winston.transports.Console()],
  })

  process.on("uncaughtException", async (err) => {
    logger.error("Uncaught Exception", { error: err })
    const span = opentelemetry.trace.getActiveSpan()
    if (span) {
      span.recordException(err)
      span.setStatus({ code: 2, message: err.message })
    }
    try {
      await sdk.forceFlush()
    } catch (flushErr) {
      logger.error("Error flushing telemetry data", { error: flushErr })
    }
    process.exit(1)
  })

  process.on("unhandledRejection", (reason, promise) => {
    logger.error("Unhandled Promise Rejection", { error: reason })
  })
}

/**
 * Patches n8n workflow and node execution to wrap the entire run in a workflow-level span.
 *
 * - Span name: "n8n.workflow.execute"
 * - Attributes prefixed with "n8n." to follow semantic conventions.
 */
function setupN8nOpenTelemetry() {
  // Setup n8n workflow execution tracing
  const tracer = trace.getTracer("n8n-instrumentation", "1.0.0")

  try {
    // Import n8n core modules
    const { WorkflowExecute } = require("n8n-core")

    /**
     * Patch the workflow execution
     *
     * Wrap the entire run in a workflow-level span and capture workflow details as attributes.
     *
     * - Span name: "n8n.workflow.execute"
     * - Attributes prefixed with "n8n." to follow semantic conventions.
     */
    const originalProcessRun = WorkflowExecute.prototype.processRunExecutionData
    /** @param {import('n8n-workflow').Workflow} workflow */
    WorkflowExecute.prototype.processRunExecutionData = function (workflow) {
      const wfData = workflow || {}
      const workflowId = wfData?.id ?? ""
      const workflowName = wfData?.name ?? ""

      const workflowAttributes = {
        "n8n.workflow.id": workflowId,
        "n8n.workflow.name": workflowName,
        ...flatten(wfData?.settings ?? {}, {
          delimiter: ".",
          transformKey: (key) => `n8n.workflow.settings.${key}`,
        }),
      }
      const span = tracer.startSpan("n8n.workflow.execute", {
        attributes: workflowAttributes,
        kind: SpanKind.INTERNAL,
      })

      if (DEBUG) {
        console.debug(`${LOGPREFIX}: starting n8n workflow:`, workflow)
      }

      // Set the span as active
      const activeContext = trace.setSpan(context.active(), span)
      return context.with(activeContext, () => {
        const cancelable = originalProcessRun.apply(this, arguments)
        cancelable
          .then(
            (result) => {
              if (result?.data?.resultData?.error) {
                const err = result.data.resultData.error
                span.recordException(err)
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: String(err.message || err),
                })
              }
            },
            (error) => {
              span.recordException(error)
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: String(error.message || error),
              })
            }
          )
          .finally(() => {
            span.end()
          })
        return cancelable
      })
    }

    /**
     * Patch the n8n node execution
     *
     * Wrap each node's run in a child span and capture node details as attributes.
     * - Span name: "n8n.node.execute"
     */
    const originalRunNode = WorkflowExecute.prototype.runNode
    /**
     * @param {import('n8n-workflow').Workflow} workflow
     * @param {import('n8n-workflow').IExecuteData} executionData
     * @param {import('n8n-workflow').IRunExecutionData} runExecutionData
     * @param {number} runIndex
     * @param {import('n8n-workflow').IWorkflowExecuteAdditionalData} additionalData
     * @param {import('n8n-workflow').WorkflowExecuteMode} mode
     * @param {AbortSignal} [abortSignal]
     * @returns {Promise<import('n8n-workflow').IRunNodeResponse>}
     */
    WorkflowExecute.prototype.runNode = async function (
      workflow,
      executionData,
      runExecutionData,
      runIndex,
      additionalData,
      mode,
      abortSignal
    ) {
      // Safeguard against undefined this context
      if (!this) {
        console.warn("WorkflowExecute context is undefined")
        return originalRunNode.apply(this, arguments)
      }

      const node = executionData?.node ?? "unknown"

      // TODO: get and log credentials used.
      // See
      // - https://github.com/n8n-io/n8n/blob/master/packages/workflow/src/Interfaces.ts#L186
      // - https://github.com/n8n-io/n8n/blob/master/packages/core/src/execution-engine/workflow-execute.ts#L1065
      // const credentials = workflow.nodes[node.name]?.credentials ?? "none"
      // console.debug(`${LOGPREFIX}: ???? credentials:`, credentials)
      // Credentials for AI Agent nodes are in the subnode, e.g. "Open AI Agent"
      // Currently runNode does not get called for the subnodes so we don't see
      // the credentials. One solution is to check the data sent in the runNode args
      // to see if the current node has subnodes with credentials?

      // let credInfo = "none"
      // if (node?.credentials && typeof node.credentials === "object") {
      //   const credTypes = Object.keys(node.credentials)
      //   if (credTypes.length) {
      //     credInfo = credTypes
      //       .map((type) => {
      //         const cred = node.credentials?.[type]
      //         return cred && typeof cred === "object"
      //           ? cred.name ?? `${type} (id:${cred?.id ?? "unknown"})`
      //           : type
      //       })
      //       .join(", ")
      //   }
      // }

      const executionId = additionalData?.executionId ?? "unknown"
      const userId = additionalData?.userId ?? "unknown"
      const nodeAttributes = {
        "n8n.workflow.id": workflow?.id ?? "unknown",
        "n8n.execution.id": executionId,
        "n8n.user.id": userId,
        // "n8n.credentials": credInfo || "none",
      }

      // Flatten the n8n node object into a single level of attributes
      const flattenedNode = flatten(node ?? {}, { delimiter: "." })
      for (const [key, value] of Object.entries(flattenedNode)) {
        if (typeof value === 'string' || typeof value === 'number') {
          nodeAttributes[`n8n.node.${key}`] = value;
        } else {
          nodeAttributes[`n8n.node.${key}`] = JSON.stringify(value);
        }
      }

      // Debug logging, uncomment as needed
      if (DEBUG) {
        console.debug(`${LOGPREFIX}: executing node:`, node.name)
        // console.debug(`${LOGPREFIX}: executing n8n node with attributes:`, nodeAttributes)
        // console.debug(`${LOGPREFIX}: executing n8n node:`, node)
        // console.debug(`${LOGPREFIX}: additionalData:`, additionalData)
        // console.debug(`${LOGPREFIX}: runExecutionData:`, runExecutionData)
        // console.debug(`${LOGPREFIX}: workflow:`, workflow)
        // console.debug(`${LOGPREFIX}: executionData:`, executionData)
        // console.debug(`${LOGPREFIX}: runIndex:`, runIndex)
        // console.debug(`${LOGPREFIX}: mode:`, mode)
        // console.debug(`${LOGPREFIX}: executionData data:`, JSON.stringify(executionData.data))
        // console.debug(`${LOGPREFIX}: executionData source:`, JSON.stringify(executionData.source))
      }

      return tracer.startActiveSpan(
        `n8n.node.execute`,
        { attributes: nodeAttributes, kind: SpanKind.INTERNAL },
        async (nodeSpan) => {
          try {
            const result = await originalRunNode.apply(this, [
              workflow,
              executionData,
              runExecutionData,
              runIndex,
              additionalData,
              mode,
              abortSignal,
            ])
            try {
              const outputData = result?.data?.[runIndex]
              const finalJson = outputData?.map((item) => item.json)
              nodeSpan.setAttribute(
                "n8n.node.output_json",
                JSON.stringify(finalJson)
              )
            } catch (error) {
              console.warn("Failed to set node output attributes: ", error)
            }
            return result
          } catch (error) {
            nodeSpan.recordException(error)
            nodeSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(error.message || error),
            })
            nodeSpan.setAttribute("n8n.node.status", "error")
            throw error
          } finally {
            nodeSpan.end()
          }
        }
      )
    }
  } catch (e) {
    console.error("Failed to set up n8n OpenTelemetry instrumentation:", e)
  }
}
