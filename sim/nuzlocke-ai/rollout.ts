/**
 * Nuzlocke AI — Rollout Engine
 *
 * Multi-turn state representation and simulation for MCTS rollouts.
 * Tracks per-Pokémon HP/status for all team members so battles can be
 * simulated across KOs and switch-ins without touching the real Battle object.
 *
 * `ref` fields are never mutated — only hp/status/fainted in RolloutMon change.
 */

import type { Battle } from '../battle';
import type { Pokemon } from '../pokemon';
import type { HazardState } from './evaluator';
import { simulateDamage, isFaster, isAbilityImmune } from './calculator';

// ─── State types ──────────────────────────────────────────────────────────────

export interface RolloutMon {
	ref: Pokemon;        // real Pokémon — for ability/item/move/type lookups (read-only)
	hp: number;
	maxHp: number;
	status: string;      // '' | 'brn' | 'psn' | 'tox' | 'par' | 'slp' | 'frz'
	toxicCounter: number;
	fainted: boolean;
}

export interface RolloutState {
	ai: RolloutMon[];
	opp: RolloutMon[];
	aiActiveIdx: number;
	oppActiveIdx: number;
	hazardsOnAiSide: HazardState;
	hazardsOnOppSide: HazardState;
	weather: string;
	terrain: string;
	trickRoom: boolean;
	turn: number;
	/** ID of the last move used by the AI's active mon (for Protect consecutive-use modeling). */
	lastAiMoveId: string;
	/** ID of the last move used by the opponent's active mon. */
	lastOppMoveId: string;
}

// ─── Initialization ───────────────────────────────────────────────────────────

function buildTeam(side: any): RolloutMon[] {
	return (side.pokemon as Pokemon[]).map((p: Pokemon) => ({
		ref: p,
		hp: p.hp,
		maxHp: p.maxhp,
		status: p.status || '',
		toxicCounter: (p.statusState as AnyObject)?.toxicTurns ?? 0,
		fainted: p.fainted || p.hp <= 0,
	}));
}

function readHazards(side: any): HazardState {
	const sc = side.sideConditions;
	return {
		stealthRock: !!sc['stealthrock'],
		spikes: sc['spikes'] ? ((sc['spikes'] as AnyObject).layers ?? 1) : 0,
		toxicSpikes: sc['toxicspikes'] ? ((sc['toxicspikes'] as AnyObject).layers ?? 1) : 0,
		stickyWeb: !!sc['stickyweb'],
	};
}

export function initRolloutState(battle: Battle): RolloutState {
	const aiSide = battle.sides[1];
	const oppSide = battle.sides[0];
	return {
		ai: buildTeam(aiSide),
		opp: buildTeam(oppSide),
		aiActiveIdx: aiSide.pokemon.indexOf(aiSide.active[0]),
		oppActiveIdx: oppSide.pokemon.indexOf(oppSide.active[0]),
		hazardsOnAiSide: readHazards(aiSide),
		hazardsOnOppSide: readHazards(oppSide),
		weather: (battle.field.weather as string) || '',
		terrain: (battle.field.terrain as string) || '',
		trickRoom: !!battle.field.pseudoWeather['trickroom'],
		turn: 0,
		lastAiMoveId: (aiSide.active[0] as AnyObject)?.lastMove?.id ?? '',
		lastOppMoveId: (oppSide.active[0] as AnyObject)?.lastMove?.id ?? '',
	};
}

export function cloneRolloutState(state: RolloutState): RolloutState {
	return {
		ai: state.ai.map(m => ({ ...m })),
		opp: state.opp.map(m => ({ ...m })),
		aiActiveIdx: state.aiActiveIdx,
		oppActiveIdx: state.oppActiveIdx,
		hazardsOnAiSide: { ...state.hazardsOnAiSide },
		hazardsOnOppSide: { ...state.hazardsOnOppSide },
		weather: state.weather,
		terrain: state.terrain,
		trickRoom: state.trickRoom,
		turn: state.turn,
		lastAiMoveId: state.lastAiMoveId,
		lastOppMoveId: state.lastOppMoveId,
	};
}

// ─── Rollout policy ───────────────────────────────────────────────────────────

