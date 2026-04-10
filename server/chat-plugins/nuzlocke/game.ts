/**
 * Nuzlocke Simulator — Game State
 */

import { saveGameToRedis, deleteGameFromRedis, loadGameFromRedis, pingRedis } from './redis-store';
import { resolveOneEncounter, resolveChoiceGift, getAvailablePool, getGiftPool, buildStarterPokemon } from './encounters';
import { getLegalMoves, type LegalMove } from './learnsets';
import { listScenarios, getScenario } from './scenarios';
import type { Scenario, Segment, RouteEncounter, OwnedPokemon, DeadPokemon, NuzlockeScreen, NuzlockeScenarioCard, EvoOption, CompletedRun } from './types';
export type { CompletedRun };

/** Returns all wild encounters for a segment. */
export function flatEncounters(segment: Segment): RouteEncounter[] {
	return segment.encounters ?? [];
}

export const nuzlockeGames = new Map<ID, NuzlockeGame>();

/** Pending randomizer previews: computed before run start so the user can see randomized starters. */
export const pendingRandomizers = new Map<ID, {
	scenarioId: string;
	config: import('./types').RandomizerConfig;
	mappings: import('./types').RandomizerMappings;
}>();

export class NuzlockeGame {
	user: ID;
	scenario: Scenario;
	curRoom: NuzlockeScreen;
	inBattle: boolean;
	battleRoomId: string | null;
	nextScreen: NuzlockeScreen | null;
	lastBattleResult: { won: boolean; perfect: boolean; trainerName: string; deaths: DeadPokemon[] } | null;

	currentSegmentIndex: number;
	currentBattleIndex: number;
	box: OwnedPokemon[];
	party: string[];           // UIDs in party
	graveyard: DeadPokemon[];
	items: string[];     // held items accumulated across segments
	tmMoves: string[];   // move IDs unlocked by TMs/HMs across segments
	completedBattles: string[];
	resolvedRoutes: string[];
	settings: { ai: 'game-accurate' | 'smart' | 'competitive'; generation: number };
	partyErrors: Map<string, string>;
	lastCompletedRun: CompletedRun | null;
	randomizerConfig: import('./types').RandomizerConfig | null;
	randomizerMappings: import('./types').RandomizerMappings | null;

	constructor(userID: ID, scenario: Scenario) {
		this.user = userID;
		this.scenario = scenario;
		this.curRoom = 'encounters';
		this.inBattle = false;
		this.battleRoomId = null;
		this.nextScreen = null;
		this.lastBattleResult = null;
		this.currentSegmentIndex = 0;
		this.currentBattleIndex = 0;
		this.box = [];
		this.party = [];
		this.graveyard = [];
		this.items = [];
		this.tmMoves = [];
		this.completedBattles = [];
		this.resolvedRoutes = [];
		this.settings = { ai: 'game-accurate', generation: 9 };
		this.partyErrors = new Map();
		this.lastCompletedRun = null;
		this.randomizerConfig = null;
		this.randomizerMappings = null;
	}

	pickStarter(index: number) {
		const starterDef = this.scenario.starters[index];
		if (!starterDef) throw new Error(`Invalid starter index ${index}`);
		const starter = buildStarterPokemon(starterDef.species, starterDef.level);
		this.box.push(starter);
		this.addToParty(starter.uid);
	}

	/** Called when entering a new segment: adds items/TMs and auto-resolves non-choice gift encounters. */
	resolveSegmentStart() {
		const segment = this.scenario.segments[this.currentSegmentIndex];
		if (!segment) return;
		const segmentItems = this.randomizerMappings?.itemMap?.[segment.id] ?? segment.items;
		this.items.push(...segmentItems);
		this.tmMoves.push(...(segment.tmMoves ?? []));
		for (const route of segment.gifts ?? []) {
			if (route.choice) continue;  // Player must choose manually
			const pokemon = resolveOneEncounter(route, this.box, this.graveyard as any, segment.levelCap, this.randomizerMappings);
			if (!pokemon) continue; // all dupes — skip
			this.box.push(pokemon);
			this.addToParty(pokemon.uid);
			this.resolvedRoutes.push(route.route);
		}
	}

