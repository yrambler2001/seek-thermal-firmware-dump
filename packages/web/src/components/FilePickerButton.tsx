/**
 * A real `<button>` that opens a hidden `<input type="file">`, which is what
 * the original did too. The button is the focusable control; the input is only
 * the browser's file dialog and is kept out of the tab order and the
 * accessibility tree.
 */

import { useRef, type ReactElement, type ReactNode } from 'react';
import { Button, type ButtonProps } from './ui/button';

export interface FilePickerButtonProps {
  readonly id: string;
  readonly label: string;
  readonly accept: string;
  readonly disabled: boolean;
  readonly variant?: ButtonProps['variant'];
  readonly icon?: ReactNode;
  readonly onPick: (file: File) => void;
}

export function FilePickerButton({
  id,
  label,
  accept,
  disabled,
  variant,
  icon,
  onPick,
}: FilePickerButtonProps): ReactElement {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <Button
        variant={variant ?? 'outline'}
        disabled={disabled}
        onClick={() => {
          input.current?.click();
        }}
      >
        {icon}
        {label}
      </Button>
      <input
        ref={input}
        id={id}
        type="file"
        accept={accept}
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          /* Cleared so picking the same file twice fires `change` again. */
          event.target.value = '';
          if (file !== undefined) onPick(file);
        }}
      />
    </>
  );
}
