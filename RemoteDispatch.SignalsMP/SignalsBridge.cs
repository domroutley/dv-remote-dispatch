	using System;
	using System.Collections.Generic;
	using System.Linq;
	using System.Reflection;
	using Signals.API;
	using Newtonsoft.Json;
	using UnityEngine;

namespace DvMod.RemoteDispatch.Signals
{
	internal class SignalsBridge
	{
		/// <summary>Callbacks to invoke on event</summary>
		private readonly Action<string, string>? _onAspectChanged;
		private readonly Action<string, string>? _onModeChanged;

		/// <summary>Constructor - inject callbacks for forward compat</summary>
		internal SignalsBridge(Action<string, string>? onAspectChanged = null, Action<string, string>? onModeChanged = null)
		{
			_onAspectChanged = onAspectChanged;
			_onModeChanged = onModeChanged;
		}

		/// <summary>The main thread, captured in Register (runs during mod load on the Unity main thread).</summary>
		private int _mainThreadId = -1;

		/// <summary>
		/// Registers event handlers for the SignalsAPI loaded and unloaded events.
		/// </summary>
		/// <remarks>Call this method to enable automatic handling of SignalsAPI lifecycle events within
		/// the current context. This method should be called only once per instance to avoid multiple
		/// registrations.</remarks>
		internal void Register()
		{
			_mainThreadId = System.Threading.Thread.CurrentThread.ManagedThreadId;
			// When SignalsAPI is Loaded, run OnSignalsLoaded
			SignalsAPI.Loaded += OnSignalsLoaded;
			// When SignalsAPI is Unloaded, run OnSignalsUnloaded
			SignalsAPI.Unloaded += OnSignalsUnloaded;

			// If SignalsAPI is already loaded before we registered, we missed the event.
			// Subscribe to instance events directly now.
			if (SignalsAPI.Instance != null)
			{
				OnSignalsLoaded();
			}
		}

		/// <summary>
		/// Unregisters event handlers from the SignalsAPI to stop receiving signal-related notifications.
		/// </summary>
		/// <remarks>Call this method to detach previously registered event handlers and prevent further
		/// callbacks from the SignalsAPI. This is typically used during cleanup to avoid memory leaks or unintended
		/// behavior after the object is no longer needed.</remarks>
		internal void Unregister()
		{
			// Make sure to undo everything we did in Register
			SignalsAPI.Loaded -= OnSignalsLoaded;
			SignalsAPI.Unloaded -= OnSignalsUnloaded;
			if (SignalsAPI.Instance != null)
			{
				// Also remove the handlers if the API is still around
				SignalsAPI.Instance.SignalAspectChanged -= OnAspectChanged;
				SignalsAPI.Instance.SignalModeChanged -= OnModeChanged;
			}
		}

		/// <summary>
		/// Initializes event handlers for signal aspect and mode changes after the Signals API has been loaded.
		/// </summary>
		private void OnSignalsLoaded()
		{
			SignalsAPI.Instance!.SignalAspectChanged += OnAspectChanged;
			SignalsAPI.Instance!.SignalModeChanged += OnModeChanged;
			LoggingReturn.DebugLog?.Invoke("Signals API loaded, ready to interact with signals.");
		}

		/// <summary>
		/// Handles cleanup operations when the Signals API is unloaded.
		/// </summary>
		private void OnSignalsUnloaded()
		{
			LoggingReturn.DebugLog?.Invoke("Signals API unloaded, cleaned up handlers.");
		}

		/// <summary>
		/// Handles changes to the aspect of the specified signal state.
		/// </summary>
		/// <param name="state">The signal state whose aspect has changed. Contains information about the signal's current and previous
		/// aspects.</param>
		private void OnAspectChanged(SignalState state)
		{
			LoggingReturn.DebugLog?.Invoke($"Signals Action triggered: Aspect changed: {state.Id} -> {state.CurrentAspectId ?? "OFF"}");
			_onAspectChanged?.Invoke(state.Id, state.CurrentAspectId ?? "OFF");
		}

