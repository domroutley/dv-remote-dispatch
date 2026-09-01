using System;
using System.Collections.Generic;
using System.Linq;
using Signals.Game;
using Signals.Game.Aspects;
using Signals.Game.Controllers;
using Signals.Game.Railway;
using UnityEngine;

using SgSignal = Signals.Game.Signal;

namespace DvMod.RemoteDispatch.Signals
{
    /// <summary>
    /// Bridge to the new Signals mod (WhistleWiz/dv-signals, GUID "DVSignals", no Signals.API).
    /// Talks to Signals.Game public classes directly: SignalManager, BasicSignalController,
    /// Signal, JunctionSignalController, TrackBlock, TrackReserver.
    /// Produces the same Dictionary&lt;string signalId, object&gt; projection that
    /// RemoteDispatch.Shims.SignalsShim expects (see SignalsShimHelpers.MinimalSignalDataProjection).
    /// </summary>
    internal class SignalsBridge
    {
        /// <summary>Callbacks to invoke on event</summary>
        private readonly Action<string, string>? _onAspectChanged;
        private readonly Action<string, string>? _onModeChanged;

        // Track which signals we've subscribed to, so we can clean up.
        private readonly HashSet<SgSignal> _subscribedSignals = new HashSet<SgSignal>();

        // The main thread (captured in Register, which runs during mod load on the
        // Unity main thread). Signal.UpdateAspect touches Unity display objects and
        // must only run there; GetAllSignals may be invoked from the HTTP thread.
        private int _mainThreadId = -1;

        /// <summary>Constructor - inject callbacks for forward compat</summary>
        internal SignalsBridge(Action<string, string>? onAspectChanged = null, Action<string, string>? onModeChanged = null)
        {
            _onAspectChanged = onAspectChanged;
            _onModeChanged = onModeChanged;
        }

        /// <summary>
        /// Registers event handlers on the SignalManager static events and subscribes to already-existing signals.
        /// </summary>
        /// <remarks>Call this method to enable automatic handling of Signals.Game lifecycle events within
        /// the current context. This method should be called only once per instance to avoid multiple
        /// registrations.</remarks>
        internal void Register()
        {
            _mainThreadId = System.Threading.Thread.CurrentThread.ManagedThreadId;
            SignalManager.AspectChanged += OnSignalAspectChanged;
            SignalManager.OperationModeChanged += OnSignalOperationModeChanged;
            SignalManager.OverrideChanged += OnSignalOverrideChanged;

            SubscribeToExistingSignals();

            RefreshSpriteCache();

            LoggingReturn.DebugLog?.Invoke("Signals bridge registered.");
        }

        /// <summary>
        /// Unregisters event handlers from the SignalManager static events and unsubscribes from signals.
        /// </summary>
        /// <remarks>Call this method to detach previously registered event handlers and prevent further
        /// callbacks from the SignalManager. This is typically used during cleanup to avoid memory leaks or unintended
        /// behavior after the object is no longer needed.</remarks>
        internal void Unregister()
        {
            SignalManager.AspectChanged -= OnSignalAspectChanged;
            SignalManager.OperationModeChanged -= OnSignalOperationModeChanged;
            SignalManager.OverrideChanged -= OnSignalOverrideChanged;

            if (SignalManager.Instance != null)
            {
                foreach (var signal in _subscribedSignals)
                {
                    UnsubscribeFromSignal(signal);
                }
            }

            _subscribedSignals.Clear();
        }

        private void SubscribeToExistingSignals()
        {
            if (SignalManager.Instance == null) return;

            foreach (var controller in SignalManager.Instance.AllControllers)
            {
                foreach (var signal in controller.AllSignals)
                {
                    SubscribeToSignal(signal);
                }
            }
        }

        private void SubscribeToSignal(SgSignal signal)
        {
            if (!_subscribedSignals.Add(signal)) return;

            signal.AspectChanged += OnInstanceAspectChanged;
            signal.OperationModeChanged += OnInstanceModeChanged;
            signal.OverrideChanged += OnInstanceOverrideChanged;
        }

