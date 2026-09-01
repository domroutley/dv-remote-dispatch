#nullable disable
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;

namespace DvMod.RemoteDispatch
{
    public static class StagingData
    {
        private static readonly object lockObj = new object();

        private const int DefaultLookAhead = 5;

        // Paces the ordinary automatic lookahead extension so it does not all
        // happen at once. Train advances, conflict probes, and a growing lookahead
        // (+ button) run immediately regardless of this timer.
        private static readonly TimeSpan ClaimInterval = TimeSpan.FromSeconds(5);

        private class PathStaging
        {
            public string pathId;
            public string[] blocks;
            public int currentBlockIndex;
            public int lookAhead;
            public string status; // "Active", "Completed", "Cancelled"

            public PathStaging(string pathId, string[] blocks, int lookAhead)
            {
                this.pathId = pathId;
                this.blocks = blocks;
                this.currentBlockIndex = 0;
                this.lookAhead = Math.Max(0, lookAhead);
                this.status = "Active";
            }
        }

        private static Dictionary<string, PathStaging> _pathProgress = new Dictionary<string, PathStaging>();
        private static Dictionary<string, List<string>> _blockQueues = new Dictionary<string, List<string>>();
        private static Dictionary<string, string> _activeBlocks = new Dictionary<string, string>();
        private static Dictionary<string, DateTime> _retryTimes = new Dictionary<string, DateTime>();

        private static List<string> GetQueue(string blockId)
        {
            if (!_blockQueues.TryGetValue(blockId, out var queue))
            {
                queue = new List<string>();
                _blockQueues[blockId] = queue;
            }
            return queue;
        }

        public static void InitializeFromPaths(List<JObject> paths)
        {
            lock (lockObj)
            {
                foreach (var path in paths)
                {
                    var pathId = path.Value<string>("id");
                    if (pathId == null) continue;
                    var blocks = path["blocks"] as JArray;
                    if (blocks == null || blocks.Count == 0) continue;
                    var blocksArr = blocks.ToObject<string[]>();
                    var lookAhead = path.Value<int?>("lookAhead") ?? DefaultLookAhead;

                    // On a client reload the staging state is still live server-side,
                    // so an already-tracked path keeps its claims exactly as they
                    // were; only genuinely new paths are seeded below.
                    if (_pathProgress.ContainsKey(pathId))
                        continue;

                    var staging = new PathStaging(pathId, blocksArr, lookAhead);
                    _pathProgress[pathId] = staging;

                    foreach (var blockId in blocksArr)
                    {
                        var queue = GetQueue(blockId);
                        if (!queue.Contains(pathId))
                            queue.Add(pathId);
                    }

                    // Startup check for a genuinely new path: run the single
                    // advancing function once. It seeds the train's block and
                    // claims ONE section ahead only (claimCap 1) - the rest of the
                    // lookahead window is filled after the 5s pacing cooldown, so a
                    // fresh path never blasts the whole window at once. Already-
                    // tracked paths keep their live claims above, untouched.
                    Advance(staging, claimCap: 1);
                    _retryTimes[pathId] = DateTime.UtcNow + ClaimInterval;
                }

                if (_pathProgress.Count > 0)
                    Sessions.AddTag("paths");
            }
        }

        public static void AddPath(string pathId, JArray blocksArray, int lookAhead = DefaultLookAhead)
        {
            lock (lockObj)
            {
                var blocksArr = blocksArray.ToObject<string[]>();
                var staging = new PathStaging(pathId, blocksArr, lookAhead);
                _pathProgress[pathId] = staging;

                foreach (var blockId in blocksArr)
                {
                    var queue = GetQueue(blockId);
                    if (!queue.Contains(pathId))
                        queue.Add(pathId);
                }

                // Startup check: seed the train's block and claim ONE section ahead
                // only via the same advancing function used by the periodic check,
                // then start the 5s pacing timer for the rest of the window.
                Advance(staging, claimCap: 1);
                _retryTimes[pathId] = DateTime.UtcNow + ClaimInterval;
            }
        }

