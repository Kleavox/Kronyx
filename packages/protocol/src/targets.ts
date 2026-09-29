const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,127}$/u;

const PROTECTED_UNITS = [
  /^ssh\.service$/u,
  /^sshd\.service$/u,
  /^krynodes\.service$/u,
  /^krynodes-.+\.service$/u,
  /^docker\.service$/u,
  /^containerd\.service$/u,
  /^systemd-.+\.service$/u,
  /^dbus\.service$/u,
  /^dbus-broker\.service$/u,
  /^networking\.service$/u,
  /^NetworkManager\.service$/u,
  /^cloudflared\.service$/u,
  /^cloudflared-.+\.service$/u,
  /^getty@.*\.service$/u,
  /^serial-getty@.*\.service$/u,
  /^user@.*\.service$/u,
  /^snap\.docker\..+\.service$/u,
];

export function isValidTarget(kind: string, name: string): boolean {
  if (!TARGET_NAME.test(name)) return false;
  if (kind === "systemd") return name.endsWith(".service");
  return kind === "docker";
}

export function isProtectedTarget(kind: string, name: string): boolean {
  return (
    kind === "systemd" && PROTECTED_UNITS.some((pattern) => pattern.test(name))
  );
}
