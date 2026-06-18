const initialZoom = 20;
const earthCircumference = 40e6;
const metersToDegrees = 360 / earthCircumference;

let verboseEnabled = false,
	verboseInConsole = false;

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

// frontend debugging UI
document.getElementById('verboseCheckbox')
	.addEventListener('change', e => {
		verboseEnabled = e.target.checked;
		// immediately toggle verbose panel visibility
		document.getElementById('verboseDebugPanel').style.display = verboseEnabled ? '' : 'none';
		//possibly add need to uncheck verboseInConsole when turning this off
	});
document.getElementById('verboseInConsole')
	.addEventListener('change', e => {
		verboseInConsole = e.target.checked;
	});

/////////////////////
// sidebar

const sidebar = L.control.sidebar({ autopan: true, container: 'sidebar' }).addTo(map);

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
		//official
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
		case 'IME': return '#b66861';
		case 'IMW': return '#9a5847';
		case 'MB': return '#988c5f';
		case 'MF': return '#dc885b';
		case 'OR': return '#935478';
		case 'OWC': return '#555a62';
		case 'OWN': return '#625d55';
		case 'SM': return '#7b8394';
		case 'SW': return '#cda888';
		//Passenger Jobs mod platforms

		//unsure
		case 'HMB': return '#816c94';
		case 'MFMB': return '#dc885b';
		default: return 'steelblue';
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
	svg.innerHTML = `<text text-anchor="middle" dominant-baseline="central" transform="${rotation}" font-family="Arial" font-weight="bold" fill="${colorForYardId(trackId.split('-')[0])}" stroke="black" stroke-width="0.25px">${trackId.split('-')[1]}</text>`;
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
	createYardLabels(); // draw yard labels
	createYardPoIs(); // draw yard points of interest icons
	});

/////////////////////
// Yard Labels

// Array of Objects in format {id: 'string', position: [y, x], label: ['array of','strings for','newlines'] }
const yardMeta = [
	// Official Yards
	{ id: 'CME', position: [0.100, 0.145], label: ['Coal Mine','East','[CME]'] }, 
	{ id: 'CMS', position: [0.0305, 0.073], label: ['Coal Mine','South','[CMS]'] }, 
	{ id: 'CP', position: [0.080, 0.014], label: ['Coal','Power','Plant','[CP]'] }, 
	{ id: 'CS', position: [0.008, 0.092], label: ['City South','[CS]'] }, 
	{ id: 'CW', position: [0.049, 0.014], label: ['City West','[CW]'] }, 
	{ id: 'FF', position: [0.120, 0.080], label: ['Food Factory','& Town','[FF]'] }, 
	{ id: 'FM', position: [0.058, 0.058], label: ['Farm','[FM]'] }, 
	{ id: 'FRC', position: [0.078, 0.056], label: ['Forest','Central','[FRC]'] }, 
	{ id: 'FRS', position: [0.032, 0.051], label: ['Forest','South','[FRS]'] }, 
	{ id: 'GF', position: [0.0925, 0.120], label: ['Goods Factory','& Town','[GF]'] }, 
	{ id: 'HB', position: [0.027, 0.122], label: ['Harbour','& Town','[HB]'] }, 
	{ id: 'IME', position: [0.134, 0.138], label: ['Iron Ore','Mine East','[IME]'] }, 
	{ id: 'IMW', position: [0.120, 0.022], label: ['Iron Ore','Mine West','[IMW]'] }, 
	{ id: 'MB', position: [0.128, 0.112], label: ['Military Base','[MB]'] }, 
	{ id: 'MF', position: [0.0965, 0.025], label: ['Machine','Factory','& Town','[MF]'] }, 
	{ id: 'OR', position: [0.099, 0.063], label: ['Oil Refinery','[OR]'] }, 
	{ id: 'OWC', position: [0.0525, 0.043], label: ['Oil Well','Central','[OWC]'] }, 
	{ id: 'OWN', position: [0.104, 0.100], label: ['Oil Well','North','[OWN]'] }, 
	{ id: 'SM', position: [0.064, 0.067], label: ['Steel Mill','[SM]'] }, 
	{ id: 'SW', position: [0.018, 0.015], label: ['Sawmill','[SW]'] }, 
	// Added Platforms through Passenger Jobs Mod

	// Unknown
	//{ id: 'HMB', position: [0, 0], label: ' [HMB]' },
	//{ id: 'MFMB', position: [0, 0], label: ' [MFMB]' },
];

function createYardLabels() {
	yardMeta.forEach((yard) => {
		//console.log(yard);
		createYardLabel(yard);
	});
}

function labelPerLine(label) {
	let out = "";
	label.forEach((l) => {
		out += "<tspan x='0' dy='1em'>" + l + "</tspan>";
	});
	return out;
}

function createYardLabel(yard) {
	const size = 0.005;
	const position = yard.position;
	const bounds = [[position[0] - size, position[1] - size], [position[0] + size, position[1] + size]];

	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('id', yard.id)
	svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svg.setAttribute('viewBox', '-50 -10 100 100');
	svg.innerHTML =
	`<text text-anchor="middle" dominant-baseline="central" font-family="Arial" font-weight="bold" fill="${colorForYardId(yard.id)}" stroke="black" stroke-width="0.25px">${labelPerLine(yard.label)}</text>`;
	L.svgOverlay(svg, bounds, { renderer: canvasRenderer })
	.addTo(map)
	.setZIndex(-1000);
}