        public static void ClearAll()
        {
            lock (lockObj)
            {
                foreach (var kvp in _activeBlocks.ToList())
                    ReleaseBlock(kvp.Key);
                _pathProgress.Clear();
                _blockQueues.Clear();
                _activeBlocks.Clear();
                _retryTimes.Clear();
            }
        }

        /// <summary>
        /// Changes a path's claim-ahead threshold (the + / - stepper in the
        /// switchboard sidebar). The + button grows the window and claims it
        /// immediately (skipping the 5s pacing timer, so it acts like the old
        /// "Claim next" button). The - button only lowers the threshold at which
        /// NEW blocks are claimed - it never releases already-held claims (use
        /// UnclaimPath / the delete button for that); held claims simply stop
        /// being extended until the train passes them.
        /// </summary>
        public static void SetLookAhead(string pathId, int value)
        {
            lock (lockObj)
            {
                if (!_pathProgress.TryGetValue(pathId, out var staging))
                    return;
                if (staging.status != "Active")
                    return;

                int clamped = Math.Max(0, value);
                if (clamped == staging.lookAhead)
                    return;

                staging.lookAhead = clamped;

                if (clamped > 0)
                {
                    // Grow: skip the pacing timer so the extra window is claimed
                    // synchronously, mirroring the + button's "claim next" role.
                    _retryTimes.Remove(pathId);
                    Advance(staging);
                }
            }
        }

        /// <summary>
        /// Removes a path's clearance (the first press of the delete button, used
        /// as a fallback when a dispatcher wants to pull the claims without
        /// deleting the route). Releases every block the path claims (guard
        /// signals revert to stop) and sets its lookAhead to 0 so it does not
        /// reclaim itself - the path stays active and can be re-cleared with the
        /// + button; the second delete press removes it entirely.
        /// </summary>
        public static void UnclaimPath(string pathId)
        {
            lock (lockObj)
            {
                if (!_pathProgress.TryGetValue(pathId, out var staging))
                    return;

                foreach (var kvp in _activeBlocks.ToList())
                {
                    if (kvp.Value == pathId)
                        ReleaseBlock(kvp.Key);
                }

                staging.lookAhead = 0;
                Sessions.AddTag("paths");
            }
        }

        public static void RemovePath(string pathId)
        {
            lock (lockObj)
            {
                if (_pathProgress.TryGetValue(pathId, out var staging))
                {
                    foreach (var blockId in staging.blocks)
                    {
                        if (_blockQueues.TryGetValue(blockId, out var queue))
                        {
                            queue.Remove(pathId);
                            if (queue.Count == 0)
                                _blockQueues.Remove(blockId);
                        }
                        if (_activeBlocks.TryGetValue(blockId, out var claimingPath) && claimingPath == pathId)
                        {
                            ReleaseBlock(blockId);
                        }
                    }
                    _pathProgress.Remove(pathId);
                    _retryTimes.Remove(pathId);
                }
            }
        }

