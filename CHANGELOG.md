# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Per-path **claim-ahead stepper** in the switchboard sidebar: a `− N +`
  control sets how many blocks a path claims ahead of itself
  (`PATCH /path/{id}/lookahead`). The `+` button grows the window and claims it
  immediately (skipping the 5s pacing timer); the `−` only lowers the
  threshold at which *new* blocks are claimed and never releases held claims.
  `lookAhead` is persisted per path (default 5, min 0 = no claims, no upper cap
  beyond the route length) and now actually bounds the claim engine's window
  (previously vestigial). The initial claim of a new/restored path is **one
  section ahead only**, with the 5s cooldown filling the rest of the window.
- Per-path **colour hue slider** in the switchboard sidebar: rotates the hue of
  the path's colour (`PATCH /path/{id}/color`, stored in the `color` field so
  it survives reloads/extensions); block colouring and sidebar chips use it.
- **Two-stage delete button**: the first `✕` press on a path that holds claims
  only removes its clearance (`POST /path/{id}/unclaim` - a fallback to pull
  the claims without deleting the route; `lookAhead` drops to 0 so the path
  does not reclaim itself and stays re-clearable via `+`); a second press (no
  claims left) deletes the path for good.
- Removed the **print-to-console** button and the **"Claim next" / advance**
  button/endpoint (`/path/{id}/advance`, `ForceClaimNextBlock`), now covered by
  the `+` stepper.

### Fixed

- Initial claiming is no longer separate from normal advancing: a single
  `StagingData.Advance` function now handles the seed, train movement, and the
  conflict-aware lookahead extension, and runs synchronously as a startup check
  from path creation/restore (`AddPath` / `InitializeFromPaths`) as well as from
  route extension, the periodic check, and the lookahead grow (`+` button). The
  auto-extension pacing timer is 5s instead of 20s and only paces the ordinary
  automatic extension - train advances and conflict probes run immediately, and
  conflict probes no longer keep the timer alive (which previously locked a
  path out for a full interval right after opposing traffic cleared).
- Pathing conflict prevention: the first automatic extension of a path facing
  opposing traffic no longer claims into the section opposing traffic still
  holds. `StagingData.TryClaimFrom`'s Case 2 branch is merged into the Case 1
  `CalcRange` walk, so an extension claims only up to the point where no more
  opposing paths are detected (backing off on the retry otherwise). The
  automatic advance re-evaluates opposing traffic even when the lookahead
  ceiling or retry timer would otherwise skip it, and the lookahead grow
  (`+`) inherits the same gating.
- New-path seeding now routes through the conflict-aware `TryClaimSeed`
  instead of an unguarded `ActivateBlock`: it refuses to steal the start block
  when another active path already holds it.
- Reload / re-activation no longer drops a path's claimed blocks.
  `StagingData.InitializeFromPaths` preserves the live staging state, keeping
  already-tracked paths' claims exactly as they were and seeding only genuinely
  new paths.
- Switchboard signal In/Out mapping: every switch with more than one signal
  previously displayed a single signal at its base (classified as `Out`).
  Direction is now read from the controller's facing
  `TrackSignalController.Direction` (junction signals = `Out`, branch signals =
  `In`) instead of the upstream junction-controller comparison, which only ever
  matched the Out controller. In (branch) signals now attach to the correct
  left/right port: `RequiredBranch` is derived from the controller's
  `Junction.outBranches` index (matching the switchboard graph's port
  assignment) rather than the group's `BranchSignals` list index, which could
  shift when small tracks are skipped.

## [1.7.0] - 2026-08-06

### Added

- Switchboard block-level pathing/staging: server-side route claims, look-ahead
  windows, and per-block signal/switch control.
- Direct block occupancy via the Signals API `IsTrackOccupied`.
- Conflict-aware path claiming queue: `StagingData` now gates claims through
  `TryClaimFrom`/`CalcRange`, refusing to claim past opposing or upcoming
  traffic on a shared span (`IsOpposing`) and backing off with a 20s retry
  timer; new paths seed with only their start block, auto-claiming stops
  five blocks ahead. Auto-extension is paced by the 20s timer on every attempt,
  and a train advancing onto the next block triggers an immediate claim
  extension (up to six blocks ahead). Manual "advance next" claims a single
  block when clear, or the cleared range when passing opposing traffic.
- Locked switchboard paths are each given a stable random **blue-dominant**
  colour; upcoming blocks show the path colour (blended where paths overlap),
  claimed blocks show the path colour boosted green, and occupied blocks stay
  red. Sidebar path chips use the same colouring.
