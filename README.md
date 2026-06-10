# Webmana Connectors

The **Apache-2.0** connector SDK for [Webmana](https://github.com/WebmanaProject/webmana) —
a self-hosted multi-domain monitoring dashboard.

This repository is intentionally separate from the Webmana application (which is
AGPL-3.0) so you can **write and publish connectors freely**, under a permissive
license, without your code being subject to the AGPL.

## Packages

| Package | Description |
|---|---|
| `@webmana/contracts` | Shared Zod schemas + types (metrics, events, connector ids) |
| `@webmana/connectors` | Connector SDK, built-in connectors, and the runtime loader |
| `create-webmana-connector` | `npm create` scaffold for a new connector package |

## Write a connector

```bash
npm create webmana-connector@latest my-thing
cd webmana-connector-my-thing
npm install
npm run build && npm test
```

A connector implements two methods:

- `fetch(ctx)` — does all I/O, never throws for expected failures (returns a raw
  object with an `error` field), always uses an `AbortController` timeout.
- `normalize(raw, ctx)` — **pure**: maps the raw payload to metrics + events.

See [`connectors/CONNECTORS.md`](connectors/CONNECTORS.md) for the full guide.

## How Webmana discovers your connector

Publish a package that either is named `webmana-connector-*` or sets
`"webmana": { "connector": true }` in its `package.json`, and exports a
`connector`. The Webmana worker auto-registers it at boot — no fork required.

```bash
pnpm --filter @webmana/worker add webmana-connector-my-thing
# restart the worker
```

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — DCO sign-off, package conventions,
testing, and publishing.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
