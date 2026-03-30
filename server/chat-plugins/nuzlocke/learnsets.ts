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
}

export function getLegalMoves(
	pokemon: OwnedPokemon,
	levelCap: number,
	generation: number,
	tmMoves: string[]
): LegalMove[] {
	const speciesName = pokemon.species;
	const levelMoveIds = new Set<string>();
	const tmMoveIds = new Set<string>();

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

				// Level-up moves: only up to cap
				if (sourceType === 'L') {
					if (sourceLevel <= levelCap) levelMoveIds.add(moveId);
					continue;
				}

				// TM/HM moves: check against collected TM/HM move IDs
				if (sourceType === 'M' || sourceType === 'H') {
					if (tmMoves.some(m => toID(m) === moveId)) {
						tmMoveIds.add(moveId);
					}
					continue;
				}

				// Egg moves and tutor moves: not available in nuzlocke
			}
		}
	}

	const allMoveIds = new Set([...levelMoveIds, ...tmMoveIds]);

	return [...allMoveIds]
		.map(id => Dex.moves.get(id))
		.filter(m => m.exists)
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(m => ({ name: m.name, fromTM: tmMoveIds.has(m.id) }));
}
