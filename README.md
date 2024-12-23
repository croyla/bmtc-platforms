# [Unofficial] BMTC Platform Helper

View platforms, search through routes to find out about their departure platform, or search through stops to find platforms and buses

The version that this repo has is hosted on [our domain](https://platforms.blrtransit.com) as well as [github-pages](https://croyla.github.io/bmtc-platforms)

### Usage

Upon loading the site the user is prompted with a location permission, denying the permission does nothing however providing the permission displays the user's current location on the map, this location is updated every 2 seconds.

The checkbox in the top corner toggles the "Dark Mode" theme.

The map has multiple displayed "features", one for each platform the app knows about.

Each feature on the map has a title which is visible, this is usually the platform name. The feature is clickable to get relevant information. 

The information provided is the following:

> Shortname towards Destination
> 
> Ex: '**315-J** to Rampura'

Optionally if a search query matches an intermediate stop:

> Shortname towards Destination via Stop
> 
> Ex: '**315-J** to Rampura via Richmond Circle'

The search box filters the features displayed on the map to features relevant to the search query. This also filters and modifies the information displayed in a feature.

The entire service is designed to run smoother when installed on your phone. This can be done on iOS by opening the site in Safari, clicking on share, and adding it to the home screen. Similarly possible on Android with the default device browser, clicking on "Install" in the options area (next to the address bar).

A few notes: The platforms may have inaccurate data. In my personal experience I have found "Platform 5" to have very inaccurate data, if you are aware of inaccuracies please raise an issue or comment [here](https://gist.github.com/croyla/6f0e128de90c49d016e6b15ebbf6d3c0).

### Self-Hosting

Self hosting can be achieved by simply cloning this repo and serving the folder, however the map will not load as the Mapbox Token used right now is restricted. 

This can be solved by editing the code block:

```js
        // Add Mapbox tile layer
        const mapboxTileLayer = L.tileLayer('https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/{z}/{x}/{y}?access_token={accessToken}', {
            attribution: 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Imagery © <a href="https://www.mapbox.com/">Mapbox</a>',
            tileSize: 512,
            zoomOffset: -1,
            maxZoom: 23,
            accessToken: 'REPLACE_WITH_YOUR_ACCESS_TOKEN'
        }).addTo(map);
```

### How it works

The applet queries geojson data from a [github gist](https://gist.github.com/croyla/6f0e128de90c49d016e6b15ebbf6d3c0), it then uses Leaflet and Mapbox to visualise the data in map form. 

The geographic locations for the platforms are manually placed, and may be slightly inaccurate as a result. 

The routes for platforms are sourced from BMTC APIs, as such reliability and accuracy tends to be dependent on the data received. There are manual overrides in place for routes known to be inaccurate in data received. It seems "platform 5" has the most inaccurate results in my testing, if you are aware of any inaccuracies please raise an issue in this repo or comment on the gist.

The route stops are sourced from a [static GTFS](https://github.com/Vonter/bmtc-gtfs), however not all routes in the geojson data have stops in the GTFS, as such some routes dont have searchable intermediate stops in the website. This can be fixed by updating the static GTFS used to build the github gist

### Special thanks

- [Namma BMTC](https://bmtcwebportal.amnex.com/commuter/dashboard)
- [Vonter bmtc-gtfs](https://github.com/Vonter/bmtc-gtfs)
- [Leaflet.js](https://leafletjs.com/)
