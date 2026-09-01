const initialZoom = 20;
const earthCircumference = 40e6;
const metersToDegrees = 360 / earthCircumference;

var loggingEnabled = false;

// On-screen error reporter: surfaces uncaught JS errors so a broken frontend is
// diagnosable without opening the devtools console. Dismissible; harmless otherwise.
(function () {
	function report(msg) {
		try {
			let overlay = document.getElementById('js-error-overlay');
			if (!overlay) {
				overlay = document.createElement('div');
				overlay.setAttribute('id', 'js-error-overlay');
				overlay.style.cssText =
					'position:fixed;left:8px;bottom:8px;z-index:99999;max-width:70vw;max-height:40vh;overflow:auto;' +
					'background:rgba(30,10,10,0.95);color:#ff8;font:12px/1.4 monospace;padding:8px 10px;' +
					'border:1px solid #f66;border-radius:4px;white-space:pre-wrap;';
				overlay.addEventListener('click', () => overlay.remove());
				document.body.appendChild(overlay);
			}
			overlay.appendChild(document.createTextNode('\n' + msg));
		} catch (_) { /* overlay itself failed; ignore */ }
	}
	window.addEventListener('error', e => report('Error: ' + (e.message || e.error)));
	window.addEventListener('unhandledrejection', e => {
		const r = e.reason;
		report('Unhandled rejection: ' + (r && r.stack ? r.stack.split('\n')[0] : r));
	});
})();

/////////////////////
// map

const canvasRenderer = L.canvas();
const mapBounds = [[0, 0], [0.15, 0.15]];
const maxBounds = [[-0.02, -0.02], [0.17, 0.17]];
const map = L.map('map', {
	minZoom: 13,
	maxBounds: maxBounds,
	tap: false,
	zoomControl: false,
})
	.fitBounds(mapBounds);
L.control.scale().addTo(map);
const zoomHome = new L.Control.ZoomHome({
	position: 'topleft',
	zoomInText: '<i class="fas fa-search-plus"></i>',
	zoomHomeText: '<i class="fas fa-user"></i>',
	zoomHomeTitle: 'Zoom to player(s)',
	zoomOutText: '<i class="fas fa-search-minus"></i>',
}).addTo(map);

let markerToFollow;
map.addEventListener('mousedown', stopFollowing);
map.on('drag', () => {
	map.fitBounds(map.getBounds());
});
map.on('zoomanim', () => {
	map.fitBounds(map.getBounds());
});

function setMarkerToFollow(marker) {
	markerToFollow = marker;
	map.panTo(marker.getBounds().getCenter());
}

function stopFollowing() {
	markerToFollow = undefined;
}

function zoomToAllPlayers() {
	const bounds = [];
	// Cant get bounds of the tooltip, so just get overlay
	playerMarkers.forEach(marker => { bounds.push(marker.overlay.getBounds()) });
	map.fitBounds(L.latLngBounds(bounds), { maxZoom: initialZoom });
}

map.addEventListener('zoomhome', () => {
	stopFollowing();
	zoomToAllPlayers();
});

/////////////////////
// settings

document.getElementById('themeDropdown')
	.addEventListener('input', e => {
		if (e.target.value === 'dark') {
			document.getElementById('map').classList.add('dark');
		} else {
			document.getElementById('map').classList.remove('dark');
		}
	});

function getCarColorMode() {
	return document.getElementById('carColorDropdown').value;
}

document.getElementById('carColorDropdown')
	.addEventListener('input', () => {
		updateAllCarColors();
		updateJobListColors();
	});

document.getElementById('playerScalingCheckbox')
	.addEventListener('change', e => {
		playerScalingEnabled = e.target.checked;
		// immediately reapply bounds to all player markers
		playerMarkers.forEach(({ overlay, position }) => {
			overlay.setBounds(getPlayerOverlayBounds(position));
		});
	});

document.getElementById('playerNameCheckbox')
	.addEventListener('change', e => {
		playerTooltipEnabled = e.target.checked;
		// immediately toggle tooltip visibility for all player markers
		playerMarkers.forEach(({ playerLabel }) => {
			playerLabel.getElement().style.display = playerTooltipEnabled ? '' : 'none';
		});
	});

// Signal display style: "lamps" (SVG faces) or "pictures" (in-game HUD sprites).
let signalStyle = 'lamps';

// The dropdown only exists when index.html has it; never let a missing element
// abort the whole script (everything else depends on this file running to the end).
const signalStyleDropdown = document.getElementById('signalStyleDropdown');
if (signalStyleDropdown) {
	signalStyleDropdown.addEventListener('change', e => {
		signalStyle = e.target.value;
		applySignalStyle();
	});
}

function applySignalStyle() {
	try {
		signalMarkers.forEach(entry => {
			entry.marker.setIcon(getSignalIcon(entry.aspect, entry.mode, entry.type, entry.entry));
		});
		renderSignalTypePreviews();
	} catch (err) {
		console.error('applySignalStyle failed:', err);
	}
}

/////////////////////
// sidebar

const sidebar = L.control.sidebar({ autopan: true, container: 'sidebar' }).addTo(map);
document.body.append(document.getElementById('sidebar'));

const tablesort = new Tablesort(document.getElementById('carList'));
const carListBody = document.getElementById('carListBody');
const locoListBody = document.getElementById('locoListBody');

function createCarRow(carId) {
	const row = document.createElement('tr');
	row.setAttribute('id', `carList-${carId}`);
	row.classList.add('interactive');
	carListBody.append(row);
	updateCarRow(carId);
	row.addEventListener('click', _ => followCar(carId, false));
}

function removeCarRow(carId) {
	const row = document.getElementById(`carList-${carId}`);
	if (row)
		row.remove();
}

function updateCarRow(carId) {
	const row = document.getElementById(`carList-${carId}`);
	if (!row)
		return;
	const jobId = carJobIds.has(carId) ? carJobIds.get(carId) : '';
	const destinationYardId = allJobData.has(jobId) ? allJobData.get(jobId).destinationYardId : '';
	row.innerHTML = `<td>${carId}</td><td>${jobId}</td><td>${destinationYardId}</td>`;
	tablesort.refresh();
}

/////////////////////
// jobs

const CarsPerRow = 3;
const allJobData = new Map();
const carJobIds = new Map();
const jobListBody = document.getElementById('jobListBody');

// https://www.npmjs.com/package/string-hash
function stringHash(str) {
	let hash = 5381, i = str.length;
	while (i) {
		hash = (hash * 33) ^ str.charCodeAt(--i);
	}
	return hash >>> 0;
}

// http://vrl.cs.brown.edu/color
const carColors = [
	'#52ef99', '#c95e9f', '#b1e632', '#7574f5', '#799d10', '#fd3fbe', '#2cf52b', '#d130ff', '#21a708', '#fd2b31',
	'#3eeaef', '#ffc4de', '#069668', '#f9793b', '#5884c9', '#e5d75e', '#96ccfe', '#bb8801', '#6a8b7b', '#a8777c',
];

function colorByHashing(str) {
	return carColors[stringHash(str) % carColors.length];
}

function colorForJobDestination(jobId) {
	const jobData = allJobData.get(jobId);
	if (!jobData)
		return 'gray';
	return colorForYardId(jobData.destinationYardId);
}

function colorForJobType(jobId) {
	const segments = jobId.split('-');
	if (segments.length == 2)
		return 'cornflowerblue';
	const jobType = segments[1];
	switch (jobType) {
		case 'FH': return 'lightgreen';
		case 'LH': return 'khaki';
		case 'PC':
		case 'PE': return 'cornflowerblue';
		case 'PR': return 'mediumpurple';
		case 'SL':
		case 'SU': return 'lightcoral';
	}
}

function colorForJobId(jobId) {
	switch (getCarColorMode()) {
		case 'jobId': return colorByHashing(jobId);
		case 'carType':
		case 'jobType': return colorForJobType(jobId);
		case 'destination': return colorForJobDestination(jobId);
	}
}

function yardIdForTrack(trackId) {
	return trackId.split('-')[0];
}

function jobMatchesFilter(jobId, jobData) {
	const testText = document.getElementById('jobSearchText').value.toUpperCase();
	const activeOnly = document.getElementById('jobActiveOnly').checked;
	function taskFields(task) { return [task.startTrack, task.destinationTrack].concat(task.cars); }
	const fields = [jobId].concat(jobData.tasks.flatMap(taskFields));
	return fields.some(field => field.includes(testText)) && (!activeOnly || jobData.isActive);
}

function jobElem(jobId, jobData) {
	function replaceHyphens(s) { return s.replaceAll('-', '\u2011'); }

	const tbody = document.createElement('tbody');
	tbody.setAttribute('id', `jobList-${jobId}`);

	let row = document.createElement('tr');
	const jobIdCell = document.createElement('th');
	jobIdCell.setAttribute('colspan', CarsPerRow);
	jobIdCell.classList.add("jobList-jobHeader");
	jobIdCell.style.background = colorForJobId(jobId);
	jobIdCell.textContent = jobId;

	jobLicensesDiv = document.createElement('div');
	jobLicensesDiv.classList.add('jobList-licenses');
	for (const license of jobData.requiredLicenses) {
		jobLicensesDiv.innerHTML += `<span class="jobList-license"><div class="jobList-licenseBackground"></div><img src="res/licenses.${license}.png" title="${license}"></span>`;
	}
	jobIdCell.appendChild(jobLicensesDiv);

	row.appendChild(jobIdCell);
	tbody.appendChild(row);

	row = document.createElement('tr');
	jobMassCell = document.createElement('th');
	jobMassCell.textContent = `${jobData.mass.toFixed(0)} t`;
	jobLengthCell = document.createElement('th');
	jobLengthCell.textContent = `${jobData.length.toFixed(0)} m`;
	jobPaymentCell = document.createElement('th');
	jobPaymentCell.textContent =
		new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
			.format(jobData.basePayment);
	row.append(jobMassCell, jobLengthCell, jobPaymentCell);
	tbody.appendChild(row);

	jobData.tasks.forEach(task => {
		row = document.createElement('tr');
		const startTrackCell = document.createElement('th');
		startTrackCell.classList.add('interactive');
		startTrackCell.textContent = replaceHyphens(task.startTrack);
		startTrackCell.style.background = colorForYardId(yardIdForTrack(task.startTrack));
		startTrackCell.addEventListener('click', () => scrollToTrack(task.startTrack));
		row.appendChild(startTrackCell);

		const arrowCell = document.createElement('th');
		arrowCell.textContent = "\u279C";
		arrowCell.classList.add('jobList-trackSeparator');
		row.appendChild(arrowCell);

		const destinationTrackCell = document.createElement('th');
		destinationTrackCell.classList.add('interactive');
		destinationTrackCell.textContent = replaceHyphens(task.destinationTrack);
		destinationTrackCell.style.background = colorForYardId(yardIdForTrack(task.destinationTrack));
		destinationTrackCell.addEventListener('click', () => scrollToTrack(task.destinationTrack));
		row.appendChild(destinationTrackCell);

		for (let carIndex = 0; carIndex < task.cars.length; carIndex++) {
			if (carIndex % CarsPerRow == 0) {
				tbody.appendChild(row);
				row = document.createElement('tr');
			}
			const carId = task.cars[carIndex];
			const carCell = document.createElement('td');
			carCell.classList.add(`jobList-carCell-${carId}`);
			carCell.classList.add('interactive');
			carCell.textContent = carId;
			carCell.addEventListener('click', () => followCar(carId, false));
			row.appendChild(carCell);
		}
		if (row.children.length < CarsPerRow)
			// add filler cells
			for (let i = 0; i < CarsPerRow - (task.cars.length % CarsPerRow); i++)
				row.appendChild(document.createElement('td'));
		tbody.appendChild(row);
	});

	return tbody;
}

function updateCarJobs() {
	carJobIds.clear();
	allJobData.forEach((jobData, jobId) => {
		jobData.tasks.forEach(task => {
			task.cars.forEach(carId => {
				carJobIds.set(carId, jobId);
			});
		})
	});
	for ([carId, _] of allCarData) {
		updateCarRow(carId);
		updateCarMarker(carId);
	}
}

function updateJobListColors() {
	for (const elem of jobListBody.querySelectorAll('th.jobList-jobHeader')) {
		elem.style.background = colorForJobId(elem.textContent);
	}
}

function updateJobList() {
	for (const elem of Array.from(jobListBody.childNodes))
		elem.remove();
	const sortedJobs = Array.from(allJobData.entries()).sort((a, b) => a[0].localeCompare(b[0]));
	sortedJobs
		.filter(([jobId, jobData]) => jobMatchesFilter(jobId, jobData))
		.forEach(([jobId, jobData]) => jobListBody.appendChild(jobElem(jobId, jobData)));
}

function updateAllJobs(jobs) {
	allJobData.clear();
	Object.entries(jobs).forEach(([jobId, jobData]) => allJobData.set(jobId, jobData));
	updateJobList();
	updateCarJobs();
}

let jobSearchTimeoutId;
function queueJobUpdate() {
	if (jobSearchTimeoutId)
		clearTimeout(jobSearchTimeoutId);
	jobSearchTimeoutId = setTimeout(updateJobList, 100);
}
document.getElementById('jobSearchText').addEventListener('input', e => {
	queueJobUpdate();
});
document.getElementById('jobActiveOnly').addEventListener('change', e => {
	queueJobUpdate();
})

/////////////////////
// track

const trackPolyLines = new Map();

function colorForYardId(yardId) {
	switch (yardId) {
		case 'CME': return '#686868';
		case 'CMS': return '#4e554e';
		case 'CP': return '#583d3d';
		case 'CS': return '#97adc2';
		case 'CW': return '#a7a7a7';
		case 'FF': return '#77a6e3';
		case 'FM': return '#ddaa4d';
		case 'FRC': return '#92b66a';
		case 'FRS': return '#609161';
		case 'GF': return '#c97fa2';
		case 'HB': return '#816c94';
		case 'HMB': return '#816c94';
		case 'IME': return '#b66861';
		case 'IMW': return '#9a5847';
		case 'MB': return '#988c5f';
		case 'MF': return '#dc885b';
		case 'MFMB': return '#dc885b';
		case 'OR': return '#935478';
		case 'OWC': return '#555a62';
		case 'OWN': return '#625d55';
		case 'SM': return '#7b8394';
		case 'SW': return '#cda888';
	}
}

function createTrackLabel(trackId, position, angle) {
	const size = 0.0002;
	const bounds = [[position[0] - size, position[1] - size], [position[0] + size, position[1] + size]];
	const rotation = `rotate(${-angle})`;

	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('id', trackId)
	svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svg.setAttribute('viewBox', '-50 -10 100 20');
	svg.innerHTML = `<text text-anchor="middle" dominant-baseline="central" transform="${rotation}" font-family="Arial" font-weight="bold" fill="steelblue" stroke="black" stroke-width="0.25px">${trackId.slice(trackId.indexOf('-') + 1)}</text>`;
	L.svgOverlay(svg, bounds, { renderer: canvasRenderer })
		.addTo(map)
		.setZIndex(1000);
}

function pointDistance(p1, p2) {
	const d0 = p1[0] - p2[0];
	const d1 = p1[1] - p2[1];
	return Math.sqrt(d0 * d0 + d1 * d1);
}

function pointLerp(p1, p2, a) {
	return [
		(p2[0] - p1[0]) * a + p1[0],
		(p2[1] - p1[1]) * a + p1[1]
	];
}

function createLocation(start, end, mid, a) {
	return [
		(end[0] - start[0]) * a + mid[0],
		(end[1] - start[1]) * a + mid[1]
	];
}

function createTrackLabels(trackId, coords) {
	const length = pointDistance(coords[0], coords[coords.length - 1]);
	const midIndex = Math.floor(coords.length / 2);
	const beforeMid = (midIndex % 2 == 1) ? coords[midIndex] : coords[midIndex - 1];
	const mid = (midIndex % 2 == 1) ? coords[midIndex] : pointLerp(coords[midIndex - 1], coords[midIndex], 0.5);
	const afterMid = (midIndex % 2 == 1) ? coords[midIndex + 1] : coords[midIndex];
	const midGap = pointDistance(beforeMid, afterMid);

	const angle = ((Math.atan2(afterMid[0] - beforeMid[0], afterMid[1] - beforeMid[1]) * 180 / Math.PI) + 270) % 180 - 90;

	if (coords.length > 5) {
		createTrackLabel(trackId, createLocation(beforeMid, afterMid, mid, length / midGap * 0.3), angle);
		createTrackLabel(trackId, createLocation(beforeMid, afterMid, mid, length / midGap * -0.3), angle);
	} else {
		createTrackLabel(trackId, mid, angle);
	}
}

const tracksReady = fetch(new URL('/track', location))
	.then(resp => resp.json())
	.then(tracks => {
		Object.entries(tracks).forEach(([trackId, coords]) => {
			const isSiding = !trackId.includes('#');
			const polyline = L.polyline(coords, {
				color: isSiding ? 'slategray' : 'lightsteelblue',
				interactive: false,
				renderer: canvasRenderer,
			}).addTo(map);
			trackPolyLines.set(trackId, polyline);
			if (isSiding)
				createTrackLabels(trackId, coords)
		});
	});

/////////////////////
// junctions

let junctions = [];
var junctionDisplayNames = new Map();

const junctionsReady = tracksReady
	.then(_ => fetch(new URL('/junction', location)))
	.then(resp => resp.json())
	.then(allJunctionData =>
		junctions = allJunctionData.map((data, index) => ({
			marker: createJunctionMarker(data.position, index, data.id), // id here is the "real" ID of the Junction, the index is just how the frontend handles them internally
			branches: data.branches,
		}))
	)
	.catch(err => console.error('Failed to load junctions:', err));

