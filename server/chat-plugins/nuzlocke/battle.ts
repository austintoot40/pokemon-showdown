/**
 * Nuzlocke Simulator — Battle preparation and event handlers
 */

'use strict';

import { nuzlockeGames, NuzlockeGame, recordCompletedRun } from './game';
import { getLegalMoves } from './learnsets';
import type { OwnedPokemon, TrainerPokemon } from './types';

// ---------------------------------------------------------------------------
// Team packing
// ---------------------------------------------------------------------------

function packPlayerTeam(game: NuzlockeGame): string {
	const partyPokemon = game.party
		.map(uid => game.box.find(p => p.uid === uid)!)
		.filter(Boolean);

	const sets: PokemonSet[] = partyPokemon.map(p => {
		const moves = p.moves.length ? p.moves : getDefaultMoves(p, game);
		return {
			name: p.nickname || p.species,
			species: p.species,
			gender: p.gender,
			item: p.item || '',
			ability: p.ability,
			moves,
			nature: p.nature,
			evs: p.evs,
			ivs: p.ivs,
			level: game.currentSegment!.levelCap,
		};
	});

	return Teams.pack(sets);
}

function getDefaultMoves(p: OwnedPokemon, game: NuzlockeGame): string[] {
	const segment = game.currentSegment!;
	return getLegalMoves(p, segment.levelCap, game.scenario.generation, game.tmMoves)
		.slice(0, 4).map(m => m.name);
}

/** Auto-fill party + moves, then navigate to teambuilding. Use instead of game.goToPage('teambuilding'). */
export function goToTeambuilding(game: NuzlockeGame) {
	game.autoFillParty();
	// Auto-fill moves for any party Pokemon with no moves assigned
	const segment = game.currentSegment;
	if (segment) {
		for (const p of game.box) {
			if (!p.alive) continue;
			const filled = p.moves.filter(Boolean);
			if (filled.length < 4) {
				// Fill empty slots with level-up moves (no TMs — those require manual selection)
				const filledIds = new Set(filled.map(m => toID(m)));
				const legal = getLegalMoves(p, segment.levelCap, game.scenario.generation, []);
				const toAdd = legal.filter(m => !filledIds.has(toID(m.name))).slice(0, 4 - filled.length);
				p.moves = [...filled, ...toAdd.map(m => m.name)];
			}
		}
	}
	game.goToPage('teambuilding');
}

function packTrainerTeam(team: TrainerPokemon[]): string {
	const sets: PokemonSet[] = team.map(t => ({
		name: t.species,
		species: t.species,
		item: t.item || '',
		ability: t.ability,
		moves: t.moves,
		nature: 'Hardy',
		evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
		ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
		level: t.level,
		gender: '',
	}));

	return Teams.pack(sets);
}

// ---------------------------------------------------------------------------
// Battle creation
// ---------------------------------------------------------------------------

export function createNuzlockeBattle(game: NuzlockeGame, user: User) {
	const segment = game.currentSegment!;
	const battle = game.currentBattle!;
	const gen = game.scenario.generation;
	const isDoubles = battle.battleType === 'doubles';

	game.partyErrors.clear();

	Rooms.createBattle({
		format: `gen${gen}nuzlocke${isDoubles ? 'doubles' : ''}battle`,
		isNuzlockeBattle: true,
		players: [
			{
				user,
				team: packPlayerTeam(game),
			},
			{
				user: null,
				username: battle.trainer,
				team: packTrainerTeam(battle.team),
				isAI: true,
				nuzlockeDifficulty: game.settings.ai,
				avatar: battle.sprite,
			},
		],
	});
}

// ---------------------------------------------------------------------------
// Death extraction from battle log
// ---------------------------------------------------------------------------

function extractDeaths(battle: import('../../room-battle').RoomBattle, game: NuzlockeGame) {
	const deaths: { uid: string; killedBy: string }[] = [];
	const trainerBattle = game.currentBattle!;
	const log = battle.room.log.log;

	// Track last move used against each player Pokemon by position name
	const lastMoveAgainst = new Map<string, string>();

	for (const line of log) {
		// Track moves used against p1: |move|p2a: Attacker|MoveName|p1a: Target
		if (line.startsWith('|move|p2')) {
			const parts = line.split('|');
			const attacker = parts[2]?.split(': ')[1] ?? '';
			const move = parts[3] ?? '';
			const target = parts[4]?.split(': ')[1] ?? '';
			if (target) {
				lastMoveAgainst.set(target, `${trainerBattle.trainer}'s ${attacker} (${move})`);
			}
		}

		// Detect player Pokemon fainting: |faint|p1a: Name
		if (line.startsWith('|faint|p1')) {
			const pokemonName = line.split(': ')[1]?.trim();
			if (!pokemonName) continue;

			// Match to party Pokemon by nickname or species
			const partyPokemon = game.party
				.map(uid => game.box.find(p => p.uid === uid)!)
				.filter(Boolean)
				.find(p => p.nickname === pokemonName || p.species === pokemonName);

			if (partyPokemon) {
				deaths.push({
					uid: partyPokemon.uid,
					killedBy: lastMoveAgainst.get(pokemonName) ?? 'Unknown',
				});
			}
		}
	}

	return deaths;
}

// ---------------------------------------------------------------------------
// Handlers export
// ---------------------------------------------------------------------------

export const battleHandlers: Chat.Handlers = {
	onBattleStart(user, room) {
		if (!(room.battle?.options as AnyObject | undefined)?.isNuzlockeBattle) return;
		if (!user) return;
		const game = nuzlockeGames.get(user.id);
		if (!game) return;
		game.inBattle = true;
		game.battleRoomId = room.roomid;
		game.goToPage('battle');
	},

	onBattleEnd(battle, winner, players) {
		if (!(battle.options as AnyObject).isNuzlockeBattle) return;

		const humanId = players[0];
		const game = nuzlockeGames.get(humanId);
		if (!game) return;

		game.inBattle = false;
		game.battleRoomId = null;

		// Detect and record deaths
		const deaths = extractDeaths(battle, game);
		for (const { uid, killedBy } of deaths) {
			const pokemon = game.box.find(p => p.uid === uid);
			if (!pokemon) continue;
			pokemon.alive = false;
			game.graveyard.push({
				uid: pokemon.uid,
				species: pokemon.species,
				nickname: pokemon.nickname,
				caughtRoute: pokemon.caughtRoute,
				killedBy,
				segment: game.currentSegment?.id ?? '',
			});
		}

		game.cleanParty();

		// Check for total wipe — go straight to summary, no results page
		const alive = game.box.filter(p => p.alive);
		if (alive.length === 0) {
			recordCompletedRun(game, 'wipe', game.currentBattle?.trainer);
			game.goToPage('summary');
			return;
		}

		const playerWon = humanId === winner;
		const trainerName = game.currentBattle?.trainer ?? 'the trainer';
		const battleDeaths = deaths.map(({ uid }) => game.graveyard.find(d => d.uid === uid)!).filter(Boolean);

		if (playerWon) {
			game.nextScreen = game.advanceAfterWin();
		} else {
			game.nextScreen = 'teambuilding';
		}
		if (game.nextScreen === 'summary') {
			recordCompletedRun(game, 'victory', trainerName);
		}
		game.lastBattleResult = { won: playerWon, perfect: playerWon && deaths.length === 0, trainerName, deaths: battleDeaths };
		game.goToPage('results');
	},
};
