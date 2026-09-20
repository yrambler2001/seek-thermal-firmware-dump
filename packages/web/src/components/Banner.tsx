import type { ReactElement, ReactNode } from 'react';

export type Tone = 'info' | 'ok' | 'warn' | 'err';

export interface BannerProps {
  readonly tone?: Tone;
  /** 'flush' drops the top margin when the banner opens a section. */
  readonly flush?: boolean;
  readonly inset?: boolean;
  readonly role?: 'status' | 'alert' | undefined;
  readonly children: ReactNode;
}

export function Banner({
  tone = 'info',
  flush = false,
  inset = false,
  role,
  children,
}: BannerProps): ReactElement {
  const classes = ['banner'];
  if (tone !== 'info') classes.push(tone);
  if (flush) classes.push('flush');
  if (inset) classes.push('inset');
  return (
    <div className={classes.join(' ')} {...(role !== undefined ? { role } : {})}>
      {children}
    </div>
  );
}