	/** Called by /nuzlocke choosegift: resolves a choice gift to the player's selected species. */
	resolveGiftChoice(giftIndex: number, speciesId: string) {
		const segment = this.scenario.segments[this.currentSegmentIndex];
		if (!segment) return;
		const gifts = segment.gifts ?? [];
		const route = gifts[giftIndex];
		if (!route || !route.choice) return;
		if (this.resolvedRoutes.includes(route.route)) return;
		const entry = getGiftPool(route).find(e => toID(e.species) === speciesId);
		if (!entry) return;
		const pokemon = resolveChoiceGift(route, entry.species, segment.levelCap);
		this.box.push(pokemon);
		this.addToParty(pokemon.uid);
		this.resolvedRoutes.push(route.route);
	}

	/** Called by /nuzlocke encounter <routeIndex> <zoneIndex>: rolls a zone from a wild route. */
	resolveOneRoute(routeIndex: number, zoneIndex: number) {
		const segment = this.scenario.segments[this.currentSegmentIndex];
		if (!segment) return;
		const route = flatEncounters(segment)[routeIndex];
		if (!route) return;
		if (this.resolvedRoutes.includes(route.route)) return;
		const pokemon = resolveOneEncounter(route, zoneIndex, this.box, this.graveyard as any, segment.levelCap, this.randomizerMappings);
		this.resolvedRoutes.push(route.route);
		if (!pokemon) return; // all dupes — route resolved with no encounter
		pokemon.caughtZoneIndex = zoneIndex;
		this.box.push(pokemon);
		this.addToParty(pokemon.uid);
	}

	get currentSegment() {
		return this.scenario.segments[this.currentSegmentIndex] ?? null;
	}

	get currentBattle() {
		return this.currentSegment?.battles[this.currentBattleIndex] ?? null;
	}

	getPokemon(uid: string): OwnedPokemon | null {
		return this.box.find(p => p.uid === uid) ?? null;
	}

	addToParty(uid: string) {
		if (this.party.includes(uid)) return;
		if (this.party.length >= 6) return;
		if (!this.box.find(p => p.uid === uid && p.alive)) return;
		this.party.push(uid);
	}

	removeFromParty(uid: string) {
		this.party = this.party.filter(id => id !== uid);
	}

	swapPartySlots(indexA: number, indexB: number) {
		if (indexA < 0 || indexB < 0 || indexA >= this.party.length || indexB >= this.party.length) return;
		[this.party[indexA], this.party[indexB]] = [this.party[indexB], this.party[indexA]];
	}

	setMoves(uid: string, moves: string[]) {
		const pokemon = this.getPokemon(uid);
		if (!pokemon) return;
		pokemon.moves = moves.slice(0, 4).filter(Boolean);
	}

	setItem(uid: string, item: string) {
		// Remove item from any other Pokemon first (each item can only be on one Pokemon)
		for (const p of this.box) {
			if (p.item === item) p.item = '';
		}
		const pokemon = this.getPokemon(uid);
		if (pokemon) pokemon.item = item;
	}

	setNickname(uid: string, name: string) {
		const pokemon = this.getPokemon(uid);
		if (pokemon) pokemon.nickname = name.slice(0, 12).trim() || pokemon.species;
	}

	/** Maps evoRegion values to the generation number where those regional forms originate. */
	static readonly REGION_GEN: {[region: string]: number} = {
		Alola: 7,
		Galar: 8,
		Hisui: 8,
		Paldea: 9,
	};

	/** Returns all evolutions currently available for a Pokemon given inventory and level cap. */
	getAvailableEvolutions(uid: string): EvoOption[] {
		const pokemon = this.getPokemon(uid);
		if (!pokemon || !pokemon.alive) return [];
		const levelCap = this.currentSegment?.levelCap ?? 0;
		const dexSpecies = Dex.species.get(pokemon.species);
		const results: EvoOption[] = [];

		for (const evoName of dexSpecies.evos) {
			const evo = Dex.species.get(evoName);
			if (!evo.exists) continue;
			// Skip regional forms that don't belong to this scenario's generation.
			if (evo.evoRegion) {
				const regionGen = NuzlockeGame.REGION_GEN[evo.evoRegion];
				if (!regionGen || this.scenario.generation !== regionGen) continue;
			}
			const evoType = evo.evoType;
			if (!evoType || evoType === 'levelFriendship' || evoType === 'levelExtra') {
				if ((evo.evoLevel ?? 0) <= levelCap) {
					results.push({ species: evo.name, item: null, type: 'level' });
				}
			} else if (evoType === 'trade') {
				if (evo.evoItem) {
					if (this.items.includes(evo.evoItem)) {
						results.push({ species: evo.name, item: evo.evoItem, type: 'trade' });
					}
				} else {
					results.push({ species: evo.name, item: null, type: 'trade' });
				}
			} else if (evoType === 'useItem' && evo.evoItem) {
				if (this.items.includes(evo.evoItem)) {
					results.push({ species: evo.name, item: evo.evoItem, type: 'item' });
				}
			}
		}
		return results;
	}

