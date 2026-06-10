import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Repository in "owner/name" form, e.g. "vercel/next.js". */
  repo: z.string().regex(/^[^/]+\/[^/]+$/, 'repo must be "owner/name"'),
  /** Warn when no commit has landed for this many days. */
  staleDays: z.number().int().positive().default(30),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(15_000),
});

export interface GithubRaw {
  daysSincePush: number | null;
  openIssues: number | null;
  defaultBranch: string | null;
  lastCommitSha: string | null;
  archived: boolean | null;
  error?: string;
}

function emptyRaw(error: string): GithubRaw {
  return {
    daysSincePush: null,
    openIssues: null,
    defaultBranch: null,
    lastCommitSha: null,
    archived: null,
    error,
  };
}

interface RepoResponse {
  pushed_at?: string;
  open_issues_count?: number;
  default_branch?: string;
  archived?: boolean;
}

interface CommitResponse {
  sha?: string;
}

export const githubConnector: Connector<GithubRaw> = {
  id: "github",
  title: "GitHub Repository",
  requiresSecrets: true,
  configSchema,
  defaultIntervalSeconds: 30 * 60, // 30 minutes

  async fetch(ctx: ConnectorRunContext): Promise<GithubRaw> {
    const { repo, timeoutMs } = configSchema.parse(ctx.config);
    const token = ctx.secrets?.token;
    if (!token) return emptyRaw("missing GitHub token");

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "webmana",
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}`, {
        headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return emptyRaw(
          `GitHub returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }
      const data = (await res.json()) as RepoResponse;

      const daysSincePush =
        data.pushed_at != null
          ? Math.floor((ctx.now.getTime() - new Date(data.pushed_at).getTime()) / 86_400_000)
          : null;

      // Best-effort latest commit on the default branch (non-fatal if it fails).
      let lastCommitSha: string | null = null;
      const branch = data.default_branch ?? "main";
      try {
        const cRes = await fetch(
          `https://api.github.com/repos/${repo}/commits/${branch}`,
          { headers, signal: controller.signal },
        );
        if (cRes.ok) {
          const commit = (await cRes.json()) as CommitResponse;
          lastCommitSha = commit.sha?.slice(0, 7) ?? null;
        }
      } catch {
        /* ignore — commit sha is optional */
      }

      return {
        daysSincePush,
        openIssues: typeof data.open_issues_count === "number" ? data.open_issues_count : null,
        defaultBranch: data.default_branch ?? null,
        lastCommitSha,
        archived: typeof data.archived === "boolean" ? data.archived : null,
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

  normalize(raw: GithubRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };
    const staleDays = configSchema.parse(ctx.config).staleDays;

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "github",
        severity: "warning",
        title: "GitHub check failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    const labels: Record<string, string> = {};
    if (raw.defaultBranch) labels.branch = raw.defaultBranch;
    if (raw.lastCommitSha) labels.commit = raw.lastCommitSha;

    const push = (name: string, value: number | null) => {
      if (value === null) return;
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "github",
        kind: "deploy",
        name,
        value,
        labels: Object.keys(labels).length > 0 ? labels : undefined,
        observedAt: ctx.now,
      });
    };

    push("github.days_since_push", raw.daysSincePush);
    push("github.open_issues", raw.openIssues);

    if (raw.archived) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "github",
        severity: "info",
        title: "GitHub repository is archived",
        occurredAt: ctx.now,
      });
    } else if (raw.daysSincePush !== null && raw.daysSincePush >= staleDays) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "github",
        severity: "warning",
        title: "Repository looks stale",
        description: `No commits for ${raw.daysSincePush} days (threshold ${staleDays}).`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
