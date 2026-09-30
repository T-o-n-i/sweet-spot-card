/*
 * Sweet Spot Card – a Home Assistant Lovelace card that balances several
 * speakers in one room around a draggable listening position.
 *
 * https://github.com/T-o-n-i/sweet-spot-card
 * MIT License
 */

const CARD_VERSION = "0.4.0";

const DEFAULTS = {
  mode: "listener", // "listener": nearer speakers get quieter; "fader": nearer speakers get louder
  strength: 0.5, // 0 = no effect, 1 = full inverse-distance compensation
  min_distance: 0.5, // in room units; avoids extreme values right next to a speaker
  weight_min: -1,
  weight_max: 1,
  master: true, // show the slider for the overall volume
};

// Colours come from the theme only. Each role tries its candidates in order and
// takes the first one that is clearly different from the roles chosen before it,
// so themes where e.g. primary and accent are the same still stay readable.
const COLOR_ROLES = [
  ["speaker", ["var(--primary-color, #03a9f4)", "var(--info-color, #039be5)", "var(--blue-color, #2196f3)", "var(--teal-color, #009688)"]],
  ["position", ["var(--success-color, #43a047)", "var(--green-color, #4caf50)", "var(--teal-color, #009688)", "var(--purple-color, #926bc7)"]],
  ["listener", ["var(--accent-color, #ff9800)", "var(--info-color, #039be5)", "var(--purple-color, #926bc7)", "var(--blue-color, #2196f3)", "var(--red-color, #f44336)"]],
];

/** True if two "rgb(r, g, b)" strings are too close to tell apart. */
export function similarColors(a, b) {
  const pa = (a.match(/[\d.]+/g) || []).map(Number);
  const pb = (b.match(/[\d.]+/g) || []).map(Number);
  if (pa.length < 3 || pb.length < 3) return false;
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) < 60;
}

/**
 * Picks one candidate per role so that no two roles look alike.
 * `resolve` turns a CSS colour into "rgb(...)".
 */
export function pickColors(resolve) {
  const chosen = {};
  const used = [];
  for (const [role, candidates] of COLOR_ROLES) {
    let pick = candidates[0];
    let rgb = resolve(pick);
    for (const c of candidates) {
      const r = resolve(c);
      if (!used.some((u) => similarColors(u, r))) {
        pick = c;
        rgb = r;
        break;
      }
    }
    chosen[role] = pick;
    used.push(rgb);
  }
  return chosen;
}

const STRINGS = {
  en: {
    reset: "Reset position",
    master: "Total",
    unavailable: "unavailable",
    drag_hint: "Drag the dot or tap a position",
    drag_hint_free: "Drag the dot",
    missing: "Entity not found",
  },
  de: {
    reset: "Position zurücksetzen",
    master: "Gesamt",
    unavailable: "nicht verfügbar",
    drag_hint: "Punkt ziehen oder Platz antippen",
    drag_hint_free: "Punkt ziehen",
    missing: "Entität nicht gefunden",
  },
};

/* ---------- pure calculation, kept separate so it can be tested ---------- */

/**
 * Weight per speaker in the range [weight_min, weight_max].
 * A weight w means "2^w times the average volume" (−1 = half, +1 = double).
 */
export function computeWeights(dot, speakers, opts) {
  const o = { ...DEFAULTS, ...opts };
  const dist = speakers.map((s) =>
    Math.max(Math.hypot(s.x - dot.x, s.y - dot.y), o.min_distance)
  );
  const logMean = dist.reduce((a, d) => a + Math.log2(d), 0) / dist.length;
  const sign = o.mode === "fader" ? -1 : 1;
  return dist.map((d) => {
    const w = sign * o.strength * (Math.log2(d) - logMean);
    return Math.min(o.weight_max, Math.max(o.weight_min, w));
  });
}

/**
 * Volumes (0..1) for the given weights that keep the mean of the current
 * volumes. Speakers without a current volume are left out of the mean.
 */
export function computeVolumes(currentVolumes, weights) {
  const mean = meanVolume(currentVolumes);
  return mean === null ? null : volumesForMean(mean, weights);
}

/** Mean of the known volumes, or null if none is known. */
export function meanVolume(volumes) {
  const known = volumes.filter((v) => typeof v === "number");
  if (known.length === 0) return null;
  return known.reduce((a, v) => a + v, 0) / known.length;
}

/** Volumes (0..1) with the given mean, split according to the weights. */
export function volumesForMean(mean, weights) {
  const factors = weights.map((w) => Math.pow(2, w));
  const fMean = factors.reduce((a, f) => a + f, 0) / factors.length;
  return factors.map((f) =>
    Math.min(1, Math.max(0, Math.round((mean * f) / fMean * 100) / 100))
  );
}

/* ------------------------------- room shape ------------------------------- */

export const CORNERS = ["bottom-left", "bottom-right", "top-left", "top-right"];

/**
 * Outline of the room as [x, y] points. An explicit `outline` wins; otherwise
 * `shape: l` cuts a rectangle (`cutout`) out of one corner.
 */
export function roomOutline(room) {
  const W = room.width;
  const H = room.height;
  if (Array.isArray(room.outline) && room.outline.length >= 3) return room.outline;
  if (room.shape === "l" && room.cutout) {
    const cw = Math.min(Math.max(room.cutout.width, 0), W);
    const ch = Math.min(Math.max(room.cutout.height, 0), H);
    switch (room.cutout.corner) {
      case "bottom-right":
        return [[0, 0], [W, 0], [W, H - ch], [W - cw, H - ch], [W - cw, H], [0, H]];
      case "top-left":
        return [[cw, 0], [W, 0], [W, H], [0, H], [0, ch], [cw, ch]];
      case "top-right":
        return [[0, 0], [W - cw, 0], [W - cw, ch], [W, ch], [W, H], [0, H]];
      default: // bottom-left
        return [[0, 0], [W, 0], [W, H], [cw, H], [cw, H - ch], [0, H - ch]];
    }
  }
  return [[0, 0], [W, 0], [W, H], [0, H]];
}

