export interface ChangeSummary {
  title: string;
  admitted: string[];
  removed: string[];
  passphrase: boolean;
  requireUv: boolean;
  access: { nodeId: string; added: string[]; removed: string[] }[];
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

export function summarizeChange(input: {
  names: Record<string, string>;
  currentCore: string[];
  currentAccess: Record<string, string[]>;
  currentPassphrase: boolean;
  change: {
    core: string[] | null;
    passphrase: boolean;
    requireUv?: boolean;
    access: Record<string, string[]>;
  };
}): ChangeSummary {
  const { change } = input;
  const core = change.core ?? input.currentCore;
  const admitted = core.filter((id) => !input.currentCore.includes(id));
  const removed = input.currentCore.filter((id) => !core.includes(id));
  const access = Object.entries(change.access)
    .map(([nodeId, list]) => {
      const before = input.currentAccess[nodeId] ?? [];
      return {
        nodeId,
        added: list.filter((id) => !before.includes(id)),
        removed: before.filter((id) => !list.includes(id)),
      };
    })
    .filter((entry) => entry.added.length > 0 || entry.removed.length > 0);
  const name = (id: string) => input.names[id] ?? "an unknown device";
  const parts = [
    ...admitted.map((id) => `Admit ${name(id)}`),
    ...removed.map((id) => `Remove ${name(id)}`),
  ];
  if (change.requireUv) parts.push("Require fingerprint");
  if (change.passphrase) {
    parts.push(
      input.currentPassphrase ? "Change passphrase" : "Set passphrase",
    );
  }
  const accessOnly = access.filter(
    (entry) =>
      entry.added.some((id) => !admitted.includes(id)) ||
      entry.removed.some((id) => !removed.includes(id)),
  );
  if (accessOnly.length > 0) {
    parts.push(`Change access on ${plural(accessOnly.length, "server")}`);
  }
  return {
    title: parts.length > 0 ? parts.join(" · ") : "Refresh servers",
    admitted,
    removed,
    passphrase: change.passphrase,
    requireUv: change.requireUv ?? false,
    access,
  };
}
