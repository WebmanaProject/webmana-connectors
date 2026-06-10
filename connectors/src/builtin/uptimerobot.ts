import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Restrict to a single UptimeRobot monitor id; otherwise match by domain. */
  monitorId: z.string().optional(),
  /** Uptime ratio window in days reported by UptimeRobot. */
  uptimeRatioDays: z.number().int().positive().default(30),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(10_000),
});

const API_URL = "https://api.uptimerobot.com/v2/getMonitors";

/** UptimeRobot status: 2 = up; 8/9 = down; 0 = paused; 1 = not checked yet. */
function isUp(status: number): boolean {
  return status === 2;
}

export interface UptimeRobotRaw {
  found: boolean;
  status: number | null;
  uptimeRatio: number | null;
  responseMs: number | null;
  monitorName: string | null;
  error?: string;
}

interface UrMonitor {
  id: number;
  friendly_name?: string;
  url?: string;
  status?: number;
  custom_uptime_ratio?: string;
  average_response_time?: string;
}

export const uptimerobotConnector: Connector<UptimeRobotRaw> = {
  id: "uptimerobot",
  title: "UptimeRobot",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 5 * 60, // 5 minutes

  async fetch(ctx: ConnectorRunContext): Promise<UptimeRobotRaw> {
    const { monitorId, uptimeRatioDays, timeoutMs } = configSchema.parse(ctx.config);
    const apiKey = ctx.secrets?.apiKey;
    if (!apiKey) {
      return {
        found: false,
        status: null,
        uptimeRatio: null,
        responseMs: null,
        monitorName: null,
        error: "missing UptimeRobot API key",
      };
    }

    const body = new URLSearchParams({
      api_key: apiKey,
      format: "json",
      response_times: "1",
      custom_uptime_ratios: String(uptimeRatioDays),
    });
    if (monitorId) body.set("monitors", monitorId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
      const data = (await res.json()) as {
        stat?: string;
        error?: { message?: string };
        monitors?: UrMonitor[];
      };
      if (data.stat !== "ok") {
        return {
          found: false,
          status: null,
          uptimeRatio: null,
          responseMs: null,
          monitorName: null,
          error: data.error?.message ?? "UptimeRobot API error",
        };
      }

      const monitors = data.monitors ?? [];
      const monitor =
        monitors.find(
          (m) =>
            (monitorId && String(m.id) === monitorId) ||
            (!monitorId && (m.url ?? "").includes(ctx.domain)),
        ) ?? (monitorId ? undefined : monitors[0]);

      if (!monitor) {
        return {
          found: false,
          status: null,
          uptimeRatio: null,
          responseMs: null,
          monitorName: null,
          error: `no UptimeRobot monitor matched ${monitorId ?? ctx.domain}`,
        };
      }

      const ratio = Number.parseFloat(monitor.custom_uptime_ratio ?? "");
      const avg = Number.parseFloat(monitor.average_response_time ?? "");
      return {
        found: true,
        status: monitor.status ?? null,
        uptimeRatio: Number.isFinite(ratio) ? ratio : null,
        responseMs: Number.isFinite(avg) ? avg : null,
        monitorName: monitor.friendly_name ?? null,
      };
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? `request timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        found: false,
        status: null,
        uptimeRatio: null,
        responseMs: null,
        monitorName: null,
        error: message,
      };
    } finally {
      clearTimeout(timer);
    }
  },

  normalize(raw: UptimeRobotRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    if (raw.error || !raw.found || raw.status === null) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "uptimerobot",
        severity: "warning",
        title: "UptimeRobot check failed",
        description: raw.error ?? "No monitor data returned",
        occurredAt: ctx.now,
      });
      return result;
    }

    const labels = raw.monitorName ? { monitor: raw.monitorName } : undefined;
    const up = isUp(raw.status);

    result.metrics.push({
      projectId: ctx.projectId,
      connectorId: "uptimerobot",
      kind: "uptime",
      name: "uptimerobot.up",
      value: up ? 1 : 0,
      labels,
      observedAt: ctx.now,
    });

    if (raw.uptimeRatio !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "uptimerobot",
        kind: "uptime",
        name: "uptimerobot.uptime_ratio",
        value: raw.uptimeRatio,
        unit: "percent",
        labels,
        observedAt: ctx.now,
      });
    }

    if (raw.responseMs !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "uptimerobot",
        kind: "uptime",
        name: "uptimerobot.response_ms",
        value: Math.round(raw.responseMs),
        unit: "ms",
        labels,
        observedAt: ctx.now,
      });
    }

    if (!up) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "uptimerobot",
        severity: "critical",
        title: "Monitor is down",
        description: `${raw.monitorName ?? ctx.domain} reported status ${raw.status}`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
