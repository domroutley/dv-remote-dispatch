using DV.PointSet;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using UnityEngine;

namespace DvMod.RemoteDispatch
{
	public static class World
	{
		public readonly struct Position
		{
			public readonly float x;
			public readonly float z;

			public Position(float x, float z)
			{
				this.x = x;
				this.z = z;
			}

			public Position(Vector3 position) : this(position.x, position.z) { }
			public Position(Transform transform) : this(transform.position) { }

			public LatLon ToLatLon() => LatLon.From(this);
		}

		public readonly struct LatLon
		{
			private const int DECIMAL_PLACES = 8; // 1.11 mm
			private const float EARTH_CIRCUMFERENCE = 40e6f;
			private const float DEGREES_PER_METER = 360f / EARTH_CIRCUMFERENCE;

			public readonly float latitude;
			public readonly float longitude;

			public LatLon(float latitude, float longitude)
			{
				this.latitude = (float)Math.Round(latitude, DECIMAL_PLACES);
				this.longitude = (float)Math.Round(longitude, DECIMAL_PLACES);
			}

			public static LatLon From(Position p) => new LatLon(DEGREES_PER_METER * p.z, DEGREES_PER_METER * p.x);

			public JToken ToJson() => new JArray(latitude, longitude);
		}
	}

	public static class RailTracks
	{
		private const float SIMPLIFIED_RESOLUTION = 40f;

		private static IEnumerable<World.LatLon> NormalizeTrackPoints(IEnumerable<World.Position> positions) => positions.Select(p => p.ToLatLon());

		public static Dictionary<RailTrack, IEnumerable<World.LatLon>> GetNormalizedTrackCoordinates() =>
			GetAllTrackPoints().ToDictionary(kvp => kvp.Key, kvp => NormalizeTrackPoints(kvp.Value));

		public static Dictionary<RailTrack, IEnumerable<World.Position>> GetAllTrackPoints(float resolution = SIMPLIFIED_RESOLUTION)
		{
			if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded)
				throw new Exception("World not yet loaded");
			var tracks = Component.FindObjectsOfType<RailTrack>();
			Main.DebugLog($"Found {tracks.Length} RailTracks.");
			return tracks.ToDictionary(track => track, track => GetTrackPoints(track, resolution));
		}

		private static IEnumerable<World.Position> GetTrackPoints(RailTrack track, float resolution = SIMPLIFIED_RESOLUTION)
		{
			var pointSet = track.GetKinkedPointSet();
			EquiPointSet simplified = EquiPointSet.ResampleEquidistant(
				pointSet,
				Mathf.Min(resolution, (float)pointSet.span / 3));

			foreach (var pt in simplified.points)
				yield return new World.Position((float)pt.position.x, (float)pt.position.z);
		}

		private static string? trackPointJSON;

		private static string GenerateTrackPointJSON()
		{
			trackPointJSON = JsonConvert.SerializeObject(
				GetNormalizedTrackCoordinates().ToDictionary(
					kvp => kvp.Key.LogicTrack().ID,
					kvp => kvp.Value.Select(ll => ll.ToJson())));
			return trackPointJSON;
		}

