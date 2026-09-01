# DVSignals Integration (vendored from upstream)

> **Status in this fork:** full parity as of upstream commit `b230c83`
> ("signals: key signals by unique Signal.Id, keep preview labels compact").
> This fork additionally carries on top of it: switchboard signal dots with
> In-branch attribution (`RequiredBranch`), per-type stop aspects in
> pathing mode, main-thread guards in both bridges, Id-keyed
> `signalpacks/*.json` tables (no name-keyed migration needed — unreleased),
> and the HUD sprite picture style (`2b15ef2`→`5d71ead` in upstream: in-game
> signal pictures served over `/signal/sprites`, selectable via the Settings
> "Signal style" dropdown). The commit list at the end records the upstream
> source commits.
>
> **Divergence (deliberate):** direction. Upstream's `GetDirection` compares
> `signal.Controller == junctionController`, which only ever matches the Out
> controller - branch/In signals fall through to a blanket `Out` (fine for
> upstream's switchboard, which doesn't attach In signals). This fork's
> switchboard needs In signals on the left/right ports, so
> `RemoteDispatch.Signals` reads the controller-facing
> `TrackSignalController.Direction` (junction signals = Out, branch signals =
> In) and derives `RequiredBranch` from the `Junction.outBranches` index.
> See `docs/CURRENT-STATE.md` §4.2.

# DVSignals Integration

**Author:** Red Rass

This document summarizes a pull request that integrates the third-party
DVSignals mod (Signals.Game) into Remote Dispatch, letting dispatchers see and
remotely control every signal on the map with lamp-accurate visual faces.

## Overview

Remote Dispatch previously had no signal support beyond a couple of legacy icon
assets. This PR adds a full signals feature:

- Live display of every DVSignals signal on the map, drawn as an SVG signal face
  built from the signal's actual lamp geometry.
- Remote control: switching a signal to Manual mode and setting its aspect.
- A persistent **signal pack table** (`signalpacks/*.json`) that caches each
  signal's lamp layout and the aspects it has displayed, so the frontend can
  render accurate faces without re-reading Unity objects.
- Support for both the new **DVSignals** mod (Signals.Game, via
  `RemoteDispatch.Signals`) and the legacy **Signals.API** mod (via
  `RemoteDispatch.SignalsMP`).

## Prerequisites

- The DVSignals mod installed in Derail Valley. The PR builds against the new
  `Signals.Game` fork; the legacy `Signals.API` mod is supported through the
  `RemoteDispatch.SignalsMP` module.
- The **Enable signals** feature flag must be turned on in the RemoteDispatch
  mod settings (`Settings.cs`). It defaults to **off**.

## Architecture

```
RemoteDispatch.dll
  └── SignalsShim.cs            loads the signals module at runtime via reflection
        ├── RemoteDispatch.Signals.dll    new DVSignals (Signals.Game) fork
        │     └── SignalsBridge.cs        wraps Signals.Game, captures lamps/aspects
        └── RemoteDispatch.SignalsMP.dll  legacy Signals.API fork
              └── SignalsBridge.cs        wraps Signals.API via reflection
```

A visual diagram lives in `docs/signals_architecture.drawio`.

- `SignalsShim` (`RemoteDispatch/Shims/SignalsShim.cs`) is the single entry
  point the HTTP server and update loop use. It resolves whichever signals
  module is installed and forwards calls to it.
- `SignalsBridge` in each module reads signal state (id, type, mode, current
  aspect, position, direction) and builds capture snapshots of lamp geometry and
  lit/blinking lamps for the current aspect.

## Signal pack table

The pack table (`RemoteDispatch/Engine/SignalPackTable.cs`) is a JSON document
keyed by pack (`DVSignalpack-*.json`) persisted under the mod folder. Each entry
holds:

- `Lamps`: the physical lamps on the signal face (name, colour, local position).
- `Aspects`: a map of aspect id to the lamps it lights/blinks and whether it
  disallows passing.

The table is built **incrementally**: every time a signal's aspect changes in
game, `RecordPackAspect` (`SignalsShim.cs`) captures that signal and upserts its
lamps plus the observed aspect into the current pack. When the Signals mod
switches packs, the table is flushed and reloaded for the new key.

