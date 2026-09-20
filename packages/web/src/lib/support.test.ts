import { describe, expect, it } from 'vitest';
import { plainText } from './rich-text';
import {
  OFFLINE_STILL_WORKS,
  detectSupport,
  isIosDevice,
  type BrowserEnvironment,
} from './support';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, ' +
  'like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

function env(overrides: Partial<BrowserEnvironment> = {}): BrowserEnvironment {
  return {
    hasWebUsb: true,
    userAgent: CHROME,
    platform: 'MacIntel',
    maxTouchPoints: 0,
    isSecureContext: true,
    protocol: 'https:',
    ...overrides,
  };
}

/** Every branch must keep the offline decryptor, which needs no USB at all. */
function assertOfflineSurvives(paragraphs: readonly string[]): void {
  expect(paragraphs).toContain(OFFLINE_STILL_WORKS);
  expect(plainText(OFFLINE_STILL_WORKS)).toContain('Decrypt a dump you already have');
}

describe('detectSupport', () => {
  it('is ready when WebUSB is present in a secure context', () => {
    const status = detectSupport(env());
    expect(status.kind).toBe('ready');
    expect(status.tone).toBe('ok');
    expect(status.canUseUsb).toBe(true);
    expect(status.offlineDecryptWorks).toBe(true);
    expect(plainText(status.paragraphs.join(' '))).toContain(
      'Ready. Plug in your Seek camera and press Connect device.',
    );
  });

  it('warns about the local-file origin but stays ready', () => {
    const status = detectSupport(env({ protocol: 'file:' }));
    expect(status.kind).toBe('ready');
    expect(status.canUseUsb).toBe(true);
    expect(status.paragraphs.join(' ')).toContain(
      'the browser will not remember the device between reloads',
    );
  });

  it('names iOS and iPadOS specifically, and keeps the decryptor', () => {
    const status = detectSupport(env({ hasWebUsb: false, userAgent: IPHONE }));
    expect(status.kind).toBe('ios');
    expect(status.canUseUsb).toBe(false);
    expect(status.offlineDecryptWorks).toBe(true);
    const text = plainText(status.paragraphs.join(' '));
    expect(text).toContain('WebUSB is not available on iOS or iPadOS,');
    expect(text).toContain('every iOS browser is required to use WebKit');
    expect(text).toContain('There is no flag or extension that changes this.');
    assertOfflineSurvives(status.paragraphs);
  });

  it('detects an iPadOS 13+ tablet claiming to be a desktop Mac', () => {
    const ipad = env({
      hasWebUsb: false,
      userAgent: CHROME,
      platform: 'MacIntel',
      maxTouchPoints: 5,
    });
    expect(isIosDevice(ipad)).toBe(true);
    expect(detectSupport(ipad).kind).toBe('ios');
  });

  it('does not mistake a real Mac with WebUSB for an iPad', () => {
    expect(isIosDevice(env({ maxTouchPoints: 5 }))).toBe(false);
  });

  it('explains a browser with no WebUSB at all', () => {
    const status = detectSupport(
      env({ hasWebUsb: false, userAgent: FIREFOX, platform: 'Linux x86_64' }),
    );
    expect(status.kind).toBe('no-webusb');
    expect(status.canUseUsb).toBe(false);
    expect(status.offlineDecryptWorks).toBe(true);
    const text = plainText(status.paragraphs.join(' '));
    expect(text).toContain('This browser cannot access USB devices.');
    expect(text).toContain('Firefox and Safari have both declined to implement it.');
    /* A secure context, so the extra "and it is not HTTPS either" line is absent. */
    expect(text).not.toContain('not being served over a secure connection');
    assertOfflineSurvives(status.paragraphs);
  });

  it('adds the insecure-origin sentence when both problems apply', () => {
    const status = detectSupport(
      env({
        hasWebUsb: false,
        userAgent: FIREFOX,
        platform: 'Linux x86_64',
        isSecureContext: false,
      }),
    );
    expect(status.kind).toBe('no-webusb');
    expect(plainText(status.paragraphs.join(' '))).toContain(
      'This page is also not being served over a secure connection, which blocks WebUSB on its own.',
    );
    assertOfflineSurvives(status.paragraphs);
  });

  it('explains an insecure context when WebUSB itself is present', () => {
    const status = detectSupport(env({ isSecureContext: false, protocol: 'http:' }));
    expect(status.kind).toBe('insecure');
    expect(status.canUseUsb).toBe(false);
    expect(status.offlineDecryptWorks).toBe(true);
    const text = plainText(status.paragraphs.join(' '));
    expect(text).toContain('Insecure connection. WebUSB is disabled here.');
    expect(text).toContain('Open this page over HTTPS or from http://localhost.');
    expect(text).toContain('http://192.168.1.10:8000');
    assertOfflineSurvives(status.paragraphs);
  });
});
