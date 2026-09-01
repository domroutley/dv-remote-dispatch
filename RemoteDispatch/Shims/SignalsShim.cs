using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;

namespace DvMod.RemoteDispatch
{
	internal static class SignalsShim
	{
		// Cache method infos for the API methods we want to call, so we don't have to do reflection every time.
		private static MethodInfo? _teardownMethod;
		private static MethodInfo? _getAllSignalsMethod;
		private static MethodInfo? _getSignalAspectMethod;
		private static MethodInfo? _setSignalAspectMethod;
		// SignalMode is a .NET enum (Manual/Automatic), need it for API invocation
		// Cache reflection info to avoid recompiling every call
		private static MethodInfo? _setSignalModeMethod;
		private static MethodInfo? _isTrackOccupiedMethod;
		private static MethodInfo? _getPackKeyMethod;
		private static MethodInfo? _captureSignalMethod;
		private static MethodInfo? _getSpriteManifestMethod;
		private static MethodInfo? _getSpritePngMethod;
		private static MethodInfo? _getOffSpritePngMethod;
		private static MethodInfo? _refreshSpritesMethod;

		internal static bool IsInitialized { get; private set; }

		private static Type? _signalsApiType;
		private static PropertyInfo? _isLoadedProperty;

		/// <summary>
		/// Indicates whether the active Signals backend is loaded and ready to serve requests.
		/// This is distinct from IsInitialized, which just means our shim has been set up.
		/// For the new Signals.Game backend there is no Signals.API IsLoaded flag, so the
		/// shim is considered ready once initialized and the Signals.Game manager exists.
		/// </summary>
		internal static bool IsAPILoaded
		{
			get
			{
				if (!IsInitialized) return false;

				// New-fork backend: no Signals.API IsLoaded property.
				if (_isLoadedProperty == null) return true;

				try
				{
					return _isLoadedProperty.GetValue(null) is true;
				}
				catch
				{
					return false;
				}
			}
		}

	/// <summary>
	/// Returns a dictionary of JunctionId -> list of (CurrentAspectId, Direction) for all junction signals.
	/// A junction can have up to two signals: one facing "In" and one facing "Out".
	/// Used by OccupancyData to determine block occupancy from signal aspects.
	/// </summary>
	internal static Dictionary<string, List<(string aspectId, string direction)>> GetJunctionSignalAspects()
	{
		var result = new Dictionary<string, List<(string aspectId, string direction)>>();
		if (!IsInitialized || _getAllSignalsMethod == null) return result;

		try
		{
			var signalsData = _getAllSignalsMethod.Invoke(null, null);
			if (signalsData is not Dictionary<string, object> data) return result;

		foreach (var signal in data)
		{
			var signalObject = JObject.FromObject(signal.Value);
			var signalId = signal.Key;
			var aspectId = signalObject["CurrentAspectId"]?.ToString() ?? "";

			var colonIdx = signalId.LastIndexOf(':');
			if (colonIdx <= 0)
			{
				var junctionId = signalObject["JunctionId"]?.ToString();
				var directionRaw = signalObject["Direction"]?.ToString();
				string direction = null;
				if (directionRaw == "Out" || directionRaw == "1")
					direction = "Out";
				else if (directionRaw == "In" || directionRaw == "2")
					direction = "In";
				if (string.IsNullOrEmpty(junctionId) || string.IsNullOrEmpty(direction))
					continue;

				if (!result.TryGetValue(junctionId, out var list))
				{
					list = new List<(string aspectId, string direction)>();
					result[junctionId] = list;
				}
				list.Add((aspectId, direction));
				continue;
			}

			var jId = signalId.Substring(0, colonIdx);
			var suffix = signalId.Substring(colonIdx + 1);

			string dir;
			if (suffix == "F" || suffix == "T")
				dir = "Out";
			else if (suffix.StartsWith("B"))
				dir = "In";
			else
				continue;

			if (!result.TryGetValue(jId, out var list2))
			{
				list2 = new List<(string aspectId, string direction)>();
				result[jId] = list2;
			}
			list2.Add((aspectId, dir));
		}
		}
		catch (Exception ex)
		{
			Main.Warning($"GetJunctionSignalAspects failed: {ex.Message}");
		}

		return result;
	}

