import { MIN_AGENT_VERSION } from "@krynodes/protocol/versions";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  accessChange,
  accessIds,
  buildChange,
  serverState,
  agentCurrent,
} from "@/lib/devices";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";

import { SHEET } from "./approval-dialog";
import type { Fleet } from "./use-fleet";

type Access = Record<string, string[]>;

export function AccessEditor({
  fleet,
  open,
  onClose,
  onReview,
}: {
  fleet: Fleet;
  open: boolean;
  onClose: () => void;
  onReview: (text: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {open && <Editor fleet={fleet} onClose={onClose} onReview={onReview} />}
    </Dialog>
  );
}

function Editor({
  fleet,
  onClose,
  onReview,
}: {
  fleet: Fleet;
  onClose: () => void;
  onReview: (text: string) => void;
}) {
  const wide = useMediaQuery("(min-width: 768px)");
  const servers = fleet.trusted.filter((server) => agentCurrent(server.node));
  const blocked = fleet.trusted.filter((server) => !agentCurrent(server.node));
  const current: Access = Object.fromEntries(
    servers.map((server) => [
      server.node.id,
      accessIds(fleet.devices, server.trust),
    ]),
  );
  const [desired, setDesired] = useState<Access>(current);
  const has = (access: Access, nodeId: string, id: string) =>
    access[nodeId]?.includes(id) ?? false;
  const changed = (nodeId: string, id: string) =>
    has(desired, nodeId, id) !== has(current, nodeId, id);
  const changes = servers.reduce(
    (sum, server) =>
      sum +
      fleet.core.filter((device) => changed(server.node.id, device.id)).length,
    0,
  );
  const toggle = (nodeId: string, id: string, on: boolean) =>
    setDesired((previous) => {
      const list = (previous[nodeId] ?? []).filter((entry) => entry !== id);
      return { ...previous, [nodeId]: on ? [...list, id] : list };
    });
  const review = () =>
    onReview(buildChange(fleet.view, accessChange(fleet.view, desired)));
  const behind = servers.some(
    (server) => serverState(fleet.view, server) === "behind",
  );

  return (
    <DialogContent className={cn(SHEET, "sm:max-w-3xl")}>
      <DialogHeader>
        <DialogTitle>Change access</DialogTitle>
        <DialogDescription>
          Access lets a core device run actions on a server. A device with
          access there approves a change on its own; otherwise two core devices
          other than the one gaining access approve it.
        </DialogDescription>
      </DialogHeader>
      {servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No server trusts your devices yet.
        </p>
      ) : wide ? (
        <div className="max-h-[55dvh] overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b">
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Server
                </th>
                {fleet.core.map((device) => (
                  <th
                    key={device.id}
                    scope="col"
                    className="px-3 py-2 text-center font-medium"
                  >
                    {device.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {servers.map((server) => (
                <tr key={server.node.id}>
                  <th
                    scope="row"
                    className="max-w-48 truncate px-3 py-1.5 text-left font-normal"
                  >
                    {server.node.name}
                  </th>
                  {fleet.core.map((device) => {
                    const id = `${server.node.id}-${device.id}`;
                    return (
                      <td
                        key={device.id}
                        className={cn(
                          "px-3 py-1.5 text-center",
                          changed(server.node.id, device.id) && "bg-primary/10",
                        )}
                      >
                        <input
                          id={id}
                          type="checkbox"
                          className="size-4 cursor-pointer align-middle accent-primary"
                          aria-label={`${device.name} on ${server.node.name}`}
                          checked={has(desired, server.node.id, device.id)}
                          onChange={(event) =>
                            toggle(
                              server.node.id,
                              device.id,
                              event.target.checked,
                            )
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="space-y-3">
          {servers.map((server) => (
            <li key={server.node.id} className="rounded-md border">
              <p className="border-b px-3 py-2 text-sm font-medium">
                {server.node.name}
              </p>
              <ul className="divide-y">
                {fleet.core.map((device) => {
                  const id = `m-${server.node.id}-${device.id}`;
                  return (
                    <li
                      key={device.id}
                      className={cn(
                        "flex min-h-11 items-center gap-3 px-3",
                        changed(server.node.id, device.id) && "bg-primary/10",
                      )}
                    >
                      <label
                        htmlFor={id}
                        className="min-w-0 flex-1 truncate text-sm"
                      >
                        {device.name}
                        {changed(server.node.id, device.id) && (
                          <span className="text-muted-foreground">
                            {" "}
                            · Changed
                          </span>
                        )}
                      </label>
                      <Switch
                        id={id}
                        aria-label={`${device.name} on ${server.node.name}`}
                        checked={has(desired, server.node.id, device.id)}
                        onCheckedChange={(on) =>
                          toggle(server.node.id, device.id, on)
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {(blocked.length > 0 || behind) && (
        <p className="text-xs text-muted-foreground">
          {blocked.length > 0 &&
            `${blocked.map((server) => server.node.name).join(", ")} ${blocked.length === 1 ? "needs" : "need"} agent ${MIN_AGENT_VERSION} before access can change there. `}
          {behind &&
            "Some servers are behind; sync them first so they count approvals the same way."}
        </p>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={changes === 0} onClick={review}>
          {changes === 0 ? "Review changes" : `Review changes (${changes})`}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
