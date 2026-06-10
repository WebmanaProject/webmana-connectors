import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Base URL of the cluster, e.g. "https://es.example.com:9200". */
  baseUrl: z.string().url(),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(10_000),
});

export interface ElasticsearchRaw {
  status: string | null;
  nodes: number | null;
  dataNodes: number | null;
  activeShards: number | null;
  unassignedShards: number | null;
  error?: string;
}

function emptyRaw(error: string): ElasticsearchRaw {
  return {
    status: null,
    nodes: null,
    dataNodes: null,
    activeShards: null,
    unassignedShards: null,
    error,
  };
}

interface HealthResponse {
  status?: string;
  number_of_nodes?: number;
  number_of_data_nodes?: number;
  active_shards?: number;
  unassigned_shards?: number;
}

/** Map cluster colour to a numeric health for charting (green=2, yellow=1, red=0). */
function statusValue(status: string | null): number | null {
  switch (status) {
    case "green":
      return 2;
    case "yellow":
      return 1;
    case "red":
      return 0;
    default:
      return null;
  }
}

/** Build an Authorization header from secrets: API key takes precedence over basic auth. */
function authHeader(secrets: Record<string, string> | undefined): string | undefined {
  if (!secrets) return undefined;
  if (secrets.apiKey) return `ApiKey ${secrets.apiKey}`;
  if (secrets.username && secrets.password) {
    const basic = Buffer.from(`${secrets.username}:${secrets.password}`).toString("base64");
    return `Basic ${basic}`;
  }
  return undefined;
}

export const elasticsearchConnector: Connector<ElasticsearchRaw> = {
  id: "elasticsearch",
  title: "Elasticsearch",
  requiresSecrets: false,
  configSchema,
  defaultIntervalSeconds: 5 * 60, // 5 minutes

  async fetch(ctx: ConnectorRunContext): Promise<ElasticsearchRaw> {
    const { baseUrl, timeoutMs } = configSchema.parse(ctx.config);
    const headers: Record<string, string> = { accept: "application/json" };
    const auth = authHeader(ctx.secrets);
    if (auth) headers.authorization = auth;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/_cluster/health`, {
        headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return emptyRaw(
          `Elasticsearch returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }
      const data = (await res.json()) as HealthResponse;
      return {
        status: data.status ?? null,
        nodes: typeof data.number_of_nodes === "number" ? data.number_of_nodes : null,
        dataNodes:
          typeof data.number_of_data_nodes === "number" ? data.number_of_data_nodes : null,
        activeShards: typeof data.active_shards === "number" ? data.active_shards : null,
        unassignedShards:
          typeof data.unassigned_shards === "number" ? data.unassigned_shards : null,
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

  normalize(raw: ElasticsearchRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "elasticsearch",
        severity: "warning",
        title: "Elasticsearch check failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    const labels = raw.status ? { status: raw.status } : undefined;
    const push = (name: string, value: number | null) => {
      if (value === null) return;
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "elasticsearch",
        kind: "uptime",
        name,
        value,
        labels,
        observedAt: ctx.now,
      });
    };

    push("elasticsearch.status", statusValue(raw.status));
    push("elasticsearch.nodes", raw.nodes);
    push("elasticsearch.data_nodes", raw.dataNodes);
    push("elasticsearch.active_shards", raw.activeShards);
    push("elasticsearch.unassigned_shards", raw.unassignedShards);

    if (raw.status === "red") {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "elasticsearch",
        severity: "critical",
        title: "Elasticsearch cluster is red",
        description: `${raw.unassignedShards ?? "some"} shard(s) unassigned`,
        occurredAt: ctx.now,
      });
    } else if (raw.status === "yellow") {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "elasticsearch",
        severity: "warning",
        title: "Elasticsearch cluster is yellow",
        description: `${raw.unassignedShards ?? "some"} shard(s) unassigned`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
