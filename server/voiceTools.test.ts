import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findNemoSpeech, nemotronMissing } from "./voiceTools.ts";

describe("Nemotron's runner and model", () => {
  it("finds nemo-speech named, in its release folder, or in the folder of releases", async () => {
    const home = await mkdtemp(join(tmpdir(), "nemo-speech-"));
    try {
      expect(findNemoSpeech(join(home, "none"))).toBeNull();
      const program = join(home, "nemo-speech-0.3.0-macos-aarch64-metal", "bin", "nemo-speech");
      await mkdir(join(program, ".."), { recursive: true });
      await writeFile(program, "");
      expect(findNemoSpeech(home)).toBe(program);
      expect(findNemoSpeech(join(home, "nemo-speech-0.3.0-macos-aarch64-metal"))).toBe(program);
      expect(findNemoSpeech(program)).toBe(program);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("says what is missing: the model, its encoder beside it, or the runner", async () => {
    const models = await mkdtemp(join(tmpdir(), "nemotron-"));
    try {
      const model = join(models, "Sample-Transcribe-AD-IQ4_NL.gguf");
      expect(nemotronMissing(model, "/opt/sample/nemo-speech")).toMatch(/^its model is not on this Mac/);
      await writeFile(model, "");
      expect(nemotronMissing(model, "/opt/sample/nemo-speech")).toMatch(/^its encoder is not beside its model/);
      await writeFile(join(models, "Sample-Transcribe-Encoder-F16.gguf"), "");
      expect(nemotronMissing(model, null)).toMatch(/^NeMo-Speech.cpp is not on this Mac/);
      expect(nemotronMissing(model, "/opt/sample/nemo-speech")).toBeNull();
    } finally {
      await rm(models, { recursive: true, force: true });
    }
  });
});