function toggleJunction(junctionId) {
	return fetch(new URL(`/junction/${junctionId}/toggle`, location), { method: 'POST' })
		.then(r => {
			if (r.status === 403) console.warn('No permission to toggle junction #' + junctionId);
			else if (r.status === 404) console.warn('Junction not found: #' + junctionId);

			return r.json();
		})
		.catch(err => {
			console.error(`Failed to toggle junction #${junctionId}:`, err);
			throw err;
		});
}

const junctionCanvasSize = 60;

function createJunctionShape(selectedBranch) {
	let branchLine = (selectedBranch) => {
		switch (selectedBranch) {
			case 0: return `<line clip-path="url(#box)" x1="${junctionCanvasSize / 2}" y1="${junctionCanvasSize}" x2="${-junctionCanvasSize / 2}" y2="${-junctionCanvasSize}" stroke="white" stroke-width="10"/>`
			case 1: return `<line clip-path="url(#box)" x1="${-junctionCanvasSize / 2}" y1="${junctionCanvasSize}" x2="${junctionCanvasSize / 2}" y2="${-junctionCanvasSize}" stroke="white" stroke-width="10"/>`
		}
		return ''
	}
	return `<g opacity="70%">
		<clipPath id="box"><rect x="${-junctionCanvasSize / 2}" y="${-junctionCanvasSize}" width="${junctionCanvasSize}" height="${junctionCanvasSize * 2}"/></clipPath>
		<rect x="${-junctionCanvasSize / 2}" y="${-junctionCanvasSize}" width="${junctionCanvasSize}" height="${junctionCanvasSize * 2}" fill="red"/>` +
		branchLine(selectedBranch) +
		`<rect x="${-junctionCanvasSize / 2}" y="${-junctionCanvasSize}" width="${junctionCanvasSize}" height="${junctionCanvasSize * 2}" fill="none" stroke="black" stroke-width="2%"/></g>`;
}

function createJunctionLabel(junctionId) {
	let displayName = junctionDisplayNames.get(junctionId) || junctionId;
	return `<rect x="${-junctionCanvasSize / 2}" y="${junctionCanvasSize - 10}" width="${junctionCanvasSize}" height="10" fill="black" opacity="60%"/>
			<text x="${-junctionCanvasSize / 2 + 2}" y="${junctionCanvasSize - 2}" font-size="8" fill="white" font-family="sans-serif">${displayName}</text>`;
}

function createJunctionOverlay(junctionId) {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('id', `J-${junctionId}`)
	svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svg.setAttribute('viewBox', `${-junctionCanvasSize / 2} ${-junctionCanvasSize} ${junctionCanvasSize} ${junctionCanvasSize * 2}`);
	svg.innerHTML = createJunctionShape(null) + createJunctionLabel(junctionId);
	return svg;
}

function updateJunctionOverlay(junctionId, selectedBranch) {
	const junction = junctions[junctionId]
	if (!junction || !junction.marker || !junction.marker.getElement()) return;
	junction.marker.getElement().innerHTML = createJunctionShape(selectedBranch) + createJunctionLabel(junctionId);
	const branches = junction.branches || [];
	const selectedTrackId = branches[selectedBranch]
	const selectedPolyLine = trackPolyLines.get(selectedTrackId);
	if (selectedPolyLine) selectedPolyLine.setStyle({ color: 'steelblue', dashArray: null });
	const unselectedTrackPolyLine = trackPolyLines.get(branches[1 - selectedBranch]);
	if (unselectedTrackPolyLine)
		unselectedTrackPolyLine
			.setStyle({ color: 'lightsteelblue', dashArray: "6 12" })
			.bringToBack();
}

function getJunctionOverlayBounds(position) {
	const size = metersToDegrees * 5;
	return [
		[
			position[0] - size,
			position[1] - size / 2
		],
		[
			position[0] + size,
			position[1] + size / 2
		]
	];
}

function createJunctionMarker(p, junctionId, displayName) {
	junctionDisplayNames.set(junctionId, displayName);
	return L.svgOverlay(
		createJunctionOverlay(junctionId, junctionId),
		getJunctionOverlayBounds(p),
		{ interactive: true, renderer: canvasRenderer })
		.addEventListener('click', () => toggleJunction(junctionId))
		.addTo(map)
		.setZIndex(Math.floor(p[0] * 100000 + p[1] * 100000));
}

function updateAllJunctions(states) {
	states.forEach((state, index) => updateJunctionOverlay(index, state));
	if (typeof switchboardRenderer !== 'undefined' && switchboardRenderer) {
		switchboardRenderer.updateSwitchStates(states);
	}
}

/////////////////////
// signals

const signalMarkers = new Map();
const signalIconAnchorY = 12; // the anchor x is the face's horizontal centre (computed per icon), y is fixed

// Signal pack table (lamp/aspect layout), served via /signalpack.
let packTable = { Signals: {} };

function refreshPackTable(data) {
	packTable = (data && data.Signals) ? data : { Signals: {} };
	// Re-render all existing signal markers so newly-loaded pack entries show.
	signalMarkers.forEach((entry, signalId) => {
		entry.entry = packTable.Signals[signalId] || null;
		entry.marker.setIcon(getSignalIcon(entry.aspect, entry.mode, entry.type, entry.entry));
	});
	renderSignalTypePreviews();
}

// In-game HUD sprite manifest, served by GET /signal/sprites:
// { Aspects: { "<aspectId>": "/signal/sprite/<aspectId>", ... },
//   Off:     { "<Type>": "/signal/sprite/off/<Type>", ... } }
let spriteManifest = { Aspects: {}, Off: {} };
let lastSpriteManifestJson = '{}';

function refreshSpriteManifest(data) {
	try {
		spriteManifest = (data && data.Aspects) ? data : { Aspects: {}, Off: {} };
		lastSpriteManifestJson = JSON.stringify(spriteManifest);
		applySignalStyle();
	} catch (err) {
		console.error('refreshSpriteManifest failed:', err);
	}
}

// Re-fetches the sprite manifest so live sprites appear once the backend has captured
// them (throttled; a no-op when nothing changed). Runs alongside the update loop.
const spriteManifestFetchInterval = 15000;
let lastSpriteManifestFetch = 0;

function refreshSpriteManifestIfStale() {
	const now = Date.now();
	if (now - lastSpriteManifestFetch < spriteManifestFetchInterval) return Promise.resolve();
	lastSpriteManifestFetch = now;
	return fetch(new URL('/signal/sprites', location))
		.then(resp => (resp.ok ? resp.json() : { Aspects: {}, Off: {} }))
		.catch(() => ({ Aspects: {}, Off: {} }))
		.then(data => {
			try {
				const json = JSON.stringify(data || {});
				if (json !== lastSpriteManifestJson) refreshSpriteManifest(data);
			} catch (err) {
				console.error('refreshSpriteManifestIfStale failed:', err);
			}
		});
}

// Static fallback pictures bundled with the frontend (signals/*.webp), used when the
// live sprite for an aspect isn't available yet. Best-effort mapping of an aspect id
// (e.g. "S2", "Ms6", "Ds1") to the closest pre-drawn face by signal type + number.
// Bundled main-signal files are named s{n}_automatic.webp / s{n}_manual.webp;
// distant files are ds{n}.webp.
function staticSignalSpriteUrl(aspectId, type) {
	const distant = String(type).toLowerCase() === 'distant';
	const base = 'res/signals/';
	const offFile = distant ? 'distant_off.webp' : 'off.webp';
	if (!aspectId || aspectId === 'OFF') return base + offFile;

	const match = String(aspectId).match(/(\d+)/);
	if (!match) return base + (distant ? 'distant_all.webp' : 'all.webp');
	const num = match[1];
	const lower = String(aspectId).toLowerCase();

	if (distant) {
		if (['1', '2', '3', '4'].includes(num)) return base + `ds${num}.webp`;
		return base + 'distant_all.webp';
	}

	const file = (lower.includes('c') && num === '1') ? 's1c_automatic.webp'
		: (['1', '2', '4', '6'].includes(num) ? `s${num}_automatic.webp` : null);
	return file ? base + file : base + 'all.webp';
}

// Resolves the sprite entry for an aspect/type: live manifest sprite, then the live
// off-state sprite, then the static webp fallback. Returns { url, w?, h? } (natural
// pixel dims when the manifest has them) or null if none match.
function spriteEntryFor(aspectId, type) {
	const key = aspectId || 'OFF';
	const aspectEntry = (key !== 'OFF' && spriteManifest.Aspects) ? spriteManifest.Aspects[key] : null;
	if (aspectEntry) return normalizeSpriteEntry(aspectEntry);
	const typeKey = String(type);
	const offEntry = spriteManifest.Off ? spriteManifest.Off[typeKey] : null;
	if (offEntry) return normalizeSpriteEntry(offEntry);
	const staticUrl = staticSignalSpriteUrl(key, typeKey);
	return staticUrl ? { url: staticUrl } : null;
}

// Normalizes a manifest entry (string URL or { u, w, h }) into { url, w?, h? }.
function normalizeSpriteEntry(entry) {
	if (typeof entry === 'string') return { url: entry };
	const url = entry && entry.u;
	if (!url) return null;
	const result = { url };
	if (entry.w > 0 && entry.h > 0) { result.w = entry.w; result.h = entry.h; }
	return result;
}

// Resolves just the sprite URL (used where only the src is needed, e.g. sidebar previews).
function spriteUrlFor(aspectId, type) {
	const entry = spriteEntryFor(aspectId, type);
	return entry ? entry.url : null;
}

