import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Namecheap account username (the ApiUser / UserName). Not a secret. */
  apiUser: z.string().min(1),
  /**
   * Whitelisted client IP for the API call (Namecheap requires it) — set the
   * public IP of the host running the worker, whitelisted in API settings.
   */
  clientIp: z.string().min(1),
  /** Emit a warning event when registration expires within this many days. */
  warnDays: z.number().int().positive().default(30),
  /** Use the Namecheap sandbox API host. */
  sandbox: z.boolean().default(false),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(10_000),
});

export interface NamecheapRaw {
  found: boolean;
  expires: string | null;
  autoRenew: boolean | null;
  isExpired: boolean | null;
  error?: string;
}

/** Read an XML attribute value from a single element string. */
function attr(element: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`, "i").exec(element);
  return match?.[1] ?? null;
}

/** Parse Namecheap's MM/DD/YYYY date into a Date (or null). */
function parseUsDate(value: string | null): Date | null {
  if (!value) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Namecheap registrar connector — reads a domain's expiry and auto-renew flag
 * from `namecheap.domains.getList`. Complements the keyless WHOIS connector with
 * the registrar-side auto-renew status that WHOIS can't provide.
 *
 * Secret: `apiKey`. Config: `apiUser` and `clientIp` (the public IP must be
 * whitelisted in the Namecheap account's API settings).
 */
export const namecheapConnector: Connector<NamecheapRaw> = {
  id: "namecheap",
  title: "Namecheap (registrar)",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 12 * 60 * 60, // 12 hours
  meta: {
    vendor: "Namecheap",
    category: "domain",
    verified: true,
    docsUrl: "https://www.namecheap.com/support/api/methods/domains/get-list/",
  },
  auth: { kind: "api_key" },

  async fetch(ctx: ConnectorRunContext): Promise<NamecheapRaw> {
    const { apiUser, clientIp, sandbox, timeoutMs } = configSchema.parse(ctx.config);
    const apiKey = ctx.secrets?.apiKey;
    if (!apiKey) {
      return {
        found: false,
        expires: null,
        autoRenew: null,
        isExpired: null,
        error: "missing Namecheap API key (apiKey)",
      };
    }

    const host = sandbox
      ? "https://api.sandbox.namecheap.com"
      : "https://api.namecheap.com";
    const params = new URLSearchParams({
      ApiUser: apiUser,
      ApiKey: apiKey,
      UserName: apiUser,
      ClientIp: clientIp,
      Command: "namecheap.domains.getList",
      SearchTerm: ctx.domain,
      PageSize: "100",
      Page: "1",
    });
    const url = `${host}/xml.response?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const xml = await res.text();

      if (/Status="ERROR"/i.test(xml)) {
        const errMatch = /<Error\b[^>]*>([^<]*)<\/Error>/i.exec(xml);
        return {
          found: false,
          expires: null,
          autoRenew: null,
          isExpired: null,
          error: errMatch?.[1]?.trim() || "Namecheap API returned an error",
        };
      }

      // getList returns one <Domain .../> element per domain; find ours by name.
      const elements = xml.match(/<Domain\b[^>]*\/?>/gi) ?? [];
      const target = ctx.domain.toLowerCase();
      const domainEl = elements.find(
        (el) => (attr(el, "Name") ?? "").toLowerCase() === target,
      );

      if (!domainEl) {
        return {
          found: false,
          expires: null,
          autoRenew: null,
          isExpired: null,
          error: `domain ${ctx.domain} not found in this Namecheap account`,
        };
      }

      const autoRenewStr = attr(domainEl, "AutoRenew");
      const isExpiredStr = attr(domainEl, "IsExpired");
      return {
        found: true,
        expires: attr(domainEl, "Expires"),
        autoRenew: autoRenewStr === null ? null : /^true$/i.test(autoRenewStr),
        isExpired: isExpiredStr === null ? null : /^true$/i.test(isExpiredStr),
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
        expires: null,
        autoRenew: null,
        isExpired: null,
        error: message,
      };
    } finally {
      clearTimeout(timer);
    }
  },

  normalize(raw: NamecheapRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };
    const { warnDays } = configSchema.parse(ctx.config);

    const expiry = parseUsDate(raw.expires);
    if (raw.error || !raw.found || !expiry) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "namecheap",
        severity: "warning",
        title: "Namecheap check failed",
        description:
          raw.error ??
          (raw.expires
            ? `Could not parse expiry date "${raw.expires}"`
            : "No registration expiry date returned"),
        occurredAt: ctx.now,
      });
      return result;
    }

    const daysUntilExpiry = Math.floor(
      (expiry.getTime() - ctx.now.getTime()) / 86_400_000,
    );

    result.metrics.push({
      projectId: ctx.projectId,
      connectorId: "namecheap",
      kind: "whois",
      name: "namecheap.days_until_expiry",
      value: daysUntilExpiry,
      unit: "days",
      observedAt: ctx.now,
    });

    if (raw.autoRenew !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "namecheap",
        kind: "whois",
        name: "namecheap.auto_renew",
        value: raw.autoRenew ? 1 : 0,
        observedAt: ctx.now,
      });
    }

    const autoRenewOff = raw.autoRenew === false;
    const renewNote = autoRenewOff ? " and auto-renew is OFF" : "";

    if (raw.isExpired || daysUntilExpiry < 0) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "namecheap",
        severity: "critical",
        title: "Domain registration expired",
        description: `${ctx.domain} registration expired on ${expiry.toISOString()}`,
        occurredAt: ctx.now,
      });
    } else if (daysUntilExpiry <= warnDays) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "namecheap",
        severity: autoRenewOff ? "critical" : "warning",
        title: "Domain registration expiring soon",
        description: `${ctx.domain} registration expires in ${daysUntilExpiry} day(s)${renewNote}`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
