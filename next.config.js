/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdf-parse uses Node built-ins and dynamic requires — keep it external so the
  // route handler loads it at runtime instead of the bundler trying to inline it.
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse"],
  },
};

module.exports = nextConfig;
