import tls from "node:tls";
import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  port: z.number().int().positive().default(443),
  /** Emit a warning event when the cert expires within this many days. */
  warnDays: z.number().int().positive().default(14),
  /** TLS connection timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(10_000),
});

export interface SslRaw {
  validTo: string | null;
  validFrom: string | null;
  issuer: string | null;
  error?: string;
}

function firstString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function getCertificate(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<tls.PeerCertificate> {
  return new Promise((resolve, reject) => {
    // rejectUnauthorized:false so we can still inspect expired/untrusted certs
    // (this is monitoring, not a trust decision for a real connection).
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || Object.keys(cert).length === 0) {
          reject(new Error("no certificate presented"));
        } else {
          resolve(cert);
        }
      },
    );
    socket.once("error", reject);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`TLS connection timed out after ${timeoutMs}ms`));
    });
  });
}

export const sslConnector: Connector<SslRaw> = {
  id: "ssl",
  title: "SSL Certificate",
  requiresSecrets: false,
  configSchema,
  defaultIntervalSeconds: 6 * 60 * 60, // 6 hours

  async fetch(ctx: ConnectorRunContext): Promise<SslRaw> {
    const { port, timeoutMs } = configSchema.parse(ctx.config);
    try {
      const cert = await getCertificate(ctx.domain, port, timeoutMs);
      const issuer =
        cert.issuer && typeof cert.issuer === "object"
          ? (firstString(cert.issuer.O) ?? firstString(cert.issuer.CN))
          : null;
      return {
        validTo: cert.valid_to ?? null,
        validFrom: cert.valid_from ?? null,
        issuer,
      };
    } catch (err) {
      return {
        validTo: null,
        validFrom: null,
        issuer: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  normalize(raw: SslRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };
    const { warnDays } = configSchema.parse(ctx.config);

    if (raw.error || !raw.validTo) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "ssl",
        severity: "critical",
        title: "SSL check failed",
        description: raw.error ?? "No certificate expiry date available",
        occurredAt: ctx.now,
      });
      return result;
    }

    const validTo = new Date(raw.validTo);
    const daysUntilExpiry = Math.floor(
      (validTo.getTime() - ctx.now.getTime()) / 86_400_000,
    );

    result.metrics.push({
      projectId: ctx.projectId,
      connectorId: "ssl",
      kind: "ssl",
      name: "ssl.days_until_expiry",
      value: daysUntilExpiry,
      unit: "days",
      labels: raw.issuer ? { issuer: raw.issuer } : undefined,
      observedAt: ctx.now,
    });

    if (daysUntilExpiry < 0) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "ssl",
        severity: "critical",
        title: "SSL certificate expired",
        description: `Certificate for ${ctx.domain} expired on ${validTo.toISOString()}`,
        occurredAt: ctx.now,
      });
    } else if (daysUntilExpiry <= warnDays) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "ssl",
        severity: "warning",
        title: "SSL certificate expiring soon",
        description: `Certificate for ${ctx.domain} expires in ${daysUntilExpiry} day(s)`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
