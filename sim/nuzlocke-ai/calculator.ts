/**
 * Nuzlocke AI — Calculation Utilities
 *
 * Pure functions for damage estimation, speed comparison, and stat lookups.
 * No class state — pass battle/pokemon explicitly.
 * Shared by all AI difficulties; base.ts wraps these as instance methods.
 */

import type { Battle } from '../battle';
import type { Pokemon } from '../pokemon';

/**
 * Ability-granted type immunities (attacker ability → can bypass via Mold Breaker etc.)
 * Returns true if `defenderAbility` makes the defender immune to `moveType`,
 * accounting for Mold Breaker / Teravolt / Turboblaze on the attacker.
 */
const MOLD_BREAKER_ABILITIES = new Set(['moldbreaker', 'teravolt', 'turboblaze']);
const ABILITY_IMMUNITY: Record<string, string> = {
	// Gen 1–5
	levitate: 'Ground',
	flashfire: 'Fire',
	voltabsorb: 'Electric',
	lightningrod: 'Electric',
	motordrive: 'Electric',
	waterabsorb: 'Water',
	stormdrain: 'Water',
	sapsipper: 'Grass',
	// Gen 9
	eartheater: 'Ground',
	wellbakedbody: 'Fire',
	purifyingsalt: 'Ghost',
};

export function isAbilityImmune(
	attackerAbility: string,
	defenderAbility: string,
	moveType: string
): boolean {
	if (MOLD_BREAKER_ABILITIES.has(attackerAbility)) return false;
	return ABILITY_IMMUNITY[defenderAbility] === moveType;
}

export function getBoostedStat(
	pokemon: Pokemon,
	stat: 'atk' | 'def' | 'spa' | 'spd' | 'spe'
): number {
	const base = pokemon.storedStats[stat];
	const boost = pokemon.boosts[stat];
	const mult = boost >= 0 ? (2 + boost) / 2 : 2 / (2 - boost);
	return Math.floor(base * mult);
}

export function isIncapacitated(pokemon: Pokemon): boolean {
	return pokemon.status === 'slp' || pokemon.status === 'frz';
}

export function hasMoveCategory(
	battle: Battle,
	pokemon: Pokemon,
	category: 'Physical' | 'Special'
): boolean {
	return pokemon.moveSlots.some(slot => {
		const move = battle.dex.moves.get(slot.id);
		return move.category === category && move.basePower > 0;
	});
}

export function simulateDamage(
	battle: Battle,
	move: Move,
	attacker: Pokemon,
	defender: Pokemon
): { damage: number } {
	if (move.basePower === 0) return { damage: 0 };

	// Resolve effective move type (Pixilate / Aerilate / Refrigerate / Galvanize)
	let moveType = move.type;
	let typeChangingBonus = 1;
	if (moveType === 'Normal') {
		const typeAbilityMap: Partial<Record<string, string>> = {
			pixilate: 'Fairy', aerilate: 'Flying', refrigerate: 'Ice', galvanize: 'Electric',
		};
		const changedType = typeAbilityMap[attacker.ability as string];
		if (changedType) { moveType = changedType; typeChangingBonus = 1.2; }
	}

	if (!battle.dex.getImmunity(moveType, defender.types)) return { damage: 0 };
	if (isAbilityImmune(attacker.ability as string, defender.ability as string, moveType)) return { damage: 0 };
	const effExp = battle.dex.getEffectiveness(moveType, defender.types);
	const effectiveness = Math.pow(2, effExp);

	// Base power modifiers (ability)
	let basePower = move.basePower;
	if (attacker.ability === 'technician' && basePower <= 60) basePower = Math.floor(basePower * 1.5);
	if (attacker.ability === 'ironfist' && (move as AnyObject).flags?.punch) basePower = Math.floor(basePower * 1.2);
	if (attacker.ability === 'reckless' && ((move as AnyObject).recoil || (move as AnyObject).hasCrashDamage)) {
		basePower = Math.floor(basePower * 1.2);
	}
	if (attacker.ability === 'sheerforce' && (move as AnyObject).secondary) basePower = Math.floor(basePower * 1.3);

	// Attack / defense stats
	const isPhysical = move.category === 'Physical';
	let atkStat = getBoostedStat(attacker, isPhysical ? 'atk' : 'spa');
	let defStat = getBoostedStat(defender, isPhysical ? 'def' : 'spd');

	// Attack stat ability/item modifiers
	if (attacker.ability === 'hugepower' || attacker.ability === 'purepower') atkStat *= 2;
	if (isPhysical && (attacker.ability === 'hustle' || attacker.ability === 'gorillatactics')) {
		atkStat = Math.floor(atkStat * 1.5);
	}
	if (attacker.ability === 'defeatist' && attacker.hp * 2 <= attacker.maxhp) atkStat = Math.floor(atkStat * 0.5);
	if (attacker.ability === 'slowstart' && attacker.activeTurns <= 5) atkStat = Math.floor(atkStat * 0.5);
	if (isPhysical && attacker.item === 'choiceband') atkStat = Math.floor(atkStat * 1.5);
	if (!isPhysical && attacker.item === 'choicespecs') atkStat = Math.floor(atkStat * 1.5);

	// Defense stat ability/item modifiers
	if (isPhysical && defender.ability === 'furcoat') defStat *= 2;
	if (defender.item === 'eviolite' && battle.dex.species.get(defender.species.id).nfe) {
		defStat = Math.floor(defStat * 1.5);
	}
	// Sand/Snow defensive boosts
	const weather = battle.field.weather as string;
	if (!isPhysical) {
		if (weather === 'sandstorm' && defender.types.includes('Rock')) defStat = Math.floor(defStat * 1.5);
		if ((weather === 'hail' || weather === 'snow') && defender.types.includes('Ice')) defStat = Math.floor(defStat * 1.5);
	}

	// Base damage formula: trunc(trunc(trunc(2*L/5+2) * P * A / D) / 50) + 2
	const tr = Math.trunc;
	const baseDamage = tr(tr(tr(tr(2 * attacker.level / 5 + 2) * basePower * atkStat) / defStat) / 50) + 2;

	// STAB (Adaptability = 2x, normal = 1.5x)
	const isSTAB = attacker.types.includes(moveType);
	const stab = isSTAB ? (attacker.ability === 'adaptability' ? 2 : 1.5) : 1;

	// Weather offensive modifiers
	let weatherMod = 1;
	if (weather === 'sunnyday' || weather === 'desolateland') {
		if (moveType === 'Fire') weatherMod = 1.5;
		else if (moveType === 'Water') weatherMod = 0.5;
	} else if (weather === 'raindance' || weather === 'primordialsea') {
		if (moveType === 'Water') weatherMod = 1.5;
		else if (moveType === 'Fire') weatherMod = 0.5;
	}

	// Terrain offensive modifiers (attacker must be grounded)
	const attackerGrounded = !attacker.types.includes('Flying') &&
		attacker.ability !== 'levitate' && !attacker.volatiles['magnetrise'];
	const defenderGrounded = !defender.types.includes('Flying') &&
		defender.ability !== 'levitate' && !defender.volatiles['magnetrise'];
	let terrainMod = 1;
	const terrain = battle.field.terrain as string;
	if (attackerGrounded) {
		if (terrain === 'electricterrain' && moveType === 'Electric') terrainMod = 1.3;
		else if (terrain === 'grassyterrain' && moveType === 'Grass') terrainMod = 1.3;
		else if (terrain === 'psychicterrain' && moveType === 'Psychic') terrainMod = 1.3;
	}
	if (defenderGrounded && terrain === 'mistyterrain' && moveType === 'Dragon') terrainMod *= 0.5;

	// Burn: 0.5x physical (unless Guts)
	const burnMod = (isPhysical && attacker.status === 'brn' && attacker.ability !== 'guts') ? 0.5 : 1;

	// Life Orb
	const lifeOrbMod = attacker.item === 'lifeorb' ? 1.3 : 1;

	// Average damage roll (0.925 = midpoint of 0.85–1.0)
	return {
		damage: baseDamage * stab * effectiveness * weatherMod * terrainMod * typeChangingBonus * burnMod * lifeOrbMod * 0.925,
	};
}