function makeSafeSignalId(id) {
	if (!id) return '';
	// Replace characters that have special meaning in CSS:
	// . (class), : (pseudo-class/attribute), [ (attribute selector),
	// # (ID), $ (data attribute), { } (content), ( ) (expression),
	// * (universal), + (adjacent sibling), > (child), space (descendant), % (percent)
	return id.replace(/[\.\:\[\]\#\$%\{\}\(\)\*\+\>\s]+/g, '_');
}

// Signal faces are drawn in a viewBox that wraps the lamps' grid positions as a min-rect:
// a fixed 10-unit slot per grid cell, with 3-unit padding around the box.
// The rendered icon is drawn 2× the viewBox, and distant signals render at 75% of normal scale.
const signalIconMaxScale = 3; // cap: icons won't grow beyond 3× their base size
const signalRenderScale = 2; // CSS pixels per viewBox unit
const signalTypeScale = { normal: 1, distant: 0.75 }; // distant renders at 75% of normal
const signalFacePad = 3; // padding around the face box
const signalFaceSlot = 10; // viewBox space allocated per grid cell
const signalFaceDefaultCols = 1;
const signalFaceDefaultRows = 5; // face used until pack data loads
// Layout editor: pixel size of a grid cell / gap between cells, and the farthest grid
// coordinate a lamp may take (must match the server's max grid extent).
const signalLayoutEditorCell = 30;
const signalLayoutEditorGap = 4;
const signalLayoutMaxGrid = 15;

// Switchboard row in the aspect × lamp table: clicking an aspect's cell cycles its dot
// colour through these (none → green → yellow → red → white → blue → none). The switchboard
// dot colour for a signal is looked up by its current aspect.
const SWITCHBOARD_COLOURS = ['green', 'yellow', 'red', 'white', 'blue'];

// Grid cell [col, row] for a lamp: the user-edited layout if present, otherwise the
// default single column laid out in array order.
function lampGridPos(lamp, index) {
	if (lamp && Array.isArray(lamp.Grid) && lamp.Grid.length === 2) return lamp.Grid;
	return [0, index];
}

// The lamp's shape ("bar" lamps render as a thin rectangle two cells wide).
function lampShape(lamp) {
	return (lamp && lamp.Shape === 'bar') ? 'bar' : 'circle';
}

// How many grid cells the lamp occupies horizontally (bars span two).
function lampSpan(lamp) {
	return lampShape(lamp) === 'bar' ? 2 : 1;
}

// Min-rect face dimensions (viewBox units) around the lamps' grid positions.
function signalFaceDimensions(lamps) {
	if (!lamps || !lamps.length) {
		return {
			w: signalFaceSlot * signalFaceDefaultCols,
			h: 2 * signalFacePad + signalFaceSlot * signalFaceDefaultRows,
			cols: signalFaceDefaultCols,
			rows: signalFaceDefaultRows,
		};
	}
	let cols = 0, rows = 0;
	lamps.forEach((lamp, i) => {
		const [x, y] = lampGridPos(lamp, i);
		if (x + lampSpan(lamp) > cols) cols = x + lampSpan(lamp);
		if (y + 1 > rows) rows = y + 1;
	});
	return {
		w: signalFaceSlot * cols,
		h: 2 * signalFacePad + signalFaceSlot * rows,
		cols,
		rows,
	};
}

function getSignalIconSize(type, lamps) {
	const factor = signalTypeScale[String(type).toLowerCase()] || signalTypeScale.normal;
	const { w, h } = signalFaceDimensions(lamps);
	const zoom = map.getZoom();
	const scale = zoom < initialZoom - 4 ? 1 / (2 ** (initialZoom - 4 - zoom)) : 1;
	const minScale = 1 / signalIconMaxScale; // floor so they don't vanish entirely
	const s = Math.max(scale, minScale);
	return [
		Math.round(w * signalRenderScale * factor * s),
		Math.round(h * signalRenderScale * factor * s),
	];
}

// Uniform sprite render scale: CSS pixels per sprite pixel. A 160x640 HUD sprite
// therefore renders at 40x160px (tall faces stay tall, larger sprites show larger).
const signalSpriteScale = 0.13;

// Rendered size of a sprite icon, preserving its natural aspect ratio. When the
// natural dimensions are unknown (e.g. static fallback) a fixed square is used.
function getSignalSpriteSize(w, h, type) {
	const factor = signalTypeScale[String(type).toLowerCase()] || signalTypeScale.normal;
	const zoom = map.getZoom();
	const scale = zoom < initialZoom - 4 ? 1 / (2 ** (initialZoom - 4 - zoom)) : 1;
	const minScale = 1 / signalIconMaxScale; // floor so they don't vanish entirely
	const s = Math.max(scale, minScale) * factor * signalSpriteScale;
	if (w > 0 && h > 0) {
		return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
	}
	const size = Math.max(1, Math.round(36 * Math.max(scale, minScale) * factor));
	return [size, size];
}

// Escapes a string for safe embedding in SVG/HTML.
function escapeXml(s) {
	return String(s).replace(/[&<>"']/g, c => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	}[c]));
}

// Lamp colours arrive as ColorUtility.ToHtmlStringRGBA() output: "RRGGBBAA" without '#',
// e.g. "31F885FF". Normalize to "#RRGGBB" (drop the always-opaque alpha) for CSS/SVG.
function normalizeLampColour(c) {
	if (!c) return '#fff';
	let s = c.charAt(0) === '#' ? c : '#' + c;
	if (s.length === 9) s = s.slice(0, 7); // #RRGGBBAA -> #RRGGBB
	return s;
}

// All unique lamp colours currently in the pack table (as "#RRGGBB", sorted) —
// the options offered by the per-lamp colour dropdown.
function collectPackColours() {
	const set = new Set();
	const signals = packTable.Signals;
	if (signals) {
		Object.keys(signals).forEach(signalId => {
			const entry = signals[signalId];
			if (!entry || !Array.isArray(entry.Lamps)) return;
			entry.Lamps.forEach(lamp => {
				if (lamp && lamp.Colour) set.add(normalizeLampColour(lamp.Colour));
			});
		});
	}
	return [...set].sort();
}

// Builds a generic lamp-based signal face as an SVG string.
// Lamps sit on integer grid cells ([col, row]); the face box is the min-rect around them,
// so empty cells/rows can exist. Lamps without a user layout fall back to the default
// single column in array order.
// The SVG fills whatever box the caller (divIcon iconSize / preview wrapper) gives it.
// When allLit is true, every lamp is shown in its own colour (used for the "none"
// sidebar preview so lamp colours are visible without any aspect applied).
function createSignalFaceSvg(entry, aspect, allLit = false) {
	const lamps = (entry && entry.Lamps) ? entry.Lamps : [];
	const aspectDef = (!allLit && aspect && aspect !== 'OFF' && entry && entry.Aspects) ? entry.Aspects[aspect] : null;
	const lit = allLit ? lamps.map(lamp => lamp.Name) : (aspectDef ? (aspectDef.Lit || []) : []);
	const blinking = allLit ? [] : (aspectDef ? (aspectDef.Blinking || []) : []);

	const { w, h } = signalFaceDimensions(lamps);
	const pad = signalFacePad;
	const slot = signalFaceSlot;
	const lampR = 3.2;

	let lampsSvg = '';
	lamps.forEach((lamp, i) => {
		const [gx, gy] = lampGridPos(lamp, i);
		const cy = pad + slot * gy + slot / 2;
		const isLampLit = allLit || lit.indexOf(lamp.Name) !== -1;
		const isBlink = !allLit && blinking.indexOf(lamp.Name) !== -1;
		const fill = isLampLit ? normalizeLampColour(lamp.Colour) : '#2a2a2a';
		const cls = isBlink ? 'sig-lamp sig-lamp-blinking' : 'sig-lamp';
		if (lampShape(lamp) === 'bar') {
			// Thin rounded rectangle spanning the lamp cell and the one to its right.
			const bx = slot * gx + 1;
			const bh = slot * 0.35;
			lampsSvg += `<rect class="${cls}" x="${bx.toFixed(1)}" y="${(cy - bh / 2).toFixed(1)}" width="${slot * 2 - 2}" height="${bh.toFixed(1)}" rx="${(bh / 2).toFixed(1)}" fill="${escapeXml(fill)}" stroke="#000" stroke-width="0.5"/>`;
		} else {
			const cx = slot * gx + slot / 2;
			lampsSvg += `<circle class="${cls}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${lampR}" fill="${escapeXml(fill)}" stroke="#000" stroke-width="0.5"/>`;
		}
	});

	return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${w} ${h}">
		<rect x="0" y="0" width="${w}" height="${h}" rx="3" fill="#1a1a1a" stroke="#444" stroke-width="1"/>
		${lampsSvg}
	</svg>`;
}

// Neutral fallback for signals whose pack entry isn't loaded yet.
function createNeutralSignalSvg() {
	const { w, h } = signalFaceDimensions(null);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
		<circle cx="${w / 2}" cy="${h / 2}" r="4.5" fill="#3a3a3a" stroke="#555" stroke-width="1"/>
	</svg>`;
}

function getSignalIcon(aspect, mode, type, entry) {
	if (signalStyle === 'pictures') {
		const sprite = spriteEntryFor(aspect, type);
		const iconSize = getSignalSpriteSize(sprite ? sprite.w : 0, sprite ? sprite.h : 0, type);
		const html = sprite
			? `<img class="sig-sprite" src="${escapeXml(sprite.url)}" alt="" style="width:${iconSize[0]}px;height:${iconSize[1]}px">`
			: (entry ? createSignalFaceSvg(entry, aspect) : createNeutralSignalSvg());
		return L.divIcon({
			html: html,
			className: 'signal-divicon',
			iconSize: iconSize,
			iconAnchor: [Math.round(iconSize[0] / 2), signalIconAnchorY],
		});
	}

	const lamps = (entry && entry.Lamps) ? entry.Lamps : null;
	const iconSize = getSignalIconSize(type, lamps);
	const html = entry ? createSignalFaceSvg(entry, aspect) : createNeutralSignalSvg();
	return L.divIcon({
		html: html,
		className: 'signal-divicon',
		iconSize: iconSize,
		iconAnchor: [Math.round(iconSize[0] / 2), signalIconAnchorY],
	});
}

function createSignalMarker(signalId, signalData) {
	const aspect = signalData.CurrentAspectId || 'OFF';
	const mode = signalData.Mode || 'Automatic';
	const signalType = signalData.Type
	const position = signalData.Position;
	const entry = packTable.Signals ? (packTable.Signals[signalId] || null) : null;
	const name = signalData.Name || signalId;
	const yard = signalData.YardId || null;

	const marker = L.marker(position, {
		icon: getSignalIcon(aspect, mode, signalType, entry),
		interactive: true,
		title: name,
		zIndexOffset: Math.floor(position[0] * 100000 + position[1] * 100000),
	})
		.bindPopup(() => buildSignalPopup(signalId, signalType), { maxWidth: 260 })
		.addTo(map);

	signalMarkers.set(signalId, { marker, aspect, mode, type: signalType, entry, Id: signalData.Id || signalId, junctionId: signalData.JunctionId || null, direction: signalData.Direction || null, RequiredBranch: (signalData.RequiredBranch !== null && signalData.RequiredBranch !== undefined) ? signalData.RequiredBranch : null, signalAspects: signalData.Aspects || null, name, yard });
}


function getSignalsByJunctionId(junctionId) {
	if (!junctionId) return [];
	const result = [];
	for (const [signalId, entry] of signalMarkers) {
		if (entry.junctionId === junctionId) {
			result.push(entry);
		}
	}
	return result;
}

function buildSignalPopup(signalId, signalType) {
	if (loggingEnabled) {
		console.log("buildSignalPopup called");
		console.log(`Signal ID   : ${signalId}`);
		console.log(`Signal type : ${signalType}`);
	}

	const state = signalMarkers.get(signalId);
	if (!state)
		return '';

	const signalName = state.name || signalId;

	if (signalType == "Distant") {
		const el = document.createElement('strong');
		el.style.fontSize = '1.1em';
		el.textContent = signalName;
		return el;
	}

	// If mode is not known, assume manual
	const isManual = state.mode === 'Manual';
	// Aspects available on this signal come from the complete API list; fall back to
	// the pack table (which only contains aspects observed so far).
	// Each aspect has a raw id (e.g. "S10", "Ms2"); the pack provides no friendly names, so show the id.
	var validTypeAspects = [];
	if (state.signalAspects && state.signalAspects.length) {
		validTypeAspects = state.signalAspects.map(id => ({ aspect: id, name: id }));
	} else if (state.entry && state.entry.Aspects) {
		validTypeAspects = Object.keys(state.entry.Aspects).map(id => ({ aspect: id, name: id }));
	}
	const noAspectData = validTypeAspects.length === 0;

	const container = document.createElement('div');
	container.style.cssText = 'min-width:200px;font-family:sans-serif';
	container.innerHTML = `
		<strong style="font-size:1.1em">${escapeXml(signalName)}</strong>
			<div style="margin:6px 0">
				Mode: <strong id="sig-mode-label-${makeSafeSignalId(signalId)}">${state.mode}</strong>
			</div>
			<label style="display:flex;align-items:center;gap:6px;margin-bottom:10px;cursor:pointer">
				<input type="checkbox" id="sig-manual-${makeSafeSignalId(signalId)}" ${isManual ? 'checked' : ''}>
				Manual control
			</label>
			<div id="sig-aspect-row-${makeSafeSignalId(signalId)}" style="display:${isManual ? 'block' : 'none'}">
				<div style="margin-bottom:4px">Set aspect:</div>
				${noAspectData
		? `<div style="font-size:0.85em;color:gray;margin-bottom:8px">Aspect data not loaded yet.</div>`
		: `<select id="sig-aspect-select-${makeSafeSignalId(signalId)}" style="width:100%;margin-bottom:8px;max-height:120px;overflow-y:auto">
					${validTypeAspects.map(a =>
		`<option value="${a.aspect}" ${a.aspect === state.aspect ? 'selected' : ''}>${a.name}</option>`
	).join('')}
				</select>`}
				<button id="sig-apply-${makeSafeSignalId(signalId)}"
					style="width:100%;padding:4px;background:#2a6;color:#fff;border:none;border-radius:3px;cursor:pointer">
					Apply aspect
				</button>
			</div>
			<div id="sig-status-${makeSafeSignalId(signalId)}" style="margin-top:6px;font-size:0.85em;color:gray"></div>
		`;

	const manualCheckbox = container.querySelector(`#sig-manual-${makeSafeSignalId(signalId)}`);
	if (manualCheckbox) {
		manualCheckbox.addEventListener('change', e => {
			const newMode = e.target.checked ? 'Manual' : 'Automatic';
			if (newMode === state.mode) return; // already in this mode, skip
			postSignalControl(signalId, { mode: newMode })
				.then(ok => {
					if (ok) {
						const entry = signalMarkers.get(signalId);
						if (entry) {
							entry.mode = newMode;
							entry.marker.setIcon(getSignalIcon(entry.aspect, entry.mode, signalType, entry.entry));
						}
						const modeLabel = container.querySelector(`#sig-mode-label-${makeSafeSignalId(signalId)}`);
						if (modeLabel) modeLabel.textContent = newMode;
						const aspectRow = container.querySelector(`#sig-aspect-row-${makeSafeSignalId(signalId)}`);
						if (aspectRow) aspectRow.style.display = e.target.checked ? 'block' : 'none';
						setSignalStatus(signalId, container, `Mode set to ${newMode}.`);
					} else {
						setSignalStatus(signalId, container, 'Failed to set mode.', true);
						e.target.checked = !e.target.checked; // revert on failure
					}
				});
		});
	}

	const applyButton = container.querySelector(`#sig-apply-${makeSafeSignalId(signalId)}`);
	if (applyButton) {
		applyButton.addEventListener('click', () => {
			const aspectSelect = container.querySelector(`#sig-aspect-select-${makeSafeSignalId(signalId)}`);
			if (!aspectSelect) return;
			const aspect = aspectSelect.value;
			postSignalControl(signalId, { aspect })
				.then(ok => {
					setSignalStatus(signalId, container,
						ok ? `Aspect set to ${aspect}.` : 'Failed to set aspect.', !ok);
					if (ok) {
						const entry = signalMarkers.get(signalId);
						if (entry) {
							entry.aspect = aspect;
							entry.marker.setIcon(getSignalIcon(entry.aspect, entry.mode, signalType, entry.entry));
						}
					}
				});
		});
	}

	return container;
}

function setSignalStatus(signalId, container, msg, isError = false) {
	const statusEl = container.querySelector(`#sig-status-${makeSafeSignalId(signalId)}`);
	if (statusEl) {
		statusEl.textContent = msg;
		statusEl.style.color = isError ? '#c44' : 'gray';
	}
}

function postSignalControl(signalId, params) {
	return fetch(new URL(`/signal/control`, location), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ signalId, ...params })
	})
		.then(r => {
			if (r.ok || r.status === 204) return true;

			if (r.status === 403) console.warn('No permission to control signal #' + signalId);
			else if (r.status === 404) console.warn('Signal not found: #' + signalId);
			else if (r.status === 400) console.warn('Bad request when controlling signal ' + signalId);
			else if (r.status === 401) console.warn('Unauthorized to control signal ' + signalId);
			else if (r.status >= 500) console.warn('Server error (' + r.status + ') when controlling signal ' + signalId);

			return false;
		})
		.catch(err => {
			console.error(`Failed to control signal #${signalId}:`, err);
			return false;
		});
}

function updateAllSignals(signalsData) {
	let anyChanged = false;
	let aspectsChanged = false;
	Object.entries(signalsData).forEach(([signalId, signalData]) => {
		if (loggingEnabled)
			console.log(`Updating signal ${signalId} with aspect ${signalData.CurrentAspectId} and mode ${signalData.Mode}`);
		const existing = signalMarkers.get(signalId);
		if (!existing)
			return;

		if (signalData.Name) existing.name = signalData.Name;
		if (signalData.YardId) existing.yard = signalData.YardId;

		const aspect = signalData.CurrentAspectId || 'OFF';
		const mode = signalData.Mode ?? existing.mode;

		const aspectChanged = existing.aspect !== aspect;
		const modeChanged = existing.mode !== mode;

		if (aspectChanged || modeChanged) anyChanged = true;

		// Refresh the complete aspect list in case it arrived after the popup was built.
		if (signalData.Aspects) {
			if (!existing.signalAspects ||
				existing.signalAspects.length !== signalData.Aspects.length ||
				existing.signalAspects.some((a, i) => a !== signalData.Aspects[i])) {
				aspectsChanged = true;
			}
			existing.signalAspects = signalData.Aspects;
		}

		// Refresh the pack entry in case a /signalpack refresh added this signal.
		if (packTable.Signals && !existing.entry && packTable.Signals[signalId]) {
			existing.entry = packTable.Signals[signalId];
		}

		// Update state first so setIcon uses the correct aspect+mode combination
		if (aspectChanged) existing.aspect = aspect;
		if (modeChanged) existing.mode = mode;

		// Regenerate icon whenever aspect OR mode changes (both affect the icon URL)
		if (aspectChanged || modeChanged || !existing.entry) {
			existing.marker.setIcon(getSignalIcon(existing.aspect, existing.mode, signalData.Type, existing.entry));
		}

		// If the popup is currently open, patch the DOM directly so it stays live
		if ((aspectChanged || modeChanged) && existing.marker.isPopupOpen()) {
			const modeLabel = document.getElementById(`sig-mode-label-${makeSafeSignalId(signalId)}`);
			const manualCb = document.getElementById(`sig-manual-${makeSafeSignalId(signalId)}`);
			const aspectSel = document.getElementById(`sig-aspect-select-${makeSafeSignalId(signalId)}`);
			const aspectRow = document.getElementById(`sig-aspect-row-${makeSafeSignalId(signalId)}`);

			if (modeLabel) modeLabel.textContent = mode;
			if (manualCb) manualCb.checked = mode === 'Manual';
			if (aspectRow) aspectRow.style.display = mode === 'Manual' ? 'block' : 'none';
			if (aspectSel) aspectSel.value = aspect;
		}
	});

	if (typeof SwitchboardSignals !== 'undefined' && !SwitchboardSignals.initialized && signalMarkers.size > 0) {
		SwitchboardSignals.init();
	}

	if (typeof SwitchboardSignals !== 'undefined' && SwitchboardSignals.initialized && !SwitchboardOccupancy.isActive) {
		SwitchboardSignals.updateAllVirtualSignals();
	}

	if (switchboardRepaint.exist()) {
		if (anyChanged) switchboardRepaint.markAllSwitches();
		return;
	}
	if (anyChanged && typeof switchboardRenderer !== 'undefined' && switchboardRenderer) {
		switchboardRenderer.rerenderSwitches();
	}
	if (aspectsChanged) renderSignalTypePreviews();
}

/////////////////////
// switchboard repaint coalescer
//
// Every tag handler mutates state and calls switchboardRepaint.markBlocks()/
// markAllSegments()/markAllSwitches() instead of painting directly. A single
// debounced pass (rAF) then renders the union of dirty blocks once, and while
// the board is hidden it skips painting; the toggle's full repaint on show
// covers anything marked while hidden.

function switchboardVisible() {
	return document.body.classList.contains('switchboard-active');
}

const switchboardRepaint = {
	_blocks: null,
	_allSegments: false,
	_allSwitches: false,
	_scheduled: false,
	_repainting: false,
	_lastPathsSignature: '',

	init() {
		this._blocks = new Set();
		this._allSegments = false;
		this._allSwitches = false;
		this._scheduled = false;
		this._repainting = false;
	},

	markBlocks(blockIds) {
		if (!this._blocks || this._repainting) {
			if (switchboardRenderer) switchboardRenderer.rerenderBlocks(blockIds);
			return;
		}
		// Store block ids; rerenderBlocks resolves each block's segments
		// (both regular and switch) in flush.
		for (const blockId of blockIds) {
			if (TrackData.getBlock(blockId)) this._blocks.add(blockId);
		}
		this._schedule();
	},

	markAllSegments() {
		if (!this._blocks || this._repainting) {
			if (switchboardRenderer) switchboardRenderer.rerenderAllSegments();
			return;
		}
		this._allSegments = true;
		this._schedule();
	},

	markAllSwitches() {
		if (!this._blocks || this._repainting) {
			if (switchboardRenderer) switchboardRenderer.rerenderSwitches();
			return;
		}
		this._allSwitches = true;
		this._schedule();
	},

	_schedule() {
		if (this._scheduled) return;
		this._scheduled = true;
		requestAnimationFrame(() => {
			this._scheduled = false;
			this.flush();
		});
	},

	exist() {
		return this._blocks !== null;
	},

	flush() {
		if (!switchboardRenderer || !this.exist()) return;
		try {
			if (!switchboardVisible()) {
				if (typeof PathingController !== 'undefined') PathingController.renderPathList();
				return;
			}
			this._repainting = true;
			if (this._allSegments) {
				switchboardRenderer.rerenderAllSegments();
			} else {
				if (this._blocks.size > 0) switchboardRenderer.rerenderBlocks(this._blocks);
				if (this._allSwitches) switchboardRenderer.rerenderSwitches();
			}
		} finally {
			this._repainting = false;
			this._blocks.clear();
			this._allSegments = false;
			this._allSwitches = false;
			if (typeof PathingController !== 'undefined') PathingController.renderPathList();
		}
	},

	// Compare the paths/blockStates signature for the sidebar path list so we
	// only rebuild its DOM when it actually changed.
	pathsSignatureChanged() {
		if (typeof PathingController === 'undefined') return false;
		const p = PathingController.lockedPaths;
		if (!p) return false;
		let sig = '';
		for (const path of p) {
			sig += (path.id || '') + ':' + (path.startBlock || '') + ':' + (path.destBlock || '') + ':' + (path.note || '') + ':' + (path.lookAhead ?? '') + ':' + (path.color || '') + ';';
			const states = path.blockStates || {};
			for (const b of (path.blocks || [])) sig += b + (states[b] || 'u') + ',';
			sig += '|';
		}
		if (sig !== this._lastPathsSignature) {
			this._lastPathsSignature = sig;
			return true;
		}
		return false;
	},
};

function updateBlockOccupancy(occupancyData) {
	if (typeof TrackData === 'undefined' || !TrackData.blocks) return;
	if (typeof switchboardRenderer === 'undefined' || !switchboardRenderer) return;

	if (typeof SwitchboardSignals !== 'undefined' && SwitchboardSignals.initialized && !SwitchboardOccupancy.isActive) {
		return;
	}

	const changedBlocks = new Set();
	for (const [blockId, occupied] of Object.entries(occupancyData)) {
		const block = TrackData.getBlock(blockId);
		if (block) {
			const newState = occupied === null ? 'unknown' : (occupied ? 'occupied' : 'clear');
			if (block.occupancyState !== newState) {
				block.occupancyState = newState;
				changedBlocks.add(blockId);
			}
		}
	}

	if (changedBlocks.size > 0) {
		// Occupancy feeds the pathfinding edge cost, so drop the memoized A*
		// trees whenever it changes; they are rebuilt lazily on the next hover.
		if (typeof PathingController !== 'undefined' && PathingController) {
			PathingController.invalidatePathTree();
		}
	}

	if (changedBlocks.size > 0 && switchboardRepaint.exist()) {
		switchboardRepaint.markBlocks(changedBlocks);
	} else if (changedBlocks.size > 0) {
		switchboardRenderer.rerenderAllSegments();
	}
}

function computeAllBlockOccupancyFromVirtualSignals() {
	if (typeof SwitchboardOccupancy !== 'undefined' && SwitchboardOccupancy.isActive) return;
	if (typeof SwitchboardSignals === 'undefined' || !SwitchboardSignals.initialized) return;
	const changedBlocks = new Set();
	for (const [blockId, block] of TrackData.blocks) {
		const newState = computeBlockOccupancyFromVirtualSignals(blockId);
		if (block.occupancyState !== newState) {
			block.occupancyState = newState;
			changedBlocks.add(blockId);
		}
	}
	if (changedBlocks.size > 0) {
		if (typeof PathingController !== 'undefined' && PathingController) {
			PathingController.invalidatePathTree();
		}
	}
	if (changedBlocks.size > 0 && switchboardRepaint.exist()) {
		switchboardRepaint.markBlocks(changedBlocks);
	} else if (changedBlocks.size > 0 && typeof switchboardRenderer !== 'undefined' && switchboardRenderer) {
		switchboardRenderer.rerenderBlocks(changedBlocks);
		if (typeof switchboardRenderer.rerenderSwitches === 'function') {
			switchboardRenderer.rerenderSwitches();
		}
	}
}

let _blockSwitchCache = null;
function getBlockSwitchMap() {
	if (_blockSwitchCache) return _blockSwitchCache;
	_blockSwitchCache = new Map();

	const nodeToBlocks = new Map();
	for (const seg of TrackData.segments.values()) {
		if (seg.type === 'switch' || !seg.blockId) continue;
		for (const nodeId of [seg.n1, seg.n2]) {
			if (!nodeToBlocks.has(nodeId)) nodeToBlocks.set(nodeId, new Set());
			nodeToBlocks.get(nodeId).add(seg.blockId);
		}
	}

	const portNodeNames = [
		{ nodeName: 'merging', portName: 'common' },
		{ nodeName: 'nl', portName: 'left' },
		{ nodeName: 'nr', portName: 'right' }
	];

	for (const seg of TrackData.segments.values()) {
		if (seg.type !== 'switch') continue;

		for (const { nodeName, portName } of portNodeNames) {
			const nodeId = seg[nodeName];
			if (!nodeId) continue;

			const blocks = nodeToBlocks.get(nodeId);
			if (!blocks) continue;

			for (const blockId of blocks) {
				if (!_blockSwitchCache.has(blockId)) _blockSwitchCache.set(blockId, []);
				_blockSwitchCache.get(blockId).push({ switchId: seg.id, port: portName });
			}
		}
	}

	return _blockSwitchCache;
}

function invalidateBlockSwitchCache() {
	_blockSwitchCache = null;
}

function computeBlockOccupancyFromVirtualSignals(blockId) {
	const block = TrackData.getBlock(blockId);
	if (!block) return 'unknown';

	const switchMap = getBlockSwitchMap();
	const switchEntries = switchMap.get(blockId);
	if (!switchEntries || switchEntries.length === 0) return block.occupancyState ?? 'unknown';

	let foundClear = false;
	let foundOccupied = false;
	let foundAny = false;

	for (const { switchId, port } of switchEntries) {
		const graphEntry = SwitchboardMapper.switchboardGraph?.get(switchId);
		if (!graphEntry || !graphEntry.signals) continue;

		let aspect = null;
		if (port === 'common') {
			aspect = graphEntry.signals.In?.aspect;
		} else if (port === 'left') {
			aspect = graphEntry.signals.LeftOut?.aspect;
		} else if (port === 'right') {
			aspect = graphEntry.signals.RightOut?.aspect;
		}

		if (aspect === null || aspect === undefined) continue;
		foundAny = true;

		if (SwitchboardSignals.CLEAR_ASPECTS.has(aspect)) foundClear = true;
		if (SwitchboardSignals.STOP_ASPECTS.has(aspect)) foundOccupied = true;
	}

	if (!foundAny) return block.occupancyState ?? 'unknown';
	if (foundClear) return 'clear';
	if (foundOccupied) return 'occupied';
	return block.occupancyState ?? 'unknown';
}

/////////////////////
// following

function followCar(carId, shouldScroll) {
	setMarkerToFollow(carMarkers.get(carId));

	for (const row of carListBody.querySelectorAll('.following'))
		row.classList.remove('following');
	const carListRow = document.getElementById(`carList-${carId}`)
	carListRow.classList.add('following');
	if (shouldScroll)
		carListRow.scrollIntoView({ block: 'center' });

	for (const elem of jobListBody.querySelectorAll('.following'))
		elem.classList.remove('following');
	const jobListElems = jobListBody.querySelectorAll(`.jobList-carCell-${carId}`);
	for (const elem of jobListElems) {
		elem.classList.add('following');
		elem.closest('tbody').classList.add('following');
	}
	if (shouldScroll && jobListElems.length > 0)
		jobListElems[0].scrollIntoView({ block: 'center' });
}

/////////////////////
// player

const playerMarkers = new Map();
let playerScalingEnabled = true;

function getPlayerOverlayBounds(position) {
	const playerScaleFactor = playerScalingEnabled ? scaleMarkerFactor : 1;
	const size = metersToDegrees * 2 * playerScaleFactor;
	return [[position[0] - size, position[1] - size], [position[0] + size, position[1] + size]];
}

function updatePlayerOverlays(data) {
	const existingPlayerIds = Array.from(playerMarkers.keys());
	// Remove markers from disconnected players
	existingPlayerIds
		.filter(id => !data.hasOwnProperty(id))
		.forEach(id => {
			removePlayerOverlay(id);
		});
	// Add markers for new players
	Object.entries(data)
		.filter(([id]) => !existingPlayerIds.includes(id))
		.forEach(([id, playerData]) => {
			createPlayerMarker(id, playerData);
		});
	Object.entries(data).forEach(([id, playerData]) => {
		const polygonElem = document.getElementById(`playerPolygon-${id}`);
		polygonElem.setAttribute('transform', `rotate(${playerData.rotation})`);
		const marker = playerMarkers.get(id);
		marker.position = playerData.position;
		marker.overlay.setBounds(getPlayerOverlayBounds(playerData.position));
		marker.playerLabel.setLatLng(playerData.position);
	});
}

function removePlayerOverlay(id) {
	document.getElementById(`playerPolygon-${id}`)?.remove();
	const marker = playerMarkers.get(id);
	if (marker) {
		// cleanup
		marker.overlay.remove();
		marker.playerLabel.remove();
	}
	playerMarkers.delete(id);
}

function createPlayerOverlay(id, playerData) {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '-15 -15 30 30');
	const polygon = document.createElementNS(svg.namespaceURI, 'polygon');
	polygon.setAttribute('id', `playerPolygon-${id}`);
	polygon.setAttribute('fill', playerData.color);
	polygon.setAttribute('fill-opacity', '70%');
	polygon.setAttribute('stroke', 'black');
	polygon.setAttribute('stroke-width', '1%');
	polygon.setAttribute('points', '0,-10 10,10 0,5 -10,10');
	svg.appendChild(polygon);
	return svg;
}