		/// <summary>
		/// Handles changes to the mode of the specified signal.
		/// </summary>
		/// <param name="signalId"></param>
		/// <param name="newMode"></param>
		private void OnModeChanged(string signalId, SignalMode newMode)
		{
			LoggingReturn.DebugLog?.Invoke($"Signals Action triggered: Mode changed: {signalId} -> {newMode}");
			_onModeChanged?.Invoke(signalId, newMode.ToString());
		}

		/// <summary>
		/// Returns the current aspect of a signal by its ID, or null if not found.
		/// </summary>
		internal string? GetSignalAspect(string signalId)
		{
			try
			{
				return SignalsAPI.GetSignal(signalId)?.CurrentAspectId;
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"GetSignalAspect({signalId}) failed: {ex.Message}");
				return null;
			}
		}

		/// <summary>
		/// Returns all signals with raw world coordinates (not yet converted to lat/lng).
		/// </summary>
		internal Dictionary<string, object> GetAllSignals()
		{
			var result = new Dictionary<string, object>();
			try
			{
				LoggingReturn.DebugLog?.Invoke("GetAllSignals: calling ForceUpdateAllSignalAspects...");
				ForceUpdateAllSignalAspects();

				var signals = SignalsAPI.GetAllSignals();
				if (signals == null)
				{
					LoggingReturn.DebugLog?.Invoke("GetAllSignals returned null.");
					return result;
				}

				foreach (var signal in signals)
				{
					var aspect = signal.CurrentAspectId ?? "OFF";

					result[signal.Id] = new
					{
						signal.Id,
						signal.Type,
						signal.Mode,
						signal.CurrentAspectId,
						signal.IsOn,
						Direction = signal.Direction.ToString(),
						signal.JunctionId,
						signal.SelectedBranch,
						signal.YardId,
						signal.TrackId,
						Position = new[] { signal.Position.x, signal.Position.z },
					};
				}
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"GetAllSignals failed: {ex.Message}");
				return result;
			}