	/// <summary>
	/// Returns raw signal data as a dictionary of signalId -> (Id, JunctionId, Position[x,z], CurrentAspectId).
	/// Position is in raw world coordinates (not converted to lat/lng).
	/// </summary>
	internal static List<(string id, string? junctionId, float x, float z, string aspectId)> GetRawSignals()
	{
		var result = new List<(string id, string? junctionId, float x, float z, string aspectId)>();
		if (!IsInitialized || _getAllSignalsMethod == null) return result;

		try
		{
			var signalsData = _getAllSignalsMethod.Invoke(null, null);
			if (signalsData is not Dictionary<string, object> data) return result;

			foreach (var signal in data.Values)
			{
				var signalObject = JObject.FromObject(signal);
				var id = signalObject["Id"]?.ToString() ?? "";
				var junctionId = signalObject["JunctionId"]?.ToString();
				if (string.IsNullOrEmpty(junctionId)) junctionId = null;
				var aspectId = signalObject["CurrentAspectId"]?.ToString() ?? "";

				var posArr = signalObject["Position"] as JArray;
				if (posArr == null || posArr.Count < 2) continue;

				result.Add((id, junctionId, posArr[0].Value<float>(), posArr[1].Value<float>(), aspectId));
			}
		}
		catch (Exception ex)
		{
			Main.Warning($"GetRawSignals failed: {ex.Message}");
		}

		return result;
	}

