/**
 * A `USBDevice` as core's `WebUsbDevice`.
 *
 * These two are the same object at runtime and differ in exactly one place in
 * the type system. Core declares the OUT payload as `ArrayBufferView`, which
 * since TypeScript 5.7 means `ArrayBufferView<ArrayBufferLike>` — a union that
 * includes `SharedArrayBuffer`. `lib.dom`'s `BufferSource` is narrower
 * (`ArrayBufferView<ArrayBuffer> | ArrayBuffer`), so neither parameter type is
 * assignable to the other and even method bivariance cannot bridge it.
 *
 * Rather than cast the whole device and lose every other check, this delegates
 * field by field and narrows only the one argument. The narrowing is sound:
 * every OUT payload core sends is a `Uint8Array` over an ordinary
 * `ArrayBuffer`, never over a `SharedArrayBuffer`.
 *
 * Core could drop this file by declaring that parameter as
 * `ArrayBufferView<ArrayBuffer>`.
 */

import type { WebUsbDevice } from '@seek-fw/core';

export function asWebUsbDevice(device: USBDevice): WebUsbDevice {
  return {
    get vendorId(): number {
      return device.vendorId;
    },
    get productId(): number {
      return device.productId;
    },
    get manufacturerName(): string | null {
      return device.manufacturerName;
    },
    get productName(): string | null {
      return device.productName;
    },
    get serialNumber(): string | null {
      return device.serialNumber;
    },
    get configuration(): { readonly configurationValue: number } | null {
      return device.configuration;
    },
    get opened(): boolean {
      return device.opened;
    },
    open: () => device.open(),
    close: () => device.close(),
    selectConfiguration: (value) => device.selectConfiguration(value),
    claimInterface: (n) => device.claimInterface(n),
    releaseInterface: (n) => device.releaseInterface(n),
    controlTransferIn: (setup, length) => device.controlTransferIn(setup, length),
    controlTransferOut: (setup, data) => device.controlTransferOut(setup, data as BufferSource),
  };
}
