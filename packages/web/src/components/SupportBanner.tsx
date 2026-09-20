import type { ReactElement } from 'react';
import { Banner } from './Banner';
import { RichParagraphs } from '../lib/rich-text';
import type { SupportStatus } from '../lib/support';

export interface SupportBannerProps {
  readonly status: SupportStatus;
}

/**
 * Deliberately NOT a live region: support is detected once at mount and never
 * changes, and a live region's initial content is not announced anyway. It is
 * ordinary page content that a screen reader meets in document order.
 */
export function SupportBanner({ status }: SupportBannerProps): ReactElement {
  return (
    <Banner tone={status.tone}>
      <RichParagraphs paragraphs={status.paragraphs} />
    </Banner>
  );
}
