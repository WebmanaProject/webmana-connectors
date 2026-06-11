import type { ConnectorId } from "@webmana/contracts";
import type { Connector } from "./types.js";
import { sslConnector } from "./builtin/ssl.js";
import { uptimeConnector } from "./builtin/uptime.js";
import { dnsConnector } from "./builtin/dns.js";
import { whoisConnector } from "./builtin/whois.js";
import { pagespeedConnector } from "./builtin/pagespeed.js";
import { uptimerobotConnector } from "./builtin/uptimerobot.js";
import { cloudflareConnector } from "./builtin/cloudflare.js";
import { ga4Connector } from "./builtin/ga4.js";
import { observatoryConnector } from "./builtin/observatory.js";
import { datadogConnector } from "./builtin/datadog.js";
import { elasticsearchConnector } from "./builtin/elasticsearch.js";
import { snykConnector } from "./builtin/snyk.js";
import { awsCostConnector } from "./builtin/aws-cost.js";
import { githubConnector } from "./builtin/github.js";
import { vercelConnector } from "./builtin/vercel.js";
import { stripeConnector } from "./builtin/stripe.js";

/** Connectors that ship in this repo, keyed by id. */
const builtInConnectors: Record<string, Connector> = {
  ssl: sslConnector,
  uptime: uptimeConnector,
  dns: dnsConnector,
  whois: whoisConnector,
  pagespeed: pagespeedConnector,
  uptimerobot: uptimerobotConnector,
  cloudflare: cloudflareConnector,
  ga4: ga4Connector,
  observatory: observatoryConnector,
  datadog: datadogConnector,
  elasticsearch: elasticsearchConnector,
  snyk: snykConnector,
  aws_cost: awsCostConnector,
  github: githubConnector,
  vercel: vercelConnector,
  stripe: stripeConnector,
} satisfies Record<ConnectorId, Connector>;

/**
 * The live registry: built-ins plus any externally-registered connectors.
 * Mutable so {@link registerConnector} can add third-party connectors at boot.
 */
const registry: Record<string, Connector> = { ...builtInConnectors };

/** All connectors currently known to Webmana, keyed by id. */
export const connectors: Readonly<Record<string, Connector>> = registry;

export function getConnector(id: string): Connector | undefined {
  return registry[id];
}

/** True for connectors that ship in this repo (vs. externally registered). */
export function isBuiltInConnector(id: string): boolean {
  return id in builtInConnectors;
}

/**
 * Register an additional connector at runtime (e.g. a third-party package).
 * Throws on a duplicate id so a typo can't silently shadow a built-in.
 */
export function registerConnector(connector: Connector): void {
  if (registry[connector.id]) {
    throw new Error(`connector id "${connector.id}" is already registered`);
  }
  registry[connector.id] = connector;
}
