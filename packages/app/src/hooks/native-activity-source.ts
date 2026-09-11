type NativeActivityListener = () => void;

const listeners = new Set<NativeActivityListener>();

/**
 * Called from the root view's onTouchStart. React Native has no global input
 * event, so native user activity is fed through this emitter.
 */
export function notifyNativeUserActivity(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeNativeUserActivity(listener: NativeActivityListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
