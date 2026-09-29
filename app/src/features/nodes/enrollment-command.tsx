import { CopyCommand } from "@/components/copy-command";
import { countdown } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import type { Enrollment } from "@/types";

export function EnrollmentCommand({ enrollment }: { enrollment: Enrollment }) {
  const now = useNow();
  const remaining = Date.parse(enrollment.enrollmentExpiresAt) - now;
  return (
    <div className="space-y-3">
      <CopyCommand command={enrollment.command} />
      <p className="font-mono text-xs text-muted-foreground">
        {remaining > 0
          ? `Expires in ${countdown(remaining)}`
          : "Expired. Create a new command."}
      </p>
    </div>
  );
}
