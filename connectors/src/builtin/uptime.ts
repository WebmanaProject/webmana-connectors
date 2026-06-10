import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Path appended to https://<domain> when probing. */
  path: z.string().default("/"),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(10_000),
  /** Any status code below this counts as "up". */
  expectStatusBelow: z.number().int().positive().default(400),
});

export interface UptimeRaw {
  up: boolean;
  statusCode: number | null;
  responseMs: number | null;
  error?: string;
}

async function probe(
  url: string,
  timeoutMs: number,
): Promise<{ statusCode: number; responseMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    // Drain the body so the socket can be reused/closed promptly.
    await res.arrayBuffer().catch(() => undefined);
    return { statusCode: res.status, responseMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

export const uptimeConnector: Connector<UptimeRaw> = {
  id: "uptime",
  title: "HTTP Uptime",
  requiresSecrets: false,
  configSchema,
  defaultIntervalSeconds: 5 * 60, // 5 minutes

  async fetch(ctx: ConnectorRunContext): Promise<UptimeRaw> {
    const { path, timeoutMs, expectStatusBelow } = configSchema.parse(ctx.config);
    const url = `https://${ctx.domain}${path.startsWith("/") ? path : `/${path}`}`;
    try {
      const { statusCode, responseMs } = await probe(url, timeoutMs);
      return { up: statusCode < expectStatusBelow, statusCode, responseMs };
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? `request timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return { up: false, statusCode: null, responseMs: null, error: message };
    }
  },

  normalize(raw: UptimeRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    result.metrics.push({
      projectId: ctx.projectId,
      connectorId: "uptime",
      kind: "uptime",
      name: "uptime.up",
      value: raw.up ? 1 : 0,
      labels: raw.statusCode !== null ? { status: String(raw.statusCode) } : undefined,
      observedAt: ctx.now,
    });

    if (raw.responseMs !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "uptime",
        kind: "uptime",
        name: "uptime.response_ms",
        value: raw.responseMs,
        unit: "ms",
        observedAt: ctx.now,
      });
    }

    if (!raw.up) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "uptime",
        severity: "critical",
        title: "Site is down",
        description:
          raw.error ??
          `${ctx.domain} returned HTTP ${raw.statusCode ?? "no response"}`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
