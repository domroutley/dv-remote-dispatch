# AGENTS.md

## Repository Layout
This is a C# UnityModManager mod for Derail Valley that provides remote dispatch capabilities. The codebase is structured as follows:
- `RemoteDispatch/` - Main mod source code
- `RemoteDispatch.Signals/` - Signals integration module
- `frontend/` - Embedded web assets (HTML, JS, CSS); served at runtime from `RemoteDispatch/frontend/`

> There are **no test projects** in this repo (despite historical references).
> The solution is `RemoteDispatch.sln`.

## Docs
- `docs/CURRENT-STATE.md` - **what the code does right now**: architecture, HTTP surface, occupancy/pathing/signals data flow, frontend switchboard modules, and known WIP/rough edges. Read this first.
- `docs/VISION.md` - (target document) where the project is heading: intended switchboard/pathing experience and feature goals. Read this before planning work.
- `docs/DVSignals_INTEGRATION.md` - vendored DVSignals (Signals mod) integration feature doc, kept in sync with `origin/trunk` signal work; see its status note for the divergence between the two forks' Signal handling (this one keys by Signal.Id per upstream `b230c83`).
- `docs/RELEASE_PROCESS.md` - release workflow steps.

The local branch is ~51 commits ahead of upstream trunk (1.7.0); the added work is the switchboard feature (occupancy, signal control, block-level pathing/staging).

## File Descriptions

### Main Mod Files
- `Main.cs` - Entry point and mod lifecycle management
- `Settings.cs` - Configuration, permissions, and feature flags
- `Data/HttpServer.cs` - HTTP endpoint implementation and request handlers
- `Data/CarData.cs` - Car/locomotive data processing
- `Data/PlayerData.cs` - Player blip data processing
- `Data/RailTracks.cs` - Track/junction graph building and signal mapping
- `Data/OccupancyData.cs` - Switchboard block occupancy (Direct + Hardcore modes)
- `Data/PathingData.cs` / `Data/StagingData.cs` / `Data/PathingActivation.cs` - Path CRUD, route-claim/staging engine, pathing-mode signal control
- `Engine/Updater.cs` - Coroutine data loops + main-thread scheduling
- `Shims/SignalsShim.cs` - Reflection bridge to the Signals module
- `Server/HttpServer.cs` / `Server/Session.cs` - HTTP server and update-tag push

### Signals Module
- `RemoteDispatch.Signals/` - Signals integration for the **new Signals mod** (WhistleWiz/dv-signals, has no `Signals.API`; talks to `Signals.Game` public classes).
- `RemoteDispatch.SignalsMP/` - Signals integration for the **old Signals mod** forks (`1.1.3-mp` / `1.1.4-mp`; links `Signals.API`).
- Both ship `Bootstrap` / `SignalsBridge` / `LoggingReturn` with an identical static surface (`GetAllSignals`, `GetSignalAspect`, `SetSignalAspect`, `SetSignalMode`, `IsTrackOccupied`, `Initialize`, `Teardown`).
- Loaded at runtime via reflection from `Shims/SignalsShim.cs`; no compile-time dependency. `SignalsShim.Initialize()` picks the DLL by the installed Signals mod's version (`-mp` suffix → `RemoteDispatch.SignalsMP.dll`, else → `RemoteDispatch.Signals.dll`).
- Build dependencies for both bridges are pinned in `refs/` (old fork `Signals.API.dll`/`Signals.Common.dll`) and in the installed `DVSignals` mod folder (new fork `Signals.Game.dll`/`Signals.Common.dll`), or via `$(DvInstallDir)` in `Directory.Build.props`.

> There are **no test files or test projects** in the repo.

## Code Flow
The mod initializes through Main.Load(), then patches game systems via Harmony. On enable, it starts HTTP server and data updaters. Data is served through HTTP endpoints (see `docs/CURRENT-STATE.md` §3 for the full table):
- `/car`, `/junction`, `/track`, `/graph`, `/player` - core map data
- `/signals`, `/occupancy`, `/path`, `/staging`, `/pathing`, `/signal/control` - signals + switchboard/pathing
- `/updates` - Real-time data updates (tag-based push)
- `/res` - Embedded frontend assets

## Build/Lint/Test Commands
```bash
# Build the solution (note: .sln, not .slnx)
dotnet build RemoteDispatch.sln

# Run tests 
dotnet test RemoteDispatch.Tests/RemoteDispatch.Tests.csproj

# Single test execution  
dotnet test RemoteDispatch.Tests/RemoteDispatch.Tests.csproj --filter "Test1"

# Package for release
.\package.ps1 -Configuration Release

# Deploy for development  
.\package.ps1 -Configuration Debug -DVPath "C:\path\to\derailvalley"
```

## Code Style Guidelines

### Imports
- Group using statements with standard libraries first, then third-party, then project-specific
- Use full namespaces for clarity (no 'using static' except where explicitly needed)
- Organize imports alphabetically within groups

### Formatting
- Use 4-space indentation (no tabs)
- Follow C# naming conventions (PascalCase for methods and properties, camelCase for parameters)
- Place opening braces on same line as control statements
- Use blank lines to separate logical sections

### Types
- Prefer readonly fields over constants when possible  
- Use var for local variables with explicit types
- Prefer explicit null checking over null-conditional operators where clarity is preferred
- Use nullable reference types (enabled in project)

### Naming Conventions
- Classes: PascalCase
- Methods: PascalCase
- Variables: camelCase  
- Constants: PascalCase
- Private fields: _camelCase

### Error Handling
- Use try/catch blocks around potentially failing operations
- Log errors with descriptive messages including stack traces when appropriate
- Prefer specific exception handling over generic catch-all blocks
- Handle null values gracefully with explicit checks

### Documentation
- Document public methods with XML comments
- Use TODO comments for incomplete features
- Keep inline comments brief and focused

### Syntax Safety Checklist
- **NEVER** use replaceAll on multi-line spans without precise boundary matching
- Always verify there are no duplicate code blocks after editing
- When replacing text, include enough surrounding context to make it unique
- After any edit, read the affected file to confirm syntax integrity
