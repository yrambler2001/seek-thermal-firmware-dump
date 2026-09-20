/**
 * `seek-fw devices` — list the cameras this host can see.
 *
 * Finding none is not an error: the command exits 0 and says so, because
 * "nothing plugged in" is a legitimate answer to the question. What it does do
 * is print the platform's permission advice, since on Linux and Windows a
 * camera that IS plugged in can be invisible for exactly one fixable reason.
 */

import { summarizeDevice } from '../backend.js';
import type { CommandContext, CommandResult } from '../cli.js';
import { permissionHint } from '../errors.js';
import { backendFor, table } from './shared.js';

export async function devicesCommand(ctx: CommandContext): Promise<CommandResult> {
  const backend = backendFor(ctx, { recipient: ctx.options.recipient });
  const transports = await backend.listDevices();
  const devices = transports.map((transport) => summarizeDevice(transport));

  if (ctx.human) {
    if (devices.length === 0) {
      ctx.out('no Seek camera found');
      if (ctx.io.platform === 'linux' || ctx.io.platform === 'win32') {
        ctx.out('');
        ctx.out(permissionHint(ctx.io.platform));
      }
    } else {
      ctx.out(
        table(
          devices.map((device) => [
            device.vendorId,
            device.productId,
            device.productName ?? '(no product string)',
            device.manufacturerName ?? '',
            device.serialNumber ?? '',
          ]),
          ['vendor', 'product', 'name', 'manufacturer', 'serial'],
        ),
      );
    }
  }

  return { count: devices.length, devices };
}
