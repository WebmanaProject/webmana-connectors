import dns from "node:dns/promises";
import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** IP-based DNSBL zones to check the domain's A records against. */
  zones: z
    .array(z.string().min(1))
    .default(["zen.spamhaus.org", "b.barracudacentral.org", "bl.spamcop.net"]),
  /** Domain-based blocklist zones (queried with the domain name directly). */
  domainZones: z.array(z.string().min(1)).default(["dbl.spamhaus.org"]),
  /** Resolution timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(10_000),
});

export interface DnsblListing {
  target: string; // the IP or domain that is listed
  zone: string;
}

export interface DnsblRaw {
  ipsChecked: string[];
  listings: DnsblListing[];
  error?: string;
}

/** True if `name` resolves to an A record (i.e. the target is listed). */
async function isListed(resolver: dns.Resolver, name: string): Promise<boolean> {
  try {
    const records = await resolver.resolve4(name);
    return records.length > 0;
  } catch (err) {
    // ENODATA/ENOTFOUND simply means "not listed".
    if (err instanceof Error && /ENODATA|ENOTFOUND/.test(err.message)) return false;
    throw err;
  }
}

/** Reverse an IPv4 address: "1.2.3.4" -> "4.3.2.1". */
function reverseIpv4(ip: string): string {
  return ip.split(".").reverse().join(".");
}

export const dnsblConnector: Connector<DnsblRaw> = {
  id: "dnsbl",
  title: "Blacklist (DNSBL)",
  requiresSecrets: false,
  configSchema,
  defaultIntervalSeconds: 6 * 60 * 60, // 6 hours

  async fetch(ctx: ConnectorRunContext): Promise<DnsblRaw> {
    const { zones, domainZones, timeoutMs } = configSchema.parse(ctx.config);
    const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
    try {
      // IP-based checks: resolve the domain, then test each IP against each zone.
      let ips: string[] = [];
      try {
        ips = await resolver.resolve4(ctx.domain);
      } catch (err) {
        if (!(err instanceof Error && /ENODATA|ENOTFOUND/.test(err.message))) throw err;
      }

      const listings: DnsblListing[] = [];
      for (const ip of ips) {
        const rev = reverseIpv4(ip);
        for (const zone of zones) {
          if (await isListed(resolver, `${rev}.${zone}`)) {
            listings.push({ target: ip, zone });
          }
        }
      }

      // Domain-based checks (e.g. Spamhaus DBL).
      for (const zone of domainZones) {
        if (await isListed(resolver, `${ctx.domain}.${zone}`)) {
          listings.push({ target: ctx.domain, zone });
        }
      }

      return { ipsChecked: ips, listings };
    } catch (err) {
      return {
        ipsChecked: [],
        listings: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  normalize(raw: DnsblRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "dnsbl",
        severity: "warning",
        title: "Blacklist check failed",
        description: `Could not run DNSBL lookups for ${ctx.domain}: ${raw.error}`,
        occurredAt: ctx.now,
      });
      return result;
    }

    const listed = raw.listings.length > 0;

    result.metrics.push(
      {
        projectId: ctx.projectId,
        connectorId: "dnsbl",
        kind: "security",
        name: "dnsbl.listed",
        value: listed ? 1 : 0,
        observedAt: ctx.now,
      },
      {
        projectId: ctx.projectId,
        connectorId: "dnsbl",
        kind: "security",
        name: "dnsbl.listing_count",
        value: raw.listings.length,
        observedAt: ctx.now,
      },
    );

    if (listed) {
      const where = raw.listings.map((l) => `${l.target} on ${l.zone}`).join(", ");
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "dnsbl",
        severity: "critical",
        title: "Domain or IP is blacklisted",
        description: `${ctx.domain} appears on ${raw.listings.length} blocklist(s): ${where}. Email deliverability may be affected.`,
        occurredAt: ctx.now,
      });
    } else if (raw.ipsChecked.length === 0) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "dnsbl",
        severity: "info",
        title: "No addresses to check",
        description: `${ctx.domain} resolved no A records, so only domain blocklists were checked`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
