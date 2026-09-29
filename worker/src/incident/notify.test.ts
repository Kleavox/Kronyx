import { describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";
import { createIncidentNotifier } from "./notify";

describe("incident notifier", () => {
  it("mails the operator without asking Pass who owns the node", async () => {
    const { db, sqlite } = createTestDb();
    seedNode(sqlite, { id: "n1" });
    const send = vi.fn(async () => ({ messageId: "m-1" }));
    const notify = createIncidentNotifier({
      DB: db,
      EMAIL: { send },
      ALERT_EMAIL: "operator@example.test",
      FROM_EMAIL: "kry@example.test",
      PUBLIC_ORIGIN: "https://kry.example.test",
    } as unknown as Env);

    await notify({
      nodeId: "n1",
      checkName: "API",
      kind: "opened",
      summary: "API is down",
      occurredAt: "2026-09-28T09:00:00.000Z",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "operator@example.test",
        subject: "[Krynodes] API is down",
      }),
    );
  });
});
