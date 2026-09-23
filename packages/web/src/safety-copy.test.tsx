/**
 * The guard against a redesign quietly dropping a warning.
 *
 * Everything in this file is prose someone wrote after bricking a camera, or
 * after working out why one would not boot. A redesign may move it, restyle
 * it, fold it into a disclosure or split it across cards — it may not reword
 * it, shorten it or lose it. Each string below is asserted against the text
 * the browser would actually show.
 */

import { describe, expect, it } from 'vitest';
import { App } from './App';
import { FlashPreview } from './components/FlashPreview';
import { RunPanel } from './components/RunPanel';
import { SupportBanner } from './components/SupportBanner';
import { plainText } from './lib/rich-text';
import { detectSupport, type BrowserEnvironment } from './lib/support';
import { fakeDeviceState, fakePreparedFlash } from './test-fixtures';
import { render } from './test-helpers';

/** Line wrapping is a layout decision; the words are not. */
function normalize(text: string): string {
  /* `\s` already covers U+00A0, so a non-breaking space in the markup and a
   * plain one in the expectation compare equal. */
  return text.replace(/\s+/g, ' ').trim();
}

function viewText(hash: string): { readonly text: string; readonly unmount: () => void } {
  window.location.hash = hash;
  const { container, unmount } = render(
    <App
      support={detectSupport({
        hasWebUsb: true,
        userAgent: 'Chrome',
        platform: 'MacIntel',
        maxTouchPoints: 0,
        isSecureContext: true,
        protocol: 'https:',
      })}
    />,
  );
  return { text: normalize(container.textContent), unmount };
}

function expectAll(text: string, phrases: readonly string[]): void {
  for (const phrase of phrases) {
    expect(text, `missing safety copy: ${phrase}`).toContain(normalize(phrase));
  }
}

/* ---- the dump view ---------------------------------------------------- */

const DUMP_COPY: readonly string[] = [
  /* the read-only promise */
  'Read-only: this view issues no flash write, erase, upload, commit, or reset command.',
  'This page can issue exactly six vendor commands. That is its entire vocabulary — there is no code path to anything else:',
  'Until the camera has reported its firmware version, only three of the six are sent, and only as reads: GetFirmwareInfo, GetOperationMode and GetErrorCode.',
  'USBDevice.reset() is never called either; the retry path just closes and reopens the handle.',

  /* detection, and the one check nothing skips */
  'A camera that does not report its version, or runs a build older than 0.8.0.0, is not read at all, and the page says why.',
  'It cannot skip the safety check. Whatever you pick, the run reads the firmware version first and refuses a camera that does not report it, or one running a build older than 0.8.0.0',

  /* the legacy-dump caveats (corrected 2026-09-23: the token was called
   * build-specific, and it is one value in 22 of the 36 images examined) */
  'It is still read-only: the token only arms a read window, and nothing is ever written.',
  'It is one 16-byte value, not one per build: the identical bytes are in 22 of the 36 firmware images examined',
  'and in none of the 14 images from 2018 on, which have no token check at all.',
  'On a build that refused it, the protected banks would just stall and be gap-filled — the same result as a dump without it, and still safe.',

  /* the offline decryptor's promise */
  'This part works in every browser, including Safari and iOS, because it needs no USB access.',
  'Decryption is still best-effort.',

  /* the 0x14060000 gap */
  'The USB command set exposes a read-window selector for every 64 KiB block of the 4 MiB flash except 0x14060000..0x1406ffff.',
  'In practice this costs you nothing.',
  'That redundancy is also why a camera whose 0x14060000 reads back as 0xff is fine: the bootable firmware still exists in the other slots.',
  'If you do want a strictly complete byte-for-byte image — to diff flash against a reference, say — read it over SWD/J-Link or with an SPI programmer.',

  /* the read-only opcode table, every row */
  'GetFirmwareInfo',
  "the running firmware version, read first: it decides which build's selector table the dump uses, and a camera that does not report one is not read",
  'GetErrorCode',
  'check status after each step',
  'SetOperationMode',
  'only to select mode 0, and only if not already there',
  'GetOperationMode',
  'read the current mode',
  'GetFeaturedFirmwareData',
  'the actual flash read',
  'BeginFirmwareUpgrade',
  'volatile read-window selector only — it selects which 64 KiB block the next reads return, and writes nothing',
];

/* ---- the flash view --------------------------------------------------- */

