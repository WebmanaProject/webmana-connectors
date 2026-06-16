import dns from "node:dns/promises";
import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /**
   * DKIM selectors to probe at `<selector>._domainkey.<domain>`. DKIM has no
   * way to enumerate selectors, so we check the common provider defaults.
   */
  dkimSelectors: z
    .array(z.string().min(1))
    .default(["default", "google", "selector1", "selector2", "k1", "dkim", "mail", "s1", "s2"]),
  /** Warn when DMARC is present but only monitoring (p=none). */
  warnOnDmarcMonitorOnly: z.boolean().default(true),
  /** Resolution timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(10_000),
});

export interface EmailAuthRaw {
  spfPresent: boolean;
  spfPolicy: string | null; // "-all" | "~all" | "?all" | "+all" | null
  dmarcPresent: boolean;
  dmarcPolicy: string | null; // "none" | "quarantine" | "reject" | null
  dkimPresent: boolean;
  dkimSelector: string | null;
  error?: string;
}

/** Resolve TXT records, treating "no such record" as an empty list. */
async function lookupTxt(resolver: dns.Resolver, name: string): Promise<string[]> {
  try {
    const records = await resolver.resolveTxt(name);
    // Each TXT record is an array of string chunks that must be concatenated.
    return records.map((chunks) => chunks.join(""));
  } catch (err) {
    if (err instanceof Error && /ENODATA|ENOTFOUND/.test(err.message)) return [];
    throw err;
  }
}

const SPF_ALL_RE = /[~\-+?]all/i;

export const emailAuthConnector: Connector<EmailAuthRaw> = {
  id: "email_auth",
  title: "Email Auth (SPF/DKIM/DMARC)",
  requiresSecrets: false,
  configSchema,
  defaultIntervalSeconds: 12 * 60 * 60, // 12 hours

  async fetch(ctx: ConnectorRunContext): Promise<EmailAuthRaw> {
    const { dkimSelectors, timeoutMs } = configSchema.parse(ctx.config);
    const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 2 });
    try {
      // SPF: a TXT record on the root domain starting with v=spf1.
      const rootTxt = await lookupTxt(resolver, ctx.domain);
      const spf = rootTxt.find((r) => /^v=spf1\b/i.test(r.trim())) ?? null;
      const spfMatch = spf ? SPF_ALL_RE.exec(spf) : null;

      // DMARC: a TXT record at _dmarc.<domain> with v=DMARC1 and a p= policy.
      const dmarcTxt = await lookupTxt(resolver, `_dmarc.${ctx.domain}`);
      const dmarc = dmarcTxt.find((r) => /^v=DMARC1\b/i.test(r.trim())) ?? null;
      const pMatch = dmarc ? /\bp=\s*(none|quarantine|reject)/i.exec(dmarc) : null;

      // DKIM: probe common selectors; report the first that looks like a key.
      let dkimSelector: string | null = null;
      for (const sel of dkimSelectors) {
        const txt = await lookupTxt(resolver, `${sel}._domainkey.${ctx.domain}`);
        if (txt.some((r) => /v=DKIM1|(?:^|;)\s*k=|(?:^|;)\s*p=/i.test(r))) {
          dkimSelector = sel;
          break;
        }
      }

      return {
        spfPresent: spf !== null,
        spfPolicy: spfMatch?.[0]?.toLowerCase() ?? null,
        dmarcPresent: dmarc !== null,
        dmarcPolicy: pMatch?.[1]?.toLowerCase() ?? null,
        dkimPresent: dkimSelector !== null,
        dkimSelector,
      };
    } catch (err) {
      return {
        spfPresent: false,
        spfPolicy: null,
        dmarcPresent: false,
        dmarcPolicy: null,
        dkimPresent: false,
        dkimSelector: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  normalize(raw: EmailAuthRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };
    const { warnOnDmarcMonitorOnly } = configSchema.parse(ctx.config);

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "email_auth",
        severity: "warning",
        title: "Email auth check failed",
        description: `Could not read DNS for ${ctx.domain}: ${raw.error}`,
        occurredAt: ctx.now,
      });
      return result;
    }

    const present = [raw.spfPresent, raw.dkimPresent, raw.dmarcPresent];
    const score = present.filter(Boolean).length; // 0..3

    result.metrics.push(
      {
        projectId: ctx.projectId,
        connectorId: "email_auth",
        kind: "security",
        name: "email_auth.spf",
        value: raw.spfPresent ? 1 : 0,
        labels: raw.spfPolicy ? { policy: raw.spfPolicy } : undefined,
        observedAt: ctx.now,
      },
      {
        projectId: ctx.projectId,
        connectorId: "email_auth",
        kind: "security",
        name: "email_auth.dkim",
        value: raw.dkimPresent ? 1 : 0,
        labels: raw.dkimSelector ? { selector: raw.dkimSelector } : undefined,
        observedAt: ctx.now,
      },
      {
        projectId: ctx.projectId,
        connectorId: "email_auth",
        kind: "security",
        name: "email_auth.dmarc",
        value: raw.dmarcPresent ? 1 : 0,
        labels: raw.dmarcPolicy ? { policy: raw.dmarcPolicy } : undefined,
        observedAt: ctx.now,
      },
      {
        projectId: ctx.projectId,
        connectorId: "email_auth",
        kind: "security",
        name: "email_auth.score",
        value: score,
        unit: "of 3",
        observedAt: ctx.now,
      },
    );

    // No DMARC at all: the domain can be spoofed in From: headers.
    if (!raw.dmarcPresent) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "email_auth",
        severity: "warning",
        title: "No DMARC record",
        description: `${ctx.domain} has no DMARC policy — the domain can be spoofed in email`,
        occurredAt: ctx.now,
      });
    } else if (raw.dmarcPolicy === "none" && warnOnDmarcMonitorOnly) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "email_auth",
        severity: "info",
        title: "DMARC is monitor-only (p=none)",
        description: `${ctx.domain} publishes DMARC but does not enforce it (p=none)`,
        occurredAt: ctx.now,
      });
    }

    if (!raw.spfPresent) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "email_auth",
        severity: "warning",
        title: "No SPF record",
        description: `${ctx.domain} has no SPF record — mail may fail authentication`,
        occurredAt: ctx.now,
      });
    } else if (raw.spfPolicy === "+all") {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "email_auth",
        severity: "critical",
        title: "Dangerous SPF policy (+all)",
        description: `${ctx.domain} SPF ends in "+all", which authorizes any server to send as the domain`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