	/** Evolve a Pokemon. Consumes the evolution item from inventory if applicable. */
	evolve(uid: string, targetSpecies: string) {
		const pokemon = this.getPokemon(uid);
		if (!pokemon || !pokemon.alive) return;
		const evos = this.getAvailableEvolutions(uid);
		const target = evos.find(e => toID(e.species) === toID(targetSpecies));
		if (!target) return;
		if (target.item) {
			const idx = this.items.indexOf(target.item);
			if (idx === -1) return;
			this.items.splice(idx, 1);
		}
		if (toID(pokemon.nickname) === toID(pokemon.species)) pokemon.nickname = target.species;
		pokemon.species = target.species;
		const dexSpecies = Dex.species.get(target.species);
		pokemon.ability = dexSpecies.abilities[0];
	}

	/** Remove party members that have died or are no longer in box */
	cleanParty() {
		this.party = this.party.filter(uid => this.box.find(p => p.uid === uid && p.alive));
	}

	/** Add all alive box Pokemon to party (up to 6), skipping those already in party */
	autoFillParty() {
		for (const p of this.box) {
			if (p.alive) this.addToParty(p.uid);
		}
	}

	/** Advances battle/segment indices and resolves encounters. Returns the next screen. */
	advanceAfterWin(): NuzlockeScreen {
		const segment = this.currentSegment!;
		const wasChained = this.currentBattle?.chained ?? false;
		this.completedBattles.push(this.currentBattle!.id);
		this.currentBattleIndex++;

		if (this.currentBattleIndex >= segment.battles.length) {
			// Segment complete — move to next segment
			this.currentSegmentIndex++;
			this.currentBattleIndex = 0;

			if (this.currentSegmentIndex >= this.scenario.segments.length) {
				// All segments done — victory!
				return 'summary';
			} else {
				// New segment: add items/gifts; wild routes are player-initiated
				this.resolvedRoutes = [];
				this.resolveSegmentStart();
				return wasChained ? 'battle' : 'encounters';
			}
		} else {
			// More battles in this segment
			this.cleanParty();
			return wasChained ? 'battle' : 'teambuilding';
		}
	}

	toJSON() {
		const { partyErrors, scenario, ...rest } = this as any;
		return { ...rest, scenarioId: this.scenario.id };
	}

	goToPage(target: NuzlockeScreen) {
		this.curRoom = target;
		navigateToNuzlocke(this.user);
		pushNuzlockeStatus(this.user, this);
		saveGame(this);
	}
}

// Full game state delivered to the view-nuzlocke room (|nuzlockestate| message).
// Drives all game screens in the Preact panel.
export interface NuzlockePanelPayload {
	curScreen: NuzlockeScreen;

	// Scenario metadata (null when no active run)
	scenarioId: string | null;
	scenarioName: string | null;
	scenarioDescription: string | null;
	generation: number;

	// Progress
	currentSegmentIndex: number;
	totalSegments: number;
	currentBattleIndex: number;
	completedBattles: string[];

	// Current segment (null when no active run)
	segment: {
		name: string;
		levelCap: number;
		items: string[];
		tmMoves: string[];
		encounters: Record<string, import('./types').RouteEncounter[]>;
		gifts: import('./types').RouteEncounter[];
		battles: import('./types').TrainerBattle[];
	} | null;

	// Player state
	box: OwnedPokemon[];
	party: string[];
	graveyard: DeadPokemon[];
	items: string[];
	tmMoves: string[];
	resolvedRoutes: string[];

	// Precomputed derived data
	legalMoves: Record<string, LegalMove[]>;
	availableEvolutions: Record<string, EvoOption[]>;

