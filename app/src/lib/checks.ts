import type { CheckKind } from "../types";

export const TARGET_HINT: Record<CheckKind, string> = {
  HTTP: "Fetched from the node. Down on errors, timeouts and 5xx answers.",
  TCP: "Opened from the node. Down when the connection fails in time.",
  SERVICE: "A unit on the node. Up while systemd reports it active.",
};

export const TARGET_PLACEHOLDER: Record<CheckKind, string> = {
  HTTP: "https://example.com/health",
  TCP: "127.0.0.1:5432",
  SERVICE: "nginx.service",
};

export function checkTargetProblem(
  kind: CheckKind,
  target: string,
): string | null {
  const value = target.trim();
  if (value === "") return "Enter a target.";
  if (kind === "HTTP") {
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") return null;
    } catch {
      return "Use a full URL starting with http:// or https://.";
    }
    return "Use a full URL starting with http:// or https://.";
  }
  if (kind === "TCP") {
    const match = /^([a-zA-Z0-9.-]+):([0-9]{1,5})$/u.exec(value);
    if (!match) return "Use host:port, such as 127.0.0.1:5432.";
    const port = Number(match[2]);
    return port >= 1 && port <= 65_535
      ? null
      : "The port must be between 1 and 65535.";
  }
  return /^[a-zA-Z0-9@_.:-]{1,128}$/u.test(value)
    ? null
    : "Use a systemd unit name, such as nginx.service.";
}
