// React Native Web has no ToastAndroid export. Keep the rendered toast on web.
export function showNativeAndroidToast(_message: string, _durationMs: number | null): boolean {
  return false;
}
