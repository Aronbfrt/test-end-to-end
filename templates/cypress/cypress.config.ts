import { defineConfig } from 'cypress';

export default defineConfig({
  e2e: {
    baseUrl: process.env.TEST_BASE_URL || 'http://localhost:3000',
    specPattern: 'cypress/e2e/**/*.cy.{ts,js}',
    supportFile: 'cypress/support/e2e.ts',
    video: true,
    screenshotOnRunFailure: true,
  },
});
