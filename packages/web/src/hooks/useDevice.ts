/**
 * Owns the `USBDevice`: the chooser, `navigator.usb` connect/disconnect, and
 * building core's `WebUsbTransport` from it.
 *
 * `generation` is the important field. Key A, the upgrade target slot and the
 * footer template are all properties of ONE camera, and the original page's
 * bug was a page-global that carried them across a device swap. Every change of
 * device bumps this counter, and the flash view throws its analysis away when
 * it changes — so a payload built for one unit can never be sent to another.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SEEK_VENDOR_ID, WebUsbTransport, hex, type RecipientPreference } from '@seek-fw/core';
import { asWebUsbDevice } from '../lib/usb-adapter';
import { canForget, getWebUsb } from '../lib/webusb';

/** The original's `describeDevice`, on a raw `USBDevice`. */
export function describeUsbDevice(device: USBDevice): string {
  const parts = [
    `${device.productName ?? 'unknown product'} — ${device.manufacturerName ?? 'unknown vendor'}`,
    `VID ${hex(device.vendorId, 4)} PID ${hex(device.productId, 4)}`,
  ];
  if (device.serialNumber != null && device.serialNumber !== '') {
    parts.push(`serial ${device.serialNumber}`);
  }
  return parts.join(' · ');
}

export interface TransportOptions {
  readonly recipient: RecipientPreference;
  readonly onWarning?: (message: string) => void;
}

export type ConnectOutcome =
  | { readonly kind: 'connected'; readonly description: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

export interface DeviceHandle {
  readonly device: USBDevice | null;
  /** `describeUsbDevice`, or the reason there is no device. */
  readonly description: string;
  /** Bumped on every device change. See the note at the top of this file. */
  readonly generation: number;
  readonly canForgetDevice: boolean;
  connect: () => Promise<ConnectOutcome>;
  forget: () => Promise<ConnectOutcome>;
  /** Builds a fresh transport. Never cached: each run opens and closes its own. */
  makeTransport: (options: TransportOptions) => WebUsbTransport;
}

const NO_DEVICE = 'No device selected.';

export function useDevice(): DeviceHandle {
  const [device, setDevice] = useState<USBDevice | null>(null);
  const [description, setDescription] = useState(NO_DEVICE);
  const [generation, setGeneration] = useState(0);
  const current = useRef<USBDevice | null>(null);

  const adopt = useCallback((next: USBDevice | null, reason: string): void => {
    if (current.current === next) return;
    current.current = next;
    setDevice(next);
    setDescription(next === null ? reason : describeUsbDevice(next));
    setGeneration((value) => value + 1);
  }, []);

  /* Reuse a device the user has already authorised, as the original's init()
   * did. getDevices() is unavailable on opaque origins, so failure is silent. */
  useEffect(() => {
    const usb = getWebUsb();
    if (usb === null) return;
    let cancelled = false;
    void usb
      .getDevices()
      .then((known) => {
        if (cancelled) return;
        const match = known.find((candidate) => candidate.vendorId === SEEK_VENDOR_ID);
        if (match !== undefined) adopt(match, NO_DEVICE);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  useEffect(() => {
    const usb = getWebUsb();
    if (usb === null) return;
    const onConnect = (event: USBConnectionEvent): void => {
      if (current.current === null && event.device.vendorId === SEEK_VENDOR_ID) {
        adopt(event.device, NO_DEVICE);
      }
    };
    const onDisconnect = (event: USBConnectionEvent): void => {
      if (current.current === event.device) adopt(null, 'Device disconnected.');
    };
    usb.addEventListener('connect', onConnect);
    usb.addEventListener('disconnect', onDisconnect);
    return () => {
      usb.removeEventListener('connect', onConnect);
      usb.removeEventListener('disconnect', onDisconnect);
    };
  }, [adopt]);

  const connect = useCallback(async (): Promise<ConnectOutcome> => {
    const usb = getWebUsb();
    if (usb === null) return { kind: 'failed', message: 'WebUSB is not available in this browser' };
    try {
      const chosen = await usb.requestDevice({ filters: [{ vendorId: SEEK_VENDOR_ID }] });
      adopt(chosen, NO_DEVICE);
      return { kind: 'connected', description: describeUsbDevice(chosen) };
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') return { kind: 'cancelled' };
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
  }, [adopt]);

  const forget = useCallback(async (): Promise<ConnectOutcome> => {
    const held = current.current;
    try {
      if (held !== null && canForget(held)) await held.forget();
      adopt(null, 'Permission revoked.');
      return { kind: 'connected', description: 'Permission revoked.' };
    } catch (error) {
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
  }, [adopt]);

  const makeTransport = useCallback(
    (options: TransportOptions): WebUsbTransport => {
      if (device === null) throw new Error('no device is connected');
      return new WebUsbTransport(asWebUsbDevice(device), {
        recipient: options.recipient,
        api: 'WebUSB',
        host: typeof navigator === 'undefined' ? null : navigator.userAgent,
        ...(options.onWarning ? { onWarning: options.onWarning } : {}),
      });
    },
    [device],
  );

  return useMemo(
    () => ({
      device,
      description,
      generation,
      canForgetDevice: device !== null && canForget(device),
      connect,
      forget,
      makeTransport,
    }),
    [device, description, generation, connect, forget, makeTransport],
  );
}
