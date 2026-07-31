import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The domain lives at ../src via experimental.externalDir, and the repo has two
  // lockfiles, so Next cannot infer the workspace root. Say it explicitly.
  outputFileTracingRoot: path.join(__dirname, '..'),
  experimental: {
    externalDir: true,
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    }];
  },
};

export default nextConfig;