/**
 * Recognises a rectangle or L-shape in an outline, so older configs with a
 * hand-written outline can be edited. Returns null for any other shape.
 */
export function outlineToShape(outline, W, H) {
  const key = (pts) =>
    pts.map((p) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`).sort().join(" ");
  const target = key(outline);
  if (target === key(roomOutline({ width: W, height: H }))) return { shape: "rectangle" };
  const xs = [...new Set(outline.map((p) => p[0]))].filter((x) => x > 0 && x < W);
  const ys = [...new Set(outline.map((p) => p[1]))].filter((y) => y > 0 && y < H);
  if (xs.length !== 1 || ys.length !== 1) return null;
  const [a] = xs;
  const [b] = ys;
  const sizes = {
    "bottom-left": [a, H - b],
    "bottom-right": [W - a, H - b],
    "top-left": [a, b],
    "top-right": [W - a, b],
  };
  for (const corner of CORNERS) {
    const [width, height] = sizes[corner];
    const cutout = { corner, width, height };
    if (key(roomOutline({ width: W, height: H, shape: "l", cutout })) === target) {
      return { shape: "l", cutout };
    }
  }
  return null;
}

/* ---------------------------------- card ---------------------------------- */

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Allows importing the calculation in Node for tests.
const Base = typeof HTMLElement !== "undefined" ? HTMLElement : class {};

class SweetSpotCard extends Base {
  static getConfigElement() {
    return document.createElement("sweet-spot-card-editor");
  }

  static getStubConfig(hass) {
    const players = Object.keys(hass?.states || {}).filter((e) => e.startsWith("media_player."));
    const pick = (i, fallback) => players[i] || fallback;
    const a = pick(0, "media_player.left");
    const b = pick(1, "media_player.right");
    return {
      room: { width: 6, height: 4 },
      speakers: [
        { id: slugify(a.split(".")[1]), entity: a, x: 0.5, y: 0.5 },
        { id: slugify(b.split(".")[1]), entity: b, x: 5.5, y: 0.5 },
      ],
    };
  }

  setConfig(config) {
    if (!config.room || !(config.room.width > 0) || !(config.room.height > 0)) {
      throw new Error("room.width and room.height are required");
    }
    if (!Array.isArray(config.speakers) || config.speakers.length < 2) {
      throw new Error("At least two speakers are required");
    }
    for (const s of config.speakers) {
      if (!s.entity || typeof s.x !== "number" || typeof s.y !== "number") {
        throw new Error("Every speaker needs entity, x and y");
      }
    }
    const pos = config.positions;
    if (pos && (!pos.entity || !Array.isArray(pos.items))) {
      throw new Error("positions needs entity and items");
    }
    if (pos && pos.weight_entity && config.speakers.some((s) => !s.id)) {
      throw new Error("positions.weight_entity needs an id on every speaker");
    }
    this._config = { ...DEFAULTS, ...config };
    this._built = false;
    this._local = null; // dot position while dragging or until HA confirms
    if (this._hass) this._build();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    if (!this._built) this._build();
    this._update();
  }

  getCardSize() {
    return 7;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  /* ---------------- helpers ---------------- */

  _t(key) {
    const lang = (this._hass?.locale?.language || this._hass?.language || "en").split("-")[0];
    return (STRINGS[lang] || STRINGS.en)[key];
  }

  get _positions() {
    return this._config.positions || null;
  }

  _activeItem() {
    const pos = this._positions;
    if (!pos) return null;
    const state = this._hass.states[pos.entity]?.state;
    return pos.items.find((i) => i.option === state) || null;
  }

  _stored() {
    const key = this._positions?.storage;
    if (!key) return {};
    try {
      return JSON.parse(this._hass.states[key]?.state || "{}") || {};
    } catch (e) {
      return {};
    }
  }

  _itemPos(item) {
    const saved = this._stored()[item.option];
    if (Array.isArray(saved) && saved.length === 2) return { x: saved[0], y: saved[1] };
    return { x: item.x, y: item.y };
  }

  _dotFromState() {
    const item = this._activeItem();
    if (item) return this._itemPos(item);
    const { width, height } = this._config.room;
    return this._free || { x: width / 2, y: height / 2 };
  }

  _currentVolumes() {
    return this._config.speakers.map((s) => {
      const st = this._hass.states[s.entity];
      if (!st || st.state === "unavailable") return null;
      const v = st.attributes.volume_level;
      return typeof v === "number" ? v : null;
    });
  }

  _weightEntity(item, speaker) {
    return this._positions.weight_entity
      .replace("{position}", item.id)
      .replace("{speaker}", speaker.id);
  }

  /* ---------------- DOM ---------------- */

  _build() {
    const c = this._config;
    const { width: W, height: H } = c.room;
    const size = Math.max(W, H);
    const pad = size * 0.09;
    this._u = size / 100; // one "percent" of the room, used for radii and text

    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 12px 16px 16px; }
        .title { font-size: 1.2em; font-weight: 500; margin: 4px 0 8px; }
        svg { width: 100%; height: auto; display: block; touch-action: none; user-select: none; }
        .room { fill: var(--secondary-background-color, rgba(127,127,127,.08)); stroke: var(--divider-color, #999); }
        :host { --ssc-speaker: ${COLOR_ROLES[0][1][0]}; --ssc-position: ${COLOR_ROLES[1][1][0]}; --ssc-listener: ${COLOR_ROLES[2][1][0]}; }
        .probe { position: absolute; visibility: hidden; }
        .speaker { fill: var(--ssc-speaker); }
        .speaker.off { fill: var(--disabled-text-color, #999); }
        .ray { stroke: var(--ssc-speaker); stroke-opacity: .25; }
        .marker { fill: var(--card-background-color, #fff); stroke: var(--ssc-position); cursor: pointer; }
        .marker.active { fill: var(--ssc-position); fill-opacity: .35; }
        .dot { fill: var(--ssc-listener); stroke: var(--card-background-color, #fff); cursor: grab; }
        .label { fill: var(--primary-text-color, #222); }
        .sub { fill: var(--secondary-text-color, #666); }
        .footer { display: flex; justify-content: space-between; align-items: center; margin-top: 8px;
                  color: var(--secondary-text-color); font-size: .9em; gap: 8px; }
        button { font: inherit; color: var(--primary-color); background: none; border: 1px solid var(--divider-color);
                 border-radius: 8px; padding: 4px 10px; cursor: pointer; }
        .warn { color: var(--error-color, #db4437); font-size: .9em; }
        .master { display: flex; align-items: center; gap: 12px; margin-top: 8px; color: var(--primary-text-color); }
        .master input { flex: 1; accent-color: var(--primary-color); min-height: 32px; }
        .master .mval { min-width: 3.5em; text-align: right; font-variant-numeric: tabular-nums; }
      </style>
      <ha-card>
        ${c.title ? `<div class="title"></div>` : ""}
        <span class="probe"></span>
        <div class="warn"></div>
        ${c.master ? `<div class="master"><span class="mlabel"></span><input type="range" min="0" max="100" step="1"><span class="mval"></span></div>` : ""}
        <div class="footer"><span class="hint"></span><button class="reset" hidden></button></div>
      </ha-card>`;

    const card = this.shadowRoot.querySelector("ha-card");
    if (c.title) card.querySelector(".title").textContent = c.title;

    const svg = svgEl("svg", {
      viewBox: `${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}`,
      preserveAspectRatio: "xMidYMid meet",
    });
    const fs = this._u * 3.8;

    if (c.room.image) {
      svg.appendChild(svgEl("image", { href: c.room.image, x: 0, y: 0, width: W, height: H, preserveAspectRatio: "none" }));
    } else {
      const outline = roomOutline(c.room);
      svg.appendChild(svgEl("polygon", {
        class: "room",
        points: outline.map((p) => p.join(",")).join(" "),
        "stroke-width": this._u * 0.4,
      }));
    }

    const rays = svgEl("g");
    svg.appendChild(rays);
    this._rays = c.speakers.map(() => {
      const l = svgEl("line", { class: "ray", "stroke-width": this._u * 0.5 });
      rays.appendChild(l);
      return l;
    });

    this._markers = [];
    for (const item of this._positions?.items || []) {
      const g = svgEl("g");
      const circle = svgEl("circle", { class: "marker", cx: item.x, cy: item.y, r: this._u * 2.6, "stroke-width": this._u * 0.6 });
      const label = svgEl("text", { class: "sub", x: item.x, y: item.y + this._u * 6, "text-anchor": "middle", "font-size": fs * 0.9 });
      label.textContent = item.name || item.option;
      g.append(circle, label);
      g.addEventListener("pointerdown", (e) => {
        // The active marker sits under the dot; let a press there start a drag.
        if (item === this._activeItem()) return;
        e.stopPropagation();
        this._selectPosition(item);
      });
      svg.appendChild(g);
      this._markers.push({ item, circle, label });
    }

    this._speakerEls = c.speakers.map((s) => {
      const circle = svgEl("circle", { class: "speaker", cx: s.x, cy: s.y, r: this._u * 2.4 });
      const name = svgEl("text", { class: "label", x: s.x, y: s.y - this._u * 4, "text-anchor": "middle", "font-size": fs });
      name.textContent = s.name || this._hass.states[s.entity]?.attributes.friendly_name || s.entity;
      const vol = svgEl("text", { class: "sub", x: s.x, y: s.y + this._u * 6.5, "text-anchor": "middle", "font-size": fs * 0.9 });
      svg.append(circle, name, vol);
      return { circle, vol };
    });

    this._dot = svgEl("circle", { class: "dot", r: this._u * 3.2, "stroke-width": this._u * 0.8 });
    svg.appendChild(this._dot);

    svg.addEventListener("pointerdown", (e) => this._dragStart(e));
    svg.addEventListener("pointermove", (e) => this._dragMove(e));
    svg.addEventListener("pointerup", (e) => this._dragEnd(e));
    svg.addEventListener("pointercancel", (e) => this._dragEnd(e));

    card.insertBefore(svg, card.querySelector(".warn"));
    this._svg = svg;

    const reset = card.querySelector(".reset");
    reset.textContent = this._t("reset");
    reset.addEventListener("click", () => this._resetToMarker());
    this._resetBtn = reset;
    if (c.master) {
      card.querySelector(".mlabel").textContent = this._t("master");
      const slider = card.querySelector(".master input");
      slider.addEventListener("input", () => {
        this._sliding = true;
        this._previewMaster(Number(slider.value));
      });
      slider.addEventListener("change", () => {
        this._sliding = false;
        this._masterUntil = Date.now() + 3000;
        this._applyMaster(Number(slider.value));
      });
      this._slider = slider;
      this._mval = card.querySelector(".mval");
    }
    this._probe = card.querySelector(".probe");
    this._colorsFor = undefined;
    this._hint = card.querySelector(".hint");
    this._warn = card.querySelector(".warn");
    this._built = true;
  }

  _updateColors() {
    // Re-check when the theme or dark mode changes; needs to be in the DOM.
    const key = JSON.stringify([this._hass.themes?.theme, this._hass.themes?.darkMode]);
    if (key === this._colorsFor || !this.isConnected) return;
    const resolve = (css) => {
      this._probe.style.color = "";
      this._probe.style.color = css;
      return getComputedStyle(this._probe).color;
    };
    if (!resolve("var(--primary-color, #03a9f4)")) return;
    const colors = pickColors(resolve);
    this.style.setProperty("--ssc-speaker", colors.speaker);
    this.style.setProperty("--ssc-position", colors.position);
    this.style.setProperty("--ssc-listener", colors.listener);
    this._colorsFor = key;
  }

  connectedCallback() {
    this._colorsFor = undefined;
    if (this._hass && this._built) this._updateColors();
  }

  _update() {
    const c = this._config;
    this._updateColors();
    const missing = [
      ...c.speakers.map((s) => s.entity),
      ...(this._positions ? [this._positions.entity] : []),
      ...(this._positions?.storage ? [this._positions.storage] : []),
    ].filter((e) => !this._hass.states[e]);
    this._warn.textContent = missing.length ? `${this._t("missing")}: ${missing.join(", ")}` : "";

    const active = this._activeItem();
    for (const m of this._markers) m.circle.classList.toggle("active", m.item === active);

    if (this._local && !this._dragging && Date.now() > this._localUntil) this._local = null;
    const dot = this._local || this._dotFromState();
    this._drawDot(dot);

    if (this._slider && !this._sliding && !(Date.now() < this._masterUntil)) {
      const mean = meanVolume(this._currentVolumes());
      this._slider.disabled = mean === null;
      const pct = mean === null ? 0 : Math.round(mean * 100);
      this._slider.value = pct;
      this._mval.textContent = mean === null ? "–" : `${pct} %`;
    }

    this._hint.textContent = this._t(this._positions ? "drag_hint" : "drag_hint_free");
    this._resetBtn.hidden = !active;
  }

  _drawDot(dot) {
    const c = this._config;
    this._dot.setAttribute("cx", dot.x);
    this._dot.setAttribute("cy", dot.y);

    const weights = computeWeights(dot, c.speakers, c);
    const current = this._currentVolumes();
    const preview = computeVolumes(current, weights);

    // Markers show where each place currently is; the active one follows the dot.
    const active = this._activeItem();
    for (const m of this._markers) {
      const p = m.item === active ? dot : this._itemPos(m.item);
      m.circle.setAttribute("cx", p.x);
      m.circle.setAttribute("cy", p.y);
      m.label.setAttribute("x", p.x);
      m.label.setAttribute("y", p.y + this._u * 6);
    }

    c.speakers.forEach((s, i) => {
      const ray = this._rays[i];
      ray.setAttribute("x1", dot.x);
      ray.setAttribute("y1", dot.y);
      ray.setAttribute("x2", s.x);
      ray.setAttribute("y2", s.y);
      const el = this._speakerEls[i];
      const off = current[i] === null;
      el.circle.classList.toggle("off", off);
      // Radius grows with the weight so the balance is visible at a glance.
      el.circle.setAttribute("r", this._u * (2.4 + 0.9 * weights[i]));
      if (off) el.vol.textContent = this._t("unavailable");
      else if (this._dragging && preview) el.vol.textContent = `${Math.round(preview[i] * 100)} %`;
      else el.vol.textContent = `${Math.round(current[i] * 100)} %`;
    });
  }

  /* ---------------- interaction ---------------- */

  _toRoom(e) {
    const pt = this._svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(this._svg.getScreenCTM().inverse());
    const { width: W, height: H } = this._config.room;
    return {
      x: Math.round(Math.min(W, Math.max(0, p.x)) * 100) / 100,
      y: Math.round(Math.min(H, Math.max(0, p.y)) * 100) / 100,
    };
  }

  _dragStart(e) {
    this._dragging = true;
    this._svg.setPointerCapture(e.pointerId);
    this._local = this._toRoom(e);
    this._drawDot(this._local);
  }

  _dragMove(e) {
    if (!this._dragging) return;
    this._local = this._toRoom(e);
    this._drawDot(this._local);
  }

  _dragEnd(e) {
    if (!this._dragging) return;
    this._dragging = false;
    try {
      this._svg.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* already released */
    }
    this._localUntil = Date.now() + 3000;
    this._apply(this._local);
  }

  _selectPosition(item) {
    this._local = null;
    this._hass.callService("input_select", "select_option", {
      entity_id: this._positions.entity,
      option: item.option,
    });
  }

  _resetToMarker() {
    const item = this._activeItem();
    if (!item) return;
    this._local = { x: item.x, y: item.y };
    this._localUntil = Date.now() + 3000;
    this._apply(this._local);
  }

  /* ---------------- overall volume ---------------- */

  /** Target volumes for a new overall volume (0..100), keeping the balance. */
  _masterVolumes(pct) {
    const c = this._config;
    const target = pct / 100;
    const current = this._currentVolumes();
    const item = this._activeItem();
    if (item && this._positions.weight_entity) {
      // Use the stored balance so rounding at low volumes does not add up.
      const weights = c.speakers.map((s) => {
        const v = Number(this._hass.states[this._weightEntity(item, s)]?.state);
        return Number.isFinite(v) ? v : 0;
      });
      return volumesForMean(target, weights);
    }
    const mean = meanVolume(current);
    if (mean === null) return null;
    return current.map((v) =>
      v === null ? null : Math.min(1, Math.round((mean > 0 ? (v * target) / mean : target) * 100) / 100)
    );
  }

  _previewMaster(pct) {
    this._mval.textContent = `${pct} %`;
    const volumes = this._masterVolumes(pct);
    if (!volumes) return;
    const current = this._currentVolumes();
    this._speakerEls.forEach((el, i) => {
      if (current[i] !== null) el.vol.textContent = `${Math.round(volumes[i] * 100)} %`;
    });
  }

  async _applyMaster(pct) {
    const volumes = this._masterVolumes(pct);
    if (!volumes) return;
    const current = this._currentVolumes();
    await Promise.all(this._config.speakers.map((s, i) => {
      if (current[i] === null || volumes[i] === null) return null;
      return this._hass.callService("media_player", "volume_set", {
        entity_id: s.entity,
        volume_level: volumes[i],
      });
    }));
  }

  /* ---------------- writing to HA ---------------- */

  async _apply(dot) {
    const c = this._config;
    const weights = computeWeights(dot, c.speakers, c);
    const item = this._activeItem();
    const pos = this._positions;

    if (item && pos.storage) {
      const stored = this._stored();
      stored[item.option] = [dot.x, dot.y];
      this._hass.callService("input_text", "set_value", {
        entity_id: pos.storage,
        value: JSON.stringify(stored),
      });
    } else if (!item) {
      this._free = dot;
    }

    if (item && pos.weight_entity) {
      // Weights go into helpers; an automation in HA turns them into volumes.
      await Promise.all(c.speakers.map((s, i) => {
        const entity = this._weightEntity(item, s);
        const st = this._hass.states[entity];
        const step = st?.attributes.step || 0.1;
        const value = Math.round(weights[i] / step) * step;
        if (st && Math.abs(Number(st.state) - value) < step / 2) return null;
        return this._hass.callService("input_number", "set_value", {
          entity_id: entity,
          value: Math.round(value * 1000) / 1000,
        });
      }));
      return;
    }

    // No helpers configured: set the volumes directly, keeping the mean.
    const volumes = computeVolumes(this._currentVolumes(), weights);
    if (!volumes) return;
    await Promise.all(c.speakers.map((s, i) => {
      if (this._currentVolumes()[i] === null) return null;
      return this._hass.callService("media_player", "volume_set", {
        entity_id: s.entity,
        volume_level: volumes[i],
      });
    }));
  }
}


