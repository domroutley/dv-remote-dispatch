using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;

namespace DvMod.RemoteDispatch
{
	public class HttpServer : MonoBehaviour
	{
		private static GameObject? rootObject;
		private readonly HttpListener listener = new HttpListener();
		private static int _requestCount = 0;
		private static int _render200Count = 0;

		public async void Start()
		{
			if (!listener.IsListening)
			{
				listener.Prefixes.Add($"http://*:{Main.settings.serverPort}/");
				listener.AuthenticationSchemes = AuthenticationSchemes.Anonymous | AuthenticationSchemes.Basic;
				listener.Realm = "DV Remote Dispatch";
				Main.Log($"Starting HTTP server on port {Main.settings.serverPort}");
				listener.Start();
			}

			while (listener.IsListening)
			{
				try
				{
					var context = await listener.GetContextAsync().ConfigureAwait(true);
					if (CheckAuthentication(context))
					{
						_ = Task.Run(async () =>
						{
							try
							{
								await HandleRequest(context).ConfigureAwait(false);
							}
							catch (Exception e)
							{
								Main.Log($"Exception while handling HTTP request ({context.Request.Url}): {e}");
							}
						});
					}
					else
					{
						context.Response.Headers.Add("WWW-Authenticate", "Basic");
						RenderEmpty(context, 401);
					}
				}
				catch (ObjectDisposedException e) when (e.ObjectName == "listener")
				{
					// ignore when OnDestroy() is called to shutdown the server
				}
			}
		}

		public void OnDestroy()
		{
			if (listener.IsListening)
			{
				Main.Log("Stopping HTTP server");
				listener.Stop();
				listener.Prefixes.Clear();
			}
		}

		private static bool CheckAuthentication(HttpListenerContext context)
		{
			string serverPassword = Main.settings.serverPassword;
			return context.User?.Identity is HttpListenerBasicIdentity identity && (string.IsNullOrEmpty(serverPassword) || identity.Password == serverPassword);
		}

		private static async Task HandleRequest(HttpListenerContext context)
		{
			var request = context.Request;
			if (request.Url.Segments.Length < 2)
			{
				context.Response.ContentType = ContentTypes.Html;
				RenderResource(context, "frontend.index.html");
				return;
			}

		switch (request.Url.Segments[1].TrimEnd('/'))
		{
		case "car":
			Main.DebugLog("/car endpoint hit");
			HandleCarRequest(context);
			break;
		case "junction":
			HandleJunctionRequest(context);
			Main.DebugLog("/junction endpoint hit");
			break;
		case "player":
			Main.DebugLog("/player endpoint hit");
			if(!Main.settings.permissions.CanSeePlayerBlips(context.User.Identity.Name))
			{
				RenderEmpty(context, 200);
				break;
			}
			var playerJson = PlayerData.GetPlayerDataJson();
			if (playerJson != null)
				Render200(context, ContentTypes.Json, playerJson);
			else
				RenderEmpty(context, 500);
			break;
		case "res":
			Main.DebugLog("/res endpoint hit");
			RenderResource(context);
			break;
		case "track":
			Main.DebugLog("/track endpoint hit");
			Render200(context, ContentTypes.Json, await RailTracks.GetTrackPointJSON().ConfigureAwait(false));
			break;
		case "graph":
			Main.DebugLog("/graph endpoint hit");
			Render200(context, ContentTypes.Json, Junctions.GetTrackGraphJSON());
			break;
		case "updates":
			if (++_requestCount % 1000 == 0)
				Main.DebugLog($"/updates endpoint hit x{_requestCount}");
			await HandleUpdatesRequest(context).ConfigureAwait(false);
			break;
		case "signals":
			Main.DebugLog("/signals endpoint hit");
			string signalsJson = Main.settings.featureFlags.enableSignals ? JsonConvert.SerializeObject(SignalsShim.GetAllSignalsData()) : JsonConvert.SerializeObject(new JObject());
			Render200(context, ContentTypes.Json, signalsJson);
			break;
		case "signalpack":
			Main.DebugLog("/signalpack endpoint hit");
			Render200(context, ContentTypes.Json, Main.settings.featureFlags.enableSignals ? SignalsShim.GetPackTableJson() : "{}");
			break;
		case "occupancy":
			if (context.Request.HttpMethod == "POST")
			{
				await HandleOccupancyMapRequest(context).ConfigureAwait(false);
			}
			else
			{
				Render200(context, ContentTypes.Json, OccupancyData.GetOccupancyJSON());
			}
			break;
		case "path":
			Main.DebugLog("/path endpoint hit");
			await HandlePathRequest(context);
			break;
		case "staging":
			Main.DebugLog("/staging endpoint hit");
			Render200(context, ContentTypes.Json, StagingData.GetStagingStateJson());
			break;
		case "pathing":
			Main.DebugLog("/pathing endpoint hit");
			await HandlePathingActivateRequest(context);
			break;
		case "signal":
			Main.DebugLog("/signal endpoint hit");
			await HandleSignalRequest(context);
			break;
		case "modconfig":
			HandleModConfigRequest(context);
			break;
		default:
			Main.DebugLog("unknown endpoint hit");
			RenderEmpty(context, 404);
			break;
		}
		}

