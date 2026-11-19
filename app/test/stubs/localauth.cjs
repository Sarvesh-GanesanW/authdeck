// expo-local-authentication stand-in for the engine scenarios: a device with a screen lock whose owner always passes.
const state = { hardware: true, enrolled: true, level: 2, prompts: 0 };
module.exports = {
  __state: state,
  hasHardwareAsync: async () => state.hardware,
  isEnrolledAsync: async () => state.enrolled,
  getEnrolledLevelAsync: async () => state.level,
  authenticateAsync: async () => {
    state.prompts++;
    return { success: true };
  },
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
};