/////////////////////
// Yard Points of Interest

// Circle Colours and SVG groups and paths for icons
// icons credited to svgrepo.com
const interestTypes = {
	'office':   { circCol: '#ff9900', symbol: `<g transform="translate(-25 -25)" fill="white">
		<path d="M3 4L3 24L17.449219 24L25 12.140625L32.550781 24L47 24L47 4L3 4 z M 25 15.859375L18.550781 26L6 26L6 46L21 46L21 35C21 32.79 22.79 31 25 31C27.21 31 29 32.79 29 35L29 46L44 46L44 26L31.449219 26L25 15.859375 z M 11 31L17 31L17 38L11 38L11 31 z M 33 31L39 31L39 38L33 38L33 31 z" />
											</g>` },
	'mil_office':   { circCol: '#669900', symbol: `<g transform="scale(0.12) translate(-240 -240)" fill="white">
		<path d="M305.844,132.859c-3.219-16.797-17.906-28.922-34.984-28.922h-87.297c-17.625,0-32.594,12.891-35.219,30.328l-10.516,70.172h181.703L305.844,132.859z" />
		<path d="M450.313,246.063c-4.625-8.406-10.813-15.313-18.141-20.188c-3.672-2.438-7.609-4.344-11.75-5.656c-4.141-1.281-8.484-1.984-12.891-1.984h-336c-4.828,0-9.547,0.828-14.016,2.359c-6.719,2.313-12.844,6.219-18.078,11.313C34.188,237,29.813,243.313,26.5,250.5l-0.188,0.422L0,327.688l17.406,5.969l9.078-26.531h16.578c-2.203,2.063-4.188,4.375-5.906,6.906c-4.344,6.438-6.906,14.25-6.906,22.594c0,5.516,1.125,10.656,3.188,15.141c1.516,3.359,3.5,6.391,5.766,9.078c3.391,4.063,7.328,7.438,11.453,10.563c4.141,3.156,8.484,6.063,12.781,9.063l0.125,0.094l25.781,16.609c11.031,7.109,23.875,10.891,36.984,10.891h227.063c13.109,0,25.953-3.781,36.969-10.875l25.797-16.625l0.125-0.094c3.813-2.656,7.688-5.266,11.391-8c2.781-2.063,5.484-4.219,8.031-6.594c1.922-1.75,3.734-3.656,5.375-5.719c2.484-3.094,4.609-6.594,6.109-10.547c1.484-3.953,2.281-8.328,2.281-12.984c0-5.563-1.125-10.906-3.188-15.719c-2.219-5.281-5.531-9.938-9.625-13.781h25.516l16.453,30.719l16.219-8.688l-44.5-83.047L450.313,246.063z M431.469,345.063c-0.828,1.844-1.938,3.594-3.438,5.359c-2.203,2.656-5.203,5.297-8.813,8.047c-3.563,2.719-7.719,5.516-12.109,8.578L381.563,383.5c-8.406,5.438-18.188,8.297-28.172,8.297H126.328c-9.984,0-19.766-2.859-28.172-8.297l-25.531-16.453c-3.906-2.734-7.625-5.234-10.875-7.641c-2.5-1.844-4.75-3.656-6.656-5.438c-1.438-1.344-2.703-2.656-3.781-4c-1.594-1.984-2.75-3.938-3.531-6.063c-0.813-2.125-1.25-4.438-1.266-7.281c0-3.344,0.672-6.5,1.891-9.391c1.844-4.328,4.906-8.047,8.781-10.641c3.875-2.609,8.469-4.125,13.484-4.125h338.391c3.344,0,6.5,0.656,9.375,1.906c4.313,1.813,8.031,4.906,10.641,8.75c2.609,3.875,4.125,8.469,4.125,13.5C433.188,340,432.563,342.609,431.469,345.063z" />
		<polygon points="321.641,168.5 442.031,158.094 442.656,165.297 512,159.313 508.563,119.531 439.219,125.531 439.844,132.719 319.453,143.125" />
		<polygon points="132.156,171.531 71.344,171.906 71.344,203.031 126.5,203.031" />
		<path d="M134.766,324.375c-15.766,0-28.563,12.781-28.563,28.563S119,381.5,134.766,381.5s28.563-12.781,28.563-28.563S150.531,324.375,134.766,324.375z" />
		<path d="M204.594,324.375c-15.781,0-28.563,12.781-28.563,28.563s12.781,28.563,28.563,28.563c15.766,0,28.563-12.781,28.563-28.563S220.359,324.375,204.594,324.375z" />
		<path d="M274.406,324.375c-15.766,0-28.563,12.781-28.563,28.563s12.797,28.563,28.563,28.563c15.781,0,28.563-12.781,28.563-28.563S290.188,324.375,274.406,324.375z" />
		<path d="M344.234,324.375c-15.766,0-28.563,12.781-28.563,28.563s12.797,28.563,28.563,28.563s28.563-12.781,28.563-28.563S360,324.375,344.234,324.375z" />
		<path d="M70.672,321.313c-8.453,0-15.328,6.844-15.328,15.313c0,8.453,6.875,15.313,15.328,15.313s15.313-6.859,15.313-15.313C85.984,328.156,79.125,321.313,70.672,321.313z" />
		<path d="M411.031,321.313c-8.453,0-15.313,6.844-15.313,15.313c0,8.453,6.859,15.313,15.313,15.313c8.469,0,15.313-6.859,15.313-15.313C426.344,328.156,419.5,321.313,411.031,321.313z" />
										</g>` },
	'shop':     { circCol: '#4573af', symbol: `<g transform="scale(3) translate(-12 -12)" fill="white">
		<path fill-rule="evenodd" clip-rule="evenodd" d="M13 3.5C13 2.94772 12.5523 2.5 12 2.5C11.4477 2.5 11 2.94772 11 3.5V4.0592C9.82995 4.19942 8.75336 4.58509 7.89614 5.1772C6.79552 5.93745 6 7.09027 6 8.5C6 9.77399 6.49167 10.9571 7.5778 11.7926C8.43438 12.4515 9.58764 12.8385 11 12.959V17.9219C10.2161 17.7963 9.54046 17.5279 9.03281 17.1772C8.32378 16.6874 8 16.0903 8 15.5C8 14.9477 7.55228 14.5 7 14.5C6.44772 14.5 6 14.9477 6 15.5C6 16.9097 6.79552 18.0626 7.89614 18.8228C8.75336 19.4149 9.82995 19.8006 11 19.9408V20.5C11 21.0523 11.4477 21.5 12 21.5C12.5523 21.5 13 21.0523 13 20.5V19.9435C14.1622 19.8101 15.2376 19.4425 16.0974 18.8585C17.2122 18.1013 18 16.9436 18 15.5C18 14.1934 17.5144 13.0022 16.4158 12.1712C15.557 11.5216 14.4039 11.1534 13 11.039V6.07813C13.7839 6.20366 14.4596 6.47214 14.9672 6.82279C15.6762 7.31255 16 7.90973 16 8.5C16 9.05228 16.4477 9.5 17 9.5C17.5523 9.5 18 9.05228 18 8.5C18 7.09027 17.2045 5.93745 16.1039 5.17721C15.2467 4.58508 14.1701 4.19941 13 4.0592V3.5ZM11 6.07814C10.2161 6.20367 9.54046 6.47215 9.03281 6.8228C8.32378 7.31255 8 7.90973 8 8.5C8 9.22601 8.25834 9.79286 8.79722 10.2074C9.24297 10.5503 9.94692 10.8384 11 10.9502V6.07814ZM13 13.047V17.9263C13.7911 17.8064 14.4682 17.5474 14.9737 17.204C15.6685 16.7321 16 16.1398 16 15.5C16 14.7232 15.7356 14.1644 15.2093 13.7663C14.7658 13.4309 14.0616 13.1537 13 13.047Z" />
											</g>` },
	'service':  { circCol: '#9b948e', symbol: `<g transform="scale(0.2) translate(-140 -140)" fill="white">
		<path d="M200.133,157.32c-2.105-2.105-4.904-3.264-7.881-3.264c-2.977,0-5.776,1.159-7.881,3.264l-9.678,9.678l-14.194-14.194l43.496-43.494c7.016,3.017,14.634,4.613,22.498,4.613c0.001,0,0,0,0.001,0c15.248,0,29.576-5.948,40.341-16.746c14.694-14.74,20.177-36.316,14.308-56.309c-0.341-1.163-1.272-2.06-2.446-2.359c-1.174-0.3-2.42,0.044-3.276,0.903l-35.874,35.983c-2.153-0.873-7.577-3.85-17.615-13.858c-10.038-10.008-13.034-15.423-13.915-17.574l35.872-35.985c0.856-0.859,1.195-2.105,0.893-3.279c-0.303-1.174-1.202-2.102-2.367-2.44C237.244,0.76,231.886,0,226.489,0c-15.249,0-29.574,5.946-40.337,16.744c-16.893,16.946-20.87,41.948-11.981,62.704l-43.515,43.514L86.118,78.424c-0.039-0.076-0.066-0.154-0.109-0.229L65.651,43.294c-0.352-0.603-0.83-1.12-1.403-1.518L29.906,17.948c-1.899-1.318-4.467-1.086-6.1,0.547l-15.3,15.3c-1.634,1.633-1.864,4.202-0.547,6.1l23.828,34.342c0.398,0.573,0.915,1.052,1.518,1.403l34.902,20.358c0.077,0.045,0.158,0.078,0.237,0.118l44.528,44.528l-33.508,33.508c-7.016-3.017-14.633-4.613-22.497-4.613c-15.25,0-29.577,5.947-40.342,16.746C1.931,201.025-3.551,222.602,2.319,242.592c0.341,1.163,1.271,2.06,2.446,2.359c1.174,0.298,2.42-0.044,3.276-0.903l35.874-35.984c2.153,0.874,7.576,3.853,17.613,13.858c10.04,10.009,13.036,15.423,13.916,17.574l-35.872,35.985c-0.856,0.859-1.195,2.105-0.893,3.279c0.303,1.174,1.202,2.102,2.367,2.439c5.17,1.5,10.528,2.261,15.926,2.261c15.247,0,29.573-5.947,40.336-16.745c10.742-10.776,16.645-25.089,16.622-40.305c-0.012-7.841-1.609-15.433-4.617-22.424l33.502-33.501l14.194,14.194l-9.677,9.677c-2.105,2.106-3.265,4.905-3.265,7.882c0,2.978,1.159,5.776,3.264,7.881l68.364,68.363c2.105,2.105,4.903,3.264,7.88,3.264c2.977,0,5.776-1.159,7.882-3.264l37.036-37.037c2.106-2.105,3.266-4.904,3.266-7.882c0-2.977-1.159-5.776-3.264-7.881L200.133,157.32z M224.331,254.164c-2.437,2.438-6.386,2.438-8.821,0l-43.859-43.858c-2.436-2.435-2.436-6.384,0-8.821c2.436-2.436,6.385-2.436,8.821,0.002l43.858,43.857C226.766,247.779,226.767,251.729,224.331,254.164z M244.177,234.318c-2.435,2.436-6.386,2.436-8.821,0l-43.857-43.859c-2.436-2.435-2.436-6.385-0.001-8.82c2.436-2.436,6.386-2.436,8.821,0l43.858,43.859C246.612,227.934,246.612,231.883,244.177,234.318z" />
		</g>` },
	'diesel':   { circCol: '#c18045', symbol: `<g transform="scale(0.5) translate(0 -130)" fill="white">
		<path d="M49,154.5c-0.7-4-1.3-6.9-1.3-6.9c0-0.1-1-8.3-1-8.3v-38.2c0-1.3-0.4-2.4-0.6-3.6c-0.6-2.5-1.6-4.7-3.5-6.6L25.8,74.3l-0.9-0.9c-0.3,0-0.8,0.3-1.4,0.6c-1.5,0.9-3.3,2.7-3.3,2.7c0,1.3,8.8,10,8.8,10l-0.1,4l-0.2,10.8c0,5.2,4.3,9.5,9.5,9.5h2.4l0,0l0,0l-0.8,28.3l0.3,2.2l0.9,7.6l4.2,22.5l1.2,6.2c0.2,4.6-4.1,7.4-7.4,7.4c-1.5,0-3-0.6-4.2-1.6c-1.5-1-2.4-2.6-2.4-4.3v-13.3v-36.8c0-3-1.3-5.8-3.3-7.9c-2-2-4.7-3.3-7.9-3.3H10.6c0.3,0,0.4-4.5,0.5-10.5c0.2-10.3,0.2-25,0.2-29.4V77c0-6.2-4.8-11-10.8-11h-31.1c-6,0-10.8,4.8-10.8,10.8v114.7H9.4h1.9v-66.5h10.1c2.3,0,4.1,1.9,4.1,4.2v50c0,5,3.6,9.6,8.3,11.6c1.6,0.6,3.4,1,5.1,1c2.3,0,4.5-0.7,6.6-1.9c4.3-2.1,7.7-6,7.7-10.8C53.2,178.1,50.6,163.5,49,154.5z M39.8,106.4c-4-0.8-5.3-2.8-5.3-4.7v-6.8c0,0,2.6,0.6,3.3,0.7c1.3,0.3,2.1,2.3,2.1,4C39.8,101.4,39.8,106.4,39.8,106.4z M3.6,103c0,1.7-1.3,2.9-2.9,2.9h-31.3c-1.7,0-2.9-1.3-2.9-2.9V76.8c0-1.7,1.3-2.9,2.9-2.9H0.5c1.7,0,2.9,1.3,2.9,2.9V103H3.6z" />
		</g>` },
	'coal':     { circCol: '#4a4744', symbol: `<g transform="scale(0.2) translate(-150 -150)">
		<path style="fill:#222224;" d="M309.262,225.284L262.658,82.323c-0.56-1.717-1.432-3.285-2.531-4.669c-1.512-1.902-3.465-3.443-5.742-4.436L132.809,20.277c-2.719-1.184-5.676-1.514-8.506-1.032c-2.162,0.368-4.252,1.209-6.105,2.512L6.377,100.316C2.38,103.124,0,107.703,0,112.589V234.98c0,6.253,3.879,11.85,9.733,14.045l109.297,40.988c0.623,0.233,1.261,0.409,1.903,0.558c1.105,0.255,2.232,0.397,3.363,0.397c1.312,0,2.625-0.172,3.905-0.518l170.703-46.035c3.972-1.07,7.328-3.725,9.286-7.342C310.149,233.456,310.536,229.194,309.262,225.284z" />
		<path style="fill:#403F44;" d="M254.385,73.219L132.809,20.277c-2.719-1.184-5.676-1.514-8.506-1.032l27.667,144.029l108.157-85.62C258.615,75.752,256.662,74.211,254.385,73.219z" />
		<path style="fill:#313133;" d="M309.262,225.284L262.658,82.323c-0.56-1.717-1.432-3.285-2.531-4.669l-108.157,85.62L120.934,290.57c1.105,0.255,2.232,0.397,3.363,0.397c1.312,0,2.625-0.172,3.905-0.518l170.703-46.035c3.972-1.07,7.328-3.725,9.286-7.342C310.149,233.456,310.536,229.194,309.262,225.284z" />
		</g>` },
	'water':    { circCol: '#557090', symbol: `<g transform="scale(3) translate(-12 -12)" fill="#83acdd">
		<path d="M16.0001 13.3848C16.0001 14.6088 15.526 15.7828 14.6821 16.6483C14.203 17.1397 13.6269 17.5091 13 17.7364M19 13.6923C19 7.11538 12 2 12 2C12 2 5 7.11538 5 13.6923C5 15.6304 5.7375 17.4893 7.05025 18.8598C8.36301 20.2302 10.1436 20.9994 12.0001 20.9994C13.8566 20.9994 15.637 20.2298 16.9497 18.8594C18.2625 17.4889 19 15.6304 19 13.6923Z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
		</g>` },
	'electric': { circCol: '#4ba58b', symbol: `<g transform="scale(2.5) translate(-12 -12)">
		<defs><style>.cls-1 { fill:none; stroke:white; stroke-miterlimit:10; stroke-width:1.91px; }</style></defs>
		<path class="cls-1" d="M15.82,1.5h1.91a0,0,0,0,1,0,0V7.23a0,0,0,0,1,0,0H15.82a1.91,1.91,0,0,1-1.91-1.91V3.41A1.91,1.91,0,0,1,15.82,1.5Z"/><line class="cls-1" x1="21.55" y1="2.45" x2="17.73" y2="2.45"/><line class="cls-1" x1="21.55" y1="6.27" x2="17.73" y2="6.27"/><polygon class="cls-1" points="11.04 11.04 9.14 13.91 11.04 13.91 11.04 11.04"/><polygon class="cls-1" points="12 15.82 13.91 12.96 12 12.96 12 15.82"/><path class="cls-1" d="M20.59,13.43a9.07,9.07,0,1,1-9.07-9.07h2.39"/>
		</g>` },
};

