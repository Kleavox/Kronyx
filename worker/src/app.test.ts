import { describe, expect, it } from "vitest";

import { app } from "./app";
import type { Env } from "./env";

describe("Krynodes without Kleavox", () => {
  it.each([
    "/api/admin/link/admin/reports",
    "/api/admin/drop/admin/file-reports",
    "/api/projects",
    "/api/notes",
  ])("has no %s", async (path) => {
    const response = await app.request(`https://kry.example.test${path}`, {}, {
      ENVIRONMENT: "development",
    } as unknown as Env);
    expect(response.status).toBe(404);
  });
});
