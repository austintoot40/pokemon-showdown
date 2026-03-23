/**
 * Nuzlocke Simulator — Command handlers
 */

'use strict';

import { nuzlockeGames, NuzlockeGame, saveNuzlockeData, pushNuzlockeStatus, pushNuzlockeState, aiPreferences } from './game';
import { getScenario } from './scenarios';
import { createNuzlockeBattle, goToTeambuilding } from './battle';

// ---------------------------------------------------------------------------
// Commands export
// ---------------------------------------------------------------------------

export const nuzlockeCommands: Chat.ChatCommands = {
	nuzlocke: {
		start(target, room, user) {
			if (nuzlockeGames.has(user.id)) return this.parse('/join view-nuzlocke');
			const savedAi = aiPreferences.get(user.id) ?? 'random';
			const [scenarioId = 'firered', difficulty = savedAi] = target.trim().split(/\s+/);
			const scenario = getScenario(scenarioId.toLowerCase());
			if (!scenario) return this.errorReply(`Unknown scenario "${scenarioId}". Available: firered`);
			if (!['random', 'game-accurate', 'smart', 'competitive'].includes(difficulty)) {
				return this.errorReply(`Unknown difficulty "${difficulty}". Options: random, game-accurate, smart, competitive`);
			}
			aiPreferences.set(user.id, difficulty);
			const game = new NuzlockeGame(user.id, scenario);
			game.settings.ai = difficulty as NuzlockeGame['settings']['ai'];
			nuzlockeGames.set(user.id, game);
			game.goToPage('starter');
		},

		abandon(target, room, user) {
			if (!nuzlockeGames.has(user.id)) return this.errorReply('No active run.');
			nuzlockeGames.delete(user.id);
			saveNuzlockeData();
			pushNuzlockeStatus(user.id, null);
			pushNuzlockeState(user.id, null);
		},

		// Called after a run naturally ends (victory or wipe) — clears the game and shows dashboard
		done(target, room, user) {
			nuzlockeGames.delete(user.id);
			saveNuzlockeData();
			pushNuzlockeStatus(user.id, null);
			pushNuzlockeState(user.id, null);
		},

		restart(target, room, user) {
			const savedAi = aiPreferences.get(user.id) ?? 'random';
			const [scenarioId = 'firered', difficulty = savedAi] = target.trim().split(/\s+/);
			const scenario = getScenario(scenarioId.toLowerCase());
			if (!scenario) return this.errorReply(`Unknown scenario "${scenarioId}". Available: firered`);
			if (!['random', 'game-accurate', 'smart', 'competitive'].includes(difficulty)) {
				return this.errorReply(`Unknown difficulty "${difficulty}". Options: random, game-accurate, smart, competitive`);
			}
			aiPreferences.set(user.id, difficulty);
			nuzlockeGames.delete(user.id);
			const game = new NuzlockeGame(user.id, scenario);
			game.settings.ai = difficulty as NuzlockeGame['settings']['ai'];
			nuzlockeGames.set(user.id, game);
			game.goToPage('starter');
		},

		setai(target, room, user) {
			const difficulty = target.trim().toLowerCase();
			if (!['random', 'game-accurate', 'smart', 'competitive'].includes(difficulty)) {
				return this.errorReply(`Unknown difficulty "${difficulty}". Options: random, game-accurate, smart, competitive`);
			}
			aiPreferences.set(user.id, difficulty);
			const game = nuzlockeGames.get(user.id);
			if (game) {
				if (game.inBattle) return this.errorReply('Cannot change AI difficulty during a battle.');
				game.settings.ai = difficulty as NuzlockeGame['settings']['ai'];
				saveNuzlockeData();
				pushNuzlockeStatus(user.id, game);
			} else {
				saveNuzlockeData();
				pushNuzlockeStatus(user.id, null);
			}
		},

		starter(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			if (game.box.length > 0) return this.errorReply('Starter already chosen.');
			const index = parseInt(target.trim());
			if (isNaN(index) || index < 0 || index >= game.scenario.starters.length) {
				return this.errorReply(`Invalid starter index. Choose 0–${game.scenario.starters.length - 1}.`);
			}
			game.pickStarter(index);
			game.resolveSegmentStart();
			game.goToPage('encounters');
		},

		encounter(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			const routeIndex = parseInt(target.trim());
			if (isNaN(routeIndex)) return this.errorReply('Usage: /nuzlocke encounter <routeIndex>');
			const segment = game.currentSegment;
			if (!segment) return this.errorReply('No active segment.');
			const route = segment.encounters[routeIndex];
			if (!route) return this.errorReply('Invalid route index.');
			if (route.type === 'gift') return this.errorReply('Gift encounters are automatic.');
			if (game.resolvedRoutes.includes(route.route)) return this.errorReply('Already explored this route.');
			game.resolveOneRoute(routeIndex);
			game.goToPage('encounters');
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
					if (dest === 'teambuilding') {
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
			goToTeambuilding(game);
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
			saveNuzlockeData();
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
			saveNuzlockeData();
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
			goToTeambuilding(game);
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
			const game = nuzlockeGames.get(user.id) ?? null;
			pushNuzlockeState(user.id, game);
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
