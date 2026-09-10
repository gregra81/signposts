// Where the embedding model's weights are, in both layouts.
//
// These are literal expectations on purpose: the paths are transformers.js's
// composition, not ours, and the point of the module is that the embedder that
// downloads the file and the doctor that probes for it cannot drift apart. A
// mistake here is silent — doctor reports a cache that cannot load.

import { describe, expect, it } from "vitest";
import {
  cachedWeightsPath,
  EMBEDDING_DTYPE,
  EMBEDDING_WEIGHTS_FILE,
  vendoredWeightsPath,
} from "../../../src/core/retrieval/model-files.js";

describe("the embedding model's files", () => {
  it("asks for the quantized build, whose ONNX file carries transformers.js's q8 suffix", () => {
    expect(EMBEDDING_DTYPE).toBe("q8");
    expect(EMBEDDING_WEIGHTS_FILE).toBe("onnx/model_quantized.onnx");
  });

  it("in the shared cache, one copy per pinned revision", () => {
    expect(cachedWeightsPath("/home/greg/.signposts/models", "Xenova/all-MiniLM-L6-v2", "751bff37")).toBe(
      "/home/greg/.signposts/models/Xenova/all-MiniLM-L6-v2/751bff37/onnx/model_quantized.onnx",
    );
  });

  it("in a vendored copy, flat and with no revision — transformers.js ignores it on this route", () => {
    expect(vendoredWeightsPath("/opt/models", "Xenova/all-MiniLM-L6-v2")).toBe(
      "/opt/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx",
    );
  });
});
