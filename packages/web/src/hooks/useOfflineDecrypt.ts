/**
 * "Decrypt a dump you already have" — the side door.
 *
 * Nothing here touches USB, which is the whole point: it works in Safari, in
 * Firefox and on iOS, where the rest of the page cannot. Ported from the
 * original's `decryptPickedFile`, with core's own offline README and manifest
 * builders in place of the hand-rolled ones.
 *
 * NEW versus the original: no firmware family is assumed. The profile is
 * omitted, so core scores the dump's own images against every registered family
 * and says which one it decided on and why. That verdict is surfaced in the UI
 * and written into the archive's manifest.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  CancelledError,
  HEADER_OFFSET,
  buildOfflineDecryptManifest,
  decryptDump,
  errorMessage,
  getProfile,
  isoStamp,
  makeOfflineDecryptReadme,
  manifestToJson,
  profileInfoOf,
  sha256hex,
  utf8,
  type Artifact,
  type DetectionResult,
} from '@seek-fw/core';
import { downloadArchive, mib } from '../lib/download';
import { logHint } from '../lib/hints';
import { yieldToUi } from '../lib/yield-to-ui';
import { useReporter, type ReporterHandle } from './useReporter';
import type { Runner } from './useRunner';

export interface OfflineDecryptParams {
  readonly id: string;
  readonly runner: Runner;
}

export interface OfflineDecryptApi {
  readonly reporter: ReporterHandle;
  readonly running: boolean;
  /** What core decided the last file was, or null before the first run. */
  readonly detection: DetectionResult | null;
  decryptFile: (file: File) => Promise<void>;
  cancel: () => void;
}

export function useOfflineDecrypt(params: OfflineDecryptParams): OfflineDecryptApi {
  const { id, runner } = params;
  const reporter = useReporter('No file chosen.');
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const running = runner.active === id;

  const execute = useCallback(
    async (file: File, signal: AbortSignal): Promise<void> => {
      const stem = file.name.replace(/\.[^./\\]+$/, '') || 'dump';
      reporter.reporter.log(`${file.name} — ${file.size.toLocaleString()} bytes`, 'detail');

      if (file.size < HEADER_OFFSET + 8) {
        reporter.reporter.log('file is too small to contain a firmware image header', 'error');
        reporter.reporter.progress(1, 1, 'Not a usable dump.');
        return;
      }
      if (file.size % 4 !== 0) {
        reporter.reporter.log(
          'warning: file size is not a multiple of 4; trailing bytes will be ignored',
          'warn',
        );
      }

      reporter.reporter.progress(0, 1, 'Reading file ...');
      await yieldToUi();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const inputSha = await sha256hex(bytes);
      reporter.reporter.log(`sha256 ${inputSha}`, 'detail');

      const startedAt = new Date().toISOString();
      /* No `profile`: with no camera attached there is no device evidence, so
       * core detects the family from the images in the file itself. */
      const result = await decryptDump(
        bytes,
        stem,
        { dumpPath: file.name, signal },
        reporter.reporter,
      );
      setDetection(result.detection);

      if (result.cancelled) {
        reporter.reporter.log('cancelled', 'warn');
        reporter.reporter.progress(1, 1, 'Cancelled.');
        return;
      }

      /* A file nothing decrypts out of is still worth an archive, and the
       * CLI has always written one: the manifest names the file, its SHA-256
       * and the profile that was tried, which is the citable evidence that
       * this dump holds no recoverable image. Only "too small to hold a
       * header" and a cancel package nothing. */
      const nothingDecrypted = result.slots.length === 0;
      if (nothingDecrypted) {
        reporter.reporter.log('');
        reporter.reporter.log(
          'no firmware image in this file could be decrypted — packaging the manifest anyway',
          'error',
        );
      }

      const profile = result.detection?.best.profile ?? getProfile('generic');
      const manifest = buildOfflineDecryptManifest({
        /* Same shape as the CLI's, differing only in the host, so two archives
         * of the same dump can be told apart and neither drifts. */
        producer: `seek-thermal-firmware-dump (web, ${profile.id})`,
        startedAt,
        finishedAt: new Date().toISOString(),
        source: { fileName: file.name, size: file.size, sha256: inputSha },
        flashBase: profile.memory.flashBase,
        decryption: result.summary,
        profile: profileInfoOf(profile, result.detection),
      });

      const outFiles: Artifact[] = [
        ...result.artifacts,
        { name: 'manifest.json', data: utf8(manifestToJson(manifest)) },
        { name: 'README.md', data: utf8(makeOfflineDecryptReadme(manifest)) },
      ];

      reporter.reporter.progress(1, 1, 'Building archive ...');
      await yieldToUi();

      const dirName = `${stem}_decrypted_${isoStamp()}`;
      const archive = downloadArchive(dirName, outFiles);

      const total = result.summary.attempted ? result.summary.images.length : 0;
      reporter.reporter.log('');
      reporter.reporter.log(
        `downloaded ${archive.fileName} — ${String(archive.fileCount)} files, ` +
          `${mib(archive.bytes, 2)} MiB`,
        'ok',
      );
      reporter.reporter.progress(
        1,
        1,
        nothingDecrypted
          ? 'No images decrypted — see the log for why. The manifest is in your downloads.'
          : `Done — ${String(result.slots.length)}/${String(total)} slot(s) decrypted. ` +
              'Check your downloads.',
      );
    },
    [reporter],
  );

  const decryptFile = useCallback(
    (file: File): Promise<void> =>
      runner.start(id, async (signal) => {
        reporter.reset('Reading file ...');
        setDetection(null);
        try {
          await execute(file, signal);
        } catch (error) {
          if (error instanceof CancelledError) {
            reporter.log('cancelled', 'warn');
            reporter.setStatus('Cancelled.');
            return;
          }
          reporter.log(`ERROR: ${errorMessage(error)}`, 'error');
          logHint(reporter.log, error);
          reporter.setStatus('Failed — see the log above.');
        } finally {
          reporter.flush();
        }
      }),
    [execute, id, reporter, runner],
  );

  const cancel = useCallback((): void => {
    runner.cancel();
    reporter.setStatus('Cancelling ...');
  }, [reporter, runner]);

  return useMemo(
    () => ({ reporter, running, detection, decryptFile, cancel }),
    [reporter, running, detection, decryptFile, cancel],
  );
}
