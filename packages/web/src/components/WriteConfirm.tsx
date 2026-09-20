/**
 * The explicit confirmation in front of the only destructive action in the
 * tool. The original used `window.confirm()`; this says the same words in the
 * page, where they can be read at leisure, and defaults focus to *Cancel*.
 */

import { useEffect, useRef, type ReactElement } from 'react';

export interface WriteConfirmProps {
  readonly fileName: string;
  readonly targetName: string;
  readonly targetAddress: string;
  readonly rekeyRisk: boolean;
  readonly bootedName: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function WriteConfirm({
  fileName,
  targetName,
  targetAddress,
  rekeyRisk,
  bootedName,
  onConfirm,
  onCancel,
}: WriteConfirmProps): ReactElement {
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    container.current?.focus();
  }, []);

  return (
    <div
      className="confirm"
      role="group"
      aria-labelledby="write-confirm-heading"
      tabIndex={-1}
      ref={container}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <p id="write-confirm-heading">
        <strong>{`Write ${fileName} to ${targetName} at ${targetAddress}?`}</strong>
      </p>
      {rekeyRisk && (
        <p className="l-err">
          {`WARNING: this camera stores upgrades under a key its bootloader does not know, so this ` +
            `slot will be skipped at boot and the camera will keep running ${
              bootedName ?? 'the other slot'
            }.`}
        </p>
      )}
      <p>This erases a 64 KiB block of the camera&apos;s flash and repoints its boot config.</p>
      <p>
        If the image does not run, the camera cannot be recovered over USB — only with SWD/J-Link or
        an SPI programmer.
      </p>
      <div className="btnrow" style={{ marginTop: '.6rem' }}>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary danger" onClick={onConfirm}>
          Yes — write to camera
        </button>
      </div>
    </div>
  );
}
