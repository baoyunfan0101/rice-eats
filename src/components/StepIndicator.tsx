import { PixelCheck } from './PixelIcons';

export interface Step {
  label: string;
}

/**
 * The submission's progress: numbered steps joined by a pixel progress bar.
 * Steps before `current` are done (and, with `onBack`, take the visitor back
 * to them), the current one is highlighted, later ones wait.
 */
export function StepIndicator({
  steps,
  current,
  onBack,
}: {
  steps: Step[];
  /** Index of the current step. */
  current: number;
  /** Returns to an earlier step. */
  onBack?: (index: number) => void;
}) {
  return (
    <nav aria-label="投稿进度">
      <ol className="flex items-stretch">
        {steps.map((step, i) => {
          const state = i < current ? 'done' : i === current ? 'current' : 'upcoming';
          const status = state === 'done' ? '已完成' : state === 'current' ? '当前步骤' : '待完成';
          const content = (
            <>
              <span
                aria-hidden="true"
                className={`flex size-9 shrink-0 items-center justify-center border-2 font-pixel text-lg font-bold ${
                  state === 'current'
                    ? 'border-ink bg-gold-300 shadow-px-sm'
                    : state === 'done'
                      ? 'border-ink bg-basil-300'
                      : 'border-dashed border-muted bg-cream text-muted'
                }`}
              >
                {state === 'done' ? <PixelCheck className="size-4" /> : i + 1}
              </span>
              <span className="min-w-0 text-left">
                <span
                  className={`block text-sm leading-5 font-black sm:text-base ${state === 'upcoming' ? 'text-muted' : ''}`}
                >
                  {step.label}
                </span>
                <span className="block text-xs leading-4 font-semibold text-muted">
                  第 {i + 1} 步 · {status}
                </span>
              </span>
            </>
          );
          return (
            <li
              key={step.label}
              aria-current={state === 'current' ? 'step' : undefined}
              className={`flex min-w-0 items-center gap-2 ${i < steps.length - 1 ? 'flex-1' : 'shrink-0'}`}
            >
              {state === 'done' && onBack ? (
                <button
                  type="button"
                  onClick={() => onBack(i)}
                  title="回到这一步"
                  className="group -m-1 flex min-w-0 items-center gap-2 p-1 hover:[&>span:first-child]:bg-gold-100"
                >
                  {content}
                </button>
              ) : (
                <span className="flex min-w-0 items-center gap-2">{content}</span>
              )}
              {i < steps.length - 1 && (
                // The bar between steps fills once the step before it is done.
                <span
                  aria-hidden="true"
                  className={`mx-1 h-3 min-w-6 flex-1 border-2 border-ink sm:mx-3 ${
                    i < current
                      ? 'bg-chili-500'
                      : 'bg-[repeating-linear-gradient(90deg,var(--color-sand)_0_6px,var(--color-cream)_6px_12px)]'
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
