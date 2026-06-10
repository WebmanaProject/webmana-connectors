import net from "node:net";
import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Emit a warning event when registration expires within this many days. */
  warnDays: z.number().int().positive().default(30),
  /** Per-query timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(10_000),
});

export interface WhoisRaw {
  expiryDate: string | null;
  registrar: string | null;
  error?: string;
}

/** Field labels that carry the registration expiry date across registries. */
const EXPIRY_FIELDS = [
  "Registry Expiry Date",
  "Registrar Registration Expiration Date",
  "Expiry Date",
  "Expiration Date",
  "Expiration Time",
  "paid-till",
  "expire",
  "expires",
];

const REGISTRAR_FIELDS = ["Registrar", "registrar"];

function queryWhois(server: string, query: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(43, server);
    let data = "";
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`WHOIS query to ${server} timed out after ${timeoutMs}ms`));
    });
    socket.on("connect", () => socket.write(`${query}\r\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

function findField(text: string, fields: string[]): string | null {
  for (const field of fields) {
    const re = new RegExp(`^\\s*${field}\\s*:\\s*(.+?)\\s*$`, "im");
    const match = re.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export const whoisConnector: Connector<WhoisRaw> = {
  id: "whois",
  title: "WHOIS Registration",
  requiresSecrets: false,
  configSchema,
  defaultIntervalSeconds: 24 * 60 * 60, // 24 hours

  async fetch(ctx: ConnectorRunContext): Promise<WhoisRaw> {
    const { timeoutMs } = configSchema.parse(ctx.config);
    try {
      const tld = ctx.domain.split(".").pop();
      if (!tld) throw new Error(`cannot determine TLD for "${ctx.domain}"`);

      // Step 1: ask IANA which WHOIS server is authoritative for this TLD.
      // IANA TLD records expose it as "whois:"; some registries use "refer:".
      const ianaResponse = await queryWhois("whois.iana.org", tld, timeoutMs);
      const refer = findField(ianaResponse, ["whois", "refer"]);
      if (!refer) throw new Error(`no WHOIS referral server for .${tld}`);

      // Step 2: query the authoritative registry/registrar server.
      const response = await queryWhois(refer, ctx.domain, timeoutMs);
      const expiryDate = findField(response, EXPIRY_FIELDS);
      const registrar = findField(response, REGISTRAR_FIELDS);

      if (!expiryDate) {
        return { expiryDate: null, registrar, error: "no expiry date in WHOIS record" };
      }
      return { expiryDate, registrar };
    } catch (err) {
      return {
        expiryDate: null,
        registrar: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  normalize(raw: WhoisRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };
    const { warnDays } = configSchema.parse(ctx.config);

    if (raw.error || !raw.expiryDate) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "whois",
        severity: "warning",
        title: "WHOIS check failed",
        description: raw.error ?? "No registration expiry date available",
        occurredAt: ctx.now,
      });
      return result;
    }

    const expiry = new Date(raw.expiryDate);
    if (Number.isNaN(expiry.getTime())) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "whois",
        severity: "warning",
        title: "WHOIS check failed",
        description: `Could not parse expiry date "${raw.expiryDate}"`,
        occurredAt: ctx.now,
      });
      return result;
    }

    const daysUntilExpiry = Math.floor(
      (expiry.getTime() - ctx.now.getTime()) / 86_400_000,
    );

    result.metrics.push({
      projectId: ctx.projectId,
      connectorId: "whois",
      kind: "whois",
      name: "whois.days_until_expiry",
      value: daysUntilExpiry,
      unit: "days",
      labels: raw.registrar ? { registrar: raw.registrar } : undefined,
      observedAt: ctx.now,
    });

    if (daysUntilExpiry < 0) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "whois",
        severity: "critical",
        title: "Domain registration expired",
        description: `${ctx.domain} registration expired on ${expiry.toISOString()}`,
        occurredAt: ctx.now,
      });
    } else if (daysUntilExpiry <= warnDays) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "whois",
        severity: "warning",
        title: "Domain registration expiring soon",
        description: `${ctx.domain} registration expires in ${daysUntilExpiry} day(s)`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
