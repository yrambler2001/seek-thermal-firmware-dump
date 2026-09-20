/**
 * Browser-support detection, ported from the original page's `checkSupport()`.
 *
 * The prose is the original's, word for word; only its HTML tags have become
 * the mini-markup of ./rich-text.tsx. The one rule that matters is at the top
 * of the original function and is preserved exactly: **dumping needs WebUSB,
 * decrypting a file you already have does not**, so an unsupported browser
 * loses steps 1-2 and keeps the offline decryptor.
 */

import { getWebUsb } from './webusb';

export type SupportKind = 'ready' | 'ios' | 'no-webusb' | 'insecure';

export interface BrowserEnvironment {
  readonly hasWebUsb: boolean;
  readonly userAgent: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
  readonly isSecureContext: boolean;
  /** `location.protocol`, e.g. 'https:' or 'file:'. */
  readonly protocol: string;
}

export interface SupportStatus {
  readonly kind: SupportKind;
  readonly tone: 'ok' | 'warn';
  /** Whether the Connect button can do anything at all. */
  readonly canUseUsb: boolean;
  /**
   * Always true. The offline decryptor runs on a file the user picks and needs
   * no USB access, so no environment check may ever disable it.
   */
  readonly offlineDecryptWorks: true;
  readonly paragraphs: readonly string[];
}

/** The original's `offlineStillWorks`, appended to every failure banner. */
export const OFFLINE_STILL_WORKS =
  'You can still use **Decrypt a dump you already have** below — that runs entirely on a file ' +
  'you pick and needs no USB access.';

/** The original's iOS/iPadOS sniff, including the iPadOS-13+ desktop-UA case. */
export function isIosDevice(env: BrowserEnvironment): boolean {
  return (
    /iPad|iPhone|iPod/.test(env.userAgent) ||
    (env.platform === 'MacIntel' && env.maxTouchPoints > 1 && !env.hasWebUsb)
  );
}

export function detectSupport(env: BrowserEnvironment): SupportStatus {
  if (isIosDevice(env) && !env.hasWebUsb) {
    return {
      kind: 'ios',
      tone: 'warn',
      canUseUsb: false,
      offlineDecryptWorks: true,
      paragraphs: [
        '**WebUSB is not available on iOS or iPadOS,** so this device cannot read a ' +
          "camera's flash.",
        'Safari does not implement it, and every iOS browser is required to use WebKit, so ' +
          'Chrome and Firefox here cannot expose it either. There is no flag or extension that ' +
          'changes this. To dump a camera, use a desktop computer or an Android phone with a ' +
          'USB-OTG cable.',
        OFFLINE_STILL_WORKS,
      ],
    };
  }

  if (!env.hasWebUsb) {
    return {
      kind: 'no-webusb',
      tone: 'warn',
      canUseUsb: false,
      offlineDecryptWorks: true,
      paragraphs: [
        '**This browser cannot access USB devices.**',
        'WebUSB is available in Chrome, Edge, Opera and other Chromium browsers on Windows, ' +
          'macOS, Linux and Android. Firefox and Safari have both declined to implement it.',
        ...(env.isSecureContext
          ? []
          : [
              'This page is also not being served over a secure connection, which blocks WebUSB ' +
                'on its own.',
            ]),
        OFFLINE_STILL_WORKS,
      ],
    };
  }

  if (!env.isSecureContext) {
    return {
      kind: 'insecure',
      tone: 'warn',
      canUseUsb: false,
      offlineDecryptWorks: true,
      paragraphs: [
        '**Insecure connection.** WebUSB is disabled here.',
        'Open this page over HTTPS or from `http://localhost`. A plain LAN address such as ' +
          '`http://192.168.1.10:8000` does not qualify.',
        OFFLINE_STILL_WORKS,
      ],
    };
  }

  return {
    kind: 'ready',
    tone: 'ok',
    canUseUsb: true,
    offlineDecryptWorks: true,
    paragraphs: [
      '**Ready.** Plug in your Seek camera and press *Connect device*.',
      ...(env.protocol === 'file:'
        ? [
            'Opened as a local file, so the browser will not remember the device between ' +
              'reloads. That is harmless.',
          ]
        : []),
    ],
  };
}

/** Reads the live environment. Split out so `detectSupport` stays pure. */
export function readBrowserEnvironment(): BrowserEnvironment {
  const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    hasWebUsb: getWebUsb() !== null,
    userAgent: nav?.userAgent ?? '',
    /* eslint-disable-next-line @typescript-eslint/no-deprecated --
       the iPadOS-13+ "desktop Safari" sniff has no non-deprecated equivalent,
       and it is the only way to tell an iPad from a Mac without WebUSB. */
    platform: nav?.platform ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    isSecureContext: typeof isSecureContext === 'undefined' ? false : isSecureContext,
    protocol: typeof location === 'undefined' ? '' : location.protocol,
  };
}