	/// <summary>
	/// Sets up the integration with the Signals mod if it's present and enabled.
		/// This should be called during the main mod's initialization.
		/// </summary>
		internal static void Initialize()
		{
			if (IsInitialized) return;

			// Check if Signals mod is present and enabled
			var signalsMod = UnityModManagerNet.UnityModManager.FindMod("DVSignals");

			Assembly? signalsAssembly = null;
			foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
			{
				try
				{
					if (asm.GetName().Name == "Signals.API")
					{
						signalsAssembly = asm;
						break;
					}
				}
				catch (Exception ex)
				{
					Main.DebugLog($"Error checking assembly '{asm.GetName().Name}': {ex.Message}");
				}
			}

			try
			{
				if (signalsMod == null || !signalsMod.Enabled)
				{
					Main.Warning("Signals mod not found or not enabled, signal integration disabled.");
					return;
				}

				// Two Signals mods share the "DVSignals" Id:
				//  - old fork: version "1.1.3-mp"/"1.1.4-mp" ships Signals.API.dll -> RemoteDispatch.SignalsMP.dll
				//  - new fork: version "1.0.0" (WhistleWiz/dv-signals, no API) -> RemoteDispatch.Signals.dll
				// Discriminate by the "-mp" suffix on the installed mod version, falling back to
				// presence of the Signals.API assembly if the version string is ambiguous.
				bool usesApi = !string.IsNullOrEmpty(signalsMod.Info?.Version) &&
							   signalsMod.Info.Version.IndexOf("-mp", StringComparison.OrdinalIgnoreCase) >= 0;
				// If the version string is ambiguous (no "-mp" marker) but a loaded
				// Signals.API assembly exists, it's the old fork. Otherwise the new
				// fork (Signals.Game, no API) is assumed and usesApi stays false.
				if (!usesApi && signalsAssembly != null)
					usesApi = true;
				if (!usesApi)
				{
					Main.Log($"Signals mod version '{signalsMod.Info.Version}' detected, using Signals.Game bridge (RemoteDispatch.Signals.dll).");
					_signalsApiType = null;
				}
				else
				{
					Main.Log($"Signals mod version '{signalsMod.Info.Version}' detected, using Signals.API bridge (RemoteDispatch.SignalsMP.dll).");
					_signalsApiType = signalsAssembly?.GetType("Signals.API.SignalsAPI");
				}
				_isLoadedProperty = _signalsApiType?.GetProperty("IsLoaded", BindingFlags.Public | BindingFlags.Static);

				var bridgeDll = usesApi ? "RemoteDispatch.SignalsMP.dll" : "RemoteDispatch.Signals.dll";
				var path = Path.Combine(Main.mod!.Path, bridgeDll);

				if (!File.Exists(path))
				{
					Main.Warning($"{bridgeDll} not found, signal integration disabled.");
					return;
				}

				var integrationAssembly = Assembly.LoadFile(path);
				var bootstrap = integrationAssembly.GetType("DvMod.RemoteDispatch.Signals.Bootstrap");

				if (bootstrap == null)
				{
					Main.Warning($"Failed to find DvMod.RemoteDispatch.Signals.Bootstrap, signal integration disabled.");
					return;
				}

				var initMethod = bootstrap.GetMethod("Initialize", BindingFlags.Public | BindingFlags.Static);
				// Load reflection-wrapped methods from the Bootstrap class in RemoteDispatch.Signals
				// This preserves the dependency chain: SignalsAPI → RemoteDispatch.Signals → RemoteDispatch.Shims
				_teardownMethod = bootstrap.GetMethod("Teardown", BindingFlags.Public | BindingFlags.Static);
				_getAllSignalsMethod = bootstrap.GetMethod("GetAllSignals", BindingFlags.Public | BindingFlags.Static);
				_getSignalAspectMethod = bootstrap.GetMethod("GetSignalAspect", BindingFlags.Public | BindingFlags.Static);
				_setSignalAspectMethod = bootstrap.GetMethod("SetSignalAspect", BindingFlags.Public | BindingFlags.Static);

			// Retrieve SetSignalMode method from Bootstrap (in RemoteDispatch.Signals DLL)
			// This maintains the same dependency chain as SetSignalAspect:
			// Signals.API → RemoteDispatch.Signals (bridge logic) → RemoteDispatch.Shims (reflection wrapper)
			_setSignalModeMethod = bootstrap.GetMethod("SetSignalMode", BindingFlags.Public | BindingFlags.Static);
			_isTrackOccupiedMethod = bootstrap.GetMethod("IsTrackOccupied", BindingFlags.Public | BindingFlags.Static);
			_getPackKeyMethod = bootstrap.GetMethod("GetPackKey", BindingFlags.Public | BindingFlags.Static);
			_captureSignalMethod = bootstrap.GetMethod("CaptureSignal", BindingFlags.Public | BindingFlags.Static);
			_getSpriteManifestMethod = bootstrap.GetMethod("GetSpriteManifest", BindingFlags.Public | BindingFlags.Static);
			_getSpritePngMethod = bootstrap.GetMethod("GetSpritePng", BindingFlags.Public | BindingFlags.Static);
			_getOffSpritePngMethod = bootstrap.GetMethod("GetOffSpritePng", BindingFlags.Public | BindingFlags.Static);
			_refreshSpritesMethod = bootstrap.GetMethod("RefreshSprites", BindingFlags.Public | BindingFlags.Static);

				PackTableStore.TableDirectory = Path.Combine(Main.mod!.Path, "signalpacks");

				initMethod?.Invoke(null, new object[]
				{
					new Action<string>(msg => Main.Log(msg)),
					new Action<string>(msg => Main.DebugLog(msg)),
					new Action<string>(msg => Main.Warning(msg)),
					new Action<string, string>((signalId, aspect) => {
						Main.DebugLog($"Signals Action triggered: Aspect changed: {signalId} -> {aspect}, pushing update");
						Sessions.AddTag("signals");
						// Distant signals upstream of this one update automatically in-game, but their
						// SignalAspectChanged event may fire after the client already consumed the first
						// "signals" tag and took a snapshot - leaving the Distant icon stale with no
						// follow-up push ever arriving. Schedule a second push so any cascaded Distant
						// signal change always reaches connected clients.
						System.Threading.Tasks.Task.Delay(200).ContinueWith(_ => Sessions.AddTag("signals"));
						RecordPackAspect(signalId, aspect);
					}),
					new Action<string, string>((signalId, mode) => {
						Main.DebugLog($"Signals Action triggered: Mode changed: {signalId} -> {mode}, pushing update");
						Sessions.AddTag("signals");
					}),

				});

				// Load any persisted pack table so the frontend's initial /signalpack fetch has data.
				// Must run AFTER initMethod: Bootstrap.GetPackKey() requires the bridge to exist.
				try
				{
					var key = _getPackKeyMethod.Invoke(null, null) as string;
					if (!string.IsNullOrEmpty(key))
					{
						PackTableStore.Load(key);
						s_currentPackKey = key;
					}
				}
				catch (Exception ex)
				{
					Main.Warning($"Failed to load pack table at startup: {ex.Message}");
				}

				IsInitialized = true;
				Main.Log("Signals integration loaded.");
			}
			catch (Exception ex)
			{
				Main.Warning($"Failed to load Signals integration.\r\n{ex.Message}\r\n{ex.StackTrace}");
			}
		}

