import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Snyk organization id (Settings → General in the Snyk dashboard). */
  orgId: z.string().min(1),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(20_000),
});

export interface SnykRaw {
  critical: number | null;
  high: number | null;
  medium: number | null;
  low: number | null;
  projects: number | null;
  error?: string;
}

function emptyRaw(error: string): SnykRaw {
  return { critical: null, high: null, medium: null, low: null, projects: null, error };
}

interface SnykProject {
  issueCountsBySeverity?: {
    critical?: number;
    high?: number;
    medium?: number;
    low?: number;
  };
}

export const snykConnector: Connector<SnykRaw> = {
  id: "snyk",
  title: "Snyk",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 6 * 60 * 60, // 6 hours

  async fetch(ctx: ConnectorRunContext): Promise<SnykRaw> {
    const { orgId, timeoutMs } = configSchema.parse(ctx.config);
    const token = ctx.secrets?.token;
    if (!token) return emptyRaw("missing Snyk API token");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`https://api.snyk.io/v1/org/${orgId}/projects`, {
        method: "POST",
        headers: {
          authorization: `token ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: "{}",
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return emptyRaw(
          `Snyk returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }
      const data = (await res.json()) as { projects?: SnykProject[] };
      const projects = data.projects ?? [];

      let critical = 0;
      let high = 0;
      let medium = 0;
      let low = 0;
      for (const p of projects) {
        const c = p.issueCountsBySeverity ?? {};
        critical += c.critical ?? 0;
        high += c.high ?? 0;
        medium += c.medium ?? 0;
        low += c.low ?? 0;
      }
      return { critical, high, medium, low, projects: projects.length };
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

  normalize(raw: SnykRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "snyk",
        severity: "warning",
        title: "Snyk check failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    const push = (name: string, value: number | null) => {
      if (value === null) return;
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "snyk",
        kind: "security",
        name,
        value,
        observedAt: ctx.now,
      });
    };

    push("snyk.projects", raw.projects);
    push("snyk.issues_critical", raw.critical);
    push("snyk.issues_high", raw.high);
    push("snyk.issues_medium", raw.medium);
    push("snyk.issues_low", raw.low);

    if (raw.critical && raw.critical > 0) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "snyk",
        severity: "critical",
        title: "Critical Snyk vulnerabilities",
        description: `${raw.critical} critical issue(s) across monitored projects`,
        occurredAt: ctx.now,
      });
    } else if (raw.high && raw.high > 0) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "snyk",
        severity: "warning",
        title: "High-severity Snyk vulnerabilities",
        description: `${raw.high} high-severity issue(s) across monitored projects`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