		private static async void HandleCarRequest(HttpListenerContext context)
		{
			var segments = context.Request.Url.Segments;
			if (segments.Length == 2 && context.Request.HttpMethod == "GET")
			{
				var allCarDataJson = CarData.GetAllCarDataJson(Main.settings.permissions.CanSeeLocomotives(context.User.Identity.Name));
				Render200(context, allCarDataJson);
				return;
			}

			if (segments.Length == 3 && context.Request.HttpMethod == "GET")
			{
				var carGuid = segments[2].TrimEnd('/');
				var carDataJson = CarData.GetCarGuidDataJson(carGuid);
				if (carDataJson == null)
					RenderEmpty(context, 404);
				else
					Render200(context, carDataJson);
				return;
			}

			if (segments.Length == 4 && segments[3] == "control" && context.Request.HttpMethod == "POST")
			{
				var carGuid = segments[2].TrimEnd('/');
				var controller = LocoControl.GetLocoController(carGuid);
				if (controller == null)
				{
					RenderEmpty(context, 404);
					return;
				}
				if (!Main.settings.permissions.HasLocoControlPermission(context.User.Identity.Name))
				{
					RenderEmpty(context, 403);
					return;
				}
				var success = await Updater.RunOnMainThread(() =>
					LocoControl.RunCommand(controller, context.Request.QueryString)
				).ConfigureAwait(false);
				RenderEmpty(context, success ? 204 : 400);
			}
			RenderEmpty(context, 404);
		}

