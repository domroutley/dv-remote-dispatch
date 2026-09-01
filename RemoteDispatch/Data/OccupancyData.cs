using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;

namespace DvMod.RemoteDispatch
{
    public static class OccupancyData
    {
        private static readonly object cacheLock = new object();

        private static Dictionary<string, List<(string junctionId, string port, int junctionIndex, bool isOwnSwitch)>>? _blockJunctionMap;
        private static HashSet<string>? _allBlockIds;
        private static Dictionary<string, bool?> _lastOccupancy = new Dictionary<string, bool?>();
        private static Dictionary<string, bool?> _currentOccupancy = new Dictionary<string, bool?>();
        private static bool _mappingInitialized = false;

        private static readonly HashSet<string> OccupiedAspects = new HashSet<string> { "S1", "S1r", "S1c" };
        private static readonly HashSet<string> ClearAspects = new HashSet<string> { "S2", "S4", "S6" };

        public enum OccupancyMode
        {
            Hardcore = 0,
            Direct = 1
        }

        private static OccupancyMode _mode = OccupancyMode.Direct;
        private static bool _modeChanged = false;

        public static bool HasMapping => _blockJunctionMap != null && _blockJunctionMap.Count > 0;

        public static void SetMode(int mode)
        {
            var newMode = (OccupancyMode)mode;
            if (_mode == newMode) return;
            _mode = newMode;
            _modeChanged = true;
            Main.Log($"OccupancyData: mode set to {_mode}");
        }

        public static OccupancyMode GetMode()
        {
            return _mode;
        }

        public static void SetBlockMapping(Dictionary<string, List<(string junctionId, string port, int junctionIndex, bool isOwnSwitch)>> mapping)
        {
            lock (cacheLock)
            {
                _blockJunctionMap = mapping;
                _allBlockIds = new HashSet<string>(mapping.Keys);
                _lastOccupancy.Clear();
                _currentOccupancy.Clear();
                _mappingInitialized = true;
                Main.Log($"OccupancyData: set mapping for {mapping.Count} blocks.");
            }
            if (CheckChanged())
            {
                Sessions.AddTag("occupancy");
            }
        }

        public static HashSet<string> GetDetectedJunctionIds()
        {
            lock (cacheLock)
            {
                if (_blockJunctionMap == null)
                    return new HashSet<string>();

                var junctionIds = new HashSet<string>();
                foreach (var entries in _blockJunctionMap.Values)
                {
                    foreach (var (junctionId, _, _, _) in entries)
                    {
                        if (!string.IsNullOrEmpty(junctionId))
                            junctionIds.Add(junctionId);
                    }
                }
                return junctionIds;
            }
        }

        public static void ClearMapping()
        {
            lock (cacheLock)
            {
                _blockJunctionMap = null;
                _allBlockIds = null;
                _lastOccupancy.Clear();
                _currentOccupancy.Clear();
                _mappingInitialized = false;
            }
        }

        private static void ComputeOccupancy()
        {
            if (_mode == OccupancyMode.Direct && SignalsShim.IsAPILoaded)
            {
                ComputeOccupancyDirect();
            }
            else
            {
                ComputeOccupancyHardcore();
            }
        }

        private static void ComputeOccupancyHardcore()
        {
            var result = new Dictionary<string, bool?>();

            if (_allBlockIds == null)
            {
                _currentOccupancy = result;
                return;
            }

            var signalAspects = SignalsShim.GetJunctionSignalAspects();
            var junctionStates = Junctions.GetAllJunctionStates().ToArray();

            int occupiedCount = 0;
            int nullCount = 0;
            int noSignalCount = 0;
            int misalignedSkipCount = 0;
            int totalEntries = 0;
            int blocksWithEntries = 0;
            int blocksWithoutEntries = 0;

            foreach (var blockId in _allBlockIds)
            {
                if (_blockJunctionMap == null || !_blockJunctionMap.TryGetValue(blockId, out var entries) || entries.Count == 0)
                {
                    result[blockId] = null;
                    nullCount++;
                    blocksWithoutEntries++;
                    continue;
                }

                blocksWithEntries++;
                totalEntries += entries.Count;

                bool foundOccupied = false;
                bool foundClear = false;
                bool foundAnySignal = false;

                foreach (var (junctionId, port, junctionIndex, isOwnSwitch) in entries)
                {
                    if (isOwnSwitch)
                        continue;

                    if (port != "common")
                    {
                        if (junctionIndex < 0 || junctionIndex >= junctionStates.Length)
                        {
                            misalignedSkipCount++;
                            continue;
                        }
                        byte currentBranch = junctionStates[junctionIndex];
                        bool isSelected = (port == "left" && currentBranch == 0) ||
                                          (port == "right" && currentBranch == 1);
                        if (!isSelected)
                        {
                            misalignedSkipCount++;
                            continue;
                        }
                    }

                    if (!signalAspects.TryGetValue(junctionId, out var signalList))
                    {
                        noSignalCount++;
                        continue;
                    }

                    string requiredDirection = port == "common" ? "In" : "Out";

                    foreach (var (aspectId, direction) in signalList)
                    {
                        if (direction != requiredDirection)
                            continue;

                        foundAnySignal = true;

                        if (OccupiedAspects.Contains(aspectId))
                            foundOccupied = true;
                        if (ClearAspects.Contains(aspectId))
                            foundClear = true;
                    }
                }

                if (foundAnySignal)
                {
                    bool occupied;
                    if (foundClear)
                        occupied = false;
                    else if (foundOccupied)
                        occupied = true;
                    else
                    {
                        result[blockId] = null;
                        nullCount++;
                        continue;
                    }
                    result[blockId] = occupied;
                    if (occupied) occupiedCount++;
                }
                else
                {
                    result[blockId] = null;
                    nullCount++;
                }
            }

            _currentOccupancy = result;
        }

