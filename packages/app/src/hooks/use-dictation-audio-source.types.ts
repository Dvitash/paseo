export interface DictationAudioSourceConfig {
  onPcmSegment: (pcm16Base64: string) => void;
  onError?: (error: Error) => void;
  onInterruption?: () => void;
  /** Preferred capture device. Web/Electron: `MediaDeviceInfo.deviceId`.
   * Null/undefined = system default. Ignored on native. */
  inputDeviceId?: string | null;
}

export interface DictationAudioSource {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  volume: number;
}
