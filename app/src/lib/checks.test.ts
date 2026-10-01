import { describe, expect, it } from "vitest";

import { checkTargetProblem } from "./checks";

describe("check targets", () => {
  it("accepts what the Worker accepts", () => {
    expect(checkTargetProblem("HTTP", "https://example.com/health")).toBeNull();
    expect(checkTargetProblem("HTTP", " http://10.0.0.2:8080 ")).toBeNull();
    expect(checkTargetProblem("TCP", "db.internal:5432")).toBeNull();
    expect(checkTargetProblem("SERVICE", "nginx.service")).toBeNull();
    expect(checkTargetProblem("SERVICE", "getty@tty1.service")).toBeNull();
  });

  it("says what is wrong for each kind", () => {
    expect(checkTargetProblem("HTTP", "")).toBe("Enter a target.");
    expect(checkTargetProblem("HTTP", "example.com")).toBe(
      "Use a full URL starting with http:// or https://.",
    );
    expect(checkTargetProblem("HTTP", "ftp://example.com")).toBe(
      "Use a full URL starting with http:// or https://.",
    );
    expect(checkTargetProblem("TCP", "example.com")).toBe(
      "Use host:port, such as 127.0.0.1:5432.",
    );
    expect(checkTargetProblem("TCP", "example.com:70000")).toBe(
      "The port must be between 1 and 65535.",
    );
    expect(checkTargetProblem("SERVICE", "nginx service")).toBe(
      "Use a systemd unit name, such as nginx.service.",
    );
  });
});
