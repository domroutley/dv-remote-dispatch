using System;
using System.Collections.Generic;

namespace DvMod.RemoteDispatch.Signals
{
    public static class Bootstrap
    {
        private static SignalsBridge? _bridge;

        // Expose methods for the main mod to interact with Signals.Game without the main
        // mod needing a compile-time dependency on the new Signals mod.
        public static Dictionary<string, object>? GetAllSignals() => _bridge?.GetAllSignals();
        public static string? GetSignalAspect(string signalId) => _bridge?.GetSignalAspect(signalId);
        public static bool SetSignalAspect(string signalId, string aspect) => _bridge?.SetSignalAspect(signalId, aspect) ?? false;
        public static bool SetSignalMode(string signalId, string mode) => _bridge?.SetSignalMode(signalId, mode) ?? false;

        /// <summary>
        /// Checks whether the given track has any trains physically on it.
        /// </summary>
        public static bool IsTrackOccupied(RailTrack track) => _bridge?.IsTrackOccupied(track) ?? false;

        /// <summary>
        /// Resolves the pack file key ("DVSignalpack-default", "DVSignalpack-&lt;ModId&gt;").
        /// </summary>
        public static string? GetPackKey() => _bridge == null ? null : SignalsBridge.GetPackKey();

        /// <summary>
        /// Captures a signal's lamps and the currently-applied aspect's lamp usage. Main-thread only.
        /// </summary>
        public static object? CaptureSignal(string signalName) => _bridge?.CaptureSignal(signalName);

        /// <summary>
        /// Returns the HUD sprite manifest: { Aspects: { id: { W, H } }, Off: { type: { W, H } } }
        /// listing the aspect ids and signal types whose sprites are currently cached, with their
        /// natural pixel sizes.
        /// </summary>
        public static object? GetSpriteManifest() => _bridge?.GetSpriteManifest();

        /// <summary>
        /// Returns the cached PNG bytes for an aspect id, or null if unavailable.
        /// </summary>
        public static byte[]? GetSpritePng(string aspectId) => _bridge?.GetSpritePng(aspectId);

        /// <summary>
        /// Returns the cached PNG bytes for a signal type's off-state sprite, or null.
        /// </summary>
        public static byte[]? GetOffSpritePng(string type) => _bridge?.GetOffSpritePng(type);

        /// <summary>
        /// Runs a throttled sprite capture pass on the current thread (must be the main
        /// thread). Called by the HTTP layer so the sprite cache populates on demand.
        /// </summary>
        public static void RefreshSprites() => _bridge?.RefreshSpriteCache();

        /// <summary>
        /// Initialize the bridge and set up logging. This should be called by the main mod during its initialization.
        /// </summary>
        /// <param name="log"></param>
        /// <param name="debugLog"></param>
        /// <param name="warning"></param>
        /// <param name="onAspectChanged">Callback for aspect changes</param>
        /// <param name="onModeChanged">Callback for mode changes</param>
        public static void Initialize(Action<string> log, Action<string> debugLog, Action<string> warning, Action<string, string>? onAspectChanged = null, Action<string, string>? onModeChanged = null)
        {
            LoggingReturn.Initialize(log, debugLog, warning);
            try
            {
                _bridge = new SignalsBridge(onAspectChanged, onModeChanged);
                _bridge.Register();
                LoggingReturn.Log?.Invoke("Signals bridge initialized.");
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"Signals Initialize failed: {ex.Message}\n{ex.StackTrace}");
            }
        }

        ///<summary>
        ///Clean up the bridge and handlers. This should be called by the main mod during its shutdown.
        ///
        ///</summary>
        public static void Teardown()
        {
            try
            {
                _bridge?.Unregister();
                _bridge = null;
                LoggingReturn.Log?.Invoke("Signals bridge torn down.");
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"Teardown failed: {ex.Message}\n{ex.StackTrace}");
            }
        }
    }
}