// Array of Objects that consists of ID of location, then array of objects for each PoI as ID and position [y, x]
const yardPoI = [
	{ id: 'TEMPLATE', pois: [
						{ poi: 'office',   position: [0., 0.] },
						{ poi: 'mil_office',   position: [0., 0.] },
						{ poi: 'shop',     position: [0., 0.] },
						{ poi: 'service',  position: [0., 0.] },
						{ poi: 'diesel',   position: [0., 0.] },
						{ poi: 'water',    position: [0., 0.] },
						{ poi: 'coal',     position: [0., 0.] },
						{ poi: 'electric', position: [0., 0.] },
					   ] },
	{ id: 'CME', pois: [
						{ poi: 'office',   position: [0.10021889, 0.14027232] },
						{ poi: 'service',  position: [0.10378886, 0.14053044] },
						{ poi: 'diesel',   position: [0.10383346, 0.14052557] },
						{ poi: 'water',    position: [0.10360843, 0.14055335] },
						{ poi: 'coal',     position: [0.10338918, 0.14058359] },
					   ] },
	{ id: 'CMS', pois: [
						{ poi: 'office',   position: [0.03137119, 0.07630888] },
						{ poi: 'water',    position: [0.02971534, 0.07591877] },
						{ poi: 'coal',     position: [0.02990706, 0.07594476] },
					  ] },
	{ id: 'CP', pois: [
						{ poi: 'office',   position: [0.08087875, 0.01885058] },
						{ poi: 'water',    position: [0.08084517, 0.01970789] },
						{ poi: 'coal',     position: [0.08097430, 0.01966926] },
					  ] },
	{ id: 'CS', pois: [
						{ poi: 'office',   position: [0.01203843, 0.08956995] },
						{ poi: 'service',  position: [0.01326034, 0.09231872] },
						{ poi: 'diesel',   position: [0.01325372, 0.09236296] },
						{ poi: 'water',    position: [0.01321174, 0.09224170] },
						{ poi: 'water',    position: [0.01233818, 0.09045592] },
						{ poi: 'coal',     position: [0.01310972, 0.09229780] },
						{ poi: 'electric', position: [0.01326987, 0.09227004] },
					  ] },
	{ id: 'CW', pois: [
						{ poi: 'office',   position: [0.05104002, 0.01822374] },
						{ poi: 'shop',     position: [0.05206668, 0.01723934] },
						{ poi: 'service',  position: [0.05057001, 0.01660809] },
						{ poi: 'diesel',   position: [0.05053400, 0.01657294] },
						{ poi: 'water',    position: [0.05128742, 0.01728370] },
						{ poi: 'electric', position: [0.05060789, 0.01664231] },
					  ] },
	{ id: 'FF', pois: [
						{ poi: 'office',   position: [0.12254239, 0.08521475] },
						{ poi: 'shop',     position: [0.12077097, 0.08580154] },
						{ poi: 'service',  position: [0.12020821, 0.08400354] },
						{ poi: 'diesel',   position: [0.12025248, 0.08402058] },
						{ poi: 'water',    position: [0.12132152, 0.08551699] },
						{ poi: 'electric', position: [0.12016401, 0.08398607] },
					  ] },
	{ id: 'FM', pois: [
						{ poi: 'office',   position: [0.06069334, 0.05390950] },
						{ poi: 'water',    position: [0.05981276, 0.05436437] },
					   ] },
	{ id: 'FRC', pois: [
						{ poi: 'office',   position: [0.07821947, 0.05119910] },
						{ poi: 'water',    position: [0.07882234, 0.05188031] },
					   ] },
	{ id: 'FRS', pois: [
						{ poi: 'office',   position: [0.03342285, 0.04828971] },
						{ poi: 'water',    position: [0.03297512, 0.04793460] },
					   ] },
	{ id: 'GF', pois: [
						{ poi: 'office',   position: [0.09943136, 0.11563829] },
						{ poi: 'shop',     position: [0.10047270, 0.11729108] },
						{ poi: 'service',  position: [0.09909987, 0.11600702] },
						{ poi: 'diesel',   position: [0.09907726, 0.11596507] },
						{ poi: 'water',    position: [0.09921992, 0.11578690] },
						{ poi: 'coal',     position: [0.09949035, 0.11804663] },
						{ poi: 'electric', position: [0.09912165, 0.11604841] },
					   ] },
	{ id: 'HB', pois: [
						{ poi: 'office',   position: [0.03167313, 0.11754386] },
						{ poi: 'mil_office',   position: [0.02912295, 0.11267803] },
						{ poi: 'shop',     position: [0.03255508, 0.12080989] },
						{ poi: 'service',  position: [0.03221129, 0.11503612] },
						{ poi: 'diesel',   position: [0.03222420, 0.11498806] },
						{ poi: 'water',    position: [0.03233161, 0.11452224] },
						{ poi: 'coal',     position: [0.03235525, 0.11441764] },
						{ poi: 'electric', position: [0.03220079, 0.11507989] },
					   ] },
	{ id: 'IME', pois: [
						{ poi: 'office',   position: [0.13729374, 0.13454964] },
						{ poi: 'service',  position: [0.13960178, 0.13498524] },
						{ poi: 'water',    position: [0.13957338, 0.13508814] },
						{ poi: 'coal',     position: [0.13971831, 0.13514397] },
					   ] },
	{ id: 'IMW', pois: [
						{ poi: 'office',   position: [0.12063519, 0.01815300] },
						{ poi: 'service',  position: [0.12173587, 0.01791450] },
						{ poi: 'water',    position: [0.12192532, 0.01764308] },
						{ poi: 'coal',     position: [0.12184144, 0.01776235] },
					   ] },
	{ id: 'MB', pois: [
						{ poi: 'mil_office',   position: [0.13282215, 0.11480732] },
						{ poi: 'water',    position: [0.13268119, 0.11336039] },
					   ] },
	{ id: 'MF', pois: [
						{ poi: 'office',   position: [0.09873824, 0.02107944] },
						{ poi: 'mil_office',   position: [0.09976895, 0.02178324] },
						{ poi: 'shop',     position: [0.09750912, 0.02008171] },
						{ poi: 'service',  position: [0.09584568, 0.02017256] },
						{ poi: 'diesel',   position: [0.09588932, 0.02015230] },
						{ poi: 'water',    position: [0.09694808, 0.02069538] },
						{ poi: 'water',    position: [0.09515341, 0.02051629] },
						{ poi: 'coal',     position: [0.09535354, 0.02050315] },
						{ poi: 'electric', position: [0.09580305, 0.02018688] },
					   ] },
	{ id: 'OR', pois: [
						{ poi: 'office',   position: [0.10173061, 0.05755503] },
						{ poi: 'diesel',   position: [0.09919536, 0.05714325] },
						{ poi: 'water',    position: [0.10291863, 0.05876546] },
					   ] },
	{ id: 'OWC', pois: [
						{ poi: 'office',   position: [0.05635248, 0.04455517] },
						{ poi: 'service',  position: [0.05693097, 0.04239562] },
						{ poi: 'diesel',   position: [0.05691243, 0.04244628] },
						{ poi: 'water',    position: [0.05663066, 0.04243822] },
					   ] },
	{ id: 'OWN', pois: [
						{ poi: 'office',   position: [0.10365083, 0.10398579] },
						{ poi: 'service',  position: [0.10461786, 0.10389203] },
						{ poi: 'diesel',   position: [0.10458219, 0.10385852] },
					   ] },
	{ id: 'SM', pois: [
						{ poi: 'office',   position: [0.06602975, 0.07132980] },
						{ poi: 'service',  position: [0.06423716, 0.07238030] },
						{ poi: 'diesel',   position: [0.06427639, 0.07235369] },
						{ poi: 'water',    position: [0.06729297, 0.07198403] },
						{ poi: 'water',    position: [0.06653203, 0.07183069] },
						{ poi: 'coal',     position: [0.06634782, 0.07173785] },
						{ poi: 'electric', position: [0.06419840, 0.07240577] },
					   ] },
	{ id: 'SW', pois: [
						{ poi: 'office',   position: [0.02059886, 0.01225835] },
						{ poi: 'service',  position: [0.02184531, 0.01073720] },
						{ poi: 'water',    position: [0.02125974, 0.01088378] },
						{ poi: 'coal',     position: [0.02100376, 0.01094750] },
					   ] },
];

