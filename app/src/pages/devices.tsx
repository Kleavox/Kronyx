import { Fingerprint } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/page-header";
import { RowMenu } from "@/components/row-menu";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { AccessEditor } from "@/features/devices/access-editor";
import {
  ApprovalDialog,
  approvalLine,
  type Review,
} from "@/features/devices/approval-dialog";
import { BigPrint, failure, plural, when } from "@/features/devices/parts";
import { useFleet, type Fleet } from "@/features/devices/use-fleet";
import {
  useCancelProposal,
  useDevices,
  useFirstTrust,
  useForgetDevice,
  useRegisterDevice,
  useRenameDevice,
  useServices,
  useSession,
} from "@/lib/api";
import {
  accessIds,
  admitChange,
  buildChange,
  decodeChange,
  describeChange,
  fingerprint,
  fingerprintsRequired,
  firstTrusts,
  formatPrint,
  removeChange,
  requireUvChange,
  serverState,
  speaksQuorum,
  syncChange,
  uvBlocker,
  type FleetServer,
  type ServerState,
} from "@/lib/devices";
import { timeAgo } from "@/lib/format";
import { registerDevice, thisBrowser } from "@/lib/passkeys";
import { cn } from "@/lib/utils";
import type { DeviceRecord, ProposalRecord } from "@/types";

const SECTION = "rounded-lg border bg-card";
const DAY_MS = 24 * 3_600_000;

const STATE: Record<ServerState, { label: string; tone: string }> = {
  update: { label: "Needs agent 0.3.0", tone: "text-muted-foreground" },
  empty: { label: "Not trusted yet", tone: "text-warning" },
  behind: { label: "Behind", tone: "text-warning" },
  current: { label: "Up to date", tone: "text-success" },
};

function guessName(): string {
  return /Android|iPhone|iPad/u.test(navigator.userAgent) ? "Phone" : "Laptop";
}

function useSetUp(fleet: Fleet, onAdmit: (device: DeviceRecord) => void) {
  const register = useRegisterDevice();
  const identity = useSession().data?.identity;
  const [name, setName] = useState(guessName);
  const [working, setWorking] = useState(false);
  const setUp = async () => {
    setWorking(true);
    try {
      const input = await registerDevice(
        name.trim() || guessName(),
        window.location.hostname,
        {
          id: identity?.id ?? "operator",
          name: identity?.email ?? "Krynodes",
        },
        fleet.devices.map((device) => device.id),
        {
          required: fingerprintsRequired(fleet.view),
          guessed: !name.trim() || name.trim() === guessName(),
        },
      );
      await register.mutateAsync(input);
      const hasCore = fleet.core.some((device) =>
        fleet.mine.includes(device.id),
      );
      if (fleet.core.length > 0 && hasCore) {
        onAdmit({
          ...input,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          fingerprint: await fingerprint(input.publicKey),
          core: false,
        });
      }
    } catch (error) {
      toast.error(failure(error, fingerprintsRequired(fleet.view)));
    } finally {
      setWorking(false);
    }
  };
  return { name, setName, working, setUp };
}

function SetUpForm({
  setup,
  label,
}: {
  setup: ReturnType<typeof useSetUp>;
  label: string;
}) {
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void setup.setUp();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="device-name">Device name</Label>
        <Input
          id="device-name"
          value={setup.name}
          maxLength={40}
          onChange={(event) => setup.setName(event.target.value)}
          className="h-9 w-full sm:w-56"
        />
      </div>
      <Button type="submit" className="h-9" disabled={setup.working}>
        <Fingerprint aria-hidden="true" />
        {setup.working ? "Waiting for the fingerprint…" : label}
      </Button>
    </form>
  );
}

function Notice({
  children,
  action,
  tone = "info",
}: {
  children: ReactNode;
  action?: ReactNode;
  tone?: "info" | "warning";
}) {
  return (
    <div
      role="status"
      className={cn(
        "mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3 text-sm",
        tone === "warning"
          ? "border-warning/40 bg-warning/10"
          : "border-primary/30 bg-primary/5",
      )}
    >
      <p className="min-w-0 flex-1 basis-64">{children}</p>
      {action}
    </div>
  );
}

