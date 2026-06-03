/**
 * Nuzlocke Simulator — Command handlers
 */

'use strict';

import { nuzlockeGames, NuzlockeGame, flatEncounters, saveGame, deleteGame, pushNuzlockeStatus, pushNuzlockeState, closeNuzlockePanel, recordCompletedRun, pendingRandomizers, bumpTotalRuns } from './game';
import { logNuzlockeError } from './error-logger';
import { postBugReportToDiscord } from './feedback';

const FEEDBACK_COOLDOWN_MS = 5 * 60 * 1000;
const feedbackCooldowns = new Map<string, number>();
import { getScenario } from './scenarios';
import { createNuzlockeBattle, goToTeambuilding } from './battle';
import { buildRandomizerMappings, buildStarterPokemon } from './encounters';
import { getLegalMoves } from './learnsets';
import type { RandomizerConfig } from './types';

/** Strip PS protocol characters from a user-supplied nickname. */
function sanitizeNickname(raw: string, fallback: string): string {
	return raw.replace(/[|\n\r]/g, '').slice(0, 12).trim() || fallback;
}

/** Return the canonical Dex item name, or null if the item doesn't exist. */
function resolveItem(itemId: string): string | null {
	if (itemId === 'none') return '';
	const item = Dex.items.get(itemId);
	return item.exists ? item.name : null;
}

// ---------------------------------------------------------------------------
// Commands export
// ---------------------------------------------------------------------------

