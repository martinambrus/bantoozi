import { useState } from 'react';

import { cx } from '../../components/cx.js';
import { FeedIcon } from '../../components/icons.js';
import { httpsUrl } from '../article/http-url.js';

/** Decorative feed identity; remote requests follow the feed's image preference. */
export function FeedFavicon({
  iconUrl,
  imagesAllowed,
  className,
}: {
  iconUrl: string | null | undefined;
  imagesAllowed: boolean;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const icon = imagesAllowed ? httpsUrl(iconUrl) : null;
  const size = cx('shrink-0', className ?? 'size-5');
  return icon === null || icon.href === failedUrl ? (
    <FeedIcon className={size} />
  ) : (
    <img
      src={icon.href}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(icon.href)}
      className={cx(size, 'rounded-sm')}
    />
  );
}
