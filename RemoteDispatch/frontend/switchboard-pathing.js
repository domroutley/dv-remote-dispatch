const PathingController = {
    enabled: false,
    state: 'idle',
    waypoints: [],
    draftPathId: null,
    anchorBlockId: null,
    _submitting: false,
    currentPathBlocks: [],
    currentPathSwitchAssignments: {},
    lockedPaths: [],
    _blockGraph: null,
    _blockSwitchPorts: null,
    _onKeyDown: null,
    _hoverBlockId: null,
    _hoverTimer: null,
    _needsRerender: false,
    _serverActive: false,
    _pathTreeValid: null,
    _pathTreeSoft: null,
    _pathTreeCount: 0,
    _pathStatusTable: new Map(),
    _pathColors: new Map(),
    _blockSwitchSegments: new Map(),
    _switchBlockIds: new Set(),
    _waypointMarkers: new Map(),
    _wasInteracting: false,

    MODE_YELLOW: '#c9a800',
    MODE_RED: '#a02020',
    MODE_PURPLE: '#a44be0',
    MODE_GREEN: '#2fbf4f',
    OCCUPIED_PENALTY: 5,

    get showGrayClear() {
        return this.enabled;
    },

    _isDrawing() {
        return this.state === 'drafting';
    },

    buildBlockGraph() {
        const graph = new Map();
        if (!TrackData.blocks || !TrackData.segments) return graph;

        for (const [blockId] of TrackData.blocks) {
            graph.set(blockId, { neighbors: [] });
        }

        this._blockSwitchPorts = new Map();
        this._switchSwitchPorts = new Map();
        this._blockSwitchSegments = new Map();

        const nodeToBlocks = new Map();
        for (const [segId, seg] of TrackData.segments) {
            if (!seg.blockId) continue;
            if (seg.type === 'switch') {
                this._blockSwitchSegments.set(seg.blockId, segId);
            }
            for (const nodeName of ['n1', 'n2', 'merging', 'nl', 'nr']) {
                const nid = seg[nodeName];
                if (!nid) continue;
                if (!nodeToBlocks.has(nid)) nodeToBlocks.set(nid, []);
                if (!nodeToBlocks.get(nid).find(e => e.blockId === seg.blockId && e.segId === segId))
                    nodeToBlocks.get(nid).push({ blockId: seg.blockId, segId, type: seg.type });
            }
        }
        this._switchBlockIds = new Set(this._blockSwitchSegments.keys());

        for (const [nodeId, entries] of nodeToBlocks) {
            if (entries.length < 2) continue;
            for (let i = 0; i < entries.length; i++) {
                for (let j = i + 1; j < entries.length; j++) {
                    const a = entries[i], b = entries[j];
                    if (a.blockId === b.blockId) continue;
                    this._addEdge(graph, a, b, nodeId);
                    this._addEdge(graph, b, a, nodeId);
                }
            }
        }

        this._blockGraph = graph;
        this._pathTreeValid = null;
        this._pathTreeSoft = null;
        this._pathTreeCount++;
        return graph;
    },

    _addEdge(graph, from, to, nodeId) {
        const entry = graph.get(from.blockId);
        if (!entry || entry.neighbors.find(n => n.blockId === to.blockId)) return;

        const fromSeg = TrackData.getSegment(from.segId);
        const toSeg = TrackData.getSegment(to.segId);

        let port = null;
        if (fromSeg.type === 'switch') {
            for (const { nodeName, portName } of [
                { nodeName: 'merging', portName: 'common' },
                { nodeName: 'nl', portName: 'left' },
                { nodeName: 'nr', portName: 'right' }
            ]) {
                if (fromSeg[nodeName] === nodeId) { port = portName; break; }
            }
        }

        entry.neighbors.push({ blockId: to.blockId, port: port });

        if (fromSeg.type === 'switch' || toSeg.type === 'switch') {
            const key = `${to.blockId}@${from.blockId}`;
            if (!this._blockSwitchPorts.has(key))
                this._blockSwitchPorts.set(key, port);
        }
    },

    _getPortForBlockAtSwitch(blockId, switchBlockId) {
        return this._blockSwitchPorts.get(`${blockId}@${switchBlockId}`) || null;
    },

    // State keys for the state-space search: a plain block id when there is no
    // entry port (non-switch blocks, and the source), otherwise blockId@port.
    // Block ids are of the form "b{n}" and never contain '@'.
    _stateKey(blockId, inPort) {
        return inPort ? `${blockId}@${inPort}` : blockId;
    },

    _blockOfState(stateKey) {
        const at = stateKey.indexOf('@');
        return at === -1 ? stateKey : stateKey.slice(0, at);
    },

    _inPortOfState(stateKey) {
        const at = stateKey.indexOf('@');
        return at === -1 ? null : stateKey.slice(at + 1);
    },

    computeBlockPath(fromBlockId, toBlockId) {
        if (!this._blockGraph) this.buildBlockGraph();
        const graph = this._blockGraph;
        if (!graph.has(fromBlockId) || !graph.has(toBlockId)) return null;

        // Valid tier first: a route avoiding occupied through-blocks always wins.
        // The start block itself is exempt so a train can leave its own block.
        const validTree = this._ensurePathTree(fromBlockId, 'valid');
        const validPath = this._tracePath(validTree, toBlockId, fromBlockId);
        if (validPath) return this._finalizePath(validPath);

        // Soft tier: short occupied routes only when no clear route exists, so a
        // dispatcher is never dead-ended but a clear detour still wins.
        const softTree = this._ensurePathTree(fromBlockId, 'soft');
        const softPath = this._tracePath(softTree, toBlockId, fromBlockId);
        if (softPath) return this._finalizePath(softPath);

        return null;
    },

    // Reconstructs a plain block sequence from a state-space tree, starting at
    // the cheapest settled state for the target block and walking parent states
    // back to the source state. A block has at most three settled states (one
    // per switch port), so it tries each cheapest-first and only accepts a
    // simple route: a path that would have to re-enter a block (a reversal /
    // shunting move) is rejected so a route never contains a block twice.
    // Returns null if no simple route reaches the target.
    _tracePath(treeData, toBlockId, fromBlockId) {
        const tree = treeData.tree;
        const startKey = this._stateKey(fromBlockId, null);
        const terminalStates = treeData.best.get(toBlockId) || [];
        for (const terminalKey of terminalStates) {
            const path = [];
            let key = terminalKey;
            while (key !== undefined) {
                path.unshift(this._blockOfState(key));
                if (key === startKey) break;
                key = tree.get(key);
            }
            if (path[0] !== fromBlockId) continue;
            if (new Set(path).size !== path.length) continue;
            return path;
        }
        return null;
    },

    // Derives switch assignments for a plain block sequence. The search
    // (_ensurePathTree) already guarantees every switch is traversed legally
    // (through its common port), so this never rejects a route - it only maps
    // each switch's entry/exit ports to the branch (0 = left, 1 = right).
    _finalizePath(path) {
        const switchAssignments = {};
        for (let i = 1; i < path.length - 1; i++) {
            const blockId = path[i];
            if (!this._switchBlockIds.has(blockId)) continue;

            const prevBlock = path[i - 1];
            const nextBlock = path[i + 1];

            const inPort = this._getPortForBlockAtSwitch(prevBlock, blockId);
            const outPort = this._getPortForBlockAtSwitch(nextBlock, blockId);
            if (!inPort || !outPort) continue;

            // Exactly one of in/out is 'common' (guaranteed by the search); the
            // other is the branch taken.
            const branch = inPort === 'right' || outPort === 'right' ? 1 : 0;
            switchAssignments[blockId] = branch;
        }
        return { blocks: path, switchAssignments };
    },

    // Chains computeBlockPath over [start, ...waypoints, dest], merging the
    // hops and dropping the shared boundary block between consecutive hops.
    // Waypoints are forced intermediate anchors for the draft route; they are
    // not sent to the server and are forgotten once the path is confirmed.
    computePathWithWaypoints(fromBlockId, toBlockId, waypoints) {
        const anchors = [fromBlockId];
        for (const w of waypoints) {
            if (w !== anchors[anchors.length - 1]) anchors.push(w);
        }
        if (toBlockId !== anchors[anchors.length - 1]) anchors.push(toBlockId);
        if (anchors.length < 2) return null;

        const blocks = [];
        const switchAssignments = {};
        for (let i = 1; i < anchors.length; i++) {
            const hop = this.computeBlockPath(anchors[i - 1], anchors[i]);
            if (!hop) return null;
            const hopBlocks = hop.blocks;
            const startSlice = (blocks.length === 0) ? 0 : 1;
            for (let j = startSlice; j < hopBlocks.length; j++) blocks.push(hopBlocks[j]);
            Object.assign(switchAssignments, hop.switchAssignments);
        }
        return { blocks, switchAssignments };
    },

    // Per-source, per-occupancy-generation shortest-path tree.
    //   tier 'valid' - occupied through-blocks are hard-blocked (the source
    //      block itself is exempt, so a train can leave its own block).
    //   tier 'soft'  - occupied blocks are routable but penalised.
    // Both tiers are memoized per (source, tier, occupancy generation) and are
    // invalidated together on occupancy change (see invalidatePathTree).
    //
    // The search runs over a small state space (block, entry port) so it can
    // refuse to traverse a switch "backwards": a switch may only be passed
    // through its common port (common <-> left or common <-> right). The entry
    // port only matters for switch blocks; the source block starts with no
    // entry port, so a train may depart from any port. Returns { tree, best }
    // where tree maps each state key to its parent state and best maps each
    // block to its settled states in increasing cost (used by _tracePath to
    // pick the cheapest simple route to a plain block id).
    _ensurePathTree(source, tier) {
        if (!this._blockGraph) this.buildBlockGraph();
        const graph = this._blockGraph;

        const key = `${source}#${tier}#${this._pathTreeCount}`;
        const cached = tier === 'valid' ? this._pathTreeValid : this._pathTreeSoft;
        if (cached && cached.key === key) {
            return cached;
        }

        const blocked = tier === 'valid'
            ? blockId => {
                if (blockId === source) return false;
                const b = TrackData.getBlock(blockId);
                return !!(b && b.occupancyState === 'occupied');
            }
            : () => false;

        const startKey = this._stateKey(source, null);
        const cameFrom = new Map();
        cameFrom.set(startKey, undefined);
        const gScore = new Map([[startKey, 0]]);
        const heap = [{ key: startKey, g: 0 }];
        const closed = new Set();
        const best = new Map();

        const heapPush = item => {
            const h = heap;
            h.push(item);
            let i = h.length - 1;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (h[p].g <= h[i].g) break;
                const t = h[p]; h[p] = h[i]; h[i] = t;
                i = p;
            }
        };
        const heapPop = () => {
            const h = heap;
            const top = h[0];
            const last = h.pop();
            if (h.length > 0 && last) {
                h[0] = last;
                let i = 0;
                while (true) {
                    const l = i * 2 + 1;
                    const r = l + 1;
                    let smallest = i;
                    if (l < h.length && h[l].g < h[smallest].g) smallest = l;
                    if (r < h.length && h[r].g < h[smallest].g) smallest = r;
                    if (smallest === i) break;
                    const t = h[i]; h[i] = h[smallest]; h[smallest] = t;
                    i = smallest;
                }
            }
            return top;
        };

        while (heap.length > 0) {
            const { key: curKey, g: curG } = heapPop();
            if (closed.has(curKey)) continue;
            closed.add(curKey);
            const curBlockId = this._blockOfState(curKey);
            const settled = best.get(curBlockId);
            if (settled) settled.push(curKey);
            else best.set(curBlockId, [curKey]);
            const curInPort = this._inPortOfState(curKey);

            const entry = graph.get(curBlockId);
            if (!entry) continue;

            for (const neighbor of entry.neighbors) {
                const nbrId = neighbor.blockId;
                if (blocked(nbrId)) continue;

                const outPort = neighbor.port;
                // Refuse to traverse the current block backwards: a switch may
                // only be passed through its common port. The source state has
                // no entry port, so its departure is unconstrained.
                if (this._switchBlockIds.has(curBlockId) && curInPort &&
                    (curInPort === 'common') === (outPort === 'common')) {
                    continue;
                }

                const nbrInPort = this._switchBlockIds.has(nbrId)
                    ? this._getPortForBlockAtSwitch(curBlockId, nbrId)
                    : null;
                const nbrKey = this._stateKey(nbrId, nbrInPort);
                if (closed.has(nbrKey)) continue;

                const tentG = curG + this._edgeCost(nbrId, tier);
                if (tentG < (gScore.get(nbrKey) ?? Infinity)) {
                    gScore.set(nbrKey, tentG);
                    cameFrom.set(nbrKey, curKey);
                    heapPush({ key: nbrKey, g: tentG });
                }
            }
        }

        const result = { tree: cameFrom, best };
        if (tier === 'valid')
            this._pathTreeValid = { key, tree: cameFrom, best };
        else
            this._pathTreeSoft = { key, tree: cameFrom, best };
        return result;
    },

    // Cost of entering a block. In the valid tier every step costs 1 (hard
    // blockage is enforced in _ensurePathTree); in the soft tier occupied
    // blocks are penalised so a clear detour still usually wins, but an
    // occupied route remains usable when it is the only option.
    _edgeCost(blockId, tier) {
        if (tier === 'valid') return 1;
        const block = TrackData.getBlock(blockId);
        if (block && block.occupancyState === 'occupied') return 1 + this.OCCUPIED_PENALTY;
        return 1;
    },

    // Occupancy changed, so edge costs may have changed too. Drop the memoized
    // per-source trees; they are recomputed lazily on the next hover query.
    invalidatePathTree() {
        this._pathTreeValid = null;
        this._pathTreeSoft = null;
        this._pathTreeCount++;
    },

    _getSignalIdsForPath(path) {
        const ids = [];
        for (let i = 1; i < path.length - 1; i++) {
            const blockId = path[i];
            const prevBlock = path[i - 1];
            const entryPort = this._getPortForBlockAtSwitch(prevBlock, blockId);
            if (!entryPort) continue;
            for (const [segId, seg] of TrackData.segments) {
                if (seg.type !== 'switch') continue;
                if (seg.blockId !== blockId) continue;
                const rawSigs = SwitchboardMapper.switchboardGraph?.get(segId)?.rawSignals;
                if (!rawSigs) continue;
                if (entryPort === 'common' && rawSigs.Out && rawSigs.Out.Id)
                    ids.push(rawSigs.Out.Id);
                if (entryPort === 'left' && rawSigs.LeftIn && rawSigs.LeftIn.Id)
                    ids.push(rawSigs.LeftIn.Id);
                if (entryPort === 'right' && rawSigs.RightIn && rawSigs.RightIn.Id)
                    ids.push(rawSigs.RightIn.Id);
            }
        }
        return ids;
    },

    _getBlockSignalIds(path) {
        const blockSignals = {};
        for (let i = 1; i < path.length - 1; i++) {
            const blockId = path[i];
            const prevBlock = path[i - 1];
            const entryPort = this._getPortForBlockAtSwitch(prevBlock, blockId);
            if (!entryPort) continue;
            for (const [segId, seg] of TrackData.segments) {
                if (seg.type !== 'switch') continue;
                if (seg.blockId !== blockId) continue;
                const rawSigs = SwitchboardMapper.switchboardGraph?.get(segId)?.rawSignals;
                if (!rawSigs) continue;
                let sigId = null;
                if (entryPort === 'common' && rawSigs.Out && rawSigs.Out.Id)
                    sigId = rawSigs.Out.Id;
                else if (entryPort === 'left' && rawSigs.LeftIn && rawSigs.LeftIn.Id)
                    sigId = rawSigs.LeftIn.Id;
                else if (entryPort === 'right' && rawSigs.RightIn && rawSigs.RightIn.Id)
                    sigId = rawSigs.RightIn.Id;
                if (sigId) blockSignals[blockId] = sigId;
            }
        }
        return blockSignals;
    },

    _resetSelection() {
        this.state = 'idle';
        this.draftPathId = null;
        this.anchorBlockId = null;
        this._submitting = false;
        this.waypoints = [];
        this.currentPathBlocks = [];
        this.currentPathSwitchAssignments = {};
        this._pathTreeValid = null;
        this._pathTreeSoft = null;
        this._clearWaypointMarkers();
        this._clearAnchorMarkers();
    },

    onBlockClick(blockId) {
        if (!this.enabled) return;
        this._needsRerender = false;
        if (this._hoverTimer) {
            clearTimeout(this._hoverTimer);
            this._hoverTimer = null;
        }
        if (this.state === 'idle') {
            if (this._submitting) return;
            this.beginNewPath(blockId);
        } else if (this.state === 'drafting') {
            if (this._submitting) return;
            if (blockId === this.anchorBlockId) return;
            const result = this.computePathWithWaypoints(this.anchorBlockId, blockId, this.waypoints);
            if (result && result.blocks.length > 0) {
                this._needsRerender = true;
                this.commitSection(result.blocks, result.switchAssignments);
            } else {
                this.updateStatus('No path found between those blocks.');
            }
        }
    },

    onBlockContextMenu(blockId) {
        if (!this.enabled) return;
        if (!this._isDrawing()) return;
        if (blockId === this.anchorBlockId) return;

        const idx = this.waypoints.indexOf(blockId);
        if (idx >= 0) {
            this.waypoints.splice(idx, 1);
            this._removeWaypointMarker(blockId);
            this.updateStatus(`Waypoint ${blockId} removed. ${this.waypoints.length} waypoint(s).`);
        } else {
            this.waypoints.push(blockId);
            this._addWaypointMarker(blockId);
            this.updateStatus(`Waypoint added: ${blockId} [${this.waypoints.join(' -> ')}]. Now click a block to add the section.`);
        }
        this._refreshHoverPath();
    },

    // Recompute the draft preview after a waypoint toggle so the shown route
    // reroutes through the (new) waypoint set.
    _refreshHoverPath() {
        if (!this._isDrawing() || !this._hoverBlockId) return;
        if (this._hoverTimer) {
            clearTimeout(this._hoverTimer);
            this._hoverTimer = null;
        }
        const hoverBlockId = this._hoverBlockId;
        const source = this.anchorBlockId;
        const result = this.computePathWithWaypoints(source, hoverBlockId, this.waypoints);
        const oldBlocks = this.currentPathBlocks;
        this.currentPathBlocks = [];
        this.currentPathSwitchAssignments = {};
        if (oldBlocks.length > 0)
            this._updateSegmentColors(oldBlocks);
        if (result && result.blocks.length > 0) {
            this.currentPathBlocks = result.blocks;
            this.currentPathSwitchAssignments = result.switchAssignments;
            this._updateSegmentColors(result.blocks);
        }
    },

    onSegmentContextMenu(segmentId) {
        if (!this.enabled) return;
        const seg = TrackData.getSegment(segmentId);
        if (!seg || !seg.blockId) return;
        this.onBlockContextMenu(seg.blockId);
    },

    // Purple dot markers for draft waypoints. They are selection-only layers,
    // kept separate from the coalesced block repaints, and are torn down on
    // reset/confirm.
    _getBlockCenter(blockId) {
        const block = TrackData.getBlock(blockId);
        if (!block || !block.segmentIds || block.segmentIds.length === 0) return null;
        let sx = 0, sy = 0, count = 0;
        for (const segId of block.segmentIds) {
            const seg = TrackData.getSegment(segId);
            if (!seg) continue;
            for (const nodeId of [seg.n1, seg.n2, seg.merging, seg.nl, seg.nr]) {
                const node = TrackData.getNode(nodeId);
                if (!node) continue;
                sx += node.x; sy += node.y; count++;
            }
        }
        if (count === 0) return null;
        return { x: sx / count, y: sy / count };
    },

    _addWaypointMarker(blockId) {
        if (!switchboardMap || this._waypointMarkers.has(blockId)) return;
        const center = this._getBlockCenter(blockId);
        if (!center) return;
        const pos = switchboardRenderer ? switchboardRenderer.coordsToLatLng(center.x, center.y) : L.latLng(center.y, center.x);
        const marker = L.circle(pos, {
            radius: 0.45,
            color: '#fff',
            weight: 1,
            fillColor: this.MODE_PURPLE,
            fillOpacity: 1
        }).addTo(switchboardMap);
        this._waypointMarkers.set(blockId, marker);
    },

    _removeWaypointMarker(blockId) {
        const marker = this._waypointMarkers.get(blockId);
        if (marker) {
            if (switchboardMap) switchboardMap.removeLayer(marker);
            this._waypointMarkers.delete(blockId);
        }
    },

    _clearWaypointMarkers() {
        if (!switchboardMap) {
            this._waypointMarkers.clear();
            return;
        }
        for (const marker of this._waypointMarkers.values()) {
            switchboardMap.removeLayer(marker);
        }
        this._waypointMarkers.clear();
    },

    onBlockHover(blockId) {
        if (!this._isDrawing()) return;
        if (blockId === this.anchorBlockId || blockId === this._hoverBlockId) return;
        if (this._needsRerender) return;
        this._hoverBlockId = blockId;

        if (this._hoverTimer) {
            clearTimeout(this._hoverTimer);
            this._hoverTimer = null;
        }

        this._hoverTimer = setTimeout(() => {
            this._hoverTimer = null;
            const source = this.anchorBlockId;
            const result = this.computePathWithWaypoints(source, blockId, this.waypoints);
            const oldBlocks = this.currentPathBlocks;
            this.currentPathBlocks = [];
            this.currentPathSwitchAssignments = {};
            if (oldBlocks.length > 0)
                this._updateSegmentColors(oldBlocks);
            if (result && result.blocks.length > 0) {
                this.currentPathBlocks = result.blocks;
                this.currentPathSwitchAssignments = result.switchAssignments;
                this._updateSegmentColors(result.blocks);
            }
        }, 30);
    },

    onBlockHoverEnd() {
        if (this._needsRerender) return;
        this._hoverBlockId = null;
        if (this._hoverTimer) {
            clearTimeout(this._hoverTimer);
            this._hoverTimer = null;
        }
    },

    _updateSegmentColors(blockIds) {
        if (typeof switchboardRenderer === 'undefined' || !switchboardRenderer) return;
        for (const blockId of blockIds) {
            const segmentIds = this._getSegmentIdsForBlock(blockId);
            for (const segId of segmentIds) {
                const seg = TrackData.getSegment(segId);
                if (!seg) continue;
                const color = this._getSegmentColor(segId);
                switchboardRenderer.setSegmentColor(seg, color);
            }
        }
    },

    _getSegmentIdsForBlock(blockId) {
        const block = TrackData.getBlock(blockId);
        if (!block || !block.segmentIds) return [];
        return block.segmentIds;
    },

    _getSegmentColor(segId) {
        const seg = TrackData.getSegment(segId);
        if (!seg || !seg.blockId) return null;
        const blockId = seg.blockId;

        if (this.state === 'drafting' && blockId === this.anchorBlockId)
            return this.MODE_GREEN;

        if (this.currentPathBlocks.includes(blockId)) {
            const block = TrackData.getBlock(blockId);
            if (block && block.occupancyState === 'occupied') return this.MODE_RED;
            if (this.waypoints.includes(blockId)) return this.MODE_PURPLE;
            return this.MODE_YELLOW;
        }

        if (this.waypoints.includes(blockId)) return this.MODE_PURPLE;

        if (typeof switchboardRenderer !== 'undefined' && switchboardRenderer.resolveBlockColor)
            return switchboardRenderer.resolveBlockColor(blockId, segId);

        const block = TrackData.getBlock(blockId);
        if (!block) return '#888';
        if (block.occupancyState === 'occupied') return this.MODE_RED;
        return '#888';
    },

    getBlockPathStatusTable() {
        return this._pathStatusTable;
    },

    // Rebuild the blockId -> { claimed, claimedPaths, upcomingCount, upcomingPaths }
    // table once per paths sync. resolveBlockColor reads this instead of scanning
    // every path per segment, so block colouring is O(blocks + paths) instead of
    // O(segments x paths) per repaint. Also assigns a stable random colour to
    // each path id (kept in _pathColors across syncs) so colours persist between
    // polls and across page reloads until the paths themselves change.
    rebuildPathStatusTable() {
        const table = new Map();
        if (this.enabled) {
            const usedColors = new Set();
            for (const o of this.lockedPaths) {
                if (o && o.color) usedColors.add(o.color);
            }
            const assigned = new Set();
            for (const p of this.lockedPaths) {
                if (!p || !p.id) continue;
                // A server-persisted colour (user-set via the hue slider) wins, then
                // the in-session _pathColors map, then a fresh random blue-dominant one.
                let color = p.color || this._pathColors.get(p.id);
                if (!color) {
                    let tries = 0;
                    do {
                        color = switchboardRenderer.randomPathColor();
                    } while (color && usedColors.has(color) && ++tries < 32);
                }
                this._pathColors.set(p.id, color);
                usedColors.add(color);
                if (assigned.has(p.id)) continue;
                assigned.add(p.id);
                p.color = color;
            }
            for (const p of this.lockedPaths) {
                if (!p.blocks) continue;
                for (const blockId of p.blocks) {
                    let entry = table.get(blockId);
                    if (!entry) {
                        entry = {
                            claimed: false,
                            claimedPaths: [],
                            upcomingCount: 0,
                            upcomingPaths: []
                        };
                        table.set(blockId, entry);
                    }
                    const state = p.blockStates && p.blockStates[blockId];
                    if (state === 'claimed') {
                        entry.claimed = true;
                        entry.claimedPaths.push(p);
                    } else {
                        entry.upcomingCount++;
                        entry.upcomingPaths.push(p);
                    }
                }
            }
        }
        this._pathStatusTable = table;
    },

    // Start a new path: the clicked block must be occupied (the train is here),
    // and it becomes the anchor for the first drafted section. After the first
    // section is committed the flow stays in drafting so further sections chain
    // exactly like extending a locked path.
    beginNewPath(blockId) {
        if (!this.enabled) return;
        const block = TrackData.getBlock(blockId);
        if (!block || block.occupancyState !== 'occupied') {
            this.updateStatus('Start block must be occupied by a train.');
            return;
        }
        this._resetSelection();
        this._needsRerender = false;
        this.draftPathId = null;
        this.anchorBlockId = blockId;
        this._addAnchorMarker(blockId);
        this.state = 'drafting';
        this.rerender();
        this.updateStatus(`New path from block ${blockId}. Click a block to add the first section (Esc to cancel).`);
    },

    // Enter drafting for a locked path: the current last block becomes the
    // anchor, and the same hover/A* drawing (including right-click waypoints)
    // drafts an extension section from it. The user stays in drafting after each
    // confirm, re-anchored at the new route end, so sections can be chained.
    // Esc / map right-click returns to idle.
    beginExtendPath(pathId) {
        if (!this.enabled) return;
        const p = this.lockedPaths.find(x => x.id === pathId);
        if (!p || !p.blocks || p.blocks.length === 0) return;

        this._resetSelection();
        this._needsRerender = false;
        this.draftPathId = pathId;
        this.anchorBlockId = p.blocks[p.blocks.length - 1];

        this._addAnchorMarker(this.anchorBlockId);
        this.state = 'drafting';
        this.rerender();
        this.updateStatus(`Extending path ${pathId} from block ${this.anchorBlockId}. Click a block to add a section (Esc to cancel).`);
    },

    // The single commit point for a drafted section. A new path (draftPathId
    // null) POSTs the first section; extending a locked path PATCHes the merged
    // route. Both re-anchor at the new end and stay in drafting, so sections
    // chain through the same flow. Self-overlap is rejected (except the shared
    // anchor block) so a path cannot loop back on itself. Staging conflicts
    // with other paths are handled server-side by the claim engine, so no
    // frontend check is needed.
    commitSection(sectionBlocks, sectionSwitchAssignments) {
        if (this.state !== 'drafting' || this._submitting) return;

        const pathId = this.draftPathId;
        const isNew = !pathId;
        const p = isNew ? null : this.lockedPaths.find(x => x.id === pathId);
        if (!isNew && !p) return;

        const existing = isNew ? [this.anchorBlockId] : (p.blocks || []);
        const anchor = this.anchorBlockId;
        const inExisting = new Set();
        for (const b of existing) {
            if (b !== anchor) inExisting.add(b);
        }
        for (const b of sectionBlocks) {
            if (inExisting.has(b)) {
                this.updateStatus(`Cannot extend: section passes through block ${b} already in the path.`);
                return;
            }
        }

        const merged = existing.slice();
        const startSlice = (existing.length > 0 && existing[existing.length - 1] === sectionBlocks[0]) ? 1 : 0;
        for (let i = startSlice; i < sectionBlocks.length; i++) merged.push(sectionBlocks[i]);

        const switchAssignments = Object.assign({}, isNew ? {} : (p.switchAssignments || {}), sectionSwitchAssignments);
        const signalIds = this._getSignalIdsForPath(merged);
        const blockSignals = this._getBlockSignalIds(merged);

        const pathEntry = {
            blocks: merged,
            startBlock: isNew ? this.anchorBlockId : p.startBlock,
            destBlock: merged[merged.length - 1],
            switchAssignments: switchAssignments,
            signalIds: signalIds,
            blockSignals: blockSignals
        };

        const newAnchor = merged[merged.length - 1];
        this._resetSelection();
        this._submitting = true;

        const resume = (ok, message, nextPathId) => {
            this._submitting = false;
            if (!ok) {
                this.rerender();
                this.updateStatus(message);
                return;
            }
            fetch(new URL('/path', location))
                .then(r => r.json())
                .then(serverData => {
                    this.syncFromServer(serverData);
                    this.state = 'drafting';
                    this.draftPathId = nextPathId || null;
                    this.anchorBlockId = newAnchor;
                    this._needsRerender = false;
                    this._addAnchorMarker(newAnchor);
                    this.rerender();
                    this.updateStatus(`${isNew ? 'Path created' : 'Extended path'} (${merged.length} blocks). Click a block to keep adding (Esc to cancel).`);
                });
        };

        if (isNew) {
            fetch(new URL('/path', location), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pathEntry)
            })
            .then(resp => resp.ok ? resp.json() : null)
            .then(data => {
                if (data && data.id) resume(true, '', data.id);
                else resume(false, 'Failed to create path.');
            })
            .catch(() => resume(false, 'Failed to create path.'));
        } else {
            fetch(new URL(`/path/${pathId}`, location), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pathEntry)
            })
            .then(resp => {
                if (resp.ok) resume(true, '', pathId);
                else resume(false, `Failed to extend path ${pathId}.`);
            })
            .catch(() => resume(false, `Failed to extend path ${pathId}.`));
        }
    },

    _anchorMarkers: new Map(),

    _addAnchorMarker(blockId) {
        if (!switchboardMap || this._anchorMarkers.has(blockId)) return;
        const center = this._getBlockCenter(blockId);
        if (!center) return;
        const pos = switchboardRenderer ? switchboardRenderer.coordsToLatLng(center.x, center.y) : L.latLng(center.y, center.x);
        const marker = L.circle(pos, {
            radius: 0.45,
            color: '#fff',
            weight: 1,
            fillColor: this.MODE_GREEN,
            fillOpacity: 1
        }).addTo(switchboardMap);
        this._anchorMarkers.set(blockId, marker);
    },

    _clearAnchorMarkers() {
        if (!switchboardMap) {
            this._anchorMarkers.clear();
            return;
        }
        for (const marker of this._anchorMarkers.values()) {
            switchboardMap.removeLayer(marker);
        }
        this._anchorMarkers.clear();
    },

    onSegmentClick(segmentId) {
        if (!this.enabled) return;
        const seg = TrackData.getSegment(segmentId);
        if (!seg || !seg.blockId) return;
        this.onBlockClick(seg.blockId);
    },

    onSegmentHover(segmentId) {
        if (!this._isDrawing()) return;
        const seg = TrackData.getSegment(segmentId);
        if (!seg || !seg.blockId) return;
        this.onBlockHover(seg.blockId);
    },

    onSegmentHoverEnd() {
        this.onBlockHoverEnd();
    },

    syncFromServer(serverPaths) {
        if (!this.enabled) return;
        const oldBlockIds = new Set();
        for (const p of this.lockedPaths) {
            if (p.blocks) for (const b of p.blocks) oldBlockIds.add(b);
        }

        const paths = Array.isArray(serverPaths) ? serverPaths : [];
        this.lockedPaths = paths;
        this.rebuildPathStatusTable();

        const allBlockIds = new Set(oldBlockIds);
        for (const p of this.lockedPaths) {
            if (p.blocks) for (const b of p.blocks) allBlockIds.add(b);
        }

        if (typeof switchboardRepaint !== 'undefined' && switchboardRepaint) {
            switchboardRepaint.markBlocks(allBlockIds);
        } else {
            const changedSegments = [];
            const changedSwitches = [];
            for (const blockId of allBlockIds) {
                const block = TrackData.getBlock(blockId);
                if (block && block.segmentIds) {
                    for (const segId of block.segmentIds) {
                        const seg = TrackData.getSegment(segId);
                        if (seg && seg.type === 'switch') changedSwitches.push(segId);
                        else changedSegments.push(segId);
                    }
                }
            }
            this.rerender(changedSegments, changedSwitches);
        }

        this.renderPathList();
    },

    clearAll() {
        if (this.lockedPaths.length === 0) {
            this._resetSelection();
            this.rerender();
            this.updateStatus('');
            return;
        }
        if (!confirm('Clear all paths? This cannot be undone.')) return;
        fetch(new URL('/path', location), { method: 'DELETE' })
            .then(resp => {
                if (resp.ok) {
                    this.lockedPaths = [];
                    this._resetSelection();
                    this.rebuildPathStatusTable();
                    this.rerender();
                    this.updateStatus('All paths cleared.');
                } else if (resp.status === 403) {
                    this.updateStatus('Permission denied.');
                }
            });
    },

    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this.buildBlockGraph();
        this._attachKeyHandler();
        this.updateStatus('Loading paths...');
        fetch(new URL('/path', location))
            .then(resp => resp.json())
            .then(data => {
                this.lockedPaths = Array.isArray(data) ? data : [];
                this.rebuildPathStatusTable();
                this.rerender();
                this.updateStatus('Click an occupied block to start a path, then click to add sections (Esc to cancel).');
            })
            .catch(() => {
                this.rebuildPathStatusTable();
                this.rerender();
                this.updateStatus('Click an occupied block to start a path, then click to add sections (Esc to cancel).');
            });
        this._activateIfNeeded();
    },

    enableFromMapping(enablePathing) {
        const wasEnabled = this.enabled;
        if (!this.enabled && enablePathing) this.enable();
        if (!this.enabled) return;
        // Mapping has now been built (switchboard opened), so re-arm the block
        // graph and send the real activation if it hasn't reached the server yet.
        this.buildBlockGraph();
        if (!wasEnabled) return; // enable() already handled activation
        this._activateIfNeeded();
    },

    _activateIfNeeded() {
        if (this._serverActive) return;
        if (!SwitchboardMapper.mapping || SwitchboardMapper.mapping.size === 0) return;
        this._activateWithRetry();
    },

    _activateWithRetry(attempts) {
        if (attempts === undefined) attempts = 0;
        if (attempts > 20) { console.warn('[Pathing] Activation failed'); return; }
        fetch(new URL('/pathing/activate', location), { method: 'POST' })
            .then(resp => {
                if (resp.ok) {
                    this._serverActive = true;
                    console.log('[Pathing] Activation sent');
                } else if (resp.status === 403) {
                    console.warn('[Pathing] No permission');
                }
            })
            .catch(() => {
                setTimeout(() => this._activateWithRetry(attempts + 1), 1000);
            });
    },

    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this._detachKeyHandler();
        this._resetSelection();
        this.lockedPaths = [];
        this._serverActive = false;
        this.rebuildPathStatusTable();
        this.rerender();
        this.updateStatus('disabled');
    },

    _attachKeyHandler() {
        if (this._onKeyDown) return;
        this._onKeyDown = e => {
            if (e.key === 'Escape') {
                if (this.state !== 'idle') {
                    this._resetSelection();
                    this.rerender();
                    this.updateStatus('Drafting cancelled. Click an occupied block to start a path, or use \u2295 to extend one.');
                } else if (this.lockedPaths.length > 0) {
                    this.clearAll();
                }
                e.preventDefault();
            }
        };
        document.addEventListener('keydown', this._onKeyDown);
    },

    _detachKeyHandler() {
        if (this._onKeyDown) {
            document.removeEventListener('keydown', this._onKeyDown);
            this._onKeyDown = null;
        }
    },

    _deletePath(pathId) {
        // Two-stage delete: if the path currently has claims, the first press only
        // removes the clearance (fallback to pull the claims without deleting the
        // route - the server drops lookAhead to 0 so it stays unclaimed); a second
        // press (no claims left) deletes the path for good.
        const p = this.lockedPaths.find(x => x.id === pathId);
        const hasClaims = p && p.blocks && p.blockStates
            && p.blocks.some(b => p.blockStates[b] === 'claimed');
        if (hasClaims) {
            fetch(new URL(`/path/${pathId}/unclaim`, location), { method: 'POST' })
                .then(resp => {
                    if (resp.ok) {
                        fetch(new URL('/path', location))
                            .then(r => r.json())
                            .then(data => this.syncFromServer(data));
                        this.updateStatus('Path clearance removed - press \u2716 again to delete.');
                    } else {
                        this.updateStatus('Failed to remove path clearance.');
                    }
                });
            return;
        }
        fetch(new URL(`/path/${pathId}`, location), { method: 'DELETE' })
            .then(resp => {
                if (!resp.ok) return;
                fetch(new URL('/path', location))
                    .then(r => r.json())
                    .then(data => this.syncFromServer(data));
            });
    },

    _saveNote(pathId) {
        const p = this.lockedPaths.find(x => x.id === pathId);
        if (!p) return;
        const input = document.getElementById(`note-${pathId}`);
        if (!input) return;
        const note = input.value.trim();
        fetch(new URL(`/path/${pathId}/note`, location), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: note })
        })
            .then(resp => {
                if (!resp.ok) {
                    console.warn('[Pathing] Failed to save note for', pathId);
                    return;
                }
                p.note = note || undefined;
            });
    },

    // + / - stepper for how many blocks this path claims ahead of itself. The
    // + button grows the window and the server claims it immediately (skipping
    // the 5s pacing timer), so it behaves like the old "Claim next" button.
    _changeLookAhead(pathId, delta) {
        const p = this.lockedPaths.find(x => x.id === pathId);
        if (!p) return;
        const current = (typeof p.lookAhead === 'number') ? p.lookAhead : 5;
        const next = Math.max(0, current + delta);
        if (next === current) return;
        fetch(new URL(`/path/${pathId}/lookahead`, location), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lookAhead: next })
        })
            .then(resp => {
                if (!resp.ok) {
                    console.warn('[Pathing] Failed to set lookahead for', pathId);
                    return;
                }
                p.lookAhead = next;
                this.renderPathList(true);
            });
    },

    _hueOf(color) {
        if (typeof switchboardRenderer !== 'undefined' && switchboardRenderer.hexToHsl) {
            const hsl = switchboardRenderer.hexToHsl(color || '#4080c0');
            if (hsl) return Math.round(hsl.h);
        }
        return 180;
    },

    // Hue slider for the path colour: keeps the current saturation/lightness and
    // only rotates the hue (no blue-dominant restriction).
    _changePathHue(pathId, hue) {
        const p = this.lockedPaths.find(x => x.id === pathId);
        if (!p) return;
        const h = Number(hue) || 0;
        const base = (typeof switchboardRenderer !== 'undefined' && switchboardRenderer.hexToHsl)
            ? switchboardRenderer.hexToHsl(p.color || '#4080c0')
            : null;
        const color = switchboardRenderer.hslToHex(h, base ? base.s : 0.6, base ? base.l : 0.55);
        fetch(new URL(`/path/${pathId}/color`, location), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ color: color })
        })
            .then(resp => {
                if (!resp.ok) {
                    console.warn('[Pathing] Failed to save colour for', pathId);
                    return;
                }
                p.color = color;
                if (this._pathColors) this._pathColors.set(pathId, color);
                if (p.blocks && typeof switchboardRepaint !== 'undefined' && switchboardRepaint && switchboardRepaint.markBlocks) {
                    switchboardRepaint.markBlocks(p.blocks);
                }
                this.renderPathList(true);
            });
    },

    _blockChipColor(blockId) {
        if (typeof switchboardRenderer !== 'undefined' && switchboardRenderer.resolveBlockColor)
            return switchboardRenderer.resolveBlockColor(blockId, null);
        const block = TrackData.getBlock(blockId);
        if (block && block.occupancyState === 'occupied') return this.MODE_RED;
        return '#666';
    },

    renderPathList(force) {
        try {
            if (!force && typeof switchboardRepaint !== 'undefined' && switchboardRepaint && !switchboardRepaint.pathsSignatureChanged()) {
                return;
            }
            const el = document.getElementById('pathList');
            if (!el) return;
            if (!this.enabled || this.lockedPaths.length === 0) {
                el.innerHTML = '';
                return;
            }
            const items = this.lockedPaths.map((p) => {
                const label = `${p.startBlock || '?'} \u2192 ${p.destBlock || '?'}`;
                const note = p.note || '';
                const blockChips = (p.blocks || []).map((b, i) => {
                    const state = (p.blockStates && p.blockStates[b]) || 'unclaimed';
                    const color = this._blockChipColor(b);
                    const isOccupied = color === this.MODE_RED || (state === 'occupied');
                    const extra = isOccupied ? 'border:1px solid #fff;' : 'border:1px solid transparent;';
                    return `<span style="display:inline-block;background:${color};color:#000;font-size:11px;padding:1px 5px;margin:1px;border-radius:3px;${extra}font-weight:600">${b}</span>`;
                }).join('');
                const pid = p.id;
                const pathHue = this._hueOf(p.color);
                const isExtending = this.state === 'drafting' && this.draftPathId === pid;
                const rowStyle = isExtending
                    ? 'margin:6px 0;padding:4px;border:1px solid #2fbf4f;border-radius:4px;'
                    : 'margin:6px 0;padding:4px;';
                return `<div style="${rowStyle}">
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span style="color:#4c4;font-size:14px">\u2713</span>
                        <span style="font-size:13px;font-weight:600;flex:1">${label}</span>
                        <button onclick="PathingController._deletePath('${pid}')" style="font-size:10px;padding:1px 5px;cursor:pointer;color:#c44" title="Delete this path">\u2716</button>
                        <button onclick="PathingController.beginExtendPath('${pid}')" style="font-size:10px;padding:1px 5px;cursor:pointer;color:#2fbf4f" title="Add unclaimed sections to this path">\u2295</button>
                    </div>
                    <div style="display:flex;align-items:center;gap:5px;margin-top:4px;">
                        <span style="color:#aaa">Ahead</span>
                        <button onclick="PathingController._changeLookAhead('${pid}', -1)" style="font-size:11px;padding:0 5px;cursor:pointer" title="Claim one less block ahead">\u2212</button>
                        <span style="min-width:1.3em;text-align:center;font-weight:600;color:#000">${p.lookAhead ?? 5}</span>
                        <button onclick="PathingController._changeLookAhead('${pid}', 1)" style="font-size:11px;padding:0 5px;cursor:pointer" title="Claim one more block ahead (immediate)">+</button>
                        <span style="color:#aaa;margin-left:4px">Hue</span>
                        <input type="range" min="0" max="360" step="1" value="${pathHue}"
                            oninput="PathingController._changePathHue('${pid}', this.value)"
                            title="Path colour hue" style="flex:1;min-width:70px;"/>
                    </div>
                    <input id="note-${pid}" type="text" placeholder="Locomotive / destination / note" value="${note}"
                        style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:3px 6px;font-size:13px;background:#ddd;color:#000;border:1px solid #aaa;border-radius:3px;"
                        title="Note for this path"
                        onchange="PathingController._saveNote('${pid}')"/>
                    <div style="margin-top:4px;line-height:1.8">${blockChips}</div>
                </div>`;
            }).join('');
            el.innerHTML = `<div style="font-size:13px;color:#aaa;margin-bottom:4px;border-bottom:1px solid #444;padding-bottom:3px;font-weight:600">Active Paths (${this.lockedPaths.length})</div>${items}`;
        } catch (e) {
            console.warn('[Pathing] renderPathList error:', e);
        }
    },

    rerender(segments, switches) {
        if (typeof switchboardRenderer === 'undefined' || !switchboardRenderer) return;
        if (segments) {
            for (const segId of segments) {
                const seg = TrackData.getSegment(segId);
                if (seg && seg.type !== 'switch') switchboardRenderer.renderSegment(seg);
            }
        }
        if (switches) {
            for (const swId of switches) {
                const seg = TrackData.getSegment(swId);
                if (seg && seg.type === 'switch') switchboardRenderer.renderSegment(seg);
            }
        }
        if (!segments && !switches) {
            switchboardRenderer.rerenderAllSegments();
            switchboardRenderer.rerenderSwitches();
        }
    },

    updateStatus(msg) {
        try {
            const el = document.getElementById('pathingStatus');
            if (!el) return;
            if (this.enabled) {
                el.textContent = msg ? `Pathing: enabled \u2014 ${msg}` : 'Pathing: enabled';
            } else {
                el.textContent = 'Pathing: disabled';
            }
            // The signature guard would hide extend-mode row highlighting, so
            // force a rebuild whenever extend mode is active or just changed.
            const interacting = this.state !== 'idle';
            this.renderPathList(interacting || this._wasInteracting);
            this._wasInteracting = interacting;
        } catch (e) {
            console.warn('[Pathing] updateStatus error:', e);
        }
    }
};