function FirstDevice({ fleet }: { fleet: Fleet }) {
  const setup = useSetUp(fleet, () => undefined);
  return (
    <>
      <PageHeader title="Trusted devices" />
      <section className={cn(SECTION, "max-w-xl p-5")}>
        <Fingerprint aria-hidden="true" className="mb-3 size-6 text-primary" />
        <h2 className="font-medium">Control servers with your fingerprint</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Start, stop, restart and deploy need a fingerprint from a core device.
          Servers keep the keys themselves, so nothing on Cloudflare can act on
          its own.
        </p>
        <p className="my-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          Set up this device first. Share the admin login only after your own
          devices are set up.
        </p>
        <SetUpForm setup={setup} label="Set up this device" />
      </section>
    </>
  );
}

function NewDevice({ fleet, device }: { fleet: Fleet; device: DeviceRecord }) {
  const forget = useForgetDevice();
  const [confirm, setConfirm] = useState(false);
  const joining = fleet.joining.includes(device.id);
  return (
    <>
      <PageHeader title="Trusted devices" />
      <section
        aria-labelledby="new-device"
        className={cn(SECTION, "max-w-xl p-5")}
      >
        <p
          className={cn(
            "text-sm font-medium",
            joining ? "text-success" : "text-warning",
          )}
        >
          {joining
            ? "Approved, your servers are taking it"
            : "Waiting for approval"}
        </p>
        <h2 id="new-device" className="mt-1 text-lg font-semibold">
          {device.name}
        </h2>
        <BigPrint publicKey={device.publicKey} className="my-4 sm:text-3xl" />
        <p className="text-sm">
          Open Trusted devices on one of your core devices and approve it. Check
          that it shows this code.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {fleet.core.length >= 2
            ? "Two core devices approve a new one. "
            : "Your core device approves it on its own. "}
          This page updates by itself once your servers take it.
        </p>
        {!joining && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-4 h-9 text-destructive"
            onClick={() => setConfirm(true)}
          >
            Forget this device
          </Button>
        )}
      </section>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Forget ${device.name}?`}
        description="No server knows it yet. You can set it up again later."
        confirmLabel="Forget"
        mutation={forget}
        variables={device.id}
      />
    </>
  );
}

function serversText(fleet: Fleet, device: DeviceRecord): string {
  const total = fleet.trusted.length;
  const count = fleet.trusted.filter((server) =>
    server.trust?.access.includes(device.fingerprint),
  ).length;
  if (count === 0) return "No servers";
  return count === total
    ? `All ${plural(total, "server")}`
    : `${count} of ${plural(total, "server")}`;
}

function proofText(fleet: Fleet, device: DeviceRecord): string | null {
  if (device.verifies === null) return null;
  if (device.verifies) return "Fingerprint";
  if (fingerprintsRequired(fleet.view)) return "Cannot sign";
  return fleet.view.passphrase ? "Needs passphrase" : "Touch only";
}

function DeviceRow({
  fleet,
  device,
  onRename,
  onAccess,
  onRemove,
  onForget,
}: {
  fleet: Fleet;
  device: DeviceRecord;
  onRename: () => void;
  onAccess: () => void;
  onRemove: () => void;
  onForget: () => void;
}) {
  const items: {
    label: string;
    onSelect: () => void;
    destructive?: boolean;
  }[] = [{ label: "Rename", onSelect: onRename }];
  if (device.core) {
    items.push({ label: "Change access", onSelect: onAccess });
    if (fleet.core.length > 1) {
      items.push({ label: "Remove", onSelect: onRemove, destructive: true });
    }
  } else {
    items.push({ label: "Forget", onSelect: onForget, destructive: true });
  }
  const facts = [
    formatPrint(device.fingerprint),
    proofText(fleet, device),
    device.core ? serversText(fleet, device) : null,
    device.lastUsedAt ? `Used ${timeAgo(device.lastUsedAt)}` : "Never used",
  ].filter(Boolean);
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-medium">{device.name}</span>
          {fleet.mine.includes(device.id) && (
            <Badge variant="outline">This device</Badge>
          )}
          <Badge
            variant="secondary"
            className={cn(!device.core && "text-warning")}
          >
            {device.core
              ? "Core"
              : fleet.joining.includes(device.id)
                ? "Joining"
                : "Waiting for approval"}
          </Badge>
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {facts.join(" · ")}
        </p>
      </div>
      <RowMenu label={`Options for ${device.name}`} items={items} />
    </li>
  );
}

function ServerRow({ fleet, server }: { fleet: Fleet; server: FleetServer }) {
  const state = STATE[serverState(fleet.view, server)];
  const names = accessIds(fleet.devices, server.trust).map(fleet.name);
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate font-medium">
          {server.node.name}
        </span>
        <span className={cn("shrink-0 font-mono text-xs", state.tone)}>
          {state.label}
        </span>
      </div>
      {(server.trust?.core.length ?? 0) > 0 && (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {names.length > 0 ? `Access: ${names.join(", ")}` : "No access"}
        </p>
      )}
    </li>
  );
}

function RecentChanges({ fleet }: { fleet: Fleet }) {
  const services = useServices();
  const now = Date.now();
  const recent = fleet.proposals
    .filter(
      (proposal) =>
        proposal.status === "applied" &&
        proposal.closedAt !== null &&
        now - Date.parse(proposal.closedAt) < DAY_MS,
    )
    .reverse()
    .slice(0, 3);
  if (recent.length === 0) return null;
  return (
    <div className="border-t px-4 py-3">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">
        Recent changes
      </h3>
      <ul className="space-y-2 text-sm">
        {recent.map((proposal) => {
          const change = decodeChange(proposal.change);
          if (!change) return null;
          const targets = Object.keys(change.access);
          const done = targets.filter(
            (id) =>
              (fleet.servers.find((server) => server.node.id === id)?.trust
                ?.version ?? 0) >= change.version,
          ).length;
          const refused = (services.data?.actions ?? []).filter(
            (action) =>
              action.kind === "trust" &&
              action.status === "failed" &&
              targets.includes(action.nodeId) &&
              action.requestedAt >= (proposal.closedAt ?? ""),
          );
          return (
            <li key={proposal.id}>
              <p className="truncate">
                {proposal.title || describeChange(fleet.view, change).title}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                Applied on {done} of {plural(targets.length, "server")}
              </p>
              {refused.map((action) => (
                <p key={action.id} className="text-xs text-destructive">
                  Refused on{" "}
                  {fleet.servers.find(
                    (server) => server.node.id === action.nodeId,
                  )?.node.name ?? "a server"}
                  : {action.output ?? "no reason given"}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ProposalCard({
  fleet,
  proposal,
  onReview,
  onCancel,
}: {
  fleet: Fleet;
  proposal: ProposalRecord;
  onReview: () => void;
  onCancel: () => void;
}) {
  const change = decodeChange(proposal.change);
  const title = change
    ? describeChange(fleet.view, change).title
    : "Unreadable change";
  const mineApproved = fleet.mine.some((id) => proposal.approvals.includes(id));
  return (
    <li className={cn(SECTION, "p-4")}>
      <p className="font-medium">{title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Opened by {fleet.name(proposal.openedBy)} · Expires{" "}
        {when(proposal.expiresAt)}
      </p>
      <p className="mt-2 font-mono text-xs">{approvalLine(fleet, proposal)}</p>
      {mineApproved && (
        <p className="mt-1 text-xs text-muted-foreground">
          You approved this. Approve on another core device.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" className="h-9 md:h-8" onClick={onReview}>
          Review
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-9 md:h-8"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </li>
  );
}

function PendingCard({
  device,
  onReview,
  onForget,
}: {
  device: DeviceRecord;
  onReview: () => void;
  onForget: () => void;
}) {
  return (
    <li className={cn(SECTION, "p-4")}>
      <p className="font-medium">Admit {device.name}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Registered {when(device.createdAt)} · Not approved yet
      </p>
      <p className="mt-2 font-mono text-xs">
        {formatPrint(device.fingerprint)}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" className="h-9 md:h-8" onClick={onReview}>
          Review
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-9 text-destructive md:h-8"
          onClick={onForget}
        >
          Forget
        </Button>
      </div>
    </li>
  );
}

function RenameDialog({
  device,
  onClose,
}: {
  device: DeviceRecord | null;
  onClose: () => void;
}) {
  const rename = useRenameDevice();
  const [name, setName] = useState("");
  return (
    <Dialog
      open={device !== null}
      onOpenChange={(open) => {
        if (open) return;
        rename.reset();
        onClose();
      }}
    >
      {device && (
        <DialogContent className="sm:max-w-sm">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              rename.mutate(
                { id: device.id, name: name.trim() || device.name },
                { onSuccess: onClose },
              );
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename {device.name}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="rename-device">Name</Label>
              <Input
                id="rename-device"
                defaultValue={device.name}
                maxLength={40}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={rename.isPending}>
                {rename.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

function FirstTrustDialog({
  fleet,
  servers,
  open,
  onClose,
}: {
  fleet: Fleet;
  servers: FleetServer[];
  open: boolean;
  onClose: () => void;
}) {
  const trust = useFirstTrust();
  const founder =
    fleet.devices.find((device) => fleet.mine.includes(device.id)) ??
    fleet.devices[0];
  const core = fleet.core.length > 0 ? fleet.core : founder ? [founder] : [];
  const founding = core.length < 2;
  const send = () =>
    trust.mutate(
      firstTrusts(
        fleet.view,
        servers.map((server) => server.node.id),
        founder?.id ?? "",
      ),
      {
        onSuccess: () => {
          toast.success("Sent to your servers. They apply it within a minute.");
          onClose();
        },
      },
    );
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        trust.reset();
        onClose();
      }}
    >
      <AlertDialogContent className="max-sm:top-auto max-sm:bottom-0 max-sm:translate-y-0 max-sm:rounded-b-none">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Trust {core.map((device) => device.name).join(", ")} on{" "}
            {plural(servers.length, "server")}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {servers.map((server) => server.node.name).join(", ")}{" "}
            {servers.length === 1 ? "trusts" : "trust"} no device yet.{" "}
            {founding
              ? "They take this device as their first core device, with access."
              : "They take your core devices with no access; give access afterwards with Change access."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="divide-y rounded-md border text-sm">
          {core.map((device) => (
            <li key={device.id} className="px-3 py-2">
              <span className="font-medium">{device.name}</span>
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                {formatPrint(device.fingerprint)}
              </span>
            </li>
          ))}
        </ul>
        {trust.error && (
          <p role="alert" className="text-sm text-destructive">
            {failure(trust.error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            disabled={trust.isPending || core.length === 0}
            onClick={send}
          >
            {trust.isPending ? "Sending…" : "Trust"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DevicesPage() {
  const probe = useDevices();
  const known = thisBrowser();
  const list = probe.data?.devices ?? [];
  const waitingHere =
    list.some((device) => !device.core && known.includes(device.id)) &&
    !list.some((device) => device.core && known.includes(device.id));
  const fleet = useFleet(waitingHere);

  if (!fleet) {
    return (
      <>
        <PageHeader title="Trusted devices" />
        <Skeleton className="h-64" />
      </>
    );
  }
  if (fleet.devices.length === 0) return <FirstDevice fleet={fleet} />;
  const mineWaiting = fleet.pending.find((device) =>
    fleet.mine.includes(device.id),
  );
  if (fleet.core.length > 0 && waitingHere && mineWaiting) {
    return <NewDevice fleet={fleet} device={mineWaiting} />;
  }
  return <Manage fleet={fleet} />;
}

function Manage({ fleet }: { fleet: Fleet }) {
  const cancel = useCancelProposal();
  const forget = useForgetDevice();
  const [review, setReview] = useState<Review | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<DeviceRecord | null>(null);
  const [forgetting, setForgetting] = useState<DeviceRecord | null>(null);
  const [cancelling, setCancelling] = useState<ProposalRecord | null>(null);
  const [trusting, setTrusting] = useState(false);
  const setup = useSetUp(fleet, (device) =>
    openReview(
      buildChange(fleet.view, admitChange(fleet.view, device)),
      undefined,
      () => setAdding(false),
    ),
  );

  function openReview(
    text: string,
    proposal?: ProposalRecord,
    before?: () => void,
  ) {
    before?.();
    setEditing(false);
    setReview({ text, proposal });
  }

  const states = new Map(
    fleet.servers.map((server) => [
      server.node.id,
      serverState(fleet.view, server),
    ]),
  );
  const empty = fleet.servers.filter(
    (server) => states.get(server.node.id) === "empty",
  );
  const behind = fleet.servers.filter(
    (server) => states.get(server.node.id) === "behind",
  );
  const old = fleet.trusted.filter((server) => !speaksQuorum(server.node));
  const admitting = new Set(
    fleet.open.flatMap((proposal) =>
      (decodeChange(proposal.change)?.core ?? []).map((key) => key.id),
    ),
  );
  const unasked = fleet.pending.filter(
    (device) => !admitting.has(device.id) && !fleet.joining.includes(device.id),
  );
  const founder =
    fleet.devices.find((device) => fleet.mine.includes(device.id)) ??
    fleet.devices[0];
  const ruled = fingerprintsRequired(fleet.view);
  const uvWaiting = fleet.open.some(
    (proposal) => decodeChange(proposal.change)?.requireUv,
  );
  const blocker = uvBlocker(fleet.view);
  const offerUv =
    fleet.core.length > 0 && old.length === 0 && !ruled && !uvWaiting;
  const leaving = fleet.core
    .filter((device) => device.verifies === false)
    .map((device) => device.name);
  const staying = fleet.core.length - leaving.length;
  const requireButton = (
    <Button
      size="sm"
      className="h-9 md:h-8"
      onClick={() =>
        openReview(buildChange(fleet.view, requireUvChange(fleet.view)))
      }
    >
      Require fingerprint
    </Button>
  );

  const addButton = (
    <Button size="sm" className="h-9 md:h-8" onClick={() => setAdding(true)}>
      Add device
    </Button>
  );
  let uvNotice = false;
  let notice: ReactNode = null;
  if (fleet.core.length === 0) {
    notice =
      empty.length > 0 ? (
        <Notice
          action={
            <Button
              size="sm"
              className="h-9 md:h-8"
              onClick={() => setTrusting(true)}
            >
              Trust on {plural(empty.length, "server")}
            </Button>
          }
        >
          Trust {founder?.name ?? "this device"} on your servers. It becomes
          your first core device.
        </Notice>
      ) : (
        <Notice tone="warning">
          Update your servers to agent 0.3.0, then trust this device on them.
        </Notice>
      );
  } else if (old.length > 0) {
    notice = (
      <Notice tone="warning">
        Update {old.map((server) => server.node.name).join(", ")} to agent
        0.3.0. Devices and access cannot change until every server speaks it.
      </Notice>
    );
  } else if (fleet.core.length === 1 && fleet.pending.length === 0) {
    notice = (
      <Notice action={addButton}>
        {ruled
          ? "Add a second fingerprint device as a backup, such as a security key or another phone."
          : "Add a second device, such as your phone. It gets access to your servers."}
      </Notice>
    );
  } else if (offerUv) {
    uvNotice = true;
    notice = blocker ? (
      <Notice tone="warning">
        Servers still accept a touch without a fingerprint. {blocker}
      </Notice>
    ) : (
      <Notice action={requireButton}>
        Servers still accept a touch without a fingerprint.{" "}
        {leaving.length > 0
          ? `Requiring one removes ${leaving.join(", ")}, which only ${leaving.length === 1 ? "takes" : "take"} a touch.`
          : "Require one so only verified passkeys approve and sign."}
        {staying === 1 &&
          " Add a second fingerprint device afterwards as a backup."}
      </Notice>
    );
  } else if (fleet.core.length === 2 && fleet.pending.length === 0) {
    notice = (
      <Notice action={addButton}>
        Add a third device as a backup. With two, losing one needs SSH to
        recover.
      </Notice>
    );
  }

  const waiting = fleet.open.length + unasked.length;

  return (
    <>
      <PageHeader
        title="Trusted devices"
        meta={
          <span className="font-mono text-xs text-muted-foreground">
            {plural(fleet.core.length, "core device")} ·{" "}
            {ruled ? "Fingerprint required" : "Touch allowed"}
          </span>
        }
        actions={offerUv && !blocker && !uvNotice ? requireButton : undefined}
      />
      {notice}

      {waiting > 0 && (
        <section aria-labelledby="waiting-heading" className="mb-5">
          <h2 id="waiting-heading" className="mb-2 text-sm font-medium">
            Waiting for approval · {waiting}
          </h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {fleet.open.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                fleet={fleet}
                proposal={proposal}
                onReview={() => openReview(proposal.change, proposal)}
                onCancel={() => setCancelling(proposal)}
              />
            ))}
            {unasked.map((device) => (
              <PendingCard
                key={device.id}
                device={device}
                onReview={() =>
                  openReview(
                    buildChange(fleet.view, admitChange(fleet.view, device)),
                  )
                }
                onForget={() => setForgetting(device)}
              />
            ))}
          </ul>
        </section>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <section aria-labelledby="devices-heading" className={SECTION}>
          <div className="flex min-h-12 items-center gap-2 border-b px-4">
            <h2 id="devices-heading" className="text-sm font-medium">
              Devices · {fleet.devices.length}
            </h2>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-9 md:h-8"
              onClick={() => setAdding((value) => !value)}
            >
              {adding ? "Close" : "Add device"}
            </Button>
          </div>
          {adding && (
            <div className="space-y-2 border-b px-4 py-3">
              <SetUpForm setup={setup} label="Set up with fingerprint" />
              <p className="text-xs text-muted-foreground">
                {ruled
                  ? 'Only passkeys that verify a fingerprint can join. On a computer without one, choose "Use a phone" in the passkey window; the phone joins.'
                  : 'To add your phone from here, choose "Use a phone" in the passkey window. It joins as waiting; core devices approve it.'}
              </p>
            </div>
          )}
          <ul className="divide-y">
            {fleet.devices.map((device) => (
              <DeviceRow
                key={device.id}
                fleet={fleet}
                device={device}
                onRename={() => setRenaming(device)}
                onAccess={() => setEditing(true)}
                onRemove={() =>
                  openReview(
                    buildChange(fleet.view, removeChange(fleet.view, device)),
                  )
                }
                onForget={() => setForgetting(device)}
              />
            ))}
          </ul>
          <p className="border-t px-4 py-3 text-xs text-muted-foreground">
            The last core device leaves only over SSH:{" "}
            <code className="font-mono">sudo kry trust --reset</code>.
          </p>
        </section>

        <section aria-labelledby="servers-heading" className={SECTION}>
          <div className="flex min-h-12 flex-wrap items-center gap-2 border-b px-4 py-2">
            <h2 id="servers-heading" className="text-sm font-medium">
              Servers · {fleet.servers.length}
            </h2>
            <div className="ml-auto flex flex-wrap gap-2">
              {fleet.core.length > 0 && empty.length > 0 && (
                <Button
                  size="sm"
                  className="h-9 md:h-8"
                  onClick={() => setTrusting(true)}
                >
                  Trust on {plural(empty.length, "server")}
                </Button>
              )}
              {behind.length > 0 && old.length === 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 md:h-8"
                  onClick={() =>
                    openReview(buildChange(fleet.view, syncChange(fleet.view)))
                  }
                >
                  Sync {plural(behind.length, "server")}
                </Button>
              )}
              {fleet.core.length > 0 && fleet.trusted.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 md:h-8"
                  onClick={() => setEditing(true)}
                >
                  Change access
                </Button>
              )}
            </div>
          </div>
          <ul className="divide-y">
            {fleet.servers.map((server) => (
              <ServerRow key={server.node.id} fleet={fleet} server={server} />
            ))}
          </ul>
          <RecentChanges fleet={fleet} />
        </section>
      </div>

      <ApprovalDialog
        fleet={fleet}
        review={review}
        onClose={() => setReview(null)}
      />
      <AccessEditor
        fleet={fleet}
        open={editing}
        onClose={() => setEditing(false)}
        onReview={(text) => openReview(text)}
      />
      <RenameDialog device={renaming} onClose={() => setRenaming(null)} />
      <FirstTrustDialog
        fleet={fleet}
        servers={empty}
        open={trusting}
        onClose={() => setTrusting(false)}
      />
      <ConfirmDialog
        open={forgetting !== null}
        onOpenChange={(open) => !open && setForgetting(null)}
        title={`Forget ${forgetting?.name ?? "this device"}?`}
        description="It never joined the core, so no server knows it. It can be set up again later."
        confirmLabel="Forget"
        mutation={forget}
        variables={forgetting?.id ?? ""}
      />
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && setCancelling(null)}
        title="Cancel this change?"
        description="The approvals collected so far are dropped. Nothing reaches your servers."
        confirmLabel="Cancel change"
        mutation={cancel}
        variables={cancelling?.id ?? ""}
      />
    </>
  );
}
