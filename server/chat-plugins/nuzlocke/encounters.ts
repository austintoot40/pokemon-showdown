/**
 * Nuzlocke Simulator — Encounter Resolution
 */

import type { OwnedPokemon, RouteEncounter, Segment } from './types';

const NATURES = [
	'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty',
	'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
	'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive',
	'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
	'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky',
];

function randomInt(min: number, max: number): number {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomIVs(): OwnedPokemon['ivs'] {
	return {
		hp: randomInt(0, 31),
		atk: randomInt(0, 31),
		def: randomInt(0, 31),
		spa: randomInt(0, 31),
		spd: randomInt(0, 31),
		spe: randomInt(0, 31),
	};
}

function pickAbility(species: import('../../../sim/dex-types').Species): string {
	const options: string[] = [species.abilities[0]];
	if (species.abilities[1]) options.push(species.abilities[1]);
	// Never pick hidden ability (abilities['H'])
	return options[Math.floor(Math.random() * options.length)];
}


/** Returns the non-duplicate species pool for a route given current ownership. Empty = all dupes. */
export function getAvailablePool(
	routePokemon: string[],
	box: OwnedPokemon[],
	graveyard: OwnedPokemon[]
): string[] {
	const ownedSpecies = new Set([
		...box.map(p => Dex.species.get(p.baseSpecies).baseSpecies),
		...graveyard.map(p => Dex.species.get(p.species).baseSpecies),
	]);
	return routePokemon.filter(s => !ownedSpecies.has(Dex.species.get(s).baseSpecies));
}

export function resolveOneEncounter(
	route: RouteEncounter,
	box: OwnedPokemon[],
	graveyard: OwnedPokemon[],
	levelCap: number
): OwnedPokemon {
	// Use filtered pool; if all dupes fall back to full pool
	const pool = getAvailablePool(route.pokemon, box, graveyard);
	const finalPool = pool.length > 0 ? pool : route.pokemon;
	const speciesName = finalPool[Math.floor(Math.random() * finalPool.length)];
	const level = randomInt(route.levels[0], route.levels[1]);
	return buildEncounter(speciesName, level, route.route, levelCap);
}

function buildEncounter(
	speciesName: string,
	level: number,
	route: string,
	levelCap: number
): OwnedPokemon {
	const baseSpecies = Dex.species.get(speciesName).name;
	const dexSpecies = Dex.species.get(speciesName);
	const ability = pickAbility(dexSpecies);
	const nature = NATURES[Math.floor(Math.random() * NATURES.length)];
	const gender = dexSpecies.gender === 'M' ? 'M'
		: dexSpecies.gender === 'F' ? 'F'
		: dexSpecies.gender === 'N' ? 'N'
		: Math.random() < 0.5 ? 'M' : 'F';
	const uid = `${toID(dexSpecies.name)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

	return {
		uid,
		species: dexSpecies.name,
		baseSpecies,
		nickname: dexSpecies.name,
		level: levelCap,
		nature,
		ability,
		ivs: randomIVs(),
		evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
		moves: [],
		item: '',
		gender,
		shiny: Math.random() < 1 / 4096,
		caughtRoute: route,
		alive: true,
	};
}

export function buildStarterPokemon(speciesName: string, level: number): OwnedPokemon {
	const dexSpecies = Dex.species.get(speciesName);
	const ability = pickAbility(dexSpecies);
	const nature = NATURES[Math.floor(Math.random() * NATURES.length)];
	const uid = `${toID(dexSpecies.name)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

	return {
		uid,
		species: dexSpecies.name,
		baseSpecies: dexSpecies.name,
		nickname: dexSpecies.name,
		level,
		nature,
		ability,
		ivs: randomIVs(),
		evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
		moves: [],
		item: '',
		gender: dexSpecies.gender === 'M' ? 'M'
			: dexSpecies.gender === 'F' ? 'F'
			: dexSpecies.gender === 'N' ? 'N'
			: Math.random() < 0.5 ? 'M' : 'F',
		shiny: false,
		caughtRoute: 'Starter',
		alive: true,
	};
}
