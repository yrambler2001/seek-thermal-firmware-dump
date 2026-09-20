/**
 * `navigator.usb`, honestly typed.
 *
 * `@types/w3c-web-usb` declares `Navigator.usb` as always present, which is the
 * one thing this app cannot assume: on Safari, Firefox and every browser on
 * iOS the property does not exist. Both casts below re-describe a real object
 * with the property marked optional, so its absence becomes a value the code
 * branches on instead of a crash — and so `no-unnecessary-condition` does not
 * "helpfully" delete the check.
 */

interface MaybeUsbNavigator {
  readonly usb?: USB;
}

interface MaybeForgettable {
  readonly forget?: () => Promise<void>;
}

export function getWebUsb(): USB | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as unknown as MaybeUsbNavigator).usb ?? null;
}

/** `USBDevice.forget()` is Chromium-only and missing on older builds. */
export function canForget(device: USBDevice): boolean {
  return typeof (device as unknown as MaybeForgettable).forget === 'function';
}
