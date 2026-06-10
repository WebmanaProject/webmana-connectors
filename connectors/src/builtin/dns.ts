import dns from "node:dns/promises";
import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Resolve IPv6 (AAAA) records in addition to IPv4 (A). */
  includeIpv6: z.boolean().default(true),
  /** Resolution timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(10_000),
});

export interface DnsRaw {
  aRecords: string[];
  aaaaRecords: string[];
  resolveMs: number | null;
  error?: string;
}

async function resolveType(
  resolver: dns.Resolver,
  fn: (r: dns.Resolver) => Promise<string[]>,
): Promise<string[]> {
  try {
    return await fn(resolver);
  } catch (err) {
    // ENODATA/ENOTFOUND for a single record type is not fatal on its own.
    if (err instanceof Error && /ENODATA|ENOTFOUND/.test(err.message)) return [];
    throw err;
  }
}

export const dnsConnector: Connector<DnsRaw> = {
  id: "dns",
  title: "DNS Resolution",
  requiresSecrets: false,
  configSchema,
  defaultIntervalSeconds: 60 * 60, // 1 hour

  async fetch(ctx: ConnectorRunContext): Promise<DnsRaw> {
    const { includeIpv6, timeoutMs } = configSchema.parse(ctx.config);
    const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 2 });
    const start = Date.now();
    try {
      const aRecords = await resolveType(resolver, (r) => r.resolve4(ctx.domain));
      const aaaaRecords = includeIpv6
        ? await resolveType(resolver, (r) => r.resolve6(ctx.domain))
        : [];
      return { aRecords, aaaaRecords, resolveMs: Date.now() - start };
    } catch (err) {
      return {
        aRecords: [],
        aaaaRecords: [],
        resolveMs: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  normalize(raw: DnsRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "dns",
        severity: "critical",
        title: "DNS resolution failed",
        description: `Could not resolve ${ctx.domain}: ${raw.error}`,
        occurredAt: ctx.now,
      });
      return result;
    }

    const total = raw.aRecords.length + raw.aaaaRecords.length;

    result.metrics.push({
      projectId: ctx.projectId,
      connectorId: "dns",
      kind: "dns",
      name: "dns.a_records",
      value: raw.aRecords.length,
      observedAt: ctx.now,
    });

    if (raw.resolveMs !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "dns",
        kind: "dns",
        name: "dns.resolve_ms",
        value: raw.resolveMs,
        unit: "ms",
        observedAt: ctx.now,
      });
    }

    if (total === 0) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "dns",
        severity: "warning",
        title: "No DNS address records",
        description: `${ctx.domain} resolved no A or AAAA records`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