		private static async Task HandleSignalRequest(HttpListenerContext context)
		{
			var url = context.Request.Url;
			var segments = url.Segments;

			// HUD sprite endpoints (pictures shown when hovering a signal in-game).
			// /signal/sprites                    -> JSON manifest of available sprites
			// /signal/sprite/{aspectId}          -> PNG of that aspect's sprite
			// /signal/sprite/off/{type}          -> PNG of that signal type's off sprite
			if (context.Request.HttpMethod == "GET" && segments.Length >= 3
				&& segments[2].TrimEnd('/').Equals("sprites", StringComparison.OrdinalIgnoreCase))
			{
				Render200(context, ContentTypes.Json, Main.settings.featureFlags.enableSignals ? SignalsShim.GetSpriteManifestJson() : "{}");
				return;
			}

			if (context.Request.HttpMethod == "GET" && segments.Length >= 3
				&& segments[2].TrimEnd('/').Equals("sprite", StringComparison.OrdinalIgnoreCase))
			{
				if (!Main.settings.featureFlags.enableSignals)
				{
					RenderEmpty(context, 404);
					return;
				}

				if (segments.Length >= 4 && segments[3].TrimEnd('/').Equals("off", StringComparison.OrdinalIgnoreCase) && segments.Length >= 5)
				{
					var type = segments[4].TrimEnd('/');
					var offPng = SignalsShim.GetOffSpritePng(type);
					if (offPng == null)
					{
						RenderEmpty(context, 404);
						return;
					}
					Render200(context, ContentTypes.Png, offPng);
					return;
				}

				if (segments.Length >= 4)
				{
					var aspectId = segments[3].TrimEnd('/');
					var png = SignalsShim.GetSpritePng(aspectId);
					if (png == null)
					{
						RenderEmpty(context, 404);
						return;
					}
					Render200(context, ContentTypes.Png, png);
					return;
				}

				RenderEmpty(context, 404);
				return;
			}

			if (segments.Length == 3 && segments[2].TrimEnd('/').Equals("entry", StringComparison.OrdinalIgnoreCase) && context.Request.HttpMethod == "POST")
			{
				HandleSignalEntryRequest(context);
				return;
			}

			if (segments.Length < 3 || !segments[2].TrimEnd('/').Equals("control", StringComparison.OrdinalIgnoreCase))
			{
				Main.Warning($"Invalid signal control request URL: {url}");
				Main.DebugLog($"Number of URL segments: {segments.Length}");
				Main.DebugLog($"First URL segment (should be host): {(segments.Length >= 1 ? segments[0] : "N/A")}");
				Main.DebugLog($"Second URL segment (should be 'signal'): {(segments.Length >= 2 ? segments[1] : "N/A")}");
				Main.DebugLog($"Third URL segment (should be signal ID): {(segments.Length >= 3 ? segments[2] : "N/A")}");
				Main.DebugLog($"Fourth URL segment (should be 'control'): {(segments.Length >= 4 ? segments[3] : "N/A")}");
				RenderEmpty(context, 404);
				return;
			}

			if (!Main.settings.permissions.HasSignalControlPermission(context.User.Identity.Name))
			{
				RenderEmpty(context, 403);
				return;
			}

			bool success = true;
			bool bodyRead = false;
			string? mode = null;
			string? aspect = null;
			string? signalId = null;

			try
			{
				const int maxBodySize = 524288;
				using var stream = context.Request.InputStream;
				var buffer = new byte[8192];
				int totalRead = 0;

				while (stream.CanRead)
				{
					int 					bytesRead = stream.Read(buffer, 0, buffer.Length);
					if (bytesRead == 0) break;
					
					totalRead += bytesRead;
					if (totalRead > maxBodySize)
					{
						throw new Exception("Request body too large");
					}
				}

				string? bodyText = Encoding.UTF8.GetString(buffer, 0, totalRead);

				if (!string.IsNullOrEmpty(bodyText))
				{
					var requestData = JObject.Parse(bodyText);
					bodyRead = true;

					if (requestData.TryGetValue("signalId", out JToken? idToken))
					{
						signalId = idToken.Value<string?>();
					}

					if (requestData.TryGetValue("mode", out JToken? modeToken))
					{
						mode = modeToken.Value<string?>();
					}
					else if (requestData.TryGetValue("aspect", out JToken? aspectToken))
					{
						aspect = aspectToken.Value<string?>();
					}
				}

				if (string.IsNullOrEmpty(signalId))
				{
					Main.Warning("Signal control request missing 'signalId' in body");
					RenderEmpty(context, 400);
					return;
				}

				if (mode != null)
				{
					Main.DebugLog($"Setting signal {signalId} mode to {mode}");
					// Signal mutation must happen on the Unity main thread.
					bool result = await Updater.RunOnMainThread(() => SignalsShim.SetSignalMode(signalId!, mode!)).ConfigureAwait(false);

					if (!result && SignalsShim.IsInitialized == false)
					{
						Main.Warning($"[SIGNAL] Integration not initialized - cannot set mode: {mode}/{signalId}");
						Main.DebugLog("  -> Check that DVSignals mod is enabled in GameMods list");
					}
					else if (!result && SignalsShim.IsInitialized == true)
					{
						Main.Warning($"[SIGNAL] API call failed: signal={signalId}, mode={mode}");
						Main.DebugLog("  -> Check Signal exists, spelling correct, aspect not already set");
					}

					success = result;
				}
				else if (aspect != null)
				{
					Main.DebugLog($"Setting signal {signalId} aspect to {aspect}");
					// Signal mutation must happen on the Unity main thread.
					bool result2 = await Updater.RunOnMainThread(() => SignalsShim.SetSignalAspect(signalId!, aspect!)).ConfigureAwait(false);

					if (!result2)
					{
						Main.Warning($"[SIGNAL] API call failed: signal={signalId}, aspect={aspect}");
					}

					success &= result2;
				}

				if (!bodyRead)
				{
					Main.Warning($"Signal control request lacks 'mode' or 'aspect'): {url}");
				}
			}
			catch (Exception e)
			{
				Main.Warning($"Failed to parse signal control request body: {e.Message}");
				success = false;
			}

			RenderEmpty(context, success ? 204 : 400);
		}