        private static Dictionary<string, RailTrack>? _trackByIdCache;
        private static Dictionary<string, List<(string trackId, bool atStart)>>? _endpointAdjCache;
        private static Dictionary<string, List<(int junctionIdx, bool atStart)>>? _trackEndpointJunctionsCache;

        private static void EnsureTrackCache()
        {
            if (_trackByIdCache != null)
                return;
            var allTracks = UnityEngine.Object.FindObjectsOfType<RailTrack>();
            _trackByIdCache = new Dictionary<string, RailTrack>();
            _endpointAdjCache = new Dictionary<string, List<(string trackId, bool atStart)>>();
            _trackEndpointJunctionsCache = new Dictionary<string, List<(int junctionIdx, bool atStart)>>();

            Main.DebugLog($"OccupancyData.Direct: caching {allTracks.Length} RailTracks.");

            foreach (var track in allTracks)
            {
                string trackId;
                try
                {
                    trackId = track.LogicTrack().ID.ToString();
                }
                catch
                {
                    continue;
                }
                if (string.IsNullOrEmpty(trackId)) continue;
                _trackByIdCache[trackId] = track;

                var pointSet = track.GetKinkedPointSet();
                if (pointSet == null || pointSet.points.Length < 1) continue;

                var start = pointSet.points[0].position;
                var end = pointSet.points[pointSet.points.Length - 1].position;
                string startKey = $"{start.x:F1},{start.z:F1}";
                string endKey = $"{end.x:F1},{end.z:F1}";

                if (!_endpointAdjCache.ContainsKey(startKey))
                    _endpointAdjCache[startKey] = new List<(string, bool)>();
                _endpointAdjCache[startKey].Add((trackId, true));
                if (!_endpointAdjCache.ContainsKey(endKey))
                    _endpointAdjCache[endKey] = new List<(string, bool)>();
                _endpointAdjCache[endKey].Add((trackId, false));
            }

            var junctions = RailTrackRegistry.Instance.OrderedJunctions;
            for (int i = 0; i < junctions.Length; i++)
            {
                var j = junctions[i];
                foreach (var b in j.outBranches)
                {
                    if (b?.track == null) continue;
                    string tid;
                    try { tid = b.track.LogicTrack().ID.ToString(); }
                    catch { continue; }
                    if (!_trackEndpointJunctionsCache.ContainsKey(tid))
                        _trackEndpointJunctionsCache[tid] = new List<(int, bool)>();
                    _trackEndpointJunctionsCache[tid].Add((i, b.first));
                }
                if (j.inBranch?.track != null)
                {
                    string tid;
                    try { tid = j.inBranch.track.LogicTrack().ID.ToString(); }
                    catch { continue; }
                    if (!_trackEndpointJunctionsCache.ContainsKey(tid))
                        _trackEndpointJunctionsCache[tid] = new List<(int, bool)>();
                    _trackEndpointJunctionsCache[tid].Add((i, j.inBranch.first));
                }
            }
        }