		/// <summary>
		/// Passes through the teardown call to the Signals integration, if it was initialized. This should be called during the main mod's shutdown to clean up any handlers in the Signals mod.
		/// </summary>
		internal static void Teardown()
		{
			if (!IsInitialized) return;

			try
			{
				// Persist any table state still held back by the throttled flush.
				PackTableStore.Flush();
			}
			catch (Exception ex)
			{
				Main.Warning($"Failed to flush signal pack table on teardown: {ex.Message}");
			}

			try
			{
				// Do the teardown in a try/catch to avoid any exceptions from preventing the rest of the mod from unloading properly.
				_teardownMethod?.Invoke(null, null);
			}
			catch (Exception ex)
			{
				Main.Warning($"Failed to teardown Signals integration.\r\n{ex.Message}\r\n{ex.StackTrace}");
			}

			_teardownMethod = null;
			IsInitialized = false;
		}

		/// <summary>
		/// Returns all signals with their positions converted to lat/lng and adjusted for the WorldMover offset.
		/// If the Signals mod is not present or there is no signals data available, returns an empty JObject.
		/// </summary>
		/// <returns></returns>
		public static JToken? GetAllSignalsData()
		{
			try
			{
				var signalsData = _getAllSignalsMethod?.Invoke(null, null);

				if (signalsData is Dictionary<string, object> data)
				{
					var minimalData = SignalsShimHelpers.MinimalSignalDataProjection.Create(data);

					// Assign junctionId and direction from signal ID suffix:
					// Format: {junctionId}:F  -> Out signal
					//         {junctionId}:B1 -> LeftIn signal
					//         {junctionId}:B2 -> RightIn signal
					// Out signals have no ':' suffix — they already have JunctionId and Direction from the API
					int suffixMatched = 0;
					int noColon = 0;
					foreach (var kv in minimalData)
					{
						var sig = kv.Value;
						var signalId = kv.Key;
						var colonIdx = signalId.LastIndexOf(':');
						if (colonIdx <= 0)
						{
							noColon++;
							continue;
						}

						var prefix = signalId.Substring(0, colonIdx);
						var suffix = signalId.Substring(colonIdx + 1);

						sig.JunctionId = prefix;
						if (suffix == "F" || suffix == "T")
							sig.Direction = "Out";
						else if (suffix.StartsWith("B"))
							sig.Direction = "In";
						suffixMatched++;
					}

					var jMinimalData = JObject.FromObject(minimalData);
					return jMinimalData;
				}

				Main.DebugLog("Signals mod not available or no signals data");
				return new JObject();
			}
			catch (Exception ex)
			{
				// Never let a signal-data failure break the HTTP response: return an
				// empty object (valid JSON) instead of an empty body, which the
				// frontend would choke on with "Unexpected end of JSON input".
				Main.Warning($"GetAllSignalsData failed: {ex.Message}\n{ex.StackTrace}");
				return new JObject();
			}
		}

		internal static string? GetSignalAspect(string signalId) =>
			_getSignalAspectMethod?.Invoke(null, new object[] { SignalsShimHelpers.StripSignalPrefix(signalId) }) as string;

		internal static bool SetSignalAspect(string signalId, string aspect) =>
			_setSignalAspectMethod?.Invoke(null, new object[] { SignalsShimHelpers.StripSignalPrefix(signalId), aspect }) is true;

		// Wrapper to expose Signals.API's SetSignalMode through reflection.
		// Accepts string mode (e.g. "Manual" or "Automatic"), forwards to RemoteDispatch.Signals.SignalsBridge.SetSignalMode().
		// Returns true on success, false on failure or 404 from API side.
		internal static bool SetSignalMode(string signalId, string mode) =>
			_setSignalModeMethod?.Invoke(null, new object[] { SignalsShimHelpers.StripSignalPrefix(signalId), mode }) is true;

		/// <summary>
		/// Checks whether the given RailTrack has any trains physically on it.
		/// </summary>
		internal static bool IsTrackOccupied(RailTrack track)
		{
			if (!IsInitialized || _isTrackOccupiedMethod == null) return false;
			try
			{
				return _isTrackOccupiedMethod.Invoke(null, new object[] { track }) is true;
			}
			catch (Exception ex)
			{
				Main.Warning($"IsTrackOccupied failed: {ex.Message}");
				return false;
			}
		}

