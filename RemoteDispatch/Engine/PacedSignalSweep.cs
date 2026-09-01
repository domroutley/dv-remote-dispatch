using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace DvMod.RemoteDispatch
{
    /// <summary>
    /// Applies a set of per-signal main-thread mutations in batches across frames so a
    /// full-map signal sweep (pathing enable/disable) does not stall the game in one
    /// frame. Only one sweep runs at a time; starting a new one cancels the previous.
    /// </summary>
    internal static class PacedSignalSweep
    {
        private const int PerFrame = 24;

        /// <summary>
        /// Runs each mutation on the main thread, up to <see cref="PerFrame"/> per frame,
        /// in list order. When the last batch is applied, onAllDone is invoked (main thread).
        /// Starting a new sweep cancels any in-flight one.
        /// </summary>
        public static void Run(IReadOnlyList<Action> mutations, Action? onAllDone = null)
        {
            if (mutations == null || mutations.Count == 0)
            {
                onAllDone?.Invoke();
                return;
            }
            if (Updater.Root == null) return; // mod not started; nothing to sweep

            Updater.StartSweep(SweepCoro(mutations, onAllDone));
        }

        // Runs one batch per frame. Mutations that throw are logged and skipped so a
        // single bad signal can't abort the whole sweep.
        private static IEnumerator SweepCoro(IReadOnlyList<Action> mutations, Action? onAllDone)
        {
            int i = 0;
            while (i < mutations.Count)
            {
                int end = Math.Min(i + PerFrame, mutations.Count);
                while (i < end)
                {
                    try
                    {
                        mutations[i]();
                    }
                    catch (Exception e)
                    {
                        Main.Warning($"PacedSignalSweep: mutation failed: {e.Message}");
                    }
                    i++;
                }
                yield return null;
            }

            onAllDone?.Invoke();
        }
    }
}
