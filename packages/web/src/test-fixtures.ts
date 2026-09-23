/**
 * Fixtures the rendering tests need and the hooks do not: a camera that
 * answers every read, the `DeviceState` core builds out of it, and a prepared
 * write plan. Shared so the a11y and safety-copy tests exercise the *real*
 * shapes rather than a hand-drawn approximation of them.
 */

import {
  OLD_FW_UNLOCK_TOKEN,
  OP,
  SeekDevice,
  WebUsbTransport,
  getProfile,
  readDeviceInfo,
  type DeviceState,
  type PreparedFlash,
  type Reporter,
  type WebUsbDevice,
  type WebUsbInTransferResult,
  type WorkflowContext,
} from '@seek-fw/core';

export const SILENT_REPORTER: Reporter = {
  log: () => undefined,
  progress: () => undefined,
  artifact: () => undefined,
};

/**
 * A camera that answers every read with 0xA5. No slot carries an image
 * header, so the analysis comes back with `canFlash: false` — which is the
 * correct answer for this fake, and leaves every slot row rendering its
 * "not readable" branch.
 */
export function fakeCamera(): WebUsbDevice {
  let opened = false;
  return {
    vendorId: 0x289d,
    productId: 0x0011,
    manufacturerName: 'Seek Thermal',
    productName: 'Fake PIR324',
    serialNumber: '0E1CA0Z16D19',
    configuration: { configurationValue: 1 },
    get opened(): boolean {
      return opened;
    },
    open: () => {
      opened = true;
      return Promise.resolve();
    },
    close: () => {
      opened = false;
      return Promise.resolve();
    },
    selectConfiguration: () => Promise.resolve(),
    claimInterface: () => Promise.resolve(),
    releaseInterface: () => Promise.resolve(),
    controlTransferIn: (setup, length) => {
      if (setup.request === OP.GET_ERROR_CODE) {
        return Promise.resolve({ status: 'ok', data: new DataView(new ArrayBuffer(4)) });
      }
      if (setup.request === OP.GET_OPERATION_MODE) {
        return Promise.resolve({ status: 'ok', data: new DataView(new ArrayBuffer(2)) });
      }
      const block = new Uint8Array(length).fill(0xa5);
      return Promise.resolve({ status: 'ok', data: new DataView(block.buffer) });
    },
    controlTransferOut: () => Promise.resolve({ status: 'ok', bytesWritten: 2 }),
  };
}

/** A real `DeviceState`, built by core's own analysis of the fake camera. */
export async function fakeDeviceState(): Promise<DeviceState> {
  const transport = new WebUsbTransport(fakeCamera(), { recipient: 'interface' });
  await transport.open();
  const ctx: WorkflowContext = {
    device: new SeekDevice(transport, { reporter: SILENT_REPORTER }),
    profile: getProfile('modern-4x'),
    detection: null,
    reporter: SILENT_REPORTER,
  };
  return readDeviceInfo(ctx);
}

/**
 * A write plan with every optional branch turned on — a re-keyed image, a
 * header that differs from the running one, a moved vector table — so the
 * preview renders all of its tables and all of its warnings at once.
 */
export function fakePreparedFlash(): PreparedFlash {
  const payload = new Uint8Array(256);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index & 0xff;
  return {
    fileName:
      'seek_fw_slotA-KeyA-00112233445566778899aabbccddeeff-KeyB-ffeeddccbbaa99887766554433221100.bin',
    originalSize: 196_608,
    targetName: 'slot B',
    bootedName: 'slot A',
    runningSlot: 'slot A',
    header: {
      versionStr: '4.9.1.5',
      imageId: 0x0000_0011,
      sp: 0x1000_0400,
      entry: 0x1401_0201,
      length: 196_608,
    },
    length: 196_608,
    declaredBefore: 196_600,
    lengthStamped: true,
    adjust: 0x1234_5678,
    keyA: new Uint8Array(16).fill(0xab),
    keyPatch: {
      changed: true,
      where: 'offset 0x0002f000',
      fromA: '00112233445566778899aabbccddeeff',
      fromB: 'ffeeddccbbaa99887766554433221100',
      toA: 'abababababababababababababababab',
      toB: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
    },
    carriesMine: true,
    footer: { length: 196_608, model: 'PIR324' },
    footerOffset: 0x0003_ffc0,
    footerFrom: 'slot A',
    payload,
    sum16: 0xbeef,
    rekeyRisk: true,
    layoutMoved: true,
    compare: [
      { field: 'version', onCamera: '4.9.1.4', inImage: '4.9.1.5' },
      { field: 'initial SP', onCamera: '0x10000200', inImage: '0x10000400' },
    ],
  } as unknown as PreparedFlash;
}

