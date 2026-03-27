#!/usr/bin/env node
/**
 * Fetches all source GeoJSON files and computes their bounding boxes.
 * Output: static/data/source-bboxes.json
 * Format: { "sourceKey": [minLng, minLat, maxLng, maxLat] }
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcesPath = resolve(__dirname, '../static/data/sources.json');
const outPath = resolve(__dirname, '../static/data/source-bboxes.json');

const sources = JSON.parse(readFileSync(sourcesPath, 'utf-8'));
const bboxes = {};

for (const [key, url] of Object.entries(sources)) {
    process.stdout.write(`Fetching ${key}... `);
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
        for (const feature of data.features) {
            const [lng, lat] = feature.geometry.coordinates;
            if (lng < minLng) minLng = lng;
            if (lat < minLat) minLat = lat;
            if (lng > maxLng) maxLng = lng;
            if (lat > maxLat) maxLat = lat;
        }

        bboxes[key] = [
            parseFloat(minLng.toFixed(6)),
            parseFloat(minLat.toFixed(6)),
            parseFloat(maxLng.toFixed(6)),
            parseFloat(maxLat.toFixed(6))
        ];
        console.log(`[${bboxes[key].join(', ')}]`);
    } catch (e) {
        console.error(`FAILED: ${e.message}`);
    }
}

writeFileSync(outPath, JSON.stringify(bboxes, null, 2));
console.log(`\nWritten to ${outPath}`);