		// POSTs of the sidebar signal editor: body is
		// {"signals": ["id", ...], "entry": {"Lamps": [{Name, Colour, Shape, Grid, Position?}],
		//   "Aspects": { "A1": { DisallowPassing, Lit, Blinking } }}}.
		// Replaces the lamps and aspects of every listed signal in the pack table, persists it,
		// and pushes a "signalpack" update to the clients.
		private static void HandleSignalEntryRequest(HttpListenerContext context)
		{
			Main.DebugLog("/signal/entry endpoint hit");
			if (!Main.settings.featureFlags.enableSignals)
			{
				RenderEmpty(context, 404);
				return;
			}

			if (!Main.settings.permissions.HasSignalControlPermission(context.User.Identity.Name))
			{
				RenderEmpty(context, 403);
				return;
			}

			const int maxBodySize = 65536;
			const int maxSignals = 512;
			const int maxLamps = 32;
			const int maxAspects = 64;
			const int maxNames = 128;
			const int maxNameLength = 64;
			const int maxGridExtent = 15;

			try
			{
				var bodyText = ReadRequestBody(context.Request.InputStream, maxBodySize);
				if (string.IsNullOrEmpty(bodyText))
				{
					Main.Warning("Signal entry request with empty body");
					RenderEmpty(context, 400);
					return;
				}

				var data = JObject.Parse(bodyText);
				if (data["signals"] is not JArray signals || data["entry"] is not JObject entryData)
				{
					Main.Warning("Signal entry request missing 'signals' or 'entry'");
					RenderEmpty(context, 400);
					return;
				}

				var signalIds = new List<string>();
				foreach (var token in signals)
				{
					if (token is not JValue value || value.Type != JTokenType.String)
						throw new ArgumentException("'signals' entries must be strings");
					var id = value.ToString();
					if (string.IsNullOrEmpty(id))
						throw new ArgumentException("empty signal id in 'signals'");
					signalIds.Add(id);
				}
				if (signalIds.Count == 0 || signalIds.Count > maxSignals)
					throw new ArgumentException($"unsupported 'signals' count: {signalIds.Count}");

				if (entryData["Lamps"] is not JArray lampsData || lampsData.Count > maxLamps)
					throw new ArgumentException($"'entry.Lamps' must be an array of at most {maxLamps} lamps");

				var lamps = new SignalLamp[lampsData.Count];
				for (var i = 0; i < lampsData.Count; i++)
				{
					if (lampsData[i] is not JObject lampData)
						throw new ArgumentException($"lamp {i} must be an object");

					var name = lampData["Name"]?.ToString();
					if (string.IsNullOrEmpty(name) || name.Length > maxNameLength)
						throw new ArgumentException($"lamp {i} has an invalid 'Name'");

					var colour = NormalizeColour(lampData["Colour"]?.ToString());
					if (colour == null)
						throw new ArgumentException($"lamp {i} has an invalid 'Colour'");

					var shape = NormalizeShape(lampData["Shape"]?.ToString());
					if (shape == null)
						throw new ArgumentException($"lamp {i} has an invalid 'Shape'");

					int[]? grid = null;
					var gridToken = lampData["Grid"];
					if (gridToken != null && gridToken.Type != JTokenType.Null)
					{
						if (gridToken is not JArray gridArray || gridArray.Count != 2)
							throw new ArgumentException($"lamp {i} 'Grid' must be [x, y] or null");
						grid = gridArray.ToObject<int[]>();
						if (grid[0] < 0 || grid[1] < 0 || grid[0] > maxGridExtent || grid[1] > maxGridExtent)
							throw new ArgumentException($"lamp {i} grid coordinates out of range (0..{maxGridExtent})");
					}

					double[]? position = null;
					if (lampData["Position"] is JArray positionArray && positionArray.Count == 3)
						position = positionArray.ToObject<double[]>();

					lamps[i] = new SignalLamp
					{
						Name = name,
						Colour = colour,
						Shape = shape,
						Grid = grid,
						Position = position,
					};
				}

				if (entryData["Aspects"] is not JObject aspectsData || aspectsData.Count > maxAspects)
					throw new ArgumentException($"'entry.Aspects' must be an object of at most {maxAspects} aspects");

				string[] ReadNames(JToken? token, string path)
				{
					if (token == null || token.Type == JTokenType.Null)
						return Array.Empty<string>();
					if (token is not JArray nameArray || nameArray.Count > maxNames)
						throw new ArgumentException($"{path} must be an array of at most {maxNames} names");
					var names = new string[nameArray.Count];
					for (var n = 0; n < nameArray.Count; n++)
					{
						if (nameArray[n] is not JValue nameValue || nameValue.Type != JTokenType.String)
							throw new ArgumentException($"{path} entries must be strings");
						var nameStr = nameValue.ToString();
						if (string.IsNullOrEmpty(nameStr) || nameStr.Length > maxNameLength)
							throw new ArgumentException($"invalid name in {path}: '{nameStr}'");
						names[n] = nameStr;
					}
					return names;
				}

				var aspects = new Dictionary<string, SignalAspect>(StringComparer.Ordinal);
				foreach (var property in aspectsData.Properties())
				{
					if (string.IsNullOrEmpty(property.Name) || property.Name.Length > maxNameLength)
						throw new ArgumentException($"invalid aspect id '{property.Name}'");
					var aspectData = (property.Value == null || property.Value.Type == JTokenType.Null)
						? new JObject()
						: property.Value as JObject;
					if (aspectData == null)
						throw new ArgumentException($"aspect '{property.Name}' must be an object");

					aspects[property.Name] = new SignalAspect
					{
						DisallowPassing = aspectData["DisallowPassing"]?.Value<bool>() ?? false,
						Lit = ReadNames(aspectData["Lit"], $"aspect '{property.Name}' Lit"),
						Blinking = ReadNames(aspectData["Blinking"], $"aspect '{property.Name}' Blinking"),
					};
				}

				// Optional per-aspect switchboard dot colours: an object mapping aspect id
				// -> semantic colour key (""/absent = none).
				Dictionary<string, string>? switchboardAspects = null;
				var switchboardToken = entryData["SwitchboardAspects"];
				if (switchboardToken != null && switchboardToken.Type != JTokenType.Null)
				{
					if (switchboardToken is not JObject switchboardData || switchboardData.Count > maxAspects)
						throw new ArgumentException($"'entry.SwitchboardAspects' must be an object of at most {maxAspects} aspects");
					switchboardAspects = new Dictionary<string, string>(StringComparer.Ordinal);
					foreach (var property in switchboardData.Properties())
					{
						if (string.IsNullOrEmpty(property.Name) || property.Name.Length > maxNameLength)
							throw new ArgumentException($"invalid switchboard aspect id '{property.Name}'");
						var colour = property.Value?.ToString() ?? "";
						if (!string.IsNullOrEmpty(colour) && Array.IndexOf(AllowedSwitchboardColours, colour) < 0)
							throw new ArgumentException($"switchboard colour '{colour}' for aspect '{property.Name}' is invalid");
						switchboardAspects[property.Name] = colour;
					}
				}

				var changed = PackTableStore.ApplyDefinitions(signalIds, lamps, aspects, switchboardAspects);
				if (changed)
				{
					PackTableStore.Flush();
					Sessions.AddTag("signalpack");
				}

				Main.DebugLog($"Signal entry request for {signalIds.Count} signal(s); changed={changed}");
				RenderEmpty(context, changed ? 204 : 400);
			}
			catch (Exception e)
			{
				Main.Warning($"Failed to process signal entry request: {e.Message}");
				RenderEmpty(context, 400);
			}
		}