        /// <summary>
        /// Updates a path's block list (route extension). Existing claims on blocks that
        /// remain in place (the common prefix - an extend only appends a tail) are
        /// preserved so the clearance is never dropped; only blocks actually removed from
        /// the route are released. The train's current block is re-seeded if needed and
        /// the lookahead window is restored synchronously inside this call (same lock,
        /// main thread), so a train advancing right after the update never observes a gap
        /// in its clearance.
        /// </summary>
        public static void UpdatePath(string pathId, JArray newBlocksArray)
        {
            lock (lockObj)
            {
                if (!_pathProgress.TryGetValue(pathId, out var staging))
                    return;
                _retryTimes.Remove(pathId);

                var oldBlocks = staging.blocks;
                var newBlocks = newBlocksArray?.ToObject<string[]>();
                if (newBlocks == null || newBlocks.Length == 0)
                    return;

                // Longest common prefix: an extend keeps the existing route intact and
                // only adds to the tail, so everything up to `common` is unchanged.
                int common = 0;
                while (common < oldBlocks.Length && common < newBlocks.Length
                    && string.Equals(oldBlocks[common], newBlocks[common], StringComparison.Ordinal))
                    common++;

                var newSet = new HashSet<string>(newBlocks);
                for (int i = 0; i < oldBlocks.Length; i++)
                {
                    var blockId = oldBlocks[i];
                    // Blocks still in place (common prefix) keep their queue entry and claim.
                    if (i < common && newSet.Contains(blockId))
                        continue;

                    if (_blockQueues.TryGetValue(blockId, out var queue))
                    {
                        queue.Remove(pathId);
                        if (queue.Count == 0)
                            _blockQueues.Remove(blockId);
                    }
                    if (_activeBlocks.TryGetValue(blockId, out var claimingPath) && claimingPath == pathId)
                        ReleaseBlock(blockId);
                }

                // If the change reached (or passed) the train's current block, reseed from
                // the start of the (possibly rearranged) route instead of trusting the
                // preserved prefix. For a pure extend this never triggers.
                if (staging.currentBlockIndex >= common)
                {
                    staging.currentBlockIndex = 0;
                    for (int i = common; i < oldBlocks.Length; i++)
                    {
                        var blockId = oldBlocks[i];
                        if (_activeBlocks.TryGetValue(blockId, out var claimingPath) && claimingPath == pathId)
                            ReleaseBlock(blockId);
                    }
                }

                staging.blocks = newBlocks;
                staging.status = "Active";

                foreach (var blockId in newBlocks)
                {
                    var queue = GetQueue(blockId);
                    if (!queue.Contains(pathId))
                        queue.Add(pathId);
                }

                // Restore the train's own block claim and re-extend the lookahead
                // clearance synchronously via the single advancing function. Runs
                // under lockObj on the main thread, so no Process() tick can observe
                // released blocks.
                Advance(staging);
            }
        }

        /// Returns (b1Claimed, b1Index, b2Index): whether we hold a claim window,
        /// the index of the furthest contiguous claim (B1), and the next index (B2).
        /// If nothing is claimed, B1 is the current block (train location).
        private static (bool, int, int) GetClaimWindowEnd(PathStaging staging)
        {
            int b1 = staging.currentBlockIndex;
            bool claimed = false;

            for (int i = staging.currentBlockIndex + 1; i < staging.blocks.Length; i++)
            {
                if (_activeBlocks.TryGetValue(staging.blocks[i], out var claimer) && claimer == staging.pathId)
                {
                    b1 = i;
                    claimed = true;
                }
                else
                {
                    break;
                }
            }

            return (claimed, b1, b1 + 1);
        }

        /// <summary>
        /// Counts how many blocks the path has claimed strictly ahead of its
        /// current block (the contiguous lookahead window). Excludes the block
        /// the train currently occupies.
        /// </summary>
        private static int CountClaimedAhead(PathStaging staging)
        {
            var (claimed, b1Index, _) = GetClaimWindowEnd(staging);
            if (!claimed)
                return 0;
            return b1Index - staging.currentBlockIndex;
        }

        private static List<string> GetPathsWithBlockUpcoming(string blockId, string excludePathId)
        {
            var result = new List<string>();

            if (!_blockQueues.TryGetValue(blockId, out var queue))
                return result;

            foreach (var pathId in queue)
            {
                if (pathId == excludePathId)
                    continue;
                if (!_pathProgress.TryGetValue(pathId, out var other))
                    continue;
                if (other.status != "Active")
                    continue;
                if (_activeBlocks.TryGetValue(blockId, out var claimer) && claimer == pathId)
                    continue;

                bool upcoming = false;
                for (int i = other.currentBlockIndex + 1; i < other.blocks.Length; i++)
                {
                    if (other.blocks[i] == blockId)
                    {
                        upcoming = true;
                        break;
                    }
                }
                if (upcoming)
                    result.Add(pathId);
            }
            return result;
        }

