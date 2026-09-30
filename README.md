# Sweet Spot Card

A Home Assistant dashboard card for rooms with several speakers. You drag a dot to where you sit, and the card balances the speakers around it: speakers close to you get quieter, the ones further away louder. The average volume stays the same, only the ratio between the speakers changes.

Works with any `media_player` that supports `volume_set` (Sonos, HEOS, Cast, …).

## Installation

### HACS

1. HACS → three-dot menu → *Custom repositories*
2. Repository `https://github.com/T-o-n-i/sweet-spot-card`, type *Dashboard*
3. Install *Sweet Spot Card* and reload the browser

### Manual

Copy `sweet-spot-card.js` to `/config/www/` and add it as a dashboard resource: `/local/sweet-spot-card.js`, type *JavaScript module*.

## Minimal configuration

Without any helpers the card sets the speaker volumes directly while you drag.

```yaml
type: custom:sweet-spot-card
title: Living room
room:
  width: 6      # any unit, metres are handy
  height: 4
speakers:
  - entity: media_player.left
    name: Left
    x: 0.3
    y: 0.3
  - entity: media_player.right
    name: Right
    x: 5.7
    y: 0.3
```

Coordinates start in the top-left corner of the room.

## Colours

The card uses your theme: speakers in the primary colour, places in the success colour and the dot in the accent colour. If two of them look alike in your theme (for example primary and accent are both orange), the card picks the next theme colour instead: info, purple, blue, teal or red.

## Options

| Option | Default | Description |
|---|---|---|
| `title` | – | Card title |
| `room.width`, `room.height` | required | Size of the room |
| `room.outline` | rectangle | Room shape as a list of `[x, y]` points, e.g. for an L-shaped room |
| `room.image` | – | Background image instead of the outline, e.g. `/local/floorplan.png` |
| `speakers` | required | At least two, each with `entity`, `x`, `y`, optional `name` and `id` |
| `mode` | `listener` | `listener`: nearer speakers get quieter. `fader`: nearer speakers get louder, like the fader in a car |
| `strength` | `0.5` | 0 = no effect, 1 = full compensation for distance. Rooms reflect sound, so full compensation usually overdoes it |
| `min_distance` | `0.5` | Distances below this count as this value, so standing right next to a speaker does not mute it |
| `master` | `true` | Show a slider for the overall volume. It raises or lowers all speakers together and keeps the balance |
| `positions` | – | Saved listening positions, see below |

## Saved positions

If you have fixed places (sofa, dining table, …) and want to switch between them from automations or voice assistants, add an `input_select` with one option per place. The card shows each place as a marker; tapping it selects the option.

```yaml
positions:
  entity: input_select.listening_position
  storage: input_text.listening_positions        # optional
  weight_entity: input_number.balance_{position}_{speaker}   # optional
  items:
    - option: Sofa
      id: sofa
      x: 2.0
      y: 3.6
    - option: Dining table
      id: dining
      x: 6.3
      y: 2.9
```

- **`storage`**: an `input_text` (max. length 255) where the card remembers where you dragged the dot for each place. The marker of the active place moves with the dot, and *Reset position* puts it back to the `x`/`y` from the configuration. Without `storage`, every place starts at its configured position again.
- **`weight_entity`**: a pattern for `input_number` helpers (range −1 to 1, step 0.1) that receive the balance instead of the volumes. `{position}` is replaced by the item `id`, `{speaker}` by the speaker `id`. A value of −1 means half the average volume, +1 double. Use this if an automation should apply the balance, for example when the place is changed by voice. The card itself then does not touch the volumes.

Without `weight_entity` the card sets the volumes directly when you release the dot.

## Overall volume

The slider below the room shows the average volume of all speakers. Moving it sets a new average and keeps the balance. With `weight_entity` and an active place, the balance is taken from the helpers, so repeated changes at low volumes do not drift because of rounding.

## How the balance is calculated

For each speaker the card takes the distance *d* to the dot and the geometric mean *g* of all distances. The weight is `strength × log2(d / g)`, limited to −1…+1 (negated in `fader` mode). The volume is then `mean × 2^weight / average(2^weights)`, rounded to whole percent.

## Development

`dev/index.html` renders the card against a mocked Home Assistant. Serve the repository root (e.g. `python3 -m http.server`) and open `/dev/index.html`. `node test.mjs` checks the calculation.

## License

MIT
