#!/usr/bin/env bash
# Dev deployment: build RemoteDispatch + the new Signals bridge and copy them into the
# installed RemoteDispatch mod folder.
#
# The old API bridge (RemoteDispatch.SignalsMP.dll) is deliberately NOT touched here:
# only one Signals mod can be installed at a time, and the new fork is what we maintain
# going forward. If you need to rebuild the MP bridge, build RemoteDispatch.SignalsMP/
# and copy it manually.
set -euo pipefail

CONFIG="${1:-Debug}"
MOD_DIR="$HOME/.local/share/Steam/steamapps/common/Derail Valley/Mods/RemoteDispatch"

dotnet build RemoteDispatch.sln -c "$CONFIG"

cp "RemoteDispatch/bin/$CONFIG/netstandard2.0/RemoteDispatch.dll" "$MOD_DIR/RemoteDispatch.dll"
cp "RemoteDispatch.Signals/bin/$CONFIG/netstandard2.0/RemoteDispatch.Signals.dll" "$MOD_DIR/RemoteDispatch.Signals.dll"

# Clear stale cache files so UnityModManager reloads the fresh DLLs
rm -f "$MOD_DIR"/RemoteDispatch.dll.*.cache

echo "Deployed RemoteDispatch.dll + RemoteDispatch.Signals.dll to $MOD_DIR"
