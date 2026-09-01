const TrackData = {
    nodes: new Map(),
    segments: new Map(),
    blocks: new Map(),
    _segmentBlockMap: new Map(),
    nextNodeId: 1,
    nextSegmentId: 1,
    nextBlockId: 1,

    createNode(x, y) {
        const id = `n${this.nextNodeId++}`;
        const node = { id, x, y };
        this.nodes.set(id, node);
        return node;
    },

    getNode(id) {
        return this.nodes.get(id);
    },

    getNodeAt(x, y) {
        for (const node of this.nodes.values()) {
            if (node.x === x && node.y === y) return node;
        }
        return null;
    },

    deleteNode(id) {
        const segmentsToDelete = [];
        for (const [segId, seg] of this.segments) {
            if (seg.n1 === id || seg.n2 === id || 
                seg.merging === id || seg.nl === id || seg.nr === id) {
                segmentsToDelete.push(segId);
            }
        }
        segmentsToDelete.forEach(sid => {
            this.deleteSegment(sid);
            if (typeof TrackRenderer !== 'undefined' && TrackRenderer.clearSegment) {
                TrackRenderer.clearSegment(sid);
            }
        });
        this.nodes.delete(id);
    },

    createSegment(type, fromId, toId, rotation = 0) {
        const id = `s${this.nextSegmentId++}`;
        const segment = { id, type, rotation, blockId: null };
        
        if (type === 'switch') {
            segment.merging = fromId;
            segment.nl = toId;
            segment.nr = arguments[3];
            segment.state = 0;
        } else {
            segment.n1 = fromId;
            segment.n2 = toId;
        }
        
        this.segments.set(id, segment);
        return segment;
    },

    getSegment(id) {
        return this.segments.get(id);
    },

    getSegmentsForNode(nodeId) {
        const result = [];
        for (const seg of this.segments.values()) {
            if (seg.n1 === nodeId || seg.n2 === nodeId ||
                seg.merging === nodeId || seg.nl === nodeId || seg.nr === nodeId) {
                result.push(seg);
            }
        }
        return result;
    },

    deleteSegment(id) {
        this.segments.delete(id);
    },

    createBlock(name) {
        const id = `b${this.nextBlockId++}`;
        const block = { id, name, segmentIds: [] };
        this.blocks.set(id, block);
        return block;
    },

    getBlock(id) {
        return this.blocks.get(id);
    },

    assignSegmentToBlock(segmentId, blockId) {
        for (const block of this.blocks.values()) {
            block.segmentIds = block.segmentIds.filter(sid => sid !== segmentId);
        }
        if (blockId) {
            const block = this.blocks.get(blockId);
            if (block) {
                if (!block.segmentIds.includes(segmentId)) {
                    block.segmentIds.push(segmentId);
                }
                this._segmentBlockMap.set(segmentId, blockId);
                return;
            }
        }
        this._segmentBlockMap.delete(segmentId);
    },

    _rebuildSegmentBlockMap() {
        this._segmentBlockMap.clear();
        for (const [blockId, block] of this.blocks) {
            if (!block.segmentIds) continue;
            for (const segId of block.segmentIds) {
                this._segmentBlockMap.set(segId, blockId);
            }
        }
    },

    getBlockForSegment(segmentId) {
        const blockId = this._segmentBlockMap.get(segmentId);
        if (blockId !== undefined) return this.blocks.get(blockId) || null;
        return null;
    },

    deleteBlock(id) {
        this.blocks.delete(id);
    },

    clear() {
        this.nodes.clear();
        this.segments.clear();
        this.blocks.clear();
        this._segmentBlockMap.clear();
        this.nextNodeId = 1;
        this.nextSegmentId = 1;
        this.nextBlockId = 1;
    },

    toJSON() {
        return {
            nodes: Array.from(this.nodes.values()),
            segments: Array.from(this.segments.values()),
            blocks: Array.from(this.blocks.values()),
            nextNodeId: this.nextNodeId,
            nextSegmentId: this.nextSegmentId,
            nextBlockId: this.nextBlockId
        };
    },

    fromJSON(data) {
        this.clear();
        this.nodes = new Map(data.nodes.map(n => [n.id, n]));
        this.segments = new Map(data.segments.map(s => [s.id, s]));
        this.blocks = new Map(data.blocks.map(b => [b.id, b]));
        this.nextNodeId = data.nextNodeId ?? this.nextNodeId;
        this.nextSegmentId = data.nextSegmentId ?? this.nextSegmentId;
        this.nextBlockId = data.nextBlockId ?? this.nextBlockId;
        this._rebuildSegmentBlockMap();
    },

    save(name) {
        const layouts = JSON.parse(localStorage.getItem('trackLayouts') || '{}');
        layouts[name] = this.toJSON();
        localStorage.setItem('trackLayouts', JSON.stringify(layouts));
    },

    load(name) {
        const layouts = JSON.parse(localStorage.getItem('trackLayouts') || '{}');
        if (layouts[name]) {
            this.fromJSON(layouts[name]);
            return true;
        }
        return false;
    },

    getLayoutNames() {
        const layouts = JSON.parse(localStorage.getItem('trackLayouts') || '{}');
        return Object.keys(layouts);
    },

    groupIntoBlocks_getConnectedTracks(nodeId) {
        const result = [];
        for (const seg of this.segments.values()) {
            if (seg.type === 'switch') continue;
            if (seg.n1 === nodeId || seg.n2 === nodeId) {
                result.push(seg);
            }
        }
        return result;
    },

    groupIntoBlocks_floodFill(segmentId, entryNodeId, block, visited) {
        const seg = this.getSegment(segmentId);
        if (!seg || seg.type === 'switch' || visited.has(segmentId)) return;

        visited.add(segmentId);
        seg.blockId = block.id;
        block.segmentIds.push(segmentId);
        this._segmentBlockMap.set(segmentId, block.id);

        const nodesToExplore = [];
        if (entryNodeId === null) {
            nodesToExplore.push(seg.n1, seg.n2);
        } else {
            const otherNode = seg.n1 === entryNodeId ? seg.n2 : seg.n1;
            nodesToExplore.push(otherNode);
        }

        for (const nodeId of nodesToExplore) {
            const connected = this.groupIntoBlocks_getConnectedTracks(nodeId);
            for (const connectedSeg of connected) {
                if (!visited.has(connectedSeg.id)) {
                    this.groupIntoBlocks_floodFill(connectedSeg.id, nodeId, block, visited);
                }
            }
        }
    },

    groupIntoBlocks() {
        this.blocks.clear();
        this._segmentBlockMap.clear();
        for (const seg of this.segments.values()) {
            seg.blockId = null;
        }

        if (typeof invalidateBlockSwitchCache === 'function') {
            invalidateBlockSwitchCache();
        }

        const visited = new Set();
        const autoNames = ["Block A", "Block B", "Block C", "Block D", "Block E",
                           "Block F", "Block G", "Block H", "Block I", "Block J"];
        let nameIndex = 0;

        for (const [segId, seg] of this.segments) {
            if (seg.type === 'switch' || visited.has(segId)) continue;

            const block = this.createBlock(autoNames[nameIndex++] || `Block ${nameIndex}`);
            block.color = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
            this.groupIntoBlocks_floodFill(segId, null, block, visited);
        }

        for (const seg of this.segments.values()) {
            if (seg.type !== 'switch') continue;

            const targetBlock = this.createBlock(autoNames[nameIndex++] || `Block ${nameIndex}`);
            targetBlock.color = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');

            seg.blockId = targetBlock.id;
            targetBlock.segmentIds.push(seg.id);
            this._segmentBlockMap.set(seg.id, targetBlock.id);
        }

        if (typeof switchboardRenderer !== 'undefined' && switchboardRenderer && switchboardRenderer.rerenderAllSegments) {
            switchboardRenderer.rerenderAllSegments();
        }

        return Array.from(this.blocks.values());
    },

    getJunctionNodes() {
        const attachmentCount = new Map();
        
        for (const node of this.nodes.values()) {
            attachmentCount.set(node.id, 0);
        }
        
        for (const seg of this.segments.values()) {
            if (seg.type === 'switch') {
                attachmentCount.set(seg.merging, (attachmentCount.get(seg.merging) || 0) + 1);
                attachmentCount.set(seg.nl, (attachmentCount.get(seg.nl) || 0) + 1);
                attachmentCount.set(seg.nr, (attachmentCount.get(seg.nr) || 0) + 1);
            } else {
                attachmentCount.set(seg.n1, (attachmentCount.get(seg.n1) || 0) + 1);
                attachmentCount.set(seg.n2, (attachmentCount.get(seg.n2) || 0) + 1);
            }
        }
        
        const junctions = [];
        for (const node of this.nodes.values()) {
            if (attachmentCount.get(node.id) > 2) {
                junctions.push(node);
            }
        }
        return junctions;
    },

    isNetworkConnected() {
        const regularSegments = [];
        for (const seg of this.segments.values()) {
            if (seg.type !== 'switch') {
                regularSegments.push(seg.id);
            }
        }

        if (regularSegments.length === 0) return true;

        const visited = new Set();
        this.groupIntoBlocks_floodFill(regularSegments[0], null, { segmentIds: [] }, visited);

        return visited.size === regularSegments.length;
    },

    getSwitchSegments() {
        const switches = [];
        for (const seg of this.segments.values()) {
            if (seg.type === 'switch') switches.push(seg);
        }
        return switches;
    },

    getSwitchNodes(switchSeg) {
        return [switchSeg.merging, switchSeg.nl, switchSeg.nr];
    },

    findAdjacentSwitch(startNodeId, visitedNodeIds, callerSwitchId) {
        const found = this.findAdjacentSwitchInternal(startNodeId, visitedNodeIds, callerSwitchId);
        if (!found) return null;
        // Determine which node of the target switch was entered so ports stay
        // distinct at crossovers where two switches share the same node.
        const targetSwitch = this.getSegment(found.switchId);
        if (!targetSwitch) return { switchId: found.switchId, viaNodeId: found.viaNodeId, entryNodeId: null };
        const enteredNode = found.viaNodeId;
        let entryPort = null;
        if (enteredNode === targetSwitch.merging) entryPort = 'merging';
        else if (enteredNode === targetSwitch.nl) entryPort = 'nl';
        else if (enteredNode === targetSwitch.nr) entryPort = 'nr';
        return { switchId: found.switchId, viaNodeId: found.viaNodeId, entryNodeId: enteredNode, entryPort };
    },

    findAdjacentSwitchInternal(startNodeId, visitedNodeIds, callerSwitchId) {
        const segsAtStart = this.getSegmentsForNode(startNodeId);
        for (const seg of segsAtStart) {
            if (seg.type === 'switch' && seg.id !== callerSwitchId && this.getSwitchNodes(seg).includes(startNodeId)) {
                return { switchId: seg.id, viaNodeId: startNodeId };
            }
        }

        const connectedTracks = this.groupIntoBlocks_getConnectedTracks(startNodeId);
        for (const track of connectedTracks) {
            if (visitedNodeIds.has(track.id)) continue;
            visitedNodeIds.add(track.id);

            const otherNode = track.n1 === startNodeId ? track.n2 : track.n1;
            if (visitedNodeIds.has(otherNode)) continue;
            visitedNodeIds.add(otherNode);

            const segsAtNode = this.getSegmentsForNode(otherNode);
            for (const seg of segsAtNode) {
                if (seg.type === 'switch' && seg.id !== callerSwitchId && this.getSwitchNodes(seg).includes(otherNode)) {
                    return { switchId: seg.id, viaNodeId: otherNode };
                }
            }

            const found = this.findAdjacentSwitchInternal(otherNode, visitedNodeIds, callerSwitchId);
            if (found) return found;
        }
        return null;
    },

    buildSwitchGraph() {
        const switches = this.getSwitchSegments();
        const graph = new Map();

        for (const sw of switches) {
            const switchNodeIds = this.getSwitchNodes(sw);
            const neighbors = [];

            for (const nodeId of switchNodeIds) {
                const visited = new Set();
                visited.add(nodeId);
                const result = this.findAdjacentSwitch(nodeId, visited, sw.id);
                if (result) {
                    let port = 'unknown';
                    if (nodeId === sw.merging) port = 'common';
                    else if (nodeId === sw.nl) port = 'left';
                    else if (nodeId === sw.nr) port = 'right';
                    neighbors.push({
                        switchId: result.switchId,
                        viaNodeId: result.viaNodeId,
                        entryNodeId: result.entryNodeId ?? null,
                        entryPort: result.entryPort ?? null,
                        fromNodeId: nodeId,
                        port: port
                    });
                }
            }

            graph.set(sw.id, {
                switchId: sw.id,
                neighbors: neighbors,
                degree: neighbors.length,
                merging: sw.merging,
                nl: sw.nl,
                nr: sw.nr
            });
        }

        return graph;
    }
};