			return result;
		}

		/// <summary>
		/// Checks whether the given track has any trains physically on it.
		/// </summary>
		internal bool IsTrackOccupied(RailTrack track)
		{
			try
			{
				return SignalsAPI.IsTrackOccupied(track);
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"IsTrackOccupied failed: {ex.Message}");
				return false;
			}
		}

		private static MethodInfo? _forceUpdateMethod;
		private static Type? _signalManagerType;
		private static PropertyInfo? _allSignalsProp;
		private static PropertyInfo? _instanceProp;
		private static bool _reflectionResolved;

		private static DateTime _lastForceUpdate = DateTime.MinValue;
		private static readonly TimeSpan _forceUpdateInterval = TimeSpan.FromSeconds(5);

		/// <summary>
		/// Forces all signals to evaluate their aspects regardless of player proximity.
		/// Tries the new SignalsAPI.ForceUpdateAllSignals(bool) if available,
		/// otherwise falls back to per-signal UpdateAspect via reflection.
		/// Throttled to avoid feedback loops.
		/// </summary>
		private void ForceUpdateAllSignalAspects()
		{
			var now = DateTime.UtcNow;
			if (now - _lastForceUpdate < _forceUpdateInterval) return;
			_lastForceUpdate = now;

			if (TryForceUpdateViaAPI()) return;
			ForceUpdateViaReflection();
		}

		private static MethodInfo? _apiForceUpdateMethod;
		private static bool _apiForceUpdateChecked;

		private bool TryForceUpdateViaAPI()
		{
			if (_apiForceUpdateChecked && _apiForceUpdateMethod == null) return false;
			_apiForceUpdateChecked = true;

			try
			{
				if (_apiForceUpdateMethod == null)
				{
					// Use runtime type, not compile-time reference, since the installed
					// Signals.API.dll may be newer than the one we compiled against.
					var runtimeType = SignalsAPI.Instance?.GetType() ?? typeof(SignalsAPI);
					_apiForceUpdateMethod = runtimeType.GetMethod("ForceUpdateAllSignals", BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance);
					if (_apiForceUpdateMethod == null)
					{
						// Search all loaded assemblies for the method
						foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
						{
							var t = asm.GetType("Signals.API.SignalsAPI");
							if (t != null)
							{
								_apiForceUpdateMethod = t.GetMethod("ForceUpdateAllSignals", BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance);
								if (_apiForceUpdateMethod != null) break;
							}
						}
					}
					if (_apiForceUpdateMethod == null) return false;
					LoggingReturn.DebugLog?.Invoke("ForceUpdate: found SignalsAPI.ForceUpdateAllSignals.");
				}

				var obj = _apiForceUpdateMethod.IsStatic ? null : SignalsAPI.Instance;
				_apiForceUpdateMethod.Invoke(obj, new object[] { false });
				return true;
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"ForceUpdate via API failed: {ex.Message}");
				return false;
			}
		}

		private void ForceUpdateViaReflection()
		{
			try
			{
				if (!_reflectionResolved)
				{
					_reflectionResolved = true;
					var signalsGameAsm = AppDomain.CurrentDomain.GetAssemblies()
						.FirstOrDefault(a => a.GetName().Name == "Signals.Game");
					if (signalsGameAsm == null)
					{
						LoggingReturn.DebugLog?.Invoke("ForceUpdate: Signals.Game assembly not found, skipping.");
						return;
					}

					_signalManagerType = signalsGameAsm.GetType("Signals.Game.SignalManager");
					if (_signalManagerType == null)
					{
						LoggingReturn.DebugLog?.Invoke("ForceUpdate: SignalManager type not found.");
						return;
					}

					_allSignalsProp = _signalManagerType.GetProperty("AllSignals");
					if (_allSignalsProp == null)
					{
						LoggingReturn.DebugLog?.Invoke("ForceUpdate: AllSignals property not found.");
						return;
					}

					var baseType = _signalManagerType.BaseType;
					while (baseType != null)
					{
						_instanceProp = baseType.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static);
						if (_instanceProp != null) break;
						baseType = baseType.BaseType;
					}
					if (_instanceProp == null)
					{
						LoggingReturn.DebugLog?.Invoke("ForceUpdate: Instance property not found on any base type.");
						return;
					}

					var controllerType = signalsGameAsm.GetType("Signals.Game.Controllers.BasicSignalController");
					if (controllerType == null)
					{
						LoggingReturn.DebugLog?.Invoke("ForceUpdate: BasicSignalController type not found.");
						return;
					}

					_forceUpdateMethod = controllerType.GetMethod("UpdateAspect", new[] { typeof(bool) });
					if (_forceUpdateMethod == null)
					{
						LoggingReturn.DebugLog?.Invoke("ForceUpdate: UpdateAspect method not found.");
						return;
					}

					LoggingReturn.DebugLog?.Invoke("ForceUpdate: reflection resolved successfully.");
				}

				if (_forceUpdateMethod == null || _signalManagerType == null) return;

				var instance = _instanceProp?.GetValue(null);
				if (instance == null) return;

				var allSignals = _allSignalsProp?.GetValue(instance) as System.Collections.IList;
				if (allSignals == null) return;

				int updated = 0;
				foreach (var signal in allSignals)
				{
					var exists = signal.GetType().GetProperty("Exists")?.GetValue(signal) as bool?;
					if (exists != true) continue;
					_forceUpdateMethod.Invoke(signal, new object[] { false });
					updated++;
				}
				LoggingReturn.DebugLog?.Invoke($"ForceUpdate: evaluated {updated} signals.");
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"ForceUpdate failed: {ex.Message}");
			}
		}

		/// <summary>
		/// Sets a signal to the specified aspect. Returns true on success.
		/// </summary>
		internal bool SetSignalAspect(string signalId, string aspect)
		{
			if (_mainThreadId >= 0 && System.Threading.Thread.CurrentThread.ManagedThreadId != _mainThreadId)
			{
				LoggingReturn.Warning?.Invoke($"SetSignalAspect({signalId}, {aspect}) called off the Unity main thread - signal mutations must run there.");
				return false;
			}

			LoggingReturn.Log?.Invoke($"Attempting to set signal aspect: {signalId} -> {aspect}");
			try
			{
				return SignalsAPI.SetSignalAspect(signalId, aspect);
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
			if (_mainThreadId >= 0 && System.Threading.Thread.CurrentThread.ManagedThreadId != _mainThreadId)
			{
				LoggingReturn.Warning?.Invoke($"SetSignalMode({signalId}, {mode}) called off the Unity main thread - signal mutations must run there.");
				return false;
			}

			LoggingReturn.DebugLog?.Invoke($"Attempting to set signal mode: {signalId} -> {mode}");
			try
			{
				if (!Enum.TryParse<SignalMode>(mode, true, out var parsed))
				{
					LoggingReturn.DebugLog?.Invoke($"Failed to parse signal mode: {signalId} -> {mode}");
					return false;
				}
				return SignalsAPI.SetSignalMode(signalId, parsed);
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"SetSignalMode({signalId}, {mode}) failed: {ex.Message}");
				return false;
			}
		}