const PROTECT_MOVES = new Set(['protect', 'kingsshield', 'spikyshield', 'banefulbunker']);

/**
 * Returns a 0-based move index for the given side.
 * Picks the move with the highest expected damage against the opponent.
 * Falls back to the least-useless non-damaging move rather than always index 0.
 */
export function rolloutPolicy(battle: Battle, state: RolloutState, side: 'ai' | 'opp'): number {
	const team = side === 'ai' ? state.ai : state.opp;
	const oppTeam = side === 'ai' ? state.opp : state.ai;
	const activeIdx = side === 'ai' ? state.aiActiveIdx : state.oppActiveIdx;
	const oppActiveIdx = side === 'ai' ? state.oppActiveIdx : state.aiActiveIdx;
	const attacker = team[activeIdx].ref;
	const defender = oppTeam[oppActiveIdx].ref;
	const defenderMon = oppTeam[oppActiveIdx];
	const targetHazards = side === 'ai' ? state.hazardsOnOppSide : state.hazardsOnAiSide;
	const lastMoveId = side === 'ai' ? state.lastAiMoveId : state.lastOppMoveId;

	let bestIdx = -1;
	let bestDamage = -1;

	for (let i = 0; i < attacker.moveSlots.length; i++) {
		const slot = attacker.moveSlots[i];
		if (slot.disabled) continue;
		const move = battle.dex.moves.get(slot.id);
		if (move.basePower === 0) continue;
		if (!battle.dex.getImmunity(move.type, defender.types)) continue;
		if (isAbilityImmune(attacker.ability as string, defender.ability as string, move.type)) continue;
		const { damage } = simulateDamage(battle, move, attacker, defender);
		if (damage > bestDamage) {
			bestDamage = damage;
			bestIdx = i;
		}
	}

	if (bestIdx >= 0) return bestIdx;

	// No damaging move available. Pick the least-useless non-damaging move,
	// skipping options that would clearly be no-ops.
	for (let i = 0; i < attacker.moveSlots.length; i++) {
		const move = battle.dex.moves.get(attacker.moveSlots[i].id);
		// Skip consecutive Protect (would fail in the sim anyway)
		if (PROTECT_MOVES.has(move.id) && PROTECT_MOVES.has(lastMoveId)) continue;
		// Skip status infliction moves on an already-statused target
		if (move.status && defenderMon.status) continue;
		// Skip hazard moves that are already at max layers
		if (move.id === 'stealthrock' && targetHazards.stealthRock) continue;
		if (move.id === 'spikes' && targetHazards.spikes >= 3) continue;
		if (move.id === 'toxicspikes' && targetHazards.toxicSpikes >= 2) continue;
		if (move.id === 'stickyweb' && targetHazards.stickyWeb) continue;
		return i;
	}

	return 0; // ultimate fallback
}

// ─── Hazard and switch helpers ────────────────────────────────────────────────

function applyHazardChip(battle: Battle, mon: RolloutMon, hazards: HazardState): void {
	if (hazards.stealthRock) {
		const rockEff = Math.pow(2, battle.dex.getEffectiveness('Rock', mon.ref));
		mon.hp = Math.max(0, mon.hp - mon.maxHp * rockEff / 8);
	}
	const isGrounded = !mon.ref.types.includes('Flying') && mon.ref.ability !== 'levitate';
	if (hazards.spikes > 0 && isGrounded) {
		const spikeFraction = [0, 1 / 8, 1 / 6, 1 / 4][Math.min(hazards.spikes, 3)];
		mon.hp = Math.max(0, mon.hp - mon.maxHp * spikeFraction);
	}
	if (mon.hp <= 0) mon.fainted = true;
}

/**
 * After a KO on `side`, switch in the best available bench mon.
 * Applies hazard chip on entry. Updates active index in place.
 */