		/// <summary>Normalises a lamp colour ("#RRGGBB" / "RRGGBBAA", case-insensitive) to "RRGGBBAA"; null if invalid.</summary>
		private static string? NormalizeColour(string? hex)
		{
			if (string.IsNullOrEmpty(hex)) return null;
			if (hex[0] == '#') hex = hex.Substring(1);
			if (hex.Length != 6 && hex.Length != 8) return null;
			foreach (var c in hex)
			{
				var isHexDigit = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f');
				if (!isHexDigit) return null;
			}
			if (hex.Length == 6) hex += "FF";
			return hex.ToUpperInvariant();
		}

		/// <summary>Normalises a lamp shape to "circle" / "bar"; null if invalid.</summary>
		private static string? NormalizeShape(string? shape)
		{
			if (string.IsNullOrEmpty(shape) || shape.Equals("circle", StringComparison.OrdinalIgnoreCase)) return "circle";
			return shape.Equals("bar", StringComparison.OrdinalIgnoreCase) ? "bar" : null;
		}

		/// <summary>Semantic dot colours the frontend switchboard understands for its signal dots.</summary>
		private static readonly string[] AllowedSwitchboardColours =
		{
			"green",
			"yellow",
			"red",
			"white",
			"blue",
		};

		private static string ReadRequestBody(Stream stream, int maxSize)
		{
			using var memoryStream = new MemoryStream();
			var buffer = new byte[8192];
			var totalRead = 0;
			var bytesRead = 0;
			while ((bytesRead = stream.Read(buffer, 0, buffer.Length)) > 0)
			{
				memoryStream.Write(buffer, 0, bytesRead);
				totalRead += bytesRead;
				if (totalRead > maxSize)
					throw new InvalidOperationException("Request body too large");
			}
			return Encoding.UTF8.GetString(memoryStream.ToArray());
		}

		private static async Task HandleUpdatesRequest(HttpListenerContext context)
		{
			if (context.Request.Url.Segments.Length < 3)
			{
				RenderEmpty(context, 404);
				return;
			}

			var username = context.User?.Identity?.Name ?? "";
			var sessionId = context.Request.Url.Segments[2];
			Render200(context, ContentTypes.Json, await Sessions.GetUpdates(username, sessionId).ConfigureAwait(false));
		}

		private static async Task HandleOccupancyMapRequest(HttpListenerContext context)
		{
			try
			{
			const int maxBodySize = 524288;
			using var stream = context.Request.InputStream;
			using var ms = new System.IO.MemoryStream();
				stream.CopyTo(ms);
				if (ms.Length > maxBodySize)
					throw new Exception("Request body too large");

				string bodyText = Encoding.UTF8.GetString(ms.ToArray());
				var parsed = JObject.Parse(bodyText);

				var mapping = new Dictionary<string, List<(string junctionId, string port, int junctionIndex, bool isOwnSwitch)>>();
				foreach (var prop in parsed.Properties())
				{
					if (prop.Name == "mode") continue;
					var entries = prop.Value as JArray;
					if (entries == null) continue;
					var list = new List<(string junctionId, string port, int junctionIndex, bool isOwnSwitch)>();
					foreach (var entry in entries)
					{
						var jid = entry["junctionId"]?.ToString();
						var port = entry["port"]?.ToString() ?? "";
						var jIdx = entry["junctionIndex"]?.Value<int>() ?? -1;
						var isOwn = entry["isOwnSwitch"]?.Value<bool>() ?? false;
						if (!string.IsNullOrEmpty(jid))
							list.Add((jid, port, jIdx, isOwn));
					}
					mapping[prop.Name] = list;
				}

				if (parsed.TryGetValue("mode", out var modeToken))
				{
					var modeVal = modeToken.Value<int>();
					await Updater.RunOnMainThread(() =>
					{
						OccupancyData.SetMode(modeVal);
					}).ConfigureAwait(false);
				}

				await Updater.RunOnMainThread(() =>
				{
					if (mapping.Count > 0)
						OccupancyData.SetBlockMapping(mapping);
				}).ConfigureAwait(false);

				RenderEmpty(context, 204);
			}
			catch (Exception e)
			{
				Main.Warning($"Failed to parse occupancy map request: {e.Message}");
				RenderEmpty(context, 400);
			}
		}