	// Battle result
	lastBattleResult: {
		won: boolean;
		perfect: boolean;
		trainerName: string;
		deaths: DeadPokemon[];
	} | null;
	nextScreen: NuzlockeScreen | null;

	// Segment name lookup for graveyard display
	segmentNames: Record<string, string>;

	// Dashboard data
	scenarios: NuzlockeScenarioCard[];

	// Active battle room (null when no battle in progress)
	battleRoomId: string | null;

	// Set when a run just ended — client saves this to localStorage
	completedRun: CompletedRun | null;
}

// Lightweight run summary delivered globally (|updatenuzlocke| message).
// Drives the main menu widget: active run banner, scenario picker, past runs.
export interface NuzlockeMenuPayload {
	activeRun: {
		scenarioId: string;
		scenarioName: string;
		segmentName: string;
		segmentIndex: number;
		totalSegments: number;
		deaths: number;
		partySpecies: string[];
		curRoom: NuzlockeScreen;
		ai: string;
	} | null;
	scenarios: NuzlockeScenarioCard[];
	/** Set while the user has a pending randomizer preview but hasn't started the run yet. */
	randomizerPreview: {
		scenarioId: string;
		starters: string[];
	} | null;
}

export function pushNuzlockeStatus(userID: ID, game: NuzlockeGame | null) {
	const user = Users.get(userID);
	if (!user) return;
	const pending = pendingRandomizers.get(userID);
	const payload: NuzlockeMenuPayload = {
		activeRun: game ? {
			scenarioId: game.scenario.id,
			scenarioName: game.scenario.name,
			segmentName: game.currentSegment?.name ?? '',
			segmentIndex: game.currentSegmentIndex,
			totalSegments: game.scenario.segments.length,
			deaths: game.graveyard.length,
			partySpecies: game.party.map(uid => game.getPokemon(uid)?.species ?? '').filter(Boolean),
			curRoom: game.curRoom,
			ai: game.settings.ai,
		} : null,
		scenarios: buildScenarioCards(),
		randomizerPreview: pending ? {
			scenarioId: pending.scenarioId,
			starters: pending.mappings.starterSpecies,
		} : null,
	};
	user.send(`|updatenuzlocke|${JSON.stringify(payload)}`);
}

function buildScenarioCards(): NuzlockeScenarioCard[] {
	return listScenarios().map(s => ({
		id: s.id,
		name: s.name,
		generation: s.generation,
		description: s.description,
		segmentCount: s.segments.length,
		battleCount: s.segments.reduce((n, seg) => n + seg.battles.length, 0),
		encounterCount: s.segments.reduce((n, seg) => n + flatEncounters(seg).length, 0),
		starters: s.starters.map(st => st.species),
		color: s.color,
		pokemon: s.pokemon,
		verified: s.verified,
	}));
}

function applyMappingsToRoutes(
	routes: RouteEncounter[],
	m: import('./types').RandomizerMappings
): RouteEncounter[] {
	return routes.map(route => {
		const routeOverride = m.routeMap[route.route];
		if (routeOverride) {
			return { ...route, zones: route.zones.map(z => ({ ...z, pokemon: [{ species: routeOverride, rate: 1 }] })) };
		}
		if (Object.keys(m.speciesMap).length > 0) {
			return { ...route, zones: route.zones.map(z => ({
				...z,
				pokemon: z.pokemon.map(e => ({ ...e, species: m.speciesMap[toID(e.species)] ?? e.species })),
			})) };
		}
		return route;
	});
}