function switchInBest(battle: Battle, state: RolloutState, side: 'ai' | 'opp'): void {
	const team = side === 'ai' ? state.ai : state.opp;
	const oppTeam = side === 'ai' ? state.opp : state.ai;
	const oppActiveIdx = side === 'ai' ? state.oppActiveIdx : state.aiActiveIdx;
	const currentActiveIdx = side === 'ai' ? state.aiActiveIdx : state.oppActiveIdx;
	const hazards = side === 'ai' ? state.hazardsOnAiSide : state.hazardsOnOppSide;
	const defender = oppTeam[oppActiveIdx].ref;

	let bestIdx = -1;
	let bestScore = -Infinity;

	for (let i = 0; i < team.length; i++) {
		if (i === currentActiveIdx) continue;
		if (team[i].fainted) continue;
		// Score by best offensive type effectiveness against current opponent
		let offScore = 0;
		for (const slot of team[i].ref.moveSlots) {
			const move = battle.dex.moves.get(slot.id);
			if (move.basePower > 0 && battle.dex.getImmunity(move.type, defender.types) &&
					!isAbilityImmune(team[i].ref.ability as string, defender.ability as string, move.type)) {
				const eff = Math.pow(2, battle.dex.getEffectiveness(move.type, defender.types));
				if (eff > offScore) offScore = eff;
			}
		}
		if (offScore > bestScore) { bestScore = offScore; bestIdx = i; }
	}

	if (bestIdx === -1) return; // all fainted — terminal, leave index unchanged

	applyHazardChip(battle, team[bestIdx], hazards);
	if (side === 'ai') {
		state.aiActiveIdx = bestIdx;
	} else {
		state.oppActiveIdx = bestIdx;
	}
}

// ─── Status move application ──────────────────────────────────────────────────

function applyStatusMove(state: RolloutState, move: Move, attackerSide: 'ai' | 'opp'): void {
	const moveId = move.id;
	const targetHazardKey = attackerSide === 'ai' ? 'hazardsOnOppSide' : 'hazardsOnAiSide' as const;
	const defenderTeam = attackerSide === 'ai' ? state.opp : state.ai;
	const attackerTeam = attackerSide === 'ai' ? state.ai : state.opp;
	const defenderActiveIdx = attackerSide === 'ai' ? state.oppActiveIdx : state.aiActiveIdx;
	const attackerActiveIdx = attackerSide === 'ai' ? state.aiActiveIdx : state.oppActiveIdx;
	const defenderMon = defenderTeam[defenderActiveIdx];
	const attackerMon = attackerTeam[attackerActiveIdx];

	if (move.status && !defenderMon.status) {
		defenderMon.status = move.status;
	} else if (moveId === 'stealthrock') {
		state[targetHazardKey].stealthRock = true;
	} else if (moveId === 'spikes') {
		state[targetHazardKey].spikes = Math.min(3, state[targetHazardKey].spikes + 1);
	} else if (moveId === 'toxicspikes') {
		state[targetHazardKey].toxicSpikes = Math.min(2, state[targetHazardKey].toxicSpikes + 1);
	} else if (moveId === 'stickyweb') {
		state[targetHazardKey].stickyWeb = true;
	} else if ((move as AnyObject).heal?.[0] > 0) {
		const fraction = (move as AnyObject).heal[0] / (move as AnyObject).heal[1];
		attackerMon.hp = Math.min(attackerMon.maxHp, attackerMon.hp + attackerMon.maxHp * fraction);
	}
	// Stat boosts / other effects: no-op (boosts not tracked in rollouts)
}

// ─── End-of-turn effects ──────────────────────────────────────────────────────

