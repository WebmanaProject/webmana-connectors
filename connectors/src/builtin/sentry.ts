import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Sentry organization slug. */
  org: z.string().min(1),
  /** Sentry project slug. */
  project: z.string().min(1),
  /** Base URL; override for self-hosted Sentry. */
  baseUrl: z.string().url().default("https://sentry.io"),
  /** Raise a warning when the most recent hour exceeds this many events (0 = off). */
  errorThresholdPerHour: z.number().int().nonnegative().default(0),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(15_000),
});

export interface SentryRaw {
  events24h: number;
  eventsLastHour: number;
  error?: string;
}

export const sentryConnector: Connector<SentryRaw> = {
  id: "sentry",
  title: "Sentry (errors)",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 15 * 60, // 15 minutes
  meta: { vendor: "Sentry", category: "errors", verified: true, docsUrl: "https://docs.sentry.io/api/" },
  auth: { kind: "api_key" },

  async fetch(ctx: ConnectorRunContext): Promise<SentryRaw> {
    const { org, project, baseUrl, timeoutMs } = configSchema.parse(ctx.config);
    const token = ctx.secrets?.token;
    if (!token) return { events24h: 0, eventsLastHour: 0, error: "missing Sentry auth token" };

    const until = Math.floor(ctx.now.getTime() / 1000);
    const since = until - 24 * 60 * 60;
    const params = new URLSearchParams({
      stat: "received",
      resolution: "1h",
      since: String(since),
      until: String(until),
    });
    const url = `${baseUrl}/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/stats/?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail =
          res.status === 401 || res.status === 403
            ? "Sentry rejected the token (needs project:read)"
            : res.status === 404
              ? `Sentry project ${org}/${project} not found`
              : `Sentry returned HTTP ${res.status}`;
        return { events24h: 0, eventsLastHour: 0, error: detail };
      }
      // Stats are returned as an array of [unixTimestamp, count] hourly buckets.
      const buckets = (await res.json()) as [number, number][];
      if (!Array.isArray(buckets)) {
        return { events24h: 0, eventsLastHour: 0, error: "unexpected Sentry stats response" };
      }
      const events24h = buckets.reduce((sum, b) => sum + (Number(b?.[1]) || 0), 0);
      const eventsLastHour = Number(buckets.at(-1)?.[1]) || 0;
      return { events24h, eventsLastHour };
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? `request timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return { events24h: 0, eventsLastHour: 0, error: message };
    } finally {
      clearTimeout(timer);
    }
  },

  normalize(raw: SentryRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };
    const { errorThresholdPerHour } = configSchema.parse(ctx.config);

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "sentry",
        severity: "warning",
        title: "Sentry check failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    result.metrics.push(
      {
        projectId: ctx.projectId,
        connectorId: "sentry",
        kind: "errors",
        name: "sentry.events_24h",
        value: raw.events24h,
        observedAt: ctx.now,
      },
      {
        projectId: ctx.projectId,
        connectorId: "sentry",
        kind: "errors",
        name: "sentry.events_last_hour",
        value: raw.eventsLastHour,
        observedAt: ctx.now,
      },
    );

    if (errorThresholdPerHour > 0 && raw.eventsLastHour > errorThresholdPerHour) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "sentry",
        severity: "warning",
        title: "Error volume spike",
        description: `${raw.eventsLastHour} events in the last hour exceeds the threshold of ${errorThresholdPerHour}.`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
