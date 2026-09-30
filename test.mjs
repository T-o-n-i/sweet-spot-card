import assert from "node:assert/strict";
import { computeWeights, computeVolumes, meanVolume, volumesForMean } from "./sweet-spot-card.js";

const speakers = [
  { id: "arabella", x: 0.58, y: 0.64 },
  { id: "treppe", x: 7.99, y: 0.71 },
  { id: "kaffeeecke", x: 8.15, y: 7.49 },
  { id: "kuchensitzecke", x: 4.56, y: 6.07 },
];
const fmt = (a) => a.map((v) => v.toFixed(2)).join("  ");

// Centre of the four speakers: roughly equal.
const centre = computeWeights({ x: 5.3, y: 3.7 }, speakers, {});
console.log("Mitte        ", fmt(centre));

// Sitting next to Arabella: Arabella quieter, the others louder.
const arab = computeWeights({ x: 1.22, y: 1.24 }, speakers, {});
console.log("Arabella     ", fmt(arab));
assert.ok(arab[0] < 0 && arab[1] > 0 && arab[2] > 0);

// Fader mode is the mirror image.
const fader = computeWeights({ x: 1.22, y: 1.24 }, speakers, { mode: "fader" });
assert.deepEqual(fader.map((v) => Math.round(v * 1e6)), arab.map((v) => Math.round(-v * 1e6)));

// strength 0 means no effect.
assert.ok(computeWeights({ x: 1, y: 1 }, speakers, { strength: 0 }).every((w) => w === 0));

// Clamped to [-1, 1] even right on top of a speaker with full strength.
const extreme = computeWeights({ x: 0.58, y: 0.64 }, speakers, { strength: 1 });
assert.ok(extreme.every((w) => w >= -1 && w <= 1));

// Volumes keep the mean (within rounding).
const cur = [0.06, 0.06, 0.06, 0.06];
const vols = computeVolumes(cur, arab);
console.log("Vol Arabella ", fmt(vols));
const mean = vols.reduce((a, v) => a + v, 0) / vols.length;
assert.ok(Math.abs(mean - 0.06) <= 0.01);

// Unavailable speakers are left out of the mean; nothing known -> null.
assert.equal(computeVolumes([null, null], [0, 0]), null);
assert.deepEqual(computeVolumes([0.2, null], [0, 0]), [0.2, 0.2]);

for (const [name, p] of Object.entries({
  Sofa: { x: 1.97, y: 3.59 }, Esstisch: { x: 6.29, y: 2.92 },
  Kuechensitzecke: { x: 4.95, y: 6.79 }, Kueche: { x: 6.39, y: 7.39 },
})) console.log(name.padEnd(13), fmt(computeWeights(p, speakers, {})));
// Overall volume: new mean, same balance.
const louder = volumesForMean(0.2, arab);
console.log("Gesamt 20 %  ", fmt(louder));
assert.ok(Math.abs(meanVolume(louder) - 0.2) <= 0.01);
assert.ok(louder[0] < louder[1]);
assert.equal(meanVolume([null, 0.1, 0.3]), 0.2);
console.log("ok");
