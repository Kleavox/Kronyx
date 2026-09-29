import { useEffect, useState } from "react";

import { fingerprint } from "@/lib/devices";
import type { DeviceRecord } from "@/types";

export function useFingerprints(devices: DeviceRecord[] | undefined) {
  const [prints, setPrints] = useState<{
    devices: DeviceRecord[];
    values: string[];
  } | null>(null);
  useEffect(() => {
    if (!devices) return;
    let current = true;
    void Promise.all(
      devices.map((device) => fingerprint(device.publicKey)),
    ).then((values) => {
      if (current) setPrints({ devices, values });
    });
    return () => {
      current = false;
    };
  }, [devices]);
  return prints && prints.devices === devices ? prints.values : null;
}
