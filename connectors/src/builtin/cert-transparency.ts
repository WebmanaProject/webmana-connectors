import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Treat certificates issued within this many hours as "new". */
  windowHours: z.number().int().positive().default(24),
  /** Include already-expired certificates in the totals. */
  includeExpired: z.boolean().default(false),
  /** Request timeout in milliseconds (crt.sh can be slow). */
  timeoutMs: z.number().int().positive().default(20_000),
});

export interface CtCert {
  issuer: string;
  commonName: string;
  notBefore: string;
  notAfter: string;
}

export interface CertTransparencyRaw {
  certs: CtCert[];
  error?: string;
}

interface CrtShEntry {
  issuer_name?: string;
  common_name?: string;
  name_value?: string;
  not_before?: string;
  not_after?: string;
  id?: number;
}

/**
 * Certificate Transparency connector — queries the public crt.sh CT-log mirror
 * for certificates issued for the domain (and its subdomains). Surfaces newly
 * issued certificates so an unexpected/rogue certificate doesn't go unnoticed.
 * No API key required.
 */
export const certTransparencyConnector: Connector<CertTransparencyRaw> = {
  id: "cert_transparency",
  title: "Certificate Transparency",
  requiresSecrets: false,
  configSchema,
  defaultIntervalSeconds: 12 * 60 * 60, // 12 hours

  async fetch(ctx: ConnectorRunContext): Promise<CertTransparencyRaw> {
    const { includeExpired, timeoutMs } = configSchema.parse(ctx.config);
    const params = new URLSearchParams({ q: `%.${ctx.domain}`, output: "json" });
    if (!includeExpired) params.set("exclude", "expired");
    const url = `https://crt.sh/?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "webmana-connector" },
        signal: controller.signal,
      });
      if (!res.ok) {
        return { certs: [], error: `crt.sh returned HTTP ${res.status}` };
      }
      const text = await res.text();
      if (!text.trim()) return { certs: [] }; // crt.sh returns empty body for no results
      let entries: CrtShEntry[];
      try {
        entries = JSON.parse(text) as CrtShEntry[];
      } catch {
        return { certs: [], error: "crt.sh returned a non-JSON response" };
      }

      // crt.sh emits one row per CT-log entry, so the same certificate repeats.
      // Dedupe by issuer + commonName + notBefore.
      const seen = new Set<string>();
      const certs: CtCert[] = [];
      for (const e of entries) {
        const cert: CtCert = {
          issuer: e.issuer_name ?? "unknown",
          commonName: e.common_name ?? e.name_value ?? ctx.domain,
          notBefore: e.not_before ?? "",
          notAfter: e.not_after ?? "",
        };
        const key = `${cert.issuer}|${cert.commonName}|${cert.notBefore}`;
        if (seen.has(key)) continue;
        seen.add(key);
        certs.push(cert);
      }
      return { certs };
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? `request timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return { certs: [], error: message };
    } finally {
      clearTimeout(timer);
    }
  },

  normalize(raw: CertTransparencyRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };
    const { windowHours } = configSchema.parse(ctx.config);

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "cert_transparency",
        severity: "warning",
        title: "Certificate Transparency check failed",
        description: `Could not query crt.sh for ${ctx.domain}: ${raw.error}`,
        occurredAt: ctx.now,
      });
      return result;
    }

    const cutoff = ctx.now.getTime() - windowHours * 3_600_000;
    const recent = raw.certs.filter((c) => {
      const t = new Date(c.notBefore).getTime();
      return !Number.isNaN(t) && t >= cutoff;
    });

    result.metrics.push(
      {
        projectId: ctx.projectId,
        connectorId: "cert_transparency",
        kind: "security",
        name: "cert_transparency.certs_total",
        value: raw.certs.length,
        observedAt: ctx.now,
      },
      {
        projectId: ctx.projectId,
        connectorId: "cert_transparency",
        kind: "security",
        name: "cert_transparency.certs_new",
        value: recent.length,
        observedAt: ctx.now,
      },
    );

    if (recent.length > 0) {
      const issuers = [...new Set(recent.map((c) => c.issuer))].slice(0, 5).join("; ");
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "cert_transparency",
        severity: "info",
        title: "New certificate(s) issued",
        description: `${recent.length} certificate(s) for ${ctx.domain} appeared in CT logs in the last ${windowHours}h. Issuer(s): ${issuers}. Confirm they're expected.`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
