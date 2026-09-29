import { Fingerprint, KeyRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useFingerprints } from "@/features/deploy/use-fingerprints";
import {
  useDevices,
  useOverview,
  useRegisterDevice,
  useServices,
  useSession,
  useTrust,
} from "@/lib/api";
import { withPrompt } from "@/lib/deploy-session";
import {
  DEPLOY_SINCE,
  initialChanges,
  nextVersion,
  proposal,
  signersFor,
  trustChange,
  trustedDeviceIds,
  trustSummary,
  type Proposal,
  type TrustSummary,
} from "@/lib/devices";
import { shortDate, timeAgo } from "@/lib/format";
import { errorMessage } from "@/lib/http";
import { registerDevice, signTrustChange } from "@/lib/passkeys";
import { cn } from "@/lib/utils";
import type { DeviceRecord, NodeRecord, NodeTrust } from "@/types";

const SECTION = "rounded-lg border bg-card";

function guessName(): string {
  const agent = navigator.userAgent;
  if (/Android|iPhone|iPad/u.test(agent)) return "Phone";
  return "Laptop";
}

interface Pending {
  title: string;
  rows: DeviceRecord[];
  proposal: Proposal;
  signed: boolean;
  apply: () => Promise<void>;
}

function ConfirmList({
  pending,
  working,
  onConfirm,
}: {
  pending: Pending;
  working: boolean;
  onConfirm: () => void;
}) {
  const prints = useFingerprints(pending.rows);
  return (
    <AlertDialogContent className="max-sm:top-auto max-sm:bottom-0 max-sm:translate-y-0 max-sm:rounded-b-none">
      <AlertDialogHeader>
        <AlertDialogTitle>{pending.title}</AlertDialogTitle>
        <AlertDialogDescription>
          Servers will trust exactly the devices below. Check each fingerprint
          before you approve.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ul className="max-h-64 divide-y overflow-y-auto rounded-md border text-sm">
        {pending.rows.map((device, index) => {
          const removed = pending.proposal.removed.includes(device.id);
          const added = pending.proposal.added.includes(device.id);
          return (
            <li key={device.id} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate font-medium",
                    removed && "text-muted-foreground line-through",
                  )}
                >
                  {device.name}
                </span>
                {added && (
                  <span className="font-mono text-xs text-success">added</span>
                )}
                {removed && (
                  <span className="font-mono text-xs text-destructive">
                    removed
                  </span>
                )}
              </div>
              <div className="font-mono text-xs text-muted-foreground">
                added {shortDate(device.createdAt)} · {prints?.[index] ?? "…"}
              </div>
            </li>
          );
        })}
      </ul>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button disabled={working || !prints} onClick={onConfirm}>
          {pending.signed && <Fingerprint aria-hidden="true" />}
          {working
            ? pending.signed
              ? "Waiting for the fingerprint…"
              : "Sending…"
            : pending.signed
              ? "Approve with fingerprint"
              : "Trust these devices"}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}

function statusOf(node: NodeRecord, summary: TrustSummary) {
  if (summary.needsUpdate.includes(node)) {
    return {
      label: `Needs agent ${DEPLOY_SINCE}`,
      tone: "text-muted-foreground",
    };
  }
  if (summary.needsTrust.includes(node)) {
    return { label: "Not trusted yet", tone: "text-warning" };
  }
  if (summary.stale.includes(node)) {
    return { label: "Trusts other devices", tone: "text-warning" };
  }
  return { label: "Trusted", tone: "text-success" };
}

function NameField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="device-name">Device name</Label>
      <Input
        id="device-name"
        value={value}
        maxLength={40}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 md:h-8 md:w-56"
      />
    </div>
  );
}