		private static bool IsValidJunctionId(int junctionId)
		{
			return junctionId >= 0 && junctionId < RailTrackRegistry.Instance.OrderedJunctions.Length;
		}

		private static async void HandleJunctionRequest(HttpListenerContext context)
		{
			var url = context.Request.Url;
			switch (url.Segments.Length)
			{
			case 2:
				Render200(context, ContentTypes.Json, Junctions.GetJunctionPointJSON());
				break;
			case 4:
				var junctionIdString = url.Segments[2].TrimEnd('/');
				if (int.TryParse(junctionIdString, out var junctionId) && url.Segments[3] == "toggle" && IsValidJunctionId(junctionId))
				{
					if (!Main.settings.permissions.HasJunctionPermission(context.User.Identity.Name))
					{
						RenderEmpty(context, 403);
						return;
					}
					var newSelectedBranch = await Updater.RunOnMainThread(() =>
					{
						Main.DebugLog($"Toggling J-{junctionId}.");
						var junction = RailTrackRegistry.Instance.OrderedJunctions[junctionId];
						junction.Switch(Junction.SwitchMode.REGULAR);
						return junction.selectedBranch;
					}).ConfigureAwait(false);
					Render200(context, new JValue(newSelectedBranch));
					return;
				}
				RenderEmpty(context, 404);
				break;
			default:
				RenderEmpty(context, 404);
				break;
			}
		}

		public static void HandleTrainsetRequest(HttpListenerContext context)
		{
			var request = context.Request;
			if (request.Url.Segments.Length < 3)
			{
				RenderEmpty(context, 404);
				return;
			}
			var trainsetId = int.Parse(request.Url.Segments[2]);
			Render200(context, CarData.GetTrainsetDataJson(trainsetId));
		}

		public static void Create()
		{
			if (rootObject == null)
			{
				rootObject = new GameObject();
				GameObject.DontDestroyOnLoad(rootObject);
				rootObject.AddComponent<HttpServer>();
			}
		}

		public static void Destroy()
		{
			if (rootObject == null)
				return;
			// ensure server shuts down immediately, not at the end of the frame
			DestroyImmediate(rootObject);
			rootObject = null;
		}

		private static void RenderResource(HttpListenerContext context)
		{
			var segments = context.Request.Url.Segments;
			// /res/<path...> — embedded resource names use dots for directories
			// (e.g. frontend/signals/s2.webp -> frontend.signals.s2.webp), so join
			// the remaining segments and convert slashes to dots before lookup.
			var resourcePath = string.Join("", segments.Skip(2)).Replace('/', '.');
			var extension = Path.GetExtension(resourcePath);
			context.Response.ContentType = ContentTypes.ForExtension(extension);
			RenderResource(context, $"frontend.{resourcePath}");
		}

