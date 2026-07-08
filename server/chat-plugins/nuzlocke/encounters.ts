/**
 * Nuzlocke Simulator — Encounter Resolution
 */

import type { EncounterEntry, OwnedPokemon, RandomizerConfig, RandomizerMappings, RouteEncounter, Scenario } from './types';

/** Mulberry32 — a fast, seedable PRNG returning values in [0, 1). */
function mulberry32(seed: number): () => number {
	return function () {
		seed |= 0; seed = seed + 0x6D2B79F5 | 0;
		let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}

function seededShuffle<T>(arr: T[], rng: () => number): T[] {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

function withinBstVariance(origBst: number, newBst: number, variance: RandomizerConfig['bstVariance']): boolean {
	if (variance === 'high') return true;
	const ratio = Math.abs(newBst - origBst) / (origBst || 1);
	return variance === 'low' ? ratio <= 0.33 : ratio <= 0.66;
}

/** Returns species names for the randomizer candidate pool based on dexPool setting.
 *  regional = only species introduced in the scenario's own generation
 *  national = all species up to and including the scenario's generation (default)
 *  all      = all species from every generation
 */
function getGenPool(generation: number, dexPool: RandomizerConfig['dexPool']): string[] {
	return (Dex.species.all() as import('../../../sim/dex-species').Species[])
		.filter(s => {
			if (s.isNonstandard || s.name !== s.baseSpecies) return false;
			if (dexPool === 'regional') return s.gen === generation;
			if (dexPool === 'national') return s.gen <= generation;
			return true; // 'all'
		})
		.map(s => s.name);
}

/**
 * Pre-computes the encounter and item mappings for a randomized run.
 * The result is stored in the game state (persisted to Redis) so randomization
 * stays consistent across page reloads and server restarts.
 */
export function buildRandomizerMappings(scenario: Scenario, config: RandomizerConfig): RandomizerMappings {
	const rng = mulberry32(config.seed);
	const speciesMap: Record<string, string> = {};
	const routeMap: Record<string, string[]> = {};

	const candidates = seededShuffle(getGenPool(scenario.generation, config.dexPool), rng);

	if (config.mode === 'shuffle') {
		// Collect all unique original species from starters, routes, and gifts across all segments
		const origSpeciesSet = new Set<string>();
		for (const s of scenario.starters) origSpeciesSet.add(toID(s.species));
		for (const seg of scenario.segments) {
			for (const route of seg.encounters ?? []) {
				for (const zone of route.zones) {
					for (const e of zone.pokemon) origSpeciesSet.add(toID(e.species));
				}
			}
			for (const route of seg.gifts ?? []) {
				for (const zone of route.zones) {
					for (const e of zone.pokemon) origSpeciesSet.add(toID(e.species));
				}
			}
		}
		const origSpecies = [...origSpeciesSet].sort();

		// Assign each original species a replacement from the shuffled candidate pool
		const used = new Set<string>();
		for (const orig of origSpecies) {
			const origBst = (Dex.species.get(orig) as import('../../../sim/dex-species').Species).bst ?? 0;
			const getBst = (c: string) => (Dex.species.get(c) as import('../../../sim/dex-species').Species).bst ?? 0;
			let assigned =
				candidates.find(c => !used.has(c) && withinBstVariance(origBst, getBst(c), config.bstVariance)) ??
				candidates.find(c => !used.has(c));
			if (!assigned) {
				// Pool exhausted — allow repeats, preferring BST match
				const fallback = candidates.filter(c => withinBstVariance(origBst, getBst(c), config.bstVariance));
				assigned = (fallback.length ? fallback : candidates)[Math.floor(rng() * (fallback.length || candidates.length))] ?? orig;
			}
			speciesMap[orig] = assigned;
			used.add(assigned);
		}
	} else {
		// Fully Random: independently assign a replacement for every original slot in every zone
		for (const seg of scenario.segments) {
			const allRoutes: RouteEncounter[] = [
				...(seg.encounters ?? []),
				...(seg.gifts ?? []),
			];
			for (const route of allRoutes) {
				route.zones.forEach((zone, zoneIndex) => {
					const key = `${route.route}::${zoneIndex}`;
					if (routeMap[key]) return; // already assigned (same route name in multiple segments)
					routeMap[key] = zone.pokemon.map(e => {
						const origBst = (Dex.species.get(e.species) as import('../../../sim/dex-species').Species).bst ?? 0;
						const pool = candidates.filter(c => withinBstVariance(origBst, (Dex.species.get(c) as import('../../../sim/dex-species').Species).bst ?? 0, config.bstVariance));
						return (pool.length ? pool : candidates)[Math.floor(rng() * (pool.length || candidates.length))];
					});
				});
			}
		}
	}

	// Compute randomized starters
	let starterSpecies: string[];
	if (config.mode === 'shuffle') {
		starterSpecies = scenario.starters.map(s => speciesMap[toID(s.species)] ?? s.species);
	} else {
		starterSpecies = scenario.starters.map(() => {
			const pick = (candidates.length ? candidates : ['Bulbasaur'])[Math.floor(rng() * candidates.length)];
			return pick;
		});
	}

	return { speciesMap, routeMap, starterSpecies };
}

/** Applies randomizer mappings to a route, remapping every zone's pokemon entries. */
export function applyRouteMapping(route: RouteEncounter, mappings: RandomizerMappings): RouteEncounter {
	return {
		...route,
		zones: route.zones.map((zone, zoneIndex) => {
			const override = mappings.routeMap[`${route.route}::${zoneIndex}`];
			if (override) {
				return { ...zone, pokemon: zone.pokemon.map((e, i) => ({ ...e, species: override[i] ?? e.species })) };
			}
			if (Object.keys(mappings.speciesMap).length > 0) {
				return { ...zone, pokemon: zone.pokemon.map(e => ({ ...e, species: mappings.speciesMap[toID(e.species)] ?? e.species })) };
			}
			return zone;
		}),
	};
}

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

function pickAbility(species: import('../../../sim/dex-species').Species): string {
	const options: string[] = [species.abilities[0]];
	if (species.abilities[1]) options.push(species.abilities[1]);
	// Never pick hidden ability (abilities['H'])
	return options[Math.floor(Math.random() * options.length)];
}


/** Walks up the prevo chain to return the root species of the evolutionary line. */
function getEvoRoot(speciesName: string): string {
	let species = Dex.species.get(speciesName);
	while (species.prevo) {
		species = Dex.species.get(species.prevo);
	}
	return species.id;
}

/** Returns the non-duplicate entries for a route given current ownership. Empty = all dupes. */
export function getAvailablePool(
	entries: EncounterEntry[],
	box: OwnedPokemon[],
	graveyard: OwnedPokemon[]
): EncounterEntry[] {
	const ownedRoots = new Set([
		...box.map(p => getEvoRoot(p.species)),
		...graveyard.map(p => getEvoRoot(p.species)),
	]);
	return entries.filter(e => !ownedRoots.has(getEvoRoot(e.species)));
}

/** Picks a species from entries using weighted random selection. */
function weightedPick(entries: EncounterEntry[]): string {
	const total = entries.reduce((sum, e) => sum + e.rate, 0);
	let roll = Math.random() * total;
	for (const entry of entries) {
		roll -= entry.rate;
		if (roll <= 0) return entry.species;
	}
	return entries[entries.length - 1].species; // floating-point safety fallback
}

/** Resolves a choice gift to a specific species chosen by the player. */
export function resolveChoiceGift(
	route: RouteEncounter,
	species: string,
	levelCap: number
): OwnedPokemon {
	return buildEncounter(species, route.route, levelCap);
}

/** Returns all pokemon entries across all zones of a gift route. */
export function getGiftPool(route: RouteEncounter): import('./types').EncounterEntry[] {
	return route.zones.flatMap(z => z.pokemon);
}

export function resolveOneEncounter(
	route: RouteEncounter,
	zoneIndex: number,
	box: OwnedPokemon[],
	graveyard: OwnedPokemon[],
	levelCap: number,
	mappings?: RandomizerMappings | null
): OwnedPokemon | null {
	const mappedRoute = mappings ? applyRouteMapping(route, mappings) : route;
	const zone = mappedRoute.zones[zoneIndex];
	if (!zone) return null;
	const entries = zone.pokemon;

	const pool = getAvailablePool(entries, box, graveyard);
	if (!pool.length) return null; // all dupes — nothing to encounter
	const speciesName = weightedPick(pool);
	return buildEncounter(speciesName, route.route, levelCap);
}

function buildEncounter(
	speciesName: string,
	route: string,
	level: number
): OwnedPokemon {
	const dexSpecies = Dex.species.get(speciesName);
	const ability = pickAbility(dexSpecies);
	const nature = NATURES[Math.floor(Math.random() * NATURES.length)];
	const gender = dexSpecies.gender === 'M' ? 'M'
		: dexSpecies.gender === 'F' ? 'F'
		: dexSpecies.gender === 'N' ? 'N'
		: Math.random() < (dexSpecies.genderRatio?.M ?? 0.5) ? 'M' : 'F';
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
		gender,
		caughtRoute: route,
		alive: true,
	};
}

export function buildStarterPokemon(speciesName: string, level: number): OwnedPokemon {
	return buildEncounter(speciesName, 'Starter', level);
}
