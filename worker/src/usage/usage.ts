import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import type { Env } from "../env";
import {
  invalidRequest,
  readJson,
  type KrynodesApp,
  type KrynodesEnv,
} from "../routes/shared";

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const CACHE_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

const FREE_QUOTAS = {
  requests: 100_000,
  writes: 100_000,
  reads: 5_000_000,
  objects: 100_000,
} as const;

const DEFAULT_BUDGET = { requests: 20_000, writes: 30_000, reads: 1_000_000 };

const budgetSchema = z.strictObject({
  requests: z.number().int().min(1).max(1_000_000_000),
  writes: z.number().int().min(1).max(1_000_000_000),
  reads: z.number().int().min(1).max(1_000_000_000),
});

type Budget = z.infer<typeof budgetSchema>;

interface Share {
  requests: number;
  reads: number;
  writes: number;
}

interface Usage {
  account: Share & { objects: number };
  krynodes: Share;
}

interface Cached {
  day: string;
  fetchedAt: string;
  usage: Usage | null;
  error: string | null;
}

const QUERY = `query Usage($account: string!, $start: Time!, $end: Time!, $date: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workers: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { requests }
        dimensions { scriptName }
      }
      d1: d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date: $date }) {
        sum { rowsRead rowsWritten }
        dimensions { databaseId }
      }
      durableObjects: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date: $date }) {
        sum { requests }
      }
    }
  }
}`;

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

export function usageRequest(account: string, now: number) {
  const day = dayOf(now);
  return {
    query: QUERY,
    variables: {
      account,
      start: `${day}T00:00:00.000Z`,
      end: new Date(now).toISOString(),
      date: day,
    },
  };
}

const answerSchema = z.object({
  data: z
    .object({
      viewer: z.object({
        accounts: z
          .array(
            z.object({
              workers: z
                .array(
                  z.object({
                    sum: z.object({ requests: z.number() }),
                    dimensions: z.object({ scriptName: z.string() }),
                  }),
                )
                .default([]),
              d1: z
                .array(
                  z.object({
                    sum: z.object({
                      rowsRead: z.number(),
                      rowsWritten: z.number(),
                    }),
                    dimensions: z.object({ databaseId: z.string() }),
                  }),
                )
                .default([]),
              durableObjects: z
                .array(z.object({ sum: z.object({ requests: z.number() }) }))
                .default([]),
            }),
          )
          .min(1),
      }),
    })
    .nullish(),
  errors: z.array(z.object({ message: z.string() })).nullish(),
});

export function parseUsage(
  value: unknown,
  mine: { scripts: string[]; database: string | null },
): Usage {
  const parsed = answerSchema.safeParse(value);
  if (!parsed.success) throw new Error("Cloudflare sent an unexpected answer.");
  const error = parsed.data.errors?.[0]?.message;
  if (error) throw new Error(error);
  const account = parsed.data.data?.viewer.accounts[0];
  if (!account) throw new Error("Cloudflare sent no account data.");
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const requests = sum(account.workers.map((row) => row.sum.requests));
  const reads = sum(account.d1.map((row) => row.sum.rowsRead));
  const writes = sum(account.d1.map((row) => row.sum.rowsWritten));
  const ours = mine.database
    ? account.d1.filter((row) => row.dimensions.databaseId === mine.database)
    : account.d1;
  return {
    account: {
      requests,
      reads,
      writes,
      objects: sum(account.durableObjects.map((row) => row.sum.requests)),
    },
    krynodes: {
      requests: sum(
        account.workers
          .filter((row) => mine.scripts.includes(row.dimensions.scriptName))
          .map((row) => row.sum.requests),
      ),
      reads: sum(ours.map((row) => row.sum.rowsRead)),
      writes: sum(ours.map((row) => row.sum.rowsWritten)),
    },
  };
}

async function readSetting<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string | null }>();
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

const writeSetting = (db: D1Database, key: string, value: unknown) =>
  db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value), new Date().toISOString())
    .run();

async function readBudget(db: D1Database): Promise<Budget> {
  const stored = budgetSchema.safeParse(await readSetting(db, "budget"));
  return stored.success ? stored.data : DEFAULT_BUDGET;
}

async function fetchUsage(env: Env, now: number): Promise<Usage> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(usageRequest(env.CF_ACCOUNT_ID!, now)),
  });
  if (!response.ok) throw new Error(`Cloudflare answered ${response.status}.`);
  return parseUsage(await response.json(), {
    scripts: (env.KRY_SCRIPTS ?? "kry,stats")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    database: env.KRY_D1_ID ?? null,
  });
}

async function currentUsage(env: Env, now: number): Promise<Cached | null> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return null;
  const day = dayOf(now);
  const cached = await readSetting<Cached>(env.DB, "usage");
  if (
    cached &&
    cached.day === day &&
    now - Date.parse(cached.fetchedAt) < CACHE_MS
  ) {
    return cached;
  }
  let next: Cached;
  try {
    next = {
      day,
      fetchedAt: new Date(now).toISOString(),
      usage: await fetchUsage(env, now),
      error: null,
    };
  } catch (error) {
    next = {
      day,
      fetchedAt: new Date(now).toISOString(),
      usage: cached?.day === day ? cached.usage : null,
      error:
        error instanceof Error ? error.message : "Cloudflare did not answer.",
    };
  }
  await writeSetting(env.DB, "usage", next);
  return next;
}

export function registerUsageRoutes(
  app: KrynodesApp,
  requireOperator: MiddlewareHandler<KrynodesEnv>,
): void {
  app.get("/api/usage", requireOperator, async (context) => {
    const now = Date.now();
    const [cached, budget] = await Promise.all([
      currentUsage(context.env, now),
      readBudget(context.env.DB),
    ]);
    const usage = cached?.usage ?? null;
    return context.json({
      source: usage ? "cloudflare" : "estimate",
      configured: Boolean(
        context.env.CF_ACCOUNT_ID && context.env.CF_ANALYTICS_TOKEN,
      ),
      fetchedAt: cached?.fetchedAt ?? null,
      error: cached?.error ?? null,
      account: usage?.account ?? null,
      krynodes: usage?.krynodes ?? null,
      budget,
      quotas: FREE_QUOTAS,
      resetAt: new Date(
        Math.floor(now / DAY_MS) * DAY_MS + DAY_MS,
      ).toISOString(),
    });
  });

  app.put("/api/usage/budget", requireOperator, async (context) => {
    const parsed = budgetSchema.safeParse(await readJson(context));
    if (!parsed.success) return invalidRequest(context);
    await writeSetting(context.env.DB, "budget", parsed.data);
    return context.json({ budget: parsed.data });
  });
}