        private static bool IsOpposing(PathStaging ours, PathStaging other, string b1BlockId, string b2BlockId)
        {
            int b1Idx = -1;
            int b2Idx = -1;
            for (int i = 0; i < other.blocks.Length; i++)
            {
                if (other.blocks[i] == b1BlockId) b1Idx = i;
                if (other.blocks[i] == b2BlockId) b2Idx = i;
            }

            if (b1Idx < 0 || b2Idx < 0)
                return false;

            // Opposing: they encounter B2 before B1 (they travel the shared section
            // in reverse order compared to us).
            return b2Idx < b1Idx;
        }

        /// <summary>
        /// Returns true when another active path is upcoming or opposing at the
        /// next claim-window start (ws). Mirrors the detection TryClaimFrom uses so
        /// the automatic advance can re-run the conflict-aware claim (and let
        /// CalcRange clear up to where opposing paths end) even when the lookahead
        /// ceiling or the retry timer would otherwise skip the attempt.
        /// </summary>
        private static bool HasOpposingOrNewAhead(PathStaging staging, int ws)
        {
            if (ws <= 0 || ws >= staging.blocks.Length)
                return false;

            var b1BlockId = staging.blocks[ws - 1];
            var b2BlockId = staging.blocks[ws];
            var listA = new HashSet<string>(GetPathsWithBlockUpcoming(b1BlockId, staging.pathId));
            var listB = new HashSet<string>(GetPathsWithBlockUpcoming(b2BlockId, staging.pathId));

            foreach (var p in listA.Where(x => listB.Contains(x)))
            {
                if (!_pathProgress.TryGetValue(p, out var other))
                    continue;
                if (IsOpposing(staging, other, b1BlockId, b2BlockId))
                    return true;
            }

            return listB.Any(x => !listA.Contains(x));
        }

        private static void PrunePastBlocks(PathStaging staging)
        {
            int removeCount = staging.currentBlockIndex;
            if (removeCount <= 0) return;

            var pruned = new List<string>();
            for (int i = 0; i < removeCount; i++)
                pruned.Add(staging.blocks[i]);

            staging.blocks = staging.blocks.Skip(removeCount).ToArray();
            staging.currentBlockIndex = 0;

            foreach (var blockId in pruned)
            {
                if (_blockQueues.TryGetValue(blockId, out var queue))
                {
                    queue.Remove(staging.pathId);
                    if (queue.Count == 0)
                        _blockQueues.Remove(blockId);
                }
            }

            PathingData.RemovePrefixFromPath(staging.pathId, removeCount);
        }

