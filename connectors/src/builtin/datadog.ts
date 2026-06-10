import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Datadog site, e.g. "datadoghq.com", "datadoghq.eu", "us5.datadoghq.com". */
  site: z.string().min(1).default("datadoghq.com"),
  /** Optional monitor tag filter, e.g. "service:web". */
  monitorTags: z.string().optional(),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(15_000),
});

export interface DatadogRaw {
  ok: number | null;
  alert: number | null;
  warn: number | null;
  noData: number | null;
  total: number | null;
  error?: string;
}

function emptyRaw(error: string): DatadogRaw {
  return { ok: null, alert: null, warn: null, noData: null, total: null, error };
}

interface DdMonitor {
  overall_state?: string;
}

export const datadogConnector: Connector<DatadogRaw> = {
  id: "datadog",
  title: "Datadog Monitors",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 5 * 60, // 5 minutes

  async fetch(ctx: ConnectorRunContext): Promise<DatadogRaw> {
    const { site, monitorTags, timeoutMs } = configSchema.parse(ctx.config);
    const apiKey = ctx.secrets?.apiKey;
    const appKey = ctx.secrets?.appKey;
    if (!apiKey || !appKey) {
      return emptyRaw("missing Datadog credentials (apiKey/appKey)");
    }

    const params = new URLSearchParams();
    if (monitorTags) params.set("monitor_tags", monitorTags);
    const query = params.toString();
    const url = `https://api.${site}/api/v1/monitor${query ? `?${query}` : ""}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          "DD-API-KEY": apiKey,
          "DD-APPLICATION-KEY": appKey,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return emptyRaw(
          `Datadog returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }
      const monitors = (await res.json()) as DdMonitor[];
      if (!Array.isArray(monitors)) return emptyRaw("unexpected Datadog response");

      let ok = 0;
      let alert = 0;
      let warn = 0;
      let noData = 0;
      for (const m of monitors) {
        switch ((m.overall_state ?? "").toLowerCase()) {
          case "ok":
            ok += 1;
            break;
          case "alert":
            alert += 1;
            break;
          case "warn":
            warn += 1;
            break;
          case "no data":
            noData += 1;
            break;
        }
      }
      return { ok, alert, warn, noData, total: monitors.length };
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

  normalize(raw: DatadogRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "datadog",
        severity: "warning",
        title: "Datadog check failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    const push = (name: string, value: number | null) => {
      if (value === null) return;
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "datadog",
        kind: "uptime",
        name,
        value,
        observedAt: ctx.now,
      });
    };

    push("datadog.monitors_total", raw.total);
    push("datadog.monitors_ok", raw.ok);
    push("datadog.monitors_alert", raw.alert);
    push("datadog.monitors_warn", raw.warn);
    push("datadog.monitors_no_data", raw.noData);

    if (raw.alert && raw.alert > 0) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "datadog",
        severity: "critical",
        title: "Datadog monitors alerting",
        description: `${raw.alert} monitor(s) in ALERT state`,
        occurredAt: ctx.now,
      });
    } else if (raw.warn && raw.warn > 0) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "datadog",
        severity: "warning",
        title: "Datadog monitors warning",
        description: `${raw.warn} monitor(s) in WARN state`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