- Draft route **waypoints**: right-clicking a segment/switch while drawing
  forces the draft route through that block (`computePathWithWaypoints`), and
  right-click empty map cancels. The path search between hops is a per-source
  memoized Dijkstra tree that is invalidated on occupancy changes.
- **Extend mode** (⊕ per locked path): anchors at the path's last block and
  reuses the same hover/A*/waypoint drafting to append unclaimed sections via
  `PATCH /path/{id}`, staying in extend mode for chained sections (self-overlap
  rejected). Intended to become the primary way to grow routes, superseding the
  waypoint-driven new-path flow.
- **Path notes**: per-path free-text field (locomotive/destination/note) saved
  via `PATCH /path/{id}/note`, preserved across path updates, and shown in the
  console print output.

### Fixed

- GF switch mapping: `BuildTrackGraph`/`TraceToJunctions` now match track
  endpoints by position proximity instead of exact (rounded) coordinate
  strings, resolving the junction that broke a station's switch mapping on both
  the single-track and DoubleTrack layouts. The J26 `GRAPH_OVERRIDES` entry was
  removed.
- Removed the redundant `GRAPH_OVERRIDES` for J26.
- Switchboard layouts re-exported as `ST_2.1-hotfix.json` (single-track) and
  `DT_2.1-hotfix.json` (DoubleTrack); obsolete `RD_1.0.4/1.0.7/1.0.8` and
  `DoubbleTrack1.0_1.4.3` files removed.
- Residual DoubleTrack crossover leg-swaps (e.g. MF J-632/J-546, J-636/J-638)
  fixed: junction `degree` is now capped at 3 in `/graph` so dense crossovers
  no longer report a spurious fourth continuation, and `repairMapping()` runs
  after the parallel walk to correct any remaining swapped pairs. The switch
  mapping is now a clean 641/641 bijection with zero consistency violations.
- Switchboard block colours unified into `TrackRenderer.resolveBlockColor`
  as the single source of truth (occupied always reads as occupied; see the
  per-path colour entry above). Removed the per-file
  `PathingController.getOverridesForSegment`/`getSwitchRimColor` override
  path; switch segments now repaint correctly on path sync, and sidebar path
  chips use the same colour source.

## [1.6.1] - 2026-04-04

### Fixed

- Fixed misalignment of junction icons introduced in 1.6.0

## [1.6.0] - 2026-04-04

### Added

- Junctions (switches/points) now display their in game names as shown when pointing at them with the comms radio
- Adds a search box ("go to box") in the top right that searches for Junctions, Locomotives, and Signals as you type, clicking on an option will "zoom" the view to the selected option.
- Adds beta Signals support. Default feature flag is "off"

## [1.5.1] - 2026-03-30

### Added

- [@radostin04] Add configurable default permissions for new users

## [1.5.0] - 2026-03-28

### Added

- [@radostin04] Add two new per-player configurable settings - Player Blips and Locomotive Visibility.
    - When Player Blips is disabled, users will not see players on the map, regardless of their frontend settings. If Player Blips is enabled, they can still choose to disable them on the frontend.
    - When Locomotive Visibility is disabled, locomotives will not show up on the map. Cars will still show up - this means that players could still keep track of a train's location by looking at the ways cars are moving, but they can't use player blips or highlighted locomotives to know where trains are.

## [1.4.1] - 2026-03-18

### Fixed

- Fixed an issue where a player leaving the game (or any other error in the Javascript) would stop the update loop from continuing.

## [1.4.0] - 2026-03-11

### Added

- Player icons now scale, there is a checkbox in the settings side-bar (cog) to toggle this on and off. Toggling this on will make the player icons visible from any level of zoom.
- Player names, there is a checkbox in the settings side-bar (cog) to toggle this on and off. Toggling this on will show the player name below and slightly to the right of the icon, making it easier to identify which player is which when multiple players are visible on the map at once. The player names are "pushed" from the Multiplayer Mod, so if you have renamed yourself in the multiplayer mod, that name will be used here as well.

## [1.3.0] - 2026-03-09

### Added

- Individual Locomotive scaling setting, allowing you to adjust the size of locomotives on the map independently from each other. Designed specifically to allow for dispatchers to track multiple trains at once over the whole map.

## [1.2.1] - 2025-04-28

For release 1.2.1 and before, see the original mod release history by [Zeibach](https://www.nexusmods.com/profile/Zeibach) on Nexus Mods: https://www.nexusmods.com/derailvalley/mods/328?tab=files or on GitHub: https://github.com/mspielberg/dv-remote-dispatch/releases
