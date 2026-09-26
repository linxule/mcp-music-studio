import { test, expect, type Page, type Frame } from "@playwright/test";
import { installAudioProbe } from "./audio-probe";

async function mount(page: Page, kind: "abc" | "strudel", args: object) {
  await page.addInitScript(installAudioProbe);
  await page.goto("/");
  await page.selectOption("#widget", kind);
  await page.waitForFunction(() => (window as any).__harness?.ready);
  await page.evaluate(async (args) => {
    const host = (window as any).__harness;
    host.setArgs(args);
    await host.send();
  }, args);
  return page.frames().find((f) => f.url().includes(`/widgets/${kind === "abc" ? "mcp" : "strudel"}-app.html`))!;
}

async function measure(frame: Frame) {
  return frame.evaluate(() => (window as any).__audioProbe()) as Promise<{ peakRms: number; contexts: number }>;
}

async function audible(frame: Frame) {
  await expect.poll(async () => (await measure(frame)).peakRms).toBeGreaterThan(0.001);
}

async function silent(frame: Frame) {
  // Allow the instrument release tail to finish, then observe a full window.
  await expect.poll(async () => (await measure(frame)).peakRms).toBeLessThan(0.0001);
  expect((await measure(frame)).peakRms).toBeLessThan(0.0001);
}

async function exported(page: Page, mimeType: string) {
  await expect.poll(() => page.evaluate(() => (window as any).__harness.lastDownload?.[0]?.resource?.mimeType)).toBe(mimeType);
  const base64 = await page.evaluate(() => (window as any).__harness.lastDownload[0].resource.blob);
  return Buffer.from(base64, "base64");
}

function assertWav(bytes: Buffer) {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  // Current encoder emits PCM16. Check actual samples, not just a file header.
  expect(bytes.readUInt16LE(20)).toBe(1);
  expect(bytes.readUInt16LE(34)).toBe(16);
  let max = 0;
  for (let i = 44; i + 1 < bytes.length; i += 2) max = Math.max(max, Math.abs(bytes.readInt16LE(i)));
  expect(max).toBeGreaterThan(32);
}

test("audio meter distinguishes a silent context from a real oscillator", async ({ page }) => {
  await page.addInitScript(installAudioProbe);
  await page.goto("/");
  await page.evaluate(() => {
    const ctx = new AudioContext();
    const source = ctx.createOscillator();
    source.connect(ctx.destination);
    (window as any).__control = { ctx, source };
  });
  expect((await page.evaluate(() => (window as any).__audioProbe())).peakRms).toBe(0);
  await page.locator(".bar strong").click();
  await page.evaluate(async () => {
    const { ctx, source } = (window as any).__control;
    await ctx.resume();
    source.start();
  });
  await audible(page.mainFrame());
  await page.evaluate(() => (window as any).__control.source.stop());
  await silent(page.mainFrame());
});

test("ABC renders, plays, stops, and exports audible WAV and score MIDI", async ({ page }) => {
  const frame = await mount(page, "abc", {
    abcNotation: "X:1\nT:Audio gate\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nC D E F|G A B c|c B A G|F E D C|",
    autoplay: false,
  });
  await expect(frame.locator("#sheet-music svg").first()).toBeVisible();
  await frame.locator(".abcjs-midi-start").click();
  await audible(frame);
  await frame.locator(".abcjs-midi-start").click();
  await silent(frame);
  await frame.getByRole("button", { name: "Download audio as WAV", exact: true }).click();
  assertWav(await exported(page, "audio/wav"));
  await frame.locator("button").filter({ hasText: /^MIDI$/ }).click();
  const midi = await exported(page, "audio/midi");
  expect(midi.toString("ascii", 0, 4)).toBe("MThd");
  expect(midi.includes(Buffer.from("MTrk"))).toBe(true);
});

test("Strudel visual preset remains audible, records WAV, and stops", async ({ page }) => {
  const frame = await mount(page, "strudel", {
    code: 'note("c3 e3 g3 c4").s("sine").gain(0.3)',
    visuals: "pianoroll", bpm: 120, autoplay: false,
  });
  await expect(frame.locator("#status")).toContainText("Ready — click Play");
  await expect(frame.locator("#play-btn")).toBeEnabled();
  await frame.locator("#play-btn").click();
  await audible(frame);
  await expect(frame.locator("#test-canvas")).toBeVisible();
  // The preset must paint pixels, not merely reveal an empty canvas.
  await expect.poll(() => frame.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>("#test-canvas")!;
    return c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.some((x, i) => i % 4 === 3 && x > 0);
  })).toBe(true);
  await frame.locator("#record-btn").click();
  await audible(frame);
  await frame.locator("#record-btn").click();
  await expect(frame.locator("#download-btn")).toBeEnabled();
  await frame.locator("#download-btn").click();
  assertWav(await exported(page, "audio/wav"));
  await frame.locator("#play-btn").click();
  await silent(frame);
});
