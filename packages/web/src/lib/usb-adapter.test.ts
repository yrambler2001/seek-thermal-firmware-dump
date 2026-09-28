import { describe, expect, it } from 'vitest';
import { WebUsbTransport } from '@seek-fw/core';
import { asWebUsbDevice } from './usb-adapter';

/**
 * A `USBDevice` as Chrome hands one over, for the attributes this test reads.
 *
 * The 2014 Compacts 0.6.0.4 .. 1.3.0.0 name iSerialNumber 5 and answer string 5
 * with the head of their configuration descriptor (FW-V1 Phase 53). Chrome on
 * macOS and Windows reads the string itself, `ParseUsbStringDescriptor` refuses a
 * reply whose bDescriptorType is not 3, and the device keeps the empty string it
 * started with: `serialNumber` is "". On Linux it has no sysfs `serial`: null.
 * Either way the camera has no serial string (TESTING.md sec.21.1).
 */
function chromeDevice(serialNumber: string | null): USBDevice {
  return {
    vendorId: 0x289d,
    productId: 0x0010,
    manufacturerName: 'Seek Thermal',
    productName: 'PIR206 Thermal Camera',
    serialNumber,
    configuration: null,
    opened: false,
  } as unknown as USBDevice;
}

describe('the web path, on a camera whose serial string cannot be read', () => {
  it('reports null, the same as the CLI, whichever way Chrome says "none"', () => {
    for (const serial of ['', null]) {
      const transport = new WebUsbTransport(asWebUsbDevice(chromeDevice(serial)));
      expect(transport.description, JSON.stringify(serial)).toMatchObject({
        serialNumber: null,
        productName: 'PIR206 Thermal Camera',
        manufacturerName: 'Seek Thermal',
      });
    }
  });

  it('keeps a real serial string as it is', () => {
    const transport = new WebUsbTransport(asWebUsbDevice(chromeDevice('1818B0Z3K6C8')));
    expect(transport.description.serialNumber).toBe('1818B0Z3K6C8');
  });
});
