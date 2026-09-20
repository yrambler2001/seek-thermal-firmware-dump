import type { ReactElement } from 'react';
import { Banner } from './Banner';
import { RichParagraphs } from '../lib/rich-text';
import type { SupportStatus } from '../lib/support';

export interface SupportBannerProps {
  readonly status: SupportStatus;
}

export function SupportBanner({ status }: SupportBannerProps): ReactElement {
  return (
    <Banner tone={status.tone} role="status">
      <RichParagraphs paragraphs={status.paragraphs} />
    </Banner>
  );
}
