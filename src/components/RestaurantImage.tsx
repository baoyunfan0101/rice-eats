import type { ImageAsset } from '../../shared/content/model';
import { BowlMark } from './Logo';

interface Props {
  image?: ImageAsset;
  sizes: string;
  className?: string;
  /** Load immediately (above-the-fold images). */
  eager?: boolean;
  /** Thumbnails inside a labelled link or button repeat its text, so they get alt="". */
  decorative?: boolean;
}

/**
 * Responsive photo with reserved space (photos keep their own look: never
 * pixelated); shows the pixel bowl as a placeholder when there is no photo.
 */
export function RestaurantImage({
  image,
  sizes,
  className = '',
  eager = false,
  decorative = false,
}: Props) {
  if (!image) {
    return (
      <div className={`flex items-center justify-center bg-sand ${className}`} aria-hidden="true">
        <BowlMark className="size-1/3 max-h-16 max-w-16 opacity-60" />
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
      className={`bg-sand object-cover ${className}`}
    />
  );
}
