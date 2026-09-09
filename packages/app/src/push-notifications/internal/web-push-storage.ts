import AsyncStorage from "@react-native-async-storage/async-storage";
import type { WebPushStorage } from "./web-push-types";

const STORAGE_PREFIX = "@paseo:web-push:";

interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function createAsyncStorageWebPushStorage(
  storage: KeyValueStorage = AsyncStorage,
): WebPushStorage {
  return {
    async isOptedIn(serverId: string): Promise<boolean> {
      const value = await storage.getItem(`${STORAGE_PREFIX}opt-in:${serverId}`);
      return value === "true";
    },

    async setOptedIn(serverId: string, optedIn: boolean): Promise<void> {
      if (optedIn) {
        await storage.setItem(`${STORAGE_PREFIX}opt-in:${serverId}`, "true");
      } else {
        await storage.removeItem(`${STORAGE_PREFIX}opt-in:${serverId}`);
      }
    },

    async getEndpoint(serverId: string): Promise<string | null> {
      return await storage.getItem(`${STORAGE_PREFIX}endpoint:${serverId}`);
    },

    async setEndpoint(serverId: string, endpoint: string | null): Promise<void> {
      if (endpoint) {
        await storage.setItem(`${STORAGE_PREFIX}endpoint:${serverId}`, endpoint);
      } else {
        await storage.removeItem(`${STORAGE_PREFIX}endpoint:${serverId}`);
      }
    },

    async getVapidKey(serverId: string): Promise<string | null> {
      return await storage.getItem(`${STORAGE_PREFIX}vapid:${serverId}`);
    },

    async setVapidKey(serverId: string, key: string | null): Promise<void> {
      if (key) {
        await storage.setItem(`${STORAGE_PREFIX}vapid:${serverId}`, key);
      } else {
        await storage.removeItem(`${STORAGE_PREFIX}vapid:${serverId}`);
      }
    },

    async clear(serverId: string): Promise<void> {
      await Promise.all([
        storage.removeItem(`${STORAGE_PREFIX}opt-in:${serverId}`),
        storage.removeItem(`${STORAGE_PREFIX}endpoint:${serverId}`),
        storage.removeItem(`${STORAGE_PREFIX}vapid:${serverId}`),
      ]);
    },
  };
}