function createYardPoIs() {
	yardPoI.forEach((yard) => {
		//console.log(yard);
		yard.pois.forEach((poi) => {
			createYardPoI(yard, poi);
		});
	});
}

function createYardPoI(yard, poi) {
	const size = 0.000025;
	const position = poi.position;
	const bounds = [[position[0] - size, position[1] - size], [position[0] + size, position[1] + size]];

	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('id', yard.id + '_' + poi.poi)
	svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svg.setAttribute('viewBox', '-50 -50 100 100');
	svg.innerHTML =
	`<circle cx="0" cy="0" r="45" fill="${interestTypes[poi.poi].circCol}" stroke="white" stroke-width="0.5em" />
	${interestTypes[poi.poi].symbol}`;
	L.svgOverlay(svg, bounds, { renderer: canvasRenderer })
	.addTo(map)
	.setZIndex(1500); // above track labels (1000) and below cars (2000)
}

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
	);

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
	junction.marker.getElement().innerHTML = createJunctionShape(selectedBranch) + createJunctionLabel(junctionId);
	const selectedTrackId = junction.branches[selectedBranch]
	trackPolyLines.get(selectedTrackId).setStyle({ color: 'steelblue', dashArray: null });
	const unselectedTrackPolyLine = trackPolyLines.get(junction.branches[1 - selectedBranch]);
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
		.setZIndex(Math.floor(p[0] + p[1] * 100000)); // doesn't need _that_ huge of a zindex...
}