        /// <summary>
        /// The single advancing entry point for a path. Handles train movement
        /// (advancing currentBlockIndex when the next claimed block becomes
        /// occupied), ensures the train's own block is claimed (the seed), and
        /// extends the lookahead window conflict-aware. Used by the periodic
        /// Process() check, path creation/restore (startup check), route
        /// extension, and the lookahead grow (+ button) path.
        /// The ClaimInterval timer only paces the ordinary automatic extension so
        /// it does not all happen at once; a train advance or a conflict probe
        /// always runs immediately. The per-path lookAhead bounds the window
        /// (0 claims nothing ahead - the path only claims again with the + button).
        /// claimCap limits a single extension (the startup check passes 1 so a new
        /// path claims one section and then waits for the pacing timer).
        /// Returns true when the train advanced or a block was claimed.
        /// </summary>
        private static bool Advance(PathStaging staging, int claimCap = int.MaxValue)
        {
            var occupancy = OccupancyData.GetOccupancyData();
            bool changed = false;
            bool trainAdvanced = false;

            int nextIdx = staging.currentBlockIndex + 1;
            if (nextIdx < staging.blocks.Length)
            {
                var nextBlockId = staging.blocks[nextIdx];
                bool nextClaimedByUs = _activeBlocks.TryGetValue(nextBlockId, out var nextClaimer) && nextClaimer == staging.pathId;
                if (nextClaimedByUs && occupancy.TryGetValue(nextBlockId, out var occ) && occ == true)
                {
                    var prevBlockId = staging.blocks[staging.currentBlockIndex];
                    if (_activeBlocks.TryGetValue(prevBlockId, out var cp) && cp == staging.pathId)
                        _activeBlocks.Remove(prevBlockId);

                    trainAdvanced = true;
                    if (prevBlockId != nextBlockId)
                        SetSignalToStop(prevBlockId, staging.pathId);

                    staging.currentBlockIndex = nextIdx;
                    if (nextIdx >= staging.blocks.Length - 1)
                    {
                        staging.status = "Completed";
                        Main.DebugLog($"StagingData: path {staging.pathId} completed, cleaning up");
                    }
                    PrunePastBlocks(staging);
                    changed = true;
                    Main.DebugLog($"StagingData: path {staging.pathId} advanced to block {nextBlockId} (index {nextIdx})");
                }
            }

            if (staging.status != "Active")
                return changed;

            // Seed: ensure the train's own block is claimed. It is the train's
            // occupied block, so the occupancy break does not apply; we only
            // refuse to steal it from another active path. Skipped when the path
            // has no claim-ahead (lookAhead 0 - e.g. unclaimed via the delete
            // button), so an unclaimed path does not reclaim itself.
            if (staging.lookAhead > 0)
            {
                int cur = staging.currentBlockIndex;
                if (cur < staging.blocks.Length)
                {
                    var curBlock = staging.blocks[cur];
                    if (occupancy.TryGetValue(curBlock, out var curOcc) && curOcc == true)
                    {
                        if (!_activeBlocks.TryGetValue(curBlock, out var curClaimer))
                            ActivateBlock(curBlock, staging);
                    }
                }
            }

            // Extend the lookahead window.
            var (_, b1Index, _) = GetClaimWindowEnd(staging);
            int ws = b1Index + 1;

            if (ws >= staging.blocks.Length)
                return changed;

            bool conflictingAhead = HasOpposingOrNewAhead(staging, ws);

            bool canTry;
            int maxBlocks;

            if (trainAdvanced)
            {
                canTry = true;
                maxBlocks = staging.lookAhead - CountClaimedAhead(staging);
            }
            else
            {
                canTry = CountClaimedAhead(staging) < staging.lookAhead;
                if (canTry && _retryTimes.TryGetValue(staging.pathId, out var retryTime)
                    && DateTime.UtcNow < retryTime)
                    canTry = false;
                maxBlocks = Math.Min(staging.lookAhead - CountClaimedAhead(staging), claimCap);
            }

            // A conflict probe extends up to where opposing/upcoming paths end, but
            // only within the path's own lookahead window (0 = nothing ahead).
            bool canProbe = conflictingAhead && staging.lookAhead > 0;

            if ((canTry && maxBlocks > 0) || canProbe)
            {
                int effectiveMax = canProbe ? Math.Max(1, maxBlocks) : maxBlocks;
                var (claimed, _) = TryClaimFrom(staging, ws, effectiveMax, occupancy);
                if (claimed)
                    changed = true;

                // The timer only paces the ordinary automatic extension. A conflict
                // probe must not keep it alive - refreshing it there previously
                // locked a path out for a full interval right after the opposing
                // traffic cleared.
                if (!canProbe)
                    _retryTimes[staging.pathId] = DateTime.UtcNow + ClaimInterval;
            }

            return changed;
        }

