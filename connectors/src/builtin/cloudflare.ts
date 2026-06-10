import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Cloudflare zone id (Overview tab of the zone in the dashboard). */
  zoneId: z.string().min(1),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(15_000),
});

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

const QUERY = `
query ($zoneTag: String!, $since: String!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequests1dGroups(
        limit: 1
        filter: { date_geq: $since }
        orderBy: [date_DESC]
      ) {
        sum { requests bytes threats pageViews }
        uniq { uniques }
      }
    }
  }
}`;

export interface CloudflareRaw {
  requests: number | null;
  bytes: number | null;
  threats: number | null;
  pageViews: number | null;
  uniques: number | null;
  error?: string;
}

function emptyRaw(error: string): CloudflareRaw {
  return {
    requests: null,
    bytes: null,
    threats: null,
    pageViews: null,
    uniques: null,
    error,
  };
}

interface GqlResponse {
  errors?: { message?: string }[];
  data?: {
    viewer?: {
      zones?: {
        httpRequests1dGroups?: {
          sum?: {
            requests?: number;
            bytes?: number;
            threats?: number;
            pageViews?: number;
          };
          uniq?: { uniques?: number };
        }[];
      }[];
    };
  };
}

export const cloudflareConnector: Connector<CloudflareRaw> = {
  id: "cloudflare",
  title: "Cloudflare Analytics",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 6 * 60 * 60, // 6 hours

  async fetch(ctx: ConnectorRunContext): Promise<CloudflareRaw> {
    const { zoneId, timeoutMs } = configSchema.parse(ctx.config);
    const apiToken = ctx.secrets?.apiToken;
    if (!apiToken) return emptyRaw("missing Cloudflare API token");

    // Look back one full day so the most recent daily group has data.
    const since = new Date(ctx.now.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: QUERY,
          variables: { zoneTag: zoneId, since },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return emptyRaw(`Cloudflare returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      const data = (await res.json()) as GqlResponse;
      if (data.errors?.length) {
        return emptyRaw(data.errors.map((e) => e.message).join("; ") || "Cloudflare GraphQL error");
      }

      const group = data.data?.viewer?.zones?.[0]?.httpRequests1dGroups?.[0];
      if (!group) return emptyRaw("no Cloudflare analytics for this zone/window");

      const sum = group.sum ?? {};
      return {
        requests: sum.requests ?? null,
        bytes: sum.bytes ?? null,
        threats: sum.threats ?? null,
        pageViews: sum.pageViews ?? null,
        uniques: group.uniq?.uniques ?? null,
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

  normalize(raw: CloudflareRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "cloudflare",
        severity: "warning",
        title: "Cloudflare check failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    const push = (name: string, value: number | null, kind: "traffic" | "security", unit?: string) => {
      if (value === null) return;
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "cloudflare",
        kind,
        name,
        value,
        unit,
        observedAt: ctx.now,
      });
    };

    push("cloudflare.requests", raw.requests, "traffic");
    push("cloudflare.bytes", raw.bytes, "traffic", "bytes");
    push("cloudflare.page_views", raw.pageViews, "traffic");
    push("cloudflare.uniques", raw.uniques, "traffic");
    push("cloudflare.threats", raw.threats, "security");

    return result;
  },
};
