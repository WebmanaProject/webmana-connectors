import { createRequire } from "node:module";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { connectorIdSchema } from "@webmana/contracts";
import type { Connector } from "./types.js";
import { getConnector, registerConnector } from "./registry.js";

/**
 * Discovery + loading of third-party connector packages.
 *
 * Connectors live in their own Apache-2.0 SDK and ship as standalone npm
 * packages, so developers can publish a connector without touching (or being
 * bound by) the AGPL application. A connector package must:
 *   - be named `webmana-connector-*` OR declare `"webmana": { "connector": true }`
 *     (or the keyword "webmana-connector") in its package.json, and
 *   - export a `connector` (or default) matching the {@link Connector} shape.
 *
 * Packages can also be listed explicitly via the WEBMANA_CONNECTORS env var
 * (comma-separated module names), which skips the node_modules scan.
 */

export interface LoadResult {
  loaded: string[];
  failed: { pkg: string; error: string }[];
}

/** Structural validation — external code is untrusted, so check the shape. */
export function isValidConnector(value: unknown): value is Connector {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  if (!connectorIdSchema.safeParse(c.id).success) return false;
  if (typeof c.title !== "string" || c.title.length === 0) return false;
  if (typeof c.requiresSecrets !== "boolean") return false;
  if (typeof c.defaultIntervalSeconds !== "number" || c.defaultIntervalSeconds <= 0) {
    return false;
  }
  if (typeof c.fetch !== "function" || typeof c.normalize !== "function") return false;
  if (!c.configSchema || typeof (c.configSchema as { safeParse?: unknown }).safeParse !== "function") {
    return false;
  }
  return true;
}

/** Pull the connector export out of a loaded module (named or default). */
function extractConnector(mod: Record<string, unknown>): unknown {
  if (isValidConnector(mod.connector)) return mod.connector;
  if (isValidConnector(mod.default)) return mod.default;
  // default-as-namespace (esModule interop)
  const def = mod.default as Record<string, unknown> | undefined;
  if (def && isValidConnector(def.connector)) return def.connector;
  return mod.connector ?? mod.default;
}

/** Names of installed packages that look like Webmana connectors. */
async function discoverPackages(req: NodeRequire): Promise<string[]> {
  const explicit = process.env.WEBMANA_CONNECTORS?.trim();
  if (explicit) {
    return explicit.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Scan node_modules (incl. one scope level) for connector packages.
  const roots = new Set<string>();
  // require.resolve.paths gives the node_modules lookup chain from here.
  for (const base of req.resolve.paths("@webmana/connectors") ?? []) {
    roots.add(base);
  }
  try {
    const resolved = req.resolve("@webmana/connectors");
    const idx = resolved.lastIndexOf("node_modules");
    if (idx !== -1) roots.add(resolved.slice(0, idx + "node_modules".length));
  } catch {
    /* ignore */
  }

  const found = new Set<string>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith("webmana-connector-")) {
        found.add(name);
      } else if (name.startsWith("@")) {
        // Scoped: scan one level deeper.
        try {
          const scoped = await readdir(`${root}/${name}`);
          for (const sub of scoped) {
            if (await looksLikeConnector(`${root}/${name}/${sub}`, sub)) {
              found.add(`${name}/${sub}`);
            }
          }
        } catch {
          /* ignore */
        }
      } else if (await looksLikeConnector(`${root}/${name}`, name)) {
        found.add(name);
      }
    }
  }
  return [...found];
}

/** A package is a connector if its name matches or its package.json opts in. */
async function looksLikeConnector(dir: string, name: string): Promise<boolean> {
  if (name.startsWith("webmana-connector-")) return true;
  try {
    const pkg = JSON.parse(await readFile(`${dir}/package.json`, "utf8")) as {
      keywords?: string[];
      webmana?: { connector?: boolean };
    };
    if (pkg.webmana?.connector === true) return true;
    if (pkg.keywords?.includes("webmana-connector")) return true;
  } catch {
    /* not a package / no manifest */
  }
  return false;
}

/**
 * Discover and register all external connector packages. Failures are isolated
 * per package and reported; one bad connector never blocks the others or boot.
 */
export async function loadExternalConnectors(
  importer: (name: string) => Promise<unknown> = (n) => import(n),
): Promise<LoadResult> {
  // Resolve from the host app's working directory so its node_modules (where
  // connector packages are installed) is the lookup root. Works under both
  // ESM and CommonJS builds (no import.meta).
  const req = createRequire(join(process.cwd(), "index.js"));
  const result: LoadResult = { loaded: [], failed: [] };

  let packages: string[];
  try {
    packages = await discoverPackages(req);
  } catch (err) {
    return { loaded: [], failed: [{ pkg: "(discovery)", error: String(err) }] };
  }

  for (const pkg of packages) {
    try {
      const mod = (await importer(pkg)) as Record<string, unknown>;
      const candidate = extractConnector(mod);
      if (!isValidConnector(candidate)) {
        result.failed.push({ pkg, error: "no valid `connector` export" });
        continue;
      }
      if (getConnector(candidate.id)) {
        result.failed.push({ pkg, error: `id "${candidate.id}" already registered` });
        continue;
      }
      registerConnector(candidate);
      result.loaded.push(`${pkg} → ${candidate.id}`);
    } catch (err) {
      result.failed.push({ pkg, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
