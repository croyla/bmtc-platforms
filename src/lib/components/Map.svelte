<script lang="ts">
    import maplibregl from 'maplibre-gl';
    import 'maplibre-gl/dist/maplibre-gl.css';
    import {onMount, tick} from 'svelte';
    import {setPlatforms} from '$lib/stores/platforms';
    import {setRoutes} from '$lib/stores/routes';
    import {results, setResults} from '$lib/stores/results';
    import {displayedLiveArrivals, focusedLiveBus} from '$lib/stores/liveArrivals';
    import {get} from 'svelte/store';
    import {Platform} from '$lib/types/Platform';
    import {previousSelectedItem, selectedItem} from '$lib/stores/selectedItem';
    import {currentSource, sources, sourceLoading} from '$lib/stores/source';
    import {showConnectivity} from '$lib/stores/connectivity';

    const DEFAULT_CENTER: maplibregl.LngLatLike = [77.5, 13.0];
    let showResetBounds = false;
    let platformBounds: maplibregl.LngLatBounds | null = null;

    let map: maplibregl.Map | undefined;
    let platformsGeoJson: GeoJSON.FeatureCollection | null = null;
    let isMapLoaded = false;
    let hasRestoredFromUrl = false;
    let liveBusesSetup = false;

    // Connectivity lines state
    let stopCoordSources: Record<string, string> = {};
    let stopCoordinates: Record<string, [number, number]> = {};
    let connFeatures: GeoJSON.Feature[] = [];
    let connAbortController: AbortController | null = null;
    let showConn = false;

    function isPlatformOpen(openHour: number | null | undefined, closeHour: number | null | undefined): boolean {
        if (openHour == null || closeHour == null || (openHour == 0 && closeHour == 0)) return true;
        const now = new Date();
        const current = now.getHours() + now.getMinutes() / 60;
        if (openHour <= closeHour) {
            // Normal: e.g. 6.5–23
            return current >= openHour && current < closeHour;
        } else {
            // Overnight: e.g. 23–4
            return current >= openHour || current < closeHour;
        }
    }

    function getFitBoundsPadding(): number {
        const el = document.getElementById('map');
        if (!el) return 60;
        return Math.max(20, Math.floor(Math.min(el.clientWidth, el.clientHeight) * 0.12));
    }

    function updatePlatformColors() {
        if (!map || !platformsGeoJson) return;
        const currentResults = get(results);
        const resultRouteIds = new Set(currentResults ? currentResults.map(r => r.number) : []);
        const currentSelectedItem = get(selectedItem);
        const activePlatformFilter = currentSelectedItem?.platformNumber?.toUpperCase() || null;

        const updated = JSON.parse(JSON.stringify(platformsGeoJson));
        for (const feature of updated.features) {
            if (!feature.properties.OriginalColor) {
                feature.properties.OriginalColor = feature.properties.Color;
            }
            const platformRoutes = (feature.properties && Array.isArray(feature.properties.Routes)) ? feature.properties.Routes : [];
            const platformNumber = feature.properties.Platform?.toString().toUpperCase() || '';

            feature.properties.isOpen = isPlatformOpen(feature.properties.OpenHour, feature.properties.CloseHour);

            let isGray;
            if (activePlatformFilter) {
                isGray = platformNumber !== activePlatformFilter;
            } else {
                isGray = !platformRoutes.some((route) => Object.hasOwn(route, 'Route') && resultRouteIds.has(route.Route));
            }

            feature.properties.isGray = isGray;
            feature.properties.Color = isGray ? '#D2D2D2' : feature.properties.OriginalColor || feature.properties.Color;
        }
        if (map.getSource('platforms')) {
            (map.getSource('platforms')! as maplibregl.GeoJSONSource).setData(updated);
        }
    }

    function updateConnSource() {
        if (!map || !map.getSource('connectivity-lines')) return;
        (map.getSource('connectivity-lines') as maplibregl.GeoJSONSource).setData({
            type: 'FeatureCollection',
            features: connFeatures
        });
    }

    async function fetchOsrmRoute(key: string, from: [number, number], to: [number, number], signal: AbortSignal) {
        try {
            const url = `https://router.project-osrm.org/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson`;
            const res = await fetch(url, { signal });
            if (signal.aborted || !res.ok) return;
            const data = await res.json();
            if (signal.aborted || !data.routes?.[0]?.geometry?.coordinates) return;

            const idx = connFeatures.findIndex(f => f.properties?.key === key);
            if (idx === -1 || signal.aborted) return;

            connFeatures = connFeatures.map((f, i) =>
                i === idx ? { ...f, geometry: { type: 'LineString' as const, coordinates: data.routes[0].geometry.coordinates } } : f
            );
            updateConnSource();
        } catch (e: any) {
            if (e?.name !== 'AbortError') console.warn('OSRM route fetch failed:', key, e);
        }
    }

    function updateConnectivityLines() {
        if (!map || !isMapLoaded) return;

        if (connAbortController) {
            connAbortController.abort();
            connAbortController = null;
        }

        if (!showConn) {
            connFeatures = [];
            updateConnSource();
            return;
        }

        const currentSelected = get(selectedItem);
        const currentResults = get(results);

        if (!currentSelected || !platformsGeoJson || currentResults.length === 0) {
            connFeatures = [];
            updateConnSource();
            return;
        }

        const platformNumber = currentSelected.platformNumber;
        if (!platformNumber) {
            connFeatures = [];
            updateConnSource();
            return;
        }

        const platformFeature = platformsGeoJson.features.find(
            f => f.properties?.Platform?.toString().toUpperCase() === platformNumber.toUpperCase()
        );
        if (!platformFeature) {
            connFeatures = [];
            updateConnSource();
            return;
        }

        const platformCoords = (platformFeature.geometry as GeoJSON.Point).coordinates as [number, number];
        const platformColor: string = platformFeature.properties?.Color || platformFeature.properties?.OriginalColor || '#1565C0';

        // Build segment map: key -> { from, to, count, routes }
        const segmentMap = new Map<string, { from: [number, number]; to: [number, number]; count: number; routes: Set<string> }>();

        for (const route of currentResults) {
            let baseIdx: number | null = null;
            if (currentSelected.type !== 'Platform') {
                baseIdx = route.stops.findIndex((s: any) => s.name === currentSelected.display);
                if (baseIdx === -1) continue;
            }

            for (let level = 0; level < 3; level++) {
                // Platform view: platform → stops[1], stops[1] → stops[2], stops[2] → stops[3]
                // Stop view: selectedStop → stops[n+1], stops[n+1] → stops[n+2], ...
                const fromIdx = currentSelected.type === 'Platform'
                    ? (level === 0 ? -1 : level)
                    : (baseIdx! + level);
                const toIdx = currentSelected.type === 'Platform'
                    ? (level + 1)
                    : (baseIdx! + level + 1);
                if (toIdx >= route.stops.length) break;

                let fromCoords: [number, number];
                if (fromIdx < 0) {
                    fromCoords = platformCoords;
                } else {
                    const fc = stopCoordinates[route.stops[fromIdx].name];
                    if (!fc) break;
                    fromCoords = fc;
                }

                const tc = stopCoordinates[route.stops[toIdx].name];
                if (!tc) break;

                const key = `${fromCoords[0].toFixed(6)},${fromCoords[1].toFixed(6)}->${tc[0].toFixed(6)},${tc[1].toFixed(6)}`;
                if (!segmentMap.has(key)) {
                    segmentMap.set(key, { from: fromCoords, to: tc, count: 0, routes: new Set() });
                }
                const seg = segmentMap.get(key)!;
                seg.count++;
                seg.routes.add(route.number);
            }
        }

        if (segmentMap.size === 0) {
            connFeatures = [];
            updateConnSource();
            return;
        }

        const maxCount = Math.max(...[...segmentMap.values()].map(s => s.count));

        connFeatures = [...segmentMap.entries()].map(([key, seg]) => {
            const routeArr = [...seg.routes].map(r => {
                const s = String(r).replace(/-/g, '');
                const parts = s.split(' ').filter(Boolean);
                if (parts.length === 0) return s;
                const first = parts[0];
                return /\d/.test(first) ? first : (parts.length > 1 ? `${first} ${parts[1]}` : first);
            });
            const routeLabel = routeArr.length <= 3
                ? routeArr.join(', ')
                : routeArr.slice(0, 3).join(', ') + '...';
            return {
                type: 'Feature' as const,
                geometry: { type: 'LineString' as const, coordinates: [seg.from, seg.to] },
                properties: { key, opacity: 0.2 + (seg.count / maxCount) * 0.75, count: seg.count, routeLabel, color: platformColor }
            };
        });
        updateConnSource();

        // Fetch OSRM road paths asynchronously
        connAbortController = new AbortController();
        const { signal } = connAbortController;
        for (const [key, seg] of segmentMap) {
            fetchOsrmRoute(key, seg.from, seg.to, signal);
        }
    }

    async function loadPlatformsFromSource(sourceKey: string, sourceUrl: string) {
        if (!map) return;

        sourceLoading.set(true);

        // Clear selected item when switching sources (not on first load)
        if (hasRestoredFromUrl) {
            selectedItem.set(undefined);
            previousSelectedItem.set(undefined);
        }

        // Remove existing platform layers and source
        const platformLayerIds = [
            'platform-circles-gray', 'platform-labels-gray',
            'platform-circles-colored', 'platform-labels-colored',
            'platform-circles', 'platform-labels'
        ];
        for (const id of platformLayerIds) {
            if (map.getLayer(id)) map.removeLayer(id);
        }
        if (map.getSource('platforms')) map.removeSource('platforms');

        platformsGeoJson = null;
        setPlatforms([]);
        setRoutes([]);
        setResults([]);

        // Clear live bus display when switching sources
        if (map.getSource('live-buses')) {
            (map.getSource('live-buses') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
        }
        displayedLiveArrivals.set([]);

        let data: GeoJSON.FeatureCollection | null = null;
        try {
            const response = await fetch(sourceUrl);
            data = await response.json();

            if (!map) return;

            const currentResults = get(results);
            const resultRouteIds = new Set(currentResults ? currentResults.map(r => r.number) : []);
            const bounds = new maplibregl.LngLatBounds();

            for (const feature of data.features) {
                bounds.extend((feature.geometry as GeoJSON.Point).coordinates);
                const platformRoutes = (feature.properties && Array.isArray(feature.properties.Routes)) ? feature.properties.Routes : [];
                feature.properties!.isGray = !platformRoutes.some((route) => Object.hasOwn(route, 'Route') && resultRouteIds.has(route.Route));
                feature.properties!.isOpen = isPlatformOpen(feature.properties?.OpenHour, feature.properties?.CloseHour);
            }

            map.fitBounds(bounds, { padding: getFitBoundsPadding() });
            platformsGeoJson = data;

            const platformsArr = (data.features || []).filter(feature => feature.properties?.isOpen).map(feature => {
                const platformNumber = feature.properties?.Platform?.toString().toUpperCase() || '';
                const color = feature.properties?.Color || '#008F45';
                const icon = feature.properties?.Icon || null;
                const apiIds: string[] = Array.isArray(feature.properties?.ApiIds) ? feature.properties.ApiIds : [];
                const routes = (feature.properties?.Routes || []).map(route => {
                    const stops = (route.Stops || []).map((s) => ({ name: s.name, nameKannada: s.name_kn }));
                    const via = { name: route.Via, nameKannada: route.KannadaVia };
                    const area = { name: route.Area, nameKannada: route.KannadaArea };
                    return {
                        number: route.Route,
                        area,
                        stops,
                        via,
                        destination: route.Destination,
                        kannadaDestination: route.KannadaDestination,
                        platformNumber: route.PlatformNumber.toUpperCase()
                    };
                });
                return new Platform({ platformNumber, color, icon, routes, apiIds });
            });

            setPlatforms(platformsArr);

            const allRoutes = [];
            for (const platform of platformsArr) {
                for (const route of platform.routes) {
                    allRoutes.push(route);
                }
            }
            setRoutes(allRoutes);

            map.addSource('platforms', { type: 'geojson', data });

            map.addLayer({
                id: 'platform-circles-gray',
                type: 'circle',
                source: 'platforms',
                filter: ['all', ['==', ['get', 'isOpen'], true], ['==', ['get', 'isGray'], true]],
                paint: {
                    'circle-radius': [
                        'interpolate', ['linear'], ['zoom'],
                        13.7, 2, 14.7, 2.25, 15.7, 6, 16.7, 16
                    ],
                    'circle-color': '#D2D2D2'
                }
            });
            map.addLayer({
                id: 'platform-labels-gray',
                type: 'symbol',
                source: 'platforms',
                filter: ['all', ['==', ['get', 'isOpen'], true], ['==', ['get', 'isGray'], true]],
                layout: {
                    'text-field': ['to-string', ['coalesce', ['get', 'Icon'], ['get', 'Platform']]],
                    'text-size': 16,
                    'text-font': ['Manrope SemiBold'],
                    'text-offset': [0, 0],
                    'text-anchor': 'center',
                    'text-allow-overlap': true
                },
                paint: {
                    'text-color': '#fff',
                    'text-halo-width': 0,
                    'text-opacity': ['interpolate', ['linear'], ['zoom'], 16.5, 0, 16.7, 1]
                }
            });
            map.addLayer({
                id: 'platform-circles-colored',
                type: 'circle',
                source: 'platforms',
                filter: ['all', ['==', ['get', 'isOpen'], true], ['==', ['get', 'isGray'], false]],
                paint: {
                    'circle-radius': [
                        'interpolate', ['linear'], ['zoom'],
                        13.7, 2, 14.7, 2.25, 15.7, 6, 16.7, 16
                    ],
                    'circle-color': ['coalesce', ['get', 'Color'], '#008F45']
                }
            });
            map.addLayer({
                id: 'platform-labels-colored',
                type: 'symbol',
                source: 'platforms',
                filter: ['all', ['==', ['get', 'isOpen'], true], ['==', ['get', 'isGray'], false]],
                layout: {
                    'text-field': ['to-string', ['coalesce', ['get', 'Icon'], ['get', 'Platform']]],
                    'text-size': 16,
                    'text-font': ['Manrope SemiBold'],
                    'text-offset': [0, 0],
                    'text-anchor': 'center',
                    'text-allow-overlap': true
                },
                paint: {
                    'text-color': '#fff',
                    'text-halo-width': 0,
                    'text-opacity': ['interpolate', ['linear'], ['zoom'], 16.5, 0, 16.7, 1]
                }
            });

            platformBounds = bounds;

            setResults(allRoutes);
            updatePlatformColors();

            // Restore from URL params on first load only
            if (!hasRestoredFromUrl) {
                hasRestoredFromUrl = true;
                const urlParams = new URLSearchParams(window.location.search);
                const paramType = urlParams.get('s') ? 's' : urlParams.get('r') ? 'r' : urlParams.get('a') ? 'a' : urlParams.get('pf') ? 'pf' : undefined;
                const paramValue = paramType ? urlParams.get(paramType) : undefined;

                if (paramType === 'pf' && paramValue) {
                    const searchResult = platformsArr.find(val => paramValue.trim().toUpperCase() === val.platformNumber);
                    if (searchResult) selectedItem.set({
                        type: 'Platform',
                        display: searchResult.platformNumber,
                        platformNumber: searchResult.platformNumber
                    });
                } else if (paramType === 'r' && paramValue) {
                    const searchResult = allRoutes.find(val => paramValue.trim().toUpperCase() === val.number);
                    if (searchResult) tick().then(() => selectedItem.set({ type: 'Route', display: searchResult.number, value: searchResult.number }));
                } else if (paramType === 's' && paramValue) {
                    const searchResult = allRoutes.flatMap(v => v.stops).find(val => paramValue.trim().toUpperCase() === val.name.toUpperCase());
                    if (searchResult) {
                        const platformParam = urlParams.get('pf');
                        const itemData: any = { type: 'Stop', display: searchResult.name, displayKannada: searchResult.nameKannada };
                        if (platformParam) itemData.platformNumber = platformParam.trim().toUpperCase();
                        selectedItem.set(itemData);
                    }
                } else if (paramType === 'a' && paramValue) {
                    const searchResult = [...allRoutes.map(v => v.area), ...allRoutes.map(v => v.via)].find(val => paramValue.trim().toUpperCase() === val.name.toUpperCase());
                    if (searchResult) {
                        const platformParam = urlParams.get('pf');
                        const itemData: any = { type: 'Area', display: searchResult.name, displayKannada: searchResult.nameKannada };
                        if (platformParam) itemData.platformNumber = platformParam.trim().toUpperCase();
                        selectedItem.set(itemData);
                    }
                }
            }
        } catch (e) {
            console.error('Failed to load source:', sourceKey, e);
        } finally {
            sourceLoading.set(false);
        }

        // Build stop coordinates from GeoJSON if stops carry lat/lon; otherwise fetch external file
        stopCoordinates = {};
        const inlineCoords: Record<string, [number, number]> = {};
        for (const feature of (data?.features ?? [])) {
            for (const route of (feature.properties?.Routes || [])) {
                for (const stop of (route.Stops || [])) {
                    if (stop.name && stop.lon != null && stop.lat != null) {
                        inlineCoords[stop.name] = [stop.lon, stop.lat];
                    }
                }
            }
        }
        if (Object.keys(inlineCoords).length > 0) {
            stopCoordinates = inlineCoords;
            if (showConn) updateConnectivityLines();
        } else {
            const coordUrl = stopCoordSources[sourceKey];
            if (coordUrl) loadStopCoordinates(coordUrl);
        }
    }

    function loadStopCoordinates(url: string) {
        fetch(url)
            .then(r => r.json())
            .then((data: Record<string, { name: string; lat: number; lon: number }>) => {
                const nameToCoords: Record<string, [number, number]> = {};
                for (const stop of Object.values(data)) {
                    if (stop.name && stop.lon != null && stop.lat != null) {
                        nameToCoords[stop.name] = [stop.lon, stop.lat];
                    }
                }
                stopCoordinates = nameToCoords;
                if (showConn) updateConnectivityLines();
            })
            .catch(() => {});
    }

    onMount(() => {
      console.log('Initializing...')
        map = new maplibregl.Map({
            container: 'map',
            style: {
                version: 8,
                glyphs: 'glyphs/{fontstack}/{range}.pbf',
                sources: {
                    carto: {
                        type: 'raster',
                        tiles: ['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'],
                        tileSize: 256,
                        attribution: '© OpenStreetMap contributors, © CartoDB'
                    }
                },
                layers: [{ id: 'carto', type: 'raster', source: 'carto' }]
            },
            center: DEFAULT_CENTER,
            zoom: 16.8,
            dragRotate: false,
            bearing: 0,
            pitch: 0,
            maxPitch: 0,
            minPitch: 0
        });

        const unsubResults = results.subscribe(() => {
            if (map && platformsGeoJson) updatePlatformColors();
            if (showConn) updateConnectivityLines();
        });

        const unsubSelected = selectedItem.subscribe(() => {
            if (map && platformsGeoJson) updatePlatformColors();
            if (showConn) updateConnectivityLines();
        });

        const unsubConn = showConnectivity.subscribe(val => {
            showConn = val;
            if (isMapLoaded) updateConnectivityLines();
        });

        const unsubLive = displayedLiveArrivals.subscribe(arrivals => {
            if (!map) return;
            const features: GeoJSON.Feature[] = arrivals
                .filter(a => a.location)
                .map(a => ({
                    type: 'Feature' as const,
                    geometry: { type: 'Point' as const, coordinates: [a.location!.lng, a.location!.lat] },
                    properties: {
                        bus_no: a.bus_no || '',
                        display_number: a.display_number,
                        vehicle_id: String(a.vehicle_id || '')
                    }
                }));
            const geojson: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
            if (map.getSource('live-buses')) {
                (map.getSource('live-buses') as maplibregl.GeoJSONSource).setData(geojson);
            }
        });

        const unsubFocused = focusedLiveBus.subscribe(bus => {
            if (!map || !bus || !bus.location) return;
            map.easeTo({ center: [bus.location.lng, bus.location.lat - 0.0005], zoom: Math.max(17), duration: 600 });
            showResetBounds = true;
        });

        // Subscribe to source changes — save to localStorage, load platforms when map is ready
        const unsubSource = currentSource.subscribe(sourceKey => {
            if (!sourceKey) return;
            try { localStorage.setItem('bmtc-last-source', sourceKey); } catch {}
            if (!isMapLoaded) return;
            const $sources = get(sources);
            const url = $sources[sourceKey];
            if (url) loadPlatformsFromSource(sourceKey, url);
        });

        map.on('rotate', () => { map!.setBearing(0); });
        map.on('pitch', () => { map!.setPitch(0); });

        map.on('load', () => {
            isMapLoaded = true;

            // Add connectivity-lines source and layer (below platforms)
            map!.addSource('connectivity-lines', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
            map!.addLayer({
                id: 'connectivity-lines-layer',
                type: 'line',
                source: 'connectivity-lines',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': ['coalesce', ['get', 'color'], '#1565C0'],
                    'line-width': 3,
                    'line-opacity': ['coalesce', ['get', 'opacity'], 0.5]
                }
            });
            map!.addLayer({
                id: 'connectivity-labels-layer',
                type: 'symbol',
                source: 'connectivity-lines',
                layout: {
                    'symbol-placement': 'line',
                    'text-field': ['get', 'routeLabel'],
                    'text-size': 11,
                    'text-font': ['Manrope SemiBold'],
                    'text-anchor': 'center',
                    'text-allow-overlap': false,
                    'symbol-spacing': 250
                },
                paint: {
                    'text-color': ['coalesce', ['get', 'color'], '#1565C0'],
                    'text-halo-color': '#fff',
                    'text-halo-width': 1.5,
                    'text-opacity': ['interpolate', ['linear'], ['zoom'], 16.5, 0, 17, 1]
                }
            });

            // Add live-buses source and layers (once)
            map!.addSource('live-buses', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
            map!.addLayer({
                id: 'live-bus-circles',
                type: 'circle',
                source: 'live-buses',
                paint: {
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 13.7, 3, 15.7, 7, 16.7, 10],
                    'circle-color': '#4CAF50',
                    'circle-stroke-width': 1.5,
                    'circle-stroke-color': '#fff'
                }
            });
            map!.addLayer({
                id: 'live-bus-labels',
                type: 'symbol',
                source: 'live-buses',
                layout: {
                    'text-field': ['to-string', ['get', 'bus_no']],
                    'text-size': 11,
                    'text-font': ['Manrope SemiBold'],
                    'text-offset': [0, 1.6],
                    'text-anchor': 'top',
                    'text-allow-overlap': false
                },
                paint: {
                    'text-color': '#1A1A1A',
                    'text-halo-color': '#fff',
                    'text-halo-width': 1,
                    'text-opacity': ['interpolate', ['linear'], ['zoom'], 16.2, 0, 16.7, 1]
                }
            });

            // Click listener for platform features
            map!.on('click', (e) => {
                const features = map!.queryRenderedFeatures(e.point, { layers: ['platform-circles-gray', 'platform-circles-colored'] });
                if (features && features.length > 0) {
                    const feature = features[0];
                    if (feature && feature.properties && feature.properties.Platform) {
                        selectedItem.set(undefined);
                        previousSelectedItem.set(undefined);
                        tick().then(() => selectedItem.set({
                            type: 'Platform',
                            display: feature.properties.Platform,
                            platformNumber: feature.properties.Platform
                        }));
                    }
                }
            });

            // Geolocate control
            const geolocate = new maplibregl.GeolocateControl({
                positionOptions: { enableHighAccuracy: true },
                trackUserLocation: true,
                showUserLocation: true,
                showAccuracyCircle: true,
                fitBoundsOptions: { maxZoom: map!.getZoom() }
            });
            map!.addControl(geolocate);
            map!.once('render', () => {
                const controls = document.getElementsByClassName('maplibregl-ctrl-geolocate');
                for (const ctrl of controls) {
                    (ctrl as HTMLElement).style.display = 'none';
                }
            });
            if (navigator.geolocation) {
                navigator.geolocation.watchPosition(
                    (pos) => { if ((geolocate as any)._updateMarker) (geolocate as any)._updateMarker(pos); },
                    () => {}
                );
            }

            // Load initial source if already set (covers case where sources.json loaded before map)
            const sourceKey = get(currentSource);
            const $sources = get(sources);
            if (sourceKey && $sources[sourceKey]) {
                loadPlatformsFromSource(sourceKey, $sources[sourceKey]);
            }
        });

        // Load stop coordinate source index, then load coords for current source
        fetch('/data/stops-coordinates-sources.json')
            .then(r => r.json())
            .then((data: Record<string, string>) => {
                stopCoordSources = data;
                const sourceKey = get(currentSource);
                if (sourceKey && data[sourceKey]) {
                    loadStopCoordinates(data[sourceKey]);
                }
            })
            .catch(() => {});

        // Resolve which source to load, then set currentSource (loading screen stays up until then)
        async function initSource() {
          console.log("Initializing source...")
            try {
                const urlParams = new URLSearchParams(window.location.search);
                const srcParam = urlParams.get('src');

                const [sourcesData, bboxData] = await Promise.all([
                    fetch('/data/sources.json').then(r => r.json()) as Promise<Record<string, string>>,
                    fetch('/data/source-bboxes.json').then(r => r.json()).catch(() => null) as Promise<Record<string, [number,number,number,number]> | null>
                ]);

                sources.set(sourcesData);

                // 1. URL param has highest priority
                if (srcParam && sourcesData[srcParam]) {
                    currentSource.set(srcParam);
                    return;
                }

                // 2. Try geolocation — stays pending until resolved or timed out
                const pos = await new Promise<GeolocationPosition | null>(resolve => {
                    if (!navigator.geolocation) { resolve(null); return; }
                    const timer = setTimeout(() => resolve(null), 4000);
                    navigator.geolocation.getCurrentPosition(
                        p => { clearTimeout(timer); resolve(p); },
                        () => { clearTimeout(timer); resolve(null); },
                        { timeout: 4000, maximumAge: 300000 }
                    );
                });

                if (pos && bboxData) {
                    const { longitude: lng, latitude: lat } = pos.coords;
                    const PAD = 0.005; // ~500m padding around each bbox
                    for (const [key, [minLng, minLat, maxLng, maxLat]] of Object.entries(bboxData)) {
                        if (lng >= minLng - PAD && lng <= maxLng + PAD &&
                            lat >= minLat - PAD && lat <= maxLat + PAD) {
                            currentSource.set(key);
                            return;
                        }
                    }
                }

                // 3. Last selected source from localStorage
                let lastSource: string | null = null;
                try { lastSource = localStorage.getItem('bmtc-last-source'); } catch {}
                if (lastSource && sourcesData[lastSource]) {
                    currentSource.set(lastSource);
                    return;
                }

                // 4. Fallback
              currentSource.set('kempegowda');
              sourceLoading.set(false);
            } catch (e) {
                console.error('Failed to initialize source:', e);
                return;
            }
        }
        initSource();

        return () => {
            if (map) map.remove();
            if (connAbortController) connAbortController.abort();
            unsubResults();
            unsubSelected();
            unsubLive();
            unsubFocused();
            unsubSource();
            unsubConn();
        };
    });
</script>

<div id="map" class="fixed inset-0 w-screen h-screen z-0"></div>

{#if showResetBounds}
  <button
    class="reset-bounds-btn"
    aria-label="Recenter map"
    on:click={() => {
      if (map && platformBounds) {
        map.fitBounds(platformBounds, { padding: getFitBoundsPadding(), duration: 500 });
        showResetBounds = false;
        focusedLiveBus.set(null);
      }
    }}
  >
    <span class="material-icons reset-icon">my_location</span>
  </button>
{/if}

<style>
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&display=swap');
@import url('https://fonts.googleapis.com/icon?family=Material+Icons');
.maplibregl-ctrl-geolocate { display: none !important; }
.reset-bounds-btn {
  position: fixed;
  bottom: 32px;
  right: 16px;
  z-index: 201;
  background: #fff;
  border: none;
  border-radius: 50%;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 12px rgba(0,0,0,0.18);
  cursor: pointer;
  transition: box-shadow 0.15s, background 0.15s;
}
.reset-bounds-btn:hover {
  background: #f5f5f7;
  box-shadow: 0 4px 18px rgba(0,0,0,0.22);
}
.reset-icon {
  font-family: 'Material Icons';
  font-size: 22px;
  color: #1A1A1A;
  line-height: 1;
  display: block;
  font-style: normal;
  font-weight: normal;
  letter-spacing: normal;
  -webkit-font-feature-settings: 'liga';
  font-feature-settings: 'liga';
}
</style>