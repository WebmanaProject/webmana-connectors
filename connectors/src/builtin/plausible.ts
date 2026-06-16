import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Plausible site id; defaults to the project's domain. */
  siteId: z.string().min(1).optional(),
  /** Aggregation period (Plausible relative period, e.g. 7d, 30d, month). */
  period: z.string().default("30d"),
  /** Base URL; override for self-hosted Plausible. */
  baseUrl: z.string().url().default("https://plausible.io"),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(15_000),
});

export interface PlausibleRaw {
  visitors: number | null;
  pageviews: number | null;
  bounceRate: number | null;
  visitDuration: number | null;
  error?: string;
}

interface AggregateResponse {
  results?: {
    visitors?: { value?: number };
    pageviews?: { value?: number };
    bounce_rate?: { value?: number };
    visit_duration?: { value?: number };
  };
}

const num = (v: number | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export const plausibleConnector: Connector<PlausibleRaw> = {
  id: "plausible",
  title: "Plausible Analytics",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 6 * 60 * 60, // 6 hours
  meta: { vendor: "Plausible", category: "traffic", verified: true, docsUrl: "https://plausible.io/docs/stats-api" },
  auth: { kind: "api_key" },

  async fetch(ctx: ConnectorRunContext): Promise<PlausibleRaw> {
    const { siteId, period, baseUrl, timeoutMs } = configSchema.parse(ctx.config);
    const apiKey = ctx.secrets?.apiKey;
    const empty = (error: string): PlausibleRaw => ({
      visitors: null,
      pageviews: null,
      bounceRate: null,
      visitDuration: null,
      error,
    });
    if (!apiKey) return empty("missing Plausible API key");

    const params = new URLSearchParams({
      site_id: siteId ?? ctx.domain,
      period,
      metrics: "visitors,pageviews,bounce_rate,visit_duration",
    });
    const url = `${baseUrl}/api/v1/stats/aggregate?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail =
          res.status === 401
            ? "Plausible rejected the API key"
            : res.status === 404
              ? `Plausible site ${siteId ?? ctx.domain} not found`
              : `Plausible returned HTTP ${res.status}`;
        return empty(detail);
      }
      const data = (await res.json()) as AggregateResponse;
      const r = data.results ?? {};
      return {
        visitors: num(r.visitors?.value),
        pageviews: num(r.pageviews?.value),
        bounceRate: num(r.bounce_rate?.value),
        visitDuration: num(r.visit_duration?.value),
      };
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? `request timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return empty(message);
    } finally {
      clearTimeout(timer);
    }
  },

  normalize(raw: PlausibleRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };
    const { period } = configSchema.parse(ctx.config);

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "plausible",
        severity: "warning",
        title: "Plausible check failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    const labels = { period };
    const push = (name: string, value: number | null, unit?: string) => {
      if (value === null) return;
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "plausible",
        kind: "traffic",
        name,
        value,
        unit,
        labels,
        observedAt: ctx.now,
      });
    };

    push("plausible.visitors", raw.visitors);
    push("plausible.pageviews", raw.pageviews);
    push("plausible.bounce_rate", raw.bounceRate, "percent");
    push("plausible.visit_duration", raw.visitDuration, "s");

    return result;
  },
};
