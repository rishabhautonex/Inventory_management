import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The invoice text-extraction stack has to be `require`d at runtime rather
   * than bundled.
   *
   * `@napi-rs/canvas` ships a prebuilt `.node` binary, which the bundler cannot
   * place in an ESM chunk at all ("non-ecmascript placeable asset").
   * `tesseract.js` and `unpdf` resolve worker and WASM assets relative to their
   * own package directory, which only holds if they stay where they are on disk.
   */
  serverExternalPackages: ["@napi-rs/canvas", "tesseract.js", "unpdf"],
};

export default nextConfig;