        private static void ActivateBlock(string blockId, PathStaging staging)
        {
            var paths = PathingData.GetPaths();
            var path = paths.FirstOrDefault(p => p.Value<string>("id") == staging.pathId);
            if (path == null) return;

            var blockSignals = path["blockSignals"] as JObject;
            if (blockSignals != null && blockSignals[blockId] != null)
            {
                var sigId = blockSignals[blockId].ToString();
                Main.DebugLog($"StagingData: signal {sigId} -> Automatic for path {staging.pathId} on block {blockId}");
                SignalsShim.SetSignalMode(sigId, "Automatic");
            }

            if (OccupancyData.TryGetOwnSwitchIndex(blockId, out var jIdx) && jIdx >= 0 && jIdx < RailTrackRegistry.Instance.OrderedJunctions.Length)
            {
                var switchAssignments = path["switchAssignments"] as JObject;
                if (switchAssignments != null && switchAssignments[blockId] != null)
                {
                    var neededBranch = (byte)(switchAssignments[blockId].Value<int>());
                    var junction = RailTrackRegistry.Instance.OrderedJunctions[jIdx];
                    if (junction.selectedBranch != neededBranch)
                    {
                        Main.DebugLog($"StagingData: toggling J-{jIdx} for path {staging.pathId} on block {blockId}");
                        junction.Switch(Junction.SwitchMode.REGULAR);
                    }
                }
            }

            _activeBlocks[blockId] = staging.pathId;
            if (_blockQueues.TryGetValue(blockId, out var queue))
                queue.Remove(staging.pathId);

            Sessions.AddTag("signals");
        }

        /// <summary>
        /// Recursively walks our route forward from startIndex and returns how many
        /// blocks can be cleared before all conflicting paths have ended.
        /// Returns 0 if a claimed section or the end of our route (with opposing
        /// traffic still active) is hit before the conflicts resolve. An occupied
        /// block advances the clearance by one and the walk continues (blocked
        /// occupancy is not treated as a hard failure like a claimed one).
        /// </summary>
        private static int CalcRange(
            HashSet<string> newPaths,
            HashSet<string> opposingPaths,
            int startIndex,
            PathStaging staging,
            Dictionary<string, bool?> occupancy)
        {
            int clearCount = 0;

            for (int i = startIndex; i < staging.blocks.Length; i++)
            {
                var blockId = staging.blocks[i];

                if (_activeBlocks.TryGetValue(blockId, out var claimer) && claimer != staging.pathId)
                    return 0;

                clearCount++;

                var pathsHere = new HashSet<string>(GetPathsWithBlockUpcoming(blockId, staging.pathId));

                newPaths.RemoveWhere(p => !pathsHere.Contains(p));
                opposingPaths.RemoveWhere(p => !pathsHere.Contains(p));

                foreach (var p in pathsHere)
                {
                    if (!newPaths.Contains(p) && !opposingPaths.Contains(p))
                        newPaths.Add(p);
                }

                var ourNext = i + 1 < staging.blocks.Length ? staging.blocks[i + 1] : blockId;

                foreach (var p in newPaths.ToList())
                {
                    if (!_pathProgress.TryGetValue(p, out var other))
                    {
                        newPaths.Remove(p);
                        continue;
                    }

                    if (other.blocks[other.blocks.Length - 1] == blockId)
                    {
                        newPaths.Remove(p);
                        continue;
                    }

                    if (IsOpposing(staging, other, blockId, ourNext))
                    {
                        newPaths.Remove(p);
                        opposingPaths.Add(p);
                    }
                    else
                    {
                        newPaths.Remove(p);
                    }
                }

                opposingPaths.RemoveWhere(p =>
                {
                    if (!_pathProgress.TryGetValue(p, out var other))
                        return true;
                    return other.blocks[other.blocks.Length - 1] == blockId;
                });

                if (newPaths.Count == 0 && opposingPaths.Count == 0)
                    return clearCount;
            }

            return 0;
        }