		private static async Task HandlePathRequest(HttpListenerContext context)
		{
			var username = context.User?.Identity?.Name ?? "";
			var segments = context.Request.Url.Segments;
			var method = context.Request.HttpMethod;

			if (!Main.settings.featureFlags.enablePathing)
			{
				if (method == "GET")
				{
					Render200(context, ContentTypes.Json, new JArray().ToString());
					return;
				}
				RenderEmpty(context, 403);
				return;
			}

			if (method == "GET" && segments.Length <= 3)
			{
				Render200(context, ContentTypes.Json, PathingData.GetPathsJson().ToString());
				return;
			}

			if (!Main.settings.permissions.HasPathingPermission(username))
			{
				RenderEmpty(context, 403);
				return;
			}

			if (method == "POST" && segments.Length <= 3)
			{
				try
				{
					const int maxBodySize = 524288;
					using var stream = context.Request.InputStream;
					using var ms = new System.IO.MemoryStream();
					stream.CopyTo(ms);
					if (ms.Length > maxBodySize)
						throw new Exception("Request body too large");
					string bodyText = Encoding.UTF8.GetString(ms.ToArray());
					var pathEntry = JObject.Parse(bodyText);
					// AddPath -> StagingData.AddPath -> ActivateBlock mutates Unity
					// objects (Junction.Switch, signal mode/aspect), so it must run
					// on the main thread.
					var id = await Updater.RunOnMainThread(() => PathingData.AddPath(pathEntry)).ConfigureAwait(false);

					Render200(context, ContentTypes.Json, new JObject { ["id"] = id }.ToString());
				}
				catch (Exception e)
				{
					Main.Warning($"Failed to parse path request: {e.Message}");
					RenderEmpty(context, 400);
				}
				return;
			}

			if (method == "PATCH" && segments.Length >= 4 && segments[3].TrimEnd('/') == "note")
			{
				try
				{
					const int maxBodySize = 524288;
					using var stream = context.Request.InputStream;
					using var ms = new System.IO.MemoryStream();
					stream.CopyTo(ms);
					if (ms.Length > maxBodySize)
						throw new Exception("Request body too large");
					string bodyText = Encoding.UTF8.GetString(ms.ToArray());
					var noteObj = JObject.Parse(bodyText);
					var pathId = segments[2].TrimEnd('/');
					PathingData.UpdatePathNote(pathId, noteObj.Value<string>("note"));
					RenderEmpty(context, 204);
				}
				catch (Exception e)
				{
					Main.Warning($"Failed to parse path note request: {e.Message}");
					RenderEmpty(context, 400);
				}
				return;
			}

			if (method == "PATCH" && segments.Length >= 4 && segments[3].TrimEnd('/') == "lookahead")
			{
				try
				{
					const int maxBodySize = 524288;
					using var stream = context.Request.InputStream;
					using var ms = new System.IO.MemoryStream();
					stream.CopyTo(ms);
					if (ms.Length > maxBodySize)
						throw new Exception("Request body too large");
					string bodyText = Encoding.UTF8.GetString(ms.ToArray());
					var lookaheadObj = JObject.Parse(bodyText);
					var value = lookaheadObj.Value<int?>("lookAhead");
					if (value == null)
					{
						RenderEmpty(context, 400);
						return;
					}
					var pathId = segments[2].TrimEnd('/');
					// SetLookAhead can release/claim blocks (signal/switch mutations),
					// so it must run on the main thread.
					await Updater.RunOnMainThread(() => PathingData.UpdatePathLookAhead(pathId, value.Value)).ConfigureAwait(false);
					RenderEmpty(context, 204);
				}
				catch (Exception e)
				{
					Main.Warning($"Failed to parse path lookahead request: {e.Message}");
					RenderEmpty(context, 400);
				}
				return;
			}

			if (method == "PATCH" && segments.Length >= 4 && segments[3].TrimEnd('/') == "color")
			{
				try
				{
					const int maxBodySize = 524288;
					using var stream = context.Request.InputStream;
					using var ms = new System.IO.MemoryStream();
					stream.CopyTo(ms);
					if (ms.Length > maxBodySize)
						throw new Exception("Request body too large");
					string bodyText = Encoding.UTF8.GetString(ms.ToArray());
					var colorObj = JObject.Parse(bodyText);
					var pathId = segments[2].TrimEnd('/');
					PathingData.UpdatePathColor(pathId, colorObj.Value<string>("color"));
					RenderEmpty(context, 204);
				}
				catch (Exception e)
				{
					Main.Warning($"Failed to parse path color request: {e.Message}");
					RenderEmpty(context, 400);
				}
				return;
			}

			if (method == "POST" && segments.Length >= 4 && segments[3].TrimEnd('/') == "unclaim")
			{
				var pathId = segments[2].TrimEnd('/');
				// UnclaimPath releases the path's claimed blocks (reverting signal
				// aspects) on the main thread.
				await Updater.RunOnMainThread(() => PathingData.UnclaimPath(pathId)).ConfigureAwait(false);
				RenderEmpty(context, 204);
				return;
			}

			if (method == "PATCH" && segments.Length >= 3)
			{
				try
				{
					const int maxBodySize = 524288;
					using var stream = context.Request.InputStream;
					using var ms = new System.IO.MemoryStream();
					stream.CopyTo(ms);
					if (ms.Length > maxBodySize)
						throw new Exception("Request body too large");
					string bodyText = Encoding.UTF8.GetString(ms.ToArray());
					var pathEntry = JObject.Parse(bodyText);
					pathEntry["id"] = segments[2].TrimEnd('/');
					// UpdatePath -> StagingData.UpdatePath -> ReleaseBlock reverts
					// signal aspects on the main thread.
					await Updater.RunOnMainThread(() => PathingData.UpdatePath(pathEntry)).ConfigureAwait(false);
					RenderEmpty(context, 204);
				}
				catch (Exception e)
				{
					Main.Warning($"Failed to parse path patch request: {e.Message}");
					RenderEmpty(context, 400);
				}
				return;
			}

			if (method == "DELETE")
			{
				if (segments.Length == 2)
				{
					var storedIds = PathingData.GetAllBlockSignalIds();
					// ClearPaths -> StagingData.ClearAll releases claimed blocks
					// (reverting signal aspects); RevertRouteSignals mutates signals.
					await Updater.RunOnMainThread(() =>
					{
						PathingData.ClearPaths();
						PathingActivation.RevertRouteSignals(storedIds);
					}).ConfigureAwait(false);
					RenderEmpty(context, 204);
				}
				else if (segments.Length >= 3)
				{
					var pathId = segments[2].TrimEnd('/');
					var storedIds = PathingData.GetBlockSignalIdsForPath(pathId);
					await Updater.RunOnMainThread(() =>
					{
						PathingData.RemovePath(pathId);
						PathingActivation.RevertRouteSignals(storedIds);
					}).ConfigureAwait(false);
					RenderEmpty(context, 204);
				}
				else
				{
					RenderEmpty(context, 404);
				}
				return;
			}

			RenderEmpty(context, 404);
		}

