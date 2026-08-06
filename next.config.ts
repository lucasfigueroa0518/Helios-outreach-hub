import path from 'path';
import type { NextConfig } from 'next';

const hubRoot = __dirname;

const nextConfig: NextConfig = {
  // lucas-outreach-hub lives inside embark-eva (separate lockfile). Without this,
  // Next infers the monorepo root and resolves deps like @opentelemetry/api from
  // embark-eva/node_modules, which is not installed for this app.
  outputFileTracingRoot: hubRoot,
  serverExternalPackages: [
    'tesseract.js',
    '@tesseract.js-data/eng',
  ],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@opentelemetry/api': path.join(
        hubRoot,
        'node_modules/next/dist/compiled/@opentelemetry/api',
      ),
    };
    return config;
  },
};

export default nextConfig;
