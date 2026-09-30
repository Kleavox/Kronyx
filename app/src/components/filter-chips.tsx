import { cn } from "@/lib/utils";

export function FilterChips<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex max-w-full gap-1.5 overflow-x-auto md:flex-wrap"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-9 shrink-0 rounded-md border px-2.5 font-mono text-xs whitespace-nowrap text-muted-foreground hover:text-foreground md:h-8",
            "aria-pressed:bg-accent aria-pressed:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
