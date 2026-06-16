import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Netlify site id, or the site's name / *.netlify.app subdomain. */
  siteId: z.string().min(1),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(15_000),
});

/** Numeric encoding of deploy state for charting. */
function stateValue(state: string | null): number | null {
  switch (state) {
    case "ready":
      return 2;
    case "building":
    case "enqueued":
    case "processing":
    case "new":
    case "uploading":
      return 1;
    case "error":
    case "rejected":
      return 0;
    default:
      return null;
  }
}

export interface NetlifyRaw {
  state: string | null;
  context: string | null;
  ageMinutes: number | null;
  errorMessage: string | null;
  url: string | null;
  error?: string;
}

function emptyRaw(error: string): NetlifyRaw {
  return { state: null, context: null, ageMinutes: null, errorMessage: null, url: null, error };
}

interface NetlifyDeploy {
  state?: string;
  context?: string;
  created_at?: string;
  error_message?: string | null;
  ssl_url?: string;
  deploy_ssl_url?: string;
}

export const netlifyConnector: Connector<NetlifyRaw> = {
  id: "netlify",
  title: "Netlify Deployments",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 10 * 60, // 10 minutes
  meta: { vendor: "Netlify", category: "deploy", verified: true, docsUrl: "https://docs.netlify.com/api/get-started/" },
  auth: { kind: "api_key" },

  async fetch(ctx: ConnectorRunContext): Promise<NetlifyRaw> {
    const { siteId, timeoutMs } = configSchema.parse(ctx.config);
    const token = ctx.secrets?.token;
    if (!token) return emptyRaw("missing Netlify token");

    const url = `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys?per_page=1`;
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
            ? "Netlify rejected the token"
            : res.status === 404
              ? `site ${siteId} not found`
              : `Netlify returned HTTP ${res.status}`;
        return emptyRaw(detail);
      }
      const deploys = (await res.json()) as NetlifyDeploy[];
      const latest = Array.isArray(deploys) ? deploys[0] : undefined;
      if (!latest) return emptyRaw("no deploys found for this site");

      const ageMinutes = latest.created_at
        ? Math.floor((ctx.now.getTime() - new Date(latest.created_at).getTime()) / 60_000)
        : null;
      return {
        state: latest.state?.toLowerCase() ?? null,
        context: latest.context ?? null,
        ageMinutes: ageMinutes !== null && Number.isFinite(ageMinutes) ? ageMinutes : null,
        errorMessage: latest.error_message ?? null,
        url: latest.ssl_url ?? latest.deploy_ssl_url ?? null,
      };
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? `request timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return emptyRaw(message);
    } finally {
      clearTimeout(timer);
    }
  },

  normalize(raw: NetlifyRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "netlify",
        severity: "warning",
        title: "Netlify check failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    const labels: Record<string, string> = {};
    if (raw.state) labels.state = raw.state;
    if (raw.context) labels.context = raw.context;
    const hasLabels = Object.keys(labels).length > 0;

    const stateVal = stateValue(raw.state);
    if (stateVal !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "netlify",
        kind: "deploy",
        name: "netlify.deploy_state",
        value: stateVal,
        labels: hasLabels ? labels : undefined,
        observedAt: ctx.now,
      });
    }
    if (raw.ageMinutes !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "netlify",
        kind: "deploy",
        name: "netlify.last_deploy_age_minutes",
        value: raw.ageMinutes,
        unit: "min",
        labels: hasLabels ? labels : undefined,
        observedAt: ctx.now,
      });
    }

    if (raw.state === "error" || raw.state === "rejected") {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "netlify",
        severity: "critical",
        title: "Latest Netlify deploy failed",
        description: `Deploy state: ${raw.state}${raw.context ? ` (${raw.context})` : ""}${raw.errorMessage ? ` — ${raw.errorMessage}` : ""}.`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
