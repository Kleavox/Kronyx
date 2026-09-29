import { describe, expect, it } from "vitest";

import { accountLinks } from "./account";

describe("accountLinks", () => {
  it("offers the Access sign-out when Zero Trust let the operator in", () => {
    expect(accountLinks("access")).toEqual([
      { label: "Sign out", href: "/cdn-cgi/access/logout" },
    ]);
  });

  it("offers nothing to a standalone operator", () => {
    expect(accountLinks("standalone")).toEqual([]);
  });
});
