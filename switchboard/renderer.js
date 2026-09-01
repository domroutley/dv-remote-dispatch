const TrackRenderer = {
    map: null,
    nodeMarkers: new Map(),
    segmentLayers: new Map(),
    switchBounds: new Map(),
    blockColors: ['#4CAF50', '#2196F3', '#FF9800', '#E91E63', '#9C27B0', '#00BCD4'],
    colorIndex: 0,

    init(map) {
        this.map = map;
    },

    coordsToLatLng(x, y) {
        return this.map.unproject([x * 100, -y * 100], 0);
    },

    latLngToCoords(latlng) {
        const point = this.map.project(latlng, 0);
        return {
            x: Math.round(point.x / 100),
            y: Math.round(-point.y / 100)
        };
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
        for (const seg of TrackData.segments.values()) {
            this.renderSegment(seg);
        }
    },

    renderNode(node, isSelected = false, forceVisible = false) {
        if (this.nodeMarkers.has(node.id)) {
            this.clearNode(node.id);
        }

        const pos = this.coordsToLatLng(node.x, node.y);
        const color = isSelected ? '#FF5722' : '#888';
        
        const marker = L.circle(pos, {
            radius: 20,
            fillColor: color,
            fillOpacity: 1,
            color: '#fff',
            weight: 3
        });

        marker.nodeId = node.id;
        this.nodeMarkers.set(node.id, marker);
        
        if (isSelected || TrackEditor.showNodes || forceVisible) {
            marker.addTo(this.map);
        }
        
        return marker;
    },

    renderJunctionNodes() {
        const junctions = TrackData.getJunctionNodes();
        for (const node of junctions) {
            const pos = this.coordsToLatLng(node.x, node.y);
            const marker = L.circle(pos, {
                radius: 25,
                fillColor: '#00BFFF',
                fillOpacity: 1,
                color: '#fff',
                weight: 3
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

    renderSegment(segment) {
        if (this.segmentLayers.has(segment.id)) {
            this.clearSegment(segment.id);
        }

        const block = TrackData.getBlockForSegment(segment.id);
        const color = block && block.color ? block.color : '#666';

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
        
        const from = this.coordsToLatLng(fromNode.x, fromNode.y);
        const to = this.coordsToLatLng(toNode.x, toNode.y);

        const polyline = L.polyline([from, to], {
            color: color,
            weight: 4,
            opacity: 0.9
        });

        polyline.addTo(this.map);
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

        const group = L.layerGroup();

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

        L.rectangle(rectBounds, {
            color: '#555',
            weight: 2,
            fillColor: '#666',
            fillOpacity: 0.7
        }).addTo(group);

        this.switchBounds.set(segment.id, { minX, maxX, minY, maxY });

        L.polyline([inboundPos, out1Pos], {
            color: '#E74C3C',
            weight: 5,
            opacity: 1
        }).addTo(group);

        L.polyline([inboundPos, out2Pos], {
            color: '#E74C3C',
            weight: 5,
            opacity: 1
        }).addTo(group);

        L.circle(inboundPos, {
            radius: 10,
            fillColor: '#E74C3C',
            fillOpacity: 1,
            color: '#fff',
            weight: 2
        }).addTo(group);

        group.addTo(this.map);
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
