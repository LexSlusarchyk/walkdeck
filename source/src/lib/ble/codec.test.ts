import assert from "node:assert/strict";
import test from "node:test";
import { consumeFitFrames, fitFrame, parseFitPayload } from "./codec.ts";
import { plausibleTotal } from "../format.ts";

test("fit frame round-trips and rejects a bad checksum", () => {
  const frame = [...fitFrame([0x51])];
  const { frames, rest } = consumeFitFrames(frame);
  assert.deepEqual(frames, [[0x51]]);
  assert.deepEqual(rest, []);
  const broken = [...frame];
  broken[1] = 0x00;
  const bad = consumeFitFrames(broken);
  assert.equal(bad.frames.length, 0);
});

test("running status carries speed, time, distance, calories, and steps", () => {
  const sample = parseFitPayload([0x51, 0x03, 30, 0, 0x7d, 0x00, 0x0c, 0x00, 40, 0, 0xe8, 0x03, 0]);
  assert.equal(sample?.phase, "running");
  assert.equal(sample?.speedKmh, 3);
  assert.equal(sample?.elapsedSec, 125);
  assert.equal(sample?.distanceKm, 1.2);
  assert.equal(sample?.kcal, 40);
  assert.equal(sample?.steps, 1000);
  assert.equal(sample?.heart, null);
});

test("countdown and speed range", () => {
  const countdown = parseFitPayload([0x51, 0x02, 3]);
  assert.equal(countdown?.phase, "countdown");
  assert.equal(countdown?.countdown, 3);
  const range = parseFitPayload([0x50, 0x02, 60, 10]);
  assert.equal(range?.maxKmh, 6);
  assert.equal(range?.minKmh, 1);
});

test("device totals that disagree with the clock are ignored", () => {
  assert.equal(plausibleTotal(1.2, 1.1), true);
  assert.equal(plausibleTotal(12, 1.1), false);
  assert.equal(plausibleTotal(0.2, 0.01), true);
});