function applyRolloutEndOfTurn(state: RolloutState): void {
	const apply = (mon: RolloutMon) => {
		if (mon.fainted) return;
		if (mon.status === 'brn' && mon.ref.ability !== 'guts') {
			mon.hp = Math.max(0, mon.hp - mon.maxHp / 16);
		}
		if (mon.status === 'psn') mon.hp = Math.max(0, mon.hp - mon.maxHp / 8);
		if (mon.status === 'tox') {
			if (mon.ref.ability === 'poisonheal') {
				mon.hp = Math.min(mon.maxHp, mon.hp + mon.maxHp / 8);
			} else {
				mon.hp = Math.max(0, mon.hp - mon.maxHp * (mon.toxicCounter + 1) / 16);
				mon.toxicCounter++;
			}
		}
		if (mon.ref.item === 'leftovers') mon.hp = Math.min(mon.maxHp, mon.hp + mon.maxHp / 16);
		if (mon.hp <= 0) mon.fainted = true;
	};

	const aiActive = state.ai[state.aiActiveIdx];
	const oppActive = state.opp[state.oppActiveIdx];
	apply(aiActive);
	apply(oppActive);

	// Weather chip
	const w = state.weather;
	if (w === 'sandstorm') {
		const immune = (m: RolloutMon) =>
			m.ref.types.some((t: string) => ['Rock', 'Steel', 'Ground'].includes(t)) ||
			['sandveil', 'sandrush', 'sandforce'].includes(m.ref.ability as string);
		if (!aiActive.fainted && !immune(aiActive)) {
			aiActive.hp = Math.max(0, aiActive.hp - aiActive.maxHp / 16);
			if (aiActive.hp <= 0) aiActive.fainted = true;
		}
		if (!oppActive.fainted && !immune(oppActive)) {
			oppActive.hp = Math.max(0, oppActive.hp - oppActive.maxHp / 16);
			if (oppActive.hp <= 0) oppActive.fainted = true;
		}
	} else if (w === 'hail' || w === 'snow') {
		if (!aiActive.fainted && !aiActive.ref.types.includes('Ice')) {
			aiActive.hp = Math.max(0, aiActive.hp - aiActive.maxHp / 16);
			if (aiActive.hp <= 0) aiActive.fainted = true;
		}
		if (!oppActive.fainted && !oppActive.ref.types.includes('Ice')) {
			oppActive.hp = Math.max(0, oppActive.hp - oppActive.maxHp / 16);
			if (oppActive.hp <= 0) oppActive.fainted = true;
		}
	}
}

// ─── Step function ────────────────────────────────────────────────────────────

/**
 * Apply one turn of joint action. Returns a new state (original is not mutated).
 * After a KO, the KO'd side immediately switches in its best available Pokémon
 * (with hazard chip), and the switch-in takes no action this turn.
 */
export function stepRollout(
	battle: Battle,
	state: RolloutState,
	aiMoveIdx: number,
	oppMoveIdx: number
): RolloutState {
	const s = cloneRolloutState(state);

	const aiMon = s.ai[s.aiActiveIdx];
	const oppMon = s.opp[s.oppActiveIdx];

	// Guard: if either side is already terminal, don't step
	if (aiMon.fainted || oppMon.fainted) { s.turn++; return s; }

	const aiMove = battle.dex.moves.get(aiMon.ref.moveSlots[aiMoveIdx]?.id ?? 'tackle');
	const oppMove = battle.dex.moves.get(oppMon.ref.moveSlots[oppMoveIdx]?.id ?? 'tackle');

	// Protect fails on consecutive use — model as no protection (turn is still wasted)
	const aiProtects = PROTECT_MOVES.has(aiMove.id) && !PROTECT_MOVES.has(s.lastAiMoveId);
	const oppProtects = PROTECT_MOVES.has(oppMove.id) && !PROTECT_MOVES.has(s.lastOppMoveId);

	// Record last moves before any KO-triggered switch changes the active indices
	s.lastAiMoveId = aiMove.id;
	s.lastOppMoveId = oppMove.id;

	const aiPriority = aiMove.priority ?? 0;
	const oppPriority = oppMove.priority ?? 0;
	const aiFirst = aiPriority !== oppPriority
		? aiPriority > oppPriority
		: isFaster(battle, aiMon.ref, oppMon.ref);

	// Apply one side's action. Returns true if the defender was KO'd this action.
	const applyAction = (attackerSide: 'ai' | 'opp', move: Move, isProtected: boolean): boolean => {
		if (isProtected) return false;
		const attackerTeam = attackerSide === 'ai' ? s.ai : s.opp;
		const defenderTeam = attackerSide === 'ai' ? s.opp : s.ai;
		const attackerIdx = attackerSide === 'ai' ? s.aiActiveIdx : s.oppActiveIdx;
		const defenderIdx = attackerSide === 'ai' ? s.oppActiveIdx : s.aiActiveIdx;
		const attacker = attackerTeam[attackerIdx];
		const defender = defenderTeam[defenderIdx];
		if (attacker.fainted || defender.fainted) return false;

		if (move.basePower > 0) {
			if (battle.dex.getImmunity(move.type, defender.ref.types) &&
					!isAbilityImmune(attacker.ref.ability as string, defender.ref.ability as string, move.type)) {
				const { damage } = simulateDamage(battle, move, attacker.ref, defender.ref);
				defender.hp = Math.max(0, defender.hp - damage);
				if (defender.hp <= 0) {
					defender.fainted = true;
					// Switch in replacement for the KO'd side; switch-in acts next turn
					switchInBest(battle, s, attackerSide === 'ai' ? 'opp' : 'ai');
					return true;
				}
			}
		} else {
			applyStatusMove(s, move, attackerSide);
		}
		return false;
	};

	if (aiFirst) {
		const oppKOd = applyAction('ai', aiMove, oppProtects);
		// If opp was KO'd, the switch-in gets no action this turn
		if (!oppKOd) applyAction('opp', oppMove, aiProtects);
	} else {
		const aiKOd = applyAction('opp', oppMove, aiProtects);
		if (!aiKOd) applyAction('ai', aiMove, oppProtects);
	}

	applyRolloutEndOfTurn(s);
	s.turn++;
	return s;
}

