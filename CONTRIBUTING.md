# Contributing to Webmana Connectors

Thanks for building a connector! This repo is **Apache-2.0** and independent of
the Webmana application (AGPL-3.0), so you can write, publish, and distribute
connectors under a permissive license without copyleft obligations.

## Developer Certificate of Origin (DCO)

All commits must be signed off under the
[DCO](https://developercertificate.org/):

```bash
git commit -s -m "feat: add my connector"
```

This appends a `Signed-off-by:` trailer certifying you have the right to submit
the code. PRs without sign-off on every commit can't be merged.

## Scaffold a connector

```bash
npm create webmana-connector@latest my-thing
cd webmana-connector-my-thing
npm install
npm run build && npm test
```

You get a complete package: `package.json` (with the discovery hints below),
`tsconfig.json`, a `fetch`/`normalize` connector in `src/index.ts`, and a
`node:test` unit test.

## Package conventions

For Webmana to auto-discover your connector at boot, the package must:

1. **Identify itself** in one of these ways:
   - name it `webmana-connector-<slug>`, or
   - set `"webmana": { "connector": true }` in `package.json`, or
   - add `"webmana-connector"` to `keywords`.
2. **Export the connector** as a named `connector` export (or default):

   ```ts
   import type { Connector } from "@webmana/connectors";
   export const connector: Connector = { id: "my-thing", /* … */ };
   ```
3. **Depend only on `@webmana/connectors`** (for types) — never on the Webmana
   app. `@webmana/connectors` and `zod` should be `peerDependencies`.

## The two methods

- **`fetch(ctx)`** — does all I/O. It must **never throw for an expected
  failure**: return a raw object carrying an `error` field instead. Always wrap
  network calls in an `AbortController` timeout. `ctx` provides `projectId`,
  `domain`, validated `config`, optional `secrets`, and `now`.
- **`normalize(raw, ctx)`** — **pure**. Maps the raw payload to `metrics` and
  `events`. No I/O, no side effects — this is what makes connectors trivially
  testable.

Connector `id` and metric `kind` are open lowercase slugs (`^[a-z0-9_-]+$`);
pick something unique and stable. Secrets are decrypted by the worker and passed
in `ctx.secrets` — never log them.

## Testing

`normalize` is pure, so unit-test it directly with mock `Raw` data. Cover at
least: a successful run, a partial/missing-value run, and the `error` path.
`fetch` usually needs real credentials, so `normalize` is the correctness gate.

```bash
npm test
```

## Publishing

1. Bump the version in `package.json`.
2. `npm publish --access public`.
3. Users install it next to the worker and restart:
   ```bash
   pnpm --filter @webmana/worker add webmana-connector-my-thing
   ```

## Code style

- TypeScript, `NodeNext` modules; import local files with the `.js` extension.
- Keep connectors read-only: poll and report, never mutate the remote service.
- All user-facing strings in English.

## Reporting security issues

Don't open public issues for vulnerabilities — contact the maintainers privately
so a fix can be prepared before disclosure.