function createPlayerMarker(id, playerData) {
	const overlay = L.svgOverlay(
		createPlayerOverlay(id, playerData),
		getPlayerOverlayBounds(playerData.position),
		{ interactive: true, bubblingMouseEvents: false }
	)
		.addEventListener('click', e => setMarkerToFollow(e.target))
		.addTo(map);

	// If a tooltip is used, it cannot be bound properly to the overlay as the overlay doesnt have a latlng, so create a separate marker just for the tooltip
	const playerLabel = L.marker(playerData.position, {
		icon: L.divIcon({
			html: `<div style="background: rgba(0,0,0,0.7); color: white; padding: 2px 6px; border-radius: 3px; font-weight: bold; white-space: nowrap; opacity: 0.7;">${id}</div>`,
			iconSize: null, // let size scale with content
			iconAnchor: [0, -20]
		})
	})
		.addEventListener('click', () => setMarkerToFollow(overlay))
		.addTo(map);

	playerMarkers.set(id, { overlay, playerLabel, position: playerData.position });
}

function scrollToTrack(trackId) {
	stopFollowing();
	const polyLine = trackPolyLines.get(trackId);
	if (polyLine)
		map.panTo(polyLine.getCenter());
}

fetch(new URL('/player', location))
	.then(resp => resp.json())
	.then(data => {
		updatePlayerOverlays(data);
		zoomToAllPlayers();
	}
	);

/////////////////////
// loco control

const locoIdSelect = document.getElementById('locoControlLocoId');
function updateLocoList() {
	for (const elem of Array.from(locoIdSelect.children))
		elem.remove();
	const locoIds = Array.from(allCarData.entries())
		.filter(([_, carData]) => carData.canBeControlled)
		.map(([id, _]) => id.slice(2));
	locoIds.sort();
	for (const id of locoIds) {
		const option = document.createElement('option');
		option.textContent = id;
		locoIdSelect.appendChild(option);
	}
}

function isReverserButtonActive(faButton) {
	return faButton.querySelector('svg').getAttribute('data-prefix') == 'fas';
}

function updateReverserButtons(reverser) {
	const reverseButton = document.querySelector('#locoControlReverserReverseButton svg');
	const newReverseStyle = reverser < 0.5 ? 'fas' : 'far';
	if (reverseButton.getAttribute('data-prefix') != newReverseStyle)
		reverseButton.setAttribute('data-prefix', newReverseStyle);

	const forwardButton = document.querySelector('#locoControlReverserForwardButton svg');
	const newForwardStyle = reverser > 0.5 ? 'fas' : 'far';
	if (forwardButton.getAttribute('data-prefix') != newForwardStyle)
		forwardButton.setAttribute('data-prefix', newForwardStyle);
}

const locoBrakePipeDisplay = document.getElementById('locoControlBrakePipe');
const locoSpeedDisplay = document.getElementById('locoControlForwardSpeed');
const locoTrainBrakeInput = document.getElementById('locoControlTrainBrakeInput');
const locoIndependentBrakeInput = document.getElementById('locoControlIndependentBrakeInput');
const locoReverserReverseButton = document.getElementById('locoControlReverserReverseButton');
const locoReverserForwardButton = document.getElementById('locoControlReverserForwardButton');
const locoThrottleInput = document.getElementById('locoControlThrottleInput');
const locoControlCoupleButton = document.getElementById('locoControlCoupleButton');
const locoControlUncoupleButton = document.getElementById('locoControlUncoupleButton');
const locoControlUncoupleSelect = document.getElementById('locoControlUncoupleSelect');

function updateCouplingControls(carData) {
	const canCouple = carData.canCouple;
	const carsInFront = carData.carsInFront;
	const carsInRear = carData.carsInRear;

	locoControlCoupleButton.disabled = !canCouple;
	locoControlUncoupleButton.disabled = carsInFront === 0 && carsInRear === 0;

	if (locoControlUncoupleSelect.childElementCount == carsInFront + carsInRear) {
		return;
	}

	const options = [];
	for (let i = carsInFront; i >= 1; i--)
		options.push(i);
	for (let i = 1; i <= carsInRear; i++)
		options.push(-i);
	locoControlUncoupleSelect.replaceChildren(...options.map(i => {
		const option = document.createElement('option');
		option.setAttribute('value', i);
		option.textContent = i >= 0 ? `\u002b${i}` : `\u2212${-i}`;
		return option;
	}));
}

function getControlledLocoGuid() {
	return allCarData.get(`L-${locoIdSelect.value}`)?.guid;
}

function getControlledLocoData() {
	const guid = getControlledLocoGuid();
	if (guid) {
		return fetch(`/car/${guid}`, location)
			.then(resp => resp.json());
	}
}

let locoTrainBrakeEditing = false;
let locoIndependentBrakeEditing = false;
let locoThrottleEditing = false;

function updateLocoTrainBrakeInput(carData) {
	if (locoTrainBrakeEditing)
		return;
	locoTrainBrakeInput.value = carData.trainBrake * 100;
}

function updateLocoIndependentBrakeInput(carData) {
	if (locoIndependentBrakeEditing)
		return;
	locoIndependentBrakeInput.value = carData.independentBrake * 100;
}

function updateLocoThrottleInput(carData) {
	if (locoThrottleEditing)
		return;
	locoThrottleInput.value = carData.throttle * 100;
}

function updateLocoDisplay() {
	getControlledLocoData()
		.then(carData => {
			locoBrakePipeDisplay.textContent = carData.brakePipe.toFixed(1);
			locoSpeedDisplay.textContent = carData.forwardSpeed.toFixed(0);
			updateLocoTrainBrakeInput(carData);
			updateLocoIndependentBrakeInput(carData);
			updateReverserButtons(carData.reverser);
			updateLocoThrottleInput(carData);
			updateCouplingControls(carData);
		});
}

let locoControlRefreshIntervalId;
locoIdSelect.addEventListener('change', updateLocoDisplay);
sidebar.on("content", e => {
	clearInterval(locoControlRefreshIntervalId);
	if (e.id == "locoControlTab") {
		locoControlRefreshIntervalId = setInterval(updateLocoDisplay, 1000 / 9);
	}
});

sidebar.on("closing", e => {
	clearInterval(locoControlRefreshIntervalId);
	locoControlRefreshIntervalId = undefined;
	if (typeof map !== 'undefined') {
		setTimeout(() => map.invalidateSize(), 50);
	}
})

const switchboardToggleBtn = document.getElementById('switchboardToggle');
switchboardToggleBtn.addEventListener('click', () => {
	const isActive = document.body.classList.toggle('switchboard-active');
	switchboardToggleBtn.textContent = isActive ? 'Show Map' : 'Show Switchboard';
	if (isActive) {
		initSwitchboard();
		if (switchboardRenderer) {
			switchboardRenderer.rerenderAllSegments();
		}
		if (switchboardMap) {
			setTimeout(() => switchboardMap.invalidateSize(), 50);
		}
	} else {
		if (typeof map !== 'undefined') {
			setTimeout(() => map.invalidateSize(), 50);
		}
	}
});

const hardcoreModeToggle = document.getElementById('hardcoreModeToggle');
if (hardcoreModeToggle) {
	hardcoreModeToggle.addEventListener('change', e => {
		if (e.target.checked && typeof PathingController !== 'undefined' && PathingController.enabled) {
			e.target.checked = false;
			alert('Cannot enable hardcore mode while pathing is active. Disable pathing first.');
			return;
		}
		const mode = e.target.checked ? 'hardcore' : 'direct';
		if (typeof SwitchboardOccupancy !== 'undefined') {
			SwitchboardOccupancy.setMode(mode);
		}
	});
}

const signalAspectsToggle = document.getElementById('signalAspectsToggle');
if (signalAspectsToggle) {
	signalAspectsToggle.addEventListener('change', e => {
		if (switchboardRenderer) {
			switchboardRenderer.showSignalAspects = e.target.checked;
			switchboardRenderer.rerenderSwitches();
		}
	});
}

function sendLocoCommand(command) {
	const guid = getControlledLocoGuid();
	if (guid) {
		fetch(new URL(`/car/${guid}/control?${command}`, location), { method: 'POST' });
	}
}

function rangeCommandSender(parameter) {
	return e => sendLocoCommand(`${parameter}=${e.target.value / 100}`);
}

locoTrainBrakeInput.addEventListener('input', rangeCommandSender('trainBrake'));
locoIndependentBrakeInput.addEventListener('input', rangeCommandSender('independentBrake'));
locoReverserReverseButton.addEventListener('click', e =>
	sendLocoCommand(`reverser=${isReverserButtonActive(locoReverserReverseButton) ? 0.5 : 0}`));
locoReverserForwardButton.addEventListener('click', e =>
	sendLocoCommand(`reverser=${isReverserButtonActive(locoReverserForwardButton) ? 0.5 : 1}`));
locoThrottleInput.addEventListener('input', rangeCommandSender('throttle'));
locoControlCoupleButton.addEventListener('click', e =>
	sendLocoCommand('couple=0'));
locoControlUncoupleButton.addEventListener('click', e =>
	sendLocoCommand(`uncouple=${locoControlUncoupleSelect.value}`));

locoTrainBrakeInput.addEventListener("mousedown", () => locoTrainBrakeEditing = true);
locoTrainBrakeInput.addEventListener("mouseup", () => {
	locoTrainBrakeEditing = false;
	updateLocoDisplay();
});
locoIndependentBrakeInput.addEventListener("mousedown", () => locoIndependentBrakeEditing = true);
locoIndependentBrakeInput.addEventListener("mouseup", () => {
	locoIndependentBrakeEditing = false;
	updateLocoDisplay();
});
locoThrottleInput.addEventListener("mousedown", () => locoThrottleEditing = true);
locoThrottleInput.addEventListener("mouseup", () => {
	locoThrottleEditing = false;
	updateLocoDisplay();
});


/////////////////////
// cars

const carWidthMeters = 3;
const carWidthPx = 20;
const svgPixelsPerMeter = carWidthPx / 3;

const allCarData = new Map();
const carMarkers = new Map();
// selected locos for zoom-based scaling
const selectedLocos = new Set();

function getCarColor(carId) {
	const jobId = carJobIds.get(carId);

	switch (getCarColorMode()) {
		case 'jobId':
			return jobId ? colorByHashing(jobId) : 'gray';
		case 'jobType':
			return jobId ? colorForJobType(jobId) : 'gray';
		case 'destination':
			return jobId ? colorForJobDestination(jobId) : 'gray';
		case 'carType':
			return colorByHashing(carId.slice(0, 3));
	}
}

function updateCarColor(carId) {
	const carMarker = carMarkers.get(carId);
	const rect = carMarker.getElement().querySelector('rect');
	if (rect)
		rect.setAttribute('fill', getCarColor(carId));
}

function updateAllCarColors() {
	carMarkers.forEach((_, carId) => updateCarColor(carId));
}

const locoShapeNoseDepth = 10;

function createCarShape(carId, carData) {
	const isLoco = carId.slice(0, 2) == 'L-';
	const lengthPx = carData.length * svgPixelsPerMeter;
	const svg = isLoco
		? `<polygon points="${-lengthPx / 2},-${carWidthPx / 2} ${-lengthPx / 2},${carWidthPx / 2} ${lengthPx / 2 - locoShapeNoseDepth},${carWidthPx / 2} ${lengthPx / 2},0 ${lengthPx / 2 - locoShapeNoseDepth},-${carWidthPx / 2}" fill="goldenrod" fill-opacity="70%" stroke="black" stroke-width="1%"/>`
		: `<rect x="${-lengthPx / 2}" y="-10" width="${lengthPx}" height="20" fill-opacity="70%" stroke="black" stroke-width="1%"/>`;
	return svg;
}