        /// <summary>
        /// Conflict-aware claim attempt. Tries to claim blocks starting at
        /// startIndex, respecting opposing/upcoming paths and physical occupancy.
        /// When new or opposing paths are detected ahead, CalcRange walks the
        /// route and only claims up to the point where those conflicts have ended.
        /// Otherwise it fills up to maxBlocks (the path's lookahead window).
        /// Returns (success, claimedCount); claimedCount == 0 means nothing claimed.
        /// </summary>
        private static (bool, int) TryClaimFrom(
            PathStaging staging,
            int startIndex,
            int maxBlocks,
            Dictionary<string, bool?> occupancy)
        {
            if (startIndex >= staging.blocks.Length)
                return (false, 0);

            var b1BlockId = staging.blocks[Math.Max(0, startIndex - 1)];
            var b2BlockId = staging.blocks[startIndex];

            var listA = new HashSet<string>(GetPathsWithBlockUpcoming(b1BlockId, staging.pathId));
            var listB = new HashSet<string>(GetPathsWithBlockUpcoming(b2BlockId, staging.pathId));

            var opposingPaths = new HashSet<string>();
            foreach (var p in listA.Where(x => listB.Contains(x)))
            {
                if (!_pathProgress.TryGetValue(p, out var other))
                    continue;
                if (IsOpposing(staging, other, b1BlockId, b2BlockId))
                    opposingPaths.Add(p);
            }

            var newPaths = new HashSet<string>(listB.Where(x => !listA.Contains(x)));

            if (newPaths.Count > 0 || opposingPaths.Count > 0)
            {
                foreach (var p in newPaths)
                {
                    if (_activeBlocks.TryGetValue(b2BlockId, out var claimer) && claimer == p)
                        return (false, 0);
                }

                int clearCount = CalcRange(
                    new HashSet<string>(newPaths),
                    new HashSet<string>(opposingPaths),
                    startIndex,
                    staging,
                    occupancy);

                if (clearCount == 0)
                    return (false, 0);

                int claimLimit = Math.Min(clearCount, maxBlocks);
                int claimCount = 0;
                for (int i = startIndex; i < staging.blocks.Length && (i - startIndex) < claimLimit; i++)
                {
                    var blockId = staging.blocks[i];
                    if (_activeBlocks.TryGetValue(blockId, out var claimer) && claimer != staging.pathId)
                        break;
                    if (occupancy.TryGetValue(blockId, out var occ) && occ == true)
                        break;
                    ActivateBlock(blockId, staging);
                    claimCount++;
                }

                if (claimCount == 0)
                    return (false, 0);

                return (true, claimCount);
            }
            else
            {
                int bound = maxBlocks;
                int claimCount = 0;

                for (int i = startIndex; i < staging.blocks.Length; i++)
                {
                    if ((i - startIndex) >= bound)
                        break;
                    var blockId = staging.blocks[i];
                    if (_activeBlocks.ContainsKey(blockId))
                        break;
                    if (occupancy.TryGetValue(blockId, out var occ) && occ == true)
                        break;
                    ActivateBlock(blockId, staging);
                    claimCount++;
                }
                return (claimCount > 0, claimCount);
            }
        }

        private static void SetSignalToStop(string blockId, string pathId)
        {
            var paths = PathingData.GetPaths();
            var path = paths.FirstOrDefault(p => p.Value<string>("id") == pathId);
            if (path == null) return;
            var blockSignals = path["blockSignals"] as JObject;
            if (blockSignals != null && blockSignals[blockId] != null)
            {
                var sigId = blockSignals[blockId].ToString();
                Main.DebugLog($"StagingData: signal {sigId} -> Manual+stop for path {pathId} on block {blockId}");
                PathingActivation.SetSignalToStop(sigId);
            }
        }

        private static void ReleaseBlock(string blockId)
        {
            if (_activeBlocks.TryGetValue(blockId, out var pathId))
            {
                SetSignalToStop(blockId, pathId);
                _activeBlocks.Remove(blockId);
                Sessions.AddTag("signals");
            }
        }