        private void UnsubscribeFromSignal(SgSignal signal)
        {
            if (signal.Definition != null)
            {
                signal.AspectChanged -= OnInstanceAspectChanged;
                signal.OperationModeChanged -= OnInstanceModeChanged;
                signal.OverrideChanged -= OnInstanceOverrideChanged;
            }
        }

        // Static (SignalManager-level) handlers.
        private void OnSignalAspectChanged(SgSignal signal, IAspect? aspect)
        {
            if (signal.Definition == null) return;
            CaptureSignalSprites(signal);
            _onAspectChanged?.Invoke(signal.Id.ToString(), aspect?.Id ?? "OFF");
        }

        private void OnSignalOperationModeChanged(SgSignal signal, SignalOperationMode mode)
        {
            if (signal.Definition == null) return;
            _onModeChanged?.Invoke(signal.Id.ToString(), ModeToString(mode));
        }

        private void OnSignalOverrideChanged(SgSignal signal, int _)
        {
            if (signal.Definition == null) return;
            _onAspectChanged?.Invoke(signal.Id.ToString(), signal.CurrentAspect?.Id ?? "OFF");
        }

        // Instance-level handlers.
        private void OnInstanceAspectChanged(IAspect? _)
        {
            // The instance handlers only fire for the owning bridge instance; the static
            // SignalManager handlers already cover the changes, so a direct callback is
            // not needed here. The Signal is captured via the per-signal subscription.
        }

        private void OnInstanceModeChanged(SignalOperationMode _)
        {
        }

        private void OnInstanceOverrideChanged(int _)
        {
        }

        private static string ModeToString(SignalOperationMode mode)
        {
            // Old API surfaced SignalMode.Manual / SignalMode.Automatic. The new mod has four
            // operation modes; any manual-ish mode is reported to the frontend as "Manual".
            switch (mode)
            {
                case SignalOperationMode.Automatic:
                    return "Automatic";
                case SignalOperationMode.TempOverride:
                case SignalOperationMode.SemiManual:
                case SignalOperationMode.FullManual:
                    return "Manual";
                default:
                    return "Automatic";
            }
        }

        /// <summary>
        /// Returns the current aspect ID of a signal by its unique registry Id, or null if not found.
        /// </summary>
        internal string? GetSignalAspect(string signalId)
        {
            var signal = FindSignalById(signalId);
            if (signal == null) return null;
            return signal.CurrentAspect?.Id ?? "OFF";
        }

        /// <summary>
        /// Returns all signals with raw world coordinates (not yet converted to lat/lng).
        /// </summary>
        internal Dictionary<string, object> GetAllSignals()
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);

