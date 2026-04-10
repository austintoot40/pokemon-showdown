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
	encounters: RouteEncounter[];
	gifts: RouteEncounter[];
	items: string[];     // held items + any bag items (bag items are silently ignored)
	tmMoves: string[];   // move IDs unlocked by TMs/HMs this segment
	battles: TrainerBattle[];
}

export interface EncounterEntry {
	species: string;
	rate: number;   // encounter weight; values in a zone should sum to 100
}

export interface ZoneEncounter {
	zone: string;      // exact Bulbapedia zone label: "1F", "B2F", "Grass", "Surfing"
	method: string;    // exact Bulbapedia method string: "Cave", "Grass", "Surfing", "Rock Smash"
	time?: string;     // "Morning" | "Day" | "Night" — only present when rates differ by time of day
	choice?: boolean;  // true for Gift zones where the player selects the species (new format only)
	pokemon: EncounterEntry[];
	requires?: { type: 'hm' | 'item'; name: string };  // explicit prereq (overrides METHOD_PREREQS inference on client)
}

export interface RouteEncounter {
	route: string;
	zones: ZoneEncounter[];
	choice?: boolean;  // if true, player selects the species rather than auto-resolve (gifts only)
}

export interface TrainerBattle {
	id: string;
	trainer: string;
	team: TrainerPokemon[];
	battleType?: 'singles' | 'doubles';
	sprite?: string;
}

export interface TrainerPokemon {
	species: string;
	level: number;
	ability: string;
	moves: string[];
	item: string | null;
}

// ---------------------------------------------------------------------------
// Source-format types (the unresolved form stored in JSON files)
// ---------------------------------------------------------------------------

/** An item or TM whose availability is gated on a move being unlocked first. */
export interface DeferredItem {
	id: string;
	requires: string;  // move name; item defers to the first segment where this move is available
}

/**
 * A named location in the game world. Can be a wild route, a gift source,
 * an item-only location (e.g. gym reward), or any combination.
 *
 * - `zones` absent → item-only location (won't appear in encounters screen)
 * - Gift zones (`method: "Gift"`) coexist with encounter zones on the same location
 * - `choice: true` on a Gift zone → player selects the species rather than auto-resolve
 */
export interface LocationDefinition {
	id: string;
	name?: string;
	zones?: ZoneEncounter[];
	items?: (string | DeferredItem)[];
	tmMoves?: (string | DeferredItem)[];
}

/** Segment as stored in nuzlocke.json — locations and battles are ID references. */
export interface RawSegment {
	id: string;
	name: string;
	locations: string[];   // LocationDefinition IDs
	battles: string[];     // TrainerBattle IDs
}

/** Top-level nuzlocke.json structure. */
export interface RawScenario {
	id: string;
	name: string;
	generation: number;
	description: string;
	color: string;
	pokemon: string;
	starters: { species: string; level: number }[];
	segments: RawSegment[];
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
	caughtZoneIndex?: number;
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
