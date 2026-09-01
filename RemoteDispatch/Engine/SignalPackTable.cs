using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace DvMod.RemoteDispatch
{
	/// <summary>
	/// Serializable description of one lamp on a signal (used by the frontend to render a signal face).
	/// </summary>
	public class SignalLamp
	{
		public string Name { get; set; } = string.Empty;
		public string Colour { get; set; } = string.Empty;
		public double[]? Position { get; set; }

		/// <summary>
		/// Optional user-edited grid position <c>[col, row]</c> from the frontend layout editor.
		/// Null means the lamp uses the default single-column layout (array order).
		/// </summary>
		public int[]? Grid { get; set; }

		/// <summary>
		/// Lamp shape in the frontend rendering: "circle" (default) or "bar" (a thin rectangle
		/// spanning two grid cells horizontally). Null means circle.
		/// </summary>
		public string? Shape { get; set; }
	}

	/// <summary>
	/// Serializable description of one aspect's lamp usage.
	/// </summary>
	public class SignalAspect
	{
		public bool DisallowPassing { get; set; }
		public string[] Lit { get; set; } = Array.Empty<string>();
		public string[] Blinking { get; set; } = Array.Empty<string>();
	}

	/// <summary>
	/// Serializable description of a single signal: its lamps and the aspects seen so far.
	/// </summary>
	public class SignalEntry
	{
		public SignalLamp[] Lamps { get; set; } = Array.Empty<SignalLamp>();
		public Dictionary<string, SignalAspect> Aspects { get; set; } = new Dictionary<string, SignalAspect>(StringComparer.Ordinal);

		/// <summary>
		/// Per-aspect switchboard dot colours: aspect id -> semantic colour key
		/// ("green", "yellow", "red", "white", "blue"). Optional; an absent/empty entry means
		/// the dot falls back to the aspect-derived colouring. Set from the "switchboard" row
		/// of the aspect × lamp editor, one colour per state the signal can be in.
		/// </summary>
		public Dictionary<string, string>? SwitchboardAspects { get; set; }
	}

	/// <summary>
	/// A remembered "original representation -> new representation" mapping. When a signal's
	/// lamps/aspects are edited in the frontend, the pre-edit lamp layout is stored as
	/// OriginalKey (a canonical LampKey signature). Newly discovered signals whose captured
	/// lamp layout matches OriginalKey get the edited Lamps + Aspects applied automatically.
	/// Overrides cascade: an original layout that was edited more than once resolves through
	/// the chain to the newest target (e.g. X-&gt;Y then Y-&gt;Z makes a raw X signal resolve to Z).
	/// </summary>
	public class PackOverride
	{
		public string OriginalKey { get; set; } = string.Empty;
		public SignalLamp[] Lamps { get; set; } = Array.Empty<SignalLamp>();
		public Dictionary<string, SignalAspect> Aspects { get; set; } = new Dictionary<string, SignalAspect>(StringComparer.Ordinal);
		public Dictionary<string, string>? SwitchboardAspects { get; set; }
	}

	/// <summary>
	/// Serializable pack table: the root object persisted as "signalpacks/DVSignalpack-*.json".
	/// </summary>
	public class PackTable
	{
		public string PackId { get; set; } = string.Empty;
		public string PackVersion { get; set; } = string.Empty;
		public string PackName { get; set; } = string.Empty;
		public Dictionary<string, SignalEntry> Signals { get; set; } = new Dictionary<string, SignalEntry>(StringComparer.Ordinal);
		/// <summary>
		/// Optional per-signal-type stop aspects (e.g. "Shunting" -> "Ms1"), used when
		/// pathing mode blocks a signal. Additive: the base mod ignores this field.
		/// </summary>
		public Dictionary<string, string>? StopAspects { get; set; }
		public List<PackOverride> Overrides { get; set; } = new List<PackOverride>();
	}

	/// <summary>
	/// Caches the current pack table and handles persistence + serialization. Lives in the main
	/// mod project so the HTTP endpoints and update tags can read it without touching Unity.
	/// </summary>
	internal static class PackTableStore
	{
		private static readonly object s_lock = new object();

		private static PackTable? s_table;
		private static string? s_key;

		// Throttled flush state (s_lock-guarded). A sweep that changes hundreds of
		// signal aspects in one frame used to write the whole pack table to disk per
		// change; the catch-up schedule collapses that into one write per gate window.
		private static readonly TimeSpan FlushGate = TimeSpan.FromSeconds(5);
		private static DateTime s_lastFlush = DateTime.MinValue;
		private static bool s_flushScheduled;

		/// <summary>The directory where pack tables are persisted (signalpacks/ under the mod folder).</summary>
		internal static string? TableDirectory { get; set; }

		/// <summary>The currently active pack file key (e.g. "DVSignalpack-default"). Null until a capture has been observed.</summary>
		internal static string? CurrentKey => s_key;

		/// <summary>
		/// Returns the current table as JSON, or null if no table has been built yet.
		/// </summary>
		internal static string? GetCurrentJson()
		{
			lock (s_lock)
			{
				if (s_table == null) return null;
				return JsonConvert.SerializeObject(s_table);
			}
		}

		/// <summary>
		/// Resets the store (e.g. when the pack key changes) and loads the table from disk for the given key.
		/// </summary>
		internal static void Load(string key)
		{
			lock (s_lock)
			{
				s_key = key;
				s_table = null;

				if (string.IsNullOrEmpty(TableDirectory)) return;

				var path = Path.Combine(TableDirectory, key + ".json");
				if (!File.Exists(path)) return;

				try
				{
					var text = File.ReadAllText(path);
					s_table = JsonConvert.DeserializeObject<PackTable>(text);
				}
				catch (Exception ex)
				{
					Main.Warning($"Failed to load signal pack table '{path}': {ex.Message}");
					s_table = null;
				}
			}
		}

		/// <summary>
		/// Upserts a signal's lamps and the current aspect into the table. Returns true if the table changed.
		/// </summary>
		/// <param name="signalName">The signal name (matches the /signals Id).</param>
		/// <param name="lamps">Lamp descriptors. Passing null keeps any existing lamp list.</param>
		/// <param name="aspectId">The aspect id observed on this signal.</param>
		/// <param name="disallowPassing">Whether the aspect disallows passing.</param>
		/// <param name="lit">Names of lit lamps for this aspect.</param>
		/// <param name="blinking">Names of blinking lamps for this aspect.</param>
		internal static bool Upsert(string signalName, SignalLamp[]? lamps, string aspectId, bool disallowPassing, string[]? lit, string[]? blinking)
		{
			if (string.IsNullOrEmpty(signalName) || string.IsNullOrEmpty(aspectId)) return false;

			lock (s_lock)
			{
				if (s_table == null) s_table = new PackTable();

				if (!s_table.Signals.TryGetValue(signalName, out var entry))
				{
					entry = new SignalEntry();
					s_table.Signals[signalName] = entry;
				}

				bool changed = false;

				if (lamps != null)
				{
					// A captured layout that matches a remembered original representation:
					// apply the edited template so newly discovered signals inherit it.
					// Overrides cascade: a layout edited more than once resolves to the newest
					// target (e.g. X->Y then Y->Z makes a raw X signal resolve to Z).
					if (TryResolveOverride(lamps, out var overrideLamps, out var overrideAspects, out var overrideSwitchboardAspects))
					{
						entry.Lamps = (SignalLamp[])overrideLamps!.Clone();
						entry.SwitchboardAspects = overrideSwitchboardAspects == null
							? null
							: new Dictionary<string, string>(overrideSwitchboardAspects, StringComparer.Ordinal);
						changed = true;
						changed |= MergeAspects(entry, overrideAspects!);
					}
					else
					{
						entry.Lamps = lamps;
						changed = true;
					}
				}

				if (!entry.Aspects.ContainsKey(aspectId))
				{
					entry.Aspects[aspectId] = new SignalAspect
					{
						DisallowPassing = disallowPassing,
						Lit = lit ?? Array.Empty<string>(),
						Blinking = blinking ?? Array.Empty<string>(),
					};
					changed = true;
				}

				return changed;
			}
		}

		/// <summary>
		/// Returns the user-configured stop aspect for a signal type, or null if none is set.
		/// </summary>
		internal static string? GetConfiguredStopAspect(string signalType)
		{
			if (string.IsNullOrEmpty(signalType)) return null;
			lock (s_lock)
			{
				if (s_table?.StopAspects == null) return null;
				return s_table.StopAspects.TryGetValue(signalType, out var aspect) && !string.IsNullOrEmpty(aspect) ? aspect : null;
			}
		}

		/// <summary>
		/// Auto-detects a stop aspect for a signal from its pack entry: the first aspect
		/// whose DisallowPassing flag is set. Returns null when the signal has no pack
		/// entry or none of its observed aspects disallow passing.
		/// </summary>
		internal static string? DetectStopAspect(string signalId)
		{
			if (string.IsNullOrEmpty(signalId)) return null;
			lock (s_lock)
			{
				if (s_table == null || !s_table.Signals.TryGetValue(signalId, out var entry))
					return null;

				foreach (var kvp in entry.Aspects)
				{
					if (kvp.Value.DisallowPassing)
						return kvp.Key;
				}
				return null;
			}
		}

		/// <summary>
		/// Sets (or clears with null) the configured stop aspect for a signal type and
		/// persists the table. Silently ignores calls when no table/key is loaded yet.
		/// </summary>
		internal static void SetStopAspect(string signalType, string? aspectId)
		{
			if (string.IsNullOrEmpty(signalType)) return;

			lock (s_lock)
			{
				if (s_table == null || string.IsNullOrEmpty(s_key)) return;
				if (s_table.StopAspects == null) s_table.StopAspects = new Dictionary<string, string>(StringComparer.Ordinal);

				if (string.IsNullOrEmpty(aspectId))
					s_table.StopAspects.Remove(signalType);
				else
					s_table.StopAspects[signalType] = aspectId;
			}

			Flush();
		}

		/// <summary>
		/// Returns the sorted union of every aspect id observed in the current pack,
		/// used to populate the stop-aspect dropdown in the settings UI.
		/// </summary>
		internal static string[] GetObservedAspects()
		{
			lock (s_lock)
			{
				if (s_table == null) return Array.Empty<string>();
				var set = new HashSet<string>(StringComparer.Ordinal);
				foreach (var entry in s_table.Signals.Values)
				{
					foreach (var aspectId in entry.Aspects.Keys)
						set.Add(aspectId);
				}
				var result = set.ToArray();
				Array.Sort(result, StringComparer.Ordinal);
				return result;
			}
		}

		/// <summary>
		/// Replaces the lamps, aspects and switchboard colours of the listed signals with
		/// user-edited definitions from the frontend signal editor. Returns true if the table
		/// changed (resaving an identical definition is a no-op).
		/// </summary>
		internal static bool ApplyDefinitions(IReadOnlyList<string> signalIds, SignalLamp[] lamps, IDictionary<string, SignalAspect> aspects, IDictionary<string, string>? switchboardAspects = null)
		{
			if (signalIds == null || signalIds.Count == 0 || lamps == null || aspects == null) return false;

			lock (s_lock)
			{
				if (s_table == null) return false;

				bool changed = false;
				foreach (var id in signalIds)
				{
					if (string.IsNullOrEmpty(id) || !s_table.Signals.TryGetValue(id, out var entry)) continue;
					if (AreSameDefinitions(entry, lamps, aspects, switchboardAspects)) continue;

					// Remember the original representation so that any new signal discovered
					// later with the same lamp layout inherits this edit automatically.
					RecordOverride(entry.Lamps, lamps, aspects, switchboardAspects);

					entry.Lamps = lamps;
					entry.Aspects = new Dictionary<string, SignalAspect>(aspects, StringComparer.Ordinal);
					entry.SwitchboardAspects = switchboardAspects == null
						? null
						: new Dictionary<string, string>(switchboardAspects, StringComparer.Ordinal);
					changed = true;
				}

				return changed;
			}
		}

		/// <summary>
		/// Canonical signature of a lamp layout, mirroring the frontend's layoutKey
		/// (Name | Colour | Shape | Grid;...). Used to match "original representations".
		/// Returns null when there is no meaningful layout to match on.
		/// </summary>
		private static string? LampKey(SignalLamp[]? lamps)
		{
			if (lamps == null || lamps.Length == 0) return null;

			var parts = new string[lamps.Length];
			for (int i = 0; i < lamps.Length; i++)
			{
				var lamp = lamps[i];
				var grid = lamp.Grid;
				var gx = 0;
				var gy = i;
				if (grid != null && grid.Length == 2)
				{
					gx = grid[0];
					gy = grid[1];
				}
				// Shape normalises the same way the frontend does: only "bar" is special.
				var shape = string.Equals(lamp.Shape, "bar", StringComparison.OrdinalIgnoreCase) ? "bar" : "circle";
				parts[i] = $"{lamp.Name}|{lamp.Colour ?? ""}|{shape}|{gx},{gy}";
			}
			return string.Join(";", parts);
		}

		private const int MaxOverrideHops = 64;

		/// <summary>
		/// Follows the override chain starting from the captured lamp layout. Each override maps an
		/// original layout to a new one, so a layout edited more than once cascades to the newest
		/// target (e.g. X-&gt;Y then Y-&gt;Z resolves raw X to Z). Aspects are merged across every hop,
		/// later edits winning per-aspect. Returns false (with nulls) when no override matches.
		/// Cycle-safe: each distinct layout key is visited at most once.
		/// </summary>
		private static bool TryResolveOverride(SignalLamp[]? lamps, out SignalLamp[]? targetLamps, out IDictionary<string, SignalAspect>? targetAspects, out IDictionary<string, string>? targetSwitchboardAspects)
		{
			targetLamps = null;
			targetAspects = null;
			targetSwitchboardAspects = null;

			var current = lamps;
			var visited = new HashSet<string>(StringComparer.Ordinal);

			while (current != null && visited.Count < MaxOverrideHops)
			{
				var key = LampKey(current);
				if (key == null || !visited.Add(key)) break;

				var match = FindOverrideByKey(key);
				if (match == null) break;

				targetLamps = match.Lamps;
				if (targetAspects == null) targetAspects = new Dictionary<string, SignalAspect>(StringComparer.Ordinal);
				foreach (var kvp in match.Aspects)
				{
					targetAspects[kvp.Key] = CloneAspect(kvp.Value);
				}
				targetSwitchboardAspects = match.SwitchboardAspects;

				current = match.Lamps;
			}

			return targetLamps != null;
		}

		private static PackOverride? FindOverrideByKey(string key)
		{
			if (s_table == null || s_table.Overrides == null) return null;
			foreach (var o in s_table.Overrides)
			{
				if (o != null && string.Equals(o.OriginalKey, key, StringComparison.Ordinal))
					return o;
			}
			return null;
		}

		/// <summary>
		/// Stores (or replaces) the override template for the given original lamp layout.
		/// </summary>
		private static void RecordOverride(SignalLamp[]? originalLamps, SignalLamp[] newLamps, IDictionary<string, SignalAspect> newAspects, IDictionary<string, string>? switchboardAspects = null)
		{
			var key = LampKey(originalLamps);
			if (key == null || s_table == null) return;

			if (s_table.Overrides == null) s_table.Overrides = new List<PackOverride>();

			var existing = s_table.Overrides.Find(o => o != null && string.Equals(o.OriginalKey, key, StringComparison.Ordinal));
			if (existing != null)
			{
				existing.Lamps = newLamps;
				existing.Aspects = new Dictionary<string, SignalAspect>(newAspects, StringComparer.Ordinal);
				existing.SwitchboardAspects = switchboardAspects == null
					? null
					: new Dictionary<string, string>(switchboardAspects, StringComparer.Ordinal);
			}
			else
			{
				s_table.Overrides.Add(new PackOverride
				{
					OriginalKey = key,
					Lamps = newLamps,
					Aspects = new Dictionary<string, SignalAspect>(newAspects, StringComparer.Ordinal),
					SwitchboardAspects = switchboardAspects == null
						? null
						: new Dictionary<string, string>(switchboardAspects, StringComparer.Ordinal),
				});
			}
		}

		/// <summary>
		/// Merges the override's aspects into the entry, override values winning for the aspects
		/// it defines while preserving any other aspects already on the entry (e.g. ones discovered
		/// after the edit). Returns true if any aspect changed.
		/// </summary>
		private static bool MergeAspects(SignalEntry entry, IDictionary<string, SignalAspect> from)
		{
			bool changed = false;
			foreach (var kvp in from)
			{
				if (entry.Aspects.TryGetValue(kvp.Key, out var existing))
				{
					if (!AspectEquals(existing, kvp.Value))
					{
						entry.Aspects[kvp.Key] = CloneAspect(kvp.Value);
						changed = true;
					}
				}
				else
				{
					entry.Aspects[kvp.Key] = CloneAspect(kvp.Value);
					changed = true;
				}
			}
			return changed;
		}

		private static SignalAspect CloneAspect(SignalAspect a)
		{
			return new SignalAspect
			{
				DisallowPassing = a.DisallowPassing,
				Lit = (string[]?)a.Lit?.Clone() ?? Array.Empty<string>(),
				Blinking = (string[]?)a.Blinking?.Clone() ?? Array.Empty<string>(),
			};
		}

		private static bool AspectEquals(SignalAspect? a, SignalAspect? b)
		{
			if (a == null || b == null) return a == null && b == null;
			return a.DisallowPassing == b.DisallowPassing
				&& AreSameNameArrays(a.Lit, b.Lit)
				&& AreSameNameArrays(a.Blinking, b.Blinking);
		}

		private static bool AreSameDefinitions(SignalEntry entry, SignalLamp[] bLamps, IDictionary<string, SignalAspect> bAspects, IDictionary<string, string>? bSwitchboardAspects)
		{
			if (!AreSameLamps(entry.Lamps, bLamps)) return false;
			if (!AreSameSwitchboardAspects(entry.SwitchboardAspects, bSwitchboardAspects)) return false;
			var aAspects = entry.Aspects;
			if (aAspects == null || aAspects.Count != bAspects.Count) return false;
			foreach (var kvp in bAspects)
			{
				if (!aAspects.TryGetValue(kvp.Key, out var aAspect) || aAspect == null || kvp.Value == null) return false;
				if (aAspect.DisallowPassing != kvp.Value.DisallowPassing) return false;
				if (!AreSameNameArrays(aAspect.Lit, kvp.Value.Lit) || !AreSameNameArrays(aAspect.Blinking, kvp.Value.Blinking)) return false;
			}
			return true;
		}

		private static bool AreSameLamps(SignalLamp[]? a, SignalLamp[]? b)
		{
			if (a == null || b == null || a.Length != b.Length) return false;
			for (int i = 0; i < a.Length; i++)
			{
				var la = a[i];
				var lb = b[i];
				if (la == null || lb == null) continue;
				if (la != (object)lb && (
					!string.Equals(la.Name, lb.Name, StringComparison.Ordinal)
					|| !string.Equals(la.Colour ?? "", lb.Colour ?? "", StringComparison.Ordinal)
					|| !string.Equals(la.Shape ?? "", lb.Shape ?? "", StringComparison.Ordinal)
					|| !AreSameGrid(la.Grid, lb.Grid)
					|| !AreSameOptionals(la.Position, lb.Position))) return false;
			}
			return true;
		}

		private static bool AreSameGrid(int[]? a, int[]? b)
		{
			if (a == null || b == null) return a == null && b == null;
			return a.Length == b.Length && a[0] == b[0] && a[1] == b[1];
		}

		private static bool AreSameOptionals(double[]? a, double[]? b)
		{
			if (a == null || b == null) return a == null && b == null;
			if (a.Length != b.Length) return false;
			for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
			return true;
		}

		private static bool AreSameNameArrays(string[]? a, string[]? b)
		{
			if (a == null || b == null) return a == null && b == null;
			if (a.Length != b.Length) return false;
			for (int i = 0; i < a.Length; i++) if (!string.Equals(a[i], b[i], StringComparison.Ordinal)) return false;
			return true;
		}

		/// <summary>Compares two aspect->colour switchboard maps (null and empty treated as equal).</summary>
		private static bool AreSameSwitchboardAspects(IDictionary<string, string>? a, IDictionary<string, string>? b)
		{
			if (a == null || a.Count == 0) return b == null || b.Count == 0;
			if (b == null || a.Count != b.Count) return false;
			foreach (var kvp in a)
			{
				if (!b.TryGetValue(kvp.Key, out var other) || !string.Equals(kvp.Value ?? "", other ?? "", StringComparison.Ordinal))
					return false;
			}
			return true;
		}

		/// <summary>
		/// Persists the current table to disk for the current key. Best-effort, never throws to callers.
		/// </summary>
		internal static void Flush()
		{
			lock (s_lock)
			{
				if (s_table == null || string.IsNullOrEmpty(s_key)) return;
				if (string.IsNullOrEmpty(TableDirectory)) return;

				try
				{
					if (!Directory.Exists(TableDirectory)) Directory.CreateDirectory(TableDirectory);

					var path = Path.Combine(TableDirectory, s_key + ".json");
					var tmp = path + ".tmp";
					var json = JsonConvert.SerializeObject(s_table);
					File.WriteAllText(tmp, json);
					if (File.Exists(path)) File.Delete(path);
					File.Move(tmp, path);
				}
				catch (Exception ex)
				{
					Main.Warning($"Failed to save signal pack table: {ex.Message}");
				}
			}
		}

		/// <summary>
		/// Persists at most once per <see cref="FlushGate"/>; a burst of aspect changes (e.g. a
		/// pathing-mode sweep) schedules a single catch-up flush instead of writing the whole
		/// table to disk per signal. In-memory state is always current, so /signalpack reads
		/// are unaffected; only the on-disk copy lags by up to the gate.
		/// </summary>
		internal static void FlushThrottled()
		{
			lock (s_lock)
			{
				var now = DateTime.UtcNow;
				if (now - s_lastFlush >= FlushGate)
				{
					s_lastFlush = now;
					s_flushScheduled = false;
				}
				else if (!s_flushScheduled)
				{
					s_flushScheduled = true;
					var wait = FlushGate - (now - s_lastFlush);
					System.Threading.Tasks.Task.Delay(wait).ContinueWith(_ =>
					{
						lock (s_lock) s_flushScheduled = false;
						Flush();
					});
					return;
				}
				else
				{
					return;
				}
			}

			Flush();
		}
	}
}