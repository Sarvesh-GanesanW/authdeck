// expo-secure-store stand-in with delete, for the engine scenarios.
const secure = new Map();
module.exports = {
  __secure: secure,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key) => (secure.has(key) ? secure.get(key) : null),
  setItemAsync: async (key, value) => void secure.set(key, value),
  deleteItemAsync: async (key) => void secure.delete(key),
};
