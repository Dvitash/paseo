import { isWeb } from "@/constants/platform";
import type {
  WebPushBrowserAdapter,
  WebPushEnvironmentStatus,
  WebPushSubscription,
} from "./web-push-types";

export function getHostScope(serverId: string): string {
  return `/_paseo/push/${encodeURIComponent(serverId)}/`;
}

export function getHostScopeHref(serverId: string, origin?: string): string {
  const scope = getHostScope(serverId);
  const base = origin ?? (isWeb && typeof window !== "undefined" ? window.location.origin : null);
  if (base) {
    return new URL(scope, base).href;
  }
  return scope;
}

export function isExactHostScope(
  registration: Pick<ServiceWorkerRegistration, "scope">,
  serverId: string,
  origin?: string,
): boolean {
  const expectedScope = getHostScope(serverId);
  const expectedHref = getHostScopeHref(serverId, origin);
  return registration.scope === expectedHref || registration.scope === expectedScope;
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function validateAndFormatPushSubscription(
  subscription: PushSubscription,
): WebPushSubscription {
  const json = subscription.toJSON();
  let p256dh = json.keys?.p256dh;
  let auth = json.keys?.auth;

  if (!p256dh && typeof subscription.getKey === "function") {
    const rawP256dh = subscription.getKey("p256dh");
    if (rawP256dh) {
      p256dh = arrayBufferToBase64Url(rawP256dh);
    }
  }

  if (!auth && typeof subscription.getKey === "function") {
    const rawAuth = subscription.getKey("auth");
    if (rawAuth) {
      auth = arrayBufferToBase64Url(rawAuth);
    }
  }

  if (
    !json.endpoint ||
    typeof json.endpoint !== "string" ||
    !p256dh ||
    typeof p256dh !== "string" ||
    !auth ||
    typeof auth !== "string"
  ) {
    throw new Error("Push subscription missing required endpoint or encryption keys");
  }

  return {
    endpoint: json.endpoint,
    keys: {
      p256dh,
      auth,
    },
    expirationTime: json.expirationTime ?? null,
  };
}

function waitForWorkerActivation(worker: ServiceWorker, timeoutMs: number): Promise<ServiceWorker> {
  return new Promise<ServiceWorker>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.removeEventListener("statechange", onStateChange);
      reject(new Error("Timeout waiting for push service worker to activate"));
    }, timeoutMs);

    function onStateChange() {
      if (settled) return;
      if (worker.state === "activated") {
        settled = true;
        clearTimeout(timer);
        worker.removeEventListener("statechange", onStateChange);
        resolve(worker);
      } else if (worker.state === "redundant") {
        settled = true;
        clearTimeout(timer);
        worker.removeEventListener("statechange", onStateChange);
        reject(new Error("Service worker became redundant during activation"));
      }
    }

    worker.addEventListener("statechange", onStateChange);
  });
}

export async function waitForActiveWorker(
  registration: Pick<ServiceWorkerRegistration, "active" | "installing" | "waiting">,
  timeoutMs = 10000,
): Promise<ServiceWorker> {
  if (registration.active) {
    return registration.active;
  }

  const worker = registration.installing ?? registration.waiting;
  if (!worker) {
    throw new Error("No service worker installing or waiting");
  }

  if (worker.state === "activated") {
    return worker;
  }

  return waitForWorkerActivation(worker, timeoutMs);
}

export interface WebPushBrowserAdapterOptions {
  subscribeTimeoutMs?: number;
}

export function createWebPushBrowserAdapter(
  options?: WebPushBrowserAdapterOptions,
): WebPushBrowserAdapter {
  const subscribeTimeoutMs = options?.subscribeTimeoutMs ?? 30000;
  return {
    isSupported(): boolean {
      if (!isWeb || typeof window === "undefined" || typeof navigator === "undefined") {
        return false;
      }
      return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    },

    getEnvironmentStatus(): WebPushEnvironmentStatus {
      if (!isWeb || typeof window === "undefined" || typeof navigator === "undefined") {
        return "unsupported-browser";
      }

      if (!window.isSecureContext) {
        return "unsupported-insecure-context";
      }

      const isIos =
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const isStandalone =
        ("standalone" in window.navigator && Boolean(window.navigator.standalone)) ||
        (typeof window.matchMedia === "function" &&
          window.matchMedia("(display-mode: standalone)").matches);

      if (isIos && !isStandalone) {
        return "unsupported-ios-homescreen";
      }

      if (
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        return "unsupported-browser";
      }

      return "supported";
    },

    async getPermission(): Promise<NotificationPermission | "unsupported"> {
      if (!isWeb || typeof Notification === "undefined") {
        return "unsupported";
      }
      return Notification.permission;
    },

    async requestPermission(): Promise<NotificationPermission | "unsupported"> {
      if (!isWeb || typeof Notification === "undefined") {
        return "unsupported";
      }
      return await Notification.requestPermission();
    },

    async getSubscription(serverId: string): Promise<WebPushSubscription | null> {
      if (!isWeb || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        return null;
      }
      const scope = getHostScope(serverId);
      const registration = await navigator.serviceWorker.getRegistration(scope);
      if (!registration || !isExactHostScope(registration, serverId)) {
        return null;
      }
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        return null;
      }
      return validateAndFormatPushSubscription(subscription);
    },

    async subscribe(serverId: string, applicationServerKey: string): Promise<WebPushSubscription> {
      if (!isWeb || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        throw new Error("Service worker is not supported in this environment");
      }

      const scope = getHostScope(serverId);
      const registration = await navigator.serviceWorker.register("/push-service-worker.js", {
        scope,
        updateViaCache: "none",
      });

      await waitForActiveWorker(registration);
      const convertedKey = urlBase64ToUint8Array(applicationServerKey);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          void registration.unregister().catch(() => undefined);
          reject(new Error("Timeout subscribing to browser push service (network unreachable)"));
        }, subscribeTimeoutMs);
      });

      try {
        const subscription = await Promise.race([
          registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: convertedKey,
          }),
          timeoutPromise,
        ]);

        return validateAndFormatPushSubscription(subscription);
      } catch (error) {
        if (timedOut) {
          void registration.pushManager
            .getSubscription()
            .then((lateSub) => lateSub?.unsubscribe())
            .catch(() => undefined);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    },

    async unsubscribe(serverId: string): Promise<boolean> {
      if (!isWeb || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        return false;
      }

      const scope = getHostScope(serverId);
      const registration = await navigator.serviceWorker.getRegistration(scope);
      if (!registration || !isExactHostScope(registration, serverId)) {
        return false;
      }

      let unsubscribed = false;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        unsubscribed = await subscription.unsubscribe();
      }

      await registration.unregister();
      return unsubscribed;
    },

    async getApplicationServerKey(serverId: string): Promise<string | null> {
      if (!isWeb || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        return null;
      }

      const scope = getHostScope(serverId);
      const registration = await navigator.serviceWorker.getRegistration(scope);
      if (!registration || !isExactHostScope(registration, serverId)) {
        return null;
      }

      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        return null;
      }

      const key = subscription.options?.applicationServerKey;
      if (!key) {
        return null;
      }

      return arrayBufferToBase64Url(key);
    },
  };
}
