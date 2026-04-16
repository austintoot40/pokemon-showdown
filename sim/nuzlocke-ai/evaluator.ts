/**
 * Nuzlocke AI — Position Evaluator
 *
 * Defines ProjectedState (lightweight battle snapshot) and PositionEvaluator
 * (formula-based position scoring). Used by CompetitiveAI for depth-1 minimax.
 *
 * projectMoveState / projectSwitchInState compute the expected state after
 * one action without touching the real Battle object.
 */

import type { Battle } from '../battle';
import type { Pokemon } from '../pokemon';
import { simulateDamage, getEffectiveSpeed, isFaster } from './calculator';

// ─── State types ─────────────────────────────────────────────────────────────

export interface HazardState {
	stealthRock: boolean;
	spikes: number;       // 0–3
	toxicSpikes: number;  // 0–2
	stickyWeb: boolean;
}

export interface ProjectedState {
	// Active Pokémon HP
	aiHp: number;       aiMaxHp: number;
	oppHp: number;      oppMaxHp: number;
	// Status
	aiStatus: string;   oppStatus: string;
	aiToxicCounter: number;  oppToxicCounter: number;
	// Stat boosts
	aiBoosts: Partial<BoostsTable>;
	oppBoosts: Partial<BoostsTable>;
	// Hazards
	hazardsOnOppSide: HazardState;
	hazardsOnAiSide: HazardState;
	// Team health (sum of HP fractions for living bench Pokémon)
	aiTeamHpFrac: number;
	oppTeamHpFrac: number;
	// Field
	weather: string;
	terrain: string;
	trickRoom: boolean;
}

// ─── State projection ─────────────────────────────────────────────────────────

function readHazards(side: any): HazardState {
	const sc = side.sideConditions;
	return {
		stealthRock: !!sc['stealthrock'],
		spikes: sc['spikes'] ? ((sc['spikes'] as AnyObject).layers ?? 1) : 0,
		toxicSpikes: sc['toxicspikes'] ? ((sc['toxicspikes'] as AnyObject).layers ?? 1) : 0,
		stickyWeb: !!sc['stickyweb'],
	};
}

function teamHpFrac(side: any): number {
	const bench = (side.pokemon as Pokemon[]).slice(1).filter((p: Pokemon) => !p.fainted && p.hp > 0);
	if (bench.length === 0) return 0;
	return bench.reduce((sum: number, p: Pokemon) => sum + p.hp / p.maxhp, 0) / bench.length;
}

/** Snapshot the current battle into a ProjectedState (no moves applied yet). */
export function snapshotState(battle: Battle, ai: Pokemon, opp: Pokemon): ProjectedState {
	return {
		aiHp: ai.hp, aiMaxHp: ai.maxhp,
		oppHp: opp.hp, oppMaxHp: opp.maxhp,
		aiStatus: ai.status || '',
		oppStatus: opp.status || '',
		aiToxicCounter: (ai.statusState as AnyObject)?.toxicTurns ?? 0,
		oppToxicCounter: (opp.statusState as AnyObject)?.toxicTurns ?? 0,
		aiBoosts: { ...ai.boosts },
		oppBoosts: { ...opp.boosts },
		hazardsOnOppSide: readHazards(battle.sides[0]),
		hazardsOnAiSide: readHazards(battle.sides[1]),
		aiTeamHpFrac: teamHpFrac(battle.sides[1]),
		oppTeamHpFrac: teamHpFrac(battle.sides[0]),
		weather: battle.field.weather as string || '',
		terrain: battle.field.terrain as string || '',
		trickRoom: !!battle.field.pseudoWeather['trickroom'],
	};
}

