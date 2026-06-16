import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Emit a warning event when registration expires within this many days. */
  warnDays: z.number().int().positive().default(30),
  /** API base; use the OTE/test host for sandbox keys. */
  apiBase: z.string().url().default("https://api.godaddy.com"),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(10_000),
});

export interface GoDaddyRaw {
  expires: string | null;
  renewAuto: boolean | null;
  status: string | null;
  error?: string;
}

interface GoDaddyDomain {
  expires?: string;
  renewAuto?: boolean;
  status?: string;
}

/**
 * GoDaddy registrar connector — reads a domain's registration expiry and
 * auto-renew flag from the GoDaddy Domains API. Complements the keyless WHOIS
 * connector with registrar-side data (auto-renew) that WHOIS can't provide.
 *
 * Secrets: `apiKey`, `apiSecret` (an API key/secret pair from the GoDaddy
 * developer portal). Auth header is `sso-key {apiKey}:{apiSecret}`.
 */
export const godaddyConnector: Connector<GoDaddyRaw> = {
  id: "godaddy",
  title: "GoDaddy (registrar)",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 12 * 60 * 60, // 12 hours
  meta: {
    vendor: "GoDaddy",
    category: "domain",
    verified: true,
    docsUrl: "https://developer.godaddy.com/doc/endpoint/domains",
  },
  auth: { kind: "api_key" },

  async fetch(ctx: ConnectorRunContext): Promise<GoDaddyRaw> {
    const { apiBase, timeoutMs } = configSchema.parse(ctx.config);
    const apiKey = ctx.secrets?.apiKey;
    const apiSecret = ctx.secrets?.apiSecret;
    if (!apiKey || !apiSecret) {
      return {
        expires: null,
        renewAuto: null,
        status: null,
        error: "missing GoDaddy credentials (apiKey and apiSecret)",
      };
    }

    const url = `${apiBase}/v1/domains/${encodeURIComponent(ctx.domain)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          authorization: `sso-key ${apiKey}:${apiSecret}`,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail =
          res.status === 404
            ? `domain ${ctx.domain} not found in this GoDaddy account`
            : res.status === 401 || res.status === 403
              ? "GoDaddy rejected the API credentials"
              : `GoDaddy API returned HTTP ${res.status}`;
        return { expires: null, renewAuto: null, status: null, error: detail };
      }
      const data = (await res.json()) as GoDaddyDomain;
      return {
        expires: data.expires ?? null,
        renewAuto: typeof data.renewAuto === "boolean" ? data.renewAuto : null,
        status: data.status ?? null,
      };
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? `request timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return { expires: null, renewAuto: null, status: null, error: message };
    } finally {
      clearTimeout(timer);
    }
  },

  normalize(raw: GoDaddyRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };
    const { warnDays } = configSchema.parse(ctx.config);

    if (raw.error || !raw.expires) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "godaddy",
        severity: "warning",
        title: "GoDaddy check failed",
        description: raw.error ?? "No registration expiry date returned",
        occurredAt: ctx.now,
      });
      return result;
    }

    const expiry = new Date(raw.expires);
    if (Number.isNaN(expiry.getTime())) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "godaddy",
        severity: "warning",
        title: "GoDaddy check failed",
        description: `Could not parse expiry date "${raw.expires}"`,
        occurredAt: ctx.now,
      });
      return result;
    }

    const labels = raw.status ? { status: raw.status } : undefined;
    const daysUntilExpiry = Math.floor(
      (expiry.getTime() - ctx.now.getTime()) / 86_400_000,
    );

    result.metrics.push({
      projectId: ctx.projectId,
      connectorId: "godaddy",
      kind: "whois",
      name: "godaddy.days_until_expiry",
      value: daysUntilExpiry,
      unit: "days",
      labels,
      observedAt: ctx.now,
    });

    if (raw.renewAuto !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "godaddy",
        kind: "whois",
        name: "godaddy.auto_renew",
        value: raw.renewAuto ? 1 : 0,
        labels,
        observedAt: ctx.now,
      });
    }

    // Auto-renew off is a louder signal: nothing will save the domain at expiry.
    const autoRenewOff = raw.renewAuto === false;
    const renewNote = autoRenewOff ? " and auto-renew is OFF" : "";

    if (daysUntilExpiry < 0) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "godaddy",
        severity: "critical",
        title: "Domain registration expired",
        description: `${ctx.domain} registration expired on ${expiry.toISOString()}`,
        occurredAt: ctx.now,
      });
    } else if (daysUntilExpiry <= warnDays) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "godaddy",
        severity: autoRenewOff ? "critical" : "warning",
        title: "Domain registration expiring soon",
        description: `${ctx.domain} registration expires in ${daysUntilExpiry} day(s)${renewNote}`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
