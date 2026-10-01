export interface QuorumInput {
  current: { core: string[]; access: string[] };
  change: {
    core: string[] | null;
    passphraseChanged: boolean;
    requireUv?: boolean;
    access: string[];
  };
  approvals: { id: string; verified: boolean; uv?: boolean }[];
}

export type QuorumResult = { ok: true } | { ok: false; reason: string };

const WITH_ACCESS = "needs approval from another device with access here";
const STAY_VERIFIED =
  "every core device that stays must approve with a fingerprint";

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((item) => b.includes(item));

export function proofMessage(purpose: string, digest: string): string {
  return `krynodes-passphrase\n${purpose}\n${digest}`;
}

export function evaluateQuorum({
  current,
  change,
  approvals,
}: QuorumInput): QuorumResult {
  const approvers = [...new Set(approvals.map((approval) => approval.id))];
  if (approvers.length === 0) return { ok: false, reason: "needs an approval" };
  if (approvers.some((id) => !current.core.includes(id))) {
    return { ok: false, reason: "an approval comes from outside the core" };
  }
  if (approvals.some((approval) => !approval.verified)) {
    return { ok: false, reason: "an approval is not verified" };
  }
  const core = change.core ?? current.core;
  if (change.access.some((id) => !core.includes(id))) {
    return { ok: false, reason: "access names a device outside the core" };
  }
  const coreChanged =
    change.core !== null && !sameSet(change.core, current.core);
  if (coreChanged || change.passphraseChanged || change.requireUv) {
    const need = Math.min(2, current.core.length);
    if (approvers.length < need) {
      const missing = need - approvers.length;
      return {
        ok: false,
        reason: `needs ${missing} more core device${missing === 1 ? "" : "s"}`,
      };
    }
  }
  if (
    change.requireUv &&
    !core.every((id) =>
      approvals.some((approval) => approval.id === id && approval.uv),
    )
  ) {
    return { ok: false, reason: STAY_VERIFIED };
  }
  for (const id of change.access) {
    if (current.access.includes(id)) continue;
    const others = approvers.filter((approver) => approver !== id);
    if (others.some((approver) => current.access.includes(approver))) continue;
    const need = Math.min(
      2,
      current.core.filter((member) => member !== id).length,
    );
    if (others.length < need) return { ok: false, reason: WITH_ACCESS };
  }
  for (const id of current.access) {
    if (change.access.includes(id)) continue;
    if (coreChanged && !core.includes(id)) continue;
    if (
      !approvers.some(
        (approver) => approver === id || current.access.includes(approver),
      )
    ) {
      return { ok: false, reason: WITH_ACCESS };
    }
  }
  return { ok: true };
}
