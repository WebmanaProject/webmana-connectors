import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Vercel project name or id. */
  project: z.string().min(1),
  /** Optional Vercel team id (for team-scoped projects). */
  teamId: z.string().optional(),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(15_000),
});

/** Numeric encoding of deployment readiness for charting. */
function stateValue(state: string | null): number | null {
  switch (state) {
    case "READY":
      return 2;
    case "BUILDING":
    case "QUEUED":
    case "INITIALIZING":
      return 1;
    case "ERROR":
    case "CANCELED":
      return 0;
    default:
      return null;
  }
}

export interface VercelRaw {
  state: string | null;
  target: string | null;
  ageMinutes: number | null;
  url: string | null;
  error?: string;
}

function emptyRaw(error: string): VercelRaw {
  return { state: null, target: null, ageMinutes: null, url: null, error };
}

interface Deployment {
  readyState?: string;
  state?: string;
  target?: string | null;
  createdAt?: number;
  url?: string;
}

export const vercelConnector: Connector<VercelRaw> = {
  id: "vercel",
  title: "Vercel Deployments",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 10 * 60, // 10 minutes

  async fetch(ctx: ConnectorRunContext): Promise<VercelRaw> {
    const { project, teamId, timeoutMs } = configSchema.parse(ctx.config);
    const token = ctx.secrets?.token;
    if (!token) return emptyRaw("missing Vercel token");

    const params = new URLSearchParams({ projectId: project, limit: "1" });
    if (teamId) params.set("teamId", teamId);
    const url = `https://api.vercel.com/v6/deployments?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return emptyRaw(
          `Vercel returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }
      const data = (await res.json()) as { deployments?: Deployment[] };
      const latest = data.deployments?.[0];
      if (!latest) return emptyRaw("no deployments found for this project");

      const state = (latest.readyState ?? latest.state ?? null)?.toUpperCase() ?? null;
      const ageMinutes =
        typeof latest.createdAt === "number"
          ? Math.floor((ctx.now.getTime() - latest.createdAt) / 60_000)
          : null;

      return {
        state,
        target: latest.target ?? "production",
        ageMinutes,
        url: latest.url ?? null,
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

  normalize(raw: VercelRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "vercel",
        severity: "warning",
        title: "Vercel check failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    const labels: Record<string, string> = {};
    if (raw.state) labels.state = raw.state;
    if (raw.target) labels.target = raw.target;
    if (raw.url) labels.url = raw.url;
    const hasLabels = Object.keys(labels).length > 0;

    const stateVal = stateValue(raw.state);
    if (stateVal !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "vercel",
        kind: "deploy",
        name: "vercel.deploy_state",
        value: stateVal,
        labels: hasLabels ? labels : undefined,
        observedAt: ctx.now,
      });
    }
    if (raw.ageMinutes !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "vercel",
        kind: "deploy",
        name: "vercel.last_deploy_age_minutes",
        value: raw.ageMinutes,
        unit: "min",
        labels: hasLabels ? labels : undefined,
        observedAt: ctx.now,
      });
    }

    if (raw.state === "ERROR" || raw.state === "CANCELED") {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "vercel",
        severity: "critical",
        title: "Latest Vercel deployment failed",
        description: `Deployment state: ${raw.state}${raw.target ? ` (${raw.target})` : ""}.`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
