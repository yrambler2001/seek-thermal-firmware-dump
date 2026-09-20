/**
 * The redesign's acceptance criterion, not a hope.
 *
 * Before the Tailwind/shadcn rewrite an audit counted the accessibility
 * affordances this tool had put in by hand: `scope` on every table header,
 * `aria-labelledby` on every section, live regions on every status line,
 * `aria-invalid`/`aria-describedby` on rejected options, `aria-current` on the
 * view switch, valued progress bars, `role="log"` transcripts. This pins the
 * equivalents — whether they come from our own markup or from a Radix
 * primitive — so a future restyle cannot quietly drop one.
 *
 * The numbers are floors measured against the pre-redesign build, not targets.
 */

import { describe, expect, it } from 'vitest';
import { App } from './App';
import { DeviceInfoPanel } from './components/DeviceInfoPanel';
import { FlashPreview } from './components/FlashPreview';
import { OptionsDetails } from './components/OptionsDetails';
import { RunPanel } from './components/RunPanel';
import { DEFAULT_OPTIONS_FORM } from './lib/options';
import { detectSupport, type BrowserEnvironment } from './lib/support';
import { fakeDeviceState, fakePreparedFlash } from './test-fixtures';
import { render } from './test-helpers';

const READY = detectSupport({
  hasWebUsb: true,
  userAgent: 'Chrome',
  platform: 'MacIntel',
  maxTouchPoints: 0,
  isSecureContext: true,
  protocol: 'https:',
} satisfies BrowserEnvironment);

function count(root: ParentNode, selector: string): number {
  return root.querySelectorAll(selector).length;
}

/** The audited floor for each view, measured on the build being replaced. */
const FLOOR: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  '#/': {
    'section[aria-labelledby]': 7,
    '[aria-live="polite"]': 4,
    '[role="status"]': 3,
    '[role="progressbar"]': 3,
    '[aria-invalid]': 4,
    '[aria-current="page"]': 1,
    '[role="group"][aria-label]': 3,
    'th[scope="col"]': 6,
    'th[scope="row"]': 6,
    'table > caption': 2,
    'label[for]': 6,
    details: 2,
  },
  '#/flash': {
    'section[aria-labelledby]': 5,
    '[aria-live="polite"]': 3,
    '[role="status"]': 2,
    '[role="progressbar"]': 2,
    '[aria-current="page"]': 1,
    '[role="group"][aria-label]': 3,
    'th[scope="col"]': 4,
    'th[scope="row"]': 5,
    'table > caption': 1,
    'label[for]': 2,
    details: 4,
  },
};

