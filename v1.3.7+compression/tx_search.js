const fetch = require('node-fetch');
const zlib = require('zlib');
const { logInfo } = require('./console');
const { serverConfig } = require('./server_config');
const consoleCmd = require('./console');

let cachedData = {};
let lastFetchTime = 0;
const fetchInterval = 1000;
const esSwitchCache = {"lastCheck":0, "esSwitch":false};
const esFetchInterval = 300000;
var currentPiCode = '';
var currentRdsPs = '';
const usStatesGeoJsonUrl = "https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json";
let usStatesGeoJson = null;  // To cache the GeoJSON data for US states

// Get weighting values based on algorithm setting.
// Defaults = algorithm 1
let weightedErp = 10;
let weightedDist = 400;
const algorithms = [
    [10, 400],
    [30, 500]
];
const algoSetting = parseInt(serverConfig.webserver.txIdAlgorithm);

if (typeof algorithms[algoSetting] !== 'undefined') {
    weightedErp = algorithms[algoSetting][0];
    weightedDist = algorithms[algoSetting][1];
}

// Load the US states GeoJSON data
async function loadUsStatesGeoJson() {
    if (!usStatesGeoJson) {
        try {
            const response = await fetch(usStatesGeoJsonUrl);
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
            usStatesGeoJson = await response.json();
        } catch (error) {
            console.error("Failed to load US States GeoJSON:", error);
            usStatesGeoJson = null; // Ensure it's null so it can retry later
        }
    }
}

// Function to get bounding box of a state
function getStateBoundingBox(coordinates) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;

    // Check if it's a MultiPolygon or a Polygon
    for (const polygon of coordinates) {
        // If it's a Polygon, it won't have an extra level of arrays
        const linearRings = Array.isArray(polygon[0][0]) ? polygon : [polygon];

        for (const ring of linearRings) {
            for (const [lon, lat] of ring) {
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
                if (lon < minLon) minLon = lon;
                if (lon > maxLon) maxLon = lon;
            }
        }
    }

    return { minLat, maxLat, minLon, maxLon };
}

// Function to check if a city (lat, lon) falls within the bounding box of a state
function isCityInState(lat, lon, boundingBox) {
    return lat >= boundingBox.minLat && lat <= boundingBox.maxLat &&
           lon >= boundingBox.minLon && lon <= boundingBox.maxLon;
}

// Function to check if a city (lat, lon) is inside any US state and return the state name
function getStateForCoordinates(lat, lon) {
    if (!usStatesGeoJson) return null;

    for (const feature of usStatesGeoJson.features) {
        const boundingBox = getStateBoundingBox(feature.geometry.coordinates);
        if (isCityInState(lat, lon, boundingBox)) {
            return feature.properties.name;  // Return the state's name if city is inside bounding box
        }
    }
    return null;
}

// Fetch data from maps
function fetchTx(freq, piCode, rdsPs) {
    const now = Date.now();
    freq = parseFloat(freq);

    if (isNaN(freq)) return;
    if (now - lastFetchTime < fetchInterval
        || serverConfig.identification.lat.length < 2
        || freq < 87
        || (currentPiCode == piCode && currentRdsPs == rdsPs)) {
        return;
    }

    lastFetchTime = now;

    if (cachedData[freq]) {
        const decompressed = JSON.parse(zlib.gunzipSync(cachedData[freq]).toString());
        return processData(decompressed, piCode, rdsPs);
    }

    const url = "https://maps.fmdx.org/api/?freq=" + freq;

    // Try POST first
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ freq }), // You can omit or customize this
        redirect: 'manual'
    })
    .then(postResponse => {
        if (!postResponse.ok) throw new Error(`POST failed: ${postResponse.status}`);
        return postResponse.json();
    })
    .then(data => {
        const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 1 });
        cachedData[freq] = compressed;
        if (serverConfig.webserver.rdsMode === true) {
            return loadUsStatesGeoJson().then(() => processData(data, piCode, rdsPs));
        } else {
            return processData(data, piCode, rdsPs);
        }
    })
    .catch(postError => {
        console.warn("POST failed, trying GET:", postError);

        // Try GET if POST fails
        return fetch(url, { redirect: 'manual' })
            .then(getResponse => {
                if (!getResponse.ok) throw new Error(`GET failed: ${getResponse.status}`);
                return getResponse.json();
            })
            .then(data => {
                const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 1 });
                cachedData[freq] = compressed;
                if (serverConfig.webserver.rdsMode === true) {
                    return loadUsStatesGeoJson().then(() => processData(data, piCode, rdsPs));
                } else {
                    return processData(data, piCode, rdsPs);
                }
            })
            .catch(getError => {
                console.error("GET also failed:", getError);
                return null;
            });
    });
}

