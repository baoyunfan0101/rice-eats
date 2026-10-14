import { useId, type ReactNode } from 'react';

/**
 * A fallback way to do something, collapsed until asked for: a small
 * "或者：…" toggle with a chevron that reveals its controls. Used the same
 * way for the address search (instead of the area buttons) and the name
 * search (instead of picking on the map).
 */
export function Alternative({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="group inline-flex min-h-8 items-center gap-1 text-sm font-semibold text-chili-700 hover:underline"
      >
        <svg
          viewBox="0 0 20 20"
          aria-hidden="true"
          className="size-4 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none"
        >
          <path d="M7.5 4.5 13 10l-5.5 5.5-1.1-1.1L10.8 10 6.4 5.6z" fill="currentColor" />
        </svg>
        或者：{label}
      </button>
      {open && <div id={id}>{children}</div>}
    </div>
  );
}
