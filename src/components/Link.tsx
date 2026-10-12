import type { AnchorHTMLAttributes } from 'react';
import { handleLinkClick } from '../lib/router';

/** In-app link: a real <a href> (works with new tabs and crawlers) using pushState. */
export function Link({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      onClick={(event) => {
        onClick?.(event);
        handleLinkClick(event, href);
      }}
      {...rest}
    />
  );
}
