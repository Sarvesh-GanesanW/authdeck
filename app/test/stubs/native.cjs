// Node stand-ins for the Expo and React Native modules the net and pairing code imports.
// Registered by test/native.ts; tests change `Platform.OS` to act as the web build.
const crypto = require('node:crypto');

const memory = new Map();
const asyncStorage = {
  getItem: async (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: async (key, value) => void memory.set(key, value),
  removeItem: async (key) => void memory.delete(key),
  getAllKeys: async () => [...memory.keys()],
  multiRemove: async (keys) => keys.forEach((key) => memory.delete(key)),
};
const secure = new Map();

module.exports = {
  // expo: no native modules in Node
  requireOptionalNativeModule: () => null,
  // react-native
  Platform: { OS: 'ios', select: (options) => options.ios ?? options.default },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  // @react-native-async-storage/async-storage
  default: asyncStorage,
  ...asyncStorage,
  // expo-crypto
  getRandomBytes: (n) => new Uint8Array(crypto.randomBytes(n)),
  // expo-secure-store
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key) => (secure.has(key) ? secure.get(key) : null),
  setItemAsync: async (key, value) => void secure.set(key, value),
  // expo-network
  getIpAddressAsync: async () => '192.168.1.50',
  // expo-device
  deviceName: 'Test phone',
  modelName: 'Test',
  deviceType: 1,
  DeviceType: { PHONE: 1, TABLET: 2 },
  // expo-haptics
  impactAsync: async () => undefined,
  notificationAsync: async () => undefined,
  selectionAsync: async () => undefined,
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy', Rigid: 'rigid', Soft: 'soft' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
};
