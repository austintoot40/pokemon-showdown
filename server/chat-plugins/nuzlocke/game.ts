/**
 * Nuzlocke Simulator — Game State
 */

import { FS } from '../../../lib';
import { resolveOneEncounter, getAvailablePool, buildStarterPokemon } from './encounters';
import { getLegalMoves, type LegalMove } from './learnsets';
import { listScenarios } from './scenarios';
import type { Scenario, OwnedPokemon, DeadPokemon, NuzlockeScreen, NuzlockeScenarioCard, EvoOption, CompletedRun } from './types';
export type { CompletedRun };

export const nuzlockeGames = new Map<ID, NuzlockeGame>();
export const completedRuns: CompletedRun[] = [];
export const aiPreferences = new Map<ID, string>();

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
	settings: { ai: 'random' | 'game-accurate' | 'smart' | 'competitive'; mechanics: 'classic' | 'modern' };
	partyErrors: Map<string, string>;

	constructor(userID: ID, scenario: Scenario) {
		this.user = userID;
		this.scenario = scenario;
		this.curRoom = 'intro';
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
		this.settings = { ai: 'random', mechanics: 'classic' };
		this.partyErrors = new Map();
	}

	pickStarter(index: number) {
		const starterDef = this.scenario.starters[index];
		if (!starterDef) throw new Error(`Invalid starter index ${index}`);
		const starter = buildStarterPokemon(starterDef.species, starterDef.level);
		this.box.push(starter);
		this.addToParty(starter.uid);
	}

	/** Called when entering a new segment: adds items/TMs and auto-resolves gift encounters. */
	resolveSegmentStart() {
		const segment = this.scenario.segments[this.currentSegmentIndex];
		if (!segment) return;
		this.items.push(...segment.items);
		this.tmMoves.push(...(segment.tmMoves ?? []));
		for (const route of segment.encounters) {
			if (route.type !== 'gift') continue;
			for (const speciesName of route.pokemon) {
				const pokemon = resolveOneEncounter(route, this.box, this.graveyard as any, segment.levelCap);
				this.box.push(pokemon);
				this.addToParty(pokemon.uid);
			}
			this.resolvedRoutes.push(route.route);
		}
	}

	/** Called by /nuzlocke encounter <routeIndex>: rolls a single wild route. */
	resolveOneRoute(routeIndex: number) {
		const segment = this.scenario.segments[this.currentSegmentIndex];
		if (!segment) return;
		const route = segment.encounters[routeIndex];
		if (!route || route.type === 'gift') return;
		if (this.resolvedRoutes.includes(route.route)) return;
		const pokemon = resolveOneEncounter(route, this.box, this.graveyard as any, segment.levelCap);
		this.box.push(pokemon);
		this.addToParty(pokemon.uid);
		this.resolvedRoutes.push(route.route);
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
			const evoType = evo.evoType;
			if (!evoType || evoType === 'levelUp' || evoType === 'levelFriendship' || evoType === 'levelExtra') {
				if ((evo.evoLevel ?? 0) <= levelCap) {
					results.push({ species: evo.name, item: null, type: 'level' });
				}
			} else if (evoType === 'trade') {
				results.push({ species: evo.name, item: null, type: 'trade' });
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
				return 'encounters';
			}
		} else {
			// More battles in this segment
			this.cleanParty();
			return 'teambuilding';
		}
	}

	toJSON() {
		const { partyErrors, ...rest } = this as any;
		return rest;
	}

	goToPage(target: NuzlockeScreen) {
		this.curRoom = target;
		navigateToNuzlocke(this.user);
		pushNuzlockeStatus(this.user, this);
		saveNuzlockeData();
	}
}

export interface NuzlockeStatePayload {
	curScreen: NuzlockeScreen;

	// Scenario metadata (null when no active run)
	scenarioId: string | null;
	scenarioName: string | null;
	scenarioDescription: string | null;
	starters: { species: string; level: number }[] | null;

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
		encounters: import('./types').RouteEncounter[];
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
}

