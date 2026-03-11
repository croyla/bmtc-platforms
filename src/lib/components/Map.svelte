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
    import {currentSource, sources} from '$lib/stores/source';

    const DEFAULT_CENTER: maplibregl.LngLatLike = [77.5736529, 12.917500];
    let showResetBounds = false;
    let platformBounds: maplibregl.LngLatBounds | null = null;

    let map: maplibregl.Map | undefined;
    let platformsGeoJson: GeoJSON.FeatureCollection | null = null;
    let isMapLoaded = false;
    let hasRestoredFromUrl = false;
    let liveBusesSetup = false;

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

    async function loadPlatformsFromSource(sourceKey: string, sourceUrl: string) {
        if (!map) return;

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

        try {
            const response = await fetch(sourceUrl);
            const data: GeoJSON.FeatureCollection = await response.json();

            if (!map) return;

            const currentResults = get(results);
            const resultRouteIds = new Set(currentResults ? currentResults.map(r => r.number) : []);
            const bounds = new maplibregl.LngLatBounds();

            for (const feature of data.features) {
                bounds.extend((feature.geometry as GeoJSON.Point).coordinates);
                const platformRoutes = (feature.properties && Array.isArray(feature.properties.Routes)) ? feature.properties.Routes : [];
                feature.properties!.isGray = !platformRoutes.some((route) => Object.hasOwn(route, 'Route') && resultRouteIds.has(route.Route));
            }

            map.fitBounds(bounds, { padding: getFitBoundsPadding() });
            platformsGeoJson = data;

            const platformsArr = (data.features || []).map(feature => {
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
                filter: ['==', ['get', 'isGray'], true],
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
                filter: ['==', ['get', 'isGray'], true],
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
                filter: ['==', ['get', 'isGray'], false],
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
                filter: ['==', ['get', 'isGray'], false],
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
        }
    }

    onMount(() => {
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
        });

        const unsubSelected = selectedItem.subscribe(() => {
            if (map && platformsGeoJson) updatePlatformColors();
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

        // Subscribe to source changes — only fires loadPlatformsFromSource when map is already loaded
        const unsubSource = currentSource.subscribe(sourceKey => {
            if (!isMapLoaded || !sourceKey) return;
            const $sources = get(sources);
            const url = $sources[sourceKey];
            if (url) loadPlatformsFromSource(sourceKey, url);
        });

        map.on('rotate', () => { map.setBearing(0); });
        map.on('pitch', () => { map.setPitch(0); });

        map.on('load', () => {
            isMapLoaded = true;

            // Add live-buses source and layers (once)
            map.addSource('live-buses', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
            map.addLayer({
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
            map.addLayer({
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
            map.on('click', (e) => {
                const features = map.queryRenderedFeatures(e.point, { layers: ['platform-circles-gray', 'platform-circles-colored'] });
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
                fitBoundsOptions: { maxZoom: map.getZoom() }
            });
            map.addControl(geolocate);
            map.once('render', () => {
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

        // Load sources.json and set initial source from URL
        fetch('/data/sources.json')
            .then(r => r.json())
            .then((data: Record<string, string>) => {
                sources.set(data);
                const urlParams = new URLSearchParams(window.location.search);
                const srcParam = urlParams.get('src');
                if (srcParam && data[srcParam]) {
                    currentSource.set(srcParam);
                }
                // If map already loaded and source was set, the subscription handles it.
                // If map not loaded yet, map.on('load') will pick it up.
            })
            .catch(e => console.error('Failed to load sources.json', e));

        return () => {
            if (map) map.remove();
            unsubResults();
            unsubSelected();
            unsubLive();
            unsubFocused();
            unsubSource();
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