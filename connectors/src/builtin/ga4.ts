import { createSign } from "node:crypto";
import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** GA4 property id, e.g. "123456789" (numeric, without the "properties/" prefix). */
  propertyId: z.string().min(1),
  /** How many days back to aggregate, ending yesterday. */
  lookbackDays: z.number().int().positive().default(1),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(20_000),
});

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export interface Ga4Raw {
  sessions: number | null;
  activeUsers: number | null;
  newUsers: number | null;
  screenPageViews: number | null;
  error?: string;
}

function emptyRaw(error: string): Ga4Raw {
  return {
    sessions: null,
    activeUsers: null,
    newUsers: null,
    screenPageViews: null,
    error,
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a short-lived OAuth2 access token from a service account JWT (RS256). */
async function getAccessToken(
  clientEmail: string,
  privateKey: string,
  timeoutMs: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = base64url(
    createSign("RSA-SHA256").update(signingInput).sign(privateKey),
  );
  const assertion = `${signingInput}.${signature}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.access_token) {
      const detail = data.error_description ?? data.error ?? `HTTP ${res.status}`;
      throw new Error(`token exchange failed: ${detail}`);
    }
    return data.access_token;
  } finally {
    clearTimeout(timer);
  }
}

interface ReportResponse {
  rows?: { metricValues?: { value?: string }[] }[];
  error?: { message?: string };
}

export const ga4Connector: Connector<Ga4Raw> = {
  id: "ga4",
  title: "Google Analytics 4",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 6 * 60 * 60, // 6 hours

  async fetch(ctx: ConnectorRunContext): Promise<Ga4Raw> {
    const { propertyId, lookbackDays, timeoutMs } = configSchema.parse(ctx.config);
    const clientEmail = ctx.secrets?.clientEmail;
    const privateKey = ctx.secrets?.privateKey?.replace(/\\n/g, "\n");
    if (!clientEmail || !privateKey) {
      return emptyRaw("missing GA4 service account credentials (clientEmail/privateKey)");
    }

    let token: string;
    try {
      token = await getAccessToken(clientEmail, privateKey, timeoutMs);
    } catch (err) {
      return emptyRaw(err instanceof Error ? err.message : String(err));
    }

    const startDate = `${lookbackDays}daysAgo`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            dateRanges: [{ startDate, endDate: "yesterday" }],
            metrics: [
              { name: "sessions" },
              { name: "activeUsers" },
              { name: "newUsers" },
              { name: "screenPageViews" },
            ],
          }),
          signal: controller.signal,
        },
      );
      const data = (await res.json().catch(() => ({}))) as ReportResponse;
      if (!res.ok || data.error) {
        return emptyRaw(data.error?.message ?? `GA4 returned HTTP ${res.status}`);
      }

      const values = data.rows?.[0]?.metricValues ?? [];
      const num = (i: number): number | null => {
        const v = Number.parseFloat(values[i]?.value ?? "");
        return Number.isFinite(v) ? v : null;
      };
      return {
        sessions: num(0),
        activeUsers: num(1),
        newUsers: num(2),
        screenPageViews: num(3),
      };
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? `request timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return emptyRaw(message);
    } finally {
      clearTimeout(timer);
    }
  },

  normalize(raw: Ga4Raw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "ga4",
        severity: "warning",
        title: "GA4 check failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    const push = (name: string, value: number | null) => {
      if (value === null) return;
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "ga4",
        kind: "traffic",
        name,
        value,
        observedAt: ctx.now,
      });
    };

    push("ga4.sessions", raw.sessions);
    push("ga4.active_users", raw.activeUsers);
    push("ga4.new_users", raw.newUsers);
    push("ga4.page_views", raw.screenPageViews);

    return result;
  },
};