		/// <summary>
		/// Returns the current pack table JSON for the /signalpack endpoint, or "{}" if unavailable.
		/// </summary>
		internal static string GetPackTableJson()
		{
			return PackTableStore.GetCurrentJson() ?? "{}";
		}

		/// <summary>
		/// Returns the HUD sprite manifest for the /signal/sprites endpoint: which aspect
		/// ids and signal types have cached sprites, mapped to their serving URLs.
		/// </summary>
		internal static string GetSpriteManifestJson()
		{
			var result = new JObject();
			if (!IsInitialized || _getSpriteManifestMethod == null)
			{
				return JsonConvert.SerializeObject(result);
			}

			try
			{
				var manifest = _getSpriteManifestMethod.Invoke(null, null);
				var j = manifest != null ? JObject.FromObject(manifest) : new JObject();

				// New shape: { Aspects: { id: { W, H } }, Off: { type: { W, H } } }.
				// Each entry becomes { u: url, w, h } so the frontend can size icons
				// proportionally. Also tolerates the legacy string-array shape (url only).
				var aspects = new JObject();
				var aspectTok = j["Aspects"];
				if (aspectTok is JObject aspectObj)
				{
					foreach (var kv in aspectObj)
					{
						var aspectId = kv.Key;
						if (string.IsNullOrEmpty(aspectId)) continue;
						aspects[aspectId] = SpriteEntry(aspectId, kv.Value, $"/signal/sprite/{aspectId}");
					}
				}
				else if (aspectTok is JArray aspectArr)
				{
					foreach (var id in aspectArr)
					{
						var aspectId = id.ToString();
						if (!string.IsNullOrEmpty(aspectId)) aspects[aspectId] = $"/signal/sprite/{aspectId}";
					}
				}

				var off = new JObject();
				var offTok = j["Off"];
				if (offTok is JObject offObj)
				{
					foreach (var kv in offObj)
					{
						var typeName = kv.Key;
						if (string.IsNullOrEmpty(typeName)) continue;
						off[typeName] = SpriteEntry(typeName, kv.Value, $"/signal/sprite/off/{typeName}");
					}
				}
				else if (offTok is JArray offArr)
				{
					foreach (var type in offArr)
					{
						var typeName = type.ToString();
						if (!string.IsNullOrEmpty(typeName)) off[typeName] = $"/signal/sprite/off/{typeName}";
					}
				}

				result["Aspects"] = aspects;
				result["Off"] = off;
			}
			catch (Exception ex)
			{
				Main.Warning($"GetSpriteManifestJson failed: {ex.Message}");
			}

			// Kick off a main-thread sprite capture pass so the cache populates on demand
			// (not just on aspect changes). The bridge throttles the actual sweep, and the
			// next manifest fetch includes any newly captured sprites.
			try
			{
				if (_refreshSpritesMethod != null)
				{
					Updater.RunOnMainThread(() =>
					{
						try { _refreshSpritesMethod.Invoke(null, null); }
						catch (Exception ex) { Main.DebugLog($"RefreshSprites failed: {ex.Message}"); }
					});
				}
			}
			catch (Exception ex)
			{
				Main.DebugLog($"Failed to schedule RefreshSprites: {ex.Message}");
			}

			return JsonConvert.SerializeObject(result);
		}

		/// <summary>
		/// Builds a sprite manifest entry: { u: url, w, h } from a dims object { W, H },
		/// falling back to { u: url } when no dimensions are available.
		/// </summary>
		private static JObject SpriteEntry(string key, JToken? dims, string url)
		{
			var entry = new JObject { ["u"] = url };
			if (dims is JObject d)
			{
				var w = d["W"]?.Value<int?>() ?? 0;
				var h = d["H"]?.Value<int?>() ?? 0;
				if (w > 0 && h > 0)
				{
					entry["w"] = w;
					entry["h"] = h;
				}
			}
			return entry;
		}

