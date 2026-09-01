const TrackRenderer = {
    map: null,
    nodeMarkers: new Map(),
    segmentLayers: new Map(),
    switchBounds: new Map(),
    showSignalAspects: true,
    CLEAR_GRAY: '#888888',
    OCCUPIED_RED: '#a02020',
    PATH_COLOR_MIN: 0x20,
    PATH_COLOR_MAX: 0x90,
    CLAIM_CAP_GREEN: 0xf0,
    CLAIM_ADD_GREEN: 0x50,
    CLAIM_SUB_BLUE: 0x50,
    CLAIM_SUB_RED: 0x20,
    blockColors: ['#4CAF50', '#2196F3', '#FF9800', '#E91E63', '#9C27B0', '#00BCD4'],
    colorIndex: 0,

    init(map) {
        this.map = map;
    },

    coordsToLatLng(x, y) {
        return L.latLng(y, x);
    },

    latLngToCoords(latlng) {
        return {
            x: Math.round(latlng.lng),
            y: Math.round(latlng.lat)
        };
    },

    hex2(v) { return Math.round(v).toString(16).padStart(2, '0'); },

    randRange(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    },

    // Random per-path colour "between #203080 and #90b0d0" with B >= G >= R so
    // paths are always blue-dominant (never read red or green). Each channel is
    // kept within the endpoint box: R in [0x20,0x90], G in [0x30,0xb0],
    // B in [0x80,0xd0]. R is drawn first, then B in [max(0x80, R), 0xd0] so
    // B >= R always holds, then G in [max(R, 0x30), min(B, 0xb0)] to keep
    // B >= G >= R while staying inside the box.
    randomPathColor() {
        const r = this.randRange(this.PATH_COLOR_MIN, this.PATH_COLOR_MAX);
        const b = this.randRange(Math.max(0x80, r), 0xd0);
        const g = this.randRange(Math.max(r, 0x30), Math.min(b, 0xb0));
        return `#${this.hex2(r)}${this.hex2(g)}${this.hex2(b)}`;
    },

    // Claimed blocks: add 0x50 to the green channel, then subtract 0x50 from
    // blue and 0x20 from red, then cap each channel so the result stays below
    // #90f090 (R <= 0x90, G <= 0xf0, B <= 0x90).
    claimColor(pathColor) {
        const c = this.parseHex(pathColor);
        if (!c) return '#208020';
        const r = Math.min(Math.max(c.r - this.CLAIM_SUB_RED, 0), this.PATH_COLOR_MAX);
        const g = Math.min(c.g + this.CLAIM_ADD_GREEN, this.CLAIM_CAP_GREEN);
        const b = Math.min(Math.max(c.b - this.CLAIM_SUB_BLUE, 0), this.PATH_COLOR_MAX);
        return `#${this.hex2(r)}${this.hex2(g)}${this.hex2(b)}`;
    },

    // Multi-path overlap: per-channel max of each path's base colour. Result
    // stays within #203080..#90b0d0.
    blendColor(colors) {
        let r = 0x20, g = 0x30, b = 0x80;
        for (const color of colors) {
            const c = this.parseHex(color);
            if (!c) continue;
            r = Math.max(r, c.r);
            g = Math.max(g, c.g);
            b = Math.max(b, c.b);
        }
        return `#${this.hex2(r)}${this.hex2(g)}${this.hex2(b)}`;
    },

    parseHex(hex) {
        if (typeof hex !== 'string') return null;
        const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
        if (!m) return null;
        return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
    },

    // #rrggbb -> HSL. h in [0,360), s/l in [0,1]. Returns null on bad input.
    hexToHsl(hex) {
        const c = this.parseHex(hex);
        if (!c) return null;
        const r = c.r / 255, g = c.g / 255, b = c.b / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = 0;
        const l = (max + min) / 2;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
        }
        return { h, s, l };
    },

    // HSL (h in [0,360), s/l in [0,1]) -> #rrggbb.
    hslToHex(h, s, l) {
        const hue = ((h % 360) + 360) % 360;
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
        const m = l - c / 2;
        let r = 0, g = 0, b = 0;
        if (hue < 60) { r = c; g = x; }
        else if (hue < 120) { r = x; g = c; }
        else if (hue < 180) { g = c; b = x; }
        else if (hue < 240) { g = x; b = c; }
        else if (hue < 300) { r = x; b = c; }
        else { r = c; b = x; }
        return `#${this.hex2((r + m) * 255)}${this.hex2((g + m) * 255)}${this.hex2((b + m) * 255)}`;
    },

    getNextColor() {
        const color = this.blockColors[this.colorIndex % this.blockColors.length];
        this.colorIndex++;
        return color;
    },

    getColorForSegmentCount(count) {
        const colors = [
            '#4CAF50',  // 1 - green
            '#2196F3',  // 2 - blue
            '#FF9800',  // 3 - orange
            '#E91E63',  // 4 - pink
            '#9C27B0',  // 5 - purple
            '#00BCD4'   // 6+ - cyan
        ];
        if (count >= 6) return colors[5];
        return colors[count - 1];
    },

    assignBlockColors() {
        for (const block of TrackData.blocks.values()) {
            const count = block.segmentIds ? block.segmentIds.length : 0;
            block.color = this.getColorForSegmentCount(count);
        }
        this.rerenderAllSegments();
    },

    rerenderAllSegments() {
        const _t0 = performance.now();
        for (const seg of TrackData.segments.values()) {
            this.renderSegment(seg);
        }
        const _elapsed = performance.now() - _t0;
        if (_elapsed > 100) console.warn(`[PERF] rerenderAllSegments took ${_elapsed.toFixed(0)}ms`);
    },

    rerenderBlocks(blockIds) {
        const _t0 = performance.now();
        for (const blockId of blockIds) {
            const block = TrackData.getBlock(blockId);
            if (!block || !block.segmentIds) continue;
            for (const segId of block.segmentIds) {
                this.renderSegment(TrackData.getSegment(segId));
            }
        }
        const _elapsed = performance.now() - _t0;
        if (_elapsed > 100) console.warn(`[PERF] rerenderBlocks(${blockIds.size}) took ${_elapsed.toFixed(0)}ms`);
    },

    rerenderSwitches(switchIds) {
        if (switchIds && switchIds.size > 0) {
            const _t0 = performance.now();
            for (const swId of switchIds) {
                const seg = TrackData.getSegment(swId);
                if (seg && seg.type === 'switch') this.renderSegment(seg);
            }
            const _elapsed = performance.now() - _t0;
            if (_elapsed > 100) console.warn(`[PERF] rerenderSwitches(${switchIds.size}) took ${_elapsed.toFixed(0)}ms`);
            return;
        }
        for (const seg of TrackData.segments.values()) {
            if (seg.type === 'switch') {
                this.renderSegment(seg);
            }
        }
    },

    renderNode(node, isSelected = false, forceVisible = false) {
        if (this.nodeMarkers.has(node.id)) {
            this.clearNode(node.id);
        }

        const pos = this.coordsToLatLng(node.x, node.y);
        const color = isSelected ? '#FF5722' : '#888';
        
        const marker = L.circle(pos, {
            radius: 0.2,
            fillColor: color,
            fillOpacity: 1,
            color: '#fff',
            weight: 10
        });

        marker.nodeId = node.id;
        this.nodeMarkers.set(node.id, marker);
        
        if (isSelected || forceVisible) {
            marker.addTo(this.map);
        }
        
        return marker;
    },

    renderJunctionNodes() {
        const junctions = TrackData.getJunctionNodes();
        for (const node of junctions) {
            const pos = this.coordsToLatLng(node.x, node.y);
            const marker = L.circle(pos, {
                radius: 0.25,
                fillColor: '#00BFFF',
                fillOpacity: 1,
                color: '#fff',
                weight: 10
            });
            marker.nodeId = node.id;
            marker.junctionMarker = true;
            this.nodeMarkers.set(node.id + '_junction', marker);
            marker.addTo(this.map);
        }
    },

    clearJunctionMarkers() {
        for (const [key, marker] of this.nodeMarkers) {
            if (marker.junctionMarker) {
                this.map.removeLayer(marker);
                this.nodeMarkers.delete(key);
            }
        }
    },

    clearNode(nodeId) {
        const marker = this.nodeMarkers.get(nodeId);
        if (marker) {
            this.map.removeLayer(marker);
            this.nodeMarkers.delete(nodeId);
        }
    },

    resolveBlockColor(blockId, segmentId) {
        const block = TrackData.getBlock(blockId);
        if (!block) return '#666';

        if (block.occupancyState === 'occupied') {
            return this.OCCUPIED_RED;
        }

        let claimedPaths = [];
        let upcomingPaths = [];
        if (typeof PathingController !== 'undefined' && PathingController.enabled &&
            typeof PathingController.getBlockPathStatusTable === 'function') {
            const entry = PathingController.getBlockPathStatusTable().get(blockId);
            if (entry) {
                claimedPaths = entry.claimedPaths || [];
                upcomingPaths = entry.upcomingPaths || [];
            }
        }

        if (claimedPaths.length > 0) {
            const c = claimedPaths[0] && claimedPaths[0].color;
            return this.claimColor(c || '#4080c0');
        }
        if (upcomingPaths.length > 1) return this.blendColor(upcomingPaths.map(x => (x && x.color) || '#4080c0'));
        if (upcomingPaths.length === 1) return (upcomingPaths[0] && upcomingPaths[0].color) || '#4080c0';
        return this.CLEAR_GRAY;
    },

    renderSegment(segment) {
        if (!segment) return null;
        if (this.segmentLayers.has(segment.id)) {
            this.clearSegment(segment.id);
        }

        const block = TrackData.getBlockForSegment(segment.id);
        const color = block ? this.resolveBlockColor(block.id, segment.id) : '#666';

        let layer;
        
        if (segment.type === 'switch') {
            layer = this.renderSwitch(segment, color);
        } else {
            layer = this.renderTrackSegment(segment, color);
        }

        if (layer) {
            layer.segmentId = segment.id;
            this.segmentLayers.set(segment.id, layer);
        }

        return layer;
    },

    renderTrackSegment(segment, color) {
        const fromNode = TrackData.getNode(segment.n1);
        const toNode = TrackData.getNode(segment.n2);
        
        if (!fromNode || !toNode) return null;

        const from = this.coordsToLatLng(fromNode.x, fromNode.y);
        const to = this.coordsToLatLng(toNode.x, toNode.y);

        const polyline = L.polyline([from, to], {
            color: color,
            weight: 4,
            opacity: 0.9
        });

        polyline.addTo(this.map);

        polyline.on('click', () => {
            if (typeof PathingController !== 'undefined' && PathingController.enabled) {
                PathingController.onSegmentClick(segment.id);
            }
        });

        polyline.on('contextmenu', (e) => {
            // Stop the Leaflet event so the map-level contextmenu (cancel
            // selection) does not also fire after a waypoint toggle.
            L.DomEvent.stop(e);
            if (typeof PathingController !== 'undefined' && PathingController.enabled) {
                PathingController.onSegmentContextMenu(segment.id);
            }
        });

        polyline.on('mouseover', () => {
            if (typeof PathingController !== 'undefined' && PathingController.enabled) {
                PathingController.onSegmentHover(segment.id);
            }
        });

        polyline.on('mouseout', () => {
            if (typeof PathingController !== 'undefined' && PathingController.enabled) {
                PathingController.onSegmentHoverEnd();
            }
        });

        return polyline;
    },

    renderSwitch(segment, color) {
        const inbound = TrackData.getNode(segment.merging);
        const out1 = TrackData.getNode(segment.nl);
        const out2 = TrackData.getNode(segment.nr);

        if (!inbound || !out1 || !out2) {
            return null;
        }

        const inboundPos = this.coordsToLatLng(inbound.x, inbound.y);
        const out1Pos = this.coordsToLatLng(out1.x, out1.y);
        const out2Pos = this.coordsToLatLng(out2.x, out2.y);

        const group = L.featureGroup();

        const allX = [inbound.x, out1.x, out2.x];
        const allY = [inbound.y, out1.y, out2.y];
        const minX = Math.min(...allX);
        const maxX = Math.max(...allX);
        const minY = Math.min(...allY);
        const maxY = Math.max(...allY);

        const rectBounds = L.latLngBounds([
            this.coordsToLatLng(minX, minY),
            this.coordsToLatLng(maxX, maxY)
        ]);

        const jIdx = SwitchboardMapper.getIngameJunctionIndex(segment.id);
        const ingameData = jIdx !== null ? SwitchboardMapper.ingameGraph?.get(jIdx) : null;
        const currentBranch = ingameData?.currentBranch;

        let rimColor = color;

        const rect = L.rectangle(rectBounds, {
            color: rimColor,
            weight: 2,
            fillColor: '#102020',
            fillOpacity: 0.7
        });
        rect.addTo(group);

        this.switchBounds.set(segment.id, { minX, maxX, minY, maxY });

        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const isHorizontal = (maxX - minX) >= (maxY - minY);

        const graphEntry = SwitchboardMapper.switchboardGraph?.get(segment.id);
        const rawSigs = graphEntry?.rawSignals;
        if (this.showSignalAspects && rawSigs) {
            const portSignalMap = [
                { node: inbound, signal: rawSigs.Out },
                { node: out1, signal: rawSigs.LeftIn },
                { node: out2, signal: rawSigs.RightIn }
            ];
            for (const { node, signal } of portSignalMap) {
                if (!signal) continue;
                const aspect = signal.aspect;
                if (aspect === null || aspect === undefined) continue;

                const dotColor = SwitchboardSignals.signalDotColor(signal);

                let dotX, dotY;
                if (isHorizontal) {
                    const fwdDir = cx >= node.x ? 1 : -1;
                    const sideDir = node.y >= cy ? 1 : -1;
                    dotX = node.x + fwdDir * 0.5;
                    dotY = node.y + sideDir * 0.25;

                    L.polyline([
                        this.coordsToLatLng(node.x, node.y + sideDir * 0.25),
                        this.coordsToLatLng(dotX, dotY)
                    ], { color: '#000', weight: 10 }).addTo(group);
                } else {
                    const fwdDir = cy >= node.y ? 1 : -1;
                    const sideDir = node.x >= cx ? 1 : -1;
                    dotX = node.x + sideDir * 0.25;
                    dotY = node.y + fwdDir * 0.5;

                    L.polyline([
                        this.coordsToLatLng(node.x + sideDir * 0.25, node.y),
                        this.coordsToLatLng(dotX, dotY)
                    ], { color: '#000', weight: 10 }).addTo(group);
                }

                L.circle(this.coordsToLatLng(dotX, dotY), {
                    radius: 0.15,
                    fillColor: dotColor,
                    fillOpacity: 1,
                    color: '#000',
                    weight: 1
                }).addTo(group);
            }
        }

        const activeColor = color;
        const inactiveColor = '#444';

        let out1Color, out2Color;
        if (currentBranch === 0) {
            out1Color = activeColor;
            out2Color = inactiveColor;
        } else if (currentBranch === 1) {
            out1Color = inactiveColor;
            out2Color = activeColor;
        } else {
            out1Color = inactiveColor;
            out2Color = inactiveColor;
        }

        const out1Active = currentBranch === 0;
        const out2Active = currentBranch === 1;

        const out1Polyline = L.polyline([inboundPos, out1Pos], {
            color: out1Color,
            weight: 5,
            opacity: 1
        });

        const out2Polyline = L.polyline([inboundPos, out2Pos], {
            color: out2Color,
            weight: 5,
            opacity: 1
        });

        if (out1Active) {
            out2Polyline.addTo(group);
            out1Polyline.addTo(group);
        } else {
            out1Polyline.addTo(group);
            out2Polyline.addTo(group);
        }

        group.addTo(this.map);

        group.on('click', () => {
            if (jIdx !== null) {
                fetch(new URL(`/junction/${jIdx}/toggle`, location), { method: 'POST' })
                    .then(resp => resp.ok ? resp.text() : Promise.reject(new Error(`${resp.status}`)))
                    .then(newBranch => console.log(`%c[${segment.id}] toggled -> branch ${newBranch} (block: ${segment.blockId})`, 'color: #00ff00'))
                    .catch(err => console.error(`%c[${segment.id}] toggle failed: ${err.message}`, 'color: #ff0000'));
            } else {
                console.log(`%c[${segment.id}] -> NO MAPPING (unmapped switch)`, 'color: #ff0000');
            }
        });

        group.on('contextmenu', (e) => {
            // Stop the Leaflet event so the map-level contextmenu (cancel
            // selection) does not also fire after a waypoint toggle.
            L.DomEvent.stop(e);
            if (typeof PathingController !== 'undefined' && PathingController.enabled) {
                PathingController.onSegmentContextMenu(segment.id);
            }
        });

        group.on('mouseover', () => {
        });

        group.on('mouseout', () => {
        });

        return group;
    },

    clearSegment(segmentId) {
        const layer = this.segmentLayers.get(segmentId);
        if (layer) {
            this.map.removeLayer(layer);
            this.segmentLayers.delete(segmentId);
        }
        this.switchBounds.delete(segmentId);
    },

    highlightSegment(segmentId, highlight = true) {
        const layer = this.segmentLayers.get(segmentId);
        if (layer) {
            const color = highlight ? '#FF5722' : '#666';
            if (layer.setStyle) {
                layer.setStyle({ color: color });
            } else {
                layer.eachLayer(l => {
                    if (l.setStyle) l.setStyle({ color: color });
                });
            }
        }
    },

    renderAll() {
        this.clearAll();

        for (const segment of TrackData.segments.values()) {
            this.renderSegment(segment);
        }

        for (const node of TrackData.nodes.values()) {
            this.renderNode(node);
        }
    },

    updateSwitchStates(states) {
        if (!SwitchboardMapper.ingameGraph || !SwitchboardMapper.mapping) return;
        const changed = [];
        for (const seg of TrackData.segments.values()) {
            if (seg.type !== 'switch') continue;
            const jIdx = SwitchboardMapper.getIngameJunctionIndex(seg.id);
            if (jIdx === null || jIdx >= states.length) continue;
            const ingameData = SwitchboardMapper.ingameGraph.get(jIdx);
            if (!ingameData) continue;
            if (ingameData.currentBranch !== states[jIdx]) {
                ingameData.currentBranch = states[jIdx];
                changed.push(seg);
            }
        }
        for (const seg of changed) {
            this.renderSegment(seg);
        }
        if (changed.length > 0 && typeof SwitchboardSignals !== 'undefined' && SwitchboardSignals.initialized) {
            SwitchboardSignals.updateAllVirtualSignals();
        }
    },

    setSegmentColor(segment, color) {
        if (!segment) return;
        if (segment.type === 'switch') {
            this.renderSegment(segment);
            return;
        }
        const layer = this.segmentLayers.get(segment.id);
        if (!layer) {
            this.renderSegment(segment);
            return;
        }
        layer.setStyle({ color: color });
    },

    clearAll() {
        for (const marker of this.nodeMarkers.values()) {
            this.map.removeLayer(marker);
        }
        this.nodeMarkers.clear();

        for (const layer of this.segmentLayers.values()) {
            this.map.removeLayer(layer);
        }
        this.segmentLayers.clear();
    },

    updateNode(nodeId, isSelected = false) {
        const node = TrackData.getNode(nodeId);
        if (node) {
            this.renderNode(node, isSelected);
        }
    },

    updateSegment(segmentId) {
        const segment = TrackData.getSegment(segmentId);
        if (segment) {
            this.renderSegment(segment);
        }
    },

    getSegmentAtPoint(latlng, tolerance = 0) {
        const coords = this.latLngToCoords(latlng);
        
        const node = TrackData.getNodeAt(coords.x, coords.y);
        if (node) return null;
        
        for (const [segId, layer] of this.segmentLayers) {
            const segment = TrackData.getSegment(segId);
            if (!segment) continue;

            if (segment.type === 'switch') {
                const bounds = this.switchBounds.get(segId);
                if (bounds && coords.x >= bounds.minX && coords.x <= bounds.maxX && 
                    coords.y >= bounds.minY && coords.y <= bounds.maxY) {
                    return segment;
                }
                if (this.pointNearLine(coords, segment.merging, segment.nl, 0) ||
                    this.pointNearLine(coords, segment.merging, segment.nr, 0)) {
                    return segment;
                }
            } else {
                if (this.pointNearLine(coords, segment.n1, segment.n2, 0)) {
                    return segment;
                }
            }
        }
        return null;
    },

    pointNearLine(point, node1Id, node2Id, tolerance) {
        const node1 = TrackData.getNode(node1Id);
        const node2 = TrackData.getNode(node2Id);
        if (!node1 || !node2) return false;

        const dist = this.pointToSegmentDistance(point, node1, node2);
        return dist <= tolerance;
    },

    pointToSegmentDistance(point, node1, node2) {
        const A = point.x - node1.x;
        const B = point.y - node1.y;
        const C = node2.x - node1.x;
        const D = node2.y - node1.y;

        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;
        
        if (lenSq !== 0) param = dot / lenSq;

        let xx, yy;
        if (param < 0) {
            xx = node1.x;
            yy = node1.y;
        } else if (param > 1) {
            xx = node2.x;
            yy = node2.y;
        } else {
            xx = node1.x + param * C;
            yy = node1.y + param * D;
        }

        const dx = point.x - xx;
        const dy = point.y - yy;
        return Math.sqrt(dx * dx + dy * dy);
    }
};