function processData(data, piCode, rdsPs) {
    let matchingStation = null;
    let matchingCity = null;
    let maxScore = -Infinity;
    let txAzimuth;
    let maxDistance;
    let esMode = checkEs();
    let detectedByPireg = false;
    currentPiCode = piCode;
    currentRdsPs = rdsPs;

    function evaluateStation(station, city, distance) {
        let weightDistance = distance.distanceKm;
        if (esMode && distance.distanceKm > 500) {
            weightDistance = Math.abs(distance.distanceKm - 1500);
        }
        let erp = station.erp && station.erp > 0 ? station.erp : 1;
        let extraWeight = erp >= weightedErp && distance.distanceKm <= weightedDist ? 0.3 : 0;
        let score = 0;
        // If ERP is 1W, use a simpler formula to avoid zero-scoring.
        if (erp === 0.001) {
            score = erp / distance.distanceKm;
        } else {
            score = ((10 * Math.log10(erp * 1000)) / weightDistance) + extraWeight;
        }
        if (score > maxScore) {
            maxScore = score;
            txAzimuth = distance.azimuth;
            matchingStation = station;
            matchingCity = city;
            maxDistance = distance.distanceKm;
        }
    }

    // First attempt: Try to match station using the piCode
    for (const cityId in data.locations) {
        const city = data.locations[cityId];
        if (city.stations) {
            for (const station of city.stations) {
                if (station.pi === piCode.toUpperCase() && !station.extra && station.ps && station.ps.toLowerCase().includes(rdsPs.replace(/ /g, '_').replace(/^_*(.*?)_*$/, '$1').toLowerCase())) {
                    const distance = haversine(serverConfig.identification.lat, serverConfig.identification.lon, city.lat, city.lon);
                    evaluateStation(station, city, distance);
                    detectedByPireg = false;
                }
            }
        }
    }

    // Fallback to pireg if no match is found
    if (!matchingStation) {
        for (const cityId in data.locations) {
            const city = data.locations[cityId];
            if (city.stations) {
                for (const station of city.stations) {
                    if (station.pireg && station.pireg.toUpperCase() === piCode.toUpperCase() && !station.extra && station.ps && station.ps.toLowerCase().includes(rdsPs.replace(/ /g, '_').replace(/^_*(.*?)_*$/, '$1').toLowerCase())) {
                        const distance = haversine(serverConfig.identification.lat, serverConfig.identification.lon, city.lat, city.lon);
                        evaluateStation(station, city, distance);
                        detectedByPireg = true;
                    }
                }
            }
        }
    }

    // Determine the state if the city is in the USA
    if (matchingStation && matchingCity.itu === 'USA') {
        const state = getStateForCoordinates(matchingCity.lat, matchingCity.lon);
        if (state) {
            matchingCity.state = state;  // Add state to matchingCity
        }
    }

    if (matchingStation) {
        return {
            station: detectedByPireg ? matchingStation.station.replace("R.", "Radio ") + ' ' + matchingStation.regname : matchingStation.station.replace("R.", "Radio "),
            pol: matchingStation.pol.toUpperCase(),
            erp: matchingStation.erp && matchingStation.erp > 0 ? matchingStation.erp : '?',
            city: matchingCity.name,
            itu: matchingCity.state ? matchingCity.state + ', ' + matchingCity.itu : matchingCity.itu,
            distance: maxDistance.toFixed(0),
            azimuth: txAzimuth.toFixed(0),
            id: matchingStation.id,
            pi: matchingStation.pi,
            foundStation: true,
            reg: detectedByPireg
        };
    } else {
        return;
    }
}

