import { ApiError } from "./http";
import { describe, expect, it } from "vitest";

import {
  createQueryClient,
  keepWhileSameNode,
  queryKeys,
} from "./query-client";

describe("createQueryClient", () => {
  it("rechecks the session when a query is refused", async () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.session, { authenticated: true });
    await client
      .fetchQuery({
        queryKey: queryKeys.overview,
        queryFn: () => Promise.reject(new ApiError("signed out", 401)),
        retry: false,
      })
      .catch(() => undefined);
    expect(client.getQueryState(queryKeys.session)?.isInvalidated).toBe(true);
  });

  it("leaves the session alone on other failures", async () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.session, { authenticated: true });
    await client
      .fetchQuery({
        queryKey: queryKeys.overview,
        queryFn: () => Promise.reject(new ApiError("broken", 500)),
        retry: false,
      })
      .catch(() => undefined);
    expect(client.getQueryState(queryKeys.session)?.isInvalidated).toBe(false);
  });
});

describe("keepWhileSameNode", () => {
  it("keeps the previous chart only while the node stays the same", () => {
    const keep = keepWhileSameNode<string>("a");
    expect(keep("old", { queryKey: queryKeys.nodeMetrics("a", "7d") })).toBe(
      "old",
    );
    expect(
      keep("old", { queryKey: queryKeys.nodeMetrics("b", "6h") }),
    ).toBeUndefined();
    expect(keep(undefined, undefined)).toBeUndefined();
  });
});
