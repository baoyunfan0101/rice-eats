import type { ReactNode } from 'react';

export function Loading({ label = '加载中…' }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-3 py-24 text-sm font-semibold text-muted"
    >
      <span aria-hidden="true" className="pixel-loader" />
      {label}
    </div>
  );
}

/** A centered notice (empty, not found, error), its icon framed like an item tile. */
export function Message({
  title,
  children,
  action,
  icon = '🍜',
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center">
      <div
        className="mb-5 flex size-20 items-center justify-center border-2 border-ink bg-gold-100 text-4xl shadow-px"
        aria-hidden="true"
      >
        {icon}
      </div>
      <h2 className="text-xl font-black">{title}</h2>
      {children && <div className="mt-2 leading-7 text-muted">{children}</div>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <Message icon="⚠️" title="内容加载失败" action={<Button onClick={onRetry}>重试</Button>}>
      可能是网络不稳定，请稍后重试。
    </Message>
  );
}

export function Button({
  children,
  onClick,
  variant = 'primary',
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={variant === 'primary' ? 'btn btn-primary px-5' : 'btn px-5'}
    >
      {children}
    </button>
  );
}
