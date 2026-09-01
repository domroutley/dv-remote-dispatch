const SwitchboardMapper = {
    ingameGraph: null,
    switchboardGraph: null,
    mapping: null,

    GRAPH_OVERRIDES: {
        // Format: junctionIndex: { neighbors, addNeighbors, commonNeighbor, leftNeighbor, rightNeighbor, degree }
        // 'neighbors' replaces the full array. 'addNeighbors' merges into existing (no duplicates).
        // Only include fields you want to override.
        // Empty: the /graph endpoint now produces correct topology for all junctions.
    },

    async fetchIngameGraph() {
        const resp = await fetch(new URL('/graph', location));
        if (!resp.ok) throw new Error(`Failed to fetch /graph: ${resp.status} ${resp.statusText}`);
        const data = await resp.json();

		this.ingameGraph = new Map();
        for (const [junctionId, graphData] of Object.entries(data)) {
            this.ingameGraph.set(graphData.junctionIndex, {
                junctionId: junctionId,
                junctionIndex: graphData.junctionIndex,
                neighbors: graphData.neighbors || [],
                degree: graphData.degree || (graphData.neighbors || []).length,
                currentBranch: graphData.currentBranch,
                incomingTracks: graphData.incomingTracks || [],
                outgoingTracks: graphData.outgoingTracks || [],
                commonNeighbor: graphData.commonNeighbor ?? null,
                leftNeighbor: graphData.leftNeighbor ?? null,
                rightNeighbor: graphData.rightNeighbor ?? null
            });
        }
        this.applyGraphOverrides();
        return this.ingameGraph;
    },

    applyGraphOverrides() {
        let count = 0;
        for (const [idx, overrides] of Object.entries(this.GRAPH_OVERRIDES)) {
            const jIdx = parseInt(idx);
            const existing = this.ingameGraph.get(jIdx);
            if (existing) {
                if (overrides.addNeighbors) {
                    for (const n of overrides.addNeighbors) {
                        if (!existing.neighbors.includes(n)) existing.neighbors.push(n);
                    }
                    delete overrides.addNeighbors;
                    if (!overrides.degree) overrides.degree = existing.neighbors.length;
                }
                Object.assign(existing, overrides);
            } else {
                const neighbors = overrides.neighbors || overrides.addNeighbors || [];
                this.ingameGraph.set(jIdx, {
                    junctionId: `override_${jIdx}`,
                    junctionIndex: jIdx,
                    neighbors: neighbors,
                    degree: overrides.degree ?? neighbors.length,
                    currentBranch: overrides.currentBranch ?? 0,
                    incomingTracks: overrides.incomingTracks || [],
                    outgoingTracks: overrides.outgoingTracks || [],
                    commonNeighbor: overrides.commonNeighbor ?? null,
                    leftNeighbor: overrides.leftNeighbor ?? null,
                    rightNeighbor: overrides.rightNeighbor ?? null
                });
            }
            count++;
        }
        if (count > 0) console.log(`Applied ${count} graph overrides`);
    },

    buildSwitchboardGraph() {
        this.switchboardGraph = TrackData.buildSwitchGraph();
        return this.switchboardGraph;
    },

    findMatches(sbNeighbors, ingameNeighbors, usedIngameIndices, ingameIdx) {
        const matches = [];
        const unmatchedIngame = ingameNeighbors.filter(idx => !usedIngameIndices.has(idx));
        const ingameData = this.ingameGraph.get(ingameIdx);

        const portToIngameNeighbor = (port) => {
            if (!ingameData) return null;
            if (port === 'common') return ingameData.commonNeighbor;
            if (port === 'left') return ingameData.leftNeighbor;
            if (port === 'right') return ingameData.rightNeighbor;
            return null;
        };

        const usedThisRound = new Set();

        const sorted = [...sbNeighbors].sort((a, b) => {
            const order = { right: 0, left: 1, common: 2 };
            const pa = order[a.port] ?? 3;
            const pb = order[b.port] ?? 3;
            return pa - pb;
        });

        // Pass 1: strict port matches. Resolve every neighbor that has an
        // available port target. When a strict port target is already claimed
        // by a non-reciprocal switch, prefer the reciprocal crossover edge and
        // evict the imposter. No degree-based fallback is used: it would
        // reclaim evicted junctions and swap the crossover's two legs back.
        const strictMatches = [];
        const evictTargets = [];
        for (const sbNeighbor of sorted) {
            if (sbNeighbor.switchId === undefined) continue;
            if (usedThisRound.has(sbNeighbor.switchId)) continue;

            const port = sbNeighbor.port || 'unknown';
            const portTarget = portToIngameNeighbor(port);
            if (portTarget === null) continue;

            if (unmatchedIngame.includes(portTarget)) {
                strictMatches.push({ sbNeighbor, portTarget });
            } else {
                // The port target is claimed by a switch already in the walk.
                // Find the imposter (owner of portTarget) and check whether the
                // reciprocal edge through it is genuine; if so, prefer it.
                let imposter = null;
                for (const [ownerId, j] of this.mapping) {
                    if (j === portTarget) { imposter = ownerId; break; }
                }
                if (imposter && imposter !== sbNeighbor.switchId &&
                    this.isReciprocalEdge(sbNeighbor.switchId, portTarget, this.mapping)) {
                    evictTargets.push({ sbNeighbor, portTarget, imposter });
                }
            }
        }

        for (const { sbNeighbor, portTarget } of strictMatches) {
            matches.push({
                sbSwitchId: sbNeighbor.switchId,
                ingameJunctionIndex: portTarget,
                port: sbNeighbor.port || 'unknown'
            });
            unmatchedIngame.splice(unmatchedIngame.indexOf(portTarget), 1);
            usedThisRound.add(sbNeighbor.switchId);
        }

        // Handle reciprocal evictions: the imposter loses its junction, which
        // becomes free for the reciprocal crossover edge.
        for (const { sbNeighbor, portTarget, imposter } of evictTargets) {
            if (usedThisRound.has(sbNeighbor.switchId)) continue;
            matches.push({
                sbSwitchId: sbNeighbor.switchId,
                ingameJunctionIndex: portTarget,
                port: sbNeighbor.port || 'unknown',
                evict: { sbSwitchId: imposter, ingameJunctionIndex: portTarget }
            });
            if (unmatchedIngame.includes(portTarget)) unmatchedIngame.splice(unmatchedIngame.indexOf(portTarget), 1);
            usedThisRound.add(sbNeighbor.switchId);
        }

        // No degree/score fallback: when a strict port target was unavailable,
        // reciprocal crossover evictions resolve the right assignment. A blind
        // degree match would otherwise reclaim evicted junctions and swap the
        // crossover's two legs back.
        return matches;
    },

    // True if `sbId` is genuinely adjacent to the switch that currently owns
        // `portTarget` in `mapping` (the walk's in-progress assignment). Used to
        // prefer reciprocal crossover edges over non-reciprocal "closer" claims.
    isReciprocalEdge(sbId, portTarget, mapping) {
        let targetOwner = null;
        for (const [ownerId, j] of mapping) {
            if (j === portTarget) { targetOwner = ownerId; break; }
        }
        if (!targetOwner || targetOwner === sbId) return false;
        const sbData = this.switchboardGraph.get(sbId);
        if (!sbData) return false;
        return sbData.neighbors.some(n => n.switchId === targetOwner);
    },

    // every mapped(n) must be a mutual neighbor of mapped(m). A violation here
        // means at least one of the two mapped switches is assigned to the wrong
        // junction (or the ingame graph is missing/linking that edge).
    validateMapping() {
        if (!this.mapping || !this.switchboardGraph || !this.ingameGraph) return [];
        const violations = [];
        for (const [sbId, jIdx] of this.mapping) {
            const sbData = this.switchboardGraph.get(sbId);
            if (!sbData) continue;
            for (const nbr of sbData.neighbors) {
                const nbrJ = this.mapping.get(nbr.switchId);
                if (nbrJ === undefined || nbrJ === jIdx) continue;
                const jData = this.ingameGraph.get(jIdx);
                const nbrData = this.ingameGraph.get(nbrJ);
                if (!jData || !nbrData) continue;
                const forward = jData.neighbors.includes(nbrJ);
                const backward = nbrData.neighbors.includes(jIdx);
                if (!forward || !backward) {
                    violations.push({ sbId, jIdx, nbrSwitchId: nbr.switchId, nbrJ, port: nbr.port || 'unknown', forward, backward });
                }
            }
        }
        return violations;
    },

    // Whether two switchboard switches are graph-adjacent (share a neighbor edge).
    _areSwitchAdjacent(aId, bId) {
        const a = this.switchboardGraph.get(aId);
        if (!a) return false;
        return a.neighbors.some(n => n.switchId === bId);
    },

    // Score a candidate junction assignment for a switch: the number of the
    // switch's switchboard neighbours that map to junctions adjacent to jIdx in
    // the ingame graph. Higher = more consistent placement.
    _scoreAssignment(sbId, jIdx) {
        const sbData = this.switchboardGraph.get(sbId);
        const jData = this.ingameGraph.get(jIdx);
        if (!sbData || !jData) return 0;
        let score = 0;
        for (const nbr of sbData.neighbors) {
            const nbrJ = this.mapping.get(nbr.switchId);
            if (nbrJ === undefined || nbrJ === jIdx) continue;
            if (jData.neighbors.includes(nbrJ)) score++;
        }
        return score;
    },

    // Post-walk consistency repair. Greedy BFS with local eviction cannot fix
    // an earlier wrong strict assignment whose port collision never surfaces -
    // both legs of a crossover get taken by non-colliding points and no eviction
    // ever fires. Repair rescans the edges flagged by validateMapping() and, for
    // each cluster of violations, tries swapping the two switches that share a
    // junction (the classic crossover leg-swap: J-632/J-546, J-636/J-638) when
    // the swap strictly improves both switches' adjacency scores. Iterates until
    // a stable minimum is reached (bounded).
    repairMapping() {
        if (!this.mapping) return;
        const MAX_PASSES = 20;
        for (let pass = 0; pass < MAX_PASSES; pass++) {
            const violations = this.validateMapping();
            if (violations.length === 0) break;

            let repaired = false;

            // Group violations by the switch that would benefit from re-mapping.
            // The ingame junction index is what's mis-assigned; collect candidate
            // swaps for each switch currently implicated in >=1 violation.
            const candidates = new Map();
            for (const v of violations) {
                if (!candidates.has(v.sbId)) candidates.set(v.sbId, []);
                candidates.get(v.sbId).push(v);
                if (!candidates.has(v.nbrSwitchId)) candidates.set(v.nbrSwitchId, []);
                candidates.get(v.nbrSwitchId).push(v);
            }

            for (const [sbId, vList] of candidates) {
                if (vList.length === 0) continue;
                const curJ = this.mapping.get(sbId);
                if (curJ === undefined) continue;

                // Try swapping sbId's junction with every OTHER switch that maps
                // to a junction adjacent to at least one of sbId's neighbors.
                for (const [otherSbId, otherCurJ] of this.mapping) {
                    if (otherSbId === sbId) continue;
                    if (otherCurJ === undefined || otherCurJ === curJ) continue;
                    if (!this._areSwitchAdjacent(sbId, otherSbId)) continue;

                    const before = this._scoreAssignment(sbId, curJ) + this._scoreAssignment(otherSbId, otherCurJ);
                    const afterSwap = this._scoreAssignment(sbId, otherCurJ) + this._scoreAssignment(otherSbId, curJ);
                    if (afterSwap > before) {
                        this.mapping.set(sbId, otherCurJ);
                        this.mapping.set(otherSbId, curJ);
                        repaired = true;
                        break;
                    }
                }
                if (repaired) break;
            }

            if (!repaired) break;
        }
    },

    runParallelWalk(anchorSbId, anchorIngameIdx) {
        if (!this.ingameGraph || !this.switchboardGraph) {
            console.error('Graphs not loaded. Call fetchIngameGraph() and buildSwitchGraph() first.');
            return null;
        }

        const mapping = new Map();
        mapping.set(anchorSbId, anchorIngameIdx);
        this.mapping = mapping;

        const usedIngame = new Set([anchorIngameIdx]);
        const queue = [{sbId: anchorSbId, ingameIdx: anchorIngameIdx}];
        const visitedSb = new Set([anchorSbId]);

        while (queue.length > 0) {
            const {sbId, ingameIdx} = queue.shift();

            const sbData = this.switchboardGraph.get(sbId);
            const ingameData = this.ingameGraph.get(ingameIdx);

            if (!sbData || !ingameData) continue;

            const sbNeighbors = sbData.neighbors.filter(n => !visitedSb.has(n.switchId));
            const ingameNeighbors = ingameData.neighbors.filter(idx => !usedIngame.has(idx));

            const matches = this.findMatches(sbNeighbors, ingameNeighbors, usedIngame, ingameIdx);

            for (const match of matches) {
                if (match.evict) {
                    // A reciprocal crossover edge wrested this junction from a
                    // non-reciprocal occupier: unmap the imposter and let the
                    // walk re-claim it later via its own reciprocal edge.
                    const imposter = match.evict.sbSwitchId;
                    mapping.delete(imposter);
                    visitedSb.delete(imposter);
                    usedIngame.delete(match.evict.ingameJunctionIndex);
                }
                mapping.set(match.sbSwitchId, match.ingameJunctionIndex);
                visitedSb.add(match.sbSwitchId);
                usedIngame.add(match.ingameJunctionIndex);
                queue.push({sbId: match.sbSwitchId, ingameIdx: match.ingameJunctionIndex});
            }
        }

        this.repairMapping();

        return mapping;
    },

    getIngameJunctionIndex(sbSwitchId) {
        if (!this.mapping) return null;
        return this.mapping.has(sbSwitchId) ? this.mapping.get(sbSwitchId) : null;
    },

    getSwitchboardId(ingameJunctionIndex) {
        if (!this.mapping) return null;
        for (const [sbId, idx] of this.mapping) {
            if (idx === ingameJunctionIndex) return sbId;
        }
        return null;
    },

    getUnmappedSwitches() {
        if (!this.mapping || !this.switchboardGraph) return [];
        const unmapped = [];
        for (const [sbId] of this.switchboardGraph) {
            if (!this.mapping.has(sbId)) unmapped.push(sbId);
        }
        return unmapped;
    },

    getUnmappedJunctions() {
        if (!this.mapping || !this.ingameGraph) return [];
        const unmapped = [];
        for (const [idx] of this.ingameGraph) {
            let found = false;
            for (const [, mappedIdx] of this.mapping) {
                if (mappedIdx === idx) { found = true; break; }
            }
            if (!found) unmapped.push(idx);
        }
        return unmapped;
    },

    printMapping() {
        if (!this.mapping) {
            console.log('No mapping built yet.');
            return;
        }
        console.log(`Switch mapping (${this.mapping.size} pairs)`);
        const unmappedSb = this.getUnmappedSwitches();
        const unmappedIn = this.getUnmappedJunctions();
        if (unmappedSb.length > 0) {
            console.warn(`Unmapped switchboard switches: ${unmappedSb.join(', ')}`);
        }
        if (unmappedIn.length > 0) {
            console.warn(`Unmapped ingame junctions: ${unmappedIn.join(', ')}`);
        }
        const violations = this.validateMapping();
        if (violations.length > 0) {
            console.warn(`Mapping consistency violations: ${violations.length}`);
            console.warn(violations.slice(0, 20));
        } else {
            console.log('Mapping consistency: all edges validated.');
        }
    }
};