export function DevicesPage() {
  const session = useSession();
  const devices = useDevices();
  const overview = useOverview();
  const services = useServices();
  const register = useRegisterDevice();
  const trust = useTrust();
  const [name, setName] = useState(guessName);
  const [adding, setAdding] = useState(false);
  const [working, setWorking] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const list = devices.data?.devices;
  const prints = useFingerprints(list);

  if (!list || !overview.data || !services.data || !prints) {
    return (
      <>
        <PageHeader title="Deploy devices" />
        <Skeleton className="h-64" />
      </>
    );
  }

  const identity = session.data?.identity;
  const origin = window.location.origin;
  const rpId = window.location.hostname;
  const nodes = overview.data.nodes.filter(
    (node) => node.enrolled_at !== null && node.disabled_at === null,
  );
  const trustById: Record<string, NodeTrust | null> = Object.fromEntries(
    services.data.nodes.map((node) => [node.id, node.trust]),
  );
  const summary = trustSummary(nodes, trustById, prints);
  const signedTargets = [...summary.trusted, ...summary.stale].map(
    (node) => node.id,
  );
  const trustedIds = trustedDeviceIds(list, prints, trustById);
  const common = signersFor(
    list,
    prints,
    signedTargets.map((id) => trustById[id]?.keys ?? []),
  );
  const signers = common.length > 0 ? common : trustedIds;

  const run = async (work: () => Promise<void>) => {
    setWorking(true);
    try {
      await work();
    } catch (error) {
      toast.error(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "The fingerprint was cancelled."
          : errorMessage(error),
      );
    } finally {
      setWorking(false);
    }
  };

  async function approve(keys: DeviceRecord[], signers: string[]) {
    if (signedTargets.length === 0) return;
    if (signers.length === 0) {
      throw new Error("No device the servers trust can approve this change.");
    }
    const signed = await withPrompt(() =>
      signTrustChange(
        trustChange(signedTargets, keys, origin, nextVersion(trustById)),
        signers,
        rpId,
      ),
    );
    await trust.mutateAsync({
      change: signed.change,
      assertion: signed.assertion!,
    });
    toast.success("Sent to the servers. They apply it within a minute.");
  }

  const ask = (
    title: string,
    devices: DeviceRecord[],
    change: { add?: string; remove?: string },
  ) => {
    const next = proposal(devices, trustedIds, change);
    setPending({
      title,
      rows: [
        ...next.keys,
        ...devices.filter((device) => next.removed.includes(device.id)),
      ],
      proposal: next,
      signed: true,
      apply: () =>
        approve(
          next.keys,
          signers.filter((id) => !next.removed.includes(id)),
        ),
    });
  };

  const confirm = (current: Pending) =>
    run(async () => {
      await current.apply();
      setPending(null);
    });

  const setUp = () =>
    run(async () => {
      const input = await withPrompt(() =>
        registerDevice(
          name.trim() || guessName(),
          rpId,
          {
            id: identity?.id ?? "operator",
            name: identity?.email ?? "operator",
          },
          list.map((device) => device.id),
        ),
      );
      await register.mutateAsync(input);
      setAdding(false);
      const added: DeviceRecord = {
        ...input,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      if (list.length > 0 && signedTargets.length > 0) {
        ask(`Trust ${added.name} on your servers?`, [...list, added], {
          add: added.id,
        });
      }
    });

  const trustFirst = () => {
    const nodeIds = summary.needsTrust.map((node) => node.id);
    setPending({
      title: `Trust these devices on ${nodeIds.length} ${nodeIds.length === 1 ? "server" : "servers"}?`,
      rows: list,
      proposal: proposal(list, [], {}),
      signed: false,
      apply: async () => {
        const changes = await Promise.all(
          initialChanges(nodeIds, list, origin).map((change) =>
            signTrustChange(change, null),
          ),
        );
        await trust.mutateAsync({
          changes: changes.map((change) => change.change),
        });
        toast.success("Sent to the servers. They apply it within a minute.");
      },
    });
  };

  const remove = (device: DeviceRecord) =>
    ask(`Remove ${device.name} from your servers?`, list, {
      remove: device.id,
    });

  const updateServers = () =>
    ask("Update the trusted devices on your servers?", list, {});

  const dialog = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => !open && !working && setPending(null)}
    >
      {pending && (
        <ConfirmList
          pending={pending}
          working={working}
          onConfirm={() => void confirm(pending)}
        />
      )}
    </AlertDialog>
  );

  if (list.length === 0) {
    return (
      <>
        <PageHeader title="Deploy devices" />
        <section className={cn(SECTION, "max-w-xl p-5")}>
          <Fingerprint
            aria-hidden="true"
            className="mb-3 size-6 text-primary"
          />
          <h2 className="font-medium">Set up deploy with your fingerprint</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Deploys need a fingerprint from a device you trust. Servers keep
            that device's public key, so nothing on Cloudflare can deploy on its
            own.
          </p>
          <ol className="mt-4 space-y-4 text-sm">
            <li className="space-y-2">
              <p className="font-medium">1. Set up this device</p>
              <div className="flex flex-wrap items-end gap-2">
                <NameField value={name} onChange={setName} />
                <Button
                  className="h-11 md:h-8"
                  disabled={working}
                  onClick={() => void setUp()}
                >
                  <Fingerprint aria-hidden="true" />
                  {working
                    ? "Waiting for the fingerprint…"
                    : "Set up with fingerprint"}
                </Button>
              </div>
            </li>
            <li className="text-muted-foreground">
              2. Trust on servers: available once this device is set up.
            </li>
          </ol>
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Deploy devices"
        meta={
          <span className="font-mono text-xs text-muted-foreground">
            trusted on {summary.trusted.length}/{summary.total} servers
          </span>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-2">
        <section aria-labelledby="devices-heading" className={SECTION}>
          <div className="flex min-h-12 items-center gap-2 border-b px-4">
            <h2 id="devices-heading" className="text-sm font-medium">
              Devices · {list.length}
            </h2>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-11 md:h-8"
              onClick={() => setAdding((value) => !value)}
            >
              Add device
            </Button>
          </div>
          {adding && (
            <div className="flex flex-wrap items-end gap-2 border-b px-4 py-3">
              <NameField value={name} onChange={setName} />
              <Button
                className="h-11 md:h-8"
                disabled={working}
                onClick={() => void setUp()}
              >
                <Fingerprint aria-hidden="true" />
                {working ? "Waiting…" : "Set up"}
              </Button>
              <p className="w-full text-xs text-muted-foreground">
                To add your phone from here, choose "use a phone" in the
                browser's passkey window. A device you already trust then
                approves it.
              </p>
            </div>
          )}
          <ul className="divide-y">
            {list.map((device) => (
              <li
                key={device.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
              >
                <KeyRound
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {device.name}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  added {shortDate(device.createdAt)} · used{" "}
                  {timeAgo(device.lastUsedAt)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-11 text-destructive md:h-8"
                  disabled={
                    working || list.length === 1 || signedTargets.length === 0
                  }
                  onClick={() => remove(device)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <p className="border-t px-4 py-3 text-xs text-muted-foreground">
            {list.length === 1
              ? "Add a second device, such as your phone, so losing one never needs SSH. "
              : ""}
            Removing the last device needs SSH:{" "}
            <code className="font-mono">sudo kry trust --reset</code>.
          </p>
        </section>

        <section aria-labelledby="servers-heading" className={SECTION}>
          <div className="flex min-h-12 flex-wrap items-center gap-2 border-b px-4 py-2">
            <h2 id="servers-heading" className="text-sm font-medium">
              Servers · {summary.total}
            </h2>
            <div className="ml-auto flex flex-wrap gap-2">
              {summary.needsTrust.length > 0 && (
                <Button
                  size="sm"
                  className="h-11 md:h-8"
                  disabled={working}
                  onClick={trustFirst}
                >
                  Trust on {summary.needsTrust.length}{" "}
                  {summary.needsTrust.length === 1 ? "server" : "servers"}
                </Button>
              )}
              {summary.stale.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 md:h-8"
                  disabled={working}
                  onClick={updateServers}
                >
                  Update servers
                </Button>
              )}
            </div>
          </div>
          <ul className="divide-y">
            {nodes.map((node) => {
              const status = statusOf(node, summary);
              return (
                <li
                  key={node.id}
                  className="flex items-center gap-3 px-4 py-3 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{node.name}</span>
                  <span className={cn("font-mono text-xs", status.tone)}>
                    {status.label}
                  </span>
                </li>
              );
            })}
          </ul>
          {summary.needsUpdate.length > 0 && (
            <p className="border-t px-4 py-3 text-xs text-muted-foreground">
              Update these servers' agent from their node page first.
            </p>
          )}
        </section>
      </div>
      {dialog}
    </>
  );
}
