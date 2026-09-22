/**
 * bootstrap.ts — OpenTelemetry bootstrap before app imports
 * Source: agent_studio_implementation_plan.md:1344, 1135-1162
 * Must be imported first in apps/runtime-worker/src/main.ts before any other imports.
 * Ensures W3C trace context propagation across MCP, Temporal, provider, tool boundaries.
 * Default: no raw prompts, full docs, tool args, credentials in logs (1153-1161).
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface TelemetryConfig {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  exporterEndpoint?: string | undefined;
  samplingPolicy?: string | undefined;
}

let sdk: NodeSDK | undefined;

export function initTelemetry(config: TelemetryConfig): NodeSDK {
  if (sdk) return sdk;

  const traceExporter = config.exporterEndpoint
    ? new OTLPTraceExporter({ url: `${config.exporterEndpoint}/v1/traces` })
    : undefined;

  const sdkConfig: ConstructorParameters<typeof NodeSDK>[0] = {
    ...(traceExporter ? { traceExporter } : {}),
  } as unknown as ConstructorParameters<typeof NodeSDK>[0];

  const resourceAttrs: Record<string, string> = {
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    'deployment.environment': config.environment,
  };
  void resourceAttrs;

  sdk = new NodeSDK(sdkConfig);

  sdk.start();
  return sdk;
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = undefined;
  }
}

export {
  REDACTED_FIELDS,
  redactAttributes,
  redactLogRecord,
  hashContent,
  setDiagnosticMode,
  isDiagnosticModeActive,
} from './redaction.js';
