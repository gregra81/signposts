// Unit-level assertion on the embedder factory's env seam — no pipeline
// load, no network, no model download. `configureEmbedEnv` is split out
// of `createEmbedder` precisely so this is testable (see A4 in the task).

import { env } from "@huggingface/transformers";
import { describe, expect, it } from "vitest";
import { configureEmbedEnv } from "../../../src/io/embed/embedder.js";

describe("configureEmbedEnv", () => {
  it("sets env.cacheDir to the caller-supplied modelCacheDir, not any other path", () => {
    configureEmbedEnv({
      modelCacheDir: "/custom/global/model/cache",
      allowRemoteModels: true,
      localModelPath: null,
    });
    expect(env.cacheDir).toBe("/custom/global/model/cache");
  });

  it("passes through allowRemoteModels", () => {
    configureEmbedEnv({ modelCacheDir: "/x", allowRemoteModels: false, localModelPath: null });
    expect(env.allowRemoteModels).toBe(false);

    configureEmbedEnv({ modelCacheDir: "/x", allowRemoteModels: true, localModelPath: null });
    expect(env.allowRemoteModels).toBe(true);
  });

  it("sets env.localModelPath when provided", () => {
    configureEmbedEnv({ modelCacheDir: "/x", allowRemoteModels: false, localModelPath: "/vendored/model" });
    expect(env.localModelPath).toBe("/vendored/model");
  });

  it("leaves env.localModelPath untouched when null", () => {
    configureEmbedEnv({ modelCacheDir: "/x", allowRemoteModels: true, localModelPath: "/vendored/model" });
    configureEmbedEnv({ modelCacheDir: "/y", allowRemoteModels: true, localModelPath: null });
    expect(env.localModelPath).toBe("/vendored/model");
  });
});
