// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/integration',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    // Clear localStorage between tests so they don't bleed into each other
    storageState: { cookies: [], origins: [] },
  },
  // Require server to already be running (Kate runs `npm start` separately)
  webServer: {
    command: 'node server.js',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 10000,
  },
});
