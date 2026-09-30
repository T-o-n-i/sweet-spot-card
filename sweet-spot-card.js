/*
 * Sweet Spot Card – a Home Assistant Lovelace card that balances several
 * speakers in one room around a draggable listening position.
 *
 * https://github.com/T-o-n-i/sweet-spot-card
 * MIT License
 */

const CARD_VERSION = "0.1.0";

const DEFAULTS = {
  mode: "listener", // "listener": nearer speakers get quieter; "fader": nearer speakers get louder
  strength: 0.5, // 0 = no effect, 1 = full inverse-distance compensation
  min_distance: 0.5, // in room units; avoids extreme values right next to a speaker
  weight_min: -1,
  weight_max: 1,
};

const STRINGS = {
  en: {
    reset: "Back to marker",
    unavailable: "unavailable",
    drag_hint: "Drag the dot or tap a position",
    drag_hint_free: "Drag the dot",
    missing: "Entity not found",
  },
  de: {
    reset: "Zurück auf Markierung",
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
  const known = currentVolumes.filter((v) => typeof v === "number");
  if (known.length === 0) return null;
  const mean = known.reduce((a, v) => a + v, 0) / known.length;
  const factors = weights.map((w) => Math.pow(2, w));
  const fMean = factors.reduce((a, f) => a + f, 0) / factors.length;
  return factors.map((f) =>
    Math.min(1, Math.max(0, Math.round((mean * f) / fMean * 100) / 100))
  );
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
  static getStubConfig() {
    return {
      room: { width: 6, height: 4 },
      speakers: [
        { id: "left", entity: "media_player.left", name: "Left", x: 0.5, y: 0.5 },
        { id: "right", entity: "media_player.right", name: "Right", x: 5.5, y: 0.5 },
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

  _dotFromState() {
    const item = this._activeItem();
    if (item) {
      const saved = this._stored()[item.option];
      if (Array.isArray(saved) && saved.length === 2) return { x: saved[0], y: saved[1] };
      return { x: item.x, y: item.y };
    }
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
        .speaker { fill: var(--primary-color, #03a9f4); }
        .speaker.off { fill: var(--disabled-text-color, #999); }
        .ray { stroke: var(--primary-color, #03a9f4); stroke-opacity: .25; }
        .marker { fill: var(--card-background-color, #fff); stroke: var(--success-color, #43a047); cursor: pointer; }
        .marker.active { fill: var(--success-color, #43a047); fill-opacity: .35; }
        .dot { fill: var(--accent-color, #ff9800); stroke: var(--card-background-color, #fff); cursor: grab; }
        .label { fill: var(--primary-text-color, #222); }
        .sub { fill: var(--secondary-text-color, #666); }
        .footer { display: flex; justify-content: space-between; align-items: center; margin-top: 8px;
                  color: var(--secondary-text-color); font-size: .9em; gap: 8px; }
        button { font: inherit; color: var(--primary-color); background: none; border: 1px solid var(--divider-color);
                 border-radius: 8px; padding: 4px 10px; cursor: pointer; }
        .warn { color: var(--error-color, #db4437); font-size: .9em; }
      </style>
      <ha-card>
        ${c.title ? `<div class="title"></div>` : ""}
        <div class="warn"></div>
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
      const outline = c.room.outline || [[0, 0], [W, 0], [W, H], [0, H]];
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
        e.stopPropagation();
        this._selectPosition(item);
      });
      svg.appendChild(g);
      this._markers.push({ item, circle });
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
    this._hint = card.querySelector(".hint");
    this._warn = card.querySelector(".warn");
    this._built = true;
  }

  _update() {
    const c = this._config;
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

if (typeof customElements !== "undefined" && !customElements.get("sweet-spot-card")) {
  customElements.define("sweet-spot-card", SweetSpotCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "sweet-spot-card",
    name: "Sweet Spot Card",
    description: "Balance several speakers in one room around a draggable listening position.",
    documentationURL: "https://github.com/T-o-n-i/sweet-spot-card",
  });
  console.info(`%c SWEET-SPOT-CARD %c ${CARD_VERSION} `, "background:#ff9800;color:#000", "");
}
