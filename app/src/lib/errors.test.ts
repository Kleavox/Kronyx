import { describe, expect, it } from "vitest";

import { isSessionLost } from "./errors";
import { ApiError } from "./http";

describe("isSessionLost", () => {
  it("treats 401 and 403 as a session that changed under the page", () => {
    expect(isSessionLost(new ApiError("signed out", 401))).toBe(true);
    expect(isSessionLost(new ApiError("not admin", 403))).toBe(true);
    expect(isSessionLost(new ApiError("broken", 500))).toBe(false);
    expect(isSessionLost(new TypeError("Failed to fetch"))).toBe(false);
  });
});