/** Apply a single damaging/status move to the state struct (no Battle mutation). */
function applyMove(battle: Battle, move: Move, attacker: 'ai' | 'opp', state: ProjectedState, ai: Pokemon, opp: Pokemon): void {
	const [attackerPoke, defenderHpKey] = attacker === 'ai'
		? [ai, 'oppHp' as const]
		: [opp, 'aiHp' as const];
	const defenderPoke = attacker === 'ai' ? opp : ai;

	if (move.basePower > 0) {
		const { damage } = simulateDamage(battle, move, attackerPoke, defenderPoke);
		state[defenderHpKey] = Math.max(0, state[defenderHpKey] - damage);
		return;
	}

	// Status move dispatch
	const moveId = move.id;
	const targetStatusKey = attacker === 'ai' ? 'oppStatus' : 'aiStatus';
	const targetHazardKey = attacker === 'ai' ? 'hazardsOnOppSide' : 'hazardsOnAiSide';
	const ownBoostKey = attacker === 'ai' ? 'aiBoosts' : 'oppBoosts';

	if (move.status && !state[targetStatusKey]) {
		state[targetStatusKey] = move.status;
	} else if (moveId === 'stealthrock') {
		state[targetHazardKey].stealthRock = true;
	} else if (moveId === 'spikes') {
		state[targetHazardKey].spikes = Math.min(3, state[targetHazardKey].spikes + 1);
	} else if (moveId === 'toxicspikes') {
		state[targetHazardKey].toxicSpikes = Math.min(2, state[targetHazardKey].toxicSpikes + 1);
	} else if (moveId === 'stickyweb') {
		state[targetHazardKey].stickyWeb = true;
	} else if (move.boosts) {
		const boosts = move.boosts as AnyObject;
		const current = state[ownBoostKey] as AnyObject;
		for (const stat of Object.keys(boosts)) {
			current[stat] = Math.max(-6, Math.min(6, (current[stat] ?? 0) + boosts[stat]));
		}
	} else if ((move as AnyObject).heal?.[0] > 0) {
		const fraction = (move as AnyObject).heal[0] / (move as AnyObject).heal[1];
		const hpKey = attacker === 'ai' ? 'aiHp' : 'oppHp';
		const maxHpKey = attacker === 'ai' ? 'aiMaxHp' : 'oppMaxHp';
		state[hpKey] = Math.min(state[maxHpKey], state[hpKey] + state[maxHpKey] * fraction);
	}
}

/** Apply end-of-turn effects (burn, poison, toxic, leftovers, weather chip). */
function applyEndOfTurn(state: ProjectedState, ai: Pokemon, opp: Pokemon): void {
	// Burn
	if (state.aiStatus === 'brn' && ai.ability !== 'guts') {
		state.aiHp = Math.max(0, state.aiHp - state.aiMaxHp / 16);
	}
	if (state.oppStatus === 'brn' && opp.ability !== 'guts') {
		state.oppHp = Math.max(0, state.oppHp - state.oppMaxHp / 16);
	}

	// Poison
	if (state.aiStatus === 'psn') state.aiHp = Math.max(0, state.aiHp - state.aiMaxHp / 8);
	if (state.oppStatus === 'psn') state.oppHp = Math.max(0, state.oppHp - state.oppMaxHp / 8);

	// Toxic (counter already at turn-start value)
	if (state.aiStatus === 'tox') {
		state.aiHp = Math.max(0, state.aiHp - state.aiMaxHp * (state.aiToxicCounter + 1) / 16);
		state.aiToxicCounter++;
	}
	if (state.oppStatus === 'tox') {
		state.oppHp = Math.max(0, state.oppHp - state.oppMaxHp * (state.oppToxicCounter + 1) / 16);
		state.oppToxicCounter++;
	}

	// Leftovers
	if (ai.item === 'leftovers') state.aiHp = Math.min(state.aiMaxHp, state.aiHp + state.aiMaxHp / 16);
	if (opp.item === 'leftovers') state.oppHp = Math.min(state.oppMaxHp, state.oppHp + state.oppMaxHp / 16);

	// Weather chip (sandstorm / hail)
	const weather = state.weather;
	if (weather === 'sandstorm') {
		const aiImmuneToSand = ai.types.some(t => ['Rock', 'Steel', 'Ground'].includes(t)) || ai.ability === 'sandveil' || ai.ability === 'sandrush' || ai.ability === 'sandforce';
		if (!aiImmuneToSand) state.aiHp = Math.max(0, state.aiHp - state.aiMaxHp / 16);
		const oppImmuneToSand = opp.types.some(t => ['Rock', 'Steel', 'Ground'].includes(t)) || opp.ability === 'sandveil' || opp.ability === 'sandrush' || opp.ability === 'sandforce';
		if (!oppImmuneToSand) state.oppHp = Math.max(0, state.oppHp - state.oppMaxHp / 16);
	} else if (weather === 'hail' || weather === 'snow') {
		if (!ai.types.includes('Ice')) state.aiHp = Math.max(0, state.aiHp - state.aiMaxHp / 16);
		if (!opp.types.includes('Ice')) state.oppHp = Math.max(0, state.oppHp - state.oppMaxHp / 16);
	}
}

