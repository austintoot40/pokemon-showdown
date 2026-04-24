#!/usr/bin/env node
// Migrates encounter zone methods in all locations.json files.
// Collapses all non-Gift/Trade method strings to 'Standard' and promotes
// implicit prerequisites (Surf, Dive, etc.) into explicit `requires` entries.

const fs = require('fs');
const path = require('path');

const IMPLICIT_PREREQS = {
	'Surf':       { type: 'move', name: 'Surf' },
	'Dive':       { type: 'move', name: 'Dive' },
	'Rock Smash': { type: 'move', name: 'Rock Smash' },
	'Headbutt':   { type: 'move', name: 'Headbutt' },
	'Fish Old':   { type: 'item', name: 'Old Rod' },
	'Fish Good':  { type: 'item', name: 'Good Rod' },
	'Fish Super': { type: 'item', name: 'Super Rod' },
};

const scenariosDir = path.join(__dirname, '../data/nuzlocke-scenarios');
const scenarios = fs.readdirSync(scenariosDir, { withFileTypes: true })
	.filter(d => d.isDirectory())
	.map(d => d.name);

for (const scenario of scenarios) {
	const file = path.join(scenariosDir, scenario, 'locations.json');
	if (!fs.existsSync(file)) continue;

	const locations = JSON.parse(fs.readFileSync(file, 'utf8'));
	let changed = 0;

	for (const loc of locations) {
		if (!Array.isArray(loc.zones)) continue;
		for (const zone of loc.zones) {
			if (zone.method === 'Gift' || zone.method === 'Trade') continue;
			const implicit = IMPLICIT_PREREQS[zone.method];
			if (implicit && !zone.requires) {
				zone.requires = implicit;
			}
			if (zone.method !== 'Standard') {
				zone.method = 'Standard';
				changed++;
			}
		}
	}

	fs.writeFileSync(file, JSON.stringify(locations, null, 2) + '\n');
	console.log(`${scenario}: ${changed} zone(s) updated`);
}

console.log('Done.');
