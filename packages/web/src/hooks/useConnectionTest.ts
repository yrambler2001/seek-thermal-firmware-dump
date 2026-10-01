/**
 * "Test connection" — the original's cheapest possible proof that the browser
 * can actually talk to the camera: open, ask for the operation mode and the
 * error code, close. Two read opcodes, nothing written.
 */

import { useCallback, useMemo } from 'react';
import { SeekDevice, errorMessage, hex } from '@seek-fw/core';
import { logHint } from '../lib/hints';
import { readOptions, type OptionsForm } from '../lib/options';
import type { DeviceHandle } from './useDevice';
import type { ReporterHandle } from './useReporter';
import type { Runner } from './useRunner';
import type { Route } from '../lib/routing';

export const TEST_PANEL_ID = 'test';

export interface ConnectionTestParams {
  readonly runner: Runner;
  readonly device: DeviceHandle;
  readonly form: OptionsForm;
  readonly reporter: ReporterHandle;
  readonly route: Route;
}

export interface ConnectionTestApi {
  readonly testing: boolean;
  test: () => Promise<void>;
}

export function useConnectionTest(params: ConnectionTestParams): ConnectionTestApi {
  const { runner, device, form, reporter, route } = params;

  const test = useCallback(
    (): Promise<void> =>
      runner.start(TEST_PANEL_ID, async (signal) => {
        let transport: ReturnType<DeviceHandle['makeTransport']> | null = null;
        try {
          const options = readOptions(form);
          transport = device.makeTransport({
            recipient: options.recipient,
            onWarning: (message) => {
              reporter.log(message, 'warn');
            },
          });
          const client = new SeekDevice(transport, { reporter: reporter.reporter, signal });
          await transport.open();
          const info = transport.info;
          reporter.log(
            `opened; recipient=${info.recipient}` +
              (info.claimedInterface ? ' (interface 0 claimed)' : ' (no claim)'),
            'detail',
          );
          const mode = await client.getOperationMode();
          const code = await client.getErrorCode();
          reporter.log(
            `GetOperationMode -> ${mode === null ? 'no data' : hex(mode)}, ` +
              `GetErrorCode -> ${code === null ? 'no data' : hex(code)}`,
            code ? 'warn' : 'ok',
          );
          reporter.log(
            route === 'flash'
              ? 'transport works — press "Read device info" to see what this camera is running'
              : route === 'preserve'
                ? 'transport works — run a step in the preserve wizard when you are ready'
                : 'transport works — ready to dump',
            'ok',
          );
        } catch (error) {
          /* The likeliest failure here is a claim the browser cannot make,
           * and that one is fixed off the page — by a udev rule, by Zadig, or
           * by quitting whatever else holds the camera. */
          reporter.log(`test failed: ${errorMessage(error)}`, 'error');
          logHint(reporter.log, error);
        } finally {
          if (transport !== null) await transport.close();
        }
      }),
    [device, form, reporter, route, runner],
  );

  return useMemo(() => ({ testing: runner.active === TEST_PANEL_ID, test }), [runner.active, test]);
}