/* ---- a camera that answers the way a given firmware line does ---------- */

/** One vendor request as the camera saw it. */
export interface CameraCall {
  readonly dir: 'in' | 'out';
  readonly request: number;
  readonly length: number;
  readonly data: Uint8Array | null;
}

export interface ScriptedCameraOptions {
  /**
   * The four version bytes GetFirmwareInfo answers with — or null for a camera
   * that never answers it (every GetFirmwareInfo stalls), which is what the
   * emulated Compact 0.5.1.0 and 0.5.1.3 do after enumerating.
   */
  readonly version: readonly [number, number, number, number] | null;
  /**
   * The locked 2014-2017 line: a plain 2-byte arm of banks 2..9 is refused
   * (the handler's `(mode - 2) <= 7` lock), and the 18-byte arm is accepted
   * only with the firmware's token. Off: the post-2018 handler, which arms
   * every bank on either form.
   */
  readonly legacy?: boolean;
}

export interface ScriptedCamera {
  readonly camera: WebUsbDevice;
  /** Every vendor request, in order. */
  readonly calls: CameraCall[];
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * A camera that answers like one firmware line: its version, its channel lock
 * and its token check. Every window reads back as 0xA5, so no image is found
 * and the decrypt stage stays out of the way. A refusal is a STALL, as it is
 * on the wire: the dispatcher stalls a control request whose handler returns
 * an error status.
 */
export function scriptedCamera(options: ScriptedCameraOptions): ScriptedCamera {
  const calls: CameraCall[] = [];
  let opened = false;
  let armed = false;
  const ok = (bytes: Uint8Array): Promise<WebUsbInTransferResult> =>
    Promise.resolve({
      status: 'ok',
      data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    });
  const stall = (): Promise<WebUsbInTransferResult> =>
    Promise.resolve({ status: 'stall', data: new DataView(new ArrayBuffer(0)) });

  const camera: WebUsbDevice = {
    vendorId: 0x289d,
    productId: options.legacy === true ? 0x0010 : 0x0011,
    manufacturerName: 'Seek Thermal',
    productName: options.legacy === true ? 'PIR206 Thermal Camera' : 'Fake PIR324',
    serialNumber: null,
    configuration: { configurationValue: 1 },
    get opened(): boolean {
      return opened;
    },
    open: () => {
      opened = true;
      return Promise.resolve();
    },
    close: () => {
      opened = false;
      return Promise.resolve();
    },
    selectConfiguration: () => Promise.resolve(),
    claimInterface: () => Promise.resolve(),
    releaseInterface: () => Promise.resolve(),
    controlTransferIn: (setup, length) => {
      calls.push({ dir: 'in', request: setup.request, length, data: null });
      switch (setup.request) {
        case OP.GET_ERROR_CODE:
          return ok(new Uint8Array(4));
        case OP.GET_OPERATION_MODE:
          return ok(new Uint8Array(2));
        case OP.GET_FIRMWARE_INFO: {
          if (options.version === null) return stall();
          const block = new Uint8Array(36);
          block.set(options.version, 0);
          block.set(new TextEncoder().encode('Jan  6 2017 11:16:17'), 4);
          return ok(block.subarray(0, Math.min(length, block.length)));
        }
        case OP.GET_FEATURED_FIRMWARE_DATA:
          return armed ? ok(new Uint8Array(length).fill(0xa5)) : stall();
        default:
          return stall();
      }
    },
    controlTransferOut: (setup, data) => {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
      calls.push({ dir: 'out', request: setup.request, length: bytes.length, data: bytes });
      const accepted = Promise.resolve({ status: 'ok' as const, bytesWritten: bytes.length });
      const refused = Promise.resolve({ status: 'stall' as const, bytesWritten: 0 });
      if (setup.request === OP.SET_OPERATION_MODE) return accepted;
      if (setup.request !== OP.BEGIN_FIRMWARE_UPGRADE) return refused;
      const subcmd = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8);
      if (options.legacy === true) {
        if (bytes.length === 18 && !sameBytes(bytes.subarray(2), OLD_FW_UNLOCK_TOKEN)) {
          return refused;
        }
        if (bytes.length === 2 && subcmd >= 2 && subcmd <= 9) return refused;
      }
      armed = true;
      return accepted;
    },
  };
  return { camera, calls };
}