function createCarLabel(carId, carData) {
	const isLoco = carId.slice(0, 2) == 'L-';
	const jobId = carJobIds.get(carId);
	const lengthPx = carData.length * svgPixelsPerMeter;
	const rotation = carData.rotation >= 180 ? 'rotate(180)' : '';
	if (isLoco)
		return `<text transform="translate(-3 0) ${rotation}" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="bold">${carId}</text>`;
	const jobIdLabel =
		!jobId ? ""
			: jobId.split('-').length == 3 ? jobId.slice(-5, -3) + jobId.slice(-2)
				: jobId.split('-').join('');
	const jobIdText = `<text x="${-lengthPx / 2 + 5}" transform="${rotation}" dominant-baseline="central" font-size="16">${jobIdLabel}</text>`
	const carIdText =
		`<text y="-0.5em" y="1" transform="${rotation} translate(${lengthPx / 2 - 5})" dominant-baseline="central" text-anchor="end" font-size="8" font-family="monospace" font-weight="bold">` +
		`<tspan x="0">${carId.slice(0, -3).replaceAll('-', '')}</tspan>` +
		`<tspan x="0" dy="1em">${carId.slice(-3)}</tspan>` +
		'</text>';
	return jobIdText + carIdText;
}

function createCarOverlay(carId, carData) {
	const lengthPx = carData.length * svgPixelsPerMeter;
	const carCanvasMajor = Math.sqrt(lengthPx / 2 * lengthPx / 2 + carWidthPx / 2 * carWidthPx / 2);
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('id', carId);
	svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svg.setAttribute('viewBox', `${-carCanvasMajor} ${-carWidthPx / 2} ${carCanvasMajor * 2} ${carWidthPx}`);
	return svg
}

function updateCarMarker(carId) {
	const marker = carMarkers.get(carId);
	if (!marker)
		return;
	const carData = allCarData.get(carId);
	marker.setBounds(getCarOverlayBounds(carId, carData));
	marker.setRotationAngle(carData.rotation - 90);
	marker.getElement().innerHTML = createCarShape(carId, carData) + createCarLabel(carId, carData);
	updateCarColor(carId);
}

function getCarOverlayBounds(carId, carData) {
	const position = carData.position;
	// If this is a selected loco, apply zoom-based scaling factor to make it more visible
	// We dont need to check if it's a loco here because only locos can (should) be in selectedLocos, so non-locos will always have a factor of 1
	const factor = selectedLocos.has(carId) ? scaleMarkerFactor : 1;
	const length = metersToDegrees * carData.length * factor;
	const width = metersToDegrees * carWidthMeters * factor;
	return [[position[0] - width / 2, position[1] - length / 2], [position[0] + width / 2, position[1] + length / 2]];
}

function createNewCar(carId, carData) {
	allCarData.set(carId, carData);
	createCarRow(carId);
	const overlay = L.svgOverlay(
		createCarOverlay(carId, carData),
		getCarOverlayBounds(carId, carData),
		{ interactive: true, bubblingMouseEvents: false })
		.addEventListener('mouseup', e => followCar(carId, true))
		.addTo(map);
	carMarkers.set(carId, overlay);
	updateCarMarker(carId);
}

function updateCar(carId, carData) {
	allCarData.set(carId, carData);
	updateCarRow(carId);
	updateCarMarker(carId);
}

function removeCar(carId) {
	removeCarRow(carId);
	const marker = carMarkers.get(carId);
	if (marker) {
		marker.remove();
		carMarkers.delete(carId);
	}
	allCarData.delete(carId);
}

function updateAllCars(updateCarData) {
	Object.entries(updateCarData).forEach(([carId, carData]) => {
		if (!carMarkers.has(carId))
			createNewCar(carId, carData);
		else
			updateCar(carId, carData);
	});
	for ([carId, _] of carMarkers)
		if (!updateCarData[carId])
			removeCar(carId);
	updateLocoList();
	updateLocoListSidebar();
	// Remove any selected locos that are no longer present
	for (const id of Array.from(selectedLocos))
		if (!allCarData.has(id))
			selectedLocos.delete(id);
}

function updateCars(cars) {
	Object.entries(cars).forEach(([carId, carData]) =>
		updateCar(carId, carData));
}

/////////////////////
// locos

let scaleMarkerFactor = 1;
map.on('zoomend', function () {
	updatescaleMarkerFactor();
});

function updatescaleMarkerFactor() {
	const zoom = map.getZoom();
	// Note, after _much fiddling_ with different formulas, (including bitwise operators)
	// Simple 2 to the power of "zoom difference" seemed the best
	scaleMarkerFactor = zoom > initialZoom ? 1 : (2 ** (initialZoom - zoom));
	if (loggingEnabled)
		console.info('Map Zoom:', zoom, 'Scale Factor:', scaleMarkerFactor);

	// update bounds only for selected locos to minimize work and avoid changing non-selected markers
	Array.from(selectedLocos).forEach(id => {
		const marker = carMarkers.get(id);
		const carData = allCarData.get(id);
		if (marker && carData)
			marker.setBounds(getCarOverlayBounds(id, carData));
	});

	if (playerScalingEnabled) {
		playerMarkers.forEach(({ overlay, position }) => {
			overlay.setBounds(getPlayerOverlayBounds(position));
		});
	}

	// Refresh signal icons so their size tracks the current zoom level
	signalMarkers.forEach(({ marker, aspect, mode, type, entry }) => {
		marker.setIcon(getSignalIcon(aspect, mode, type, entry));
	});
}

// Update the loco selection sidebar. Shows ordered list of L- IDs with checkboxes.
function updateLocoListSidebar() {
	if (!locoListBody)
		return;
	// clear existing
	locoListBody.replaceChildren();

	const locoIds = Array.from(allCarData.keys())
		.filter(id => id.slice(0, 2) == 'L-')
		.sort((a, b) => a.localeCompare(b));
	// build rows using simple HTML to keep logic concise
	const frag = document.createDocumentFragment();
	for (const locoId of locoIds) {
		const row = document.createElement('tr');
		const idCell = document.createElement('td');
		idCell.textContent = locoId;
		const selectCell = document.createElement('td');
		selectCell.innerHTML = `<input type="checkbox" data-loco-id="${locoId}" ${selectedLocos.has(locoId) ? 'checked' : ''}>`;
		row.appendChild(idCell);
		row.appendChild(selectCell);
		frag.appendChild(row);
	}
	locoListBody.appendChild(frag);

	// use event delegation for checkbox changes (single listener)
	if (!locoListBody._hasDelegatedLocoListener) {
		locoListBody.addEventListener('change', e => {
			const target = e.target;
			if (target && target.matches('input[type=checkbox][data-loco-id]')) {
				const locoId = target.getAttribute('data-loco-id');
				if (target.checked) selectedLocos.add(locoId); else selectedLocos.delete(locoId);
				const marker = carMarkers.get(locoId);
				const carData = allCarData.get(locoId);
				if (loggingEnabled)
					console.info('Loco data', carData);
				if (marker && carData) marker.setBounds(getCarOverlayBounds(locoId, carData));
			}
		});
		locoListBody._hasDelegatedLocoListener = true;
	}
}

/////////////////////
// junction + signal + loco search

function searchAll(query) {
	const q = query.toLowerCase();
	const results = [];

	// Junctions — search by displayName
	for (const [junctionId, name] of junctionDisplayNames) {
		if (name.toLowerCase().includes(q))
			results.push({
				label: `[J] ${name}`,
				go() {
					stopFollowing();
					const center = junctions[junctionId].marker.getBounds().getCenter();
					map.setView(center, initialZoom);
				}
			});
	}

	// Signals — search by signal ID
	for (const [signalId] of signalMarkers) {
		if (signalId.toLowerCase().includes(q))
			results.push({
				label: `[S] ${signalId}`,
				go() {
					stopFollowing();
					map.setView(signalMarkers.get(signalId).marker.getLatLng(), initialZoom);
				}
			});
	}

	// Locos — search by loco ID (L- prefix)
	for (const [carId, carData] of allCarData) {
		if (carId.startsWith('L-') && carId.toLowerCase().includes(q))
			results.push({
				label: `[L] ${carId}`,
				go() {
					followCar(carId, false);
				}
			});
	}

	return results.sort((a, b) => a.label.localeCompare(b.label)).slice(0, 15);
}

const input = document.getElementById('searchInput');
const resultsList = document.getElementById('searchResults');

function buildSuggestions(query) {
	resultsList.innerHTML = '';
	if (!query) return;

	for (const result of searchAll(query)) {
		const li = document.createElement('li');
		li.textContent = result.label;
		li.addEventListener('mousedown', e => {
			e.preventDefault();
			input.value = result.label;
			resultsList.innerHTML = '';
			result.go();
		});
		resultsList.appendChild(li);
	}
}

input.addEventListener('input', () => buildSuggestions(input.value));

input.addEventListener('keydown', e => {
	if (e.key === 'Enter') {
		const first = searchAll(input.value)[0];
		if (first) { first.go(); resultsList.innerHTML = ''; input.blur(); }
	}
	if (e.key === 'Escape') {
		resultsList.innerHTML = '';
		input.blur();
	}
});

input.addEventListener('blur', () => {
	setTimeout(() => { resultsList.innerHTML = ''; }, 150);
});

/////////////////////
// events

function uuidv4() {
	return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
		(c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
	);
}
const sessionId = uuidv4();
const updateInterval = 100;
let updateStart;

function updateOnce() {
	updateStart = performance.now();
	return fetch(new URL(`/updates/${sessionId}`, location))
		.then(resp => {
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			return resp.json();
		})
		.then(updateData => {
			Object.entries(updateData).forEach(([tag, data]) => {
				try {
					const _t0 = performance.now();
					switch (tag) {
						case 'cars':
							updateAllCars(data);
							break;
						case 'jobs':
							updateAllJobs(data);
							break;
						case 'junctions':
							updateAllJunctions(data);
							break;
						case 'player':
							updatePlayerOverlays(data);
							break;
					case 'signals':
						updateAllSignals(data);
						break;
					case 'signalpack':
						refreshPackTable(data);
						break;
			case 'occupancy':
				updateBlockOccupancy(data);
				break;
			case 'paths':
				if (typeof PathingController !== 'undefined') {
					PathingController.syncFromServer(data);
				}
				break;
			case 'modconfig':
				if (data && typeof data.enablePathing === 'boolean') {
					enablePathing = data.enablePathing;
					if (data.enablePathing) {
						if (typeof PathingController !== 'undefined') PathingController.enable();
					} else {
						if (typeof PathingController !== 'undefined') PathingController.disable();
					}
				}
				break;
					default:
							const segments = tag.split('-');
							switch (segments[0]) {
								case 'trainset': updateCars(data); break;
								case 'carguid': updateCar(data.id, data); break;
							}
					}
					const _elapsed = performance.now() - _t0;
					if (_elapsed > 100) {
						console.warn(`[PERF] ${tag} handler took ${_elapsed.toFixed(0)}ms`);
					}
				} catch (err) {
					console.error(`Update tag '${tag}' failed:`, err);
				}
			});
		})
		.then(_ => {
			if (markerToFollow)
				map.panTo(markerToFollow.getBounds().getCenter());
		});
}

function updateLoop() {
	// Promise.resolve() turns any synchronous throw inside updateOnce into a rejected
	// promise, so a single bad update can never permanently stop the loop.
	Promise.resolve()
		.then(() => updateOnce())
		.catch(err => {
			console.error('Update failed:', err);
		})
		.finally(() => {
			const timeToNextUpdate = (updateStart + updateInterval) - performance.now();
			setTimeout(updateLoop, Math.max(0, timeToNextUpdate));
		});
}

// The update loop must never depend on signals initialization completing — a stalled
// signals fetch must not freeze car/player/junction updates. Start it immediately.
updateLoop();

// Refresh the sprite manifest on its own schedule so live sprites appear once the
// backend has captured them, independent of the update loop (and its errors).
refreshSpriteManifestIfStale();
setInterval(refreshSpriteManifestIfStale, spriteManifestFetchInterval);

/////////////////////
// signal visibility

const validYards = new Set([
	'IMW', 'MF', 'CP', 'CW', 'SW', 'FRS', 'OWC', 'FM', 'SM', 'FRC',
	'OR', 'FF', 'IME', 'MB', 'OWN', 'GF', 'CME', 'HB', 'CS', 'CMS'
]);

const signalVisibility = {
	show: true,
	all: true,
	distant: true,
	yards: {}
};

function applySignalVisibility() {
	signalMarkers.forEach(({ marker, type, yard }, signalId) => {
		const yardVisible = yard ? (signalVisibility.yards[yard] ?? true) : true;
		const distantVisible = type === 'Distant' ? signalVisibility.distant : true;
		const visible = signalVisibility.show
			&& signalVisibility.all
			&& yardVisible
			&& distantVisible;

		if (visible) {
			if (!map.hasLayer(marker)) marker.addTo(map);
		} else {
			if (map.hasLayer(marker)) marker.remove();
		}
	});
}

// Signature identifying a signal's lamp layout (ordered lamp names + colours + shapes +
// grid positions). Signals of the same RD type can have different layouts (e.g. 3-lamp vs
// 4-lamp variants, or the same lamps arranged differently), so this is what
// distinguishes preview rows within a type.
function layoutKey(entry) {
	const lamps = (entry && entry.Lamps) ? entry.Lamps : [];
	if (!lamps.length) return null;
	return lamps.map((lamp, i) => {
		const grid = lampGridPos(lamp, i);
		return `${lamp.Name}|${normalizeLampColour(lamp.Colour)}|${lampShape(lamp)}|${grid[0]},${grid[1]}`;
	}).join(';');
}

// layoutKey of the face whose layout editor is open (null = closed).
let layoutEditorKey = null;

// The open editor's group entry (lamps + aspects) as of when it was opened;
// the "Cancel edit" button restores this snapshot locally.
let layoutEditorSnapshot = null;

function snapshotLayout(layout) {
	return {
		signalIds: layout.signalIds.slice(),
		entry: JSON.parse(JSON.stringify(layout.entry)), // deep copy of Lamps + Aspects
	};
}

// The "Cancel edit" button (next to the "Signal types" header) only shows while
// the layout editor is open.
function setLayoutCancelVisible() {
	const btn = document.getElementById('sig-layout-cancel');
	if (btn) btn.hidden = layoutEditorKey === null;
}

// The aspect × lamp table lives in a floating window centred in the space between
// the sidebar and the right screen edge, so it never touches the sidebar.
function positionFloatingMatrix(el) {
	const side = document.getElementById('sidebar');
	const sideRight = side ? side.getBoundingClientRect().right : 0;
	const areaW = Math.max(200, window.innerWidth - sideRight);

	el.style.maxWidth = (areaW - 32) + 'px';
	el.style.maxHeight = (window.innerHeight - 32) + 'px';

	const w = Math.min(el.scrollWidth, areaW - 32);
	const left = sideRight + Math.max(16, (areaW - w) / 2);
	const top = Math.max(16, (window.innerHeight - el.offsetHeight) / 2);
	el.style.left = Math.round(left) + 'px';
	el.style.top = Math.round(top) + 'px';
}

// Groups live signals by RD type. Each type holds its distinct lamp layouts side by side;
// signals of the same type can differ (e.g. 3-lamp vs 4-lamp variants). Aspects are the
// union across every layout of the type. Signals with no pack data yet fold into a single
// placeholder layout that is only shown when the type has no data at all.
function collectSignalTypes() {
	const byType = new Map();

	signalMarkers.forEach(({ type, entry, signalAspects }, signalId) => {
		if (!type) return;
		if (!byType.has(type)) byType.set(type, { layouts: new Map(), aspects: new Set() });
		const group = byType.get(type);

		const key = layoutKey(entry);
		if (!group.layouts.has(key)) {
			group.layouts.set(key, {
				lamps: key ? entry.Lamps : null,
				switchboardAspects: key ? entry.SwitchboardAspects : null,
				packAspects: {},
				apiAspects: new Set(),
				signals: 0,
				signalIds: [],
			});
		}
		const layout = group.layouts.get(key);
		layout.signals += 1;
		layout.signalIds.push(signalId);

		if (key && entry.Aspects) {
			Object.entries(entry.Aspects).forEach(([aspectId, def]) => {
				if (aspectId && !layout.packAspects[aspectId]) layout.packAspects[aspectId] = def;
			});
		}

		const list = (signalAspects && signalAspects.length)
			? signalAspects
			: (entry && entry.Aspects ? Object.keys(entry.Aspects) : []);
		list.forEach(aspectId => {
			if (aspectId) {
				layout.apiAspects.add(aspectId);
				group.aspects.add(aspectId);
			}
		});
	});

	const result = [];
	[...byType.keys()].sort().forEach(type => {
		const { layouts, aspects } = byType.get(type);
		const keys = [...layouts.keys()].sort((a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0));
		const hasData = keys.some(key => key !== null);

		const layoutList = [];
		keys.forEach(key => {
			if (key === null && hasData) return;
			const layout = layouts.get(key);
			layoutList.push({
				hasFace: !!key,
				entry: { Lamps: layout.lamps || [], Aspects: layout.packAspects, SwitchboardAspects: layout.switchboardAspects },
				aspects: [...layout.apiAspects]
					.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })),
				signals: layout.signals,
				signalIds: layout.signalIds.slice(),
			});
		});

		result.push({
			type,
			layouts: layoutList,
			aspects: [...aspects]
				.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })),
		});
	});
	return result;
}

// Pixel dimensions for a sidebar preview face, matching the map-icon render scale.
function previewFaceSize(type, lamps) {
	const factor = signalTypeScale[String(type).toLowerCase()] || signalTypeScale.normal;
	const { w, h } = signalFaceDimensions(lamps);
	return [
		Math.round(w * signalRenderScale * factor),
		Math.round(h * signalRenderScale * factor),
	];
}

// Preview face size for the sidebar "Signal types" list (pictures mode).
const previewSpriteSize = 48;