/**
 * Project what the state looks like after both sides take one action.
 * ai/opp are the current active Pokémon. aiMove/oppMove are the chosen moves.
 * protect: if either side uses protect, the other side's damage is skipped.
 */
export function projectMoveState(
	battle: Battle,
	ai: Pokemon,
	opp: Pokemon,
	aiMove: Move,
	oppMove: Move
): ProjectedState {
	const state = snapshotState(battle, ai, opp);

	const aiProtects = ['protect', 'kingsshield', 'spikyshield', 'banefulbunker'].includes(aiMove.id);
	const oppProtects = ['protect', 'kingsshield', 'spikyshield', 'banefulbunker'].includes(oppMove.id);

	// Determine order
	const aiFirst = (() => {
		const aiPriority = aiMove.priority ?? 0;
		const oppPriority = oppMove.priority ?? 0;
		if (aiPriority !== oppPriority) return aiPriority > oppPriority;
		return isFaster(battle, ai, opp);
	})();

	const applyFirst = aiFirst ? 'ai' : 'opp';
	const applySecond = aiFirst ? 'opp' : 'ai';
	const firstMove = aiFirst ? aiMove : oppMove;
	const secondMove = aiFirst ? oppMove : aiMove;

	// Apply first actor
	const firstProtected = applyFirst === 'ai' ? oppProtects : aiProtects;
	if (!firstProtected) applyMove(battle, firstMove, applyFirst, state, ai, opp);

	// Skip second actor if first KO'd them
	const secondStillAlive = applyFirst === 'ai' ? state.oppHp > 0 : state.aiHp > 0;
	if (secondStillAlive) {
		const secondProtected = applySecond === 'ai' ? oppProtects : aiProtects;
		if (!secondProtected) applyMove(battle, secondMove, applySecond, state, ai, opp);
	}

	applyEndOfTurn(state, ai, opp);
	return state;
}

/**
 * Project the state assuming the AI switches in a benched Pokémon.
 * The opponent takes a free attack against the switch-in.
 */