export const nuzlockeCommands: Chat.ChatCommands = {
	nuzlocke: {
		start(target, room, user) {
			if (nuzlockeGames.has(user.id)) return this.parse('/join view-nuzlocke');
			const [scenarioId = 'firered', difficulty = 'basic', generationMode = 'original', starterIndexStr] = target.trim().split(/\s+/);
			const scenario = getScenario(scenarioId.toLowerCase());
			if (!scenario) return this.errorReply(`Unknown scenario "${scenarioId}". Available: firered`);
			if (!['basic', 'smart'].includes(difficulty)) {
				return this.errorReply(`Unknown difficulty "${difficulty}". Options: basic, smart`);
			}
			if (!['original', 'modern'].includes(generationMode)) {
				return this.errorReply(`Unknown generation mode "${generationMode}". Options: original, modern`);
			}
			const game = new NuzlockeGame(user.id, scenario);
			game.settings.ai = difficulty as NuzlockeGame['settings']['ai'];
			game.settings.generation = generationMode === 'modern' ? 9 : scenario.generation;
			pendingRandomizers.delete(user.id);
			nuzlockeGames.set(user.id, game);
			bumpTotalRuns();
			const starterIndex = parseInt(starterIndexStr);
			if (isNaN(starterIndex) || starterIndex < 0 || starterIndex >= scenario.starters.length) {
				return this.errorReply(`Invalid starter index. Choose 0-${scenario.starters.length - 1}.`);
			}
			game.pickStarter(starterIndex);
			game.resolveSegmentStart();
			game.goToPage('segment');
		},

		proceed(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game || game.curRoom !== 'segment') return;
			game.goToPage('encounters');
		},

		/**
		 * Computes randomizer mappings and pushes randomized starters to the client
		 * without starting the run. The user picks a starter, then calls randomizestart.
		 */
		randomizerpreview(target, room, user) {
			if (nuzlockeGames.has(user.id)) return this.errorReply('Already in a run.');
			const [scenarioId = 'firered', mode = 'shuffle', bstVariance = 'medium', dexPool = 'national'] = target.trim().split(/\s+/);
			const scenario = getScenario(scenarioId.toLowerCase());
			if (!scenario) return this.errorReply(`Unknown scenario "${scenarioId}".`);
			if (!['shuffle', 'fully-random'].includes(mode)) {
				return this.errorReply(`Unknown mode "${mode}". Options: shuffle, fully-random`);
			}
			if (!['low', 'medium', 'high'].includes(bstVariance)) {
				return this.errorReply(`Unknown BST variance "${bstVariance}". Options: low, medium, high`);
			}
			if (!['regional', 'national', 'all'].includes(dexPool)) {
				return this.errorReply(`Unknown dex pool "${dexPool}". Options: regional, national, all`);
			}
			const config: RandomizerConfig = {
				mode: mode as RandomizerConfig['mode'],
				bstVariance: bstVariance as RandomizerConfig['bstVariance'],
				dexPool: dexPool as RandomizerConfig['dexPool'],
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
			const [scenarioId = '', difficulty = 'basic', generationMode = 'original', starterIndexStr] = target.trim().split(/\s+/);
			const pending = pendingRandomizers.get(user.id);
			if (!pending || pending.scenarioId !== scenarioId) {
				return this.errorReply('No pending randomizer preview. Click Randomize first.');
			}
			const scenario = getScenario(scenarioId);
			if (!scenario) return this.errorReply(`Unknown scenario "${scenarioId}".`);
			if (!['basic', 'smart'].includes(difficulty)) {
				return this.errorReply(`Unknown difficulty "${difficulty}". Options: basic, smart`);
			}
			if (!['original', 'modern'].includes(generationMode)) {
				return this.errorReply(`Unknown generation mode "${generationMode}". Options: original, modern`);
			}
			const starterIndex = parseInt(starterIndexStr);
			if (isNaN(starterIndex) || starterIndex < 0 || starterIndex >= scenario.starters.length) {
				return this.errorReply(`Invalid starter index. Choose 0-${scenario.starters.length - 1}.`);
			}
			const game = new NuzlockeGame(user.id, scenario);
			game.settings.ai = difficulty as NuzlockeGame['settings']['ai'];
			game.settings.generation = generationMode === 'modern' ? 9 : scenario.generation;
			game.randomizerConfig = pending.config;
			game.randomizerMappings = pending.mappings;
			pendingRandomizers.delete(user.id);
			nuzlockeGames.set(user.id, game);
			bumpTotalRuns();
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
			const [scenarioId = 'firered', difficulty = 'basic', starterIndexStr, mode = 'shuffle', bstVariance = 'medium'] = target.trim().split(/\s+/);
			const scenario = getScenario(scenarioId.toLowerCase());
			if (!scenario) return this.errorReply(`Unknown scenario "${scenarioId}". Available: firered`);
			if (!['basic', 'smart'].includes(difficulty)) {
				return this.errorReply(`Unknown difficulty "${difficulty}". Options: basic, smart`);
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
				dexPool: 'national',
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
			bumpTotalRuns();
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

		status(target, room, user) {
			// Client requests this on connect so the mainmenu populates even before the user logs in.
			const game = nuzlockeGames.get(user.id) ?? null;
			pushNuzlockeStatus(user.id, game);
		},

		setai(target, room, user) {
			const difficulty = target.trim().toLowerCase();
			if (!['basic', 'smart'].includes(difficulty)) {
				return this.errorReply(`Unknown difficulty "${difficulty}". Options: basic, smart`);
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
			if (isNaN(zoneIndex) || zoneIndex < 0) return this.errorReply('Usage: /nuzlocke encounter <routeName> <zoneIndex>');
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

		encounterchoice(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			const parts = target.trim().split(/\s+/);
			if (parts.length < 3) return this.errorReply('Usage: /nuzlocke encounterchoice <routeName> <zoneIndex> <speciesId>');
			const speciesId = parts[parts.length - 1];
			const zoneIndex = parseInt(parts[parts.length - 2]);
			const routeName = parts.slice(0, -2).join(' ');
			if (isNaN(zoneIndex) || zoneIndex < 0 || !speciesId) return this.errorReply('Usage: /nuzlocke encounterchoice <routeName> <zoneIndex> <speciesId>');
			if (!game.currentSegment) return this.errorReply('No active segment.');
			if (game.resolvedRoutes.includes(routeName)) return this.errorReply('Already explored this route.');
			game.resolveChoiceZone(routeName, zoneIndex, speciesId);
			game.goToPage('encounters');
		},

		choosegift(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			const [giftIndexStr, speciesId] = target.trim().split(' ');
			const giftIndex = parseInt(giftIndexStr);
			if (isNaN(giftIndex) || giftIndex < 0 || !speciesId) return this.errorReply('Usage: /nuzlocke choosegift <giftIndex> <speciesId>');
			const segment = game.currentSegment;
			if (!segment) return this.errorReply('No active segment.');
			const route = (segment.gifts ?? [])[giftIndex];
			if (!route || !route.choice) return this.errorReply('Not a valid choice gift.');
			if (game.resolvedRoutes.includes(route.route)) return this.errorReply('Already received this gift.');
			game.resolveGiftChoice(giftIndex, speciesId);
			game.goToPage('encounters');
		},

		battle(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			if (game.inBattle) return this.errorReply('Already in a battle.');
			if (!game.currentBattle) return this.errorReply('No battle available.');
			if (game.party.length === 0) return this.errorReply('Add Pokémon to your party first.');
			game.inChainedTeambuilding = false;
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
			if (!pokemon || !pokemon.alive) return this.errorReply('Pokemon not found.');
			const idx = pokemon.moves.indexOf(move);
			if (idx !== -1) {
				pokemon.moves.splice(idx, 1);
			} else if (pokemon.moves.length < 4) {
				const legal = getLegalMoves(pokemon, game.currentLevelCap, game.learnsetGeneration, game.tmMoves);
				if (!legal.some(m => toID(m.name) === toID(move))) {
					return this.errorReply(`${move} is not a legal move for this Pokémon.`);
				}
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
				const pokemon = game.getPokemon(uid);
				const rawMoves = parts[i + 1].split(',').map(m => m.trim()).filter(Boolean);
				const itemId = parts[i + 2];
				i += 3;
				if (!pokemon || !pokemon.alive) continue;
				// Only allow moves that are legal for this Pokemon at the current level cap.
				const legalMoveIds = new Set(
					getLegalMoves(pokemon, game.currentLevelCap, game.learnsetGeneration, game.tmMoves)
						.map(m => toID(m.name))
				);
				const moves = rawMoves.filter(m => legalMoveIds.has(toID(m)));
				const item = resolveItem(itemId);
				if (item === null) continue; // unknown item — skip rather than store garbage
				game.setMoves(uid, moves);
				game.setItem(uid, item);
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
			const pokemon = game.getPokemon(uid);
			if (!pokemon || !pokemon.alive) return this.errorReply('Pokemon not found.');
			const itemId = target.slice(spaceIdx + 1).trim();
			const item = resolveItem(itemId);
			if (item === null) return this.errorReply(`Unknown item "${itemId}".`);
			game.setItem(uid, item);
			saveGame(game);
		},

		setmoves(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			const spaceIdx = target.indexOf(' ');
			if (spaceIdx === -1) return this.errorReply('Usage: /nuzlocke setmoves <uid> <move1,move2,...>');
			const uid = target.slice(0, spaceIdx);
			const pokemon = game.getPokemon(uid);
			if (!pokemon || !pokemon.alive) return this.errorReply('Pokemon not found.');
			const moveStr = target.slice(spaceIdx + 1).trim();
			const rawMoves = moveStr === 'none' ? [] : moveStr.split(',').map(m => m.trim()).filter(Boolean);
			const legalMoveIds = new Set(
				getLegalMoves(pokemon, game.currentLevelCap, game.learnsetGeneration, game.tmMoves)
					.map(m => toID(m.name))
			);
			game.setMoves(uid, rawMoves.filter(m => legalMoveIds.has(toID(m))));
			saveGame(game);
		},

		setnicks(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			// Format: "uid nick uid nick ..." — pairs set by the encounters page form
			const parts = target.trim().split(' ');
			for (let i = 0; i + 1 < parts.length; i += 2) {
				const uid = parts[i];
				const rawNick = parts[i + 1];
				if (!uid || !rawNick) continue;
				const pokemon = game.getPokemon(uid);
				if (!pokemon) continue;
				const nick = sanitizeNickname(rawNick, pokemon.species);
				game.setNickname(uid, nick);
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

		evolveall(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (!game) return this.errorReply('No active run.');
			game.evolveAll();
			game.goToPage('teambuilding');
		},

		refresh(target, room, user) {
			const game = nuzlockeGames.get(user.id);
			if (game) {
				pushNuzlockeState(user.id, game);
			} else {
				closeNuzlockePanel(user.id);
			}
		},

		feedback(target, room, user) {
			if (!user.named) return;

			const now = Date.now();
			const lastSent = feedbackCooldowns.get(user.id) ?? 0;
			const remaining = FEEDBACK_COOLDOWN_MS - (now - lastSent);
			if (remaining > 0) {
				const minutes = Math.ceil(remaining / 60000);
				this.sendReply(`|html|<p style="color:#e74c3c;margin:4px 0">Please wait ${minutes} minute${minutes !== 1 ? 's' : ''} before sending another report.</p>`);
				return;
			}

			let payload: any;
			try {
				payload = JSON.parse(Buffer.from(target, 'base64').toString('utf8'));
			} catch {
				return;
			}
			const message = String(payload.message ?? '').trim().slice(0, 2000);
			if (!message) return;

			feedbackCooldowns.set(user.id, now);

			const game = nuzlockeGames.get(user.id);
			postBugReportToDiscord({
				message,
				username: user.name,
				screen: payload.context?.curScreen ?? game?.curRoom,
				recentCommands: payload.context?.recentCommands,
				userAgent: payload.context?.userAgent,
				gameState: game?.toJSON(),
			});
			this.sendReply('|html|<p style="color:var(--nz-success,#2ecc71);margin:4px 0">Report sent — thanks!</p>');
		},

		logerror(target, room, user) {
			let payload: any;
			try {
				payload = JSON.parse(Buffer.from(target, 'base64').toString('utf8'));
			} catch {
				return;
			}
			const game = nuzlockeGames.get(user.id);
			const segment = game?.scenario.segments[game.currentSegmentIndex];
			logNuzlockeError({
				timestamp: new Date().toISOString(),
				source: 'client',
				error: { message: payload.error?.message ?? 'Unknown', stack: payload.error?.stack },
				gameState: game?.toJSON(),
				scenarioId: game?.scenario.id,
				segmentId: segment?.id,
				context: { userId: user.id, ...payload.context },
			});
		},
	},
};
