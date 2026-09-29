import type { ReactNode } from "react";
import { errorMessage } from "@/lib/http";

import { useSession } from "@/lib/api";
import type { Identity, SessionVia } from "@/types";

import { FaultScreen, GuestScreen, ShellSkeleton } from "./screens";

export function SessionGate({
  children,
}: {
  children: (identity: Identity, via: SessionVia) => ReactNode;
}) {
  const session = useSession();
  if (session.isPending) return <ShellSkeleton />;
  if (session.isError) {
    return (
      <FaultScreen
        message={errorMessage(session.error)}
        onRetry={() => void session.refetch()}
      />
    );
  }
  const identity = session.data.identity;
  if (!session.data.authenticated || !identity) return <GuestScreen />;
  return children(identity, session.data.via);
}
