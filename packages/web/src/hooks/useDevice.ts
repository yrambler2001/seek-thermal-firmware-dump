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
  /**
   * Adopts an authorized Seek camera straight from `navigator.usb.getDevices()`
   * — no chooser, no gesture, no reliance on the connect event. The reattach
   * path for the reset dance: a camera rebooted by command re-enumerates while
   * the page holds nothing, and a missed `connect` event must not strand the
   * run when the device is demonstrably back on the bus. True when one was
   * adopted.
   */
  reattach: () => Promise<boolean>;
  /** Builds a fresh transport. Never cached: each run opens and closes its own. */
  makeTransport: (options: TransportOptions) => WebUsbTransport;
}

const NO_DEVICE = 'No device selected.';

export function useDevice(): DeviceHandle {
  const [device, setDevice] = useState<USBDevice | null>(null);
  const [description, setDescription] = useState(NO_DEVICE);
  const [generation, setGeneration] = useState(0);
  const current = useRef<USBDevice | null>(null);
  /* The unit that just dropped off the bus, as its vid/pid. This camera has
   * no USB serial string, so vid/pid is the only identity a reconnect can be
   * judged by — and the preserve wizard's reset (the drain step's wire-89)
   * re-enumerates the same unit after roughly ten seconds of boot silence.
   * A connect event is auto-adopted only when it matches what dropped (or
   * when nothing dropped — the page-load case, where the vendor match alone
   * decides as it always has). A different model is never adopted silently:
   * swapping cameras is a user decision. */
  const dropped = useRef<{ vid: number; pid: number } | null>(null);

  const adopt = useCallback((next: USBDevice | null, reason: string): void => {
    if (current.current === next) return;
    current.current = next;
    if (next !== null) dropped.current = null;
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
      const last = dropped.current;
      const sameShape =
        last === null ||
        (event.device.vendorId === last.vid && event.device.productId === last.pid);
      if (current.current === null && event.device.vendorId === SEEK_VENDOR_ID && sameShape) {
        adopt(event.device, NO_DEVICE);
      }
    };
    const onDisconnect = (event: USBConnectionEvent): void => {
      if (current.current === event.device) {
        dropped.current = { vid: event.device.vendorId, pid: event.device.productId };
        adopt(null, 'Device disconnected.');
      }
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

  const reattach = useCallback(async (): Promise<boolean> => {
    if (current.current !== null) return true;
    const usb = getWebUsb();
    if (usb === null) return false;
    try {
      const known = await usb.getDevices();
      const match = known.find((candidate) => candidate.vendorId === SEEK_VENDOR_ID);
      if (match === undefined) return false;
      adopt(match, NO_DEVICE);
      return true;
    } catch {
      return false;
    }
  }, [adopt]);

  const makeTransport = useCallback((options: TransportOptions): WebUsbTransport => {
    /* Read through the ref, not the state: the preserve wizard's opener
     * ladder holds this closure across a reset — the camera that
     * re-enumerates after the ~10 s boot silence is a NEW USBDevice
     * object, and the ladder's next attempt must open that one, not the
     * dead object the phase started with. */
    const held = current.current;
    if (held === null) throw new Error('no device is connected');
    return new WebUsbTransport(asWebUsbDevice(held), {
      recipient: options.recipient,
      api: 'WebUSB',
      host: typeof navigator === 'undefined' ? null : navigator.userAgent,
      ...(options.onWarning ? { onWarning: options.onWarning } : {}),
    });
  }, []);

  return useMemo(
    () => ({
      device,
      description,
      generation,
      canForgetDevice: device !== null && canForget(device),
      connect,
      forget,
      reattach,
      makeTransport,
    }),
    [device, description, generation, connect, forget, reattach, makeTransport],
  );
}
