import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AnySetSchema, SpeakingSetSchema, stripAnswers, type SpeakingSet } from "@toefl-prep/shared";
import { config } from "../src/lib/config.js";
import {
  applyScene,
  cleanupSceneImageArtifacts,
  composeScenePrompt,
  generateSceneImage,
  locateFocusRegions,
  sceneImageLocation,
  SceneImageError,
  SCENE_IMAGE_MODEL,
} from "../src/services/sceneImage.js";
import { speakingPlanFixture } from "./helpers/generationDiversityFixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const speakingDir = path.join(config.dataDir, "question-sets/speaking");
const scenariosDir = path.join(config.dataDir, "images/scenarios");

// Each test that writes gets its own set id so no two tests in this file collide on one file, and
// so a failure leaves an identifiable file behind rather than a shared one.
const uniqueSetId = () => `spk-test-${Math.random().toString(16).slice(2, 10)}`;
const created: string[] = [];
const tempDataDirs: string[] = [];
const track = (setId: string) => {
  created.push(setId);
  return setId;
};

const readSet = (id: string): SpeakingSet =>
  SpeakingSetSchema.parse(JSON.parse(fs.readFileSync(path.join(speakingDir, `${id}.json`), "utf8")));

const legacySet = (): SpeakingSet => {
  const set = structuredClone(readSet("spk-e5b2b735"));
  delete set.listenAndRepeat.image;
  for (const item of set.listenAndRepeat.items) delete item.focusRegion;
  return set;
};

const imagesWrap = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });
const geminiWrap = (o: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] }), { status: 200 });

const lrFixture = {
  scenarioTitle: "At the campus bookstore",
  scenarioDescription: "You are helping a new student find course materials.",
  items: Array.from({ length: 7 }, (_, i) => ({ sentence: `Sentence number ${i + 1} for practice.` })),
};

// generateSceneImage rejects anything that is not a WebP, so every stubbed image payload must carry
// a real RIFF/WEBP header: "RIFF", a 4-byte size, then "WEBP".
const fakeWebp = (...tail: number[]) =>
  Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "ascii"), Buffer.from(tail)]);

afterEach(() => {
  vi.restoreAllMocks();
  while (created.length) {
    const setId = created.pop() as string;
    fs.rmSync(path.join(scenariosDir, `${setId}.webp`), { force: true });
  }
  while (tempDataDirs.length) {
    fs.rmSync(tempDataDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("composeScenePrompt", () => {
  it("reproduces the validated prompt for spk-e5b2b735 byte for byte", () => {
    // Golden file: the exact prompt whose output was compared side by side with ETS's reference
    // illustration. If this assertion fails, the art style has changed, which is what it is for.
    const golden = fs.readFileSync(path.join(here, "fixtures/scene-prompt-spk-e5b2b735.txt"), "utf8");
    expect(composeScenePrompt(readSet("spk-e5b2b735").listenAndRepeat)).toBe(golden);
  });

  it("lists all seven sentences as KEY OBJECTS bullets, in order", () => {
    const prompt = composeScenePrompt(lrFixture);
    const bullets = prompt.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toEqual(lrFixture.items.map((i) => `- ${i.sentence}`));
  });

  it("carries the scenario title and description", () => {
    expect(composeScenePrompt(lrFixture)).toContain(
      "SCENE TO ILLUSTRATE: At the campus bookstore. You are helping a new student find course materials."
    );
  });

  it("keeps the load-bearing style constraints", () => {
    const prompt = composeScenePrompt(lrFixture);
    expect(prompt).toContain("STRICTLY GRAYSCALE / ACHROMATIC");
    expect(prompt).toContain("WATER AND SWIMMING POOLS ARE GRAY, NOT BLUE OR CYAN");
    expect(prompt).toContain("COMPLETELY FLAT FILL");
    expect(prompt).toContain("#00A082");
    expect(prompt).toContain("ABSOLUTELY NO TEXT");
    expect(prompt).toContain("show them as pictures only");
  });
});

describe("cleanupSceneImageArtifacts", () => {
  it("refuses a symlinked scenarios parent without unlinking an external canonical file", (context) => {
    const setId = uniqueSetId();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-cleanup-root-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-cleanup-outside-"));
    tempDataDirs.push(dataDir, outsideDir);
    const imagesDir = path.join(dataDir, "images");
    const scenariosLink = path.join(imagesDir, "scenarios");
    fs.mkdirSync(imagesDir, { recursive: true });
    try {
      fs.symlinkSync(outsideDir, scenariosLink, "dir");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
        context.skip(`platform cannot create the required test symlink (${code})`);
        return;
      }
      throw err;
    }
    const externalCanonical = path.join(outsideDir, `${setId}.webp`);
    fs.writeFileSync(externalCanonical, "external owner");

    expect(cleanupSceneImageArtifacts(setId, dataDir)).toBe(false);

    expect(fs.readFileSync(externalCanonical, "utf8")).toBe("external owner");
    expect(fs.lstatSync(scenariosLink).isSymbolicLink()).toBe(true);
  });

  it("preserves a canonical directory collision but still removes an exact-set regular temp file", () => {
    const setId = uniqueSetId();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-cleanup-"));
    tempDataDirs.push(dataDir);
    const canonical = sceneImageLocation(setId, dataDir).path;
    const dir = path.dirname(canonical);
    const temp = path.join(dir, `.${setId}.deadbeef.webp.tmp`);
    const siblingTemp = path.join(dir, `.${setId}-other.deadbeef.webp.tmp`);
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, "owner.txt"), "unrelated collision");
    fs.writeFileSync(temp, "owned temp");
    fs.writeFileSync(siblingTemp, "other set temp");

    let removed: boolean | undefined;
    expect(() => {
      removed = cleanupSceneImageArtifacts(setId, dataDir);
    }).not.toThrow();

    expect(removed).toBe(true);
    expect(fs.lstatSync(canonical).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(canonical, "owner.txt"), "utf8")).toBe("unrelated collision");
    expect(fs.existsSync(temp)).toBe(false);
    expect(fs.readFileSync(siblingTemp, "utf8")).toBe("other set temp");
  });

  it("preserves a non-regular matching temp collision and continues to later exact-set temps", () => {
    const setId = uniqueSetId();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-cleanup-"));
    tempDataDirs.push(dataDir);
    const dir = path.dirname(sceneImageLocation(setId, dataDir).path);
    const collidingTemp = path.join(dir, `.${setId}.aaa.webp.tmp`);
    const removableTemp = path.join(dir, `.${setId}.bbb.webp.tmp`);
    const siblingTemp = path.join(dir, `.${setId}-sibling.ccc.webp.tmp`);
    fs.mkdirSync(collidingTemp, { recursive: true });
    fs.writeFileSync(path.join(collidingTemp, "owner.txt"), "unrelated collision");
    fs.writeFileSync(removableTemp, "owned temp");
    fs.writeFileSync(siblingTemp, "other set temp");

    expect(cleanupSceneImageArtifacts(setId, dataDir)).toBe(true);

    expect(fs.lstatSync(collidingTemp).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(collidingTemp, "owner.txt"), "utf8")).toBe("unrelated collision");
    expect(fs.existsSync(removableTemp)).toBe(false);
    expect(fs.readFileSync(siblingTemp, "utf8")).toBe("other set temp");
  });
});

