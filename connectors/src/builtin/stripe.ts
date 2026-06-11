import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Max subscription pages to scan (100 per page); guards huge accounts. */
  maxPages: z.number().int().positive().max(50).default(10),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(20_000),
});

const API = "https://api.stripe.com/v1";

interface StripePrice {
  unit_amount: number | null;
  currency: string;
  recurring: { interval: "day" | "week" | "month" | "year"; interval_count: number } | null;
}
interface StripeSubItem {
  quantity?: number;
  price?: StripePrice;
}
interface StripeSubscription {
  id: string;
  currency: string;
  items: { data: StripeSubItem[] };
}
interface StripeList {
  data: StripeSubscription[];
  has_more: boolean;
}

export interface StripeRaw {
  /** Monthly recurring revenue in the account's major currency unit. */
  mrr: number | null;
  currency: string | null;
  activeSubscriptions: number | null;
  error?: string;
}

function emptyRaw(error: string): StripeRaw {
  return { mrr: null, currency: null, activeSubscriptions: null, error };
}

/** Convert one subscription item's price to a monthly amount (major units). */
function itemMrr(item: StripeSubItem): number {
  const price = item.price;
  if (!price || price.unit_amount == null || !price.recurring) return 0;
  const qty = item.quantity ?? 1;
  const amount = (price.unit_amount / 100) * qty;
  const n = price.recurring.interval_count || 1;
  switch (price.recurring.interval) {
    case "month":
      return amount / n;
    case "year":
      return amount / (12 * n);
    case "week":
      return (amount * 52) / 12 / n;
    case "day":
      return (amount * 365) / 12 / n;
    default:
      return 0;
  }
}

export const stripeConnector: Connector<StripeRaw> = {
  id: "stripe",
  title: "Stripe (revenue)",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 6 * 60 * 60, // 6 hours

  async fetch(ctx: ConnectorRunContext): Promise<StripeRaw> {
    const { maxPages, timeoutMs } = configSchema.parse(ctx.config);
    const apiKey = ctx.secrets?.apiKey;
    if (!apiKey) return emptyRaw("missing Stripe secret key (apiKey)");

    let mrr = 0;
    let count = 0;
    let currency: string | null = null;
    let startingAfter: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const params = new URLSearchParams({ status: "active", limit: "100" });
      if (startingAfter) params.set("starting_after", startingAfter);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${API}/subscriptions?${params.toString()}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return emptyRaw(`Stripe returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }
        const list = (await res.json()) as StripeList;
        for (const sub of list.data) {
          count += 1;
          currency ??= sub.currency?.toUpperCase() ?? null;
          for (const item of sub.items?.data ?? []) mrr += itemMrr(item);
        }
        if (!list.has_more || list.data.length === 0) break;
        startingAfter = list.data[list.data.length - 1]?.id;
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
    }

    return {
      mrr: Math.round(mrr * 100) / 100,
      currency,
      activeSubscriptions: count,
    };
  },

  normalize(raw: StripeRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "stripe",
        severity: "warning",
        title: "Stripe revenue check failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    if (raw.mrr !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "stripe",
        kind: "revenue",
        name: "revenue.mrr",
        value: raw.mrr,
        unit: raw.currency ?? undefined,
        observedAt: ctx.now,
      });
    }
    if (raw.activeSubscriptions !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "stripe",
        kind: "revenue",
        name: "revenue.active_subscriptions",
        value: raw.activeSubscriptions,
        observedAt: ctx.now,
      });
    }

    return result;
  },
};