describe('accessibility parity', () => {
  for (const [hash, floors] of Object.entries(FLOOR)) {
    it(`${hash} keeps every landmark, scope, live region and label the audit found`, () => {
      window.location.hash = hash;
      const { container, unmount } = render(<App support={READY} />);
      for (const [selector, minimum] of Object.entries(floors)) {
        expect(count(container, selector), `${hash} ${selector}`).toBeGreaterThanOrEqual(minimum);
      }
      unmount();
    });

    it(`${hash} gives every input and select a real <label for>`, () => {
      window.location.hash = hash;
      const { container, unmount } = render(<App support={READY} />);

      const controls = [...container.querySelectorAll<HTMLElement>('input, select, textarea')];
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        /* The file pickers' inputs are the browser's dialog, not a control:
         * they are out of the tab order and out of the a11y tree entirely. */
        if (control.getAttribute('aria-hidden') === 'true') continue;
        expect(control.id, `${control.tagName} has no id`).not.toBe('');
        expect(
          container.querySelector(`label[for="${control.id}"]`),
          `no <label for="${control.id}">`,
        ).toBeTruthy();
      }
      unmount();
    });

    it(`${hash} issues every id exactly once`, () => {
      window.location.hash = hash;
      const { container, unmount } = render(<App support={READY} />);

      /* A duplicate id silently breaks `label[for]`, `aria-labelledby` and
       * `aria-describedby` — every association on this page runs through one. */
      const ids = [...container.querySelectorAll('[id]')].map((node) => node.id);
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      expect(duplicates).toEqual([]);
      expect(ids.length).toBeGreaterThan(5);
      unmount();
    });

    it(`${hash} builds every control out of a real element`, () => {
      window.location.hash = hash;
      const { container, unmount } = render(<App support={READY} />);

      /* Nothing is a div pretending to be a control. */
      expect(count(container, '[role="button"]')).toBe(0);
      expect(count(container, '[role="checkbox"]')).toBe(0);
      expect(count(container, '[role="textbox"]')).toBe(0);
      expect(count(container, '[role="link"]')).toBe(0);

      const REAL = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
      for (const node of container.querySelectorAll<HTMLElement>('[tabindex]')) {
        const allowed = REAL.has(node.tagName) || node.getAttribute('role') === 'log';
        expect(allowed, `${node.tagName} is focusable but is not a control`).toBe(true);
      }

      /* Every button says what it does in words, not only in an icon. */
      for (const button of container.querySelectorAll('button')) {
        expect(button.textContent.trim().length, 'a button has no accessible name').toBeGreaterThan(
          0,
        );
      }
      unmount();
    });
  }

  it('the run panel is a valued progress bar, a live status and a log transcript', () => {
    const { container, unmount } = render(
      <RunPanel
        id="dump"
        label="Dump"
        progress={{ done: 5, total: 10, text: 'window 5 of 10 ...' }}
        lines={[
          { seq: 1, level: 'ok', text: 'read 0x14010000' },
          { seq: 2, level: 'warn', text: 'retrying' },
        ]}
        trimmed={3}
      />,
    );

    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('50');
    expect(bar?.getAttribute('aria-valuemin')).toBe('0');
    expect(bar?.getAttribute('aria-valuemax')).toBe('100');
    expect(bar?.getAttribute('aria-valuetext')).toBe('window 5 of 10 ...');
    expect(bar?.getAttribute('aria-label')).toBe('Dump progress');

    const status = container.querySelector('#dump-status');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toBe('window 5 of 10 ...');

    const log = container.querySelector('[role="log"]');
    expect(log?.getAttribute('aria-label')).toBe('Dump log');
    expect(log?.getAttribute('tabindex')).toBe('0');
    expect(log?.textContent).toContain('3 earlier line(s) trimmed');
    unmount();
  });

  it('marks a rejected option invalid and points it at the message', () => {
    const { container, unmount } = render(
      <OptionsDetails
        value={DEFAULT_OPTIONS_FORM}
        onChange={() => undefined}
        disabled={false}
        invalidField="chunk"
        errorMessage="chunk must be between 1 and 65536, got 0x1ff"
      />,
    );

    const chunk = container.querySelector('#optChunk');
    expect(chunk?.getAttribute('aria-invalid')).toBe('true');
    const describedBy = chunk?.getAttribute('aria-describedby');
    expect(describedBy).toBe('opt-error');
    const message = container.querySelector(`#${describedBy ?? ''}`);
    expect(message?.getAttribute('role')).toBe('alert');
    expect(message?.textContent).toContain('chunk must be between 1 and 65536');

    /* The other three are explicitly valid rather than silently unmarked. */
    expect(container.querySelector('#optGapFill')?.getAttribute('aria-invalid')).toBe('false');
    unmount();
  });

  it('keeps the slot list a real table with a caption and scoped headers', async () => {
    const state = await fakeDeviceState();
    const { container, unmount } = render(<DeviceInfoPanel state={state} />);

    const table = container.querySelector('table');
    expect(table).toBeTruthy();
    expect(table?.querySelector('caption')?.textContent).toContain('Each firmware slot');
    expect(count(container, 'th[scope="col"]')).toBe(5);
    /* One row header per slot, so a card-per-row phone layout still says
     * which slot each value belongs to. */
    expect(count(container, 'th[scope="row"]')).toBe(state.slots.length);
    expect(state.slots.length).toBeGreaterThan(0);

    /* The roles are written out, because the phone layout sets
     * `display: block` and that strips a table's implicit semantics. */
    expect(table?.getAttribute('role')).toBe('table');
    expect(count(container, 'tr[role="row"]')).toBeGreaterThan(0);
    expect(count(container, '[role="rowgroup"]')).toBe(2);
    unmount();
  });

  it('keeps the header comparison a real table too', async () => {
    const state = await fakeDeviceState();
    const { container, unmount } = render(
      <FlashPreview state={state} prep={fakePreparedFlash()} sha256={'a'.repeat(64)} />,
    );

    const caption = container.querySelector('caption');
    expect(caption?.textContent).toContain('Header fields that differ');
    expect(count(container, 'th[scope="col"]')).toBe(3);
    expect(count(container, 'th[scope="row"]')).toBe(2);
    unmount();
  });
});
