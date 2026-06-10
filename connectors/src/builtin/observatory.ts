import { z } from "zod";
import type { Connector, ConnectorResult, ConnectorRunContext } from "../types.js";

const configSchema = z.object({
  /** Emit a warning event when the score falls below this value. */
  warnScoreBelow: z.number().int().default(70),
  /** Request timeout in milliseconds (scans can be slow). */
  timeoutMs: z.number().int().positive().default(30_000),
});

const API_URL = "https://observatory-api.mdn.mozilla.net/api/v2/scan";

export interface ObservatoryRaw {
  grade: string | null;
  score: number | null;
  testsFailed: number | null;
  testsPassed: number | null;
  error?: string;
}

function emptyRaw(error: string): ObservatoryRaw {
  return { grade: null, score: null, testsFailed: null, testsPassed: null, error };
}

interface ScanResponse {
  error?: string | null;
  grade?: string | null;
  score?: number;
  tests_failed?: number;
  tests_passed?: number;
}

/** A passing grade starts with A or B; C/D/F warrant attention. */
function gradeIsWeak(grade: string | null): boolean {
  if (!grade) return false;
  const letter = grade.trim().charAt(0).toUpperCase();
  return letter === "C" || letter === "D" || letter === "F";
}

export const observatoryConnector: Connector<ObservatoryRaw> = {
  id: "observatory",
  title: "Mozilla Observatory",
  requiresSecrets: false,
  configSchema,
  defaultIntervalSeconds: 24 * 60 * 60, // 24 hours

  async fetch(ctx: ConnectorRunContext): Promise<ObservatoryRaw> {
    const { timeoutMs } = configSchema.parse(ctx.config);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${API_URL}?host=${encodeURIComponent(ctx.domain)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return emptyRaw(
          `Observatory returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }
      const data = (await res.json()) as ScanResponse;
      if (data.error) return emptyRaw(data.error);

      return {
        grade: data.grade ?? null,
        score: typeof data.score === "number" ? data.score : null,
        testsFailed: typeof data.tests_failed === "number" ? data.tests_failed : null,
        testsPassed: typeof data.tests_passed === "number" ? data.tests_passed : null,
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

  normalize(raw: ObservatoryRaw, ctx: ConnectorRunContext): ConnectorResult {
    const result: ConnectorResult = { metrics: [], events: [] };
    const { warnScoreBelow } = configSchema.parse(ctx.config);

    if (raw.error) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "observatory",
        severity: "warning",
        title: "Observatory scan failed",
        description: raw.error,
        occurredAt: ctx.now,
      });
      return result;
    }

    const labels = raw.grade ? { grade: raw.grade } : undefined;
    const push = (name: string, value: number | null) => {
      if (value === null) return;
      result.metrics.push({
        projectId: ctx.projectId,
        connectorId: "observatory",
        kind: "security",
        name,
        value,
        labels,
        observedAt: ctx.now,
      });
    };

    push("observatory.score", raw.score);
    push("observatory.tests_failed", raw.testsFailed);
    push("observatory.tests_passed", raw.testsPassed);

    const scoreLow = raw.score !== null && raw.score < warnScoreBelow;
    if (scoreLow || gradeIsWeak(raw.grade)) {
      result.events.push({
        projectId: ctx.projectId,
        connectorId: "observatory",
        severity: "warning",
        title: "Weak security posture",
        description: `${ctx.domain} scored ${raw.score ?? "?"} (grade ${raw.grade ?? "?"})`,
        occurredAt: ctx.now,
      });
    }

    return result;
  },
};
