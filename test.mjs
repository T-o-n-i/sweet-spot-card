import assert from "node:assert/strict";
import { computeWeights, computeVolumes, meanVolume, volumesForMean, pickColors, similarColors, roomOutline, outlineToShape, CORNERS, encodeEntry, decodeWeights } from "./sweet-spot-card.js";

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
// Theme colours: default theme keeps primary/success/accent.
const hex = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
const theme = (vars) => (css) => {
  const name = css.match(/--[\w-]+/)[0];
  const fallback = css.match(/#[0-9a-f]{6}/i)[0];
  return hex(vars[name] || fallback);
};
const std = pickColors(theme({}));
assert.match(std.speaker, /primary/);
assert.match(std.position, /success/);
assert.match(std.listener, /accent/);
// Orange theme: primary == accent, so the listener moves on to info.
const orange = pickColors(theme({ "--primary-color": "#ff9800", "--accent-color": "#ff9800" }));
assert.match(orange.listener, /info/);
// Everything the same colour: still three different picks.
const mono = pickColors(theme({ "--primary-color": "#4caf50", "--accent-color": "#4caf50", "--success-color": "#4caf50" }));
assert.equal(new Set(Object.values(mono)).size, 3);
assert.ok(similarColors("rgb(3, 169, 244)", "rgb(3, 155, 229)"));
// Room shapes: the hand-written outline from the living room is an L.
const living = [[0, 0], [8.6, 0], [8.6, 7.9], [4.1, 7.9], [4.1, 4.22], [0, 4.22]];
const parsed = outlineToShape(living, 8.6, 7.9);
assert.equal(parsed.shape, "l");
assert.equal(parsed.cutout.corner, "bottom-left");
assert.ok(Math.abs(parsed.cutout.width - 4.1) < 1e-9 && Math.abs(parsed.cutout.height - 3.68) < 1e-9);
assert.deepEqual(outlineToShape(roomOutline({ width: 5, height: 3 }), 5, 3), { shape: "rectangle" });
for (const corner of CORNERS) {
  const room = { width: 6, height: 4, shape: "l", cutout: { corner, width: 2, height: 1.5 } };
  assert.deepEqual(outlineToShape(roomOutline(room), 6, 4), { shape: "l", cutout: room.cutout });
}
assert.equal(outlineToShape([[0, 0], [5, 0], [3, 3]], 5, 3), null);
// Storage entries: weights sorted by entity_id, round trip in card order.
const spk = [
  { entity: "media_player.wohnzimmer_arabella" },
  { entity: "media_player.wohnzimmer_treppe" },
  { entity: "media_player.kuche_kaffeeecke" },
  { entity: "media_player.kuche_kuchensitzecke" },
];
const entry = encodeEntry({ x: 1.2, y: 3.4 }, [-1, 0.4, 0.6, 0.3], spk);
// kuche_kaffeeecke, kuche_kuchensitzecke, wohnzimmer_arabella, wohnzimmer_treppe
assert.deepEqual(entry, [1.2, 3.4, 6, 3, -10, 4]);
assert.deepEqual(decodeWeights(entry, spk), [-1, 0.4, 0.6, 0.3]);
assert.equal(decodeWeights([1.2, 3.4], spk), null);
assert.equal(decodeWeights([1, 2, 3], spk), null);
const full = JSON.stringify(Object.fromEntries(["Arabella", "Sofa", "Esstisch", "Küche", "Küchensitzecke"].map((o) => [o, entry])));
console.log("Speicher     ", full.length, "Zeichen");
assert.ok(full.length <= 255);
console.log("ok");
