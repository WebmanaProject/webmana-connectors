#!/usr/bin/env node
// Scaffold a new Webmana connector package. Zero dependencies.
//
//   npm create webmana-connector@latest my-thing
//   node index.js my-thing [--dir <path>]
//
// Produces a publish-ready `webmana-connector-<slug>` package that Webmana
// auto-discovers at boot. See docs/CONNECTORS.md in the main repo.

import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const SDK_VERSION = "^0.1.0";

function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Parse argv: first non-flag is the name; supports --dir <path>. */
function parseArgs(argv) {
  let name;
  let dir;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") {
      dir = argv[++i];
    } else if (!a.startsWith("-") && !name) {
      name = a;
    }
  }
  return { name, dir };
}

function titleCase(slug) {
  return slug
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

const files = (slug, pkgName, title) => ({
  "package.json":
    JSON.stringify(
      {
        name: pkgName,
        version: "0.1.0",
        description: `Webmana connector: ${title}`,
        license: "Apache-2.0",
        type: "module",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
        files: ["dist"],
        // How Webmana discovers this package at boot:
        webmana: { connector: true },
        keywords: ["webmana", "webmana-connector", slug],
        scripts: {
          build: "tsc -p tsconfig.json",
          test: "node --test",
        },
        peerDependencies: { "@webmana/connectors": SDK_VERSION },
        devDependencies: {
          "@webmana/connectors": SDK_VERSION,
          "@types/node": "^22.10.5",
          typescript: "^5.7.3",
          zod: "^3.24.1",
        },
      },
      null,
      2,
    ) + "\n",

  "tsconfig.json":
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          declaration: true,
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          outDir: "dist",
          rootDir: "src",
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",

  ".gitignore": "node_modules\ndist\n",

  "README.md": `# ${pkgName}

A [Webmana](https://github.com/WebmanaProject/webmana) connector: **${title}**.

## Install

\`\`\`bash
pnpm --filter @webmana/worker add ${pkgName}
# then restart the worker; Webmana auto-discovers it at boot
\`\`\`

## Develop

\`\`\`bash
npm install
npm run build
npm test
\`\`\`

Edit \`src/index.ts\`. A connector implements two methods:

- \`fetch(ctx)\` — does all I/O, never throws for expected failures (return a raw
  object with an \`error\` field instead), always uses an AbortController timeout.
- \`normalize(raw, ctx)\` — pure: maps the raw payload to metrics + events.

Licensed Apache-2.0 — independent of Webmana's AGPL application.
`,

  "src/index.ts": `import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "@webmana/connectors";

/** Non-secret settings for this connector instance. */
const configSchema = z.object({
  /** Example setting. Replace with your own. */
  endpoint: z.string().url().optional(),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(15_000),
});

export interface ${titleCase(slug).replace(/\s+/g, "")}Raw {
  value: number | null;
  error?: string;
}

function emptyRaw(error: string): ${titleCase(slug).replace(/\s+/g, "")}Raw {
  return { value: null, error };
}

export const connector: Connector<${titleCase(slug).replace(/\s+/g, "")}Raw> = {
  id: "${slug}",
  title: "${title}",
  requiresSecrets: false,
  configSchema,
  defaultIntervalSeconds: 15 * 60, // 15 minutes

  async fetch(ctx: ConnectorRunContext): Promise<${titleCase(slug).replace(/\s+/g, "")}Raw> {
    const { endpoint, timeoutMs } = configSchema.parse(ctx.config);
    // const token = ctx.secrets?.token; // if requiresSecrets is true

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Replace with a real request. ctx.domain is the project's domain.
      const url = endpoint ?? \`https://\${ctx.domain}\`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return emptyRaw(\`${title} returned HTTP \${res.status}\`);
      return { value: res.status };
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? \`request timed out after \${timeoutMs}ms\`
          : err instanceof Error
            ? err.message
            : String(err);
      return emptyRaw(message);
    } finally {
      clearTimeout(timer);
    }
  },

  normalize(raw, ctx): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "${slug}",
        severity: "warning",
        title: "${title} check failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    if (raw.value !== null) {
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "${slug}",
        kind: "uptime",
        name: "${slug}.value",
        value: raw.value,
        observedAt: ctx.now,
      });
    }

    return result;
  },
};

export default connector;
`,

  "src/index.test.ts": `import { test } from "node:test";
import assert from "node:assert/strict";
import { connector } from "./index.js";

const ctx = {
  projectId: "00000000-0000-0000-0000-000000000000",
  domain: "example.com",
  config: {},
  now: new Date("2026-01-01T00:00:00Z"),
};

test("normalize: good value -> one metric, no events", () => {
  const res = connector.normalize({ value: 200 }, ctx);
  assert.equal(res.metrics.length, 1);
  assert.equal(res.metrics[0].name, "${slug}.value");
  assert.equal(res.events.length, 0);
});

test("normalize: error -> warning event, no metrics", () => {
  const res = connector.normalize({ value: null, error: "boom" }, ctx);
  assert.equal(res.metrics.length, 0);
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].severity, "warning");
});
`,
});

async function main() {
  const { name, dir } = parseArgs(process.argv.slice(2));
  if (!name) {
    console.error("Usage: create-webmana-connector <name> [--dir <path>]");
    process.exit(1);
  }

  const slug = slugify(name);
  if (!slug) {
    console.error(`Invalid connector name: "${name}"`);
    process.exit(1);
  }
  const pkgName = `webmana-connector-${slug}`;
  const title = titleCase(slug);
  const target = resolve(dir ?? pkgName);

  // Refuse to clobber a non-empty directory.
  try {
    const existing = await readdir(target);
    if (existing.length > 0) {
      console.error(`Target directory "${target}" exists and is not empty.`);
      process.exit(1);
    }
  } catch {
    /* does not exist — good */
  }

  const tree = files(slug, pkgName, title);
  for (const [rel, content] of Object.entries(tree)) {
    const full = join(target, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  console.log(`\n✓ Created ${pkgName} in ${target}\n`);
  console.log("Next steps:");
  console.log(`  cd ${dir ?? pkgName}`);
  console.log("  npm install");
  console.log("  npm run build && npm test");
  console.log("  # edit src/index.ts, then publish to npm\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
