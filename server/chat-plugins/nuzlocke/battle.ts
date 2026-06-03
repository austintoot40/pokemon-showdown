/**
 * Nuzlocke Simulator — Battle preparation and event handlers
 */

'use strict';

import { nuzlockeGames, NuzlockeGame, recordCompletedRun, deleteGame, pushNuzlockeStatus, pushNuzlockeState, closeNuzlockePanel, saveGame } from './game';
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
		const legalMoveIds = new Set(
			getLegalMoves(p, game.currentLevelCap, game.learnsetGeneration, game.tmMoves)
				.map(m => toID(m.name))
		);
		const raw = p.moves.length ? p.moves : getDefaultMoves(p, game);
		// Strip any moves that aren't legal for this Pokemon at the current level cap.
		// This is the last line of defense — commands that set moves should also validate,
		// but we enforce it here regardless of how moves ended up in game state.
		const moves = raw.filter(m => legalMoveIds.has(toID(m)));
		return {
			name: p.nickname || p.species,
			species: p.species,
			gender: p.gender,
			item: p.item || '',
			ability: p.ability,
			moves: moves.length ? moves : getDefaultMoves(p, game),
			nature: p.nature,
			evs: p.evs,
			ivs: p.ivs,
			level: game.currentLevelCap,
		};
	});

	return Teams.pack(sets);
}

function getDefaultMoves(p: OwnedPokemon, game: NuzlockeGame): string[] {
	return getLegalMoves(p, game.currentLevelCap, game.learnsetGeneration, game.tmMoves)
		.slice(0, 4).map(m => m.name);
}

/** Auto-fill party + moves, then navigate to teambuilding. Use instead of game.goToPage('teambuilding').
 *  Pass skipAutoFill=true for chained battles to keep party as-is (box is locked). */
export function goToTeambuilding(game: NuzlockeGame, skipAutoFill = false) {
	if (!skipAutoFill) game.autoFillParty();
	// Auto-fill moves for any party Pokemon with no moves assigned
	if (game.currentSegment) {
		for (const p of game.box) {
			if (!p.alive) continue;
			const filled = p.moves.filter(Boolean);
			if (filled.length < 4) {
				// Fill empty slots with level-up moves (no TMs — those require manual selection)
				const filledIds = new Set(filled.map(m => toID(m)));
				const legal = getLegalMoves(p, game.currentLevelCap, game.learnsetGeneration, []);
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
	const gen = game.settings.generation;
	const isDoubles = battle.battleType === 'doubles';
	const isModernized = gen === 9 && game.scenario.generation !== 9;
	const doublesTag = isDoubles ? 'doubles' : '';
	const formatId = isModernized
		? `gen9modernizednuzlocke${doublesTag}battle`
		: `gen${gen}nuzlocke${doublesTag}battle`;

	const resolvedFormat = Dex.formats.get(formatId);
	console.log(`[nuzlocke] createBattle: formatId=${formatId} exists=${resolvedFormat.exists} mod=${resolvedFormat.mod ?? 'none'} settings.gen=${gen} scenario.gen=${game.scenario.generation} isModernized=${isModernized}`);

	const playerTeam = packPlayerTeam(game);

	game.partyErrors.clear();

	Rooms.createBattle({
		format: formatId,
		isNuzlockeBattle: true,
		players: [
			{
				user,
				username: 'Player',
				team: playerTeam,
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

		const playerWon = winner === toID(battle.p1.name);

		if (!playerWon) {
			// Any loss ends the run immediately — no retry
			game.curRoom = 'wipe';
			recordCompletedRun(game, 'wipe');
			pushNuzlockeState(humanId as ID, game);
			nuzlockeGames.delete(humanId as ID);
			void deleteGame(humanId as ID);
			pushNuzlockeStatus(humanId as ID, null);
			// Panel stays open for Hall of Shame screen; client sends /nuzlocke done to close it.
			return;
		}

		const trainerName = game.currentBattle?.trainer ?? 'the trainer';
		const battleDeaths = deaths.map(({ uid }) => game.graveyard.find(d => d.uid === uid)!).filter(Boolean);
		game.lastBattleResult = { won: true, perfect: deaths.length === 0, trainerName, deaths: battleDeaths };

		const dest = game.advanceAfterWin();
		if (dest === 'done') {
			game.curRoom = 'done';
			recordCompletedRun(game, 'victory');
			pushNuzlockeState(humanId as ID, game);
			nuzlockeGames.delete(humanId as ID);
			void deleteGame(humanId as ID);
			pushNuzlockeStatus(humanId as ID, null);
			// Panel stays open for victory screen; client sends /nuzlocke done to close it.
		} else if (dest === 'teambuilding') {
			// Chained battle — go to teambuilder with box locked; don't auto-fill party
			goToTeambuilding(game, true);
		} else {
			game.goToPage(dest);
		}
	},
};