describe("generateSceneImage", () => {
  it("hands the job's signal to the image request, and makes none once it has aborted", async () => {
    const controller = new AbortController();
    const bytes = fakeWebp(4, 5, 6);
    const f = vi.fn().mockResolvedValue(imagesWrap({ data: [{ b64_json: bytes.toString("base64") }] }));
    await generateSceneImage(track(uniqueSetId()), lrFixture, { fetch: f as never, signal: controller.signal });
    expect((f.mock.calls[0] as [string, RequestInit])[1].signal).toBe(controller.signal);

    controller.abort(new Error("cancelled"));
    const late = vi.fn();
    await expect(generateSceneImage(track(uniqueSetId()), lrFixture, { fetch: late as never, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(late).not.toHaveBeenCalled();
  });

  it("writes the decoded WebP bytes to data/images/scenarios/<setId>.webp and returns the image field", async () => {
    const setId = track(uniqueSetId());
    const bytes = fakeWebp(1, 2, 3);
    const f = vi.fn().mockResolvedValue(imagesWrap({ data: [{ b64_json: bytes.toString("base64") }] }));

    const image = await generateSceneImage(setId, lrFixture, { fetch: f as never });

    expect(image).toEqual({
      file: `images/scenarios/${setId}.webp`,
      prompt: composeScenePrompt(lrFixture),
      model: SCENE_IMAGE_MODEL,
    });
    expect(fs.readFileSync(path.join(config.dataDir, image.file))).toEqual(bytes);

    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: SCENE_IMAGE_MODEL,
      size: "1024x1024",
      n: 1,
      prompt: image.prompt,
      // The format is requested, not converted after the fact — measured at ~9x smaller than the
      // default PNG on this flat vector art, and these files are committed to the repo. See
      // docs/adr/0014-speaking-scene-illustrations.md.
      output_format: "webp",
      output_compression: 80,
    });
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });

  it("writes beneath an injected dataDir while keeping the stored image.file data-relative", async () => {
    const setId = uniqueSetId();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-image-root-"));
    tempDataDirs.push(dataDir);
    const bytes = fakeWebp(8, 6, 7);
    const f = vi.fn().mockResolvedValue(imagesWrap({ data: [{ b64_json: bytes.toString("base64") }] }));

    const image = await generateSceneImage(setId, lrFixture, { fetch: f as never, dataDir });

    expect(image.file).toBe(`images/scenarios/${setId}.webp`);
    expect(fs.readFileSync(path.join(dataDir, image.file))).toEqual(bytes);
    expect(fs.existsSync(path.join(config.dataDir, image.file))).toBe(false);
  });

  it("leaves no temp file behind on success", async () => {
    const setId = track(uniqueSetId());
    const f = vi.fn().mockResolvedValue(imagesWrap({ data: [{ b64_json: fakeWebp(9).toString("base64") }] }));
    await generateSceneImage(setId, lrFixture, { fetch: f as never });
    // The atomic write's temp file lives in this same directory, so anything named after this set
    // other than the final .webp is a leaked intermediate.
    const leftovers = fs.readdirSync(scenariosDir).filter((n) => n.includes(setId) && n !== `${setId}.webp`);
    expect(leftovers).toEqual([]);
  });

  it("removes its owned temp when a descriptor write partially succeeds and then throws", async () => {
    const setId = uniqueSetId();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-partial-write-"));
    tempDataDirs.push(dataDir);
    const bytes = fakeWebp(2, 4, 6, 8);
    const f = vi.fn().mockResolvedValue(imagesWrap({
      data: [{ b64_json: bytes.toString("base64") }],
    }));
    const writeFailure = new Error("simulated partial descriptor write failure");
    const realWriteFileSync = fs.writeFileSync as (...args: unknown[]) => void;
    const realWriteSync = fs.writeSync;
    let wroteThroughDescriptor = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((target, data, options) => {
      if (typeof target !== "number") {
        return realWriteFileSync(target, data, options);
      }
      wroteThroughDescriptor = true;
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      realWriteSync(target, payload.subarray(0, 4));
      throw writeFailure;
    }) as typeof fs.writeFileSync);

    await expect(generateSceneImage(
      setId,
      lrFixture,
      { fetch: f as never, dataDir },
    )).rejects.toBe(writeFailure);

    const canonical = sceneImageLocation(setId, dataDir).path;
    const scenarios = path.dirname(canonical);
    expect(wroteThroughDescriptor).toBe(true);
    expect(fs.existsSync(canonical)).toBe(false);
    expect(fs.readdirSync(scenarios).filter((name) => name.includes(setId))).toEqual([]);
  });

  it("never follows or removes a pre-existing symlink at its randomized temp name", async (context) => {
    const setId = uniqueSetId();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-temp-collision-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-temp-outside-"));
    tempDataDirs.push(dataDir, outsideDir);
    const scenarios = path.join(dataDir, "images", "scenarios");
    fs.mkdirSync(scenarios, { recursive: true });
    const external = path.join(outsideDir, "external-owner.webp");
    fs.writeFileSync(external, "external owner");
    let tmp: string | null = null;
    const installCollision = (target: unknown) => {
      if (
        tmp ||
        typeof target !== "string" ||
        !target.includes(setId) ||
        !target.endsWith(".webp.tmp")
      ) return;
      try {
        fs.symlinkSync(external, target, "file");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
          context.skip(`platform cannot create the required test symlink (${code})`);
          return;
        }
        throw err;
      }
      tmp = target;
    };
    const realOpenSync = fs.openSync as (...args: unknown[]) => number;
    vi.spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
      installCollision(target);
      return realOpenSync(target, flags, mode);
    }) as typeof fs.openSync);
    const realWriteFileSync = fs.writeFileSync as (...args: unknown[]) => void;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((target, data, options) => {
      installCollision(target);
      return realWriteFileSync(target, data, options);
    }) as typeof fs.writeFileSync);
    const f = vi.fn().mockResolvedValue(imagesWrap({
      data: [{ b64_json: fakeWebp(1, 3, 5, 7).toString("base64") }],
    }));

    await expect(generateSceneImage(setId, lrFixture, { fetch: f as never, dataDir })).rejects.toThrow();

    expect(tmp).not.toBeNull();
    expect(fs.readFileSync(external, "utf8")).toBe("external owner");
    if (tmp === null) throw new Error("the temp collision was not installed");
    expect(fs.lstatSync(tmp).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(sceneImageLocation(setId, dataDir).path)).toBe(false);
  });

  it("falls back to fetching data[0].url when the response has no inline base64", async () => {
    const setId = track(uniqueSetId());
    const bytes = fakeWebp(7, 7, 7);
    const f = vi.fn()
      .mockResolvedValueOnce(imagesWrap({ data: [{ url: "https://cdn.example/img.webp" }] }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const image = await generateSceneImage(setId, lrFixture, { fetch: f as never });
    expect(fs.readFileSync(path.join(config.dataDir, image.file))).toEqual(bytes);
    expect(f.mock.calls[1][0]).toBe("https://cdn.example/img.webp");
  });

  it("rejects with a useful message and writes nothing when the image API fails", async () => {
    const setId = uniqueSetId();
    const f = vi.fn().mockResolvedValue(new Response("quota exhausted", { status: 400 }));
    await expect(generateSceneImage(setId, lrFixture, { fetch: f as never })).rejects.toThrow(
      /scene image 400.*quota exhausted/
    );
    expect(fs.existsSync(path.join(scenariosDir, `${setId}.webp`))).toBe(false);
  });

  it("rejects when the response carries neither b64_json nor url", async () => {
    const setId = uniqueSetId();
    const f = vi.fn().mockResolvedValue(imagesWrap({ data: [{}] }));
    await expect(generateSceneImage(setId, lrFixture, { fetch: f as never })).rejects.toBeInstanceOf(SceneImageError);
    expect(fs.existsSync(path.join(scenariosDir, `${setId}.webp`))).toBe(false);
  });

  it("refuses a set id that could escape the scenarios directory", async () => {
    const f = vi.fn();
    await expect(generateSceneImage("../../evil", lrFixture, { fetch: f as never })).rejects.toThrow(/bad-set-id/);
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ["undecodable base64 that yields zero bytes", "!!!!"],
    ["bytes that are not a WebP", Buffer.from("<html>nope</html>").toString("base64")],
    // "RIFF" alone matches WAV/AVI too, so the second marker is what actually identifies a WebP.
    ["a RIFF container that is not WebP", Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE")]).toString("base64")],
  ])("rejects a 200 carrying %s, writing nothing", async (_label, b64_json) => {
    const setId = uniqueSetId();
    const f = vi.fn().mockResolvedValue(imagesWrap({ data: [{ b64_json }] }));
    // Buffer.from(x, "base64") silently drops undecodable characters instead of throwing, so
    // without the magic-number guard this path would rename an empty file into place as a success.
    await expect(generateSceneImage(setId, lrFixture, { fetch: f as never })).rejects.toThrow(/bad-webp/);
    expect(fs.existsSync(path.join(scenariosDir, `${setId}.webp`))).toBe(false);
  });

  it("removes the temp file and leaves the final path untouched when the rename fails", async () => {
    const setId = uniqueSetId();
    const f = vi.fn().mockResolvedValue(imagesWrap({ data: [{ b64_json: fakeWebp(4).toString("base64") }] }));
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EXDEV: simulated rename failure");
    });

    await expect(generateSceneImage(setId, lrFixture, { fetch: f as never })).rejects.toThrow(/simulated rename failure/);

    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(scenariosDir, `${setId}.webp`))).toBe(false);
    // The whole point of the catch branch: the written-but-unrenamed temp file must not linger.
    expect(fs.readdirSync(scenariosDir).filter((n) => n.includes(setId))).toEqual([]);
  });

  it("rejects and preserves a temp replacement swapped inside rename publication", async () => {
    const setId = uniqueSetId();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-pre-rename-swap-"));
    tempDataDirs.push(dataDir);
    const generated = fakeWebp(2, 3, 5, 7);
    const replacement = fakeWebp(9, 7, 5, 3);
    const f = vi.fn().mockResolvedValue(imagesWrap({
      data: [{ b64_json: generated.toString("base64") }],
    }));
    const realRename = fs.renameSync;
    const realRm = fs.rmSync;
    const realWrite = fs.writeFileSync;
    let tmp = "";
    let canonical = "";
    vi.spyOn(fs, "renameSync").mockImplementation(((oldPath, newPath) => {
      tmp = String(oldPath);
      canonical = String(newPath);
      realRm(oldPath);
      realWrite(oldPath, replacement);
      realRename(oldPath, newPath);
    }) as typeof fs.renameSync);

    await expect(generateSceneImage(
      setId,
      lrFixture,
      { fetch: f as never, dataDir },
    )).rejects.toThrow(/unsafe-publication/);

    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.readFileSync(canonical)).toEqual(replacement);
  });

  // The case above swaps in a new file, which only some file systems give a new inode number. Here
  // the temp file's bytes are replaced in place, so its identity is the same on every file system
  // and only the content can show that the published file is not the one this attempt wrote.
  it("rejects and preserves a temp file whose bytes were replaced in place inside rename publication", async () => {
    const setId = uniqueSetId();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-in-place-swap-"));
    tempDataDirs.push(dataDir);
    const replacement = fakeWebp(9, 7, 5, 3);
    const f = vi.fn().mockResolvedValue(imagesWrap({
      data: [{ b64_json: fakeWebp(2, 3, 5, 7).toString("base64") }],
    }));
    const realRename = fs.renameSync;
    const realWrite = fs.writeFileSync;
    let tmp = "";
    let canonical = "";
    vi.spyOn(fs, "renameSync").mockImplementation(((oldPath, newPath) => {
      tmp = String(oldPath);
      canonical = String(newPath);
      realWrite(oldPath, replacement);
      realRename(oldPath, newPath);
    }) as typeof fs.renameSync);

    await expect(generateSceneImage(
      setId,
      lrFixture,
      { fetch: f as never, dataDir },
    )).rejects.toThrow(/unsafe-publication/);

    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.readFileSync(canonical)).toEqual(replacement);
  });

});