/* --------------------------------- editor --------------------------------- */

export function slugify(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const EDITOR_STRINGS = {
  en: {
    title: "Title",
    width: "Room width",
    height: "Room depth",
    shape: "Room shape",
    rectangle: "Rectangle",
    l: "L-shape",
    custom: "Custom outline (YAML)",
    corner: "Missing corner",
    "top-left": "Top left",
    "top-right": "Top right",
    "bottom-left": "Bottom left",
    "bottom-right": "Bottom right",
    mode: "Mode",
    listener: "Listening position (near speakers quieter)",
    fader: "Fader (near speakers louder)",
    strength: "Strength",
    master: "Overall volume slider",
    plan: "Floor plan",
    plan_hint: "Drag speakers, places and the square handle of the L-shape into position.",
    speakers: "Speakers",
    add_speaker: "Add speaker",
    remove: "Remove",
    entity: "Speaker",
    name: "Label",
    positions: "Places (optional)",
    positions_hint: "An input_select with one option per place. Needed if places should be switchable from automations or voice assistants.",
    pos_entity: "Selection (input_select)",
    storage: "Memory for dragged places (input_text)",
    weight_entity: "Balance helpers, e.g. input_number.balance_{position}_{speaker}",
    sync: "Take places from selection",
    min_two: "At least two speakers are needed.",
    custom_note: "The room uses a custom outline from YAML. Choose a shape to replace it.",
  },
  de: {
    title: "Titel",
    width: "Raumbreite",
    height: "Raumtiefe",
    shape: "Raumform",
    rectangle: "Rechteck",
    l: "L-Form",
    custom: "Eigene Form (YAML)",
    corner: "Fehlende Ecke",
    "top-left": "Oben links",
    "top-right": "Oben rechts",
    "bottom-left": "Unten links",
    "bottom-right": "Unten rechts",
    mode: "Modus",
    listener: "Hörplatz (nahe Lautsprecher leiser)",
    fader: "Fader (nahe Lautsprecher lauter)",
    strength: "Stärke",
    master: "Regler für Gesamtlautstärke",
    plan: "Grundriss",
    plan_hint: "Lautsprecher, Plätze und den eckigen Griff der L-Form an ihren Ort ziehen.",
    speakers: "Lautsprecher",
    add_speaker: "Lautsprecher hinzufügen",
    remove: "Entfernen",
    entity: "Lautsprecher",
    name: "Beschriftung",
    positions: "Plätze (optional)",
    positions_hint: "Ein input_select mit einer Option pro Platz. Nötig, wenn Plätze auch per Automation oder Sprachassistent umschaltbar sein sollen.",
    pos_entity: "Auswahl (input_select)",
    storage: "Speicher für gezogene Plätze (input_text)",
    weight_entity: "Balance-Helfer, z. B. input_number.balance_{position}_{speaker}",
    sync: "Plätze aus Auswahl übernehmen",
    min_two: "Es werden mindestens zwei Lautsprecher gebraucht.",
    custom_note: "Der Raum hat eine eigene Form aus YAML. Wähle eine Form, um sie zu ersetzen.",
  },
};

const SNAP = 0.05;
const snap = (v) => Math.round(v / SNAP) * SNAP;
const round2 = (v) => Math.round(v * 100) / 100;

class SweetSpotCardEditor extends Base {
  setConfig(config) {
    this._config = JSON.parse(JSON.stringify(config));
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._loadComponents().then(() => {
        this._structure = null;
        this._render();
      });
    }
    this._render();
  }

  _t(key) {
    const lang = (this._hass?.locale?.language || this._hass?.language || "en").split("-")[0];
    return (EDITOR_STRINGS[lang] || EDITOR_STRINGS.en)[key] ?? key;
  }

  // ha-form and the entity picker are loaded lazily by HA; creating an
  // entities card editor once makes sure they exist.
  async _loadComponents() {
    if (customElements.get("ha-form") && customElements.get("ha-entity-picker")) return;
    try {
      const helpers = await window.loadCardHelpers?.();
      if (!helpers) return;
      const card = await helpers.createCardElement({ type: "entities", entities: [] });
      await card.constructor.getConfigElement?.();
    } catch (e) {
      /* the form falls back to whatever is available */
    }
  }

  _fire() {
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: this._config },
      bubbles: true,
      composed: true,
    }));
  }

  /* ---------------- room model ---------------- */

  _room() {
    const r = this._config.room || {};
    const W = r.width > 0 ? r.width : 6;
    const H = r.height > 0 ? r.height : 4;
    let shape = r.shape === "l" ? "l" : "rectangle";
    let cutout = r.cutout;
    if (Array.isArray(r.outline) && r.outline.length >= 3) {
      const parsed = outlineToShape(r.outline, W, H);
      if (parsed) ({ shape, cutout } = { cutout: undefined, ...parsed });
      else shape = "custom";
    }
    cutout = {
      corner: CORNERS.includes(cutout?.corner) ? cutout.corner : "bottom-left",
      width: cutout?.width > 0 ? cutout.width : round2(W / 2),
      height: cutout?.height > 0 ? cutout.height : round2(H / 2),
    };
    return { W, H, shape, cutout, image: r.image };
  }

  _writeRoom({ W, H, shape, cutout, image }) {
    const room = { width: round2(W), height: round2(H) };
    if (image) room.image = image;
    if (shape === "l") {
      room.shape = "l";
      room.cutout = {
        corner: cutout.corner,
        width: round2(Math.min(Math.max(cutout.width, 0.1), W - 0.1)),
        height: round2(Math.min(Math.max(cutout.height, 0.1), H - 0.1)),
      };
    } else if (shape === "custom") {
      room.outline = this._config.room.outline;
    }
    this._config.room = room;
    // Keep everything inside the room when it gets smaller.
    const clamp = (p) => {
      p.x = round2(Math.min(Math.max(p.x, 0), W));
      p.y = round2(Math.min(Math.max(p.y, 0), H));
    };
    (this._config.speakers || []).forEach(clamp);
    (this._config.positions?.items || []).forEach(clamp);
  }

  /* ---------------- forms ---------------- */

  _generalSchema(room) {
    const t = (k) => this._t(k);
    const shapes = [{ value: "rectangle", label: t("rectangle") }, { value: "l", label: t("l") }];
    if (room.shape === "custom") shapes.push({ value: "custom", label: t("custom") });
    return [
      { name: "title", selector: { text: {} } },
      { type: "grid", name: "", schema: [
        { name: "width", selector: { number: { min: 1, max: 100, step: 0.1, mode: "box" } } },
        { name: "height", selector: { number: { min: 1, max: 100, step: 0.1, mode: "box" } } },
      ] },
      { type: "grid", name: "", schema: [
        { name: "shape", selector: { select: { mode: "dropdown", options: shapes } } },
        ...(room.shape === "l"
          ? [{ name: "corner", selector: { select: { mode: "dropdown", options: CORNERS.map((c) => ({ value: c, label: t(c) })) } } }]
          : []),
      ] },
      { name: "mode", selector: { select: { mode: "dropdown", options: [
        { value: "listener", label: t("listener") },
        { value: "fader", label: t("fader") },
      ] } } },
      { name: "strength", selector: { number: { min: 0, max: 1, step: 0.05, mode: "slider" } } },
      { name: "master", selector: { boolean: {} } },
    ];
  }

  _generalData(room) {
    const c = this._config;
    return {
      title: c.title || "",
      width: room.W,
      height: room.H,
      shape: room.shape,
      corner: room.cutout.corner,
      mode: c.mode || DEFAULTS.mode,
      strength: c.strength ?? DEFAULTS.strength,
      master: c.master ?? DEFAULTS.master,
    };
  }

  _onGeneral(v) {
    const room = this._room();
    if (v.title) this._config.title = v.title;
    else delete this._config.title;
    this._config.mode = v.mode;
    this._config.strength = v.strength;
    this._config.master = v.master;
    this._writeRoom({
      ...room,
      W: Number(v.width) > 0 ? Number(v.width) : room.W,
      H: Number(v.height) > 0 ? Number(v.height) : room.H,
      shape: v.shape,
      cutout: { ...room.cutout, corner: v.corner || room.cutout.corner },
    });
    this._fire();
    this._render();
  }

  _speakerSchema() {
    return [{ type: "grid", name: "", schema: [
      { name: "entity", selector: { entity: { domain: "media_player" } } },
      { name: "name", selector: { text: {} } },
    ] }];
  }

  _onSpeaker(i, v) {
    const s = this._config.speakers[i];
    if (v.entity && v.entity !== s.entity && (!s.id || s.id === slugify((s.entity || "").split(".")[1] || ""))) {
      // Follow the entity with an automatic id unless the user chose one.
      s.id = slugify(v.entity.split(".")[1]);
    }
    s.entity = v.entity || "";
    if (v.name) s.name = v.name;
    else delete s.name;
    this._fire();
    this._render();
  }

  _addSpeaker() {
    const { W, H } = this._room();
    this._config.speakers = [...(this._config.speakers || []), { entity: "", x: round2(W / 2), y: round2(H / 2) }];
    this._fire();
    this._render();
  }

  _removeSpeaker(i) {
    this._config.speakers.splice(i, 1);
    this._fire();
    this._render();
  }

  _positionsSchema() {
    return [
      { name: "pos_entity", selector: { entity: { domain: "input_select" } } },
      { name: "storage", selector: { entity: { domain: "input_text" } } },
      { name: "weight_entity", selector: { text: {} } },
    ];
  }

  _positionsData() {
    const p = this._config.positions || {};
    return { pos_entity: p.entity || "", storage: p.storage || "", weight_entity: p.weight_entity || "" };
  }

  _onPositions(v) {
    if (!v.pos_entity) {
      // Remember the places in case the same selection is picked again.
      if (this._config.positions) this._lastPositions = this._config.positions;
      delete this._config.positions;
    } else {
      const old = this._config.positions
        || (this._lastPositions?.entity === v.pos_entity ? this._lastPositions : {});
      const p = { ...old, entity: v.pos_entity, items: old.items || [] };
      if (v.storage) p.storage = v.storage;
      else delete p.storage;
      if (v.weight_entity) p.weight_entity = v.weight_entity;
      else delete p.weight_entity;
      this._config.positions = p;
      if (p.items.length === 0 || old.entity !== p.entity) this._syncItems(false);
    }
    this._fire();
    this._render();
  }

  /** Adds a place for every option of the input_select and drops the rest. */
  _syncItems(fire = true) {
    const p = this._config.positions;
    const options = this._hass?.states[p.entity]?.attributes.options || [];
    const { W, H } = this._room();
    p.items = options.map((option, k) => {
      const existing = (p.items || []).find((i) => i.option === option);
      if (existing) return existing;
      return { option, id: slugify(option), x: round2(snap((W * (k + 1)) / (options.length + 1))), y: round2(snap(H / 2)) };
    });
    if (fire) {
      this._fire();
      this._render();
    }
  }

  _onItem(k, v) {
    const item = this._config.positions.items[k];
    if (v.name) item.name = v.name;
    else delete item.name;
    this._fire();
    this._render();
  }

  /* ---------------- DOM ---------------- */

  _render() {
    if (!this._config || !this._hass) return;
    const room = this._room();
    const speakers = this._config.speakers || [];
    const items = this._config.positions?.items || [];
    const structure = [speakers.length, items.length, !!this._config.positions, room.shape === "custom"].join("|");

    if (structure !== this._structure) {
      this._structure = structure;
      this._build(speakers, items);
    }

    const setForm = (form, schema, data, label) => {
      form.computeLabel = label || ((s) => this._t(s.name));
      form.hass = this._hass;
      form.schema = schema;
      form.data = data;
    };
    setForm(this._general, this._generalSchema(room), this._generalData(room));
    this._speakerForms.forEach((f, i) =>
      setForm(f, this._speakerSchema(), { entity: speakers[i].entity || "", name: speakers[i].name || "" }));
    setForm(this._posForm, this._positionsSchema(), this._positionsData());
    this._itemForms.forEach((f, k) =>
      setForm(f, [{ name: "name", selector: { text: {} } }], { name: items[k].name || "" },
        () => `${this._t("name")} – ${items[k].option}`));

    this._minTwo.hidden = speakers.length >= 2;
    this._customNote.hidden = room.shape !== "custom";
    this._syncBtn.hidden = !this._config.positions;
    this._drawPlan();
  }

  _build(speakers, items) {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        h3 { font-size: 1.05em; font-weight: 500; margin: 24px 0 4px; }
        .hint, .note { color: var(--secondary-text-color); font-size: .9em; margin: 0 0 8px; }
        .warn { color: var(--error-color, #db4437); font-size: .9em; }
        .row { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
        .row > ha-form { flex: 1; }
        button { font: inherit; color: var(--primary-color); background: none; border: 1px solid var(--divider-color);
                 border-radius: 8px; padding: 6px 12px; cursor: pointer; }
        button.remove { margin-top: 8px; color: var(--error-color, #db4437); }
        svg { width: 100%; height: auto; display: block; touch-action: none; user-select: none;
              background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: 8px; }
        .room { fill: var(--secondary-background-color, rgba(127,127,127,.08)); stroke: var(--divider-color, #999); }
        .speaker { fill: var(--primary-color, #03a9f4); cursor: move; }
        .place { fill: var(--card-background-color, #fff); stroke: var(--success-color, #43a047); cursor: move; }
        .handle { fill: var(--secondary-text-color, #666); cursor: move; }
        .label { fill: var(--primary-text-color, #222); pointer-events: none; }
        .sub { fill: var(--secondary-text-color, #666); pointer-events: none; }
      </style>
      <ha-form class="general"></ha-form>
      <p class="note custom-note"></p>
      <h3>${this._t("plan")}</h3>
      <p class="hint">${this._t("plan_hint")}</p>
      <div class="plan"></div>
      <h3>${this._t("speakers")}</h3>
      <div class="speakers"></div>
      <p class="warn min-two">${this._t("min_two")}</p>
      <button class="add">${this._t("add_speaker")}</button>
      <h3>${this._t("positions")}</h3>
      <p class="hint">${this._t("positions_hint")}</p>
      <ha-form class="positions"></ha-form>
      <div class="items"></div>
      <button class="sync">${this._t("sync")}</button>`;

    const root = this.shadowRoot;
    this._general = root.querySelector(".general");
    this._general.addEventListener("value-changed", (e) => this._onGeneral(e.detail.value));
    this._customNote = root.querySelector(".custom-note");
    this._customNote.textContent = this._t("custom_note");
    this._minTwo = root.querySelector(".min-two");

    const list = root.querySelector(".speakers");
    this._speakerForms = speakers.map((s, i) => {
      const row = document.createElement("div");
      row.className = "row";
      const form = document.createElement("ha-form");
      form.addEventListener("value-changed", (e) => this._onSpeaker(i, e.detail.value));
      const remove = document.createElement("button");
      remove.className = "remove";
      remove.textContent = this._t("remove");
      remove.addEventListener("click", () => this._removeSpeaker(i));
      row.append(form, remove);
      list.appendChild(row);
      return form;
    });
    root.querySelector(".add").addEventListener("click", () => this._addSpeaker());

    this._posForm = root.querySelector(".positions");
    this._posForm.addEventListener("value-changed", (e) => this._onPositions(e.detail.value));
    const itemList = root.querySelector(".items");
    this._itemForms = items.map((item, k) => {
      const form = document.createElement("ha-form");
      form.addEventListener("value-changed", (e) => this._onItem(k, e.detail.value));
      itemList.appendChild(form);
      return form;
    });
    this._syncBtn = root.querySelector(".sync");
    this._syncBtn.addEventListener("click", () => this._syncItems());

    this._svg = svgEl("svg");
    root.querySelector(".plan").appendChild(this._svg);
    this._svg.addEventListener("pointerdown", (e) => this._dragStart(e));
    this._svg.addEventListener("pointermove", (e) => this._dragMove(e));
    this._svg.addEventListener("pointerup", (e) => this._dragEnd(e));
    this._svg.addEventListener("pointercancel", (e) => this._dragEnd(e));
  }

  _drawPlan() {
    const room = this._room();
    const { W, H } = room;
    const size = Math.max(W, H);
    const u = size / 100;
    const pad = size * 0.09;
    const fs = u * 3.8;
    const svg = this._svg;
    svg.setAttribute("viewBox", `${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}`);
    svg.textContent = "";

    const cfgRoom = room.shape === "custom"
      ? this._config.room
      : { width: W, height: H, shape: room.shape, cutout: room.cutout };
    if (room.image) {
      svg.appendChild(svgEl("image", { href: room.image, x: 0, y: 0, width: W, height: H, preserveAspectRatio: "none" }));
    }
    svg.appendChild(svgEl("polygon", {
      class: "room",
      points: roomOutline(cfgRoom).map((p) => p.join(",")).join(" "),
      "stroke-width": u * 0.4,
      "fill-opacity": room.image ? 0.2 : 1,
    }));

    (this._config.positions?.items || []).forEach((item, k) => {
      svg.appendChild(svgEl("circle", { class: "place", cx: item.x, cy: item.y, r: u * 2.6, "stroke-width": u * 0.6, "data-kind": "item", "data-index": k }));
      const label = svgEl("text", { class: "sub", x: item.x, y: item.y + u * 6, "text-anchor": "middle", "font-size": fs * 0.9 });
      label.textContent = item.name || item.option;
      svg.appendChild(label);
    });

    (this._config.speakers || []).forEach((s, i) => {
      svg.appendChild(svgEl("circle", { class: "speaker", cx: s.x, cy: s.y, r: u * 2.6, "data-kind": "speaker", "data-index": i }));
      const label = svgEl("text", { class: "label", x: s.x, y: s.y - u * 4, "text-anchor": "middle", "font-size": fs });
      label.textContent = s.name || this._hass.states[s.entity]?.attributes.friendly_name || s.entity || "?";
      svg.appendChild(label);
    });

    if (room.shape === "l") {
      const p = this._cornerPoint(room);
      const r = u * 2;
      svg.appendChild(svgEl("rect", { class: "handle", x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r, "data-kind": "corner" }));
    }
  }

  _cornerPoint({ W, H, cutout }) {
    const { corner, width: cw, height: ch } = cutout;
    return {
      "bottom-left": { x: cw, y: H - ch },
      "bottom-right": { x: W - cw, y: H - ch },
      "top-left": { x: cw, y: ch },
      "top-right": { x: W - cw, y: ch },
    }[corner];
  }

  _toRoom(e) {
    const pt = this._svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(this._svg.getScreenCTM().inverse());
    const { W, H } = this._room();
    return { x: round2(snap(Math.min(W, Math.max(0, p.x)))), y: round2(snap(Math.min(H, Math.max(0, p.y)))) };
  }

  _dragStart(e) {
    const kind = e.target.dataset?.kind;
    if (!kind) return;
    this._drag = { kind, index: Number(e.target.dataset.index) };
    this._svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  _dragMove(e) {
    if (!this._drag) return;
    const p = this._toRoom(e);
    const { kind, index } = this._drag;
    if (kind === "speaker") Object.assign(this._config.speakers[index], p);
    else if (kind === "item") Object.assign(this._config.positions.items[index], p);
    else if (kind === "corner") {
      const room = this._room();
      const { corner } = room.cutout;
      const cw = corner.endsWith("left") ? p.x : room.W - p.x;
      const ch = corner.startsWith("bottom") ? room.H - p.y : p.y;
      this._writeRoom({ ...room, cutout: { corner, width: cw, height: ch } });
    }
    this._moved = true;
    this._drawPlan();
  }

  _dragEnd(e) {
    if (!this._drag) return;
    this._drag = null;
    try {
      this._svg.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* already released */
    }
    if (this._moved) {
      this._moved = false;
      this._fire();
    }
  }
}

if (typeof customElements !== "undefined" && !customElements.get("sweet-spot-card")) {
  customElements.define("sweet-spot-card", SweetSpotCard);
  customElements.define("sweet-spot-card-editor", SweetSpotCardEditor);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "sweet-spot-card",
    name: "Sweet Spot Card",
    description: "Balance several speakers in one room around a draggable listening position.",
    documentationURL: "https://github.com/T-o-n-i/sweet-spot-card",
  });
  console.info(`%c SWEET-SPOT-CARD %c ${CARD_VERSION} `, "background:#ff9800;color:#000", "");
}
