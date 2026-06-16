import { z } from "zod";

/** RBAC roles. A single guard enforces these across the API and the MCP server. */
export const roleSchema = z.enum(["admin", "editor", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

/**
 * Lifecycle status of a project, from idea to retirement. Monitoring connectors
 * only run for projects that are actually deployed (`live` or `rebuild`).
 */
export const projectStatusSchema = z.enum([
  "idea",
  "in_progress",
  "rebuild",
  "live",
  "paused",
  "archived",
]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

/** Statuses for which the worker should poll monitoring connectors. */
export const MONITORED_STATUSES: ProjectStatus[] = ["live", "rebuild"];

/** Connector ids shipped in this repo. External connectors add their own ids. */
export const BUILT_IN_CONNECTOR_IDS = [
  // keyless built-ins (Phase 1)
  "ssl",
  "whois",
  "dns",
  "uptime",
  // registrar connectors
  "godaddy",
  "namecheap",
  // keyless deliverability/security (DNS-based)
  "email_auth",
  "dnsbl",
  "cert_transparency",
  // API connectors (Phase 2+)
  "cloudflare",
  "pagespeed",
  "uptimerobot",
  "ga4",
  "observatory",
  "datadog",
  "elasticsearch",
  "snyk",
  "aws_cost",
  // dev/deploy connectors (Phase 6)
  "github",
  "vercel",
  "netlify",
  // revenue / errors / analytics
  "stripe",
  "sentry",
  "plausible",
] as const;

/**
 * Connector identifier — a lowercase slug (letters, digits, `_`, `-`).
 * Open by design: third-party connectors (Apache-2.0 SDK) register their own
 * ids without changing this schema. Built-ins are listed in
 * {@link BUILT_IN_CONNECTOR_IDS}.
 */
export const connectorIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/, "connector id must be a lowercase slug");
export type ConnectorId = z.infer<typeof connectorIdSchema>;

/** Suggested metric categories for grouping in the UI. */
export const BUILT_IN_METRIC_KINDS = [
  "uptime",
  "performance",
  "ssl",
  "dns",
  "whois",
  "security",
  "cost",
  "traffic",
  "deploy",
] as const;

/**
 * Metric category. Open slug so external connectors can introduce new kinds
 * (e.g. "revenue"); the built-ins live in {@link BUILT_IN_METRIC_KINDS}.
 */
export const metricKindSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9_-]+$/, "metric kind must be a lowercase slug");
export type MetricKind = z.infer<typeof metricKindSchema>;

/** A single normalized time-series point produced by a connector's normalize(). */
export const normalizedMetricSchema = z.object({
  projectId: z.string().uuid(),
  connectorId: connectorIdSchema,
  kind: metricKindSchema,
  /** Dotted metric name, e.g. "ssl.days_until_expiry" or "uptime.ratio". */
  name: z.string().min(1),
  value: z.number(),
  unit: z.string().optional(),
  /** Free-form low-cardinality labels (e.g. region, endpoint). */
  labels: z.record(z.string()).optional(),
  observedAt: z.coerce.date(),
});
export type NormalizedMetric = z.infer<typeof normalizedMetricSchema>;

/** Unified timeline event / incident. */
export const eventSeveritySchema = z.enum(["info", "warning", "critical"]);
export type EventSeverity = z.infer<typeof eventSeveritySchema>;

export const projectEventSchema = z.object({
  projectId: z.string().uuid(),
  connectorId: connectorIdSchema.optional(),
  severity: eventSeveritySchema,
  title: z.string().min(1),
  description: z.string().optional(),
  occurredAt: z.coerce.date(),
});
export type ProjectEvent = z.infer<typeof projectEventSchema>;

/** Result of a single connector run, recorded for observability. */
export const connectorSyncStatusSchema = z.enum(["ok", "error", "running"]);
export type ConnectorSyncStatus = z.infer<typeof connectorSyncStatusSchema>;

/** Health score buckets surfaced in the dashboard. */
export const healthBandSchema = z.enum(["healthy", "degraded", "down", "unknown"]);
export type HealthBand = z.infer<typeof healthBandSchema>;

export interface HealthInput {
  /** Latest sync status per connector instance on the project. */
  connectors: { lastSyncStatus: string | null }[];
  /** Count of critical events within the caller's "recent" window. */
  recentCriticalCount: number;
  /** Count of warning events within the caller's "recent" window. */
  recentWarningCount: number;
}

/**
 * Derive a project's health band from connector sync statuses and recent
 * event severity. Pure and window-agnostic: the caller decides what "recent"
 * means and passes the counts.
 */
export function computeHealthBand(input: HealthInput): HealthBand {
  const statuses = input.connectors.map((c) => c.lastSyncStatus);
  if (statuses.length === 0 || statuses.every((s) => s == null)) return "unknown";
  if (statuses.includes("error") || input.recentCriticalCount > 0) return "down";
  if (input.recentWarningCount > 0 || statuses.some((s) => s !== "ok")) {
    return "degraded";
  }
  return "healthy";
}