        public static void Process()
        {
            bool changed = false;

            lock (lockObj)
            {
                foreach (var kvp in _pathProgress.ToList())
                {
                    var staging = kvp.Value;
                    if (staging.status != "Active")
                        continue;

                    // The single advancing function handles train movement, the
                    // seed, and the conflict-aware lookahead extension. Its 5s
                    // pacing timer keeps the automatic extension from all happening
                    // at once; train advances, conflict probes, and a growing
                    // lookahead (+ button) are immediate.
                    if (Advance(staging))
                        changed = true;
                }

                var completed = _pathProgress.Where(kvp => kvp.Value.status == "Completed").Select(kvp => kvp.Key).ToList();
                foreach (var pathId in completed)
                {
                    var staging = _pathProgress[pathId];
                    var lastBlock = staging.blocks[staging.blocks.Length - 1];
                    if (_activeBlocks.TryGetValue(lastBlock, out var cp) && cp == pathId)
                        ReleaseBlock(lastBlock);
                    else
                        SetSignalToStop(lastBlock, pathId);
                    _pathProgress.Remove(pathId);
                    PathingData.RemovePathFromStoredList(pathId);
                    Main.DebugLog($"StagingData: path {pathId} fully cleaned up from server");
                }

                _activeBlocks.RemoveWhere(kvp =>
                    !_pathProgress.Values.Any(p => p.pathId == kvp.Value && p.status == "Active"));
            }

            if (changed)
            {
                Sessions.AddTag("paths");
                Sessions.AddTag("signals");
            }
        }

        public static Dictionary<string, List<string>> GetStagingData()
        {
            lock (lockObj)
            {
                var occupancy = OccupancyData.GetOccupancyData();
                var result = new Dictionary<string, List<string>>();
                foreach (var kvp in _pathProgress)
                {
                    var staging = kvp.Value;
                    var blockStates = new List<string>();
                    for (int i = 0; i < staging.blocks.Length; i++)
                        blockStates.Add(GetBlockState(staging.blocks[i], i, staging, occupancy));
                    result[staging.pathId] = blockStates;
                }
                return result;
            }
        }

        public static string GetStagingStateJson()
        {
            lock (lockObj)
            {
                var occupancy = OccupancyData.GetOccupancyData();
                var result = new JObject();
                var pathsArray = new JArray();

                foreach (var kvp in _pathProgress)
                {
                    var staging = kvp.Value;
                    var pathObj = new JObject();
                    pathObj["id"] = staging.pathId;
                    pathObj["currentBlockIndex"] = staging.currentBlockIndex;
                    pathObj["status"] = staging.status;

                    var blocksArray = new JArray();
                    for (int i = 0; i < staging.blocks.Length; i++)
                    {
                        var blockId = staging.blocks[i];
                        var blockObj = new JObject();
                        blockObj["id"] = blockId;
                        blockObj["state"] = GetBlockState(blockId, i, staging, occupancy);
                        blocksArray.Add(blockObj);
                    }
                    pathObj["blocks"] = blocksArray;
                    pathsArray.Add(pathObj);
                }

                result["paths"] = pathsArray;
                return result.ToString();
            }
        }

        private static string GetBlockState(string blockId, int index, PathStaging staging, Dictionary<string, bool?> occupancy)
        {
            if (index < staging.currentBlockIndex)
            {
                if (occupancy.TryGetValue(blockId, out var occ) && occ == true)
                    return "occupied";
                return "completed";
            }

            if (index == staging.currentBlockIndex)
                return "occupied";

            if (_activeBlocks.TryGetValue(blockId, out var claimingPath))
            {
                if (claimingPath == staging.pathId)
                    return "claimed";
                return "waiting";
            }

            return "unclaimed";
        }
    }

    internal static class DictionaryExtensions
    {
        public static void RemoveWhere<K, V>(this Dictionary<K, V> dict, System.Func<KeyValuePair<K, V>, bool> predicate)
        {
            var keysToRemove = new List<K>();
            foreach (var kvp in dict)
            {
                if (predicate(kvp))
                    keysToRemove.Add(kvp.Key);
            }
            foreach (var key in keysToRemove)
                dict.Remove(key);
        }
    }
}