// ─── Terminal check ───────────────────────────────────────────────────────────

export function isRolloutTerminal(state: RolloutState): boolean {
	return state.ai.every(m => m.fainted) || state.opp.every(m => m.fainted);
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

function statusValue(status: string, toxicCounter: number): number {
	switch (status) {
	case 'slp': return 20;
	case 'frz': return 20;
	case 'par': return 8;
	case 'brn': return 10;
	case 'tox': return 6 + toxicCounter * 2;
	case 'psn': return 6;
	default: return 0;
	}
}

/**
 * Evaluate a RolloutState from the AI's perspective.
 * Returns ±1000 for terminal states, otherwise the same weighted formula
 * as PositionEvaluator.evaluate() but derived from the rollout state.
 * Scores are normalized to roughly [-200, 200] for non-terminal states
 * so UCB1 exploration constants remain meaningful.
 */
export function evaluateRolloutState(battle: Battle, state: RolloutState): number {
	const aiLiving = state.ai.filter(m => !m.fainted);
	const oppLiving = state.opp.filter(m => !m.fainted);

	if (oppLiving.length === 0) return 1000;
	if (aiLiving.length === 0) return -1000;

	const aiActive = state.ai[state.aiActiveIdx];
	const oppActive = state.opp[state.oppActiveIdx];

	let score = 0;

	// HP ratio for active mons
	score += 100 * (aiActive.hp / aiActive.maxHp - oppActive.hp / oppActive.maxHp);

	// Team depth (bench HP fractions)
	const aiBench = state.ai.filter((m, i) => i !== state.aiActiveIdx && !m.fainted);
	const oppBench = state.opp.filter((m, i) => i !== state.oppActiveIdx && !m.fainted);
	const aiTeamFrac = aiBench.length > 0
		? aiBench.reduce((s, m) => s + m.hp / m.maxHp, 0) / aiBench.length : 0;
	const oppTeamFrac = oppBench.length > 0
		? oppBench.reduce((s, m) => s + m.hp / m.maxHp, 0) / oppBench.length : 0;
	score += 40 * (aiTeamFrac - oppTeamFrac);

	// Status
	score += statusValue(oppActive.status, oppActive.toxicCounter);
	score -= statusValue(aiActive.status, aiActive.toxicCounter);

	// Hazard advantage — expected chip to opponent's bench
	const hazardChip = (hazards: HazardState, bench: RolloutMon[]): number => {
		if (bench.length === 0) return 0;
		let total = 0;
		for (const mon of bench) {
			if (hazards.stealthRock) {
				const rockEff = Math.pow(2, battle.dex.getEffectiveness('Rock', mon.ref));
				total += rockEff / 8;
			}
			const grounded = !mon.ref.types.includes('Flying') && mon.ref.ability !== 'levitate';
			if (hazards.spikes > 0 && grounded) {
				total += [0, 1 / 8, 1 / 6, 1 / 4][Math.min(hazards.spikes, 3)];
			}
		}
		return (total / bench.length) * 20;
	};

	score += hazardChip(state.hazardsOnOppSide, oppBench);
	score -= hazardChip(state.hazardsOnAiSide, aiBench);

	return score;
}
