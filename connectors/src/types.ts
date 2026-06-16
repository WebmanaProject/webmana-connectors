import type { ZodTypeAny } from "zod";
import type { NormalizedMetric, ProjectEvent } from "@webmana/contracts";

/** Everything a connector needs to run one sync for one project. */
export interface ConnectorRunContext {
  projectId: string;
  /** Primary domain of the project, e.g. "example.com". */
  domain: string;
  /** Non-secret connector settings (validated against the connector's schema). */
  config: Record<string, unknown>;
  /** Decrypted secrets, if the connector requires credentials. */
  secrets?: Record<string, string>;
  /** Wall-clock time for this run; connectors should use it for observedAt. */
  now: Date;
}

/** What a connector run produces, ready to persist. */
export interface ConnectorResult {
  metrics: NormalizedMetric[];
  events: ProjectEvent[];
}

/**
 * A connector fetches data from one source and normalizes it into Webmana's
 * shared metric/event shape. The worker handles scheduling, retries, error
 * isolation, and persistence — a connector only implements fetch + normalize.
 */
export interface Connector<Raw = unknown> {
  /** Unique lowercase slug, e.g. "ssl" or "stripe". */
  id: string;
  /** Human-readable name shown in the UI. */
  title: string;
  /** True if the connector needs API credentials (secrets) to run. */
  requiresSecrets: boolean;
  /** Validates ConnectorRunContext.config. */
  configSchema: ZodTypeAny;
  /** Default polling cadence in seconds; the worker enqueues when due. */
  defaultIntervalSeconds: number;
  /** SDK v2 (optional): marketplace metadata for browsing/filtering. */
  meta?: ConnectorMeta;
  /** SDK v2 (optional): how the connector authenticates (defaults to api_key). */
  auth?: ConnectorAuth;
  fetch(ctx: ConnectorRunContext): Promise<Raw>;
  normalize(raw: Raw, ctx: ConnectorRunContext): ConnectorResult;
  /**
   * SDK v2 (optional): two-way actions this connector can perform. The host app
   * gates every invocation behind a capability grant + RBAC + an audit entry;
   * a connector only implements the side effect.
   */
  actions?: ConnectorAction[];
}

/** Marketplace metadata for a connector (SDK v2). */
export interface ConnectorMeta {
  /** Vendor/product name, e.g. "Stripe". */
  vendor?: string;
  /** Grouping category, e.g. "revenue", "deploy", "uptime", "security". */
  category?: string;
  /** Link to setup docs. */
  docsUrl?: string;
  /** True for connectors reviewed/maintained by the Webmana project. */
  verified?: boolean;
}

/** How a connector authenticates (SDK v2). */
export interface ConnectorAuth {
  kind: "none" | "api_key" | "oauth2";
  /** OAuth2 endpoints, when kind is "oauth2". */
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    scopes?: string[];
  };
}

/** Outcome of running a {@link ConnectorAction}. */
export interface ActionResult {
  ok: boolean;
  /** Human-readable result or error message. */
  message?: string;
  /** Optional structured data (e.g. a deployment id). */
  data?: Record<string, unknown>;
}

/**
 * A two-way action exposed by a connector (SDK v2). Read connectors omit this.
 * `inputSchema` validates the action's parameters and lets the host render a
 * form; `destructive` forces an extra confirmation in the UI.
 */
export interface ConnectorAction<Input = unknown> {
  /** Unique within the connector, lowercase slug, e.g. "redeploy". */
  id: string;
  title: string;
  description?: string;
  /** Zod schema validating the action input. */
  inputSchema: ZodTypeAny;
  /** Marks irreversible/high-impact actions for extra confirmation. */
  destructive?: boolean;
  run(ctx: ConnectorRunContext, input: Input): Promise<ActionResult>;
}