// Renders one sidebar preview face, honouring the current signal style.
// In pictures mode an aspect's in-game sprite is shown (the off sprite for "none");
// in lamps mode the lamp SVG is used ("none" lights every lamp to show colours).
function renderPreviewFaceHtml(type, layout, aspect, isNone) {
	if (signalStyle === 'pictures') {
		const url = spriteUrlFor(isNone ? 'OFF' : (aspect || 'OFF'), type);
		return url
			? `<img class="sig-sprite" src="${escapeXml(url)}" alt="" style="width:100%;height:100%;object-fit:contain">`
			: '<div class="sig-type-face-empty">No sprite yet.</div>';
	}
	return createSignalFaceSvg(layout.entry, aspect, isNone);
}

function renderSignalTypePreviews() {
	setLayoutCancelVisible();
	const container = document.getElementById('sig-type-list');
	if (!container) return;

	const groups = collectSignalTypes();
	if (groups.length === 0) {
		container.innerHTML = '<div style="font-size:0.85em;color:#888;font-style:italic;">No signal types yet.</div>';
		return;
	}

	container.innerHTML = groups.map((group, groupIndex) => {
		const hasData = group.layouts.some(l => l.hasFace);
		const options = hasData
			? ['none', ...group.aspects].map(id => {
				const label = id === 'none' ? 'none (all lamps lit)' : id;
				return `<option value="${escapeXml(id)}"${id === 'none' ? ' selected' : ''}>${escapeXml(label)}</option>`;
			}).join('')
			: '';

		const faces = group.layouts.map(layout => {
			const key = layout.hasFace ? layoutKey(layout.entry) : null;

			// The face being edited renders the interactive layout editor instead.
			if (key && key === layoutEditorKey) {
				return `
					<div class="sig-type-item">
						${renderSignalLayoutEditor(layout)}
					</div>`;
			}

			const [w, h] = layout.hasFace
				? (signalStyle === 'pictures'
					? [previewSpriteSize, previewSpriteSize]
					: previewFaceSize(group.type, layout.entry.Lamps))
				: [0, 0];
			const face = layout.hasFace
				? renderPreviewFaceHtml(group.type, layout, null, true) // default "none" preview
				: '<div class="sig-type-face-empty">No pack data yet.</div>';
			const faceStyle = layout.hasFace ? `width:${w}px;height:${h}px` : '';
			const sub = layout.hasFace ? String(layout.signals) : '';
			const faceClass = key ? 'sig-type-face sig-type-face-clickable' : 'sig-type-face';
			const faceTitle = key ? ' title="Click to edit this layout"' : '';

			return `
				<div class="sig-type-item">
					<div class="${faceClass}" data-layout="${key ? escapeXml(key) : ''}"${faceTitle} style="${faceStyle}">${face}</div>
					${sub ? `<div class="sig-type-sub" title="${layout.signals} signal${layout.signals === 1 ? '' : 's'} sharing this layout">${escapeXml(sub)}</div>` : ''}
				</div>`;
		}).join('');

		return `
			<div class="sig-type-group" data-group="${groupIndex}">
				<div class="sig-type-header">
					<span class="sig-type-name">${escapeXml(group.type)}</span>
					${hasData ? `<select class="sig-type-select">${options}</select>` : ''}
				</div>
				<div class="sig-type-faces">${faces}</div>
			</div>`;
	}).join('');

	// Layouts are looked up within their type group (by layout key) so that two types
	// sharing an identical layout don't get mixed up.
	const layoutInGroup = (groupEl, key) => {
		const group = groups[Number(groupEl.dataset.group)];
		if (!group || !key) return null;
		return group.layouts.find(l => l.hasFace && layoutKey(l.entry) === key) || null;
	};

	container.querySelectorAll('.sig-type-select').forEach(select => {
		select.addEventListener('change', () => {
			const groupEl = select.closest('.sig-type-group');
			if (!groupEl) return;
			const isNone = select.value === 'none';
			const aspect = isNone ? null : select.value;

			groupEl.querySelectorAll('.sig-type-face').forEach(faceEl => {
				const key = faceEl.dataset.layout;
				const layout = layoutInGroup(groupEl, key);
				if (!layout || key === layoutEditorKey) return; // editor face renders its own
				faceEl.innerHTML = renderPreviewFaceHtml(group.type, layout, aspect, isNone);
			});
		});
	});

	container.querySelectorAll('.sig-type-face-clickable').forEach(faceEl => {
		faceEl.addEventListener('click', () => {
			const groupEl = faceEl.closest('.sig-type-group');
			const layout = groupEl ? layoutInGroup(groupEl, faceEl.dataset.layout) : null;
			layoutEditorKey = faceEl.dataset.layout;
			layoutEditorSnapshot = layout ? snapshotLayout(layout) : null;
			renderSignalTypePreviews();
		});
	});

	container.querySelectorAll('.sig-layout-editor').forEach(editorEl => {
		const groupEl = editorEl.closest('.sig-type-group');
		const layout = groupEl ? layoutInGroup(groupEl, editorEl.dataset.layout) : null;
		if (!layout) return;
		const gridEl = editorEl.querySelector('.sig-layout-grid');
		gridEl.querySelectorAll('.sig-layout-lamp').forEach(lampEl => {
			wireLampDrag(layout, gridEl, lampEl);
		});
		editorEl.querySelectorAll('.sig-layout-palette-item').forEach(itemEl => {
			wirePaletteDrag(layout, itemEl, gridEl, itemEl.dataset.shape);
		});
		editorEl.querySelector('.sig-layout-save').addEventListener('click', e => {
			e.stopPropagation();
			// Save & exit = persist any unsaved changes, then close.
			const dirty = !layoutEditorSnapshot || !entriesEqual(layoutEditorSnapshot.entry, layout.entry);
			closeLayoutEditor();
			if (dirty && !layoutSaveInFlight) persistSignalEntry(layout.signalIds, layout.entry);
		});
		editorEl.querySelector('.sig-layout-reset').addEventListener('click', e => {
			e.stopPropagation();
			resetSignalLayout(layout);
		});
		const matrixEl = editorEl.querySelector('.sig-layout-matrix');
		if (matrixEl) {
			matrixEl.querySelectorAll('.sig-aspect-cell').forEach(cellEl => {
				cellEl.addEventListener('click', ev => {
					ev.stopPropagation();
					const lamp = layout.entry.Lamps[Number(cellEl.dataset.lamp)];
					if (!lamp) return;
					const aspectDef = (layout.entry.Aspects && cellEl.dataset.aspect != null)
						? layout.entry.Aspects[cellEl.dataset.aspect] : null;
					const cycle = { off: 'on', on: 'blink', blink: 'off' };
					setAspectLampState(layout, cellEl.dataset.aspect, lamp, cycle[lampAspectState(lamp, aspectDef)]);
				});
			});
		matrixEl.querySelectorAll('.sig-lamp-colour').forEach(selectEl => {
			const idx = Number(selectEl.dataset.lamp);
			selectEl.addEventListener('change', e => setLampColour(layout, idx, e.target.value));
		});
		matrixEl.querySelectorAll('.sig-switchboard-cell').forEach(cellEl => {
			cellEl.addEventListener('click', ev => {
				ev.stopPropagation();
				setSwitchboardAspectColour(layout, cellEl.dataset.aspect);
			});
		});
			matrixEl.querySelectorAll('.sig-lamp-remove').forEach(btn => {
				btn.addEventListener('click', e => {
					e.stopPropagation();
					removeLampFromGroup(layout, Number(btn.dataset.lamp));
				});
			});
		}
	});

	// The aspect × lamp table floats in its own window (centered over the map,
	// clear of the sidebar). All but the first are hidden (two editors only
	// co-occur when two types share an identical layout).
	container.querySelectorAll('.sig-layout-matrix-wrap').forEach((el, i) => {
		if (i > 0) {
			el.style.display = 'none';
			return;
		}
		positionFloatingMatrix(el);
	});
}

// Interactive layout editor for a signal face: a min-rect grid of cells (one per integer
// position) with the lamps drawn on top for dragging. Only one is open at a time
// (layoutEditorKey).
function renderSignalLayoutEditor(layout) {
	const lamps = layout.entry.Lamps;
	const key = layoutKey(layout.entry);

	let cols = 0, rows = 0;
	lamps.forEach((lamp, i) => {
		const [x, y] = lampGridPos(lamp, i);
		if (x + lampSpan(lamp) > cols) cols = x + lampSpan(lamp);
		if (y + 1 > rows) rows = y + 1;
	});
	if (!cols) cols = 1;
	if (!rows) rows = 1;

	const cell = signalLayoutEditorCell;
	const gap = signalLayoutEditorGap;
	const pitch = cell + gap;
	const barW = 2 * cell + gap; // a bar lamp spans two cells (incl. the gap between them)
	const barH = 10;
	const dotSize = 14;
	const gridWidth = cols * pitch - gap;
	const gridHeight = rows * pitch - gap;

	let cellsHtml = '';
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < cols; x++) {
			cellsHtml += `<div class="sig-layout-cell" data-cell="${x}-${y}" style="left:${x * pitch}px;top:${y * pitch}px;width:${cell}px;height:${cell}px;"></div>`;
		}
	}

	const lampsHtml = lamps.map((lamp, i) => {
		const [x, y] = lampGridPos(lamp, i);
		const isBar = lampShape(lamp) === 'bar';
		const w = isBar ? barW : dotSize;
		const h = isBar ? barH : dotSize;
		const left = x * pitch + (isBar ? 1 : (cell - dotSize) / 2);
		const top = y * pitch + (cell - h) / 2;
		return `<div class="sig-layout-lamp${isBar ? ' sig-layout-lamp-bar' : ''}" data-index="${i}" title="${escapeXml(lamp.Name)}" `
			+ `style="left:${left}px;top:${top}px;width:${w}px;height:${h}px;background:${escapeXml(normalizeLampColour(lamp.Colour))};"></div>`;
	}).join('');

	const paletteHtml = `
		<div class="sig-layout-palette">
			<span class="sig-layout-palette-label">add lamp:</span>
			<div class="sig-layout-palette-item" data-shape="circle" title="Pull a round lamp onto the grid">
				<span class="sig-layout-palette-preview sig-layout-palette-preview-circle"></span>
			</div>
			<div class="sig-layout-palette-item" data-shape="bar" title="Pull a bar lamp (two cells wide) onto the grid">
				<span class="sig-layout-palette-preview sig-layout-palette-preview-bar"></span>
			</div>
		</div>`;

	const matrixHtml = renderSignalAspectTable(layout, cell, gap, pitch, barW, barH, dotSize);

	return `
		<div class="sig-layout-editor" data-layout="${escapeXml(key)}">
			<div class="sig-layout-toolbar">
				<span class="sig-layout-title">drag lamps to arrange · ${layout.signals} signal${layout.signals === 1 ? '' : 's'}</span>
				<span class="sig-layout-buttons">
					<button type="button" class="sig-layout-reset">Reset</button>
					<button type="button" class="sig-layout-save">Save &amp; exit</button>
				</span>
			</div>
			${paletteHtml}
			<div class="sig-layout-scroll">
				<div class="sig-layout-grid" data-cols="${cols}" data-rows="${rows}" style="width:${gridWidth}px;height:${gridHeight}px;">
					${cellsHtml}
					${lampsHtml}
				</div>
			</div>
			<div class="sig-layout-matrix-hint">aspect × lamps table → floating window</div>
			${matrixHtml}
			<div class="sig-layout-status"></div>
		</div>`;
}

// The aspect × lamp table: aspects across the top, lamps down the side. Each row has a
// colour swatch and a remove button; each cell is the lamp's state in that aspect
// (off / on / blinking, cycled by clicking). A trailing "switchboard" row picks the dot
// colour for each aspect (none / green / yellow / red / white / blue, cycled by clicking),
// which replaces the aspect-derived dot colouring for that state.
function renderSignalAspectTable(layout, cell, gap, pitch, barW, barH, dotSize) {
	const lamps = layout.entry.Lamps;
	if (!lamps.length) return '';
	const aspects = (layout.aspects || []).filter(id => id && id !== 'OFF');
	if (!aspects.length) return '';

	const headHtml = aspects.map(id =>
		`<th title="${escapeXml(id)}">${escapeXml(id)}</th>`
	).join('');

	// Every colour that exists in the pack, offered by the per-lamp dropdown.
	const packColours = collectPackColours();

	const rowsHtml = lamps.map((lamp, i) => {
		const isBar = lampShape(lamp) === 'bar';
		const swatch = normalizeLampColour(lamp.Colour);
		const colours = packColours.indexOf(swatch) !== -1 ? packColours : [swatch, ...packColours];
		const colourOptions = colours.map(c =>
			`<option value="${escapeXml(c)}"${c === swatch ? ' selected' : ''}>${escapeXml(c)}</option>`
		).join('');
		const cellsHtml = aspects.map(id => {
			const aspectDef = layout.entry.Aspects ? layout.entry.Aspects[id] : null;
			const state = lampAspectState(lamp, aspectDef);
			const bg = state === 'off' ? '' : `style="background:${escapeXml(swatch)};"`;
			return `<td><button type="button" class="sig-aspect-cell sig-aspect-${state}" data-aspect="${escapeXml(id)}" data-lamp="${i}" ${bg} title="${escapeXml(lamp.Name)} in ${escapeXml(id)}: ${state}; click to change"></button></td>`;
		}).join('');

		const shapeMark = isBar
			? `<span class="sig-lamp-shape" title="bar (2 cells wide)">▬</span>`
			: '';
		const newRow = lamp.Name === lastAddedLampName ? ' sig-lamp-row-new' : '';
		return `
			<tr class="sig-lamp-row${newRow}">
				<td class="sig-lamp-col">
					<span class="sig-lamp-swatch" style="background:${escapeXml(swatch)};" title="current colour ${escapeXml(swatch)}"></span>
					<select class="sig-lamp-colour" data-lamp="${i}" title="set colour of ${escapeXml(lamp.Name)}">${colourOptions}</select>
					<span class="sig-lamp-name" title="${escapeXml(lamp.Name)}">${escapeXml(lamp.Name)}</span>
					${shapeMark}
					<button type="button" class="sig-lamp-remove" data-lamp="${i}" title="remove ${escapeXml(lamp.Name)}">×</button>
				</td>
				${cellsHtml}
			</tr>`;
	}).join('');

	const switchboardCellsHtml = aspects.map(id => {
		const colour = switchboardAspectColour(layout.entry, id);
		const bg = colour ? `style="background:${switchboardDotHex(colour)};"` : '';
		return `<td><button type="button" class="sig-aspect-cell sig-switchboard-cell${colour ? ' sig-switchboard-set' : ''}" data-aspect="${escapeXml(id)}" ${bg} title="switchboard dot colour for ${escapeXml(id)}: ${colour || 'none'}; click to change"></button></td>`;
	}).join('');

	return `
		<div class="sig-layout-matrix-wrap">
			<div class="sig-layout-matrix-title">aspects × lamps (click a cell: off → on → blink) · switchboard row (click: dot colour per aspect)</div>
			<table class="sig-layout-matrix">
				<thead><tr><th class="sig-lamp-col">lamp</th>${headHtml}</tr></thead>
				<tbody>
					${rowsHtml}
					<tr class="sig-switchboard-row" title="switchboard dot colour per aspect (replaces aspect-derived colouring)">
						<td class="sig-lamp-col">switchboard</td>
						${switchboardCellsHtml}
					</tr>
				</tbody>
			</table>
		</div>`;
}