const FLASH_COPY: readonly string[] = [
  /* the warning that matters most */
  "This writes to the camera's flash. It erases a 64 KiB block and programs your image into the slot the camera is not currently booted from, then points the boot config at it.",
  'An image that is structurally valid but does not run leaves the camera unbootable, and the first-stage bootloader has no USB — only SWD/J-Link or an SPI programmer can recover it. Keep the rescue dump this page downloads for you.',

  /* what the file has to be */
  "The filename must carry the image's own key pair",
  'A file whose named keys are not both inside it, exactly once each, is refused too.',
  'Dump the whole 4 MiB flash and download it before writing (rescue copy)',

  /* the flash opcode table, every row */
  'GetFirmwareInfo',
  'running version, bootloader string, platform, USB speed, boot-config state',
  'SetFirmwareInfoFeatures',
  'selects which of the above to return — a selector register, writes no flash',
  'SetRamDataFeatures',
  'arms the 248-byte RAM device-id block so the serial can be read',
  'SetFeaturedFirmwareData',
  "streams the payload into the camera's RAM staging buffer, 64 B at a time",
  'CompleteMemoryUpgrade',
  'the commit — the only command here that erases or programs flash',

  /* the four explainers */
  'The bank switch only takes effect on a real power cycle, so unplug and replug the camera afterwards.',
  'This page always streams the full bank payload and refuses to send one whose footer does not validate.',
  'There is no signature and no MAC — that sum is the whole check.',
  'The recovery slot at 0x14070000 is never touched by this page, so it stays as your golden copy.',
];

/* ---- shown in both ---------------------------------------------------- */

const PLATFORM_COPY: readonly string[] = [
  'Works out of the box in Chrome, Edge or any Chromium browser. No driver install, no admin rights.',
  'SUBSYSTEM=="usb", ATTR{idVendor}=="289d", MODE="0666", TAG+="uaccess"',
  'sudo udevadm control --reload-rules && sudo udevadm trigger',
  'Snap and Flatpak Chromium builds are often sandboxed away from raw USB devices;',
  'Windows needs the WinUSB driver bound to the camera before any browser can reach it.',
  'Options → List All Devices',
  'choose WinUSB as the driver, and click Replace Driver.',
  'If your camera appears more than once, take the entry labelled (Interface 0).',
  'Works in Chrome for Android with a USB-OTG cable, provided the phone can supply bus power to the camera.',
  'Cannot read a camera, and this will not change. Safari does not implement WebUSB, and on iOS and iPadOS every browser — including Chrome and Firefox — is required to render with WebKit, so none of them expose the API.',
  'The optional decryptor does work here: decrypting a dump you already have needs no USB access,',
];

