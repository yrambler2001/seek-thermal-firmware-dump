/**
 * The shell: the masthead, the support banner, the two-view nav and the
 * Connect panel that both views share — then whichever view the hash selects.
 *
 * All the state that outlives a view lives here (the device, the run lock, the
 * options form, the firmware-profile choices), so switching tabs mid-run does
 * not disturb anything.
 */

import { useCallback, useMemo, useState, type ReactElement } from 'react';
import type { ProfileId } from '@seek-fw/core';
import { AppHeader } from './components/AppHeader';
import { ConnectSection } from './components/ConnectSection';
import { Prose } from './components/Prose';
import { SupportBanner } from './components/SupportBanner';
import { useConnectionTest } from './hooks/useConnectionTest';
import { useDevice } from './hooks/useDevice';
import { useDumpPanel } from './hooks/useDumpPanel';
import { useFlashPanel } from './hooks/useFlashPanel';
import { useOfflineDecrypt } from './hooks/useOfflineDecrypt';
import { useRunner } from './hooks/useRunner';
import type { ProfileChoice } from './lib/identify';
import { DEFAULT_OPTIONS_FORM, type OptionsFailure, type OptionsForm } from './lib/options';
import { useRoute } from './lib/routing';
import { detectSupport, readBrowserEnvironment, type SupportStatus } from './lib/support';
import { DumpView } from './views/DumpView';
import { FlashView } from './views/FlashView';

export interface AppProps {
  /** Injectable so the render tests can drive every environment. */
  readonly support?: SupportStatus;
}

export function App({ support }: AppProps = {}): ReactElement {
  const route = useRoute();
  const status = useMemo(() => support ?? detectSupport(readBrowserEnvironment()), [support]);

  const device = useDevice();
  const runner = useRunner();
  const [options, setOptions] = useState<OptionsForm>(DEFAULT_OPTIONS_FORM);
  const [optionsFailure, setOptionsFailure] = useState<OptionsFailure | null>(null);
  const [profileChoice, setProfileChoice] = useState<ProfileChoice>('auto');
  /* The dump view's expert override. It starts on the legacy family because
   * that is what the page's old "Dump legacy firmware" button forced, and it
   * is only ever used when someone presses its own button. */
  const [manualProfile, setManualProfile] = useState<ProfileId>('legacy-auth');

  const onOptionsFailure = useCallback((failure: OptionsFailure | null): void => {
    setOptionsFailure(failure);
  }, []);

  /* The camera is asked which family it is; nobody picks. */
  const dump = useDumpPanel({
    id: 'dump',
    runner,
    device,
    form: options,
    choice: 'auto',
    dirPrefix: 'seek_flash4m_',
    sweepPrefix: 'seek_selectors_',
    onOptionsFailure,
  });

  /* The same runs under a family picked by hand — which still read and check
   * the firmware version before anything is armed. */
  const manual = useDumpPanel({
    id: 'manual',
    runner,
    device,
    form: options,
    choice: manualProfile,
    dirPrefix: `seek_flash4m_${manualProfile}_`,
    sweepPrefix: `seek_selectors_${manualProfile}_`,
    onOptionsFailure,
  });

  const offline = useOfflineDecrypt({ id: 'offline', runner });

  const flash = useFlashPanel({
    runner,
    device,
    form: options,
    profileChoice,
    onOptionsFailure,
  });

  /* The original routed the Connect panel's own log lines into whichever
   * view's main panel was showing. Same rule. */
  const viewReporter = route === 'flash' ? flash.infoReporter : dump.reporter;
  const { testing, test } = useConnectionTest({
    runner,
    device,
    form: options,
    reporter: viewReporter,
    route,
  });

  const onConnect = useCallback((): void => {
    void device.connect().then((outcome) => {
      if (outcome.kind === 'connected') {
        viewReporter.log(`selected ${outcome.description}`, 'ok');
      } else if (outcome.kind === 'cancelled') {
        viewReporter.log('no device chosen', 'detail');
      } else {
        viewReporter.log(`could not open the device chooser: ${outcome.message}`, 'error');
      }
    });
  }, [device, viewReporter]);

  const onForget = useCallback((): void => {
    void device.forget().then((outcome) => {
      if (outcome.kind === 'failed') viewReporter.log(`forget failed: ${outcome.message}`, 'error');
      else viewReporter.log('device permission revoked', 'detail');
    });
  }, [device, viewReporter]);

  return (
    <div className="min-h-dvh bg-background">
      <AppHeader route={route} connected={device.device !== null} canUseUsb={status.canUseUsb} />

      <main className="mx-auto w-full max-w-[64rem] space-y-4 px-4 pt-5 pb-20 sm:px-6">
        <Prose className="max-w-[62ch]">
          {route === 'dump' ? (
            <p>
              Reads the 4&nbsp;MiB SPIFI flash of a Seek Thermal camera over WebUSB and decrypts any
              firmware images it finds. Everything runs locally in your browser — nothing is
              uploaded anywhere. <strong>Read-only:</strong> this view issues no flash write, erase,
              upload, commit, or reset command.
            </p>
          ) : (
            <p>
              Shows what firmware the camera is running right now, and writes a new{' '}
              <em>plaintext</em> firmware image to it over WebUSB using the camera&apos;s own
              upgrade path. Everything runs locally in your browser.{' '}
              <strong>This view writes to flash.</strong> A bad image can leave the camera
              unbootable, and the bootloader has no USB — recovery would need SWD/J-Link or an SPI
              programmer.
            </p>
          )}
        </Prose>

        <SupportBanner status={status} />

        <ConnectSection
          description={device.description}
          connected={device.device !== null}
          canUseUsb={status.canUseUsb}
          canForget={device.canForgetDevice}
          busy={runner.busy}
          testing={testing}
          onConnect={onConnect}
          onTest={() => {
            void test();
          }}
          onForget={onForget}
        />

        {route === 'dump' ? (
          <DumpView
            dump={dump}
            manual={manual}
            manualProfile={manualProfile}
            onManualProfile={setManualProfile}
            offline={offline}
            connected={device.device !== null}
            busy={runner.busy}
            options={options}
            onOptionsChange={setOptions}
            optionsInvalidField={optionsFailure?.field ?? null}
            optionsErrorMessage={optionsFailure?.message ?? null}
          />
        ) : (
          <FlashView
            flash={flash}
            connected={device.device !== null}
            busy={runner.busy}
            profileChoice={profileChoice}
            onProfileChoice={setProfileChoice}
          />
        )}
      </main>
    </div>
  );
}