// Drag behaviour for a lamp in the editor: it follows the pointer, stays clamped inside
// the grid (growing it by one cell when the pointer passes the right/bottom edge, so a
// lamp can never be pushed off-screen), and snaps to the nearest cell on release.
// Drops onto a cell already occupied by another lamp are rejected.
// All positions are computed in the grid's viewport space (clientX/Y + getBoundingClientRect)
// so no mix of layout and viewport coordinates can offset the snap.
function wireLampDrag(layout, gridEl, lampEl) {
	const lampIndex = Number(lampEl.dataset.index);
	const span = lampSpan(layout.entry.Lamps[lampIndex]) || 1; // bars occupy two cells
	const cell = signalLayoutEditorCell;
	const gap = signalLayoutEditorGap;
	const pitch = cell + gap;

	let curCols = Number(gridEl.dataset.cols) || 1;
	let curRows = Number(gridEl.dataset.rows) || 1;
	// Cells built so far (growth only appends the ones that are missing).
	const builtCells = new Set();
	gridEl.querySelectorAll('.sig-layout-cell').forEach(c => {
		if (c.dataset.cell) builtCells.add(c.dataset.cell);
	});

	const growTo = (newCols, newRows) => {
		curCols = newCols;
		curRows = newRows;
		gridEl.dataset.cols = newCols;
		gridEl.dataset.rows = newRows;
		gridEl.style.width = (newCols * pitch - gap) + 'px';
		gridEl.style.height = (newRows * pitch - gap) + 'px';
		for (let y = 0; y < newRows; y++) {
			for (let x = 0; x < newCols; x++) {
				const tag = x + '-' + y;
				if (builtCells.has(tag)) continue;
				builtCells.add(tag);
				const cEl = document.createElement('div');
				cEl.className = 'sig-layout-cell';
				cEl.dataset.cell = tag;
				cEl.style.left = x * pitch + 'px';
				cEl.style.top = y * pitch + 'px';
				cEl.style.width = cell + 'px';
				cEl.style.height = cell + 'px';
				gridEl.insertBefore(cEl, lampEl); // keep the dragged lamp on top
			}
		}
	};

	const showOccupiedHint = () => {
		const statusEl = document.querySelector('#sig-type-list .sig-layout-status');
		if (statusEl) statusEl.textContent = 'cell already occupied';
	};

	const clampInt = (v, min, max) => (max < min ? min : Math.max(min, Math.min(v, max)));

	let dragging = false;
	let grabDx, grabDy;

	lampEl.addEventListener('pointerdown', e => {
		e.preventDefault();
		e.stopPropagation();
		const rect = gridEl.getBoundingClientRect();
		dragging = true;
		// Pointer offset from the lamp's centre stays fixed for the whole drag.
		grabDx = (e.clientX - rect.left) - (lampEl.offsetLeft + lampEl.offsetWidth / 2);
		grabDy = (e.clientY - rect.top) - (lampEl.offsetTop + lampEl.offsetHeight / 2);
		lampEl.setPointerCapture(e.pointerId);
		lampEl.classList.add('dragging');
	});

	lampEl.addEventListener('pointermove', e => {
		if (!dragging) return;
		e.preventDefault();
		const rect = gridEl.getBoundingClientRect();
		const pointerX = (e.clientX - rect.left) - grabDx; // lamp centre, in grid px
		const pointerY = (e.clientY - rect.top) - grabDy;

		// Extend the grid by one cell when the lamp no longer fully fits (its edge
		// passed the grid edge; up to signalLayoutMaxGrid + 1 cells per axis).
		if (pointerX + lampEl.offsetWidth / 2 >= curCols * pitch - gap && curCols <= signalLayoutMaxGrid)
			growTo(curCols + 1, curRows);
		if (pointerY + lampEl.offsetHeight / 2 >= curRows * pitch - gap && curRows <= signalLayoutMaxGrid)
			growTo(curCols, curRows + 1);

		// Keep the lamp fully inside the grid so it is never hidden behind the map.
		lampEl.style.left = clampInt(pointerX - lampEl.offsetWidth / 2, 0, Math.max(0, curCols * pitch - gap - lampEl.offsetWidth)) + 'px';
		lampEl.style.top = clampInt(pointerY - lampEl.offsetHeight / 2, 0, Math.max(0, curRows * pitch - gap - lampEl.offsetHeight)) + 'px';
	});

	const finish = e => {
		if (!dragging) return;
		dragging = false;
		lampEl.classList.remove('dragging');
		const rect = gridEl.getBoundingClientRect();
		// The lamp's final (clamped) position, snapped to the nearest cell.
		const left = clampInt((e.clientX - rect.left) - grabDx - lampEl.offsetWidth / 2,
			0, Math.max(0, curCols * pitch - gap - lampEl.offsetWidth));
		const top = clampInt((e.clientY - rect.top) - grabDy - lampEl.offsetHeight / 2,
			0, Math.max(0, curRows * pitch - gap - lampEl.offsetHeight));
		const gx = clampInt(Math.round(left / pitch), 0, Math.max(0, curCols - span));
		const gy = clampInt(Math.round(top / pitch), 0, curRows - 1);

		const lamps = layout.entry.Lamps;
		const [curX, curY] = lampGridPos(lamps[lampIndex], lampIndex);
		if (gx === curX && gy === curY) {
			// No-op drop: re-render to realign the lamp without bothering the server.
			renderSignalTypePreviews();
			return;
		}
		// Cells the lamp would occupy after the move (a bar takes two).
		const occupied = new Set();
		for (let i = 0; i < lamps.length; i++) {
			if (i === lampIndex) continue;
			const [ox, oy] = lampGridPos(lamps[i], i);
			for (let c = ox; c < ox + lampSpan(lamps[i]); c++) occupied.add(c + ',' + oy);
		}
		for (let c = gx; c < gx + span; c++) {
			if (occupied.has(c + ',' + gy)) {
				// Occupied cell: bounce the lamp back to its saved position.
				renderSignalTypePreviews();
				showOccupiedHint();
				return;
			}
		}
		commitLampMove(layout, lampIndex, gx, gy);
	};

	lampEl.addEventListener('pointerup', finish);
	lampEl.addEventListener('lostpointercapture', () => {
		dragging = false;
		lampEl.classList.remove('dragging');
	});
	lampEl.addEventListener('pointercancel', () => {
		// Abort the drag and re-render to realign the lamp with the saved position.
		if (!dragging) return;
		dragging = false;
		lampEl.classList.remove('dragging');
		renderSignalTypePreviews();
	});
}

// Drag a new lamp from the palette strip into the grid. A ghost follows the pointer;
// on release inside the grid the lamp is added at the snapped cell (grid grows on
// request, occupied cells are rejected). The colour is chosen via the new lamp's
// matrix swatch right after the add.
function wirePaletteDrag(layout, itemEl, gridEl, shape) {
	const cell = signalLayoutEditorCell;
	const gap = signalLayoutEditorGap;
	const pitch = cell + gap;
	const span = (shape === 'bar') ? 2 : 1;
	const lampW = span === 2 ? 2 * cell + gap : 14;
	const lampH = span === 2 ? 10 : 14;

	let curCols = Number(gridEl.dataset.cols) || 1;
	let curRows = Number(gridEl.dataset.rows) || 1;
	const builtCells = new Set();
	gridEl.querySelectorAll('.sig-layout-cell').forEach(c => {
		if (c.dataset.cell) builtCells.add(c.dataset.cell);
	});

	const growTo = (newCols, newRows) => {
		curCols = newCols;
		curRows = newRows;
		gridEl.dataset.cols = newCols;
		gridEl.dataset.rows = newRows;
		gridEl.style.width = (newCols * pitch - gap) + 'px';
		gridEl.style.height = (newRows * pitch - gap) + 'px';
		for (let y = 0; y < newRows; y++) {
			for (let x = 0; x < newCols; x++) {
				const tag = x + '-' + y;
				if (builtCells.has(tag)) continue;
				builtCells.add(tag);
				const cEl = document.createElement('div');
				cEl.className = 'sig-layout-cell';
				cEl.dataset.cell = tag;
				cEl.style.left = x * pitch + 'px';
				cEl.style.top = y * pitch + 'px';
				cEl.style.width = cell + 'px';
				cEl.style.height = cell + 'px';
				gridEl.appendChild(cEl);
			}
		}
	};

	const clampInt = (v, min, max) => (max < min ? min : Math.max(min, Math.min(v, max)));

	let ghost = null;

	itemEl.addEventListener('pointerdown', e => {
		e.preventDefault();
		e.stopPropagation();
		itemEl.setPointerCapture(e.pointerId);
		itemEl.classList.add('dragging');
		ghost = document.createElement('div');
		ghost.className = 'sig-layout-ghost ' + (span === 2 ? 'sig-ghost-bar' : 'sig-ghost-circle');
		ghost.style.width = lampW + 'px';
		ghost.style.height = lampH + 'px';
		document.body.appendChild(ghost);
		moveGhost(e);
	});

	const moveGhost = e => {
		if (!ghost) return;
		const rect = gridEl.getBoundingClientRect();
		const uLeft = (e.clientX - rect.left) - lampW / 2;
		const uTop = (e.clientY - rect.top) - lampH / 2;
		// Extend the grid while the ghost is pushed past the current bounds.
		if (uLeft > curCols * pitch - gap && curCols <= signalLayoutMaxGrid)
			growTo(curCols + 1, curRows);
		if (uTop > curRows * pitch - gap && curRows <= signalLayoutMaxGrid)
			growTo(curCols, curRows + 1);
		const rawLeft = clampInt(uLeft, 0, Math.max(0, curCols * pitch - gap - lampW));
		const rawTop = clampInt(uTop, 0, Math.max(0, curRows * pitch - gap - lampH));
		ghost.style.left = (rect.left + rawLeft) + 'px';
		ghost.style.top = (rect.top + rawTop) + 'px';
	};

	const endDrag = e => {
		if (!ghost) return;
		const rect = gridEl.getBoundingClientRect();
		ghost.remove();
		ghost = null;
		itemEl.classList.remove('dragging');

		// Drops must land inside the grid rectangle (a little margin).
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;
		const margin = cell / 2;
		if (px < -margin || py < -margin || px > curCols * pitch - gap + margin || py > curRows * pitch - gap + margin)
			return;

		const rawLeft = clampInt(px - lampW / 2, 0, Math.max(0, curCols * pitch - gap - lampW));
		const rawTop = clampInt(py - lampH / 2, 0, Math.max(0, curRows * pitch - gap - lampH));
		const gx = clampInt(Math.round(rawLeft / pitch), 0, Math.max(0, curCols - span));
		const gy = clampInt(Math.round(rawTop / pitch), 0, curRows - 1);

		// The target cell(s) must be free.
		const lamps = layout.entry.Lamps;
		const targets = new Set();
		for (let c = gx; c < gx + span; c++) targets.add(c + ',' + gy);
		for (let i = 0; i < lamps.length; i++) {
			const [ox, oy] = lampGridPos(lamps[i], i);
			for (let c = ox; c < ox + lampSpan(lamps[i]); c++) {
				if (targets.has(c + ',' + oy)) {
					flashLayoutStatus('cell already occupied');
					return;
				}
			}
		}
		addLampToGroup(layout, shape, gx, gy);
	};

	itemEl.addEventListener('pointermove', moveGhost);
	itemEl.addEventListener('pointerup', endDrag);
	itemEl.addEventListener('pointercancel', () => {
		if (ghost) {
			ghost.remove();
			ghost = null;
		}
		itemEl.classList.remove('dragging');
	});
	itemEl.addEventListener('lostpointercapture', () => {
		if (ghost) {
			ghost.remove();
			ghost = null;
		}
		itemEl.classList.remove('dragging');
	});
}

// Moves a lamp's grid cell: updates every signal sharing this layout in the local
// packTable, refreshes the sidebar and map icons. Not saved until Save & exit.
function commitLampMove(layout, lampIndex, gx, gy) {
	gx = Math.max(0, Math.min(gx, signalLayoutMaxGrid));
	gy = Math.max(0, Math.min(gy, signalLayoutMaxGrid));

	setLampGrid(layout, lampIndex, [gx, gy]);
	layoutEditorKey = layoutKey(layout.entry); // the layout signature changes with it
	renderSignalTypePreviews();
	updateSignalIcons(layout.signalIds);
}

// Clears the custom layout of a whole group (back to the default single column),
// locally. Not saved until Save & exit.
function resetSignalLayout(layout) {
	layout.entry.Lamps.forEach((lamp, i) => setLampGrid(layout, i, null));
	layoutEditorKey = layoutKey(layout.entry);
	renderSignalTypePreviews();
	updateSignalIcons(layout.signalIds);
}

// Sets one lamp's grid position on every group member (group members share lamp order).
function setLampGrid(layout, lampIndex, grid) {
	layout.signalIds.forEach(signalId => {
		const entry = packTable.Signals[signalId];
		if (!entry || !Array.isArray(entry.Lamps)) return;
		const lamp = entry.Lamps[lampIndex];
		if (lamp) lamp.Grid = grid;
	});
}

// Refreshes the map icons of the given signals after a layout change.
function updateSignalIcons(signalIds) {
	signalIds.forEach(signalId => {
		const state = signalMarkers.get(signalId);
		if (state) state.marker.setIcon(getSignalIcon(state.aspect, state.mode, state.type, state.entry));
	});
}

// Stable JSON-ish serialization (object keys sorted) for value-comparing entries.
function stableStringify(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
	if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
	return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// True if two group entries ({Lamps, Aspects}) hold the same values.
function entriesEqual(a, b) {
	return a && b && stableStringify(a) === stableStringify(b);
}

// Writes a group's edited entry (lamps + aspects + switchboard colours) to every listed
// signal, cloned per entry so members don't alias each other's arrays.
function applyEntryToMembers(signalIds, entry) {
	signalIds.forEach(signalId => {
		const target = packTable.Signals[signalId];
		if (!target) return;
		const clone = JSON.parse(JSON.stringify(entry));
		target.Lamps = clone.Lamps;
		target.Aspects = clone.Aspects;
		target.SwitchboardAspects = clone.SwitchboardAspects;
	});
}

// 'blink' / 'on' / 'off' for a lamp within an aspect definition.
function lampAspectState(lamp, aspectDef) {
	if (!aspectDef) return 'off';
	const lit = aspectDef.Lit || [];
	const blinking = aspectDef.Blinking || [];
	if (blinking.indexOf(lamp.Name) !== -1) return 'blink';
	return lit.indexOf(lamp.Name) !== -1 ? 'on' : 'off';
}

// Sets a lamp's aspect state (off/on/blink) for every group member, then re-renders.
function setAspectLampState(layout, aspectId, lamp, state) {
	const lit = state === 'blink' || state === 'on';
	const blink = state === 'blink';
	layout.signalIds.forEach(signalId => {
		const entry = packTable.Signals[signalId];
		if (!entry) return;
		if (!entry.Aspects[aspectId]) entry.Aspects[aspectId] = { DisallowPassing: false, Lit: [], Blinking: [] };
		const aspect = entry.Aspects[aspectId];
		if (!Array.isArray(aspect.Lit)) aspect.Lit = [];
		if (!Array.isArray(aspect.Blinking)) aspect.Blinking = [];
		if (lit && aspect.Lit.indexOf(lamp.Name) === -1) aspect.Lit.push(lamp.Name);
		if (!lit) {
			const at = aspect.Lit.indexOf(lamp.Name);
			if (at !== -1) aspect.Lit.splice(at, 1);
		}
		if (blink && aspect.Blinking.indexOf(lamp.Name) === -1) aspect.Blinking.push(lamp.Name);
		if (!blink) {
			const at = aspect.Blinking.indexOf(lamp.Name);
			if (at !== -1) aspect.Blinking.splice(at, 1);
		}
	});
	renderSignalTypePreviews();
}

// The switchboard dot colour assigned to an aspect (from entry.SwitchboardAspects), or ''.
function switchboardAspectColour(entry, aspectId) {
	const sb = (entry && entry.SwitchboardAspects) ? entry.SwitchboardAspects : {};
	const colour = sb[aspectId];
	return (colour && SWITCHBOARD_COLOURS.indexOf(colour) !== -1) ? colour : '';
}

// Hex used for a switchboard dot colour (must match SwitchboardSignals.DOT_COLORS).
function switchboardDotHex(colour) {
	const hex = { red: '#ff4444', blue: '#4488ff', green: '#44ff44', white: '#ffffff', yellow: '#eecc33' };
	return hex[colour] || '#666';
}

// Cycles an aspect's switchboard dot colour (none → green → yellow → red → white → blue → none)
// for every group member, then re-renders.
function setSwitchboardAspectColour(layout, aspectId) {
	const entry = layout.entry;
	const current = switchboardAspectColour(entry, aspectId);
	const cycle = [...SWITCHBOARD_COLOURS, ''];
	const at = cycle.indexOf(current);
	const next = cycle[(at + 1) % cycle.length];

	layout.signalIds.forEach(signalId => {
		const member = packTable.Signals[signalId];
		if (!member) return;
		if (!member.SwitchboardAspects) member.SwitchboardAspects = {};
		if (next) member.SwitchboardAspects[aspectId] = next;
		else delete member.SwitchboardAspects[aspectId];
	});
	renderSignalTypePreviews();
}

// Sets a lamp's colour on every group member, re-keys the open editor (colour is
// part of layoutKey) and re-renders sidebar + map icons.
function setLampColour(layout, lampIndex, hex) {
	const h = String(hex).replace('#', '').toUpperCase();
	const colour = (h.length === 6 || h.length === 8) ? h : null;
	if (!colour) return;

	layout.signalIds.forEach(signalId => {
		const entry = packTable.Signals[signalId];
		if (!entry || !Array.isArray(entry.Lamps)) return;
		const lamp = entry.Lamps[lampIndex];
		if (lamp) lamp.Colour = colour;
	});

	layoutEditorKey = layoutKey(layout.entry);
	renderSignalTypePreviews();
	updateSignalIcons(layout.signalIds);
}

// A unique name for a user-added lamp: custom_<n>, continuing the group's existing sequence.
function nextCustomLampName(layout) {
	const names = new Set();
	layout.signalIds.forEach(signalId => {
		const entry = packTable.Signals[signalId];
		if (entry && Array.isArray(entry.Lamps))
			entry.Lamps.forEach(lamp => { if (lamp && lamp.Name) names.add(lamp.Name); });
	});
	let n = 1;
	while (names.has('custom_' + n)) n++;
	return 'custom_' + n;
}

// Name of the most recently added custom lamp (its matrix row pulses to hint at the colour picker).
let lastAddedLampName = null;

// Appends a new user lamp of the given shape at (gx, gy) to every group member.
function addLampToGroup(layout, shape, gx, gy) {
	const proto = {
		Name: nextCustomLampName(layout),
		Colour: 'FFFFFFFF',
		Shape: shape,
		Grid: [gx, gy],
	};
	layout.signalIds.forEach(signalId => {
		const entry = packTable.Signals[signalId];
		if (!entry) return;
		if (!Array.isArray(entry.Lamps)) entry.Lamps = [];
		entry.Lamps.push(JSON.parse(JSON.stringify(proto)));
	});

	lastAddedLampName = proto.Name;
	layoutEditorKey = layoutKey(layout.entry); // the layout signature changes with a new lamp
	renderSignalTypePreviews();
	updateSignalIcons(layout.signalIds);

	// Ask for a colour: try to open the picker on the new lamp's swatch.
	const idx = layout.entry.Lamps.length - 1;
	const swatch = document.querySelector('#sig-type-list .sig-lamp-colour[data-lamp="' + idx + '"]');
	if (swatch && typeof swatch.showPicker === 'function') {
		try { swatch.showPicker(); } catch (e) { /* pickers must open from a user gesture; the row pulses instead */ }
	}
}

// Removes a lamp from every group member and strips it from all of their aspect patterns.
function removeLampFromGroup(layout, lampIndex) {
	const lamp = layout.entry.Lamps[lampIndex];
	if (!lamp) return;
	const name = lamp.Name;

	layout.signalIds.forEach(signalId => {
		const entry = packTable.Signals[signalId];
		if (!entry || !Array.isArray(entry.Lamps)) return;
		entry.Lamps.splice(lampIndex, 1);
		Object.keys(entry.Aspects || {}).forEach(aspectId => {
			const aspect = entry.Aspects[aspectId];
			['Lit', 'Blinking'].forEach(field => {
				if (!aspect || !Array.isArray(aspect[field])) return;
				const at = aspect[field].indexOf(name);
				if (at !== -1) aspect[field].splice(at, 1);
			});
		});
	});

	layoutEditorKey = layoutKey(layout.entry); // lamp removed from the signature
	renderSignalTypePreviews();
	updateSignalIcons(layout.signalIds);
}

// A save request is in flight (POST /signal/entry).
let layoutSaveInFlight = false;

// Closes the editor without touching the lamp positions.
function closeLayoutEditor() {
	layoutEditorKey = null;
	layoutEditorSnapshot = null;
	lastAddedLampName = null;
	renderSignalTypePreviews();
}

function flashLayoutStatus(msg) {
	const statusEl = document.querySelector('#sig-type-list .sig-layout-status');
	if (statusEl) statusEl.textContent = msg;
}

// Cancels the current edit session: restores the group's lamps + aspects from
// when the editor was opened. No POST — the server already holds that state,
// because edits only leave the editor through Save & exit.
function cancelSignalLayoutEdit() {
	if (layoutEditorKey === null) return;

	const snapshot = layoutEditorSnapshot;
	if (snapshot && !layoutSaveInFlight) {
		applyEntryToMembers(snapshot.signalIds, snapshot.entry);
		updateSignalIcons(snapshot.signalIds);
	}

	closeLayoutEditor();
}

// Keeps custom layouts tight: if a signal's fully-placed layout starts below/right of
// cell [0, 0] (empty first row/column), every lamp is shifted left/up by the offset.
// Runs every 10 s; skipped while the editor is open so it never re-renders mid-edit.
function normalizeSignalLayouts() {
	if (layoutEditorKey !== null) return;
	const signals = packTable.Signals;
	if (!signals) return;

	const fixed = [];
	Object.keys(signals).forEach(signalId => {
		const entry = signals[signalId];
		const lamps = (entry && Array.isArray(entry.Lamps)) ? entry.Lamps : [];
		if (!lamps.length) return;

		const allExplicit = lamps.every(lamp => lamp.Grid && lamp.Grid.length === 2);
		if (!allExplicit) return;

		let minCol = Infinity, minRow = Infinity;
		lamps.forEach(lamp => {
			if (lamp.Grid[0] < minCol) minCol = lamp.Grid[0];
			if (lamp.Grid[1] < minRow) minRow = lamp.Grid[1];
		});
		if (minCol === 0 && minRow === 0) return;

		lamps.forEach(lamp => {
			lamp.Grid = [lamp.Grid[0] - minCol, lamp.Grid[1] - minRow];
		});
		fixed.push(signalId);
	});

	if (!fixed.length) return;

	renderSignalTypePreviews();
	updateSignalIcons(fixed);
	fixed.forEach(signalId => {
		const entry = packTable.Signals[signalId];
		persistSignalEntry([signalId], { Lamps: entry.Lamps, Aspects: entry.Aspects, SwitchboardAspects: entry.SwitchboardAspects });
	});
}

// Periodic layout normalization (see normalizeSignalLayouts).
setInterval(normalizeSignalLayouts, 10000);

// Saves a group's edited entry (lamps + aspects) to the server via POST /signal/entry.
// onSuccess runs only for accepted saves; layoutSaveInFlight guards double-saves.
// On failure the table is re-synced from /signalpack, which re-renders the previews
// (the editor closes if the saved layout no longer matches).
function persistSignalEntry(signalIds, entry, onSuccess) {
	layoutSaveInFlight = true;
	const lamps = (entry.Lamps || []).map(lamp => {
		const payload = {
			Name: lamp.Name,
			Colour: lamp.Colour,
			Shape: lampShape(lamp),
			Grid: (lamp.Grid && lamp.Grid.length === 2) ? [lamp.Grid[0], lamp.Grid[1]] : null,
		};
		if (lamp.Position && lamp.Position.length === 3)
			payload.Position = [lamp.Position[0], lamp.Position[1], lamp.Position[2]];
		return payload;
	});
	fetch(new URL('/signal/entry', location), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			signals: signalIds,
			entry: { Lamps: lamps, Aspects: entry.Aspects || {}, SwitchboardAspects: entry.SwitchboardAspects || {} },
		}),
	}).then(resp => {
		if (!resp.ok) throw new Error('HTTP ' + resp.status);
		layoutSaveInFlight = false;
		if (typeof onSuccess === 'function') onSuccess();
	}).catch(err => {
		layoutSaveInFlight = false;
		console.warn('Failed to save signal entry:', err);
		const statusEl = document.querySelector('#sig-type-list .sig-layout-status');
		if (statusEl) statusEl.textContent = 'Save failed (' + err.message + ') — reloading from server';
		fetch(new URL('/signalpack', location))
			.then(r => r.json())
			.then(data => refreshPackTable(data));
	});
}

