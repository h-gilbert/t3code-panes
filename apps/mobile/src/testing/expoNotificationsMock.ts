import { vi } from "vite-plus/test";

export const addPushTokenListener = vi.fn(
  (_listener: (token: { readonly type: string; readonly data: string }) => void) => ({
    remove: vi.fn(),
  }),
);
export const getDevicePushTokenAsync = vi.fn(() =>
  Promise.resolve({ type: "ios", data: "apns-token" }),
);
export const getPermissionsAsync = vi.fn(() => Promise.resolve({ granted: true }));
export const requestPermissionsAsync = vi.fn(() =>
  Promise.resolve({ granted: true, canAskAgain: true }),
);
