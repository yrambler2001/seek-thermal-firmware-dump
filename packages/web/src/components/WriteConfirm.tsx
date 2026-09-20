/**
 * The last thing between a $300 camera and an erase.
 *
 * The original page used `window.confirm()`. This says the same words in a
 * real modal — Radix's AlertDialog — so they can be read at leisure, focus is
 * trapped, Escape backs out, and the initial focus is on *Cancel*. Confirming
 * takes a deliberate move of focus; nothing about holding a key down can
 * reach the write.
 */

import { useRef, type ReactElement } from 'react';
import { Flame } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from './ui/alert-dialog';

export interface WriteConfirmProps {
  readonly open: boolean;
  readonly fileName: string;
  readonly targetName: string;
  readonly targetAddress: string;
  readonly rekeyRisk: boolean;
  readonly bootedName: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function WriteConfirm({
  open,
  fileName,
  targetName,
  targetAddress,
  rekeyRisk,
  bootedName,
  onConfirm,
  onCancel,
}: WriteConfirmProps): ReactElement {
  /* Radix closes on its own after the action fires. Without this the close
   * would report itself as a cancellation too, and the caller would be told
   * both things happened. */
  const confirmed = useRef(false);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        if (confirmed.current) {
          confirmed.current = false;
          return;
        }
        onCancel();
      }}
    >
      <AlertDialogContent aria-describedby="write-confirm-what">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/12 text-destructive"
          >
            <Flame className="size-4" />
          </span>
          <AlertDialogTitle>{`Write ${fileName} to ${targetName} at ${targetAddress}?`}</AlertDialogTitle>
        </div>

        {rekeyRisk && (
          <p className="rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[0.85rem] font-medium text-destructive">
            {`WARNING: this camera stores upgrades under a key its bootloader does not know, so this ` +
              `slot will be skipped at boot and the camera will keep running ${
                bootedName ?? 'the other slot'
              }.`}
          </p>
        )}

        <AlertDialogDescription id="write-confirm-what" className="space-y-2">
          <span className="block">
            This erases a 64 KiB block of the camera&apos;s flash and repoints its boot config.
          </span>
          <span className="block">
            If the image does not run, the camera cannot be recovered over USB — only with
            SWD/J-Link or an SPI programmer.
          </span>
        </AlertDialogDescription>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              confirmed.current = true;
              onConfirm();
            }}
          >
            Yes — write to camera
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
