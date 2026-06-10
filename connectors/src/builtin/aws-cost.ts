import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Cost Explorer is a global service reached via the us-east-1 endpoint. */
  region: z.string().min(1).default("us-east-1"),
  /** Cost metric to report; UnblendedCost is the common default. */
  metric: z.string().min(1).default("UnblendedCost"),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(20_000),
});

const SERVICE = "ce";
const TARGET = "AWSInsightsIndexService.GetCostAndUsage";

export interface AwsCostRaw {
  amount: number | null;
  unit: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  error?: string;
}

function emptyRaw(error: string): AwsCostRaw {
  return { amount: null, unit: null, periodStart: null, periodEnd: null, error };
}

const sha256Hex = (data: string): string =>
  createHash("sha256").update(data, "utf8").digest("hex");

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

export interface SignParams {
  method: string;
  host: string;
  path: string;
  region: string;
  service: string;
  headers: Record<string, string>;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** ISO basic format, e.g. "20150830T123600Z". */
  amzDate: string;
}

/** Compute an AWS Signature Version 4 Authorization header value. */
export function signRequestV4(p: SignParams): string {
  const dateStamp = p.amzDate.slice(0, 8);

  // Normalize header names to lowercase, collapse internal whitespace, then sort.
  const normalized = Object.entries(p.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = normalized.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = normalized.map(([k]) => k).join(";");

  const canonicalRequest = [
    p.method,
    p.path,
    "", // canonical query string
    canonicalHeaders,
    signedHeaders,
    sha256Hex(p.body),
  ].join("\n");

  const scope = `${dateStamp}/${p.region}/${p.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    p.amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${p.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, p.region);
  const kService = hmac(kRegion, p.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  return `AWS4-HMAC-SHA256 Credential=${p.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** First day of the current UTC month, "YYYY-MM-DD". */
function monthStart(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** First day of the next UTC month, "YYYY-MM-DD" (Cost Explorer end is exclusive). */
function nextMonthStart(now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const ny = m === 11 ? y + 1 : y;
  const nm = m === 11 ? 0 : m + 1;
  return `${ny}-${String(nm + 1).padStart(2, "0")}-01`;
}

export const awsCostConnector: Connector<AwsCostRaw> = {
  id: "aws_cost",
  title: "AWS Cost Explorer",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 12 * 60 * 60, // 12 hours

  async fetch(ctx: ConnectorRunContext): Promise<AwsCostRaw> {
    const { region, metric, timeoutMs } = configSchema.parse(ctx.config);
    const accessKeyId = ctx.secrets?.accessKeyId;
    const secretAccessKey = ctx.secrets?.secretAccessKey;
    if (!accessKeyId || !secretAccessKey) {
      return emptyRaw("missing AWS credentials (accessKeyId/secretAccessKey)");
    }

    const host = `ce.${region}.amazonaws.com`;
    const start = monthStart(ctx.now);
    const end = nextMonthStart(ctx.now);
    const body = JSON.stringify({
      TimePeriod: { Start: start, End: end },
      Granularity: "MONTHLY",
      Metrics: [metric],
    });

    const amzDate = ctx.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/x-amz-json-1.1",
      Host: host,
      "X-Amz-Date": amzDate,
      "X-Amz-Target": TARGET,
    };
    const authorization = signRequestV4({
      method: "POST",
      host,
      path: "/",
      region,
      service: SERVICE,
      headers,
      body,
      accessKeyId,
      secretAccessKey,
      amzDate,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`https://${host}/`, {
        method: "POST",
        headers: { ...headers, Authorization: authorization },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        return emptyRaw(
          `AWS Cost Explorer returned HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`,
        );
      }
      const data = (await res.json()) as {
        ResultsByTime?: {
          TimePeriod?: { Start?: string; End?: string };
          Total?: Record<string, { Amount?: string; Unit?: string }>;
        }[];
      };
      const period = data.ResultsByTime?.[0];
      const total = period?.Total?.[metric];
      const amount = Number.parseFloat(total?.Amount ?? "");
      return {
        amount: Number.isFinite(amount) ? amount : null,
        unit: total?.Unit ?? null,
        periodStart: period?.TimePeriod?.Start ?? start,
        periodEnd: period?.TimePeriod?.End ?? end,
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

  normalize(raw: AwsCostRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "aws_cost",
        severity: "warning",
        title: "AWS Cost Explorer check failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    if (raw.amount !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "aws_cost",
        kind: "cost",
        name: "aws_cost.month_to_date",
        value: raw.amount,
        unit: raw.unit ?? undefined,
        labels: raw.periodStart ? { period: raw.periodStart } : undefined,
        observedAt: ctx.now,
      });
    }

    return result;
  },
};