		public static async Task<string> GetTrackPointJSON()
		{
			if (trackPointJSON != null)
				return trackPointJSON;
			if (!WorldStreamingInit.Instance)
				throw new Exception("World not yet loaded");

			if (WorldStreamingInit.IsLoaded)
				return GenerateTrackPointJSON();

			var tcs = new TaskCompletionSource<string>();
			WorldStreamingInit.LoadingFinished += () => tcs.TrySetResult(GenerateTrackPointJSON());
			if (WorldStreamingInit.IsLoaded)
				return GenerateTrackPointJSON();

			return await tcs.Task.ConfigureAwait(false);
		}
	}

	public static class Junctions
	{
		private const float CONNECTION_THRESHOLD = 1.5f;

		// point position -> list of track endpoint records that sit at that point.
		private class EndpointGroup
		{
			public readonly Vector2 point;
			public readonly List<(string trackId, bool atStart)> endpoints = new List<(string, bool)>();
			public EndpointGroup(Vector2 p) { point = p; }
		}

		private static string junctionPointJSON = string.Empty;

		public static string GetJunctionPointJSON()
		{
			if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded)
				throw new Exception("World not yet loaded");
			if (string.IsNullOrEmpty(junctionPointJSON))
			{
				junctionPointJSON = JsonConvert.SerializeObject(
					RailTrackRegistry.Instance.OrderedJunctions.Select(j =>
					{
						var moved = j.position - WorldMover.currentMove;
						return new JObject(
							new JProperty("position", new World.Position(moved.x, moved.z).ToLatLon().ToJson()),
							new JProperty("branches", j.outBranches.Select(b => b.track.LogicTrack().ID.ToString())),
							new JProperty("id", j.junctionData.junctionIdLong)
						);
					})
				);
			}
			return junctionPointJSON;
		}

		public static IEnumerable<byte> GetAllJunctionStates()
		{
			if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded)
				throw new Exception("World not yet loaded");
			return RailTrackRegistry.Instance.OrderedJunctions.Select(j => j.selectedBranch);
		}

		public static string GetJunctionStateJSON()
		{
			return JsonConvert.SerializeObject(GetAllJunctionStates());
		}

		public static Dictionary<string, JunctionGraphData> BuildTrackGraph()
		{
			if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded)
				throw new Exception("World not yet loaded");

			var junctions = RailTrackRegistry.Instance.OrderedJunctions;
			var junctionIndexMap = new Dictionary<Junction, int>();
			for (int i = 0; i < junctions.Length; i++)
				junctionIndexMap[junctions[i]] = i;

			var allTracks = Component.FindObjectsOfType<RailTrack>();

			var trackLookup = new Dictionary<string, RailTrack>();
			var endpointAdj = new Dictionary<Vector2, EndpointGroup>();
			var trackEndpointJunctions = new Dictionary<string, List<(int junctionIdx, bool atStart)>>();

			foreach (var track in allTracks)
			{
				var trackId = track.LogicTrack().ID.ToString();
				trackLookup[trackId] = track;

				var pointSet = track.GetKinkedPointSet();
				if (pointSet.points.Length < 1) continue;

				var start = pointSet.points[0].position;
				var end = pointSet.points[pointSet.points.Length - 1].position;

				AddEndpoint(endpointAdj, new Vector2((float)start.x, (float)start.z), trackId, true);
				AddEndpoint(endpointAdj, new Vector2((float)end.x, (float)end.z), trackId, false);
			}

			for (int i = 0; i < junctions.Length; i++)
			{
				var j = junctions[i];
				foreach (var b in j.outBranches)
				{
					if (b.track == null) continue;
					var tid = b.track.LogicTrack().ID.ToString();
					if (!trackEndpointJunctions.ContainsKey(tid))
						trackEndpointJunctions[tid] = new List<(int, bool)>();
					trackEndpointJunctions[tid].Add((i, b.first));
				}
				if (j.inBranch?.track != null)
				{
					var tid = j.inBranch.track.LogicTrack().ID.ToString();
					if (!trackEndpointJunctions.ContainsKey(tid))
						trackEndpointJunctions[tid] = new List<(int, bool)>();
					trackEndpointJunctions[tid].Add((i, j.inBranch.first));
				}
			}

			if (endpointAdj.Count < 2)
				throw new Exception($"BuildTrackGraph: expected >=2 endpoint groups from {allTracks.Length} tracks, got {endpointAdj.Count}");

			var trackToJunctionMap = new Dictionary<string, List<int>>();
			var portNeighborMap = new Dictionary<(int junctionIdx, string port), int>();

			for (int i = 0; i < junctions.Length; i++)
			{
				var junction = junctions[i];
				var branchTracks = new List<(string trackId, bool first, string port)>();

				for (int bi = 0; bi < junction.outBranches.Count; bi++)
				{
					var b = junction.outBranches[bi];
					if (b.track == null) continue;
					branchTracks.Add((b.track.LogicTrack().ID.ToString(), b.first, bi == 0 ? "left" : "right"));
				}
				if (junction.inBranch?.track != null)
					branchTracks.Add((junction.inBranch.track.LogicTrack().ID.ToString(), junction.inBranch.first, "common"));

				foreach (var (btId, first, port) in branchTracks)
				{
					if (!trackToJunctionMap.ContainsKey(btId))
						trackToJunctionMap[btId] = new List<int>();
					if (!trackToJunctionMap[btId].Contains(i))
						trackToJunctionMap[btId].Add(i);

					if (!trackLookup.TryGetValue(btId, out var bt)) continue;
					var ps = bt.GetKinkedPointSet();
					if (ps.points.Length < 1) continue;

					var farPos = first
						? ps.points[ps.points.Length - 1].position
						: ps.points[0].position;
					var farPoint = new Vector2((float)farPos.x, (float)farPos.z);

					var visited = new HashSet<string> { btId };
					var neighbors = TraceToJunctions(farPoint, btId, endpointAdj, trackLookup, trackEndpointJunctions, visited);

					foreach (var n in neighbors)
					{
						if (!trackToJunctionMap[btId].Contains(n))
							trackToJunctionMap[btId].Add(n);
						if (n != i && !portNeighborMap.ContainsKey((i, port)))
							portNeighborMap[(i, port)] = n;
					}
				}
			}

			var graphData = new Dictionary<string, JunctionGraphData>();

			for (int i = 0; i < junctions.Length; i++)
			{
				var junction = junctions[i];
				var movedPos = junction.position - WorldMover.currentMove;

				var outgoingTrackIds = junction.outBranches.Select(b => b.track.LogicTrack().ID.ToString()).ToList();

				var incomingTracks = new List<string>();
				foreach (var kvp in trackToJunctionMap)
				{
					if (kvp.Value.Count >= 2 && kvp.Value.Contains(i))
						incomingTracks.Add(kvp.Key);
				}

				var neighbors = new List<int>();
				var allTrackIds = new HashSet<string>(incomingTracks);
				allTrackIds.UnionWith(outgoingTrackIds);

				// A switch has at most three physical ports (common/left/right),
				// so no junction may report more than that. In dense areas
				// (e.g. the DT-SJX1 crossovers) parallel track endpoints sit so
				// close together that TraceToJunctions links a spurious fourth
				// continuation, inflating degree to 4. The genuine port targets
				// take priority; track-derived neighbors only fill up to the cap.
				const int MAX_DEGREE = 3;
				var portTargets = new List<int>();
				foreach (var port in new[] { "common", "left", "right" })
				{
					if (portNeighborMap.TryGetValue((i, port), out var pt) && !portTargets.Contains(pt))
						portTargets.Add(pt);
				}

				foreach (var trackId in allTrackIds)
				{
					if (trackToJunctionMap.TryGetValue(trackId, out var connectedJunctions))
					{
						foreach (var otherIdx in connectedJunctions)
						{
							if (otherIdx == i || neighbors.Contains(otherIdx)) continue;
							// Prefer the physical port target for this neighbor.
							if (portTargets.Contains(otherIdx))
								neighbors.Add(otherIdx);
							else if (neighbors.Count >= MAX_DEGREE)
								continue;
							else
								neighbors.Add(otherIdx);

							if (neighbors.Count >= MAX_DEGREE) break;
						}
					}
					if (neighbors.Count >= MAX_DEGREE) break;
				}

				graphData[junction.junctionData.junctionIdLong.ToString()] = new JunctionGraphData
				{
					junctionIndex = i,
					position = new World.Position(movedPos.x, movedPos.z).ToLatLon(),
					incomingTracks = incomingTracks,
					outgoingTracks = outgoingTrackIds,
					currentBranch = junction.selectedBranch,
					neighbors = neighbors,
					degree = neighbors.Count,
					commonNeighbor = portNeighborMap.TryGetValue((i, "common"), out var cn) ? cn : (int?)null,
					leftNeighbor = portNeighborMap.TryGetValue((i, "left"), out var ln) ? ln : (int?)null,
					rightNeighbor = portNeighborMap.TryGetValue((i, "right"), out var rn) ? rn : (int?)null
				};
			}

			return graphData;
		}

		private static void AddEndpoint(Dictionary<Vector2, EndpointGroup> endpointAdj, Vector2 point, string trackId, bool atStart)
		{
			if (!endpointAdj.TryGetValue(point, out var group))
			{
				group = new EndpointGroup(point);
				endpointAdj[point] = group;
			}
			group.endpoints.Add((trackId, atStart));
		}

		// Returns all endpoint groups within CONNECTION_THRESHOLD of `point`.
		// Vector2 == is exact float equality, so any geometric scattering or
		// duplicate density would have produced distinct groups; iterate all
		// candidates within range instead of relying on a single map key.
		private static List<EndpointGroup> FindEndpointGroups(Dictionary<Vector2, EndpointGroup> endpointAdj, Vector2 point, float threshold)
		{
			var thresholdSqr = threshold * threshold;
			var matches = new List<EndpointGroup>();
			foreach (var kvp in endpointAdj)
			{
				if ((kvp.Value.point - point).sqrMagnitude <= thresholdSqr)
					matches.Add(kvp.Value);
			}
			return matches;
		}

		private static List<int> TraceToJunctions(
			Vector2 farPoint,
			string originTrackId,
			Dictionary<Vector2, EndpointGroup> endpointAdj,
			Dictionary<string, RailTrack> trackLookup,
			Dictionary<string, List<(int junctionIdx, bool atStart)>> trackEndpointJunctions,
			HashSet<string> visited)
		{
			var result = new List<int>();
			var queue = new Queue<(Vector2 key, string trackId, bool atStart)>();
			queue.Enqueue((farPoint, originTrackId, false));

			while (queue.Count > 0)
			{
				var (key, prevTrackId, atStart) = queue.Dequeue();
				var connected = FindEndpointGroups(endpointAdj, key, CONNECTION_THRESHOLD);
				if (connected.Count == 0) continue;

				foreach (var group in connected)
				{
					foreach (var (ctId, ctAtStart) in group.endpoints)
					{
						if (ctId == prevTrackId) continue;
						if (!visited.Add(ctId)) continue;

						if (trackEndpointJunctions.TryGetValue(ctId, out var epJunctions))
						{
							bool found = false;
							foreach (var (jIdx, jAtStart) in epJunctions)
							{
								if (ctAtStart == jAtStart)
								{
									if (!result.Contains(jIdx))
										result.Add(jIdx);
									found = true;
								}
							}
							if (found) continue;
						}

						if (trackLookup.TryGetValue(ctId, out var ct))
						{
							var ps = ct.GetKinkedPointSet();
							if (ps.points.Length >= 1)
							{
								var otherFarPos = ctAtStart
									? ps.points[ps.points.Length - 1].position
									: ps.points[0].position;
								var otherFarPoint = new Vector2((float)otherFarPos.x, (float)otherFarPos.z);
								queue.Enqueue((otherFarPoint, ctId, ctAtStart));
							}
						}
					}
				}
			}

			return result;
		}

		public static string GetTrackGraphJSON()
		{
			return JsonConvert.SerializeObject(BuildTrackGraph());
		}

		private static Dictionary<string, List<string>>? _inboundSignalMap;
		private static readonly object _inboundSignalLock = new object();

		/// <summary>
		/// Builds a map of junctionIdLong -> list of signal IDs that are "In" signals (branch signals
		/// placed on the junction's outBranch tracks). The signals mod does not populate JunctionId
		/// for these signals, so we trace the track from each junction's outBranches to find them.
		/// </summary>
		public static Dictionary<string, List<string>> GetInboundSignalMap()
		{
			lock (_inboundSignalLock)
			{
				if (_inboundSignalMap != null) return _inboundSignalMap;
				return BuildInboundSignalMap();
			}
		}

		private static Dictionary<string, List<string>> BuildInboundSignalMap()
		{
			var map = new Dictionary<string, List<string>>();

			if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded)
			{
				Main.Warning("BuildInboundSignalMap: World not loaded yet.");
				_inboundSignalMap = map;
				return map;
			}

			var allSignals = SignalsShim.GetRawSignals();
			if (allSignals.Count == 0)
			{
				Main.DebugLog("BuildInboundSignalMap: No signals data available.");
				_inboundSignalMap = map;
				return map;
			}

			var orphanSignals = new List<(string signalId, float x, float z)>();
			foreach (var sig in allSignals)
			{
				if (!string.IsNullOrEmpty(sig.junctionId)) continue;
				orphanSignals.Add((sig.id, sig.x, sig.z));
			}

			Main.DebugLog($"BuildInboundSignalMap: {orphanSignals.Count} orphaned signals to match.");

			var junctions = RailTrackRegistry.Instance.OrderedJunctions;
			const float MATCH_THRESHOLD = 25f;
			const float MATCH_THRESHOLD_SQR = MATCH_THRESHOLD * MATCH_THRESHOLD;

			foreach (var junction in junctions)
			{
				var junctionIdLong = junction.junctionData.junctionIdLong.ToString();
				var branchTracks = new HashSet<RailTrack>();

				foreach (var branch in junction.outBranches)
				{
					if (branch?.track?.outBranch?.track == null) continue;
					branchTracks.Add(branch.track.outBranch.track);
				}

				foreach (var track in branchTracks)
				{
					var pointSet = track.GetKinkedPointSet();
					if (pointSet?.points == null || pointSet.points.Length == 0) continue;

					foreach (var (signalId, sigX, sigZ) in orphanSignals)
					{
						if (map.TryGetValue(junctionIdLong, out var existing) && existing.Contains(signalId))
							continue;

						bool matched = false;
						foreach (var pt in pointSet.points)
						{
							float dx = (float)pt.position.x - sigX;
							float dz = (float)pt.position.z - sigZ;
							if (dx * dx + dz * dz < MATCH_THRESHOLD_SQR)
							{
								matched = true;
								break;
							}
						}

						if (matched)
						{
							if (!map.TryGetValue(junctionIdLong, out var list))
							{
								list = new List<string>();
								map[junctionIdLong] = list;
							}
							list.Add(signalId);
						}
					}
				}
			}

			int totalMatched = map.Values.Sum(l => l.Count);
			Main.Log($"BuildInboundSignalMap: matched {totalMatched} In signals to {map.Count} junctions.");
			_inboundSignalMap = map;
			return map;
		}

		public static void ClearInboundSignalMap()
		{
			lock (_inboundSignalLock)
			{
				_inboundSignalMap = null;
			}
		}
	}

	public class JunctionGraphData
	{
		public int junctionIndex { get; set; }
		public World.LatLon position { get; set; } = default!;
		public List<string> incomingTracks { get; set; } = new();
		public List<string> outgoingTracks { get; set; } = new();
		public byte currentBranch { get; set; }
		public List<int> neighbors { get; set; } = new();
		public int degree { get; set; }
		public int? commonNeighbor { get; set; }
		public int? leftNeighbor { get; set; }
		public int? rightNeighbor { get; set; }
	}
}