function buildSignalsSidebar(installed) {
	const content = document.getElementById('signals-sidebar-content');
	if (!content) return;

	if (!installed) {
		content.innerHTML = '<p style="margin:12px 16px;color:#888;font-style:italic;">Signals mod not installed.</p>';
		return;
	}

	const presentYards = [...new Set(
		[...signalMarkers.values()].map(state => state.yard).filter(y => y && validYards.has(y))
	)].sort();

	presentYards.forEach(yard => { signalVisibility.yards[yard] = true; });

	const yardCheckboxes = presentYards.map(yard => `
		<label class="sig-filter-label">
			<input type="checkbox" class="sig-filter-yard" data-yard="${yard}" checked>
			<span>${yard}</span>
		</label>`).join('');

	content.innerHTML = `
		<div class="sig-filter-section">
			<label class="sig-filter-label sig-filter-master">
				<input type="checkbox" id="sig-filter-show" checked>
				<span>Show all signals</span>
			</label>
		</div>
		<div id="sig-filter-sub" class="sig-filter-section">
			<label class="sig-filter-label">
				<input type="checkbox" id="sig-filter-distant" checked>
				<span>Show Distant signals</span>
			</label>
			<div class="sig-filter-divider">Yards</div>
			<div class="sig-filter-yard-grid">
				${yardCheckboxes}
			</div>
		</div>
		<div class="sig-filter-section">
			<div class="sig-filter-header">
				<div class="sig-filter-divider">Signal types</div>
				<button type="button" class="sig-layout-cancel" id="sig-layout-cancel" hidden>Cancel edit</button>
			</div>
			<div id="sig-type-list"></div>
		</div>`;

	renderSignalTypePreviews();

	const subSection = content.querySelector('#sig-filter-sub');
	const allSubInputs = () => subSection.querySelectorAll('input');

	const showCb = content.querySelector('#sig-filter-show');
	showCb.addEventListener('change', e => {
		signalVisibility.show = e.target.checked;
		allSubInputs().forEach(el => { el.disabled = !e.target.checked; });
		subSection.style.opacity = e.target.checked ? '' : '0.4';
		applySignalVisibility();
	});

	const distantCb = content.querySelector('#sig-filter-distant');
	distantCb.addEventListener('change', e => {
		signalVisibility.distant = e.target.checked;
		applySignalVisibility();
	});

	const yardGrid = content.querySelector('.sig-filter-yard-grid');
	yardGrid.addEventListener('change', e => {
		const cb = e.target;
		if (!cb.matches('.sig-filter-yard')) return;
		signalVisibility.yards[cb.dataset.yard] = cb.checked;
		applySignalVisibility();
	});

	const cancelBtn = content.querySelector('#sig-layout-cancel');
	cancelBtn.addEventListener('click', () => cancelSignalLayoutEdit());
}

let signalsInstalled = false;

// Critical signals init: pack table + signal markers. The sprite manifest fetch is
// deliberately NOT in this chain — a stalled /signal/sprites must never freeze the
// signals tab or the rest of the frontend (it is re-fetched periodically instead).
const signalsReady = junctionsReady
	.then(_ => fetch(new URL('/signalpack', location)))
	.then(resp => (resp.ok ? resp.json() : {}))
	.catch(err => {
		console.error('Failed to load signal pack table:', err);
		return {};
	})
	.then(tableData => {
		refreshPackTable(tableData);
	})
	.then(_ => fetch(new URL('/signals', location)))
	.then(resp => {
		if (!resp.ok) throw new Error(`Signals endpoint failed: HTTP ${resp.status} ${resp.statusText}`);
		return resp.json();
	})
	.catch(err => {
		console.error('Failed to load signal data:', err);
		return null;
	})
	.then(allSignalsData => {
		if (allSignalsData !== null) {
			signalsInstalled = true;
			Object.entries(allSignalsData).forEach(([signalId, signalData]) =>
				createSignalMarker(signalId, signalData));
			if (typeof switchboardRenderer !== 'undefined' && switchboardRenderer) {
				switchboardRenderer.rerenderAllSegments();
			}
		}
	});

// Opportunistic sprite manifest load; on failure the static pictures remain in use.
fetch(new URL('/signal/sprites', location))
	.then(resp => (resp.ok ? resp.json() : { Aspects: {}, Off: {} }))
	.catch(err => {
		console.error('Failed to load signal sprite manifest:', err);
		return { Aspects: {}, Off: {} };
	})
	.then(manifest => {
		refreshSpriteManifest(manifest);
	});

// The sidebar must always be built once signals init settles (even on failure), but
// never gate the update loop on it — updates are already running independently.
const signalsInitTimeout = 20000;

Promise.race([
	signalsReady,
	new Promise(resolve => setTimeout(resolve, signalsInitTimeout)),
])
	.catch(err => {
		console.error('Signals init failed:', err);
		return null;
	})
	.then(_ => {
		try {
			buildSignalsSidebar(signalsInstalled);
		} catch (err) {
			console.error('buildSignalsSidebar failed:', err);
		}
	});

// Switchboard functionality
let switchboardMap;
let switchboardRenderer;

let enablePathing = false;

function initSwitchboard() {
	// Initialize switchboard map if not already done
	if (!switchboardMap) {
		const mapContainer = document.getElementById('switchboard-map');
		if (mapContainer) {
		switchboardMap = L.map('switchboard-map', {
			minZoom: 1,
			maxZoom: 20,
			zoomControl: false,
			center: [0, 0],
			zoom: 10,
			crs: L.CRS.Simple,
			preferCanvas: true
		});

		switchboardMap.on('contextmenu', e => {
			if (typeof PathingController !== 'undefined' && PathingController.enabled && PathingController.state !== 'idle') {
				// Right-click on empty map cancels selection; right-click on a
				// segment/switch toggles a waypoint and is stopped upstream so it
				// does not reach this map-level handler.
				PathingController._resetSelection();
				PathingController.rerender();
				PathingController.updateStatus('Drafting cancelled. Click an occupied block to start a path, or use \u2295 to extend one.');
			}
		});

		// Add zoom control
		L.control.zoom({
			position: 'bottomright'
		}).addTo(switchboardMap);

			// Initialize track renderer
			switchboardRenderer = Object.create(TrackRenderer);
			switchboardRenderer.init(switchboardMap);
			switchboardRepaint.init();

			if (typeof SwitchboardOccupancy !== 'undefined') {
				SwitchboardOccupancy.sendMode();
			}

			// Load sample data
			loadSampleTrackData();
		}
	}
}

function loadSampleTrackData() {
	fetch(new URL('/modconfig', location))
		.then(resp => resp.json())
		.then(config => {
			enablePathing = config.enablePathing ?? false;
			const trackFile = config.doubleTrack ? 'DT_2.1-hotfix.json' : 'ST_2.1-hotfix.json';
			console.log(`Loading track data: ${trackFile} (DoubleTrack: ${config.doubleTrack ?? false})`);
			return fetch(`res/${trackFile}`);
		})
		.then(response => {
			if (!response.ok) {
				throw new Error('Failed to load sample data');
			}
			return response.json();
		})
		.then(data => {
			TrackData.fromJSON(data);
			TrackData.groupIntoBlocks();
			if (switchboardRenderer) {
				switchboardRenderer.renderAll();
				const bounds = [];
				TrackData.nodes.forEach(node => {
					const latlng = switchboardRenderer.coordsToLatLng(node.x, node.y);
					bounds.push([latlng.lat, latlng.lng]);
				});
				if (bounds.length > 0) {
					switchboardMap.fitBounds(bounds, { padding: [20, 20] });
				}
			}
			buildSwitchMapping(enablePathing);
		})
		.catch(error => {
			console.error('Failed to load switchboard sample data:', error);
		});
}

const SWITCHBOARD_ANCHOR = {
	switchboardId: 's1677',
	ingameJunctionIndex: 0
};

async function buildSwitchMapping(enablePathing) {
	try {
		await SwitchboardMapper.fetchIngameGraph();
		SwitchboardMapper.buildSwitchboardGraph();

		console.log(`Ingame graph: ${SwitchboardMapper.ingameGraph.size} junctions`);
		console.log(`Switchboard graph: ${SwitchboardMapper.switchboardGraph.size} switches`);

		const sbSwitch = SwitchboardMapper.switchboardGraph.get(SWITCHBOARD_ANCHOR.switchboardId);
		const ingameJunction = SwitchboardMapper.ingameGraph.get(SWITCHBOARD_ANCHOR.ingameJunctionIndex);

		if (!sbSwitch) {
			console.error(`Anchor switchboard switch '${SWITCHBOARD_ANCHOR.switchboardId}' not found in switchboard graph`);
			return;
		}
		if (!ingameJunction) {
			console.error(`Anchor ingame junction index ${SWITCHBOARD_ANCHOR.ingameJunctionIndex} not found in ingame graph`);
			return;
		}

		console.log(`Anchor: ${SWITCHBOARD_ANCHOR.switchboardId} (deg ${sbSwitch.degree}) -> junction ${SWITCHBOARD_ANCHOR.ingameJunctionIndex} (deg ${ingameJunction.degree})`);

		const mapping = SwitchboardMapper.runParallelWalk(
			SWITCHBOARD_ANCHOR.switchboardId,
			SWITCHBOARD_ANCHOR.ingameJunctionIndex
		);

		console.log(`Mapping complete: ${mapping.size} pairs`);
		SwitchboardMapper.printMapping();

		await sendBlockOccupancyMapping();

		if (typeof SwitchboardSignals !== 'undefined') {
			SwitchboardSignals.init();
			if (!SwitchboardSignals.initialized) {
				signalsReady.then(_ => {
					SwitchboardSignals.init();
					if (switchboardRenderer) switchboardRenderer.rerenderAllSegments();
				});
			}
		}

		if (switchboardRenderer) {
			switchboardRenderer.rerenderAllSegments();
		}

		if (typeof PathingController !== 'undefined') {
			PathingController.enableFromMapping(enablePathing);
		}
	} catch (e) {
		console.error('Failed to build switch mapping:', e);
	}
}

function sendBlockOccupancyMapping() {
    if (!SwitchboardMapper.mapping || SwitchboardMapper.mapping.size === 0) return;
    if (!TrackData.blocks || TrackData.blocks.size === 0) return;
    if (!SwitchboardMapper.ingameGraph || SwitchboardMapper.ingameGraph.size === 0) return;

    const blockJunctionMap = {};
    for (const [blockId, block] of TrackData.blocks) {
        blockJunctionMap[blockId] = [];
    }

    const portNodeNames = [
        { nodeName: 'merging', portName: 'common' },
        { nodeName: 'nl', portName: 'left' },
        { nodeName: 'nr', portName: 'right' }
    ];

    for (const [segId, seg] of TrackData.segments) {
        if (seg.type !== 'switch') continue;

        const jIdx = SwitchboardMapper.getIngameJunctionIndex(segId);
        if (jIdx === null) continue;
        const jData = SwitchboardMapper.ingameGraph.get(jIdx);
        if (!jData || !jData.junctionId) continue;

        for (const { nodeName, portName } of portNodeNames) {
            const nodeId = seg[nodeName];
            if (!nodeId) continue;

            const blocksAtPort = new Set();
            for (const otherSeg of TrackData.segments.values()) {
                if (otherSeg.type === 'switch') continue;
                if (otherSeg.n1 !== nodeId && otherSeg.n2 !== nodeId) continue;
                if (!otherSeg.blockId) continue;
                blocksAtPort.add(otherSeg.blockId);
            }

            if (seg.blockId && portName === 'common') {
                blocksAtPort.add(seg.blockId);
            }

            for (const blockId of blocksAtPort) {
                const entries = blockJunctionMap[blockId];
                const existing = entries.find(e => e.junctionId === jData.junctionId);
                if (existing) {
                    if (existing.port !== portName) {
                        console.warn(`Block ${blockId} junction ${jData.junctionId} has conflicting ports: ${existing.port} vs ${portName}`);
                    }
                    continue;
                }
                const isOwnSwitch = blockId === seg.blockId;
                entries.push({ junctionId: jData.junctionId, port: portName, junctionIndex: jData.junctionIndex, isOwnSwitch });
            }
        }
    }

    return fetch(new URL('/occupancy', location), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign(
            { mode: typeof SwitchboardOccupancy !== 'undefined' && SwitchboardOccupancy.isActive ? 1 : 0 },
            blockJunctionMap
        ))
    }).then(() => {
        console.log(`Sent occupancy mapping for ${Object.keys(blockJunctionMap).length} blocks`);
    }).catch(err => {
        console.error('Failed to send occupancy mapping:', err);
    });
}

function getBlockPortAtSwitch(blockId, switchSegId) {
    const sw = TrackData.getSegment(switchSegId);
    if (!sw || sw.type !== 'switch') return null;

    const block = TrackData.getBlock(blockId);
    if (!block) return null;

    const blockSegIds = new Set(block.segmentIds);

    const hasTrackAtPort = (nodeId) => {
        for (const seg of TrackData.segments.values()) {
            if (seg.type === 'switch') continue;
            if (!blockSegIds.has(seg.id)) continue;
            if (seg.n1 === nodeId || seg.n2 === nodeId) return true;
        }
        return false;
    };

    if (hasTrackAtPort(sw.merging)) return 'common';
    if (hasTrackAtPort(sw.nl)) return 'left';
    if (hasTrackAtPort(sw.nr)) return 'right';
    return null;
}
