import { SCHEMA_VERSION } from './constants.mjs';

let otelApi = null;
let tracer = null;
let rootSpan = null;
let rootContext = null;
let sdkShutdown = null;
let tracingEnabled = false;

/**
 * Initialize OpenTelemetry tracing if environment variables are set.
 * Reads OTEL_TRACE_PARENT from parent process (worker) to continue the trace.
 *
 * @returns {Promise<boolean>} True if tracing was initialized
 */
export async function initTracing() {
  if (process.env.OTEL_TRACING_ENABLED !== 'true' || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return false;
  }

  try {
    const [
      { trace, context, SpanKind, SpanStatusCode },
      { NodeSDK },
      { OTLPTraceExporter },
      { Resource },
      { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
      { BatchSpanProcessor }
    ] = await Promise.all([
      import('@opentelemetry/api'),
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
      import('@opentelemetry/sdk-trace-node')
    ]);

    otelApi = { trace, context, SpanKind, SpanStatusCode };

    const exporter = new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`
    });

    const resource = new Resource({
      [ATTR_SERVICE_NAME]: 'code-evolution-analyzer',
      [ATTR_SERVICE_VERSION]: SCHEMA_VERSION
    });

    const sdk = new NodeSDK({
      resource,
      spanProcessor: new BatchSpanProcessor(exporter)
    });

    sdk.start();
    sdkShutdown = () => sdk.shutdown();

    tracer = trace.getTracer('code-evolution-analyzer', SCHEMA_VERSION);

    const parentContext = parseTraceParent(process.env.OTEL_TRACE_PARENT);

    if (parentContext) {
      const parentSpanContext = {
        traceId: parentContext.traceId,
        spanId: parentContext.spanId,
        traceFlags: parentContext.traceFlags,
        isRemote: true
      };

      const ctx = trace.setSpanContext(context.active(), parentSpanContext);
      rootSpan = tracer.startSpan('analyzer.run', { kind: SpanKind.INTERNAL }, ctx);
      rootContext = trace.setSpan(ctx, rootSpan);
    } else {
      rootSpan = tracer.startSpan('analyzer.run', { kind: SpanKind.INTERNAL });
      rootContext = trace.setSpan(context.active(), rootSpan);
    }

    tracingEnabled = true;
    return true;
  } catch (err) {
    if (process.env.DEBUG) {
      console.error('Tracing initialization failed:', err.message);
    }
    return false;
  }
}

/**
 * Parse W3C traceparent header format
 * Format: version-traceid-spanid-flags (e.g., "00-abc123...-def456...-01")
 *
 * @param {string} traceparent - W3C traceparent string
 * @returns {{ traceId: string, spanId: string, traceFlags: number } | null}
 */
export function parseTraceParent(traceparent) {
  if (!traceparent) return null;

  const parts = traceparent.split('-');
  if (parts.length !== 4) return null;

  const [version, traceId, spanId, flags] = parts;

  if (version !== '00') return null;

  if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === '00000000000000000000000000000000') {
    return null;
  }

  if (!/^[0-9a-f]{16}$/.test(spanId) || spanId === '0000000000000000') {
    return null;
  }

  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16)
  };
}

/**
 * Create a child span for an operation
 * Returns a no-op span object if tracing is not initialized
 */
export function startSpan(name, attributes = {}) {
  if (!tracer || !otelApi) {
    return {
      span: null,
      end: () => {},
      setAttributes: () => {},
      setStatus: () => {},
      recordException: () => {},
      addEvent: () => {}
    };
  }

  const span = tracer.startSpan(
    name,
    { kind: otelApi.SpanKind.INTERNAL, attributes },
    rootContext
  );

  return {
    span,
    end: () => span.end(),
    setAttributes: (attrs) => {
      for (const [key, value] of Object.entries(attrs)) {
        span.setAttribute(key, value);
      }
    },
    setStatus: (code, message) => {
      span.setStatus({
        code: code === 'error' ? otelApi.SpanStatusCode.ERROR : otelApi.SpanStatusCode.OK,
        message
      });
    },
    recordException: (err) => span.recordException(err),
    addEvent: (eventName, attrs) => span.addEvent(eventName, attrs)
  };
}

export function setRootAttributes(attrs) {
  if (!rootSpan) return;
  for (const [key, value] of Object.entries(attrs)) {
    rootSpan.setAttribute(key, value);
  }
}

export function recordRootException(err) {
  if (rootSpan && otelApi) {
    rootSpan.recordException(err);
  }
}

/**
 * Shutdown tracing and flush spans
 */
export async function shutdownTracing(success = true) {
  if (rootSpan && otelApi) {
    rootSpan.setStatus({
      code: success ? otelApi.SpanStatusCode.OK : otelApi.SpanStatusCode.ERROR
    });
    rootSpan.end();
  }

  if (sdkShutdown) {
    try {
      await sdkShutdown();
    } catch {
      // Ignore shutdown errors
    }
  }

  tracingEnabled = false;
}

export function isTracingEnabled() {
  return tracingEnabled;
}
