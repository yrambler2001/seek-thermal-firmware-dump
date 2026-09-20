/** The platform notes, carried over word for word. Shown in both views. */

import type { ReactElement } from 'react';

const UDEV_RULE = `# /etc/udev/rules.d/70-seek-thermal.rules
SUBSYSTEM=="usb", ATTR{idVendor}=="289d", MODE="0666", TAG+="uaccess"

sudo udevadm control --reload-rules && sudo udevadm trigger`;

export function PlatformNotes(): ReactElement {
  return (
    <section aria-labelledby="platform-heading">
      <h2 id="platform-heading">Platform notes</h2>

      <h3>macOS</h3>
      <p className="note">
        Works out of the box in Chrome, Edge or any Chromium browser. No driver install, no admin
        rights. Quit any other program that is already talking to the camera first — only one
        process can hold the USB interface at a time.
      </p>

      <h3>Linux</h3>
      <p className="note">Give your user access to the device, then unplug and replug it:</p>
      <pre className="block">{UDEV_RULE}</pre>
      <p className="note">
        Snap and Flatpak Chromium builds are often sandboxed away from raw USB devices; the{' '}
        <code>.deb</code> or <code>.rpm</code> build is the reliable one.
      </p>

      <h3>Windows</h3>
      <p className="note">
        Windows needs the WinUSB driver bound to the camera before any browser can reach it. Use{' '}
        <a href="https://zadig.akeo.ie/" rel="noopener">
          Zadig
        </a>
        : <em>Options → List All Devices</em>, then in the dropdown pick the entry named after your
        camera — for example <code>CompactPRO FF</code> — choose <strong>WinUSB</strong> as the
        driver, and click Replace Driver. If your camera appears more than once, take the entry
        labelled <em>(Interface 0)</em>. This takes the device away from the vendor software until
        you revert it in Device Manager (<em>Uninstall device → Delete driver</em>, then replug).
      </p>

      <h3>Android</h3>
      <p className="note">
        Works in Chrome for Android with a USB-OTG cable, provided the phone can supply bus power to
        the camera. Android grants USB access through its own permission dialog. The download lands
        in your Downloads folder like any other file.
      </p>

      <h3>iPhone and iPad</h3>
      <p className="note">
        <strong>Cannot read a camera</strong>, and this will not change. Safari does not implement
        WebUSB, and on iOS and iPadOS every browser — including Chrome and Firefox — is required to
        render with WebKit, so none of them expose the API. There is no flag, extension, or app that
        works around it. Use a desktop or an Android phone to dump.
      </p>
      <p className="note">
        The optional decryptor does work here: decrypting a dump you already have needs no USB
        access, so you can do that from an iPhone or iPad, or from Firefox and Safari on the
        desktop.
      </p>
    </section>
  );
}
