/**
 * Fixtures the rendering tests need and the hooks do not: a camera that
 * answers every read, the `DeviceState` core builds out of it, and a prepared
 * write plan. Shared so the a11y and safety-copy tests exercise the *real*
 * shapes rather than a hand-drawn approximation of them.
 */

import {
  OP,
  SeekDevice,
  WebUsbTransport,
  getProfile,
  readDeviceInfo,
  type DeviceState,
  type PreparedFlash,
  type Reporter,
  type WebUsbDevice,
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
