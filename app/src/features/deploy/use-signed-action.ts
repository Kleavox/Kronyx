import {
  ACTION_QUERIES,
  postActions,
  useApiMutation,
  useDevices,
  useServices,
} from "@/lib/api";
import { signersFor } from "@/lib/devices";
import { signTargets, type CommandTarget } from "@/lib/passkeys";
import type { ActionVerb, BatchMode } from "@/types";

import { useDeploySession } from "./use-deploy-session";
import { useFingerprints } from "./use-fingerprints";

const NO_SIGNER =
  "None of your devices is trusted by every server here. Update them in Trusted devices.";

export function useSignedAction(toastErrors = true) {
  const devices = useDevices();
  const services = useServices();
  const prints = useFingerprints(devices.data?.devices);
  const { open } = useDeploySession();
  return useApiMutation(
    async ({
      action,
      mode = "rolling",
      targets,
    }: {
      action: Exclude<ActionVerb, "trust">;
      mode?: BatchMode;
      targets: CommandTarget[];
    }) => {
      const keys = new Map(
        (services.data?.nodes ?? []).map((node) => [
          node.id,
          node.trust?.keys ?? [],
        ]),
      );
      const signers = signersFor(
        devices.data?.devices ?? [],
        prints ?? [],
        targets.map((target) => keys.get(target.nodeId) ?? []),
      );
      if (signers.length === 0) throw new Error(NO_SIGNER);
      try {
        const session = await open(signers);
        return await postActions({
          action,
          mode,
          targets: await signTargets(session, action, targets),
        });
      } catch (error) {
        throw error instanceof DOMException && error.name === "NotAllowedError"
          ? new Error("The fingerprint was cancelled.")
          : error;
      }
    },
    ACTION_QUERIES,
    toastErrors,
  );
}