		/// <summary>
		/// Returns the cached PNG bytes for an aspect id, or null if unavailable.
		/// </summary>
		internal static byte[]? GetSpritePng(string aspectId)
		{
			if (!IsInitialized || _getSpritePngMethod == null || string.IsNullOrEmpty(aspectId)) return null;
			try
			{
				return _getSpritePngMethod.Invoke(null, new object[] { aspectId }) as byte[];
			}
			catch (Exception ex)
			{
				Main.Warning($"GetSpritePng({aspectId}) failed: {ex.Message}");
				return null;
			}
		}

		/// <summary>
		/// Returns the cached PNG bytes for a signal type's off-state sprite, or null.
		/// </summary>
		internal static byte[]? GetOffSpritePng(string type)
		{
			if (!IsInitialized || _getOffSpritePngMethod == null || string.IsNullOrEmpty(type)) return null;
			try
			{
				return _getOffSpritePngMethod.Invoke(null, new object[] { type }) as byte[];
			}
			catch (Exception ex)
			{
				Main.Warning($"GetOffSpritePng({type}) failed: {ex.Message}");
				return null;
			}
		}

		private static string? s_currentPackKey;

		/// <summary>
		/// Triggered on every signal aspect change (on the main thread). Captures the signal's
		/// lamp geometry + the observed aspect into the persistent pack table, then pushes a
		/// "signalpack" update to clients when the table grew.
		/// </summary>
		private static void RecordPackAspect(string signalId, string aspect)
		{
			if (!IsInitialized || _getPackKeyMethod == null || _captureSignalMethod == null) return;
			if (string.IsNullOrEmpty(signalId) || string.IsNullOrEmpty(aspect) || aspect == "OFF") return;

			// The bridge's AspectChanged event fires on the Unity main thread (both the new
			// SignalManager.AspectChanged and the -mp SignalsAPI.SignalAspectChanged). CaptureSignal
			// reads Unity objects (transforms, colors) so it must run there; call directly.
			RecordPackAspectCore(signalId, aspect);
		}

		private static void RecordPackAspectCore(string signalId, string aspect)
		{
			try
			{
				if (_getPackKeyMethod == null || _captureSignalMethod == null) return;

				var key = _getPackKeyMethod.Invoke(null, null) as string;
				if (string.IsNullOrEmpty(key)) return;

				// Pack switch (or first capture): swap to the new table.
				if (s_currentPackKey != key)
				{
					PackTableStore.Flush();
					PackTableStore.Load(key);
					s_currentPackKey = key;
				}

				var capture = _captureSignalMethod.Invoke(null, new object[] { signalId });
				if (capture == null) return;

				var jobj = Newtonsoft.Json.Linq.JObject.FromObject(capture);
				var lamps = ParseLamps(jobj["Lamps"]);
				var lit = ParseNameArray(jobj["Lit"]);
				var blinking = ParseNameArray(jobj["Blinking"]);
				var disallowPassing = jobj["DisallowPassing"]?.Value<bool>() ?? false;

				var changed = PackTableStore.Upsert(signalId, lamps, aspect, disallowPassing, lit, blinking);
				if (!changed) return;

				// Throttled: a pathing-mode sweep changes hundreds of aspects in one
				// frame, so one disk flush per change would stall the main thread.
				PackTableStore.FlushThrottled();
				Sessions.AddTag("signalpack");
			}
			catch (Exception ex)
			{
				Main.Warning($"RecordPackAspect({signalId}, {aspect}) failed: {ex.Message}");
			}
		}

		private static SignalLamp[]? ParseLamps(Newtonsoft.Json.Linq.JToken? lampsToken)
		{
			if (lampsToken == null || lampsToken is not Newtonsoft.Json.Linq.JArray array) return null;
			if (array.Count == 0) return null;

			var lamps = new SignalLamp[array.Count];
			for (int i = 0; i < array.Count; i++)
			{
				var item = array[i];
				lamps[i] = new SignalLamp
				{
					Name = item["Name"]?.ToString() ?? string.Empty,
					Colour = item["Colour"]?.ToString() ?? string.Empty,
					Position = item["Position"]?.ToObject<double[]>(),
				};
			}
			return lamps;
		}

		private static string[] ParseNameArray(Newtonsoft.Json.Linq.JToken? token)
		{
			if (token == null || token is not Newtonsoft.Json.Linq.JArray array) return Array.Empty<string>();
			var names = new string[array.Count];
			for (int i = 0; i < array.Count; i++) names[i] = array[i].ToString();
			return names;
		}
	}
}
