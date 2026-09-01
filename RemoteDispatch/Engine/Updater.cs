using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Threading.Tasks;
using UnityEngine;

namespace DvMod.RemoteDispatch
{
    public class Updater : MonoBehaviour
    {
		public void Start()
		{
			StartCoroutine(CheckPlayerTransformCoro());
			StartCoroutine(CheckTrainsetsCoro());
			StartCoroutine(DeferredEventsCoro());
			StartCoroutine(CheckOccupancyCoro());
			StartCoroutine(CheckStagingCoro());
		}

        private static GameObject? rootObject;
        private static Coroutine? _sweep;

        /// <summary>The GameObject hosting this component; null until Create() ran.</summary>
        public static GameObject? Root => rootObject;

        public static void Create()
        {
            if (rootObject == null)
            {
                rootObject = new GameObject();
                GameObject.DontDestroyOnLoad(rootObject);
                rootObject.AddComponent<Updater>();
            }
        }

        public static void Destroy()
        {
            if (rootObject != null)
            {
                StopSweep();
                GameObject.Destroy(rootObject);
                rootObject = null;
            }
        }

        // Hosts the pacing coroutine for full-map signal sweeps (pathing enable/disable).
        // The coroutine runs on the Updater component so it executes on the Unity main
        // thread and is torn down with the rest of the mod.
        public static void StartSweep(IEnumerator routine)
        {
            if (rootObject == null) return;
            if (_sweep != null)
            {
                rootObject.GetComponent<Updater>().StopCoroutine(_sweep);
                _sweep = null;
            }
            _sweep = rootObject.GetComponent<Updater>().StartCoroutine(routine);
        }

        public static void StopSweep()
        {
            if (_sweep == null || rootObject == null)
            {
                _sweep = null;
                return;
            }
            rootObject.GetComponent<Updater>().StopCoroutine(_sweep);
            _sweep = null;
        }

        private IEnumerator CheckPlayerTransformCoro()
        {
            while (true)
            {
                yield return WaitFor.Seconds(0.1f);
                PlayerData.CheckTransform();
            }
        }

        private IEnumerator CheckTrainsetsCoro()
        {
            while (true)
            {
                foreach (var trainset in Trainset.allSets)
                {
                    if (!trainset.firstCar.isStationary)
                    {
                        CarUpdater.MarkTrainsetAsDirty(trainset);
                    }
                }
                yield return null;
            }
        }

        private IEnumerator DeferredEventsCoro()
        {
            while (true)
            {
                while (taskQueue.TryDequeue(out var action))
                    action();
                yield return null;
            }
        }

		private IEnumerator CheckOccupancyCoro()
		{
			while (true)
			{
				yield return WaitFor.Seconds(0.5f);
				if (OccupancyData.HasMapping && OccupancyData.CheckChanged())
				{
					Sessions.AddTag("occupancy");
				}
			}
		}

		private IEnumerator CheckStagingCoro()
		{
			while (true)
			{
				yield return WaitFor.Seconds(0.5f);
				if (OccupancyData.HasMapping && Main.settings.featureFlags.enablePathing)
				{
					StagingData.Process();
				}
			}
		}

        private static readonly ConcurrentQueue<Action> taskQueue = new ConcurrentQueue<Action>();

        public static Task RunOnMainThread(Action action)
        {
            var tcs = new TaskCompletionSource<bool>();
            taskQueue.Enqueue(() =>
            {
                try
                {
                    action();
                    tcs.SetResult(true);
                }
                catch (Exception e)
                {
                    tcs.SetException(e);
                }
            });
            return tcs.Task;
        }

        public static Task<T> RunOnMainThread<T>(Func<T> func)
        {
            var tcs = new TaskCompletionSource<T>();
            taskQueue.Enqueue(() =>
            {
                try
                {
                    tcs.SetResult(func());
                }
                catch (Exception e)
                {
                    tcs.SetException(e);
                }
            });
            return tcs.Task;
        }
    }
}
