/**
 * Nuzlocke Simulator — Command handlers
 */

'use strict';

import { nuzlockeGames, NuzlockeGame, flatEncounters, saveGame, deleteGame, pushNuzlockeStatus, pushNuzlockeState, closeNuzlockePanel, recordCompletedRun, pendingRandomizers } from './game';
import { getScenario } from './scenarios';
import { createNuzlockeBattle, goToTeambuilding } from './battle';
import { buildRandomizerMappings, buildStarterPokemon } from './encounters';
import type { RandomizerConfig } from './types';

// ---------------------------------------------------------------------------
// Commands export
// ---------------------------------------------------------------------------

export const nuzlockeCommands: Chat.ChatCommands = {
	nuzlocke: {
		start(target, room, user) {
			if (nuzlockeGames.has(user.id)) return this.parse('/join view-nuzlocke');
			const [scenarioId = 'firered', difficulty = 'game-accurate', starterIndexStr] = target.trim().split(/\s+/);
			const scenario = getScenario(scenarioId.toLowerCase());
			if (!scenario) return this.errorReply(`Unknown scenario "${scenarioId}". Available: firered`);
			if (!['game-accurate', 'smart', 'competitive'].includes(difficulty)) {
				return this.errorReply(`Unknown difficulty "${difficulty}". Options: game-accurate, smart, competitive`);
			}
			const game = new NuzlockeGame(user.id, scenario);
			game.settings.ai = difficulty as NuzlockeGame['settings']['ai'];
			game.settings.generation = scenario.generation;
			pendingRandomizers.delete(user.id);
			nuzlockeGames.set(user.id, game);
			const starterIndex = parseInt(starterIndexStr);
			if (isNaN(starterIndex) || starterIndex < 0 || starterIndex >= scenario.starters.length) {
				return this.errorReply(`Invalid starter index. Choose 0-${scenario.starters.length - 1}.`);
			}
			game.pickStarter(starterIndex);
			game.resolveSegmentStart();
			game.goToPage('encounters');
		},

		/**
		 * Computes randomizer mappings and pushes randomized starters to the client
		 * without starting the run. The user picks a starter, then calls randomizestart.
		 */
		randomizerpreview(target, room, user) {
			if (nuzlockeGames.has(user.id)) return this.errorReply('Already in a run.');
			const [scenarioId = 'firered', mode = 'shuffle', bstVariance = 'medium', randomizeItemsStr = 'false'] = target.trim().split(/\s+/);
			const scenario = getScenario(scenarioId.toLowerCase());
			if (!scenario) return this.errorReply(`Unknown scenario "${scenarioId}".`);
			if (!['shuffle', 'fully-random'].includes(mode)) {
				return this.errorReply(`Unknown mode "${mode}". Options: shuffle, fully-random`);
			}
			if (!['low', 'medium', 'high'].includes(bstVariance)) {
				return this.errorReply(`Unknown BST variance "${bstVariance}". Options: low, medium, high`);
			}
			const config: RandomizerConfig = {
				mode: mode as RandomizerConfig['mode'],
				bstVariance: bstVariance as RandomizerConfig['bstVariance'],
				randomizeItems: randomizeItemsStr === 'true',
				seed: Date.now(),
			};
			const mappings = buildRandomizerMappings(scenario, config);
			pendingRandomizers.set(user.id, { scenarioId: scenario.id, config, mappings });
			pushNuzlockeStatus(user.id, null);
		},

		/**
		 * Starts a randomized run using the pending randomizer preview config.
		 * Called after randomizerpreview once the user has picked a starter.
		 */
		randomizestart(target, room, user) {
			if (nuzlockeGames.has(user.id)) return this.parse('/join view-nuzlocke');
			const [scenarioId = '', difficulty = 'game-accurate', starterIndexStr] = target.trim().split(/\s+/);
			const pending = pendingRandomizers.get(user.id);
			if (!pending || pending.scenarioId !== scenarioId) {
				return this.errorReply('No pending randomizer preview. Click Randomize first.');
			}
			const scenario = getScenario(scenarioId);
			if (!scenario) return this.errorReply(`Unknown scenario "${scenarioId}".`);
			if (!['game-accurate', 'smart', 'competitive'].includes(difficulty)) {
				return this.errorReply(`Unknown difficulty "${difficulty}". Options: game-accurate, smart, competitive`);
			}
			const starterIndex = parseInt(starterIndexStr);
			if (isNaN(starterIndex) || starterIndex < 0 || starterIndex >= scenario.starters.length) {
				return this.errorReply(`Invalid starter index. Choose 0-${scenario.starters.length - 1}.`);
			}
			const game = new NuzlockeGame(user.id, scenario);
			game.settings.ai = difficulty as NuzlockeGame['settings']['ai'];
			game.settings.generation = scenario.generation;
			game.randomizerConfig = pending.config;
			game.randomizerMappings = pending.mappings;
			pendingRandomizers.delete(user.id);
			nuzlockeGames.set(user.id, game);
			const randStarterSpecies = pending.mappings.starterSpecies[starterIndex];
			const starterDef = scenario.starters[starterIndex];
			const starter = buildStarterPokemon(randStarterSpecies ?? starterDef.species, starterDef.level);
			game.box.push(starter);
			game.addToParty(starter.uid);
			game.resolveSegmentStart();
			game.goToPage('encounters');
		},

		randomizercancel(target, room, user) {
			pendingRandomizers.delete(user.id);
			pushNuzlockeStatus(user.id, nuzlockeGames.get(user.id) ?? null);
		},

		randomize(target, room, user) {
			if (nuzlockeGames.has(user.id)) return this.parse('/join view-nuzlocke');
			const [scenarioId = 'firered', difficulty = 'game-accurate', starterIndexStr, mode = 'shuffle', bstVariance = 'medium', randomizeItemsStr = 'false'] = target.trim().split(/\s+/);
			const scenario = getScenario(scenarioId.toLowerCase());
			if (!scenario) return this.errorReply(`Unknown scenario "${scenarioId}". Available: firered`);
			if (!['game-accurate', 'smart', 'competitive'].includes(difficulty)) {
				return this.errorReply(`Unknown difficulty "${difficulty}". Options: game-accurate, smart, competitive`);
			}
			if (!['shuffle', 'fully-random'].includes(mode)) {
				return this.errorReply(`Unknown randomizer mode "${mode}". Options: shuffle, fully-random`);
			}
			if (!['low', 'medium', 'high'].includes(bstVariance)) {
				return this.errorReply(`Unknown BST variance "${bstVariance}". Options: low, medium, high`);
			}
			const starterIndex = parseInt(starterIndexStr);
			if (isNaN(starterIndex) || starterIndex < 0 || starterIndex >= scenario.starters.length) {
				return this.errorReply(`Invalid starter index. Choose 0-${scenario.starters.length - 1}.`);
			}
			const config: RandomizerConfig = {
				mode: mode as RandomizerConfig['mode'],
				bstVariance: bstVariance as RandomizerConfig['bstVariance'],
				randomizeItems: randomizeItemsStr === 'true',
				seed: Date.now(),
			};
			const mappings = buildRandomizerMappings(scenario, config);
			const game = new NuzlockeGame(user.id, scenario);
			game.settings.ai = difficulty as NuzlockeGame['settings']['ai'];
			game.settings.generation = scenario.generation;
			game.randomizerConfig = config;
			game.randomizerMappings = mappings;
			pendingRandomizers.delete(user.id);
			nuzlockeGames.set(user.id, game);
			const randStarterSpecies = mappings.starterSpecies[starterIndex];
			const starterDef = scenario.starters[starterIndex];
			const starter = buildStarterPokemon(randStarterSpecies ?? starterDef.species, starterDef.level);
			game.box.push(starter);
			game.addToParty(starter.uid);
			game.resolveSegmentStart();
			game.goToPage('encounters');
		},

		abandon(target, room, user) {
			if (!nuzlockeGames.has(user.id)) return this.errorReply('No active run.');
			const game = nuzlockeGames.get(user.id)!;
			const battleRoomId = game.battleRoomId;
			nuzlockeGames.delete(user.id);
			deleteGame(user.id);
			pushNuzlockeStatus(user.id, null);
			closeNuzlockePanel(user.id);
			if (battleRoomId) user.send(`>${battleRoomId}\n|deinit|`);
		},

		// Called after a run naturally ends (victory or wipe) — clears the game and closes the panel
		done(target, room, user) {
			nuzlockeGames.delete(user.id);
			deleteGame(user.id);
			pushNuzlockeStatus(user.id, null);
			closeNuzlockePanel(user.id);
		},

		setai(target, room, user) {
			const difficulty = target.trim().toLowerCase();
			if (!['game-accurate', 'smart', 'competitive'].includes(difficulty)) {
				return this.errorReply(`Unknown difficulty "${difficulty}". Options: game-accurate, smart, competitive`);
			}
			const game = nuzlockeGames.get(user.id);
			if (game) {
				if (game.inBattle) return this.errorReply('Cannot change AI difficulty during a battle.');
				game.settings.ai = difficulty as NuzlockeGame['settings']['ai'];
				saveGame(game);
				pushNuzlockeStatus(user.id, game);
			}
		},

		encounter(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			const parts = target.trim().split(/\s+/);
			if (parts.length < 2) return this.errorReply('Usage: /nuzlocke encounter <routeName> <zoneIndex>');
			const zoneIndex = parseInt(parts[parts.length - 1]);
			const routeName = parts.slice(0, -1).join(' ');
			if (isNaN(zoneIndex)) return this.errorReply('Usage: /nuzlocke encounter <routeName> <zoneIndex>');
			if (!game.currentSegment) return this.errorReply('No active segment.');
			if (game.resolvedRoutes.includes(routeName)) return this.errorReply('Already explored this route.');
			game.resolveOneRoute(routeName, zoneIndex);
			game.goToPage('encounters');
		},

		defer(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			const routeName = target.trim();
			if (!routeName) return this.errorReply('Usage: /nuzlocke defer <routeName>');
			if (!game.deferRoute(routeName)) return this.errorReply('Cannot defer that route.');
			saveGame(game);
			pushNuzlockeState(user.id, game);
		},

		choosegift(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			const [giftIndexStr, speciesId] = target.trim().split(' ');
			const giftIndex = parseInt(giftIndexStr);
			if (isNaN(giftIndex) || !speciesId) return this.errorReply('Usage: /nuzlocke choosegift <giftIndex> <speciesId>');
			const segment = game.currentSegment;
			if (!segment) return this.errorReply('No active segment.');
			const route = (segment.gifts ?? [])[giftIndex];
			if (!route || !route.choice) return this.errorReply('Not a valid choice gift.');
			if (game.resolvedRoutes.includes(route.route)) return this.errorReply('Already received this gift.');
			game.resolveGiftChoice(giftIndex, speciesId);
			game.goToPage('encounters');
		},

		giveup(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			if (game.curRoom !== 'results') return this.errorReply('Can only give up from the results screen.');
			if (game.lastBattleResult?.won) return this.errorReply('You won — nothing to give up.');
			recordCompletedRun(game, 'wipe', game.lastBattleResult?.trainerName);
			game.goToPage('summary');
		},

		continue(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			if (game.curRoom === 'results') {
				const alive = game.box.filter(p => p.alive);
				if (alive.length === 0) {
					game.goToPage('summary');
				} else {
					const dest = game.nextScreen ?? 'teambuilding';
					game.nextScreen = null;
					game.lastBattleResult = null;
					if (dest === 'battle') {
						createNuzlockeBattle(game, user);
					} else if (dest === 'teambuilding') {
						goToTeambuilding(game);
					} else {
						game.goToPage(dest);
					}
				}
			} else {
				void this.parse('/join view-nuzlocke');
			}
		},

		battle(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			if (game.inBattle) return this.errorReply('Already in a battle.');
			if (!game.currentBattle) return this.errorReply('No battle available.');
			if (game.party.length === 0) return this.errorReply('Add Pokémon to your party first.');
			createNuzlockeBattle(game, user);
		},

		addtoparty(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			game.addToParty(target.trim());
			game.goToPage('teambuilding');
		},

		removefromparty(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			game.removeFromParty(target.trim());
			game.goToPage('teambuilding');
		},

		partymove(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			const [uid, dir] = target.trim().split(' ');
			const idx = game.party.indexOf(uid);
			if (idx === -1) return this.errorReply('Pokémon not in party.');
			if (dir === 'left') {
				game.swapPartySlots(idx, idx - 1);
			} else if (dir === 'right') {
				game.swapPartySlots(idx, idx + 1);
			} else {
				return this.errorReply('Usage: /nuzlocke partymove <uid> left|right');
			}
			game.goToPage('teambuilding');
		},

		togglemove(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			const spaceIdx = target.indexOf(' ');
			if (spaceIdx === -1) return this.errorReply('Usage: /nuzlocke togglemove <uid> <move>');
			const uid = target.slice(0, spaceIdx);
			const move = target.slice(spaceIdx + 1).trim();
			const pokemon = game.getPokemon(uid);
			if (!pokemon) return this.errorReply('Pokemon not found.');
			const idx = pokemon.moves.indexOf(move);
			if (idx !== -1) {
				pokemon.moves.splice(idx, 1);
			} else if (pokemon.moves.length < 4) {
				pokemon.moves.push(move);
			}
			game.goToPage('teambuilding');
		},

		battlewithmoves(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			if (game.inBattle) return this.errorReply('Already in a battle.');
			if (!game.currentBattle) return this.errorReply('No battle available.');
			if (game.party.length === 0) return this.errorReply('Add Pokémon to your party first.');
			// Each party entry: "uid m1,m2,m3,m4 item"
			const parts = target.trim().split(' ');
			let i = 0;
			while (i + 2 < parts.length) {
				const uid = parts[i];
				const moves = parts[i + 1].split(',').map(m => m.trim()).filter(Boolean);
				const itemId = parts[i + 2];
				const item = itemId === 'none' ? '' : (Dex.items.get(itemId).name || itemId);
				game.setMoves(uid, moves);
				game.setItem(uid, item);
				i += 3;
			}
			// Validate party before battling
			game.partyErrors.clear();
			for (const uid of game.party) {
				const p = game.getPokemon(uid);
				if (!p) continue;
				const moves = p.moves.filter(Boolean);
				if (moves.length === 0) {
					game.partyErrors.set(uid, 'No moves assigned.');
					continue;
				}
				const seen = new Set<string>();
				const dupes = moves.filter(m => {
					const id = toID(m);
					if (seen.has(id)) return true;
					seen.add(id);
					return false;
				});
				if (dupes.length > 0) {
					game.partyErrors.set(uid, `Duplicate move: ${dupes.map(m => Dex.moves.get(m).name || m).join(', ')}`);
				}
			}
			if (game.partyErrors.size > 0) {
				game.goToPage('teambuilding');
				return;
			}
			createNuzlockeBattle(game, user);
		},

		setitem(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			const spaceIdx = target.indexOf(' ');
			if (spaceIdx === -1) return this.errorReply('Usage: /nuzlocke setitem <uid> <item>');
			const uid = target.slice(0, spaceIdx);
			const item = target.slice(spaceIdx + 1).trim();
			game.setItem(uid, item);
			game.goToPage('teambuilding');
		},

		setnicks(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			// Format: "uid nick uid nick ..." — pairs set by the encounters page form
			const parts = target.trim().split(' ');
			for (let i = 0; i + 1 < parts.length; i += 2) {
				const uid = parts[i];
				const nick = parts[i + 1];
				if (uid && nick) game.setNickname(uid, nick);
			}
			goToTeambuilding(game);
		},

		evolve(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			const spaceIdx = target.indexOf(' ');
			if (spaceIdx === -1) return this.errorReply('Usage: /nuzlocke evolve <uid> <species>');
			const uid = target.slice(0, spaceIdx);
			const targetSpecies = target.slice(spaceIdx + 1).trim();
			game.evolve(uid, targetSpecies);
			game.goToPage('teambuilding');
		},

		// Phase 1 test command — kept for debugging
		testbattle(target, room, user) {
			const playerTeam = Teams.pack([{
				name: 'Charmander', species: 'Charmander', item: '', ability: 'Blaze',
				moves: ['Scratch', 'Growl', 'Ember'], nature: 'Hardy',
				evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
				ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
				level: 15, gender: 'M',
			}] as PokemonSet[]);
			const aiTeam = Teams.pack([{
				name: 'Onix', species: 'Onix', item: 'Oran Berry', ability: 'Rock Head',
				moves: ['Tackle', 'Rock Tomb', 'Bind', 'Harden'], nature: 'Hardy',
				evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
				ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
				level: 14,
			}] as PokemonSet[]);
			Rooms.createBattle({
				format: 'gen3nuzlockebattle',
				isNuzlockeBattle: true,
				players: [
					{ user, team: playerTeam },
					{ user: null, username: 'Leader Brock', team: aiTeam, isAI: true },
				],
			});
			this.sendReply('Test battle created!');
		},

		refresh(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (game) {
				pushNuzlockeState(user.id, game);
			} else {
				closeNuzlockePanel(user.id);
			}
		},

		'': 'help',
		help() {
			this.sendReply([
				'/nuzlocke start [firered] — Start a new run',
				'/nuzlocke restart — Abandon current run',
				'/nuzlocke testbattle — Dev: test AI battle',
			].join('\n'));
		},
	},
};