export function projectSwitchInState(
	battle: Battle,
	switchIn: Pokemon,
	opp: Pokemon,
	oppMove: Move
): ProjectedState {
	// Build state from the switch-in's perspective
	const state: ProjectedState = {
		aiHp: switchIn.hp, aiMaxHp: switchIn.maxhp,
		oppHp: opp.hp, oppMaxHp: opp.maxhp,
		aiStatus: switchIn.status || '',
		oppStatus: opp.status || '',
		aiToxicCounter: (switchIn.statusState as AnyObject)?.toxicTurns ?? 0,
		oppToxicCounter: (opp.statusState as AnyObject)?.toxicTurns ?? 0,
		aiBoosts: { ...switchIn.boosts },
		oppBoosts: { ...opp.boosts },
		hazardsOnOppSide: readHazards(battle.sides[0]),
		hazardsOnAiSide: readHazards(battle.sides[1]),
		aiTeamHpFrac: teamHpFrac(battle.sides[1]),
		oppTeamHpFrac: teamHpFrac(battle.sides[0]),
		weather: battle.field.weather as string || '',
		terrain: battle.field.terrain as string || '',
		trickRoom: !!battle.field.pseudoWeather['trickroom'],
	};

	// Apply hazard damage to switch-in
	const hazards = state.hazardsOnAiSide;
	if (hazards.stealthRock) {
		const rockEff = Math.pow(2, battle.dex.getEffectiveness('Rock', switchIn));
		state.aiHp = Math.max(0, state.aiHp - state.aiMaxHp * rockEff / 8);
	}
	const isGrounded = !switchIn.types.includes('Flying') && switchIn.ability !== 'levitate';
	if (hazards.spikes > 0 && isGrounded) {
		const spikeFraction = [0, 1 / 8, 1 / 6, 1 / 4][Math.min(hazards.spikes, 3)];
		state.aiHp = Math.max(0, state.aiHp - state.aiMaxHp * spikeFraction);
	}

	// Opponent attacks the switch-in (uses best available move)
	if (oppMove.basePower > 0 && battle.dex.getImmunity(oppMove.type, switchIn)) {
		const { damage } = simulateDamage(battle, oppMove, opp, switchIn);
		state.aiHp = Math.max(0, state.aiHp - damage);
	}

	applyEndOfTurn(state, switchIn, opp);
	return state;
}

// ─── Position evaluator ───────────────────────────────────────────────────────

export class PositionEvaluator {
	constructor(private battle: Battle) {}

	evaluate(state: ProjectedState): number {
		if (state.oppHp <= 0) return Infinity;
		if (state.aiHp <= 0) return -Infinity;

		let score = 0;

		// HP ratio advantage (most important signal)
		score += 100 * (state.aiHp / state.aiMaxHp - state.oppHp / state.oppMaxHp);

		// Team depth advantage
		score += 40 * (state.aiTeamHpFrac - state.oppTeamHpFrac);

		// Status on opponent vs self
		score += this.statusValue(state.oppStatus, state.oppToxicCounter);
		score -= this.statusValue(state.aiStatus, state.aiToxicCounter);

		// Hazard advantage (expected chip to opponent's remaining team)
		score += this.hazardValue(state.hazardsOnOppSide, this.battle.sides[0]);
		score -= this.hazardValue(state.hazardsOnAiSide, this.battle.sides[1]);

		return score;
	}

	/** Convert a status condition to a score bonus (damage-equivalent estimate). */
	private statusValue(status: string, toxicCounter: number): number {
		switch (status) {
		case 'slp': return 20;  // ~2 free turns
		case 'frz': return 20;  // same
		case 'par': return 8;   // speed cut + 25% full para
		case 'brn': return 10;  // ongoing 1/16 + Atk cut
		case 'tox': return 6 + toxicCounter * 2;  // escalating chip
		case 'psn': return 6;   // 1/8 per turn
		default: return 0;
		}
	}

	/** Estimate total HP lost to hazards for remaining bench Pokémon. */
	private hazardValue(hazards: HazardState, side: any): number {
		const bench = (side.pokemon as Pokemon[]).filter((p: Pokemon) => !p.fainted && !p.isActive && p.hp > 0);
		if (bench.length === 0) return 0;
		let totalFraction = 0;
		for (const p of bench) {
			if (hazards.stealthRock) {
				const rockEff = Math.pow(2, this.battle.dex.getEffectiveness('Rock', p));
				totalFraction += rockEff / 8;
			}
			const isGrounded = !p.types.includes('Flying') && p.ability !== 'levitate';
			if (hazards.spikes > 0 && isGrounded) {
				const spikeFraction = [0, 1 / 8, 1 / 6, 1 / 4][Math.min(hazards.spikes, 3)];
				totalFraction += spikeFraction;
			}
		}
		// Normalize to per-Pokemon fraction, scale by 20
		return (totalFraction / bench.length) * 20;
	}
}