#region Pack table (reflection-based capture)

		// The -mp fork ships its own Signals.Game.dll (same Signal/IAspect/SignalLight surface as
		// the new fork) but also the old Signals.API. The two Signals.Common.dll builds collide by
		// assembly name, so we reach the pack/lamp data via reflection at runtime instead of a
		// compile-time reference. Kept in one place so the reflection surface is easy to audit.

		private static bool s_packReflectionResolved;
		private static Type? s_packType;
		private static Type? s_signalManagerType;
		private static Type? s_signalsModType;
		private static PropertyInfo? s_signalManagerInstanceProp;
		private static PropertyInfo? s_allControllersProp;
		private static PropertyInfo? s_controllerSignalsProp;
		private static PropertyInfo? s_controllerExistsProp;
		private static PropertyInfo? s_currentPackProp;
		private static PropertyInfo? s_packModIdProp;
		private static PropertyInfo? s_packVersionProp;
		private static PropertyInfo? s_packModNameProp;
		private static FieldInfo? s_customPackField;
		private static PropertyInfo? s_signalNameProp;
		private static PropertyInfo? s_signalAllLightsProp;
		private static PropertyInfo? s_signalCurrentAspectProp;
		private static PropertyInfo? s_signalDefinitionProp;
		private static PropertyInfo? s_lightDefinitionProp;
		private static FieldInfo? s_lightDefinitionColourField;
		private static PropertyInfo? s_aspectIdProp;
		private static MethodInfo? s_aspectGetDefinitionMethod;
		private static PropertyInfo? s_defDisallowPassingProp;
		private static FieldInfo? s_defOnLightsField;
		private static FieldInfo? s_defBlinkingLightsField;
		private static FieldInfo? s_defLightSequencesField;
		private static FieldInfo? s_seqLightsField;

		private static void ResolvePackReflection()
		{
			if (s_packReflectionResolved) return;
			s_packReflectionResolved = true;

			try
			{
				var gameAsm = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == "Signals.Game");
				var commonAsm = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == "Signals.Common");
				if (gameAsm == null || commonAsm == null)
				{
					LoggingReturn.DebugLog?.Invoke("Pack capture: Signals.Game/Common assemblies not found.");
					return;
				}

				s_signalManagerType = gameAsm.GetType("Signals.Game.SignalManager");
				s_signalsModType = gameAsm.GetType("Signals.Game.SignalsMod");
				s_packType = commonAsm.GetType("Signals.Common.SignalPack");
				if (s_signalManagerType == null || s_packType == null) return;

				s_currentPackProp = s_signalManagerType.GetProperty("CurrentPack");
				s_packModIdProp = s_packType.GetProperty("ModId");
				s_packVersionProp = s_packType.GetProperty("Version");
				s_packModNameProp = s_packType.GetProperty("ModName");

				// Settings.CustomPack: the field lives on Signals.Game.Settings (top-level) in this build.
				var settingsType = gameAsm.GetType("Signals.Game.Settings") ?? s_signalsModType?.GetNestedType("Settings");
				s_customPackField = settingsType?.GetField("CustomPack");

				var instanceBase = s_signalManagerType.BaseType;
				while (instanceBase != null)
				{
					s_signalManagerInstanceProp = instanceBase.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static);
					if (s_signalManagerInstanceProp != null) break;
					instanceBase = instanceBase.BaseType;
				}

				s_allControllersProp = s_signalManagerType.GetProperty("AllControllers");
				var controllerType = gameAsm.GetType("Signals.Game.Controllers.BasicSignalController");
				if (controllerType != null)
				{
					s_controllerSignalsProp = controllerType.GetProperty("Signals");
					s_controllerExistsProp = controllerType.GetProperty("Exists");
				}

				var signalType = gameAsm.GetType("Signals.Game.Signal");
				if (signalType != null)
				{
					s_signalNameProp = signalType.GetProperty("Name");
					s_signalAllLightsProp = signalType.GetProperty("AllLights");
					s_signalCurrentAspectProp = signalType.GetProperty("CurrentAspect");
					s_signalDefinitionProp = signalType.GetProperty("Definition");
				}

				var lightType = gameAsm.GetType("Signals.Game.Lights.SignalLight");
				if (lightType != null) s_lightDefinitionProp = lightType.GetProperty("Definition");

				var lightDefType = commonAsm.GetType("Signals.Common.SignalLightDefinition");
				if (lightDefType != null) s_lightDefinitionColourField = lightDefType.GetField("Colour");

				var aspectType = gameAsm.GetType("Signals.Game.Aspects.IAspect");
				if (aspectType != null)
				{
					s_aspectIdProp = aspectType.GetProperty("Id");
					s_aspectGetDefinitionMethod = aspectType.GetMethod("GetDefinition");
				}

				var aspectDefType = commonAsm.GetType("Signals.Common.Aspects.AspectBaseDefinition");
				if (aspectDefType != null)
				{
					s_defDisallowPassingProp = aspectDefType.GetProperty("DisallowPassing");
					s_defOnLightsField = aspectDefType.GetField("OnLights");
					s_defBlinkingLightsField = aspectDefType.GetField("BlinkingLights");
					s_defLightSequencesField = aspectDefType.GetField("LightSequences");
				}

				var seqDefType = commonAsm.GetType("Signals.Common.SignalLightSequenceDefinition");
				if (seqDefType != null) s_seqLightsField = seqDefType.GetField("Lights");
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"ResolvePackReflection failed: {ex.Message}");
			}
		}

		/// <summary>
		/// Resolves the pack file key. The -mp fork always uses "DVSignalpack-mp".
		/// </summary>
		internal static string GetPackKey() => "DVSignalpack-mp";

		private static object? GetSignalManagerInstance()
		{
			if (s_signalManagerInstanceProp == null) return null;
			try { return s_signalManagerInstanceProp.GetValue(null); }
			catch { return null; }
		}

		private static IEnumerable<object> EnumerateSignals()
		{
			var instance = GetSignalManagerInstance();
			if (instance == null) yield break;

			var controllers = s_allControllersProp?.GetValue(instance) as System.Collections.IEnumerable;
			if (controllers == null) yield break;

			foreach (var controller in controllers)
			{
				if (s_controllerExistsProp != null)
				{
					var exists = s_controllerExistsProp.GetValue(controller) as bool?;
					if (exists != true) continue;
				}

				var signals = s_controllerSignalsProp?.GetValue(controller) as System.Collections.IEnumerable;
				if (signals == null) continue;

				foreach (var signal in signals) yield return signal;
			}
		}

		private static object? FindSignalReflection(string signalName)
		{
			foreach (var signal in EnumerateSignals())
			{
				var name = s_signalNameProp?.GetValue(signal) as string;
				if (string.Equals(name, signalName, StringComparison.OrdinalIgnoreCase)) return signal;
			}
			return null;
		}

		/// <summary>
		/// Builds a capture snapshot for the given signal name via reflection. Main-thread only.
		/// Returns null if the signal could not be found.
		/// </summary>
		internal object? CaptureSignal(string signalName)
		{
			ResolvePackReflection();
			if (!s_packReflectionResolved) return null;

			var signal = FindSignalReflection(signalName);
			if (signal == null || s_signalDefinitionProp == null) return null;

			try
			{
				var pack = s_currentPackProp?.GetValue(GetSignalManagerInstance());
				var packId = pack != null && s_packModIdProp != null ? s_packModIdProp.GetValue(pack) as string ?? string.Empty : string.Empty;
				var packVersion = pack != null && s_packVersionProp != null ? s_packVersionProp.GetValue(pack) as string ?? string.Empty : string.Empty;
				var packName = pack != null && s_packModNameProp != null ? s_packModNameProp.GetValue(pack) as string ?? string.Empty : string.Empty;

				var signalDef = s_signalDefinitionProp.GetValue(signal);
				var signalTransform = signalDef != null ? GetTransform(signalDef) : null;

				var lamps = new List<object>();
				var allLights = s_signalAllLightsProp?.GetValue(signal) as System.Collections.IEnumerable;
				if (allLights != null)
				{
					foreach (var light in allLights)
					{
						var lightDef = s_lightDefinitionProp?.GetValue(light);
						if (lightDef == null) continue;

						var name = GetObjectName(lightDef);
						var colourObj = s_lightDefinitionColourField?.GetValue(lightDef);
						var colourHex = colourObj is Color c ? ColorUtility.ToHtmlStringRGBA(c) : string.Empty;

						double[] position = Array.Empty<double>();
						var lightTransform = GetTransform(lightDef);
						if (signalTransform != null && lightTransform != null)
						{
							var localPos = signalTransform.InverseTransformPoint(lightTransform.position);
							position = new[] { (double)localPos.x, (double)localPos.y, (double)localPos.z };
						}

						lamps.Add(new { Name = name, Colour = colourHex, Position = position });
					}
				}

				var currentAspect = s_signalCurrentAspectProp?.GetValue(signal);
				string aspectId = "OFF";
				bool disallowPassing = false;
				var lit = new List<string>();
				var blinking = new List<string>();

				if (currentAspect != null)
				{
					aspectId = s_aspectIdProp?.GetValue(currentAspect) as string ?? "OFF";
					var defObj = s_aspectGetDefinitionMethod?.Invoke(currentAspect, null);

					if (defObj != null)
					{
						var disallow = s_defDisallowPassingProp?.GetValue(defObj);
						disallowPassing = disallow is bool b && b;

						AddLampNames(s_defOnLightsField?.GetValue(defObj), lit, null);
						AddLampNames(s_defBlinkingLightsField?.GetValue(defObj), lit, blinking);

						var sequences = s_defLightSequencesField?.GetValue(defObj) as System.Collections.IEnumerable;
						if (sequences != null)
						{
							foreach (var seq in sequences)
							{
								if (seq == null) continue;
								AddLampNames(s_seqLightsField?.GetValue(seq), lit, null);
							}
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
				LoggingReturn.Warning?.Invoke($"CaptureSignal({signalName}) failed: {ex.Message}");
				return null;
			}
		}

		private static void AddLampNames(object? lightsValue, List<string> lit, List<string>? blinking)
		{
			if (lightsValue == null) return;
			if (lightsValue is not System.Collections.IEnumerable lights) return;

			foreach (var lightDef in lights)
			{
				if (lightDef == null) continue;
				var name = GetObjectName(lightDef);
				if (string.IsNullOrEmpty(name)) continue;
				if (!lit.Contains(name)) lit.Add(name);
				if (blinking != null && !blinking.Contains(name)) blinking.Add(name);
			}
		}

		private static string GetObjectName(object component)
		{
			if (component is UnityEngine.Object obj) return obj.name;
			return string.Empty;
		}

		private static UnityEngine.Transform? GetTransform(object component)
		{
			if (component is UnityEngine.Component comp) return comp.transform;
			return null;
		}

		#endregion Pack table
	}
}
