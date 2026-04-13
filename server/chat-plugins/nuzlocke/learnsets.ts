/**
 * Nuzlocke Simulator — Learnset Filtering
 *
 * Returns legal moves for a Pokemon given:
 *   - The generation of the scenario
 *   - The current level cap
 *   - The move IDs unlocked by TMs/HMs collected so far
 *
 * Combined movesets: an evolved Pokemon can use pre-evolution moves up to the cap.
 * This preserves the strategic value of the pokemon without requiring manual management.
 */

import type { OwnedPokemon } from './types';

export interface LegalMove {
	name: string;
	fromTM: boolean;
	fromHM: boolean;
	hpType?: string;  // Computed Hidden Power type (gen 2+, based on pokemon's IVs)
}

const HP_TYPES = [
	'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel',
	'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark',
];

export function hiddenPowerType(ivs: { hp: number; atk: number; def: number; spe: number; spa: number; spd: number }): string {
	const bits =
		(ivs.hp & 1) |
		((ivs.atk & 1) << 1) |
		((ivs.def & 1) << 2) |
		((ivs.spe & 1) << 3) |
		((ivs.spa & 1) << 4) |
		((ivs.spd & 1) << 5);
	return HP_TYPES[Math.floor(bits * 15 / 63)];
}

export function getLegalMoves(
	pokemon: OwnedPokemon,
	levelCap: number,
	generation: number,
	tmMoves: string[]
): LegalMove[] {
	const hpType = generation >= 2 && pokemon.ivs ? hiddenPowerType(pokemon.ivs) : undefined;
	const speciesName = pokemon.species;
	// Maps moveId -> minimum level learned (for learnset order sorting)
	const levelMoveMap = new Map<string, number>();
	const tmMoveIds = new Set<string>();
	const hmMoveIds = new Set<string>();

	// getFullLearnset includes all pre-evolution learnsets
	const fullLearnset = Dex.species.getFullLearnset(toID(speciesName));

	for (const entry of fullLearnset) {
		if (!entry.learnset) continue;
		for (const moveId in entry.learnset) {
			for (const source of entry.learnset[moveId]) {
				const m = source.match(/^(\d+)([A-Z])(\d*)$/i);
				if (!m) continue;
				const sourceGen = parseInt(m[1]);
				const sourceType = m[2].toUpperCase();
				const sourceLevel = m[3] ? parseInt(m[3]) : 0;

				if (sourceGen > generation) continue;

				// Level-up moves: only up to cap; track minimum learn level
				if (sourceType === 'L') {
					if (sourceLevel <= levelCap) {
						const existing = levelMoveMap.get(moveId);
						if (existing === undefined || sourceLevel < existing) {
							levelMoveMap.set(moveId, sourceLevel);
						}
					}
					continue;
				}

				// TM/HM moves: check against collected TM/HM move IDs
				if (sourceType === 'M' || sourceType === 'H') {
					if (tmMoves.some(m => toID(m) === moveId)) {
						if (sourceType === 'H') {
							hmMoveIds.add(moveId);
						} else {
							tmMoveIds.add(moveId);
						}
					}
					continue;
				}

				// Egg moves and tutor moves: not available in nuzlocke
			}
		}
	}

	// Level-up moves sorted by minimum learn level (learnset order).
	// Moves learnable both naturally and by TM/HM appear here, not in the TM/HM section.
	const toMove = (m: ReturnType<typeof Dex.moves.get>, fromTM: boolean, fromHM: boolean): LegalMove => {
		const result: LegalMove = { name: m.name, fromTM, fromHM };
		if (hpType && m.id === 'hiddenpower') result.hpType = hpType;
		return result;
	};

	const levelResults: LegalMove[] = [...levelMoveMap.entries()]
		.sort(([, a], [, b]) => a - b)
		.map(([id]) => Dex.moves.get(id))
		.filter(m => m.exists)
		.map(m => toMove(m, false, false));

	// TM moves after level-up moves, sorted by position in tmMoves (scenario TM number order).
	// Exclude moves already covered by the level-up section.
	const tmResults: LegalMove[] = [...tmMoveIds]
		.filter(id => !levelMoveMap.has(id))
		.sort((a, b) => {
			const ai = tmMoves.findIndex(m => toID(m) === a);
			const bi = tmMoves.findIndex(m => toID(m) === b);
			return ai - bi;
		})
		.map(id => Dex.moves.get(id))
		.filter(m => m.exists)
		.map(m => toMove(m, true, false));

	// HM moves last, sorted by position in tmMoves (scenario HM number order).
	// Exclude moves already covered by the level-up section.
	const hmResults: LegalMove[] = [...hmMoveIds]
		.filter(id => !levelMoveMap.has(id))
		.sort((a, b) => {
			const ai = tmMoves.findIndex(m => toID(m) === a);
			const bi = tmMoves.findIndex(m => toID(m) === b);
			return ai - bi;
		})
		.map(id => Dex.moves.get(id))
		.filter(m => m.exists)
		.map(m => toMove(m, false, true));

	return [...levelResults, ...tmResults, ...hmResults];
}