describe("locateFocusRegions", () => {
  const sceneDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-"));
  const scenePath = path.join(sceneDir, "scene.webp");
  fs.writeFileSync(scenePath, fakeWebp());
  const sentences = Array.from({ length: 7 }, (_, i) => `Sentence ${i + 1}.`);

  afterAll(() => fs.rmSync(sceneDir, { recursive: true, force: true }));

  // A cancelled generation job must stop waiting on the vision call: the request carries the job's
  // signal, and the retry backoff after a 429 ends on it instead of buying the next attempt.
  it("hands the job's signal to the request and stops retrying once it aborts", async () => {
    const controller = new AbortController();
    const f = vi.fn(async () => {
      controller.abort(new Error("cancelled"));
      return new Response("busy", { status: 429 });
    });

    await expect(locateFocusRegions(scenePath, sentences, { fetch: f as never, signal: controller.signal })).rejects.toThrow();

    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(controller.signal);
  });

  it("maps a well-formed reply to regions in sentence order", async () => {
    const regions = sentences.map((_, i) => ({
      index: i, depicted: true, x: i / 10, y: 0.2, w: 0.15, h: 0.25,
    }));
    const f = vi.fn().mockResolvedValue(geminiWrap({ regions }));

    const out = await locateFocusRegions(scenePath, sentences, { fetch: f as never });

    expect(out).toHaveLength(7);
    expect(out[0]).toEqual({ x: 0, y: 0.2, w: 0.15, h: 0.25 });
    expect(out[6]).toEqual({ x: 0.6, y: 0.2, w: 0.15, h: 0.25 });

    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBeDefined();
    const body = JSON.parse(init.body as string);
    expect(body.contents[0].parts[1].inline_data.mime_type).toBe("image/webp");
    expect(body.contents[0].parts[1].inline_data.data).toBe(fs.readFileSync(scenePath).toString("base64"));
    expect(body.contents[0].parts[0].text).toContain("Sentence 7.");
  });

  it("sends the mime type the file actually is, not the format this module happens to write", async () => {
    // The pipeline writes WebP, but this function takes any path, and an older scene may be a .png:
    // telling Gemini "image/webp" about PNG bytes is a rejected call.
    const legacy = path.join(sceneDir, "legacy-scene.png");
    fs.writeFileSync(legacy, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const f = vi.fn().mockResolvedValue(geminiWrap({ regions: [{ index: 0, depicted: true, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }));
    await locateFocusRegions(legacy, sentences, { fetch: f as never });
    const body = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.contents[0].parts[1].inline_data.mime_type).toBe("image/png");
  });

  it("declares x/y/w/h as NOT required in the structured-output schema", async () => {
    const f = vi.fn().mockResolvedValue(geminiWrap({ regions: [{ index: 0, depicted: true, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }));
    await locateFocusRegions(scenePath, sentences, { fetch: f as never });
    const body = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string);
    const item = body.generationConfig.responseSchema.properties.regions.items;
    // Load-bearing, and invisible to every other test in this file because they all feed
    // hand-written replies: if the four coordinates were marked required, Gemini would be forced to
    // emit a box for objects the scene does not contain, i.e. fabricate rings onto the wrong things.
    expect(item.required).toEqual(["index", "depicted"]);
    expect(Object.keys(item.properties).sort()).toEqual(["depicted", "h", "index", "w", "x", "y"]);
  });

  it("returns null for a sentence the scene does not depict, without failing the call", async () => {
    const regions = sentences.map((_, i) =>
      i === 3 ? { index: i, depicted: false } : { index: i, depicted: true, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
    );
    const out = await locateFocusRegions(scenePath, sentences, {
      fetch: vi.fn().mockResolvedValue(geminiWrap({ regions })) as never,
    });
    expect(out[3]).toBeNull();
    expect(out.filter((r) => r !== null)).toHaveLength(6);
  });

  it("returns null for a sentence the model omits entirely", async () => {
    const out = await locateFocusRegions(scenePath, sentences, {
      fetch: vi.fn().mockResolvedValue(geminiWrap({ regions: [{ index: 2, depicted: true, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] })) as never,
    });
    expect(out).toHaveLength(7);
    expect(out.filter((r) => r !== null)).toHaveLength(1);
    expect(out[2]).not.toBeNull();
  });

  it("maps out-of-order unique indices to their authoritative sentence slots", async () => {
    const out = await locateFocusRegions(scenePath, sentences, {
      fetch: vi.fn().mockResolvedValue(geminiWrap({
        regions: [
          { index: 4, depicted: true, x: 0.4, y: 0.1, w: 0.2, h: 0.2 },
          { index: 1, depicted: true, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        ],
      })) as never,
    });
    expect(out[1]).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    expect(out[4]).toEqual({ x: 0.4, y: 0.1, w: 0.2, h: 0.2 });
  });

  it("degrades out-of-range, malformed and zero-area boxes to null instead of throwing", async () => {
    const regions = [
      { index: 0, depicted: true, x: 512, y: 300, w: 100, h: 80 },      // pixels, not fractions
      { index: 1, depicted: true, x: -0.1, y: 0.2, w: 0.3, h: 0.3 },    // negative origin
      { index: 2, depicted: true, x: 0.1, y: 0.2, w: 0, h: 0.3 },       // zero area
      { index: 3, depicted: true, x: 0.1, w: 0.3, h: 0.3 },             // missing y
      { index: 99, depicted: true, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },    // index out of range
      { index: 4, depicted: true, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },     // the one good box
    ];
    const out = await locateFocusRegions(scenePath, sentences, {
      fetch: vi.fn().mockResolvedValue(geminiWrap({ regions })) as never,
    });
    expect(out).toHaveLength(7);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeNull();
    expect(out[3]).toBeNull();
    expect(out[4]).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });

  it("rejects a box that starts in range but overflows the image edge", async () => {
    const regions = [
      // Every field is individually a legal 0–1 fraction, so the per-field range check passes; the
      // box still runs off the bottom-right corner and would draw a ring outside the picture.
      { index: 0, depicted: true, x: 0.9, y: 0.9, w: 0.9, h: 0.9 },
      { index: 1, depicted: true, x: 0.1, y: 0.95, w: 0.2, h: 0.2 },   // overflows vertically only
      { index: 2, depicted: true, x: 0.7, y: 0.7, w: 0.3, h: 0.3 },    // flush to the edge: allowed
      // The whole image. The widest legitimate box there is, and the case most likely to be broken
      // by someone tightening the edge check to a strict `>= 1`.
      { index: 3, depicted: true, x: 0, y: 0, w: 1, h: 1 },
    ];
    const out = await locateFocusRegions(scenePath, sentences, {
      fetch: vi.fn().mockResolvedValue(geminiWrap({ regions })) as never,
    });
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toEqual({ x: 0.7, y: 0.7, w: 0.3, h: 0.3 });
    expect(out[3]).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("throws a typed SceneImageError, not a bare ENOENT, when the image file is missing", async () => {
    // Keeps this function's error surface to exactly two types (JudgeError for the model call,
    // SceneImageError for the file). The realistic route here is a caller that swallowed an earlier
    // generateSceneImage failure — as the generator is required to — and then called this with a
    // path that was never written. A bare ENOENT would escape both catches and kill the job.
    const f = vi.fn();
    await expect(
      locateFocusRegions(path.join(sceneDir, "does-not-exist.webp"), sentences, { fetch: f as never })
    ).rejects.toThrow(SceneImageError);
    expect(f).not.toHaveBeenCalled(); // fails before spending a paid call
  });

  it("repairs once on unparseable JSON, then succeeds", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(geminiWrap("not a region reply"))
      .mockResolvedValueOnce(geminiWrap({ regions: [{ index: 0, depicted: true, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }));
    const out = await locateFocusRegions(scenePath, sentences, { fetch: f as never });
    expect(f).toHaveBeenCalledTimes(2);
    expect(out[0]).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    // The repair asks for structure only. The negative assertion keeps a "look harder" nudge, which
    // pressures the model into fabricating regions, off this path.
    const retryPrompt = JSON.parse((f.mock.calls[1] as [string, RequestInit])[1].body as string)
      .contents[0].parts[0].text as string;
    expect(retryPrompt).toContain("Output ONLY the JSON object");
    expect(retryPrompt).not.toContain("located none of the objects");
  });

  it("repairs once when a region omits the required depicted flag", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(geminiWrap({
        regions: [{ index: 0, x: 0.6, y: 0.6, w: 0.2, h: 0.2 }],
      }))
      .mockResolvedValueOnce(geminiWrap({
        regions: [{ index: 0, depicted: true, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
      }));

    const out = await locateFocusRegions(scenePath, sentences, { fetch: f as never });

    expect(f).toHaveBeenCalledTimes(2);
    expect(out[0]).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });

  it("throws when the repair response still omits the required depicted flag", async () => {
    const missingDepicted = () => geminiWrap({
      regions: [{ index: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
    });
    const f = vi.fn().mockImplementation(() => Promise.resolve(missingDepicted()));

    await expect(locateFocusRegions(scenePath, sentences, { fetch: f as never })).rejects.toThrow(/invalid-json/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("throws after the repair retry also fails to parse", async () => {
    // A fresh Response per call: a Response body can only be consumed once.
    const f = vi.fn().mockImplementation(() => Promise.resolve(geminiWrap("still not JSON")));
    await expect(locateFocusRegions(scenePath, sentences, { fetch: f as never })).rejects.toThrow(/invalid-json/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("accepts a structurally valid all-null reply without asking Gemini to look harder", async () => {
    const nothing = { regions: sentences.map((_, i) => ({ index: i, depicted: false })) };
    const f = vi.fn().mockResolvedValue(geminiWrap(nothing));

    const out = await locateFocusRegions(scenePath, sentences, { fetch: f as never });

    expect(f).toHaveBeenCalledTimes(1);
    expect(out).toEqual(Array.from({ length: 7 }, () => null));
  });

  it("repairs a duplicate index once and never applies the overwritten first reply", async () => {
    const duplicate = {
      regions: [
        { index: 2, depicted: true, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { index: 2, depicted: true, x: 0.6, y: 0.6, w: 0.2, h: 0.2 },
      ],
    };
    const repaired = {
      regions: [
        { index: 5, depicted: true, x: 0.5, y: 0.1, w: 0.2, h: 0.2 },
        { index: 2, depicted: true, x: 0.2, y: 0.1, w: 0.2, h: 0.2 },
      ],
    };
    const f = vi.fn()
      .mockResolvedValueOnce(geminiWrap(duplicate))
      .mockResolvedValueOnce(geminiWrap(repaired));

    const out = await locateFocusRegions(scenePath, sentences, { fetch: f as never });

    expect(f).toHaveBeenCalledTimes(2);
    expect(out[2]).toEqual({ x: 0.2, y: 0.1, w: 0.2, h: 0.2 });
    expect(out[5]).toEqual({ x: 0.5, y: 0.1, w: 0.2, h: 0.2 });
  });

  it("throws after the one repair response repeats a duplicate index", async () => {
    const duplicate = () => geminiWrap({
      regions: [
        { index: 1, depicted: true, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { index: 1, depicted: false },
      ],
    });
    const f = vi.fn().mockImplementation(() => Promise.resolve(duplicate()));
    await expect(locateFocusRegions(scenePath, sentences, { fetch: f as never })).rejects.toThrow(/invalid-json/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("makes no call at all for an empty sentence list", async () => {
    const f = vi.fn();
    expect(await locateFocusRegions(scenePath, [], { fetch: f as never })).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("applyScene", () => {
  it("clears a stale focus region when the authoritative result is null", () => {
    const set = legacySet();
    set.listenAndRepeat.items[0].focusRegion = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    const image = { file: "images/scenarios/new.webp", prompt: "trusted", model: SCENE_IMAGE_MODEL } as const;

    const applied = applyScene(set, image, [null]);

    expect(applied.listenAndRepeat.image).toEqual(image);
    expect(applied.listenAndRepeat.items[0]).not.toHaveProperty("focusRegion");
  });
});

describe("scene fields on the speaking schema", () => {
  it("pins three backfilled sets whose ids, exact image paths, WebP bytes, and stripped public fields agree", () => {
    const backfilledSetIds = ["spk-26132ac6", "spk-43ab8b09", "spk-e5b2b735"];
    for (const id of backfilledSetIds) {
      const setFile = path.join(speakingDir, `${id}.json`);
      const set = readSet(id);
      expect(path.basename(setFile, ".json")).toBe(set.id);
      expect(set.listenAndRepeat.image?.file).toBe(`images/scenarios/${id}.webp`);

      const imagePath = path.join(config.dataDir, set.listenAndRepeat.image!.file);
      expect(fs.existsSync(imagePath)).toBe(true);
      const bytes = fs.readFileSync(imagePath);
      expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
      expect(bytes.toString("ascii", 8, 12)).toBe("WEBP");

      const stripped = stripAnswers(set);
      if (stripped.kind !== "speaking") throw new Error("kind changed");
      expect(stripped.listenAndRepeat.image).toEqual({
        file: `images/scenarios/${id}.webp`,
        model: SCENE_IMAGE_MODEL,
      });
      for (let i = 0; i < stripped.listenAndRepeat.items.length; i += 1) {
        expect(stripped.listenAndRepeat.items[i]).not.toHaveProperty("sentence");
        expect(stripped.listenAndRepeat.items[i].focusRegion)
          .toEqual(set.listenAndRepeat.items[i].focusRegion);
      }
      const served = JSON.stringify(stripped);
      for (const item of set.listenAndRepeat.items) expect(served).not.toContain(item.sentence);
      expect(served).not.toContain(set.listenAndRepeat.image!.prompt);
      expect(served).not.toContain("\"prompt\"");
    }

    const parsed = SpeakingSetSchema.parse(legacySet());
    expect(parsed.listenAndRepeat.image).toBeUndefined();
    for (const item of parsed.listenAndRepeat.items) expect(item.focusRegion).toBeUndefined();
  });

  it("accepts a set carrying an image and per-item focus regions", () => {
    const set = legacySet();
    const withScene = {
      ...set,
      listenAndRepeat: {
        ...set.listenAndRepeat,
        image: { file: "images/scenarios/spk-e5b2b735.webp", prompt: "…", model: SCENE_IMAGE_MODEL },
        items: set.listenAndRepeat.items.map((item, i) => ({
          ...item,
          ...(i === 0 ? {} : { focusRegion: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }),
        })),
      },
    };
    const parsed = SpeakingSetSchema.parse(withScene);
    expect(parsed.listenAndRepeat.image?.model).toBe(SCENE_IMAGE_MODEL);
    expect(parsed.listenAndRepeat.items[0].focusRegion).toBeUndefined();
    expect(parsed.listenAndRepeat.items[1].focusRegion).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  it("rejects a focus region outside 0–1", () => {
    const set = legacySet();
    const bad = {
      ...set,
      listenAndRepeat: {
        ...set.listenAndRepeat,
        items: set.listenAndRepeat.items.map((item, i) => (i === 0 ? { ...item, focusRegion: { x: 1.4, y: 0, w: 0.1, h: 0.1 } } : item)),
      },
    };
    expect(() => SpeakingSetSchema.parse(bad)).toThrow();
  });

  // Builds the Set as the generator does: a scene image whose stored prompt is the real composed
  // prompt, and a focus region on every item.
  const sceneSet = () => {
    const set = legacySet();
    return AnySetSchema.parse({
      ...set,
      listenAndRepeat: {
        ...set.listenAndRepeat,
        image: {
          file: "images/scenarios/spk-e5b2b735.webp",
          prompt: composeScenePrompt(set.listenAndRepeat),
          model: SCENE_IMAGE_MODEL,
        },
        items: set.listenAndRepeat.items.map((item) => ({ ...item, focusRegion: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } })),
      },
    });
  };

  it("stripAnswers keeps safe file, model and focus regions while removing the sentence and prompt", () => {
    const stripped = stripAnswers(sceneSet());
    if (stripped.kind !== "speaking") throw new Error("kind changed");
    // The ring moves while the sentence plays and its text is still hidden, so the region must
    // survive exactly the strip that removes the sentence.
    for (const item of stripped.listenAndRepeat.items) {
      expect(item).not.toHaveProperty("sentence");
      expect(item.focusRegion).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    }
    expect(stripped.listenAndRepeat.image).toEqual({
      file: "images/scenarios/spk-e5b2b735.webp",
      model: SCENE_IMAGE_MODEL,
    });
    expect(stripped.listenAndRepeat.image).not.toHaveProperty("prompt");
  });

  it("stripAnswers leaves no target sentence anywhere in the served payload", () => {
    const set = sceneSet();
    if (set.kind !== "speaking") throw new Error("kind changed");
    const targets = set.listenAndRepeat.items.map((i) => i.sentence);

    const served = JSON.stringify(stripAnswers(set));

    // Whole-payload check, not just image.prompt: the scene prompt embeds all seven sentences
    // verbatim as its KEY OBJECTS list, so it is one route by which the answers can escape, and
    // this asserts they escape by no route at all.
    for (const sentence of targets) expect(served).not.toContain(sentence);
    expect(served).not.toContain("KEY OBJECTS");
    expect(served).not.toContain("prompt");
    expect(served).toContain(SCENE_IMAGE_MODEL);
    // The answer-bearing prompt is gone; safe rendering data and trusted provenance remain.
    expect(served).toContain("images/scenarios/spk-e5b2b735.webp");
  });

  it("stripAnswers removes persisted generation planning metadata from the served scene payload", () => {
    const parsed = AnySetSchema.parse({
      ...sceneSet(),
      generationPlan: speakingPlanFixture(),
    });
    expect(parsed).toHaveProperty("generationPlan");

    const served = JSON.stringify(stripAnswers(parsed));

    expect(served).not.toContain("generationPlan");
    expect(served).not.toContain("ceramics-studio-tool-cleanup");
    expect(served).not.toContain("missed connection");
  });

  it("stripAnswers leaves a set with no image untouched in that respect", () => {
    const stripped = stripAnswers(legacySet());
    if (stripped.kind !== "speaking") throw new Error("kind changed");
    expect(stripped.listenAndRepeat).not.toHaveProperty("image");
  });
});