describe('safety copy is carried verbatim', () => {
  it('the dump view keeps every read-only promise and caveat', () => {
    const { text, unmount } = viewText('#/');
    expectAll(text, DUMP_COPY);
    expectAll(text, PLATFORM_COPY);
    unmount();
  });

  it('never calls the unlock token build-specific, on either view', () => {
    /* It was false: firmware-facts.test.ts finds the same 16 bytes, exactly
     * once each, in all 22 images from 2014-2017, and in none of the 14 later
     * ones. A caveat that says otherwise tells the user a camera might need a
     * token this page does not have. */
    for (const hash of ['#/', '#/flash']) {
      const { text, unmount } = viewText(hash);
      expect(text.toLowerCase(), hash).not.toMatch(/build[- ]specific|per[- ]build token/);
      expect(text, hash).not.toContain('recovered from a Compact PRO (PIR324) unit');
      unmount();
    }
  });

  it('the flash view keeps every bricking warning and explainer', () => {
    const { text, unmount } = viewText('#/flash');
    expectAll(text, FLASH_COPY);
    expectAll(text, PLATFORM_COPY);
    unmount();
  });

  it('renders every paragraph of all four browser-support banners', () => {
    const ENVIRONMENTS: readonly (readonly [string, BrowserEnvironment])[] = [
      [
        'ready',
        {
          hasWebUsb: true,
          userAgent: 'Chrome',
          platform: 'Linux x86_64',
          maxTouchPoints: 0,
          isSecureContext: true,
          protocol: 'https:',
        },
      ],
      [
        'ios',
        {
          hasWebUsb: false,
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
          platform: 'iPhone',
          maxTouchPoints: 5,
          isSecureContext: true,
          protocol: 'https:',
        },
      ],
      [
        'no-webusb',
        {
          hasWebUsb: false,
          userAgent: 'Firefox',
          platform: 'Linux x86_64',
          maxTouchPoints: 0,
          isSecureContext: true,
          protocol: 'https:',
        },
      ],
      [
        'insecure',
        {
          hasWebUsb: true,
          userAgent: 'Chrome',
          platform: 'Linux x86_64',
          maxTouchPoints: 0,
          isSecureContext: false,
          protocol: 'http:',
        },
      ],
    ];

    for (const [name, environment] of ENVIRONMENTS) {
      const status = detectSupport(environment);
      expect(status.kind, name).toBe(name);
      const { container, unmount } = render(<SupportBanner status={status} />);
      const text = normalize(container.textContent);
      for (const paragraph of status.paragraphs) {
        expect(text, `${name}: ${paragraph}`).toContain(normalize(plainText(paragraph)));
      }
      unmount();
    }
  });

  it('spot-checks the exact words of each support banner', () => {
    const literal: readonly string[] = [
      'Ready. Plug in your Seek camera and press Connect device.',
      "WebUSB is not available on iOS or iPadOS, so this device cannot read a camera's flash.",
      'This browser cannot access USB devices.',
      'WebUSB is available in Chrome, Edge, Opera and other Chromium browsers on Windows, macOS, Linux and Android. Firefox and Safari have both declined to implement it.',
      'Insecure connection. WebUSB is disabled here.',
      'Open this page over HTTPS or from http://localhost.',
      'You can still use Decrypt a dump you already have below — that runs entirely on a file you pick and needs no USB access.',
    ];
    const seen: string[] = [];
    for (const environment of [
      {
        hasWebUsb: true,
        userAgent: 'Chrome',
        platform: 'Linux',
        maxTouchPoints: 0,
        isSecureContext: true,
        protocol: 'https:',
      },
      {
        hasWebUsb: false,
        userAgent: 'iPhone',
        platform: 'iPhone',
        maxTouchPoints: 5,
        isSecureContext: true,
        protocol: 'https:',
      },
      {
        hasWebUsb: false,
        userAgent: 'Firefox',
        platform: 'Linux',
        maxTouchPoints: 0,
        isSecureContext: true,
        protocol: 'https:',
      },
      {
        hasWebUsb: true,
        userAgent: 'Chrome',
        platform: 'Linux',
        maxTouchPoints: 0,
        isSecureContext: false,
        protocol: 'http:',
      },
    ] satisfies readonly BrowserEnvironment[]) {
      const { container, unmount } = render(<SupportBanner status={detectSupport(environment)} />);
      seen.push(normalize(container.textContent));
      unmount();
    }
    const all = seen.join(' || ');
    expectAll(all, literal);
  });

  it('prints what the camera said after a write, unaltered', () => {
    /* These two lines are produced by the flash workflow, not by the view.
     * What is pinned here is that the transcript renders them character for
     * character — no truncation, no ellipsis, no reflow. */
    const unplug = 'NOW UNPLUG AND REPLUG THE CAMERA.';
    const proven =
      'Proven so far: the payload streamed, the camera accepted its checksum, and the ' +
      'commit returned no error. NOT proven: that the bootloader will select this slot, ' +
      'or that the image runs. The bank switch only takes effect on a real power cycle, ' +
      'so replug and press "Read device info" — the running version it reports is the ' +
      'only thing that settles it.';

    const { container, unmount } = render(
      <RunPanel
        id="flash"
        label="Write"
        tone="danger"
        progress={{ done: 1, total: 1, text: 'Written.' }}
        lines={[
          { seq: 1, level: 'warn', text: unplug },
          { seq: 2, level: 'detail', text: proven },
        ]}
        trimmed={0}
      />,
    );
    const log = container.querySelector('[role="log"]');
    expect(log?.textContent).toContain(unplug);
    expect(log?.textContent).toContain(proven);
    unmount();
  });

  it('keeps the re-key risk warning on the prepared write', async () => {
    const state = await fakeDeviceState();
    const { container, unmount } = render(
      <FlashPreview state={state} prep={fakePreparedFlash()} sha256={'b'.repeat(64)} />,
    );
    const text = normalize(container.textContent);
    expectAll(text, [
      "This write will not be booted. slot B already holds a valid image encrypted with a key this camera's bootloader does not know, which means the running application re-encrypts with that key.",
      'Nothing here is damaged by trying — but to actually change what this camera runs you need an SPI programmer or SWD/J-Link.',
      "The stack pointer or reset vector moved. Those come from the image's own vector table, so this is a differently linked build — make sure it is a build for this camera.",
      'Nothing has been sent to the camera yet. Write to camera streams this payload and commits it.',
    ]);
    unmount();
  });
});
