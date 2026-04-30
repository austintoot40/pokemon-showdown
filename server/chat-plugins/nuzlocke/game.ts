/**
 * Nuzlocke Simulator — Game State
 */

import { saveGameToRedis, deleteGameFromRedis, loadGameFromRedis, pingRedis, saveBeatenScenario, loadBeatenScenarios } from './redis-store';
import { logNuzlockeError } from './error-logger';
import { resolveOneEncounter, resolveChoiceGift, getAvailablePool, getGiftPool, buildStarterPokemon } from './encounters';
import { getLegalMoves, type LegalMove } from './learnsets';
import { listScenarios, getScenario } from './scenarios';
import type { Scenario, Segment, RouteEncounter, OwnedPokemon, DeadPokemon, NuzlockeScreen, NuzlockeScenarioCard, EvoOption } from './types';

/** Returns all wild encounters for a segment. */
export function flatEncounters(segment: Segment): RouteEncounter[] {
	return segment.encounters ?? [];
}

export const nuzlockeGames = new Map<ID, NuzlockeGame>();

const beatenScenariosCache = new Map<ID, string[]>();

export async function loadBeatenScenariosForUser(userId: ID): Promise<void> {
	const ids = await loadBeatenScenarios(userId);
	beatenScenariosCache.set(userId, ids);
}

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
	inChainedTeambuilding: boolean;
	battleRoomId: string | null;
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
	deferredRoutes: RouteEncounter[];   // explicitly deferred by player; re-appear as pending each session
	lockedRoutes: RouteEncounter[];     // auto-carried routes where all zones were inaccessible at segment end
	settings: { ai: 'basic' | 'smart' | 'competitive'; generation: number };
	partyErrors: Map<string, string>;
	randomizerConfig: import('./types').RandomizerConfig | null;
	randomizerMappings: import('./types').RandomizerMappings | null;

	constructor(userID: ID, scenario: Scenario) {
		this.user = userID;
		this.scenario = scenario;
		this.curRoom = 'encounters';
		this.inBattle = false;
		this.inChainedTeambuilding = false;
		this.battleRoomId = null;
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
		this.deferredRoutes = [];
		this.lockedRoutes = [];
		this.settings = { ai: 'basic', generation: 9 };
		this.partyErrors = new Map();
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
		const segmentItems = segment.items;
		this.items.push(...segmentItems);
		this.tmMoves.push(...(segment.tmMoves ?? []));
		for (const route of segment.gifts ?? []) {
			if (route.choice) continue;  // Player must choose manually
			const pokemon = resolveOneEncounter(route, 0, this.box, this.graveyard as any, this.currentLevelCap, this.randomizerMappings);
			if (!pokemon) continue; // all dupes — skip
			this.box.push(pokemon);
			this.addToParty(pokemon.uid);
			this.resolvedRoutes.push(route.route);
		}
		// Re-lock previously-deferred routes that are still fully inaccessible.
		// This prevents routes in deferredRoutes from showing confusing "Deferred" badges
		// when they haven't become accessible yet.
		this.deferredRoutes = this.deferredRoutes.filter(r => {
			if (!this.isRouteDeferrable(r)) return true; // accessible or all dupes — keep as deferred
			if (!this.lockedRoutes.some(lr => lr.route === r.route)) {
				this.lockedRoutes.push(r);
			}
			return false; // moved to lockedRoutes
		});

		// Auto-lock encounters whose every zone is currently inaccessible (and have
		// something non-dupe to come back for), so the client shows them as handled
		// from the moment the segment loads rather than waiting until segment end.
		for (const route of flatEncounters(segment)) {
			if (this.resolvedRoutes.includes(route.route)) continue;
			if (this.deferredRoutes.some(r => r.route === route.route)) continue;
			if (this.lockedRoutes.some(r => r.route === route.route)) continue;
			if (this.isRouteDeferrable(route)) this.lockedRoutes.push(route);
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

		// Resolve species accounting for randomizer mappings.
		// The client sends the *randomized* species ID, but the original route still has the original pool.
		let speciesName: string | null = null;
		const m = this.randomizerMappings;
		if (m?.routeMap[route.route]) {
			// Fully-random: one species pre-assigned for the whole route
			const mapped = m.routeMap[route.route];
			if (toID(mapped) === speciesId) speciesName = mapped;
		} else if (m && Object.keys(m.speciesMap).length > 0) {
			// Shuffle: find original entry whose remapped species matches
			const entry = getGiftPool(route).find(e => toID(m.speciesMap[toID(e.species)] ?? e.species) === speciesId);
			if (entry) speciesName = m.speciesMap[toID(entry.species)] ?? entry.species;
		} else {
			// No randomizer: direct match against original pool
			const entry = getGiftPool(route).find(e => toID(e.species) === speciesId);
			if (entry) speciesName = entry.species;
		}
		if (!speciesName) return;

		const pokemon = resolveChoiceGift(route, speciesName, this.currentLevelCap);
		this.box.push(pokemon);
		this.addToParty(pokemon.uid);
		this.resolvedRoutes.push(route.route);
		this.refreshLockedRoutes();
	}

	/** Returns true if a zone's prerequisite is currently unmet. */
	isZoneLocked(zone: import('./types').ZoneEncounter): boolean {
		const prereq = zone.requires;
		if (!prereq) return false;
		if (prereq.type === 'move') return !this.tmMoves.includes(prereq.name);
		if (prereq.type === 'pokemon') return !this.box.some(p => toID(p.species) === toID(prereq.name));
		if (prereq.type === 'battle') return !this.completedBattles.includes(prereq.name);
		return !this.items.includes(prereq.name);
	}

	/** Returns true if every zone in the route has an unmet prerequisite. */
	isRouteAllLocked(route: RouteEncounter): boolean {
		return route.zones.every(zone => this.isZoneLocked(zone));
	}

	/**
	 * Returns true if the route should be auto-carried to a future segment.
	 * Conditions: no accessible zone has a non-duplicate available,
	 * AND at least one locked zone has a non-duplicate (worth coming back for).
	 */
	isRouteDeferrable(route: RouteEncounter): boolean {
		// If any accessible zone has a non-dupe catchable Pokemon, player can act now — not deferrable.
		const canCatchNow = route.zones.some(zone => {
			if (this.isZoneLocked(zone)) return false;
			return getAvailablePool(zone.pokemon, this.box, this.graveyard as any).length > 0;
		});
		if (canCatchNow) return false;

		// At least one locked zone must have something non-dupe to return for.
		return route.zones.some(zone => {
			if (!this.isZoneLocked(zone)) return false;
			return getAvailablePool(zone.pokemon, this.box, this.graveyard as any).length > 0;
		});
	}

	/**
	 * Removes from lockedRoutes any routes that now have an accessible non-dupe zone.
	 * Called after operations that add Pokemon (or items/TMs) that may unlock trade/prereq zones.
	 */
	refreshLockedRoutes() {
		this.lockedRoutes = this.lockedRoutes.filter(r => this.isRouteDeferrable(r));
	}

	/** Explicitly defer a route; moves it from lockedRoutes to deferredRoutes if needed. */
	deferRoute(routeName: string): boolean {
		if (this.resolvedRoutes.includes(routeName)) return false;
		const segment = this.currentSegment;
		const allRoutes = [
			...(segment ? flatEncounters(segment) : []),
			...this.deferredRoutes,
			...this.lockedRoutes,
		];
		const route = allRoutes.find(r => r.route === routeName);
		if (!route) return false;
		// Move from lockedRoutes to deferredRoutes if it was auto-carried
		this.lockedRoutes = this.lockedRoutes.filter(r => r.route !== routeName);
		if (!this.deferredRoutes.some(r => r.route === routeName)) {
			this.deferredRoutes.push(route);
		}
		return true;
	}

	/** Called by /nuzlocke encounterchoice <routeName> <zoneIndex> <speciesId>: player picks a specific
	 *  species from a Gift zone that is embedded in an encounter route (e.g. fossil revival). */
	resolveChoiceZone(routeName: string, zoneIndex: number, speciesId: string) {
		const segment = this.currentSegment;
		if (!segment) return;
		const allRoutes = [...flatEncounters(segment), ...this.deferredRoutes, ...this.lockedRoutes];
		const route = allRoutes.find(r => r.route === routeName);
		if (!route) return;
		if (this.resolvedRoutes.includes(route.route)) return;
		const zone = route.zones[zoneIndex];
		if (!zone || zone.method !== 'Gift') return;

		this.lockedRoutes = this.lockedRoutes.filter(r => r.route !== routeName);

		// Look up the canonical species name, then apply randomizer mappings if active.
		let speciesName = zone.pokemon.find(e => toID(e.species) === speciesId)?.species ?? speciesId;
		if (this.randomizerMappings) {
			const routeOverride = this.randomizerMappings.routeMap[route.route];
			if (routeOverride) {
				speciesName = routeOverride;
			} else {
				const mapped = this.randomizerMappings.speciesMap[toID(speciesName)];
				if (mapped) speciesName = mapped;
			}
		}

		const pokemon = resolveChoiceGift(route, speciesName, this.currentLevelCap);
		pokemon.caughtZoneIndex = zoneIndex;
		this.resolvedRoutes.push(route.route);
		this.box.push(pokemon);
		this.addToParty(pokemon.uid);
		this.refreshLockedRoutes();
	}

	/** Called by /nuzlocke encounter <routeName> <zoneIndex>: rolls a zone from a wild route. */
	resolveOneRoute(routeName: string, zoneIndex: number) {
		const segment = this.currentSegment;
		if (!segment) return;
		const allRoutes = [
			...flatEncounters(segment),
			...this.deferredRoutes,
			...this.lockedRoutes,
		];
		const route = allRoutes.find(r => r.route === routeName);
		if (!route) return;
		if (this.resolvedRoutes.includes(route.route)) return;
		// Remove from lockedRoutes; keep in deferredRoutes so resolved carry-over routes remain visible
		this.lockedRoutes = this.lockedRoutes.filter(r => r.route !== routeName);
		const pokemon = resolveOneEncounter(route, zoneIndex, this.box, this.graveyard as any, this.currentLevelCap, this.randomizerMappings);
		this.resolvedRoutes.push(route.route);
		if (!pokemon) return; // all dupes — route resolved with no encounter
		pokemon.caughtZoneIndex = zoneIndex;
		this.box.push(pokemon);
		this.addToParty(pokemon.uid);
		// Trade zones: remove the traded-away pokemon from the box
		const zone = route.zones[zoneIndex];
		if (zone?.requires?.type === 'pokemon') {
			const tradedIdx = this.box.findIndex(p => toID(p.species) === toID(zone.requires!.name));
			if (tradedIdx >= 0) {
				const traded = this.box[tradedIdx];
				this.party = this.party.filter(uid => uid !== traded.uid);
				this.box.splice(tradedIdx, 1);
			}
		}
		this.refreshLockedRoutes();
	}

	get currentSegment() {
		return this.scenario.segments[this.currentSegmentIndex] ?? null;
	}

	get currentBattle() {
		return this.currentSegment?.battles[this.currentBattleIndex] ?? null;
	}

	/** Level cap for the current battle: the highest level on the upcoming trainer's team. */
	get currentLevelCap(): number {
		const battle = this.currentBattle;
		if (!battle?.team.length) return 0;
		return Math.max(...battle.team.map(p => p.level));
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
		if (pokemon) pokemon.nickname = name.replace(/[|\n\r]/g, '').slice(0, 12).trim() || pokemon.species;
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
		const levelCap = this.currentLevelCap;
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
			// Skip evolutions introduced in a later generation than this scenario.
			if (evo.gen && evo.gen > this.scenario.generation) continue;
			const evoType = evo.evoType;
			if (!evoType || evoType === 'levelFriendship' || evoType === 'levelExtra' || evoType === 'levelMove') {
				// levelMove: ignore the move requirement — just check the level cap.
				if ((evo.evoLevel ?? 0) <= levelCap) {
					results.push({ species: evo.name, item: null, type: 'level' });
				}
			} else if (evoType === 'levelHold' && evo.evoItem) {
				// levelHold: ignore time-of-day — just check the item.
				if (this.items.includes(evo.evoItem)) {
					results.push({ species: evo.name, item: evo.evoItem, type: 'item' });
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
		// Nincada: collapse the dual evolution — Shedinja is created as a side effect of evolving to Ninjask.
		if (toID(pokemon.species) === 'nincada') {
			return results.filter(e => toID(e.species) !== 'shedinja');
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
		const wasNincada = toID(pokemon.species) === 'nincada';
		pokemon.species = target.species;
		const dexSpecies = Dex.species.get(target.species);
		pokemon.ability = dexSpecies.abilities[0];

		// Nincada → Ninjask also creates a Shedinja inheriting Nincada's stats.
		if (wasNincada && toID(target.species) === 'ninjask') {
			const shedinja = buildStarterPokemon('Shedinja', pokemon.level);
			shedinja.nature = pokemon.nature;
			shedinja.ivs = { ...pokemon.ivs };
			shedinja.caughtRoute = pokemon.caughtRoute;
			this.box.push(shedinja);
			this.addToParty(shedinja.uid);
		}
	}

	/** Evolve all Pokemon that have exactly one unambiguous, resource-free evolution available. */
	evolveAll() {
		for (const pokemon of this.box) {
			if (!pokemon.alive) continue;
			const eligible = this.getAvailableEvolutions(pokemon.uid).filter(e => e.item === null);
			if (eligible.length === 1) this.evolve(pokemon.uid, eligible[0].species);
		}
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
			this.inChainedTeambuilding = false;
			// Auto-carry fully-locked routes from the current segment before advancing.
			// These are routes the player couldn't act on because all zones had unmet prereqs.
			for (const route of flatEncounters(segment)) {
				if (this.resolvedRoutes.includes(route.route)) continue;
				if (this.deferredRoutes.some(r => r.route === route.route)) continue;
				if (this.lockedRoutes.some(r => r.route === route.route)) continue;
				if (this.isRouteDeferrable(route)) {
					this.lockedRoutes.push(route);
				}
			}

			// Segment complete — move to next segment
			this.currentSegmentIndex++;
			this.currentBattleIndex = 0;

			if (this.currentSegmentIndex >= this.scenario.segments.length) {
				// All segments done — victory!
				return 'done';
			} else {
				// New segment: add items/gifts; wild routes are player-initiated
				// Prune resolved deferred routes before clearing resolvedRoutes, or the check in
				// resolveSegmentStart would always see an empty list and never remove them.
				this.deferredRoutes = this.deferredRoutes.filter(r => !this.resolvedRoutes.includes(r.route));
				this.resolvedRoutes = [];
				this.resolveSegmentStart();
				return 'encounters';
			}
		} else {
			// More battles remain in this segment — go to teambuilder with box locked
			this.inChainedTeambuilding = true;
			return 'teambuilding';
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
		encounters: import('./types').RouteEncounter[];
		gifts: import('./types').RouteEncounter[];
		battles: import('./types').TrainerBattle[];
	} | null;

	// Player state
	box: OwnedPokemon[];
	party: string[];
	graveyard: DeadPokemon[];
	items: string[];
	holdableItems: string[];
	tmMoves: string[];
	resolvedRoutes: string[];
	deferredRoutes: import('./types').RouteEncounter[];
	lockedRoutes: import('./types').RouteEncounter[];

	// Precomputed derived data
	legalMoves: Record<string, LegalMove[]>;
	availableEvolutions: Record<string, EvoOption[]>;

	// Result of the most recent battle
	lastBattleResult: { won: boolean; perfect: boolean; trainerName: string; deaths: DeadPokemon[] } | null;

	// Segment name lookup for graveyard display
	segmentNames: Record<string, string>;

	// Dashboard data
	scenarios: NuzlockeScenarioCard[];

	// Active battle room (null when no battle in progress)
	battleRoomId: string | null;

	// True when in teambuilder between chained battles; box ↔ party transfers are disabled
	boxDisabled: boolean;
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
	beatenScenarios: string[];
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
		beatenScenarios: beatenScenariosCache.get(userID) ?? [],
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
		const prevSeg = game.scenario.segments[game.currentSegmentIndex - 1];
		const previousLevelCap = prevSeg?.battles.length
			? Math.max(...prevSeg.battles.flatMap(b => b.team.map(p => p.level)))
			: 0;
		const tmRoutes = game.scenario.tmRouteMap;
		const newTmMoves = game.currentSegment.tmMoves ?? [];
		for (const p of game.box) {
			if (p.alive) {
				legalMoves[p.uid] = getLegalMoves(
					p, game.currentLevelCap, game.scenario.generation, game.tmMoves,
					previousLevelCap, newTmMoves, tmRoutes
				);
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
			levelCap: game.currentLevelCap,
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
		holdableItems: (() => {
			const dex = Dex.forGen(game.scenario.generation);
			return [...new Set(game.items)].filter(name => {
				const it = dex.items.get(name);
				if (!it.exists || !it.fling) return false;
				if (it.isBerry || it.isGem) return true;
				return Object.keys(it).some(k => k.startsWith('on') && (it as any)[k] !== undefined);
			}).map(name => ({
				id: toID(name),
				name,
				location: game.scenario.itemRouteMap[toID(name)] ?? '',
			}));
		})(),
		tmMoves: game.tmMoves,
		resolvedRoutes: game.resolvedRoutes,
		deferredRoutes: m ? applyMappingsToRoutes(game.deferredRoutes, m) : game.deferredRoutes,
		lockedRoutes: m ? applyMappingsToRoutes(game.lockedRoutes, m) : game.lockedRoutes,
		legalMoves,
		availableEvolutions,
		lastBattleResult: game.lastBattleResult,
		segmentNames,
		scenarios,
		battleRoomId: game.battleRoomId,
		boxDisabled: game.inChainedTeambuilding,
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

export function recordCompletedRun(game: NuzlockeGame, outcome: 'victory' | 'wipe') {
	if (outcome === 'victory') {
		const cached = beatenScenariosCache.get(game.user) ?? [];
		if (!cached.includes(game.scenario.id)) {
			cached.push(game.scenario.id);
			beatenScenariosCache.set(game.user, cached);
		}
		void saveBeatenScenario(game.user, game.scenario.id);
	}
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
		if (!scenario) {
			logNuzlockeError({
				timestamp: new Date().toISOString(),
				source: 'server',
				error: { message: `Unknown scenarioId "${gameData.scenarioId}" for user ${userId} — scenario not loaded` },
				scenarioId: gameData.scenarioId,
				context: { command: 'loadUserGame', userId },
			});
			return null;
		}
		const game = Object.assign(new NuzlockeGame(userId, scenario), gameData, { scenario });
		// Battle rooms don't survive server restarts — put the player back at teambuilding
		if (game.inBattle) {
			game.inBattle = false;
			game.battleRoomId = null;
			game.curRoom = 'teambuilding';
		}
		nuzlockeGames.set(userId, game);
		return game;
	} catch (e: any) {
		logNuzlockeError({
			timestamp: new Date().toISOString(),
			source: 'server',
			error: { message: e?.message ?? String(e), stack: e?.stack },
			context: { command: 'loadUserGame', userId },
		});
		return null;
	}
}
