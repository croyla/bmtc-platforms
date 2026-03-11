# BMTC Platforms
### Platform, bus route, stop web-app for bus stands in Bengaluru
A mobile-friendly single-page PWA that facilitates easy navigation of bus stands in Bengaluru: 

#### Setup

- To set up the project, for development or otherwise, first run `yarn install`
- Once the packages have been installed, `yarn dev` will run the applet locally, while `yarn build` will create a build folder.

#### Translations

Translation strings for data elements are provided with the data, while other translations are stored in `messages/`. 
Translation related settings (e.g default locale) are stored in `project.inlang/settings.json`.

#### Data

Data is sourced from the bmtc-platforms-geojson github repo and the official majestic repo, to facilitate this there is a `static/sources.json`

##### AI Disclaimer: Certain project components have been created or modified by generative AI.