export interface NuzlockeStatusPayload {
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
	pastRuns: CompletedRun[];
	selectedAi: string;
}

export function pushNuzlockeStatus(userID: ID, game: NuzlockeGame | null) {
	const user = Users.get(userID);
	if (!user) return;
	const savedAi = aiPreferences.get(userID) ?? 'random';
	const payload: NuzlockeStatusPayload = {
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
		pastRuns: completedRuns.filter(r => r.userId === userID),
		selectedAi: game?.settings.ai ?? savedAi,
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
	}));
}

export function serializeGameState(game: NuzlockeGame | null): NuzlockeStatePayload {
	const scenarios = buildScenarioCards();

	if (!game) {
		return {
			curScreen: 'dashboard',
			scenarioId: null, scenarioName: null, scenarioDescription: null, starters: null,
			currentSegmentIndex: 0, totalSegments: 0, currentBattleIndex: 0,
			completedBattles: [],
			segment: null,
			box: [], party: [], graveyard: [], items: [], tmMoves: [], resolvedRoutes: [],
			legalMoves: {}, availableEvolutions: {},
			lastBattleResult: null, nextScreen: null,
			segmentNames: {},
			scenarios,
		};
	}

	// Precompute legal moves for alive party members
	const legalMoves: Record<string, LegalMove[]> = {};
	if (game.currentSegment) {
		for (const uid of game.party) {
			const p = game.getPokemon(uid);
			if (p?.alive) {
				legalMoves[uid] = getLegalMoves(p, game.currentSegment.levelCap, game.scenario.generation, game.tmMoves);
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
	return {
		curScreen: game.curRoom,
		scenarioId: game.scenario.id,
		scenarioName: game.scenario.name,
		scenarioDescription: game.scenario.description,
		starters: game.scenario.starters,
		currentSegmentIndex: game.currentSegmentIndex,
		totalSegments: game.scenario.segments.length,
		currentBattleIndex: game.currentBattleIndex,
		completedBattles: game.completedBattles,
		segment: seg ? {
			name: seg.name,
			levelCap: seg.levelCap,
			items: seg.items,
			encounters: seg.encounters,
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
	};
}

export function pushNuzlockeState(userID: ID, game: NuzlockeGame | null) {
	const user = Users.get(userID);
	if (!user) return;
	const payload = JSON.stringify(serializeGameState(game));
	user.send(`>view-nuzlocke\n|nuzlockestate|${payload}`);
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
		survivors: game.box.filter(p => p.alive).map(p => ({ species: p.species, nickname: p.nickname })),
		finalParty: game.box.map(p => ({ species: p.species, alive: p.alive })),
		finalBattle: finalBattle ?? game.currentBattle?.trainer ?? '',
		segmentIndex: game.currentSegmentIndex,
		ai: game.settings.ai,
	};
	completedRuns.push(run);
}

export function saveNuzlockeData() {
	FS('config/nuzlocke.json').writeUpdate(
		() => JSON.stringify({ games: [...nuzlockeGames], completed: completedRuns, aiPrefs: [...aiPreferences] })
	);
}

export function loadNuzlockeData() {
	try {
		const raw = FS('config/nuzlocke.json').readIfExistsSync();
		if (!raw) return;
		const data = JSON.parse(raw);
		// Support both old array format and new object format
		const games: [ID, any][] = Array.isArray(data) ? data : (data.games ?? []);
		const completed: CompletedRun[] = Array.isArray(data) ? [] : (data.completed ?? []);
		const prefs: [ID, string][] = Array.isArray(data) ? [] : (data.aiPrefs ?? []);
		for (const [id, gameData] of games) {
			nuzlockeGames.set(id, Object.assign(new NuzlockeGame(id, gameData.scenario), gameData));
		}
		completedRuns.push(...completed);
		for (const [id, ai] of prefs) {
			aiPreferences.set(id, ai);
		}
	} catch {}
}