function checkEs() {
    const now = Date.now();
    const url = "https://fmdx.org/includes/tools/get_muf.php";
    let esSwitch = false;

    if (now - esSwitchCache.lastCheck < esFetchInterval) {
        return esSwitchCache.esSwitch;
    }

    if (serverConfig.identification.lat > 20) {
        esSwitchCache.lastCheck = now;
        fetch(url)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                return response.json();
            })
            .then(data => {
                if ((serverConfig.identification.lon < -32 && data.north_america.max_frequency !== "No data") ||
                    (serverConfig.identification.lon >= -32 && data.europe.max_frequency !== "No data")) {
                    esSwitchCache.esSwitch = true;
                }
            })
            .catch(error => {
                console.error("Error fetching Es data:", error);
            });
    }

    return esSwitchCache.esSwitch;
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    const y = Math.sin(dLon) * Math.cos(deg2rad(lat2));
    const x = Math.cos(deg2rad(lat1)) * Math.sin(deg2rad(lat2)) -
              Math.sin(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.cos(dLon);
    const azimuth = Math.atan2(y, x);
    const azimuthDegrees = (azimuth * 180 / Math.PI + 360) % 360;

    return {
        distanceKm: distance,
        azimuth: azimuthDegrees
    };
}

function deg2rad(deg) {
    return deg * (Math.PI / 180);
}

// Schedule weekly reset
const weeklyCacheResetTimeUTC = {
    day: 2,    // Tuesday
    hour: 12   // 12:00 UTC
};

function scheduleWeeklyCacheReset() {
    const now = new Date();
    const currentDay = now.getUTCDay();
    const currentHour = now.getUTCHours();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();

    const randomMinuteOffset = Math.floor(Math.random() * 59);

    let daysUntilReset = (weeklyCacheResetTimeUTC.day - currentDay + 7) % 7;
    if (
        daysUntilReset === 0 &&
        (currentHour > weeklyCacheResetTimeUTC.hour ||
         (currentHour === weeklyCacheResetTimeUTC.hour && currentMinute >= randomMinuteOffset))
    ) {
        daysUntilReset = 7;
    }

    const msUntilReset =
        daysUntilReset * 24 * 60 * 60 * 1000 +
        weeklyCacheResetTimeUTC.hour * 60 * 60 * 1000 +
        randomMinuteOffset * 60 * 1000 -
        (currentHour * 60 * 60 * 1000 + currentMinute * 60 * 1000 + currentSecond * 1000);

    const hours = Math.floor(msUntilReset / 3600000);
    const minutes = Math.round(msUntilReset / 60000) % 60;
    setTimeout(() => {
        logInfo(`[Cache] Clear scheduled in ${hours}h ${minutes}m`);
    }, 1000);

    setTimeout(() => {
        clearCache();

        // Schedule repeats every 7 days
        setInterval(() => {
            clearCache();
        }, 7 * 24 * 60 * 60 * 1000);
    }, msUntilReset);
}

function clearCache() {
    const count = Object.keys(cachedData).length;
    for (const key in cachedData) delete cachedData[key];
    const remaining = Object.keys(cachedData).length;
    logInfo(`[Cache] Cleared ${count} entries (${remaining} remaining) at ${new Date().toISOString()}`);
}

scheduleWeeklyCacheReset();

module.exports = {
    fetchTx
};