        private static HashSet<string> CollectTracksForBlock(
            List<(string junctionId, string port, int junctionIndex, bool isOwnSwitch)> entries,
            byte[] junctionStates)
        {
            var trackIds = new HashSet<string>();
            var walkSeeds = new List<(string trackId, bool walkFromStart)>();

            foreach (var (junctionId, port, junctionIndex, isOwnSwitch) in entries)
            {
                if (junctionIndex < 0 || junctionIndex >= junctionStates.Length)
                    continue;

                var junction = RailTrackRegistry.Instance.OrderedJunctions[junctionIndex];

                if (port == "common")
                {
                    if (junction.inBranch?.track != null)
                    {
                        string tid;
                        try { tid = junction.inBranch.track.LogicTrack().ID.ToString(); }
                        catch { continue; }
                        trackIds.Add(tid);
                        walkSeeds.Add((tid, !junction.inBranch.first));
                    }
                }
                else
                {
                    int branchIdx = port == "left" ? 0 : 1;
                    if (branchIdx < junction.outBranches.Count)
                    {
                        var b = junction.outBranches[branchIdx];
                        if (b?.track != null)
                        {
                            string tid;
                            try { tid = b.track.LogicTrack().ID.ToString(); }
                            catch { continue; }
                            walkSeeds.Add((tid, !b.first));
                        }
                    }
                }
            }

            foreach (var (seedTrackId, walkFromStart) in walkSeeds)
            {
                WalkTracksFromSeed(seedTrackId, walkFromStart, trackIds);
            }

            return trackIds;
        }

        private static void WalkTracksFromSeed(string seedTrackId, bool walkFromStart, HashSet<string> collectedTrackIds)
        {
            if (_trackByIdCache == null || _endpointAdjCache == null || _trackEndpointJunctionsCache == null)
                return;

            if (!_trackByIdCache.TryGetValue(seedTrackId, out var seedTrack))
                return;

            var ps = seedTrack.GetKinkedPointSet();
            if (ps == null || ps.points.Length < 1)
                return;

            var startPos = walkFromStart ? ps.points[0].position : ps.points[ps.points.Length - 1].position;
            string startKey = $"{startPos.x:F1},{startPos.z:F1}";

            var visited = new HashSet<string> { seedTrackId };
            var queue = new Queue<(string key, string prevTrackId)>();
            queue.Enqueue((startKey, seedTrackId));

            while (queue.Count > 0)
            {
                var (key, prevTrackId) = queue.Dequeue();
                if (!_endpointAdjCache.TryGetValue(key, out var connected))
                    continue;

                foreach (var (ctId, ctAtStart) in connected)
                {
                    if (ctId == prevTrackId) continue;
                    if (!visited.Add(ctId)) continue;

                    if (_trackEndpointJunctionsCache.TryGetValue(ctId, out var epJunctions))
                    {
                        bool found = false;
                        foreach (var (jIdx, jAtStart) in epJunctions)
                        {
                            if (ctAtStart == jAtStart)
                            {
                                found = true;
                                break;
                            }
                        }
                        if (found) continue;
                    }

                    collectedTrackIds.Add(ctId);

                    if (_trackByIdCache.TryGetValue(ctId, out var ct))
                    {
                        var ctPs = ct.GetKinkedPointSet();
                        if (ctPs != null && ctPs.points.Length >= 1)
                        {
                            var otherFarPos = ctAtStart
                                ? ctPs.points[ctPs.points.Length - 1].position
                                : ctPs.points[0].position;
                            string otherFarKey = $"{otherFarPos.x:F1},{otherFarPos.z:F1}";
                            queue.Enqueue((otherFarKey, ctId));
                        }
                    }
                }
            }
        }

        private static void ComputeOccupancyDirect()
        {
            var result = new Dictionary<string, bool?>();

            if (_allBlockIds == null)
            {
                _currentOccupancy = result;
                return;
            }

            EnsureTrackCache();

            var junctionStates = Junctions.GetAllJunctionStates().ToArray();

            foreach (var blockId in _allBlockIds)
            {
                if (_blockJunctionMap == null || !_blockJunctionMap.TryGetValue(blockId, out var entries) || entries.Count == 0)
                {
                    result[blockId] = null;
                    continue;
                }

                bool isOwnSwitch = false;
                foreach (var e in entries)
                {
                    if (e.isOwnSwitch) { isOwnSwitch = true; break; }
                }

                if (isOwnSwitch)
                {
                    result[blockId] = CheckSwitchOccupied(entries, junctionStates);
                    continue;
                }

                var trackIds = CollectTracksForBlock(entries, junctionStates);

                if (trackIds.Count == 0)
                {
                    result[blockId] = null;
                    continue;
                }

                bool foundOccupied = false;
                foreach (var trackId in trackIds)
                {
                    if (_trackByIdCache != null && _trackByIdCache.TryGetValue(trackId, out var track))
                    {
                        if (SignalsShim.IsTrackOccupied(track))
                        {
                            foundOccupied = true;
                            break;
                        }
                    }
                }

                result[blockId] = foundOccupied;
            }

            _currentOccupancy = result;
        }

