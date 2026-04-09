/**
 * Nuzlocke Simulator — Type Definitions
 */

export interface Scenario {
	id: string;
	name: string;
	generation: number;
	description: string;
	color: string;
	pokemon: string;
	verified: boolean;
	starters: { species: string; level: number }[];
	segments: Segment[];
}

export interface Segment {
	id: string;
	name: string;
	levelCap: number;
	encounters: Record<string, RouteEncounter[]>;  // keyed by method: walk/surf/oldRod/etc.
	gifts: RouteEncounter[];
	items: string[];     // held items + any bag items (bag items are silently ignored)
	tmMoves: string[];   // move IDs unlocked by TMs/HMs this segment
	battles: TrainerBattle[];
}

export interface EncounterEntry {
	species: string;
	rate: number;   // encounter weight; values in a route should sum to 100
}

export interface RouteEncounter {
	route: string;
	pokemon: EncounterEntry[];
	choice?: boolean;  // if true, player selects the species rather than auto-resolve
}

export interface TrainerBattle {
	id: string;
	trainer: string;
	team: TrainerPokemon[];
	battleType?: 'singles' | 'doubles';
	chained?: boolean;
	sprite?: string;
}

export interface TrainerPokemon {
	species: string;
	level: number;
	ability: string;
	moves: string[];
	item: string | null;
}

export interface OwnedPokemon {
	uid: string;
	species: string;       // current species (post-evolution)
	baseSpecies: string;   // species as caught (pre-evolution)
	nickname: string;
	level: number;
	nature: string;
	ability: string;
	ivs: StatsTable;
	evs: StatsTable;       // all zeros (no EV training)
	moves: string[];       // currently assigned moves (up to 4)
	item: string;          // held item or ''
	gender: string;
	caughtRoute: string;
	alive: boolean;
}

export interface DeadPokemon {
	uid: string;
	species: string;
	nickname: string;
	caughtRoute: string;
	killedBy: string;      // e.g. "Brock's Onix (Rock Tomb)"
	segment: string;
}

export interface StatsTable {
	hp: number;
	atk: number;
	def: number;
	spa: number;
	spd: number;
	spe: number;
}

export interface RandomizerConfig {
	mode: 'shuffle' | 'fully-random';
	bstVariance: 'low' | 'medium' | 'high';
	randomizeItems: boolean;
	seed: number;
}

export interface RandomizerMappings {
	/** Shuffle mode: original species ID → replacement species name */
	speciesMap: Record<string, string>;
	/** Fully Random mode: route name → replacement species name */
	routeMap: Record<string, string>;
	/** Item shuffle: segment ID → shuffled items (only when randomizeItems is true) */
	itemMap: Record<string, string[]>;
	/** Randomized starter species in original slot order */
	starterSpecies: string[];
}

export type NuzlockeScreen =
	'encounters' | 'teambuilding' | 'battle' | 'results' | 'summary';

export interface NuzlockeScenarioCard {
	id: string;
	name: string;
	generation: number;
	description: string;
	segmentCount: number;
	battleCount: number;
	encounterCount: number;
	starters: string[];
	color: string;
	pokemon: string;
	verified: boolean;
}

export interface EvoOption {
	species: string;
	item: string | null;
	type: 'level' | 'trade' | 'item';
}

export interface CompletedRun {
	id: string;
	userId: ID;
	scenarioId: string;
	scenarioName: string;
	outcome: 'victory' | 'wipe';
	date: string;           // ISO date string
	deathCount: number;
	graveyard: DeadPokemon[];
	survivors: { species: string; nickname: string }[];
	finalParty: { species: string; alive: boolean }[];
	finalBattle: string;    // trainer name that ended the run
	segmentIndex: number;   // which segment the run ended on
	ai: string;             // AI difficulty tier used for this run
}
