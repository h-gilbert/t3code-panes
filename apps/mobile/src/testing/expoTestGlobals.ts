// Expo 57 reads this Metro global while its modules initialize. Vitest runs
// outside Metro, so define the production value before mobile test imports.
Object.defineProperty(globalThis, "__DEV__", {
  configurable: true,
  value: false,
});