        private static bool? CheckSwitchOccupied(
            List<(string junctionId, string port, int junctionIndex, bool isOwnSwitch)> entries,
            byte[] junctionStates)
        {
            bool foundAny = false;

            foreach (var entry in entries)
            {
                if (!entry.isOwnSwitch) continue;
                if (entry.junctionIndex < 0 || entry.junctionIndex >= junctionStates.Length)
                    continue;

                var junction = RailTrackRegistry.Instance.OrderedJunctions[entry.junctionIndex];

                foreach (var b in junction.outBranches)
                {
                    if (b?.track == null) continue;
                    foundAny = true;
                    if (SignalsShim.IsTrackOccupied(b.track))
                        return true;
                }
            }

            return foundAny ? false : (bool?)null;
        }

        public static Dictionary<string, bool?> GetOccupancyData()
        {
            lock (cacheLock)
            {
                return new Dictionary<string, bool?>(_currentOccupancy);
            }
        }

        public static bool CheckChanged()
        {
            ComputeOccupancy();

            lock (cacheLock)
            {
                bool changed = _modeChanged;
                _modeChanged = false;

                foreach (var kvp in _currentOccupancy)
                {
                    if (!_lastOccupancy.TryGetValue(kvp.Key, out var prev) || prev != kvp.Value)
                    {
                        changed = true;
                        break;
                    }
                }

                if (!changed && _lastOccupancy.Count != _currentOccupancy.Count)
                    changed = true;

                if (changed)
                    _lastOccupancy = new Dictionary<string, bool?>(_currentOccupancy);

                return changed;
            }
        }

        public static string GetOccupancyJSON()
        {
            return JsonConvert.SerializeObject(GetOccupancyData());
        }

        public static bool TryGetOwnSwitchIndex(string blockId, out int junctionIndex)
        {
            lock (cacheLock)
            {
                if (_blockJunctionMap != null && _blockJunctionMap.TryGetValue(blockId, out var entries))
                {
                    foreach (var (_, _, jIdx, isOwnSwitch) in entries)
                    {
                        if (isOwnSwitch)
                        {
                            junctionIndex = jIdx;
                            return true;
                        }
                    }
                }
            }
            junctionIndex = -1;
            return false;
        }

        public static Dictionary<string, List<(int junctionIndex, byte neededBranch)>> GetSwitchBlocksForPath(JObject path)
        {
            var result = new Dictionary<string, List<(int junctionIndex, byte neededBranch)>>();
            var switchAssignments = path["switchAssignments"] as JObject;
            if (switchAssignments == null) return result;

            lock (cacheLock)
            {
                if (_blockJunctionMap == null) return result;

                foreach (var assignment in switchAssignments.Properties())
                {
                    var blockId = assignment.Name;
                    var neededBranch = (byte)(assignment.Value<int>());
                    if (!_blockJunctionMap.TryGetValue(blockId, out var entries)) continue;

                    var list = new List<(int junctionIndex, byte neededBranch)>();
                    foreach (var (_, _, junctionIndex, isOwnSwitch) in entries)
                    {
                        if (isOwnSwitch)
                            list.Add((junctionIndex, neededBranch));
                    }
                    if (list.Count > 0)
                        result[blockId] = list;
                }
            }
            return result;
        }

        public static List<string> GetOwnSwitchSignalIdsForBlock(string blockId)
        {
            var result = new List<string>();
            lock (cacheLock)
            {
                if (_blockJunctionMap == null || !_blockJunctionMap.TryGetValue(blockId, out var entries))
                    return result;

                var ownJunctionIds = new HashSet<string>();
                foreach (var (junctionId, _, _, isOwnSwitch) in entries)
                {
                    if (isOwnSwitch && !string.IsNullOrEmpty(junctionId))
                        ownJunctionIds.Add(junctionId);
                }
                if (ownJunctionIds.Count == 0) return result;

                var allSignals = SignalsShim.GetAllSignalsData() as JObject;
                if (allSignals == null) return result;

                foreach (var prop in allSignals.Properties())
                {
                    var signalData = prop.Value as JObject;
                    if (signalData == null) continue;
                    var junctionId = signalData["JunctionId"]?.ToString() ?? "";
                    if (ownJunctionIds.Contains(junctionId))
                        result.Add(prop.Name);
                }
            }
            return result;
        }
    }
}