		private static async Task HandlePathingActivateRequest(HttpListenerContext context)
		{
			if (context.Request.HttpMethod != "POST")
			{
				RenderEmpty(context, 404);
				return;
			}

			if (!Main.settings.featureFlags.enablePathing)
			{
				RenderEmpty(context, 403);
				return;
			}

			var username = context.User?.Identity?.Name ?? "";
			if (!Main.settings.permissions.HasPathingPermission(username))
			{
				RenderEmpty(context, 403);
				return;
			}

			await Updater.RunOnMainThread(() =>
			{
				PathingActivation.ActivatePathingMode();
				StagingData.InitializeFromPaths(PathingData.GetPaths());
			}).ConfigureAwait(false);

			Sessions.AddTag("signals");
			RenderEmpty(context, 204);
		}

		private static void HandleModConfigRequest(HttpListenerContext context)
		{
			var config = new JObject();
			var doubleTrackMod = UnityModManagerNet.UnityModManager.FindMod("DoubleTrack");
			config["doubleTrack"] = doubleTrackMod != null && doubleTrackMod.Enabled;
			config["enablePathing"] = Main.settings.featureFlags.enablePathing;
			Render200(context, ContentTypes.Json, config.ToString());
		}

		private static void RenderResource(HttpListenerContext context, string resourceName)
		{
			var assembly = typeof(HttpServer).Assembly;
			using var stream = assembly.GetManifestResourceStream(typeof(HttpServer), resourceName);
			if (stream == null)
			{
				RenderEmpty(context, 404);
			}
			else
			{
				context.Response.Headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
				stream.CopyTo(context.Response.OutputStream);
				context.Response.Close();
			}
		}

		private static class ContentTypes
		{
			public const string Css = "text/css";
			public const string Html = "text/html; charset=UTF-8";
			public const string Json = "application/json";
			public const string Javascript = "application/javascript";
			public const string Png = "image/png";
			public const string Svg = "image/svg+xml";
			public const string Webp = "image/webp";

			public static string ForExtension(string extension)
			{
				return extension switch
				{
					".css" => Css,
					".js" => Javascript,
					".json" => Json,
					".png" => Png,
					".svg" => Svg,
					".webp" => Webp,
					_ => "",
				};
			}
		}

		private static void Render200(HttpListenerContext context, JToken json)
		{
			Render200(context, ContentTypes.Json, JsonConvert.SerializeObject(json));
		}

		private static void Render200(HttpListenerContext context, string contentType, string s)
		{
			if (++_render200Count % 1000 == 0)
				Main.DebugLog($"Render200 x{_render200Count}");
			context.Response.ContentType = contentType;
			var bytes = Encoding.UTF8.GetBytes(s);
			if (bytes.Length > 128 && (context.Request.Headers.GetValues("Accept-Encoding")?.Contains("gzip") ?? false))
			{
				context.Response.Headers.Add("Content-Encoding", "gzip");
				var mem = new MemoryStream(bytes);
				using var gzip = new GZipStream(context.Response.OutputStream, CompressionMode.Compress);
				mem.CopyTo(gzip);
			}
			else
			{
				context.Response.Close(bytes, false);
			}
		}

		private static void Render200(HttpListenerContext context, string contentType, byte[] bytes)
		{
#if DEBUG
			Main.Log("Render200 (bytes)");
#endif
			context.Response.ContentType = contentType;
			context.Response.Headers.Add("Cache-Control", "max-age=60");
			context.Response.Close(bytes, false);
		}

		private static void RenderEmpty(HttpListenerContext context, int statusCode)
		{
			context.Response.StatusCode = statusCode;
			context.Response.Close();
		}
	}
}