Because the table is populated from observed aspects only, it can be incomplete
for a signal that has not displayed every aspect. The frontend therefore prefers
the complete aspect list served by the API (see below) and uses the pack table
as a fallback.

## Frontend rendering

All rendering lives in `RemoteDispatch/frontend/main.js`:

- Each signal marker is a Leaflet `divIcon` containing an inline SVG signal face.
- The SVG is built from the pack entry's `Lamps`, laid out vertically in the
  order they appear. Lit and blinking lamps are drawn using the aspect's
  `Lit`/`Blinking` arrays.
- Signal faces are rendered at **2×** their SVG viewBox size, and **distant**
  signals at **0.75×** the normal scale.
- The box height is driven by the **lamp count**: a 2-lamp signal renders shorter
  than 5- or 6-lamp main signals, so the rectangle wraps the actual face.
- **Pictures style (fork addition, ported from upstream `2b15ef2`→`5d71ead`):**
  the Settings **Signal style** dropdown switches between the lamp-SVG faces and
  the in-game HUD sprite pictures captured by the bridge. The frontend resolves
  each signal's picture through a fallback chain - live sprite from the
  `/signal/sprites` manifest (sized to its natural `w`/`h`), then the type's
  off-state sprite, then a bundled `frontend/signals/*.webp` static picture,
  then the lamp SVG. The manifest is re-fetched on its own 15s schedule,
  independent of the update loop.

## Aspect control

- Each signal's payload now includes the complete list of aspects it supports
  (`signal.AllAspects`), served through `/signals`.
- The popup's aspect dropdown uses this authoritative list, so identical-layout
  signals always offer the same options, regardless of which aspects have been
  observed and cached in the pack table. The pack table remains the fallback if
  the list is unavailable.
- Control flows through `/signal/control` (`HttpServer.cs`), which calls
  `SetSignalMode` / `SetSignalAspect` on the bridge. Setting an aspect puts the
  signal in FullManual mode and applies the aspect override.

## HTTP endpoints & updates

| Endpoint       | Purpose                                              |
| -------------- | ---------------------------------------------------- |
| `/signals`     | All signals (id, type, mode, aspect, position, aspects) |
| `/signalpack`  | Current pack table JSON (lamp/aspect layout)         |
| `/signal/control` | POST to set a signal's mode or aspect             |
| `/signal/sprites` | HUD sprite manifest (`{Aspects:{id:{u,w,h}}, Off:{type:{u,w,h}}}`) |
| `/signal/sprite/{aspectId}` | PNG of an aspect's in-game HUD sprite    |
| `/signal/sprite/off/{type}` | PNG of a signal type's off-state sprite  |
| `/updates`     | SSE stream; emits `signals` and `signalpack` tags    |

The `signals` and `signalpack` update tags push aspect changes and pack-table
growth to connected clients in real time.

## Limitations

- The pack table only records aspects that have actually been observed in game;
  entries are filled in over time. The frontend's complete-aspect list mitigates
  this for the control dropdown.
- The full-aspect-list fix is applied on the new DVSignals (`Signals.Game`) fork;
  the legacy `RemoteDispatch.SignalsMP` module continues to use the pack-table
  fallback.
- Remote control is gated by the dispatcher permissions system
  (`HasSignalControlPermission`), not by signal type.

## Commit list

The following commits make up this pull request (all authored by Red Rass):

1. `937527a` — signals: support new DVSignals (Signals.Game) alongside old API
   Adds the `RemoteDispatch.Signals` and `RemoteDispatch.SignalsMP` modules,
   the runtime reflection shim, and dual-module support.
2. `6f16b45` — signals: persistent pack table backend (signalpacks/*.json)
   Implements `SignalPackTable.cs` and the incremental aspect capture pipeline.
3. `b849bc7` — signals: render lamp-based signal faces from pack table in frontend
   Replaces legacy icon assets with SVG signal faces built from pack lamps.
4. `6e3093f` — signals: load pack table at startup, fix /updates payload, match frontend casing
   Loads the pack table on startup and fixes the SSE payload shape.
5. `0c522fb` — signals: scale up signal icons, size boxes by lamp count, expose full aspect list
   Scales signal faces 2× (distant 0.75×), sizes boxes by lamp count, and serves
   the complete per-signal aspect list.