export function getEffectiveSpeed(battle: Battle, pokemon: Pokemon): number {
	let speed = getBoostedStat(pokemon, 'spe');

	// Paralysis drops speed (Quick Feet ignores the drop and gives 1.5x instead)
	if (pokemon.status === 'par') {
		if (pokemon.ability === 'quickfeet') {
			speed = Math.floor(speed * 1.5);
		} else {
			speed = Math.floor(speed * (battle.gen >= 7 ? 0.5 : 0.25));
		}
	} else if (pokemon.ability === 'quickfeet' && pokemon.status) {
		speed = Math.floor(speed * 1.5);
	}

	// Choice Scarf
	if (pokemon.item === 'choicescarf') speed = Math.floor(speed * 1.5);

	// Slow Start halves speed for first 5 turns
	if (pokemon.ability === 'slowstart' && pokemon.activeTurns <= 5) speed = Math.floor(speed * 0.5);

	// Weather speed abilities
	const weather = battle.field.weather as string;
	if (pokemon.ability === 'swiftswim' && (weather === 'raindance' || weather === 'primordialsea')) {
		speed *= 2;
	} else if (pokemon.ability === 'chlorophyll' && (weather === 'sunnyday' || weather === 'desolateland')) {
		speed *= 2;
	} else if (pokemon.ability === 'sandrush' && weather === 'sandstorm') {
		speed *= 2;
	} else if (pokemon.ability === 'slushrush' && (weather === 'hail' || weather === 'snow')) {
		speed *= 2;
	} else if (pokemon.ability === 'surgesurfer' && battle.field.terrain === 'electricterrain') {
		speed *= 2;
	}

	// Tailwind doubles speed on that side
	if (pokemon.side.sideConditions['tailwind']) speed *= 2;

	return speed;
}

export function isFaster(battle: Battle, a: Pokemon, b: Pokemon): boolean {
	const spdA = getEffectiveSpeed(battle, a);
	const spdB = getEffectiveSpeed(battle, b);
	const trickRoom = !!battle.field.pseudoWeather['trickroom'];
	return trickRoom ? spdA < spdB : spdA > spdB;
}

export function maxOpponentDamage(battle: Battle, attacker: Pokemon, defender: Pokemon): number {
	let maxDamage = 0;
	for (const slot of attacker.moveSlots) {
		const m = battle.dex.moves.get(slot.id);
		if (m.basePower === 0 || !battle.dex.getImmunity(m.type, defender.types)) continue;
		if (isAbilityImmune(attacker.ability as string, defender.ability as string, m.type)) continue;
		const { damage } = simulateDamage(battle, m, attacker, defender);
		if (damage > maxDamage) maxDamage = damage;
	}
	return maxDamage;
}
