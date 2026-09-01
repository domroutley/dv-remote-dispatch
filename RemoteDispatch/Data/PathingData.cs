using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace DvMod.RemoteDispatch
{
    public static class PathingData
    {
        private static readonly List<JObject> paths = new List<JObject>();
        private static int nextId = 1;

        public static JArray GetPathsJson()
        {
            // Snapshot the staging data BEFORE taking the paths lock. The staging
            // loop on the main thread (StagingData.Process -> ActivateBlock ->
            // PathingData.GetPaths) takes lockObj then paths, so taking paths then
            // lockObj here inverts the lock order and can deadlock the two threads.
            var stagingData = StagingData.GetStagingData();
            lock (paths)
            {
                var enriched = new JArray();
                foreach (var p in paths)
                {
                    var clone = (JObject)p.DeepClone();
                    var pathId = clone.Value<string>("id");
                    var blocks = clone["blocks"] as JArray;
                    if (pathId != null && blocks != null && stagingData.TryGetValue(pathId, out var pathBlocks))
                    {
                        var states = new JObject();
                        for (int i = 0; i < blocks.Count && i < pathBlocks.Count; i++)
                        {
                            var blockId = blocks[i].ToString();
                            states[blockId] = pathBlocks[i];
                        }
                        clone["blockStates"] = states;
                    }
                    enriched.Add(clone);
                }
                return enriched;
            }
        }

        public static List<JObject> GetPaths()
        {
            lock (paths)
            {
                return paths.ToList();
            }
        }

        public static List<string> GetAllSignalIds()
        {
            lock (paths)
            {
                var result = new List<string>();
                foreach (var p in paths)
                {
                    var arr = p["signalIds"] as JArray;
                    if (arr != null)
                        result.AddRange(arr.ToObject<List<string>>());
                }
                return result;
            }
        }

        public static List<string> GetSignalIdsForPath(string id)
        {
            lock (paths)
            {
                var p = paths.FirstOrDefault(x => x.Value<string>("id") == id);
                if (p == null) return new List<string>();
                var arr = p["signalIds"] as JArray;
                return arr?.ToObject<List<string>>() ?? new List<string>();
            }
        }

        public static List<string> GetAllBlockSignalIds()
        {
            lock (paths)
            {
                var result = new List<string>();
                foreach (var p in paths)
                {
                    var blockSignals = p["blockSignals"] as JObject;
                    if (blockSignals != null)
                    {
                        foreach (var prop in blockSignals.Properties())
                        {
                            if (prop.Value != null)
                                result.Add(prop.Value.ToString());
                        }
                    }
                }
                return result;
            }
        }

        public static List<string> GetBlockSignalIdsForPath(string id)
        {
            lock (paths)
            {
                var p = paths.FirstOrDefault(x => x.Value<string>("id") == id);
                if (p == null) return new List<string>();
                var blockSignals = p["blockSignals"] as JObject;
                if (blockSignals == null) return new List<string>();
                return blockSignals.Properties().Select(prop => prop.Value.ToString()).ToList();
            }
        }

        public static bool HasSignalIds(string id)
        {
            lock (paths)
            {
                var p = paths.FirstOrDefault(x => x.Value<string>("id") == id);
                if (p == null) return false;
                return p["signalIds"] != null;
            }
        }

        public static string AddPath(JObject pathEntry)
        {
            var id = $"p{nextId++}";
            pathEntry["id"] = id;
            // Store the (defaulted) claim-ahead amount on the path so it round-trips
            // through /path GET and survives reloads/extensions.
            pathEntry["lookAhead"] = pathEntry.Value<int?>("lookAhead") ?? 5;
            lock (paths)
            {
                paths.Add((JObject)pathEntry.DeepClone());
            }
            var blocks = pathEntry["blocks"] as JArray;
            if (blocks != null)
                StagingData.AddPath(id, blocks, pathEntry.Value<int?>("lookAhead") ?? 5);
            Sessions.AddTag("paths");
            return id;
        }

        public static bool RemovePath(string id)
        {
            bool removed;
            JObject? removedPath = null;
            lock (paths)
            {
                removedPath = paths.FirstOrDefault(p => p.Value<string>("id") == id);
                var count = paths.RemoveAll(p => p.Value<string>("id") == id);
                removed = count > 0;
            }
            if (removed && removedPath != null)
            {
                StagingData.RemovePath(id);
                Sessions.AddTag("paths");
            }
            return removed;
        }

        public static void UpdatePath(JObject pathEntry)
        {
            var id = pathEntry.Value<string>("id");
            JObject? oldPath = null;
            lock (paths)
            {
                var existing = paths.FirstOrDefault(p => p.Value<string>("id") == id);
                if (existing != null)
                {
                    oldPath = (JObject)existing.DeepClone();
                    if (oldPath["note"] != null && pathEntry.Property("note") == null)
                        pathEntry["note"] = oldPath["note"];
                    if (oldPath["lookAhead"] != null && pathEntry.Property("lookAhead") == null)
                        pathEntry["lookAhead"] = oldPath["lookAhead"];
                    if (oldPath["color"] != null && pathEntry.Property("color") == null)
                        pathEntry["color"] = oldPath["color"];
                    paths[paths.IndexOf(existing)] = (JObject)pathEntry.DeepClone();
                }
            }
            if (oldPath != null)
            {
                var newBlocks = pathEntry["blocks"] as JArray;
                if (newBlocks != null)
                    StagingData.UpdatePath(id, newBlocks);
                Sessions.AddTag("paths");
            }
        }

        public static void UpdatePathNote(string id, string? note)
        {
            lock (paths)
            {
                var p = paths.FirstOrDefault(x => x.Value<string>("id") == id);
                if (p == null) return;
                if (string.IsNullOrEmpty(note))
                    p.Remove("note");
                else
                    p["note"] = note;
            }
            Sessions.AddTag("paths");
        }

        /// <summary>
        /// Sets a path's claim-ahead amount (the + / - stepper). The paths lock is
        /// released before touching staging so lock ordering stays lockObj -> paths.
        /// </summary>
        public static void UpdatePathLookAhead(string id, int lookAhead)
        {
            int clamped = Math.Max(0, lookAhead);
            lock (paths)
            {
                var p = paths.FirstOrDefault(x => x.Value<string>("id") == id);
                if (p == null) return;
                p["lookAhead"] = clamped;
            }
            StagingData.SetLookAhead(id, clamped);
            Sessions.AddTag("paths");
        }

        /// <summary>
        /// Sets a path's display colour (the switchboard hue slider). Cosmetic only -
        /// no staging interaction, so it does not need the main thread.
        /// </summary>
        public static void UpdatePathColor(string id, string? color)
        {
            if (!string.IsNullOrEmpty(color) && !Regex.IsMatch(color, "^#[0-9a-fA-F]{6}$"))
            {
                Main.Warning($"PathingData: rejecting invalid path color '{color}' for {id}");
                return;
            }
            lock (paths)
            {
                var p = paths.FirstOrDefault(x => x.Value<string>("id") == id);
                if (p == null) return;
                if (string.IsNullOrEmpty(color))
                    p.Remove("color");
                else
                    p["color"] = color;
            }
            Sessions.AddTag("paths");
        }

        /// <summary>
        /// Removes a path's clearance without deleting it (first press of the delete
        /// button): releases the staging claims and drops the persisted lookAhead to
        /// 0 so the path does not reclaim itself; it stays active and can be
        /// re-cleared with the + button, and a second delete removes it entirely.
        /// The paths lock is released before touching staging (lockObj -> paths).
        /// </summary>
        public static void UnclaimPath(string id)
        {
            lock (paths)
            {
                var p = paths.FirstOrDefault(x => x.Value<string>("id") == id);
                if (p == null) return;
                p["lookAhead"] = 0;
            }
            StagingData.UnclaimPath(id);
            Sessions.AddTag("paths");
        }

        public static void RemovePrefixFromPath(string id, int count)
        {
            lock (paths)
            {
                var p = paths.FirstOrDefault(x => x.Value<string>("id") == id);
                if (p == null) return;
                var blocks = p["blocks"] as JArray;
                if (blocks == null || blocks.Count < count) return;
                var removed = new List<string>();
                for (int i = 0; i < count && i < blocks.Count; i++)
                {
                    if (blocks[i] is JValue val) removed.Add(val.ToString());
                }
                var remaining = blocks.Skip(count).ToArray();
                p.Remove("blocks");
                p["blocks"] = new JArray(remaining);

                if (p["blockSignals"] is JObject blockSignals)
                    foreach (var r in removed)
                        blockSignals.Remove(r);
                if (p["switchAssignments"] is JObject switchAssignments)
                    foreach (var r in removed)
                        switchAssignments.Remove(r);
            }
        }

        public static void RemovePathFromStoredList(string id)
        {
            lock (paths)
            {
                paths.RemoveAll(p => p.Value<string>("id") == id);
            }
        }

        public static void ClearPaths()
        {
            lock (paths)
            {
                paths.Clear();
            }
            StagingData.ClearAll();
            Sessions.AddTag("paths");
        }
    }
}