            try
            {
                if (SignalManager.Instance == null) return result;

                // UpdateAspect touches Unity display objects and is main-thread-only.
                // From the HTTP thread we skip the sweep; the new fork's own 1s update
                // loop keeps aspects fresh, and SubscribeToExistingSignals (main thread)
                // already opened the subscription map for event-driven pushes.
                if (_mainThreadId == System.Threading.Thread.CurrentThread.ManagedThreadId)
                    ForceUpdateAllSignalAspects();

                // Also refresh the sprite cache on the main thread (throttled).
                RefreshSpriteCache();

                foreach (var controller in SignalManager.Instance.AllControllers)
                {
                    if (!controller.Exists) continue;

                    // The switchboard needs In (branch) signals attributed to their
                    // junction too, so read the owning junction off the group
                    // (available on every controller in a junction group).
                    var junction = controller.GroupJunction;

                    // Direction is the controller's facing semantic, set by the Signals
                    // mod at creation: junction signals protect the diverging (out)
                    // branches => "Out"; branch signals protect the converging (in)
                    // track => "In". (Upstream's signal.Controller == junctionController
                    // comparison only matches the Out controller, so branch controllers
                    // fell through to a blanket "Out"; see GetDirection below.)
                    var direction = GetDirection(controller);

                    // The left/right port for an In (branch) signal is its index in the
                    // junction's outBranches order, which matches the switchboard
                    // graph's left/right port assignment. The group's BranchSignals
                    // list can skip small tracks, so its index is not the port index.
                    int? branchIndex = null;
                    if (direction == "In" && junction != null && controller is TrackSignalController trackController)
                    {
                        var idx = junction.outBranches.FindIndex(b => b.track == trackController.StartingTrack);
                        if (idx >= 0)
                            branchIndex = idx;
                    }

                    foreach (var signal in controller.AllSignals)
                    {
                        if (signal.Definition == null) continue;

                        // Keep an up-to-date subscription map open so event-driven
                        // signals pushes keep working.
                        SubscribeToSignal(signal);

                        var block = signal.Block;
                        var junctionId = junction?.junctionData.junctionIdLong;
                        var type = TypeToString(controller.Type);
                        var position = signal.Definition.transform.position;
                        var signalId = signal.Id.ToString();

                        // Key by the signal's unique instance Id, not its display Name:
                        // entry signals often share names like "A" or "B" across yards,
                        // which would overwrite each other in the result dictionary.
                        result[signalId] = new
                        {
                            Id = signalId,
                            Name = signal.Name,
                            Type = type,
                            Mode = ModeToString(signal.Operation),
                            CurrentAspectId = signal.CurrentAspect?.Id ?? "OFF",
                            IsOn = signal.IsOn,
                            Direction = direction,
                            JunctionId = junctionId,
                            RequiredBranch = direction == "In" ? branchIndex : (int?)null,
                            SelectedBranch = junction?.selectedBranch,
                            YardId = block?.Yard,
                            TrackId = block?.TrackNumber,
                            Aspects = signal.AllAspects?.Select(a => a.Id).ToArray() ?? Array.Empty<string>(),
                            Position = new[] { position.x, position.z },
                        };
                    }
                }
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"GetAllSignals failed: {ex.Message}");
            }

            return result;
        }

        private static string GetDirection(BasicSignalController controller)
        {
            // TrackSignalController.Direction is the signal's facing semantic, set at
            // creation by the Signals mod (junction signals = Out, branch signals = In).
            // Signals without a TrackSignalController (e.g. Distant) have no switchboard
            // facing and fall back to "Out"; they carry no junction so they never attach
            // to a switch anyway.
            if (controller is TrackSignalController tsc)
                return tsc.Direction == TrackDirection.Out ? "Out" : "In";

            return "Out";
        }

        private static string TypeToString(SignalType type)
        {
            // Old API SignalType values: NotSet, Mainline, IntoYard, Shunting, Distant, Other.
            // The new mod's SignalType is richer; fold it back to the legacy names.
            switch (type)
            {
                case SignalType.Mainline:
                    return "Mainline";
                case SignalType.Entry:
                case SignalType.Exit:
                case SignalType.ExitPax:
                case SignalType.ExitMainline:
                case SignalType.Spacing:
                    return "IntoYard";
                case SignalType.Shunting:
                    return "Shunting";
                case SignalType.Distant:
                    return "Distant";
                default:
                    return "Other";
            }
        }

        /// <summary>
        /// Checks whether the given track has any trains physically on it.
        /// </summary>
        internal bool IsTrackOccupied(RailTrack track)
        {
            if (track == null) return false;
            try
            {
                // Equivalent to the old API's IsTrackOccupied / the new mod's internal
                // Extensions.HasBogies(). RailTrackOnTrackBogiesExtensions is a public
                // static helper in Assembly-CSharp (global namespace).
                return RailTrackOnTrackBogiesExtensions.BogiesOnTrack(track).Count > 0;
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"IsTrackOccupied failed: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Sets a signal to the specified aspect. Returns true on success.
        /// </summary>
        internal bool SetSignalAspect(string signalId, string aspect)
        {
            if (!IsMainThread())
            {
                LoggingReturn.Warning?.Invoke($"SetSignalAspect({signalId}, {aspect}) called off the Unity main thread - signal mutations must run there.");
                return false;
            }

            var signal = FindSignalById(signalId);
            if (signal == null) return false;

            LoggingReturn.Log?.Invoke($"Attempting to set signal aspect: {signalId} -> {aspect}");

            try
            {
                // Resolve the aspect index by ID, then set FullManual + override so the
                // aspect sticks (mirrors old SetAspectById behaviour). ChangeAspect must
                // run BEFORE SetAspectOverride: SetAspectOverride fires OverrideChanged,
                // which the Signals MP layer turns into an OverridePacket that reads
                // CurrentAspectIndex - so it would carry the stale aspect if the change
                // hadn't happened yet.
                for (int i = 0; i < signal.AllAspects.Length; i++)
                {
                    if (string.Equals(signal.AllAspects[i].Id, aspect, StringComparison.OrdinalIgnoreCase))
                    {
                        signal.ChangeOperationMode(SignalOperationMode.FullManual);
                        var changed = signal.ChangeAspect(i);
                        signal.SetAspectOverride(i);
                        signal.UpdateDisplays(changed);
                        signal.UpdateIndicators();
                        return true;
                    }
                }

                LoggingReturn.Warning?.Invoke($"Aspect '{aspect}' not found on signal '{signalId}'.");
                return false;
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"SetSignalAspect({signalId}, {aspect}) failed: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Sets a signal to the specified mode. Returns true on success.
        /// </summary>
        /// <param name="signalId">The ID of the signal</param>
        internal bool SetSignalMode(string signalId, string mode)
        {
            if (!IsMainThread())
            {
                LoggingReturn.Warning?.Invoke($"SetSignalMode({signalId}, {mode}) called off the Unity main thread - signal mutations must run there.");
                return false;
            }

            var signal = FindSignalById(signalId);
            if (signal == null) return false;

            LoggingReturn.DebugLog?.Invoke($"Attempting to set signal mode: {signalId} -> {mode}");

            try
            {
                SignalOperationMode parsed;
                switch (mode)
                {
                    case "Manual":
                        parsed = SignalOperationMode.FullManual;
                        break;
                    case "Automatic":
                        parsed = SignalOperationMode.Automatic;
                        break;
                    default:
                        LoggingReturn.DebugLog?.Invoke($"Failed to parse signal mode: {signalId} -> {mode}");
                        return false;
                }

                return signal.ChangeOperationMode(parsed);
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"SetSignalMode({signalId}, {mode}) failed: {ex.Message}");
                return false;
            }
        }

        private bool IsMainThread()
        {
            return _mainThreadId < 0 || System.Threading.Thread.CurrentThread.ManagedThreadId == _mainThreadId;
        }

        private static SgSignal? FindSignalById(string signalId)
        {
            if (string.IsNullOrEmpty(signalId) || SignalManager.Instance == null) return null;

            foreach (var controller in SignalManager.Instance.AllControllers)
            {
                foreach (var signal in controller.AllSignals)
                {
                    if (signal.Id.ToString().Equals(signalId, StringComparison.OrdinalIgnoreCase))
                    {
                        return signal;
                    }
                }
            }

            return null;
        }

        /// <summary>
        /// Resolves the pack file key for the current Signals.Game pack.
        /// Returns "DVSignalpack-default" when no custom pack is enabled, or
        /// "DVSignalpack-&lt;ModId&gt;" for an enabled custom pack.
        /// </summary>
        internal static string GetPackKey()
        {
            try
            {
                var pack = SignalManager.CurrentPack;
                if (pack == null) return "DVSignalpack-default";

                // A custom pack is enabled when the user selected one in the DVSignals settings.
                var custom = SignalsMod.Settings.CustomPack;
                if (string.IsNullOrEmpty(custom)) return "DVSignalpack-default";

                var modId = pack.ModId;
                if (string.IsNullOrEmpty(modId)) return "DVSignalpack-default";

                var sanitized = Sanitize(modId);
                return string.IsNullOrEmpty(sanitized) ? "DVSignalpack-default" : $"DVSignalpack-{sanitized}";
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"GetPackKey failed: {ex.Message}");
                return "DVSignalpack-default";
            }
        }

        internal static string Sanitize(string value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            var chars = value.ToCharArray();
            for (int i = 0; i < chars.Length; i++)
            {
                char c = chars[i];
                if (!char.IsLetterOrDigit(c) && c != '.' && c != '_' && c != '-')
                    chars[i] = '_';
            }
            return new string(chars);
        }

        /// <summary>
        /// Builds a capture snapshot for the given signal name. Must be called on the main thread.
        /// Returns null if the signal could not be found.
        /// The returned object serializes to:
        /// { PackId, PackVersion, PackName, Lamps: [{Name,Colour,Position:[x,y,z]}], CurrentAspectId, DisallowPassing, Lit: [], Blinking: [] }
        /// </summary>
        internal object? CaptureSignal(string signalId)
        {
            var signal = FindSignalById(signalId);
            if (signal == null || signal.Definition == null) return null;

            try
            {
                var pack = SignalManager.CurrentPack;
                var packId = pack?.ModId ?? string.Empty;
                var packVersion = pack?.Version ?? string.Empty;
                var packName = pack?.ModName ?? string.Empty;

                var lamps = new List<object>();
                foreach (var light in signal.AllLights)
                {
                    var def = light.Definition;
                    if (def == null) continue;

                    var localPos = signal.Definition.transform.InverseTransformPoint(def.transform.position);
                    lamps.Add(new
                    {
                        Name = def.gameObject.name,
                        Colour = ColorUtility.ToHtmlStringRGBA(def.Colour),
                        Position = new[] { localPos.x, localPos.y, localPos.z },
                    });
                }

                var aspect = signal.CurrentAspect;
                string aspectId = aspect?.Id ?? "OFF";
                bool disallowPassing = false;
                var lit = new List<string>();
                var blinking = new List<string>();

                if (aspect != null)
                {
                    var def = aspect.GetDefinition();
                    disallowPassing = def.DisallowPassing;

                    foreach (var on in def.OnLights)
                    {
                        if (on != null && !lit.Contains(on.gameObject.name)) lit.Add(on.gameObject.name);
                    }
                    foreach (var blink in def.BlinkingLights)
                    {
                        if (blink == null) continue;
                        var name = blink.gameObject.name;
                        if (!lit.Contains(name)) lit.Add(name);
                        if (!blinking.Contains(name)) blinking.Add(name);
                    }
                    foreach (var seq in def.LightSequences)
                    {
                        if (seq == null || seq.Lights == null) continue;
                        foreach (var light in seq.Lights)
                        {
                            if (light != null && !lit.Contains(light.gameObject.name)) lit.Add(light.gameObject.name);
                        }
                    }
                }

                return new
                {
                    PackId = packId,
                    PackVersion = packVersion,
                    PackName = packName,
                    Lamps = lamps.ToArray(),
                    CurrentAspectId = aspectId,
                    DisallowPassing = disallowPassing,
                    Lit = lit.ToArray(),
                    Blinking = blinking.ToArray(),
                };
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"CaptureSignal({signalId}) failed: {ex.Message}");
                return null;
            }
        }

        private static DateTime _lastForceUpdate = DateTime.MinValue;
        private static readonly TimeSpan _forceUpdateInterval = TimeSpan.FromSeconds(5);

        /// <summary>
        /// Forces all signals to evaluate their aspects regardless of player proximity.
        /// The new Signals mod runs its own 1s update loop, but this keeps Dispatch's
        /// aspect snapshot fresh even when a player is far from a signal. Throttled.
        /// </summary>
        private void ForceUpdateAllSignalAspects()
        {
            var now = DateTime.UtcNow;
            if (now - _lastForceUpdate < _forceUpdateInterval) return;
            _lastForceUpdate = now;

            if (SignalManager.Instance == null) return;

            try
            {
                foreach (var controller in SignalManager.Instance.AllControllers)
                {
                    if (!controller.Exists) continue;

                    foreach (var signal in controller.AllSignals)
                    {
                        if (signal.Definition == null) continue;
                        signal.UpdateAspect(false);
                    }
                }
            }
            catch (Exception ex)
            {
                LoggingReturn.DebugLog?.Invoke($"ForceUpdateAllSignalAspects failed: {ex.Message}");
            }
        }

        // ---------------------------------------------------------------------
        // HUD sprite capture (the in-game hover pictures).
        //
        // The Signals mod shows a picture of a signal when hovered: the current
        // aspect's HUDSprite (AspectBaseDefinition.HUDSprite) or, when off, the
        // signal's OffStateHUDSprite. These are static per signal pack, so we
        // extract each unique one once and cache the PNG bytes, then serve them
        // to the frontend over HTTP as an alternative to the lamp faces.
        // ---------------------------------------------------------------------

        private static string? _spriteCacheKey;
        private static DateTime _lastSpriteRefresh = DateTime.MinValue;
        private static readonly TimeSpan _spriteRefreshInterval = TimeSpan.FromSeconds(5);

        /// <summary>
        /// Throttled full sweep: (re)captures HUD sprites for every signal in the
        /// current pack, resetting the cache when the pack changes. Main thread only.
        /// Exposed via Bootstrap so the HTTP layer can trigger a capture pass on demand.
        /// </summary>
        internal void RefreshSpriteCache()
        {
            if (_mainThreadId != System.Threading.Thread.CurrentThread.ManagedThreadId) return;

            var key = GetPackKey();
            if (!string.Equals(key, _spriteCacheKey, StringComparison.Ordinal))
            {
                SignalSpriteCache.Reset();
                _spriteCacheKey = key;
                _lastSpriteRefresh = DateTime.MinValue;
            }

            var now = DateTime.UtcNow;
            if (now - _lastSpriteRefresh < _spriteRefreshInterval) return;
            _lastSpriteRefresh = now;

            if (SignalManager.Instance == null) return;

            try
            {
                int signals = 0;
                int aspects = 0;
                foreach (var controller in SignalManager.Instance.AllControllers)
                {
                    if (!controller.Exists) continue;
                    foreach (var signal in controller.AllSignals)
                    {
                        if (signal.Definition == null) continue;
                        signals++;
                        aspects += signal.AllAspects?.Length ?? 0;
                        CaptureSignalSprites(signal);
                    }
                }

                var summary = $"Sprite sweep: {signals} signals, {aspects} aspects, " +
                    $"{SignalSpriteCache.AspectIds().Length} aspect sprites, {SignalSpriteCache.OffTypes().Length} off sprites cached.";
                if (!string.Equals(summary, _lastSpriteSummary, StringComparison.Ordinal))
                {
                    _lastSpriteSummary = summary;
                    LoggingReturn.DebugLog?.Invoke(summary);
                }
            }
            catch (Exception ex)
            {
                LoggingReturn.DebugLog?.Invoke($"RefreshSpriteCache failed: {ex.Message}");
            }
        }

        private static string? _lastSpriteSummary;

        /// <summary>
        /// Captures the HUD sprites of a single signal into the cache: every aspect's
        /// HUDSprite (keyed by aspect id) and the signal's off-state sprite (keyed by
        /// its RD type). Main thread only. Best-effort; unreadable textures are skipped.
        /// </summary>
        private void CaptureSignalSprites(SgSignal signal)
        {
            if (_mainThreadId != System.Threading.Thread.CurrentThread.ManagedThreadId) return;
            if (signal.Definition == null) return;

            try
            {
                var type = TypeToString(signal.Controller?.Type ?? SignalType.NotSet);

                foreach (var aspect in signal.AllAspects)
                {
                    if (aspect == null) continue;
                    var id = aspect.Id;
                    if (string.IsNullOrEmpty(id) || SignalSpriteCache.HasAspect(id)) continue;

                    var def = aspect.GetDefinition();
                    if (def == null || def.HUDSprite == null)
                    {
                        LoggingReturn.DebugLog?.Invoke($"No HUDSprite for aspect '{id}' on {signal.Name}.");
                        continue;
                    }
                    var png = SpriteToPng(def.HUDSprite);
                    if (png != null) SignalSpriteCache.SetAspect(id, png);
                }

                if (!SignalSpriteCache.HasOff(type))
                {
                    var offPng = SpriteToPng(signal.Definition.OffStateHUDSprite);
                    if (offPng != null) SignalSpriteCache.SetOff(type, offPng);
                }
            }
            catch (Exception ex)
            {
                LoggingReturn.DebugLog?.Invoke($"CaptureSignalSprites({signal.Name}) failed: {ex.Message}");
            }
        }

        /// <summary>
        /// Encodes a Unity Sprite to PNG bytes, cropping to the sprite's rect so
        /// atlas-packed sprites work too. Non-readable textures (common for asset-bundle
        /// sprites) are copied through a RenderTexture; only the sprite's rect is read
        /// back to the CPU, so large atlases stay cheap. Returns null when the sprite
        /// is missing or could not be encoded (the frontend falls back to static pics).
        /// </summary>
        private static byte[]? SpriteToPng(Sprite? sprite)
        {
            if (sprite == null) return null;

            try
            {
                var texture = sprite.texture;
                if (texture == null) return null;

                var rect = sprite.rect;
                int x = (int)rect.x;
                int y = (int)rect.y;
                int w = (int)rect.width;
                int h = (int)rect.height;
                if (w <= 0 || h <= 0) return null;
                if (w > MaxSpriteSize || h > MaxSpriteSize)
                {
                    LoggingReturn.DebugLog?.Invoke($"SpriteToPng skipped ({sprite.name}): size {w}x{h} exceeds {MaxSpriteSize}px cap.");
                    return null;
                }

                Texture2D cropped;
                if (texture.isReadable)
                {
                    cropped = new Texture2D(w, h, TextureFormat.RGBA32, false);
                    cropped.SetPixels(texture.GetPixels(x, y, w, h));
                    cropped.Apply();
                }
                else
                {
                    // Non-readable source (typical for asset-bundle sprites). Blit the
                    // whole source into a RenderTexture on the GPU, then read back ONLY
                    // the sprite rect (not the whole atlas).
                    if ((long)texture.width * texture.height > MaxSourcePixels)
                    {
                        LoggingReturn.DebugLog?.Invoke($"SpriteToPng skipped ({sprite.name}): source {texture.width}x{texture.height} exceeds {MaxSourcePixels}px cap.");
                        return null;
                    }

                    var rt = RenderTexture.GetTemporary(texture.width, texture.height, 0, RenderTextureFormat.ARGB32);
                    try
                    {
                        Graphics.Blit(texture, rt);
                        var previous = RenderTexture.active;
                        RenderTexture.active = rt;
                        cropped = new Texture2D(w, h, TextureFormat.RGBA32, false);
                        cropped.ReadPixels(new Rect(x, y, w, h), 0, 0);
                        cropped.Apply();
                        RenderTexture.active = previous;
                    }
                    finally
                    {
                        RenderTexture.active = null;
                        RenderTexture.ReleaseTemporary(rt);
                    }
                }

                var png = cropped.EncodeToPNG();
                UnityEngine.Object.Destroy(cropped);
                return (png == null || png.Length == 0) ? null : png;
            }
            catch (Exception ex)
            {
                LoggingReturn.DebugLog?.Invoke($"SpriteToPng failed ({sprite.name}): {ex.Message}");
                return null;
            }
        }

        /// <summary>Encoded sprite size cap: larger HUD sprites are skipped (static pictures used instead).
        /// HUD face sprites are tall/narrow (e.g. 160x640), so allow up to 1024px per side.</summary>
        private const int MaxSpriteSize = 1024;

        /// <summary>Source-texture area cap for the non-readable RenderTexture path (bounds the temporary RT).</summary>
        private const long MaxSourcePixels = 4096L * 4096L;

        /// <summary>
        /// Returns the aspect ids and RD types that currently have cached HUD sprites,
        /// with their natural pixel sizes, serialized as
        /// { Aspects: { id: { W, H } }, Off: { type: { W, H } } }.
        /// </summary>
        internal object? GetSpriteManifest()
        {
            var aspects = new Dictionary<string, object>();
            foreach (var id in SignalSpriteCache.AspectIds())
            {
                var size = SignalSpriteCache.PngSize(SignalSpriteCache.GetAspect(id));
                if (size != null) aspects[id] = new { W = size.Value.Width, H = size.Value.Height };
            }

            var off = new Dictionary<string, object>();
            foreach (var type in SignalSpriteCache.OffTypes())
            {
                var size = SignalSpriteCache.PngSize(SignalSpriteCache.GetOff(type));
                if (size != null) off[type] = new { W = size.Value.Width, H = size.Value.Height };
            }

            return new
            {
                Aspects = aspects,
                Off = off,
            };
        }

        /// <summary>Returns the cached PNG bytes for an aspect id, or null.</summary>
        internal byte[]? GetSpritePng(string aspectId) => SignalSpriteCache.GetAspect(aspectId);

        /// <summary>Returns the cached PNG bytes for a signal type's off sprite, or null.</summary>
        internal byte[]? GetOffSpritePng(string type) => SignalSpriteCache.GetOff(type);

    }

    /// <summary>
    /// Thread-safe cache of encoded HUD sprite PNGs, keyed by aspect id (and by RD
    /// type for off-state sprites). Populated on the Unity main thread, read from
    /// the HTTP threads.
    /// </summary>
    internal static class SignalSpriteCache
    {
        private static readonly object s_lock = new object();
        private static readonly Dictionary<string, byte[]> s_aspectPngs = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        private static readonly Dictionary<string, byte[]> s_offPngs = new Dictionary<string, byte[]>(StringComparer.Ordinal);

        internal static void Reset()
        {
            lock (s_lock)
            {
                s_aspectPngs.Clear();
                s_offPngs.Clear();
            }
        }

        internal static bool HasAspect(string id)
        {
            lock (s_lock) return s_aspectPngs.ContainsKey(id);
        }

        internal static bool HasOff(string type)
        {
            lock (s_lock) return s_offPngs.ContainsKey(type);
        }

        internal static void SetAspect(string id, byte[] png)
        {
            lock (s_lock) s_aspectPngs[id] = png;
        }

        internal static void SetOff(string type, byte[] png)
        {
            lock (s_lock) s_offPngs[type] = png;
        }

        internal static byte[]? GetAspect(string id)
        {
            lock (s_lock) return s_aspectPngs.TryGetValue(id, out var png) ? png : null;
        }

        internal static byte[]? GetOff(string type)
        {
            lock (s_lock) return s_offPngs.TryGetValue(type, out var png) ? png : null;
        }

        internal static string[] AspectIds()
        {
            lock (s_lock) return new List<string>(s_aspectPngs.Keys).ToArray();
        }

        internal static string[] OffTypes()
        {
            lock (s_lock) return new List<string>(s_offPngs.Keys).ToArray();
        }

        /// <summary>Pixel size of an encoded PNG, read from its IHDR header (bytes 16-23).</summary>
        internal static (int Width, int Height)? PngSize(byte[]? png)
        {
            if (png == null || png.Length < 24) return null;
            if (png[0] != 0x89 || png[1] != 0x50) return null; // PNG signature
            return (
                Width: (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19],
                Height: (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23]);
        }
    }
}
