import type { ImageAsset } from '../content/model';

interface Props {
  image?: ImageAsset;
  sizes: string;
  className?: string;
  /** Load immediately (above-the-fold images). */
  eager?: boolean;
  /** Thumbnails inside a labelled link or button repeat its text, so they get alt="". */
  decorative?: boolean;
}

/** Responsive photo with reserved space; shows a neutral placeholder when there is no photo. */
export function RestaurantImage({
  image,
  sizes,
  className = '',
  eager = false,
  decorative = false,
}: Props) {
  if (!image) {
    return (
      <div
        className={`flex items-center justify-center bg-gradient-to-br from-chili-50 to-line text-chili-600/50 ${className}`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 48 48" className="size-1/4 max-h-16 max-w-16" fill="none">
          <path d="M8 24h32a16 16 0 0 1-32 0z" fill="currentColor" />
          <path
            d="M18 16c0-3 3-3 3-6M27 16c0-3 3-3 3-6"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      </div>
    );
  }
  return (
    <img
      src={image.src}
      srcSet={image.srcset}
      sizes={sizes}
      width={image.width}
      height={image.height}
      alt={decorative ? '' : image.alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      className={`bg-line object-cover ${className}`}
    />
  );
}
