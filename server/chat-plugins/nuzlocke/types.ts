/**
 * Nuzlocke Simulator — Type Definitions
 */

export interface Scenario {
	id: string;
	name: string;
	generation: number;
	description: string;
	starters: { species: string; level: number }[];
	segments: Segment[];
}

export interface Segment {
	id: string;
	name: string;
	levelCap: number;
	encounters: RouteEncounter[];
	items: string[];     // held items + any bag items (bag items are silently ignored)
	tmMoves: string[];   // move IDs unlocked by TMs/HMs this segment
	battles: TrainerBattle[];
}

export interface RouteEncounter {
	route: string;
	type?: 'gift';
	pokemon: string[];
	levels: [number, number];
}

export interface TrainerBattle {
	id: string;
	trainer: string;
	team: TrainerPokemon[];
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
	shiny: boolean;
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

export type NuzlockeScreen =
	'dashboard' | 'starter' | 'encounters' | 'teambuilding' | 'battle' | 'results' | 'summary';

export interface NuzlockeScenarioCard {
	id: string;
	name: string;
	generation: number;
	description: string;
	segmentCount: number;
	battleCount: number;
	encounterCount: number;
	starters: string[];
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