export function serializeGameState(game: NuzlockeGame): NuzlockePanelPayload {
	const scenarios = buildScenarioCards();

	// Precompute legal moves for all alive box pokemon
	const legalMoves: Record<string, LegalMove[]> = {};
	if (game.currentSegment) {
		for (const p of game.box) {
			if (p.alive) {
				legalMoves[p.uid] = getLegalMoves(p, game.currentSegment.levelCap, game.scenario.generation, game.tmMoves);
			}
		}
	}

	// Precompute available evolutions for all alive box pokemon
	const availableEvolutions: Record<string, EvoOption[]> = {};
	for (const p of game.box) {
		if (p.alive) availableEvolutions[p.uid] = game.getAvailableEvolutions(p.uid);
	}

	// Segment name lookup for graveyard display
	const segmentNames: Record<string, string> = {};
	for (const seg of game.scenario.segments) {
		segmentNames[seg.id] = seg.name;
	}

	const seg = game.currentSegment;
	const m = game.randomizerMappings;
	return {
		curScreen: game.curRoom,
		scenarioId: game.scenario.id,
		scenarioName: game.scenario.name,
		scenarioDescription: game.scenario.description,
		generation: game.scenario.generation,
		currentSegmentIndex: game.currentSegmentIndex,
		totalSegments: game.scenario.segments.length,
		currentBattleIndex: game.currentBattleIndex,
		completedBattles: game.completedBattles,
		segment: seg ? {
			name: seg.name,
			levelCap: seg.levelCap,
			items: seg.items,
			tmMoves: seg.tmMoves ?? [],
			encounters: m ? applyMappingsToRoutes(seg.encounters ?? [], m) : (seg.encounters ?? []),
			gifts: m ? applyMappingsToRoutes(seg.gifts ?? [], m) : (seg.gifts ?? []),
			battles: seg.battles,
		} : null,
		box: game.box,
		party: game.party,
		graveyard: game.graveyard,
		items: game.items,
		tmMoves: game.tmMoves,
		resolvedRoutes: game.resolvedRoutes,
		legalMoves,
		availableEvolutions,
		lastBattleResult: game.lastBattleResult,
		nextScreen: game.nextScreen,
		segmentNames,
		scenarios,
		battleRoomId: game.battleRoomId,
		completedRun: game.lastCompletedRun,
	};
}

export function pushNuzlockeState(userID: ID, game: NuzlockeGame) {
	const user = Users.get(userID);
	if (!user) return;
	const payload = JSON.stringify(serializeGameState(game));
	user.send(`>view-nuzlocke\n|nuzlockestate|${payload}`);
}

export function closeNuzlockePanel(userID: ID) {
	const user = Users.get(userID);
	if (!user) return;
	user.send(`>view-nuzlocke\n|deinit|`);
}


export function navigateToNuzlocke(userID: ID) {
	const user = Users.get(userID);
	if (!user) return;
	for (const conn of user.connections) {
		void Chat.parse('/join view-nuzlocke', null, user, conn);
	}
}

export function recordCompletedRun(game: NuzlockeGame, outcome: 'victory' | 'wipe', finalBattle?: string) {
	const run: CompletedRun = {
		id: `${game.user}-${Date.now()}`,
		userId: game.user,
		scenarioId: game.scenario.id,
		scenarioName: game.scenario.name,
		outcome,
		date: new Date().toISOString(),
		deathCount: game.graveyard.length,
		graveyard: [...game.graveyard],
		survivors: game.party
			.map(uid => game.getPokemon(uid))
			.filter((p): p is OwnedPokemon => p != null && p.alive)
			.map(p => ({ species: p.species, nickname: p.nickname })),
		finalParty: game.party
			.map(uid => game.getPokemon(uid))
			.filter((p): p is OwnedPokemon => p != null)
			.map(p => ({ species: p.species, alive: p.alive })),
		finalBattle: finalBattle ?? game.currentBattle?.trainer ?? '',
		segmentIndex: game.currentSegmentIndex,
		ai: game.settings.ai,
	};
	game.lastCompletedRun = run;
}

export { pingRedis } from './redis-store';

export function saveGame(game: NuzlockeGame) {
	void saveGameToRedis(game);
}

export function deleteGame(userId: ID) {
	void deleteGameFromRedis(userId);
}

export async function loadUserGame(userId: ID): Promise<NuzlockeGame | null> {
	const raw = await loadGameFromRedis(userId);
	if (!raw) return null;
	try {
		const gameData = JSON.parse(raw);
		const scenario = getScenario(gameData.scenarioId);
		if (!scenario) return null;
		const game = Object.assign(new NuzlockeGame(userId, scenario), gameData, { scenario });
		// Battle rooms don't survive server restarts — put the player back at teambuilding
		if (game.inBattle) {
			game.inBattle = false;
			game.battleRoomId = null;
			game.curRoom = 'teambuilding';
		}
		nuzlockeGames.set(userId, game);
		return game;
	} catch {
		return null;
	}
}
