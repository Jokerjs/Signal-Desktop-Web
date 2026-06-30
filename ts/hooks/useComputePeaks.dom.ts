// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import lodash from 'lodash';
import { useEffect, useRef, useState } from 'react';
import {
  computePeaks,
  getCachedPeaks,
} from '../components/VoiceNotesPlaybackContext.dom.tsx';
import { createLogger } from '../logging/log.std.ts';
import type { PeakType } from '../types/Audio.dom.tsx';

const { noop } = lodash;

const log = createLogger('useComputePeaks');

type WaveformData = {
  peaks: ReadonlyArray<PeakType>;
  duration: number;
};

function normalizeDuration(
  duration: number | undefined,
  fallbackDuration?: number
): number {
  if (duration != null && Number.isFinite(duration) && duration > 0) {
    return Math.max(duration, 1e-23);
  }

  if (
    fallbackDuration != null &&
    Number.isFinite(fallbackDuration) &&
    fallbackDuration > 0
  ) {
    return Math.max(fallbackDuration, 1e-23);
  }

  return 1e-23;
}

function getCachedWaveformData(
  audioUrl: string | undefined,
  barCount: number,
  fallbackDuration?: number
): WaveformData | undefined {
  if (!audioUrl) {
    return undefined;
  }

  const cached = getCachedPeaks(audioUrl, barCount);
  if (!cached) {
    return undefined;
  }

  return {
    duration: normalizeDuration(cached.duration, fallbackDuration),
    peaks: cached.peaks,
  };
}

export function useComputePeaks({
  audioUrl,
  activeDuration,
  barCount,
  onCorrupted,
}: {
  audioUrl: string | undefined;
  activeDuration: number | undefined;
  barCount: number;
  onCorrupted: () => void;
}): { peaks: ReadonlyArray<PeakType>; hasPeaks: boolean; duration: number } {
  const [waveformData, setWaveformData] = useState<WaveformData | undefined>(
    () => getCachedWaveformData(audioUrl, barCount, activeDuration)
  );
  const onCorruptedRef = useRef(onCorrupted);
  onCorruptedRef.current = onCorrupted;

  // This effect loads audio file and computes its RMS peak for displaying the
  // waveform.
  useEffect(() => {
    if (!audioUrl) {
      return noop;
    }

    const cached = getCachedWaveformData(audioUrl, barCount, activeDuration);
    if (cached) {
      setWaveformData(current => {
        if (
          current?.duration === cached.duration &&
          current.peaks === cached.peaks
        ) {
          return current;
        }

        return cached;
      });
      return noop;
    }

    log.info('MessageAudio: loading audio and computing waveform');

    let canceled = false;

    void (async () => {
      try {
        const { peaks: newPeaks, duration: newDuration } = await computePeaks(
          audioUrl,
          barCount
        );
        if (canceled) {
          return;
        }
        setWaveformData({
          peaks: newPeaks,
          duration: normalizeDuration(newDuration, activeDuration),
        });
      } catch (err) {
        log.error(
          'MessageAudio: computePeaks error, marking as corrupted',
          err
        );

        onCorruptedRef.current();
      }
    })();

    return () => {
      canceled = true;
    };
  }, [activeDuration, audioUrl, barCount]);

  let peaks = waveformData?.peaks;
  if (peaks == null) {
    const blank = new Array<PeakType>();
    for (let i = 0; i < barCount; i += 1) {
      blank.push({ value: 0, index: i });
    }
    peaks = blank;
  }

  return {
    duration: normalizeDuration(waveformData?.duration, activeDuration),
    hasPeaks: waveformData !== undefined,
    peaks,
  };
}
