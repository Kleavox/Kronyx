import { sparklineSegments } from "@/lib/series";
import { cn } from "@/lib/utils";

export function Sparkline({
  values,
  max = 100,
  label,
  className,
}: {
  values: (number | null)[];
  max?: number;
  label: string;
  className?: string;
}) {
  const segments = sparklineSegments(values, max);
  return (
    <svg
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={cn("h-8 w-full overflow-visible", className)}
    >
      {segments.map((points) => (
        <polyline
          key={points}
          points={points}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth={new Set(points.split(" ")).size === 1 ? 3 : 1.5}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
