import type { ReactNode } from 'react';

export function Loading({ label = '加载中…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-24 text-muted">
      <span className="size-5 animate-spin rounded-full border-2 border-line border-t-chili-600 motion-reduce:animate-none" />
      {label}
    </div>
  );
}

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
      <div className="mb-4 text-5xl" aria-hidden="true">
        {icon}
      </div>
      <h2 className="text-xl font-bold">{title}</h2>
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
      className={
        variant === 'primary'
          ? 'min-h-11 rounded-full bg-chili-600 px-5 font-semibold text-white hover:bg-chili-700'
          : 'min-h-11 rounded-full border border-line bg-white px-5 font-semibold hover:border-chili-600'
      }
    >
      {children}
    </button>
  );
}
