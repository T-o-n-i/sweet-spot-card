// Minimal stand-in for Home Assistant's <ha-form>, only for dev/index.html.
class FakeHaForm extends HTMLElement {
  set schema(v) { this._schema = v; this._render(); }
  set data(v) { this._data = v; this._render(); }
  set hass(v) { this._hass = v; }
  set computeLabel(f) { this._label = f; }
  _render() {
    if (!this._schema || !this._data) return;
    if (this.contains(document.activeElement)) return; // do not disturb typing
    this.innerHTML = "";
    this.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px;margin:4px 0";
    const fields = this._schema.flatMap((f) => (f.type === "grid" ? f.schema : [f]));
    for (const f of fields) {
      const label = document.createElement("label");
      label.style.cssText = "display:flex;flex-direction:column;font-size:12px;color:#555";
      label.textContent = this._label ? this._label(f) : f.name;
      const sel = f.selector;
      let input;
      if (sel.select) {
        input = document.createElement("select");
        for (const o of sel.select.options) input.add(new Option(o.label, o.value));
      } else if (sel.boolean) {
        input = document.createElement("input");
        input.type = "checkbox";
      } else {
        input = document.createElement("input");
        if (sel.number) Object.assign(input, { type: "number", step: sel.number.step, min: sel.number.min, max: sel.number.max });
        if (sel.entity) input.placeholder = sel.entity.domain + ".…";
      }
      input.dataset.name = f.name;
      const val = this._data[f.name];
      if (sel.boolean) input.checked = !!val;
      else input.value = val ?? "";
      input.addEventListener("change", () => {
        const v = sel.boolean ? input.checked : sel.number ? Number(input.value) : input.value;
        this.dispatchEvent(new CustomEvent("value-changed", { detail: { value: { ...this._data, [f.name]: v } } }));
      });
      label.appendChild(input);
      this.appendChild(label);
    }
  }
}
customElements.define("ha-form", FakeHaForm);