function updateAllJunctions(states) {
	states.forEach((state, index) => updateJunctionOverlay(index, state))
}

/////////////////////
// signals

const signalMarkers = new Map();
const signalIconAnchor = [12, 12];


function makeSafeSignalId(id) {
	if (!id) return '';
	// Replace characters that have special meaning in CSS:
	// . (class), : (pseudo-class/attribute), [ (attribute selector),
	// # (ID), $ (data attribute), { } (content), ( ) (expression),
	// * (universal), + (adjacent sibling), > (child), space (descendant), % (percent)
	return id.replace(/[\.\:\[\]\#\$%\{\}\(\)\*\+\>\s]+/g, '_');
}

function getSignalIconUrl(aspect, mode, type) {
	if (verboseInConsole)
		console.log(`Getting signal icon for aspect ${aspect} and mode ${mode}, of type ${type}`);
	if (!aspect || aspect === 'OFF') {
		if (type == "Distant") return 'res/signals.distant_off.webp';
		return 'res/signals.off.webp';
	}

	if (type === "Distant") {
		// Distant signals do not have a manual image
		if (verboseInConsole)
			console.log("Signal is of type 'distant'")
		mode = "automatic";
	}
	const imageName = `${aspect.toLowerCase()}_${mode.toLowerCase()}`;

	// Match all known aspects by lowercasing the input
	const imageNames = [
		's1_manual', 's1c_manual', 's2_manual', 's4_manual', 's6_manual',
		's1_automatic', 's1c_automatic', 's2_automatic', 's4_automatic', 's6_automatic',
		'ds1_automatic', 'ds2_automatic', 'ds3_automatic', 'ds4_automatic'
	].map(x => x.toLowerCase());

	if (!imageNames.includes(imageName)) {
		console.log(`No valid image found for a signal with aspect ${aspect} and mode ${mode} of type ${type}. imageName var was ${imageName}`);
		return 'res/signals.all.webp';
	}

	return `res/signals.${imageName}.webp`;
}

const signalIconBaseSize = { normal: [16, 80], distant: [16, 32] };
const signalIconMaxScale = 3; // cap: icons won't grow beyond 3× their base size

function getSignalIconSize(type) {
	const base = type === "Distant" ? signalIconBaseSize.distant : signalIconBaseSize.normal;
	const zoom = map.getZoom();
	const scale = zoom < initialZoom - 4 ? 1 / (2 ** (initialZoom - 4 - zoom)) : 1;
	const minScale = 1 / signalIconMaxScale; // floor so they don't vanish entirely
	const s = Math.max(scale, minScale);
	return [Math.round(base[0] * s), Math.round(base[1] * s)];
}

function getSignalIcon(aspect, mode, type) {
	const url = getSignalIconUrl(aspect, mode, type);
	const iconSize = getSignalIconSize(type);
	return L.icon({
		iconUrl: url,
		iconSize: iconSize,
		iconAnchor: signalIconAnchor,
	});
}

function createSignalMarker(signalId, signalData) {
	const aspect = signalData.CurrentAspectId || 'OFF';
	const mode = signalData.Mode || 'Automatic';
	const signalType = signalData.Type
	const position = signalData.Position;

	const marker = L.marker(position, {
		icon: getSignalIcon(aspect, mode, signalType),
		interactive: true,
		title: signalId,
		zIndexOffset: Math.floor((position[0] + position[1]) * 2000), // signals should appear above cars but below players
	})
		.bindPopup(() => buildSignalPopup(signalId, signalType), { maxWidth: 260 })
		.addTo(map);

	signalMarkers.set(signalId, { marker, aspect, mode, type: signalType });
}

function buildSignalPopup(signalId, signalType) {
	if (verboseInConsole) {
		console.log("buildSignalPopup called");
		console.log(`Signal ID   : ${signalId}`);
		console.log(`Signal type : ${signalType}`);
	}

	const state = signalMarkers.get(signalId);
	if (!state)
		return '';

	if (signalType == "Distant") {
		const el = document.createElement('strong');
		el.style.fontSize = '1.1em';
		el.textContent = signalId;
		return el;
	}

	// If mode is not known, assume manual
	const isManual = state.mode === 'Manual';
	// Get valid aspects
	var validTypeAspects = [
		{ "aspect": "S2", "name": "Clear" },
		{ "aspect": "S4", "name": "Expect Caution" },
		{ "aspect": "S6", "name": "Caution" },
		{ "aspect": "S1", "name": "Stop" },
		{ "aspect": "S1c", "name": "Stop, train crossing" }
	]

	const container = document.createElement('div');
	container.style.cssText = 'min-width:200px;font-family:sans-serif';
	container.innerHTML = `
		<strong style="font-size:1.1em">${signalId}</strong>
			<div style="margin:6px 0">
				Mode: <strong id="sig-mode-label-${makeSafeSignalId(signalId)}">${state.mode}</strong>
			</div>
			<label style="display:flex;align-items:center;gap:6px;margin-bottom:10px;cursor:pointer">
				<input type="checkbox" id="sig-manual-${makeSafeSignalId(signalId)}" ${isManual ? 'checked' : ''}>
				Manual control
			</label>
			<div id="sig-aspect-row-${makeSafeSignalId(signalId)}" style="display:${isManual ? 'block' : 'none'}">
				<div style="margin-bottom:4px">Set aspect:</div>
				<select id="sig-aspect-select-${makeSafeSignalId(signalId)}" style="width:100%;margin-bottom:8px;max-height:120px;overflow-y:auto">
					${validTypeAspects.map(a =>
		`<option value="${a.aspect}" ${a.aspect === state.aspect ? 'selected' : ''}>${a.name}</option>`
	).join('')}
				</select>
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
							entry.marker.setIcon(getSignalIcon(entry.aspect, entry.mode, signalType));
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
							entry.marker.setIcon(getSignalIcon(entry.aspect, entry.mode, signalType));
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
	Object.entries(signalsData).forEach(([signalId, signalData]) => {
		if (verboseInConsole)
			console.log(`Updating signal ${signalId} with aspect ${signalData.CurrentAspectId} and mode ${signalData.Mode}`);
		const existing = signalMarkers.get(signalId);
		if (!existing)
			return;

		const aspect = signalData.CurrentAspectId || 'OFF';
		const mode = signalData.Mode ?? existing.mode;

		const aspectChanged = existing.aspect !== aspect;
		const modeChanged = existing.mode !== mode;

		// Update state first so setIcon uses the correct aspect+mode combination
		if (aspectChanged) existing.aspect = aspect;
		if (modeChanged) existing.mode = mode;

		// Regenerate icon whenever aspect OR mode changes (both affect the icon URL)
		if (aspectChanged || modeChanged) {
			existing.marker.setIcon(getSignalIcon(existing.aspect, existing.mode, signalData.Type));
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
	let debugPlayerPositions = "";
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
		if (verboseEnabled) 
			debugPlayerPositions += id + ': y=' + playerData.position[0] + ', x=' + playerData.position[1] + '</br>'; //debug get position of player on canvas
	});
	if (verboseEnabled) document.getElementById('verbosePlayerPositions').innerHTML = debugPlayerPositions; //output to DOM element
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
		.addTo(map)
		.setZIndex(1000000); // set zindex to 1 million, players should always be topmost

	// If a tooltip is used, it cannot be bound properly to the overlay as the overlay doesnt have a latlng, so create a separate marker just for the tooltip
	const playerLabel = L.marker(playerData.position, {
		icon: L.divIcon({
			html: `<div style="background: rgba(0,0,0,0.7); color: white; padding: 2px 6px; border-radius: 3px; font-weight: bold; white-space: nowrap; opacity: 0.7;">${id}</div>`,
			iconSize: null, // let size scale with content
			iconAnchor: [0, -20]
		}) //TODO: possibly use zIndexOffset on the marker to set zindex
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
})

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
		.addTo(map)
		.setZIndex(2000); // add zindex to make them appear on top of other elements, but under players
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
	if (verboseInConsole)
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
	signalMarkers.forEach(({ marker, aspect, mode, type }) => {
		marker.setIcon(getSignalIcon(aspect, mode, type));
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
				if (verboseInConsole)
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
					default:
						const segments = tag.split('-');
						switch (segments[0]) {
							case 'trainset': updateCars(data); break;
							case 'carguid': updateCar(data.id, data); break;
						}
				}
			});
		})
		.then(_ => {
			if (markerToFollow)
				map.panTo(markerToFollow.getBounds().getCenter());
		});
}

function updateLoop() {
	updateOnce()
		.catch(err => {
			console.error('Update failed:', err);
		})
		.then(_ => {
			const timeToNextUpdate = (updateStart + updateInterval) - performance.now();
			setTimeout(updateLoop, timeToNextUpdate);
		});
}

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

function yardFromSignalId(signalId) {
	const stripped = signalId.startsWith('#') ? signalId.slice(1) : signalId;
	const part = stripped.split('-')[2];
	return part ? part.split(':')[0] : null;
}

function applySignalVisibility() {
	signalMarkers.forEach(({ marker, type }, signalId) => {
		const yard = yardFromSignalId(signalId);
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

function buildSignalsSidebar(installed) {
	const content = document.getElementById('signals-sidebar-content');
	if (!content) return;

	if (!installed) {
		content.innerHTML = '<p style="margin:12px 16px;color:#888;font-style:italic;">Signals mod not installed.</p>';
		return;
	}

	const presentYards = [...new Set(
		[...signalMarkers.keys()].map(yardFromSignalId).filter(y => y && validYards.has(y))
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
		</div>`;

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
}

let signalsInstalled = false;

const signalsReady = junctionsReady
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
		}
	});

signalsReady.then(_ => {
	buildSignalsSidebar(signalsInstalled);
	updateLoop();
});
