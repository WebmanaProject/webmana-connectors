import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** URL path appended to https://<domain> when probing. */
  path: z.string().default("/"),
  /** "mobile" or "desktop" — PSI scores differ markedly between them. */
  strategy: z.enum(["mobile", "desktop"]).default("mobile"),
  /** Emit a warning event when the performance score drops below this (0-100). */
  warnScoreBelow: z.number().int().min(0).max(100).default(50),
  /** Request timeout in milliseconds. PSI runs a full Lighthouse audit. */
  timeoutMs: z.number().int().positive().default(60_000),
});

const PSI_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/** Lighthouse audits we surface as Core Web Vitals metrics. */
const VITAL_AUDITS: Record<string, { name: string; unit: string }> = {
  "largest-contentful-paint": { name: "pagespeed.lcp_ms", unit: "ms" },
  "first-contentful-paint": { name: "pagespeed.fcp_ms", unit: "ms" },
  "cumulative-layout-shift": { name: "pagespeed.cls", unit: "score" },
  "total-blocking-time": { name: "pagespeed.tbt_ms", unit: "ms" },
  interactive: { name: "pagespeed.tti_ms", unit: "ms" },
  "speed-index": { name: "pagespeed.speed_index_ms", unit: "ms" },
};

export interface PagespeedRaw {
  /** Performance category score 0-100, or null if unavailable. */
  score: number | null;
  /** Numeric audit values keyed by Lighthouse audit id. */
  audits: Record<string, number>;
  error?: string;
}

export const pagespeedConnector: Connector<PagespeedRaw> = {
  id: "pagespeed",
  title: "PageSpeed Insights",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 12 * 60 * 60, // 12 hours

  async fetch(ctx: ConnectorRunContext): Promise<PagespeedRaw> {
    const { path, strategy, timeoutMs } = configSchema.parse(ctx.config);
    const apiKey = ctx.secrets?.apiKey;
    if (!apiKey) {
      return { score: null, audits: {}, error: "missing PageSpeed API key" };
    }

    const target = `https://${ctx.domain}${path.startsWith("/") ? path : `/${path}`}`;
    const url = new URL(PSI_ENDPOINT);
    url.searchParams.set("url", target);
    url.searchParams.set("strategy", strategy);
    url.searchParams.set("category", "performance");
    url.searchParams.set("key", apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          score: null,
          audits: {},
          error: `PSI returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        };
      }
      const data = (await res.json()) as PsiResponse;
      const lh = data.lighthouseResult;
      const rawScore = lh?.categories?.performance?.score;
      const score = typeof rawScore === "number" ? Math.round(rawScore * 100) : null;

      const audits: Record<string, number> = {};
      for (const auditId of Object.keys(VITAL_AUDITS)) {
        const value = lh?.audits?.[auditId]?.numericValue;
        if (typeof value === "number") audits[auditId] = value;
      }
      return { score, audits };
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? `request timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return { score: null, audits: {}, error: message };
    } finally {
      clearTimeout(timer);
    }
  },

  normalize(raw: PagespeedRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };
    const { strategy, warnScoreBelow } = configSchema.parse(ctx.config);

    if (raw.error || raw.score === null) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "pagespeed",
        severity: "warning",
        title: "PageSpeed check failed",
        description: raw.error ?? "No performance score returned",
        occurredAt: ctx.now,
      });
      return result;
    }

    result.metrics.push({
      projectId: ctx.projectId,
      connectorId: "pagespeed",
      kind: "performance",
      name: "pagespeed.performance_score",
      value: raw.score,
      unit: "score",
      labels: { strategy },
      observedAt: ctx.now,
    });

    for (const [auditId, value] of Object.entries(raw.audits)) {
      const meta = VITAL_AUDITS[auditId];
      if (!meta) continue;
      // Millisecond timings round to whole ms; unitless scores (CLS) keep
      // their fractional precision.
      const value2 =
        meta.unit === "ms" ? Math.round(value) : Math.round(value * 1000) / 1000;
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "pagespeed",
        kind: "performance",
        name: meta.name,
        value: value2,
        unit: meta.unit,
        labels: { strategy },
        observedAt: ctx.now,
      });
    }

    if (raw.score < warnScoreBelow) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "pagespeed",
        severity: "warning",
        title: "Low PageSpeed performance score",
        description: `${ctx.domain} scored ${raw.score}/100 (${strategy})`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};

interface PsiResponse {
  lighthouseResult?: {
    categories?: { performance?: { score?: number | null } };
    audits?: Record<string, { numericValue?: number }>;
  };
}
